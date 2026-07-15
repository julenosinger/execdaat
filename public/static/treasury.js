// ============================================================
// TREASURY MODULE — Inbound Turbo Bridge Operational Control Center
// ------------------------------------------------------------
// Phase 3 — institutional-grade, multi-workspace. Governs EXCLUSIVELY:
//     External Chains  ──▶  Arc Network   (inbound only)
// The outbound direction (Arc ──▶ External) is never inspected, read,
// monitored, modified, or exposed.
//
// 100% additive. Read-only except operator-gated Vault actions, which are
// enabled ONLY after real on-chain capability detection (bytecode selector
// scan + getAvailableLiquidity/balanceOf verification). Never simulates or
// fabricates deposits/withdrawals/balances. Arc Testnet.
//
// Data sources (real only): TreasuryVault contract, local Turbo Bridge store,
// Treasury Core proxy APIs, /api/status, /api/treasury/health, /api/dex/pools,
// Arc RPC (read-only), token contracts, bridge chain registry.
// ============================================================
'use strict';

(function () {
  const TRS_EXPLORER = 'https://testnet.arcscan.app';
  const TRS_NETWORK  = 'Arc Testnet';
  const TRS_CHAIN_ID = 5042002;
  const TRS_RPC      = (typeof window !== 'undefined' && window.location && window.location.origin.indexOf('http') === 0)
    ? window.location.origin + '/api/rpc' // same-origin failover proxy
    : 'https://rpc.testnet.arc.network';
  const TRS_REFRESH_MS = 25000;
  const TRS_VERSION  = '20260709t-mint';
  const ARC_KEY = 'arc', ARC_DOMAIN = 26;

  const DEFAULT_VAULT_ADDR = '0xbfC9E8F79bd30b912081ae88F9ad0A515F08c2F1';
  let   VAULT_ADDR   = DEFAULT_VAULT_ADDR;   // may be overridden by on-chain auto-discovery
  let   TREASURY_ADDR = null;                // ArcTreasury (governance) — from discovery manifest
  let   DEPLOYMENT   = null;                 // parsed /treasury-deployment.json (addresses only)
  let   DISCOVERY_DONE = false;
  const VAULT_OWNER  = '0xA43ABD9Dc38840376d3C469bFBf5951912936c9f';
  const ARC_TREASURY_ABI = ['function summary() view returns (tuple(string name,string version,uint256 signerCount,uint256 threshold,bool paused,address vault,uint256 proposalCount,uint256 executedCount,uint256 assetCount))'];
  const VAULT_ASSETS = { USDC: '0x3600000000000000000000000000000000000000', EURC: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a' };
  const ASSET_DECIMALS = { USDC: 6, EURC: 6 };
  const DEPOSIT_WHITELIST = [
    '0xA43ABD9Dc38840376d3C469bFBf5951912936c9f', '0x01dE545e8Fea5EcAAb78eC2C09E6D98117f7687d',
    '0xBBE4Bf2D53A4A752c0eF21573FA0162BddafCD12', '0xC77F058339Bb0ff06554b2D0Efcb0E2FD4852cb0',
  ];
  const VAULT_ABI = [
    'function getAvailableLiquidity(address asset) view returns (uint256 available)',
    'function isOperator(address) view returns (bool)',
    'function turboFeeBps() view returns (uint256)',
    'event IntentCreated(bytes32 indexed intentId, address indexed creator, address asset, uint256 grossAmount, uint256 feeAmount, address indexed receiver)',
    'event IntentFulfilled(bytes32 indexed intentId, address fulfiller)',
    'event IntentSettled(bytes32 indexed intentId, address settler, uint256 settledAmount)',
    'event IntentFailed(bytes32 indexed intentId, string reason)',
    'event TurboFeeCollected(bytes32 indexed intentId, address indexed asset, uint256 feeAmount)',
  ];
  const ERC20_ABI = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)', 'function transfer(address,uint256) returns (bool)', 'function approve(address,uint256) returns (bool)', 'event Transfer(address indexed from, address indexed to, uint256 value)'];
  const DEPOSIT_SIGS  = ['deposit(address,uint256)', 'deposit(uint256)', 'depositLiquidity(address,uint256)', 'depositLiquidity(uint256)', 'fund(address,uint256)', 'fund(uint256)', 'mintLiquidity(address,uint256)', 'addLiquidity(address,uint256)', 'addLiquidity(uint256)'];
  const WITHDRAW_SIGS = ['withdraw(address,uint256)', 'withdraw(uint256)', 'withdrawLiquidity(address,uint256)', 'withdrawLiquidity(uint256)', 'redeem(address,uint256)', 'redeem(uint256)', 'releaseLiquidity(address,uint256)', 'removeLiquidity(address,uint256)', 'removeLiquidity(uint256)'];

  const WORKSPACES = [
    { id: 'overview',    label: 'Overview',    icon: 'fa-gauge-high' },
    { id: 'vault',       label: 'Vault',       icon: 'fa-vault' },
    { id: 'intents',     label: 'Intents',     icon: 'fa-list-check' },
    { id: 'settlements', label: 'Settlements', icon: 'fa-check-double' },
    { id: 'mint',        label: 'Mint',        icon: 'fa-coins' },
    { id: 'liquidity',   label: 'Liquidity',   icon: 'fa-water' },
    { id: 'analytics',   label: 'Analytics',   icon: 'fa-chart-pie' },
    { id: 'diagnostics', label: 'Diagnostics', icon: 'fa-stethoscope' },
  ];

  const S = {
    intents: [], metricsRemote: null, health: null, system: null, dexPools: null, policies: null,
    vault: [], operator: { checked: false, isOperator: false, address: null },
    caps: { checked: false, deposit: false, depositMode: null, depositSig: null, withdraw: false, withdrawSig: null, transferFunded: false, nativeDeposit: null, balanceOf: null, available: null },
    vaultEvents: null, vaultEventsLoading: false,
    ws: 'overview', wsLoaded: {}, lastSync: 0, loading: false, built: false,
    search: '', fStatus: 'all', fAsset: 'all', fChain: 'all', sortKey: 'created', sortDir: 'desc', page: 1, pageSize: 12, timer: null, dm: null,
  };

  // ─── Helpers ────────────────────────────────────────────────────────────────
  const q = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  function toast(m, t) { try { if (typeof showToast === 'function') showToast(m, t || 'info'); } catch (_) {} }
  function W(n) { try { return window[n]; } catch (_) { return undefined; } }
  const num = (v) => { const n = Number(v); return isFinite(n) ? n : null; };
  function fmtNum(v, dp) { const n = num(v); if (n == null) return '—'; return n.toLocaleString('en-US', { minimumFractionDigits: dp == null ? 0 : dp, maximumFractionDigits: dp == null ? 2 : dp }); }
  function fmtUsd(v, dp) { const n = num(v); if (n == null) return '—'; return '$' + fmtNum(n, dp == null ? 2 : dp); }
  const shortAddr = (a) => (!a || typeof a !== 'string' || a.length < 12) ? (a || '—') : a.slice(0, 6) + '…' + a.slice(-4);
  const shortHash = (h) => (!h || typeof h !== 'string' || h.length < 14) ? (h || '—') : h.slice(0, 10) + '…' + h.slice(-6);
  function toMs(t) { if (t == null || t === '') return 0; if (typeof t === 'number') { if (t > 1e12) return t; if (t > 1e9) return t * 1000; return t; } const p = Date.parse(t); return isNaN(p) ? 0 : p; }
  function timeAgo(ms) { if (!ms) return '—'; const s = Math.max(0, Math.floor((Date.now() - ms) / 1000)); if (s < 60) return s + 's ago'; const m = Math.floor(s / 60); if (m < 60) return m + 'm ago'; const h = Math.floor(m / 60); if (h < 24) return h + 'h ago'; return Math.floor(h / 24) + 'd ago'; }
  function fmtDur(ms) { if (ms == null || !isFinite(ms) || ms <= 0) return '—'; const s = Math.round(ms / 1000); if (s < 60) return s + 's'; const m = Math.floor(s / 60); if (m < 60) return m + 'm ' + (s % 60) + 's'; const h = Math.floor(m / 60); return h + 'h ' + (m % 60) + 'm'; }
  function fmtDate(ms) { if (!ms) return '—'; return new Date(ms).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }); }
  function copyBtn(val, label) { const safe = String(val || '').replace(/'/g, "\\'"); return `<button type="button" class="trs-ic" title="Copy ${esc(label || '')}" aria-label="Copy ${esc(label || '')}" onclick="event.stopPropagation();trsCopy('${safe}','${esc(label || '')}')"><i class="fas fa-copy"></i></button>`; }
  function txLink(hash, label, base) { if (!hash) return ''; return `<a class="trs-ic" href="${base || TRS_EXPLORER}/tx/${hash}" target="_blank" rel="noopener" title="View ${esc(label || 'transaction')}" aria-label="View ${esc(label || 'transaction')}" onclick="event.stopPropagation();"><i class="fas fa-external-link-alt"></i></a>`; }
  function addrLink(addr, base) { if (!addr) return ''; return `<a class="trs-ic" href="${base || TRS_EXPLORER}/address/${addr}" target="_blank" rel="noopener" title="View on explorer" aria-label="View address on explorer" onclick="event.stopPropagation();"><i class="fas fa-external-link-alt"></i></a>`; }

  const STATUS_META = {
    pending: { label: 'Pending', color: '#fbbf24', rgb: '245,158,11', icon: 'fa-clock' },
    processing: { label: 'Processing', color: '#67e8f9', rgb: '34,211,238', icon: 'fa-spinner' },
    completed: { label: 'Completed', color: '#34d399', rgb: '52,211,153', icon: 'fa-check-circle' },
    failed: { label: 'Failed', color: '#f87171', rgb: '239,68,68', icon: 'fa-times-circle' },
    review: { label: 'Manual Review', color: '#c084fc', rgb: '192,132,252', icon: 'fa-user-shield' },
    cancelled: { label: 'Cancelled', color: '#9ca3af', rgb: '148,163,184', icon: 'fa-ban' },
    expired: { label: 'Expired', color: '#c084fc', rgb: '192,132,252', icon: 'fa-hourglass-end' },
    unknown: { label: 'Unknown', color: '#8aaac8', rgb: '138,170,200', icon: 'fa-circle' },
  };
  function bucket(raw) { const s = String(raw || '').toLowerCase();
    if (/await(ing)?\s*operator|manual|review/.test(s)) return 'review';
    if (/settl(ed|ement complete)|complete|success|done|^settled$/.test(s)) return 'completed';
    if (/fail|error|revert/.test(s)) return 'failed'; if (/cancel/.test(s)) return 'cancelled'; if (/expire/.test(s)) return 'expired';
    if (/fulfil|process|execut|attest|mint|burn|bridg|pending_settle|settling/.test(s)) return 'processing';
    if (/creat|pending|queued|new|initiat|reserv/.test(s)) return 'pending'; return 'unknown'; }
  function statusChip(key) { const m = STATUS_META[key] || STATUS_META.unknown; return `<span class="trs-chip" style="color:${m.color};background:rgba(${m.rgb},0.12);border:1px solid rgba(${m.rgb},0.3);"><i class="fas ${m.icon}" style="font-size:8px;"></i>${m.label}</span>`; }

  function chainMeta(key) { const reg = (W('ArcBridge') && window.ArcBridge.CHAINS) || {}; const k = String(key || '').toLowerCase(); for (const kk in reg) { const c = reg[kk]; if (!c) continue; if (kk.toLowerCase() === k || String(c.key || '').toLowerCase() === k || String(c.short || '').toLowerCase() === k || String(c.name || '').toLowerCase() === k) return c; } return null; }
  function chainName(key) { const c = chainMeta(key); return c ? (c.name || c.short || key) : (key || '—'); }
  function chainExplorer(key) { const c = chainMeta(key); return c ? (c.explorer || TRS_EXPLORER) : TRS_EXPLORER; }

  async function withTimeout(p, ms) { return await Promise.race([Promise.resolve(p), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms || 8000))]); }
  async function fetchJson(url, opts, ms) { try { const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms || 8000); const r = await fetch(url, Object.assign({ signal: ctl.signal, headers: { 'Accept': 'application/json' } }, opts || {})); clearTimeout(t); if (!r.ok) return { _httpError: r.status }; return await r.json(); } catch (e) { return null; } }
  async function vaultProvider() { if (!W('ethers')) return null; try { return new window.ethers.JsonRpcProvider(TRS_RPC); } catch (_) { return null; } }

  // ─── Intent normalization + INBOUND filter ──────────────────────────────────
  function isInbound(it) { const dst = String(it.dstChain || '').toLowerCase(); const src = String(it.srcChain || '').toLowerCase(); const dstArc = dst === '' || dst === ARC_KEY || dst.includes('arc') || Number(it.raw && (it.raw.destinationDomain != null ? it.raw.destinationDomain : it.raw.destDomain)) === ARC_DOMAIN; const srcArc = src === ARC_KEY || src.includes('arc'); return dstArc && !srcArc; }
  function normIntent(x, source) { if (!x || typeof x !== 'object') return null; const pick = (...k) => { for (const kk of k) { if (x[kk] != null && x[kk] !== '') return x[kk]; } return null; }; const status = pick('status', 'state', 'intentStatus', 'phase');
    return { id: pick('id', 'intentId', 'intent_id', 'intentBytes32', 'hash') || ('intent-' + Math.random().toString(16).slice(2, 8)), intentId: pick('intentId', 'intent_id', 'id', 'intentBytes32'), bytes32: pick('intentBytes32', 'intentId'), asset: (pick('asset', 'token', 'symbol', 'currency') || '—'), amount: pick('grossAmount', 'amount', 'value', 'inputAmount', 'srcAmount'), net: pick('netAmount', 'receive', 'outputAmount', 'dstAmount'), fee: pick('feeAmount', 'fee', 'bridgeFee'), sender: pick('userAddress', 'sender', 'from', 'wallet', 'account'), recipient: pick('recipient', 'receiver', 'to', 'destination', 'userAddress'), srcChain: pick('srcChain', 'sourceChain', 'source_chain', 'from_chain', 'origin'), dstChain: pick('dstChain', 'destinationChain', 'destination_chain', 'to_chain') || 'arc', sourceDomain: pick('sourceDomain', 'source_domain'), status: status || 'unknown', statusKey: bucket(status), created: toMs(pick('createdAt', 'created_at', 'created', 'timestamp', 'ts')), updated: toMs(pick('updatedAt', 'updated_at', 'updated', 'lastUpdate')), settled: toMs(pick('settledAt', 'settled_at', 'completedAt', 'completed_at')), fulfilled: toMs(pick('arcFulfillmentTimestamp')), txHash: pick('txHash', 'sourceTxHash', 'burnTxHash', 'depositTxHash', 'source_tx'), arcTx: pick('arcTxHash'), settleTx: pick('settlementTxHash', 'destinationTxHash', 'mintTxHash', 'settle_tx'), cctpMsgHash: pick('cctpMsgHash'), error: pick('settlementError', 'error', 'failReason', 'lastError'), retryCount: num(pick('retryCount', 'retries', 'attempts')), source: source, raw: x }; }
  async function loadIntents() { const out = [], seen = new Set();
    try { const rc = W('RepaymentContract'); if (rc && rc.getAll) (rc.getAll() || []).forEach((x) => { const n = normIntent(x, 'local'); if (n && isInbound(n)) { const k = String(n.intentId || n.id); if (!seen.has(k)) { seen.add(k); out.push(n); } } }); } catch (_) {}
    try { const td = W('TreasuryData'); if (td && td.history) { const arr = await withTimeout(td.history({ limit: 300 }), 9000).catch(() => null); if (Array.isArray(arr)) arr.forEach((x) => { const n = normIntent(x, 'remote'); if (n && isInbound(n)) { const k = String(n.intentId || n.id); if (!seen.has(k)) { seen.add(k); out.push(n); } } }); } } catch (_) {}
    out.sort((a, b) => (b.created || 0) - (a.created || 0)); return out; }
  async function loadRemoteMetrics() { try { const td = W('TreasuryData'); if (td && td.metrics) { const m = await withTimeout(td.metrics(), 9000).catch(() => null); if (m && typeof m === 'object' && m.ok !== false && !m.error && !m.code) return m; } } catch (_) {} return null; }
  async function loadHealth() { const comp = {}; let ok = null; try { const ti = W('TreasuryIntegration'); if (ti && ti.checkHealth) await withTimeout(ti.checkHealth(), 9000).catch(() => {}); const td = W('TreasuryData'); if (td && td.health) { const h = td.health() || {}; if (h.components) Object.assign(comp, h.components); if (typeof h.ok === 'boolean') ok = h.ok; } } catch (_) {} const meta = await fetchJson('/api/treasury/health', null, 8000); return { ok, checkedAt: Date.now(), components: comp, meta }; }
  async function loadSystem() { const t0 = performance.now(); const status = await fetchJson('/api/status', null, 8000); const apiLatency = Math.round(performance.now() - t0); let rpc = { ok: false, latency: null, block: null }; try { const s0 = performance.now(); const r = await fetchJson(TRS_RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }) }, 7000); const lat = Math.round(performance.now() - s0); if (r && r.result) rpc = { ok: true, latency: lat, block: parseInt(r.result, 16) }; else rpc = { ok: false, latency: lat, block: null }; } catch (_) {} return { status, apiLatency, rpc }; }
  async function loadDexPools() { return await fetchJson('/api/dex/pools', null, 8000); }
  async function loadPolicies() { const pol = { turboFeeBps: null, operators: DEPOSIT_WHITELIST.length }; try { const fn = W('fetchTurboFeeBps'); if (typeof fn === 'function') { const bps = await withTimeout(fn(), 7000).catch(() => null); if (bps != null && isFinite(Number(bps))) pol.turboFeeBps = Number(bps); } } catch (_) {} if (pol.turboFeeBps == null) { try { const p = await vaultProvider(); if (p) { const vc = new window.ethers.Contract(VAULT_ADDR, VAULT_ABI, p); const bps = await withTimeout(vc.turboFeeBps(), 7000).catch(() => null); if (bps != null) pol.turboFeeBps = Number(bps); } } catch (_) {} } return pol; }

  async function loadVault(intents) {
    const rows = {}; const ensure = (sym) => { const s = String(sym || '').toUpperCase(); if (!rows[s]) rows[s] = { asset: s, available: null, locked: null, reserved: 0, pending: 0, total: null }; return rows[s]; };
    try { const p = await vaultProvider(); if (p) { const vc = new window.ethers.Contract(VAULT_ADDR, VAULT_ABI, p); for (const sym of Object.keys(VAULT_ASSETS)) { try { const raw = await withTimeout(vc.getAvailableLiquidity(VAULT_ASSETS[sym]), 9000); ensure(sym).available = parseFloat(window.ethers.formatUnits(raw, ASSET_DECIMALS[sym] || 6)); } catch (_) { ensure(sym); } } } } catch (_) {}
    try { const vs = W('VaultStore'); if (vs && vs.get) { const st = vs.get() || {}; const la = st.lockedAmounts || {}; Object.keys(la).forEach((a) => { const v = Number(la[a]); if (isFinite(v)) ensure(a).locked = v; }); const cb = st.chainBalances || {}; Object.keys(cb).forEach((a) => { const row = ensure(a); if (cb[a] && cb[a].locked != null && row.locked == null) row.locked = Number(cb[a].locked); if (row.available == null && cb[a] && cb[a].available != null) row.available = Number(cb[a].available); }); } } catch (_) {}
    (intents || []).forEach((it) => { const amt = Number(it.amount); if (!isFinite(amt)) return; const row = ensure(it.asset); if (it.statusKey === 'pending') row.reserved += amt; if (it.statusKey === 'processing' || it.statusKey === 'review') row.pending += amt; });
    Object.values(rows).forEach((r) => { const a = Number(r.available) || 0, l = Number(r.locked) || 0; r.total = (r.available != null || r.locked != null) ? a + l : null; });
    return Object.values(rows);
  }
  async function loadOperator() { const addr = (W('walletState') && window.walletState.address) || null; let isOp = false; if (addr) { isOp = DEPOSIT_WHITELIST.some(a => a.toLowerCase() === addr.toLowerCase()); try { const p = await vaultProvider(); if (p) { const vc = new window.ethers.Contract(VAULT_ADDR, VAULT_ABI, p); const on = await withTimeout(vc.isOperator(addr), 7000).catch(() => null); if (typeof on === 'boolean') isOp = on || isOp; } } catch (_) {} } S.operator = { checked: true, isOperator: !!isOp, address: addr }; return S.operator; }

  // ─── Auto-discovery of deployed ArcTreasury + ArcVault (no hardcoded addrs) ─
  async function loadDiscovery() {
    DISCOVERY_DONE = true;
    try {
      const d = await fetchJson('/static/treasury-deployment.json?ts=' + Date.now(), null, 7000);
      if (d && d.configured && d.vault && /^0x[0-9a-fA-F]{40}$/.test(d.vault.address || '')) {
        DEPLOYMENT = d;
        VAULT_ADDR = d.vault.address;
        TREASURY_ADDR = (d.treasury && /^0x[0-9a-fA-F]{40}$/.test(d.treasury.address || '')) ? d.treasury.address : null;
        S.caps = { checked: false, deposit: false, depositMode: null, depositSig: null, withdraw: false, withdrawSig: null, transferFunded: false, nativeDeposit: null, balanceOf: null, available: null, note: '' };
        if (Array.isArray(d.assets)) d.assets.forEach((a) => { if (a && a.symbol && /^0x[0-9a-fA-F]{40}$/.test(a.address || '')) { const sym = String(a.symbol).toUpperCase(); VAULT_ASSETS[sym] = a.address; if (a.decimals != null) ASSET_DECIMALS[sym] = Number(a.decimals); } });
      } else { DEPLOYMENT = d && typeof d === 'object' ? d : { configured: false }; }
    } catch (_) { DEPLOYMENT = { configured: false }; }
  }
  async function loadGovernance() {
    if (!TREASURY_ADDR) { S.governance = null; return; }
    try { const p = await vaultProvider(); if (!p) return; const tc = new window.ethers.Contract(TREASURY_ADDR, ARC_TREASURY_ABI, p); const sm = await withTimeout(tc.summary(), 8000).catch(() => null); if (sm) S.governance = { name: sm.name, version: sm.version, signerCount: Number(sm.signerCount), threshold: Number(sm.threshold), paused: sm.paused, vault: sm.vault, proposalCount: Number(sm.proposalCount), executedCount: Number(sm.executedCount), assetCount: Number(sm.assetCount) }; } catch (_) {}
  }

  // ─── Smart capability detection (real, on-chain) ────────────────────────────
  async function detectCapabilities() {
    const caps = { checked: true, deposit: false, depositMode: null, depositSig: null, withdraw: false, withdrawSig: null, transferFunded: false, nativeDeposit: null, balanceOf: null, available: null, note: '' };
    try {
      const p = await vaultProvider(); if (!p || !window.ethers) { caps.note = 'ethers/RPC unavailable'; S.caps = caps; return caps; }
      const code = await withTimeout(p.getCode(VAULT_ADDR), 9000).catch(() => null);
      const codeLc = (code || '').toLowerCase();
      const hasSel = (sig) => { try { const sel = window.ethers.id(sig).slice(2, 10).toLowerCase(); return sel && codeLc.length > 2 && codeLc.includes(sel); } catch (_) { return false; } };
      caps.nativeDeposit = DEPOSIT_SIGS.find(hasSel) || null;
      caps.withdrawSig = WITHDRAW_SIGS.find(hasSel) || null;
      try { const vc = new window.ethers.Contract(VAULT_ADDR, VAULT_ABI, p); const tok = new window.ethers.Contract(VAULT_ASSETS.USDC, ERC20_ABI, p);
        const [bal, av] = await Promise.all([tok.balanceOf(VAULT_ADDR).catch(() => null), vc.getAvailableLiquidity(VAULT_ASSETS.USDC).catch(() => null)]);
        if (bal != null) caps.balanceOf = parseFloat(window.ethers.formatUnits(bal, 6));
        if (av != null) caps.available = parseFloat(window.ethers.formatUnits(av, 6));
        // ERC20-transfer accounting: available tracks the vault's token balance ⇒ transfers increase getAvailableLiquidity
        if (bal != null && av != null && bal > 0n && av > 0n && av <= bal) caps.transferFunded = true;
      } catch (_) {}
      caps.deposit = caps.transferFunded || !!caps.nativeDeposit;
      caps.depositMode = caps.transferFunded ? 'transfer' : (caps.nativeDeposit ? 'native' : null);
      caps.depositSig = caps.nativeDeposit;
      caps.withdraw = !!caps.withdrawSig;
      caps.note = caps.transferFunded ? 'ERC-20 transfer accounting confirmed via getAvailableLiquidity()' : (caps.nativeDeposit ? ('native ' + caps.nativeDeposit + ' detected in bytecode') : 'no funding capability detected on-chain');
    } catch (_) {}
    S.caps = caps; return caps;
  }

  // ─── Vault history from real blockchain events (lazy) ───────────────────────
  async function loadVaultEvents() {
    if (S.vaultEventsLoading) return S.vaultEvents; S.vaultEventsLoading = true;
    const out = [];
    try {
      const p = await vaultProvider(); if (!p) { S.vaultEventsLoading = false; return null; }
      const latest = await p.getBlockNumber(); const from = Math.max(0, latest - 120000);
      const vIface = new window.ethers.Interface(VAULT_ABI);
      const transferTopic = window.ethers.id('Transfer(address,address,uint256)');
      const pad = (a) => '0x' + '0'.repeat(24) + a.replace(/^0x/, '').toLowerCase();
      const blockTs = {};
      async function tsFor(bn) { if (blockTs[bn] != null) return blockTs[bn]; try { const b = await p.getBlock(bn); blockTs[bn] = b ? b.timestamp * 1000 : 0; } catch (_) { blockTs[bn] = 0; } return blockTs[bn]; }
      // Vault contract events (consumption / settlement / fees)
      const vTopics = { IntentFulfilled: window.ethers.id('IntentFulfilled(bytes32,address)'), IntentSettled: window.ethers.id('IntentSettled(bytes32,address,uint256)'), TurboFeeCollected: window.ethers.id('TurboFeeCollected(bytes32,address,uint256)') };
      for (const [name, t0] of Object.entries(vTopics)) { try { const ls = await p.getLogs({ address: VAULT_ADDR, topics: [t0], fromBlock: from, toBlock: latest }); for (const l of ls) { let parsed = null; try { parsed = vIface.parseLog(l); } catch (_) {} out.push({ kind: name === 'IntentSettled' ? 'Settlement Consumption' : name === 'IntentFulfilled' ? 'Liquidity Release' : 'Fee Collected', name, block: Number(l.blockNumber || 0), tx: l.transactionHash, parsed, asset: parsed && parsed.args && parsed.args.asset ? parsed.args.asset : null, amount: parsed && parsed.args && (parsed.args.settledAmount != null ? parsed.args.settledAmount : parsed.args.feeAmount) }); } } catch (_) {} }
      // ERC-20 transfers in/out of the vault (deposits / withdrawals / consumption) per known asset
      for (const sym of Object.keys(VAULT_ASSETS)) {
        const tokenAddr = VAULT_ASSETS[sym];
        try { const inLs = await p.getLogs({ address: tokenAddr, topics: [transferTopic, null, pad(VAULT_ADDR)], fromBlock: from, toBlock: latest }); for (const l of inLs) { const val = BigInt(l.data); out.push({ kind: 'Deposit / Funding', name: 'Transfer', block: Number(l.blockNumber || 0), tx: l.transactionHash, asset: sym, amount: val, from: '0x' + (l.topics[1] || '').slice(26) }); } } catch (_) {}
        try { const outLs = await p.getLogs({ address: tokenAddr, topics: [transferTopic, pad(VAULT_ADDR)], fromBlock: from, toBlock: latest }); for (const l of outLs) { const val = BigInt(l.data); out.push({ kind: 'Withdrawal / Outflow', name: 'Transfer', block: Number(l.blockNumber || 0), tx: l.transactionHash, asset: sym, amount: val, to: '0x' + (l.topics[2] || '').slice(26) }); } } catch (_) {}
      }
      // timestamps for the most recent blocks
      const blocks = Array.from(new Set(out.map(e => e.block))).sort((a, b) => b - a).slice(0, 40);
      await Promise.all(blocks.map(tsFor));
      out.forEach((e) => { e.ts = blockTs[e.block] || 0; if (e.amount != null && typeof e.amount === 'bigint') { const dec = ASSET_DECIMALS[e.asset] || 6; e.amountH = parseFloat(window.ethers.formatUnits(e.amount, dec)); } });
      out.sort((a, b) => (b.block - a.block));
    } catch (_) {}
    S.vaultEvents = out; S.vaultEventsLoading = false; return out;
  }

  // ─── Derived metrics ────────────────────────────────────────────────────────
  function deriveMetrics(intents) {
    const m = { total: intents.length, pending: 0, processing: 0, completed: 0, failed: 0, review: 0, cancelled: 0, expired: 0 };
    const durations = []; let vol24 = 0, completedToday = 0, pendingValue = 0;
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0); const t24 = Date.now() - 86400000;
    intents.forEach((it) => { if (m[it.statusKey] != null) m[it.statusKey]++; const amt = Number(it.amount);
      if (it.statusKey === 'completed') { const dur = (it.settled || it.updated) && it.created ? (it.settled || it.updated) - it.created : null; if (dur && dur > 0) durations.push(dur); if ((it.settled || it.updated || 0) >= dayStart.getTime()) completedToday++; }
      if (['pending', 'processing', 'review'].includes(it.statusKey) && isFinite(amt)) pendingValue += amt;
      if (it.created >= t24 && isFinite(amt)) vol24 += amt; });
    const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
    const peak = durations.length ? Math.max.apply(null, durations) : null;
    const terminal = m.completed + m.failed; const success = terminal > 0 ? (m.completed / terminal) * 100 : null;
    return { ...m, avgMs: avg, peakMs: peak, successPct: success, vol24, completedToday, pendingValue, durations };
  }
  function vaultTotals() { const v = S.vault || []; const avail = v.reduce((a, r) => a + (Number(r.available) || 0), 0); const locked = v.reduce((a, r) => a + (Number(r.locked) || 0), 0); const reserved = v.reduce((a, r) => a + (Number(r.reserved) || 0), 0); const anyAvail = v.some(r => r.available != null); return { avail, locked, reserved, anyAvail }; }

  // ─── Charts ─────────────────────────────────────────────────────────────────
  function barChart(series, color, unit) { if (!series || !series.length || series.every(s => !s.value)) return `<div class="trs-empty">No data</div>`; const w = 100, h = 46, n = series.length, gap = 3; const bw = (w - gap * (n - 1)) / n; const max = Math.max(1, ...series.map(s => s.value)); let bars = ''; series.forEach((s, i) => { const bh = (s.value / max) * (h - 12); const x = i * (bw + gap); const y = (h - 10) - bh; bars += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${bw.toFixed(2)}" height="${Math.max(0.5, bh).toFixed(2)}" rx="1" fill="${color}"><title>${esc(s.label)}: ${fmtNum(s.value, 2)}${unit || ''}</title></rect>`; bars += `<text x="${(x + bw / 2).toFixed(2)}" y="${h - 1}" font-size="3.1" fill="#5f7ba0" text-anchor="middle">${esc(s.label)}</text>`; }); return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:64px;" role="img" aria-label="bar chart">${bars}</svg>`; }
  function donut(pct, color, label) { if (pct == null) return `<div class="trs-empty">No data</div>`; const r = 15.9155, c = 2 * Math.PI * r, val = Math.max(0, Math.min(100, pct)); return `<svg viewBox="0 0 42 42" style="width:80px;height:80px;" role="img" aria-label="${esc(label || 'ratio')} ${val.toFixed(0)}%"><circle cx="21" cy="21" r="${r}" fill="none" stroke="rgba(55,138,221,0.15)" stroke-width="4"></circle><circle cx="21" cy="21" r="${r}" fill="none" stroke="${color}" stroke-width="4" stroke-dasharray="${(c * val / 100).toFixed(2)} ${c.toFixed(2)}" stroke-linecap="round" transform="rotate(-90 21 21)"></circle><text x="21" y="22" font-size="8" font-weight="800" fill="#eef2fb" text-anchor="middle">${val.toFixed(0)}%</text><text x="21" y="28" font-size="3.1" fill="#5f7ba0" text-anchor="middle">${esc(label || '')}</text></svg>`; }
  function lastNDays(intents, n, valueFn) { const days = []; for (let i = n - 1; i >= 0; i--) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i); const start = d.getTime(), end = start + 86400000; let v = 0; intents.forEach((it) => { if (it.created >= start && it.created < end) v += valueFn(it); }); days.push({ label: d.toLocaleDateString('en-US', { weekday: 'short' }).slice(0, 2), value: v }); } return days; }
  function lastNWeeks(intents, n, valueFn) { const out = []; for (let i = n - 1; i >= 0; i--) { const end = Date.now() - i * 7 * 86400000, start = end - 7 * 86400000; let v = 0; intents.forEach((it) => { if (it.created >= start && it.created < end) v += valueFn(it); }); out.push({ label: 'w' + (n - i), value: v }); } return out; }
  function last24h(intents, valueFn) { const buckets = []; const now = new Date(); now.setMinutes(0, 0, 0); for (let i = 11; i >= 0; i--) { const start = now.getTime() - i * 2 * 3600000, end = start + 2 * 3600000; let v = 0; intents.forEach((it) => { if (it.created >= start && it.created < end) v += valueFn(it); }); buckets.push({ label: new Date(start).getHours() + 'h', value: v }); } return buckets; }
  function distribution(intents, keyFn, valueFn) { const map = {}; intents.forEach((it) => { const k = keyFn(it) || '—'; map[k] = (map[k] || 0) + valueFn(it); }); return Object.keys(map).map(k => ({ label: k, value: map[k] })).sort((a, b) => b.value - a.value); }

  // ─── Small UI atoms ─────────────────────────────────────────────────────────
  function kpi(icon, label, value, sub, color) { return `<div class="trs-kpi"><div class="trs-kpi-top"><span class="trs-kpi-ic" style="color:${color};"><i class="fas ${icon}"></i></span><span class="trs-kpi-label">${esc(label)}</span></div><div class="trs-kpi-val">${value}</div><div class="trs-kpi-sub">${sub || '&nbsp;'}</div></div>`; }
  function healthRow(state, label, detail) { const c = { green: '#34d399', yellow: '#fbbf24', red: '#f87171', gray: '#5f7ba0' }[state] || '#5f7ba0'; return `<div class="trs-hrow"><span class="trs-hdot" style="background:${c};box-shadow:0 0 8px ${c}66;"></span><span class="trs-hlabel">${esc(label)}</span><span class="trs-hstate" style="color:${c};margin-left:auto;">${detail != null ? esc(detail) : (state === 'gray' ? 'Unknown' : state.charAt(0).toUpperCase() + state.slice(1))}</span></div>`; }
  function compState(v) { if (v === true || v === 'online' || v === 'ok' || v === 'healthy' || v === 'up') return 'green'; if (v === false || v === 'offline' || v === 'down' || v === 'error') return 'red'; if (v === 'degraded' || v === 'warning') return 'yellow'; return 'gray'; }
  function mcell(k, v, c, note) { return `<div class="trs-mcell"><div class="trs-mk">${esc(k)}</div><div class="trs-mv" style="color:${c || '#dde6f5'};">${v}</div>${note ? `<div class="trs-dim" style="margin-top:2px;">${esc(note)}</div>` : ''}</div>`; }
  function tokenBadge(sym) { return `<span class="trs-token sm">${esc(sym)}</span>`; }

  // ─── Alerts (real thresholds) ───────────────────────────────────────────────
  function computeAlerts(dm) {
    const A = []; const now = Date.now(); const vt = vaultTotals();
    const rpcOk = S.system && S.system.rpc && S.system.rpc.ok; const rpcLat = S.system && S.system.rpc ? S.system.rpc.latency : null;
    const apiOk = S.system && S.system.status && (S.system.status.status === 'online' || S.system.status.success);
    const openQueue = dm.pending + dm.processing + dm.review;
    if (vt.anyAvail && vt.avail <= 0) A.push({ sev: 'critical', src: 'Vault', title: 'Vault liquidity depleted', action: 'Fund the Treasury Vault to resume settlements.' });
    else if (vt.anyAvail && dm.pendingValue > vt.avail && vt.avail > 0) A.push({ sev: 'warning', src: 'Liquidity', title: 'Low liquidity vs pending settlements', action: 'Reserve pressure exceeds available liquidity — add liquidity.' });
    if (!W('FulfillerEngine')) A.push({ sev: 'warning', src: 'Worker', title: 'Settlement engine unavailable', action: 'Fulfiller engine not loaded in this session.' });
    if (rpcLat != null && rpcLat > 1500) A.push({ sev: 'warning', src: 'RPC', title: 'RPC latency high (' + rpcLat + ' ms)', action: 'Consider an alternate Arc RPC endpoint.' });
    if (!rpcOk) A.push({ sev: 'critical', src: 'Bridge', title: 'Blockchain RPC unreachable', action: 'Inbound settlements cannot confirm until RPC recovers.' });
    if (!apiOk) A.push({ sev: 'critical', src: 'Treasury', title: 'Treasury API offline', action: 'ExecDaat worker /api/status is not responding.' });
    if (openQueue > 25) A.push({ sev: 'warning', src: 'Queue', title: 'Queue congestion (' + openQueue + ' open)', action: 'Monitor operator fulfillment throughput.' });
    const oldestProc = S.intents.filter(i => i.statusKey === 'processing').reduce((mn, it) => Math.min(mn, it.created || Infinity), Infinity);
    if (oldestProc !== Infinity && now - oldestProc > 1800000) A.push({ sev: 'warning', src: 'Settlement', title: 'Settlement delay detected', action: 'A processing intent has been pending > 30m — consider retry.' });
    if (dm.failed + dm.completed >= 4 && dm.successPct != null && dm.successPct < 75) A.push({ sev: 'warning', src: 'Reliability', title: 'High failure rate (' + (100 - dm.successPct).toFixed(0) + '%)', action: 'Investigate recent failed inbound settlements.' });
    const util = utilPct(); if (util != null && util > 90) A.push({ sev: 'warning', src: 'Threshold', title: 'Utilization above 90%', action: 'Liquidity nearly exhausted — replenish soon.' });
    if (S.operator.checked && S.operator.address && !S.operator.isOperator) A.push({ sev: 'info', src: 'Operator', title: 'Connected wallet is not an operator', action: 'Deposit/retry actions require an authorized operator.' });
    if (!A.length) A.push({ sev: 'ok', src: 'Treasury', title: 'All systems nominal', action: 'No active alerts for the inbound bridge.' });
    A.forEach(a => a.ts = now); return A;
  }
  function utilPct() { const vt = vaultTotals(); const dm = S.dm || deriveMetrics(S.intents); const used = vt.locked + dm.pendingValue; const total = vt.avail + used; return total > 0 ? (used / total) * 100 : null; }

  // ─── Renderers (workspace-scoped) ───────────────────────────────────────────
  function renderHeader() {
    const pill = q('trs-hdr-status'); const sync = q('trs-hdr-sync'); if (sync) sync.textContent = S.lastSync ? ('Synced ' + timeAgo(S.lastSync)) : 'Syncing…';
    if (pill) { const apiOk = S.system && S.system.status && (S.system.status.status === 'online' || S.system.status.success); const rpcOk = S.system && S.system.rpc && S.system.rpc.ok; let state = 'green', label = 'Operational'; if (!apiOk || !rpcOk) { state = 'yellow'; label = 'Degraded'; } if (!apiOk && !rpcOk) { state = 'red'; label = 'Offline'; } const c = { green: '#34d399', yellow: '#fbbf24', red: '#f87171' }[state]; pill.innerHTML = `<span class="trs-hdot" style="background:${c};box-shadow:0 0 8px ${c}66;"></span><span style="color:${c};font-weight:800;">${label}</span>`; }
    const badge = q('trs-alert-badge'); if (badge) { const alerts = computeAlerts(S.dm || deriveMetrics(S.intents)); const active = alerts.filter(a => a.sev !== 'ok'); badge.style.display = active.length ? 'inline-flex' : 'none'; badge.textContent = active.length; }
  }

  // OVERVIEW
  function renderOverviewWs() {
    const dm = S.dm; const vt = vaultTotals();
    const alerts = computeAlerts(dm);
    q('trs-overview').innerHTML =
      kpi('fa-vault', 'Total Vault Value', (vt.anyAvail || vt.locked) ? fmtUsd(vt.avail + vt.locked) : '—', TRS_NETWORK + ' pool', '#60b4ff') +
      kpi('fa-water', 'Available Liquidity', vt.anyAvail ? fmtUsd(vt.avail) : '—', 'On-chain reserves', '#34d399') +
      kpi('fa-bookmark', 'Reserved', fmtUsd(vt.reserved), dm.pending + ' queued', '#a78bfa') +
      kpi('fa-hourglass-half', 'Pending Settlement', fmtUsd(dm.pendingValue), (dm.processing + dm.review) + ' in progress', '#67e8f9') +
      kpi('fa-arrow-right-to-bracket', 'Inbound Volume 24h', fmtUsd(dm.vol24), 'External → Arc', '#a78bfa') +
      kpi('fa-check-double', 'Completed Today', String(dm.completedToday || 0), dm.total + ' total', '#34d399') +
      kpi('fa-stopwatch', 'Avg Settlement', dm.avgMs != null ? fmtDur(dm.avgMs) : '—', dm.durations.length + ' samples', '#60b4ff') +
      kpi('fa-percentage', 'Success Rate', dm.successPct != null ? dm.successPct.toFixed(1) + '%' : '—', dm.completed + ' ok / ' + dm.failed + ' failed', '#34d399');
    // Alerts
    const sevMap = { critical: { c: '#f87171', i: 'fa-triangle-exclamation' }, warning: { c: '#fbbf24', i: 'fa-circle-exclamation' }, info: { c: '#60b4ff', i: 'fa-circle-info' }, ok: { c: '#34d399', i: 'fa-circle-check' } };
    q('trs-alerts').innerHTML = alerts.map((a) => { const s = sevMap[a.sev]; return `<div class="trs-alert-row" style="border-left:3px solid ${s.c};"><i class="fas ${s.i}" style="color:${s.c};"></i><div style="flex:1;min-width:0;"><div class="trs-feed-title">${esc(a.title)} <span class="trs-chip" style="font-size:8.5px;padding:1px 6px;color:${s.c};background:rgba(0,0,0,0);border:1px solid ${s.c}55;">${esc(a.sev)}</span></div><div class="trs-dim">${esc(a.src)} · ${esc(a.action)}</div></div><div class="trs-dim" style="flex-shrink:0;">${esc(timeAgo(a.ts))}</div></div>`; }).join('');
    // Action center (capability-gated)
    renderActions('trs-actions-overview');
    renderGovernance();
    // Health
    renderHealthInto('trs-health-overview', dm);
    // Recent events
    renderEventsInto('trs-events-overview', 8);
  }

  function renderGovernance() {
    const el = q('trs-governance'); if (!el) return; const dep = DEPLOYMENT;
    if (!dep || !dep.configured || !TREASURY_ADDR) {
      el.innerHTML = `<div class="trs-dim" style="line-height:1.6;">
        <i class="fas fa-circle-info" style="color:#60b4ff;"></i> ArcTreasury (governance) & ArcVault (liquidity) contracts are auto-discovered from <span class="trs-mono">/static/treasury-deployment.json</span>. Deploy them with the provided scripts (<span class="trs-mono">contracts/deployTreasury.cjs</span>) and this page wires up automatically — no hardcoded addresses.<br>
        Currently reading the live inbound vault at <span class="trs-mono">${esc(shortAddr(VAULT_ADDR))}</span>${copyBtn(VAULT_ADDR, 'vault address')}${addrLink(VAULT_ADDR)} <span class="trs-chip" style="color:#8aaac8;background:rgba(138,170,200,0.1);border:1px solid rgba(138,170,200,0.25);"><i class="fas fa-link" style="font-size:8px;"></i>fallback</span>
      </div>`;
      return;
    }
    const g = S.governance;
    el.innerHTML = `<div class="trs-mgrid">
        ${mcell('Treasury (Governance)', shortAddr(TREASURY_ADDR), '#fbbf24')}
        ${mcell('Vault (Liquidity)', shortAddr(VAULT_ADDR), '#60b4ff')}
        ${mcell('Signers', g ? (g.signerCount + ' · thr ' + g.threshold) : '—', '#dde6f5')}
        ${mcell('Proposals', g ? (g.proposalCount + ' (' + g.executedCount + ' exec)') : '—', '#a78bfa')}
        ${mcell('Governance', g ? (g.paused ? 'Paused' : 'Active') : '—', g && g.paused ? '#f87171' : '#34d399')}
        ${mcell('Version', (dep.treasury && dep.treasury.version) || (g && g.version) || '—')}
      </div>
      <div class="trs-dim" style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;line-height:1.6;">
        <span class="trs-chip" style="color:#34d399;background:rgba(52,211,153,0.12);border:1px solid rgba(52,211,153,0.3);"><i class="fas fa-circle-check" style="font-size:8px;"></i>Auto-discovered</span>
        Treasury <span class="trs-mono">${esc(shortAddr(TREASURY_ADDR))}</span>${copyBtn(TREASURY_ADDR, 'treasury')}${addrLink(TREASURY_ADDR)} governs Vault <span class="trs-mono">${esc(shortAddr(VAULT_ADDR))}</span>${copyBtn(VAULT_ADDR, 'vault')}${addrLink(VAULT_ADDR)}
        ${g && g.vault && g.vault.toLowerCase() !== VAULT_ADDR.toLowerCase() ? '<span style="color:#fbbf24;"><i class="fas fa-triangle-exclamation"></i> vault link mismatch</span>' : ''}
      </div>
      <div class="trs-dim" style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;line-height:1.6;">
        <span class="trs-chip" style="color:#67e8f9;background:rgba(103,232,249,0.1);border:1px solid rgba(103,232,249,0.25);"><i class="fas fa-arrow-right-to-bracket" style="font-size:8px;"></i>Inbound backend</span>
        Inbound (External → Arc) settlements can be processed through this ArcVault via the operator (reserve → start → complete). Outbound (Arc → External) is 100% untouched.
        ${(() => { try { const n = W('TreasuryBridge') ? window.TreasuryBridge.records().length : 0; return n ? '<span class="trs-mono">· ' + n + ' vault settlement record' + (n === 1 ? '' : 's') + '</span>' : ''; } catch (_) { return ''; } })()}
      </div>`;
  }

  function renderActions(containerId) {
    const el = q(containerId); if (!el) return; const op = S.operator.isOperator;
    const btn = (label, icon, on, extra) => `<button class="trs-btn ${extra || ''}" onclick="${on}"><i class="fas ${icon}"></i>${label}</button>`;
    let html = '';
    html += btn('Refresh Treasury', 'fa-rotate', 'trsRefreshNow()');
    html += btn('Refresh Liquidity', 'fa-water', 'trsVaultRefresh()');
    html += btn('Refresh Vault', 'fa-vault', 'trsVaultRefresh()');
    html += btn('Refresh Workers', 'fa-microchip', 'treasuryRefresh()');
    // Retry — only if operator + engine present + there is a retryable intent
    const retryable = S.intents.find(i => ['review', 'processing', 'failed'].includes(i.statusKey));
    if (op && W('FulfillerEngine') && retryable) html += btn('Retry Settlement', 'fa-rotate-right', `trsRetryIntent('${esc(String(retryable.id))}')`, 'trs-btn-primary');
    html += btn('Export Treasury', 'fa-file-export', 'trsExport("treasury")');
    html += btn('Export Liquidity', 'fa-file-export', 'trsExport("liquidity")');
    html += btn('Export Vault', 'fa-file-export', 'trsExport("vault")');
    html += btn('Copy JSON', 'fa-code', 'trsCopyJson()');
    html += `<a class="trs-btn" href="${TRS_EXPLORER}/address/${VAULT_ADDR}" target="_blank" rel="noopener"><i class="fas fa-external-link-alt"></i>Open Explorer</a>`;
    el.innerHTML = `<div class="trs-actions">${html}</div>`;
  }

  function renderHealthInto(id, dm) {
    const el = q(id); if (!el) return; const comp = (S.health && S.health.components) || {}; const meta = (S.health && S.health.meta) || null;
    const rpcOk = S.system && S.system.rpc && S.system.rpc.ok; const apiOk = S.system && S.system.status && (S.system.status.status === 'online' || S.system.status.success);
    const vt = vaultTotals(); const openQueue = dm.pending + dm.processing + dm.review;
    const treasuryOnline = meta && meta.ok === true ? 'green' : (Object.keys(comp).length ? compState(comp.treasury) : (apiOk ? 'green' : 'gray'));
    const liqState = vt.anyAvail ? (vt.avail > 0 ? (vt.avail >= dm.pendingValue ? 'green' : 'yellow') : 'red') : 'gray';
    el.innerHTML = healthRow(treasuryOnline, 'Treasury Online') + healthRow(comp.bridge != null ? compState(comp.bridge) : (rpcOk ? 'green' : 'yellow'), 'Inbound Bridge') + healthRow(openQueue > 25 ? 'yellow' : 'green', 'Intent Queue') + healthRow(liqState, 'Vault Liquidity') + healthRow(comp.relayer != null ? compState(comp.relayer) : (rpcOk ? 'green' : 'gray'), 'Settlement Engine') + healthRow(comp.workers != null ? compState(comp.workers) : (apiOk ? 'green' : 'red'), 'Worker Connected') + healthRow(apiOk ? 'green' : 'red', 'API Connected') + healthRow(rpcOk ? 'green' : 'red', 'Blockchain Connected');
  }

  function eventStream(intents, limit) {
    const ev = [];
    intents.forEach((it) => { const tag = shortHash(String(it.intentId || it.id)) + ' · ' + it.asset + ' ' + (it.amount != null ? fmtNum(it.amount, 2) : '') + ' · ' + chainName(it.srcChain) + ' → Arc';
      if (it.created) ev.push({ ts: it.created, sev: 'info', icon: 'fa-plus-circle', color: '#60b4ff', title: 'Intent Created', chain: it.srcChain, tx: it.txHash, sub: tag });
      if (it.statusKey === 'pending') ev.push({ ts: it.updated || it.created, sev: 'info', icon: 'fa-bookmark', color: '#a78bfa', title: 'Liquidity Reserved', chain: it.srcChain, sub: tag });
      if (it.fulfilled || it.statusKey === 'processing') ev.push({ ts: it.fulfilled || it.updated || it.created, sev: 'info', icon: 'fa-bolt', color: '#67e8f9', title: 'Settlement Started', chain: it.srcChain, tx: it.arcTx, sub: tag });
      if (it.statusKey === 'completed') { ev.push({ ts: it.settled || it.updated, sev: 'success', icon: 'fa-check-circle', color: '#34d399', title: 'Settlement Confirmed', chain: it.srcChain, tx: it.settleTx, sub: tag }); ev.push({ ts: (it.settled || it.updated) + 1, sev: 'success', icon: 'fa-unlock', color: '#34d399', title: 'Liquidity Released', chain: it.srcChain, sub: tag }); }
      if (it.statusKey === 'failed') ev.push({ ts: it.updated || it.created, sev: 'error', icon: 'fa-times-circle', color: '#f87171', title: 'Settlement Failed', chain: it.srcChain, sub: (it.error ? esc(it.error) : tag) });
      if (it.statusKey === 'review') ev.push({ ts: it.updated || it.created, sev: 'warning', icon: 'fa-user-shield', color: '#c084fc', title: 'Awaiting Operator', chain: it.srcChain, sub: tag }); });
    ev.sort((a, b) => b.ts - a.ts); return ev.slice(0, limit || 16);
  }
  function renderEventsInto(id, limit) {
    const el = q(id); if (!el) return; const ev = eventStream(S.intents, limit); if (!ev.length) { el.innerHTML = `<div class="trs-empty">No inbound events yet.</div>`; return; }
    const sc = { info: '#60b4ff', success: '#34d399', warning: '#fbbf24', error: '#f87171' };
    el.innerHTML = `<div class="trs-feed">${ev.map((e, i) => `<div class="trs-feed-item"><div class="trs-feed-rail"><span class="trs-feed-dot" style="border-color:${e.color};color:${e.color};"><i class="fas ${e.icon}"></i></span>${i < ev.length - 1 ? '<span class="trs-feed-line"></span>' : ''}</div><div style="flex:1;min-width:0;"><div class="trs-feed-title">${esc(e.title)} <span class="trs-chip" style="font-size:8.5px;padding:1px 6px;color:${sc[e.sev]};background:rgba(0,0,0,0);border:1px solid ${sc[e.sev]}55;">${esc(e.sev)}</span>${e.tx ? txLink(e.tx, 'tx', e.chain ? chainExplorer(e.chain) : TRS_EXPLORER) : ''}</div><div class="trs-dim trs-mono" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${e.sub}</div></div><div class="trs-dim" style="flex-shrink:0;">${esc(timeAgo(e.ts))}</div></div>`).join('')}</div>`;
  }

  // VAULT
  function renderVaultWs() {
    const dm = S.dm; const vt = vaultTotals(); const pending = dm.pendingValue || 0;
    const capacity = vt.avail; const used = vt.locked + pending; const totalCap = vt.avail + used; const util = totalCap > 0 ? (used / totalCap) * 100 : null;
    const health = !vt.anyAvail ? 'gray' : (vt.avail <= 0 ? 'red' : (vt.avail < pending ? 'yellow' : 'green')); const hc = { green: '#34d399', yellow: '#fbbf24', red: '#f87171', gray: '#5f7ba0' }[health];
    q('trs-vault-dash').innerHTML = `<div class="trs-mgrid">
      ${mcell('Total Vault Value', (vt.anyAvail || vt.locked) ? fmtUsd(vt.avail + vt.locked) : '—')}
      ${mcell('Available', vt.anyAvail ? fmtUsd(vt.avail) : '—', '#34d399')}
      ${mcell('Reserved', fmtUsd(vt.reserved), '#a78bfa')}
      ${mcell('Locked', vt.locked ? fmtUsd(vt.locked) : (vt.anyAvail ? fmtUsd(0) : '—'), '#fbbf24')}
      ${mcell('Pending Settlement', fmtUsd(pending), '#67e8f9')}
      ${mcell('Settlement Capacity', vt.anyAvail ? fmtUsd(capacity) : '—')}
      ${mcell('Utilization', util != null ? util.toFixed(1) + '%' : '—')}
      ${mcell('Health', `<span style="color:${hc};display:inline-flex;align-items:center;gap:6px;"><span class="trs-hdot" style="background:${hc};box-shadow:0 0 8px ${hc}66;"></span>${health === 'gray' ? 'Unknown' : health.charAt(0).toUpperCase() + health.slice(1)}</span>`)}
    </div>`;
    // Per-asset
    q('trs-vault-assets').innerHTML = (S.vault || []).length ? `<div class="trs-liq-wrap">${S.vault.map((r) => `<div class="trs-liq"><div class="trs-liq-head"><span class="trs-token">${esc(r.asset)}</span>${VAULT_ASSETS[r.asset] ? addrLink(VAULT_ASSETS[r.asset]) : ''}</div><div class="trs-liq-grid4"><div><div class="trs-liq-k">Available</div><div class="trs-liq-v" style="color:#34d399;">${r.available != null ? fmtNum(r.available, 2) : '—'}</div></div><div><div class="trs-liq-k">Reserved</div><div class="trs-liq-v" style="color:#a78bfa;">${fmtNum(r.reserved || 0, 2)}</div></div><div><div class="trs-liq-k">Locked</div><div class="trs-liq-v" style="color:#fbbf24;">${r.locked != null ? fmtNum(r.locked, 2) : (r.available != null ? '0.00' : '—')}</div></div><div><div class="trs-liq-k">Pending</div><div class="trs-liq-v" style="color:#67e8f9;">${fmtNum(r.pending || 0, 2)}</div></div></div></div>`).join('')}</div>` : `<div class="trs-empty">No vault balances available.</div>`;
    // Operations with capability detection
    renderVaultOps();
    // Explorer + history
    renderVaultExplorer();
    renderVaultHistory();
  }

  function renderVaultOps() {
    const el = q('trs-vault-ops'); if (!el) return; const op = S.operator; const caps = S.caps;
    const opBadge = op.checked ? (op.isOperator ? `<span class="trs-chip" style="color:#34d399;background:rgba(52,211,153,0.12);border:1px solid rgba(52,211,153,0.3);"><i class="fas fa-user-shield" style="font-size:8px;"></i>Operator</span>` : `<span class="trs-chip" style="color:#8aaac8;background:rgba(55,138,221,0.08);border:1px solid rgba(55,138,221,0.16);"><i class="fas fa-eye" style="font-size:8px;"></i>Read-only</span>`) : '';
    // capability chips
    const capChip = (label, on, why) => `<span class="trs-chip" title="${esc(why)}" style="color:${on ? '#34d399' : '#8aaac8'};background:rgba(${on ? '52,211,153' : '138,170,200'},0.1);border:1px solid rgba(${on ? '52,211,153' : '138,170,200'},0.25);"><i class="fas ${on ? 'fa-circle-check' : 'fa-circle-xmark'}" style="font-size:8px;"></i>${label}</span>`;
    const depOn = caps.checked && caps.deposit; const wOn = caps.checked && caps.withdraw;
    // deposit button
    const depBtn = depOn
      ? `<button class="trs-btn trs-btn-primary" ${op.isOperator ? '' : 'disabled title="Connect an authorized operator wallet"'} onclick="trsOpenDeposit()"><i class="fas fa-arrow-down-to-line"></i>Deposit Funds</button>`
      : `<button class="trs-btn" disabled title="Direct deposits are not supported by the current Treasury implementation."><i class="fas fa-arrow-down-to-line"></i>Deposit Funds</button>`;
    const wBtn = wOn
      ? `<button class="trs-btn" ${op.isOperator ? '' : 'disabled title="Requires an authorized operator wallet"'} onclick="trsOpenWithdraw()"><i class="fas fa-arrow-up-from-line"></i>Withdraw Funds</button>`
      : `<button class="trs-btn" disabled title="This Treasury Vault does not expose a public withdraw function."><i class="fas fa-arrow-up-from-line"></i>Withdraw Funds</button>`;
    el.innerHTML = `<div class="trs-sub" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">Vault operations ${opBadge} ${caps.checked ? (capChip('Deposit', depOn, caps.note) + capChip('Withdraw', wOn, wOn ? ('detected ' + caps.withdrawSig) : 'no public withdraw function detected in bytecode')) : '<span class="trs-dim">detecting capabilities…</span>'}</div>
      <div class="trs-actions">
        <button class="trs-btn" onclick="trsVaultRefresh()"><i class="fas fa-rotate"></i>Refresh Vault</button>
        ${depBtn}${wBtn}
        <button class="trs-btn" onclick="trsVaultTransactions()"><i class="fas fa-list"></i>View Transactions</button>
        <button class="trs-btn" onclick="trsExport('vault')"><i class="fas fa-file-export"></i>Export History</button>
        <a class="trs-btn" href="${TRS_EXPLORER}/address/${VAULT_ADDR}" target="_blank" rel="noopener"><i class="fas fa-external-link-alt"></i>Open Explorer</a>
      </div>
      <div class="trs-dim" style="margin-top:8px;line-height:1.5;">
        <i class="fas fa-shield-halved" style="color:#5f7ba0;"></i> Vault <span class="trs-mono">${esc(shortAddr(VAULT_ADDR))}</span>${copyBtn(VAULT_ADDR, 'vault address')} · Owner <span class="trs-mono">${esc(shortAddr(VAULT_OWNER))}</span><br>
        ${caps.checked ? (depOn ? `Deposit enabled — ${esc(caps.note)}.` : 'Direct deposits are not supported by the current Treasury implementation.') + ' ' + (wOn ? 'Withdraw enabled — ' + esc(caps.withdrawSig) + ' detected on-chain.' : 'This Treasury Vault does not expose a public withdraw function.') : 'Detecting on-chain vault capabilities…'}
      </div>`;
  }

  function renderVaultExplorer() {
    const el = q('trs-vault-explorer'); if (!el) return;
    const settled = S.intents.filter(i => i.statusKey === 'completed');
    const largestSettlements = settled.slice().sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0)).slice(0, 5);
    const ev = S.vaultEvents || [];
    const deposits = ev.filter(e => e.kind === 'Deposit / Funding');
    const consumption = ev.filter(e => e.kind === 'Withdrawal / Outflow' || e.kind === 'Settlement Consumption');
    const largestDeposits = deposits.slice().sort((a, b) => (b.amountH || 0) - (a.amountH || 0)).slice(0, 5);
    const vt = vaultTotals();
    const alloc = (S.vault || []).filter(r => r.available != null && r.available > 0);
    const allocTotal = alloc.reduce((a, r) => a + r.available, 0);
    el.innerHTML = `
      <div class="trs-grid-2">
        <div>
          <div class="trs-sub" style="margin-top:0;">Current Holdings</div>
          <div class="trs-mgrid">${(S.vault || []).map(r => mcell(r.asset, r.available != null ? fmtNum(r.available, 2) : '—', '#34d399')).join('') || '<div class="trs-empty">No holdings</div>'}</div>
          <div class="trs-sub">Asset Allocation</div>
          ${alloc.length ? alloc.map(r => { const pct = allocTotal > 0 ? (r.available / allocTotal) * 100 : 0; return `<div style="margin-bottom:8px;"><div style="display:flex;justify-content:space-between;font-size:11px;color:#9db8d8;margin-bottom:3px;"><span>${esc(r.asset)}</span><span>${pct.toFixed(1)}%</span></div><div class="trs-bar"><div class="trs-bar-fill" style="width:${pct}%;background:#34d399;"></div></div></div>`; }).join('') : '<div class="trs-empty">No allocation data</div>'}
        </div>
        <div>
          <div class="trs-sub" style="margin-top:0;">Largest Settlements (consumption)</div>
          ${largestSettlements.length ? largestSettlements.map(it => `<div class="trs-mini-row" onclick="trsOpenIntent('${esc(String(it.id))}')"><span class="trs-token sm">${esc(it.asset)}</span><span class="trs-mono" style="flex:1;">${esc(shortHash(String(it.intentId || it.id)))}</span><span style="font-weight:800;color:#34d399;">${fmtNum(it.amount, 2)}</span></div>`).join('') : '<div class="trs-empty">No settlements yet</div>'}
          <div class="trs-sub">Largest Deposits (on-chain)</div>
          ${S.vaultEvents == null ? '<div class="trs-empty">Load vault events to view funding.</div>' : (largestDeposits.length ? largestDeposits.map(e => `<div class="trs-mini-row"><span class="trs-token sm">${esc(e.asset)}</span><span class="trs-mono" style="flex:1;">${esc(shortHash(e.tx || ''))}</span><span style="font-weight:800;color:#60b4ff;">${fmtNum(e.amountH || 0, 2)}</span>${txLink(e.tx, 'deposit')}</div>`).join('') : '<div class="trs-empty">No funding events found</div>')}
        </div>
      </div>`;
  }

  function renderVaultHistory() {
    const el = q('trs-vault-history'); if (!el) return;
    if (S.vaultEvents == null) { el.innerHTML = `<div class="trs-empty"><button class="trs-btn" onclick="trsLoadVaultEvents()"><i class="fas fa-cloud-arrow-down"></i>Load Vault History from chain</button><div class="trs-dim" style="margin-top:8px;">Reads real ERC-20 & vault settlement events from Arc Testnet.</div></div>`; return; }
    if (S.vaultEventsLoading) { el.innerHTML = `<div class="trs-empty"><i class="fas fa-spinner fa-spin"></i> Loading vault events…</div>`; return; }
    const ev = S.vaultEvents.slice(0, 40);
    if (!ev.length) { el.innerHTML = `<div class="trs-empty">No vault events found in the recent block window.<br><a class="trs-btn" style="margin-top:8px;" href="${TRS_EXPLORER}/address/${VAULT_ADDR}" target="_blank" rel="noopener"><i class="fas fa-external-link-alt"></i>Open Vault on ArcScan</a></div>`; return; }
    const kindColor = { 'Deposit / Funding': '#60b4ff', 'Withdrawal / Outflow': '#fbbf24', 'Settlement Consumption': '#34d399', 'Liquidity Release': '#67e8f9', 'Fee Collected': '#a78bfa' };
    el.innerHTML = `<div class="trs-tablewrap"><table class="trs-table"><thead><tr><th scope="col">Type</th><th scope="col">Asset</th><th scope="col">Amount</th><th scope="col">Counterparty</th><th scope="col">Time</th><th scope="col">Tx</th></tr></thead><tbody>${ev.map((e) => `<tr><td><span class="trs-chip" style="color:${kindColor[e.kind] || '#8aaac8'};background:rgba(0,0,0,0);border:1px solid ${(kindColor[e.kind] || '#8aaac8')}55;">${esc(e.kind)}</span></td><td>${e.asset ? tokenBadge(e.asset) : '—'}</td><td class="trs-mono">${e.amountH != null ? fmtNum(e.amountH, 2) : '—'}</td><td class="trs-mono trs-dim">${esc(shortAddr(e.from || e.to || (e.parsed && e.parsed.args && (e.parsed.args.settler || e.parsed.args.fulfiller)) || ''))}</td><td class="trs-dim">${e.ts ? timeAgo(e.ts) : ('#' + fmtNum(e.block))}</td><td>${e.tx ? `<span class="trs-mono trs-dim">${esc(shortHash(e.tx))}</span>${copyBtn(e.tx, 'tx')}${txLink(e.tx, 'tx')}` : '—'}</td></tr>`).join('')}</tbody></table></div>`;
  }

  // INTENTS (with pagination — handles thousands)
  function filteredIntents() { let arr = S.intents.slice(); const s = S.search.trim().toLowerCase(); if (s) arr = arr.filter(it => [it.id, it.intentId, it.asset, it.sender, it.recipient, it.txHash, it.settleTx, it.srcChain, it.dstChain].some(v => String(v || '').toLowerCase().includes(s))); if (S.fStatus !== 'all') arr = arr.filter(it => it.statusKey === S.fStatus); if (S.fAsset !== 'all') arr = arr.filter(it => String(it.asset).toLowerCase() === S.fAsset); if (S.fChain !== 'all') arr = arr.filter(it => String(it.srcChain || '').toLowerCase() === S.fChain); const dir = S.sortDir === 'asc' ? 1 : -1; arr.sort((a, b) => { let va, vb; switch (S.sortKey) { case 'amount': va = Number(a.amount) || 0; vb = Number(b.amount) || 0; break; case 'status': va = a.statusKey; vb = b.statusKey; break; case 'asset': va = a.asset; vb = b.asset; break; case 'updated': va = a.updated || a.created; vb = b.updated || b.created; break; default: va = a.created; vb = b.created; } if (va < vb) return -1 * dir; if (va > vb) return 1 * dir; return 0; }); return arr; }
  function renderIntents() {
    const el = q('trs-intents'); if (!el) return; const pager = q('trs-intents-pager');
    const all = filteredIntents(); const totalPages = Math.max(1, Math.ceil(all.length / S.pageSize)); if (S.page > totalPages) S.page = totalPages;
    const rows = all.slice((S.page - 1) * S.pageSize, (S.page - 1) * S.pageSize + S.pageSize);
    if (!S.intents.length) { el.innerHTML = `<div class="trs-empty">No inbound intents found. External → Arc transfers appear here as created.</div>`; if (pager) pager.innerHTML = ''; return; }
    if (!rows.length) { el.innerHTML = `<div class="trs-empty">No intents match the current filters.</div>`; if (pager) pager.innerHTML = ''; return; }
    const arrow = (k) => S.sortKey === k ? (S.sortDir === 'asc' ? ' <i class="fas fa-caret-up"></i>' : ' <i class="fas fa-caret-down"></i>') : '';
    const th = (k, l) => `<th scope="col"><button class="trs-th" onclick="trsSort('${k}')" aria-label="Sort by ${esc(l)}">${esc(l)}${arrow(k)}</button></th>`;
    el.innerHTML = `<div class="trs-tablewrap"><table class="trs-table"><thead><tr><th scope="col">Intent</th>${th('asset', 'Asset')}${th('amount', 'Amount')}<th scope="col">Origin → Arc</th>${th('status', 'Status')}${th('created', 'Created')}${th('updated', 'Updated')}<th scope="col">Time</th><th scope="col" style="text-align:right;">Actions</th></tr></thead><tbody>${rows.map((it) => { const dur = it.statusKey === 'completed' && it.created ? fmtDur((it.settled || it.updated) - it.created) : (['pending', 'processing', 'review'].includes(it.statusKey) ? timeAgo(it.created) : '—'); return `<tr tabindex="0" class="trs-tr" onclick="trsOpenIntent('${esc(String(it.id))}')" onkeydown="if(event.key==='Enter'){trsOpenIntent('${esc(String(it.id))}')}"><td><span class="trs-mono">${esc(shortHash(String(it.intentId || it.id)))}</span></td><td>${tokenBadge(it.asset)}</td><td class="trs-mono">${it.amount != null ? fmtNum(it.amount, 2) : '—'}</td><td><span class="trs-route">${esc(chainName(it.srcChain))} <i class="fas fa-arrow-right" style="font-size:8px;color:#5f7ba0;"></i> Arc</span></td><td>${statusChip(it.statusKey)}</td><td class="trs-dim">${esc(timeAgo(it.created))}</td><td class="trs-dim">${esc(timeAgo(it.updated || it.created))}</td><td class="trs-dim">${esc(dur)}</td><td style="text-align:right;"><button class="trs-ic" title="Open details" aria-label="Open intent details" onclick="event.stopPropagation();trsOpenIntent('${esc(String(it.id))}')"><i class="fas fa-up-right-from-square"></i></button></td></tr>`; }).join('')}</tbody></table></div>`;
    if (pager) pager.innerHTML = `<span class="trs-dim">${all.length} intent${all.length === 1 ? '' : 's'} · page ${S.page}/${totalPages}</span><div style="display:flex;gap:6px;align-items:center;"><label class="trs-dim" for="trs-pagesize" style="font-size:11px;">Rows</label><select id="trs-pagesize" class="trs-select" onchange="trsPageSize(this.value)" aria-label="Rows per page">${[12, 25, 50, 100].map(n => `<option value="${n}" ${S.pageSize === n ? 'selected' : ''}>${n}</option>`).join('')}</select><button class="trs-pgbtn" onclick="trsPage(${S.page - 1})" ${S.page <= 1 ? 'disabled' : ''} aria-label="Previous page"><i class="fas fa-chevron-left"></i></button><button class="trs-pgbtn" onclick="trsPage(${S.page + 1})" ${S.page >= totalPages ? 'disabled' : ''} aria-label="Next page"><i class="fas fa-chevron-right"></i></button></div>`;
    syncFilterOptions();
  }
  function syncFilterOptions() { const assets = Array.from(new Set(S.intents.map(i => String(i.asset).toLowerCase()).filter(Boolean))).sort(); const chains = Array.from(new Set(S.intents.map(i => String(i.srcChain || '').toLowerCase()).filter(Boolean))).sort(); const aSel = q('trs-filter-asset'), cSel = q('trs-filter-chain'); if (aSel && aSel.dataset.count !== String(assets.length)) { aSel.dataset.count = String(assets.length); aSel.innerHTML = `<option value="all">All assets</option>` + assets.map(a => `<option value="${esc(a)}" ${S.fAsset === a ? 'selected' : ''}>${esc(a.toUpperCase())}</option>`).join(''); } if (cSel && cSel.dataset.count !== String(chains.length)) { cSel.dataset.count = String(chains.length); cSel.innerHTML = `<option value="all">All origins</option>` + chains.map(c => `<option value="${esc(c)}" ${S.fChain === c ? 'selected' : ''}>${esc(chainName(c))}</option>`).join(''); } }

  // SETTLEMENTS — pipeline
  function renderSettlementsWs() {
    const dm = S.dm;
    const stages = [
      { key: 'Created', count: dm.total, color: '#60b4ff', icon: 'fa-plus-circle' },
      { key: 'Validated', count: dm.total - dm.failed, color: '#93c5fd', icon: 'fa-clipboard-check' },
      { key: 'Liquidity Reserved', count: dm.pending + dm.processing + dm.review + dm.completed, color: '#a78bfa', icon: 'fa-bookmark' },
      { key: 'Settlement Started', count: dm.processing + dm.review + dm.completed, color: '#67e8f9', icon: 'fa-bolt' },
      { key: 'Settlement Confirmed', count: dm.completed, color: '#34d399', icon: 'fa-check-circle' },
      { key: 'Released', count: dm.completed, color: '#34d399', icon: 'fa-unlock' },
      { key: 'Completed', count: dm.completed, color: '#34d399', icon: 'fa-flag-checkered' },
    ];
    q('trs-pipeline').innerHTML = `<div class="trs-pipe">${stages.map((s, i) => `<div class="trs-pipe-stage"><div class="trs-pipe-dot" style="border-color:${s.color};color:${s.color};"><i class="fas ${s.icon}"></i></div><div class="trs-pipe-count" style="color:${s.color};">${s.count}</div><div class="trs-dim" style="text-align:center;">${esc(s.key)}</div></div>${i < stages.length - 1 ? `<div class="trs-pipe-arrow"><i class="fas fa-chevron-right"></i></div>` : ''}`).join('')}</div>
      <div class="trs-dim" style="margin-top:10px;">Failed: <span style="color:#f87171;font-weight:700;">${dm.failed}</span> · Manual review: <span style="color:#c084fc;font-weight:700;">${dm.review}</span> · Avg settle: ${dm.avgMs != null ? fmtDur(dm.avgMs) : '—'} · Peak: ${dm.peakMs != null ? fmtDur(dm.peakMs) : '—'}</div>`;
    // recent settlements
    const settled = S.intents.filter(i => i.statusKey === 'completed').sort((a, b) => (b.settled || b.updated || 0) - (a.settled || a.updated || 0)).slice(0, 12);
    // Treasury Vault settlements (real, from the deployed ArcVault via TreasuryBridge)
    const vsEl = q('trs-vault-settlements');
    if (vsEl) {
      let recs = []; try { recs = (W('TreasuryBridge') ? window.TreasuryBridge.records() : []) || []; } catch (_) {}
      recs = recs.filter(r => r && (r.status === 'completed' || r.status === 'observed')).sort((a, b) => (b.settledAt || 0) - (a.settledAt || 0)).slice(0, 12);
      vsEl.innerHTML = recs.length ? recs.map((r) => `<div class="trs-settle"><span class="trs-settle-ic"><i class="fas fa-vault" style="color:#f59e0b;"></i></span><div style="flex:1;min-width:0;"><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;"><span class="trs-mono" style="color:#cdd8ea;">${esc(shortHash(String(r.intentId)))}</span>${tokenBadge(r.asset || '—')}<span style="font-weight:800;color:#34d399;">${r.amount != null ? fmtNum(r.amount, 2) : '—'}</span><span class="trs-dim">${esc(chainName(r.origin))} → Arc · ${r.source === 'existing-bridge' ? 'Turbo Bridge' : 'ArcVault'}</span></div><div class="trs-dim" style="margin-top:2px;">${esc(fmtDate(r.settledAt))}${r.settlementTime ? ' · ' + fmtDur(r.settlementTime) : ''}</div></div><div style="display:flex;align-items:center;gap:5px;flex-shrink:0;">${r.settleTx ? `<span class="trs-mono trs-dim">${esc(shortHash(r.settleTx))}</span>${copyBtn(r.settleTx, 'tx')}${txLink(r.settleTx, 'settlement')}` : `<span class="trs-dim">—</span>`}</div></div>`).join('') : `<div class="trs-empty">No Treasury Vault settlements yet. Open an inbound intent and use <b>Settle via Vault</b> (operator) to process one through the deployed ArcVault.</div>`;
    }
    q('trs-settlements-list').innerHTML = settled.length ? settled.map((it) => `<div class="trs-settle" onclick="trsOpenIntent('${esc(String(it.id))}')" style="cursor:pointer;"><span class="trs-settle-ic"><i class="fas fa-check" style="color:#34d399;"></i></span><div style="flex:1;min-width:0;"><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;"><span class="trs-mono" style="color:#cdd8ea;">${esc(shortHash(String(it.intentId || it.id)))}</span>${tokenBadge(it.asset)}<span style="font-weight:800;color:#34d399;">${it.amount != null ? fmtNum(it.amount, 2) : '—'}</span><span class="trs-dim">${esc(chainName(it.srcChain))} → Arc · ${it.created && it.settled ? fmtDur(it.settled - it.created) : '—'}</span></div><div class="trs-dim" style="margin-top:2px;">${esc(fmtDate(it.settled || it.updated))}</div></div><div style="display:flex;align-items:center;gap:5px;flex-shrink:0;" onclick="event.stopPropagation();">${it.settleTx ? `<span class="trs-mono trs-dim">${esc(shortHash(it.settleTx))}</span>${copyBtn(it.settleTx, 'tx hash')}${txLink(it.settleTx, 'settlement')}` : `<span class="trs-dim">no tx</span>`}</div></div>`).join('') : `<div class="trs-empty">No inbound settlements recorded yet.</div>`;
  }

  // MINT — operator delivers vault liquidity to inbound intent recipients (Turbo <-> Treasury)
  function renderMintWs() {
    const liqEl = q('trs-mint-liquidity');
    if (liqEl) {
      liqEl.innerHTML = (S.vault || []).length
        ? `<div class="trs-liq-wrap">${S.vault.map((r) => `<div class="trs-liq"><div class="trs-liq-head"><span class="trs-token">${esc(r.asset)}</span></div><div class="trs-liq-grid"><div><div class="trs-liq-k">Mintable (available)</div><div class="trs-liq-v" style="color:#34d399;">${r.available != null ? fmtNum(r.available, 2) : '—'}</div></div><div><div class="trs-liq-k">Locked</div><div class="trs-liq-v" style="color:#fbbf24;">${r.locked != null ? fmtNum(r.locked, 2) : (r.available != null ? '0.00' : '—')}</div></div><div><div class="trs-liq-k">Pending</div><div class="trs-liq-v" style="color:#67e8f9;">${fmtNum(r.pending || 0, 2)}</div></div></div></div>`).join('')}</div>`
        : `<div class="trs-empty">No vault liquidity data. Fund the vault from the Vault workspace before minting.</div>`;
    }
    const opEl = q('trs-mint-operator');
    const configured = !!(DEPLOYMENT && DEPLOYMENT.configured && TREASURY_ADDR && W('TreasuryBridge'));
    if (opEl) {
      const addr = S.operator.address; let msg, bg, col, ic;
      if (!configured) { msg = 'Treasury Vault not configured/deployed — minting unavailable.'; bg = 'rgba(239,68,68,0.10)'; col = '#f87171'; ic = 'fa-triangle-exclamation'; }
      else if (!addr) { msg = 'Connect your wallet to mint/settle inbound intents.'; bg = 'rgba(245,158,11,0.10)'; col = '#fbbf24'; ic = 'fa-wallet'; }
      else if (!S.operator.isOperator) { msg = 'Wallet ' + shortAddr(addr) + ' is not an authorized Vault operator — minting disabled.'; bg = 'rgba(245,158,11,0.10)'; col = '#fbbf24'; ic = 'fa-user-shield'; }
      else { msg = 'Operator ' + shortAddr(addr) + ' authorized — deliver vault liquidity to intent recipients on Arc.'; bg = 'rgba(52,211,153,0.10)'; col = '#34d399'; ic = 'fa-user-shield'; }
      opEl.innerHTML = `<div style="display:flex;align-items:center;gap:9px;background:${bg};border:1px solid ${col}33;border-radius:10px;padding:9px 12px;font-size:12px;color:${col};font-weight:700;"><i class="fas ${ic}"></i><span>${esc(msg)}</span></div>`;
    }
    const el = q('trs-mint-queue'); if (!el) return;
    const canMint = S.operator.isOperator && configured;
    const pend = S.intents.filter((it) => ['pending', 'processing', 'review'].includes(it.statusKey));
    if (!pend.length) { el.innerHTML = `<div class="trs-empty">No inbound intents awaiting mint. External → Arc transfers appear here until settled.</div>`; return; }
    el.innerHTML = `<div class="trs-tablewrap"><table class="trs-table"><thead><tr><th scope="col">Intent</th><th scope="col">Asset</th><th scope="col">Amount</th><th scope="col">Origin → Arc</th><th scope="col">Recipient</th><th scope="col">Status</th><th scope="col" style="text-align:right;">Action</th></tr></thead><tbody>${pend.map((it) => {
      const rcpt = it.recipient || it.sender;
      return `<tr class="trs-tr"><td><span class="trs-mono">${esc(shortHash(String(it.intentId || it.id)))}</span></td><td>${tokenBadge(it.asset)}</td><td class="trs-mono">${it.amount != null ? fmtNum(it.amount, 2) : '—'}</td><td><span class="trs-route">${esc(chainName(it.srcChain))} <i class="fas fa-arrow-right" style="font-size:8px;color:#5f7ba0;"></i> Arc</span></td><td class="trs-mono" title="${esc(rcpt || '')}">${esc(shortAddr(rcpt))}</td><td>${statusChip(it.statusKey)}</td><td style="text-align:right;">${canMint ? `<button class="trs-btn trs-btn-sm trs-btn-primary" onclick="trsSettleViaTreasury('${esc(String(it.id))}')"><i class="fas fa-hand-holding-dollar"></i>Mint</button>` : `<button class="trs-btn trs-btn-sm" onclick="trsOpenIntent('${esc(String(it.id))}')"><i class="fas fa-up-right-from-square"></i>View</button>`}</td></tr>`;
    }).join('')}</tbody></table></div><div class="trs-dim" style="margin-top:10px;"><i class="fas fa-circle-info" style="color:#60b4ff;"></i> Minting runs the on-chain lifecycle on the ArcVault (<b>reserve → start → complete</b>), delivering the asset to the recipient on Arc and finalizing the Turbo intent. The outbound Arc → External route is never touched.</div>`;
  }

  // LIQUIDITY — assets, heatmap, reserves, forecast
  function renderLiquidityWs() {
    const dm = S.dm; const vt = vaultTotals();
    // per-asset
    q('trs-liq-assets').innerHTML = (S.vault || []).length ? `<div class="trs-liq-wrap">${S.vault.map((r) => `<div class="trs-liq"><div class="trs-liq-head"><span class="trs-token">${esc(r.asset)}</span></div><div class="trs-liq-grid"><div><div class="trs-liq-k">Available</div><div class="trs-liq-v" style="color:#34d399;">${r.available != null ? fmtUsd(r.available) : '—'}</div></div><div><div class="trs-liq-k">Locked</div><div class="trs-liq-v" style="color:#fbbf24;">${r.locked != null ? fmtUsd(r.locked) : (r.available != null ? fmtUsd(0) : '—')}</div></div><div><div class="trs-liq-k">Pending</div><div class="trs-liq-v" style="color:#67e8f9;">${fmtUsd(r.pending || 0)}</div></div></div></div>`).join('')}</div>` : `<div class="trs-empty">No liquidity data.</div>`;
    // heatmap origin × asset (reserved+pending value)
    const chains = Array.from(new Set(S.intents.map(i => String(i.srcChain || 'unknown')))).filter(Boolean);
    const assets = Array.from(new Set(S.intents.map(i => String(i.asset).toUpperCase()).filter(Boolean)));
    if (!chains.length || !assets.length) { q('trs-heatmap').innerHTML = `<div class="trs-empty">No inbound flows yet — heatmap populates as intents arrive.</div>`; }
    else {
      const cell = {}; let max = 0; S.intents.forEach((it) => { if (!['pending', 'processing', 'review'].includes(it.statusKey)) return; const c = String(it.srcChain || 'unknown'); const a = String(it.asset).toUpperCase(); const k = c + '|' + a; cell[k] = (cell[k] || 0) + (Number(it.amount) || 0); if (cell[k] > max) max = cell[k]; });
      q('trs-heatmap').innerHTML = `<div class="trs-dim" style="margin-bottom:8px;">Reserved + pending settlement value (External → Arc) by origin chain × asset.</div><div style="overflow-x:auto;"><table class="trs-heat"><thead><tr><th></th>${assets.map(a => `<th>${esc(a)}</th>`).join('')}</tr></thead><tbody>${chains.map(c => `<tr><td class="trs-heat-row">${esc(chainName(c))} → Arc</td>${assets.map(a => { const v = cell[c + '|' + a] || 0; const inten = max > 0 ? v / max : 0; const bg = v > 0 ? `rgba(96,180,255,${(0.12 + inten * 0.6).toFixed(2)})` : 'rgba(55,138,221,0.04)'; return `<td class="trs-heat-cell" style="background:${bg};" title="${esc(chainName(c))} · ${esc(a)}: ${fmtNum(v, 2)}">${v > 0 ? fmtNum(v, 0) : '·'}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>`;
    }
    // reserves by origin
    const byChain = {}; S.intents.forEach((it) => { const k = String(it.srcChain || 'unknown'); if (!byChain[k]) byChain[k] = { chain: k, transfers: 0, reserved: 0, pending: 0, failed: 0, completed: 0 }; const g = byChain[k]; g.transfers++; const amt = Number(it.amount) || 0; if (it.statusKey === 'pending') g.reserved += amt; if (['processing', 'review'].includes(it.statusKey)) g.pending += amt; if (it.statusKey === 'failed') g.failed++; if (it.statusKey === 'completed') g.completed++; });
    const chainsArr = Object.values(byChain).sort((a, b) => b.transfers - a.transfers);
    q('trs-reserves').innerHTML = chainsArr.length ? `<div class="trs-dim" style="margin-bottom:9px;"><i class="fas fa-circle-info" style="color:#5f7ba0;"></i> Available settlement liquidity is a shared Arc vault pool${vt.anyAvail ? ' (' + fmtUsd(vt.avail) + ')' : ''}; per-origin figures reflect that chain's inbound reserved/pending value.</div><div class="trs-tablewrap"><table class="trs-table"><thead><tr><th scope="col">Origin</th><th scope="col">→</th><th scope="col">Transfers</th><th scope="col">Reserved</th><th scope="col">Pending</th><th scope="col">Failed</th><th scope="col">Health</th></tr></thead><tbody>${chainsArr.map((g) => { const health = g.failed > g.completed && g.failed > 0 ? 'yellow' : 'green'; const hc = { green: '#34d399', yellow: '#fbbf24' }[health]; return `<tr><td>${tokenBadge(chainName(g.chain))}</td><td class="trs-dim"><i class="fas fa-arrow-right" style="font-size:8px;"></i> Arc</td><td class="trs-mono">${g.transfers}</td><td class="trs-mono" style="color:#a78bfa;">${fmtNum(g.reserved, 2)}</td><td class="trs-mono" style="color:#67e8f9;">${fmtNum(g.pending, 2)}</td><td class="trs-mono" style="color:${g.failed ? '#f87171' : '#5f7ba0'};">${g.failed}</td><td><span class="trs-hdot" style="background:${hc};box-shadow:0 0 8px ${hc}66;"></span></td></tr>`; }).join('')}</tbody></table></div>` : `<div class="trs-empty">No inbound reserves yet.</div>`;
    // forecast
    const projected = vt.anyAvail ? vt.avail - (vt.reserved + dm.pendingValue) : null;
    const remainingCap = vt.anyAvail ? Math.max(0, vt.avail - dm.pendingValue) : null;
    q('trs-forecast').innerHTML = `<div class="trs-flow">
      ${flowNode('Current Liquidity', vt.anyAvail ? fmtUsd(vt.avail) : '—', '#34d399')}
      ${flowNode('Reserved', fmtUsd(vt.reserved), '#a78bfa')}
      ${flowNode('Pending', fmtUsd(dm.pendingValue), '#67e8f9')}
      ${flowNode('Projected Liquidity', projected != null ? fmtUsd(projected) : '—', projected != null && projected < 0 ? '#f87171' : '#60b4ff')}
      ${flowNode('Remaining Capacity', remainingCap != null ? fmtUsd(remainingCap) : '—', '#34d399')}
    </div>
    <div class="trs-dim" style="margin-top:10px;">Projected = Available − (Reserved + Pending). ${projected != null && projected < 0 ? '<span style="color:#f87171;font-weight:700;">Warning: reservations exceed available liquidity.</span>' : ''} Minimum threshold not exposed by contract — shown as “—”. Computed from live data only (no estimation models).</div>`;
  }
  function flowNode(label, value, color) { return `<div class="trs-flow-node"><div class="trs-dim" style="font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;">${esc(label)}</div><div style="font-size:16px;font-weight:800;color:${color};margin-top:3px;">${value}</div></div><div class="trs-flow-arrow"><i class="fas fa-arrow-right-long"></i></div>`; }

  // ANALYTICS
  function renderAnalyticsWs() {
    const dm = S.dm;
    if (!S.intents.length) { q('trs-analytics').innerHTML = `<div class="trs-empty">No historical data yet — analytics populate as inbound intents are created.</div>`; return; }
    const settledC = S.intents.filter(i => i.statusKey === 'completed');
    const charts = [
      ['Hourly Volume (24h)', barChart(last24h(S.intents, (it) => Number(it.amount) || 0), '#60b4ff')],
      ['Daily Volume (7d)', barChart(lastNDays(S.intents, 7, (it) => Number(it.amount) || 0), '#a78bfa')],
      ['Weekly Volume (6w)', barChart(lastNWeeks(S.intents, 6, (it) => Number(it.amount) || 0), '#93c5fd')],
      ['Daily Intents (7d)', barChart(lastNDays(S.intents, 7, () => 1), '#67e8f9')],
      ['Avg Settlement / day (s)', barChart(lastNDays(settledC, 7, (it) => it.created && (it.settled || it.updated) ? ((it.settled || it.updated) - it.created) / 1000 : 0), '#fbbf24')],
      ['Settlement Throughput (7d)', barChart(lastNDays(settledC, 7, () => 1), '#34d399')],
      ['Reserve Consumption (7d)', barChart(lastNDays(settledC, 7, (it) => Number(it.amount) || 0), '#f59e0b')],
      ['Origin Distribution', barChart(distribution(S.intents, (it) => chainName(it.srcChain), () => 1).slice(0, 8), '#34d399')],
      ['Asset Distribution', barChart(distribution(S.intents, (it) => String(it.asset).toUpperCase(), (it) => Number(it.amount) || 0).slice(0, 8), '#c084fc')],
      ['Queue Size (open)', barChart([{ label: 'Pend', value: dm.pending }, { label: 'Proc', value: dm.processing }, { label: 'Rev', value: dm.review }, { label: 'Fail', value: dm.failed }], '#fbbf24')],
    ];
    const donuts = [
      ['Success Rate', donut(dm.successPct, '#34d399', 'success')],
      ['Liquidity Usage', donut(utilPct(), '#67e8f9', 'used')],
    ];
    q('trs-analytics').innerHTML = `<div class="trs-analytics-grid">${charts.map(([t, c]) => `<div class="trs-chart"><div class="trs-chart-t">${esc(t)}</div>${c}</div>`).join('')}${donuts.map(([t, c]) => `<div class="trs-chart" style="display:flex;flex-direction:column;align-items:center;justify-content:center;"><div class="trs-chart-t" style="align-self:flex-start;">${esc(t)}</div>${c}</div>`).join('')}</div>`;
  }

  // DIAGNOSTICS
  function renderDiagnosticsWs() {
    const dm = S.dm; const comp = (S.health && S.health.components) || {}; const meta = (S.health && S.health.meta) || null; const st = (S.system && S.system.status) || null; const apiOk = st && (st.status === 'online' || st.success); const rpc = (S.system && S.system.rpc) || {};
    const row = (label, state, detail) => { const c = { green: '#34d399', yellow: '#fbbf24', red: '#f87171', gray: '#5f7ba0' }[state] || '#5f7ba0'; return `<div class="trs-sysrow"><span class="trs-hdot" style="background:${c};box-shadow:0 0 8px ${c}66;"></span><span class="trs-hlabel">${esc(label)}</span><span class="trs-dim" style="margin-left:auto;">${esc(detail != null ? detail : '—')}</span></div>`; };
    const openQueue = dm.pending + dm.processing + dm.review;
    const ver = st && (st.version || (st.agents && st.agents.version)) || null;
    q('trs-diag-grid').innerHTML =
      row('RPC Status', rpc.ok ? 'green' : 'red', rpc.ok ? 'connected' : 'unreachable') +
      row('RPC Latency', rpc.latency != null ? (rpc.latency < 800 ? 'green' : rpc.latency < 1500 ? 'yellow' : 'red') : 'gray', rpc.latency != null ? rpc.latency + ' ms' : '—') +
      row('Block Height', rpc.ok ? 'green' : 'gray', rpc.block != null ? '#' + fmtNum(rpc.block) : '—') +
      row('Indexer / Treasury Core', meta && meta.ok ? 'green' : (Object.keys(comp).length ? compState(comp.treasury) : 'gray'), meta ? ('mode ' + (meta.mode || (meta.enabled ? 'REMOTE' : 'LOCAL'))) : '—') +
      row('Worker Status', apiOk ? 'green' : 'red', apiOk ? 'online' : 'offline') +
      row('Worker Version', ver ? 'green' : 'gray', ver || '—') +
      row('Worker Memory', 'gray', '—') +
      row('Worker Latency', S.system && S.system.apiLatency != null ? (S.system.apiLatency < 800 ? 'green' : 'yellow') : 'gray', S.system && S.system.apiLatency != null ? S.system.apiLatency + ' ms' : '—') +
      row('Queue Size', openQueue > 25 ? 'yellow' : 'green', openQueue + ' open') +
      row('Settlement Engine', comp.relayer != null ? compState(comp.relayer) : (W('FulfillerEngine') ? 'green' : (rpc.ok ? 'green' : 'gray')), W('FulfillerEngine') ? 'running (local)' : (comp.relayer != null ? String(comp.relayer) : '—')) +
      row('Cloudflare Worker', apiOk ? 'green' : 'red', apiOk ? 'edge online' : 'offline') +
      row('Bridge Health', comp.bridge != null ? compState(comp.bridge) : (rpc.ok ? 'green' : 'yellow'), comp.bridge != null ? String(comp.bridge) : (rpc.ok ? 'operational' : '—')) +
      row('Database', comp.db != null ? compState(comp.db) : 'gray', comp.db != null ? String(comp.db) : '—') +
      row('Cache', comp.cache != null ? compState(comp.cache) : 'gray', comp.cache != null ? String(comp.cache) : '—') +
      row('Last Health Check', 'green', fmtDate(Date.now())) +
      row('Uptime', 'gray', '—') +
      row('Heartbeat', rpc.ok && apiOk ? 'green' : 'yellow', timeAgo(S.lastSync || Date.now()));
    // Workers
    renderWorkersInto('trs-diag-workers');
    // Queues
    renderQueuesInto('trs-diag-queues');
    // Policies
    renderPoliciesInto('trs-diag-policies');
    // full event stream
    renderEventsInto('trs-diag-events', 20);
  }
  function renderWorkersInto(id) {
    const el = q(id); if (!el) return; const fe = W('FulfillerEngine'); const processing = S.intents.filter(i => i.statusKey === 'processing').length; const review = S.intents.filter(i => i.statusKey === 'review').length; const pending = S.intents.filter(i => i.statusKey === 'pending').length; const lastUpdate = S.intents.reduce((mx, it) => Math.max(mx, it.updated || it.created || 0), 0);
    const wr = (name, state, tasks, heartbeat, extra) => { const c = { green: '#34d399', yellow: '#fbbf24', red: '#f87171', gray: '#5f7ba0' }[state] || '#5f7ba0'; return `<div class="trs-worker"><span class="trs-hdot" style="background:${c};box-shadow:0 0 8px ${c}66;"></span><div style="flex:1;min-width:0;"><div class="trs-feed-title">${esc(name)}</div><div class="trs-dim">${esc(extra || '')}</div></div><div style="text-align:right;"><div class="trs-mono" style="font-size:12px;color:#cdd8ea;">${tasks} task${tasks === 1 ? '' : 's'}</div><div class="trs-dim">${esc(heartbeat)}</div></div></div>`; };
    let html = wr('Settlement Engine', fe ? 'green' : 'gray', processing, lastUpdate ? timeAgo(lastUpdate) : '—', fe ? 'CCTP attestation + settlement poller' : 'engine unavailable');
    html += wr('Operator Fulfillment Poller', fe ? (review > 0 ? 'yellow' : 'green') : 'gray', review, lastUpdate ? timeAgo(lastUpdate) : '—', review > 0 ? 'awaiting operator fulfillment' : 'on-chain state poller');
    html += wr('Intent Intake', 'green', pending, lastUpdate ? timeAgo(lastUpdate) : '—', 'accepts External → Arc intents');
    html += `<div class="trs-sub">Authorized operators (${DEPOSIT_WHITELIST.length})</div>` + DEPOSIT_WHITELIST.map((a) => `<div class="trs-worker"><span class="trs-hdot" style="background:#34d399;box-shadow:0 0 8px #34d39966;"></span><div style="flex:1;min-width:0;"><div class="trs-mono" style="font-size:12px;color:#cdd8ea;">${esc(shortAddr(a))}${(S.operator.address && a.toLowerCase() === S.operator.address.toLowerCase()) ? ' <span style="color:#34d399;font-weight:800;font-size:9px;">(You)</span>' : ''}</div></div>${copyBtn(a, 'operator')}${addrLink(a)}</div>`).join('');
    el.innerHTML = html;
  }
  function renderQueuesInto(id) {
    const el = q(id); if (!el) return; const now = Date.now();
    const groups = { 'Intent Queue': S.intents.filter(i => i.statusKey === 'pending'), 'Settlement Queue': S.intents.filter(i => i.statusKey === 'processing'), 'Retry Queue': S.intents.filter(i => i.statusKey === 'review'), 'Dead Letter Queue': S.intents.filter(i => i.statusKey === 'failed') };
    const settledLastHour = S.intents.filter(i => i.statusKey === 'completed' && (i.settled || i.updated) >= now - 3600000).length;
    el.innerHTML = Object.keys(groups).map((name) => { const arr = groups[name]; const oldest = arr.reduce((mn, it) => Math.min(mn, it.created || Infinity), Infinity); const avgAge = arr.length ? arr.reduce((a, it) => a + (now - (it.created || now)), 0) / arr.length : null; return `<div class="trs-queue"><div style="flex:1;min-width:0;"><div class="trs-feed-title">${esc(name)}</div><div class="trs-dim">Oldest: ${arr.length ? timeAgo(oldest === Infinity ? 0 : oldest) : '—'} · Avg delay: ${avgAge != null ? fmtDur(avgAge) : '—'}</div></div><div style="text-align:right;"><div class="trs-kpi-val" style="font-size:18px;">${arr.length}</div><div class="trs-dim">${name === 'Settlement Queue' ? settledLastHour + '/h' : 'in queue'}</div></div></div>`; }).join('');
  }
  function renderPoliciesInto(id) {
    const el = q(id); if (!el) return; const p = S.policies || {}; const fe = W('FulfillerEngine');
    el.innerHTML = `<div class="trs-mgrid">${mcell('Turbo Fee', p.turboFeeBps != null ? (p.turboFeeBps / 100).toFixed(2) + '%' : '—', '#dde6f5', 'on-chain turboFeeBps')}${mcell('Operators', String(p.operators || DEPOSIT_WHITELIST.length), '#dde6f5', 'isOperator whitelist')}${mcell('Auto Settlement', fe ? 'Enabled' : '—', '#34d399', fe ? 'local fulfiller' : 'unavailable')}${mcell('Retry Policy', fe ? 'Operator + CCTP poll' : '—', '#dde6f5', 'existing engine')}${mcell('Max Settlement', '—', '#dde6f5', 'not on-chain')}${mcell('Min Liquidity', '—', '#dde6f5', 'not on-chain')}${mcell('Emergency Threshold', '—', '#dde6f5', 'not on-chain')}${mcell('Confirmations', '—', '#dde6f5', 'not on-chain')}</div><div class="trs-dim" style="margin-top:8px;"><i class="fas fa-lock" style="color:#5f7ba0;"></i> Read-only. Values not exposed by contract/API are shown as “—”.</div>`;
  }

  // ─── Intent details / settlement pipeline panel (reused) ────────────────────
  function ensurePanel() { if (q('trs-panel-overlay')) return; const ov = document.createElement('div'); ov.id = 'trs-panel-overlay'; ov.className = 'trs-overlay hidden'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-label', 'Intent details'); ov.innerHTML = `<aside id="trs-panel" class="trs-panel" tabindex="-1"><div id="trs-panel-body"></div></aside>`; ov.addEventListener('click', (e) => { if (e.target === ov) trsCloseIntent(); }); document.body.appendChild(ov); document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !ov.classList.contains('hidden')) trsCloseIntent(); }); }
  function pRow(label, value, mono, extra) { return `<div class="trs-prow"><span class="trs-pk">${esc(label)}</span><span class="${mono ? 'trs-mono' : ''} trs-pv" title="${esc(String(value))}">${value === '' || value == null ? '—' : esc(String(value))}</span>${extra || ''}</div>`; }
  window.trsOpenIntent = function (id) {
    ensurePanel(); const it = S.intents.find(x => String(x.id) === String(id) || String(x.intentId) === String(id)); const ov = q('trs-panel-overlay'); const body = q('trs-panel-body'); if (!it || !ov || !body) return; const srcExp = chainExplorer(it.srcChain);
    const tl = []; if (it.created) tl.push({ t: it.created, label: 'Intent Created', color: '#60b4ff', icon: 'fa-plus-circle' }); if (it.statusKey !== 'pending' && (it.updated || it.created)) tl.push({ t: it.updated, label: 'Liquidity Reserved', color: '#a78bfa', icon: 'fa-bookmark' }); if (it.fulfilled) tl.push({ t: it.fulfilled, label: 'Settlement Started', color: '#67e8f9', icon: 'fa-bolt' }); if (it.settled) tl.push({ t: it.settled, label: 'Settlement Confirmed', color: '#34d399', icon: 'fa-check-circle' }); if (it.statusKey === 'failed' && it.updated) tl.push({ t: it.updated, label: 'Failed', color: '#f87171', icon: 'fa-times-circle' }); tl.sort((a, b) => a.t - b.t);
    const canRetry = S.operator.isOperator && ['review', 'processing', 'failed'].includes(it.statusKey) && W('FulfillerEngine');
    const canSettle = S.operator.isOperator && ['pending', 'processing', 'review'].includes(it.statusKey) && W('TreasuryBridge') && DEPLOYMENT && DEPLOYMENT.configured && TREASURY_ADDR && (() => { try { return window.TreasuryBridge.isInboundIntent(it); } catch (_) { return false; } })();
    body.innerHTML = `
      <div class="trs-panel-head"><div style="min-width:0;"><div class="trs-dim" style="text-transform:uppercase;letter-spacing:.08em;font-size:10px;font-weight:800;">Inbound Intent · External → Arc</div><div class="trs-mono" style="font-size:14px;color:#eef2fb;font-weight:800;margin-top:2px;word-break:break-all;">${esc(String(it.intentId || it.id))}</div></div><button class="trs-ic" style="width:32px;height:32px;" onclick="trsCloseIntent()" aria-label="Close details"><i class="fas fa-times"></i></button></div>
      <div style="display:flex;align-items:center;gap:8px;margin:12px 0;flex-wrap:wrap;">${statusChip(it.statusKey)}<span class="trs-chip" style="color:#9db8d8;background:rgba(55,138,221,0.08);border:1px solid rgba(55,138,221,0.16);"><i class="fas fa-database" style="font-size:8px;"></i>${it.source === 'remote' ? 'Treasury Core' : 'Turbo Bridge'}</span>${canSettle ? `<button class="trs-btn trs-btn-sm trs-btn-primary" onclick="trsSettleViaTreasury('${esc(String(it.id))}')"><i class="fas fa-money-bill-transfer"></i>Settle via Vault</button>` : ''}${canRetry ? `<button class="trs-btn trs-btn-sm" onclick="trsRetryIntent('${esc(String(it.id))}')"><i class="fas fa-rotate-right"></i>Retry</button>` : ''}<button class="trs-btn trs-btn-sm" onclick="trsCopyIntentJson('${esc(String(it.id))}')"><i class="fas fa-code"></i>Copy JSON</button></div>
      <div class="trs-psec-title">Intent Metadata</div>
      <div class="trs-pcard">${pRow('Asset', it.asset)}${pRow('Amount', it.amount != null ? fmtNum(it.amount, 2) + ' ' + it.asset : '—')}${pRow('Net Delivered', it.net != null ? fmtNum(it.net, 2) : '—')}${pRow('Bridge Fee', it.fee != null ? fmtNum(it.fee, 4) : '—')}${pRow('Origin Chain', chainName(it.srcChain))}${pRow('Destination', 'Arc Network')}${pRow('Sender', it.sender ? shortAddr(it.sender) : '—', true, it.sender ? (copyBtn(it.sender, 'sender') + addrLink(it.sender, srcExp)) : '')}${pRow('Receiver (Arc)', it.recipient ? shortAddr(it.recipient) : '—', true, it.recipient ? (copyBtn(it.recipient, 'receiver') + addrLink(it.recipient)) : '')}${pRow('Source Domain', it.sourceDomain != null ? it.sourceDomain : '—')}${pRow('Status', it.status)}${it.retryCount != null ? pRow('Retry Count', it.retryCount) : ''}</div>
      <div class="trs-psec-title">Settlement Pipeline</div>
      <div class="trs-pcard">${tl.length ? `<div class="trs-feed">${tl.map((e, i) => `<div class="trs-feed-item"><div class="trs-feed-rail"><span class="trs-feed-dot" style="border-color:${e.color};color:${e.color};"><i class="fas ${e.icon}"></i></span>${i < tl.length - 1 ? '<span class="trs-feed-line"></span>' : ''}</div><div style="flex:1;"><div class="trs-feed-title">${esc(e.label)}</div><div class="trs-dim">${esc(fmtDate(e.t))}${i > 0 ? ' · ' + fmtDur(e.t - tl[i - 1].t) : ''}</div></div></div>`).join('')}</div>` : `<div class="trs-empty">No timeline events.</div>`}</div>
      <div class="trs-psec-title">Transactions</div>
      <div class="trs-pcard">${pRow('Created', fmtDate(it.created))}${pRow('Updated', fmtDate(it.updated))}${it.fulfilled ? pRow('Fulfilled', fmtDate(it.fulfilled)) : ''}${it.settled ? pRow('Settled', fmtDate(it.settled)) : ''}${it.settled && it.created ? pRow('Total Duration', fmtDur(it.settled - it.created)) : ''}${pRow('Source Tx (' + esc(chainName(it.srcChain)) + ')', it.txHash ? shortHash(it.txHash) : '—', true, it.txHash ? (copyBtn(it.txHash, 'source tx') + `<a class="trs-ic" href="${srcExp}/tx/${it.txHash}" target="_blank" rel="noopener" aria-label="View source tx"><i class="fas fa-external-link-alt"></i></a>`) : '')}${it.arcTx ? pRow('Arc Fulfillment Tx', shortHash(it.arcTx), true, copyBtn(it.arcTx, 'arc tx') + txLink(it.arcTx, 'fulfillment')) : ''}${pRow('Settlement Tx (Arc)', it.settleTx ? shortHash(it.settleTx) : '—', true, it.settleTx ? (copyBtn(it.settleTx, 'settlement tx') + txLink(it.settleTx, 'settlement')) : '')}${it.cctpMsgHash ? pRow('CCTP Message', shortHash(it.cctpMsgHash), true, copyBtn(it.cctpMsgHash, 'cctp message')) : ''}</div>
      ${it.error ? `<div class="trs-psec-title">Error / Recovery</div><div class="trs-pcard"><div style="color:#f87171;font-size:12px;margin-bottom:6px;">${esc(it.error)}</div>${canRetry ? `<button class="trs-btn trs-btn-sm trs-btn-primary" onclick="trsRetryIntent('${esc(String(it.id))}')"><i class="fas fa-rotate-right"></i>Retry Settlement</button>` : `<div class="trs-dim">Recovery requires an authorized operator.</div>`}</div>` : ''}`;
    ov.classList.remove('hidden'); const panel = q('trs-panel'); if (panel) { requestAnimationFrame(() => panel.classList.add('open')); setTimeout(() => panel.focus(), 60); }
  };
  window.trsCloseIntent = function () { const ov = q('trs-panel-overlay'); const panel = q('trs-panel'); if (panel) panel.classList.remove('open'); setTimeout(() => { if (ov) ov.classList.add('hidden'); }, 180); };
  window.trsCopyIntentJson = function (id) { const it = S.intents.find(x => String(x.id) === String(id) || String(x.intentId) === String(id)); if (!it) return; try { window.trsCopy(JSON.stringify(it.raw || it, null, 2), 'Intent JSON'); } catch (_) {} };

  // ─── Operational actions ────────────────────────────────────────────────────
  window.trsRetryIntent = function (id) { const it = S.intents.find(x => String(x.id) === String(id) || String(x.intentId) === String(id)); if (!it) return; if (!S.operator.isOperator) { toast('Retry requires an authorized operator wallet', 'warning'); return; } const fe = W('FulfillerEngine'); if (!fe) { toast('Settlement engine unavailable', 'warning'); return; } try { if (it.statusKey === 'review' && fe._startOperatorFulfillmentPoller) { fe._startOperatorFulfillmentPoller(it.id); toast('Re-queued for operator fulfillment', 'success'); } else if (fe._startSettlementPoller) { fe._startSettlementPoller(it.id); toast('Settlement poller restarted', 'success'); } else { toast('No retry entrypoint available', 'warning'); return; } setTimeout(() => refresh(false), 1500); } catch (e) { toast('Retry failed: ' + (e.message || e), 'error'); } };

  // ── Inbound settlement via the deployed ArcVault (operator-gated, real) ──────
  window.trsSettleViaTreasury = function (id) {
    const it = S.intents.find(x => String(x.id) === String(id) || String(x.intentId) === String(id)); if (!it) return;
    if (!W('TreasuryBridge')) { toast('Treasury bridge link not loaded', 'warning'); return; }
    try { if (!window.TreasuryBridge.isInboundIntent(it)) { toast('Only inbound (External → Arc) intents can be settled by the Treasury', 'warning'); return; } } catch (_) {}
    ensureModal(); q('trs-modal-title').textContent = 'Settle Inbound Intent via Treasury Vault';
    q('trs-modal-body').innerHTML = `
      <div class="trs-pcard" style="margin-bottom:12px;">
        <div class="trs-prow"><span class="trs-pk">Intent</span><span class="trs-mono trs-pv">${esc(shortHash(String(it.intentId || it.id)))}</span></div>
        <div class="trs-prow"><span class="trs-pk">Route</span><span class="trs-pv">${esc(chainName(it.srcChain))} → Arc</span></div>
        <div class="trs-prow"><span class="trs-pk">Asset / Amount</span><span class="trs-pv">${esc(it.asset)} ${it.amount != null ? fmtNum(it.amount, 2) : '—'}</span></div>
        <div class="trs-prow"><span class="trs-pk">Recipient (Arc)</span><span class="trs-mono trs-pv" title="${esc(it.recipient || '')}">${esc(shortAddr(it.recipient))}</span></div>
      </div>
      <div class="trs-dim" style="margin-bottom:12px;line-height:1.5;"><i class="fas fa-circle-info" style="color:#60b4ff;"></i> Runs the real on-chain lifecycle on the ArcVault: <b>reserve → start → complete</b>, delivering ${esc(it.asset)} to the recipient on Arc. Operator-signed. The outbound bridge (Arc → External) is never affected.</div>
      <div style="display:flex;gap:8px;"><button id="trs-settle-go" class="trs-btn trs-btn-primary" style="flex:1;" onclick="trsExecuteTreasurySettle('${esc(String(it.id))}')"><i class="fas fa-money-bill-transfer"></i>Settle</button><button class="trs-btn" onclick="trsCloseModal()">Cancel</button></div>
      <div id="trs-settle-status" style="margin-top:10px;"></div>`;
    q('trs-modal-overlay').classList.remove('hidden');
  };
  window.trsExecuteTreasurySettle = async function (id) {
    const it = S.intents.find(x => String(x.id) === String(id) || String(x.intentId) === String(id)); if (!it) return;
    const go = q('trs-settle-go'); const status = q('trs-settle-status');
    const setStat = (m, c) => { if (status) status.innerHTML = `<div style="font-size:12px;color:${c || '#8aaac8'};">${m}</div>`; };
    if (go) { go.disabled = true; go.innerHTML = '<i class="fas fa-spinner fa-spin"></i>Settling…'; }
    try {
      const res = await window.TreasuryBridge.settleInbound(it, { onStep: (s) => setStat('Step: ' + esc(s) + '…', '#60b4ff') });
      try { const rc = W('RepaymentContract'); if (rc && rc.verifyAndSettle) rc.verifyAndSettle((it.raw && it.raw.id) || it.id, { mintTxHash: res && res.txHash }); } catch (_) {}
      try { window.dispatchEvent(new CustomEvent('treasury:completed', { detail: { intentId: it.id } })); } catch (_) {}
      setStat(`<i class="fas fa-check-circle" style="color:#34d399;"></i> Settled on-chain. <a href="${res.explorer}" target="_blank" rel="noopener" style="color:#60b4ff;">View tx ↗</a>`, '#34d399');
      toast('Inbound settlement completed via Treasury Vault', 'success');
      setTimeout(() => { trsCloseModal(); trsCloseIntent(); refresh(false); }, 2600);
    } catch (e) {
      setStat('<i class="fas fa-times-circle" style="color:#f87171;"></i> ' + esc((e && (e.shortMessage || e.message)) || String(e)), '#f87171');
      toast('Settlement failed', 'error');
      if (go) { go.disabled = false; go.innerHTML = '<i class="fas fa-money-bill-transfer"></i>Settle'; }
    }
  };

  // ── Mint All — settle every pending inbound intent (operator, sequential) ────
  window.trsMintAll = async function () {
    if (!S.operator.isOperator) { toast('Minting requires an authorized operator wallet', 'warning'); return; }
    if (!W('TreasuryBridge')) { toast('Treasury bridge link not loaded', 'warning'); return; }
    const pend = S.intents.filter((it) => ['pending', 'processing', 'review'].includes(it.statusKey));
    if (!pend.length) { toast('No pending intents to mint', 'info'); return; }
    toast('Minting ' + pend.length + ' intent' + (pend.length === 1 ? '' : 's') + '…', 'info');
    let ok = 0, bad = 0;
    for (const it of pend) {
      try {
        const settleObj = Object.assign({}, it, { recipient: it.recipient || it.sender, amount: it.amount, asset: it.asset });
        const res = await window.TreasuryBridge.settleInbound(settleObj, {});
        try { const rc = W('RepaymentContract'); if (rc && rc.verifyAndSettle) rc.verifyAndSettle((it.raw && it.raw.id) || it.id, { mintTxHash: res && res.txHash }); } catch (_) {}
        ok++;
      } catch (e) { bad++; }
    }
    try { window.dispatchEvent(new CustomEvent('treasury:completed', { detail: {} })); } catch (_) {}
    toast('Mint complete: ' + ok + ' settled' + (bad ? ', ' + bad + ' failed' : ''), bad ? 'warning' : 'success');
    refresh(false);
  };
  window.trsExport = function (kind) {
    let payload; const base = { generatedAt: new Date().toISOString(), network: TRS_NETWORK, chainId: TRS_CHAIN_ID, vault: VAULT_ADDR, direction: 'inbound (External → Arc)' };
    if (kind === 'vault') payload = Object.assign(base, { balances: S.vault, capabilities: S.caps, events: (S.vaultEvents || []).map(e => ({ kind: e.kind, asset: e.asset, amount: e.amountH, tx: e.tx, block: e.block, ts: e.ts })) });
    else if (kind === 'liquidity') payload = Object.assign(base, { balances: S.vault, reservesByOrigin: (() => { const b = {}; S.intents.forEach(it => { const k = String(it.srcChain || 'unknown'); b[k] = b[k] || { reserved: 0, pending: 0 }; const a = Number(it.amount) || 0; if (it.statusKey === 'pending') b[k].reserved += a; if (['processing', 'review'].includes(it.statusKey)) b[k].pending += a; }); return b; })() });
    else payload = Object.assign(base, { metrics: S.dm, vault: S.vault, capabilities: S.caps, intents: S.intents.map(i => i.raw || i) });
    try { const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'treasury-' + kind + '-' + Date.now() + '.json'; document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('Exported ' + kind, 'success'); } catch (e) { toast('Export failed', 'error'); }
  };
  window.trsCopyJson = function () { try { window.trsCopy(JSON.stringify({ metrics: S.dm, vault: S.vault, capabilities: S.caps }, null, 2), 'Treasury JSON'); } catch (_) {} };
  window.trsLoadVaultEvents = async function () { S.vaultEventsLoading = true; renderVaultHistory(); await loadVaultEvents(); renderVaultHistory(); renderVaultExplorer(); };

  // ─── Vault deposit / withdraw ───────────────────────────────────────────────
  window.trsVaultRefresh = async function () { toast('Refreshing vault…', 'info'); try { const va = W('VaultAccounting'); if (va && va.fetchOnChainReserves) await va.fetchOnChainReserves().catch(() => {}); } catch (_) {} S.vault = await loadVault(S.intents).catch(() => S.vault); await detectCapabilities().catch(() => {}); S.dm = deriveMetrics(S.intents); if (S.ws === 'vault') renderVaultWs(); else renderActive(); toast('Vault refreshed', 'success'); };
  window.trsVaultTransactions = async function () { ensureModal(); const body = q('trs-modal-body'); q('trs-modal-title').textContent = 'Treasury Vault — On-Chain Events'; body.innerHTML = `<div class="trs-empty"><i class="fas fa-spinner fa-spin"></i> Fetching vault events from Arc Testnet…</div>`; q('trs-modal-overlay').classList.remove('hidden'); await loadVaultEvents(); const ev = (S.vaultEvents || []).slice(0, 60); if (!ev.length) { body.innerHTML = `<div class="trs-empty">No vault events found.<br><a class="trs-btn" style="margin-top:10px;" href="${TRS_EXPLORER}/address/${VAULT_ADDR}" target="_blank" rel="noopener"><i class="fas fa-external-link-alt"></i>Open Vault on ArcScan</a></div>`; return; } const kindColor = { 'Deposit / Funding': '#60b4ff', 'Withdrawal / Outflow': '#fbbf24', 'Settlement Consumption': '#34d399', 'Liquidity Release': '#67e8f9', 'Fee Collected': '#a78bfa' }; body.innerHTML = `<div style="max-height:60vh;overflow:auto;">${ev.map((e) => `<div class="trs-pcard" style="margin-bottom:8px;"><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;"><span class="trs-chip" style="color:${kindColor[e.kind] || '#8aaac8'};background:rgba(0,0,0,0);border:1px solid ${(kindColor[e.kind] || '#8aaac8')}55;">${esc(e.kind)}</span>${e.asset ? tokenBadge(e.asset) : ''}<span style="font-weight:800;color:#cdd8ea;">${e.amountH != null ? fmtNum(e.amountH, 2) : ''}</span><span class="trs-dim">${e.ts ? fmtDate(e.ts) : '#' + fmtNum(e.block)}</span>${e.tx ? `<span style="margin-left:auto;display:flex;gap:5px;align-items:center;"><span class="trs-mono trs-dim">${esc(shortHash(e.tx))}</span>${copyBtn(e.tx, 'tx')}${txLink(e.tx, 'tx')}</span>` : ''}</div></div>`).join('')}</div>`; };

  window.trsOpenDeposit = function () {
    if (!S.caps.deposit) { toast('Direct deposits are not supported by the current Treasury implementation.', 'warning'); return; }
    if (!S.operator.isOperator) { toast('Connect an authorized operator wallet to deposit', 'warning'); return; }
    ensureModal(); q('trs-modal-title').textContent = 'Deposit Liquidity into Treasury Vault';
    const assetOpts = Object.keys(VAULT_ASSETS).map(sym => `<option value="${sym}">${sym}</option>`).join('');
    const modeNote = S.caps.depositMode === 'transfer' ? 'Mode: ERC-20 transfer to vault (accounting confirmed by getAvailableLiquidity).' : ('Mode: native ' + esc(S.caps.depositSig || '') + ' (detected on-chain).');
    q('trs-modal-body').innerHTML = `
      <div class="trs-pcard" style="margin-bottom:12px;">
        <div class="trs-prow"><span class="trs-pk">Asset</span><span style="flex:1;"><select id="trs-dep-asset" class="trs-select" style="width:100%;" onchange="trsDepBalance()">${assetOpts}</select></span></div>
        <div class="trs-prow"><span class="trs-pk">Amount</span><span style="flex:1;display:flex;gap:6px;align-items:center;"><input id="trs-dep-amount" class="trs-input" type="number" min="0" step="0.01" placeholder="0.00" style="flex:1;"><button class="trs-btn trs-btn-sm" onclick="trsDepMax()">Max</button></span></div>
        <div class="trs-prow"><span class="trs-pk">Wallet Balance</span><span id="trs-dep-bal" class="trs-mono trs-pv">—</span></div>
        <div class="trs-prow"><span class="trs-pk">Vault Available</span><span id="trs-dep-vault" class="trs-mono trs-pv">—</span></div>
      </div>
      <div class="trs-dim" style="margin-bottom:12px;line-height:1.5;"><i class="fas fa-circle-info" style="color:#60b4ff;"></i> Funds the Treasury Vault liquidity pool <span class="trs-mono">${esc(shortAddr(VAULT_ADDR))}</span> for inbound (External → Arc) settlements. Real on-chain transaction on ${esc(TRS_NETWORK)}. ${modeNote} Only the Treasury Vault contract can move these funds out.</div>
      <div style="display:flex;gap:8px;"><button id="trs-dep-go" class="trs-btn trs-btn-primary" style="flex:1;" onclick="trsExecuteDeposit()"><i class="fas fa-arrow-down-to-line"></i>Deposit</button><button class="trs-btn" onclick="trsCloseModal()">Cancel</button></div>
      <div id="trs-dep-status" style="margin-top:10px;"></div>`;
    q('trs-modal-overlay').classList.remove('hidden'); trsDepBalance();
  };
  window.trsDepBalance = async function () { const sym = (q('trs-dep-asset') || {}).value; if (!sym) return; const balEl = q('trs-dep-bal'), vEl = q('trs-dep-vault'); if (balEl) balEl.textContent = '…'; if (vEl) vEl.textContent = '…'; try { const p = await vaultProvider(); const addr = S.operator.address; if (p && addr) { const tok = new window.ethers.Contract(VAULT_ASSETS[sym], ERC20_ABI, p); const dec = ASSET_DECIMALS[sym] || 6; const [bal, vc] = await Promise.all([tok.balanceOf(addr).catch(() => null), new window.ethers.Contract(VAULT_ADDR, VAULT_ABI, p).getAvailableLiquidity(VAULT_ASSETS[sym]).catch(() => null)]); if (balEl) balEl.textContent = bal != null ? fmtNum(parseFloat(window.ethers.formatUnits(bal, dec)), 2) + ' ' + sym : '—'; if (vEl) vEl.textContent = vc != null ? fmtNum(parseFloat(window.ethers.formatUnits(vc, dec)), 2) + ' ' + sym : '—'; window._trsDepBalRaw = bal; } } catch (_) { if (balEl) balEl.textContent = '—'; if (vEl) vEl.textContent = '—'; } };
  window.trsDepMax = function () { const sym = (q('trs-dep-asset') || {}).value; const dec = ASSET_DECIMALS[sym] || 6; try { if (window._trsDepBalRaw != null) q('trs-dep-amount').value = window.ethers.formatUnits(window._trsDepBalRaw, dec); } catch (_) {} };
  window.trsExecuteDeposit = async function () {
    const sym = (q('trs-dep-asset') || {}).value; const amtStr = (q('trs-dep-amount') || {}).value; const status = q('trs-dep-status'); const go = q('trs-dep-go');
    if (!sym || !amtStr || Number(amtStr) <= 0) { toast('Enter a valid amount', 'warning'); return; }
    if (!S.operator.isOperator) { toast('Not an authorized operator', 'error'); return; }
    if (!W('ethers') || !W('walletState') || !window.walletState.provider) { toast('Wallet not connected', 'error'); return; }
    const dec = ASSET_DECIMALS[sym] || 6; if (go) { go.disabled = true; go.innerHTML = '<i class="fas fa-spinner fa-spin"></i>Depositing…'; }
    const setStat = (msg, c) => { if (status) status.innerHTML = `<div style="font-size:12px;color:${c || '#8aaac8'};">${msg}</div>`; };
    try {
      const provider = new window.ethers.BrowserProvider(window.walletState.provider); const signer = await provider.getSigner(); const from = await signer.getAddress();
      const vcRead = new window.ethers.Contract(VAULT_ADDR, VAULT_ABI, provider); const before = await vcRead.getAvailableLiquidity(VAULT_ASSETS[sym]).catch(() => null);
      const tok = new window.ethers.Contract(VAULT_ASSETS[sym], ERC20_ABI, signer); const amt = window.ethers.parseUnits(String(amtStr), dec);
      const bal = await tok.balanceOf(from).catch(() => null); if (bal != null && bal < amt) throw new Error('Insufficient ' + sym + ' balance');
      let tx;
      if (S.caps.depositMode === 'native' && S.caps.depositSig) {
        const sig = S.caps.depositSig; const vaultWrite = new window.ethers.Contract(VAULT_ADDR, ['function ' + sig], signer); const fnName = sig.slice(0, sig.indexOf('('));
        setStat('Approving vault to pull ' + sym + '…', '#fbbf24');
        try { const approve = await tok.approve(VAULT_ADDR, amt); await approve.wait(); } catch (_) {}
        setStat('Awaiting wallet confirmation…', '#fbbf24');
        tx = sig.indexOf('address') !== -1 ? await vaultWrite[fnName](VAULT_ASSETS[sym], amt) : await vaultWrite[fnName](amt);
      } else {
        setStat('Awaiting wallet confirmation…', '#fbbf24');
        tx = await tok.transfer(VAULT_ADDR, amt);
      }
      setStat('Submitted ' + shortHash(tx.hash) + ' — waiting for confirmation…', '#60b4ff');
      const rcpt = await tx.wait(); if (!rcpt || rcpt.status !== 1) throw new Error('Transaction reverted');
      const after = await vcRead.getAvailableLiquidity(VAULT_ASSETS[sym]).catch(() => null); let delta = null; try { if (before != null && after != null) delta = parseFloat(window.ethers.formatUnits(after - before, dec)); } catch (_) {}
      setStat(`<i class="fas fa-check-circle" style="color:#34d399;"></i> Deposit confirmed. ${delta != null ? 'Vault available +' + fmtNum(delta, 2) + ' ' + sym + '.' : ''} <a href="${TRS_EXPLORER}/tx/${tx.hash}" target="_blank" rel="noopener" style="color:#60b4ff;">View tx ↗</a>`, '#34d399');
      toast('Vault deposit confirmed', 'success'); setTimeout(() => { trsCloseModal(); refresh(false); }, 2500);
    } catch (e) { const msg = (e && (e.shortMessage || e.message)) || String(e); setStat('<i class="fas fa-times-circle" style="color:#f87171;"></i> ' + esc(msg), '#f87171'); toast('Deposit failed', 'error'); if (go) { go.disabled = false; go.innerHTML = '<i class="fas fa-arrow-down-to-line"></i>Deposit'; } }
  };

  window.trsOpenWithdraw = function () {
    if (!S.caps.withdraw || !S.caps.withdrawSig) { toast('This Treasury Vault does not expose a public withdraw function.', 'warning'); return; }
    if (!S.operator.isOperator) { toast('Requires an authorized operator wallet', 'warning'); return; }
    ensureModal(); q('trs-modal-title').textContent = 'Withdraw Liquidity from Treasury Vault';
    const assetOpts = Object.keys(VAULT_ASSETS).map(sym => `<option value="${sym}">${sym}</option>`).join('');
    q('trs-modal-body').innerHTML = `
      <div class="trs-pcard" style="margin-bottom:12px;">
        <div class="trs-prow"><span class="trs-pk">Asset</span><span style="flex:1;"><select id="trs-wd-asset" class="trs-select" style="width:100%;">${assetOpts}</select></span></div>
        <div class="trs-prow"><span class="trs-pk">Amount</span><span style="flex:1;"><input id="trs-wd-amount" class="trs-input" type="number" min="0" step="0.01" placeholder="0.00" style="width:100%;"></span></div>
        <div class="trs-prow"><span class="trs-pk">Detected function</span><span class="trs-mono trs-pv">${esc(S.caps.withdrawSig)}</span></div>
      </div>
      <div class="trs-dim" style="margin-bottom:12px;line-height:1.5;"><i class="fas fa-triangle-exclamation" style="color:#fbbf24;"></i> Calls the on-chain <span class="trs-mono">${esc(S.caps.withdrawSig)}</span> function detected in the vault bytecode. The contract enforces its own access control — if your wallet is not authorized by the contract, the transaction will revert (no funds move). Real on-chain call on ${esc(TRS_NETWORK)}.</div>
      <div style="display:flex;gap:8px;"><button id="trs-wd-go" class="trs-btn trs-btn-primary" style="flex:1;" onclick="trsExecuteWithdraw()"><i class="fas fa-arrow-up-from-line"></i>Withdraw</button><button class="trs-btn" onclick="trsCloseModal()">Cancel</button></div>
      <div id="trs-wd-status" style="margin-top:10px;"></div>`;
    q('trs-modal-overlay').classList.remove('hidden');
  };
  window.trsExecuteWithdraw = async function () {
    const sym = (q('trs-wd-asset') || {}).value; const amtStr = (q('trs-wd-amount') || {}).value; const status = q('trs-wd-status'); const go = q('trs-wd-go');
    if (!sym || !amtStr || Number(amtStr) <= 0) { toast('Enter a valid amount', 'warning'); return; }
    if (!S.caps.withdrawSig) { toast('No withdraw function available', 'error'); return; }
    if (!W('ethers') || !W('walletState') || !window.walletState.provider) { toast('Wallet not connected', 'error'); return; }
    const dec = ASSET_DECIMALS[sym] || 6; const setStat = (m, c) => { if (status) status.innerHTML = `<div style="font-size:12px;color:${c || '#8aaac8'};">${m}</div>`; };
    if (go) { go.disabled = true; go.innerHTML = '<i class="fas fa-spinner fa-spin"></i>Withdrawing…'; }
    try {
      const provider = new window.ethers.BrowserProvider(window.walletState.provider); const signer = await provider.getSigner();
      const sig = S.caps.withdrawSig; const vaultWrite = new window.ethers.Contract(VAULT_ADDR, ['function ' + sig], signer); const fnName = sig.slice(0, sig.indexOf('('));
      const amt = window.ethers.parseUnits(String(amtStr), dec);
      setStat('Awaiting wallet confirmation…', '#fbbf24');
      const tx = sig.indexOf('address') !== -1 ? await vaultWrite[fnName](VAULT_ASSETS[sym], amt) : await vaultWrite[fnName](amt);
      setStat('Submitted ' + shortHash(tx.hash) + ' — waiting…', '#60b4ff');
      const rcpt = await tx.wait(); if (!rcpt || rcpt.status !== 1) throw new Error('Transaction reverted');
      setStat(`<i class="fas fa-check-circle" style="color:#34d399;"></i> Withdraw confirmed. <a href="${TRS_EXPLORER}/tx/${tx.hash}" target="_blank" rel="noopener" style="color:#60b4ff;">View tx ↗</a>`, '#34d399');
      toast('Withdraw confirmed', 'success'); setTimeout(() => { trsCloseModal(); refresh(false); }, 2500);
    } catch (e) { const msg = (e && (e.shortMessage || e.message)) || String(e); setStat('<i class="fas fa-times-circle" style="color:#f87171;"></i> ' + esc(msg) + (/revert|not.*author|owner/i.test(msg) ? ' (contract rejected — your wallet is not authorized to withdraw).' : ''), '#f87171'); toast('Withdraw failed', 'error'); if (go) { go.disabled = false; go.innerHTML = '<i class="fas fa-arrow-up-from-line"></i>Withdraw'; } }
  };

  // ─── Modal ──────────────────────────────────────────────────────────────────
  function ensureModal() { if (q('trs-modal-overlay')) return; const ov = document.createElement('div'); ov.id = 'trs-modal-overlay'; ov.className = 'trs-overlay hidden'; ov.style.justifyContent = 'center'; ov.style.alignItems = 'flex-start'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.innerHTML = `<div id="trs-modal" class="trs-modal"><div class="trs-panel-head"><h3 id="trs-modal-title" style="font-size:15px;font-weight:800;color:#eef2fb;margin:0;"></h3><button class="trs-ic" style="width:32px;height:32px;" onclick="trsCloseModal()" aria-label="Close"><i class="fas fa-times"></i></button></div><div id="trs-modal-body" style="margin-top:14px;"></div></div>`; ov.addEventListener('click', (e) => { if (e.target === ov) trsCloseModal(); }); document.body.appendChild(ov); document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !ov.classList.contains('hidden')) trsCloseModal(); }); }
  window.trsCloseModal = function () { const ov = q('trs-modal-overlay'); if (ov) ov.classList.add('hidden'); };

  // ─── Global handlers ────────────────────────────────────────────────────────
  window.trsCopy = function (text, label) { const done = () => toast(((label ? label + ' ' : '') + 'copied!').trim(), 'success'); try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(done).catch(fb); } else fb(); } catch (_) { fb(); } function fb() { try { const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); done(); } catch (_) {} } };
  window.trsSort = function (k) { if (S.sortKey === k) S.sortDir = S.sortDir === 'asc' ? 'desc' : 'asc'; else { S.sortKey = k; S.sortDir = (k === 'asset' || k === 'status') ? 'asc' : 'desc'; } renderIntents(); };
  window.trsPage = function (n) { S.page = Math.max(1, n); renderIntents(); };
  window.trsPageSize = function (n) { S.pageSize = Number(n) || 12; S.page = 1; renderIntents(); };
  window.trsApplyFilters = function () { const s = q('trs-search'), fs = q('trs-filter-status'), fa = q('trs-filter-asset'), fc = q('trs-filter-chain'); S.search = s ? s.value : ''; S.fStatus = fs ? fs.value : 'all'; S.fAsset = fa ? fa.value : 'all'; S.fChain = fc ? fc.value : 'all'; S.page = 1; renderIntents(); };
  window.trsGlobalSearch = function () { const g = q('trs-global-search'); const v = g ? g.value.trim() : ''; if (!v) return; const it = S.intents.find(x => [x.id, x.intentId, x.txHash, x.settleTx, x.arcTx, x.sender, x.recipient].some(f => String(f || '').toLowerCase() === v.toLowerCase())) || S.intents.find(x => [x.id, x.intentId, x.txHash, x.settleTx, x.sender, x.recipient, x.asset].some(f => String(f || '').toLowerCase().includes(v.toLowerCase()))); if (it) { trsOpenIntent(it.id); } else { S.search = v; trsGoto('intents'); const s = q('trs-search'); if (s) s.value = v; S.page = 1; renderIntents(); toast('No exact match — filtered the intent queue', 'info'); } };
  window.trsRefreshNow = function () { if (S.loading) return; toast('Refreshing treasury…', 'info'); refresh(true); };
  window.trsGoto = function (ws) { if (!WORKSPACES.some(w => w.id === ws)) return; S.ws = ws; WORKSPACES.forEach(w => { const el = q('trs-ws-' + w.id); if (el) el.classList.toggle('hidden', w.id !== ws); const nav = q('trs-nav-' + w.id); if (nav) nav.classList.toggle('active', w.id === ws); }); if (ws === 'vault' && !S.caps.checked) detectCapabilities().then(() => renderVaultOps()); renderActive(); };

  // ─── Skeleton ───────────────────────────────────────────────────────────────
  function injectStyle() {
    if (q('trs-style')) return; const st = document.createElement('style'); st.id = 'trs-style';
    st.textContent = `
      #tab-content-treasury .trs-card{background:rgba(8,11,24,0.96);border:1px solid rgba(55,138,221,0.14);border-radius:16px;}
      #tab-content-treasury .trs-sec{margin-bottom:16px;}
      #tab-content-treasury .trs-sec-head{display:flex;align-items:center;gap:9px;margin-bottom:10px;flex-wrap:wrap;}
      #tab-content-treasury .trs-sec-title{font-size:11px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:#8aaac8;display:inline-flex;align-items:center;gap:7px;}
      #tab-content-treasury .trs-pad{padding:14px 16px;}
      #tab-content-treasury .trs-grid-2{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
      #tab-content-treasury .trs-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;}
      #tab-content-treasury .trs-kpi{background:rgba(12,16,32,0.6);border:1px solid rgba(55,138,221,0.12);border-radius:13px;padding:12px 13px;}
      #tab-content-treasury .trs-kpi-top{display:flex;align-items:center;gap:7px;margin-bottom:8px;}
      #tab-content-treasury .trs-kpi-ic{font-size:13px;}
      #tab-content-treasury .trs-kpi-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#5f7ba0;}
      #tab-content-treasury .trs-kpi-val{font-size:21px;font-weight:800;color:#eef2fb;letter-spacing:-.01em;line-height:1;}
      #tab-content-treasury .trs-kpi-sub{font-size:10px;color:#5f7ba0;margin-top:5px;}
      #tab-content-treasury .trs-nav{display:flex;gap:6px;flex-wrap:wrap;background:rgba(8,11,24,0.7);border:1px solid rgba(55,138,221,0.12);border-radius:14px;padding:6px;margin-bottom:16px;}
      #tab-content-treasury .trs-nav-btn{display:inline-flex;align-items:center;gap:7px;background:none;border:1px solid transparent;border-radius:10px;color:#8aaac8;font-size:12px;font-weight:700;padding:8px 13px;cursor:pointer;transition:all .15s;}
      #tab-content-treasury .trs-nav-btn:hover{color:#cdd8ea;background:rgba(55,138,221,0.08);}
      #tab-content-treasury .trs-nav-btn.active{background:rgba(245,158,11,0.12);border-color:rgba(245,158,11,0.35);color:#fbbf24;}
      #tab-content-treasury .trs-hrow,#tab-content-treasury .trs-sysrow,#tab-content-treasury .trs-worker,#tab-content-treasury .trs-queue{display:flex;align-items:center;gap:9px;padding:9px 0;border-bottom:1px solid rgba(55,138,221,0.07);}
      #tab-content-treasury .trs-hrow:last-child,#tab-content-treasury .trs-sysrow:last-child,#tab-content-treasury .trs-worker:last-child,#tab-content-treasury .trs-queue:last-child{border-bottom:none;}
      #tab-content-treasury .trs-hdot{width:9px;height:9px;border-radius:50%;flex-shrink:0;}
      #tab-content-treasury .trs-hlabel{font-size:12.5px;color:#cdd8ea;}
      #tab-content-treasury .trs-hstate{font-size:11px;font-weight:700;}
      #tab-content-treasury .trs-mgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:9px;}
      #tab-content-treasury .trs-mcell{background:rgba(55,138,221,0.05);border:1px solid rgba(55,138,221,0.12);border-radius:10px;padding:9px 10px;}
      #tab-content-treasury .trs-mk{font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;font-weight:700;color:#5f7ba0;margin-bottom:4px;}
      #tab-content-treasury .trs-mv{font-size:16px;font-weight:800;color:#dde6f5;}
      #tab-content-treasury .trs-sub{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.07em;color:#5f7ba0;margin:14px 0 8px;}
      #tab-content-treasury .trs-liq-wrap{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;}
      #tab-content-treasury .trs-liq{background:rgba(55,138,221,0.04);border:1px solid rgba(55,138,221,0.12);border-radius:12px;padding:11px 12px;}
      #tab-content-treasury .trs-liq-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:9px;}
      #tab-content-treasury .trs-liq-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;}
      #tab-content-treasury .trs-liq-grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;}
      #tab-content-treasury .trs-liq-k{font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:#5f7ba0;font-weight:700;margin-bottom:3px;}
      #tab-content-treasury .trs-liq-v{font-size:13px;font-weight:800;}
      #tab-content-treasury .trs-token{display:inline-flex;align-items:center;font-weight:800;font-size:12.5px;color:#dbe4f2;background:rgba(96,180,255,0.1);border:1px solid rgba(96,180,255,0.22);border-radius:7px;padding:2px 9px;}
      #tab-content-treasury .trs-token.sm{font-size:10.5px;padding:1px 7px;}
      #tab-content-treasury .trs-controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-left:auto;}
      #tab-content-treasury .trs-input,#tab-content-treasury .trs-select{background:rgba(12,16,32,0.7);border:1px solid rgba(55,138,221,0.2);border-radius:9px;color:#dbe4f2;font-size:12px;padding:6px 10px;outline:none;}
      #tab-content-treasury .trs-input:focus,#tab-content-treasury .trs-select:focus{border-color:#60b4ff;box-shadow:0 0 0 3px rgba(96,180,255,.15);}
      #tab-content-treasury .trs-btn{display:inline-flex;align-items:center;gap:7px;background:rgba(55,138,221,0.09);border:1px solid rgba(55,138,221,0.2);border-radius:9px;color:#bcd6f5;font-size:12px;font-weight:700;padding:7px 12px;cursor:pointer;transition:all .15s;text-decoration:none;}
      #tab-content-treasury .trs-btn:hover{background:rgba(55,138,221,0.2);}
      #tab-content-treasury .trs-btn:disabled{opacity:.4;cursor:not-allowed;}
      #tab-content-treasury .trs-btn-primary{background:linear-gradient(135deg,#b45309,#f59e0b);border:none;color:#fff;}
      #tab-content-treasury .trs-btn-primary:hover{filter:brightness(1.08);}
      #tab-content-treasury .trs-btn-sm{font-size:11px;padding:4px 9px;}
      #tab-content-treasury .trs-actions{display:flex;gap:8px;flex-wrap:wrap;}
      #tab-content-treasury .trs-alert-row{display:flex;align-items:center;gap:11px;padding:10px 12px;background:rgba(12,16,32,0.6);border-radius:10px;margin-bottom:8px;}
      #tab-content-treasury .trs-tablewrap{overflow-x:auto;border:1px solid rgba(55,138,221,0.1);border-radius:12px;}
      #tab-content-treasury .trs-table{width:100%;border-collapse:collapse;font-size:12px;min-width:640px;}
      #tab-content-treasury .trs-table thead th{text-align:left;padding:9px 12px;background:rgba(55,138,221,0.05);border-bottom:1px solid rgba(55,138,221,0.12);color:#5f7ba0;font-weight:700;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap;}
      #tab-content-treasury .trs-th{background:none;border:none;color:inherit;font:inherit;cursor:pointer;padding:0;text-transform:uppercase;letter-spacing:.04em;}
      #tab-content-treasury .trs-th:hover{color:#93c5fd;}
      #tab-content-treasury .trs-tr{cursor:pointer;transition:background .12s;}
      #tab-content-treasury .trs-tr:hover{background:rgba(55,138,221,0.06);}
      #tab-content-treasury .trs-tr:focus{outline:2px solid #60b4ff;outline-offset:-2px;}
      #tab-content-treasury .trs-table td{padding:9px 12px;border-bottom:1px solid rgba(55,138,221,0.06);color:#cdd8ea;white-space:nowrap;}
      #tab-content-treasury .trs-route{font-size:11px;color:#9db8d8;display:inline-flex;align-items:center;gap:5px;}
      #tab-content-treasury .trs-chip{display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:700;padding:2px 8px;border-radius:999px;white-space:nowrap;}
      #tab-content-treasury .trs-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}
      #tab-content-treasury .trs-dim{color:#5f7ba0;font-size:11px;}
      #tab-content-treasury .trs-ic{width:24px;height:24px;border-radius:6px;background:rgba(55,138,221,0.09);border:1px solid rgba(55,138,221,0.2);color:#7fa8d8;cursor:pointer;font-size:10px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;text-decoration:none;transition:all .15s;}
      #tab-content-treasury .trs-ic:hover{background:rgba(55,138,221,0.2);color:#bcd6f5;}
      #tab-content-treasury .trs-pgbtn{width:28px;height:28px;border-radius:8px;background:rgba(55,138,221,0.09);border:1px solid rgba(55,138,221,0.2);color:#9db8d8;cursor:pointer;font-size:11px;}
      #tab-content-treasury .trs-pgbtn:disabled{opacity:.4;cursor:not-allowed;}
      #tab-content-treasury .trs-pager{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px;flex-wrap:wrap;}
      #tab-content-treasury .trs-settle{display:flex;align-items:center;gap:11px;padding:10px 12px;background:rgba(52,211,153,0.04);border:1px solid rgba(52,211,153,0.12);border-radius:11px;margin-bottom:8px;}
      #tab-content-treasury .trs-settle-ic{width:28px;height:28px;border-radius:8px;background:rgba(52,211,153,0.12);display:flex;align-items:center;justify-content:center;flex-shrink:0;}
      #tab-content-treasury .trs-feed{display:flex;flex-direction:column;}
      #tab-content-treasury .trs-feed-item{display:flex;gap:11px;padding-bottom:11px;}
      #tab-content-treasury .trs-feed-item:last-child{padding-bottom:0;}
      #tab-content-treasury .trs-feed-rail{display:flex;flex-direction:column;align-items:center;flex-shrink:0;}
      #tab-content-treasury .trs-feed-dot{width:24px;height:24px;border-radius:50%;border:1px solid;display:flex;align-items:center;justify-content:center;font-size:9px;background:rgba(8,11,24,0.6);}
      #tab-content-treasury .trs-feed-line{width:2px;flex:1;background:rgba(55,138,221,0.18);margin-top:2px;min-height:8px;}
      #tab-content-treasury .trs-feed-title{font-size:12.5px;font-weight:700;color:#cdd8ea;display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
      #tab-content-treasury .trs-analytics-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;}
      #tab-content-treasury .trs-chart{background:rgba(55,138,221,0.04);border:1px solid rgba(55,138,221,0.12);border-radius:12px;padding:11px 12px;}
      #tab-content-treasury .trs-chart-t{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#5f7ba0;margin-bottom:8px;}
      #tab-content-treasury .trs-empty{padding:20px;text-align:center;color:#5f7ba0;font-size:12px;font-style:italic;}
      #tab-content-treasury .trs-bar{height:7px;background:rgba(55,138,221,0.12);border-radius:6px;overflow:hidden;}
      #tab-content-treasury .trs-bar-fill{height:100%;border-radius:6px;}
      #tab-content-treasury .trs-mini-row{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid rgba(55,138,221,0.06);font-size:12px;color:#cdd8ea;cursor:pointer;}
      #tab-content-treasury .trs-pipe{display:flex;align-items:center;gap:4px;overflow-x:auto;padding:6px 0;}
      #tab-content-treasury .trs-pipe-stage{display:flex;flex-direction:column;align-items:center;gap:4px;min-width:84px;flex-shrink:0;}
      #tab-content-treasury .trs-pipe-dot{width:34px;height:34px;border-radius:50%;border:1px solid;display:flex;align-items:center;justify-content:center;font-size:12px;background:rgba(8,11,24,0.6);}
      #tab-content-treasury .trs-pipe-count{font-size:16px;font-weight:800;}
      #tab-content-treasury .trs-pipe-arrow{color:#3a4870;flex-shrink:0;}
      #tab-content-treasury .trs-heat{border-collapse:collapse;font-size:11px;}
      #tab-content-treasury .trs-heat th{padding:5px 8px;color:#5f7ba0;font-size:10px;text-transform:uppercase;font-weight:700;text-align:center;}
      #tab-content-treasury .trs-heat-row{color:#9db8d8;font-weight:700;white-space:nowrap;padding-right:10px;}
      #tab-content-treasury .trs-heat-cell{text-align:center;padding:8px 10px;border-radius:6px;color:#dbe4f2;font-weight:700;min-width:56px;}
      #tab-content-treasury .trs-flow{display:flex;align-items:center;gap:0;overflow-x:auto;padding:6px 0;}
      #tab-content-treasury .trs-flow-node{background:rgba(12,16,32,0.6);border:1px solid rgba(55,138,221,0.12);border-radius:11px;padding:10px 14px;min-width:130px;flex-shrink:0;text-align:center;}
      #tab-content-treasury .trs-flow-arrow{color:#3a4870;padding:0 8px;flex-shrink:0;}
      #tab-content-treasury .trs-flow-arrow:last-child{display:none;}
      #tab-content-treasury .trs-ws.hidden{display:none;}
      .trs-overlay{position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,0.55);backdrop-filter:blur(3px);display:flex;justify-content:flex-end;padding:0;}
      .trs-overlay.hidden{display:none;}
      .trs-panel{width:100%;max-width:460px;height:100%;background:#0a0c18;border-left:1px solid rgba(55,138,221,0.2);overflow-y:auto;padding:18px;transform:translateX(30px);opacity:0;transition:transform .18s ease,opacity .18s ease;outline:none;}
      .trs-panel.open{transform:translateX(0);opacity:1;}
      .trs-modal{width:100%;max-width:680px;margin:6vh auto;background:#0a0c18;border:1px solid rgba(55,138,221,0.2);border-radius:16px;padding:18px;max-height:88vh;overflow-y:auto;}
      .trs-panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;}
      .trs-psec-title{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#5f7ba0;margin:16px 0 8px;}
      .trs-pcard{background:rgba(12,16,32,0.6);border:1px solid rgba(55,138,221,0.12);border-radius:12px;padding:6px 12px;}
      .trs-prow{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid rgba(55,138,221,0.07);}
      .trs-prow:last-child{border-bottom:none;}
      .trs-pk{font-size:11px;color:#5f7ba0;min-width:130px;flex-shrink:0;}
      .trs-pv{font-size:12px;color:#dbe4f2;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .trs-btn{display:inline-flex;align-items:center;gap:7px;background:rgba(55,138,221,0.09);border:1px solid rgba(55,138,221,0.2);border-radius:9px;color:#bcd6f5;font-size:12px;font-weight:700;padding:7px 12px;cursor:pointer;text-decoration:none;}
      .trs-btn-primary{background:linear-gradient(135deg,#b45309,#f59e0b);border:none;color:#fff;}
      .trs-btn-sm{font-size:11px;padding:4px 9px;}
      @media (max-width:860px){ #tab-content-treasury .trs-kpis{grid-template-columns:repeat(2,1fr);} #tab-content-treasury .trs-grid-2{grid-template-columns:1fr;} }
      @media (max-width:520px){ #tab-content-treasury .trs-kpis{grid-template-columns:1fr;} }
    `;
    document.head.appendChild(st);
  }
  function sec(title, icon, color, bodyId, extraHead) { return `<section class="trs-sec" aria-label="${esc(title)}"><div class="trs-sec-head"><span class="trs-sec-title"><i class="fas ${icon}" style="color:${color};"></i>${esc(title)}</span>${extraHead || ''}</div><div class="trs-card trs-pad"><div id="${bodyId}"></div></div></section>`; }

  function buildSkeleton() {
    const root = q('trs-root'); if (!root) return; injectStyle();
    const nav = WORKSPACES.map(w => `<button id="trs-nav-${w.id}" class="trs-nav-btn ${w.id === S.ws ? 'active' : ''}" onclick="trsGoto('${w.id}')" aria-label="${esc(w.label)} workspace"><i class="fas ${w.icon}"></i>${esc(w.label)}</button>`).join('');
    root.innerHTML = `
      <div class="trs-card" style="padding:16px 18px;margin-bottom:16px;">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:12px;">
            <div style="width:44px;height:44px;border-radius:13px;background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.25);display:flex;align-items:center;justify-content:center;flex-shrink:0;"><i class="fas fa-landmark" style="color:#f59e0b;font-size:18px;"></i></div>
            <div><h2 style="font-size:19px;font-weight:800;color:#eef2fb;margin:0;line-height:1.1;">Treasury <span id="trs-alert-badge" class="trs-chip" style="display:none;background:rgba(239,68,68,0.16);border:1px solid rgba(239,68,68,0.4);color:#f87171;vertical-align:middle;"></span></h2><p style="font-size:12px;color:#8aaac8;margin:3px 0 0;">Inbound Turbo Bridge Control Center · <span style="color:#67e8f9;font-weight:700;">External Chains → Arc</span></p></div>
          </div>
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
            <span class="trs-chip" style="color:#9db8d8;background:rgba(55,138,221,0.08);border:1px solid rgba(55,138,221,0.16);padding:5px 11px;"><i class="fas fa-network-wired" style="font-size:9px;"></i>${esc(TRS_NETWORK)} · ${TRS_CHAIN_ID}</span>
            <span id="trs-hdr-status" class="trs-chip" style="background:rgba(55,138,221,0.06);border:1px solid rgba(55,138,221,0.16);padding:5px 11px;"><span class="trs-hdot" style="background:#5f7ba0;"></span><span class="trs-dim">Checking…</span></span>
            <span id="trs-hdr-sync" class="trs-dim">Syncing…</span>
            <button onclick="trsRefreshNow()" class="trs-btn" aria-label="Refresh treasury data" style="color:#60b4ff;"><i class="fas fa-rotate" style="font-size:11px;"></i>Refresh</button>
          </div>
        </div>
        <div style="margin-top:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <div style="position:relative;flex:1;min-width:200px;"><i class="fas fa-magnifying-glass" style="position:absolute;left:11px;top:50%;transform:translateY(-50%);color:#5f7ba0;font-size:11px;"></i><input id="trs-global-search" class="trs-input" style="width:100%;padding-left:30px;" type="search" placeholder="Treasury explorer — search intent, tx, hash, wallet, asset…" onkeydown="if(event.key==='Enter')trsGlobalSearch()" aria-label="Global treasury search"></div>
          <button class="trs-btn" onclick="trsGlobalSearch()"><i class="fas fa-magnifying-glass"></i>Search</button>
        </div>
      </div>

      <div class="trs-nav" role="tablist" aria-label="Treasury workspaces">${nav}</div>

      <div id="trs-ws-overview" class="trs-ws">
        <section class="trs-sec"><div class="trs-sec-head"><span class="trs-sec-title"><i class="fas fa-gauge-high" style="color:#60b4ff;"></i>Overview</span></div><div id="trs-overview" class="trs-kpis"></div></section>
        ${sec('Alerts Center', 'fa-bell', '#f87171', 'trs-alerts')}
        ${sec('Action Center', 'fa-bolt', '#fbbf24', 'trs-actions-overview')}
        ${sec('Treasury Governance & Contracts', 'fa-scale-balanced', '#fbbf24', 'trs-governance')}
        <div class="trs-grid-2">${sec('Treasury Health', 'fa-heart-pulse', '#34d399', 'trs-health-overview')}${sec('Recent Event Stream', 'fa-wave-square', '#67e8f9', 'trs-events-overview')}</div>
      </div>

      <div id="trs-ws-vault" class="trs-ws hidden">
        ${sec('Vault Dashboard', 'fa-vault', '#f59e0b', 'trs-vault-dash')}
        ${sec('Vault Operations', 'fa-sliders', '#fbbf24', 'trs-vault-ops')}
        ${sec('Vault Balances by Asset', 'fa-coins', '#60b4ff', 'trs-vault-assets')}
        ${sec('Vault Explorer', 'fa-magnifying-glass-chart', '#a78bfa', 'trs-vault-explorer')}
        ${sec('Vault History (on-chain events)', 'fa-clock-rotate-left', '#67e8f9', 'trs-vault-history')}
      </div>

      <div id="trs-ws-intents" class="trs-ws hidden">
        <section class="trs-sec"><div class="trs-sec-head"><span class="trs-sec-title"><i class="fas fa-list-check" style="color:#fbbf24;"></i>Inbound Intent Queue</span><div class="trs-controls"><input id="trs-search" class="trs-input" type="search" placeholder="Search…" oninput="trsApplyFilters()" aria-label="Search intents" style="min-width:150px;"><select id="trs-filter-status" class="trs-select" onchange="trsApplyFilters()" aria-label="Filter by status"><option value="all">All status</option><option value="pending">Pending</option><option value="processing">Processing</option><option value="review">Manual Review</option><option value="completed">Completed</option><option value="failed">Failed</option></select><select id="trs-filter-asset" class="trs-select" onchange="trsApplyFilters()" aria-label="Filter by asset" data-count=""><option value="all">All assets</option></select><select id="trs-filter-chain" class="trs-select" onchange="trsApplyFilters()" aria-label="Filter by origin" data-count=""><option value="all">All origins</option></select></div></div><div class="trs-card trs-pad"><div id="trs-intents"></div><div id="trs-intents-pager" class="trs-pager"></div></div></section>
      </div>

      <div id="trs-ws-settlements" class="trs-ws hidden">
        ${sec('Settlement Pipeline', 'fa-diagram-project', '#67e8f9', 'trs-pipeline')}
        ${sec('Treasury Vault Settlements (real, on-chain)', 'fa-vault', '#f59e0b', 'trs-vault-settlements')}
        ${sec('Recent Settlements', 'fa-check-double', '#34d399', 'trs-settlements-list')}
      </div>

      <div id="trs-ws-mint" class="trs-ws hidden">
        ${sec('Mintable Liquidity — Vault Reserves', 'fa-coins', '#34d399', 'trs-mint-liquidity')}
        <section class="trs-sec"><div class="trs-sec-head"><span class="trs-sec-title"><i class="fas fa-hand-holding-dollar" style="color:#f59e0b;"></i>Inbound Intents — Mint &amp; Settle</span><div class="trs-controls"><button class="trs-btn trs-btn-primary trs-btn-sm" onclick="trsMintAll()" aria-label="Mint all pending intents"><i class="fas fa-wand-magic-sparkles"></i>Mint All Pending</button></div></div><div id="trs-mint-operator" style="margin-bottom:10px;"></div><div class="trs-card trs-pad"><div id="trs-mint-queue"></div></div></section>
      </div>

      <div id="trs-ws-liquidity" class="trs-ws hidden">
        ${sec('Liquidity by Asset', 'fa-water', '#60b4ff', 'trs-liq-assets')}
        ${sec('Liquidity Heatmap — Origin × Asset', 'fa-fire', '#f59e0b', 'trs-heatmap')}
        ${sec('Reserves by Origin Chain', 'fa-coins', '#a78bfa', 'trs-reserves')}
        ${sec('Liquidity Forecast', 'fa-chart-line', '#34d399', 'trs-forecast')}
      </div>

      <div id="trs-ws-analytics" class="trs-ws hidden">
        ${sec('Analytics', 'fa-chart-pie', '#a78bfa', 'trs-analytics')}
      </div>

      <div id="trs-ws-diagnostics" class="trs-ws hidden">
        ${sec('Infrastructure Diagnostics', 'fa-stethoscope', '#67e8f9', 'trs-diag-grid')}
        <div class="trs-grid-2">${sec('Workers (Inbound)', 'fa-microchip', '#67e8f9', 'trs-diag-workers')}${sec('Queue Inspector', 'fa-layer-group', '#fbbf24', 'trs-diag-queues')}</div>
        ${sec('Treasury Policies', 'fa-scroll', '#a78bfa', 'trs-diag-policies')}
        ${sec('Event Stream (Inbound)', 'fa-wave-square', '#67e8f9', 'trs-diag-events')}
      </div>
    `;
    S.built = true; ensurePanel();
  }

  // ─── Render active workspace only (perf) ────────────────────────────────────
  function renderActive() {
    S.dm = deriveMetrics(S.intents);
    renderHeader();
    switch (S.ws) {
      case 'overview': renderOverviewWs(); break;
      case 'vault': renderVaultWs(); break;
      case 'intents': renderIntents(); break;
      case 'settlements': renderSettlementsWs(); break;
      case 'mint': renderMintWs(); break;
      case 'liquidity': renderLiquidityWs(); break;
      case 'analytics': renderAnalyticsWs(); break;
      case 'diagnostics': renderDiagnosticsWs(); break;
    }
  }

  function focusedInInput() { const a = document.activeElement; if (!a) return false; const tag = (a.tagName || '').toLowerCase(); if (tag !== 'input' && tag !== 'select' && tag !== 'textarea') return false; const t = q('tab-content-treasury'); return t && t.contains(a); }

  async function refresh(showFeedback) {
    if (S.loading) return; S.loading = true;
    try {
      if (!DISCOVERY_DONE) await loadDiscovery().catch(() => {});
      const [intents, metricsRemote, health, system, dex, policies] = await Promise.all([
        loadIntents().catch(() => S.intents), loadRemoteMetrics().catch(() => null), loadHealth().catch(() => S.health),
        loadSystem().catch(() => S.system), loadDexPools().catch(() => null), loadPolicies().catch(() => S.policies),
      ]);
      S.intents = Array.isArray(intents) ? intents : S.intents; S.metricsRemote = metricsRemote; S.health = health || S.health; S.system = system || S.system; S.dexPools = dex; S.policies = policies || S.policies;
      await loadOperator().catch(() => {});
      S.vault = await loadVault(S.intents).catch(() => S.vault || []);
      await loadGovernance().catch(() => {});
      if (!S.caps.checked) await detectCapabilities().catch(() => {});
      S.lastSync = Date.now();
      if (!focusedInInput()) renderActive(); else renderHeader();
      if (showFeedback) toast('Treasury updated', 'success');
    } catch (e) { if (showFeedback) toast('Some treasury data could not be loaded', 'warning'); }
    finally { S.loading = false; }
  }
  function tabActive() { const el = q('tab-content-treasury'); return el && !el.classList.contains('hidden'); }
  function startAuto() { if (S.timer) clearInterval(S.timer); S.timer = setInterval(() => { if (tabActive() && !document.hidden) refresh(false); }, TRS_REFRESH_MS); }
  function onExt() { if (tabActive()) refresh(false); }
  ['ub:bridge:completed', 'ub:cctp:completed', 'treasury:completed', 'ub:agent:executed'].forEach((ev) => { try { window.addEventListener(ev, onExt); } catch (_) {} });
  try { window.addEventListener('treasurybridge:event', (e) => { const d = (e && e.detail) || {}; if (['SettlementCompleted', 'SettlementFailed', 'LowLiquidity'].indexOf(d.name) !== -1) toast('Treasury: ' + d.name, d.name === 'SettlementCompleted' ? 'success' : (d.name === 'SettlementFailed' ? 'error' : 'warning')); if (tabActive() && !S.loading) refresh(false); }); } catch (_) {}
  try { window.addEventListener('treasury:metrics', () => { if (tabActive()) loadRemoteMetrics().then((m) => { S.metricsRemote = m; }); }); } catch (_) {}

  window.treasuryInit = function () { try { buildSkeleton(); refresh(false); startAuto(); } catch (e) { console.error('[Treasury] init failed', e); } };
  window.treasuryRefresh = function () { if (!S.built) { window.treasuryInit(); return; } refresh(false); };

  console.log('%c[Treasury] Inbound Control Center loaded', 'color:#f59e0b;font-weight:bold', '| v' + TRS_VERSION + ' | External → Arc | workspaces + capability detection | real-data only');
})();
