// ============================================================
// EXECDAAT AGENT VAULT — Vault Manager
// Build: 20260722 — IIFE / Event-based / Pure logic
//
// Namespace: D.AgentVault
// WARNING: Allocation layer on top of existing treasury. No new treasury.
// Depends: D.AgentWallet (graceful fallback if absent)
// ============================================================
;(function() {
  'use strict';
  var D = window.ExecDaat = window.ExecDaat || {};

  var LS_KEY = 'execdaat_agent_vault';

  var ALLOCATION_TYPES = [
    'agent_operational',
    'agent_treasury',
    'agent_yield',
    'agent_liquidity',
    'agent_automation',
    'agent_gas'
  ];

  var _state = {
    allocations: [],
    depositHistory: [],
    loaded: false
  };

  function _emit(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent('agentVault:' + name, { detail: detail || {} }));
    } catch (e) { /* never throw from event handlers */ }
  }

  function _save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        allocations: _state.allocations,
        depositHistory: _state.depositHistory,
        loaded: _state.loaded
      }));
    } catch (e) { /* quota exceeded */ }
  }

  function _load() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) {
        var data = JSON.parse(raw);
        _state.allocations = data.allocations || [];
        _state.depositHistory = data.depositHistory || [];
        _state.loaded = data.loaded || false;
      }
    } catch (e) { /* corrupt data */ }
  }

  function _formatAmount(amount) {
    var n = Number(amount);
    if (!isFinite(n)) return '0.000000';
    return n.toFixed(6);
  }

  function _now() {
    return new Date().toISOString();
  }

  function _findAllocation(type) {
    for (var i = 0; i < _state.allocations.length; i++) {
      if (_state.allocations[i].type === type) return _state.allocations[i];
    }
    return null;
  }

  function _findAllocationById(id) {
    for (var i = 0; i < _state.allocations.length; i++) {
      if (_state.allocations[i].id === id) return _state.allocations[i];
    }
    return null;
  }

  /**
   * Get total treasury balance from AgentWallet (or estimate from allocations).
   * @returns {number} total available treasury
   */
  function _getTreasuryTotal() {
    var AW = window.ExecDaat && window.ExecDaat.AgentWallet;
    if (AW && AW.state && AW.state.treasuryBalances) {
      var balances = AW.state.treasuryBalances;
      var total = 0;
      for (var i = 0; i < balances.length; i++) {
        total += Number(balances[i].balance || balances[i].amount || 0);
      }
      if (total > 0) return total;
    }
    // Fallback: sum of allocations
    var sum = 0;
    for (var j = 0; j < _state.allocations.length; j++) {
      sum += Number(_state.allocations[j].allocated) || 0;
    }
    return sum || 0;
  }

  function _getTotalAllocated() {
    var sum = 0;
    for (var i = 0; i < _state.allocations.length; i++) {
      sum += Number(_state.allocations[i].allocated) || 0;
    }
    return sum;
  }

  // ═══════════════════════════════════════════════════════════════
  //  PUBLIC API
  // ═══════════════════════════════════════════════════════════════

  D.AgentVault = {
    get state() { return Object.assign({}, _state); },
    get allocations() { return _state.allocations.slice(); },
    get depositHistory() { return _state.depositHistory.slice(); },
    get loaded() { return _state.loaded; },

    // ── Init ────────────────────────────────────────────────────────────────
    init: async function() {
      if (_state.loaded) return _state;

      _load();

      try {
        var AW = window.ExecDaat && window.ExecDaat.AgentWallet;
        if (AW && typeof AW.refreshTreasury === 'function') {
          await AW.refreshTreasury();
        }

        // Load existing allocations from API if available
        if (AW && AW.state && AW.state.agentId) {
          try {
            var resp = await fetch('/api/agent-wallet/vault/allocations/' + encodeURIComponent(AW.state.agentId));
            var data = await resp.json();
            if (data && data.success && Array.isArray(data.allocations)) {
              _state.allocations = data.allocations.map(function(a) {
                return {
                  id: a.id,
                  agentId: a.agentId || AW.state.agentId,
                  type: a.type,
                  token: a.token || 'USDC',
                  allocated: String(a.allocated || '0'),
                  used: String(a.used || '0'),
                  available: String(a.available !== undefined ? a.available : a.allocated || '0')
                };
              });
            }
          } catch (e) { /* API not available, use cached */ }

          if (_state.depositHistory.length === 0) {
            try {
              var auditResp = await fetch('/api/agent-wallet/audit/' + encodeURIComponent(AW.state.agentId) + '?limit=50');
              var auditData = await auditResp.json();
              if (auditData && auditData.success && Array.isArray(auditData.logs)) {
                _state.depositHistory = auditData.logs.filter(function(l) {
                  return l.type === 'deposit' || l.type === 'allocation' || l.action === 'deposit';
                });
              }
            } catch (e) { /* API not available */ }
          }
        }
      } catch (e) { /* AgentWallet unavailable */ }

      // Ensure default gas allocation exists
      if (!_findAllocation('agent_gas')) {
        _state.allocations.push({
          id: 'gas_' + Date.now(),
          agentId: null,
          type: 'agent_gas',
          token: 'ETH',
          allocated: '0.000000',
          used: '0.000000',
          available: '0.000000'
        });
      }

      _state.loaded = true;
      _save();
      _emit('updated', { allocations: _state.allocations });
      return _state;
    },

    // ── Allocate ────────────────────────────────────────────────────────────
    allocate: async function(type, token, amount) {
      if (ALLOCATION_TYPES.indexOf(type) === -1) {
        return { success: false, error: 'Invalid allocation type: ' + type };
      }

      amount = Number(amount) || 0;
      token = token || 'USDC';

      if (amount <= 0) {
        return { success: false, error: 'Amount must be greater than 0' };
      }

      // Check if allocation is possible
      var canResult = D.AgentVault.canAllocate(type, amount);
      if (!canResult.allowed) {
        _emit('allocationExceeded', {
          type: type,
          requested: _formatAmount(amount),
          reason: canResult.reason
        });
        return { success: false, error: canResult.reason };
      }

      // Check vault policies
      if (D.AgentVault && D.AgentVault.Policies && typeof D.AgentVault.Policies.validateAllocation === 'function') {
        var policyResult = D.AgentVault.Policies.validateAllocation(type, amount);
        if (policyResult && !policyResult.allowed) {
          return { success: false, error: policyResult.reason || 'Allocation blocked by vault policy' };
        }
      }

      var existing = _findAllocation(type);

      var AW = window.ExecDaat && window.ExecDaat.AgentWallet;
      if (AW && AW.state && AW.state.agentId) {
        try {
          var resp = await fetch('/api/agent-wallet/vault/allocate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              agentId: AW.state.agentId,
              type: type,
              token: token,
              amount: String(amount)
            })
          });
          var data = await resp.json();

          if (data && data.success) {
            if (existing) {
              var prevAlloc = Number(existing.allocated) || 0;
              existing.allocated = _formatAmount(prevAlloc + amount);
              existing.used = String(data.used || existing.used);
              existing.available = _formatAmount((prevAlloc + amount) - (Number(existing.used) || 0));
            } else {
              _state.allocations.push({
                id: data.allocationId || data.id || 'alloc_' + Date.now(),
                agentId: AW.state.agentId,
                type: type,
                token: token,
                allocated: _formatAmount(amount),
                used: '0.000000',
                available: _formatAmount(amount)
              });
            }
            _save();
            _emit('allocationCreated', { type: type, token: token, amount: _formatAmount(amount) });
            _emit('updated', { allocations: _state.allocations });
            return { success: true, allocation: _findAllocation(type) };
          }
          return { success: false, error: data.error || 'API allocation failed' };
        } catch (e) {
          // Fall through to local-only allocation
        }
      }

      // Local-only allocation
      if (existing) {
        var prevAlloc = Number(existing.allocated) || 0;
        existing.allocated = _formatAmount(prevAlloc + amount);
        existing.available = _formatAmount((prevAlloc + amount) - (Number(existing.used) || 0));
      } else {
        _state.allocations.push({
          id: 'alloc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
          agentId: null,
          type: type,
          token: token,
          allocated: _formatAmount(amount),
          used: '0.000000',
          available: _formatAmount(amount)
        });
      }
      _save();
      _emit('allocationCreated', { type: type, token: token, amount: _formatAmount(amount) });
      _emit('updated', { allocations: _state.allocations });
      return { success: true, allocation: _findAllocation(type) };
    },

    // ── Get Allocations ─────────────────────────────────────────────────────
    getAllocations: function() {
      return _state.allocations.slice();
    },

    // ── Get Allocation ──────────────────────────────────────────────────────
    getAllocation: function(type) {
      var alloc = _findAllocation(type);
      return alloc ? Object.assign({}, alloc) : null;
    },

    // ── Get Available Balance ───────────────────────────────────────────────
    getAvailableBalance: function(type) {
      var treasuryTotal = _getTreasuryTotal();
      var totalAllocated = _getTotalAllocated();
      var unallocated = treasuryTotal - totalAllocated;

      if (type) {
        var alloc = _findAllocation(type);
        var used = alloc ? (Number(alloc.used) || 0) : 0;
        var allocated = alloc ? (Number(alloc.allocated) || 0) : 0;
        var typeAvailable = allocated - used;
        return _formatAmount(typeAvailable > 0 ? typeAvailable : 0);
      }

      return _formatAmount(unallocated > 0 ? unallocated : 0);
    },

    // ── Can Allocate ────────────────────────────────────────────────────────
    canAllocate: function(type, amount) {
      amount = Number(amount) || 0;

      if (amount <= 0) {
        return { allowed: false, reason: 'Amount must be greater than 0' };
      }

      var treasuryTotal = _getTreasuryTotal();
      var totalAllocated = _getTotalAllocated();
      var unallocated = treasuryTotal - totalAllocated;

      if (amount > unallocated) {
        return {
          allowed: false,
          reason: 'Insufficient unallocated treasury. Available: ' + _formatAmount(unallocated) + ', Requested: ' + _formatAmount(amount)
        };
      }

      return { allowed: true, reason: null, unallocated: _formatAmount(unallocated) };
    },

    // ── Get Deposit History ─────────────────────────────────────────────────
    getDepositHistory: function(limit) {
      limit = limit || 20;
      return _state.depositHistory.slice(0, limit);
    },

    // ── Summarize Vault ─────────────────────────────────────────────────────
    summarizeVault: function() {
      var treasuryTotal = _getTreasuryTotal();
      var totalAllocated = _getTotalAllocated();
      var unallocated = treasuryTotal - totalAllocated;

      var byType = {};
      for (var i = 0; i < _state.allocations.length; i++) {
        var a = _state.allocations[i];
        byType[a.type] = {
          id: a.id,
          token: a.token,
          allocated: a.allocated,
          used: a.used,
          available: a.available
        };
      }

      return {
        treasuryTotal: _formatAmount(treasuryTotal),
        totalAllocated: _formatAmount(totalAllocated),
        unallocated: _formatAmount(unallocated > 0 ? unallocated : 0),
        allocationCount: _state.allocations.length,
        byType: byType,
        hasGasReserve: !!_findAllocation('agent_gas') && Number(_findAllocation('agent_gas').available) > 0
      };
    }
  };

  console.log('[AgentVault] Vault Manager loaded');
})();
