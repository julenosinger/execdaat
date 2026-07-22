// ============================================================
// EXECDAAT AGENT TREASURY — Treasury Audit Logger
// Build: 20260722 — Audit trail for all treasury actions
//
// Extends: D.AgentTreasury
//
// Events emitted:
//   agentTreasury:auditLogged
// ============================================================
;(function() {
  'use strict';
  var D = window.ExecDaat = window.ExecDaat || {};

  var AUDIT_KEY = 'execdaat_treasury_audit';
  var MAX_ENTRIES = 500;

  function _emit(name, detail) {
    window.dispatchEvent(new CustomEvent('agentTreasury:' + name, { detail: detail || {} }));
  }

  function _uid() {
    return 'audit_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function _nowISO() {
    return new Date().toISOString();
  }

  function _readAuditLog() {
    try {
      var raw = localStorage.getItem(AUDIT_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore */ }
    return [];
  }

  function _writeAuditLog(entries) {
    var trimmed = entries.slice(-MAX_ENTRIES);
    try { localStorage.setItem(AUDIT_KEY, JSON.stringify(trimmed)); } catch (e) { /* ignore */ }
    return trimmed;
  }

  // ═══════════════════════════════════════════════════════════════
  //  AGENT TREASURY AUDIT — appended to D.AgentTreasury
  // ═══════════════════════════════════════════════════════════════

  var T = D.AgentTreasury = D.AgentTreasury || {};

  T.logTreasuryAction = function(action, details) {
    var log = _readAuditLog();
    var entry = {
      id: _uid(),
      timestamp: _nowISO(),
      action: action || 'unknown',
      allocationType: details ? details.allocationType : null,
      amount: details ? (details.amount || 0) : 0,
      token: details ? (details.token || 'USDC') : 'USDC',
      previousBalance: details ? details.previousBalance : null,
      newBalance: details ? details.newBalance : null,
      operation: details ? (details.operation || null) : null,
      status: details ? (details.status || 'completed') : 'completed'
    };

    log.push(entry);
    _writeAuditLog(log);

    _emit('auditLogged', entry);
    return entry;
  };

  T.getTreasuryHistory = function(filter) {
    var log = _readAuditLog();
    if (!filter) return log.slice().reverse();

    return log.filter(function(entry) {
      var match = true;
      if (filter.action && entry.action !== filter.action) match = false;
      if (filter.allocationType && entry.allocationType !== filter.allocationType) match = false;
      if (filter.token && entry.token !== filter.token) match = false;
      if (filter.status && entry.status !== filter.status) match = false;
      if (filter.since) {
        var entryTime = new Date(entry.timestamp).getTime();
        var sinceTime = new Date(filter.since).getTime();
        if (entryTime < sinceTime) match = false;
      }
      if (filter.until) {
        var entryTime2 = new Date(entry.timestamp).getTime();
        var untilTime = new Date(filter.until).getTime();
        if (entryTime2 > untilTime) match = false;
      }
      if (filter.minAmount !== undefined && entry.amount < filter.minAmount) match = false;
      if (filter.maxAmount !== undefined && entry.amount > filter.maxAmount) match = false;
      return match;
    }).reverse();
  };

  T.getAllocationHistory = function(allocationType) {
    var log = _readAuditLog();
    return log.filter(function(entry) {
      return entry.allocationType === allocationType;
    }).reverse();
  };

  T.getSpendingHistory = function(period) {
    var log = _readAuditLog();
    var now = Date.now();
    var ms;

    switch (period) {
      case 'day':   ms = 24 * 60 * 60 * 1000; break;
      case 'week':  ms = 7 * 24 * 60 * 60 * 1000; break;
      case 'month': ms = 30 * 24 * 60 * 60 * 1000; break;
      default:      ms = 24 * 60 * 60 * 1000; break;
    }

    var cutoff = now - ms;

    return log.filter(function(entry) {
      return new Date(entry.timestamp).getTime() >= cutoff;
    }).reverse();
  };

  T.exportAuditReport = function() {
    var log = _readAuditLog();
    var now = new Date().toISOString();

    var totalSpent = log.reduce(function(sum, e) {
      return sum + (e.action === 'spend' || e.action === 'recordSpend' ? (Number(e.amount) || 0) : 0);
    }, 0);

    var totalAllocated = log.reduce(function(sum, e) {
      return sum + (e.action === 'allocationSet' || e.action === 'setAllocation' ? (Number(e.amount) || 0) : 0);
    }, 0);

    var actionsSummary = {};
    log.forEach(function(e) {
      var key = e.action || 'unknown';
      actionsSummary[key] = (actionsSummary[key] || 0) + 1;
    });

    var tokensSummary = {};
    log.forEach(function(e) {
      var key = e.token || 'unknown';
      tokensSummary[key] = (tokensSummary[key] || 0) + 1;
    });

    var report = {
      generatedAt: now,
      totalEntries: log.length,
      totalSpent: totalSpent,
      totalAllocated: totalAllocated,
      actionCounts: actionsSummary,
      tokenUsage: tokensSummary,
      newestEntry: log.length > 0 ? log[log.length - 1] : null,
      oldestEntry: log.length > 0 ? log[0] : null,
      entries: log.slice().reverse()
    };

    return report;
  };

  console.log('[AgentTreasury Audit] Loaded');
})();
