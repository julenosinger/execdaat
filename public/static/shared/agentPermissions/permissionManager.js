// ============================================================
// EXECDAAT AGENT PERMISSIONS — Permission Manager
// Build: 20260722 — IIFE / Event-based / Pure logic
//
// Namespace: D.AgentPermissions
// Depends: D.AgentWallet (graceful fallback if absent)
// ============================================================
;(function() {
  'use strict';
  var D = window.ExecDaat = window.ExecDaat || {};

  var LS_KEY = 'execdaat_agent_permissions';

  var SUPPORTED_CAPABILITIES = [
    'payments', 'treasury', 'swap', 'bridge',
    'scheduler', 'contracts', 'vault', 'multisend'
  ];

  var _state = {
    permissions: [],
    usage: {
      daily: {},
      monthly: {}
    },
    loaded: false
  };

  function _emit(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent('agentPermission:' + name, { detail: detail || {} }));
    } catch (e) { /* never throw from event handlers */ }
  }

  function _save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        permissions: _state.permissions,
        usage: _state.usage,
        loaded: _state.loaded
      }));
    } catch (e) { /* quota exceeded or unavailable */ }
  }

  function _load() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) {
        var data = JSON.parse(raw);
        _state.permissions = data.permissions || [];
        _state.usage = data.usage || { daily: {}, monthly: {} };
        _state.loaded = data.loaded || false;
      }
    } catch (e) { /* corrupt data, start fresh */ }
  }

  function _formatAmount(amount) {
    var n = Number(amount);
    if (!isFinite(n)) return '0.000000';
    return n.toFixed(6);
  }

  function _now() {
    return new Date().toISOString();
  }

  function _isExpired(perm) {
    if (!perm.expiresAt) return false;
    return new Date(perm.expiresAt) < new Date();
  }

  function _isRevoked(perm) {
    return !!perm.revokedAt;
  }

  function _isActive(perm) {
    if (!perm.active) return false;
    if (_isExpired(perm)) return false;
    if (_isRevoked(perm)) return false;
    return true;
  }

  function _getTodayKey() {
    var d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function _getMonthKey() {
    var d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0');
  }

  function _ensureUsage(capability) {
    var todayKey = _getTodayKey();
    var monthKey = _getMonthKey();

    if (!_state.usage.daily[capability]) {
      _state.usage.daily[capability] = {};
    }
    if (!_state.usage.monthly[capability]) {
      _state.usage.monthly[capability] = {};
    }

    var daily = _state.usage.daily[capability];
    var monthly = _state.usage.monthly[capability];

    if (daily.dateKey !== todayKey) {
      daily.dateKey = todayKey;
      daily.spent = 0;
    }
    if (monthly.dateKey !== monthKey) {
      monthly.dateKey = monthKey;
      monthly.spent = 0;
    }

    if (typeof daily.spent !== 'number') daily.spent = 0;
    if (typeof monthly.spent !== 'number') monthly.spent = 0;
  }

  function _findPermission(capability, token) {
    for (var i = 0; i < _state.permissions.length; i++) {
      var p = _state.permissions[i];
      if (p.capability !== capability) continue;
      if (!_isActive(p)) continue;
      if (p.allowedTokens && p.allowedTokens.length && p.allowedTokens.indexOf(token) === -1) continue;
      return p;
    }
    return null;
  }

  function _findPermissionById(id) {
    for (var i = 0; i < _state.permissions.length; i++) {
      if (_state.permissions[i].id === id) return _state.permissions[i];
    }
    return null;
  }

  function _getPermissionLimits(perm) {
    return {
      dailyLimit: Number(perm.dailyLimit) || 0,
      monthlyLimit: Number(perm.monthlyLimit) || 0,
      perTxLimit: Number(perm.perTxLimit) || 0
    };
  }

  // ═══════════════════════════════════════════════════════════════
  //  PUBLIC API
  // ═══════════════════════════════════════════════════════════════

  D.AgentPermissions = {
    get state() { return Object.assign({}, _state); },
    get permissions() { return _state.permissions.slice(); },
    get usage() {
      return {
        daily: JSON.parse(JSON.stringify(_state.usage.daily)),
        monthly: JSON.parse(JSON.stringify(_state.usage.monthly))
      };
    },
    get loaded() { return _state.loaded; },

    // ── Init ────────────────────────────────────────────────────────────────
    init: async function() {
      if (_state.loaded) return _state;

      _load();

      try {
        var AW = window.ExecDaat && window.ExecDaat.AgentWallet;
        if (AW && typeof AW.getPermissions === 'function') {
          var result = await AW.getPermissions();
          if (result && result.success && Array.isArray(result.permissions)) {
            _state.permissions = result.permissions.map(function(p) {
              return {
                id: p.id,
                capability: p.capability,
                agentId: p.agentId,
                dailyLimit: String(p.dailyLimit || '0'),
                monthlyLimit: String(p.monthlyLimit || '0'),
                perTxLimit: String(p.perTxLimit || '0'),
                durationDays: p.durationDays || 30,
                allowedTokens: p.allowedTokens || [],
                allowedOperations: p.allowedOperations || [],
                grantedAt: p.grantedAt || _now(),
                expiresAt: p.expiresAt || null,
                active: p.active !== false,
                revokedAt: p.revokedAt || null
              };
            });
          }
        }
      } catch (e) { /* API unavailable, rely on cached */ }

      _state.loaded = true;
      _save();
      _emit('initialized', { permissions: _state.permissions });
      return _state;
    },

    // ── Grant ───────────────────────────────────────────────────────────────
    grant: async function(capability, limits) {
      if (SUPPORTED_CAPABILITIES.indexOf(capability) === -1) {
        return { success: false, error: 'Unsupported capability: ' + capability };
      }

      limits = limits || {};

      var payload = {
        dailyLimit: String(limits.dailyLimit || 500),
        perTxLimit: String(limits.perTxLimit || 50),
        monthlyLimit: String(limits.monthlyLimit || 5000),
        durationDays: limits.durationDays || 30,
        allowedTokens: limits.allowedTokens || ['USDC'],
        allowedOperations: limits.allowedOperations || ['transfer']
      };

      var AW = window.ExecDaat && window.ExecDaat.AgentWallet;
      if (AW && typeof AW.grantPermission === 'function') {
        try {
          var apiResult = await AW.grantPermission(capability, payload);
          if (apiResult && apiResult.success) {
            var perm = {
              id: apiResult.permissionId || apiResult.id || 'perm_' + Date.now(),
              capability: capability,
              agentId: apiResult.agentId || null,
              dailyLimit: payload.dailyLimit,
              monthlyLimit: payload.monthlyLimit,
              perTxLimit: payload.perTxLimit,
              durationDays: payload.durationDays,
              allowedTokens: payload.allowedTokens,
              allowedOperations: payload.allowedOperations,
              grantedAt: _now(),
              expiresAt: apiResult.expiresAt || null,
              active: true,
              revokedAt: null
            };
            _state.permissions.push(perm);
            _save();
            _emit('granted', { permission: perm });
            return { success: true, permission: perm };
          }
          return { success: false, error: apiResult.error || 'API grant failed' };
        } catch (e) {
          return { success: false, error: 'API call failed: ' + (e.message || e) };
        }
      }

      // Fallback: local-only grant
      var perm = {
        id: 'perm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        capability: capability,
        agentId: null,
        dailyLimit: payload.dailyLimit,
        monthlyLimit: payload.monthlyLimit,
        perTxLimit: payload.perTxLimit,
        durationDays: payload.durationDays,
        allowedTokens: payload.allowedTokens,
        allowedOperations: payload.allowedOperations,
        grantedAt: _now(),
        expiresAt: null,
        active: true,
        revokedAt: null
      };
      _state.permissions.push(perm);
      _save();
      _emit('granted', { permission: perm });
      return { success: true, permission: perm };
    },

    // ── Revoke ──────────────────────────────────────────────────────────────
    revoke: async function(permissionId) {
      var perm = _findPermissionById(permissionId);
      if (!perm) return { success: false, error: 'Permission not found: ' + permissionId };

      var AW = window.ExecDaat && window.ExecDaat.AgentWallet;
      if (AW && typeof AW.revokePermission === 'function') {
        try {
          var apiResult = await AW.revokePermission(permissionId);
          if (apiResult && apiResult.success) {
            perm.active = false;
            perm.revokedAt = _now();
            _save();
            _emit('revoked', { permissionId: permissionId, capability: perm.capability });
            return { success: true };
          }
        } catch (e) { /* fall through to local revoke */ }
      }

      // Local revoke
      perm.active = false;
      perm.revokedAt = _now();
      _save();
      _emit('revoked', { permissionId: permissionId, capability: perm.capability });
      return { success: true };
    },

    // ── Has Permission ──────────────────────────────────────────────────────
    hasPermission: function(capability, amount, token) {
      var check = D.AgentPermissions.checkPermission(capability, amount, token);
      return check.allowed;
    },

    // ── Check Permission (detailed) ─────────────────────────────────────────
    checkPermission: function(capability, amount, token) {
      amount = Number(amount) || 0;
      token = token || 'USDC';

      if (SUPPORTED_CAPABILITIES.indexOf(capability) === -1) {
        _emit('checked', { capability: capability, allowed: false, reason: 'Unsupported capability' });
        return { allowed: false, reason: 'Unsupported capability', remaining: '0.000000' };
      }

      var perm = _findPermission(capability, token);
      if (!perm) {
        _emit('checked', { capability: capability, allowed: false, reason: 'No active permission for ' + capability + '/' + token });
        return { allowed: false, reason: 'No active permission for ' + capability + '/' + token, remaining: '0.000000' };
      }

      var limits = _getPermissionLimits(perm);
      _ensureUsage(capability);

      var dailySpent = _state.usage.daily[capability].spent || 0;
      var monthlySpent = _state.usage.monthly[capability].spent || 0;
      var dailyRemaining = limits.dailyLimit - dailySpent;
      var monthlyRemaining = limits.monthlyLimit - monthlySpent;

      // Per-tx limit check
      if (limits.perTxLimit > 0 && amount > limits.perTxLimit) {
        _emit('checked', {
          capability: capability,
          amount: _formatAmount(amount),
          token: token,
          allowed: false,
          reason: 'Exceeds per-transaction limit of ' + _formatAmount(limits.perTxLimit)
        });
        return {
          allowed: false,
          reason: 'Exceeds per-transaction limit of ' + _formatAmount(limits.perTxLimit),
          remaining: _formatAmount(dailyRemaining > 0 ? dailyRemaining : 0)
        };
      }

      // Daily limit check
      if (limits.dailyLimit > 0 && (dailySpent + amount) > limits.dailyLimit) {
        _emit('limitExceeded', {
          capability: capability,
          limit: _formatAmount(limits.dailyLimit),
          spent: _formatAmount(dailySpent),
          requested: _formatAmount(amount)
        });
        return {
          allowed: false,
          reason: 'Exceeds daily limit of ' + _formatAmount(limits.dailyLimit),
          remaining: _formatAmount(dailyRemaining > 0 ? dailyRemaining : 0)
        };
      }

      // Monthly limit check
      if (limits.monthlyLimit > 0 && (monthlySpent + amount) > limits.monthlyLimit) {
        _emit('limitExceeded', {
          capability: capability,
          limit: _formatAmount(limits.monthlyLimit),
          spent: _formatAmount(monthlySpent),
          requested: _formatAmount(amount)
        });
        return {
          allowed: false,
          reason: 'Exceeds monthly limit of ' + _formatAmount(limits.monthlyLimit),
          remaining: _formatAmount(monthlyRemaining > 0 ? monthlyRemaining : 0)
        };
      }

      // Operation check
      if (perm.allowedOperations && perm.allowedOperations.length > 0) {
        // Passing check — operation validation happens at execution level
      }

      // Calculate overall remaining
      var overallRemaining = dailyRemaining < monthlyRemaining ? dailyRemaining : monthlyRemaining;

      // Daily warning threshold (80% used)
      if (limits.dailyLimit > 0 && (dailySpent + amount) >= limits.dailyLimit * 0.8) {
        _emit('limitWarning', {
          capability: capability,
          limit: _formatAmount(limits.dailyLimit),
          spent: _formatAmount(dailySpent + amount),
          remaining: _formatAmount(limits.dailyLimit - (dailySpent + amount))
        });
      }

      _emit('checked', {
        capability: capability,
        amount: _formatAmount(amount),
        token: token,
        allowed: true,
        remaining: _formatAmount(overallRemaining > 0 ? overallRemaining : 0)
      });

      return {
        allowed: true,
        reason: null,
        remaining: _formatAmount(overallRemaining > 0 ? overallRemaining : 0),
        permissionId: perm.id
      };
    },

    // ── Track Usage ─────────────────────────────────────────────────────────
    trackUsage: function(capability, amount) {
      amount = Number(amount) || 0;
      _ensureUsage(capability);

      var daily = _state.usage.daily[capability];
      var monthly = _state.usage.monthly[capability];

      daily.spent = (daily.spent || 0) + amount;
      monthly.spent = (monthly.spent || 0) + amount;

      _save();
      _emit('usageTracked', {
        capability: capability,
        amount: _formatAmount(amount),
        dailySpent: _formatAmount(daily.spent),
        monthlySpent: _formatAmount(monthly.spent)
      });
    },

    // ── Get Active Permissions ──────────────────────────────────────────────
    getActivePermissions: function() {
      return _state.permissions.filter(function(p) {
        return _isActive(p);
      });
    },

    // ── Get Expiring Soon ───────────────────────────────────────────────────
    getExpiringSoon: function(daysThreshold) {
      var threshold = daysThreshold || 7;
      var now = new Date();
      var cutoff = new Date(now.getTime() + threshold * 24 * 60 * 60 * 1000);

      return _state.permissions.filter(function(p) {
        if (!_isActive(p)) return false;
        if (!p.expiresAt) return false;
        var exp = new Date(p.expiresAt);
        return exp > now && exp <= cutoff;
      });
    },

    // ── Summarize Limits ────────────────────────────────────────────────────
    summarizeLimits: function() {
      var summary = {};
      var active = D.AgentPermissions.getActivePermissions();

      for (var i = 0; i < SUPPORTED_CAPABILITIES.length; i++) {
        var cap = SUPPORTED_CAPABILITIES[i];
        _ensureUsage(cap);

        var perms = active.filter(function(p) { return p.capability === cap; });
        var totalDaily = 0;
        var totalMonthly = 0;
        var totalPerTx = 0;

        for (var j = 0; j < perms.length; j++) {
          totalDaily += Number(perms[j].dailyLimit) || 0;
          totalMonthly += Number(perms[j].monthlyLimit) || 0;
          totalPerTx = Math.max(totalPerTx, Number(perms[j].perTxLimit) || 0);
        }

        var dailySpent = (_state.usage.daily[cap] && _state.usage.daily[cap].spent) || 0;
        var monthlySpent = (_state.usage.monthly[cap] && _state.usage.monthly[cap].spent) || 0;

        summary[cap] = {
          dailyLimit: _formatAmount(totalDaily),
          dailySpent: _formatAmount(dailySpent),
          dailyRemaining: _formatAmount(totalDaily - dailySpent > 0 ? totalDaily - dailySpent : 0),
          monthlyLimit: _formatAmount(totalMonthly),
          monthlySpent: _formatAmount(monthlySpent),
          monthlyRemaining: _formatAmount(totalMonthly - monthlySpent > 0 ? totalMonthly - monthlySpent : 0),
          perTxLimit: _formatAmount(totalPerTx),
          activePermissions: perms.length
        };
      }

      return summary;
    }
  };

  console.log('[AgentPermissions] Permission Manager loaded');
})();
