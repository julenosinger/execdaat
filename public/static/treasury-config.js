// ============================================================
// Treasury Config — ExecDaat (Phase 3)
// ------------------------------------------------------------
// Loads the non-sensitive Treasury Core configuration from the
// ExecDaat backend and exposes it as window.TreasuryConfig.
//
// The frontend NEVER sees the Application Secret. It only learns:
//   • which mode is active (LOCAL | REMOTE)
//   • whether the remote path is enabled (URL configured)
//   • the public identity (Application/Client/Version)
//
// Correlation IDs are generated here and propagated on every
// Treasury Core request (logs / intent / timeline / history /
// support / audit).
// build: 20260705a
// ============================================================
'use strict';

(function () {
  var CONFIG_URL = '/api/treasury/config';

  var _state = {
    loaded: false,
    loading: null,
    applicationId: 'EXECDAAT',
    clientId: 'EXECDAAT-PROD',
    apiVersion: 'v1',
    applicationMode: 'REMOTE',
    treasuryMode: 'REMOTE',
    enabled: false,            // remote path can be attempted
    basePath: '/api/core/v1',  // same-origin proxy base
  };

  function _log() {
    try {
      var a = Array.prototype.slice.call(arguments);
      a.unshift('%c[TREASURY-CFG]', 'color:#22d3ee');
      console.log.apply(console, a);
    } catch (e) {}
  }

  // ── Correlation ID — stable RFC-ish, safe charset ([A-Za-z0-9_-]) ──────────
  function newCorrelationId() {
    var rnd;
    try {
      if (window.crypto && window.crypto.randomUUID) {
        rnd = window.crypto.randomUUID().replace(/-/g, '');
      } else {
        rnd = Math.random().toString(16).slice(2) + Date.now().toString(16);
      }
    } catch (e) {
      rnd = Math.random().toString(16).slice(2) + Date.now().toString(16);
    }
    return 'exd-' + rnd.slice(0, 24);
  }

  // ── Load config from backend (cached; safe to call repeatedly) ─────────────
  function load(force) {
    if (_state.loaded && !force) return Promise.resolve(_state);
    if (_state.loading && !force) return _state.loading;

    _state.loading = fetch(CONFIG_URL, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      credentials: 'same-origin',
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && j.ok) {
          _state.applicationId = j.applicationId || _state.applicationId;
          _state.clientId = j.clientId || _state.clientId;
          _state.apiVersion = j.apiVersion || _state.apiVersion;
          _state.applicationMode = j.applicationMode || _state.applicationMode;
          _state.treasuryMode = j.treasuryMode || _state.treasuryMode;
          _state.enabled = !!j.enabled;
          _state.basePath = j.basePath || _state.basePath;
        }
        _state.loaded = true;
        _log('loaded', { mode: _state.treasuryMode, enabled: _state.enabled, basePath: _state.basePath });
        return _state;
      })
      .catch(function (e) {
        // On any failure, remain in safe default (enabled:false → LOCAL fallback).
        _state.loaded = true;
        _state.enabled = false;
        _log('config load failed — staying LOCAL', e && e.message);
        return _state;
      });

    return _state.loading;
  }

  function isRemote() {
    // Effective remote requires: mode REMOTE AND backend reports enabled.
    // Health is checked separately by the integration layer.
    return _state.treasuryMode === 'REMOTE' && _state.enabled === true;
  }

  window.TreasuryConfig = {
    VERSION: '20260705b',
    load: load,
    get: function () { return Object.assign({}, _state); },
    isRemote: isRemote,
    mode: function () { return _state.treasuryMode; },
    basePath: function () { return _state.basePath; },
    newCorrelationId: newCorrelationId,
  };

  // Kick off an early load (non-blocking).
  try { load(); } catch (e) {}
  _log('ready');
})();
