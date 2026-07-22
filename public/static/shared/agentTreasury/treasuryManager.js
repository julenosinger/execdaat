// ============================================================
// EXECDAAT AGENT TREASURY — Treasury Manager
// Build: 20260722 — Core treasury logic
//
// Exposes:
//   D.AgentTreasury — main treasury API
//
// Events emitted:
//   agentTreasury:updated
//   agentTreasury:allocationChanged
//   agentTreasury:spendRecorded
//   agentTreasury:limitExceeded
//   agentTreasury:limitWarning
// ============================================================
;(function() {
  'use strict';
  var D = window.ExecDaat = window.ExecDaat || {};

  var USDC_ADDRESS = '0x3600000000000000000000000000000000000000';
  var EURC_ADDRESS = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';

  var ALLOCATION_KEY = 'execdaat_treasury_allocations';
  var LIMITS_KEY = 'execdaat_treasury_limits';

  var DEFAULT_ALLOCATIONS = {
    operational:    { name: 'Operational',       percentage: 30 },
    treasury:       { name: 'Treasury Reserve',  percentage: 20 },
    automation:     { name: 'Automation',        percentage: 10 },
    gas_reserve:    { name: 'Gas Reserve',       percentage: 10 },
    yield:          { name: 'Yield',             percentage: 15 },
    liquidity:      { name: 'Liquidity',         percentage: 10 },
    locked_funds:   { name: 'Locked Funds',      percentage: 5  }
  };

  function _emit(name, detail) {
    window.dispatchEvent(new CustomEvent('agentTreasury:' + name, { detail: detail || {} }));
  }

  function _now() {
    return new Date().toISOString();
  }

  function _uid() {
    return 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function _rawToHuman(raw, decimals) {
    var d = decimals || 6;
    var n = Number(raw);
    if (!isFinite(n)) return '0';
    return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: d });
  }

  function _humanToRaw(human, decimals) {
    var d = decimals || 6;
    var n = parseFloat(String(human).replace(/[^0-9.]/g, ''));
    if (!isFinite(n)) return 0;
    return Math.round(n * Math.pow(10, d));
  }

  function _loadFromStorage(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore */ }
    return fallback;
  }

  function _saveToStorage(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  }

  function _buildAllocations(balances) {
    var saved = _loadFromStorage(ALLOCATION_KEY, null);
    var allocs = [];

    Object.keys(DEFAULT_ALLOCATIONS).forEach(function(type) {
      var def = DEFAULT_ALLOCATIONS[type];
      var savedAlloc = saved ? saved[type] : null;
      allocs.push({
        id: _uid(),
        type: type,
        name: def.name,
        token: savedAlloc ? savedAlloc.token : 'USDC',
        allocated: savedAlloc ? savedAlloc.allocated : 0,
        used: savedAlloc ? (savedAlloc.used || 0) : 0,
        percentage: def.percentage
      });
    });

    return allocs;
  }

  function _buildLimits() {
    var saved = _loadFromStorage(LIMITS_KEY, null);
    return {
      dailySpend: saved ? (saved.dailySpend || 500) : 500,
      monthlySpend: saved ? (saved.monthlySpend || 5000) : 5000,
      perTxSpend: saved ? (saved.perTxSpend || 50) : 50,
      remainingDaily: saved ? (saved.remainingDaily || 500) : 500,
      remainingMonthly: saved ? (saved.remainingMonthly || 5000) : 5000
    };
  }

  // ═══════════════════════════════════════════════════════════════
  //  AGENT TREASURY — Public API
  // ═══════════════════════════════════════════════════════════════

  var _state = {
    balances: {
      USDC: { raw: 0, human: '0' },
      EURC: { raw: 0, human: '0' }
    },
    allocations: [],
    limits: _buildLimits(),
    policies: [],
    loaded: false
  };

  D.AgentTreasury = {
    get state() { return JSON.parse(JSON.stringify(_state)); },

    init: function() {
      if (_state.loaded) return _state;
      _state.allocations = _buildAllocations();
      _state.limits = _buildLimits();
      _state.loaded = true;
      D.AgentTreasury.refreshBalances();
      return _state;
    },

    refreshBalances: async function() {
      var wallet = window.ExecDaat.AgentWallet;
      if (!wallet) {
        console.warn('[AgentTreasury] AgentWallet not loaded');
        return _state;
      }

      var result = await wallet.refreshTreasury();
      if (result && result.success) {
        var treasury = result.treasury;
        if (treasury) {
          _state.balances.USDC.raw = Number(treasury.USDC || treasury.usdc || 0);
          _state.balances.USDC.human = _rawToHuman(_state.balances.USDC.raw, 6);
          _state.balances.EURC.raw = Number(treasury.EURC || treasury.eurc || 0);
          _state.balances.EURC.human = _rawToHuman(_state.balances.EURC.raw, 6);
        }
        _emit('updated', { balances: _state.balances, allocations: _state.allocations, limits: _state.limits });
      }
      return _state;
    },

    getAllocation: function(type) {
      return _state.allocations.find(function(a) { return a.type === type; }) || null;
    },

    setAllocation: function(type, amount, token) {
      var alloc = _state.allocations.find(function(a) { return a.type === type; });
      if (!alloc) return null;

      alloc.allocated = Number(amount);
      alloc.token = token || 'USDC';

      var storageObj = {};
      _state.allocations.forEach(function(a) {
        storageObj[a.type] = { allocated: a.allocated, used: a.used, token: a.token };
      });
      _saveToStorage(ALLOCATION_KEY, storageObj);

      _emit('allocationChanged', { type: type, amount: amount, token: token, allocation: alloc });
      return alloc;
    },

    getAllocations: function() {
      var totalAllocated = _state.allocations.reduce(function(sum, a) { return sum + a.allocated; }, 0);

      return _state.allocations.map(function(a) {
        var pct = totalAllocated > 0 ? ((a.allocated / totalAllocated) * 100) : a.percentage;
        return {
          id: a.id,
          type: a.type,
          name: a.name,
          token: a.token,
          allocated: a.allocated,
          human: _rawToHuman(a.allocated, 6),
          used: a.used,
          percentage: parseFloat(pct.toFixed(2)),
          remaining: Math.max(0, a.allocated - a.used),
          remainingHuman: _rawToHuman(Math.max(0, a.allocated - a.used), 6)
        };
      });
    },

    canSpend: function(amount, token) {
      var amt = Number(amount);
      if (!isFinite(amt) || amt <= 0) return { allowed: false, reason: 'Invalid amount' };

      if (amt > _state.limits.perTxSpend) {
        _emit('limitExceeded', { reason: 'perTxSpend', amount: amt, limit: _state.limits.perTxSpend });
        return { allowed: false, reason: 'Exceeds per-transaction limit of ' + _rawToHuman(_state.limits.perTxSpend, 6) + ' ' + (token || 'USDC') };
      }

      if (amt > _state.limits.remainingDaily) {
        _emit('limitExceeded', { reason: 'dailySpend', amount: amt, limit: _state.limits.remainingDaily });
        return { allowed: false, reason: 'Exceeds remaining daily limit of ' + _rawToHuman(_state.limits.remainingDaily, 6) + ' ' + (token || 'USDC') };
      }

      if (amt > _state.limits.remainingMonthly) {
        _emit('limitExceeded', { reason: 'monthlySpend', amount: amt, limit: _state.limits.remainingMonthly });
        return { allowed: false, reason: 'Exceeds remaining monthly limit of ' + _rawToHuman(_state.limits.remainingMonthly, 6) + ' ' + (token || 'USDC') };
      }

      var dailyRatio = _state.limits.dailySpend > 0 ? (_state.limits.remainingDaily / _state.limits.dailySpend) : 1;
      var monthlyRatio = _state.limits.monthlySpend > 0 ? (_state.limits.remainingMonthly / _state.limits.monthlySpend) : 1;

      if (dailyRatio < 0.2 || monthlyRatio < 0.2) {
        _emit('limitWarning', { remainingDailyPct: Math.round(dailyRatio * 100), remainingMonthlyPct: Math.round(monthlyRatio * 100) });
      }

      return { allowed: true, remainingDaily: _state.limits.remainingDaily, remainingMonthly: _state.limits.remainingMonthly };
    },

    recordSpend: function(amount, token, operation) {
      var amt = Number(amount);
      if (!isFinite(amt)) return { success: false, error: 'Invalid amount' };

      _state.limits.remainingDaily = Math.max(0, _state.limits.remainingDaily - amt);
      _state.limits.remainingMonthly = Math.max(0, _state.limits.remainingMonthly - amt);

      var limitsObj = {
        dailySpend: _state.limits.dailySpend,
        monthlySpend: _state.limits.monthlySpend,
        perTxSpend: _state.limits.perTxSpend,
        remainingDaily: _state.limits.remainingDaily,
        remainingMonthly: _state.limits.remainingMonthly
      };
      _saveToStorage(LIMITS_KEY, limitsObj);

      _emit('spendRecorded', { amount: amt, token: token, operation: operation, remainingDaily: _state.limits.remainingDaily, remainingMonthly: _state.limits.remainingMonthly });

      return { success: true, remainingDaily: _state.limits.remainingDaily, remainingMonthly: _state.limits.remainingMonthly };
    },

    resetDailyLimits: function() {
      _state.limits.remainingDaily = _state.limits.dailySpend;
      var limitsObj = {
        dailySpend: _state.limits.dailySpend,
        monthlySpend: _state.limits.monthlySpend,
        perTxSpend: _state.limits.perTxSpend,
        remainingDaily: _state.limits.remainingDaily,
        remainingMonthly: _state.limits.remainingMonthly
      };
      _saveToStorage(LIMITS_KEY, limitsObj);

      _emit('updated', { action: 'dailyReset', limits: _state.limits });
    },

    getSummary: function() {
      var allocations = D.AgentTreasury.getAllocations();
      var totalAllocated = allocations.reduce(function(sum, a) { return sum + a.allocated; }, 0);
      var totalUSDC = _state.balances.USDC.raw;
      var totalEURC = _state.balances.EURC.raw;

      return {
        balances: {
          USDC: { raw: totalUSDC, human: _state.balances.USDC.human },
          EURC: { raw: totalEURC, human: _state.balances.EURC.human }
        },
        totalBalance: {
          USDC: totalUSDC,
          EURC: totalEURC,
          usdcHuman: _rawToHuman(totalUSDC, 6),
          eurcHuman: _rawToHuman(totalEURC, 6)
        },
        allocations: allocations,
        totalAllocated: totalAllocated,
        totalAllocatedHuman: _rawToHuman(totalAllocated, 6),
        unallocated: Math.max(0, totalUSDC - totalAllocated),
        unallocatedHuman: _rawToHuman(Math.max(0, totalUSDC - totalAllocated), 6),
        limits: {
          dailySpend: _state.limits.dailySpend,
          monthlySpend: _state.limits.monthlySpend,
          perTxSpend: _state.limits.perTxSpend,
          remainingDaily: _state.limits.remainingDaily,
          remainingMonthly: _state.limits.remainingMonthly,
          remainingDailyHuman: _rawToHuman(_state.limits.remainingDaily, 6),
          remainingMonthlyHuman: _rawToHuman(_state.limits.remainingMonthly, 6)
        }
      };
    }
  };

  console.log('[AgentTreasury Manager] Loaded');
})();
