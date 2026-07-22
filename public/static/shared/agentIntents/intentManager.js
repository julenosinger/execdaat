// ============================================================
// EXECDAAT AGENT INTENTS — Intent Manager
// Build: 20260722 — IIFE / Event-based / Pure logic
//
// Namespace: D.AgentIntents
// Manages financial intents — structured representation of what
// the user or AI wants to do.
// ============================================================
;(function() {
  'use strict';
  var D = window.ExecDaat = window.ExecDaat || {};

  var LS_KEY = 'execdaat_agent_intents';
  var EXPIRE_CHECK_MS = 5 * 60 * 1000;

  var _state = {
    intents: [],
    loaded: false
  };

  var _expireTimer = null;

  function _emit(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent('agentIntent:' + name, { detail: detail || {} }));
    } catch (e) { /* never throw from event handlers */ }
  }

  function _save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        intents: _state.intents,
        loaded: _state.loaded
      }));
    } catch (e) { /* quota exceeded */ }
  }

  function _load() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) {
        var data = JSON.parse(raw);
        _state.intents = data.intents || [];
        _state.loaded = data.loaded || false;
      }
    } catch (e) { /* corrupt data */ }
  }

  function _now() {
    return new Date().toISOString();
  }

  function _uid() {
    return 'int_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function _formatAmount(amount) {
    var n = Number(amount);
    if (!isFinite(n)) return '0.000000';
    return n.toFixed(6);
  }

  function _findIntentIndex(intentId) {
    for (var i = 0; i < _state.intents.length; i++) {
      if (_state.intents[i].id === intentId) return i;
    }
    return -1;
  }

  function _isExpired(intent) {
    if (!intent.expiresAt) return false;
    return new Date(intent.expiresAt) < new Date();
  }

  function _isTerminal(status) {
    return ['completed', 'failed', 'cancelled', 'expired'].indexOf(status) !== -1;
  }

  function _ensureState() {
    if (!_state.loaded) {
      _load();
      _state.loaded = true;
      _save();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  VALIDATORS
  // ═══════════════════════════════════════════════════════════════

  function _validateIntentParams(type, params) {
    var errors = [];
    params = params || {};

    var supportedTypes = ['transfer', 'swap', 'bridge', 'schedule', 'allocate', 'multisend'];
    if (supportedTypes.indexOf(type) === -1) {
      errors.push('Unsupported intent type: ' + type);
      return { valid: false, errors: errors };
    }

    if (type === 'transfer' || type === 'multisend') {
      if (!params.token) errors.push('Token is required');
      var amt = Number(params.amount);
      if (!params.amount || !isFinite(amt) || amt <= 0) errors.push('Valid amount is required');
      if (!params.to && type !== 'multisend') errors.push('Recipient address is required');
    }

    if (type === 'swap') {
      if (!params.token) errors.push('Source token is required');
      if (!params.to) errors.push('Destination token is required');
      var swapAmt = Number(params.amount);
      if (!params.amount || !isFinite(swapAmt) || swapAmt <= 0) errors.push('Valid amount is required');
    }

    if (type === 'bridge') {
      if (!params.token) errors.push('Token is required');
      var bridgeAmt = Number(params.amount);
      if (!params.amount || !isFinite(bridgeAmt) || bridgeAmt <= 0) errors.push('Valid amount is required');
      if (!params.chainId) errors.push('Destination chain ID is required');
    }

    if (type === 'schedule') {
      if (!params.schedule || !params.schedule.cron) errors.push('Cron expression is required');
    }

    if (type === 'allocate') {
      if (!params.token) errors.push('Token is required');
      var allocAmt = Number(params.amount);
      if (!params.amount || !isFinite(allocAmt) || allocAmt <= 0) errors.push('Valid amount is required');
    }

    return { valid: errors.length === 0, errors: errors };
  }

  // ═══════════════════════════════════════════════════════════════
  //  INTENT MANAGER — Public API
  // ═══════════════════════════════════════════════════════════════

  D.AgentIntents = {

    get state() { return Object.assign({}, _state); },
    get intents() { return _state.intents.slice(); },
    get loaded() { return _state.loaded; },

    // ── Init ────────────────────────────────────────────────────────────────
    init: function() {
      if (_state.loaded) return _state;
      _load();
      _state.loaded = true;
      _save();

      D.AgentIntents.expireIntents();

      if (!_expireTimer) {
        _expireTimer = setInterval(function() {
          D.AgentIntents.expireIntents();
        }, EXPIRE_CHECK_MS);
      }

      return _state;
    },

    // ── Create Intent ───────────────────────────────────────────────────────
    create: function(type, params, source) {
      _ensureState();

      var validation = _validateIntentParams(type, params);
      if (!validation.valid) {
        return { success: false, errors: validation.errors };
      }

      var intent = {
        id: _uid(),
        type: type,
        status: 'draft',
        summary: '',
        params: {
          amount: _formatAmount(params.amount || 0),
          token: params.token || 'USDC',
          from: params.from || '',
          to: params.to || '',
          chainId: params.chainId || null,
          schedule: params.schedule || null,
          metadata: params.metadata || {}
        },
        permissions: {
          required: params.requiredCapabilities || [type],
          granted: []
        },
        approvals: {
          required: false,
          approved: false,
          approvedBy: '',
          approvedAt: ''
        },
        policies: {
          passed: false,
          warnings: [],
          blocks: []
        },
        execution: {
          txHash: '',
          blockNumber: 0,
          executedAt: '',
          error: ''
        },
        expiresAt: params.expiresAt || '',
        createdAt: _now(),
        updatedAt: _now(),
        source: source || 'user'
      };

      intent.summary = _buildSummary(intent);

      _state.intents.push(intent);
      _save();
      _emit('created', { intent: intent });
      return { success: true, intent: intent };
    },

    // ── Submit Intent ───────────────────────────────────────────────────────
    submit: function(intentId) {
      _ensureState();
      var idx = _findIntentIndex(intentId);
      if (idx < 0) return { success: false, error: 'Intent not found: ' + intentId };

      var intent = _state.intents[idx];

      if (intent.status !== 'draft') {
        return { success: false, error: 'Intent must be in draft status to submit' };
      }

      var validation = D.AgentIntents.validateIntent(intentId);
      if (!validation.valid) {
        return { success: false, errors: validation.errors, warnings: validation.warnings };
      }

      if (validation.requiresApproval) {
        intent.status = 'pending';
        intent.approvals.required = true;
        intent.approvals.approved = false;
      } else {
        intent.status = 'approved';
        intent.approvals.required = false;
        intent.approvals.approved = true;
        intent.approvals.approvedBy = '';
        intent.approvals.approvedAt = _now();
      }

      intent.policies.passed = validation.valid;
      intent.policies.warnings = validation.warnings || [];
      intent.policies.blocks = validation.blocks || [];
      intent.updatedAt = _now();

      _save();

      if (intent.status === 'approved') {
        _emit('approved', { intent: intent });
      }
      _emit('submitted', { intent: intent });
      return { success: true, intent: intent };
    },

    // ── Cancel Intent ───────────────────────────────────────────────────────
    cancel: function(intentId) {
      _ensureState();
      var idx = _findIntentIndex(intentId);
      if (idx < 0) return { success: false, error: 'Intent not found: ' + intentId };

      var intent = _state.intents[idx];

      if (_isTerminal(intent.status)) {
        return { success: false, error: 'Intent is already in terminal state: ' + intent.status };
      }

      intent.status = 'cancelled';
      intent.updatedAt = _now();
      _save();
      _emit('cancelled', { intent: intent });
      return { success: true, intent: intent };
    },

    // ── Approve Intent ──────────────────────────────────────────────────────
    approve: function(intentId) {
      _ensureState();
      var idx = _findIntentIndex(intentId);
      if (idx < 0) return { success: false, error: 'Intent not found: ' + intentId };

      var intent = _state.intents[idx];

      if (intent.status !== 'pending') {
        return { success: false, error: 'Intent must be pending to approve' };
      }

      intent.status = 'approved';
      intent.approvals.approved = true;
      intent.approvals.approvedAt = _now();
      intent.updatedAt = _now();
      _save();
      _emit('approved', { intent: intent });
      return { success: true, intent: intent };
    },

    // ── Reject Intent ───────────────────────────────────────────────────────
    reject: function(intentId, reason) {
      _ensureState();
      var idx = _findIntentIndex(intentId);
      if (idx < 0) return { success: false, error: 'Intent not found: ' + intentId };

      var intent = _state.intents[idx];

      if (intent.status !== 'pending') {
        return { success: false, error: 'Intent must be pending to reject' };
      }

      intent.status = 'failed';
      intent.execution.error = reason || 'Rejected by approver';
      intent.updatedAt = _now();
      _save();
      _emit('rejected', { intent: intent, reason: reason || 'Rejected' });
      return { success: true, intent: intent };
    },

    // ── Get Intent ──────────────────────────────────────────────────────────
    getIntent: function(intentId) {
      _ensureState();
      var idx = _findIntentIndex(intentId);
      if (idx < 0) return null;
      return Object.assign({}, _state.intents[idx]);
    },

    // ── Get Intents (filtered) ──────────────────────────────────────────────
    getIntents: function(filter) {
      _ensureState();
      filter = filter || {};
      return _state.intents.filter(function(intent) {
        if (filter.status && intent.status !== filter.status) return false;
        if (filter.type && intent.type !== filter.type) return false;
        if (filter.source && intent.source !== filter.source) return false;
        return true;
      });
    },

    // ── Get Pending Intents ─────────────────────────────────────────────────
    getPendingIntents: function() {
      _ensureState();
      return _state.intents
        .filter(function(intent) {
          return intent.status === 'pending';
        })
        .sort(function(a, b) {
          return new Date(a.createdAt) - new Date(b.createdAt);
        });
    },

    // ── Get Active Intents ──────────────────────────────────────────────────
    getActiveIntents: function() {
      _ensureState();
      return _state.intents.filter(function(intent) {
        return intent.status === 'pending' || intent.status === 'executing';
      });
    },

    // ── Get Intent History ──────────────────────────────────────────────────
    getIntentHistory: function(limit) {
      _ensureState();
      limit = limit || 50;
      return _state.intents
        .filter(function(intent) {
          return intent.status === 'completed' || intent.status === 'failed';
        })
        .sort(function(a, b) {
          return new Date(b.updatedAt) - new Date(a.updatedAt);
        })
        .slice(0, limit);
    },

    // ── Update Intent Status ────────────────────────────────────────────────
    updateIntentStatus: function(intentId, status, details) {
      _ensureState();
      var idx = _findIntentIndex(intentId);
      if (idx < 0) return { success: false, error: 'Intent not found: ' + intentId };

      var intent = _state.intents[idx];
      var oldStatus = intent.status;
      intent.status = status;
      intent.updatedAt = _now();

      if (details) {
        if (details.txHash) intent.execution.txHash = details.txHash;
        if (details.blockNumber !== undefined) intent.execution.blockNumber = details.blockNumber;
        if (details.executedAt) intent.execution.executedAt = details.executedAt;
        if (details.error) intent.execution.error = details.error;
      }

      _save();

      if (status === 'executing') intent.execution.executedAt = _now();
      if (status === 'completed') {
        intent.execution.executedAt = intent.execution.executedAt || _now();
        _emit('completed', { intent: intent, previousStatus: oldStatus });
      }
      if (status === 'failed') _emit('failed', { intent: intent, error: (details && details.error) || '' });

      return { success: true, intent: intent };
    },

    // ── Expire Intents ──────────────────────────────────────────────────────
    expireIntents: function() {
      _ensureState();
      var expired = [];

      for (var i = 0; i < _state.intents.length; i++) {
        var intent = _state.intents[i];
        if (_isTerminal(intent.status)) continue;
        if (_isExpired(intent)) {
          intent.status = 'expired';
          intent.updatedAt = _now();
          expired.push(intent);
          _emit('expired', { intent: intent });
        }
      }

      if (expired.length > 0) {
        _save();
      }

      return expired;
    },

    // ── Validate Intent ─────────────────────────────────────────────────────
    validateIntent: function(intentId) {
      _ensureState();
      var idx = _findIntentIndex(intentId);
      if (idx < 0) return { valid: false, errors: ['Intent not found: ' + intentId] };

      var intent = _state.intents[idx];
      var errors = [];
      var warnings = [];
      var blocks = [];
      var requiresApproval = false;

      // 1. Check agent is registered
      var AW = D.AgentWallet;
      if (AW) {
        try {
          var awState = AW.state || {};
          if (!awState.isRegistered) {
            errors.push('Agent is not registered');
            return { valid: false, errors: errors, warnings: warnings, requiresApproval: false, blocks: blocks };
          }
        } catch (e) {
          errors.push('Unable to verify agent registration');
          return { valid: false, errors: errors, warnings: warnings, requiresApproval: false, blocks: blocks };
        }
      } else {
        warnings.push('AgentWallet module not loaded — skipping registration check');
      }

      // 2. Check permissions
      var AP = D.AgentPermissions;
      if (AP && typeof AP.checkPermission === 'function') {
        try {
          var capCheck = AP.checkPermission(
            intent.type,
            intent.params.amount,
            intent.params.token
          );
          if (!capCheck.allowed) {
            errors.push('Permission denied: ' + (capCheck.reason || 'Insufficient permissions'));
            blocks.push({ source: 'permissions', reason: capCheck.reason || 'Insufficient permissions' });
          }
          if (capCheck.remaining && Number(capCheck.remaining) < Number(intent.params.amount)) {
            warnings.push('Remaining limit may be insufficient: ' + capCheck.remaining + ' remaining');
          }
        } catch (e) {
          warnings.push('Permission check failed: ' + e.message);
        }
      }

      // 3. Check treasury limits
      var AT = D.AgentTreasury;
      if (AT && typeof AT.canSpend === 'function') {
        try {
          var spendCheck = AT.canSpend(intent.params.amount, intent.params.token);
          if (!spendCheck.allowed) {
            errors.push('Treasury limit exceeded: ' + (spendCheck.reason || 'Insufficient treasury'));
            blocks.push({ source: 'treasury', reason: spendCheck.reason || 'Treasury limit exceeded' });
          }
        } catch (e) {
          warnings.push('Treasury check failed: ' + e.message);
        }
      }

      // 4. Evaluate policies
      var policies = D.AgentPolicies;
      if (policies && typeof policies.evaluateForOperation === 'function') {
        try {
          var operation = {
            type: intent.type,
            amount: Number(intent.params.amount) || 0,
            token: intent.params.token || 'USDC',
            from: intent.params.from || '',
            to: intent.params.to || '',
            chainId: intent.params.chainId || null,
            capability: intent.type
          };

          var policyResult = policies.evaluateForOperation(operation);

          if (policyResult.blocked) {
            errors.push('Operation blocked by policy');
            policyResult.warnings.forEach(function(w) {
              blocks.push({ source: 'policy:' + w.rule, reason: w.message });
            });
          }

          if (policyResult.requireApproval) {
            requiresApproval = true;
            warnings.push('Operation requires approval');
          }

          if (policyResult.warnings && policyResult.warnings.length > 0) {
            policyResult.warnings.forEach(function(w) {
              warnings.push('Policy: ' + w.message);
            });
          }

          if (policyResult.suggestions && policyResult.suggestions.length > 0) {
            policyResult.suggestions.forEach(function(s) {
              warnings.push('Suggestion: ' + s.message);
            });
          }
        } catch (e) {
          warnings.push('Policy evaluation failed: ' + e.message);
        }
      }

      var result = {
        valid: errors.length === 0,
        errors: errors,
        warnings: warnings,
        requiresApproval: requiresApproval,
        blocks: blocks
      };

      _emit('validated', { intentId: intentId, result: result });
      return result;
    },

    // ── Summarize Intents ───────────────────────────────────────────────────
    summarizeIntents: function() {
      _ensureState();
      var counts = {
        total: _state.intents.length,
        draft: 0,
        pending: 0,
        approved: 0,
        executing: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        expired: 0
      };

      for (var i = 0; i < _state.intents.length; i++) {
        var s = _state.intents[i].status;
        if (counts.hasOwnProperty(s)) {
          counts[s]++;
        }
      }

      var active = D.AgentIntents.getActiveIntents();
      var pending = D.AgentIntents.getPendingIntents();

      return {
        counts: counts,
        activeCount: active.length,
        pendingCount: pending.length,
        pendingIntents: pending.slice(0, 10).map(function(i) {
          return {
            id: i.id,
            type: i.type,
            summary: i.summary,
            status: i.status,
            createdAt: i.createdAt
          };
        }),
        activeIntents: active.slice(0, 10).map(function(i) {
          return {
            id: i.id,
            type: i.type,
            summary: i.summary,
            status: i.status,
            createdAt: i.createdAt
          };
        })
      };
    }
  };

  // ── Helpers ──────────────────────────────────────────────────────────────

  function _buildSummary(intent) {
    var p = intent.params;
    switch (intent.type) {
      case 'transfer':
        return 'Transfer ' + p.amount + ' ' + p.token + (p.to ? ' to ' + _shortAddr(p.to) : '');
      case 'swap':
        return 'Swap ' + p.amount + ' ' + p.token + ' → ' + p.to;
      case 'bridge':
        return 'Bridge ' + p.amount + ' ' + p.token + ' to chain ' + p.chainId;
      case 'schedule':
        return 'Scheduled: ' + p.token + ' transfer';
      case 'allocate':
        return 'Allocate ' + p.amount + ' ' + p.token;
      case 'multisend':
        return 'Multi-send ' + p.amount + ' ' + p.token;
      default:
        return intent.type + ': ' + p.amount + ' ' + p.token;
    }
  }

  function _shortAddr(addr) {
    if (!addr || typeof addr !== 'string') return 'unknown';
    if (addr.length <= 10) return addr;
    return addr.slice(0, 6) + '...' + addr.slice(-4);
  }

  console.log('[AgentIntents] Intent Manager loaded');
})();
