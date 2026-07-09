// ============================================================
// TREASURY OPERATIONS CENTER (TOC) — ExecDaat
// ------------------------------------------------------------
// Pure OBSERVABILITY layer. 100% additive, read-only.
//
//   • Subscribes to window.TreasuryEventBus (never emits).
//   • Reads window.TreasuryJobEngine.status() (never controls jobs).
//   • Reads the native Treasury Core (/api/core/v1/*) — GET only.
//   • Never signs, moves, locks or reimburses funds.
//   • Never modifies Bridge, Treasury, Vault, Settlement, Event Bus
//     or Job Engine. Never interferes with any of them.
//
// Provides a single real-time operational console: status bar, live
// operations, live event stream, system health, performance, alerts,
// live pipeline map, details drawer, filters, search, export.
//
// Exposes: window.tocInit / window.tocRefresh
// build: 20260709toc1
// ============================================================
'use strict';

(function () {
  const TOC_VERSION = '20260709toc1';
  const ARC_EXPLORER = 'https://testnet.arcscan.app';
  const CORE = '/api/core/v1';
  const REFRESH_MS = 4000;
  const EVT_CAP = 500;

  const S = {
    built: false, timer: null, loading: false, lastSync: 0,
    health: null, metrics: null, vault: null, ops: [], jobStatus: null,
    events: [], evtPaused: false, evtSearch: '', evtFilter: 'all',
    evtTimes: [], jobTimes: [],
    fStatus: 'all', fAsset: 'all', search: '', selected: null,
    unsub: null,
  };

  // ── Helpers ──────────────────────────────────────────────────────────────────
  const q = (id) => document.getElementById(id);
  const W = (n) => { try { return window[n]; } catch (_) { return undefined; } };
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const escAttr = (s) => esc(s).replace(/'/g, '&#39;');
  const num = (v) => { const n = Number(v); return isFinite(n) ? n : null; };
  function fmtNum(v, dp) { const n = num(v); if (n == null) return '—'; return n.toLocaleString('en-US', { minimumFractionDigits: dp == null ? 0 : dp, maximumFractionDigits: dp == null ? 2 : dp }); }
  function fmtAmt(v) { const n = num(v); return n == null ? '—' : fmtNum(n, 2); }
  const shortHash = (h) => (!h || typeof h !== 'string' || h.length < 14) ? (h || '—') : h.slice(0, 8) + '…' + h.slice(-6);
  const shortAddr = (a) => (!a || typeof a !== 'string' || a.length < 12) ? (a || '—') : a.slice(0, 6) + '…' + a.slice(-4);
  function toMs(t) { if (t == null || t === '') return 0; if (typeof t === 'number') { if (t > 1e12) return t; if (t > 1e9) return t * 1000; return t; } const p = Date.parse(t); return isNaN(p) ? 0 : p; }
  function fmtDur(ms) { if (ms == null || !isFinite(ms) || ms <= 0) return '—'; const s = Math.round(ms / 1000); if (s < 60) return s + 's'; const m = Math.floor(s / 60); if (m < 60) return m + 'm ' + (s % 60) + 's'; const h = Math.floor(m / 60); return h + 'h ' + (m % 60) + 'm'; }
  function clock(ms) { const d = new Date(ms || Date.now()); return d.toLocaleTimeString('en-US', { hour12: false }); }
  function timeAgo(ms) { if (!ms) return '—'; const s = Math.max(0, Math.floor((Date.now() - ms) / 1000)); if (s < 60) return s + 's ago'; const m = Math.floor(s / 60); if (m < 60) return m + 'm ago'; return Math.floor(m / 60) + 'h ago'; }
  function copyText(v, l) { try { navigator.clipboard.writeText(String(v || '')); if (typeof showToast === 'function') showToast((l || 'Value') + ' copied', 'success'); } catch (_) {} }
  window.tocCopy = copyText;

  function fetchCore(path) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 11000);
    return fetch(CORE + path, { signal: ctrl.signal, headers: { 'Accept': 'application/json' }, credentials: 'same-origin' })
      .then((r) => r.ok ? r.json() : null).then((j) => (j && j.data !== undefined ? j.data : j)).catch(() => null).finally(() => clearTimeout(t));
  }

  // ── Stage / status model ──────────────────────────────────────────────────────
  const STAGE_META = {
    CREATED: { label: 'Created', color: '#93c5fd', icon: 'fa-file-circle-plus' },
    RESERVED: { label: 'Reserved', color: '#7dd3fc', icon: 'fa-lock' },
    VAULT_DEBITED: { label: 'Vault Debited', color: '#38bdf8', icon: 'fa-money-bill-transfer' },
    TREASURY_PAID: { label: 'Treasury Paid', color: '#a78bfa', icon: 'fa-hand-holding-dollar' },
    WAITING_ATTESTATION: { label: 'Waiting Attestation', color: '#fbbf24', icon: 'fa-satellite-dish' },
    ATTESTED: { label: 'Attested', color: '#67e8f9', icon: 'fa-certificate' },
    MINTED: { label: 'Minted', color: '#67e8f9', icon: 'fa-coins' },
    SETTLING: { label: 'Settling', color: '#c084fc', icon: 'fa-gears' },
    SETTLED: { label: 'Settled', color: '#34d399', icon: 'fa-check-double' },
    REIMBURSED: { label: 'Reimbursed', color: '#34d399', icon: 'fa-arrow-rotate-left' },
    COMPLETED: { label: 'Completed', color: '#10b981', icon: 'fa-circle-check' },
    FAILED: { label: 'Failed', color: '#f87171', icon: 'fa-circle-xmark' },
    CANCELLED: { label: 'Cancelled', color: '#9ca3af', icon: 'fa-ban' },
    UNKNOWN: { label: 'Unknown', color: '#8aaac8', icon: 'fa-circle' },
  };
  const STAGE_ORDER = ['CREATED', 'RESERVED', 'VAULT_DEBITED', 'TREASURY_PAID', 'WAITING_ATTESTATION', 'ATTESTED', 'MINTED', 'SETTLING', 'SETTLED', 'REIMBURSED', 'COMPLETED'];
  const TERMINAL = { COMPLETED: 1, REIMBURSED: 1, FAILED: 1, CANCELLED: 1 };
  function stageKey(s) { const k = String(s || '').toUpperCase(); return STAGE_META[k] ? k : 'UNKNOWN'; }
  function stageBadge(s) { const k = stageKey(s); const m = STAGE_META[k]; return `<span class="toc-chip" style="color:${m.color};background:${m.color}1f;border:1px solid ${m.color}44;"><i class="fas ${m.icon}" style="font-size:8px;"></i>${m.label}</span>`; }
  function progressPct(s) { const i = STAGE_ORDER.indexOf(stageKey(s)); if (i < 0) return (stageKey(s) === 'FAILED' || stageKey(s) === 'CANCELLED') ? 100 : 5; return Math.round(((i + 1) / STAGE_ORDER.length) * 100); }
  function progressBar(s) { const k = stageKey(s); const m = STAGE_META[k]; const isFail = k === 'FAILED' || k === 'CANCELLED'; return `<div class="toc-prog"><div class="toc-prog-fill" style="width:${progressPct(s)}%;background:${isFail ? '#f87171' : m.color};"></div></div>`; }

  // ── Live Event Stream (subscribe-only) ─────────────────────────────────────────
  function onBusEvent(payload) {
    try {
      const ev = payload && payload.event;
      const ts = (payload && payload.timestamp) || Date.now();
      S.events.unshift({ ts, event: ev || 'Event', intentId: payload && payload.intentId, stage: payload && payload.stage, asset: payload && payload.asset, amount: payload && payload.amount, priority: payload && payload.priority });
      if (S.events.length > EVT_CAP) S.events.length = EVT_CAP;
      S.evtTimes.push(ts); pruneTimes(S.evtTimes);
      if (ev === 'JobCompleted') { S.jobTimes.push(ts); pruneTimes(S.jobTimes); }
      if (!S.evtPaused && tabActive()) renderEventStream();
    } catch (_) {}
  }
  function pruneTimes(arr) { const cut = Date.now() - 60000; while (arr.length && arr[0] < cut) arr.shift(); }

  function subscribeBus() {
    if (S.unsub) return;
    const bus = W('TreasuryEventBus');
    if (bus && bus.onAny) { S.unsub = bus.onAny(onBusEvent); }
  }

  // ── Data load (read-only) ──────────────────────────────────────────────────────
  async function load() {
    if (S.loading) return; S.loading = true;
    try {
      const [health, metrics, vault, hist] = await Promise.all([
        fetchCore('/health'), fetchCore('/metrics'), fetchCore('/vault'), fetchCore('/history?limit=200'),
      ]);
      if (health) S.health = health;
      if (metrics) S.metrics = metrics;
      if (vault) S.vault = vault;
      if (hist && Array.isArray(hist.items)) S.ops = hist.items;
      try { const je = W('TreasuryJobEngine'); if (je && je.status) S.jobStatus = je.status(); } catch (_) {}
      S.lastSync = Date.now();
      renderAll();
    } catch (_) {} finally { S.loading = false; }
  }

  function tabActive() { const el = q('tab-content-toc'); return el && !el.classList.contains('hidden'); }
  function startAuto() { if (S.timer) clearInterval(S.timer); S.timer = setInterval(() => { if (tabActive() && !document.hidden) load(); }, REFRESH_MS); }

  // ── Health scoring ──────────────────────────────────────────────────────────────
  function components() {
    const c = (S.health && S.health.components) || {};
    const je = S.jobStatus;
    const busOk = !!W('TreasuryEventBus');
    return {
      'Treasury Core': (S.health && S.health.status === 'ok') ? 'ok' : 'degraded',
      Vault: c.vault ? c.vault.status : 'unknown',
      Bridge: c.bridge ? c.bridge.status : 'ok',
      Settlement: c.settlement ? c.settlement.status : 'ok',
      Reimbursement: c.reimbursement ? c.reimbursement.status : 'ok',
      Circle: c.circle ? c.circle.status : 'ok',
      RPC: c.rpc ? c.rpc.status : 'unknown',
      KV: c.kv ? c.kv.status : 'unknown',
      Storage: c.storage ? c.storage.status : 'unknown',
      Workers: c.workers ? c.workers.status : 'ok',
      'Background Jobs': je ? 'ok' : 'degraded',
      'Event Bus': busOk ? 'ok' : 'degraded',
    };
  }
  function healthScore() { const comp = components(); const keys = Object.keys(comp); const okc = keys.filter((k) => comp[k] === 'ok').length; return keys.length ? Math.round((okc / keys.length) * 100) : 0; }
  function dot(status) { const col = status === 'ok' ? '#34d399' : (status === 'degraded' ? '#fbbf24' : (status === 'unknown' ? '#5f7ba0' : '#f87171')); return `<span class="toc-dot" style="background:${col};"></span>`; }

  // ── Renders ──────────────────────────────────────────────────────────────────
  function renderAll() { if (!S.built) return; renderStatusBar(); renderMap(); renderOps(); renderHealth(); renderPerf(); renderAlerts(); renderEventStream(); if (S.selected) { const o = S.ops.find((x) => (x.intentId || x.id) === S.selected); if (o) renderPanel(o); } setSync(); }
  function setSync() { const el = q('toc-sync'); if (el) el.innerHTML = `<i class="fas fa-circle" style="color:#34d399;font-size:7px;"></i> Live · ${timeAgo(S.lastSync)}`; }

  function renderStatusBar() {
    const el = q('toc-statusbar'); if (!el) return;
    const c = (S.health && S.health.components) || {};
    const je = S.jobStatus;
    const chip = (label, status, extra) => `<div class="toc-sb"><div class="toc-sb-top">${dot(status)}<span>${esc(label)}</span></div><div class="toc-sb-val">${extra || (status || '—')}</div></div>`;
    const score = healthScore();
    const scoreCol = score >= 90 ? '#34d399' : (score >= 60 ? '#fbbf24' : '#f87171');
    el.innerHTML = [
      chip('Treasury', (S.health && S.health.status) === 'ok' ? 'ok' : 'degraded'),
      chip('Vault', c.vault ? c.vault.status : 'unknown', c.vault && c.vault.paused ? 'paused' : 'active'),
      chip('Bridge', c.bridge ? c.bridge.status : 'ok'),
      chip('Settlement', c.settlement ? c.settlement.status : 'ok'),
      chip('Circle', c.circle ? c.circle.status : 'ok'),
      chip('RPC', c.rpc ? c.rpc.status : 'unknown', c.rpc && c.rpc.latencyMs != null ? c.rpc.latencyMs + 'ms' : '—'),
      chip('Jobs', je ? 'ok' : 'degraded', je ? ((je.running || 0) + ' run') : '—'),
      chip('Event Bus', W('TreasuryEventBus') ? 'ok' : 'degraded'),
      `<div class="toc-sb toc-sb-score"><div class="toc-sb-top"><span>Health Score</span></div><div class="toc-sb-val" style="color:${scoreCol};font-size:20px;font-weight:800;">${score}%</div></div>`,
    ].join('');
  }

  function renderMap() {
    const el = q('toc-map'); if (!el) return;
    const counts = {};
    S.ops.forEach((o) => { const k = stageKey(o.status); counts[k] = (counts[k] || 0) + 1; });
    const groups = [
      { key: 'Bridge', stages: ['CREATED', 'RESERVED', 'VAULT_DEBITED', 'TREASURY_PAID'], icon: 'fa-bridge', color: '#06b6d4' },
      { key: 'Circle', stages: ['WAITING_ATTESTATION', 'ATTESTED', 'MINTED'], icon: 'fa-certificate', color: '#67e8f9' },
      { key: 'Vault', stages: ['VAULT_DEBITED'], icon: 'fa-vault', color: '#f59e0b' },
      { key: 'Settlement', stages: ['SETTLING', 'SETTLED'], icon: 'fa-gears', color: '#c084fc' },
      { key: 'Reimbursement', stages: ['REIMBURSED'], icon: 'fa-arrow-rotate-left', color: '#34d399' },
      { key: 'Completed', stages: ['COMPLETED'], icon: 'fa-circle-check', color: '#10b981' },
    ];
    el.innerHTML = groups.map((g, i) => {
      const active = g.stages.reduce((a, s) => a + (counts[s] || 0), 0);
      return `<div class="toc-map-node ${active ? 'active' : ''}" style="--nc:${g.color};"><div class="toc-map-ic"><i class="fas ${g.icon}"></i></div><div class="toc-map-label">${g.key}</div><div class="toc-map-count">${active}</div></div>${i < groups.length - 1 ? '<div class="toc-map-arrow"><i class="fas fa-chevron-right"></i></div>' : ''}`;
    }).join('');
  }

  function opFilter(list) {
    const term = S.search.trim().toLowerCase();
    return list.filter((o) => {
      const st = stageKey(o.status);
      if (S.fStatus === 'active' && TERMINAL[st]) return false;
      if (S.fStatus !== 'all' && S.fStatus !== 'active' && st !== S.fStatus) return false;
      if (S.fAsset !== 'all' && String(o.asset || '').toUpperCase() !== S.fAsset) return false;
      if (term) { const hay = [o.intentId, o.wallet, o.recipient, o.correlationId, o.memo, o.sourceTxHash, o.settlementTxHash].filter(Boolean).join(' ').toLowerCase(); if (hay.indexOf(term) === -1) return false; }
      return true;
    });
  }

  function renderOps() {
    const el = q('toc-ops'); if (!el) return;
    let list = opFilter(S.ops.slice());
    list.sort((a, b) => toMs(b.updatedAt || b.createdAt) - toMs(a.updatedAt || a.createdAt));
    list = list.slice(0, 60); // lazy cap
    if (!list.length) { el.innerHTML = `<div class="toc-empty"><i class="fas fa-inbox"></i><p>No operations to display.</p></div>`; return; }
    const rows = list.map((o) => {
      const st = stageKey(o.status); const created = toMs(o.createdAt); const dur = created ? (toMs(o.updatedAt || o.completedAt) || Date.now()) - created : null;
      return `<tr onclick="tocOpen('${escAttr(o.intentId || o.id)}')">
        <td><span class="toc-mono">${esc(shortHash(o.intentId || o.id))}</span></td>
        <td><div style="display:flex;flex-direction:column;gap:4px;">${stageBadge(o.status)}${progressBar(o.status)}</div></td>
        <td>${esc(String(o.asset || '—').toUpperCase())}</td>
        <td style="text-align:right;font-weight:700;color:#e7eefb;">${fmtAmt(o.amount)}</td>
        <td>${esc(o.sourceChain || '—')} <i class="fas fa-arrow-right" style="color:#3a4870;font-size:8px;"></i> ${esc(o.destinationChain || 'arc')}</td>
        <td>${esc(o.bridge || 'Turbo')}</td>
        <td>${esc(fmtDur(dur))}</td>
        <td>${o.wallet ? `<span class="toc-mono">${esc(shortAddr(o.wallet))}</span>` : '—'}</td>
        <td>${o.correlationId ? `<span class="toc-mono toc-xs">${esc(shortHash(o.correlationId))}</span>` : '—'}</td>
      </tr>`;
    }).join('');
    el.innerHTML = `<div class="toc-table-scroll"><table class="toc-table"><thead><tr><th>Intent</th><th>Stage · Progress</th><th>Asset</th><th style="text-align:right;">Amount</th><th>Route</th><th>Bridge</th><th>Duration</th><th>Operator</th><th>Corr. ID</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function renderHealth() {
    const el = q('toc-health'); if (!el) return;
    const comp = components(); const c = (S.health && S.health.components) || {};
    const rows = Object.keys(comp).map((k) => {
      const status = comp[k]; let latency = '—'; let last = timeAgo(S.lastSync);
      if (k === 'RPC' && c.rpc && c.rpc.latencyMs != null) latency = c.rpc.latencyMs + 'ms';
      const warn = status !== 'ok' && status !== 'unknown';
      return `<div class="toc-hrow"><div class="toc-hk">${dot(status)}<span>${esc(k)}</span></div><div class="toc-hv"><span class="toc-xs" style="color:${warn ? '#fbbf24' : '#8aaac8'};">${esc(status)}</span><span class="toc-xs toc-dim">${latency}</span><span class="toc-xs toc-dim">${last}</span></div></div>`;
    }).join('');
    el.innerHTML = rows;
  }

  function renderPerf() {
    const el = q('toc-perf'); if (!el) return;
    const m = S.metrics || {};
    const settleTimes = S.ops.map((o) => (toMs(o.settledAt) && toMs(o.createdAt)) ? toMs(o.settledAt) - toMs(o.createdAt) : null).filter(Boolean).sort((a, b) => a - b);
    const pct = (p) => { if (!settleTimes.length) return '—'; const i = Math.min(settleTimes.length - 1, Math.floor((p / 100) * settleTimes.length)); return fmtDur(settleTimes[i]); };
    const evMin = S.evtTimes.length, jobMin = S.jobTimes.length;
    const stat = (label, val, col) => `<div class="toc-perf-cell"><div class="toc-perf-v" style="color:${col || '#e7eefb'};">${val}</div><div class="toc-perf-k">${esc(label)}</div></div>`;
    el.innerHTML = [
      stat('Bridge Throughput', fmtNum(m.intentCount || 0, 0), '#60b4ff'),
      stat('Settlements', fmtNum(m.settledCount || 0, 0), '#34d399'),
      stat('Events/min', fmtNum(evMin, 0), '#67e8f9'),
      stat('Jobs/min', fmtNum(jobMin, 0), '#f59e0b'),
      stat('Avg Settle', fmtDur(m.averageSettlementTime), '#a78bfa'),
      stat('P50', pct(50), '#93c5fd'),
      stat('P95', pct(95), '#93c5fd'),
      stat('P99', pct(99), '#93c5fd'),
      stat('Success Rate', (m.bridgeSuccessRate != null ? fmtNum(m.bridgeSuccessRate, 1) + '%' : '—'), '#34d399'),
      stat('Failures', fmtNum(m.failedCount || 0, 0), '#f87171'),
    ].join('');
  }

  function renderAlerts() {
    const el = q('toc-alerts'); if (!el) return;
    const alerts = [];
    const c = (S.health && S.health.components) || {};
    const m = S.metrics || {};
    const je = S.jobStatus;
    if (c.rpc && c.rpc.latencyMs != null && c.rpc.latencyMs > 1500) alerts.push({ t: 'RPC Slow', d: c.rpc.latencyMs + 'ms', lvl: 'warn' });
    if (S.vault && S.vault.assets && S.vault.assets.USDC && S.vault.assets.USDC.available != null && S.vault.assets.USDC.available < 100) alerts.push({ t: 'Vault Low Liquidity', d: 'USDC ' + fmtAmt(S.vault.assets.USDC.available), lvl: 'warn' });
    const pendAtt = S.ops.filter((o) => stageKey(o.status) === 'WAITING_ATTESTATION').length;
    if (pendAtt) alerts.push({ t: 'Pending Attestation', d: pendAtt + ' operation(s)', lvl: 'info' });
    const pendSettle = S.ops.filter((o) => stageKey(o.status) === 'SETTLED' || stageKey(o.status) === 'SETTLING').length;
    if (pendSettle) alerts.push({ t: 'Settlement Delayed', d: pendSettle + ' awaiting reimbursement', lvl: 'info' });
    if (je && je.retryQueue) alerts.push({ t: 'Background Job Retry', d: je.retryQueue + ' in retry queue', lvl: 'warn' });
    if (c.workers && c.workers.status !== 'ok') alerts.push({ t: 'Worker Offline', d: c.workers.status, lvl: 'error' });
    if (!alerts.length) { el.innerHTML = `<div class="toc-noalert"><i class="fas fa-circle-check"></i> All systems nominal — no active alerts.</div>`; return; }
    el.innerHTML = alerts.map((a) => { const col = a.lvl === 'error' ? '#f87171' : (a.lvl === 'warn' ? '#fbbf24' : '#67e8f9'); return `<div class="toc-alert" style="border-color:${col}44;"><i class="fas fa-triangle-exclamation" style="color:${col};"></i><span class="toc-alert-t">${esc(a.t)}</span><span class="toc-alert-d">${esc(a.d)}</span></div>`; }).join('');
  }

  function evtFilter(list) {
    const term = S.evtSearch.trim().toLowerCase();
    return list.filter((e) => {
      if (S.evtFilter !== 'all' && e.event !== S.evtFilter) return false;
      if (term) { const hay = [e.event, e.intentId, e.stage, e.asset].filter(Boolean).join(' ').toLowerCase(); if (hay.indexOf(term) === -1) return false; }
      return true;
    });
  }
  function renderEventStream() {
    const el = q('toc-evt-list'); if (!el) return;
    const list = evtFilter(S.events).slice(0, 200);
    if (!list.length) { el.innerHTML = `<div class="toc-dim toc-xs" style="padding:12px;">Waiting for events… run a bridge to see the live stream.</div>`; return; }
    el.innerHTML = list.map((e) => {
      const m = STAGE_META[stageKey(e.stage)] || { color: '#67e8f9' };
      const col = /fail|cancel/i.test(e.event) ? '#f87171' : (/completed|reimbursed|settlementcompleted/i.test(e.event) ? '#34d399' : m.color);
      return `<div class="toc-evt"><span class="toc-evt-ts">${clock(e.ts)}</span><span class="toc-evt-name" style="color:${col};">${esc(e.event)}</span>${e.intentId ? `<span class="toc-mono toc-xs toc-dim">${esc(shortHash(e.intentId))}</span>` : ''}</div>`;
    }).join('');
    const c = q('toc-evt-count'); if (c) c.textContent = S.events.length + ' events';
  }

  // ── Details drawer ──────────────────────────────────────────────────────────────
  function renderPanel(o) {
    const panel = q('toc-panel'); if (!panel) return;
    const st = stageKey(o.status);
    const created = toMs(o.createdAt);
    const steps = STAGE_ORDER.map((sk) => ({ key: sk, done: STAGE_ORDER.indexOf(sk) <= STAGE_ORDER.indexOf(st) }));
    const timeline = steps.map((s, i) => { const m = STAGE_META[s.key]; const dot = s.done ? '#34d399' : '#3a4870'; return `<div class="toc-tl-row"><div class="toc-tl-mk"><span class="toc-tl-dot" style="background:${dot};border-color:${dot};"></span>${i < steps.length - 1 ? `<span class="toc-tl-line" style="background:${s.done ? 'rgba(52,211,153,.35)' : 'rgba(58,72,112,.4)'};"></span>` : ''}</div><div class="toc-tl-body"><span class="toc-tl-label" style="color:${s.done ? '#e7eefb' : '#7f93b5'};"><i class="fas ${m.icon}" style="font-size:9px;color:${m.color};"></i> ${m.label}</span>${s.done ? '<i class="fas fa-check toc-tl-ok"></i>' : ''}</div></div>`; }).join('');
    const evts = S.events.filter((e) => e.intentId === (o.intentId || o.id)).slice(0, 20);
    const evtHist = evts.length ? evts.map((e) => `<div class="toc-prow"><span class="toc-pk">${clock(e.ts)}</span><span class="toc-pv">${esc(e.event)}</span></div>`).join('') : '<div class="toc-prow"><span class="toc-pv toc-dim">No captured events for this intent yet.</span></div>';
    const tx = (label, h) => `<div class="toc-prow"><span class="toc-pk">${esc(label)}</span><span class="toc-pv">${h ? `<a class="toc-txn" href="${ARC_EXPLORER}/tx/${escAttr(h)}" target="_blank" rel="noopener">${esc(shortHash(h))}<i class="fas fa-external-link-alt"></i></a>` : '—'}</span></div>`;
    const row = (k, v) => `<div class="toc-prow"><span class="toc-pk">${esc(k)}</span><span class="toc-pv">${v}</span></div>`;
    panel.innerHTML = `
      <div class="toc-panel-head"><div><div>${stageBadge(o.status)}</div><div class="toc-xs toc-dim" style="margin-top:6px;">${esc(shortHash(o.intentId || o.id))}</div></div><button class="toc-ic" onclick="tocClose()"><i class="fas fa-times"></i></button></div>
      <div class="toc-psec">Timeline</div><div class="toc-timeline">${timeline}</div>
      <div class="toc-psec">Operation</div><div class="toc-pcard">
        ${row('Intent ID', `<span class="toc-mono">${esc(o.intentId || o.id)}</span>`)}
        ${row('Application', esc(o.application || 'EXECDAAT'))}
        ${row('Wallet', o.wallet ? `<span class="toc-mono">${esc(shortAddr(o.wallet))}</span>` : '—')}
        ${row('Recipient', o.recipient ? `<span class="toc-mono">${esc(shortAddr(o.recipient))}</span>` : '—')}
        ${row('Asset', esc(String(o.asset || '—').toUpperCase()))}
        ${row('Amount', fmtAmt(o.amount))}
        ${row('Vault', o.vault ? `<span class="toc-mono">${esc(shortAddr(o.vault))}</span>` : '—')}
        ${row('Route', esc(o.sourceChain || '—') + ' → ' + esc(o.destinationChain || 'arc'))}
        ${row('Memo', o.memo ? `<span class="toc-mono toc-wrap">${esc(o.memo)}</span>` : '—')}
        ${row('Correlation ID', o.correlationId ? `<span class="toc-mono">${esc(o.correlationId)}</span>` : '—')}
        ${row('Ledger Entry', o.ledgerEntry ? `<span class="toc-mono">${esc(o.ledgerEntry)}</span>` : '—')}
        ${row('Created', created ? new Date(created).toLocaleString() : '—')}
      </div>
      <div class="toc-psec">Transactions</div><div class="toc-pcard">
        ${tx('Circle Burn', o.sourceTxHash)}${tx('Mint', o.circleMintTxHash)}${tx('Treasury', o.fulfillTxHash)}${tx('Settlement', o.settlementTxHash)}${tx('Vault Credit', o.vaultCreditTxHash)}
      </div>
      <div class="toc-psec">Event History</div><div class="toc-pcard">${evtHist}</div>
      <p class="toc-note"><i class="fas fa-shield-halved"></i> Observability only — read-only view of the native Treasury Core.</p>`;
    q('toc-overlay').classList.remove('hidden');
    requestAnimationFrame(() => panel.classList.add('open'));
  }

  // ── Export ──────────────────────────────────────────────────────────────────
  function download(name, text, mime) { try { const b = new Blob([text], { type: mime }); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(u); a.remove(); }, 100); if (typeof showToast === 'function') showToast('Export ready: ' + name, 'success'); } catch (_) {} }
  function exportJSON() { const rows = opFilter(S.ops.slice()); download('toc-operations-' + Date.now() + '.json', JSON.stringify(rows, null, 2), 'application/json'); }
  function exportCSV() {
    const rows = opFilter(S.ops.slice()); const cols = ['intentId', 'application', 'asset', 'amount', 'sourceChain', 'destinationChain', 'bridge', 'status', 'wallet', 'correlationId', 'createdAt', 'updatedAt'];
    const head = cols.join(','); const body = rows.map((o) => cols.map((c) => '"' + String(o[c] == null ? '' : o[c]).replace(/"/g, '""') + '"').join(',')).join('\n');
    download('toc-operations-' + Date.now() + '.csv', head + '\n' + body, 'text/csv');
  }
  function exportPDF() {
    const rows = opFilter(S.ops.slice()); const w = window.open('', '_blank'); if (!w) { if (typeof showToast === 'function') showToast('Allow popups to export PDF', 'warning'); return; }
    const m = S.metrics || {}; const style = 'body{font-family:Arial;padding:24px;color:#111}h1{font-size:18px}table{border-collapse:collapse;width:100%;font-size:10px;margin-top:12px}th,td{border:1px solid #ccc;padding:4px 6px;text-align:left}th{background:#f3f4f6}';
    const head = '<tr><th>Intent</th><th>Stage</th><th>Asset</th><th>Amount</th><th>Route</th><th>Created</th></tr>';
    const body = rows.map((o) => `<tr><td>${esc(o.intentId || o.id)}</td><td>${esc(stageKey(o.status))}</td><td>${esc(o.asset || '')}</td><td>${fmtAmt(o.amount)}</td><td>${esc(o.sourceChain || '')}→${esc(o.destinationChain || 'arc')}</td><td>${o.createdAt ? new Date(toMs(o.createdAt)).toLocaleString() : ''}</td></tr>`).join('');
    w.document.write(`<html><head><title>ExecDaat TOC Report</title><style>${style}</style></head><body><h1>ExecDaat — Treasury Operations Report</h1><p>${new Date().toLocaleString()} · ${rows.length} operations · Health ${healthScore()}% · Volume ${fmtAmt(m.totalVolume)}</p><table><thead>${head}</thead><tbody>${body}</tbody></table><script>window.onload=function(){window.print()}<\/script></body></html>`);
    w.document.close();
  }

  // ── Public handlers ──────────────────────────────────────────────────────────
  window.tocOpen = function (id) { S.selected = id; const o = S.ops.find((x) => (x.intentId || x.id) === id); if (o) renderPanel(o); };
  window.tocClose = function () { S.selected = null; const p = q('toc-panel'), o = q('toc-overlay'); if (p) p.classList.remove('open'); if (o) setTimeout(() => o.classList.add('hidden'), 180); };
  window.tocSetFilter = function (k, v) { S[k] = v; renderOps(); };
  window.tocSearch = function (v) { S.search = v; renderOps(); };
  window.tocEvtSearch = function (v) { S.evtSearch = v; renderEventStream(); };
  window.tocEvtFilter = function (v) { S.evtFilter = v; renderEventStream(); };
  window.tocEvtPause = function () { S.evtPaused = !S.evtPaused; const b = q('toc-evt-pause'); if (b) b.innerHTML = S.evtPaused ? '<i class="fas fa-play"></i> Resume' : '<i class="fas fa-pause"></i> Pause'; if (!S.evtPaused) renderEventStream(); };
  window.tocEvtClear = function () { S.events = []; renderEventStream(); };
  window.tocRefreshNow = function () { load(); };
  window.tocExportCSV = exportCSV; window.tocExportJSON = exportJSON; window.tocExportPDF = exportPDF;

  // ── Skeleton + styles ──────────────────────────────────────────────────────────
  function injectStyle() {
    if (q('toc-styles')) return;
    const st = document.createElement('style'); st.id = 'toc-styles';
    st.textContent = `
      #tab-content-toc{color:#dbe4f2;}
      #tab-content-toc .toc-card{background:rgba(12,16,32,.55);border:1px solid rgba(55,138,221,.12);border-radius:16px;padding:16px;margin-bottom:16px;}
      #tab-content-toc .toc-card-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;}
      #tab-content-toc .toc-card-title{font-size:13px;font-weight:800;color:#eef2fb;display:flex;align-items:center;gap:8px;}
      #tab-content-toc .toc-dim{color:#5f7ba0;} #tab-content-toc .toc-xs{font-size:10px;}
      #tab-content-toc .toc-mono{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#bcd6f5;} #tab-content-toc .toc-wrap{white-space:normal;word-break:break-all;}
      #tab-content-toc .toc-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;display:inline-block;}
      #tab-content-toc .toc-chip{display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:999px;font-size:10px;font-weight:700;white-space:nowrap;}
      #tab-content-toc .toc-prog{height:4px;background:rgba(55,138,221,.12);border-radius:3px;overflow:hidden;min-width:70px;margin-top:2px;}
      #tab-content-toc .toc-prog-fill{height:100%;border-radius:3px;transition:width .4s ease;}
      #tab-content-toc .toc-btn{display:inline-flex;align-items:center;gap:6px;background:rgba(55,138,221,.09);border:1px solid rgba(55,138,221,.2);border-radius:9px;color:#bcd6f5;font-size:12px;font-weight:700;padding:6px 11px;cursor:pointer;}
      #tab-content-toc .toc-btn:hover{background:rgba(55,138,221,.18);}
      #tab-content-toc .toc-ic{background:rgba(55,138,221,.09);border:1px solid rgba(55,138,221,.18);border-radius:7px;color:#9db8d8;cursor:pointer;font-size:12px;width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;}
      /* status bar */
      #tab-content-toc .toc-statusbar{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;}
      #tab-content-toc .toc-sb{background:rgba(8,11,24,.5);border:1px solid rgba(55,138,221,.1);border-radius:11px;padding:9px 11px;}
      #tab-content-toc .toc-sb-top{display:flex;align-items:center;gap:6px;font-size:10px;color:#8aaac8;font-weight:700;text-transform:uppercase;letter-spacing:.03em;}
      #tab-content-toc .toc-sb-val{font-size:12px;color:#dbe4f2;font-weight:700;margin-top:4px;text-transform:capitalize;}
      #tab-content-toc .toc-sb-score{background:rgba(16,185,129,.06);border-color:rgba(16,185,129,.2);}
      /* map */
      #tab-content-toc .toc-map{display:flex;align-items:center;gap:2px;overflow-x:auto;padding:4px 0;}
      #tab-content-toc .toc-map-node{background:rgba(8,11,24,.5);border:1px solid rgba(55,138,221,.12);border-radius:12px;padding:10px 14px;min-width:104px;text-align:center;flex-shrink:0;transition:.3s;}
      #tab-content-toc .toc-map-node.active{border-color:var(--nc);box-shadow:0 0 0 1px var(--nc),0 0 18px -6px var(--nc);animation:tocPulse 1.6s ease-in-out infinite;}
      #tab-content-toc .toc-map-ic{font-size:15px;color:var(--nc);} #tab-content-toc .toc-map-label{font-size:11px;color:#cdd9ec;margin-top:5px;font-weight:600;}
      #tab-content-toc .toc-map-count{font-size:16px;font-weight:800;color:#e7eefb;margin-top:2px;}
      #tab-content-toc .toc-map-arrow{color:#3a4870;flex-shrink:0;padding:0 3px;}
      @keyframes tocPulse{0%,100%{opacity:1}50%{opacity:.75}}
      /* grid */
      #tab-content-toc .toc-grid{display:grid;grid-template-columns:1.6fr 1fr;gap:16px;}
      @media(max-width:1000px){#tab-content-toc .toc-grid{grid-template-columns:1fr;}}
      /* table */
      #tab-content-toc .toc-table-scroll{overflow-x:auto;border:1px solid rgba(55,138,221,.1);border-radius:12px;}
      #tab-content-toc .toc-table{width:100%;border-collapse:collapse;font-size:11.5px;min-width:820px;}
      #tab-content-toc .toc-table th{position:sticky;top:0;background:#0b0f1e;color:#5f7ba0;font-size:9.5px;text-transform:uppercase;font-weight:800;text-align:left;padding:9px 10px;white-space:nowrap;border-bottom:1px solid rgba(55,138,221,.14);}
      #tab-content-toc .toc-table td{padding:8px 10px;border-bottom:1px solid rgba(55,138,221,.06);white-space:nowrap;}
      #tab-content-toc .toc-table tbody tr{cursor:pointer;} #tab-content-toc .toc-table tbody tr:hover{background:rgba(55,138,221,.06);}
      /* event stream */
      #tab-content-toc .toc-evt-console{background:#070a14;border:1px solid rgba(55,138,221,.1);border-radius:12px;height:360px;overflow-y:auto;padding:6px 4px;font-family:ui-monospace,Menlo,monospace;}
      #tab-content-toc .toc-evt{display:flex;align-items:center;gap:8px;padding:3px 8px;border-bottom:1px solid rgba(55,138,221,.04);}
      #tab-content-toc .toc-evt-ts{color:#5f7ba0;font-size:10px;flex-shrink:0;} #tab-content-toc .toc-evt-name{font-size:11px;font-weight:700;}
      #tab-content-toc .toc-evt-controls{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px;}
      /* health / perf / alerts */
      #tab-content-toc .toc-hrow{display:flex;align-items:center;justify-content:space-between;padding:7px 0;border-bottom:1px solid rgba(55,138,221,.06);}
      #tab-content-toc .toc-hk{display:flex;align-items:center;gap:8px;font-size:12px;color:#cdd9ec;} #tab-content-toc .toc-hv{display:flex;gap:12px;align-items:center;}
      #tab-content-toc .toc-perf{display:grid;grid-template-columns:repeat(auto-fit,minmax(90px,1fr));gap:10px;}
      #tab-content-toc .toc-perf-cell{background:rgba(8,11,24,.5);border:1px solid rgba(55,138,221,.1);border-radius:10px;padding:10px;text-align:center;}
      #tab-content-toc .toc-perf-v{font-size:18px;font-weight:800;} #tab-content-toc .toc-perf-k{font-size:10px;color:#8aaac8;margin-top:3px;}
      #tab-content-toc .toc-alert{display:flex;align-items:center;gap:10px;background:rgba(8,11,24,.5);border:1px solid rgba(55,138,221,.14);border-radius:10px;padding:9px 12px;margin-bottom:8px;}
      #tab-content-toc .toc-alert-t{font-weight:700;font-size:12px;color:#e7eefb;} #tab-content-toc .toc-alert-d{margin-left:auto;font-size:11px;color:#9db8d8;}
      #tab-content-toc .toc-noalert{color:#34d399;font-size:12px;padding:8px;} #tab-content-toc .toc-noalert i{margin-right:6px;}
      #tab-content-toc .toc-empty{text-align:center;padding:36px;color:#8aaac8;} #tab-content-toc .toc-empty i{font-size:26px;color:#3a4870;display:block;margin-bottom:8px;}
      #tab-content-toc .toc-input{background:rgba(8,11,24,.6);border:1px solid rgba(55,138,221,.16);border-radius:8px;color:#e7eefb;font-size:12px;padding:7px 10px;}
      #tab-content-toc .toc-txn{color:#60b4ff;text-decoration:none;font-family:ui-monospace,monospace;font-size:10.5px;} #tab-content-toc .toc-txn i{font-size:8px;margin-left:4px;}
      /* drawer */
      .toc-overlay{position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,.55);backdrop-filter:blur(3px);display:flex;justify-content:flex-end;} .toc-overlay.hidden{display:none;}
      .toc-panel{width:100%;max-width:460px;height:100%;background:#0a0c18;border-left:1px solid rgba(6,182,212,.2);overflow-y:auto;padding:18px;transform:translateX(30px);opacity:0;transition:.18s;} .toc-panel.open{transform:translateX(0);opacity:1;}
      .toc-panel-head{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:10px;}
      .toc-psec{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#5f7ba0;margin:16px 0 8px;}
      .toc-pcard{background:rgba(12,16,32,.6);border:1px solid rgba(55,138,221,.12);border-radius:12px;padding:4px 12px;}
      .toc-prow{display:flex;gap:8px;padding:7px 0;border-bottom:1px solid rgba(55,138,221,.07);} .toc-prow:last-child{border-bottom:none;}
      .toc-pk{font-size:11px;color:#5f7ba0;min-width:110px;flex-shrink:0;} .toc-pv{font-size:12px;color:#dbe4f2;flex:1;min-width:0;}
      .toc-timeline .toc-tl-row{display:flex;gap:10px;} .toc-tl-mk{display:flex;flex-direction:column;align-items:center;flex-shrink:0;}
      .toc-tl-dot{width:13px;height:13px;border-radius:50%;border:2px solid;margin-top:2px;} .toc-tl-line{width:2px;flex:1;min-height:10px;}
      .toc-tl-body{padding-bottom:11px;display:flex;align-items:center;gap:8px;} .toc-tl-label{font-size:12px;font-weight:600;} .toc-tl-ok{color:#34d399;font-size:9px;}
      .toc-note{font-size:10px;color:#5f7ba0;margin-top:14px;} .toc-note i{color:#34d399;margin-right:5px;}
    `;
    document.head.appendChild(st);
  }

  function buildSkeleton() {
    const root = q('toc-root'); if (!root) return; injectStyle();
    root.innerHTML = `
      <div class="toc-card">
        <div class="toc-card-head">
          <div style="display:flex;align-items:center;gap:12px;">
            <div style="width:42px;height:42px;border-radius:12px;background:rgba(6,182,212,.1);border:1px solid rgba(6,182,212,.28);display:flex;align-items:center;justify-content:center;"><i class="fas fa-satellite-dish" style="color:#06b6d4;font-size:17px;"></i></div>
            <div><h2 style="font-size:18px;font-weight:800;color:#eef2fb;margin:0;">Treasury Operations Center</h2><p style="font-size:12px;color:#8aaac8;margin:2px 0 0;">Real-time operational console · <span style="color:#34d399;font-weight:700;">observability only</span></p></div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span id="toc-sync" class="toc-dim" style="font-size:11px;"></span>
            <button class="toc-btn" onclick="tocRefreshNow()"><i class="fas fa-rotate"></i></button>
            <button class="toc-btn" onclick="tocExportCSV()" title="CSV"><i class="fas fa-file-csv"></i></button>
            <button class="toc-btn" onclick="tocExportJSON()" title="JSON"><i class="fas fa-file-code"></i></button>
            <button class="toc-btn" onclick="tocExportPDF()" title="PDF"><i class="fas fa-file-pdf"></i></button>
          </div>
        </div>
        <div id="toc-statusbar" class="toc-statusbar"></div>
      </div>

      <div class="toc-card"><div class="toc-card-head"><span class="toc-card-title"><i class="fas fa-diagram-project" style="color:#06b6d4;"></i>Live Pipeline</span></div><div id="toc-map" class="toc-map"></div></div>

      <div class="toc-grid">
        <div class="toc-card">
          <div class="toc-card-head"><span class="toc-card-title"><i class="fas fa-list-check" style="color:#67e8f9;"></i>Live Operations</span>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              <input class="toc-input" style="width:150px;" type="search" placeholder="Search…" oninput="tocSearch(this.value)">
              <select class="toc-input" onchange="tocSetFilter('fStatus',this.value)"><option value="active">Active</option><option value="all">All</option>${STAGE_ORDER.concat(['FAILED', 'CANCELLED']).map((s) => `<option value="${s}">${STAGE_META[s].label}</option>`).join('')}</select>
            </div>
          </div>
          <div id="toc-ops"></div>
        </div>
        <div class="toc-card">
          <div class="toc-card-head"><span class="toc-card-title"><i class="fas fa-terminal" style="color:#34d399;"></i>Live Event Stream</span><span id="toc-evt-count" class="toc-dim toc-xs">0 events</span></div>
          <div class="toc-evt-controls">
            <input class="toc-input" style="flex:1;min-width:100px;" type="search" placeholder="Search events…" oninput="tocEvtSearch(this.value)">
            <button id="toc-evt-pause" class="toc-btn" onclick="tocEvtPause()"><i class="fas fa-pause"></i> Pause</button>
            <button class="toc-btn" onclick="tocEvtClear()"><i class="fas fa-trash"></i></button>
          </div>
          <div id="toc-evt-list" class="toc-evt-console"></div>
        </div>
      </div>

      <div class="toc-grid">
        <div class="toc-card"><div class="toc-card-head"><span class="toc-card-title"><i class="fas fa-heart-pulse" style="color:#34d399;"></i>System Health</span></div><div id="toc-health"></div></div>
        <div class="toc-card"><div class="toc-card-head"><span class="toc-card-title"><i class="fas fa-bell" style="color:#fbbf24;"></i>Active Alerts</span></div><div id="toc-alerts"></div></div>
      </div>

      <div class="toc-card"><div class="toc-card-head"><span class="toc-card-title"><i class="fas fa-gauge-high" style="color:#a78bfa;"></i>Performance</span></div><div id="toc-perf" class="toc-perf"></div></div>
    `;
    if (!q('toc-overlay')) { const ov = document.createElement('div'); ov.id = 'toc-overlay'; ov.className = 'toc-overlay hidden'; ov.setAttribute('onclick', 'if(event.target===this)tocClose()'); ov.innerHTML = '<div id="toc-panel" class="toc-panel" role="dialog" aria-label="Operation details"></div>'; document.body.appendChild(ov); }
    S.built = true;
  }

  window.tocInit = function () { try { buildSkeleton(); subscribeBus(); load(); startAuto(); } catch (e) { console.error('[TOC] init failed', e); } };
  window.tocRefresh = function () { if (!S.built) { window.tocInit(); return; } load(); };

  // Subscribe to the bus early (even before the tab is opened) so the event
  // stream captures activity from the start.
  try { if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(subscribeBus, 2000); else document.addEventListener('DOMContentLoaded', function () { setTimeout(subscribeBus, 2000); }); } catch (_) {}

  console.log('%c[TOC] Treasury Operations Center loaded', 'color:#06b6d4;font-weight:bold', '| v' + TOC_VERSION + ' | observability · read-only');
})();
