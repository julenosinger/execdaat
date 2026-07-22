// ============================================================
// EXECDAAT AGENT POLICIES — Policy Engine Bridge
// Build: 20260722 — IIFE / Event-based / Pure logic
//
// Namespace: D.AgentPolicies.Bridge
// Bridges financial policies with ExecDaat's existing Policy Engine
// without modifying the original modules.
// ============================================================
;(function() {
  'use strict';
  var D = window.ExecDaat = window.ExecDaat || {};

  var _initialized = false;

  function _emit(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent('agentPolicy:' + name, { detail: detail || {} }));
    } catch (e) { /* never throw from event handlers */ }
  }

  function _now() {
    return new Date().toISOString();
  }

  function _formatAmount(amount) {
    var n = Number(amount);
    if (!isFinite(n)) return '0.000000';
    return n.toFixed(6);
  }

  function _ensurePolicies() {
    var policies = D.AgentPolicies;
    if (!policies || !policies.loaded) {
      if (policies && typeof policies.init === 'function') {
        policies.init();
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  EVENT HANDLERS
  // ═══════════════════════════════════════════════════════════════

  // ── Execution Request Handler ─────────────────────────────────────────────

  function onPreExecution(event) {
    _ensurePolicies();
    var detail = event.detail || {};
    var intent = detail.intent || {};
    var operation = {
      type: intent.type || detail.action || 'transfer',
      amount: Number(intent.amount || detail.amount || 0),
      token: intent.token || detail.token || 'USDC',
      from: intent.from || detail.from || '',
      to: intent.to || detail.to || '',
      chainId: intent.chainId || detail.chainId || null
    };

    var policies = D.AgentPolicies;
    if (!policies || typeof policies.evaluateForOperation !== 'function') {
      _emit('executionApproved', { operation: operation, reason: 'Policy engine not available' });
      return;
    }

    var result = policies.evaluateForOperation(operation);

    if (result.blocked) {
      _emit('executionBlocked', {
        operation: operation,
        evaluationId: result.evaluationId,
        warnings: result.warnings
      });
    } else {
      _emit('executionApproved', {
        operation: operation,
        evaluationId: result.evaluationId,
        requireApproval: result.requireApproval,
        warnings: result.warnings,
        suggestions: result.suggestions
      });
    }
  }

  // ── Spending Request Handler ──────────────────────────────────────────────

  function onPreSpending(event) {
    _ensurePolicies();
    var detail = event.detail || {};
    var amount = detail.amount || 0;
    var token = detail.token || 'USDC';
    var capability = detail.capability || detail.type || 'payments';

    var policies = D.AgentPolicies;
    if (!policies || typeof policies.validateSpending !== 'function') {
      window.dispatchEvent(new CustomEvent('agentTreasury:spendValidated', {
        detail: { allowed: true, reason: 'Policy engine not available', amount: _formatAmount(amount), token: token }
      }));
      return;
    }

    var result = policies.validateSpending(amount, token, capability);
    var eventName = result.blocked ? 'agentTreasury:spendBlocked' : 'agentTreasury:spendValidated';
    window.dispatchEvent(new CustomEvent(eventName, {
      detail: {
        allowed: !result.blocked,
        amount: _formatAmount(amount),
        token: token,
        evaluationId: result.evaluationId,
        requireApproval: result.requireApproval,
        warnings: result.warnings,
        suggestions: result.suggestions
      }
    }));
  }

  // ── Allocation Request Handler ────────────────────────────────────────────

  function onPreAllocation(event) {
    _ensurePolicies();
    var detail = event.detail || {};
    var allocationType = detail.type || detail.allocationType || '';
    var amount = detail.amount || 0;
    var token = detail.token || 'USDC';

    var policies = D.AgentPolicies;
    if (!policies || typeof policies.evaluateForOperation !== 'function') {
      window.dispatchEvent(new CustomEvent('agentVault:allocationValidated', {
        detail: { allowed: true, reason: 'Policy engine not available', type: allocationType, amount: _formatAmount(amount), token: token }
      }));
      return;
    }

    var operation = {
      type: 'allocate',
      amount: Number(amount) || 0,
      token: token,
      capability: 'vault',
      metadata: { allocationType: allocationType }
    };

    var result = policies.evaluateForOperation(operation);
    window.dispatchEvent(new CustomEvent('agentVault:allocationValidated', {
      detail: {
        allowed: !result.blocked,
        type: allocationType,
        amount: _formatAmount(amount),
        token: token,
        evaluationId: result.evaluationId,
        requireApproval: result.requireApproval,
        warnings: result.warnings,
        suggestions: result.suggestions
      }
    }));
  }

  // ── Intent Created Handler ────────────────────────────────────────────────

  function onIntentCreated(event) {
    _ensurePolicies();
    var detail = event.detail || {};
    var intent = detail.intent || detail || {};

    var policies = D.AgentPolicies;
    if (!policies || typeof policies.evaluateForOperation !== 'function') {
      window.dispatchEvent(new CustomEvent('agentIntents:intentValidated', {
        detail: { valid: true, reason: 'Policy engine not available', intentId: intent.id || '' }
      }));
      return;
    }

    var operation = {
      type: intent.type || 'transfer',
      amount: Number(intent.params ? intent.params.amount : intent.amount) || 0,
      token: (intent.params && intent.params.token) || intent.token || 'USDC',
      from: (intent.params && intent.params.from) || intent.from || '',
      to: (intent.params && intent.params.to) || intent.to || '',
      chainId: (intent.params && intent.params.chainId) || intent.chainId || null
    };

    var result = policies.evaluateForOperation(operation);
    window.dispatchEvent(new CustomEvent('agentIntents:intentValidated', {
      detail: {
        valid: !result.blocked,
        intentId: intent.id || '',
        evaluationId: result.evaluationId,
        passed: result.passed,
        blocked: result.blocked,
        requireApproval: result.requireApproval,
        warnings: result.warnings,
        suggestions: result.suggestions
      }
    }));
  }

  // ═══════════════════════════════════════════════════════════════
  //  POLICY BRIDGE — Public API
  // ═══════════════════════════════════════════════════════════════

  D.AgentPolicies = D.AgentPolicies || {};
  D.AgentPolicies.Bridge = {

    init: function() {
      if (_initialized) return true;

      _ensurePolicies();

      window.addEventListener('agentExecution:requested', onPreExecution);
      window.addEventListener('agentTreasury:spendRequested', onPreSpending);
      window.addEventListener('agentVault:allocationRequested', onPreAllocation);
      window.addEventListener('agentIntents:intentCreated', onIntentCreated);

      _initialized = true;
      _emit('bridgeInitialized', { timestamp: _now() });

      return true;
    },

    registerWithPolicyEngine: function() {
      var policies = D.AgentPolicies;
      if (!policies || typeof policies.evaluate !== 'function') {
        return { success: false, error: 'AgentPolicies not loaded' };
      }

      if (D.PolicyEngine) {
        try {
          D.PolicyEngine.registerProvider('agentPolicies', {
            name: 'Agent Financial Policies',
            evaluate: function(context) {
              return policies.evaluate(context);
            },
            getRules: function(filter) {
              return policies.getRules(filter);
            }
          });
          return { success: true, registered: true };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }

      return { success: true, registered: false, reason: 'PolicyEngine not available — bridge mode active' };
    },

    onPreExecution: onPreExecution,
    onPreSpending: onPreSpending,
    onPreAllocation: onPreAllocation,

    getPolicyStatus: function() {
      _ensurePolicies();
      var policies = D.AgentPolicies;
      if (!policies) {
        return {
          active: false,
          totalRules: 0,
          activeRules: 0,
          blockedRules: 0,
          summary: 'Policy engine not loaded'
        };
      }

      var rules = policies.rules || [];
      var activeRules = rules.filter(function(r) { return r.active; });
      var blockedRules = activeRules.filter(function(r) { return r.action && r.action.type === 'block'; });

      return {
        active: policies.loaded || false,
        totalRules: rules.length,
        activeRules: activeRules.length,
        blockedRules: blockedRules.length,
        byType: {
          spending: activeRules.filter(function(r) { return r.type === 'spending'; }).length,
          allocation: activeRules.filter(function(r) { return r.type === 'allocation'; }).length,
          transfer: activeRules.filter(function(r) { return r.type === 'transfer'; }).length,
          swap: activeRules.filter(function(r) { return r.type === 'swap'; }).length,
          bridge: activeRules.filter(function(r) { return r.type === 'bridge'; }).length,
          execution: activeRules.filter(function(r) { return r.type === 'execution'; }).length
        },
        recentEvaluations: (policies.evaluationLog || []).slice(0, 5).map(function(e) {
          return {
            evaluationId: e.evaluationId,
            timestamp: e.timestamp,
            operation: e.context,
            passed: e.result.passed,
            blocked: e.result.blocked
          };
        })
      };
    }
  };

  // ── Auto-init on load ─────────────────────────────────────────────────────
  setTimeout(function() {
    if (D.AgentPolicies && typeof D.AgentPolicies.Bridge.init === 'function') {
      D.AgentPolicies.Bridge.init();
    }
  }, 500);

  console.log('[AgentPolicies] Policy Engine Bridge loaded');
})();
