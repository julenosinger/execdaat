// ============================================================
// ExecDaat — Unified Balance Cross-Chain Bridge (Asset Management)
// Adds an in-place "Bridge / Move" modal to the Unified Balance tab.
//
// 100% ADDITIVE + reuses existing infrastructure:
//   • window.ArcBridge      (Standard Bridge / Arc App Kit CCTP engine)
//   • window.TurboBridge     (Turbo Bridge + smart routing/fallback)
//   • window.ubRefresh       (Unified Balance refresh)
//   • Payments history store (arc_pay_history) — same schema as Smart Payments
//
// No new bridge logic, no new contracts. Turbo is used automatically for
// "other → Arc" (when available); the Standard Bridge is used otherwise,
// with automatic fallback — exactly like the Advanced Cross-Chain Center.
// build: 20260704a
// ============================================================
'use strict';

(function () {
  const ARC_KEY = 'arc';
  const S = {
    fromKey: null, sym: 'USDC', toKey: null,
    balance: null, quote: null, turbo: false, quoting: false, executing: false,
    _burnHash: null, _mintHash: null, _steps: [],
  };

  function log(...a) { console.log('%c[UB-BRIDGE]', 'color:#22d3ee', ...a); }
  function el(id) { return document.getElementById(id); }
  function chains() { return (window.ArcBridge && window.ArcBridge.CHAINS) || {}; }
  function chain(k) { return chains()[k] || null; }
  function fmt(n, d) { const v = Number(n); if (isNaN(v)) return '—'; return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: d || 4 }); }
  function shortAddr(a) { return a ? a.slice(0, 6) + '…' + a.slice(-4) : '—'; }
  function toast(m, t) { if (typeof window.ubShowToast === 'function') window.ubShowToast(m, t); else if (typeof window.showToast === 'function') window.showToast(m, t); }

  // Normalize a Unified-Balance network key to the ArcBridge engine key.
  function normKey(k) {
    if (!k) return null;
    const c = chains();
    if (c[k]) return k;
    const lk = String(k).toLowerCase();
    for (const key of Object.keys(c)) { if (key.toLowerCase() === lk) return key; }
    const al = { polygonamoy: 'polygonAmoy', polygon: 'polygonAmoy', matic: 'polygonAmoy', ethereum: 'sepolia', eth: 'sepolia', base: 'basesepolia', arbitrum: 'arbsepolia', arb: 'arbsepolia', optimism: 'optsepolia', op: 'optsepolia' };
    return (al[lk] && c[al[lk]]) ? al[lk] : null;
  }

  /* ═══════════════ MODAL (self-injected, matches UB dark design) ═══════════════ */
  function ensureModal() {
    if (el('ubx-modal')) return;
    const d = document.createElement('div');
    d.id = 'ubx-modal';
    d.className = 'hidden fixed inset-0 z-[120] flex items-center justify-center';
    d.style.cssText = 'background:rgba(0,0,0,0.65);backdrop-filter:blur(4px);';
    d.addEventListener('click', function (e) { if (e.target === d) ubxClose(); });
    d.innerHTML =
      '<div class="w-full max-w-md mx-4 rounded-2xl overflow-hidden shadow-2xl" style="background:linear-gradient(160deg,rgba(12,16,32,0.99),rgba(6,9,20,1));border:1px solid rgba(55,138,221,0.25);max-height:92vh;overflow-y:auto;">' +
      '  <div style="height:2px;background:linear-gradient(90deg,transparent,#22d3ee 40%,#a78bfa 60%,transparent);"></div>' +
      '  <div class="p-5">' +
      '    <div class="flex items-center justify-between mb-4">' +
      '      <div class="flex items-center gap-2"><i class="fas fa-right-left text-cyan-400"></i><h3 class="text-white font-bold text-base">Bridge / Move Assets</h3></div>' +
      '      <div class="flex items-center gap-2"><span id="ubx-badge" class="text-[10px] font-bold px-2 py-1 rounded-lg"></span><button onclick="ubxClose()" class="text-gray-500 hover:text-gray-300"><i class="fas fa-times"></i></button></div>' +
      '    </div>' +
      '    <div class="grid grid-cols-[1fr_auto_1fr] gap-2 items-end mb-3">' +
      '      <div><div class="text-[9px] uppercase tracking-wider text-gray-500 font-bold mb-1">From</div><div id="ubx-from" class="bg-gray-900/70 border border-gray-700/50 rounded-xl px-3 py-2.5 text-sm text-gray-200"></div></div>' +
      '      <div class="pb-2.5 text-gray-600"><i class="fas fa-arrow-right"></i></div>' +
      '      <div><div class="text-[9px] uppercase tracking-wider text-gray-500 font-bold mb-1">To Network</div>' +
      '        <select id="ubx-to" onchange="ubxOnToChange(this.value)" class="w-full bg-gray-900/70 border border-gray-700/50 rounded-xl px-3 py-2.5 text-sm text-gray-200 outline-none focus:border-cyan-500/50"></select></div>' +
      '    </div>' +
      '    <div class="mb-3">' +
      '      <div class="flex items-center justify-between mb-1"><div class="text-[9px] uppercase tracking-wider text-gray-500 font-bold">Amount</div><div id="ubx-balance" class="text-[10px] text-gray-500"></div></div>' +
      '      <div class="relative">' +
      '        <input id="ubx-amount" type="number" min="0" step="0.000001" placeholder="0.000000" oninput="ubxOnAmount()" class="w-full bg-gray-900/70 border border-gray-700/50 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-500/50 pr-16" />' +
      '        <button onclick="ubxSetMax()" class="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-bold text-cyan-400 bg-cyan-900/30 border border-cyan-700/40 rounded-lg px-2 py-1">MAX</button>' +
      '      </div>' +
      '    </div>' +
      '    <button id="ubx-quote-btn" onclick="ubxQuote()" class="w-full mb-3 py-2.5 rounded-xl text-sm font-bold bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700/50 transition"><i class="fas fa-route mr-1.5"></i>Find Best Route</button>' +
      '    <div id="ubx-preview" class="hidden mb-3 rounded-xl border border-gray-700/40 bg-gray-900/50 p-3 text-xs"></div>' +
      '    <div id="ubx-timeline" class="hidden mb-3 rounded-xl border border-cyan-700/25 bg-gray-900/50 p-3"></div>' +
      '    <div id="ubx-status" class="text-[11px] text-gray-400 mb-3 min-h-[16px]"></div>' +
      '    <button id="ubx-exec-btn" onclick="ubxExecute()" disabled class="w-full py-3 rounded-xl text-sm font-bold bg-gradient-to-r from-cyan-500 to-violet-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition"><i class="fas fa-bolt mr-1.5"></i>Bridge</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(d);
  }

  function setBadge() {
    const b = el('ubx-badge'); if (!b) return;
    const cross = S.fromKey !== S.toKey;
    if (!cross) { b.textContent = '🟢 Local'; b.style.cssText = 'background:rgba(52,211,153,0.14);color:#34d399;'; }
    else if (S.turbo) { b.textContent = '⚡ Turbo Bridge'; b.style.cssText = 'background:rgba(245,158,11,0.16);color:#f59e0b;'; }
    else { b.textContent = '🌉 Cross-Chain'; b.style.cssText = 'background:rgba(96,165,250,0.14);color:#60a5fa;'; }
  }

  /* ═══════════════ OPEN ═══════════════ */
  async function ubBridgeOpen(netKey, sym) {
    if (!window.walletState?.address) { toast('Connect wallet first', 'warning'); return; }
    if (!window.ArcBridge) { toast('Cross-chain engine unavailable', 'error'); return; }
    ensureModal();
    const fromKey = normKey(netKey) || ARC_KEY;
    S.fromKey = fromKey; S.sym = (sym || 'USDC').toUpperCase();
    S.quote = null; S.turbo = false; S.balance = null; S._burnHash = null; S._mintHash = null;

    const fc = chain(fromKey);
    el('ubx-from').innerHTML = (fc ? fc.icon + ' ' + fc.name : fromKey) + ' <span class="text-gray-500">· ' + S.sym + '</span>';

    // Destination options = all engine chains except origin.
    const toSel = el('ubx-to');
    const opts = Object.keys(chains()).filter(k => k !== fromKey);
    // Prefer Arc as default destination when bridging inbound; else first option.
    S.toKey = (fromKey !== ARC_KEY) ? ARC_KEY : (opts[0] || ARC_KEY);
    toSel.innerHTML = opts.map(k => { const c = chain(k); return '<option value="' + k + '"' + (k === S.toKey ? ' selected' : '') + '>' + c.icon + ' ' + c.name + '</option>'; }).join('');

    el('ubx-amount').value = '';
    el('ubx-balance').textContent = 'Balance: …';
    el('ubx-preview').classList.add('hidden');
    el('ubx-timeline').classList.add('hidden');
    el('ubx-status').textContent = '';
    el('ubx-exec-btn').disabled = true;
    el('ubx-exec-btn').innerHTML = '<i class="fas fa-bolt mr-1.5"></i>Bridge';
    setBadge();
    el('ubx-modal').classList.remove('hidden');

    // Load real balance from the shared engine (no ubState dependency).
    try {
      const bal = await window.ArcBridge.getBalance(fromKey, window.walletState.address);
      S.balance = (bal == null) ? null : bal;
      el('ubx-balance').textContent = 'Balance: ' + (S.balance == null ? '—' : fmt(S.balance, 6) + ' ' + S.sym);
    } catch (e) { el('ubx-balance').textContent = 'Balance: —'; }

    // Non-USDC assets can't use the CCTP cross-chain engine.
    if (S.sym !== 'USDC') {
      el('ubx-status').innerHTML = '<span style="color:#fbbf24;"><i class="fas fa-info-circle"></i> Cross-chain movement is available for USDC. ' + S.sym + ' can be swapped to USDC first.</span>';
      el('ubx-quote-btn').disabled = true;
    } else {
      el('ubx-quote-btn').disabled = false;
    }
  }

  function ubxClose() { const m = el('ubx-modal'); if (m) m.classList.add('hidden'); }
  function ubxOnToChange(v) { S.toKey = v; S.quote = null; el('ubx-preview').classList.add('hidden'); el('ubx-exec-btn').disabled = true; setBadge(); }
  function ubxOnAmount() { S.quote = null; el('ubx-preview').classList.add('hidden'); el('ubx-exec-btn').disabled = true; }
  function ubxSetMax() { if (S.balance && S.balance > 0) { el('ubx-amount').value = String(Math.floor(S.balance * 1e6) / 1e6); ubxOnAmount(); } }

  /* ═══════════════ QUOTE (reuses ArcBridge + Turbo decision) ═══════════════ */
  async function ubxQuote() {
    const amount = parseFloat(el('ubx-amount').value) || 0;
    if (S.sym !== 'USDC') { toast('Cross-chain supports USDC', 'warning'); return; }
    if (amount <= 0) { el('ubx-status').textContent = 'Enter an amount.'; return; }
    if (S.fromKey === S.toKey) { el('ubx-status').textContent = 'Choose a different destination network.'; return; }
    if (S.fromKey !== ARC_KEY && S.toKey === ARC_KEY) {
      el('ubx-status').innerHTML = '<span style="color:#f87171;">Bridging from other chains into Arc is temporarily unavailable — inbound liquidity is depleted. Please don\u2019t use this route right now; try again later.</span>';
      el('ubx-exec-btn').disabled = true;
      return;
    }
    if (S.balance != null && amount > S.balance) { el('ubx-status').innerHTML = '<span style="color:#f87171;">Insufficient balance.</span>'; return; }

    S.quoting = true;
    el('ubx-status').innerHTML = '<i class="fas fa-circle-notch fa-spin text-cyan-400"></i> Finding best route…';
    try {
      let turbo = false;
      if (window.TurboBridge && typeof window.TurboBridge.decide === 'function') {
        const d = await window.TurboBridge.decide(S.fromKey, S.toKey, amount);
        turbo = d && d.mode === 'turbo';
      }
      const q = await window.ArcBridge.getQuote({ from: S.fromKey, to: S.toKey, amount: amount, mode: 'fast' });
      S.quote = q; S.turbo = turbo;
      setBadge();
      renderPreview(q, turbo, amount);
      el('ubx-status').textContent = '';
      el('ubx-exec-btn').disabled = false;
    } catch (e) {
      el('ubx-status').innerHTML = '<span style="color:#f87171;">Route unavailable: ' + ((e && e.message) || 'error') + '</span>';
      el('ubx-exec-btn').disabled = true;
    } finally { S.quoting = false; }
  }

  function renderPreview(q, turbo, amount) {
    const p = el('ubx-preview'); if (!p) return;
    const fc = chain(S.fromKey), tc = chain(S.toKey);
    const recv = (q.output != null) ? q.output : amount;
    const bridgeName = turbo ? 'Turbo Bridge' : 'Standard Bridge';
    const row = (l, v, c) => '<div class="flex justify-between py-0.5"><span class="text-gray-500">' + l + '</span><span class="' + (c || 'text-gray-200') + '">' + v + '</span></div>';
    p.innerHTML =
      row('From', fc.icon + ' ' + fc.name) +
      row('To', tc.icon + ' ' + tc.name) +
      row('Token', S.sym + ' → ' + S.sym) +
      row('Amount', fmt(amount, 6) + ' ' + S.sym) +
      row('Estimated Receive', fmt(recv, 6) + ' ' + S.sym, 'text-green-400 font-bold') +
      row('Bridge', (turbo ? '⚡ ' : '') + bridgeName, turbo ? 'text-amber-400 font-bold' : 'text-blue-400 font-bold') +
      row('Provider', (q.provider && q.provider.name) || 'Circle CCTP V2') +
      row('Bridge Fee', '$' + fmt(q.bridgeFee || 0, 4)) +
      row('Protocol Fee', '$' + fmt(q.protocolFee || 0, 4)) +
      row('Gas (est.)', '$' + fmt(q.gasFeeEst || 0.02, 4)) +
      row('Estimated Time', q.estTime || '~1–2 min') +
      row('Slippage', (q.slippage || 0) + '%') +
      row('Route', q.routeType || 'Native Burn & Mint');
    p.classList.remove('hidden');
  }

  /* ═══════════════ TIMELINE ═══════════════ */
  function buildSteps(turbo) {
    const base = [
      { id: 'prepare', label: 'Preparing' },
      { id: 'route', label: 'Finding Route' },
      { id: 'quote', label: 'Quote Received' },
      { id: 'sign', label: 'Signing' },
      { id: 'bridge', label: 'Bridge Started' },
    ];
    if (turbo) base.push({ id: 'treasury', label: 'Treasury Processing' }, { id: 'vault', label: 'Vault Processing' });
    base.push(
      { id: 'srcconf', label: 'Source Confirmation' },
      { id: 'settle', label: 'Destination Settlement' },
      { id: 'balupd', label: 'Balance Update' },
      { id: 'done', label: 'Completed' }
    );
    return base.map((s, i) => ({ id: s.id, label: s.label, status: i === 0 ? 'active' : 'pending' }));
  }
  function tlInit(turbo) { S._steps = buildSteps(turbo); tlRender(); el('ubx-timeline').classList.remove('hidden'); }
  function tlSet(id, st) { const s = S._steps.find(x => x.id === id); if (s) s.status = st; }
  function tlDone(id) { tlSet(id, 'done'); }
  function tlActive(id) { const s = S._steps.find(x => x.id === id); if (s && s.status !== 'done') s.status = 'active'; }
  function tlFail() { const a = S._steps.find(x => x.status === 'active'); if (a) a.status = 'failed'; }
  function tlRender() {
    const el2 = el('ubx-timeline'); if (!el2) return;
    el2.innerHTML = '<div class="text-[9px] uppercase tracking-wider text-gray-500 font-bold mb-2">Transaction Timeline</div>' +
      S._steps.map(s => {
        let ic, c;
        if (s.status === 'done') { ic = 'fas fa-check-circle'; c = '#34d399'; }
        else if (s.status === 'active') { ic = 'fas fa-circle-notch fa-spin'; c = '#22d3ee'; }
        else if (s.status === 'failed') { ic = 'fas fa-times-circle'; c = '#f87171'; }
        else { ic = 'far fa-circle'; c = '#3a4870'; }
        return '<div class="flex items-center gap-2 py-1"><i class="' + ic + '" style="color:' + c + ';font-size:13px;width:15px;text-align:center;"></i><span style="color:' + (s.status === 'pending' ? '#4a6490' : '#dde2f0') + ';font-size:11px;">' + s.label + '</span></div>';
      }).join('');
  }
  function onEvent(stage, data) {
    data = data || {};
    switch (stage) {
      case 'mode_resolved': tlDone('prepare'); tlDone('route'); tlActive('quote'); break;
      case 'validating': tlActive('prepare'); break;
      case 'switching_source': tlDone('prepare'); tlDone('route'); tlDone('quote'); tlActive('sign'); break;
      case 'approving': tlActive('sign'); break;
      case 'approved': tlDone('sign'); tlActive('bridge'); break;
      case 'burning': tlActive('bridge'); break;
      case 'burn_sent': tlActive('bridge'); S._burnHash = data.txHash; break;
      case 'burn_confirmed': tlDone('sign'); tlDone('bridge'); tlActive(S.turbo ? 'treasury' : 'srcconf'); S._burnHash = data.txHash || S._burnHash; break;
      case 'attesting': if (S.turbo) { tlDone('treasury'); tlActive('vault'); } else { tlDone('srcconf'); tlActive('settle'); } break;
      case 'attested': if (S.turbo) { tlDone('vault'); } tlActive('settle'); break;
      case 'switching_dest': tlActive('settle'); break;
      case 'minting': tlDone('settle'); tlActive('balupd'); break;
      case 'mint_sent': tlActive('balupd'); S._mintHash = data.txHash; break;
      case 'mint_confirmed': tlDone('balupd'); tlActive('done'); S._mintHash = data.txHash || S._mintHash; break;
      case 'turbo_progress': tlDone('quote'); tlDone('sign'); tlActive('treasury'); break;
      case 'completed': S._steps.forEach(s => s.status = 'done'); break;
      case 'failed': tlFail(); break;
    }
    tlRender();
  }

  /* ═══════════════ EXECUTE (via shared TurboBridge.smartExecute) ═══════════════ */
  async function ubxExecute() {
    if (S.executing) return;
    const amount = parseFloat(el('ubx-amount').value) || 0;
    const addr = window.walletState?.address;
    if (!addr) { toast('Connect wallet', 'warning'); return; }
    if (S.sym !== 'USDC') { toast('Cross-chain supports USDC', 'warning'); return; }
    if (amount <= 0) { el('ubx-status').textContent = 'Enter an amount.'; return; }
    if (S.fromKey === S.toKey) { el('ubx-status').textContent = 'Choose a different destination.'; return; }
    if (!S.quote) { await ubxQuote(); if (!S.quote) return; }
    if (S.balance != null && amount > S.balance) { el('ubx-status').innerHTML = '<span style="color:#f87171;">Insufficient balance.</span>'; return; }

    S.executing = true; S._burnHash = null; S._mintHash = null;
    el('ubx-exec-btn').disabled = true;
    el('ubx-exec-btn').innerHTML = '<i class="fas fa-spinner fa-spin mr-1.5"></i>Bridging…';
    el('ubx-quote-btn').disabled = true;
    tlInit(S.turbo);
    el('ubx-status').textContent = '';
    const startTs = Date.now();

    try {
      const smart = (window.TurboBridge && window.TurboBridge.smartExecute)
        ? window.TurboBridge.smartExecute
        : function (o) { return window.ArcBridge.execute(o); };
      const result = await smart({ from: S.fromKey, to: S.toKey, amount: amount, recipient: addr, mode: 'fast', onEvent: onEvent });

      S._steps.forEach(s => s.status = 'done'); tlRender();
      const burnHash = result.burnTxHash || result.txHash || S._burnHash || null;
      const mintHash = result.mintTxHash || S._mintHash || null;
      const turbo = result.mode === 'turbo';

      recordHistory({ addr, amount, burnHash, mintHash, turbo, durationMs: Date.now() - startTs });

      // Refresh consolidated views without manual reload.
      if (typeof window.ubRefresh === 'function') setTimeout(window.ubRefresh, 2500);
      if (typeof window.renderPaymentHistory === 'function') window.renderPaymentHistory();
      if (typeof window.ubAddPaymentToHistory === 'function') { try { window.ubAddPaymentToHistory(amount, S.sym, addr, mintHash || burnHash, 'bridge_completed'); } catch (e) {} }
      if (typeof window.ubDispatchEvent === 'function') { try { window.ubDispatchEvent('bridge:completed', { from: S.fromKey, to: S.toKey, amount: amount, burnHash: burnHash, mintHash: mintHash, turbo: turbo }); } catch (e) {} }

      const tc = chain(S.toKey);
      el('ubx-status').innerHTML = '<span style="color:#34d399;">✅ Bridged to ' + (tc ? tc.short : S.toKey) + (turbo ? ' ⚡' : '') + '! ' + (mintHash && tc ? '<a href="' + tc.explorer + '/tx/' + mintHash + '" target="_blank" class="underline">View</a>' : '') + '</span>';
      toast('Bridge completed' + (turbo ? ' ⚡' : ''), 'success');
      setTimeout(function () { ubxClose(); }, 4000);
    } catch (err) {
      tlFail(); tlRender();
      el('ubx-status').innerHTML = '<span style="color:#f87171;">❌ ' + ((err && err.message) ? err.message.slice(0, 90) : 'Bridge failed') + '</span>';
      toast('Bridge failed: ' + ((err && err.message) || 'error').slice(0, 60), 'error');
      el('ubx-exec-btn').disabled = false;
      el('ubx-exec-btn').innerHTML = '<i class="fas fa-redo mr-1.5"></i>Retry';
    } finally {
      S.executing = false;
      el('ubx-quote-btn').disabled = (S.sym !== 'USDC');
    }
  }

  /* ── History (same schema as Smart Payments → shows in Payments history) ── */
  function recordHistory({ addr, amount, burnHash, mintHash, turbo, durationMs }) {
    try {
      const sc = chain(S.fromKey), dc = chain(S.toKey);
      const srcExplorer = (sc && sc.explorer) || 'https://testnet.arcscan.app';
      const destExplorer = (dc && dc.explorer) || '';
      const entry = {
        id: 'ubx_' + Date.now(),
        txHash: burnHash, sender: addr, from: addr, recipient: addr, to: addr, finalRecipient: addr,
        amount: amount, token: S.sym, sentAmount: amount, receivedAmount: amount, sentToken: S.sym, receivedToken: S.sym,
        status: 'completed', timestamp: new Date().toISOString(), createdAt: new Date().toISOString(),
        crossChain: true, type: 'cross-chain-move',
        bridgeType: turbo ? 'Turbo' : 'Standard', bridgeUsed: turbo ? 'Turbo Bridge' : 'Standard Bridge',
        fromNetwork: (sc && sc.name) || S.fromKey, toNetwork: (dc && dc.name) || S.toKey,
        fromChainKey: S.fromKey, toChainKey: S.toKey,
        bridgeTxHash: burnHash, burnTxHash: burnHash, destinationTxHash: mintHash, mintTxHash: mintHash, finalTxHash: mintHash,
        srcExplorer: srcExplorer, destExplorer: destExplorer,
        explorerUrl: burnHash ? (srcExplorer + '/tx/' + burnHash) : '',
        destExplorerUrl: (mintHash && destExplorer) ? (destExplorer + '/tx/' + mintHash) : '',
        provider: turbo ? 'Turbo Bridge' : 'Circle CCTP V2', durationMs: durationMs,
      };
      const walletKey = 'arc_pay_history_' + addr.toLowerCase();
      const ws = JSON.parse(localStorage.getItem(walletKey) || '[]'); ws.unshift(entry);
      localStorage.setItem(walletKey, JSON.stringify(ws.slice(0, 50)));
      const g = JSON.parse(localStorage.getItem('arc_pay_history') || '[]'); g.unshift(entry);
      localStorage.setItem('arc_pay_history', JSON.stringify(g.slice(0, 50)));
      S._lastMove = entry;
    } catch (e) { log('history record failed', e && e.message); }
  }

  /* ═══════════════ AI AGENT / PROGRAMMATIC API ═══════════════ */
  window.UBBridge = {
    VERSION: '20260704a',
    open: ubBridgeOpen,
    // move({ from, to, network, token, amount }) — for the Autonomous Agent.
    // "network" is the DESTINATION; "from" optional (defaults Arc).
    move: async function (opts) {
      opts = opts || {};
      const fromKey = normKey(opts.from) || ARC_KEY;
      const toKey = normKey(opts.to || opts.network || opts.destination);
      if (!toKey) throw new Error('Unsupported destination network: ' + (opts.to || opts.network));
      await ubBridgeOpen(fromKey, (opts.token || 'USDC').toUpperCase());
      const sel = el('ubx-to'); if (sel) sel.value = toKey; S.toKey = toKey; setBadge();
      if (opts.amount != null) { el('ubx-amount').value = String(opts.amount); }
      await ubxQuote();
      return ubxExecute();
    },
    getLastMove: function () { return S._lastMove || null; },
  };

  // Expose modal handlers + re-wire the existing Unified Balance Bridge actions.
  window.ubBridgeOpen = ubBridgeOpen;
  window.ubxClose = ubxClose;
  window.ubxOnToChange = ubxOnToChange;
  window.ubxOnAmount = ubxOnAmount;
  window.ubxSetMax = ubxSetMax;
  window.ubxQuote = ubxQuote;
  window.ubxExecute = ubxExecute;

  function _rewire() {
    // Row/quick-action "Bridge" and the asset-detail "Bridge" now open the modal.
    window.ubActionBridge = function (nk, sym) { return ubBridgeOpen(nk || ARC_KEY, sym || 'USDC'); };
    // "Move" (Quick Actions + CCTP move) now uses the SAME shared cross-chain engine.
    window.ubActionCCTPMove = function (nk, sym) { return ubBridgeOpen(nk || ARC_KEY, sym || 'USDC'); };
    const origDetailBridge = window.ubDetailBridge;
    window.ubDetailBridge = function () {
      try { if (typeof window.ubCloseDetail === 'function') window.ubCloseDetail(); } catch (e) {}
      // Read the currently-open detail asset if available via the detail modal fields.
      let nk = null, sym = null;
      const symEl = document.getElementById('ub-detail-symbol');
      const netEl = document.getElementById('ub-detail-network');
      if (symEl) sym = (symEl.textContent || '').trim();
      if (netEl) { const t = (netEl.textContent || '').toLowerCase(); if (t.includes('arc')) nk = 'arc'; else if (t.includes('base')) nk = 'basesepolia'; else if (t.includes('arbitrum')) nk = 'arbsepolia'; else if (t.includes('optimism') || t.includes('op ')) nk = 'optsepolia'; else if (t.includes('polygon')) nk = 'polygonAmoy'; else if (t.includes('ethereum') || t.includes('sepolia')) nk = 'sepolia'; }
      return ubBridgeOpen(nk || 'arc', sym || 'USDC');
    };
    void origDetailBridge;
  }

  let _t = 0;
  const _iv = setInterval(function () { _t++; if (window.ArcBridge) { _rewire(); clearInterval(_iv); } else if (_t > 60) clearInterval(_iv); }, 200);
  document.addEventListener('DOMContentLoaded', function () { if (window.ArcBridge) _rewire(); });
  window.addEventListener('load', function () { if (window.ArcBridge) _rewire(); });

  log('Unified Balance Cross-Chain Bridge ready — reuses ArcBridge/TurboBridge, Turbo auto for →Arc');
})();
