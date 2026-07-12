// ============================================================
// ExecDaat Telemetry — Privacy-first performance metrics
// ============================================================
// Measures: page load, wallet connect, tx durations, RPC
// latency. Stores locally only. No tracking. No analytics.
// ============================================================
;(function() {
  'use strict';
  var D = window.ExecDaat = window.ExecDaat || {};

  var STORAGE_KEY = 'exd_telemetry';
  var MAX_ENTRIES = 500;
  var entries = [];
  var marks = {};
  var _loaded = false;

  function now() { return Date.now(); }
  function nowISO() { return new Date().toISOString(); }

  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES))); } catch(e) {}
  }

  function load() {
    if (_loaded) return;
    _loaded = true;
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) entries = JSON.parse(raw);
    } catch(e) { entries = []; }
  }

  function addEntry(category, name, durationMs, extra) {
    load();
    var entry = { ts: nowISO(), category: category, name: name, durationMs: durationMs, extra: extra || {} };
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
    // Persist periodically (every 10 entries)
    if (entries.length % 10 === 0) persist();
  }

  // ─── Public API ────────────────────────────────────────────────────────

  D.telemetry = {
    /** Start timing an operation */
    markStart: function(name) {
      marks[name] = now();
    },

    /** End timing and record duration */
    markEnd: function(name, category, extra) {
      var start = marks[name];
      if (!start) return 0;
      var duration = now() - start;
      delete marks[name];
      addEntry(category || 'operation', name, duration, extra);
      return duration;
    },

    /** Record a one-shot measurement */
    record: function(category, name, durationMs, extra) {
      addEntry(category, name, durationMs, extra);
    },

    /** Get all telemetry entries */
    getAll: function() {
      load();
      return entries.slice();
    },

    /** Get entries by category */
    getByCategory: function(cat) {
      load();
      return entries.filter(function(e) { return e.category === cat; });
    },

    /** Get average duration for a named operation */
    avg: function(name) {
      load();
      var matches = entries.filter(function(e) { return e.name === name; });
      if (matches.length === 0) return 0;
      var sum = matches.reduce(function(s, e) { return s + e.durationMs; }, 0);
      return Math.round(sum / matches.length);
    },

    /** Get summary stats */
    summary: function() {
      load();
      var cats = {};
      entries.forEach(function(e) {
        if (!cats[e.category]) cats[e.category] = { count: 0, totalMs: 0, minMs: Infinity, maxMs: 0 };
        var c = cats[e.category];
        c.count++;
        c.totalMs += e.durationMs;
        if (e.durationMs < c.minMs) c.minMs = e.durationMs;
        if (e.durationMs > c.maxMs) c.maxMs = e.durationMs;
      });
      var result = {};
      Object.keys(cats).forEach(function(k) {
        var c = cats[k];
        result[k] = { count: c.count, avgMs: Math.round(c.totalMs / c.count), minMs: c.minMs, maxMs: c.maxMs };
      });
      return result;
    },

    /** Clear all telemetry */
    clear: function() {
      entries = [];
      marks = {};
      try { localStorage.removeItem(STORAGE_KEY); } catch(e) {}
    },

    /** Get total entry count */
    count: function() { load(); return entries.length; },
  };

  // ─── Auto-capture key events ───────────────────────────────────────────

  // Page load timing
  if (window.performance && window.performance.timing) {
    var pt = window.performance.timing;
    if (pt.loadEventEnd && pt.navigationStart) {
      var pageLoad = pt.loadEventEnd - pt.navigationStart;
      D.telemetry.record('page', 'page-load', pageLoad);
    }
  } else if (window.performance && window.performance.now) {
    D.telemetry.record('page', 'page-load', Math.round(window.performance.now()));
  }

  // Wallet connect timing
  window.addEventListener('walletConnected', function() {
    D.telemetry.record('wallet', 'connect', 0);
  });

  // Persist on page unload
  window.addEventListener('beforeunload', function() { persist(); });
  window.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'hidden') persist();
  });

  // Periodic persistence
  setInterval(persist, 30000);
})();
