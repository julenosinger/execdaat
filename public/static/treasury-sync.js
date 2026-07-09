// ============================================================
// TREASURY SYNC — ExecDaat (additive, non-breaking)
// ------------------------------------------------------------
// Mirrors the local Turbo Bridge intents (window.RepaymentContract)
// into the NATIVE ExecDaat Treasury Core ledger (/api/core/v1/intents)
// so the server-side ledger, metrics, history and reimbursements
// reflect real bridge activity — with ZERO changes to the bridge flow.
//
// Read-only w.r.t. the bridge: it never mutates bridge state, never
// signs, never moves funds. Fire-and-forget upserts; failures are
// swallowed. Nothing here can block or alter a bridge operation.
// build: 20260709c1
// ============================================================
'use strict';

(function () {
  var BASE = '/api/core/v1';
  var SYNC_MS = 15000;
  var _sig = {};            // intentId -> last synced signature (dedupe)
  var _timer = null;

  function _log() { try { var a = Array.prototype.slice.call(arguments); a.unshift('%c[TREASURY-SYNC]', 'color:#10b981'); console.log.apply(console, a); } catch (e) {} }
  function pick(o) { for (var i = 1; i < arguments.length; i++) { var k = arguments[i]; if (o && o[k] != null && o[k] !== '') return o[k]; } return undefined; }

  function toBody(it) {
    if (!it || typeof it !== 'object') return null;
    var id = pick(it, 'intentId', 'id', 'intentBytes32');
    if (!id) return null;
    return {
      intentId: String(id),
      intentBytes32: pick(it, 'intentBytes32'),
      application: 'EXECDAAT',
      client: 'EXECDAAT-PROD',
      environment: 'LOCAL',
      wallet: pick(it, 'userAddress', 'sender', 'wallet', 'account'),
      recipient: pick(it, 'recipient', 'receiver', 'userAddress'),
      asset: String(pick(it, 'asset', 'token', 'symbol') || 'USDC').toUpperCase(),
      amount: pick(it, 'grossAmount', 'amount', 'value'),
      sourceChain: pick(it, 'srcChain', 'sourceChain', 'origin'),
      destinationChain: pick(it, 'dstChain', 'destinationChain') || 'arc',
      bridge: pick(it, 'bridge') || 'Turbo',
      memo: pick(it, 'memo'),
      nonce: pick(it, 'nonce', 'cctpNonce'),
      status: pick(it, 'status'),
      sourceTxHash: pick(it, 'txHash', 'burnTxHash', 'depositTxHash', 'sourceTxHash'),
      attestation: pick(it, 'attestation', 'attestationHash'),
      circleMintTxHash: pick(it, 'mintTxHash', 'circleMintTxHash'),
      fulfillTxHash: pick(it, 'fulfillTxHash', 'arcTxHash'),
      settlementTxHash: pick(it, 'settlementTxHash', 'settleTx'),
      vaultCreditTxHash: pick(it, 'vaultCreditTxHash', 'reimbursementTxHash')
    };
  }

  function sig(b) {
    return [b.status, b.sourceTxHash, b.attestation, b.circleMintTxHash, b.fulfillTxHash, b.settlementTxHash, b.vaultCreditTxHash].join('|');
  }

  function upsert(b) {
    try {
      fetch(BASE + '/intents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(b),
        keepalive: true
      }).catch(function () {});
    } catch (e) {}
  }

  function syncOnce() {
    try {
      var rc = window.RepaymentContract;
      if (!rc || typeof rc.getAll !== 'function') return;
      var all = rc.getAll() || [];
      var n = 0;
      for (var i = 0; i < all.length; i++) {
        var b = toBody(all[i]);
        if (!b) continue;
        var s = sig(b);
        if (_sig[b.intentId] === s) continue;   // unchanged → skip (no duplicate requests)
        _sig[b.intentId] = s;
        upsert(b);
        n++;
      }
      if (n) _log('mirrored ' + n + ' intent(s) to native core');
    } catch (e) { /* never throw */ }
  }

  function start() {
    if (_timer) return;
    // small initial delay so the bridge store is ready
    setTimeout(syncOnce, 4000);
    _timer = setInterval(syncOnce, SYNC_MS);
    // opportunistic sync on known bridge lifecycle events
    ['ub:bridge:completed', 'ub:cctp:completed', 'treasury:completed', 'treasurybridge:event', 'reimbursement:completed'].forEach(function (ev) {
      try { window.addEventListener(ev, function () { setTimeout(syncOnce, 800); }); } catch (e) {}
    });
    _log('ready · mirroring local bridge → native Treasury Core');
  }

  window.TreasurySync = { syncNow: syncOnce };

  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(start, 1200);
  else document.addEventListener('DOMContentLoaded', function () { setTimeout(start, 1200); });
})();
