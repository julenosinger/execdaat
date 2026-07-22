// ============================================================
// EXECDAAT AGENT AUDIT — Audit System
// Build: 20260722 — IIFE / Event-based / Pure logic
//
// Namespace: D.AgentAudit
//
// Events dispatched:
//   agentAudit:entryAdded
//   agentAudit:dailyReport
//   agentAudit:thresholdReached
// ============================================================
;(function() {
  'use strict';
  var D = window.ExecDaat = window.ExecDaat || {};

  var AUDIT_KEY = 'execdaat_agent_audit';
  var MAX_ENTRIES = 1000;
  var ERROR_THRESHOLD = 10;

  var _state = {
    entries: [],
    filters: null,
    loaded: false
  };

  var _errorCount = 0;
  var _lastDailyReport = '';

  function _emit(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent('agentAudit:' + name, { detail: detail || {} }));
    } catch (e) { /* never throw from event handlers */ }
  }

  function _now() {
    return new Date().toISOString();
  }

  function _uid() {
    return 'au_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function _formatAmount(amount) {
    var n = Number(amount);
    if (!isFinite(n)) return '0.000000';
    return n.toFixed(6);
  }

  function _save() {
    try {
      var trimmed = _state.entries.slice(0, MAX_ENTRIES);
      localStorage.setItem(AUDIT_KEY, JSON.stringify(trimmed));
    } catch (e) { /* quota exceeded */ }
  }

  function _load() {
    try {
      var raw = localStorage.getItem(AUDIT_KEY);
      if (raw) _state.entries = JSON.parse(raw);
    } catch (e) { /* corrupt data, start fresh */ }
  }

  function _severityForStatus(status) {
    switch (status) {
      case 'failed':
      case 'error':
        return 'critical';
      case 'pending':
      case 'pending_approval':
        return 'warning';
      default:
        return 'info';
    }
  }

  function _moduleFromEventType(eventType) {
    if (!eventType) return 'system';
    if (eventType.indexOf('agentTreasury:') === 0 || eventType.indexOf('treasury') >= 0) return 'treasury';
    if (eventType.indexOf('agentPermission:') === 0 || eventType.indexOf('permission') >= 0) return 'permissions';
    if (eventType.indexOf('agentVault:') === 0 || eventType.indexOf('vault') >= 0) return 'vault';
    if (eventType.indexOf('agentPolicy:') === 0 || eventType.indexOf('policy') >= 0) return 'policies';
    if (eventType.indexOf('agentIntent:') === 0 || eventType.indexOf('intent') >= 0) return 'intents';
    if (eventType.indexOf('agentExecution:') === 0 || eventType.indexOf('execution') >= 0) return 'execution';
    if (eventType.indexOf('agentWorkflow:') === 0 || eventType.indexOf('automation') >= 0) return 'automation';
    if (eventType.indexOf('agentWallet:') === 0 || eventType.indexOf('wallet') >= 0) return 'wallet';
    return 'system';
  }

  function _categoryFromEvent(eventType, detail) {
    if (!eventType) return 'operation';
    if (eventType.indexOf('failed') >= 0 || eventType.indexOf('error') >= 0) return 'error';
    if (eventType.indexOf('completed') >= 0 || eventType.indexOf('success') >= 0) return 'success';
    if (eventType.indexOf('warning') >= 0 || eventType.indexOf('limitExceeded') >= 0) return 'warning';
    if (eventType.indexOf('approval') >= 0 || eventType.indexOf('approved') >= 0) return 'approval';
    if (eventType.indexOf('check') >= 0 || eventType.indexOf('validat') >= 0) return 'check';
    return 'operation';
  }

  function _statusFromEvent(eventType, detail) {
    if (!eventType) return 'pending';
    if (eventType.indexOf('failed') >= 0 || eventType.indexOf('error') >= 0) return 'failed';
    if (eventType.indexOf('completed') >= 0 || eventType.indexOf('success') >= 0) return 'success';
    if (eventType.indexOf('warning') >= 0) return 'warning';
    return 'pending';
  }

  function _createEntry(eventType, detail) {
    var entry = {
      id: _uid(),
      timestamp: detail.timestamp || _now(),
      module: detail.module || _moduleFromEventType(eventType),
      category: detail.category || _categoryFromEvent(eventType, detail),
      action: detail.action || eventType || 'unknown',
      status: detail.status || _statusFromEvent(eventType, detail),
      details: {
        agentId: detail.agentId || '',
        amount: detail.amount ? _formatAmount(detail.amount) : '',
        token: detail.token || '',
        operation: detail.operation || detail.type || '',
        txHash: detail.txHash || '',
        blockNumber: detail.blockNumber || 0,
        error: detail.error || '',
        metadata: detail.metadata || {}
      },
      severity: detail.severity || _severityForStatus(detail.status || _statusFromEvent(eventType, detail))
    };

    // Copy additional data from detail to entry details
    if (detail.item) {
      var item = detail.item;
      if (item.type) entry.details.operation = item.type;
      if (item.params) {
        entry.details.amount = _formatAmount(item.params.amount || '0');
        entry.details.token = item.params.token || '';
      }
      if (item.result) {
        entry.details.txHash = item.result.txHash || '';
        entry.details.blockNumber = item.result.blockNumber || 0;
        entry.details.error = item.result.error || '';
      }
    }

    // Merge nested detail if present
    if (detail.detail && typeof detail.detail === 'object') {
      var nested = detail.detail;
      if (nested.item && nested.item.params) {
        entry.details.amount = _formatAmount(nested.item.params.amount || '0');
        entry.details.token = nested.item.params.token || '';
      }
      if (nested.error) entry.details.error = nested.error;
    }

    // Handle workflow events
    if (detail.workflowId) {
      entry.details.metadata.workflowId = detail.workflowId;
    }
    if (detail.workflow && detail.workflow.name) {
      entry.action = entry.action + ' (' + detail.workflow.name + ')';
    }

    return entry;
  }

  function _addEntry(entry) {
    _state.entries.unshift(entry);
    if (_state.entries.length > MAX_ENTRIES) {
      _state.entries.length = MAX_ENTRIES;
    }

    if (entry.severity === 'critical' || entry.status === 'failed') {
      _errorCount++;
    }

    _emit('entryAdded', { entry: entry });

    if (_errorCount >= ERROR_THRESHOLD) {
      _emit('thresholdReached', {
        threshold: ERROR_THRESHOLD,
        count: _errorCount,
        timestamp: _now()
      });
    }

    _save();
    _checkDailyReport();
  }

  function _checkDailyReport() {
    var today = new Date().toISOString().slice(0, 10);
    if (_lastDailyReport === today) return;
    _lastDailyReport = today;

    var summary = D.AgentAudit.getDailySummary();
    _emit('dailyReport', { summary: summary, date: today });
  }

  function _logGenericEvent(event) {
    try {
      var eventType = event.type || 'unknown';
      var detail = event.detail || {};
      var entry = _createEntry(eventType, detail);
      _addEntry(entry);
    } catch (e) { /* ignore */ }
  }

  function _subscribeToAllModules() {
    var eventPatterns = [
      'agentTreasury:',
      'agentPermission:',
      'agentVault:',
      'agentPolicy:',
      'agentIntent:',
      'agentExecution:',
      'agentWorkflow:',
      'agentWallet:'
    ];

    window.addEventListener('*', _logGenericEvent);
    // Since we cannot subscribe to wildcard events, we subscribe to known events
    var knownEvents = [
      'agentTreasury:updated',
      'agentTreasury:allocationChanged',
      'agentTreasury:spendRecorded',
      'agentTreasury:limitExceeded',
      'agentTreasury:limitWarning',
      'agentTreasury:policyRuleAdded',
      'agentTreasury:policyRuleTriggered',
      'agentTreasury:policyEvaluationComplete',
      'agentPermission:updated',
      'agentPermission:added',
      'agentPermission:removed',
      'agentPermission:checkFailed',
      'agentPermission:limitExceeded',
      'agentVault:allocationChanged',
      'agentVault:deposit',
      'agentVault:withdraw',
      'agentVault:allocationSet',
      'agentPolicy:initialized',
      'agentPolicy:ruleAdded',
      'agentPolicy:ruleTriggered',
      'agentPolicy:evaluated',
      'agentIntent:created',
      'agentIntent:approved',
      'agentIntent:rejected',
      'agentIntent:updated',
      'agentExecution:enqueued',
      'agentExecution:started',
      'agentExecution:validating',
      'agentExecution:pendingApproval',
      'agentExecution:approved',
      'agentExecution:executing',
      'agentExecution:completed',
      'agentExecution:failed',
      'agentExecution:cancelled',
      'agentExecution:retried',
      'agentExecution:enginePaused',
      'agentExecution:engineResumed',
      'agentExecution:emergencyStop',
      'agentWorkflow:added',
      'agentWorkflow:updated',
      'agentWorkflow:removed',
      'agentWorkflow:activated',
      'agentWorkflow:paused',
      'agentWorkflow:evaluated',
      'agentWorkflow:executed',
      'agentWorkflow:conditionMet',
      'agentWorkflow:actionExecuted',
      'agentWorkflow:scheduled',
      'agentWallet:initialized',
      'agentWallet:registered',
      'agentWallet:unregistered',
      'agentWallet:reputationUpdated',
      'agentWallet:treasuryRefreshed',
      'agentWallet:validationRequested',
      'agentWallet:executionValidated',
      'agentWallet:scheduleChecked',
      'agentWallet:policyCheck'
    ];

    for (var i = 0; i < knownEvents.length; i++) {
      window.addEventListener(knownEvents[i], _logGenericEvent);
    }
  }

  function _normalizeDate(date) {
    if (!date) return null;
    if (typeof date === 'string') return date;
    if (date instanceof Date) return date.toISOString();
    return String(date);
  }

  // ═══════════════════════════════════════════════════════════════
  //  PUBLIC API
  // ═══════════════════════════════════════════════════════════════

  D.AgentAudit = {
    get state() { return Object.assign({}, _state); },
    get entries() { return _state.entries.slice(); },
    get loaded() { return _state.loaded; },

    init: function() {
      if (_state.loaded) return _state;
      _load();
      _state.loaded = true;
      _subscribeToAllModules();
      return _state;
    },

    log: function(entry) {
      if (!entry) return null;
      var auditEntry = _createEntry(entry.module || 'system', entry);
      if (entry.action) auditEntry.action = entry.action;
      if (entry.category) auditEntry.category = entry.category;
      if (entry.status) auditEntry.status = entry.status;
      if (entry.severity) auditEntry.severity = entry.severity;
      if (entry.details) {
        Object.assign(auditEntry.details, entry.details);
      }
      if (entry.module) auditEntry.module = entry.module;
      _addEntry(auditEntry);
      return auditEntry;
    },

    logFromEvent: function(event) {
      if (!event) return null;
      var entry = _createEntry(event.type || 'unknown', event.detail || {});
      _addEntry(entry);
      return entry;
    },

    getEntries: function(filter) {
      var result = _state.entries.slice();
      if (filter) {
        result = result.filter(function(e) {
          if (filter.module && e.module !== filter.module) return false;
          if (filter.category && e.category !== filter.category) return false;
          if (filter.status && e.status !== filter.status) return false;
          if (filter.severity && e.severity !== filter.severity) return false;
          if (filter.startDate && new Date(e.timestamp) < new Date(filter.startDate)) return false;
          if (filter.endDate && new Date(e.timestamp) > new Date(filter.endDate)) return false;
          if (filter.agentId && e.details.agentId !== filter.agentId) return false;
          return true;
        });
      }
      _state.filters = filter || null;
      return result;
    },

    getEntriesByModule: function(module, limit) {
      var filtered = _state.entries.filter(function(e) { return e.module === module; });
      if (limit && limit > 0) filtered = filtered.slice(0, limit);
      return filtered;
    },

    getEntriesByAgent: function(agentId, limit) {
      var filtered = _state.entries.filter(function(e) { return e.details.agentId === agentId; });
      if (limit && limit > 0) filtered = filtered.slice(0, limit);
      return filtered;
    },

    getEntriesByType: function(type, limit) {
      var filtered = _state.entries.filter(function(e) { return e.details.operation === type; });
      if (limit && limit > 0) filtered = filtered.slice(0, limit);
      return filtered;
    },

    getRecentActivity: function(limit) {
      var lim = limit || 50;
      return _state.entries.slice(0, lim);
    },

    getDailySummary: function() {
      var today = new Date().toISOString().slice(0, 10);
      var todayEntries = _state.entries.filter(function(e) { return e.timestamp.slice(0, 10) === today; });

      var byModule = {};
      var byStatus = {};
      var bySeverity = {};
      var byCategory = {};

      for (var i = 0; i < todayEntries.length; i++) {
        var e = todayEntries[i];
        byModule[e.module] = (byModule[e.module] || 0) + 1;
        byStatus[e.status] = (byStatus[e.status] || 0) + 1;
        bySeverity[e.severity] = (bySeverity[e.severity] || 0) + 1;
        byCategory[e.category] = (byCategory[e.category] || 0) + 1;
      }

      return {
        date: today,
        total: todayEntries.length,
        byModule: byModule,
        byStatus: byStatus,
        bySeverity: bySeverity,
        byCategory: byCategory
      };
    },

    getWeeklySummary: function() {
      var now = new Date();
      var startOfWeek = new Date(now);
      startOfWeek.setDate(now.getDate() - now.getDay());
      startOfWeek.setHours(0, 0, 0, 0);
      var startStr = startOfWeek.toISOString();

      var weekEntries = _state.entries.filter(function(e) { return e.timestamp >= startStr; });

      var byDay = {};
      var byModule = {};
      var byStatus = {};
      var bySeverity = {};

      for (var i = 0; i < weekEntries.length; i++) {
        var e = weekEntries[i];
        var day = e.timestamp.slice(0, 10);
        byDay[day] = (byDay[day] || 0) + 1;
        byModule[e.module] = (byModule[e.module] || 0) + 1;
        byStatus[e.status] = (byStatus[e.status] || 0) + 1;
        bySeverity[e.severity] = (bySeverity[e.severity] || 0) + 1;
      }

      return {
        startDate: startStr,
        endDate: _now(),
        total: weekEntries.length,
        byDay: byDay,
        byModule: byModule,
        byStatus: byStatus,
        bySeverity: bySeverity
      };
    },

    search: function(query) {
      if (!query) return [];
      var q = String(query).toLowerCase();
      return _state.entries.filter(function(e) {
        return (e.action && e.action.toLowerCase().indexOf(q) >= 0) ||
               (e.module && e.module.toLowerCase().indexOf(q) >= 0) ||
               (e.category && e.category.toLowerCase().indexOf(q) >= 0) ||
               (e.details && e.details.txHash && e.details.txHash.toLowerCase().indexOf(q) >= 0) ||
               (e.details && e.details.error && e.details.error.toLowerCase().indexOf(q) >= 0) ||
               (e.details && e.details.operation && e.details.operation.toLowerCase().indexOf(q) >= 0) ||
               (e.details && e.details.agentId && e.details.agentId.toLowerCase().indexOf(q) >= 0);
      });
    },

    exportReport: function(format) {
      format = format || 'json';
      if (format === 'json') {
        return {
          exportedAt: _now(),
          totalEntries: _state.entries.length,
          entries: _state.entries.slice()
        };
      }
      return JSON.stringify({
        exportedAt: _now(),
        totalEntries: _state.entries.length,
        entries: _state.entries.slice()
      }, null, 2);
    },

    clear: function(olderThan) {
      if (!olderThan) {
        _state.entries = [];
        _errorCount = 0;
        _save();
        return _state.entries.length;
      }

      var cutoff = _normalizeDate(olderThan);
      if (!cutoff) return _state.entries.length;

      _state.entries = _state.entries.filter(function(e) {
        return new Date(e.timestamp) >= new Date(cutoff);
      });
      _save();
      return _state.entries.length;
    },

    getStats: function() {
      var byModule = {};
      var bySeverity = {};
      var byStatus = {};

      for (var i = 0; i < _state.entries.length; i++) {
        var e = _state.entries[i];
        byModule[e.module] = (byModule[e.module] || 0) + 1;
        bySeverity[e.severity] = (bySeverity[e.severity] || 0) + 1;
        byStatus[e.status] = (byStatus[e.status] || 0) + 1;
      }

      return {
        total: _state.entries.length,
        byModule: byModule,
        bySeverity: bySeverity,
        byStatus: byStatus,
        errorCount: _errorCount,
        loaded: _state.loaded
      };
    }
  };

  // Auto-init on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { D.AgentAudit.init(); });
  } else {
    D.AgentAudit.init();
  }
})();
