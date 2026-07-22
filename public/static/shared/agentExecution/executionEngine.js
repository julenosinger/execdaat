// ============================================================
// EXECDAAT AGENT EXECUTION — Execution Engine
// Build: 20260722 — IIFE / Event-based / Pure logic
//
// Namespace: D.AgentExecution
//
// Events dispatched:
//   agentExecution:enqueued
//   agentExecution:started
//   agentExecution:validating
//   agentExecution:pendingApproval
//   agentExecution:approved
//   agentExecution:executing
//   agentExecution:completed
//   agentExecution:failed
//   agentExecution:cancelled
//   agentExecution:retried
//   agentExecution:enginePaused
//   agentExecution:engineResumed
//   agentExecution:emergencyStop
// ============================================================
;(function() {
  'use strict';
  var D = window.ExecDaat = window.ExecDaat || {};

  var QUEUE_KEY = 'execdaat_execution_queue';
  var HISTORY_KEY = 'execdaat_execution_history';
  var MAX_HISTORY = 200;
  var QUEUE_INTERVAL = 10000;

  var _state = {
    queue: [],
    history: [],
    active: false,
    loaded: false
  };

  var _queueTimer = null;
  var _pendingCallbacks = {};

  function _emit(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent('agentExecution:' + name, { detail: detail || {} }));
    } catch (e) { /* never throw from event handlers */ }
  }

  function _now() {
    return new Date().toISOString();
  }

  function _uid() {
    return 'ex_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function _formatAmount(amount) {
    var n = Number(amount);
    if (!isFinite(n)) return '0.000000';
    return n.toFixed(6);
  }

  function _save() {
    try {
      localStorage.setItem(QUEUE_KEY, JSON.stringify(_state.queue));
      var hist = _state.history.slice(0, MAX_HISTORY);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(hist));
    } catch (e) { /* quota exceeded */ }
  }

  function _load() {
    try {
      var queueRaw = localStorage.getItem(QUEUE_KEY);
      if (queueRaw) _state.queue = JSON.parse(queueRaw);
      var histRaw = localStorage.getItem(HISTORY_KEY);
      if (histRaw) _state.history = JSON.parse(histRaw);
    } catch (e) { /* corrupt data, start fresh */ }
  }

  function _createItem(type, params, priority) {
    return {
      id: _uid(),
      intentId: params.intentId || null,
      type: type,
      params: {
        amount: params.amount ? _formatAmount(params.amount) : '0',
        token: params.token || 'USDC',
        from: params.from || '',
        to: params.to || '',
        recipient: params.recipient || '',
        chainId: params.chainId || '',
        data: params.data || null
      },
      status: 'queued',
      checkpoints: {
        policy: { passed: false, timestamp: '', details: {} },
        permission: { passed: false, timestamp: '', details: {} },
        risk: { passed: false, timestamp: '' },
        approval: { required: false, approved: false, timestamp: '' },
        treasury: { passed: false, timestamp: '' }
      },
      result: {
        txHash: '',
        blockNumber: 0,
        error: ''
      },
      priority: priority || 5,
      createdAt: _now(),
      updatedAt: _now(),
      maxRetries: params.maxRetries || 3,
      retryCount: 0
    };
  }

  function _findById(executionId) {
    for (var i = 0; i < _state.queue.length; i++) {
      if (_state.queue[i].id === executionId) return _state.queue[i];
    }
    for (var j = 0; j < _state.history.length; j++) {
      if (_state.history[j].id === executionId) return _state.history[j];
    }
    return null;
  }

  function _findInQueue(executionId) {
    for (var i = 0; i < _state.queue.length; i++) {
      if (_state.queue[i].id === executionId) return i;
    }
    return -1;
  }

  function _sortQueue() {
    _state.queue.sort(function(a, b) {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return new Date(a.createdAt) - new Date(b.createdAt);
    });
  }

  function _moveToHistory(item) {
    _state.history.unshift(item);
    if (_state.history.length > MAX_HISTORY) _state.history.length = MAX_HISTORY;
  }

  function _startQueueTimer() {
    if (_queueTimer) return;
    _queueTimer = setInterval(_processQueue, QUEUE_INTERVAL);
  }

  function _stopQueueTimer() {
    if (_queueTimer) {
      clearInterval(_queueTimer);
      _queueTimer = null;
    }
  }

  function _processQueue() {
    if (!_state.active) return;
    if (_state.queue.length === 0) return;

    var executing = 0;
    for (var i = 0; i < _state.queue.length; i++) {
      if (_state.queue[i].status === 'executing' || _state.queue[i].status === 'validating') {
        executing++;
      }
    }
    if (executing > 0) return;

    _sortQueue();
    var next = null;
    for (var j = 0; j < _state.queue.length; j++) {
      if (_state.queue[j].status === 'queued' || _state.queue[j].status === 'pending_approval') {
        next = _state.queue[j];
        break;
      }
    }
    if (next) {
      if (next.status === 'queued') {
        D.AgentExecution.execute(next.id);
      } else if (next.status === 'pending_approval') {
        var checkpoint = next.checkpoints.approval;
        if (checkpoint.approved) {
          next.status = 'queued';
          next.updatedAt = _now();
          _save();
          D.AgentExecution.execute(next.id);
        }
      }
    }
  }

  function _runValidation(executionId) {
    var item = _findById(executionId);
    if (!item) return;

    item.status = 'validating';
    item.updatedAt = _now();
    _emit('validating', { executionId: executionId, item: item });

    var timestamp = _now();
    var allPassed = true;
    var approvalRequired = false;

    // Policy check
    var policies = D.AgentPolicies;
    if (policies && typeof policies.evaluate === 'function') {
      try {
        var policyResult = policies.evaluate({
          type: item.type,
          amount: item.params.amount,
          token: item.params.token,
          recipient: item.params.recipient || item.params.to
        });
        item.checkpoints.policy = {
          passed: policyResult && policyResult.passed !== false,
          timestamp: timestamp,
          details: policyResult || {}
        };
      } catch (e) {
        item.checkpoints.policy = { passed: true, timestamp: timestamp, details: { error: 'policy module unavailable' } };
      }
    } else {
      item.checkpoints.policy = { passed: true, timestamp: timestamp, details: { note: 'no policy module loaded' } };
    }
    if (!item.checkpoints.policy.passed) allPassed = false;

    // Permission check
    var permissions = D.AgentPermissions;
    if (permissions && typeof permissions.check === 'function') {
      try {
        var permResult = permissions.check({
          capability: item.type,
          amount: item.params.amount,
          token: item.params.token
        });
        item.checkpoints.permission = {
          passed: permResult && permResult.allowed !== false,
          timestamp: timestamp,
          details: permResult || {}
        };
        if (permResult && permResult.requiresApproval) {
          approvalRequired = true;
        }
      } catch (e) {
        item.checkpoints.permission = { passed: true, timestamp: timestamp, details: { error: 'permission module unavailable' } };
      }
    } else {
      item.checkpoints.permission = { passed: true, timestamp: timestamp, details: { note: 'no permission module loaded' } };
    }
    if (!item.checkpoints.permission.passed) allPassed = false;

    // Risk check
    try {
      var amountNum = parseFloat(item.params.amount) || 0;
      var riskPassed = true;
      if (item.type === 'multisend' || amountNum > 1000) {
        var riskThreshold = 500;
        if (amountNum > riskThreshold) {
          riskPassed = false;
        }
      }
      item.checkpoints.risk = { passed: riskPassed, timestamp: timestamp };
      if (!riskPassed) allPassed = false;
    } catch (e) {
      item.checkpoints.risk = { passed: true, timestamp: timestamp };
    }

    // Treasury check
    var treasury = D.AgentTreasury;
    if (treasury) {
      try {
        var treasuryBalance = 0;
        if (treasury.state && treasury.state.allocations) {
          for (var k = 0; k < treasury.state.allocations.length; k++) {
            treasuryBalance += parseFloat(treasury.state.allocations[k].amount || 0);
          }
        }
        var needed = parseFloat(item.params.amount) || 0;
        item.checkpoints.treasury = {
          passed: treasuryBalance >= needed,
          timestamp: timestamp
        };
        if (!item.checkpoints.treasury.passed) allPassed = false;
      } catch (e) {
        item.checkpoints.treasury = { passed: true, timestamp: timestamp };
      }
    } else {
      item.checkpoints.treasury = { passed: true, timestamp: timestamp };
    }

    // Approval
    item.checkpoints.approval = {
      required: approvalRequired || !allPassed,
      approved: false,
      timestamp: timestamp
    };

    item.updatedAt = _now();

    if (item.checkpoints.approval.required && !item.checkpoints.approval.approved) {
      item.status = 'pending_approval';
      _emit('pendingApproval', { executionId: executionId, item: item, checkpoint: item.checkpoints });
      _save();
      return { passed: false, reason: 'approval_required' };
    }

    _save();
    return { passed: true };
  }

  function _dispatchToModule(item) {
    var eventName;
    var detail = { executionId: item.id, item: item };

    switch (item.type) {
      case 'transfer':
        eventName = 'agentExecution:executeTransfer';
        detail = { executionId: item.id, to: item.params.to || item.params.recipient, amount: item.params.amount, token: item.params.token, item: item };
        break;
      case 'swap':
        eventName = 'agentExecution:executeSwap';
        detail = { executionId: item.id, fromToken: item.params.token, toToken: item.params.data && item.params.data.toToken, amount: item.params.amount, item: item };
        break;
      case 'bridge':
        eventName = 'agentExecution:executeBridge';
        detail = { executionId: item.id, source: item.params.chainId, destination: item.params.data && item.params.data.destChainId, amount: item.params.amount, token: item.params.token, item: item };
        break;
      case 'multisend':
        eventName = 'agentExecution:executeMultisend';
        detail = { executionId: item.id, recipients: item.params.data && item.params.data.recipients, item: item };
        break;
      case 'allocate':
        eventName = 'agentExecution:executeAllocate';
        detail = { executionId: item.id, type: item.params.data && item.params.data.allocationType, amount: item.params.amount, token: item.params.token, item: item };
        break;
      case 'contract':
        eventName = 'agentExecution:executeContract';
        detail = { executionId: item.id, data: item.params.data, item: item };
        break;
      default:
        _emit('failed', { executionId: item.id, error: 'unknown execution type: ' + item.type });
        item.status = 'failed';
        item.result.error = 'unknown execution type';
        item.updatedAt = _now();
        _moveToHistory(item);
        _save();
        return;
    }

    _emit('executing', { executionId: item.id, type: item.type, detail: detail });
    window.dispatchEvent(new CustomEvent(eventName, { detail: detail }));
  }

  function _onTaskComplete(event) {
    try {
      var detail = event.detail || {};
      var executionId = detail.executionId;
      if (!executionId) return;

      var item = _findById(executionId);
      if (!item) return;

      if (detail.txHash) item.result.txHash = detail.txHash;
      if (detail.blockNumber) item.result.blockNumber = detail.blockNumber;
      item.status = 'completed';
      item.updatedAt = _now();
      _moveToHistory(item);

      var qIdx = _findInQueue(executionId);
      if (qIdx >= 0) _state.queue.splice(qIdx, 1);

      _emit('completed', { executionId: executionId, item: item });
      _save();
    } catch (e) { /* ignore */ }
  }

  function _onTaskFailed(event) {
    try {
      var detail = event.detail || {};
      var executionId = detail.executionId;
      if (!executionId) return;

      var item = _findById(executionId);
      if (!item) return;

      item.retryCount++;
      item.result.error = detail.error || 'execution failed';
      item.updatedAt = _now();

      if (item.retryCount <= item.maxRetries) {
        item.status = 'queued';
        _emit('retried', { executionId: executionId, item: item, attempt: item.retryCount });
      } else {
        item.status = 'failed';
        _moveToHistory(item);
        var qIdx = _findInQueue(executionId);
        if (qIdx >= 0) _state.queue.splice(qIdx, 1);
        _emit('failed', { executionId: executionId, item: item });
      }
      _save();
    } catch (e) { /* ignore */ }
  }

  // ═══════════════════════════════════════════════════════════════
  //  PUBLIC API
  // ═══════════════════════════════════════════════════════════════

  D.AgentExecution = {
    get state() { return Object.assign({}, _state); },
    get queue() { return _state.queue.slice(); },
    get history() { return _state.history.slice(); },
    get active() { return _state.active; },
    get loaded() { return _state.loaded; },

    init: function() {
      if (_state.loaded) return _state;
      _load();
      _state.active = true;
      _state.loaded = true;

      window.addEventListener('agentExecution:taskComplete', _onTaskComplete);
      window.addEventListener('agentExecution:taskFailed', _onTaskFailed);

      _startQueueTimer();
      _emit('engineResumed', { active: true });
      return _state;
    },

    enqueue: function(type, params, priority) {
      var item = _createItem(type, params || {}, priority || 5);
      _state.queue.push(item);
      _sortQueue();
      _emit('enqueued', { executionId: item.id, type: type, item: item });
      _save();
      return item;
    },

    dequeue: function(executionId) {
      var idx = _findInQueue(executionId);
      if (idx >= 0) {
        var removed = _state.queue.splice(idx, 1)[0];
        _save();
        return removed;
      }
      return null;
    },

    processQueue: function() {
      _processQueue();
    },

    execute: function(intentOrParams) {
      var item;
      if (typeof intentOrParams === 'string') {
        item = _findById(intentOrParams);
        if (!item) return null;
      } else if (typeof intentOrParams === 'object') {
        item = intentOrParams;
        if (!item.id) {
          item = _createItem(item.type || 'transfer', item.params || item, item.priority);
          _state.queue.push(item);
          _sortQueue();
        }
      } else {
        return null;
      }

      _emit('started', { executionId: item.id, item: item });

      // 1. VALIDATE
      var validation = _runValidation(item.id);
      if (!validation) return item;
      if (!validation.passed) return item;

      // 3. APPROVE (if required)
      if (item.checkpoints.approval.required && !item.checkpoints.approval.approved) {
        return item;
      }

      // 4. PREPARE — mark as approved if not already
      if (!item.checkpoints.approval.approved) {
        item.checkpoints.approval.approved = true;
        item.checkpoints.approval.timestamp = _now();
        _emit('approved', { executionId: item.id, item: item });
      }

      // 5. DISPATCH
      item.status = 'executing';
      item.updatedAt = _now();
      _save();
      _dispatchToModule(item);

      return item;
    },

    validate: function(executionId) {
      return _runValidation(executionId);
    },

    cancel: function(executionId) {
      var item = _findById(executionId);
      if (!item) return null;

      item.status = 'failed';
      item.result.error = 'cancelled by user';
      item.updatedAt = _now();
      _moveToHistory(item);

      var qIdx = _findInQueue(executionId);
      if (qIdx >= 0) _state.queue.splice(qIdx, 1);

      _emit('cancelled', { executionId: executionId, item: item });
      _save();
      return item;
    },

    retry: function(executionId) {
      var item = _findById(executionId);
      if (!item) return null;

      item.retryCount = 0;
      item.status = 'queued';
      item.result.error = '';
      item.updatedAt = _now();

      var qIdx = _findInQueue(executionId);
      if (qIdx >= 0) {
        _state.queue[qIdx] = item;
      } else {
        _state.queue.push(item);
        _sortQueue();
      }

      _emit('retried', { executionId: executionId, item: item, attempt: 0 });
      _save();

      if (_state.active) {
        _processQueue();
      }

      return item;
    },

    getStatus: function(executionId) {
      var item = _findById(executionId);
      if (!item) return { status: 'not_found' };
      return {
        id: item.id,
        type: item.type,
        status: item.status,
        checkpoints: item.checkpoints,
        result: item.result,
        priority: item.priority,
        retryCount: item.retryCount,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt
      };
    },

    getQueue: function() {
      _sortQueue();
      return _state.queue.slice();
    },

    getHistory: function(filter) {
      var result = _state.history.slice();
      if (filter) {
        result = result.filter(function(item) {
          if (filter.type && item.type !== filter.type) return false;
          if (filter.status && item.status !== filter.status) return false;
          if (filter.priority && item.priority > filter.priority) return false;
          if (filter.after && new Date(item.createdAt) < new Date(filter.after)) return false;
          if (filter.before && new Date(item.createdAt) > new Date(filter.before)) return false;
          return true;
        });
      }
      return result;
    },

    pauseEngine: function() {
      _state.active = false;
      _stopQueueTimer();
      _emit('enginePaused', { active: false });
      _save();
    },

    resumeEngine: function() {
      if (_state.active) return;
      _state.active = true;
      _startQueueTimer();
      _emit('engineResumed', { active: true });
      _save();
    },

    stopAll: function() {
      _state.active = false;
      _stopQueueTimer();

      for (var i = _state.queue.length - 1; i >= 0; i--) {
        var item = _state.queue[i];
        if (item.status === 'executing' || item.status === 'validating') {
          item.status = 'failed';
          item.result.error = 'emergency stop';
          item.updatedAt = _now();
          _moveToHistory(item);
          _state.queue.splice(i, 1);
        }
      }

      _emit('emergencyStop', { timestamp: _now() });
      _save();
    }
  };

  // Auto-init when D.AgentPolicies is available (or defer)
  window.addEventListener('agentPolicy:initialized', function() {
    if (!D.AgentExecution.loaded) D.AgentExecution.init();
  });
})();
