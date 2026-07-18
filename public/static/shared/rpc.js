// ============================================================
// ExecDaat RPC Manager v2 — Reliability Engine
// ============================================================
// Enhanced Phase 4: health monitor, latency, fallback, retry,
// exponential backoff, circuit breaker, blacklist, metrics.
// ============================================================
;(function() {
  'use strict';
  var D = window.ExecDaat = window.ExecDaat || {};

  var RPCS = D.CHAIN ? D.CHAIN.RPCS.slice() : [
    'https://rpc.testnet.arc.network',
    'https://rpc.blockdaemon.testnet.arc.network',
    'https://rpc.drpc.testnet.arc.network',
    'https://rpc.quicknode.testnet.arc.network',
  ];

  // Request-optimization (Phase 4): public read RPC stays FIRST so plain
  // blockchain reads go straight to the network (0 Cloudflare requests).
  // The same-origin /api/rpc proxy is inserted as the SECOND endpoint: the
  // moment a public endpoint rate-limits ("request limit reached") or fails,
  // the reliability stack (retry/rotate/circuit-breaker) fails over to the
  // proxy, which distributes reads across all Arc RPCs server-side.
  if (typeof window !== 'undefined' && window.location && String(window.location.origin).indexOf('http') === 0) {
    RPCS.splice(1, 0, window.location.origin + '/api/rpc');
  }

  // ─── State ─────────────────────────────────────────────────────────────
  var currentIndex  = 0;
  var healthCache   = {};   // { url: { ok, latencyMs, failures, lastCheck } }
  var circuitOpen   = {};   // { url: timestamp when circuit opens }
  var pendingChecks = {};
  var metrics       = { totalRequests: 0, totalFailures: 0, totalRetries: 0, avgLatency: 0 };
  var HEALTH_TTL       = 30000;  // 30s between health checks
  var CIRCUIT_TIMEOUT  = 60000;  // 60s circuit breaker timeout
  var MAX_FAILURES     = 3;      // consecutive failures before circuit opens
  var MAX_RETRIES      = 3;
  var BASE_BACKOFF     = 500;    // ms
  var MAX_BACKOFF      = 8000;   // ms

  // ─── Internal ──────────────────────────────────────────────────────────
  function now() { return Date.now(); }

  function isCircuitOpen(url) {
    var ot = circuitOpen[url];
    if (!ot) return false;
    if (now() - ot > CIRCUIT_TIMEOUT) { delete circuitOpen[url]; return false; }
    return true;
  }

  function recordFailure(url) {
    var h = healthCache[url] = healthCache[url] || { ok: false, latencyMs: 0, failures: 0, lastCheck: now() };
    h.failures++;
    h.lastCheck = now();
    h.ok = false;
    metrics.totalFailures++;
    if (h.failures >= MAX_FAILURES) {
      circuitOpen[url] = now();
      D.safeLogWarn && D.safeLogWarn('rpc', 'Circuit breaker OPEN for ' + url + ' after ' + h.failures + ' failures');
    }
  }

  function recordSuccess(url, latencyMs) {
    var h = healthCache[url] = healthCache[url] || { ok: true, latencyMs: 0, failures: 0, lastCheck: now() };
    h.failures = 0;
    h.latencyMs = latencyMs;
    h.lastCheck = now();
    h.ok = true;
    delete circuitOpen[url];
    // Update running avg latency
    metrics.totalRequests++;
    metrics.avgLatency = Math.round((metrics.avgLatency * (metrics.totalRequests - 1) + latencyMs) / metrics.totalRequests);
  }

  function getHealthyRPCs() {
    return RPCS.filter(function(url) { return !isCircuitOpen(url); });
  }

  // ─── Public API ────────────────────────────────────────────────────────

  /** Get the current best RPC URL */
  D.getRPC = function() {
    var healthy = getHealthyRPCs();
    if (healthy.length === 0) {
      // All circuits open — reset and retry
      D.safeLogWarn && D.safeLogWarn('rpc', 'All RPCs in circuit-breaker — resetting');
      circuitOpen = {};
      healthy = RPCS;
      currentIndex = 0;
    }
    if (currentIndex >= healthy.length) currentIndex = 0;
    return healthy[currentIndex] || RPCS[0];
  };

  /** Get all RPC URLs */
  D.getRPCs = function() { return RPCS.slice(); };

  /** Rotate to next healthy RPC */
  D.rotateRPC = function() {
    var healthy = getHealthyRPCs();
    if (healthy.length === 0) return RPCS[0];
    currentIndex = (currentIndex + 1) % healthy.length;
    return healthy[currentIndex];
  };

  /** Reset to default */
  D.resetRPC = function() { currentIndex = 0; circuitOpen = {}; return D.getRPC(); };

  /** Health check with latency measurement */
  D.rpcHealthCheck = function(rpcUrl) {
    rpcUrl = rpcUrl || D.getRPC();
    if (isCircuitOpen(rpcUrl)) return Promise.resolve(false);
    var cached = healthCache[rpcUrl];
    if (cached && (now() - cached.lastCheck) < HEALTH_TTL) return Promise.resolve(cached.ok);

    // Deduplicate concurrent checks for same URL
    if (pendingChecks[rpcUrl]) return pendingChecks[rpcUrl];
    var t0 = now();

    pendingChecks[rpcUrl] = fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
    }).then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function(j) {
      var ok = !!(j && j.result);
      var lat = now() - t0;
      if (ok) recordSuccess(rpcUrl, lat); else recordFailure(rpcUrl);
      delete pendingChecks[rpcUrl];
      return ok;
    }).catch(function() {
      recordFailure(rpcUrl);
      delete pendingChecks[rpcUrl];
      return false;
    });

    return pendingChecks[rpcUrl];
  };

  /** Background health check all RPCs */
  D.rpcHealthCheckAll = function() {
    return Promise.all(RPCS.map(function(url) { return D.rpcHealthCheck(url).catch(function() { return false; }); }));
  };

  /** Find fastest healthy RPC */
  D.rpcFindFastest = function() {
    var checks = RPCS.filter(function(u) { return !isCircuitOpen(u); }).map(function(url) {
      return D.rpcHealthCheck(url).then(function(ok) {
        var h = healthCache[url];
        return { url: url, ok: ok, latencyMs: h ? h.latencyMs : Infinity };
      });
    });
    return Promise.all(checks).then(function(results) {
      var best = null;
      results.forEach(function(r) {
        if (r.ok && (!best || r.latencyMs < best.latencyMs)) best = r;
      });
      if (best) {
        currentIndex = RPCS.indexOf(best.url);
        if (currentIndex < 0) currentIndex = 0;
      }
      return best;
    });
  };

  /** Fetch with full reliability stack: retry + backoff + fallback */
  D.rpcFetch = function(body, opts) {
    opts = opts || {};
    var maxTries = opts.maxRetries || MAX_RETRIES;
    var fallback = opts.fallback !== false;
    var tries = 0;
    var rpc = D.getRPC();

    function attempt() {
      if (tries >= maxTries) {
        if (fallback && tries < RPCS.length) { rpc = D.rotateRPC(); tries++; return attempt(); }
        return Promise.reject(new Error('All RPC endpoints exhausted after ' + tries + ' attempts'));
      }
      return fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function(j) {
        if (j && j.error) throw new Error(j.error.message || 'RPC error ' + (j.error.code || ''));
        return j;
      }).catch(function(err) {
        tries++;
        metrics.totalRetries++;
        if (tries >= maxTries && fallback) rpc = D.rotateRPC();
        var delay = Math.min(BASE_BACKOFF * Math.pow(2, tries - 1), MAX_BACKOFF);
        return new Promise(function(resolve) { setTimeout(resolve, delay); }).then(attempt);
      });
    }
    return attempt();
  };

  /** Get RPC metrics */
  D.getRPCMetrics = function() {
    var activeRPC = D.getRPC();
    var rpcStats = {};
    RPCS.forEach(function(url) {
      var h = healthCache[url] || {};
      rpcStats[url] = {
        healthy: h.ok || false,
        latencyMs: h.latencyMs || null,
        failures: h.failures || 0,
        circuitOpen: !!isCircuitOpen(url),
        lastCheck: h.lastCheck || null,
      };
    });
    return {
      activeRPC: activeRPC,
      healthyCount: getHealthyRPCs().length,
      totalCount: RPCS.length,
      rpcs: rpcStats,
      metrics: metrics,
    };
  };

  /** Periodic background health check (caller provides interval) */
  D.startRPCHealthMonitor = function(intervalMs) {
    intervalMs = intervalMs || 300000;
    if (D._rpcHealthTimer) clearInterval(D._rpcHealthTimer);
    // Initial probe only when the tab is visible AND elected leader
    if (!window.PollingManager || window.PollingManager.shouldPoll('ambient')) D.rpcHealthCheckAll();
    D._rpcHealthTimer = setInterval(function() {
      if (window.PollingManager && !window.PollingManager.shouldPoll('ambient')) return;
      D.rpcHealthCheckAll();
    }, intervalMs);
    if (window.PollingManager) window.PollingManager.register('rpc-health-monitor', D._rpcHealthTimer, { ms: intervalMs, scope: 'ambient' });
    return D._rpcHealthTimer;
  };

  /** Stop background health monitor */
  D.stopRPCHealthMonitor = function() {
    if (D._rpcHealthTimer) { clearInterval(D._rpcHealthTimer); D._rpcHealthTimer = null; }
    if (window.PollingManager) window.PollingManager.unregister('rpc-health-monitor');
  };

  // Auto-start health monitor after script loads
  // Request-optimization: 30s → 300s (health is re-validated on demand by
  // rpcFetch failures + circuit breaker; a 5-min ambient sweep is enough).
  setTimeout(function() { D.startRPCHealthMonitor(300000); }, 2000);
})();
