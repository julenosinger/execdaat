// ============================================================
// EXECDAAT AGENT TREASURY — Treasury Policies Engine
// Build: 20260722 — Policy rules for treasury governance
//
// Exposes: D.AgentTreasury.Policies
//
// Events emitted:
//   agentTreasury:policyRuleAdded
//   agentTreasury:policyRuleTriggered
//   agentTreasury:policyEvaluationComplete
// ============================================================
;(function() {
  'use strict';
  var D = window.ExecDaat = window.ExecDaat || {};

  var POLICIES_KEY = 'execdaat_treasury_policies';

  function _emit(name, detail) {
    window.dispatchEvent(new CustomEvent('agentTreasury:' + name, { detail: detail || {} }));
  }

  function _uid() {
    return 'pol_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function _nowISO() {
    return new Date().toISOString();
  }

  function _loadPolicies() {
    try {
      var raw = localStorage.getItem(POLICIES_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore */ }
    return [];
  }

  function _savePolicies(policies) {
    try { localStorage.setItem(POLICIES_KEY, JSON.stringify(policies)); } catch (e) { /* ignore */ }
  }

  function _evaluateCondition(condition, context) {
    if (!condition || !context) return false;

    var fieldVal = context[condition.field];
    if (fieldVal === undefined || fieldVal === null) return false;

    var op = condition.operator;
    var val = condition.value;

    switch (op) {
      case 'gt':  return Number(fieldVal) >  Number(val);
      case 'lt':  return Number(fieldVal) <  Number(val);
      case 'gte': return Number(fieldVal) >= Number(val);
      case 'lte': return Number(fieldVal) <= Number(val);
      case 'eq':  return fieldVal == val;
      case 'neq': return fieldVal != val;
      default:    return false;
    }
  }

  function _buildDefaultRules() {
    return [
      {
        id: _uid(),
        name: 'Gas Reserve Protection',
        condition: { field: 'gas_reserve', operator: 'lt', value: 10 },
        action: { type: 'warn', params: { severity: 'medium', message: 'Gas Reserve allocation is below minimum threshold of 10 USDC' } },
        priority: 1,
        active: true,
        createdAt: _nowISO()
      },
      {
        id: _uid(),
        name: 'Operational Minimum',
        condition: { field: 'operational', operator: 'lt', value: 50 },
        action: { type: 'warn', params: { severity: 'medium', message: 'Operational allocation is below minimum threshold of 50 USDC' } },
        priority: 2,
        active: true,
        createdAt: _nowISO()
      },
      {
        id: _uid(),
        name: 'Treasury Overflow',
        condition: { field: 'totalBalance', operator: 'gt', value: 1000 },
        action: { type: 'suggest', params: { target: 'yield', message: 'Total balance exceeds 1000 USDC — consider allocating surplus to yield strategies' } },
        priority: 3,
        active: true,
        createdAt: _nowISO()
      }
    ];
  }

  // ═══════════════════════════════════════════════════════════════
  //  AGENT TREASURY POLICIES
  // ═══════════════════════════════════════════════════════════════

  var T = D.AgentTreasury = D.AgentTreasury || {};

  T.Policies = {
    addRule: function(name, condition, action, priority) {
      var rules = _loadPolicies();
      var existing = rules.find(function(r) { return r.name === name; });
      if (existing) {
        existing.condition = condition || existing.condition;
        existing.action = action || existing.action;
        existing.priority = priority !== undefined ? priority : existing.priority;
        existing.active = true;
        _savePolicies(rules);
        _emit('policyRuleAdded', { rule: existing, updated: true });
        return existing;
      }

      var rule = {
        id: _uid(),
        name: name,
        condition: condition || { field: '', operator: 'eq', value: null },
        action: action || { type: 'log', params: {} },
        priority: priority || 50,
        active: true,
        createdAt: _nowISO()
      };

      rules.push(rule);
      _savePolicies(rules);

      _emit('policyRuleAdded', { rule: rule, updated: false });
      return rule;
    },

    removeRule: function(name) {
      var rules = _loadPolicies();
      var idx = -1;
      for (var i = 0; i < rules.length; i++) {
        if (rules[i].name === name) { idx = i; break; }
      }
      if (idx === -1) return false;

      rules.splice(idx, 1);
      _savePolicies(rules);
      return true;
    },

    evaluateRules: function(context) {
      var rules = _loadPolicies();
      if (rules.length === 0) {
        _emit('policyEvaluationComplete', { matched: [], total: 0 });
        return [];
      }

      rules.sort(function(a, b) { return a.priority - b.priority; });

      var results = [];
      rules.forEach(function(rule) {
        if (!rule.active) return;
        if (_evaluateCondition(rule.condition, context)) {
          results.push({
            ruleId: rule.id,
            ruleName: rule.name,
            action: rule.action,
            priority: rule.priority,
            matchedAt: _nowISO()
          });
          _emit('policyRuleTriggered', { rule: rule, context: context });
        }
      });

      _emit('policyEvaluationComplete', { matched: results, total: rules.length, context: context });
      return results;
    },

    getRules: function() {
      var rules = _loadPolicies();
      rules.sort(function(a, b) { return a.priority - b.priority; });
      return rules;
    },

    validateOperation: function(operation) {
      if (!operation) return { valid: false, reasons: ['No operation provided'] };

      var context = {
        totalBalance: operation.totalBalance || 0,
        amount: operation.amount || 0,
        token: operation.token || 'USDC',
        allocationType: operation.allocationType || null,
        perTx: operation.perTx || 0
      };

      if (operation.allocations) {
        Object.keys(operation.allocations).forEach(function(key) {
          context[key] = operation.allocations[key];
        });
      }

      var violators = [];
      var rules = _loadPolicies().filter(function(r) { return r.active; });

      rules.forEach(function(rule) {
        if (_evaluateCondition(rule.condition, context)) {
          violators.push({
            ruleId: rule.id,
            ruleName: rule.name,
            action: rule.action,
            reason: rule.action.params ? rule.action.params.message : rule.name
          });
        }
      });

      return {
        valid: violators.length === 0,
        reasons: violators,
        totalRules: rules.length,
        violated: violators.length
      };
    }
  };

  // ── Initialize default rules if none exist ─────────────────
  (function _initDefaults() {
    var existing = _loadPolicies();
    if (existing.length === 0) {
      _savePolicies(_buildDefaultRules());
    }
  })();

  console.log('[AgentTreasury Policies] Loaded');
})();
