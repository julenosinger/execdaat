// ============================================================
// ExecDaat Polling Manager — Global request governor
// ------------------------------------------------------------
// ADDITIVE & SAFE: no existing module is replaced. Modules
// opt-in via one-line guards. Provides:
//   • Central registry of timers (register/unregister/destroy)
//   • Global pause/resume driven by Page Visibility API
//   • Multi-tab leader election (localStorage heartbeat +
//     BroadcastChannel) so ambient monitors run in ONE tab only
//   • Request coalescing + shared TTL cache (dedupe)
// Exposes: window.PollingManager
// build: 20260717pm1
// ============================================================
;(function () {
  'use strict';
  if (window.PollingManager && window.PollingManager.__ready) return;

  var VERSION = '20260717pm1';
  var LS_KEY = 'execdaat-pm-leader';
  var HEARTBEAT_MS = 5000;
  var STALE_MS = 12000;

  var _tabId = 'tab-' + Math.random().toString(16).slice(2, 12) + '-' + Date.now().toString(36);
  var _timers = {};        // id -> { timerId, opts }
  var _paused = false;
  var _leader = false;
  var _bc = null;
  var _hbTimer = null;
  var _cache = {};         // key -> { value, expires }
  var _inflight = {};      // key -> Promise

  function _now() { return Date.now(); }
  function _lsGet() { try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (_) { return null; } }
  function _lsSet(v) { try { localStorage.setItem(LS_KEY, JSON.stringify(v)); } catch (_) {} }
  function _lsDel() { try { var c = _lsGet(); if (c && c.id === _tabId) localStorage.removeItem(LS_KEY); } catch (_) {} }

  // ── Leader election ────────────────────────────────────────
  function _claimLeadership() {
    var cur = _lsGet();
    if (!cur || cur.id === _tabId || (_now() - (cur.ts || 0)) > STALE_MS) {
      _lsSet({ id: _tabId, ts: _now() });
      // Verify we actually won (last-writer-wins is fine here)
      var check = _lsGet();
      _leader = !!(check && check.id === _tabId);
    } else {
      _leader = false;
    }
    return _leader;
  }

  function _releaseLeadership() {
    if (_leader) { _leader = false; _lsDel(); try { if (_bc) _bc.postMessage({ t: 'released', id: _tabId }); } catch (_) {} }
  }

  function _heartbeat() {
    try {
      if (document.hidden) {
        // Hidden tabs must not hold leadership — let a visible tab take over.
        _releaseLeadership();
        return;
      }
      var cur = _lsGet();
      if (_leader) {
        if (!cur || cur.id === _tabId) _lsSet({ id: _tabId, ts: _now() });
        else _leader = false; // someone else took over
      } else {
        if (!cur || (_now() - (cur.ts || 0)) > STALE_MS) _claimLeadership();
      }
    } catch (_) { _leader = true; } // storage unavailable → behave standalone
  }

  try {
    if (typeof BroadcastChannel !== 'undefined') {
      _bc = new BroadcastChannel('execdaat-pm');
      _bc.onmessage = function (ev) {
        var m = ev && ev.data;
        if (!m) return;
        if (m.t === 'released' && !document.hidden) setTimeout(_heartbeat, 250 + Math.random() * 500);
      };
    }
  } catch (_) { _bc = null; }

  // ── Visibility handling ────────────────────────────────────
  function _onVisibility() {
    if (document.hidden) {
      _paused = true;
      _releaseLeadership();
    } else {
      _paused = false;
      _heartbeat();
      // Notify listeners that polling may resume (modules can refresh immediately)
      try { window.dispatchEvent(new CustomEvent('pm:resume')); } catch (_) {}
    }
  }
  try { document.addEventListener('visibilitychange', _onVisibility); } catch (_) {}
  try { window.addEventListener('pagehide', function () { _releaseLeadership(); }); } catch (_) {}
  try { window.addEventListener('beforeunload', function () { _releaseLeadership(); }); } catch (_) {}

  // Initial state
  _paused = !!document.hidden;
  if (!document.hidden) _claimLeadership();
  _hbTimer = setInterval(_heartbeat, HEARTBEAT_MS);

  // ── Public API ─────────────────────────────────────────────
  var PM = {
    __ready: true,
    VERSION: VERSION,
    tabId: _tabId,

    /** true when this tab is the elected leader (ambient monitors) */
    isLeader: function () { return _leader; },

    /** true when polling should proceed.
     *  scope 'tab'     → only requires the page to be visible
     *  scope 'ambient' → requires visible AND leadership (default)   */
    shouldPoll: function (scope) {
      if (_paused || document.hidden) return false;
      if (scope === 'tab') return true;
      return _leader;
    },

    /** Register an existing interval/timeout id for central cleanup */
    register: function (id, timerId, opts) {
      if (!id) return timerId;
      if (_timers[id] && _timers[id].timerId !== timerId) { try { clearInterval(_timers[id].timerId); } catch (_) {} }
      _timers[id] = { timerId: timerId, opts: opts || {} };
      return timerId;
    },

    unregister: function (id) {
      var t = _timers[id];
      if (t) { try { clearInterval(t.timerId); } catch (_) {} try { clearTimeout(t.timerId); } catch (_) {} delete _timers[id]; }
    },

    /** Convenience: create + register a managed interval whose callback
     *  is automatically gated by shouldPoll(scope). */
    interval: function (id, fn, ms, scope) {
      var timerId = setInterval(function () {
        if (!PM.shouldPoll(scope || 'ambient')) return;
        try { fn(); } catch (_) {}
      }, ms);
      return PM.register(id, timerId, { ms: ms, scope: scope || 'ambient' });
    },

    pause: function () { _paused = true; },
    resume: function () { _paused = !!document.hidden; },
    start: function () { PM.resume(); },
    stop: function () { PM.pause(); },

    destroy: function () {
      Object.keys(_timers).forEach(function (id) { PM.unregister(id); });
      if (_hbTimer) { clearInterval(_hbTimer); _hbTimer = null; }
      _releaseLeadership();
    },

    status: function () {
      return { tabId: _tabId, leader: _leader, paused: _paused, hidden: !!document.hidden, timers: Object.keys(_timers) };
    },

    // ── Request coalescing + shared TTL cache ────────────────
    /** dedupe('key', fetcherFn, ttlMs) — concurrent callers share ONE
     *  in-flight promise; results are cached for ttlMs. */
    dedupe: function (key, fetcher, ttlMs) {
      ttlMs = ttlMs || 15000;
      var c = _cache[key];
      if (c && _now() < c.expires) return Promise.resolve(c.value);
      if (_inflight[key]) return _inflight[key];
      var p = Promise.resolve().then(fetcher).then(function (v) {
        _cache[key] = { value: v, expires: _now() + ttlMs };
        delete _inflight[key];
        return v;
      }).catch(function (e) {
        delete _inflight[key];
        // serve stale on failure when available
        if (c) return c.value;
        throw e;
      });
      _inflight[key] = p;
      return p;
    },

    /** invalidate cached keys (prefix match) — call after write ops */
    invalidate: function (prefix) {
      Object.keys(_cache).forEach(function (k) { if (!prefix || k.indexOf(prefix) === 0) delete _cache[k]; });
    }
  };

  window.PollingManager = PM;
  try { console.log('%c[PM] Polling Manager ready', 'color:#38bdf8;font-weight:bold', '| v' + VERSION + ' | tab ' + _tabId); } catch (_) {}
})();
