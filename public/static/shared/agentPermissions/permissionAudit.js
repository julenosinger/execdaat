// ============================================================
// EXECDAAT AGENT PERMISSIONS — Permission Audit
// Build: 20260722 — IIFE / Event-based / Pure logic
//
// Namespace: D.AgentPermissions (extends)
// ============================================================
;(function() {
  'use strict';
  var D = window.ExecDaat = window.ExecDaat || {};

  var LS_KEY = 'execdaat_permission_audit';
  var MAX_ENTRIES = 500;

  var _auditLog = [];

  function _emit(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent('agentPermission:' + name, { detail: detail || {} }));
    } catch (e) { /* never throw from event handlers */ }
  }

  function _save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(_auditLog));
    } catch (e) { /* quota exceeded */ }
  }

  function _load() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) {
        _auditLog = JSON.parse(raw);
        if (!Array.isArray(_auditLog)) _auditLog = [];
      }
    } catch (e) { _auditLog = []; }
  }

  function _now() {
    return new Date().toISOString();
  }

  function _formatAmount(amount) {
    var n = Number(amount);
    if (!isFinite(n)) return '0.000000';
    return n.toFixed(6);
  }

  function _push(entry) {
    _auditLog.unshift(entry);
    if (_auditLog.length > MAX_ENTRIES) {
      _auditLog = _auditLog.slice(0, MAX_ENTRIES);
    }
    _save();
    _emit('auditLogged', entry);
  }

  function _getAP() {
    var AP = (D.AgentPermissions) || null;
    return AP;
  }

  // Load existing audit entries on init
  _load();

  // ═══════════════════════════════════════════════════════════════
  //  PUBLIC API (merged into D.AgentPermissions)
  // ═══════════════════════════════════════════════════════════════

  // Ensure D.AgentPermissions namespace exists
  D.AgentPermissions = D.AgentPermissions || {};

  Object.assign(D.AgentPermissions, {

    // ── Log Permission Check ────────────────────────────────────────────────
    logCheck: function(capability, amount, token, result) {
      var entry = {
        type: 'check',
        capability: capability,
        amount: _formatAmount(amount),
        token: token || 'USDC',
        allowed: result ? !!result.allowed : false,
        reason: result ? (result.reason || null) : null,
        remaining: result ? (result.remaining || '0.000000') : '0.000000',
        timestamp: _now()
      };
      _push(entry);
      return entry;
    },

    // ── Log Grant ───────────────────────────────────────────────────────────
    logGrant: function(capability, limits) {
      var entry = {
        type: 'grant',
        capability: capability,
        dailyLimit: limits ? _formatAmount(limits.dailyLimit) : '0.000000',
        monthlyLimit: limits ? _formatAmount(limits.monthlyLimit) : '0.000000',
        perTxLimit: limits ? _formatAmount(limits.perTxLimit) : '0.000000',
        durationDays: limits ? (limits.durationDays || 30) : 30,
        allowedTokens: limits ? (limits.allowedTokens || []) : [],
        timestamp: _now()
      };
      _push(entry);
      return entry;
    },

    // ── Log Revoke ──────────────────────────────────────────────────────────
    logRevoke: function(permissionId, reason) {
      var entry = {
        type: 'revoke',
        permissionId: permissionId,
        reason: reason || 'Manual revocation',
        timestamp: _now()
      };
      _push(entry);
      return entry;
    },

    // ── Log Usage ───────────────────────────────────────────────────────────
    logUsage: function(capability, amount, operation) {
      var entry = {
        type: 'usage',
        capability: capability,
        amount: _formatAmount(amount),
        operation: operation || 'execute',
        timestamp: _now()
      };
      _push(entry);
      return entry;
    },

    // ── Get Check History ───────────────────────────────────────────────────
    getCheckHistory: function(capability, limit) {
      limit = limit || 50;
      var filtered = _auditLog.filter(function(e) {
        return e.type === 'check';
      });
      if (capability) {
        filtered = filtered.filter(function(e) {
          return e.capability === capability;
        });
      }
      return filtered.slice(0, limit);
    },

    // ── Get Daily Report ────────────────────────────────────────────────────
    getDailyReport: function() {
      var today = new Date();
      var todayStr = today.getFullYear() + '-' +
        String(today.getMonth() + 1).padStart(2, '0') + '-' +
        String(today.getDate()).padStart(2, '0');

      var todayEntries = _auditLog.filter(function(e) {
        return e.timestamp && e.timestamp.slice(0, 10) === todayStr;
      });

      var checks = todayEntries.filter(function(e) { return e.type === 'check'; });
      var grants = todayEntries.filter(function(e) { return e.type === 'grant'; });
      var revokes = todayEntries.filter(function(e) { return e.type === 'revoke'; });
      var usages = todayEntries.filter(function(e) { return e.type === 'usage'; });

      var allowedChecks = checks.filter(function(e) { return e.allowed; });
      var deniedChecks = checks.filter(function(e) { return !e.allowed; });

      var totalUsage = 0;
      for (var i = 0; i < usages.length; i++) {
        totalUsage += Number(usages[i].amount) || 0;
      }

      var byCapability = {};
      for (var j = 0; j < usages.length; j++) {
        var cap = usages[j].capability;
        if (!byCapability[cap]) byCapability[cap] = { count: 0, total: 0 };
        byCapability[cap].count++;
        byCapability[cap].total += Number(usages[j].amount) || 0;
      }

      // Format totals
      var formattedByCap = {};
      Object.keys(byCapability).forEach(function(k) {
        formattedByCap[k] = {
          count: byCapability[k].count,
          total: _formatAmount(byCapability[k].total)
        };
      });

      var report = {
        date: todayStr,
        totalChecks: checks.length,
        allowedChecks: allowedChecks.length,
        deniedChecks: deniedChecks.length,
        grants: grants.length,
        revokes: revokes.length,
        usageCount: usages.length,
        totalUsage: _formatAmount(totalUsage),
        byCapability: formattedByCap,
        entries: todayEntries.slice(0, 100)
      };

      _emit('dailyReport', report);
      return report;
    }
  });

  // ── Wire up auto-logging from permission events ──────────────────────────

  window.addEventListener('agentPermission:checked', function(e) {
    if (e.detail) {
      D.AgentPermissions.logCheck(
        e.detail.capability,
        e.detail.amount || 0,
        e.detail.token,
        { allowed: e.detail.allowed, reason: e.detail.reason, remaining: e.detail.remaining }
      );
    }
  });

  window.addEventListener('agentPermission:granted', function(e) {
    if (e.detail && e.detail.permission) {
      var p = e.detail.permission;
      D.AgentPermissions.logGrant(p.capability, {
        dailyLimit: p.dailyLimit,
        monthlyLimit: p.monthlyLimit,
        perTxLimit: p.perTxLimit,
        durationDays: p.durationDays,
        allowedTokens: p.allowedTokens
      });
    }
  });

  window.addEventListener('agentPermission:revoked', function(e) {
    if (e.detail) {
      D.AgentPermissions.logRevoke(e.detail.permissionId);
    }
  });

  window.addEventListener('agentPermission:usageTracked', function(e) {
    if (e.detail) {
      D.AgentPermissions.logUsage(e.detail.capability, e.detail.amount, 'tracked');
    }
  });

  console.log('[AgentPermissions] Audit module loaded');
})();
