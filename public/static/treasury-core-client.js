// ============================================================
// Treasury Core Client — ExecDaat (Phase 4)
// ------------------------------------------------------------
// Thin, well-behaved HTTP client for the Elligent Treasury Core
// API. Exposed as window.TreasuryCore.
//
// Endpoints (all via the same-origin proxy that injects the
// Application Secret + HMAC signature server-side):
//   POST   /api/core/v1/intents           createIntent()
//   GET    /api/core/v1/intents/{id}       getIntent()  (status)
//   POST   /api/core/v1/quote              quote()
//   POST   /api/core/v1/execute            execute()
//   GET    /api/core/v1/history            history()
//   GET    /api/core/v1/metrics            metrics()
//   GET    /api/core/v1/applications       applications()
//   GET    /api/core/v1/health             health()
//
// Guarantees:
//   • Every request carries a Correlation ID header.
//   • Retries ONLY transient failures (network / 502 / 503 / 504)
//     and ONLY for idempotent GETs (never re-POSTs intents/execute).
//   • De-duplicates concurrent identical GETs (avoids duplicate calls).
//   • Reuses the browser's persistent same-origin HTTP connections.
//   • Never sends secrets or private keys (there are none client-side).
//   • Surfaces friendly errors; raw internals stay server-side.
//   • Emits lightweight observability via window.TreasuryObs.
// build: 20260705b
// ============================================================
'use strict';

(function () {
  var TRANSIENT = { 0: 1, 429: 1, 502: 1, 503: 1, 504: 1 };   // Phase 8: 429 added for rate-limit backoff
  var MAX_RETRIES = 3;                                           // increased from 2
  var RETRY_BASE_MS = 250;
  var RATE_LIMIT_BACKOFF = [2000, 5000, 10000];                  // longer backoff for 429
  var DEFAULT_TIMEOUT_MS = 25000;
  // In-flight GET de-duplication (idempotent reads only).
  var _inflight = {};

  function _cfg() {
    return (window.TreasuryConfig && window.TreasuryConfig.get()) || {
      basePath: '/api/core/v1', apiVersion: 'v1', treasuryMode: 'REMOTE', enabled: false,
    };
  }
  function _base() {
    return (window.TreasuryConfig && window.TreasuryConfig.basePath()) || '/api/core/v1';
  }
  function _newCorr() {
    return (window.TreasuryConfig && window.TreasuryConfig.newCorrelationId())
      || ('exd-' + Math.random().toString(16).slice(2, 26));
  }

  // ── Observability sink (no sensitive data) ─────────────────────────────────
  function _obs(entry) {
    try {
      if (window.TreasuryObs && typeof window.TreasuryObs.record === 'function') {
        window.TreasuryObs.record(entry);
      }
    } catch (e) {}
  }

  function _log() {
    try {
      var a = Array.prototype.slice.call(arguments);
      a.unshift('%c[TREASURY-CORE]', 'color:#34d399');
      console.log.apply(console, a);
    } catch (e) {}
  }

  function _sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ── Friendly error shaping (never leak internals) ──────────────────────────
  function _friendly(status, code, correlationId) {
    var map = {
      DISABLED: 'Treasury Core is not configured for this environment.',
      UNAVAILABLE: 'Treasury service is temporarily unavailable. Please try again shortly.',
      TIMEOUT: 'Treasury service took too long to respond. Please try again.',
      UPSTREAM: 'The Treasury service could not process this request.',
      NOTFOUND: 'Requested Treasury resource was not found.',
      NETWORK: 'Could not reach the Treasury service. Please check your connection.',
    };
    var e = new Error(map[code] || map.UPSTREAM);
    e.friendly = map[code] || map.UPSTREAM;
    e.code = code;
    e.status = status;
    e.correlationId = correlationId;
    e.transient = !!TRANSIENT[status] || code === 'TIMEOUT' || code === 'NETWORK';
    return e;
  }

  // ── Core request with correlation + retry (GET only) + observability ───────
  function _request(method, path, opts) {
    opts = opts || {};
    var correlationId = opts.correlationId || _newCorr();
    var url = _base() + path;
    var timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    var canRetry = method === 'GET';
    var started = Date.now();
    var cleanEndpoint = (_base() + path).split('?')[0];

    function attempt(n) {
      var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs) : null;

      var headers = {
        'Accept': 'application/json',
        'X-Correlation-Id': correlationId,
      };
      var init = { method: method, headers: headers, credentials: 'same-origin' };
      if (ctrl) init.signal = ctrl.signal;
      if (opts.body !== undefined && (method === 'POST' || method === 'PUT')) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(opts.body || {});
      }

      return fetch(url, init).then(function (res) {
        if (timer) clearTimeout(timer);
        var status = res.status;
        return res.text().then(function (txt) {
          var json = null;
          try { json = txt ? JSON.parse(txt) : null; } catch (e) { json = null; }

          if (res.ok) {
            _obs({
              correlationId: correlationId,
              intentId: (json && (json.intentId || (json.intent && json.intent.id) || (json.data && (json.data.intentId || (json.data.intent && json.data.intent.id))))) || opts.intentId || null,
              endpoint: cleanEndpoint, method: method, status: status,
              latencyMs: Date.now() - started, result: 'ok', attempt: n,
            });
            var out = (json != null ? json : {});
            // Elligent wraps responses as { success, data, errors }. Unwrap one
            // `data` layer so downstream adapters see the payload directly. Also
            // works with flat responses (returns them unchanged).
            if (out && typeof out === 'object' && out.success === true && out.data !== undefined && out.data !== null) {
              var d = out.data;
              if (d && typeof d === 'object') {
                if (out.correlationId && d.correlationId === undefined) { try { d.correlationId = out.correlationId; } catch (e) {} }
              }
              return d;
            }
            return out;
          }

          // Non-OK. Retry transient GETs.
          if (TRANSIENT[status] && canRetry && n < MAX_RETRIES) {
            _obs({ correlationId: correlationId, endpoint: cleanEndpoint, method: method, status: status, latencyMs: Date.now() - started, result: 'transient', attempt: n });
            var delay = status === 429 ? (RATE_LIMIT_BACKOFF[n] || 5000) : RETRY_BASE_MS * Math.pow(2, n);
            return _sleep(delay).then(function () { return attempt(n + 1); });
          }

          var code = status === 404 ? 'NOTFOUND' : TRANSIENT[status] ? 'UNAVAILABLE' : 'UPSTREAM';
          _obs({ correlationId: correlationId, endpoint: cleanEndpoint, method: method, status: status, latencyMs: Date.now() - started, result: 'error', attempt: n });
          throw _friendly(status, code, (json && json.correlationId) || correlationId);
        });
      }).catch(function (err) {
        if (timer) clearTimeout(timer);
        // Already a friendly, thrown error — rethrow.
        if (err && err.friendly) throw err;
        var aborted = err && err.name === 'AbortError';
        if (canRetry && n < MAX_RETRIES) {
          _obs({ correlationId: correlationId, endpoint: cleanEndpoint, method: method, status: 0, latencyMs: Date.now() - started, result: 'transient', attempt: n });
          return _sleep(RETRY_BASE_MS * Math.pow(2, n)).then(function () { return attempt(n + 1); });
        }
        _obs({ correlationId: correlationId, endpoint: cleanEndpoint, method: method, status: aborted ? 504 : 0, latencyMs: Date.now() - started, result: 'error', attempt: n });
        throw _friendly(aborted ? 504 : 0, aborted ? 'TIMEOUT' : 'NETWORK', correlationId);
      });
    }

    return attempt(0);
  }

  // GET requests are de-duplicated: concurrent identical reads share one
  // in-flight promise. POSTs (intents/execute) are NEVER de-duplicated.
  function _requestDeduped(method, path, opts) {
    if (method !== 'GET') return _request(method, path, opts);
    var key = 'GET ' + _base() + path;
    if (_inflight[key]) return _inflight[key];
    var p = _request(method, path, opts);
    _inflight[key] = p;
    function clear() { if (_inflight[key] === p) delete _inflight[key]; }
    p.then(clear, clear);
    return p;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  // POST /intents — create a Treasury intent. Returns { intentId, ... }.
  // Sensitive material is NEVER placed in the body; only public operation data.
  function createIntent(params, correlationId) {
    var cfg = _cfg();
    var body = {
      applicationId: cfg.applicationId || 'EXECDAAT',
      clientId: cfg.clientId || 'EXECDAAT-PROD',
      version: cfg.apiVersion || 'v1',
      sourceChain: params.sourceChain,
      destinationChain: params.destinationChain,
      asset: String(params.token || params.asset || 'USDC').toLowerCase(),
      amount: Number(params.amount),
      wallet: params.wallet,
      recipient: params.recipient || params.wallet,
    };
    return _request('POST', '/intents', { body: body, correlationId: correlationId });
  }

  // POST /quote — best route. Never recalculated locally.
  function quote(params, correlationId) {
    var cfg = _cfg();
    var body = {
      applicationId: cfg.applicationId || 'EXECDAAT',
      clientId: cfg.clientId || 'EXECDAAT-PROD',
      version: cfg.apiVersion || 'v1',
      intentId: params.intentId || undefined,
      sourceChain: params.sourceChain,
      destinationChain: params.destinationChain,
      asset: String(params.token || params.asset || 'USDC').toLowerCase(),
      amount: Number(params.amount),
      wallet: params.wallet,
      recipient: params.recipient || params.wallet,
    };
    return _request('POST', '/quote', { body: body, correlationId: correlationId });
  }

  // POST /execute — begin execution on Elligent. Signature only when applicable.
  function execute(params, correlationId) {
    var cfg = _cfg();
    var body = {
      application: cfg.applicationId || 'EXECDAAT',
      clientId: cfg.clientId || 'EXECDAAT-PROD',
      version: cfg.apiVersion || 'v1',
      intentId: params.intentId,
      wallet: params.wallet,
      correlationId: correlationId || params.correlationId,
    };
    if (params.signature) body.signature = params.signature;
    if (params.quoteId) body.quoteId = params.quoteId;
    return _request('POST', '/execute', { body: body, correlationId: correlationId });
  }

  // GET /intents/{id} — canonical operation state (drives all UI).
  function getIntent(intentId, correlationId) {
    var id = encodeURIComponent(String(intentId || ''));
    return _requestDeduped('GET', '/intents/' + id, { correlationId: correlationId, intentId: intentId });
  }

  // GET /history — remote history with filters. Falls back to local when down.
  function history(filters, correlationId) {
    var qs = _buildQuery(filters);
    return _requestDeduped('GET', '/history' + qs, { correlationId: correlationId });
  }

  // GET /metrics — treasury metrics.
  function metrics(filters, correlationId) {
    var qs = _buildQuery(filters);
    return _requestDeduped('GET', '/metrics' + qs, { correlationId: correlationId });
  }

  // GET /applications — registered applications breakdown.
  function applications(correlationId) {
    return _requestDeduped('GET', '/applications', { correlationId: correlationId });
  }

  // GET /health — treasury/bridge/vault/relayer/circle/rpc statuses.
  function health(correlationId) {
    return _requestDeduped('GET', '/health', { correlationId: correlationId, timeoutMs: 8000 });
  }

  function _buildQuery(filters) {
    if (!filters) return '';
    var parts = [];
    Object.keys(filters).forEach(function (k) {
      var v = filters[k];
      if (v === undefined || v === null || v === '') return;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    });
    return parts.length ? ('?' + parts.join('&')) : '';
  }

  // ── Status poller — drives the timeline from GET /intents/{id} ─────────────
  // Never reconstructs state locally; the API is the single source of truth.
  function pollIntent(intentId, opts) {
    opts = opts || {};
    var onUpdate = typeof opts.onUpdate === 'function' ? opts.onUpdate : function () {};
    var intervalMs = opts.intervalMs || 4000;
    var maxPolls = opts.maxPolls || 150;
    var correlationId = opts.correlationId;
    var terminal = opts.terminalStates || ['SETTLED', 'COMPLETED', 'FAILED', 'REFUNDED', 'CANCELLED'];
    var polls = 0;

    return new Promise(function (resolve, reject) {
      function tick() {
        polls++;
        getIntent(intentId, correlationId).then(function (data) {
          var intent = (data && data.intent) ? data.intent : data;
          onUpdate(intent, data);
          var st = String((intent && intent.status) || '').toUpperCase();
          if (terminal.indexOf(st) !== -1) { resolve(intent); return; }
          if (polls >= maxPolls) { resolve(intent); return; }
          setTimeout(tick, intervalMs);
        }).catch(function (err) {
          // Transient error → keep polling until maxPolls; hard error → reject.
          if (err && err.transient && polls < maxPolls) { setTimeout(tick, intervalMs); return; }
          reject(err);
        });
      }
      tick();
    });
  }

  window.TreasuryCore = {
    VERSION: '20260705b',
    createIntent: createIntent,
    quote: quote,
    execute: execute,
    getIntent: getIntent,
    pollIntent: pollIntent,
    history: history,
    metrics: metrics,
    applications: applications,
    health: health,
    // Small debounce util (used to avoid rapid duplicate quote calls).
    debounce: function (fn, wait) {
      var t = null;
      return function () {
        var ctx = this, args = arguments;
        if (t) clearTimeout(t);
        t = setTimeout(function () { t = null; fn.apply(ctx, args); }, wait || 250);
      };
    },
  };

  _log('client ready');
})();
