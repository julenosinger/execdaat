// ============================================================
// TREASURY EVENT BUS — ExecDaat (native, additive, non-breaking)
// ------------------------------------------------------------
// A single lightweight pub/sub layer that becomes the internal
// synchronization spine for every Treasury / Bridge / Settlement /
// Reimbursement event.
//
// STRICTLY ADDITIVE & OBSERVE-ONLY:
//   • Never modifies the Bridge / Turbo Bridge execution flow.
//   • Never signs, moves, locks or reimburses funds.
//   • Never blocks or delays bridge / settlement / reimbursement.
//   • One failing subscriber never affects the others (isolated dispatch).
//
// PRODUCERS (how events enter the bus):
//   1) Diffing window.RepaymentContract (local bridge ledger) → emits
//      canonical lifecycle events when an intent's stage advances.
//   2) Adapting existing window CustomEvents already dispatched by the
//      app (ub:bridge:completed, ub:cctp:completed, treasury:completed,
//      treasurybridge:event, reimbursement:completed).
//
// REACTORS (who consumes, all debounced & guarded):
//   Ledger/Core sync · Reimbursements · History · Treasury · Metrics ·
//   Analytics · Unified Balance · Notifications
//   (each reactor only calls a module's EXISTING public refresh fn).
//
// No external dependencies. No secrets ever in payloads.
// build: 20260709e1
// ============================================================
'use strict';

(function () {
  if (window.TreasuryEventBus && window.TreasuryEventBus.__ready) return; // singleton

  var VERSION = '20260709e1';
  var POLL_MS = 4000;          // producer diff interval (cheap localStorage read)
  var DEBOUNCE_MS = 500;       // UI reactor debounce
  var LOG = false;

  // ── Core pub/sub (EventTarget-backed, resilient dispatch) ─────────────────
  var _target = (typeof EventTarget !== 'undefined') ? new EventTarget() : null;
  var _any = [];               // onAny subscribers
  var _wrapped = new WeakMap(); // cb -> wrapped handler (dedupe listeners)

  function _safe(fn, arg) { try { fn(arg); } catch (e) { try { console.warn('[TBUS] subscriber error (isolated):', e && e.message); } catch (_) {} } }

  function on(eventName, cb) {
    if (!_target || typeof cb !== 'function') return function () {};
    var h = _wrapped.get(cb);
    if (!h) { h = function (ev) { _safe(cb, ev.detail); }; _wrapped.set(cb, h); }
    _target.addEventListener(eventName, h);
    return function off() { try { _target.removeEventListener(eventName, h); } catch (_) {} };
  }
  function onAny(cb) { if (typeof cb === 'function' && _any.indexOf(cb) === -1) _any.push(cb); return function () { var i = _any.indexOf(cb); if (i !== -1) _any.splice(i, 1); }; }

  function emit(eventName, payload) {
    payload = payload || {};
    payload.event = eventName;
    if (!payload.timestamp) payload.timestamp = Date.now();
    payload.version = VERSION;
    if (LOG) { try { console.log('%c[TBUS] ' + eventName, 'color:#10b981', { intent: payload.intentId, stage: payload.stage, status: payload.settlementStatus || payload.status, ts: payload.timestamp }); } catch (_) {} }
    if (_target) { try { _target.dispatchEvent(new CustomEvent(eventName, { detail: payload })); } catch (_) {} }
    // onAny (isolated)
    for (var i = 0; i < _any.length; i++) _safe(_any[i], payload);
  }

  // ── Canonical stage → event mapping ───────────────────────────────────────
  var STAGE_EVENT = {
    CREATED: 'IntentCreated',
    RESERVED: 'LiquidityReserved',
    VAULT_DEBITED: 'VaultDebited',
    TREASURY_PAID: 'BridgeStarted',
    WAITING_ATTESTATION: 'BurnSubmitted',
    ATTESTED: 'AttestationReceived',
    MINTED: 'MintReceived',
    SETTLING: 'SettlementStarted',
    SETTLED: 'SettlementCompleted',
    REIMBURSED: 'VaultReimbursed',
    COMPLETED: 'Completed',
    FAILED: 'Failed',
    CANCELLED: 'Cancelled'
  };
  var STAGE_ORDER = ['CREATED', 'RESERVED', 'VAULT_DEBITED', 'TREASURY_PAID', 'WAITING_ATTESTATION', 'ATTESTED', 'MINTED', 'SETTLING', 'SETTLED', 'REIMBURSED', 'COMPLETED'];

  function pick(o) { for (var i = 1; i < arguments.length; i++) { var k = arguments[i]; if (o && o[k] != null && o[k] !== '') return o[k]; } return undefined; }

  function deriveStage(it) {
    var raw = String(pick(it, 'status', 'state') || '').toLowerCase();
    if (/fail|error|revert/.test(raw)) return 'FAILED';
    if (/cancel|expire/.test(raw)) return 'CANCELLED';
    var rs = String((it.reimbursement && it.reimbursement.status) || it.reimbursementStatus || '').toLowerCase();
    var vaultCredit = pick(it, 'vaultCreditTxHash', 'reimbursementTxHash');
    if (vaultCredit || /complete|done|reimbursed|success/.test(rs)) return /completed/.test(raw) ? 'COMPLETED' : 'REIMBURSED';
    if (rs && /pending|processing|await|running/.test(rs)) return 'SETTLED';
    if (pick(it, 'settlementTxHash', 'settleTx') || /settled|settlement complete/.test(raw)) return 'SETTLED';
    if (/settling|settlement running/.test(raw)) return 'SETTLING';
    if (pick(it, 'mintTxHash', 'circleMintTxHash') || /minted|mint executed|mint received/.test(raw)) return 'MINTED';
    if (pick(it, 'attestation', 'attestationHash') || /attested|attestation received/.test(raw)) return 'ATTESTED';
    if (pick(it, 'fulfillTxHash', 'arcTxHash') || /paid|treasury paid|fulfil/.test(raw)) return 'TREASURY_PAID';
    if (pick(it, 'txHash', 'burnTxHash', 'depositTxHash', 'sourceTxHash') || /burn|bridging|executing|waiting/.test(raw)) return 'WAITING_ATTESTATION';
    if (/debited/.test(raw)) return 'VAULT_DEBITED';
    if (/reserved/.test(raw)) return 'RESERVED';
    return 'CREATED';
  }

  // Build a safe, non-sensitive payload from a local intent record.
  function buildPayload(it, stage) {
    var created = Number(pick(it, 'createdAt', 'created', 'ts')) || 0;
    var txs = {
      burn: pick(it, 'txHash', 'burnTxHash', 'depositTxHash', 'sourceTxHash') || null,
      attestation: pick(it, 'attestation', 'attestationHash') || null,
      mint: pick(it, 'mintTxHash', 'circleMintTxHash') || null,
      fulfill: pick(it, 'fulfillTxHash', 'arcTxHash') || null,
      settlement: pick(it, 'settlementTxHash', 'settleTx') || null,
      vaultCredit: pick(it, 'vaultCreditTxHash', 'reimbursementTxHash') || null
    };
    var explorer = 'https://testnet.arcscan.app';
    return {
      intentId: String(pick(it, 'intentId', 'id') || ''),
      intentBytes32: pick(it, 'intentBytes32') || null,
      correlationId: pick(it, 'correlationId') || null,
      wallet: pick(it, 'userAddress', 'wallet', 'sender', 'account') || null,
      recipient: pick(it, 'recipient', 'receiver', 'userAddress') || null,
      asset: String(pick(it, 'asset', 'token', 'symbol') || '').toUpperCase() || null,
      amount: pick(it, 'grossAmount', 'amount', 'value') || null,
      sourceChain: pick(it, 'srcChain', 'sourceChain', 'origin') || null,
      destinationChain: pick(it, 'dstChain', 'destinationChain') || 'arc',
      bridge: pick(it, 'bridge') || 'Turbo',
      vault: pick(it, 'vault') || null,
      settlementStatus: (it.settlement && it.settlement.status) || it.settlementStatus || null,
      reimbursementStatus: (it.reimbursement && it.reimbursement.status) || it.reimbursementStatus || null,
      stage: stage,
      status: stage,
      txHashes: txs,
      explorer: explorer,
      duration: created ? (Date.now() - created) : null,
      memo: pick(it, 'memo') || null,
      application: 'EXECDAAT',
      worker: 'ExecDaat Native Treasury Core',
      timestamp: Date.now()
    };
  }

  // ── Producer 1: diff RepaymentContract → emit canonical lifecycle events ───
  var _lastStage = {};   // intentId -> last emitted stage
  var _seen = {};        // intentId -> true (for IntentCreated once)

  function pollLedger() {
    try {
      var rc = window.RepaymentContract;
      if (!rc || typeof rc.getAll !== 'function') return;
      var all = rc.getAll() || [];
      for (var i = 0; i < all.length; i++) {
        var it = all[i];
        var id = String(pick(it, 'intentId', 'id') || '');
        if (!id) continue;
        var stage = deriveStage(it);
        if (!_seen[id]) {
          _seen[id] = true;
          _lastStage[id] = stage;
          // Always announce discovery as IntentCreated (idempotent per id)
          emit('IntentCreated', buildPayload(it, stage));
          if (stage !== 'CREATED') emit(STAGE_EVENT[stage] || 'Updated', buildPayload(it, stage));
          continue;
        }
        if (_lastStage[id] !== stage) {
          _lastStage[id] = stage;
          emit(STAGE_EVENT[stage] || 'Updated', buildPayload(it, stage));
        }
      }
    } catch (e) { /* never throw — must not affect bridge */ }
  }

  // ── Producer 2: adapt existing window CustomEvents into the bus ────────────
  function adaptWindowEvents() {
    var map = {
      'treasurybridge:event': function (d) {
        var n = d && d.name;
        if (n === 'SettlementCompleted') return { event: 'SettlementCompleted', detail: d };
        if (n === 'SettlementFailed') return { event: 'Failed', detail: d };
        if (n === 'LowLiquidity') return { event: 'LowLiquidity', detail: d };
        return null;
      },
      'reimbursement:completed': function (d) { return { event: 'VaultReimbursed', detail: d }; },
      'ub:cctp:completed': function (d) { return { event: 'MintReceived', detail: d }; },
      'ub:bridge:completed': function (d) { return { event: 'Completed', detail: d }; },
      'treasury:completed': function (d) { return { event: 'Completed', detail: d }; }
    };
    Object.keys(map).forEach(function (evName) {
      try {
        window.addEventListener(evName, function (e) {
          try {
            var r = map[evName]((e && e.detail) || {});
            if (!r) return;
            var d = r.detail || {};
            emit(r.event, {
              intentId: d.intentId || d.id || null,
              asset: d.asset || null,
              amount: d.amount || null,
              stage: r.event,
              status: r.event,
              source: 'window:' + evName,
              application: 'EXECDAAT',
              worker: 'adapter',
              timestamp: Date.now()
            });
          } catch (_) {}
        });
      } catch (_) {}
    });
  }

  // ── Reactors (debounced, guarded, isolated) ────────────────────────────────
  function debounce(fn, ms) { var t = null; return function () { if (t) clearTimeout(t); t = setTimeout(function () { t = null; try { fn(); } catch (_) {} }, ms || DEBOUNCE_MS); }; }
  function isTabActive(id) { var el = document.getElementById(id); return el && !el.classList.contains('hidden'); }
  function callIf(name) { try { var f = window[name]; if (typeof f === 'function') f(); } catch (_) {} }

  var refreshReimbursements = debounce(function () { if (isTabActive('tab-content-reimbursements')) callIf('reimbursementsRefresh'); });
  var refreshTreasury = debounce(function () { if (isTabActive('tab-content-treasury')) callIf('treasuryRefresh'); });
  var refreshHistory = debounce(function () { if (isTabActive('tab-content-history')) { if (typeof window.historyRefresh === 'function') callIf('historyRefresh'); else callIf('historyInit'); } });
  var refreshUnified = debounce(function () { if (typeof window.ubRefresh === 'function') callIf('ubRefresh'); else if (isTabActive('tab-content-unifiedbalance')) callIf('ubInit'); });
  var pushToCore = debounce(function () { try { if (window.TreasurySync && window.TreasurySync.syncNow) window.TreasurySync.syncNow(); } catch (_) {} }, 900);

  function toast(msg, type) { try { if (typeof window.showToast === 'function') window.showToast(msg, type || 'info'); } catch (_) {} }
  var NOTIFY = {
    IntentCreated: ['Intent created', 'info'],
    BridgeStarted: ['Bridge started', 'info'],
    AttestationReceived: ['Circle attestation received', 'info'],
    SettlementStarted: ['Settlement started', 'info'],
    SettlementCompleted: ['Settlement completed', 'success'],
    VaultReimbursed: ['Vault reimbursed', 'success'],
    Completed: ['Bridge completed', 'success'],
    Failed: ['Bridge operation failed', 'error']
  };

  var _lastReactorRun = 0;
  var REACTOR_COOLDOWN_MS = 3000;  // Phase 8: prevent cascade refreshes from rapid events

  function wireReactors() {
    onAny(function (p) {
      var now = Date.now();
      if (now - _lastReactorRun < REACTOR_COOLDOWN_MS) return;  // Phase 8: skip if refreshed recently
      _lastReactorRun = now;
      pushToCore();
      refreshReimbursements();
      refreshTreasury();
      refreshHistory();
      var e = p && p.event;
      if (e === 'VaultReimbursed' || e === 'SettlementCompleted' || e === 'Completed' || e === 'MintReceived') refreshUnified();
      var n = NOTIFY[e];
      if (n) { var suffix = p && p.intentId ? ' · ' + String(p.intentId).slice(0, 10) : ''; toast(n[0] + suffix, n[1]); }
    });
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  var _timer = null;
  function start() {
    if (_timer) return;
    adaptWindowEvents();
    wireReactors();
    // initial pass shortly after load (bridge store ready), then poll
    setTimeout(pollLedger, 3500);
    _timer = setInterval(function () { if (!document.hidden) pollLedger(); }, POLL_MS);
    try { window.addEventListener('pagehide', function () { if (_timer) { clearInterval(_timer); _timer = null; } }); } catch (_) {}
  }

  window.TreasuryEventBus = {
    __ready: true,
    VERSION: VERSION,
    on: on,
    off: function (name, cb) { try { var h = _wrapped.get(cb); if (h && _target) _target.removeEventListener(name, h); } catch (_) {} },
    onAny: onAny,
    emit: emit,
    poll: pollLedger,
    setLogging: function (v) { LOG = !!v; },
    STAGE_EVENT: STAGE_EVENT,
    STAGE_ORDER: STAGE_ORDER
  };

  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(start, 1500);
  else document.addEventListener('DOMContentLoaded', function () { setTimeout(start, 1500); });

  try { console.log('%c[TBUS] Treasury Event Bus ready', 'color:#10b981;font-weight:bold', '| v' + VERSION + ' | additive · observe-only'); } catch (_) {}
})();
