// ============================================================
// EXECDAAT AGENT AUTOMATION — Automation Engine
// Build: 20260722 — IIFE / Event-based / Pure logic
//
// Namespace: D.AgentAutomation
//
// Events dispatched:
//   agentWorkflow:added
//   agentWorkflow:updated
//   agentWorkflow:removed
//   agentWorkflow:activated
//   agentWorkflow:paused
//   agentWorkflow:evaluated
//   agentWorkflow:executed
//   agentWorkflow:conditionMet
//   agentWorkflow:actionExecuted
//   agentWorkflow:scheduled
// ============================================================
;(function() {
  'use strict';
  var D = window.ExecDaat = window.ExecDaat || {};

  var WORKFLOWS_KEY = 'execdaat_agent_workflows';
  var EVAL_INTERVAL = 60000;

  var _state = {
    workflows: [],
    schedule: null,
    lastRun: '',
    loaded: false
  };

  var _evalTimer = null;

  function _emit(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent('agentWorkflow:' + name, { detail: detail || {} }));
    } catch (e) { /* never throw from event handlers */ }
  }

  function _now() {
    return new Date().toISOString();
  }

  function _uid() {
    return 'wf_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function _formatAmount(amount) {
    var n = Number(amount);
    if (!isFinite(n)) return '0.000000';
    return n.toFixed(6);
  }

  function _save() {
    try {
      localStorage.setItem(WORKFLOWS_KEY, JSON.stringify(_state.workflows));
    } catch (e) { /* quota exceeded */ }
  }

  function _load() {
    try {
      var raw = localStorage.getItem(WORKFLOWS_KEY);
      if (raw) _state.workflows = JSON.parse(raw);
    } catch (e) { /* corrupt data, start fresh */ }
  }

  function _findWorkflow(workflowId) {
    for (var i = 0; i < _state.workflows.length; i++) {
      if (_state.workflows[i].id === workflowId) return i;
    }
    return -1;
  }

  function _createWorkflow(def) {
    return {
      id: def.id || _uid(),
      name: def.name || 'Untitled Workflow',
      description: def.description || '',
      trigger: {
        type: def.trigger ? def.trigger.type : 'interval',
        cron: def.trigger ? def.trigger.cron || '' : '',
        event: def.trigger ? def.trigger.event || '' : '',
        condition: def.trigger ? def.trigger.condition || null : null,
        intervalMs: def.trigger ? def.trigger.intervalMs || 0 : 0
      },
      conditions: def.conditions || [],
      actions: def.actions || [],
      status: def.status || 'active',
      priority: def.priority || 5,
      maxExecutionsPerDay: def.maxExecutionsPerDay || 10,
      executionCount: def.executionCount || 0,
      lastExecution: def.lastExecution || '',
      createdAt: def.createdAt || _now(),
      updatedAt: def.updatedAt || _now()
    };
  }

  function _getDefaultWorkflows() {
    return [
      {
        id: 'wf_friday_treasury',
        name: 'Friday Treasury Check',
        description: 'Every Friday, if treasury balance exceeds 200 USDC, suggest moving 50 USDC to treasury allocation',
        trigger: { type: 'schedule', cron: '0 0 * * 5' },
        conditions: [
          { field: 'treasuryBalance', operator: 'gt', value: '200', source: 'treasury' }
        ],
        actions: [
          { type: 'allocate', params: { type: 'treasury', amount: '50', token: 'USDC' } }
        ],
        status: 'active',
        priority: 3,
        maxExecutionsPerDay: 5,
        executionCount: 0,
        lastExecution: '',
        createdAt: _now(),
        updatedAt: _now()
      },
      {
        id: 'wf_gas_reserve',
        name: 'Gas Reserve Monitor',
        description: 'Every hour, if gas reserve is below 10 USDC, notify',
        trigger: { type: 'interval', intervalMs: 3600000 },
        conditions: [
          { field: 'gas_reserve', operator: 'lt', value: '10', source: 'vault' }
        ],
        actions: [
          { type: 'notify', params: { message: 'Gas reserve below 10 USDC threshold' } }
        ],
        status: 'active',
        priority: 2,
        maxExecutionsPerDay: 24,
        executionCount: 0,
        lastExecution: '',
        createdAt: _now(),
        updatedAt: _now()
      },
      {
        id: 'wf_payment_overflow',
        name: 'Payment Overflow Check',
        description: 'Every 6 hours, if payment daily spend exceeds 80%, warn',
        trigger: { type: 'interval', intervalMs: 21600000 },
        conditions: [
          { field: 'dailySpendPercent', operator: 'gt', value: '80', source: 'permissions' }
        ],
        actions: [
          { type: 'notify', params: { message: 'Daily payment spend above 80% threshold' } }
        ],
        status: 'active',
        priority: 4,
        maxExecutionsPerDay: 4,
        executionCount: 0,
        lastExecution: '',
        createdAt: _now(),
        updatedAt: _now()
      }
    ];
  }

  function _parseCron(cron) {
    if (!cron) return null;
    var parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return null;
    return {
      minute: parts[0],
      hour: parts[1],
      dayOfMonth: parts[2],
      month: parts[3],
      dayOfWeek: parts[4]
    };
  }

  function _cronMatches(parsed, date) {
    if (!parsed || !date) return false;

    if (parsed.minute !== '*' && parseInt(parsed.minute, 10) !== date.getUTCMinutes()) return false;
    if (parsed.hour !== '*' && parseInt(parsed.hour, 10) !== date.getUTCHours()) return false;
    if (parsed.dayOfMonth !== '*' && parseInt(parsed.dayOfMonth, 10) !== date.getUTCDate()) return false;
    if (parsed.month !== '*' && parseInt(parsed.month, 10) !== (date.getUTCMonth() + 1)) return false;
    if (parsed.dayOfWeek !== '*') {
      var dow = date.getUTCDay();
      if (dow === 0) dow = 7; // Sunday = 7 for cron
      if (parsed.dayOfWeek.indexOf(String(dow)) === -1) return false;
    }

    return true;
  }

  function _getNextCronTime(cron) {
    var parsed = _parseCron(cron);
    if (!parsed) return null;

    var now = new Date();
    // Simple: find next matching time within 7 days
    for (var m = 0; m < 10080; m++) {
      var candidate = new Date(now.getTime() + m * 60000);
      if (_cronMatches(parsed, candidate)) {
        return candidate.toISOString();
      }
    }
    return null;
  }

  function _getSourceData(source) {
    try {
      switch (source) {
        case 'treasury':
          if (D.AgentTreasury && D.AgentTreasury.state) {
            var tState = D.AgentTreasury.state;
            var treasuryBalance = 0;
            if (tState.allocations) {
              for (var i = 0; i < tState.allocations.length; i++) {
                treasuryBalance += parseFloat(tState.allocations[i].amount || 0);
              }
            }
            return {
              treasuryBalance: treasuryBalance,
              allocations: tState.allocations || [],
              totalAllocated: treasuryBalance
            };
          }
          return null;

        case 'permissions':
          if (D.AgentPermissions && D.AgentPermissions.state) {
            var pState = D.AgentPermissions.state;
            var dailySpend = 0;
            if (pState.usage && pState.usage.daily) {
              var keys = Object.keys(pState.usage.daily);
              for (var j = 0; j < keys.length; j++) {
                dailySpend += parseFloat(pState.usage.daily[keys[j]] || 0);
              }
            }
            var dailySpendPercent = dailySpend > 0 ? (dailySpend / (pState.dailyLimit || 1000)) * 100 : 0;
            return {
              dailySpend: dailySpend,
              dailySpendPercent: dailySpendPercent,
              permissions: pState.permissions || [],
              usage: pState.usage
            };
          }
          return null;

        case 'vault':
          if (D.AgentVault && D.AgentVault.state) {
            var vState = D.AgentVault.state;
            var gasReserve = 0;
            if (vState.allocations) {
              for (var k = 0; k < vState.allocations.length; k++) {
                if (vState.allocations[k].type === 'agent_gas') {
                  gasReserve = parseFloat(vState.allocations[k].available || vState.allocations[k].allocated || 0);
                  break;
                }
              }
            }
            return {
              gas_reserve: gasReserve,
              allocations: vState.allocations || [],
              deposits: vState.depositHistory || []
            };
          }
          return null;

        case 'intents':
          if (D.AgentIntents && D.AgentIntents.state) {
            return { intents: D.AgentIntents.state.intents || [], count: D.AgentIntents.state.count || 0 };
          }
          return null;

        case 'execution':
          if (D.AgentExecution && D.AgentExecution.state) {
            return { queue: D.AgentExecution.state.queue || [], history: D.AgentExecution.state.history || [] };
          }
          return null;

        case 'policies':
          if (D.AgentPolicies && D.AgentPolicies.state) {
            return { policies: D.AgentPolicies.state.policies || [] };
          }
          return null;

        default:
          return null;
      }
    } catch (e) { return null; }
  }

  function _evaluateCondition(condition) {
    if (!condition) return false;
    if (!condition.source) return false;

    var data = _getSourceData(condition.source);
    if (!data) return false;

    var fieldVal = data[condition.field];
    if (fieldVal === undefined || fieldVal === null) return false;

    var cmpVal = Number(condition.value);
    var fieldNum = Number(fieldVal);

    switch (condition.operator) {
      case 'gt':
        return fieldNum > cmpVal;
      case 'gte':
        return fieldNum >= cmpVal;
      case 'lt':
        return fieldNum < cmpVal;
      case 'lte':
        return fieldNum <= cmpVal;
      case 'eq':
        return fieldNum === cmpVal;
      case 'neq':
        return fieldNum !== cmpVal;
      case 'contains':
        return String(fieldVal).toLowerCase().indexOf(String(condition.value).toLowerCase()) >= 0;
      default:
        return false;
    }
  }

  function _evaluateAllConditions(conditions) {
    if (!conditions || conditions.length === 0) return true;
    for (var i = 0; i < conditions.length; i++) {
      if (!_evaluateCondition(conditions[i])) return false;
    }
    return true;
  }

  function _executeAction(workflow, action) {
    try {
      switch (action.type) {
        case 'create_intent':
          if (D.AgentIntents && typeof D.AgentIntents.create === 'function') {
            D.AgentIntents.create(action.params || {});
          }
          break;

        case 'allocate':
          if (D.AgentExecution && typeof D.AgentExecution.enqueue === 'function') {
            D.AgentExecution.enqueue('allocate', {
              amount: action.params.amount || '0',
              token: action.params.token || 'USDC',
              data: { allocationType: action.params.type || 'treasury' }
            }, workflow.priority);
          }
          break;

        case 'notify':
          window.dispatchEvent(new CustomEvent('agentNotification:alert', {
            detail: {
              workflowId: workflow.id,
              workflowName: workflow.name,
              message: action.params.message || 'Automation alert',
              timestamp: _now()
            }
          }));
          break;

        case 'approve':
          if (action.params.executionId && D.AgentExecution) {
            var execItem = D.AgentExecution.getStatus(action.params.executionId);
            if (execItem && execItem.status === 'pending_approval') {
              var item = (D.AgentExecution.queue || []).concat(D.AgentExecution.history || []).find(function(e) { return e.id === action.params.executionId; });
              if (item) {
                item.checkpoints.approval.approved = true;
                item.checkpoints.approval.timestamp = _now();
                item.status = 'queued';
                D.AgentExecution.processQueue();
              }
            }
          }
          break;

        case 'execute':
          if (D.AgentExecution && typeof D.AgentExecution.enqueue === 'function') {
            D.AgentExecution.enqueue(
              action.params.type || 'transfer',
              action.params || {},
              workflow.priority
            );
          }
          break;

        default:
          break;
      }

      _emit('actionExecuted', {
        workflowId: workflow.id,
        action: action,
        timestamp: _now()
      });
    } catch (e) { /* ignore */ }
  }

  function _startEvalTimer() {
    if (_evalTimer) return;
    _evalTimer = setInterval(_evaluateAll, EVAL_INTERVAL);
  }

  function _stopEvalTimer() {
    if (_evalTimer) {
      clearInterval(_evalTimer);
      _evalTimer = null;
    }
  }

  function _evaluateWorkflow(workflowId) {
    var idx = _findWorkflow(workflowId);
    if (idx < 0) return;

    var workflow = _state.workflows[idx];
    if (workflow.status !== 'active') return;

    var today = new Date().toISOString().slice(0, 10);
    var countToday = workflow.executionCount;
    if (workflow.lastExecution && workflow.lastExecution.slice(0, 10) === today) {
      // already counted today
    } else {
      countToday = 0;
    }
    if (countToday >= workflow.maxExecutionsPerDay) return;

    var triggerType = workflow.trigger.type;
    var shouldRun = false;

    switch (triggerType) {
      case 'schedule':
        shouldRun = _evaluateScheduleTrigger(workflow);
        break;
      case 'interval':
        shouldRun = _evaluateIntervalTrigger(workflow);
        break;
      case 'event':
        // Event-based triggers fire via event listener, not timer
        shouldRun = false;
        break;
      case 'condition':
        shouldRun = true;
        break;
      default:
        return;
    }

    if (!shouldRun) return;

    var conditionsMet = _evaluateAllConditions(workflow.conditions);
    if (!conditionsMet) return;

    _emit('conditionMet', { workflowId: workflowId, workflow: workflow, timestamp: _now() });

    _state.workflows[idx].lastExecution = _now();
    _state.workflows[idx].executionCount++;
    _state.workflows[idx].updatedAt = _now();
    _state.lastRun = _now();
    _save();

    if (workflow.actions && workflow.actions.length > 0) {
      for (var i = 0; i < workflow.actions.length; i++) {
        _executeAction(workflow, workflow.actions[i]);
      }
    }

    _emit('executed', {
      workflowId: workflowId,
      workflow: workflow,
      timestamp: _now()
    });
  }

  function _evaluateAll() {
    for (var i = 0; i < _state.workflows.length; i++) {
      if (_state.workflows[i].status === 'active') {
        _evaluateWorkflow(_state.workflows[i].id);
      }
    }
    _emit('evaluated', { count: _state.workflows.length, timestamp: _now() });
  }

  function _evaluateScheduleTrigger(workflow) {
    var cron = workflow.trigger.cron;
    if (!cron) return false;
    var parsed = _parseCron(cron);
    if (!parsed) return false;

    var now = new Date();
    // Allow cron match within the last 2 minutes (to account for eval interval drift)
    for (var m = 0; m < 2; m++) {
      var checkTime = new Date(now.getTime() - m * 60000);
      if (_cronMatches(parsed, checkTime)) return true;
    }
    return false;
  }

  function _evaluateIntervalTrigger(workflow) {
    var intervalMs = workflow.trigger.intervalMs;
    if (!intervalMs || intervalMs <= 0) return false;

    if (!workflow.lastExecution) return true;

    var lastTime = new Date(workflow.lastExecution).getTime();
    if (isNaN(lastTime)) return true;

    var elapsed = Date.now() - lastTime;
    return elapsed >= intervalMs;
  }

  function _onWorkflowEvent(event) {
    if (!event || !event.type) return;
    for (var i = 0; i < _state.workflows.length; i++) {
      var wf = _state.workflows[i];
      if (wf.status === 'active' && wf.trigger.type === 'event' && wf.trigger.event === event.type) {
        var conditionsMet = _evaluateAllConditions(wf.conditions);
        if (conditionsMet) {
          _emit('conditionMet', { workflowId: wf.id, workflow: wf, timestamp: _now(), event: event.type });
          _state.workflows[i].lastExecution = _now();
          _state.workflows[i].executionCount++;
          _state.workflows[i].updatedAt = _now();
          _state.lastRun = _now();
          _save();

          if (wf.actions && wf.actions.length > 0) {
            for (var j = 0; j < wf.actions.length; j++) {
              _executeAction(wf, wf.actions[j]);
            }
          }

          _emit('executed', { workflowId: wf.id, workflow: wf, timestamp: _now() });
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  PUBLIC API
  // ═══════════════════════════════════════════════════════════════

  D.AgentAutomation = {
    get state() { return Object.assign({}, _state); },
    get workflows() { return _state.workflows.slice(); },
    get loaded() { return _state.loaded; },

    init: function() {
      if (_state.loaded) return _state;
      _load();

      if (_state.workflows.length === 0) {
        _state.workflows = _getDefaultWorkflows();
        _save();
      }

      _state.loaded = true;
      _startEvalTimer();

      window.addEventListener('agentExecution:completed', _onWorkflowEvent);
      window.addEventListener('agentExecution:failed', _onWorkflowEvent);
      window.addEventListener('agentTreasury:updated', _onWorkflowEvent);
      window.addEventListener('agentVault:allocationChanged', _onWorkflowEvent);
      window.addEventListener('agentPermission:updated', _onWorkflowEvent);
      window.addEventListener('agentIntent:created', _onWorkflowEvent);

      return _state;
    },

    addWorkflow: function(workflow) {
      var wf = _createWorkflow(workflow);
      _state.workflows.push(wf);
      _save();

      if (wf.trigger.type === 'event' && wf.trigger.event) {
        window.addEventListener(wf.trigger.event, _onWorkflowEvent);
      }

      _emit('added', { workflowId: wf.id, workflow: wf });
      return wf;
    },

    removeWorkflow: function(workflowId) {
      var idx = _findWorkflow(workflowId);
      if (idx < 0) return false;

      var removed = _state.workflows.splice(idx, 1)[0];
      _save();
      _emit('removed', { workflowId: workflowId, workflow: removed });
      return true;
    },

    updateWorkflow: function(workflowId, updates) {
      var idx = _findWorkflow(workflowId);
      if (idx < 0) return null;

      if (updates.name !== undefined) _state.workflows[idx].name = updates.name;
      if (updates.description !== undefined) _state.workflows[idx].description = updates.description;
      if (updates.trigger !== undefined) _state.workflows[idx].trigger = Object.assign({}, _state.workflows[idx].trigger, updates.trigger);
      if (updates.conditions !== undefined) _state.workflows[idx].conditions = updates.conditions;
      if (updates.actions !== undefined) _state.workflows[idx].actions = updates.actions;
      if (updates.status !== undefined) _state.workflows[idx].status = updates.status;
      if (updates.priority !== undefined) _state.workflows[idx].priority = updates.priority;
      if (updates.maxExecutionsPerDay !== undefined) _state.workflows[idx].maxExecutionsPerDay = updates.maxExecutionsPerDay;
      _state.workflows[idx].updatedAt = _now();
      _save();

      _emit('updated', { workflowId: workflowId, workflow: _state.workflows[idx] });
      return _state.workflows[idx];
    },

    getWorkflows: function(filter) {
      var result = _state.workflows.slice();
      if (filter) {
        result = result.filter(function(wf) {
          if (filter.status && wf.status !== filter.status) return false;
          if (filter.triggerType && wf.trigger.type !== filter.triggerType) return false;
          if (filter.priority && wf.priority > filter.priority) return false;
          return true;
        });
      }
      return result;
    },

    activate: function(workflowId) {
      var idx = _findWorkflow(workflowId);
      if (idx < 0) return false;
      _state.workflows[idx].status = 'active';
      _state.workflows[idx].updatedAt = _now();
      _save();
      _emit('activated', { workflowId: workflowId, workflow: _state.workflows[idx] });
      return true;
    },

    pause: function(workflowId) {
      var idx = _findWorkflow(workflowId);
      if (idx < 0) return false;
      _state.workflows[idx].status = 'paused';
      _state.workflows[idx].updatedAt = _now();
      _save();
      _emit('paused', { workflowId: workflowId, workflow: _state.workflows[idx] });
      return true;
    },

    evaluateWorkflow: function(workflowId) {
      _evaluateWorkflow(workflowId);
    },

    evaluateAll: function() {
      _evaluateAll();
    },

    evaluateSchedules: function() {
      for (var i = 0; i < _state.workflows.length; i++) {
        var wf = _state.workflows[i];
        if (wf.status === 'active' && wf.trigger.type === 'schedule') {
          _evaluateWorkflow(wf.id);
        }
      }
    },

    evaluateConditions: function() {
      for (var i = 0; i < _state.workflows.length; i++) {
        var wf = _state.workflows[i];
        if (wf.status === 'active' && (wf.trigger.type === 'condition' || wf.trigger.type === 'interval')) {
          _evaluateWorkflow(wf.id);
        }
      }
    },

    executeWorkflowAction: function(workflow, action) {
      if (!workflow || !action) return;
      _executeAction(workflow, action);
    },

    stop: function() {
      _stopEvalTimer();
      _state.loaded = false;
    },

    getNextScheduledRun: function(workflowId) {
      var idx = _findWorkflow(workflowId);
      if (idx < 0) return null;
      var wf = _state.workflows[idx];
      if (wf.trigger.type === 'schedule' && wf.trigger.cron) {
        return _getNextCronTime(wf.trigger.cron);
      }
      if (wf.trigger.type === 'interval' && wf.trigger.intervalMs) {
        var last = wf.lastExecution || wf.createdAt;
        var lastTime = new Date(last).getTime();
        if (isNaN(lastTime)) return new Date(Date.now() + wf.trigger.intervalMs).toISOString();
        return new Date(lastTime + wf.trigger.intervalMs).toISOString();
      }
      return null;
    }
  };

  // Auto-init on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { D.AgentAutomation.init(); });
  } else {
    D.AgentAutomation.init();
  }
})();
