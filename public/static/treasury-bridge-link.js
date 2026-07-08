// ============================================================================
//  treasury-bridge-link.js — Inbound Turbo Bridge ⇄ Treasury/Vault integration
// ----------------------------------------------------------------------------
//  100% ADDITIVE. Connects the INBOUND direction only:  External Chains → Arc.
//  The OUTBOUND bridge (Arc → External) is NEVER read, wrapped, intercepted,
//  reserved, settled, or modified in any way. This module does not touch the
//  bridge UI, bridge core, workers, or the user's execution path — it exposes a
//  real, operator-gated settlement backend on the deployed ArcVault plus live
//  liquidity verification, lifecycle events, health, and settlement logging.
//
//  Real data only: the deployed ArcTreasury/ArcVault contracts (auto-discovered
//  from /static/treasury-deployment.json), the connected operator wallet, and
//  the live Arc RPC. No mock balances, no simulated settlements, no fabrication.
//
//  Security: never accesses private keys/seed; every write is signed by the
//  connected operator wallet via the standard provider. Direction is strictly
//  guarded so nothing outbound can ever be processed here.
// ============================================================================
'use strict';

(function () {
  const RPC = 'https://rpc.testnet.arc.network';
  const CHAIN_ID = 5042002;
  const EXPLORER = 'https://testnet.arcscan.app';
  const ARC_KEY = 'arc';
  const ARC_DOMAIN = 26;
  const REC_KEY = 'execdaat_treasury_settlements_v1';
  const VERSION = '20260707l1';

  const VAULT_ABI = [
    'function getAvailableLiquidity(address) view returns (uint256)',
    'function isOperator(address) view returns (bool)',
    'function summary() view returns (tuple(string name,string version,address governor,bool paused,uint256 assetCount,uint256 operatorCount,uint256 turboFeeBps))',
    'function reserve(bytes32 intentId, address asset, uint256 amount)',
    'function startSettlement(bytes32 intentId, address asset, uint256 amount)',
    'function completeSettlement(bytes32 intentId, address asset, address to, uint256 amount)',
    'function release(bytes32 intentId, address asset, uint256 amount)',
    'function cancelSettlement(bytes32 intentId, address asset, uint256 amount)',
  ];

  const CFG = { configured: false, vault: null, treasury: null, assets: {}, chains: [] };

  // ─── Utils ──────────────────────────────────────────────────────────────────
  function E() { return window.ethers; }
  function readProvider() { try { return E() ? new (E().JsonRpcProvider)(RPC, CHAIN_ID) : null; } catch (_) { return null; } }
  function fmtU(v, d) { try { return parseFloat(E().formatUnits(v, d || 6)); } catch (_) { return null; } }
  function log() { try { console.log('%c[TreasuryBridge]', 'color:#f59e0b', ...arguments); } catch (_) {} }

  function fireEvent(name, detail) {
    const payload = Object.assign({ ts: Date.now(), name: name }, detail || {});
    try { window.dispatchEvent(new CustomEvent('treasurybridge:' + String(name).toLowerCase(), { detail: payload })); } catch (_) {}
    try { window.dispatchEvent(new CustomEvent('treasurybridge:event', { detail: payload })); } catch (_) {}
    pushEvent(payload);
  }
  const _events = [];
  function pushEvent(p) { _events.unshift(p); if (_events.length > 200) _events.pop(); }

  function loadRecords() { try { return JSON.parse(localStorage.getItem(REC_KEY) || '[]'); } catch (_) { return []; } }
  function saveRecord(rec) { try { const all = loadRecords(); all.unshift(rec); localStorage.setItem(REC_KEY, JSON.stringify(all.slice(0, 200))); } catch (_) {} }

  // ─── Discovery (reads the same manifest the Treasury page uses) ─────────────
  async function loadConfig(force) {
    if (CFG.configured && !force) return CFG;
    try {
      const r = await fetch('/static/treasury-deployment.json?ts=' + Date.now(), { headers: { Accept: 'application/json' } });
      if (!r.ok) return CFG;
      const d = await r.json();
      if (d && d.configured && d.vault && /^0x[0-9a-fA-F]{40}$/.test(d.vault.address || '')) {
        CFG.configured = true;
        CFG.vault = d.vault.address;
        CFG.treasury = d.treasury && d.treasury.address || null;
        CFG.chains = Array.isArray(d.chains) ? d.chains : [];
        CFG.assets = {};
        (Array.isArray(d.assets) ? d.assets : []).forEach((a) => { if (a && a.symbol && /^0x[0-9a-fA-F]{40}$/.test(a.address || '')) CFG.assets[String(a.symbol).toUpperCase()] = { address: a.address, decimals: a.decimals != null ? Number(a.decimals) : 6 }; });
      }
    } catch (_) {}
    return CFG;
  }

  // ─── Direction guards (INBOUND only; outbound is never handled) ─────────────
  function isInboundRoute(fromKey, toKey) {
    try { if (window.TurboBridge && typeof window.TurboBridge.isTurboRoute === 'function') return !!window.TurboBridge.isTurboRoute(fromKey, toKey); } catch (_) {}
    const f = String(fromKey || '').toLowerCase(), t = String(toKey || '').toLowerCase();
    return f && f !== ARC_KEY && (t === ARC_KEY || t === '');
  }
  function isInboundIntent(it) {
    if (!it) return false;
    const dst = String(it.dstChain || it.destinationChain || '').toLowerCase();
    const src = String(it.srcChain || it.sourceChain || '').toLowerCase();
    const dstArc = dst === '' || dst === ARC_KEY || dst.includes('arc') || Number(it.destinationDomain) === ARC_DOMAIN;
    const srcArc = src === ARC_KEY || src.includes('arc');
    return dstArc && !srcArc;
  }

  function assetOf(sym) { return CFG.assets[String(sym || '').toUpperCase()] || null; }
  function idBytes32(intent) {
    const b = intent.bytes32 || intent.intentBytes32 || intent.intentId || intent.id;
    if (typeof b === 'string' && /^0x[0-9a-fA-F]{64}$/.test(b)) return b;
    try { return E().id(String(intent.intentId || intent.id || Math.random())); } catch (_) { return '0x' + '0'.repeat(64); }
  }

  // ─── Liquidity verification (real, against the deployed ArcVault) ───────────
  async function verifyLiquidity(sym, amountH) {
    await loadConfig();
    if (!CFG.configured) return { ok: false, reason: 'treasury-not-configured', available: null, requested: amountH };
    const a = assetOf(sym); if (!a) return { ok: false, reason: 'asset-not-registered', available: null, requested: amountH };
    const p = readProvider(); if (!p) return { ok: false, reason: 'rpc-unavailable', available: null, requested: amountH };
    try {
      const vc = new (E().Contract)(CFG.vault, VAULT_ABI, p);
      const availRaw = await vc.getAvailableLiquidity(a.address);
      const available = fmtU(availRaw, a.decimals);
      const ok = Number(available) >= Number(amountH);
      if (!ok) fireEvent('LowLiquidity', { asset: sym, available: available, requested: amountH });
      return { ok, available, requested: amountH, asset: sym, vault: CFG.vault };
    } catch (e) { return { ok: false, reason: e.message, available: null, requested: amountH }; }
  }

  // ─── Real inbound settlement lifecycle on the ArcVault (operator-gated) ─────
  async function settleInbound(intent, opts) {
    opts = opts || {}; const step = typeof opts.onStep === 'function' ? opts.onStep : function () {};
    await loadConfig();
    if (!CFG.configured) throw new Error('Treasury Vault is not deployed/configured');
    if (!isInboundIntent(intent)) throw new Error('Refused: not an inbound (External → Arc) intent. Outbound is never handled by the Treasury.');
    const sym = String(intent.asset || '').toUpperCase();
    const a = assetOf(sym); if (!a) throw new Error('Asset ' + sym + ' is not registered in the Treasury Vault');
    const recipient = intent.recipient || intent.receiver;
    if (!recipient || !/^0x[0-9a-fA-F]{40}$/.test(recipient)) throw new Error('Intent has no valid Arc recipient address');
    const amountH = Number(intent.amount != null ? intent.amount : intent.grossAmount);
    if (!isFinite(amountH) || amountH <= 0) throw new Error('Invalid settlement amount');
    if (!E() || !window.walletState || !window.walletState.provider) throw new Error('Wallet not connected');

    const provider = new (E().BrowserProvider)(window.walletState.provider);
    const signer = await provider.getSigner();
    const worker = await signer.getAddress();
    const readVault = new (E().Contract)(CFG.vault, VAULT_ABI, provider);
    const isOp = await readVault.isOperator(worker).catch(() => false);
    if (!isOp) throw new Error('Connected wallet is not an authorized Treasury Vault operator');

    const vault = new (E().Contract)(CFG.vault, VAULT_ABI, signer);
    const bytes32 = idBytes32(intent);
    const amount = E().parseUnits(String(amountH), a.decimals);
    const rec = { intentId: bytes32, origin: intent.srcChain || null, dst: 'arc', asset: sym, amount: amountH, recipient, worker, status: 'validating', createdAt: Date.now(), explorer: EXPLORER };

    fireEvent('IntentReceived', { intentId: bytes32, origin: rec.origin, asset: sym, amount: amountH });
    fireEvent('IntentValidated', { intentId: bytes32 });

    // Liquidity verification (real) — never create negative balances
    const availRaw = await readVault.getAvailableLiquidity(a.address);
    if (availRaw < amount) { fireEvent('LowLiquidity', { asset: sym, available: fmtU(availRaw, a.decimals), requested: amountH }); fireEvent('SettlementFailed', { intentId: bytes32, reason: 'insufficient-liquidity' }); throw new Error('Insufficient Treasury Vault liquidity (' + fmtU(availRaw, a.decimals) + ' < ' + amountH + ' ' + sym + ')'); }

    try {
      step('reserve');
      const t1 = await vault.reserve(bytes32, a.address, amount); await t1.wait();
      rec.reservationTx = t1.hash; rec.status = 'reserved';
      fireEvent('LiquidityReserved', { intentId: bytes32, asset: sym, amount: amountH, tx: t1.hash });

      step('start');
      const t2 = await vault.startSettlement(bytes32, a.address, amount); await t2.wait();
      rec.startTx = t2.hash; rec.status = 'settling';
      fireEvent('SettlementStarted', { intentId: bytes32, tx: t2.hash });

      step('complete');
      const t3 = await vault.completeSettlement(bytes32, a.address, recipient, amount); const r3 = await t3.wait();
      if (!r3 || r3.status !== 1) throw new Error('completeSettlement reverted');
      rec.settleTx = t3.hash; rec.settlementId = t3.hash; rec.status = 'completed'; rec.settledAt = Date.now(); rec.block = r3.blockNumber;
      rec.settlementTime = rec.settledAt - rec.createdAt;
      saveRecord(rec);
      fireEvent('SettlementConfirmed', { intentId: bytes32, tx: t3.hash, block: r3.blockNumber });
      fireEvent('SettlementCompleted', { intentId: bytes32, tx: t3.hash, to: recipient, asset: sym, amount: amountH });
      fireEvent('LiquidityReleased', { intentId: bytes32, asset: sym, amount: amountH });
      log('inbound settled', sym, amountH, '→', recipient, t3.hash);
      return { ok: true, settlementId: t3.hash, txHash: t3.hash, block: r3.blockNumber, explorer: EXPLORER + '/tx/' + t3.hash };
    } catch (e) {
      // Best-effort cleanup so we never leave phantom reserved/pending liquidity
      try {
        if (rec.status === 'reserved') { const c = await vault.release(bytes32, a.address, amount); await c.wait(); }
        else if (rec.status === 'settling') { const c = await vault.cancelSettlement(bytes32, a.address, amount); await c.wait(); }
      } catch (_) {}
      rec.status = 'failed'; rec.error = (e && (e.shortMessage || e.message)) || String(e); saveRecord(rec);
      fireEvent('SettlementFailed', { intentId: bytes32, reason: rec.error });
      throw e;
    }
  }

  // ─── Health (inbound infrastructure only) ───────────────────────────────────
  async function health() {
    await loadConfig();
    const out = { configured: CFG.configured, vault: CFG.vault, treasury: CFG.treasury, rpc: false, vaultOk: false, paused: null, operator: null, checkedAt: Date.now() };
    const p = readProvider(); if (!p || !CFG.configured) return out;
    try { const bn = await p.getBlockNumber(); out.rpc = bn > 0; } catch (_) {}
    try { const vc = new (E().Contract)(CFG.vault, VAULT_ABI, p); const s = await vc.summary(); out.vaultOk = true; out.paused = s.paused; } catch (_) {}
    try { const addr = window.walletState && window.walletState.address; if (addr) { const vc = new (E().Contract)(CFG.vault, VAULT_ABI, p); out.operator = await vc.isOperator(addr); } } catch (_) {}
    return out;
  }

  // ─── Auto-observe REAL inbound settlements done by the existing bridge ───────
  // Read-only: when the existing bridge reports an inbound completion, record it
  // for Treasury analytics/history. Never re-settles, never touches outbound.
  function observeExisting() {
    try {
      const rc = window.RepaymentContract; if (!rc || typeof rc.getAll !== 'function') return;
      const existing = new Set(loadRecords().map(r => String(r.intentId)));
      (rc.getAll() || []).forEach((it) => {
        if (!isInboundIntent(it)) return; // inbound only
        if (String(it.status || '').toLowerCase() !== 'settled') return;
        const key = String(it.intentBytes32 || it.intentId || it.id);
        if (existing.has(key)) return;
        saveRecord({ intentId: key, origin: it.srcChain || null, dst: 'arc', asset: String(it.asset || '').toUpperCase(), amount: Number(it.grossAmount || it.amount) || null, recipient: it.userAddress || null, worker: 'turbo-bridge', status: 'observed', source: 'existing-bridge', settleTx: it.settlementTxHash || it.arcTxHash || null, settlementId: it.settlementTxHash || it.arcTxHash || key, createdAt: it.createdAt || Date.now(), settledAt: it.settledAt || it.updatedAt || Date.now(), explorer: EXPLORER });
        fireEvent('SettlementObserved', { intentId: key, asset: String(it.asset || '').toUpperCase(), amount: Number(it.grossAmount || it.amount) || null, origin: it.srcChain || null, tx: it.settlementTxHash || it.arcTxHash || null });
      });
    } catch (_) {}
  }
  ['ub:bridge:completed', 'ub:cctp:completed', 'treasury:completed'].forEach((ev) => { try { window.addEventListener(ev, observeExisting); } catch (_) {} });

  // ─── Public API ─────────────────────────────────────────────────────────────
  window.TreasuryBridge = {
    VERSION,
    config: () => Object.assign({}, CFG),
    loadConfig,
    isInboundRoute,
    isInboundIntent,
    verifyLiquidity,
    settleInbound,
    health,
    records: loadRecords,
    events: () => _events.slice(),
    observeExisting,
  };

  loadConfig().then((c) => { if (c.configured) { log('linked · inbound backend → ArcVault', c.vault, '· outbound untouched'); observeExisting(); } else { log('inactive · Treasury/Vault not deployed yet (bridge unchanged)'); } });
})();
