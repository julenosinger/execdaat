// ============================================================
// REIMBURSEMENTS MODULE — ExecDaat Treasury Operations Dashboard
// ------------------------------------------------------------
// 100% READ-ONLY, ADDITIVE, MONITORING ONLY.
//
// This module NEVER executes, signs, or settles anything. It does not hold,
// move, lock, or reimburse funds. ALL liquidation/settlement/reimbursement
// continues to occur EXCLUSIVELY on the Elligent Treasury Core.
//
// It provides a professional, real-time Treasury Operations Dashboard that
// tracks, syncs, monitors, displays, audits and informs the full lifecycle of
// every ExecDaat-originated intent:
//   Intent Created → Liquidity Reserved → Vault Debited → Treasury Paid →
//   Waiting Circle Attestation → Circle Attested → Waiting Mint →
//   Mint Executed → Settlement Running → Treasury Settled → Vault Reimbursed →
//   Completed
//
// Single source of truth: the Elligent Treasury Core, via the SAME existing
// same-origin proxy (window.TreasuryCore):
//   GET /api/core/v1/history         window.TreasuryCore.history()
//   GET /api/core/v1/metrics         window.TreasuryCore.metrics()
//   GET /api/core/v1/applications    window.TreasuryCore.applications()
//   GET /api/core/v1/intents/{id}    window.TreasuryCore.getIntent()
//
// No new APIs, no duplicated business logic, no secrets. Nothing financial is
// computed authoritatively here — figures prefer Core /metrics; the rest are
// simple non-authoritative summaries of the data the Core returns.
//
// Exposes: window.reimbursementsInit / window.reimbursementsRefresh
// build: 20260709r2
// ============================================================
'use strict';

(function () {
  const REIM_VERSION = '20260709r3';
  const ARC_EXPLORER = 'https://testnet.arcscan.app';
  // Self-contained ExecDaat vault (native Treasury Core). Legacy records may
  // still carry the old Elligent vault — normalize to the ExecDaat vault for display.
  const EXECDAAT_VAULT = '0x1e039fF538Ed84Ad54610D644ca36D4b03167B87';
  const LEGACY_ELLIGENT_VAULT = '0xbfc9e8f79bd30b912081ae88f9ad0a515f08c2f1';
  const REFRESH_ACTIVE_MS = 15000;   // request-optimization: 4s → 15s (event bus still triggers instant refreshes)
  const REFRESH_IDLE_MS = 60000;     // request-optimization: 20s → 60s (everything terminal)
  const CACHE_TTL_MS = 30000;        // metrics/applications ONLY (never status/history)

  const S = {
    intents: [],
    metricsRemote: null,
    applications: null,
    prevStatus: {},          // intentId -> statusKey (for notifications)
    lastSync: 0,
    loading: false,
    built: false,
    timer: null,
    timerMs: 0,
    coreError: false,        // Treasury Core temporarily unavailable
    coreErrorMsg: '',
    failStreak: 0,
    // caches (metrics/applications only)
    _cache: {},
    // filters / search
    search: '',
    fStatus: 'all', fChain: 'all', fAsset: 'all', fBridge: 'all', fApp: 'all',
    fFrom: '', fTo: '',
    sortKey: 'created', sortDir: 'desc',
    page: 1, pageSize: 15,
    view: 'list',            // 'list' | 'analytics'
    selected: null,
    firstLoad: true,
  };

  // ─── Helpers ─────────────────────────────────────────────────────────────────
  const q = (id) => document.getElementById(id);
  const W = (n) => { try { return window[n]; } catch (_) { return undefined; } };
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const escAttr = (s) => esc(s).replace(/'/g, '&#39;');
  function toast(m, t) { try { if (typeof showToast === 'function') showToast(m, t || 'info'); } catch (_) {} }
  const num = (v) => { const n = Number(v); return isFinite(n) ? n : null; };
  function fmtNum(v, dp) { const n = num(v); if (n == null) return '—'; return n.toLocaleString('en-US', { minimumFractionDigits: dp == null ? 0 : dp, maximumFractionDigits: dp == null ? 2 : dp }); }
  function fmtAmt(v) { const n = num(v); if (n == null) return '—'; return fmtNum(n, 2); }
  const shortAddr = (a) => (!a || typeof a !== 'string' || a.length < 12) ? (a || '—') : a.slice(0, 6) + '…' + a.slice(-4);
  const shortHash = (h) => (!h || typeof h !== 'string' || h.length < 14) ? (h || '—') : h.slice(0, 8) + '…' + h.slice(-6);
  function toMs(t) { if (t == null || t === '') return 0; if (typeof t === 'number') { if (t > 1e12) return t; if (t > 1e9) return t * 1000; return t; } const p = Date.parse(t); return isNaN(p) ? 0 : p; }
  function timeAgo(ms) { if (!ms) return '—'; const s = Math.max(0, Math.floor((Date.now() - ms) / 1000)); if (s < 60) return s + 's ago'; const m = Math.floor(s / 60); if (m < 60) return m + 'm ago'; const h = Math.floor(m / 60); if (h < 24) return h + 'h ago'; return Math.floor(h / 24) + 'd ago'; }
  function fmtDur(ms) { if (ms == null || !isFinite(ms) || ms <= 0) return '—'; const s = Math.round(ms / 1000); if (s < 60) return s + 's'; const m = Math.floor(s / 60); if (m < 60) return m + 'm ' + (s % 60) + 's'; const h = Math.floor(m / 60); return h + 'h ' + (m % 60) + 'm'; }
  function fmtDate(ms) { if (!ms) return '—'; return new Date(ms).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }); }
  function startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function dayKey(ms) { const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

  function copyText(val, label) { try { navigator.clipboard.writeText(String(val || '')); toast((label || 'Value') + ' copied', 'success'); } catch (_) {} }
  window.reimCopy = copyText;
  function copyBtn(val, label) { if (!val) return ''; return `<button type="button" class="reim-ic" title="Copy ${escAttr(label || '')}" aria-label="Copy ${escAttr(label || '')}" onclick="event.stopPropagation();reimCopy('${escAttr(val)}','${escAttr(label || '')}')"><i class="fas fa-copy"></i></button>`; }
  function txLink(hash, base, label) { if (!hash) return '<span class="reim-dim">—</span>'; return `<a class="reim-txn" href="${base || ARC_EXPLORER}/tx/${escAttr(hash)}" target="_blank" rel="noopener" title="View ${escAttr(label || 'transaction')} on explorer" onclick="event.stopPropagation();">${esc(shortHash(hash))}<i class="fas fa-external-link-alt"></i></a>`; }

  // ─── Asset / chain visuals ─────────────────────────────────────────────────────
  const ASSET_META = {
    USDC: { color: '#2775CA', label: 'USDC' }, EURC: { color: '#1A54F4', label: 'EURC' },
    ETH: { color: '#627EEA', label: 'ETH' }, ARB: { color: '#28A0F0', label: 'ARB' },
    OP: { color: '#FF0420', label: 'OP' }, BASE: { color: '#0052FF', label: 'BASE' },
    POLYGON: { color: '#8247E5', label: 'POL' }, MATIC: { color: '#8247E5', label: 'POL' },
    SOL: { color: '#14F195', label: 'SOL' }, SOLANA: { color: '#14F195', label: 'SOL' },
    ARC: { color: '#f59e0b', label: 'ARC' },
  };
  function assetBadge(sym) { const s = String(sym || '').toUpperCase(); const m = ASSET_META[s] || { color: '#8aaac8', label: s || '—' }; return `<span class="reim-asset"><span class="reim-asset-dot" style="background:${m.color};"></span>${esc(m.label)}</span>`; }
  const CHAIN_META = {
    arc: { name: 'Arc', color: '#f59e0b' },
    ethereum: { name: 'Ethereum', color: '#627EEA' }, eth: { name: 'Ethereum', color: '#627EEA' }, sepolia: { name: 'Sepolia', color: '#627EEA' },
    arbitrum: { name: 'Arbitrum', color: '#28A0F0' }, arb: { name: 'Arbitrum', color: '#28A0F0' },
    optimism: { name: 'Optimism', color: '#FF0420' }, op: { name: 'Optimism', color: '#FF0420' },
    base: { name: 'Base', color: '#0052FF' },
    polygon: { name: 'Polygon', color: '#8247E5' }, matic: { name: 'Polygon', color: '#8247E5' },
    solana: { name: 'Solana', color: '#14F195' }, sol: { name: 'Solana', color: '#14F195' },
    avalanche: { name: 'Avalanche', color: '#E84142' }, avax: { name: 'Avalanche', color: '#E84142' },
  };
  function chainName(k) { const m = CHAIN_META[String(k || '').toLowerCase()]; return m ? m.name : (k || '—'); }
  function chainChip(k) { if (!k) return '<span class="reim-dim">—</span>'; const m = CHAIN_META[String(k).toLowerCase()] || { name: k, color: '#8aaac8' }; return `<span class="reim-chain"><span class="reim-chain-dot" style="background:${m.color};"></span>${esc(m.name)}</span>`; }

  // ─── Status model (full Treasury lifecycle) ──────────────────────────────────
  const STATUS_META = {
    created:       { label: 'Intent Created',            color: '#93c5fd', rgb: '147,197,253', icon: 'fa-file-circle-plus',    group: 'open' },
    reserved:      { label: 'Liquidity Reserved',        color: '#7dd3fc', rgb: '125,211,252', icon: 'fa-lock',                group: 'open' },
    vault_debited: { label: 'Vault Debited',             color: '#38bdf8', rgb: '56,189,248',  icon: 'fa-money-bill-transfer', group: 'progress' },
    treasury_paid: { label: 'Treasury Paid',             color: '#a78bfa', rgb: '167,139,250', icon: 'fa-hand-holding-dollar', group: 'progress' },
    waiting_att:   { label: 'Waiting Circle Attestation',color: '#fbbf24', rgb: '245,158,11',  icon: 'fa-satellite-dish',      group: 'progress' },
    attested:      { label: 'Circle Attested',           color: '#67e8f9', rgb: '34,211,238',  icon: 'fa-certificate',         group: 'progress' },
    waiting_mint:  { label: 'Waiting Mint',              color: '#fbbf24', rgb: '245,158,11',  icon: 'fa-hourglass-half',      group: 'progress' },
    minted:        { label: 'Mint Executed',             color: '#67e8f9', rgb: '34,211,238',  icon: 'fa-coins',               group: 'progress' },
    settling:      { label: 'Settlement Running',        color: '#c084fc', rgb: '192,132,252', icon: 'fa-gears',               group: 'progress' },
    settled:       { label: 'Treasury Settled',          color: '#34d399', rgb: '52,211,153',  icon: 'fa-check-double',        group: 'progress' },
    reimbursed:    { label: 'Vault Reimbursed',          color: '#34d399', rgb: '52,211,153',  icon: 'fa-arrow-rotate-left',   group: 'done' },
    completed:     { label: 'Completed',                 color: '#10b981', rgb: '16,185,129',  icon: 'fa-circle-check',        group: 'done' },
    retrying:      { label: 'Retrying',                  color: '#fb923c', rgb: '251,146,60',  icon: 'fa-rotate',              group: 'progress' },
    failed:        { label: 'Failed',                    color: '#f87171', rgb: '239,68,68',   icon: 'fa-circle-xmark',        group: 'fail' },
    cancelled:     { label: 'Cancelled',                 color: '#9ca3af', rgb: '148,163,184', icon: 'fa-ban',                 group: 'fail' },
    unknown:       { label: 'Unknown',                   color: '#8aaac8', rgb: '138,170,200', icon: 'fa-circle',              group: 'open' },
  };
  // Linear progression used for progress indicators & timeline.
  const STATUS_ORDER = ['created', 'reserved', 'vault_debited', 'treasury_paid', 'waiting_att', 'attested', 'waiting_mint', 'minted', 'settling', 'settled', 'reimbursed', 'completed'];
  const PENDING_KEYS = { created: 1, reserved: 1, vault_debited: 1, treasury_paid: 1, waiting_att: 1, attested: 1, waiting_mint: 1, minted: 1, settling: 1, settled: 1, retrying: 1 };

  function progressPct(key) { const i = STATUS_ORDER.indexOf(key); if (i < 0) return key === 'failed' || key === 'cancelled' ? 100 : 5; return Math.round(((i + 1) / STATUS_ORDER.length) * 100); }
  function statusBadge(key) { const m = STATUS_META[key] || STATUS_META.unknown; return `<span class="reim-chip" style="color:${m.color};background:rgba(${m.rgb},0.12);border:1px solid rgba(${m.rgb},0.3);"><i class="fas ${m.icon}" style="font-size:8px;"></i>${m.label}</span>`; }
  function progressBar(key) { const m = STATUS_META[key] || STATUS_META.unknown; const pct = progressPct(key); const isFail = m.group === 'fail'; return `<div class="reim-prog" title="${pct}%"><div class="reim-prog-fill" style="width:${pct}%;background:${isFail ? '#f87171' : m.color};"></div></div>`; }

  function deriveStatus(it) {
    const raw = String(it.rawStatus || '').toLowerCase();
    if (/retry|retrying/.test(raw)) return 'retrying';
    if (/fail|error|revert/.test(raw)) return 'failed';
    if (/cancel|expire/.test(raw)) return 'cancelled';

    const rs = String(it.reimbursementStatus || '').toLowerCase();
    const ss = String(it.settlementStatus || '').toLowerCase();

    // Completion / reimbursement (end of pipeline)
    if (/complete|completed/.test(raw) && (it.vaultCreditTx || /complete|done|reimbursed|success/.test(rs))) return 'completed';
    if (it.vaultCreditTx || /complete|done|reimbursed|success/.test(rs)) return 'reimbursed';
    if (rs && /pending|processing|await|progress|running/.test(rs)) return 'settled'; // settled, awaiting reimbursement

    // Settlement
    if (/running|processing|progress/.test(ss)) return 'settling';
    if (it.settleTx || /settled|settlement complete|complete/.test(raw)) return 'settled';
    if (/settl/.test(raw)) return 'settling';

    // Mint
    if (it.mintTx || /minted|mint executed/.test(raw)) return 'minted';
    if (/waiting_mint|awaiting mint|mint/.test(raw)) return 'waiting_mint';

    // Attestation
    if (it.attestation || /attested|attestation received/.test(raw)) return 'attested';
    if (/attest/.test(raw)) return 'waiting_att';

    // Treasury / vault advance
    if (it.fulfillTx || /treasury paid|fulfil|paid/.test(raw) || /paid/.test(String(it.treasuryPaymentStatus || '').toLowerCase())) return it.burnTx ? 'waiting_att' : 'treasury_paid';
    if (/debited/.test(String(it.vaultDebitStatus || '').toLowerCase()) || /vault debited|debited/.test(raw)) return 'vault_debited';
    if (/reserved|liquidity reserved/.test(raw)) return 'reserved';

    // Burn submitted → next expected is attestation
    if (it.burnTx || /burn|bridging|executing/.test(raw)) return 'waiting_att';

    if (/creat|new|queued|initiat|pending/.test(raw)) return 'created';
    return it.settleTx ? 'settled' : 'created';
  }

  // ─── Normalization from Treasury Core shapes ─────────────────────────────────
  function deep(x, path) { try { return path.split('.').reduce((o, k) => (o == null ? o : o[k]), x); } catch (_) { return undefined; } }
  function firstOf(x, keys) { for (const k of keys) { const v = k.indexOf('.') !== -1 ? deep(x, k) : x[k]; if (v != null && v !== '') return v; } return null; }

  function normIntent(x, source) {
    if (!x || typeof x !== 'object') return null;
    const id = firstOf(x, ['intentId', 'intent_id', 'id', 'intentBytes32', 'hash']) || ('int-' + Math.random().toString(16).slice(2, 8));
    const it = {
      id: String(id),
      intentId: String(firstOf(x, ['intentId', 'intent_id', 'id']) || id),
      application: firstOf(x, ['application', 'applicationId', 'app', 'app_id']) || 'EXECDAAT',
      client: firstOf(x, ['client', 'clientId']) || null,
      environment: firstOf(x, ['environment', 'env', 'mode', 'applicationMode']) || null,
      wallet: firstOf(x, ['wallet', 'userAddress', 'sender', 'account', 'from']) || null,
      recipient: firstOf(x, ['recipient', 'receiver', 'to', 'destination']) || null,
      asset: String(firstOf(x, ['asset', 'token', 'symbol', 'currency']) || '—').toUpperCase(),
      amount: firstOf(x, ['amount', 'grossAmount', 'value', 'inputAmount', 'srcAmount']),
      srcChain: firstOf(x, ['sourceChain', 'srcChain', 'source_chain', 'from_chain', 'origin']),
      dstChain: firstOf(x, ['destinationChain', 'dstChain', 'destination_chain', 'to_chain']) || 'arc',
      bridge: firstOf(x, ['bridge', 'route', 'bridgeType', 'method']) || null,
      vault: firstOf(x, ['vault', 'vaultAddress', 'vault.address', 'vaultUsed']) || null,
      memo: firstOf(x, ['memo', 'reference', 'note']) || null,
      nonce: firstOf(x, ['nonce', 'cctpNonce']),
      correlationId: firstOf(x, ['correlationId', 'correlation_id']) || null,
      ledgerEntry: firstOf(x, ['ledgerEntry', 'ledger', 'ledgerId']) || null,
      circleMessage: firstOf(x, ['circleMessage', 'message', 'cctpMessage', 'circle.message']) || null,
      rawStatus: firstOf(x, ['status', 'state', 'intentStatus', 'phase', 'currentStage', 'stage']) || 'unknown',
      // tx hashes
      burnTx: firstOf(x, ['sourceTxHash', 'burnTxHash', 'burnTx', 'depositTxHash', 'source_tx', 'txHash']),
      attestation: firstOf(x, ['attestation', 'attestationHash', 'circleAttestation', 'attestation.hash', 'circle.attestation']),
      mintTx: firstOf(x, ['circleMintTxHash', 'mintTxHash', 'destinationTxHash', 'mint_tx']),
      fulfillTx: firstOf(x, ['fulfillTxHash', 'fulfillmentTxHash', 'treasuryPayment.txHash', 'treasuryTxHash', 'fulfill_tx']),
      settleTx: firstOf(x, ['settlementTxHash', 'settlement.txHash', 'settle_tx']),
      vaultCreditTx: firstOf(x, ['vaultCreditTxHash', 'reimbursement.txHash', 'vaultCredit.txHash', 'vault_credit_tx']),
      // sub-states
      vaultDebitStatus: firstOf(x, ['vaultDebit.status', 'vaultDebitStatus']),
      vaultDebitAmount: firstOf(x, ['vaultDebit.amount', 'vaultDebitAmount']),
      treasuryPaymentStatus: firstOf(x, ['treasuryPayment.status', 'treasuryPaymentStatus']),
      attestationStatus: firstOf(x, ['attestationStatus', 'circle.status', 'circleStatus']),
      reimbursementStatus: firstOf(x, ['reimbursement.status', 'reimbursementStatus']),
      settlementStatus: firstOf(x, ['settlement.status', 'settlementStatus']),
      // times
      created: toMs(firstOf(x, ['createdAt', 'created_at', 'created', 'ts', 'timestamp'])),
      updated: toMs(firstOf(x, ['updatedAt', 'updated_at', 'updated'])),
      settledAt: toMs(firstOf(x, ['settledAt', 'settled_at', 'settlement.ts', 'completedAt', 'completed_at'])),
      reimbursedAt: toMs(firstOf(x, ['reimbursedAt', 'reimbursement.ts', 'reimbursement.completedAt'])),
      timeline: Array.isArray(x.timeline) ? x.timeline : null,
      explorer: firstOf(x, ['explorer', 'explorerUrl']) || null,
      source: source,
      raw: x,
    };
    it.statusKey = deriveStatus(it)
    // Normalize legacy/empty vault to the self-contained ExecDaat vault (display only).
    if (!it.vault || String(it.vault).toLowerCase() === LEGACY_ELLIGENT_VAULT) it.vault = EXECDAAT_VAULT;
    it.settlementMs = (it.settledAt && it.created) ? (it.settledAt - it.created) : null;
    it.reimbursementMs = (it.reimbursedAt && it.settledAt) ? (it.reimbursedAt - it.settledAt) : ((it.reimbursedAt && it.created) ? (it.reimbursedAt - it.created) : null);
    it.completedAt = it.reimbursedAt || ((it.statusKey === 'completed' || it.statusKey === 'reimbursed') ? it.updated : 0);
    return it;
  }

  function coreReady() {
    try {
      if (!W('TreasuryCore')) return false;
      const cfg = (W('TreasuryConfig') && window.TreasuryConfig.get && window.TreasuryConfig.get()) || null;
      if (cfg && cfg.enabled === false) return false;
      return true;
    } catch (_) { return false; }
  }
  async function withTimeout(p, ms) { return await Promise.race([Promise.resolve(p), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms || 9000))]); }

  // ─── Loaders ──────────────────────────────────────────────────────────────────
  async function loadData() {
    const out = [], seen = new Set();
    let coreOk = false, coreAttempted = false;
    const add = (arr, src) => { (arr || []).forEach((x) => { const n = normIntent(x, src); if (!n) return; const k = n.intentId || n.id; if (seen.has(k)) return; seen.add(k); out.push(n); }); };

    // 1) Treasury Core history — authoritative (never cached)
    if (W('TreasuryCore') && window.TreasuryCore.history) {
      coreAttempted = true;
      try {
        const r = await withTimeout(window.TreasuryCore.history({ limit: 300, application: 'EXECDAAT' }), 9000);
        const items = r && (r.items || r.history || r.data || (Array.isArray(r) ? r : null));
        if (Array.isArray(items)) { add(items, 'core'); coreOk = true; }
        else { coreOk = true; } // reachable, just empty
      } catch (e) { coreOk = false; S.coreErrorMsg = (e && e.friendly) || 'Treasury Core temporarily unavailable'; }
    }
    // 2) TreasuryData cache fallback (integration layer)
    if (!out.length && W('TreasuryData') && window.TreasuryData.history) {
      try { const arr = await withTimeout(window.TreasuryData.history({ limit: 300 }), 9000); if (Array.isArray(arr)) { add(arr, 'core'); coreOk = coreOk || true; } } catch (_) {}
    }
    // 3) Local Turbo Bridge store — surface in-flight ops not yet indexed by Core.
    try { const rc = W('RepaymentContract'); if (rc && rc.getAll) add(rc.getAll() || [], 'local'); } catch (_) {}

    // Track core availability (only when it was actually attempted).
    if (coreAttempted) {
      if (coreOk) { S.coreError = false; S.failStreak = 0; }
      else { S.failStreak++; if (S.failStreak >= 2) S.coreError = true; }
    }
    out.sort((a, b) => (b.created || 0) - (a.created || 0));
    return out;
  }

  function cacheGet(key) { const e = S._cache[key]; if (e && (Date.now() - e.t) < CACHE_TTL_MS) return e.v; return null; }
  function cacheSet(key, v) { S._cache[key] = { v: v, t: Date.now() }; }

  async function loadMetrics() {
    const hit = cacheGet('metrics'); if (hit) return hit;
    try { if (W('TreasuryCore') && window.TreasuryCore.metrics) { const m = await withTimeout(window.TreasuryCore.metrics({ application: 'EXECDAAT' }), 9000); if (m && typeof m === 'object' && !m.code && m.error == null) { cacheSet('metrics', m); return m; } } } catch (_) {}
    return null;
  }
  async function loadApplications() {
    const hit = cacheGet('applications'); if (hit) return hit;
    try { if (W('TreasuryCore') && window.TreasuryCore.applications) { const a = await withTimeout(window.TreasuryCore.applications(), 9000); const list = a && (a.applications || a.items || (Array.isArray(a) ? a : null)); if (Array.isArray(list)) { cacheSet('applications', list); return list; } } } catch (_) {}
    return S.applications;
  }

  // ─── Derived dashboard figures (Core /metrics preferred) ─────────────────────
  function derive(list) {
    const now = Date.now(), today0 = startOfDay(now);
    const month0 = (function () { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime(); })();
    const d = {
      totalReimbursed: 0, totalReimbursedCount: 0, pendingReimbursement: 0, pendingReimbursementCount: 0,
      vaultOutstanding: 0, settleTimes: [], reimbTimes: [], success: 0, terminal: 0,
      attestations: 0, pendingAttestations: 0, pendingMint: 0, failedOps: 0, activeIntents: 0,
      todayCount: 0, volumeToday: 0, volumeMonth: 0,
    };
    list.forEach((it) => {
      const amt = num(it.amount) || 0, k = it.statusKey, g = (STATUS_META[k] || {}).group;
      if (k === 'reimbursed' || k === 'completed') { d.totalReimbursed += amt; d.totalReimbursedCount++; }
      if (k === 'settled' || k === 'settling') { d.pendingReimbursement += amt; d.pendingReimbursementCount++; }
      // outstanding = treasury advanced (paid and beyond) but not yet reimbursed
      if (['treasury_paid', 'waiting_att', 'attested', 'waiting_mint', 'minted', 'settling', 'settled'].indexOf(k) !== -1) d.vaultOutstanding += amt;
      if (it.settlementMs) d.settleTimes.push(it.settlementMs);
      if (it.reimbursementMs) d.reimbTimes.push(it.reimbursementMs);
      if (g === 'done') d.success++;
      if (g === 'done' || g === 'fail') d.terminal++;
      if (g === 'fail' && k !== 'cancelled') d.failedOps++;
      if (PENDING_KEYS[k]) d.activeIntents++;
      if (it.attestation || ['attested', 'waiting_mint', 'minted', 'settling', 'settled', 'reimbursed', 'completed'].indexOf(k) !== -1) d.attestations++;
      if (k === 'waiting_att') d.pendingAttestations++;
      if (k === 'waiting_mint' || k === 'attested') d.pendingMint++;
      if (it.created >= today0) { d.todayCount++; d.volumeToday += amt; }
      if (it.created >= month0) d.volumeMonth += amt;
    });
    d.todaysReimbursements = list.filter((it) => (it.statusKey === 'reimbursed' || it.statusKey === 'completed') && (it.completedAt || it.reimbursedAt || 0) >= today0).length;
    d.avgSettle = d.settleTimes.length ? d.settleTimes.reduce((a, b) => a + b, 0) / d.settleTimes.length : null;
    d.avgReimb = d.reimbTimes.length ? d.reimbTimes.reduce((a, b) => a + b, 0) / d.reimbTimes.length : null;
    d.successRate = d.terminal ? (d.success / d.terminal) * 100 : null;
    d.totalApplications = Array.isArray(S.applications) ? S.applications.length : null;

    const mr = S.metricsRemote;
    if (mr && typeof mr === 'object') {
      const mv = function () { const keys = Array.prototype.slice.call(arguments); for (const kk of keys) { const v = kk.indexOf('.') !== -1 ? deep(mr, kk) : mr[kk]; if (v != null && v !== '') return v; } return null; };
      const set = (field, ...keys) => { const v = mv.apply(null, keys); if (v != null) d[field] = num(v); };
      set('totalReimbursed', 'totalReimbursed', 'reimbursement.total', 'reimbursedTotal');
      set('vaultOutstanding', 'vaultOutstanding', 'vault.outstanding', 'outstanding', 'outstandingLiquidity');
      set('successRate', 'successRate', 'success_rate', 'bridgeSuccessRate');
      set('avgSettle', 'avgSettlementMs', 'averageSettlementTime', 'settlement.avgMs');
      set('avgReimb', 'avgReimbursementMs', 'averageReimbursementTime', 'reimbursement.avgMs');
      set('volumeToday', 'volumeToday', 'todayVolume', 'volume.today');
      set('volumeMonth', 'volumeMonth', 'monthlyVolume', 'volume.month');
      set('failedOps', 'failedOperations', 'failed', 'failedCount');
      set('activeIntents', 'activeIntents', 'active');
      const ta = mv('totalApplications', 'applicationsCount', 'applications'); if (ta != null) d.totalApplications = Array.isArray(ta) ? ta.length : num(ta);
    }
    return d;
  }

  // ─── Filters ─────────────────────────────────────────────────────────────────
  function distinct(list, key) { const s = new Set(); list.forEach((it) => { const v = it[key]; if (v != null && v !== '' && v !== '—') s.add(String(v)); }); return Array.from(s).sort(); }
  function applyFilters(list) {
    const term = S.search.trim().toLowerCase();
    const from = S.fFrom ? Date.parse(S.fFrom) : null;
    const to = S.fTo ? Date.parse(S.fTo) + 86400000 : null;
    return list.filter((it) => {
      if (S.fStatus !== 'all' && it.statusKey !== S.fStatus) return false;
      if (S.fChain !== 'all' && String(it.srcChain).toLowerCase() !== S.fChain && String(it.dstChain).toLowerCase() !== S.fChain) return false;
      if (S.fAsset !== 'all' && it.asset !== S.fAsset) return false;
      if (S.fBridge !== 'all' && String(it.bridge || '') !== S.fBridge) return false;
      if (S.fApp !== 'all' && String(it.application || '') !== S.fApp) return false;
      if (from && it.created && it.created < from) return false;
      if (to && it.created && it.created > to) return false;
      if (term) { const hay = [it.intentId, it.wallet, it.recipient, it.burnTx, it.mintTx, it.fulfillTx, it.settleTx, it.vaultCreditTx, it.memo, it.correlationId, it.asset, it.application].filter(Boolean).join(' ').toLowerCase(); if (hay.indexOf(term) === -1) return false; }
      return true;
    });
  }

  // ─── Rendering: dashboard ─────────────────────────────────────────────────────
  function hexToRgb(hex) { const h = String(hex || '').replace('#', ''); if (h.length !== 6) return '138,170,200'; const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(','); }
  function kpi(label, value, sub, color, icon) { return `<div class="reim-kpi"><div class="reim-kpi-top"><span class="reim-kpi-ic" style="color:${color};background:rgba(${hexToRgb(color)},0.12);"><i class="fas ${icon}"></i></span><span class="reim-kpi-label">${esc(label)}</span></div><div class="reim-kpi-val" style="color:${color};">${value}</div><div class="reim-kpi-sub">${sub || '&nbsp;'}</div></div>`; }

  function renderDashboard() {
    const el = q('reim-kpis'); if (!el) return;
    const d = derive(S.intents);
    el.innerHTML = [
      kpi('Total Reimbursed', fmtAmt(d.totalReimbursed), d.totalReimbursedCount + ' intents', '#34d399', 'fa-arrow-rotate-left'),
      kpi('Pending Reimbursements', fmtAmt(d.pendingReimbursement), d.pendingReimbursementCount + ' awaiting', '#fbbf24', 'fa-hourglass-half'),
      kpi('Outstanding Vault Liquidity', fmtAmt(d.vaultOutstanding), 'advanced, unreimbursed', '#f59e0b', 'fa-vault'),
      kpi("Today's Volume", fmtAmt(d.volumeToday), d.todayCount + ' intents today', '#60b4ff', 'fa-chart-simple'),
      kpi('Monthly Volume', fmtAmt(d.volumeMonth), 'month to date', '#a78bfa', 'fa-chart-column'),
      kpi('Pending Circle Attestations', fmtNum(d.pendingAttestations, 0), 'awaiting Circle', '#fbbf24', 'fa-satellite-dish'),
      kpi('Pending Mint', fmtNum(d.pendingMint, 0), 'awaiting mint', '#67e8f9', 'fa-coins'),
      kpi('Avg Settlement Time', fmtDur(d.avgSettle), d.settleTimes.length + ' samples', '#67e8f9', 'fa-stopwatch'),
      kpi('Avg Reimbursement Time', fmtDur(d.avgReimb), d.reimbTimes.length + ' samples', '#a78bfa', 'fa-clock-rotate-left'),
      kpi('Bridge Success Rate', d.successRate == null ? '—' : fmtNum(d.successRate, 1) + '%', d.success + '/' + d.terminal + ' terminal', '#34d399', 'fa-circle-check'),
      kpi('Failed Operations', fmtNum(d.failedOps, 0), 'requires attention', '#f87171', 'fa-triangle-exclamation'),
      kpi('Active Intents', fmtNum(d.activeIntents, 0), 'in-flight now', '#67e8f9', 'fa-bolt'),
      kpi('Total Applications', d.totalApplications == null ? '—' : fmtNum(d.totalApplications, 0), 'registered on Core', '#93c5fd', 'fa-layer-group'),
    ].join('');
  }

  function renderBanner() {
    const el = q('reim-banner'); if (!el) return;
    if (S.coreError) {
      el.className = 'reim-banner';
      el.innerHTML = `<i class="fas fa-triangle-exclamation"></i><span>Treasury Core temporarily unavailable — showing last known data and retrying automatically…</span><span class="reim-banner-dot"><i class="fas fa-rotate fa-spin"></i></span>`;
      el.style.display = 'flex';
    } else { el.style.display = 'none'; el.innerHTML = ''; }
  }

  // ─── Filters bar ──────────────────────────────────────────────────────────────
  function renderFilters() {
    const chains = distinct(S.intents, 'srcChain'), assets = distinct(S.intents, 'asset'), bridges = distinct(S.intents, 'bridge'), apps = distinct(S.intents, 'application');
    const opt = (v, cur, label) => `<option value="${escAttr(v)}"${String(cur) === String(v) ? ' selected' : ''}>${esc(label != null ? label : v)}</option>`;
    const bar = q('reim-filters'); if (!bar) return;
    bar.innerHTML = `
      <div class="reim-search"><i class="fas fa-magnifying-glass"></i><input id="reim-search-input" type="search" placeholder="Search intent, wallet, recipient, tx, memo, correlation ID, application…" value="${escAttr(S.search)}" oninput="reimOnSearch(this.value)" aria-label="Search"></div>
      <select class="reim-select" onchange="reimSetFilter('fStatus',this.value)" aria-label="Filter status"><option value="all"${S.fStatus === 'all' ? ' selected' : ''}>All status</option>${STATUS_ORDER.concat(['retrying', 'failed', 'cancelled']).map((k) => opt(k, S.fStatus, STATUS_META[k].label)).join('')}</select>
      <select class="reim-select" onchange="reimSetFilter('fChain',this.value)" aria-label="Filter chain"><option value="all"${S.fChain === 'all' ? ' selected' : ''}>All chains</option>${chains.map((c) => opt(c.toLowerCase(), S.fChain, chainName(c))).join('')}</select>
      <select class="reim-select" onchange="reimSetFilter('fAsset',this.value)" aria-label="Filter asset"><option value="all"${S.fAsset === 'all' ? ' selected' : ''}>All assets</option>${assets.map((a) => opt(a, S.fAsset)).join('')}</select>
      <select class="reim-select" onchange="reimSetFilter('fBridge',this.value)" aria-label="Filter bridge"><option value="all"${S.fBridge === 'all' ? ' selected' : ''}>All bridges</option>${bridges.map((b) => opt(b, S.fBridge)).join('')}</select>
      <select class="reim-select" onchange="reimSetFilter('fApp',this.value)" aria-label="Filter application"><option value="all"${S.fApp === 'all' ? ' selected' : ''}>All apps</option>${apps.map((a) => opt(a, S.fApp)).join('')}</select>
      <input class="reim-date" type="date" value="${escAttr(S.fFrom)}" onchange="reimSetFilter('fFrom',this.value)" aria-label="From date" title="From date">
      <input class="reim-date" type="date" value="${escAttr(S.fTo)}" onchange="reimSetFilter('fTo',this.value)" aria-label="To date" title="To date">
      <button class="reim-btn" onclick="reimClearFilters()" title="Clear filters"><i class="fas fa-filter-circle-xmark"></i></button>`;
  }

  // ─── Operations table ─────────────────────────────────────────────────────────
  function sortCaret(k) { if (S.sortKey !== k) return '<i class="fas fa-sort reim-dim" style="font-size:9px;"></i>'; return `<i class="fas fa-sort-${S.sortDir === 'asc' ? 'up' : 'down'}" style="font-size:9px;"></i>`; }
  function subStatusChip(v) { if (!v) return '<span class="reim-dim">—</span>'; const s = String(v).toLowerCase(); let col = '#9db8d8'; if (/complete|done|paid|debited|success|settled|reimbursed/.test(s)) col = '#34d399'; else if (/pending|processing|await|running|progress/.test(s)) col = '#fbbf24'; else if (/fail|error/.test(s)) col = '#f87171'; return `<span class="reim-mini" style="color:${col};">${esc(String(v))}</span>`; }

  function renderTable() {
    const body = q('reim-table-wrap'); if (!body) return;
    const filtered = applyFilters(S.intents);
    filtered.sort((a, b) => { let av, bv; if (S.sortKey === 'amount') { av = num(a.amount) || 0; bv = num(b.amount) || 0; } else if (S.sortKey === 'settlement') { av = a.settlementMs || 0; bv = b.settlementMs || 0; } else if (S.sortKey === 'updated') { av = a.updated || 0; bv = b.updated || 0; } else { av = a.created || 0; bv = b.created || 0; } return S.sortDir === 'asc' ? av - bv : bv - av; });
    const total = filtered.length, pages = Math.max(1, Math.ceil(total / S.pageSize));
    if (S.page > pages) S.page = pages;
    const start = (S.page - 1) * S.pageSize, rows = filtered.slice(start, start + S.pageSize);

    if (!total) {
      body.innerHTML = `<div class="reim-empty"><i class="fas fa-inbox"></i><p>${S.intents.length ? 'No operations match your filters.' : (coreReady() ? 'No ExecDaat operations found yet. New bridge transactions will appear here automatically.' : 'Treasury Core is not configured for this environment. Operations will appear once the Core endpoint is available.')}</p></div>`;
      return;
    }

    const head = `<tr>
      <th onclick="reimSort('created')">Created ${sortCaret('created')}</th>
      <th>Intent ID</th><th>App</th>
      <th>Source</th><th>Destination</th><th>Asset</th>
      <th onclick="reimSort('amount')" style="text-align:right;">Amount ${sortCaret('amount')}</th>
      <th>Recipient</th><th>Vault</th>
      <th>Current Stage</th><th>Settlement</th><th>Reimbursement</th>
      <th onclick="reimSort('settlement')" style="text-align:right;">Settle ${sortCaret('settlement')}</th>
      <th onclick="reimSort('updated')">Updated ${sortCaret('updated')}</th>
      <th>Corr. ID</th><th>Memo</th><th>Explorer</th><th>Actions</th></tr>`;

    const trs = rows.map((it) => {
      const memo = it.memo || `EXECDAAT|REPAY|${it.intentId}|${it.asset}|${fmtAmt(it.amount)}`;
      return `<tr onclick="reimOpen('${escAttr(it.id)}')" tabindex="0" onkeydown="if(event.key==='Enter')reimOpen('${escAttr(it.id)}')">
        <td><div class="reim-t">${esc(timeAgo(it.created))}</div><div class="reim-dim reim-xs">${esc(fmtDate(it.created))}</div></td>
        <td><span class="reim-mono">${esc(shortHash(it.intentId))}</span>${copyBtn(it.intentId, 'Intent ID')}</td>
        <td><span class="reim-app">${esc(it.application)}</span></td>
        <td>${chainChip(it.srcChain)}</td>
        <td>${chainChip(it.dstChain)}</td>
        <td>${assetBadge(it.asset)}</td>
        <td style="text-align:right;font-weight:700;color:#e7eefb;">${fmtAmt(it.amount)}</td>
        <td>${it.recipient ? `<span class="reim-mono">${esc(shortAddr(it.recipient))}</span>` : '<span class="reim-dim">—</span>'}</td>
        <td>${it.vault ? `<span class="reim-mono">${esc(shortAddr(it.vault))}</span>` : '<span class="reim-dim">—</span>'}</td>
        <td><div style="display:flex;flex-direction:column;gap:4px;">${statusBadge(it.statusKey)}${progressBar(it.statusKey)}</div></td>
        <td>${subStatusChip(it.settlementStatus || (it.settleTx ? 'settled' : ''))}</td>
        <td>${subStatusChip(it.reimbursementStatus || (it.vaultCreditTx ? 'completed' : ''))}</td>
        <td style="text-align:right;">${fmtDur(it.settlementMs)}</td>
        <td><div class="reim-dim reim-xs">${it.updated ? esc(timeAgo(it.updated)) : '—'}</div></td>
        <td>${it.correlationId ? `<span class="reim-mono reim-xs">${esc(shortHash(it.correlationId))}</span>${copyBtn(it.correlationId, 'Correlation ID')}` : '<span class="reim-dim">—</span>'}</td>
        <td>${copyBtn(memo, 'Memo')}</td>
        <td>${it.wallet ? `<a class="reim-ic" href="${ARC_EXPLORER}/address/${escAttr(it.wallet)}" target="_blank" rel="noopener" title="Explorer" onclick="event.stopPropagation();"><i class="fas fa-satellite-dish"></i></a>` : '<span class="reim-dim">—</span>'}</td>
        <td><button class="reim-ic" title="Details" onclick="event.stopPropagation();reimOpen('${escAttr(it.id)}')"><i class="fas fa-chevron-right"></i></button></td>
      </tr>`;
    }).join('');

    body.innerHTML = `<div class="reim-table-scroll"><table class="reim-table"><thead>${head}</thead><tbody>${trs}</tbody></table></div>
      <div class="reim-pager"><span class="reim-dim">${total} operation${total === 1 ? '' : 's'} · page ${S.page}/${pages}</span>
        <div class="reim-pager-btns"><button class="reim-btn" ${S.page <= 1 ? 'disabled' : ''} onclick="reimPage(${S.page - 1})"><i class="fas fa-chevron-left"></i></button><button class="reim-btn" ${S.page >= pages ? 'disabled' : ''} onclick="reimPage(${S.page + 1})"><i class="fas fa-chevron-right"></i></button></div>
      </div>`;
  }

  // ─── Analytics ─────────────────────────────────────────────────────────────────
  function barChart(title, icon, color, entries) {
    const max = entries.reduce((m, e) => Math.max(m, e.value), 0) || 1;
    const bars = entries.length ? entries.map((e) => `<div class="reim-bar-row"><div class="reim-bar-label" title="${escAttr(e.label)}">${esc(e.label)}</div><div class="reim-bar-track"><div class="reim-bar-fill" style="width:${Math.max(3, (e.value / max) * 100)}%;background:${color};"></div></div><div class="reim-bar-val">${esc(e.display != null ? e.display : fmtNum(e.value, 0))}</div></div>`).join('') : '<div class="reim-dim" style="padding:10px 0;font-size:12px;">No data yet.</div>';
    return `<section class="reim-card"><div class="reim-card-head"><span class="reim-card-title"><i class="fas ${icon}" style="color:${color};"></i>${esc(title)}</span></div><div class="reim-bars">${bars}</div></section>`;
  }
  function statChart(title, icon, color, rows) {
    const body = rows.map((r) => `<div class="reim-stat-row"><span class="reim-stat-k">${esc(r.k)}</span><span class="reim-stat-v" style="color:${r.color || '#e7eefb'};">${r.v}</span></div>`).join('');
    return `<section class="reim-card"><div class="reim-card-head"><span class="reim-card-title"><i class="fas ${icon}" style="color:${color};"></i>${esc(title)}</span></div><div class="reim-stats">${body}</div></section>`;
  }
  function groupSum(list, key, valFn) { const m = {}; list.forEach((it) => { const k = String(it[key] || '—'); m[k] = (m[k] || 0) + valFn(it); }); return Object.keys(m).map((k) => ({ key: k, label: k, value: m[k] })).sort((a, b) => b.value - a.value).slice(0, 8); }
  function groupCount(list, keyFn) { const m = {}; list.forEach((it) => { const k = String(keyFn(it) || '—'); m[k] = (m[k] || 0) + 1; }); return Object.keys(m).map((k) => ({ label: k, value: m[k] })).sort((a, b) => b.value - a.value).slice(0, 8); }
  function timeBuckets(arr) { const b = [{ label: '<5s', lo: 0, hi: 5000 }, { label: '5–15s', lo: 5000, hi: 15000 }, { label: '15–60s', lo: 15000, hi: 60000 }, { label: '1–5m', lo: 60000, hi: 300000 }, { label: '>5m', lo: 300000, hi: Infinity }]; return b.map((x) => ({ label: x.label, value: arr.filter((v) => v >= x.lo && v < x.hi).length })); }

  function renderAnalytics() {
    const el = q('reim-analytics'); if (!el) return;
    const list = S.intents, d = derive(list);
    const dayMap = {}, volMap = {};
    list.forEach((it) => { if (it.statusKey === 'reimbursed' || it.statusKey === 'completed') { const k = dayKey(it.completedAt || it.reimbursedAt || it.created); dayMap[k] = (dayMap[k] || 0) + 1; } const vk = dayKey(it.created); volMap[vk] = (volMap[vk] || 0) + (num(it.amount) || 0); });
    const days = []; for (let i = 13; i >= 0; i--) { const dd = new Date(); dd.setDate(dd.getDate() - i); const k = dayKey(dd.getTime()); days.push({ k, short: (dd.getMonth() + 1) + '/' + dd.getDate() }); }
    const perDay = days.map((x) => ({ label: x.short, value: dayMap[x.k] || 0 }));
    const volDay = days.map((x) => ({ label: x.short, value: Math.round(volMap[x.k] || 0), display: fmtAmt(volMap[x.k] || 0) }));
    // monthly volume (last 6 months)
    const monMap = {}; list.forEach((it) => { const dd = new Date(it.created || Date.now()); const k = dd.getFullYear() + '-' + String(dd.getMonth() + 1).padStart(2, '0'); monMap[k] = (monMap[k] || 0) + (num(it.amount) || 0); });
    const months = []; for (let i = 5; i >= 0; i--) { const dd = new Date(); dd.setMonth(dd.getMonth() - i); const k = dd.getFullYear() + '-' + String(dd.getMonth() + 1).padStart(2, '0'); months.push({ k, short: dd.toLocaleString('en-US', { month: 'short' }) }); }
    const volMonth = months.map((x) => ({ label: x.short, value: Math.round(monMap[x.k] || 0), display: fmtAmt(monMap[x.k] || 0) }));

    const byAsset = groupSum(list, 'asset', (it) => num(it.amount) || 0);
    const byBridge = groupCount(list, (it) => it.bridge || 'Turbo');
    const byApp = groupCount(list, (it) => it.application || 'EXECDAAT');
    const settleBuckets = timeBuckets(list.map((it) => it.settlementMs).filter(Boolean));
    const reimbBuckets = timeBuckets(list.map((it) => it.reimbursementMs).filter(Boolean));

    el.innerHTML = `<div class="reim-analytics-grid">
      ${barChart('Daily Volume (14d)', 'fa-chart-column', '#60b4ff', volDay)}
      ${barChart('Monthly Volume (6mo)', 'fa-calendar', '#a78bfa', volMonth)}
      ${barChart('Bridge Usage', 'fa-bridge', '#67e8f9', byBridge)}
      ${barChart('Settlement Time', 'fa-stopwatch', '#67e8f9', settleBuckets)}
      ${barChart('Reimbursement Time', 'fa-clock-rotate-left', '#a78bfa', reimbBuckets)}
      ${barChart('Asset Distribution', 'fa-coins', '#f59e0b', byAsset.map((e) => ({ label: e.key, value: Math.round(e.value), display: fmtAmt(e.value) })))}
      ${barChart('Application Usage', 'fa-layer-group', '#93c5fd', byApp)}
      ${barChart('Reimbursements per Day', 'fa-calendar-check', '#34d399', perDay)}
      ${statChart('Vault Liquidity & Balance', 'fa-vault', '#f59e0b', [
        { k: 'Total Reimbursed', v: fmtAmt(d.totalReimbursed), color: '#34d399' },
        { k: 'Outstanding Liquidity', v: fmtAmt(d.vaultOutstanding), color: '#f59e0b' },
        { k: 'Pending Reimbursement', v: fmtAmt(d.pendingReimbursement), color: '#fbbf24' },
      ])}
      ${statChart('Bridge Success Rate', 'fa-circle-check', '#34d399', [
        { k: 'Success Rate', v: d.successRate == null ? '—' : fmtNum(d.successRate, 1) + '%', color: '#34d399' },
        { k: 'Completed', v: fmtNum(d.success, 0), color: '#34d399' },
        { k: 'Failed', v: fmtNum(d.failedOps, 0), color: '#f87171' },
        { k: 'Active', v: fmtNum(d.activeIntents, 0), color: '#67e8f9' },
      ])}
    </div>`;
  }

  // ─── Side panel (timeline + full details) ────────────────────────────────────
  function afterOrAt(it, key) { const cur = STATUS_ORDER.indexOf(it.statusKey); const tgt = STATUS_ORDER.indexOf(key); return cur >= 0 && tgt >= 0 && cur >= tgt; }
  function pipelineSteps(it) {
    return [
      { label: 'Intent Created', ts: it.created, tx: null, base: null, worker: 'ExecDaat', done: true },
      { label: 'Liquidity Reserved', ts: null, tx: null, base: null, worker: 'Vault', done: afterOrAt(it, 'reserved') },
      { label: 'Vault Debited', ts: null, tx: null, base: null, worker: 'Vault', done: afterOrAt(it, 'vault_debited') || !!it.vaultDebitStatus },
      { label: 'Treasury Paid (funds delivered)', ts: null, tx: it.fulfillTx, base: ARC_EXPLORER, worker: 'Treasury Engine', done: afterOrAt(it, 'treasury_paid') || !!it.fulfillTx },
      { label: 'Circle Attestation', ts: null, tx: null, base: null, worker: 'Circle', done: afterOrAt(it, 'attested') || !!it.attestation },
      { label: 'Mint Executed', ts: null, tx: it.mintTx, base: ARC_EXPLORER, worker: 'Circle CCTP', done: afterOrAt(it, 'minted') || !!it.mintTx },
      { label: 'Treasury Settlement', ts: it.settledAt, tx: it.settleTx, base: ARC_EXPLORER, worker: 'Settlement Engine', done: afterOrAt(it, 'settled') || !!it.settleTx },
      { label: 'Vault Reimbursed', ts: it.reimbursedAt, tx: it.vaultCreditTx, base: ARC_EXPLORER, worker: 'Reimbursement (Elligent)', done: it.statusKey === 'reimbursed' || it.statusKey === 'completed' },
      { label: 'Completed', ts: it.completedAt, tx: null, base: null, worker: '—', done: it.statusKey === 'completed' },
    ];
  }

  function renderPanel(it) {
    const panel = q('reim-panel'); if (!panel) return;
    const steps = pipelineSteps(it); let prevTs = it.created;
    const timeline = steps.map((s, i) => {
      const dur = (s.ts && prevTs) ? (s.ts - prevTs) : null; if (s.ts) prevTs = s.ts;
      const dot = s.done ? '#34d399' : '#3a4870';
      return `<div class="reim-tl-row"><div class="reim-tl-marker"><span class="reim-tl-dot" style="background:${dot};border-color:${dot};"></span>${i < steps.length - 1 ? `<span class="reim-tl-line" style="background:${s.done ? 'rgba(52,211,153,0.35)' : 'rgba(58,72,112,0.4)'};"></span>` : ''}</div><div class="reim-tl-body"><div class="reim-tl-head"><span class="reim-tl-label" style="color:${s.done ? '#e7eefb' : '#7f93b5'};">${esc(s.label)}</span>${s.done ? '<span class="reim-tl-ok"><i class="fas fa-check"></i></span>' : '<span class="reim-tl-pending">pending</span>'}</div><div class="reim-tl-meta">${s.ts ? `<span><i class="fas fa-clock"></i> ${esc(fmtDate(s.ts))}</span>` : ''}${dur ? `<span><i class="fas fa-hourglass-half"></i> ${esc(fmtDur(dur))}</span>` : ''}${s.worker && s.worker !== '—' ? `<span><i class="fas fa-microchip"></i> ${esc(s.worker)}</span>` : ''}${s.tx ? `<span>${txLink(s.tx, s.base, s.label)}</span>` : ''}</div></div></div>`;
    }).join('');
    const row = (k, v) => `<div class="reim-prow"><span class="reim-pk">${esc(k)}</span><span class="reim-pv">${v}</span></div>`;
    const memo = it.memo || `EXECDAAT|REPAY|${it.intentId}|${it.asset}|${fmtAmt(it.amount)}`;
    const dur = it.completedAt && it.created ? it.completedAt - it.created : (it.updated && it.created ? it.updated - it.created : null);

    panel.innerHTML = `
      <div class="reim-panel-head">
        <div><div class="reim-panel-title">${statusBadge(it.statusKey)}</div>
          <div class="reim-panel-sub">${assetBadge(it.asset)} <span style="font-weight:800;color:#e7eefb;">${fmtAmt(it.amount)}</span> · ${chainChip(it.srcChain)} <i class="fas fa-arrow-right reim-arrow"></i> ${chainChip(it.dstChain)}</div>
          <div style="margin-top:8px;">${progressBar(it.statusKey)}</div>
        </div>
        <button class="reim-ic reim-ic-lg" onclick="reimClose()" aria-label="Close panel"><i class="fas fa-times"></i></button>
      </div>
      <div class="reim-psec-title">Lifecycle Timeline</div>
      <div class="reim-timeline">${timeline}</div>
      <div class="reim-psec-title">Operation</div>
      <div class="reim-pcard">
        ${row('Intent ID', `<span class="reim-mono">${esc(it.intentId)}</span> ${copyBtn(it.intentId, 'Intent ID')}`)}
        ${row('Application', esc(it.application))}
        ${row('Client', it.client ? esc(it.client) : '—')}
        ${row('Environment', it.environment ? esc(it.environment) : '—')}
        ${row('Wallet', it.wallet ? `<span class="reim-mono">${esc(shortAddr(it.wallet))}</span> ${copyBtn(it.wallet, 'Wallet')}` : '—')}
        ${row('Recipient', it.recipient ? `<span class="reim-mono">${esc(shortAddr(it.recipient))}</span> ${copyBtn(it.recipient, 'Recipient')}` : '—')}
        ${row('Source Chain', chainChip(it.srcChain))}
        ${row('Destination Chain', chainChip(it.dstChain))}
        ${row('Asset', assetBadge(it.asset))}
        ${row('Amount', `<span style="font-weight:700;color:#e7eefb;">${fmtAmt(it.amount)}</span>`)}
        ${row('Vault Used', it.vault ? `<span class="reim-mono">${esc(shortAddr(it.vault))}</span> ${copyBtn(it.vault, 'Vault')}` : '—')}
        ${row('Current Stage', statusBadge(it.statusKey))}
        ${row('Memo', `<span class="reim-mono reim-wrap">${esc(memo)}</span> ${copyBtn(memo, 'Memo')}`)}
        ${row('Nonce', it.nonce != null ? esc(String(it.nonce)) : '—')}
        ${row('Correlation ID', it.correlationId ? `<span class="reim-mono">${esc(it.correlationId)}</span> ${copyBtn(it.correlationId, 'Correlation ID')}` : '—')}
        ${row('Ledger Entry', it.ledgerEntry ? `<span class="reim-mono">${esc(it.ledgerEntry)}</span>` : '—')}
        ${row('Created', fmtDate(it.created))}
        ${row('Updated', it.updated ? fmtDate(it.updated) : '—')}
        ${row('Duration', fmtDur(dur))}
        ${row('Settlement Time', fmtDur(it.settlementMs))}
        ${row('Reimbursement Time', fmtDur(it.reimbursementMs))}
        ${row('Source', `<span class="reim-mini">${esc(it.source)}</span>`)}
      </div>
      <div class="reim-psec-title">Transactions</div>
      <div class="reim-pcard">
        ${row('Circle Message', it.circleMessage ? `<span class="reim-mono reim-wrap">${esc(shortHash(String(it.circleMessage)))}</span> ${copyBtn(String(it.circleMessage), 'Circle Message')}` : '—')}
        ${row('Attestation Hash', it.attestation ? `<span class="reim-mono">${esc(shortHash(String(it.attestation)))}</span> ${copyBtn(String(it.attestation), 'Attestation')}` : '—')}
        ${row('Circle Burn', it.burnTx ? txLink(it.burnTx, ARC_EXPLORER, 'burn') : '—')}
        ${row('Mint Transaction', it.mintTx ? txLink(it.mintTx, ARC_EXPLORER, 'mint') : '—')}
        ${row('Treasury Transaction', it.fulfillTx ? txLink(it.fulfillTx, ARC_EXPLORER, 'treasury') : '—')}
        ${row('Settlement Transaction', it.settleTx ? txLink(it.settleTx, ARC_EXPLORER, 'settlement') : '—')}
        ${row('Vault Credit Transaction', it.vaultCreditTx ? txLink(it.vaultCreditTx, ARC_EXPLORER, 'vault credit') : '—')}
      </div>
      <div class="reim-panel-actions">
        <a class="reim-btn reim-btn-primary" href="${ARC_EXPLORER}/address/${escAttr(it.wallet || '')}" target="_blank" rel="noopener"><i class="fas fa-satellite-dish"></i> Arc Explorer</a>
        <button class="reim-btn" onclick="reimExportOne('${escAttr(it.id)}')"><i class="fas fa-file-export"></i> Export JSON</button>
      </div>
      <p class="reim-panel-note"><i class="fas fa-shield-halved"></i> Read-only monitor. Settlement &amp; reimbursement are executed exclusively by the Elligent Treasury Core.</p>`;
    q('reim-overlay').classList.remove('hidden');
    requestAnimationFrame(() => panel.classList.add('open'));
    try { panel.focus(); } catch (_) {}
  }

  // ─── Notifications (status transitions) ──────────────────────────────────────
  function detectTransitions(list) {
    if (S.firstLoad) { list.forEach((it) => { S.prevStatus[it.intentId] = it.statusKey; }); S.firstLoad = false; return; }
    const notifyOn = {
      attested: ['Circle attested', 'info'], minted: ['Mint executed', 'info'],
      settled: ['Treasury settled', 'success'], reimbursed: ['Vault reimbursed', 'success'],
      completed: ['Operation completed', 'success'], failed: ['Operation failed', 'error'], retrying: ['Retrying operation', 'warning'],
    };
    list.forEach((it) => {
      const prev = S.prevStatus[it.intentId];
      if (prev !== it.statusKey) {
        const n = notifyOn[it.statusKey];
        if (n && prev !== undefined) toast(n[0] + ' · ' + shortHash(it.intentId), n[1]);
        S.prevStatus[it.intentId] = it.statusKey;
        if (it.statusKey === 'reimbursed' || it.statusKey === 'completed') { try { window.dispatchEvent(new CustomEvent('reimbursement:completed', { detail: { intentId: it.intentId, asset: it.asset, amount: it.amount } })); } catch (_) {} }
      }
    });
  }

  // ─── Sync loop ──────────────────────────────────────────────────────────────
  function tabActive() { const el = q('tab-content-reimbursements'); return el && !el.classList.contains('hidden'); }
  function hasPending() { return S.intents.some((it) => PENDING_KEYS[it.statusKey]); }
  function scheduleAuto() {
    const want = (hasPending() || S.coreError) ? REFRESH_ACTIVE_MS : REFRESH_IDLE_MS;
    if (S.timer && S.timerMs === want) return;
    if (S.timer) clearInterval(S.timer);
    S.timerMs = want;
    S.timer = setInterval(() => { if (tabActive() && !document.hidden) refresh(false); }, want);
  }

  var REFRESH_COOLDOWN_MS = 3000;  // Phase 8: prevent cascade refreshes

  async function refresh(showFeedback) {
    if (S.loading) return;
    var now = Date.now();
    if (now - (S.lastRefresh || 0) < REFRESH_COOLDOWN_MS) return;  // Phase 8: cooldown
    S.lastRefresh = now;
    S.loading = true; setSyncing(true);
    try {
      const [list, metrics, apps] = await Promise.all([loadData().catch(() => S.intents), loadMetrics().catch(() => S.metricsRemote), loadApplications().catch(() => S.applications)]);
      S.intents = Array.isArray(list) ? list : S.intents;
      if (metrics) S.metricsRemote = metrics;
      if (apps) S.applications = apps;
      detectTransitions(S.intents);
      S.lastSync = Date.now();
      renderBanner();
      renderHeader();
      renderDashboard();
      if (!focusedInFilter()) renderFilters();
      if (S.view === 'analytics') renderAnalytics(); else renderTable();
      if (S.selected) { const cur = S.intents.find((i) => i.id === S.selected); if (cur) renderPanel(cur); }
      scheduleAuto();
      if (showFeedback) toast(S.coreError ? 'Treasury Core unavailable — retrying' : 'Reimbursements updated', S.coreError ? 'warning' : 'success');
    } catch (e) { if (showFeedback) toast('Some reimbursement data could not be loaded', 'warning'); }
    finally { S.loading = false; setSyncing(false); }
  }
  function focusedInFilter() { const a = document.activeElement; if (!a) return false; const t = q('reim-filters'); return t && t.contains(a); }
  function setSyncing(on) { const el = q('reim-sync'); if (!el) return; if (on) { el.innerHTML = '<i class="fas fa-rotate fa-spin"></i> Syncing…'; return; } el.innerHTML = S.coreError ? '<i class="fas fa-circle" style="color:#f87171;font-size:7px;"></i> Core offline · retrying' : `<i class="fas fa-circle" style="color:#34d399;font-size:7px;"></i> Live · ${timeAgo(S.lastSync)}`; }
  function renderHeader() { const el = q('reim-count'); if (el) el.textContent = S.intents.length + ' tracked'; }

  // ─── Export ──────────────────────────────────────────────────────────────────
  function currentRows() { return applyFilters(S.intents); }
  function download(name, text, mime) { try { const blob = new Blob([text], { type: mime }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100); toast('Export ready: ' + name, 'success'); } catch (e) { toast('Export failed', 'error'); } }
  function exportCSV() {
    const rows = currentRows();
    const cols = ['intentId', 'application', 'srcChain', 'dstChain', 'asset', 'amount', 'recipient', 'vault', 'status', 'settlementStatus', 'reimbursementStatus', 'burnTx', 'attestation', 'mintTx', 'fulfillTx', 'settleTx', 'vaultCreditTx', 'settlementMs', 'reimbursementMs', 'created', 'updated', 'correlationId', 'memo'];
    const head = cols.join(',');
    const body = rows.map((it) => cols.map((c) => { let v = c === 'status' ? (STATUS_META[it.statusKey] || {}).label : it[c]; if (c === 'created' || c === 'updated') v = v ? new Date(v).toISOString() : ''; return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }).join(',')).join('\n');
    download('reimbursements-' + Date.now() + '.csv', head + '\n' + body, 'text/csv');
  }
  function exportJSON() { const rows = currentRows().map((it) => { const c = Object.assign({}, it); delete c.raw; delete c.source; return c; }); download('reimbursements-' + Date.now() + '.json', JSON.stringify(rows, null, 2), 'application/json'); }
  function exportOne(id) { const it = S.intents.find((i) => i.id === id); if (!it) return; const c = Object.assign({}, it); delete c.raw; download('reimbursement-' + it.intentId + '.json', JSON.stringify(c, null, 2), 'application/json'); }
  window.reimExportOne = exportOne;
  function exportPDF() {
    const rows = currentRows(); const w = window.open('', '_blank'); if (!w) { toast('Popup blocked — allow popups to export PDF', 'warning'); return; }
    const style = 'body{font-family:Arial,Helvetica,sans-serif;color:#111;padding:24px;}h1{font-size:18px;}table{border-collapse:collapse;width:100%;font-size:10px;margin-top:12px;}th,td{border:1px solid #ccc;padding:4px 6px;text-align:left;}th{background:#f3f4f6;}';
    const head = '<tr><th>Intent</th><th>App</th><th>Asset</th><th>Amount</th><th>Route</th><th>Stage</th><th>Settle</th><th>Reimb</th><th>Created</th></tr>';
    const body = rows.map((it) => `<tr><td>${esc(it.intentId)}</td><td>${esc(it.application)}</td><td>${esc(it.asset)}</td><td>${fmtAmt(it.amount)}</td><td>${esc(chainName(it.srcChain))}→${esc(chainName(it.dstChain))}</td><td>${esc((STATUS_META[it.statusKey] || {}).label)}</td><td>${esc(fmtDur(it.settlementMs))}</td><td>${esc(fmtDur(it.reimbursementMs))}</td><td>${esc(fmtDate(it.created))}</td></tr>`).join('');
    w.document.write(`<html><head><title>ExecDaat Reimbursements</title><style>${style}</style></head><body><h1>ExecDaat — Treasury Reimbursements Report</h1><p>Generated ${new Date().toLocaleString()} · ${rows.length} records</p><table><thead>${head}</thead><tbody>${body}</tbody></table><script>window.onload=function(){window.print();}<\/script></body></html>`);
    w.document.close();
  }

  // ─── Public handlers ──────────────────────────────────────────────────────────
  window.reimOnSearch = function (v) { S.search = v || ''; S.page = 1; renderTable(); };
  window.reimSetFilter = function (k, v) { S[k] = v; S.page = 1; renderTable(); };
  window.reimClearFilters = function () { S.search = ''; S.fStatus = 'all'; S.fChain = 'all'; S.fAsset = 'all'; S.fBridge = 'all'; S.fApp = 'all'; S.fFrom = ''; S.fTo = ''; S.page = 1; renderFilters(); renderTable(); };
  window.reimSort = function (k) { if (S.sortKey === k) S.sortDir = S.sortDir === 'asc' ? 'desc' : 'asc'; else { S.sortKey = k; S.sortDir = 'desc'; } renderTable(); };
  window.reimPage = function (p) { S.page = p; renderTable(); };
  window.reimOpen = function (id) { S.selected = id; const it = S.intents.find((i) => i.id === id); if (it) renderPanel(it); };
  window.reimClose = function () { S.selected = null; const p = q('reim-panel'); const o = q('reim-overlay'); if (p) p.classList.remove('open'); if (o) setTimeout(() => o.classList.add('hidden'), 180); };
  window.reimSwitchView = function (v) { S.view = v; q('reim-tab-list').classList.toggle('active', v === 'list'); q('reim-tab-analytics').classList.toggle('active', v === 'analytics'); q('reim-view-list').classList.toggle('hidden', v !== 'list'); q('reim-view-analytics').classList.toggle('hidden', v !== 'analytics'); if (v === 'analytics') renderAnalytics(); else renderTable(); };
  window.reimRefreshNow = function () { refresh(true); };
  window.reimExportCSV = exportCSV; window.reimExportJSON = exportJSON; window.reimExportPDF = exportPDF;

  // ─── Skeleton + styles ───────────────────────────────────────────────────────
  function injectStyle() {
    if (q('reim-styles')) return;
    const st = document.createElement('style'); st.id = 'reim-styles';
    st.textContent = `
      #tab-content-reimbursements{color:#dbe4f2;}
      #tab-content-reimbursements .reim-card{background:rgba(12,16,32,0.55);border:1px solid rgba(55,138,221,0.12);border-radius:16px;padding:16px;margin-bottom:16px;backdrop-filter:blur(6px);}
      #tab-content-reimbursements .reim-card-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;}
      #tab-content-reimbursements .reim-card-title{font-size:13px;font-weight:800;color:#eef2fb;display:flex;align-items:center;gap:8px;}
      #tab-content-reimbursements .reim-dim{color:#5f7ba0;}
      #tab-content-reimbursements .reim-xs{font-size:10px;}
      #tab-content-reimbursements .reim-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:#bcd6f5;}
      #tab-content-reimbursements .reim-wrap{white-space:normal;word-break:break-all;}
      #tab-content-reimbursements .reim-chip{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;font-size:10.5px;font-weight:700;white-space:nowrap;}
      #tab-content-reimbursements .reim-app{font-size:10px;font-weight:800;color:#a78bfa;background:rgba(167,139,250,0.1);border:1px solid rgba(167,139,250,0.25);border-radius:6px;padding:2px 7px;}
      #tab-content-reimbursements .reim-mini{font-size:10px;color:#9db8d8;background:rgba(55,138,221,0.08);border:1px solid rgba(55,138,221,0.16);border-radius:6px;padding:2px 6px;white-space:nowrap;}
      #tab-content-reimbursements .reim-asset{display:inline-flex;align-items:center;gap:6px;font-weight:700;font-size:12px;color:#e7eefb;}
      #tab-content-reimbursements .reim-asset-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0;}
      #tab-content-reimbursements .reim-chain{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:#cdd9ec;}
      #tab-content-reimbursements .reim-chain-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;}
      #tab-content-reimbursements .reim-arrow{color:#3a4870;font-size:9px;margin:0 2px;}
      #tab-content-reimbursements .reim-prog{height:4px;background:rgba(55,138,221,0.12);border-radius:3px;overflow:hidden;min-width:70px;}
      #tab-content-reimbursements .reim-prog-fill{height:100%;border-radius:3px;transition:width .4s ease;}
      #tab-content-reimbursements .reim-ic{background:rgba(55,138,221,0.09);border:1px solid rgba(55,138,221,0.18);border-radius:7px;color:#9db8d8;cursor:pointer;font-size:10px;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;transition:.15s;}
      #tab-content-reimbursements .reim-ic:hover{background:rgba(55,138,221,0.2);color:#fff;}
      #tab-content-reimbursements .reim-ic-lg{width:32px;height:32px;font-size:14px;}
      #tab-content-reimbursements .reim-txn{display:inline-flex;align-items:center;gap:5px;font-family:ui-monospace,monospace;font-size:10.5px;color:#60b4ff;text-decoration:none;}
      #tab-content-reimbursements .reim-txn:hover{color:#93c5fd;text-decoration:underline;}
      #tab-content-reimbursements .reim-txn i{font-size:8px;opacity:.7;}
      #tab-content-reimbursements .reim-btn{display:inline-flex;align-items:center;gap:7px;background:rgba(55,138,221,0.09);border:1px solid rgba(55,138,221,0.2);border-radius:9px;color:#bcd6f5;font-size:12px;font-weight:700;padding:7px 12px;cursor:pointer;text-decoration:none;transition:.15s;}
      #tab-content-reimbursements .reim-btn:hover:not(:disabled){background:rgba(55,138,221,0.18);}
      #tab-content-reimbursements .reim-btn:disabled{opacity:.4;cursor:not-allowed;}
      #tab-content-reimbursements .reim-btn-primary{background:linear-gradient(135deg,#0f766e,#10b981);border:none;color:#fff;}
      #tab-content-reimbursements .reim-banner{display:none;align-items:center;gap:10px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);color:#fca5a5;border-radius:12px;padding:10px 14px;margin-bottom:14px;font-size:12.5px;font-weight:600;}
      #tab-content-reimbursements .reim-banner-dot{margin-left:auto;color:#fca5a5;}
      #tab-content-reimbursements .reim-hero{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;}
      #tab-content-reimbursements .reim-hero-ic{width:44px;height:44px;border-radius:13px;background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.28);display:flex;align-items:center;justify-content:center;flex-shrink:0;}
      #tab-content-reimbursements .reim-tabs{display:inline-flex;gap:4px;background:rgba(8,11,24,0.6);border:1px solid rgba(55,138,221,0.14);border-radius:11px;padding:4px;}
      #tab-content-reimbursements .reim-tab{border:none;background:transparent;color:#8aaac8;font-size:12px;font-weight:700;padding:7px 14px;border-radius:8px;cursor:pointer;display:inline-flex;align-items:center;gap:7px;}
      #tab-content-reimbursements .reim-tab.active{background:rgba(16,185,129,0.14);color:#34d399;}
      #tab-content-reimbursements .reim-kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px;margin-bottom:16px;}
      #tab-content-reimbursements .reim-kpi{background:rgba(12,16,32,0.55);border:1px solid rgba(55,138,221,0.12);border-radius:14px;padding:13px 14px;}
      #tab-content-reimbursements .reim-kpi-top{display:flex;align-items:center;gap:8px;margin-bottom:8px;}
      #tab-content-reimbursements .reim-kpi-ic{width:26px;height:26px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:11px;flex-shrink:0;}
      #tab-content-reimbursements .reim-kpi-label{font-size:10.5px;color:#8aaac8;font-weight:700;text-transform:uppercase;letter-spacing:.03em;}
      #tab-content-reimbursements .reim-kpi-val{font-size:22px;font-weight:800;line-height:1.1;}
      #tab-content-reimbursements .reim-kpi-sub{font-size:10.5px;color:#5f7ba0;margin-top:3px;}
      #tab-content-reimbursements .reim-filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px;}
      #tab-content-reimbursements .reim-search{position:relative;flex:1;min-width:220px;}
      #tab-content-reimbursements .reim-search i{position:absolute;left:11px;top:50%;transform:translateY(-50%);color:#5f7ba0;font-size:11px;}
      #tab-content-reimbursements .reim-search input{width:100%;padding:8px 12px 8px 30px;background:rgba(8,11,24,0.6);border:1px solid rgba(55,138,221,0.16);border-radius:9px;color:#e7eefb;font-size:12px;}
      #tab-content-reimbursements .reim-select,#tab-content-reimbursements .reim-date{background:rgba(8,11,24,0.6);border:1px solid rgba(55,138,221,0.16);border-radius:9px;color:#cdd9ec;font-size:12px;padding:8px 10px;cursor:pointer;}
      #tab-content-reimbursements input:focus,#tab-content-reimbursements select:focus{outline:none;border-color:rgba(16,185,129,0.4);}
      #tab-content-reimbursements .reim-table-scroll{overflow-x:auto;border:1px solid rgba(55,138,221,0.1);border-radius:12px;}
      #tab-content-reimbursements .reim-table{width:100%;border-collapse:collapse;font-size:12px;min-width:1500px;}
      #tab-content-reimbursements .reim-table th{position:sticky;top:0;background:#0b0f1e;color:#5f7ba0;font-size:10px;text-transform:uppercase;letter-spacing:.04em;font-weight:800;text-align:left;padding:10px 10px;white-space:nowrap;border-bottom:1px solid rgba(55,138,221,0.14);}
      #tab-content-reimbursements .reim-table th[onclick]{cursor:pointer;}
      #tab-content-reimbursements .reim-table td{padding:9px 10px;border-bottom:1px solid rgba(55,138,221,0.06);white-space:nowrap;vertical-align:middle;}
      #tab-content-reimbursements .reim-table tbody tr{cursor:pointer;transition:background .12s;}
      #tab-content-reimbursements .reim-table tbody tr:hover{background:rgba(55,138,221,0.06);}
      #tab-content-reimbursements .reim-t{font-size:11.5px;color:#cdd9ec;}
      #tab-content-reimbursements .reim-pager{display:flex;align-items:center;justify-content:space-between;padding:12px 4px 2px;font-size:12px;}
      #tab-content-reimbursements .reim-pager-btns{display:flex;gap:6px;}
      #tab-content-reimbursements .reim-empty{text-align:center;padding:56px 20px;color:#8aaac8;}
      #tab-content-reimbursements .reim-empty i{font-size:32px;color:#3a4870;margin-bottom:12px;}
      #tab-content-reimbursements .reim-empty p{font-size:13px;max-width:460px;margin:0 auto;}
      #tab-content-reimbursements .reim-analytics-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px;}
      #tab-content-reimbursements .reim-bars{display:flex;flex-direction:column;gap:7px;}
      #tab-content-reimbursements .reim-bar-row{display:flex;align-items:center;gap:10px;}
      #tab-content-reimbursements .reim-bar-label{width:70px;font-size:11px;color:#9db8d8;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      #tab-content-reimbursements .reim-bar-track{flex:1;height:14px;background:rgba(55,138,221,0.08);border-radius:5px;overflow:hidden;}
      #tab-content-reimbursements .reim-bar-fill{height:100%;border-radius:5px;transition:width .4s ease;}
      #tab-content-reimbursements .reim-bar-val{width:64px;text-align:right;font-size:11px;font-weight:700;color:#cdd9ec;flex-shrink:0;}
      #tab-content-reimbursements .reim-stats{display:flex;flex-direction:column;gap:2px;}
      #tab-content-reimbursements .reim-stat-row{display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(55,138,221,0.07);font-size:12px;}
      #tab-content-reimbursements .reim-stat-row:last-child{border-bottom:none;}
      #tab-content-reimbursements .reim-stat-k{color:#8aaac8;}
      #tab-content-reimbursements .reim-stat-v{font-weight:800;}
      .reim-overlay{position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,0.55);backdrop-filter:blur(3px);display:flex;justify-content:flex-end;}
      .reim-overlay.hidden{display:none;}
      .reim-panel{width:100%;max-width:480px;height:100%;background:#0a0c18;border-left:1px solid rgba(16,185,129,0.2);overflow-y:auto;padding:18px;transform:translateX(30px);opacity:0;transition:transform .18s ease,opacity .18s ease;outline:none;}
      .reim-panel.open{transform:translateX(0);opacity:1;}
      .reim-panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:8px;}
      .reim-panel-title{margin-bottom:8px;}
      .reim-panel-sub{font-size:12px;color:#9db8d8;display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
      .reim-psec-title{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#5f7ba0;margin:18px 0 8px;}
      .reim-pcard{background:rgba(12,16,32,0.6);border:1px solid rgba(55,138,221,0.12);border-radius:12px;padding:4px 12px;}
      .reim-prow{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid rgba(55,138,221,0.07);}
      .reim-prow:last-child{border-bottom:none;}
      .reim-pk{font-size:11px;color:#5f7ba0;min-width:130px;flex-shrink:0;}
      .reim-pv{font-size:12px;color:#dbe4f2;flex:1;min-width:0;display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
      .reim-timeline{position:relative;}
      .reim-tl-row{display:flex;gap:12px;}
      .reim-tl-marker{display:flex;flex-direction:column;align-items:center;flex-shrink:0;}
      .reim-tl-dot{width:16px;height:16px;border-radius:50%;border:2px solid;margin-top:2px;}
      .reim-tl-line{width:2px;flex:1;margin:2px 0;min-height:14px;}
      .reim-tl-body{padding-bottom:16px;flex:1;min-width:0;}
      .reim-tl-head{display:flex;align-items:center;gap:8px;}
      .reim-tl-label{font-size:12.5px;font-weight:700;}
      .reim-tl-ok{color:#34d399;font-size:10px;}
      .reim-tl-pending{font-size:9px;color:#7f93b5;background:rgba(127,147,181,0.12);border-radius:5px;padding:1px 6px;}
      .reim-tl-meta{display:flex;gap:12px;flex-wrap:wrap;margin-top:4px;font-size:10.5px;color:#7f93b5;}
      .reim-tl-meta i{margin-right:3px;opacity:.7;}
      .reim-panel-actions{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap;}
      .reim-panel-note{font-size:10.5px;color:#5f7ba0;margin-top:14px;display:flex;align-items:center;gap:6px;line-height:1.5;}
      .reim-panel-note i{color:#34d399;}
      @media (max-width:820px){#tab-content-reimbursements .reim-kpis{grid-template-columns:repeat(2,1fr);}}
      @media (max-width:520px){#tab-content-reimbursements .reim-kpis{grid-template-columns:1fr;}}
    `;
    document.head.appendChild(st);
  }

  function buildSkeleton() {
    const root = q('reim-root'); if (!root) return; injectStyle();
    root.innerHTML = `
      <div class="reim-card">
        <div class="reim-hero">
          <div style="display:flex;align-items:center;gap:12px;">
            <div class="reim-hero-ic"><i class="fas fa-arrow-rotate-left" style="color:#10b981;font-size:18px;"></i></div>
            <div>
              <h2 style="font-size:19px;font-weight:800;color:#eef2fb;margin:0;line-height:1.1;">Treasury Operations</h2>
              <p style="font-size:12px;color:#8aaac8;margin:3px 0 0;">Real-time settlement &amp; reimbursement dashboard · <span style="color:#34d399;font-weight:700;">read-only</span> · Elligent Treasury Core</p>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
            <span class="reim-mini" id="reim-count">—</span>
            <span id="reim-sync" class="reim-dim" style="font-size:11px;"></span>
            <div class="reim-tabs">
              <button id="reim-tab-list" class="reim-tab active" onclick="reimSwitchView('list')"><i class="fas fa-table-list"></i>Operations</button>
              <button id="reim-tab-analytics" class="reim-tab" onclick="reimSwitchView('analytics')"><i class="fas fa-chart-pie"></i>Analytics</button>
            </div>
            <button class="reim-btn" onclick="reimRefreshNow()"><i class="fas fa-rotate"></i>Refresh</button>
            <div class="reim-tabs">
              <button class="reim-tab" onclick="reimExportCSV()" title="Export CSV"><i class="fas fa-file-csv"></i></button>
              <button class="reim-tab" onclick="reimExportJSON()" title="Export JSON"><i class="fas fa-file-code"></i></button>
              <button class="reim-tab" onclick="reimExportPDF()" title="Export PDF"><i class="fas fa-file-pdf"></i></button>
            </div>
          </div>
        </div>
      </div>

      <div id="reim-banner"></div>
      <div id="reim-kpis" class="reim-kpis"></div>

      <div id="reim-view-list">
        <div id="reim-filters" class="reim-filters"></div>
        <div id="reim-table-wrap"></div>
      </div>
      <div id="reim-view-analytics" class="hidden"><div id="reim-analytics"></div></div>
    `;
    if (!q('reim-overlay')) {
      const ov = document.createElement('div');
      ov.id = 'reim-overlay'; ov.className = 'reim-overlay hidden';
      ov.setAttribute('onclick', 'if(event.target===this)reimClose()');
      ov.innerHTML = '<div id="reim-panel" class="reim-panel" tabindex="-1" role="dialog" aria-label="Operation details"></div>';
      document.body.appendChild(ov);
    }
    S.built = true;
  }

  ['ub:bridge:completed', 'ub:cctp:completed', 'treasury:completed', 'treasurybridge:event'].forEach((ev) => {
    try { window.addEventListener(ev, () => { if (tabActive() && !S.loading) refresh(false); }); } catch (_) {}
  });

  window.reimbursementsInit = function () {
    try { buildSkeleton(); renderBanner(); renderDashboard(); renderFilters(); renderTable(); refresh(false); scheduleAuto(); }
    catch (e) { console.error('[Reimbursements] init failed', e); }
  };
  window.reimbursementsRefresh = function () { if (!S.built) { window.reimbursementsInit(); return; } refresh(false); };

  console.log('%c[Reimbursements] Treasury Operations Dashboard loaded', 'color:#10b981;font-weight:bold', '| v' + REIM_VERSION + ' | read-only · Treasury Core real-time');
})();
