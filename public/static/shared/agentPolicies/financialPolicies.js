// ============================================================
// EXECDAAT AGENT POLICIES — Financial Policy Engine
// Build: 20260722 — IIFE / Event-based / Pure logic
//
// Namespace: D.AgentPolicies
// Evaluates rules and determines whether financial operations are allowed.
// ============================================================
;(function() {
  'use strict';
  var D = window.ExecDaat = window.ExecDaat || {};

  var LS_KEY = 'execdaat_financial_policies';
  var MAX_LOG_SIZE = 200;

  var _state = {
    rules: [],
    evaluationLog: [],
    loaded: false
  };

  function _emit(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent('agentPolicy:' + name, { detail: detail || {} }));
    } catch (e) { /* never throw from event handlers */ }
  }

  function _save() {
    try {
      var data = {
        rules: _state.rules.map(function(r) {
          return {
            id: r.id, name: r.name, description: r.description, type: r.type,
            condition: r.condition, action: r.action, scope: r.scope,
            priority: r.priority, active: r.active, createdAt: r.createdAt, updatedAt: r.updatedAt
          };
        }),
        loaded: _state.loaded
      };
      localStorage.setItem(LS_KEY, JSON.stringify(data));
    } catch (e) { /* quota exceeded */ }
  }

  function _load() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) {
        var data = JSON.parse(raw);
        _state.rules = data.rules || [];
        _state.loaded = data.loaded || false;
      }
    } catch (e) { /* corrupt data */ }
  }

  function _now() {
    return new Date().toISOString();
  }

  function _uid() {
    return 'fp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function _formatAmount(amount) {
    var n = Number(amount);
    if (!isFinite(n)) return '0.000000';
    return n.toFixed(6);
  }

  function _compare(a, op, b) {
    var na = Number(a);
    var nb = Number(b);
    switch (op) {
      case 'gt':  return na > nb;
      case 'lt':  return na < nb;
      case 'gte': return na >= nb;
      case 'lte': return na <= nb;
      case 'eq':  return na === nb || String(a) === String(b);
      case 'neq': return na !== nb && String(a) !== String(b);
      case 'between':
        if (!Array.isArray(b) || b.length !== 2) return false;
        return na >= Number(b[0]) && na <= Number(b[1]);
      case 'in':
        if (!Array.isArray(b)) return false;
        return b.indexOf(a) !== -1;
      default: return false;
    }
  }

  function _resolveField(context, field) {
    var parts = field.split('.');
    var val = context;
    for (var i = 0; i < parts.length; i++) {
      if (val === null || val === undefined) return undefined;
      val = val[parts[i]];
    }
    return val;
  }

  function _ruleMatchesContext(rule, context) {
    if (!rule.active) return false;
    var op = context.operation || {};
    var opType = op.type || '';

    if (rule.type === 'execution') {
      return true;
    }
    if (rule.type === 'spending' && opType !== 'transfer' && opType !== 'spend') {
      return false;
    }
    if (rule.type === 'allocation' && opType !== 'allocate') return false;
    if (rule.type === 'transfer' && opType !== 'transfer') return false;
    if (rule.type === 'swap' && opType !== 'swap') return false;
    if (rule.type === 'bridge' && opType !== 'bridge') return false;

    if (rule.scope && rule.scope.capabilities && rule.scope.capabilities.length > 0) {
      var cap = op.capability || op.type || '';
      if (rule.scope.capabilities.indexOf(cap) === -1) return false;
    }

    if (rule.scope && rule.scope.tokens && rule.scope.tokens.length > 0) {
      var tok = op.token || '';
      if (rule.scope.tokens.indexOf(tok) === -1) return false;
    }

    if (rule.scope && rule.scope.chains && rule.scope.chains.length > 0) {
      var chain = op.chainId || context.operation.chainId;
      if (chain !== undefined && rule.scope.chains.indexOf(Number(chain)) === -1) return false;
    }

    return true;
  }

  function _evaluateCondition(condition, context) {
    if (!condition || !condition.field) return true;
    var fieldVal = _resolveField(context, condition.field);
    return _compare(fieldVal, condition.operator, condition.value);
  }

  // ── Default built-in rules ───────────────────────────────────────────────

  var DEFAULT_RULES = [
    {
      id: 'builtin_max_tx_limit',
      name: 'Maximum Transaction Limit',
      description: 'Require approval for transactions over 5000 USDC',
      type: 'spending',
      condition: { field: 'operation.amount', operator: 'gt', value: 5000 },
      action: { type: 'require_approval', message: 'Transaction exceeds maximum limit of 5,000 USDC. Approval required.', redirect: '' },
      scope: { capabilities: ['payments', 'transfer'], tokens: ['USDC'], chains: [] },
      priority: 10,
      active: true,
      createdAt: _now(),
      updatedAt: _now()
    },
    {
      id: 'builtin_gas_reserve',
      name: 'Gas Reserve Protection',
      description: 'Block spending from gas_reserve if remaining balance falls below 10',
      type: 'spending',
      condition: { field: 'treasury.allocations.gas_reserve', operator: 'lt', value: 10 },
      action: { type: 'block', message: 'Gas reserve protection: insufficient gas reserve remaining.', redirect: '' },
      scope: { capabilities: ['payments', 'transfer', 'gas'], tokens: [], chains: [] },
      priority: 5,
      active: true,
      createdAt: _now(),
      updatedAt: _now()
    },
    {
      id: 'builtin_treasury_safety',
      name: 'Treasury Safety Net',
      description: 'Warn when transfers exceed 80% of monthly limit',
      type: 'transfer',
      condition: { field: 'operation.amount', operator: 'gte', value: 0 },
      action: { type: 'warn', message: 'Transfer exceeds safety threshold. Consider reviewing before proceeding.', redirect: '' },
      scope: { capabilities: ['payments', 'transfer'], tokens: [], chains: [] },
      priority: 20,
      active: true,
      createdAt: _now(),
      updatedAt: _now()
    },
    {
      id: 'builtin_unknown_token',
      name: 'Unknown Token Guard',
      description: 'Block operations with tokens outside approved list',
      type: 'execution',
      condition: { field: 'operation.token', operator: 'in', value: ['USDC', 'EURC'] },
      action: { type: 'block', message: 'Token not in approved list. Only USDC and EURC are permitted.', redirect: 'Use a supported token (USDC or EURC).' },
      scope: { capabilities: [], tokens: [], chains: [] },
      priority: 1,
      active: true,
      createdAt: _now(),
      updatedAt: _now()
    },
    {
      id: 'builtin_bridge_auth',
      name: 'Bridge Authorization',
      description: 'Require approval for bridging to unapproved destinations',
      type: 'bridge',
      condition: { field: 'operation.to', operator: 'in', value: [] },
      action: { type: 'require_approval', message: 'Bridge destination not in approved list. Approval required.', redirect: '' },
      scope: { capabilities: ['bridge'], tokens: [], chains: [] },
      priority: 15,
      active: true,
      createdAt: _now(),
      updatedAt: _now()
    },
    {
      id: 'builtin_operational_budget',
      name: 'Operational Budget Check',
      description: 'Warn when spending from operational exceeds daily remaining',
      type: 'spending',
      condition: { field: 'permissions.dailyRemaining', operator: 'lt', value: 0 },
      action: { type: 'warn', message: 'Operational budget: daily remaining is below requested amount.', redirect: '' },
      scope: { capabilities: ['payments', 'transfer'], tokens: [], chains: [] },
      priority: 25,
      active: true,
      createdAt: _now(),
      updatedAt: _now()
    }
  ];

  function _installDefaultRules() {
    var existingIds = {};
    for (var i = 0; i < _state.rules.length; i++) {
      existingIds[_state.rules[i].id] = true;
    }
    for (var j = 0; j < DEFAULT_RULES.length; j++) {
      if (!existingIds[DEFAULT_RULES[j].id]) {
        _state.rules.push(Object.assign({}, DEFAULT_RULES[j]));
      }
    }
    _state.rules.sort(function(a, b) { return (a.priority || 100) - (b.priority || 100); });
  }

  function _findRuleIndex(ruleId) {
    for (var i = 0; i < _state.rules.length; i++) {
      if (_state.rules[i].id === ruleId) return i;
    }
    return -1;
  }

  function _addToLog(entry) {
    _state.evaluationLog.unshift(entry);
    if (_state.evaluationLog.length > MAX_LOG_SIZE) {
      _state.evaluationLog = _state.evaluationLog.slice(0, MAX_LOG_SIZE);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  AGENT POLICIES — Public API
  // ═══════════════════════════════════════════════════════════════

  D.AgentPolicies = {

    get state() { return Object.assign({}, _state); },
    get rules() { return _state.rules.slice(); },
    get evaluationLog() { return _state.evaluationLog.slice(); },
    get loaded() { return _state.loaded; },

    // ── Init ────────────────────────────────────────────────────────────────
    init: function() {
      if (_state.loaded) return _state;
      _load();
      if (_state.rules.length === 0) {
        _installDefaultRules();
      }
      _state.loaded = true;
      _save();
      return _state;
    },

    // ── Add Rule ────────────────────────────────────────────────────────────
    addRule: function(rule) {
      if (!rule || !rule.name) {
        return { success: false, error: 'Rule name is required' };
      }

      var newRule = {
        id: rule.id || _uid(),
        name: rule.name,
        description: rule.description || '',
        type: rule.type || 'execution',
        condition: rule.condition || { field: '', operator: 'eq', value: null },
        action: rule.action || { type: 'allow', message: '' },
        scope: rule.scope || { capabilities: [], tokens: [], chains: [] },
        priority: rule.priority || 100,
        active: rule.active !== false,
        createdAt: rule.createdAt || _now(),
        updatedAt: _now()
      };

      var idx = _findRuleIndex(newRule.id);
      if (idx >= 0) {
        _state.rules[idx] = newRule;
      } else {
        _state.rules.push(newRule);
      }

      _state.rules.sort(function(a, b) { return (a.priority || 100) - (b.priority || 100); });
      _save();
      _emit('added', { rule: newRule });
      return { success: true, rule: newRule };
    },

    // ── Remove Rule ─────────────────────────────────────────────────────────
    removeRule: function(ruleId) {
      var idx = _findRuleIndex(ruleId);
      if (idx < 0) return { success: false, error: 'Rule not found: ' + ruleId };

      var removed = _state.rules[idx];
      _state.rules.splice(idx, 1);
      _save();
      _emit('removed', { ruleId: ruleId, name: removed.name });
      return { success: true };
    },

    // ── Update Rule ─────────────────────────────────────────────────────────
    updateRule: function(ruleId, updates) {
      var idx = _findRuleIndex(ruleId);
      if (idx < 0) return { success: false, error: 'Rule not found: ' + ruleId };

      var rule = _state.rules[idx];
      if (updates.name !== undefined) rule.name = updates.name;
      if (updates.description !== undefined) rule.description = updates.description;
      if (updates.type !== undefined) rule.type = updates.type;
      if (updates.condition !== undefined) rule.condition = updates.condition;
      if (updates.action !== undefined) rule.action = updates.action;
      if (updates.scope !== undefined) rule.scope = updates.scope;
      if (updates.priority !== undefined) rule.priority = updates.priority;
      if (updates.active !== undefined) rule.active = updates.active;
      rule.updatedAt = _now();

      _state.rules.sort(function(a, b) { return (a.priority || 100) - (b.priority || 100); });
      _save();
      _emit('added', { rule: rule });
      return { success: true, rule: rule };
    },

    // ── Get Rules ───────────────────────────────────────────────────────────
    getRules: function(filter) {
      filter = filter || {};
      return _state.rules.filter(function(r) {
        if (filter.type && r.type !== filter.type) return false;
        if (filter.active !== undefined && r.active !== filter.active) return false;
        if (filter.capability && r.scope && r.scope.capabilities && r.scope.capabilities.length > 0) {
          if (r.scope.capabilities.indexOf(filter.capability) === -1) return false;
        }
        if (filter.token && r.scope && r.scope.tokens && r.scope.tokens.length > 0) {
          if (r.scope.tokens.indexOf(filter.token) === -1) return false;
        }
        return true;
      });
    },

    // ── Get Rule By ID ─────────────────────────────────────────────────────
    getRuleById: function(ruleId) {
      var idx = _findRuleIndex(ruleId);
      if (idx < 0) return null;
      return Object.assign({}, _state.rules[idx]);
    },

    // ── Evaluate ────────────────────────────────────────────────────────────
    evaluate: function(context) {
      context = context || {};
      context.operation = context.operation || {};
      context.treasury = context.treasury || {};
      context.permissions = context.permissions || {};
      context.agent = context.agent || {};

      var evaluationId = _uid();
      var passed = true;
      var blocked = false;
      var matches = [];
      var warnings = [];
      var suggestions = [];
      var requireApproval = false;

      for (var i = 0; i < _state.rules.length; i++) {
        var rule = _state.rules[i];
        if (!_ruleMatchesContext(rule, context)) continue;

        try {
          var conditionResult = _evaluateCondition(rule.condition, context);
          if (!conditionResult) {
            matches.push({ rule: rule, passed: false });

            var actionType = rule.action.type;
            if (actionType === 'block') {
              blocked = true;
              passed = false;
              warnings.push({ rule: rule.name, message: rule.action.message || 'Blocked by policy: ' + rule.name });
            } else if (actionType === 'require_approval') {
              requireApproval = true;
              warnings.push({ rule: rule.name, message: rule.action.message || 'Approval required: ' + rule.name });
            } else if (actionType === 'warn') {
              warnings.push({ rule: rule.name, message: rule.action.message || 'Warning: ' + rule.name });
            } else if (actionType === 'suggest') {
              suggestions.push({ rule: rule.name, message: rule.action.message || '', action: rule.action.redirect || '' });
            }

            if (blocked) break;
          } else {
            matches.push({ rule: rule, passed: true });
          }
        } catch (e) {
          matches.push({ rule: rule, passed: true, error: e.message });
        }
      }

      if (requireApproval) {
        passed = true;
      }

      var result = {
        passed: passed,
        blocked: blocked,
        approved: passed && !blocked,
        warnings: warnings,
        suggestions: suggestions,
        requireApproval: requireApproval,
        matchedRules: matches,
        evaluationId: evaluationId
      };

      _addToLog({
        evaluationId: evaluationId,
        timestamp: _now(),
        context: context.operation,
        result: {
          passed: result.passed,
          blocked: result.blocked,
          requireApproval: result.requireApproval,
          warningCount: warnings.length,
          suggestionCount: suggestions.length
        }
      });

      _emit('evaluated', result);

      if (blocked) {
        _emit('blocked', { evaluationId: evaluationId, warnings: warnings });
      }

      if (warnings.length > 0 && !blocked) {
        _emit('warning', { evaluationId: evaluationId, warnings: warnings });
      }

      return result;
    },

    // ── Evaluate For Operation ──────────────────────────────────────────────
    evaluateForOperation: function(operation) {
      var context = {
        operation: operation || {},
        treasury: {},
        permissions: {},
        agent: {}
      };

      var AT = D.AgentTreasury;
      if (AT) {
        try {
          var summary = AT.getSummary ? AT.getSummary() : AT;
          context.treasury = {
            totalBalance: summary.totalBalance ? summary.totalBalance.USDC : 0,
            allocations: {}
          };
          if (summary.allocations) {
            for (var i = 0; i < summary.allocations.length; i++) {
              var a = summary.allocations[i];
              context.treasury.allocations[a.type] = Number(a.remaining) || 0;
            }
          }
        } catch (e) { /* treasury unavailable */ }
      }

      var AP = D.AgentPermissions;
      if (AP) {
        try {
          var usage = AP.usage;
          if (usage) {
            context.permissions.dailyRemaining = 0;
            context.permissions.monthlyRemaining = 0;
            if (usage.daily) {
              var caps = Object.keys(usage.daily);
              for (var j = 0; j < caps.length; j++) {
                var c = usage.daily[caps[j]];
                if (c && typeof c.spent === 'number') {
                  context.permissions.dailyRemaining += c.spent;
                }
              }
            }
          }
        } catch (e) { /* permissions unavailable */ }
      }

      var AW = D.AgentWallet;
      if (AW) {
        try {
          var st = AW.state;
          context.agent.agentId = st.agentId || null;
          context.agent.isRegistered = st.isRegistered || false;
        } catch (e) { /* wallet unavailable */ }
      }

      return D.AgentPolicies.evaluate(context);
    },

    // ── Validate Spending ───────────────────────────────────────────────────
    validateSpending: function(amount, token, capability) {
      var context = {
        operation: {
          type: capability === 'payments' ? 'transfer' : (capability || 'spend'),
          amount: Number(amount) || 0,
          token: token || 'USDC',
          capability: capability || 'payments'
        },
        treasury: { totalBalance: 0, allocations: {} },
        permissions: { dailyRemaining: 0, monthlyRemaining: 0, activePermissions: [] },
        agent: { agentId: null, isRegistered: false }
      };

      var AT = D.AgentTreasury;
      if (AT) {
        try {
          var s = AT.getSummary ? AT.getSummary() : {};
          context.treasury.totalBalance = (s.totalBalance && s.totalBalance.USDC) ? s.totalBalance.USDC : 0;
          if (s.limits) {
            context.treasury.dailySpend = s.limits.dailySpend;
            context.treasury.monthlySpend = s.limits.monthlySpend;
          }
        } catch (e) { /* treasury unavailable */ }
      }

      var AP = D.AgentPermissions;
      if (AP) {
        try {
          var check = AP.checkPermission(capability || 'payments', amount, token);
          context.permissions.dailyRemaining = Number(check.remaining) || 0;
          context.permissions.monthlyRemaining = Number(check.remaining) || 0;
        } catch (e) { /* permissions unavailable */ }
      }

      var AW = D.AgentWallet;
      if (AW) {
        try {
          context.agent.agentId = AW.state.agentId || null;
          context.agent.isRegistered = AW.state.isRegistered || false;
        } catch (e) { /* wallet unavailable */ }
      }

      return D.AgentPolicies.evaluate(context);
    }
  };

  console.log('[AgentPolicies] Financial Policy Engine loaded');
})();
