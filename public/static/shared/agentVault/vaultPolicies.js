// ============================================================
// EXECDAAT AGENT VAULT — Vault Policies
// Build: 20260722 — IIFE / Event-based / Pure logic
//
// Namespace: D.AgentVault.Policies
// ============================================================
;(function() {
  'use strict';
  var D = window.ExecDaat = window.ExecDaat || {};

  var LS_KEY = 'execdaat_vault_policies';

  var _rules = {};

  // ── Built-in default rules ───────────────────────────────────────────────

  var BUILT_IN_RULES = {
    'Minimum Gas Reserve': {
      name: 'Minimum Gas Reserve',
      condition: function(ctx) {
        // gas_reserve must stay > 0 at all times
        if (ctx.allocationType !== 'agent_gas') return true;
        var vault = D.AgentVault;
        if (!vault) return true;
        var gasAlloc = vault.getAllocation('agent_gas');
        if (!gasAlloc) return true;
        var available = Number(gasAlloc.available) || 0;
        var requested = Number(ctx.amount) || 0;
        return (available - requested) > 0;
      },
      action: function(ctx) {
        return { allowed: false, reason: 'Gas reserve must remain above 0' };
      }
    },
    'Automation Cap': {
      name: 'Automation Cap',
      condition: function(ctx) {
        // automation allocation capped at 50% of total treasury
        if (ctx.allocationType !== 'agent_automation') return true;
        var vault = D.AgentVault;
        if (!vault) return true;
        var summary = vault.summarizeVault();
        var treasuryTotal = Number(summary.treasuryTotal) || 0;
        if (treasuryTotal <= 0) return true;
        var autoAlloc = vault.getAllocation('agent_automation');
        var currentAuto = autoAlloc ? (Number(autoAlloc.allocated) || 0) : 0;
        var requested = Number(ctx.amount) || 0;
        var newAutoTotal = currentAuto + requested;
        var cap = treasuryTotal * 0.5;
        return newAutoTotal <= cap;
      },
      action: function(ctx) {
        return { allowed: false, reason: 'Automation allocation exceeds 50% cap of total treasury' };
      }
    },
    'Yield Safety': {
      name: 'Yield Safety',
      condition: function(ctx) {
        // yield allocation requires minimum 100 USDC treasury first
        if (ctx.allocationType !== 'agent_yield') return true;
        var vault = D.AgentVault;
        if (!vault) return true;
        var treasuryAlloc = vault.getAllocation('agent_treasury');
        if (!treasuryAlloc) return true;
        var treasuryBalance = Number(treasuryAlloc.available) || 0;
        return treasuryBalance >= 100;
      },
      action: function(ctx) {
        return { allowed: false, reason: 'Yield allocation requires minimum 100 USDC in treasury first' };
      }
    }
  };

  function _emit(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent('agentVault:' + name, { detail: detail || {} }));
    } catch (e) { /* never throw from event handlers */ }
  }

  function _save() {
    try {
      var data = {};
      Object.keys(_rules).forEach(function(k) {
        var r = _rules[k];
        data[k] = {
          name: r.name,
          conditionSource: r.conditionSource || '',
          actionSource: r.actionSource || '',
          builtIn: r.builtIn || false
        };
      });
      localStorage.setItem(LS_KEY, JSON.stringify(data));
    } catch (e) { /* quota exceeded */ }
  }

  function _load() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) {
        var data = JSON.parse(raw);
        Object.keys(data).forEach(function(k) {
          var r = data[k];
          if (!r.builtIn && _rules[k]) {
            // Only restore user-defined rules; built-ins are always re-created
          } else if (r.builtIn && BUILT_IN_RULES[k]) {
            // Keep built-in – no-op, already loaded
          }
        });
      }
    } catch (e) { /* corrupt data */ }
  }

  // Initialize built-in rules
  Object.keys(BUILT_IN_RULES).forEach(function(name) {
    _rules[name] = {
      name: name,
      condition: BUILT_IN_RULES[name].condition,
      action: BUILT_IN_RULES[name].action,
      conditionSource: null,
      actionSource: null,
      builtIn: true
    };
  });

  _load();

  // ═══════════════════════════════════════════════════════════════
  //  PUBLIC API — D.AgentVault.Policies
  // ═══════════════════════════════════════════════════════════════

  // Ensure parent namespace exists
  D.AgentVault = D.AgentVault || {};
  D.AgentVault.Policies = {

    // ── Add Rule ────────────────────────────────────────────────────────────
    addRule: function(name, condition, action) {
      if (!name || typeof name !== 'string') {
        return { success: false, error: 'Rule name is required' };
      }
      if (typeof condition !== 'function') {
        return { success: false, error: 'Condition must be a function' };
      }
      if (typeof action !== 'function') {
        return { success: false, error: 'Action must be a function' };
      }

      var existing = _rules[name];
      var isBuiltIn = existing && existing.builtIn;

      _rules[name] = {
        name: name,
        condition: condition,
        action: action,
        conditionSource: condition.toString(),
        actionSource: action.toString(),
        builtIn: isBuiltIn || false
      };

      _save();
      _emit('policyRuleAdded', { name: name, builtIn: _rules[name].builtIn });
      return { success: true, rule: _rules[name] };
    },

    // ── Remove Rule ────────────────────────────────────────────────────────
    removeRule: function(name) {
      if (!_rules[name]) {
        return { success: false, error: 'Rule not found: ' + name };
      }
      if (_rules[name].builtIn) {
        return { success: false, error: 'Cannot remove built-in rule: ' + name };
      }

      delete _rules[name];
      _save();
      _emit('policyRuleRemoved', { name: name });
      return { success: true };
    },

    // ── Evaluate Rules ─────────────────────────────────────────────────────
    evaluateRules: function(context) {
      context = context || {};
      var results = [];
      var names = Object.keys(_rules);

      for (var i = 0; i < names.length; i++) {
        var name = names[i];
        var rule = _rules[name];
        try {
          var passed = rule.condition(context);
          if (!passed) {
            var outcome = rule.action(context) || { allowed: false, reason: 'Policy violation: ' + name };
            _emit('policyRuleTriggered', {
              rule: name,
              context: context,
              outcome: outcome
            });
            results.push({
              rule: name,
              allowed: false,
              reason: outcome.reason || ('Policy violation: ' + name)
            });
          } else {
            results.push({ rule: name, allowed: true, reason: null });
          }
        } catch (e) {
          // Error in rule evaluation – treat as passed to avoid blocking
          results.push({ rule: name, allowed: true, reason: null, error: e.message });
        }
      }

      return results;
    },

    // ── Get Rules ──────────────────────────────────────────────────────────
    getRules: function() {
      var list = [];
      Object.keys(_rules).forEach(function(k) {
        var r = _rules[k];
        list.push({
          name: r.name,
          builtIn: r.builtIn || false
        });
      });
      return list;
    },

    // ── Validate Allocation ────────────────────────────────────────────────
    validateAllocation: function(type, amount) {
      var context = {
        allocationType: type,
        amount: Number(amount) || 0,
        timestamp: new Date().toISOString()
      };

      var results = D.AgentVault.Policies.evaluateRules(context);

      for (var i = 0; i < results.length; i++) {
        if (!results[i].allowed) {
          return { allowed: false, reason: results[i].reason, failedRule: results[i].rule };
        }
      }

      return { allowed: true, reason: null };
    }
  };

  console.log('[AgentVault] Vault Policies loaded (' + Object.keys(_rules).length + ' rules)');
})();
