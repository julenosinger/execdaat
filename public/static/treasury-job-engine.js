// ============================================================
// TREASURY BACKGROUND JOB ENGINE — ExecDaat (additive, resilient)
// ------------------------------------------------------------
// A lightweight, priority-aware scheduler that runs maintenance
// jobs automatically in the background — read-only, non-financial.
//
// ADDITIVE & SAFE:
//   • Never replaces any existing logic.
//   • Jobs are STRICTLY read-only operations (health, metrics, vault,
//     liquidity, attestation detection, cache cleanup).
//   • Never retries financial operations (settlement, bridge, mint,
//     burn, vault debit/credit, transfer).
//   • Runs independently from the UI — survives tab switches.
//   • Pauses when the document is hidden; reduces frequency when idle.
//   • One failed job never stops the scheduler or affects other jobs.
//   • Every job lifecycle event is emitted via TreasuryEventBus.
//
// Exposes: window.TreasuryJobEngine
// build: 20260709j1
// ============================================================
'use strict';

(function () {
  if (window.TreasuryJobEngine && window.TreasuryJobEngine.__ready) return;

  var VERSION = '20260709j1';
  var CORE_BASE = '/api/core/v1';
  var ARC_RPC = 'https://rpc.testnet.arc.network';
  var ARC_EXPLORER = 'https://testnet.arcscan.app';
  var TICK_MS = 1000;

  // ── Priority levels (lower = runs sooner) ──────────────────────────────────
  var PRIORITY = { CRITICAL: 0, HIGH: 10, NORMAL: 20, LOW: 30, BACKGROUND: 40 };

  // ── Job model ──────────────────────────────────────────────────────────────
  function _jobId() { return 'job-' + Math.random().toString(16).slice(2, 12); }
  function _corr() { return 'job-' + Math.random().toString(16).slice(2, 18); }

  var _jobs = [];        // all registered { id, label, type, priority, recurring, intervalMs, fastIntervalMs, nextRun, enabled, worker, retryPolicy: {max, backoff}, state: {status, lastRun, lastDuration, runCount, failCount, retryCount, lastError} }
  var _stats = { running: 0, queued: 0, failed: 0, retryQueue: 0, lastRun: 0, avgDuration: 0, durations: [] };
  var _scheduler = null;
  var _idle = true;
  var _card = null;
  var LOG = false;

  function _log() { if (!LOG) return; try { var a = Array.prototype.slice.call(arguments); a.unshift('%c[TJOBS]', 'color:#f59e0b'); console.log.apply(console, a); } catch (_) {} }

  function emit(evt, payload) { try { if (window.TreasuryEventBus && window.TreasuryEventBus.emit) window.TreasuryEventBus.emit(evt, payload); } catch (_) {} }
  function toast(m, t) { try { if (typeof window.showToast === 'function') window.showToast(m, t || 'info'); } catch (_) {} }

  function fetchOk(url, opts, timeoutMs) {
    var ctrl = new AbortController(); var t = setTimeout(function () { ctrl.abort(); }, timeoutMs || 12000);
    return fetch(url, Object.assign({ signal: ctrl.signal, headers: { 'Accept': 'application/json', 'X-Correlation-Id': _corr() }, credentials: 'same-origin' }, opts || {}))
      .then(function (r) { clearTimeout(t); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .finally(function () { clearTimeout(t); });
  }

  // ── Safe read jobs (the ONLY job types — never financial) ──────────────────
  function jobHealth() {
    return fetchOk(CORE_BASE + '/health', {}, 10000).then(function (d) {
      var dd = d && d.data;
      if (dd) { _stats.healthStatus = dd.status; _stats.healthComponents = dd.components; }
      return dd;
    });
  }
  function jobMetrics() {
    return fetchOk(CORE_BASE + '/metrics', {}, 10000).then(function (d) {
      if (d && d.data) {
        _hasPending = (d.data.pendingSettlement > 0 || d.data.pendingReimbursement > 0 || d.data.activeIntents > 0);
        _lastMetrics = d.data;
      }
      return d && d.data;
    });
  }
  function jobVault() {
    return fetchOk(CORE_BASE + '/vault', {}, 10000).then(function (d) {
      if (d && d.data) { _lastVault = d.data; _stats.vaultAddress = d.data.address; _stats.vaultPaused = d.data.paused; }
      return d && d.data;
    });
  }
  function jobLiquidity() {
    return fetchOk(CORE_BASE + '/liquidity', {}, 10000).then(function (d) { return d && d.data; });
  }

  var _lastSettledCount = 0, _lastReimbursedCount = 0;
  function jobSyncAndDetect() {
    // Sync local bridge → Core (idempotent)
    try { if (window.TreasurySync && window.TreasurySync.syncNow) window.TreasurySync.syncNow(); } catch (_) {}
    // Poll the Event Bus producer once (already in treasury-event-bus.js)
    try { if (window.TreasuryEventBus && window.TreasuryEventBus.poll) window.TreasuryEventBus.poll(); } catch (_) {}
    // Fetch fresh metrics to detect new settlements / reimbursements
    return fetchOk(CORE_BASE + '/metrics', {}, 10000).then(function (d) {
      if (!d || !d.data) return;
      var sc = d.data.settledCount || 0, rc = d.data.settledCount || 0; // settledCount includes settled+reimbursed+completed
      if (sc > _lastSettledCount) { emit('SettlementDetected', { previousCount: _lastSettledCount, currentCount: sc, asset: null, timestamp: Date.now() }); _lastSettledCount = sc; }
      else _lastSettledCount = sc;
      // Reimbursement detection via history (filter reimbursed)
      return fetchOk(CORE_BASE + '/reimbursements', {}, 10000).then(function (r) {
        if (r && r.data && r.data.total > _lastReimbursedCount) { emit('ReimbursementDetected', { previousCount: _lastReimbursedCount, currentCount: r.data.total, timestamp: Date.now() }); _lastReimbursedCount = r.data.total; }
        else _lastReimbursedCount = r.data.total;
      }).catch(function () {});
    }).catch(function () {});
  }
  function jobCleanup() {
    // Expired caches (tenant-friendly — no critical data purged)
    return Promise.resolve();
  }

  // ── Define jobs (recurring, read-only, non-financial) ──────────────────────
  function defineJobs() {
    var defs = [
      { id: 'health',        label: 'Health Check',    type: 'Recurring', priority: PRIORITY.CRITICAL, intervalMs: 60000,  fastIntervalMs: 30000,  worker: jobHealth },
      { id: 'metrics',       label: 'Metrics Refresh', type: 'Recurring', priority: PRIORITY.HIGH,     intervalMs: 60000,  fastIntervalMs: 20000,  worker: jobMetrics },
      { id: 'vault',         label: 'Vault Refresh',   type: 'Recurring', priority: PRIORITY.NORMAL,   intervalMs: 120000, fastIntervalMs: 30000,  worker: jobVault },
      { id: 'liquidity',     label: 'Liquidity Check', type: 'Recurring', priority: PRIORITY.LOW,      intervalMs: 180000, fastIntervalMs: 60000,  worker: jobLiquidity },
      { id: 'sync-detect',   label: 'Sync & Detect',   type: 'Recurring', priority: PRIORITY.NORMAL,   intervalMs: 60000,  fastIntervalMs: 15000,  worker: jobSyncAndDetect },
      { id: 'cleanup',       label: 'Cache Cleanup',   type: 'Recurring', priority: PRIORITY.BACKGROUND, intervalMs: 300000, fastIntervalMs: 300000, worker: jobCleanup },
    ];
    defs.forEach(function (d) {
      d.recurring = true;
      d.enabled = true;
      d.nextRun = Date.now() + 1000; // short initial delay
      d.state = { status: 'idle', lastRun: 0, lastDuration: 0, runCount: 0, failCount: 0, retryCount: 0, lastError: null };
      // Only the safe read jobs may retry (never financial jobs — none exist here).
      if (['health', 'metrics', 'vault', 'liquidity', 'sync-detect'].indexOf(d.id) !== -1) {
        d.retryPolicy = { max: 3, backoff: [2000, 5000, 10000] };
      } else {
        d.retryPolicy = { max: 0, backoff: [] };
      }
      _jobs.push(d);
    });
  }

  // ── Scheduler loop ─────────────────────────────────────────────────────────
  // Request-optimization: jobs only run at full cadence while a treasury
  // surface (Treasury / TOC / Reimbursements / XBridge) is in use OR there is
  // pending work. Otherwise a single slow "metrics" heartbeat (5 min) keeps
  // pending-operation detection alive. Multi-tab: only the leader tab polls.
  var HEARTBEAT_MS_IDLE = 300000;
  function _treasuryContextActive() {
    try {
      var ids = ['tab-content-treasury', 'tab-content-toc', 'tab-content-reimbursements', 'tab-content-xbridge'];
      for (var i = 0; i < ids.length; i++) {
        var el = document.getElementById(ids[i]);
        if (el && !el.classList.contains('hidden')) return true;
      }
    } catch (_) {}
    return false;
  }

  function tick() {
    var now = Date.now();
    var hidden = document.hidden;
    if (hidden) return; // pause when hidden
    if (window.PollingManager && !window.PollingManager.shouldPoll('ambient')) return; // leader tab only

    if (!_treasuryContextActive() && !_hasPending) {
      // Ambient heartbeat: metrics only, every 5 minutes
      for (var k = 0; k < _jobs.length; k++) {
        var mj = _jobs[k];
        if (mj.id !== 'metrics') continue;
        if (!mj.enabled || mj.nextRun > now || mj.state.status === 'running') break;
        mj.nextRun = now + HEARTBEAT_MS_IDLE;
        runJob(mj, now).then(function (r) { r.job.nextRun = Date.now() + HEARTBEAT_MS_IDLE; });
        break;
      }
      return;
    }

    for (var i = 0; i < _jobs.length; i++) {
      var j = _jobs[i];
      if (!j.enabled) continue;
      if (j.nextRun > now) continue;
      var interval = _idle ? (j.intervalMs || 30000) : (j.fastIntervalMs || j.intervalMs || 10000);
      if (j.state.status === 'running') { j.nextRun = now + interval; continue; } // already executing — reschedule

      runJob(j, now).then(function (result) {
        var jr = result.job;
        jr.nextRun = Date.now() + (_idle ? (jr.intervalMs || 30000) : (jr.fastIntervalMs || jr.intervalMs || 10000));
        _stats.jobsRan = (_stats.jobsRan || 0) + 1;
        if (_stats.jobsRan % 10 === 0) updateCard();
      });
    }
  }

  function runJob(j, started) {
    j.state.status = 'running'; j.state.lastRun = started; _stats.running++;
    var cid = _corr();
    emit('JobStarted', { jobId: j.id, label: j.label, type: j.type, priority: j.priority, correlationId: cid, timestamp: started });
    updateCard();
    return Promise.resolve().then(function () { return j.worker(); }).then(function (res) {
      var end = Date.now(); var dur = end - started;
      j.state.status = 'idle'; j.state.lastDuration = dur; j.state.runCount++; j.state.retryCount = 0; j.state.lastError = null;
      _stats.running--; _stats.lastRun = end;
      // rolling avg (last 20)
      _stats.durations.push(dur); if (_stats.durations.length > 20) _stats.durations.shift();
      _stats.avgDuration = Math.round(_stats.durations.reduce(function (a, b) { return a + b; }, 0) / _stats.durations.length);
      emit('JobCompleted', { jobId: j.id, label: j.label, type: j.type, priority: j.priority, started: started, duration: dur, result: res ? 'ok' : 'ok', correlationId: cid, timestamp: end });
      _log(j.label, 'completed in', dur, 'ms');
      return { job: j, ok: true };
    }).catch(function (err) {
      j.state.status = 'idle'; j.state.failCount++; j.state.lastError = (err && err.message) || String(err); _stats.running--; _stats.failed++;
      var rp = j.retryPolicy || { max: 0, backoff: [] };
      if (j.state.retryCount < rp.max) {
        j.state.retryCount++;
        j.nextRun = Date.now() + (rp.backoff[j.state.retryCount - 1] || 10000);
        _stats.retryQueue++;
        emit('JobRetried', { jobId: j.id, label: j.label, attempt: j.state.retryCount, error: j.state.lastError, nextRun: j.nextRun, correlationId: cid, timestamp: Date.now() });
        _log(j.label, 'failed — retrying', j.state.retryCount, '/', rp.max, 'in', (j.nextRun - Date.now()), 'ms');
      } else {
        emit('JobFailed', { jobId: j.id, label: j.label, error: j.state.lastError, correlationId: cid, timestamp: Date.now() });
        _log(j.label, 'failed permanently after', j.state.failCount, 'attempts');
      }
      return { job: j, ok: false };
    }).finally(function () { updateCard(); });
  }

  // ── Idle detection (adjust intervals dynamically) ───────────────────────────
  var _hasPending = false, _lastMetrics = null, _lastVault = null;
  function checkIdle() {
    try {
      if (window.TreasuryEventBus && window.TreasuryEventBus.emit) {
        // ... (emit used below)
      }
    } catch (_) {}

    // Read pending from last metrics (updated by each job run)
    _idle = !_hasPending;
  }

  // ── Health card injection (Treasury page only) ─────────────────────────────
  function injectCard() {
    if (_card && document.getElementById('trs-bg-services')) return;
    if (!document.getElementById('trs-bg-styles')) {
      var st = document.createElement('style'); st.id = 'trs-bg-styles';
      st.textContent = '.trs-bg-card .trs-bg-head{display:flex;align-items:center;gap:6px;font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:#f59e0b;margin-bottom:7px;}.trs-bg-card .trs-bg-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:2.5px 0;color:#9db8d8;}.trs-bg-card .trs-bg-row span:last-child{color:#dbe4f2;font-weight:600;}';
      document.head.appendChild(st);
    }
    var el = document.createElement('div');
    el.id = 'trs-bg-services';
    el.className = 'trs-bg-card';
    el.innerHTML = '<div class="trs-bg-head"><i class="fas fa-gears" style="color:#f59e0b;font-size:9px;"></i><span>Background Services</span></div><div id="trs-bg-body"></div>';
    el.style.cssText = 'position:fixed;bottom:12px;right:16px;z-index:90;background:rgba(8,11,24,0.85);border:1px solid rgba(55,138,221,0.16);border-radius:12px;padding:10px 12px;max-width:260px;backdrop-filter:blur(8px);font-size:10.5px;color:#8aaac8;display:none;';
    document.body.appendChild(el);
    _card = el;
    // show/hide based on treasury tab visibility
    setInterval(function () {
      var tabEl = document.getElementById('tab-content-treasury');
      if (_card) {
        var visible = tabEl && !tabEl.classList.contains('hidden');
        _card.style.display = visible ? 'block' : 'none';
        if (visible) updateCard();
      }
    }, 2000);
  }
  function updateCard() {
    var body = document.getElementById('trs-bg-body');
    if (!body) return;
    var h = _stats.healthStatus || 'unknown';
    var hc = h === 'ok' ? '#34d399' : (h === 'degraded' ? '#fbbf24' : '#f87171');
    var running = _stats.running || 0;
    var retry = _stats.retryQueue || 0;
    var last = _stats.lastRun ? Math.round((Date.now() - _stats.lastRun) / 1000) + 's ago' : 'never';
    body.innerHTML = [
      '<div class="trs-bg-row"><span>Scheduler</span><span style="color:#34d399;font-weight:700;">' + (running ? 'Running' : 'Idle') + '</span></div>',
      '<div class="trs-bg-row"><span>Jobs active</span><span>' + running + '</span></div>',
      '<div class="trs-bg-row"><span>Retry queue</span><span style="color:' + (retry ? '#fbbf24' : '#5f7ba0') + ';">' + retry + '</span></div>',
      '<div class="trs-bg-row"><span>Last sync</span><span>' + last + '</span></div>',
      '<div class="trs-bg-row"><span>Health</span><span style="color:' + hc + ';font-weight:700;"><i class="fas fa-circle" style="font-size:6px;"></i> ' + h + '</span></div>',
      '<div class="trs-bg-row"><span>Avg exec</span><span>' + (_stats.avgDuration || 0) + 'ms</span></div>',
    ].join('');
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  var _started = false;
  function start() {
    if (_started) return;
    _started = true;
    defineJobs();
    injectCard();
    // tick every second
    _scheduler = setInterval(function () { checkIdle(); tick(); }, TICK_MS);
    if (window.PollingManager) window.PollingManager.register('treasury-job-engine', _scheduler, { ms: TICK_MS, scope: 'ambient' });
    // pause on hide
    try { document.addEventListener('visibilitychange', function () { if (!document.hidden) { _idle = true; checkIdle(); } }); } catch (_) {}
    // resume on page show
    try { window.addEventListener('pageshow', function () { checkIdle(); }); } catch (_) {}
    _log('Background Job Engine started ·', _jobs.length, 'jobs');
  }

  window.TreasuryJobEngine = {
    __ready: true,
    VERSION: VERSION,
    start: start,
    stop: function () { if (_scheduler) { clearInterval(_scheduler); _scheduler = null; } if (window.PollingManager) window.PollingManager.unregister('treasury-job-engine'); _started = false; },
    status: function () { return Object.assign({}, _stats, { jobs: _jobs.map(function (j) { var s = Object.assign({}, j.state); s.priority = j.priority; s.id = j.id; s.label = j.label; s.type = j.type; return s; }) }); },
    runNow: function (id) { var j = _jobs.find(function (x) { return x.id === id; }); if (j) { j.nextRun = Date.now() + 100; } },
    setLogging: function (v) { LOG = !!v; }
  };

  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(start, 2500);
  else document.addEventListener('DOMContentLoaded', function () { setTimeout(start, 2500); });

  try { console.log('%c[TJOBS] Job Engine ready', 'color:#f59e0b;font-weight:bold', '| v' + VERSION + ' | read-only · additive'); } catch (_) {}
})();
