// ============================================================
// ExecDaat — Smart Cross-Chain Payments
// Turns the Payments tab into a Smart Cross-Chain Payments Center.
//
//   • Arc → Arc  : 100% the existing local payment flow (untouched).
//   • Arc → *    : automatically routes through the existing Cross-Chain
//                  engine (window.TurboBridge.smartExecute → ArcBridge /
//                  Turbo Bridge) with automatic fallback.
//
// This module is fully ADDITIVE. It never replaces the local payment engine;
// it wraps the public payment hooks (updatePayPreview / payValidateForm /
// executePayment) and only changes behaviour when a non-Arc destination is
// selected. Local Arc→Arc payments always delegate 1:1 to the originals.
// build: 20260704a
// ============================================================
'use strict';

(function () {
  const ARC_KEY = 'arc';

  const spState = {
    toNetwork: ARC_KEY,     // destination network key (arc = local)
    quote:     null,
    quoting:   false,
    executing: false,
    _quoteTimer: null,
    _wrapped:  false,
    _inited:   false,
  };

  function _log(...a)  { console.log('%c[SMART-PAY]', 'color:#22d3ee', ...a); }
  function _warn(...a) { console.warn('%c[SMART-PAY]', 'color:#22d3ee', ...a); }

  function _el(id) { return document.getElementById(id); }
  function _chains() { return (window.ArcBridge && window.ArcBridge.CHAINS) || {}; }
  function _chain(k) { return _chains()[k] || null; }
  function _isCrossChain() { return spState.toNetwork && spState.toNetwork !== ARC_KEY; }
  function _fmt(n, d) { const v = Number(n); if (isNaN(v)) return '—'; return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: d || 4 }); }
  function _short(a) { return a ? a.slice(0, 6) + '…' + a.slice(-4) : '—'; }
  function _isAddr(a) { return typeof a === 'string' && /^0x[a-fA-F0-9]{40}$/.test(a); }
  // Active token is defined exclusively by the top USDC/EURC selector.
  function _token() { return (window.payState && window.payState.token) || 'USDC'; }

  /* ── Populate the TO NETWORK selector from the Cross-Chain engine ── */
  function _populateNetworks() {
    const sel = _el('pay-to-network');
    if (!sel) return;
    const chains = _chains();
    if (!Object.keys(chains).length) return; // engine not ready yet
    const order = [ARC_KEY].concat(Object.keys(chains).filter(k => k !== ARC_KEY));
    sel.innerHTML = order.map(k => {
      const c = chains[k];
      if (!c) return '';
      const label = (k === ARC_KEY) ? (c.icon + ' ' + c.name + ' (Local)') : (c.icon + ' ' + c.name);
      return `<option value="${k}"${k === spState.toNetwork ? ' selected' : ''}>${label}</option>`;
    }).join('');
  }

  /* ── Badge (🟢 Local · 🌉 Cross-Chain · ⚡ Turbo) ── */
  function _renderBadge(turbo) {
    const b = _el('pay-route-badge');
    if (!b) return;
    if (!_isCrossChain()) {
      b.innerHTML = '🟢 Local Payment';
      b.style.cssText = 'font-size:10px;font-weight:700;padding:2px 9px;border-radius:999px;background:rgba(52,211,153,0.12);color:#34d399;border:1px solid rgba(52,211,153,0.3);';
    } else if (turbo) {
      b.innerHTML = '⚡ Turbo Bridge';
      b.style.cssText = 'font-size:10px;font-weight:700;padding:2px 9px;border-radius:999px;background:rgba(245,158,11,0.14);color:#f59e0b;border:1px solid rgba(245,158,11,0.35);';
    } else {
      b.innerHTML = '🌉 Cross-Chain Payment';
      b.style.cssText = 'font-size:10px;font-weight:700;padding:2px 9px;border-radius:999px;background:rgba(96,165,250,0.12);color:#60a5fa;border:1px solid rgba(96,165,250,0.3);';
    }
  }

  function _toggleCrossChainUI(on) {
    const panel = _el('pay-xchain-panel');
    if (panel) panel.style.display = on ? '' : 'none';
    document.querySelectorAll('.pay-xc-row').forEach(r => { r.style.display = on ? '' : 'none'; });
    // Network row in the Payment Summary reflects the destination
    const netRow = _el('pay-info-network');
    if (netRow) netRow.textContent = on ? (_chain(spState.toNetwork)?.name || spState.toNetwork) : 'Arc Testnet';
  }

  /* ═══════════════ QUOTE (reuses ArcBridge / Turbo engine) ═══════════════ */
  function _scheduleQuote() {
    clearTimeout(spState._quoteTimer);
    spState._quoteTimer = setTimeout(_refreshQuote, 500);
  }

  async function _refreshQuote() {
    if (!_isCrossChain()) return;
    const amountStr = (_el('pay-amount')?.value || '').trim();
    const amount = parseFloat(amountStr) || 0;
    const box = _el('pay-xchain-quote');
    const token = _token();
    // Cross-Chain settlement runs on Circle CCTP (USDC-native).
    if (token !== 'USDC') {
      if (box) box.innerHTML = '<span style="color:#fbbf24;"><i class="fas fa-info-circle"></i> Cross-chain settlement is available for USDC. Switch the token to USDC above to bridge to another network.</span>';
      _clearQuoteSummary();
      spState.quote = null;
      return;
    }
    if (amount <= 0) { if (box) box.innerHTML = '<span style="color:#6b7280;">Enter an amount to preview the cross-chain route.</span>'; _clearQuoteSummary(); return; }
    if (!window.ArcBridge) { if (box) box.innerHTML = '<span style="color:#f87171;">Cross-Chain engine unavailable.</span>'; return; }

    spState.quoting = true;
    if (box) box.innerHTML = '<i class="fas fa-circle-notch fa-spin" style="color:#60a5fa;"></i> Finding best route…';
    try {
      // Decide Turbo vs Standard through the shared decision engine.
      let turbo = false;
      if (window.TurboBridge && typeof window.TurboBridge.decide === 'function') {
        const d = await window.TurboBridge.decide(ARC_KEY, spState.toNetwork, amount);
        turbo = d && d.mode === 'turbo';
      }
      const raw = await window.ArcBridge.getQuote({ from: ARC_KEY, to: spState.toNetwork, amount: amount, mode: 'fast' });
      spState.quote = { raw, turbo, amount };
      _renderBadge(turbo);
      _renderQuote(raw, turbo);
    } catch (e) {
      _warn('quote error:', e && e.message);
      if (box) box.innerHTML = '<span style="color:#f87171;">Route unavailable: ' + ((e && e.message) || 'error') + '</span>';
      spState.quote = null;
    } finally {
      spState.quoting = false;
    }
  }

  function _renderQuote(q, turbo) {
    const box = _el('pay-xchain-quote');
    const provider = (q.provider && q.provider.name) || 'Circle CCTP V2';
    const bridgeName = turbo ? 'Turbo Bridge' : 'Standard Bridge';
    const recv = (q.output != null) ? q.output : q.input;
    const tk = _token();
    if (box) {
      box.innerHTML =
        '<div style="display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;">' +
        '<span style="color:#8aaac8;">Route</span> <span style="color:#dde2f0;font-weight:600;">' + (_chain(ARC_KEY)?.short || 'Arc') + ' → ' + (_chain(spState.toNetwork)?.short || spState.toNetwork) + '</span>' +
        '<span style="color:#8aaac8;">Mode</span> <span style="color:' + (turbo ? '#f59e0b' : '#60a5fa') + ';font-weight:700;">' + (turbo ? '⚡ ' : '') + bridgeName + '</span>' +
        '<span style="color:#8aaac8;">Est. Receive</span> <span style="color:#34d399;font-weight:700;">' + _fmt(recv, 6) + ' ' + tk + '</span>' +
        '<span style="color:#8aaac8;">Time</span> <span style="color:#dde2f0;">' + (q.estTime || '~1–2 min') + '</span>' +
        '</div>';
    }
    // Summary rows (right column)
    _set('pay-xc-from', 'Arc Testnet');
    _set('pay-xc-to', _chain(spState.toNetwork)?.name || spState.toNetwork);
    _set('pay-xc-bridge', (turbo ? '⚡ ' : '') + bridgeName);
    _set('pay-xc-receive', _fmt(recv, 6) + ' ' + tk);
    _set('pay-xc-fee', '$' + _fmt(q.bridgeFee || 0, 4));
    _set('pay-xc-time', q.estTime || '~1–2 min');
    _set('pay-xc-provider', provider);
  }

  function _clearQuoteSummary() {
    ['pay-xc-to','pay-xc-bridge','pay-xc-receive','pay-xc-fee','pay-xc-time','pay-xc-provider'].forEach(id => _set(id, '—'));
  }

  function _set(id, v) { const e = _el(id); if (e) e.textContent = v; }

  /* ═══════════════ EVENT HANDLERS (bound from HTML) ═══════════════ */
  window.smartPayOnNetworkChange = function (val) {
    spState.toNetwork = val;
    const cross = _isCrossChain();
    _toggleCrossChainUI(cross);
    _renderBadge(false);
    if (cross) _scheduleQuote(); else { spState.quote = null; _clearQuoteSummary(); }
    if (typeof window.updatePayPreview === 'function') window.updatePayPreview();
    if (typeof window.payValidateForm === 'function') window.payValidateForm();
  };

  /* ═══════════════ WRAPPERS (additive) ═══════════════ */
  function _afterPreview() {
    if (_isCrossChain()) { _toggleCrossChainUI(true); _scheduleQuote(); }
    else { _toggleCrossChainUI(false); _renderBadge(false); }
  }

  function _afterValidate() {
    if (!_isCrossChain()) return;
    const btn = _el('pay-send-btn');
    const btnText = _el('pay-send-btn-text');
    if (!btn) return;
    // Keep the original disabled logic (balance/recipient/amount are identical
    // for the burn on Arc). Only relabel the button for cross-chain intent.
    if (!btn.disabled && btnText) {
      const netShort = _chain(spState.toNetwork)?.short || spState.toNetwork;
      btnText.textContent = (spState.quote && spState.quote.turbo ? '⚡ ' : '🌉 ') + 'Bridge & Send to ' + netShort;
      const ic = btn.querySelector('i');
      if (ic) ic.className = 'fas fa-satellite-dish';
    }
  }

  /* ═══════════════ CROSS-CHAIN TIMELINE ═══════════════ */
  const XC_STEPS = [
    { id: 'prepare',  label: 'Preparing' },
    { id: 'route',    label: 'Finding Best Route' },
    { id: 'quote',    label: 'Quote Received' },
    { id: 'sign',     label: 'Signing' },
    { id: 'bridge',   label: 'Bridge Started' },
    { id: 'treasury', label: 'Treasury Processing' },
    { id: 'vault',    label: 'Vault Processing' },
    { id: 'settle',   label: 'Destination Settlement' },
    { id: 'sending',  label: 'Payment Sending' },
    { id: 'confirm',  label: 'Recipient Confirmation' },
    { id: 'done',     label: 'Completed' },
  ];
  let _xcSteps = [];

  function _xcInit() {
    _xcSteps = XC_STEPS.map((s, i) => ({ id: s.id, label: s.label, status: i === 0 ? 'active' : 'pending' }));
    _xcRender();
    const panel = _el('pay-xchain-timeline');
    if (panel) panel.style.display = '';
  }
  function _xcSet(id, status) { const s = _xcSteps.find(x => x.id === id); if (s) s.status = status; }
  function _xcDone(id) { _xcSet(id, 'done'); }
  function _xcActive(id) { const s = _xcSteps.find(x => x.id === id); if (s && s.status !== 'done') s.status = 'active'; }
  function _xcFailCurrent() { const a = _xcSteps.find(x => x.status === 'active'); if (a) a.status = 'failed'; }
  function _xcRender() {
    const el = _el('pay-xchain-timeline');
    if (!el) return;
    el.innerHTML =
      '<p style="font-size:10px;color:#8aaac8;text-transform:uppercase;letter-spacing:0.1em;font-weight:700;margin:0 0 10px;">CROSS-CHAIN PIPELINE</p>' +
      _xcSteps.map(s => {
        let icon, color;
        if (s.status === 'done') { icon = 'fas fa-check-circle'; color = '#34d399'; }
        else if (s.status === 'active') { icon = 'fas fa-circle-notch fa-spin'; color = '#60a5fa'; }
        else if (s.status === 'failed') { icon = 'fas fa-times-circle'; color = '#f87171'; }
        else { icon = 'far fa-circle'; color = '#3a4870'; }
        return '<div style="display:flex;align-items:center;gap:9px;padding:5px 0;">' +
          '<i class="' + icon + '" style="color:' + color + ';font-size:14px;width:16px;text-align:center;"></i>' +
          '<span style="color:' + (s.status === 'pending' ? '#4a6490' : '#dde2f0') + ';font-size:12px;">' + s.label + '</span>' +
          '</div>';
      }).join('');
  }

  /* ── Map engine events → cross-chain timeline ── */
  function _onEngineEvent(stage, data) {
    data = data || {};
    switch (stage) {
      case 'mode_resolved': _xcDone('prepare'); _xcDone('route'); _xcActive('quote'); break;
      case 'validating':    _xcActive('prepare'); break;
      case 'switching_source': _xcDone('prepare'); _xcDone('route'); _xcDone('quote'); _xcActive('sign'); break;
      case 'approving':     _xcActive('sign'); break;
      case 'approved':      _xcDone('sign'); _xcActive('bridge'); break;
      case 'burning':       _xcActive('bridge'); break;
      case 'burn_sent':     _xcActive('bridge'); spState._burnHash = data.txHash; break;
      case 'burn_confirmed': _xcDone('sign'); _xcDone('bridge'); _xcActive('treasury'); spState._burnHash = data.txHash || spState._burnHash; break;
      case 'attesting':     _xcDone('treasury'); _xcActive('vault'); break;
      case 'attested':      _xcDone('vault'); _xcActive('settle'); break;
      case 'switching_dest': _xcActive('settle'); break;
      case 'minting':       _xcDone('settle'); _xcActive('sending'); break;
      case 'mint_sent':     _xcActive('sending'); spState._mintHash = data.txHash; break;
      case 'mint_confirmed': _xcDone('sending'); _xcActive('confirm'); spState._mintHash = data.txHash || spState._mintHash; break;
      case 'turbo_progress': _xcDone('quote'); _xcDone('sign'); _xcActive('treasury'); break;
      case 'completed':     ['prepare','route','quote','sign','bridge','treasury','vault','settle','sending','confirm','done'].forEach(_xcDone); break;
      case 'failed':        _xcFailCurrent(); break;
    }
    _xcRender();
  }

  /* ═══════════════ CROSS-CHAIN EXECUTION ═══════════════ */
  async function _executeCrossChain() {
    if (spState.executing) return;
    const ws = window.walletState;
    const recipient = (_el('pay-recipient')?.value || '').trim();
    const amountStr = (_el('pay-amount')?.value || '').trim();
    const amount = parseFloat(amountStr) || 0;
    const toKey = spState.toNetwork;
    const showErr = window.showPayError || function (m) { alert(m); };

    // ── Validations (never trust the frontend alone; engine re-validates too) ──
    if (!ws?.address || !ws?.provider) { showErr('Please connect your wallet first.'); return; }
    if (!_isAddr(recipient)) { showErr('Invalid recipient wallet address.'); return; }
    if (amount <= 0) { showErr('Enter a valid amount greater than 0.'); return; }
    if (window.payState && window.payState.token && window.payState.token !== 'USDC') {
      showErr('Cross-chain payments support USDC only. Switch the token to USDC.'); return;
    }
    if (!window.ArcBridge) { showErr('Cross-Chain engine unavailable. Reload the page.'); return; }

    spState.executing = true;
    spState._burnHash = null; spState._mintHash = null;
    if (window.payState) window.payState.pending = true;
    if (typeof window.hidePayError === 'function') window.hidePayError();
    if (typeof window.payValidateForm === 'function') window.payValidateForm();
    _xcInit();

    const startTs = Date.now();
    try {
      const smart = (window.TurboBridge && window.TurboBridge.smartExecute)
        ? window.TurboBridge.smartExecute
        : function (o) { return window.ArcBridge.execute(o); };

      const result = await smart({
        from: ARC_KEY, to: toKey, amount: amount, recipient: recipient, mode: 'fast',
        onEvent: _onEngineEvent,
      });

      ['prepare','route','quote','sign','bridge','treasury','vault','settle','sending','confirm','done'].forEach(_xcDone);
      _xcRender();

      const burnHash = result.burnTxHash || result.txHash || spState._burnHash || null;
      const mintHash = result.mintTxHash || spState._mintHash || null;
      const turbo = result.mode === 'turbo';
      const durationMs = Date.now() - startTs;

      _recordHistory({ recipient, amount, toKey, burnHash, mintHash, turbo, durationMs });

      // Refresh balances / unified balance / analytics without page reload
      if (typeof window.refreshPaymentBalances === 'function') setTimeout(window.refreshPaymentBalances, 2500);
      if (typeof window.ubRefresh === 'function') setTimeout(window.ubRefresh, 3000);
      if (typeof window.renderPaymentHistory === 'function') window.renderPaymentHistory();

      const showToast = window.showToast || function () {};
      showToast('✅ Cross-chain payment sent to ' + (_chain(toKey)?.short || toKey) + (turbo ? ' ⚡' : '') + '!', 'success');

      // Clear amount + recipient (keep the rest of the form intact)
      const amtEl = _el('pay-amount'); if (amtEl) amtEl.value = '';
      const rcpEl = _el('pay-recipient'); if (rcpEl) rcpEl.value = '';
      spState.quote = null; _clearQuoteSummary();
      setTimeout(() => { const p = _el('pay-xchain-timeline'); if (p) p.style.display = 'none'; }, 4000);

    } catch (err) {
      _warn('cross-chain execute failed:', err && err.message);
      _xcFailCurrent(); _xcRender();
      showErr((err && err.message) || 'Cross-chain payment failed. Your funds were not sent.');
      const showToast = window.showToast || function () {};
      showToast('❌ ' + ((err && err.message) ? err.message.slice(0, 80) : 'Cross-chain payment failed'), 'error');
      // Form state preserved (no reset) so the user can retry.
    } finally {
      spState.executing = false;
      if (window.payState) window.payState.pending = false;
      if (typeof window.payValidateForm === 'function') window.payValidateForm();
    }
  }

  function _recordHistory({ recipient, amount, toKey, burnHash, mintHash, turbo, durationMs }) {
    try {
      const from = window.walletState?.address || '';
      const tk = _token();
      const srcChain = _chain(ARC_KEY);
      const dstChain = _chain(toKey);
      const srcExplorer = (srcChain && srcChain.explorer) || 'https://testnet.arcscan.app';
      const destExplorer = (dstChain && dstChain.explorer) || '';
      const entry = {
        id: 'xpay_' + Date.now(),
        txHash: burnHash,                 // source (Arc) tx → arcscan link works
        sender: from, from: from,
        recipient: recipient, to: recipient,
        finalRecipient: recipient,
        amount: amount, token: tk,
        sentAmount: amount, receivedAmount: amount,   // CCTP is 1:1
        sentToken: tk, receivedToken: tk,
        status: 'completed',
        timestamp: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        // Cross-chain metadata
        crossChain: true,
        type: 'cross-chain-payment',
        bridgeType: turbo ? 'Turbo' : 'Standard',
        bridgeUsed: turbo ? 'Turbo Bridge' : 'Standard Bridge',
        fromNetwork: 'Arc Testnet',
        toNetwork: (dstChain && dstChain.name) || toKey,
        fromChainKey: ARC_KEY,
        toChainKey: toKey,
        // Transactions
        bridgeTxHash: burnHash,           // bridge (burn) tx on origin
        burnTxHash: burnHash,
        destinationTxHash: mintHash,      // FINAL delivery tx on destination
        mintTxHash: mintHash,
        finalTxHash: mintHash,
        // Explorers
        srcExplorer: srcExplorer,
        destExplorer: destExplorer,
        explorerUrl: burnHash ? (srcExplorer + '/tx/' + burnHash) : '',
        destExplorerUrl: (mintHash && destExplorer) ? (destExplorer + '/tx/' + mintHash) : '',
        provider: turbo ? 'Turbo Bridge' : 'Circle CCTP V2',
        durationMs: durationMs,
      };
      if (window.payState && Array.isArray(window.payState.history)) window.payState.history.unshift(entry);
      const walletKey = from ? ('arc_pay_history_' + from.toLowerCase()) : null;
      if (walletKey) {
        const ws = JSON.parse(localStorage.getItem(walletKey) || '[]');
        ws.unshift(entry);
        localStorage.setItem(walletKey, JSON.stringify(ws.slice(0, 50)));
      }
      const g = JSON.parse(localStorage.getItem('arc_pay_history') || '[]');
      g.unshift(entry);
      localStorage.setItem('arc_pay_history', JSON.stringify(g.slice(0, 50)));
      spState._lastDelivery = entry;
    } catch (e) { _warn('history record failed:', e && e.message); }
  }

  /* ═══════════════ AI AGENT / PROGRAMMATIC API ═══════════════ */
  // Resolve a network name/alias (e.g. "base", "ethereum") to an engine key.
  function _resolveNetwork(name) {
    if (!name) return null;
    const n = String(name).toLowerCase().trim();
    const chains = _chains();
    if (chains[n]) return n;
    const alias = {
      ethereum: 'sepolia', eth: 'sepolia', sepolia: 'sepolia',
      base: 'basesepolia', 'base sepolia': 'basesepolia',
      arbitrum: 'arbsepolia', arb: 'arbsepolia',
      optimism: 'optsepolia', op: 'optsepolia', 'op mainnet': 'optsepolia',
      polygon: 'polygonAmoy', matic: 'polygonAmoy', amoy: 'polygonAmoy',
      arc: 'arc',
    };
    if (alias[n] && chains[alias[n]]) return alias[n];
    // fuzzy: match by chain name/short
    for (const k of Object.keys(chains)) {
      const c = chains[k];
      if ((c.name && c.name.toLowerCase().includes(n)) || (c.short && c.short.toLowerCase() === n)) return k;
    }
    return null;
  }

  window.SmartPayments = {
    VERSION: '20260704b',
    isCrossChain: _isCrossChain,
    resolveNetwork: _resolveNetwork,
    getState: function () { return { toNetwork: spState.toNetwork, token: _token(), quote: spState.quote }; },
    // ── Delivery tracking (used by the Autonomous Agent to answer
    //    "where was my payment delivered?") ──
    getDeliveries: function () {
      try {
        const from = (window.walletState?.address || '').toLowerCase();
        const key = from ? ('arc_pay_history_' + from) : 'arc_pay_history';
        const list = JSON.parse(localStorage.getItem(key) || '[]');
        return list.filter(function (e) { return e && e.crossChain; });
      } catch (e) { return []; }
    },
    getLastDelivery: function () {
      if (spState._lastDelivery) return spState._lastDelivery;
      const d = this.getDeliveries();
      return d.length ? d[0] : null;
    },
    // Find a cross-chain payment by any hash (bridge or destination).
    findDelivery: function (hash) {
      if (!hash) return null;
      const h = String(hash).toLowerCase();
      return this.getDeliveries().find(function (e) {
        return [e.bridgeTxHash, e.destinationTxHash, e.burnTxHash, e.mintTxHash, e.txHash]
          .filter(Boolean).some(function (x) { return String(x).toLowerCase() === h; });
      }) || null;
    },
    // Human-readable summary for a delivery (agent-friendly).
    describeDelivery: function (entry) {
      const e = entry || this.getLastDelivery();
      if (!e) return 'No cross-chain payments found yet.';
      const parts = [];
      parts.push('Destination network: ' + (e.toNetwork || '—'));
      parts.push('Recipient: ' + (e.finalRecipient || e.recipient || '—'));
      parts.push('Amount: ' + (e.receivedAmount != null ? e.receivedAmount : e.amount) + ' ' + (e.receivedToken || e.token || 'USDC'));
      parts.push('Bridge used: ' + (e.bridgeUsed || e.bridgeType || '—'));
      if (e.bridgeTxHash) parts.push('Bridge tx: ' + e.bridgeTxHash + (e.srcExplorer ? ' (' + e.srcExplorer + '/tx/' + e.bridgeTxHash + ')' : ''));
      if (e.destinationTxHash) parts.push('Final (destination) tx: ' + e.destinationTxHash + (e.destExplorer ? ' (' + e.destExplorer + '/tx/' + e.destinationTxHash + ')' : ''));
      else parts.push('Final (destination) tx: pending');
      parts.push('Status: ' + (e.status || 'completed'));
      return parts.join('\n');
    },
    // Programmatic cross-chain payment used by the Autonomous Agent.
    // pay({ network, recipient, amount, token }) — network name/alias, USDC only.
    pay: async function (opts) {
      const key = _resolveNetwork(opts && opts.network);
      if (!key) throw new Error('Unsupported destination network: ' + (opts && opts.network));
      if (key === ARC_KEY) throw new Error('Use the local payment flow for Arc → Arc.');
      // Reflect selection in the UI so the user sees what runs.
      const sel = _el('pay-to-network'); if (sel) sel.value = key;
      spState.toNetwork = key;
      const rcp = _el('pay-recipient'); if (rcp && opts.recipient) rcp.value = opts.recipient;
      const amt = _el('pay-amount'); if (amt && opts.amount != null) amt.value = String(opts.amount);
      if (typeof window.selectPayToken === 'function') { try { window.selectPayToken('USDC'); } catch (e) {} }
      _toggleCrossChainUI(true);
      if (typeof window.updatePayPreview === 'function') window.updatePayPreview();
      return _executeCrossChain();
    },
    execute: _executeCrossChain,
  };

  /* ═══════════════ INIT ═══════════════ */
  function _wrap() {
    if (spState._wrapped) return;
    const origPreview  = window.updatePayPreview;
    const origValidate = window.payValidateForm;
    const origExecute  = window.executePayment;

    if (typeof origPreview === 'function') {
      window.updatePayPreview = function () {
        const r = origPreview.apply(this, arguments);
        try { _afterPreview(); } catch (e) {}
        return r;
      };
    }
    if (typeof origValidate === 'function') {
      window.payValidateForm = function () {
        const r = origValidate.apply(this, arguments);
        try { _afterValidate(); } catch (e) {}
        return r;
      };
    }
    if (typeof origExecute === 'function') {
      window.executePayment = async function () {
        if (_isCrossChain()) { return _executeCrossChain(); }
        return origExecute.apply(this, arguments);
      };
    }
    spState._wrapped = true;
  }

  function _init() {
    if (spState._inited) return;
    // Wait for both the payment engine and the cross-chain engine to be present.
    if (typeof window.executePayment !== 'function' || !window.ArcBridge) return;
    spState._inited = true;
    _populateNetworks();
    _toggleCrossChainUI(false);
    _renderBadge(false);
    _wrap();
    _log('Smart Cross-Chain Payments ready — local Arc→Arc preserved, cross-chain via shared engine');
  }

  // Retry init until dependencies are loaded (scripts may load in any order).
  let _tries = 0;
  const _iv = setInterval(function () {
    _tries++;
    _init();
    if (spState._inited || _tries > 60) clearInterval(_iv);
  }, 250);
  document.addEventListener('DOMContentLoaded', _init);
  window.addEventListener('load', _init);
})();
