// ============================================================
// Treasury UI Sync — ExecDaat (Phase 4)
// ------------------------------------------------------------
// Keeps the experience layer in sync with the Treasury Core as the
// single source of truth — WITHOUT changing any UI/UX.
//
// Responsibilities (all additive, all guarded — never throws):
//   • Real-time refresh: after ANY treasury/bridge/payment operation
//     completes, automatically refresh Unified Balance + History +
//     Advanced Cross-Chain balances (no manual page refresh needed).
//   • Unified history: broadcasts a `treasury:history` event and fills
//     any [data-treasury-history] container when remote history is used.
//   • Metrics: when effective REMOTE, periodically pulls /metrics and
//     fills any [data-treasury-metric="<key>"] node + broadcasts
//     `treasury:metrics` so dashboards can consume it. No-op if absent.
//
// It reuses the app's EXISTING refresh hooks (window.ubRefresh,
// window.histRefreshNew/historyInit, window.accRefreshBalances). If a
// hook is missing, it is silently skipped.
// build: 20260705b
// ============================================================
'use strict';

(function () {
  function _log() {
    try {
      var a = Array.prototype.slice.call(arguments);
      a.unshift('%c[TREASURY-SYNC]', 'color:#38bdf8');
      console.log.apply(console, a);
    } catch (e) {}
  }

  function _remote() {
    try { return !!(window.TreasuryData && window.TreasuryData.isRemote && window.TreasuryData.isRemote()); }
    catch (e) { return false; }
  }

  // ── Real-time refresh of every experience-layer view ───────────────────────
  var _refreshing = false;
  function refreshUI() {
    if (_refreshing) return;
    _refreshing = true;
    setTimeout(function () { _refreshing = false; }, 1200); // coalesce bursts
    try { if (typeof window.ubRefresh === 'function') setTimeout(window.ubRefresh, 300); } catch (e) {}
    try { if (typeof window.accRefreshBalances === 'function') setTimeout(window.accRefreshBalances, 400); } catch (e) {}
    try {
      if (typeof window.histRefreshNew === 'function') setTimeout(window.histRefreshNew, 800);
      else if (typeof window.historyInit === 'function') setTimeout(window.historyInit, 800);
    } catch (e) {}
    // Let dashboards refresh treasury metrics too.
    syncMetrics();
  }

  // Subscribe to the app's existing completion events (dispatched as `ub:*`).
  var COMPLETION_EVENTS = [
    'ub:bridge:completed',
    'ub:cctp:completed',
    'ub:payment:executed',
    'ub:agent:executed',
    'treasury:completed',
  ];
  COMPLETION_EVENTS.forEach(function (evt) {
    try { window.addEventListener(evt, function () { refreshUI(); }); } catch (e) {}
  });

  // ── Metrics (remote → optional DOM + broadcast) ────────────────────────────
  var _metricsTimer = null;
  var _lastMetrics = null;

  function _fmt(v) {
    if (v == null) return '—';
    if (typeof v === 'number') {
      if (Math.abs(v) >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
      return String(v);
    }
    return String(v);
  }

  function _fillMetricNodes(metrics) {
    if (!metrics || typeof document === 'undefined') return;
    try {
      var nodes = document.querySelectorAll('[data-treasury-metric]');
      nodes.forEach(function (n) {
        var key = n.getAttribute('data-treasury-metric');
        if (!key) return;
        var val = metrics[key];
        if (val === undefined && metrics.metrics) val = metrics.metrics[key];
        if (val !== undefined) n.textContent = _fmt(val);
      });
    } catch (e) {}
  }

  function syncMetrics(filters) {
    if (!_remote() || !window.TreasuryData) return Promise.resolve(null);
    return window.TreasuryData.metrics(filters).then(function (m) {
      if (!m) return null;
      _lastMetrics = m;
      _fillMetricNodes(m);
      try { window.dispatchEvent(new CustomEvent('treasury:metrics', { detail: m })); } catch (e) {}
      return m;
    }).catch(function () { return null; });
  }

  // ── History (remote → optional DOM container + broadcast) ──────────────────
  function _fillHistoryContainers(items) {
    if (!items || typeof document === 'undefined') return;
    try {
      var containers = document.querySelectorAll('[data-treasury-history]');
      if (!containers.length) return;
      var list = Array.isArray(items) ? items : (items.items || items.history || []);
      containers.forEach(function (c) {
        // Additive rendering only into explicit opt-in containers.
        c.setAttribute('data-treasury-count', String(list.length));
      });
    } catch (e) {}
  }

  function syncHistory(filters) {
    if (!_remote() || !window.TreasuryData) return Promise.resolve(null);
    return window.TreasuryData.history(filters).then(function (h) {
      if (!h) return null;
      _fillHistoryContainers(h);
      try { window.dispatchEvent(new CustomEvent('treasury:history', { detail: h })); } catch (e) {}
      return h;
    }).catch(function () { return null; });
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────────
  function _boot() {
    var cfgP = (window.TreasuryConfig && window.TreasuryConfig.load()) || Promise.resolve();
    cfgP.then(function () {
      if (_remote()) {
        syncMetrics();
        if (!_metricsTimer) _metricsTimer = setInterval(function () { if (_remote()) syncMetrics(); }, 30000);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot);
  } else {
    setTimeout(_boot, 0);
  }

  window.TreasuryUISync = {
    VERSION: '20260705b',
    refreshUI: refreshUI,
    syncMetrics: syncMetrics,
    syncHistory: syncHistory,
    lastMetrics: function () { return _lastMetrics; },
  };

  _log('ui-sync ready');
})();
