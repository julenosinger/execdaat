// ============================================================================
// ExecDaat — Digital Agreements · Dispute Resolution Center (da-dispute-center.js)
// ----------------------------------------------------------------------------
// Enterprise mediation & arbitration workspace for the Digital Agreements (OTC)
// tab — mirrors the Contracts Dispute Resolution Center. 100% ADDITIVE:
//   • Does NOT modify the OTC smart contracts, ABI, escrow flow, on-chain
//     registration, existing APIs or any business logic.
//   • Reuses the OTC data source (localStorage: execDaat_otc_contracts) and
//     routes REAL fund settlement through the EXISTING on-chain functions
//     window.otcResolveDispute() / window.otcRaiseDispute() (no ABI change).
//   • All collaboration data (messages, evidence, proposals, arbitration,
//     audit log) lives in a NEW localStorage namespace.
//   • UI is 100% English, uses the ExecDaat design tokens, fully responsive,
//     and renders ABOVE the sidebar, confined to the main content area.
//
// Entry: window.daDrcOpen(contractId)  + auto-injected card button.
// ============================================================================
(function () {
  'use strict';

  const OTC_STORE   = 'execDaat_otc_contracts';
  const DADR_KEY    = 'da_dispute_center_v1';  // collaboration data per agreement
  const DADR_SNAP   = 'da_dispute_snap_v1';    // minimal agreement snapshots
  const SLA_HOURS   = 72;
  const MAX_FILE    = 10 * 1024 * 1024;

  let activeTab = 'messages';
  let currentId = null;
  let pollTimer = null;
  let pendingMsgFiles = [];
  let _tpl = null;
  let _lastSig = '';

  // ── Host helpers (safe access) ───────────────────────────────────────────
  const toast = (m, t) => { try { (window.showToast || function () {})(m, t || 'info'); } catch (_) {} };
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function shortAddr(a) { if (!a || a.length < 12) return a || '—'; return a.slice(0, 8) + '…' + a.slice(-6); }
  function wallet() { return (window.walletState && window.walletState.address) || null; }
  function explorer() { try { if (typeof OTC_EXPLORER !== 'undefined' && OTC_EXPLORER) return OTC_EXPLORER; } catch (_) {} return 'https://testnet.arcscan.app'; }
  function fmtNum(n) { n = Number(n) || 0; return n.toLocaleString('en-US', { maximumFractionDigits: 6 }); }

  // ── OTC data source ───────────────────────────────────────────────────────
  function loadOtc() { try { return JSON.parse(localStorage.getItem(OTC_STORE) || '[]'); } catch (_) { return []; } }
  function getContract(id) {
    const c = loadOtc().find(x => String(x.contractId) === String(id));
    if (c) { snapshot(c); return c; }
    try { const snap = JSON.parse(localStorage.getItem(DADR_SNAP) || '{}')[String(id)]; if (snap) return snap; } catch (_) {}
    return null;
  }
  function snapshot(c) {
    try {
      const all = JSON.parse(localStorage.getItem(DADR_SNAP) || '{}');
      all[String(c.contractId)] = {
        contractId: c.contractId, buyer: c.buyer, seller: c.seller, asset: c.asset, amount: c.amount,
        status: c.status, onChain: c.onChain, escrowDealId: c.escrowDealId,
        createdAt: c.createdAt || c.timestamp || c.savedAt || null, disputeReason: c.disputeReason || '',
      };
      localStorage.setItem(DADR_SNAP, JSON.stringify(all));
    } catch (_) {}
  }
  function refreshOtc() {
    try { if (typeof window.otcRenderMyContracts === 'function') setTimeout(window.otcRenderMyContracts, 800); } catch (_) {}
    try { if (typeof window.otcRenderMarketplace === 'function') setTimeout(window.otcRenderMarketplace, 900); } catch (_) {}
    try { if (typeof window.ubRefresh === 'function') setTimeout(window.ubRefresh, 2500); } catch (_) {}
    try { document.dispatchEvent(new CustomEvent('da-drc:settled', { detail: { contractId: currentId } })); } catch (_) {}
  }

  // ── Collaboration store ─────────────────────────────────────────────────────
  function allData() { try { return JSON.parse(localStorage.getItem(DADR_KEY) || '{}'); } catch (_) { return {}; } }
  function getData(id) {
    const d = allData()[String(id)];
    return d || { dispute: null, messages: [], evidence: [], proposals: [], arbitration: null, auditLog: [], pendingResolution: null };
  }
  function save(id, data) {
    try { const all = allData(); all[String(id)] = data; localStorage.setItem(DADR_KEY, JSON.stringify(all)); return true; }
    catch (_) { toast('Storage limit reached — try smaller attachments.', 'error'); return false; }
  }
  function audit(id, action, detail) {
    const d = getData(id); d.auditLog = d.auditLog || [];
    d.auditLog.push({ ts: Date.now(), wallet: wallet(), role: roleOf(getContract(id), wallet()).key, action, detail: detail || '' });
    save(id, d);
  }
  // Dispute record (auto-seeds from the OTC on-chain dispute state)
  function getDispute(id) {
    const d = getData(id);
    if (d.dispute) return d.dispute;
    const c = getContract(id);
    if (c && (c.status === 'IN_DISPUTE' || c.status === 'DISPUTED')) {
      d.dispute = { status: 'open', reason: c.disputeReason || '', openedBy: null, openedAt: c.updatedAt || Date.now() };
      save(id, d); return d.dispute;
    }
    if (c && (c.status === 'RELEASED' || c.status === 'CANCELLED' || c.status === 'COMPLETED') && d.dispute === null) {
      return null;
    }
    return d.dispute;
  }
  function setDispute(id, patch) {
    const d = getData(id); d.dispute = Object.assign({}, d.dispute || {}, patch); save(id, d);
  }

  // ── Roles / access ──────────────────────────────────────────────────────────
  function roleOf(c, w) {
    const lw = (w || '').toLowerCase();
    if (!c || !lw) return { key: 'observer', label: 'Observer', color: '#8b93a7', bg: '139,147,167' };
    if (c.buyer && c.buyer.toLowerCase() === lw)   return { key: 'buyer',  label: 'Buyer',  color: '#60b4ff', bg: '96,180,255' };
    if (c.seller && c.seller.toLowerCase() === lw) return { key: 'seller', label: 'Seller', color: '#34d399', bg: '52,211,153' };
    const arb = arbAddr(c.contractId);
    if (arb && arb.toLowerCase() === lw)           return { key: 'arbitrator', label: 'Arbitrator', color: '#a78bfa', bg: '167,139,250' };
    return { key: 'observer', label: 'Observer', color: '#8b93a7', bg: '139,147,167' };
  }
  function arbAddr(id) {
    const a = getData(id).arbitration;
    if (a && a.arbitrator && a.arbitrator.type === 'wallet') return a.arbitrator.value || null;
    return null;
  }
  function canAccess(c) { const r = roleOf(c, wallet()); return r.key === 'buyer' || r.key === 'seller' || r.key === 'arbitrator'; }

  // ── Phases ────────────────────────────────────────────────────────────────
  const PHASES = {
    negotiation: { label: 'Negotiation',       dot: '#34d399', bg: '52,211,153',  icon: 'fa-comments' },
    awaiting:    { label: 'Awaiting Response', dot: '#fbbf24', bg: '251,191,36',  icon: 'fa-hourglass-half' },
    mediation:   { label: 'In Mediation',      dot: '#38bdf8', bg: '56,189,248',  icon: 'fa-people-arrows' },
    arbitration: { label: 'Arbitration',       dot: '#a78bfa', bg: '167,139,250', icon: 'fa-gavel' },
    resolved:    { label: 'Resolved',          dot: '#f87171', bg: '248,113,113', icon: 'fa-flag-checkered' },
  };
  function phaseOf(id) {
    const dsp = getDispute(id);
    const c = getContract(id);
    if ((dsp && dsp.status === 'resolved') || (c && ['RELEASED', 'CANCELLED', 'COMPLETED'].includes(c.status))) return 'resolved';
    const d = getData(id);
    if (d.arbitration && d.arbitration.started) return 'arbitration';
    if (d.arbitration && d.arbitration.requested) return 'mediation';
    if ((d.proposals || []).some(p => p.status === 'pending')) return 'awaiting';
    return 'negotiation';
  }

  // ── Time / format ────────────────────────────────────────────────────────
  function fmtDateTime(ts) { try { return new Date(Number(ts)).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }); } catch (_) { return '—'; } }
  function fmtTime(ts) { try { return new Date(Number(ts)).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }); } catch (_) { return '—'; } }
  function fmtDate(ts) { try { return new Date(Number(ts)).toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' }); } catch (_) { return '—'; } }
  function durationSince(ms) {
    if (!ms) return '—';
    let s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    const d = Math.floor(s / 86400); s -= d * 86400; const h = Math.floor(s / 3600); s -= h * 3600; const m = Math.floor(s / 60);
    if (d > 0) return d + 'd ' + h + 'h'; if (h > 0) return h + 'h ' + m + 'm'; return m + 'm';
  }
  function durationBetween(a, b) {
    let s = Math.max(0, Math.floor((b - a) / 1000));
    const d = Math.floor(s / 86400); s -= d * 86400; const h = Math.floor(s / 3600); s -= h * 3600; const m = Math.floor(s / 60);
    return (d > 0 ? d + 'd ' : '') + (h > 0 ? h + 'h ' : '') + m + 'm';
  }
  function priorityOf(openedAt, resolved) {
    if (resolved) return { label: 'Resolved', color: '#8b93a7', bg: '139,147,167' };
    const ageH = openedAt ? (Date.now() - openedAt) / 3600000 : 0;
    if (ageH >= 48) return { label: 'High Priority', color: '#f87171', bg: '248,113,113' };
    if (ageH >= 24) return { label: 'Medium Priority', color: '#fbbf24', bg: '251,191,36' };
    return { label: 'Standard', color: '#34d399', bg: '52,211,153' };
  }

  // ── Files ─────────────────────────────────────────────────────────────────
  function fileKind(mime, name) {
    const m = (mime || '').toLowerCase(); const n = (name || '').toLowerCase();
    if (m.startsWith('image/')) return 'image';
    if (m === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
    if (m.startsWith('video/')) return 'video';
    if (m.includes('zip') || n.endsWith('.zip') || n.endsWith('.rar') || n.endsWith('.7z')) return 'zip';
    return 'doc';
  }
  function kindIcon(k) { return k === 'image' ? 'fa-image' : k === 'pdf' ? 'fa-file-pdf' : k === 'video' ? 'fa-file-video' : k === 'zip' ? 'fa-file-archive' : 'fa-file-lines'; }
  function humanSize(b) { b = Number(b) || 0; if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(0) + ' KB'; return (b / 1048576).toFixed(1) + ' MB'; }
  function readFile(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = e => resolve({ name: file.name, url: e.target.result, size: file.size, mimeType: file.type, kind: fileKind(file.type, file.name) });
      r.onerror = reject; r.readAsDataURL(file);
    });
  }

  // ── Badges ────────────────────────────────────────────────────────────────
  function badge(label, color, bg, icon) {
    return '<span class="drc-badge" style="color:' + color + ';background:rgba(' + bg + ',0.12);border-color:rgba(' + bg + ',0.35);">' +
      (icon ? '<i class="fas ' + icon + '"></i>' : '') + esc(label) + '</span>';
  }
  function roleBadge(rkey) {
    const map = {
      buyer: { label: 'Buyer', color: '#60b4ff', bg: '96,180,255', icon: 'fa-user' },
      seller: { label: 'Seller', color: '#34d399', bg: '52,211,153', icon: 'fa-store' },
      arbitrator: { label: 'Arbitrator', color: '#a78bfa', bg: '167,139,250', icon: 'fa-scale-balanced' },
      system: { label: 'System', color: '#8b93a7', bg: '139,147,167', icon: 'fa-robot' },
      observer: { label: 'Observer', color: '#8b93a7', bg: '139,147,167', icon: 'fa-eye' },
    };
    const r = map[rkey] || map.system;
    return badge(r.label, r.color, r.bg, r.icon);
  }

  // ── Styles (self-contained; reuses drc-* class names) ───────────────────────
  function injectStyles() {
    if (document.getElementById('da-drc-styles')) return;
    const s = document.createElement('style');
    s.id = 'da-drc-styles';
    s.textContent = `
    #da-drc-overlay{position:fixed;top:0;right:0;bottom:0;left:var(--sidebar-w,0px);z-index:9990;
      display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(2,4,12,0.82);
      backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);animation:drcFade .18s ease;}
    @keyframes drcFade{from{opacity:0}to{opacity:1}}
    @keyframes drcSlideUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
    #da-drc-shell{width:100%;max-width:1120px;height:92vh;display:flex;flex-direction:column;
      background:radial-gradient(120% 80% at 0% 0%,rgba(99,102,241,0.06),transparent 60%),#0a0c18;
      border:1px solid rgba(129,140,248,0.20);border-radius:20px;overflow:hidden;
      box-shadow:0 24px 80px rgba(0,0,0,0.55),0 0 0 1px rgba(129,140,248,0.05);animation:drcSlideUp .22s ease;}
    .drc-badge{display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:700;letter-spacing:.02em;
      padding:2px 9px;border-radius:999px;border:1px solid;white-space:nowrap;}
    .drc-head{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid rgba(129,140,248,0.12);background:rgba(10,14,28,0.9);flex-shrink:0;}
    .drc-x{width:32px;height:32px;border-radius:9px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.10);color:#9aa7c4;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .18s;}
    .drc-x:hover{background:rgba(239,68,68,0.14);border-color:rgba(239,68,68,0.35);color:#f87171;}
    .drc-body{flex:1;display:grid;grid-template-columns:340px 1fr;min-height:0;}
    .drc-side{border-right:1px solid rgba(129,140,248,0.10);overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:12px;background:rgba(9,12,24,0.55);}
    .drc-main{display:flex;flex-direction:column;min-height:0;}
    .drc-panel{background:rgba(129,140,248,0.04);border:1px solid rgba(129,140,248,0.13);border-radius:14px;padding:13px 14px;}
    .drc-panel h4{font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#7c83ad;margin:0 0 9px;display:flex;align-items:center;gap:6px;}
    .drc-row{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11.5px;margin-bottom:6px;}
    .drc-row .k{color:#7c83ad;} .drc-row .v{color:#dde2f0;font-weight:600;text-align:right;}
    .drc-tabs{display:flex;gap:4px;padding:10px 12px 0;flex-shrink:0;flex-wrap:wrap;}
    .drc-tab{flex:1;min-width:96px;padding:9px 8px;border-radius:10px 10px 0 0;font-size:12px;font-weight:700;cursor:pointer;border:1px solid transparent;color:#7b8eb8;background:transparent;transition:all .16s;display:flex;align-items:center;justify-content:center;gap:6px;position:relative;}
    .drc-tab:hover{color:#c9d3e7;background:rgba(129,140,248,0.06);}
    .drc-tab.active{color:#fff;background:linear-gradient(135deg,#4f46e5,#7c3aed);box-shadow:0 4px 14px rgba(99,102,241,0.28);}
    .drc-tab .pill{position:absolute;top:3px;right:6px;font-size:8px;font-weight:800;background:#ef4444;color:#fff;min-width:15px;height:15px;padding:0 4px;border-radius:999px;display:flex;align-items:center;justify-content:center;}
    .drc-tabwrap{flex:1;min-height:0;display:flex;flex-direction:column;border-top:1px solid rgba(129,140,248,0.12);}
    .drc-scroll{flex:1;overflow-y:auto;padding:14px;}
    .drc-msg{display:flex;gap:9px;margin-bottom:14px;animation:drcSlideUp .2s ease;}
    .drc-msg.me{flex-direction:row-reverse;}
    .drc-av{width:34px;height:34px;border-radius:10px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;color:#fff;}
    .drc-bub{max-width:74%;border-radius:14px;padding:9px 12px;font-size:12.5px;line-height:1.5;color:#e6ecfb;background:rgba(255,255,255,0.045);border:1px solid rgba(255,255,255,0.07);}
    .drc-msg.me .drc-bub{background:rgba(129,140,248,0.12);border-color:rgba(129,140,248,0.24);}
    .drc-meta{display:flex;align-items:center;gap:7px;margin-bottom:3px;font-size:10px;}
    .drc-att{display:flex;align-items:center;gap:8px;margin-top:7px;padding:7px 9px;border-radius:9px;cursor:pointer;background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.08);transition:all .16s;}
    .drc-att:hover{border-color:rgba(129,140,248,0.4);background:rgba(129,140,248,0.08);}
    .drc-composer{flex-shrink:0;border-top:1px solid rgba(129,140,248,0.12);padding:11px 12px;background:rgba(9,12,24,0.7);}
    .drc-input{width:100%;background:rgba(255,255,255,0.04);border:1px solid rgba(129,140,248,0.18);border-radius:12px;padding:10px 12px;color:#e6ecfb;font-size:12.5px;font-family:inherit;resize:none;outline:none;transition:border-color .18s,box-shadow .2s;}
    .drc-input:focus{border-color:rgba(99,102,241,0.6);box-shadow:0 0 0 1px rgba(99,102,241,0.2),0 0 14px rgba(99,102,241,0.16);}
    .drc-btn{border:none;border-radius:11px;padding:9px 14px;font-size:12px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;transition:transform .14s,filter .18s,box-shadow .2s;}
    .drc-btn:hover{filter:brightness(1.08);} .drc-btn:active{transform:scale(.97);} .drc-btn:disabled{opacity:.4;cursor:not-allowed;}
    .drc-btn-primary{background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;box-shadow:0 6px 18px rgba(80,50,200,0.3);}
    .drc-btn-ghost{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.10);color:#9aa7c4;}
    .drc-btn-green{background:rgba(52,211,153,0.14);border:1px solid rgba(52,211,153,0.35);color:#34d399;}
    .drc-btn-red{background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.32);color:#f87171;}
    .drc-btn-amber{background:rgba(251,191,36,0.12);border:1px solid rgba(251,191,36,0.32);color:#fbbf24;}
    .drc-btn-purple{background:rgba(167,139,250,0.12);border:1px solid rgba(167,139,250,0.34);color:#a78bfa;}
    .drc-chip{padding:7px 10px;border-radius:10px;font-size:11px;font-weight:700;cursor:pointer;border:1px solid rgba(129,140,248,0.18);background:rgba(129,140,248,0.06);color:#a5b0dd;transition:all .16s;}
    .drc-chip:hover{border-color:rgba(129,140,248,0.5);color:#dde2f0;background:rgba(129,140,248,0.12);}
    .drc-chip.sel{background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;border-color:transparent;}
    .drc-tl{position:relative;padding-left:22px;}
    .drc-tl::before{content:'';position:absolute;left:6px;top:4px;bottom:4px;width:2px;background:rgba(129,140,248,0.16);}
    .drc-tl-item{position:relative;margin-bottom:12px;animation:drcSlideUp .3s ease;}
    .drc-tl-dot{position:absolute;left:-22px;top:2px;width:14px;height:14px;border-radius:50%;border:2px solid #0a0c18;display:flex;align-items:center;justify-content:center;font-size:6px;color:#fff;}
    .drc-prop{border:1px solid rgba(129,140,248,0.14);border-radius:14px;padding:13px;margin-bottom:12px;background:rgba(129,140,248,0.03);animation:drcSlideUp .22s ease;}
    .drc-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:44px 20px;text-align:center;color:#5b6a8c;}
    .drc-empty i{font-size:30px;color:rgba(129,140,248,0.35);}
    .drc-progress{height:4px;border-radius:4px;background:rgba(129,140,248,0.12);overflow:hidden;margin-top:6px;}
    .drc-progress>div{height:100%;background:linear-gradient(90deg,#4f46e5,#7c3aed);width:0;transition:width .25s;}
    @media (max-width:820px){#da-drc-shell{height:96vh;max-width:100%;}.drc-body{grid-template-columns:1fr;}.drc-side{border-right:none;border-bottom:1px solid rgba(129,140,248,0.10);max-height:38vh;}.drc-bub{max-width:82%;}}
    @media (prefers-reduced-motion:reduce){#da-drc-overlay,#da-drc-shell,.drc-msg,.drc-tl-item,.drc-prop{animation:none!important;}}
    `;
    document.head.appendChild(s);
  }

  // ── Open / close ────────────────────────────────────────────────────────────
  window.daDrcOpen = function (contractId) {
    injectStyles();
    const id = contractId;
    const c = getContract(id);
    if (!c) { toast('Agreement data not available on this device.', 'error'); return; }
    if (!canAccess(c)) { toast('Only the Buyer, Seller or assigned Arbitrator can access this dispute.', 'error'); return; }

    currentId = id; activeTab = 'messages'; markRead(id);

    document.getElementById('da-drc-overlay')?.remove();
    const ov = document.createElement('div');
    ov.id = 'da-drc-overlay';
    ov.innerHTML = '<div id="da-drc-shell"></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) closeCenter(); });
    ov.addEventListener('click', onClick);
    ov.addEventListener('change', onChange);
    ov.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeCenter();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && document.activeElement?.id === 'da-msg-input') sendMessage();
    });
    render();
    clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (document.getElementById('da-drc-overlay')) softRefresh(); else clearInterval(pollTimer); }, 4000);
  };
  function closeCenter() { clearInterval(pollTimer); document.getElementById('da-drc-overlay')?.remove(); currentId = null; }

  function markRead(id) {
    const d = getData(id); const w = (wallet() || '').toLowerCase(); if (!w) return;
    let changed = false;
    (d.messages || []).forEach(m => { if ((m.wallet || '').toLowerCase() !== w) { m.readBy = m.readBy || {}; if (!m.readBy[w]) { m.readBy[w] = true; changed = true; } } });
    if (changed) save(id, d);
  }
  function softRefresh() {
    const id = currentId; if (id == null) return;
    const d = getData(id); const dsp = getDispute(id); const c = getContract(id);
    const sig = JSON.stringify([(d.messages || []).length, (d.evidence || []).length, (d.proposals || []).map(p => p.status), d.arbitration, dsp && dsp.status, c && c.status]);
    if (sig !== _lastSig) { _lastSig = sig; markRead(id); render(); }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════════════════
  function render() {
    const shell = document.getElementById('da-drc-shell'); if (!shell) return;
    const id = currentId; const c = getContract(id); const dsp = getDispute(id) || {}; const d = getData(id);
    const c2 = getContract(id);
    const resolved = dsp.status === 'resolved' || (c2 && ['RELEASED', 'CANCELLED', 'COMPLETED'].includes(c2.status));
    const ph = PHASES[phaseOf(id)];
    const me = roleOf(c, wallet());
    const unread = unreadCount(id);
    _lastSig = JSON.stringify([(d.messages || []).length, (d.evidence || []).length, (d.proposals || []).map(p => p.status), d.arbitration, dsp && dsp.status, c && c.status]);

    // No dispute yet → show "Open Dispute" starter
    if (!getData(id).dispute && !(c && ['IN_DISPUTE', 'DISPUTED', 'RELEASED', 'CANCELLED', 'COMPLETED'].includes(c.status))) {
      shell.innerHTML = headerHTML(c, {}, ph, false) + openStarterHTML(id, c, me);
      return;
    }

    shell.innerHTML =
      headerHTML(c, dsp, ph, resolved) +
      '<div class="drc-body"><div class="drc-side">' +
        statusHTML(id, c, dsp, ph, resolved) +
        agreementHTML(c, dsp) +
        arbitrationHTML(id, c, d, me, resolved) +
        resolutionHTML(id, c, dsp, d, me, resolved) +
        timelineHTML(id, c, dsp, d) +
        auditHTML(d) +
      '</div><div class="drc-main">' +
        '<div class="drc-tabs">' +
          tabBtn('messages', 'Messages', 'fa-comments', unread) +
          tabBtn('evidence', 'Evidence', 'fa-paperclip', 0) +
          tabBtn('proposals', 'Proposals', 'fa-handshake', pendingForMe(id, me)) +
        '</div><div class="drc-tabwrap">' + tabContent(id, c, dsp, d, me, resolved) + '</div>' +
      '</div></div>';

    if (activeTab === 'messages') {
      const sc = document.getElementById('da-msg-scroll'); if (sc) sc.scrollTop = sc.scrollHeight;
      const inp = document.getElementById('da-msg-input'); if (inp && !resolved && me.key !== 'observer') setTimeout(() => inp.focus(), 30);
    }
  }
  function tabBtn(key, label, icon, count) {
    return '<button class="drc-tab ' + (activeTab === key ? 'active' : '') + '" data-act="tab" data-tab="' + key + '"><i class="fas ' + icon + '"></i>' + label + (count > 0 ? '<span class="pill">' + (count > 9 ? '9+' : count) + '</span>' : '') + '</button>';
  }

  function headerHTML(c, dsp, ph, resolved) {
    const prio = priorityOf(dsp.openedAt, resolved);
    const amount = c ? (fmtNum(c.amount) + ' ' + esc(c.asset || '')) : '0';
    return '<div class="drc-head">' +
      '<div style="width:38px;height:38px;border-radius:11px;display:flex;align-items:center;justify-content:center;background:rgba(' + ph.bg + ',0.14);border:1px solid rgba(' + ph.bg + ',0.3);flex-shrink:0;"><i class="fas fa-scale-balanced" style="color:' + ph.dot + ';font-size:16px;"></i></div>' +
      '<div style="flex:1;min-width:0;"><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
        '<span style="font-size:15px;font-weight:800;color:#eaf0ff;">Dispute Resolution</span>' +
        '<span style="font-size:11px;color:#5b6a8c;font-family:monospace;">' + esc(String(c ? c.contractId : '—')).slice(0, 20) + '</span>' +
        badge(ph.label, ph.dot, ph.bg, ph.icon) + '</div>' +
        '<div style="font-size:11px;color:#7c83ad;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Digital Agreement · Escrow ' + amount + '</div></div>' +
      badge(prio.label, prio.color, prio.bg, 'fa-flag') +
      '<button class="drc-x" data-act="close" title="Close"><i class="fas fa-times"></i></button></div>';
  }

  function openStarterHTML(id, c, me) {
    const isParty = me.key === 'buyer' || me.key === 'seller';
    return '<div class="drc-body" style="grid-template-columns:1fr;"><div class="drc-scroll" style="max-width:560px;margin:0 auto;width:100%;">' +
      '<div class="drc-panel" style="margin-top:20px;">' +
      '<h4 style="color:#f87171;"><i class="fas fa-gavel"></i>Open a Dispute</h4>' +
      '<p style="font-size:12px;color:#8aaac8;line-height:1.6;margin:0 0 14px;">Opening a dispute freezes settlement and starts a mediation workspace with messaging, evidence, settlement proposals and optional arbitration. ' + (c && c.onChain && c.escrowDealId ? 'This will also open the dispute <strong>on-chain</strong> so an arbiter can resolve it.' : 'This agreement is off-chain — the dispute is recorded locally.') + '</p>' +
      (isParty ?
        '<label style="font-size:11px;color:#8aaac8;font-weight:600;display:block;margin-bottom:6px;">Reason for dispute</label>' +
        '<textarea id="da-open-reason" class="drc-input" rows="3" placeholder="Describe the issue in detail…" style="margin-bottom:12px;"></textarea>' +
        '<button class="drc-btn drc-btn-red" data-act="openDispute" style="width:100%;"><i class="fas fa-gavel"></i>Open Dispute</button>'
        : '<div style="font-size:11px;color:#5b6a8c;">Only the Buyer or Seller can open a dispute.</div>') +
      '</div></div></div>';
  }

  function statusHTML(id, c, dsp, ph, resolved) {
    const opened = dsp.openedAt;
    const prio = priorityOf(opened, resolved);
    const slaLeft = opened ? Math.max(0, SLA_HOURS - (Date.now() - opened) / 3600000) : SLA_HOURS;
    const slaPct = Math.min(100, Math.round(((SLA_HOURS - slaLeft) / SLA_HOURS) * 100));
    const steps = ['negotiation', 'awaiting', 'mediation', 'arbitration', 'resolved'];
    const curIdx = steps.indexOf(phaseOf(id));
    return '<div class="drc-panel" style="border-color:rgba(' + ph.bg + ',0.28);background:rgba(' + ph.bg + ',0.05);">' +
      '<h4><i class="fas fa-signal"></i>Current Status</h4>' +
      '<div style="display:flex;align-items:center;gap:9px;margin-bottom:10px;"><span style="width:11px;height:11px;border-radius:50%;background:' + ph.dot + ';box-shadow:0 0 10px ' + ph.dot + ';flex-shrink:0;"></span><span style="font-size:14px;font-weight:800;color:' + ph.dot + ';">' + ph.label + '</span></div>' +
      '<div style="display:flex;gap:4px;margin-bottom:12px;">' + steps.map((sk, i) => { const p = PHASES[sk]; const done = i <= curIdx; return '<div title="' + p.label + '" style="flex:1;height:5px;border-radius:3px;background:' + (done ? p.dot : 'rgba(129,140,248,0.12)') + ';transition:all .3s;"></div>'; }).join('') + '</div>' +
      '<div class="drc-row"><span class="k">Priority</span><span class="v" style="color:' + prio.color + ';">' + prio.label + '</span></div>' +
      '<div class="drc-row"><span class="k">Opened</span><span class="v">' + (opened ? durationSince(opened) + ' ago' : '—') + '</span></div>' +
      '<div class="drc-row"><span class="k">Suggested SLA</span><span class="v">' + SLA_HOURS + 'h</span></div>' +
      (!resolved ? '<div class="drc-row" style="margin-bottom:4px;"><span class="k">SLA Progress</span><span class="v">' + slaLeft.toFixed(0) + 'h left</span></div><div class="drc-progress"><div style="width:' + slaPct + '%;' + (slaPct >= 100 ? 'background:linear-gradient(90deg,#ef4444,#b91c1c);' : '') + '"></div></div>' : '') +
      '</div>';
  }

  function agreementHTML(c, dsp) {
    if (!c) return '';
    const opener = dsp.openedBy;
    const openerRole = opener && c.buyer && opener.toLowerCase() === c.buyer.toLowerCase() ? 'Buyer' : opener && c.seller && opener.toLowerCase() === c.seller.toLowerCase() ? 'Seller' : '—';
    return '<div class="drc-panel"><h4><i class="fas fa-file-signature"></i>Agreement Details</h4>' +
      '<div class="drc-row"><span class="k">Agreement</span><span class="v" style="font-family:monospace;font-size:10px;">' + esc(String(c.contractId).slice(0, 22)) + '</span></div>' +
      '<div class="drc-row"><span class="k">Escrow Amount</span><span class="v" style="color:#60b4ff;">' + fmtNum(c.amount) + ' ' + esc(c.asset || '') + '</span></div>' +
      '<div class="drc-row"><span class="k">On-Chain Escrow</span><span class="v" style="color:' + (c.onChain && c.escrowDealId ? '#34d399' : '#8b93a7') + ';">' + (c.onChain && c.escrowDealId ? 'Yes' : 'Off-chain') + '</span></div>' +
      '<div style="height:1px;background:rgba(129,140,248,0.1);margin:8px 0;"></div>' +
      '<div class="drc-row"><span class="k"><i class="fas fa-user" style="color:#60b4ff;"></i> Buyer</span><a class="v" style="color:#60b4ff;font-family:monospace;" href="' + explorer() + '/address/' + esc(c.buyer) + '" target="_blank" rel="noopener">' + shortAddr(c.buyer) + '</a></div>' +
      '<div class="drc-row"><span class="k"><i class="fas fa-store" style="color:#34d399;"></i> Seller</span><a class="v" style="color:#34d399;font-family:monospace;" href="' + explorer() + '/address/' + esc(c.seller) + '" target="_blank" rel="noopener">' + shortAddr(c.seller) + '</a></div>' +
      '<div style="height:1px;background:rgba(129,140,248,0.1);margin:8px 0;"></div>' +
      '<div class="drc-row"><span class="k">Opened By</span><span class="v">' + openerRole + (opener ? ' · ' + shortAddr(opener) : '') + '</span></div>' +
      '<div class="drc-row"><span class="k">Opened On</span><span class="v">' + (dsp.openedAt ? fmtDate(dsp.openedAt) : '—') + '</span></div>' +
      (dsp.reason ? '<div style="margin-top:8px;padding:8px 10px;background:rgba(239,68,68,0.05);border:1px solid rgba(239,68,68,0.18);border-radius:9px;"><div style="font-size:9px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#f87171;margin-bottom:3px;">Reason</div><div style="font-size:11.5px;color:#e6ecfb;line-height:1.5;">' + esc(dsp.reason) + '</div></div>' : '') +
      '</div>';
  }

  // ── Tabs ────────────────────────────────────────────────────────────────
  function tabContent(id, c, dsp, d, me, resolved) {
    if (activeTab === 'evidence') return evidenceTab(id, d, me, resolved);
    if (activeTab === 'proposals') return proposalsTab(id, c, d, me, resolved);
    return messagesTab(id, c, d, me, resolved);
  }

  function messagesTab(id, c, d, me, resolved) {
    const msgs = d.messages || []; const myw = (wallet() || '').toLowerCase();
    const body = msgs.length ? msgs.map(m => {
      const mine = (m.wallet || '').toLowerCase() === myw;
      const rk = m.role || 'system';
      const rcolor = rk === 'buyer' ? '#60b4ff' : rk === 'seller' ? '#34d399' : rk === 'arbitrator' ? '#a78bfa' : '#8b93a7';
      const rbg = rk === 'buyer' ? '96,180,255' : rk === 'seller' ? '52,211,153' : rk === 'arbitrator' ? '167,139,250' : '139,147,167';
      const initials = rk === 'buyer' ? 'BU' : rk === 'seller' ? 'SE' : rk === 'arbitrator' ? 'AR' : 'SY';
      const readByOther = m.readBy && Object.keys(m.readBy).some(k => k !== myw);
      const atts = (m.attachments || []).map((a, ai) => '<div class="drc-att" data-act="viewFile" data-scope="msg" data-mi="' + msgs.indexOf(m) + '" data-ai="' + ai + '"><i class="fas ' + kindIcon(a.kind) + '" style="color:' + rcolor + ';"></i><span style="flex:1;font-size:11px;color:#c9d3e7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(a.name) + '</span><span style="font-size:9px;color:#7c83ad;">' + humanSize(a.size) + '</span><i class="fas fa-eye" style="color:#7c83ad;font-size:10px;"></i></div>').join('');
      return '<div class="drc-msg ' + (mine ? 'me' : '') + '"><div class="drc-av" style="background:linear-gradient(135deg,rgba(' + rbg + ',0.9),rgba(' + rbg + ',0.5));">' + initials + '</div><div style="min-width:0;">' +
        '<div class="drc-meta" style="' + (mine ? 'justify-content:flex-end;' : '') + '">' + roleBadge(rk) + '<span style="color:#7c83ad;">' + fmtTime(m.ts) + ' · ' + fmtDate(m.ts) + '</span></div>' +
        '<div class="drc-bub">' + (m.text ? esc(m.text).replace(/\n/g, '<br>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener" style="color:#60b4ff;">$1</a>') : '') + atts + '</div>' +
        (mine ? '<div style="text-align:right;font-size:9px;color:' + (readByOther ? '#34d399' : '#7c83ad') + ';margin-top:2px;"><i class="fas fa-check' + (readByOther ? '-double' : '') + '"></i> ' + (readByOther ? 'Read' : 'Sent') + '</div>' : '') +
        '</div></div>';
    }).join('') : '<div class="drc-empty"><i class="fas fa-comments"></i><div><strong style="color:#8aaac8;">No messages yet</strong><br><span style="font-size:11px;">Start the conversation to reach a consensus before releasing funds.</span></div></div>';
    const disabled = resolved || me.key === 'observer';
    return '<div class="drc-scroll" id="da-msg-scroll">' + body + '</div>' +
      (disabled ? '<div class="drc-composer" style="text-align:center;color:#5b6a8c;font-size:11px;"><i class="fas fa-lock mr-1"></i>' + (resolved ? 'This dispute is resolved — the conversation is read-only.' : 'Only dispute participants can send messages.') + '</div>'
        : '<div class="drc-composer"><div id="da-msg-atts" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;"></div>' +
          '<div style="display:flex;gap:8px;align-items:flex-end;">' +
          '<button class="drc-btn drc-btn-ghost" data-act="pickMsgFile" title="Attach file" style="padding:9px 11px;"><i class="fas fa-paperclip"></i></button>' +
          '<textarea id="da-msg-input" class="drc-input" rows="1" placeholder="Write a message…  (Ctrl/Cmd + Enter to send)" style="flex:1;max-height:120px;" oninput="this.style.height=\'auto\';this.style.height=Math.min(120,this.scrollHeight)+\'px\';"></textarea>' +
          '<button class="drc-btn drc-btn-primary" data-act="send"><i class="fas fa-paper-plane"></i>Send</button></div>' +
          '<input type="file" id="da-msg-file" multiple accept="image/*,application/pdf,video/*,.zip,.rar,.7z,.doc,.docx,.txt" style="display:none;"></div>');
  }

  function evidenceTab(id, d, me, resolved) {
    const ev = (d.evidence || []).slice().sort((a, b) => a.ts - b.ts);
    const list = ev.length ? ev.map((e, i) => '<div style="display:flex;align-items:center;gap:11px;padding:11px 12px;border:1px solid rgba(129,140,248,0.12);border-radius:12px;margin-bottom:9px;background:rgba(129,140,248,0.03);animation:drcSlideUp .2s ease;">' +
      '<div style="width:40px;height:40px;border-radius:10px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:rgba(' + (e.role === 'buyer' ? '96,180,255' : e.role === 'seller' ? '52,211,153' : '167,139,250') + ',0.14);"><i class="fas ' + kindIcon(e.kind) + '" style="color:' + (e.role === 'buyer' ? '#60b4ff' : e.role === 'seller' ? '#34d399' : '#a78bfa') + ';font-size:16px;"></i></div>' +
      '<div style="flex:1;min-width:0;"><div style="font-size:12.5px;font-weight:700;color:#e6ecfb;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(e.name) + '</div>' +
      '<div style="font-size:10px;color:#7c83ad;margin-top:2px;display:flex;gap:8px;flex-wrap:wrap;">' + roleBadge(e.role) + '<span>' + humanSize(e.size) + '</span><span>' + (e.kind || 'file').toUpperCase() + '</span><span>' + fmtDateTime(e.ts) + '</span></div></div>' +
      '<button class="drc-btn drc-btn-ghost" data-act="viewFile" data-scope="ev" data-i="' + i + '" style="padding:8px 10px;"><i class="fas fa-eye"></i></button>' +
      '<button class="drc-btn drc-btn-ghost" data-act="dlFile" data-scope="ev" data-i="' + i + '" style="padding:8px 10px;"><i class="fas fa-download"></i></button></div>').join('')
      : '<div class="drc-empty"><i class="fas fa-folder-open"></i><div><strong style="color:#8aaac8;">No evidence submitted</strong><br><span style="font-size:11px;">Upload supporting documents, screenshots, PDFs, video or ZIP archives.</span></div></div>';
    const disabled = resolved || me.key === 'observer';
    return '<div class="drc-scroll">' +
      (disabled ? '' : '<div id="da-ev-drop" data-act="pickEvFile" style="border:2px dashed rgba(129,140,248,0.3);border-radius:14px;padding:22px;text-align:center;cursor:pointer;margin-bottom:14px;"><i class="fas fa-cloud-arrow-up" style="font-size:26px;color:#818cf8;display:block;margin-bottom:8px;"></i><div style="font-size:12.5px;font-weight:700;color:#c9d3e7;">Upload Evidence</div><div style="font-size:10px;color:#5b6a8c;margin-top:3px;">Images · PDF · Video · ZIP · Documents — up to 10 MB each</div><div class="drc-progress" id="da-ev-progress" style="display:none;"><div></div></div><input type="file" id="da-ev-file" multiple accept="image/*,application/pdf,video/*,.zip,.rar,.7z,.doc,.docx,.txt,.csv,.xlsx" style="display:none;"></div>') +
      '<div style="font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#7c83ad;margin-bottom:9px;">Supporting Documents (' + ev.length + ')</div>' + list + '</div>';
  }

  const TEMPLATES = [
    { key: 'release100', label: 'Release 100%', rel: 100, ref: 0 },
    { key: 'refund100', label: 'Refund 100%', rel: 0, ref: 100 },
    { key: 'split5050', label: 'Split 50 / 50', rel: 50, ref: 50 },
    { key: 'split7030', label: 'Split 70 / 30', rel: 70, ref: 30 },
    { key: 'split9010', label: 'Split 90 / 10', rel: 90, ref: 10 },
    { key: 'custom', label: 'Custom', rel: null, ref: null },
  ];
  function proposalsTab(id, c, d, me, resolved) {
    const props = (d.proposals || []).slice().sort((a, b) => a.ts - b.ts);
    const total = c ? Number(c.amount) || 0 : 0;
    const asset = c ? (c.asset || '') : '';
    const myw = (wallet() || '').toLowerCase();
    const list = props.length ? props.map((p, i) => {
      const mine = (p.wallet || '').toLowerCase() === myw;
      const relAmt = fmtNum(total * p.rel / 100); const refAmt = fmtNum(total * p.ref / 100);
      const st = p.status;
      const stColor = st === 'accepted' ? '#34d399' : st === 'rejected' ? '#f87171' : st === 'countered' ? '#8b93a7' : '#fbbf24';
      const stBg = st === 'accepted' ? '52,211,153' : st === 'rejected' ? '248,113,113' : st === 'countered' ? '139,147,167' : '251,191,36';
      const stLabel = st === 'accepted' ? 'Accepted' : st === 'rejected' ? 'Rejected' : st === 'countered' ? 'Superseded' : 'Pending Approval';
      const canRespond = !resolved && st === 'pending' && !mine && (me.key === 'buyer' || me.key === 'seller');
      return '<div class="drc-prop" style="border-color:rgba(' + stBg + ',0.25);">' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:9px;flex-wrap:wrap;">' + roleBadge(p.role) + '<span style="font-size:10px;color:#7c83ad;">' + fmtDateTime(p.ts) + '</span>' + badge(stLabel, stColor, stBg, st === 'accepted' ? 'fa-check' : st === 'rejected' ? 'fa-times' : st === 'countered' ? 'fa-rotate' : 'fa-clock') + '</div>' +
        '<div style="display:flex;gap:9px;margin-bottom:8px;">' +
        '<div style="flex:1;padding:9px;border-radius:10px;background:rgba(52,211,153,0.06);border:1px solid rgba(52,211,153,0.18);"><div style="font-size:9px;color:#7c83ad;text-transform:uppercase;letter-spacing:.05em;">Release → Seller</div><div style="font-size:15px;font-weight:800;color:#34d399;">' + p.rel + '%</div><div style="font-size:10px;color:#8aaac8;">' + relAmt + ' ' + esc(asset) + '</div></div>' +
        '<div style="flex:1;padding:9px;border-radius:10px;background:rgba(96,180,255,0.06);border:1px solid rgba(96,180,255,0.18);"><div style="font-size:9px;color:#7c83ad;text-transform:uppercase;letter-spacing:.05em;">Refund → Buyer</div><div style="font-size:15px;font-weight:800;color:#60b4ff;">' + p.ref + '%</div><div style="font-size:10px;color:#8aaac8;">' + refAmt + ' ' + esc(asset) + '</div></div></div>' +
        (p.note ? '<div style="font-size:11.5px;color:#c9d3e7;line-height:1.5;margin-bottom:8px;padding:7px 9px;background:rgba(0,0,0,0.2);border-radius:8px;"><i class="fas fa-quote-left" style="color:#5b6a8c;font-size:9px;margin-right:5px;"></i>' + esc(p.note) + '</div>' : '') +
        (canRespond ? '<div style="display:flex;gap:7px;flex-wrap:wrap;"><button class="drc-btn drc-btn-green" data-act="acceptProp" data-i="' + i + '"><i class="fas fa-check"></i>Accept Proposal</button><button class="drc-btn drc-btn-red" data-act="rejectProp" data-i="' + i + '"><i class="fas fa-times"></i>Reject</button><button class="drc-btn drc-btn-amber" data-act="counterProp" data-i="' + i + '"><i class="fas fa-reply"></i>Send Counter Offer</button></div>'
          : (st === 'pending' && mine ? '<div style="font-size:10.5px;color:#fbbf24;"><i class="fas fa-hourglass-half mr-1"></i>Awaiting the counterparty\'s response.</div>' : '')) +
        '</div>';
    }).join('') : '<div class="drc-empty"><i class="fas fa-handshake"></i><div><strong style="color:#8aaac8;">No settlement proposals yet</strong><br><span style="font-size:11px;">Create a proposal to reach a mutual agreement.</span></div></div>';
    const canCreate = !resolved && (me.key === 'buyer' || me.key === 'seller');
    return '<div class="drc-scroll">' +
      (canCreate ? '<div class="drc-panel" style="margin-bottom:14px;"><h4><i class="fas fa-plus-circle"></i>New Settlement Proposal</h4>' +
        '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;" id="da-prop-templates">' + TEMPLATES.map(t => '<button class="drc-chip" data-act="propTpl" data-tpl="' + t.key + '">' + t.label + '</button>').join('') + '</div>' +
        '<div id="da-prop-custom" style="display:none;gap:9px;margin-bottom:10px;"><div style="display:flex;gap:9px;"><div style="flex:1;"><label style="font-size:10px;color:#7c83ad;">Release to Seller (%)</label><input type="number" id="da-prop-rel" min="0" max="100" value="50" class="drc-input" oninput="if(document.getElementById(\'da-prop-ref\'))document.getElementById(\'da-prop-ref\').value=Math.max(0,100-(+this.value||0));"></div><div style="flex:1;"><label style="font-size:10px;color:#7c83ad;">Refund to Buyer (%)</label><input type="number" id="da-prop-ref" min="0" max="100" value="50" class="drc-input" readonly></div></div></div>' +
        '<textarea id="da-prop-note" class="drc-input" rows="2" placeholder="Justification (optional) — explain the reasoning behind this settlement…" style="margin-bottom:10px;"></textarea>' +
        '<button class="drc-btn drc-btn-primary" data-act="createProp" style="width:100%;"><i class="fas fa-paper-plane"></i>Submit Proposal</button></div>' : '') +
      '<div style="font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#7c83ad;margin-bottom:9px;">Proposal History (' + props.length + ')</div>' + list + '</div>';
  }

  function arbitrationHTML(id, c, d, me, resolved) {
    const a = d.arbitration; const myKey = me.key; const isParty = myKey === 'buyer' || myKey === 'seller';
    if (!a || !a.requested) {
      return '<div class="drc-panel" style="border-color:rgba(167,139,250,0.22);"><h4 style="color:#a78bfa;"><i class="fas fa-gavel"></i>Arbitration</h4>' +
        '<p style="font-size:11px;color:#8aaac8;line-height:1.55;margin:0 0 10px;">If both parties cannot reach a consensus, either side can request consensual arbitration by a neutral third party.</p>' +
        (!resolved && isParty ? '<button class="drc-btn drc-btn-purple" data-act="reqArb" style="width:100%;"><i class="fas fa-gavel"></i>Request Arbitration</button>' : '<div style="font-size:10.5px;color:#5b6a8c;">' + (resolved ? 'Dispute already resolved.' : 'Only parties can request arbitration.') + '</div>') + '</div>';
    }
    const approvals = a.requested || {};
    const buyerOk = c && approvals[(c.buyer || '').toLowerCase()];
    const sellerOk = c && approvals[(c.seller || '').toLowerCase()];
    const arb = a.arbitrator;
    if (!a.started) {
      const iApproved = approvals[(wallet() || '').toLowerCase()];
      return '<div class="drc-panel" style="border-color:rgba(167,139,250,0.28);background:rgba(167,139,250,0.05);"><h4 style="color:#a78bfa;"><i class="fas fa-gavel"></i>Arbitration Requested</h4>' +
        '<p style="font-size:11px;color:#8aaac8;margin:0 0 10px;">Both parties must approve to begin arbitration.</p>' +
        '<div class="drc-row"><span class="k"><i class="fas fa-user" style="color:#60b4ff;"></i> Buyer</span><span class="v" style="color:' + (buyerOk ? '#34d399' : '#7c83ad') + ';"><i class="fas fa-' + (buyerOk ? 'check-circle' : 'clock') + '"></i> ' + (buyerOk ? 'Approved' : 'Pending') + '</span></div>' +
        '<div class="drc-row"><span class="k"><i class="fas fa-store" style="color:#34d399;"></i> Seller</span><span class="v" style="color:' + (sellerOk ? '#34d399' : '#7c83ad') + ';"><i class="fas fa-' + (sellerOk ? 'check-circle' : 'clock') + '"></i> ' + (sellerOk ? 'Approved' : 'Pending') + '</span></div>' +
        (!resolved && isParty && !iApproved ? '<button class="drc-btn drc-btn-purple" data-act="approveArb" style="width:100%;margin-top:8px;"><i class="fas fa-check"></i>Approve Arbitration</button>' : iApproved ? '<div style="margin-top:8px;font-size:10.5px;color:#34d399;"><i class="fas fa-check-circle mr-1"></i>You approved — awaiting the counterparty.</div>' : '') + '</div>';
    }
    return '<div class="drc-panel" style="border-color:rgba(167,139,250,0.3);background:rgba(167,139,250,0.06);"><h4 style="color:#a78bfa;"><i class="fas fa-scale-balanced"></i>Arbitration Active</h4>' +
      (arb && arb.value ?
        '<div class="drc-row"><span class="k">Assigned Arbitrator</span><span class="v" style="color:#a78bfa;">' + (arb.type === 'wallet' ? 'Wallet' : 'User') + '</span></div>' +
        '<div style="font-size:11px;color:#c9d3e7;font-family:monospace;word-break:break-all;padding:7px 9px;background:rgba(0,0,0,0.2);border-radius:8px;margin-bottom:8px;">' + esc(arb.name || arb.value) + '</div>' +
        (myKey === 'arbitrator' ? '<div style="font-size:10.5px;color:#34d399;margin-bottom:8px;"><i class="fas fa-user-check mr-1"></i>You are the assigned arbitrator. Use the panel below to issue a decision.</div>' : '') +
        '<button class="drc-btn drc-btn-ghost" data-act="copyArbLink" style="width:100%;"><i class="fas fa-link"></i>Copy Arbitrator Access Link</button>'
        : '<p style="font-size:11px;color:#8aaac8;margin:0 0 10px;">Appoint a neutral third-party arbitrator (wallet address or registered user).</p>' +
          (!resolved && isParty ? '<input type="text" id="da-arb-value" class="drc-input" placeholder="0x… wallet address or username" style="margin-bottom:8px;"><button class="drc-btn drc-btn-purple" data-act="appointArb" style="width:100%;"><i class="fas fa-user-plus"></i>Appoint Arbitrator</button>' : '')) +
      '</div>' +
      (myKey === 'arbitrator' && arb && arb.value && !resolved ? arbitratorPanel() : '');
  }
  function arbitratorPanel() {
    return '<div class="drc-panel" style="border-color:rgba(167,139,250,0.4);background:linear-gradient(135deg,rgba(167,139,250,0.08),rgba(124,58,237,0.05));"><h4 style="color:#a78bfa;"><i class="fas fa-user-shield"></i>Arbitrator Decision Panel</h4>' +
      '<p style="font-size:10.5px;color:#8aaac8;margin:0 0 10px;">Review the full case (messages, evidence, proposals, timeline) then issue a binding decision. On-chain execution requires the escrow arbiter authority.</p>' +
      '<textarea id="da-arb-note" class="drc-input" rows="2" placeholder="Decision rationale (recorded in the audit log)…" style="margin-bottom:9px;"></textarea>' +
      '<div style="display:flex;flex-direction:column;gap:7px;">' +
      '<button class="drc-btn drc-btn-green" data-act="arbDecide" data-outcome="seller" style="width:100%;justify-content:flex-start;"><i class="fas fa-arrow-right"></i>Release 100% to Seller</button>' +
      '<button class="drc-btn drc-btn-red" data-act="arbDecide" data-outcome="buyer" style="width:100%;justify-content:flex-start;"><i class="fas fa-undo"></i>Refund 100% to Buyer</button>' +
      '<div style="display:flex;gap:7px;align-items:center;"><input type="number" id="da-arb-rel" min="0" max="100" value="50" class="drc-input" style="width:80px;" title="Release % to seller"><span style="font-size:10px;color:#7c83ad;">% release / rest refunded</span><button class="drc-btn drc-btn-purple" data-act="arbDecide" data-outcome="split" style="flex:1;"><i class="fas fa-scale-balanced"></i>Custom Split</button></div>' +
      '<div style="display:flex;gap:7px;"><button class="drc-btn drc-btn-ghost" data-act="arbRequest" data-what="evidence" style="flex:1;"><i class="fas fa-folder-plus"></i>Request Evidence</button><button class="drc-btn drc-btn-ghost" data-act="arbRequest" data-what="messages" style="flex:1;"><i class="fas fa-comment-dots"></i>Request Info</button></div>' +
      '</div></div>';
  }

  function resolutionHTML(id, c, dsp, d, me, resolved) {
    const r = dsp.resolution;
    if (resolved && r) {
      const outLabel = r.outcome === 'seller' ? 'Funds Released to Seller' : r.outcome === 'buyer' ? 'Funds Refunded to Buyer' : 'Mutual Settlement';
      const total = c ? Number(c.amount) || 0 : 0; const asset = c ? (c.asset || '') : '';
      let releasedTxt = '—', refundedTxt = '—';
      if (r.split && typeof r.split.rel === 'number') { releasedTxt = fmtNum(total * r.split.rel / 100) + ' ' + asset + ' (' + r.split.rel + '%)'; refundedTxt = fmtNum(total * r.split.ref / 100) + ' ' + asset + ' (' + r.split.ref + '%)'; }
      else if (r.outcome === 'seller') { releasedTxt = fmtNum(total) + ' ' + asset + ' (100%)'; refundedTxt = '0 (0%)'; }
      else if (r.outcome === 'buyer') { releasedTxt = '0 (0%)'; refundedTxt = fmtNum(total) + ' ' + asset + ' (100%)'; }
      const decidedBy = r.method === 'arbitration' ? 'Arbitrator' : r.method === 'mutual_agreement' ? 'Both Parties' : 'Party';
      const totalTime = dsp.openedAt ? durationBetween(dsp.openedAt, r.resolvedAt) : '—';
      const tx = r.txHash || (c && c.resolveTxHash);
      const onchain = !!(r.onChain && tx);
      return '<div class="drc-panel" style="border-color:rgba(52,211,153,0.3);background:linear-gradient(135deg,rgba(52,211,153,0.07),rgba(16,185,129,0.03));"><h4 style="color:#34d399;"><i class="fas fa-flag-checkered"></i>Resolution Summary</h4>' +
        '<div style="text-align:center;padding:8px 0 12px;"><i class="fas fa-circle-check" style="font-size:26px;color:#34d399;"></i><div style="font-size:14px;font-weight:800;color:#e6ecfb;margin-top:6px;">' + outLabel + '</div><div style="margin-top:6px;">' + (onchain ? badge('Settled On-Chain', '#34d399', '52,211,153', 'fa-link') : badge('Recorded Settlement', '#8b93a7', '139,147,167', 'fa-file-signature')) + '</div></div>' +
        '<div class="drc-row"><span class="k">Decided By</span><span class="v">' + decidedBy + '</span></div>' +
        '<div class="drc-row"><span class="k">Released</span><span class="v" style="color:#34d399;">' + releasedTxt + '</span></div>' +
        '<div class="drc-row"><span class="k">Refunded</span><span class="v" style="color:#60b4ff;">' + refundedTxt + '</span></div>' +
        '<div class="drc-row"><span class="k">Resolved On</span><span class="v">' + fmtDateTime(r.resolvedAt) + '</span></div>' +
        '<div class="drc-row"><span class="k">Total Time</span><span class="v">' + totalTime + '</span></div>' +
        (r.note ? '<div style="margin-top:8px;padding:8px 10px;background:rgba(0,0,0,0.22);border-radius:9px;font-size:11px;color:#c9d3e7;font-style:italic;">"' + esc(r.note) + '"</div>' : '') +
        (tx ? '<a class="drc-btn drc-btn-ghost" href="' + explorer() + '/tx/' + esc(tx) + '" target="_blank" rel="noopener" style="width:100%;margin-top:9px;text-decoration:none;"><i class="fas fa-arrow-up-right-from-square"></i>View on Explorer</a>' : '') +
        '</div>';
    }
    const pr = d.pendingResolution;
    if (pr) {
      const label = pr.onchainOutcome === 'seller' ? 'Release 100% to Seller' : pr.onchainOutcome === 'buyer' ? 'Refund 100% to Buyer' : 'Agreed Settlement';
      const amArb = me.key === 'arbitrator';
      return '<div class="drc-panel" style="border-color:rgba(251,191,36,0.32);background:rgba(251,191,36,0.05);"><h4 style="color:#fbbf24;"><i class="fas fa-hourglass-half"></i>Settlement Pending Execution</h4>' +
        '<div style="font-size:12px;color:#e6ecfb;font-weight:700;margin-bottom:6px;">' + label + '</div>' +
        '<p style="font-size:10.5px;color:#8aaac8;line-height:1.5;margin:0 0 10px;">The parties agreed on this outcome. The on-chain escrow settlement must be executed by the <strong style="color:#a78bfa;">Arbiter</strong> authority.</p>' +
        (pr.note ? '<div style="font-size:10.5px;color:#c9d3e7;font-style:italic;margin-bottom:10px;">"' + esc(pr.note) + '"</div>' : '') +
        '<button class="drc-btn drc-btn-primary" data-act="execPending" style="width:100%;"><i class="fas fa-arrow-up-from-bracket"></i>Execute Settlement On-Chain</button>' +
        (amArb ? '' : '<div style="font-size:10px;color:#7c83ad;margin-top:6px;text-align:center;">Requires escrow arbiter authority.</div>') + '</div>';
    }
    if (me.key === 'observer') return '';
    const onchainDeal = !!(c && c.onChain && c.escrowDealId);
    const isDisputedOnChain = c && (c.status === 'IN_DISPUTE' || c.status === 'DISPUTED');
    return '<div class="drc-panel" style="border-color:rgba(251,191,36,0.22);"><h4 style="color:#fbbf24;"><i class="fas fa-flag-checkered"></i>Finalize Dispute</h4>' +
      '<p style="font-size:10.5px;color:#8aaac8;line-height:1.5;margin:0 0 10px;">Settlement is executed on-chain via the escrow arbiter. Reaching a mutual agreement or an accepted proposal is recommended first.</p>' +
      (onchainDeal && !isDisputedOnChain ? '<button class="drc-btn drc-btn-red" data-act="openOnChain" style="width:100%;margin-bottom:8px;"><i class="fas fa-gavel"></i>Open Dispute On-Chain</button>' : '') +
      '<div style="display:flex;flex-direction:column;gap:7px;">' +
      '<button class="drc-btn drc-btn-green" data-act="finalize" data-outcome="seller" style="width:100%;justify-content:flex-start;"><i class="fas fa-arrow-right"></i>Release Funds → Seller</button>' +
      '<button class="drc-btn drc-btn-red" data-act="finalize" data-outcome="buyer" style="width:100%;justify-content:flex-start;"><i class="fas fa-undo"></i>Refund → Buyer</button>' +
      '</div><div style="height:1px;background:rgba(255,255,255,0.06);margin:10px 0;"></div>' +
      '<button class="drc-btn drc-btn-amber" data-act="mutualAgree" style="width:100%;"><i class="fas fa-handshake"></i>Approve Mutual Agreement</button>' + mutualState(id, c) + '</div>';
  }
  function mutualState(id, c) {
    const dsp = getDispute(id) || {}; const ap = dsp.mutualApproval || {}; if (!c) return '';
    const buyerOk = ap[(c.buyer || '').toLowerCase()]; const sellerOk = ap[(c.seller || '').toLowerCase()];
    if (!buyerOk && !sellerOk) return '';
    return '<div style="margin-top:8px;font-size:10px;color:#8aaac8;display:flex;gap:12px;"><span style="color:' + (buyerOk ? '#34d399' : '#7c83ad') + ';"><i class="fas fa-' + (buyerOk ? 'check-circle' : 'clock') + '"></i> Buyer</span><span style="color:' + (sellerOk ? '#34d399' : '#7c83ad') + ';"><i class="fas fa-' + (sellerOk ? 'check-circle' : 'clock') + '"></i> Seller</span></div>';
  }

  function timelineHTML(id, c, dsp, d) {
    const ev = [];
    const created = c && (c.createdAt || c.timestamp || c.savedAt);
    if (created) ev.push({ ts: Number(created), icon: 'fa-file-signature', color: '#818cf8', title: 'Agreement created' });
    if (c && ['FUNDED', 'AWAITING_PROOF', 'READY_TO_SETTLE', 'IN_DISPUTE', 'RELEASED', 'COMPLETED'].includes(c.status)) ev.push({ ts: (Number(created) || Date.now()) + 1, icon: 'fa-vault', color: '#2dd4bf', title: 'Escrow funded' });
    if (dsp && dsp.openedAt) ev.push({ ts: dsp.openedAt, icon: 'fa-gavel', color: '#f87171', title: 'Dispute opened' });
    (d.auditLog || []).forEach(a => { const m = auditToTimeline(a); if (m) ev.push({ ts: a.ts, icon: m.icon, color: m.color, title: m.title }); });
    if (dsp && dsp.resolution) ev.push({ ts: dsp.resolution.resolvedAt, icon: 'fa-circle-check', color: '#34d399', title: 'Dispute resolved' });
    ev.sort((a, b) => a.ts - b.ts);
    return '<div class="drc-panel"><h4><i class="fas fa-timeline"></i>Activity Timeline</h4><div class="drc-tl">' +
      (ev.length ? ev.map(e => '<div class="drc-tl-item"><span class="drc-tl-dot" style="background:' + e.color + ';box-shadow:0 0 8px ' + e.color + ';"><i class="fas ' + e.icon + '"></i></span><div style="font-size:11.5px;color:#dde2f0;font-weight:600;">' + esc(e.title) + '</div><div style="font-size:9.5px;color:#7c83ad;">' + fmtDateTime(e.ts) + '</div></div>').join('') : '<div style="font-size:11px;color:#5b6a8c;">No activity recorded yet.</div>') +
      '</div></div>';
  }
  function auditToTimeline(a) {
    switch (a.action) {
      case 'message': return { icon: 'fa-comment', color: '#60b4ff', title: 'New message sent' };
      case 'evidence': return { icon: 'fa-paperclip', color: '#38bdf8', title: 'Evidence submitted' };
      case 'proposal': return { icon: 'fa-handshake', color: '#fbbf24', title: 'Settlement proposal created' };
      case 'proposal_accept': return { icon: 'fa-check', color: '#34d399', title: 'Proposal accepted' };
      case 'proposal_reject': return { icon: 'fa-times', color: '#f87171', title: 'Proposal rejected' };
      case 'counter': return { icon: 'fa-rotate', color: '#fbbf24', title: 'Counter offer sent' };
      case 'arb_request': return { icon: 'fa-gavel', color: '#a78bfa', title: 'Arbitration requested' };
      case 'arb_approve': return { icon: 'fa-check-double', color: '#a78bfa', title: 'Arbitration approved' };
      case 'arb_start': return { icon: 'fa-scale-balanced', color: '#a78bfa', title: 'Arbitration started' };
      case 'arb_appoint': return { icon: 'fa-user-plus', color: '#a78bfa', title: 'Arbitrator appointed' };
      case 'arb_decision': return { icon: 'fa-gavel', color: '#a78bfa', title: 'Arbitrator issued a decision' };
      case 'arb_request_more': return { icon: 'fa-circle-question', color: '#a78bfa', title: 'Arbitrator requested more information' };
      case 'dispute_open': return { icon: 'fa-gavel', color: '#f87171', title: 'Dispute opened' };
      default: return null;
    }
  }

  function auditHTML(d) {
    const log = (d.auditLog || []).slice().reverse().slice(0, 40);
    if (!log.length) return '';
    return '<div class="drc-panel"><h4><i class="fas fa-clipboard-list"></i>Audit Log</h4><div style="max-height:180px;overflow-y:auto;">' +
      log.map(a => '<div style="font-size:10px;color:#8aaac8;padding:5px 0;border-bottom:1px solid rgba(129,140,248,0.07);display:flex;justify-content:space-between;gap:8px;"><span><i class="fas fa-circle" style="font-size:5px;color:#818cf8;margin-right:5px;vertical-align:middle;"></i>' + esc(prettyAction(a.action)) + ' · <span style="color:#7c83ad;">' + (a.role || '—') + '</span></span><span style="color:#5b6a8c;white-space:nowrap;">' + fmtTime(a.ts) + '</span></div>').join('') +
      '</div></div>';
  }
  function prettyAction(a) {
    return ({ message: 'Message sent', evidence: 'Evidence submitted', proposal: 'Proposal created', proposal_accept: 'Proposal accepted', proposal_reject: 'Proposal rejected', counter: 'Counter offer', arb_request: 'Arbitration requested', arb_approve: 'Arbitration approved', arb_start: 'Arbitration started', arb_appoint: 'Arbitrator appointed', arb_decision: 'Arbitrator decision', arb_request_more: 'Info requested', finalize: 'Dispute finalized', mutual: 'Mutual agreement', dispute_open: 'Dispute opened' })[a] || a;
  }

  function unreadCount(id) { const d = getData(id); const w = (wallet() || '').toLowerCase(); if (!w) return 0; return (d.messages || []).filter(m => (m.wallet || '').toLowerCase() !== w && !(m.readBy && m.readBy[w])).length; }
  function pendingForMe(id, me) { if (me.key !== 'buyer' && me.key !== 'seller') return 0; const w = (wallet() || '').toLowerCase(); return (getData(id).proposals || []).filter(p => p.status === 'pending' && (p.wallet || '').toLowerCase() !== w).length; }

  // ══════════════════════════════════════════════════════════════════════════
  // EVENTS
  // ══════════════════════════════════════════════════════════════════════════
  function onClick(e) {
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const act = btn.getAttribute('data-act'); const id = currentId;
    switch (act) {
      case 'close': closeCenter(); break;
      case 'tab': activeTab = btn.getAttribute('data-tab'); pendingMsgFiles = []; markRead(id); render(); break;
      case 'openDispute': openDispute(); break;
      case 'openOnChain': openOnChainDispute(id); break;
      case 'send': sendMessage(); break;
      case 'pickMsgFile': document.getElementById('da-msg-file')?.click(); break;
      case 'pickEvFile': document.getElementById('da-ev-file')?.click(); break;
      case 'viewFile': viewFile(btn); break;
      case 'dlFile': dlFile(btn); break;
      case 'propTpl': selectTemplate(btn); break;
      case 'createProp': createProposal(); break;
      case 'acceptProp': respondProposal(+btn.getAttribute('data-i'), 'accept'); break;
      case 'rejectProp': respondProposal(+btn.getAttribute('data-i'), 'reject'); break;
      case 'counterProp': respondProposal(+btn.getAttribute('data-i'), 'counter'); break;
      case 'reqArb': requestArbitration(); break;
      case 'approveArb': approveArbitration(); break;
      case 'appointArb': appointArbitrator(); break;
      case 'copyArbLink': copyArbLink(); break;
      case 'arbDecide': arbitratorDecide(btn.getAttribute('data-outcome')); break;
      case 'arbRequest': arbitratorRequestMore(btn.getAttribute('data-what')); break;
      case 'finalize': finalize(btn.getAttribute('data-outcome')); break;
      case 'execPending': executePending(id); break;
      case 'mutualAgree': mutualAgree(); break;
    }
  }
  function onChange(e) {
    if (e.target.id === 'da-msg-file') queueMsgFiles(e.target.files);
    else if (e.target.id === 'da-ev-file') uploadEvidence(e.target.files);
  }

  // ── Open dispute ──────────────────────────────────────────────────────────
  async function openDispute() {
    const id = currentId; const c = getContract(id); const me = roleOf(c, wallet());
    if (me.key !== 'buyer' && me.key !== 'seller') { toast('Only the Buyer or Seller can open a dispute.', 'error'); return; }
    const reason = (document.getElementById('da-open-reason')?.value || '').trim();
    if (reason.length < 5) { toast('Please describe the reason (at least 5 characters).', 'warning'); return; }
    setDispute(id, { status: 'open', reason, openedBy: wallet(), openedAt: Date.now() });
    audit(id, 'dispute_open', reason.slice(0, 60));
    // Optionally raise on-chain for funded escrow deals
    if (c && c.onChain && c.escrowDealId && typeof window.otcRaiseDispute === 'function') {
      const disputable = ['FUNDED', 'AWAITING_PROOF', 'AWAITING_SELLER_DEPOSIT', 'READY_TO_SETTLE'].includes(c.status);
      if (disputable && confirm('Also open this dispute ON-CHAIN so an arbiter can resolve it? (Requires a wallet signature.)')) {
        try { await window.otcRaiseDispute(id, reason); } catch (err) { toast('On-chain dispute failed: ' + (err.message || err), 'error'); }
      }
    }
    toast('Dispute opened.', 'success');
    render();
  }
  async function openOnChainDispute(id) {
    const c = getContract(id);
    if (!c || !c.onChain || !c.escrowDealId) { toast('This agreement is not in on-chain escrow.', 'warning'); return; }
    if (typeof window.otcRaiseDispute !== 'function') { toast('On-chain dispute function unavailable.', 'error'); return; }
    const reason = (getDispute(id) || {}).reason || '';
    try { await window.otcRaiseDispute(id, reason); render(); } catch (err) { toast('On-chain dispute failed: ' + (err.message || err), 'error'); }
  }

  // ── Chat ────────────────────────────────────────────────────────────────
  async function queueMsgFiles(files) {
    for (const f of Array.from(files)) {
      if (f.size > MAX_FILE) { toast(f.name + ' exceeds 10 MB.', 'error'); continue; }
      if (pendingMsgFiles.length >= 4) { toast('Up to 4 attachments per message.', 'warning'); break; }
      try { pendingMsgFiles.push(await readFile(f)); } catch (_) { toast('Failed to read ' + f.name, 'error'); }
    }
    renderMsgAtts();
  }
  function renderMsgAtts() {
    const wrap = document.getElementById('da-msg-atts'); if (!wrap) return;
    wrap.innerHTML = pendingMsgFiles.map((a, i) => '<span style="display:inline-flex;align-items:center;gap:6px;padding:5px 9px;border-radius:8px;background:rgba(129,140,248,0.09);border:1px solid rgba(129,140,248,0.2);font-size:10.5px;color:#c9d3e7;"><i class="fas ' + kindIcon(a.kind) + '"></i>' + esc(a.name) + ' <span style="color:#7c83ad;">' + humanSize(a.size) + '</span><i class="fas fa-times" style="cursor:pointer;color:#f87171;" onclick="window.__daDrcRmAtt(' + i + ')"></i></span>').join('');
  }
  window.__daDrcRmAtt = function (i) { pendingMsgFiles.splice(i, 1); renderMsgAtts(); };
  function sendMessage() {
    const id = currentId; const c = getContract(id); const me = roleOf(c, wallet());
    if (me.key === 'observer') { toast('Only participants can send messages.', 'error'); return; }
    const inp = document.getElementById('da-msg-input'); const text = (inp ? inp.value : '').trim();
    if (!text && !pendingMsgFiles.length) { toast('Type a message or attach a file.', 'warning'); return; }
    const d = getData(id); d.messages = d.messages || [];
    d.messages.push({ wallet: wallet(), role: me.key, text, ts: Date.now(), attachments: pendingMsgFiles.slice(), readBy: { [(wallet() || '').toLowerCase()]: true } });
    if (!save(id, d)) return;
    audit(id, 'message', text.slice(0, 60)); pendingMsgFiles = [];
    notify('New Message', me.label + ' sent a message.'); render();
  }

  // ── Evidence ────────────────────────────────────────────────────────────
  async function uploadEvidence(files) {
    const id = currentId; const c = getContract(id); const me = roleOf(c, wallet());
    if (me.key === 'observer') { toast('Only participants can upload evidence.', 'error'); return; }
    const prog = document.getElementById('da-ev-progress'); if (prog) prog.style.display = 'block';
    const arr = Array.from(files); let done = 0;
    const d = getData(id); d.evidence = d.evidence || [];
    for (const f of arr) {
      if (f.size > MAX_FILE) { toast(f.name + ' exceeds 10 MB.', 'error'); continue; }
      try { const fo = await readFile(f); d.evidence.push(Object.assign(fo, { role: me.key, wallet: wallet(), ts: Date.now() })); } catch (_) { toast('Failed to read ' + f.name, 'error'); }
      done++; if (prog) prog.firstElementChild.style.width = Math.round((done / arr.length) * 100) + '%';
    }
    if (!save(id, d)) return;
    audit(id, 'evidence', arr.map(f => f.name).join(', ').slice(0, 60));
    notify('New Evidence Submitted', me.label + ' uploaded ' + arr.length + ' file(s).');
    setTimeout(() => render(), 250);
  }
  function getFileRef(btn) {
    const id = currentId; const d = getData(id); const scope = btn.getAttribute('data-scope');
    if (scope === 'ev') return (d.evidence || [])[+btn.getAttribute('data-i')];
    if (scope === 'msg') { const m = (d.messages || [])[+btn.getAttribute('data-mi')]; return m && (m.attachments || [])[+btn.getAttribute('data-ai')]; }
    return null;
  }
  function viewFile(btn) {
    const f = getFileRef(btn); if (!f || !f.url) { toast('File not available.', 'error'); return; }
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:9995;background:rgba(0,0,0,0.92);backdrop-filter:blur(4px);display:flex;flex-direction:column;';
    let content;
    if (f.kind === 'image') content = '<div style="flex:1;display:flex;align-items:center;justify-content:center;padding:16px;overflow:auto;"><img src="' + f.url + '" style="max-width:100%;max-height:calc(100vh - 90px);object-fit:contain;border-radius:10px;"></div>';
    else if (f.kind === 'pdf') content = '<div style="flex:1;padding:8px 16px;"><iframe src="' + f.url + '" style="width:100%;height:calc(100vh - 90px);border:none;border-radius:10px;background:#fff;"></iframe></div>';
    else if (f.kind === 'video') content = '<div style="flex:1;display:flex;align-items:center;justify-content:center;padding:16px;"><video src="' + f.url + '" controls style="max-width:100%;max-height:calc(100vh - 90px);border-radius:10px;"></video></div>';
    else content = '<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;color:#c9d3e7;"><i class="fas ' + kindIcon(f.kind) + '" style="font-size:52px;color:#818cf8;"></i><div style="font-weight:700;">' + esc(f.name) + '</div><a href="' + f.url + '" download="' + esc(f.name) + '" class="drc-btn drc-btn-primary" style="text-decoration:none;"><i class="fas fa-download"></i>Download</a></div>';
    ov.innerHTML = '<div style="display:flex;align-items:center;gap:10px;padding:13px 18px;background:rgba(10,12,24,0.95);border-bottom:1px solid rgba(129,140,248,0.15);"><div style="flex:1;min-width:0;"><div style="font-size:13px;font-weight:700;color:#e6ecfb;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(f.name) + '</div><div style="font-size:10px;color:#7c83ad;">' + (f.kind || 'file').toUpperCase() + ' · ' + humanSize(f.size) + '</div></div><a href="' + f.url + '" download="' + esc(f.name) + '" class="drc-x" style="text-decoration:none;"><i class="fas fa-download"></i></a><button class="drc-x" id="da-fv-x"><i class="fas fa-times"></i></button></div>' + content;
    ov.addEventListener('click', (e) => { if (e.target === ov || e.target.closest('#da-fv-x')) ov.remove(); });
    document.body.appendChild(ov);
  }
  function dlFile(btn) { const f = getFileRef(btn); if (!f || !f.url) { toast('File not available.', 'error'); return; } const a = document.createElement('a'); a.href = f.url; a.download = f.name || 'evidence'; a.click(); }

  // ── Proposals ─────────────────────────────────────────────────────────────
  function selectTemplate(btn) {
    const key = btn.getAttribute('data-tpl'); _tpl = TEMPLATES.find(t => t.key === key);
    document.querySelectorAll('#da-prop-templates .drc-chip').forEach(el => el.classList.remove('sel')); btn.classList.add('sel');
    const custom = document.getElementById('da-prop-custom');
    if (custom) { custom.style.display = key === 'custom' ? 'block' : 'none'; if (key !== 'custom') { const rel = document.getElementById('da-prop-rel'); const ref = document.getElementById('da-prop-ref'); if (rel) rel.value = _tpl.rel; if (ref) ref.value = _tpl.ref; } }
  }
  function createProposal() {
    const id = currentId; const c = getContract(id); const me = roleOf(c, wallet());
    if (me.key !== 'buyer' && me.key !== 'seller') { toast('Only parties can create proposals.', 'error'); return; }
    if (!_tpl) { toast('Select a proposal type first.', 'warning'); return; }
    let rel, ref;
    if (_tpl.key === 'custom') { rel = Math.min(100, Math.max(0, parseInt(document.getElementById('da-prop-rel')?.value || '0', 10))); ref = 100 - rel; }
    else { rel = _tpl.rel; ref = _tpl.ref; }
    const note = (document.getElementById('da-prop-note')?.value || '').trim();
    const d = getData(id); d.proposals = d.proposals || [];
    d.proposals.push({ wallet: wallet(), role: me.key, rel, ref, note, ts: Date.now(), status: 'pending' });
    if (!save(id, d)) return;
    audit(id, 'proposal', rel + '% release / ' + ref + '% refund'); _tpl = null;
    notify('New Settlement Proposal', me.label + ' proposed ' + rel + '% release / ' + ref + '% refund.');
    activeTab = 'proposals'; render();
  }
  async function respondProposal(idx, action) {
    const id = currentId; const c = getContract(id); const me = roleOf(c, wallet());
    const d = getData(id); const p = (d.proposals || [])[idx]; if (!p || p.status !== 'pending') return;
    if ((p.wallet || '').toLowerCase() === (wallet() || '').toLowerCase()) { toast('You cannot respond to your own proposal.', 'warning'); return; }
    if (action === 'accept') {
      if (!confirm('Accept this settlement?\n\nRelease ' + p.rel + '% to Seller · Refund ' + p.ref + '% to Buyer.\n\nThis will finalize the dispute.')) return;
      p.status = 'accepted'; p.respondedBy = wallet(); p.respondedAt = Date.now(); save(id, d);
      audit(id, 'proposal_accept', p.rel + '% / ' + p.ref + '%');
      notify('Proposal Accepted', 'Settlement of ' + p.rel + '% release / ' + p.ref + '% refund accepted.');
      const outcome = p.rel === 100 ? 'seller' : p.ref === 100 ? 'buyer' : 'mutual';
      await settle(id, outcome, { method: 'mutual_agreement', note: 'Accepted settlement: ' + p.rel + '% release / ' + p.ref + '% refund.' + (p.note ? ' — ' + p.note : ''), split: { rel: p.rel, ref: p.ref } });
    } else if (action === 'reject') {
      p.status = 'rejected'; p.respondedBy = wallet(); p.respondedAt = Date.now(); save(id, d);
      audit(id, 'proposal_reject', p.rel + '% / ' + p.ref + '%'); notify('Proposal Rejected', me.label + ' rejected the settlement proposal.'); render();
    } else if (action === 'counter') {
      p.status = 'countered'; p.respondedBy = wallet(); p.respondedAt = Date.now(); save(id, d);
      audit(id, 'counter', 'counter to ' + p.rel + '%/' + p.ref + '%'); _tpl = { key: 'custom', rel: p.ref, ref: p.rel };
      notify('Counter Offer', me.label + ' is preparing a counter offer.'); activeTab = 'proposals'; render();
      setTimeout(() => { const custom = document.getElementById('da-prop-custom'); const rel = document.getElementById('da-prop-rel'); const ref = document.getElementById('da-prop-ref'); if (custom) custom.style.display = 'block'; if (rel) rel.value = p.ref; if (ref) ref.value = p.rel; document.querySelectorAll('#da-prop-templates .drc-chip').forEach(el => { if (el.getAttribute('data-tpl') === 'custom') el.classList.add('sel'); }); document.getElementById('da-prop-note')?.focus(); }, 60);
    }
  }

  // ── Arbitration ───────────────────────────────────────────────────────────
  function requestArbitration() {
    const id = currentId; const c = getContract(id); const me = roleOf(c, wallet());
    if (me.key !== 'buyer' && me.key !== 'seller') { toast('Only parties can request arbitration.', 'error'); return; }
    const d = getData(id); d.arbitration = d.arbitration || { requested: {}, started: false, arbitrator: null };
    d.arbitration.requested = d.arbitration.requested || {}; d.arbitration.requested[(wallet() || '').toLowerCase()] = true;
    save(id, d); audit(id, 'arb_request', ''); checkArbStart(id, c); notify('Arbitration Started', me.label + ' requested arbitration.'); render();
  }
  function approveArbitration() {
    const id = currentId; const c = getContract(id); const me = roleOf(c, wallet());
    if (me.key !== 'buyer' && me.key !== 'seller') { toast('Only parties can approve arbitration.', 'error'); return; }
    const d = getData(id); d.arbitration.requested[(wallet() || '').toLowerCase()] = true; save(id, d);
    audit(id, 'arb_approve', ''); checkArbStart(id, c); render();
  }
  function checkArbStart(id, c) {
    const d = getData(id); const ap = d.arbitration.requested || {};
    if (c && ap[(c.buyer || '').toLowerCase()] && ap[(c.seller || '').toLowerCase()] && !d.arbitration.started) {
      d.arbitration.started = true; d.arbitration.startedAt = Date.now(); save(id, d); audit(id, 'arb_start', '');
      toast('Arbitration started — appoint a neutral arbitrator.', 'info');
    }
  }
  function appointArbitrator() {
    const id = currentId; const c = getContract(id); const me = roleOf(c, wallet());
    if (me.key !== 'buyer' && me.key !== 'seller') { toast('Only parties can appoint an arbitrator.', 'error'); return; }
    const val = (document.getElementById('da-arb-value')?.value || '').trim();
    if (!val) { toast('Enter a wallet address or username.', 'warning'); return; }
    const isWallet = /^0x[a-fA-F0-9]{40}$/.test(val);
    if (isWallet && c && (val.toLowerCase() === (c.buyer || '').toLowerCase() || val.toLowerCase() === (c.seller || '').toLowerCase())) { toast('The arbitrator must be a neutral third party.', 'error'); return; }
    const d = getData(id); d.arbitration.arbitrator = { type: isWallet ? 'wallet' : 'user', value: val, name: val, assignedAt: Date.now(), assignedBy: wallet() };
    save(id, d); audit(id, 'arb_appoint', isWallet ? shortAddr(val) : val);
    notify('Assigned Arbitrator', 'A ' + (isWallet ? 'wallet' : 'user') + ' arbitrator has been appointed.'); render();
  }
  function copyArbLink() {
    const id = currentId; const url = location.origin + location.pathname + '?daDispute=' + encodeURIComponent(id);
    try { navigator.clipboard.writeText(url); toast('Arbitrator access link copied to clipboard.', 'success'); } catch (_) { toast(url, 'info'); }
  }
  async function arbitratorDecide(outcome) {
    const id = currentId; const c = getContract(id); const me = roleOf(c, wallet());
    if (me.key !== 'arbitrator') { toast('Only the assigned arbitrator can decide.', 'error'); return; }
    const note = (document.getElementById('da-arb-note')?.value || '').trim();
    let split = null, out = outcome;
    if (outcome === 'split') { const rel = Math.min(100, Math.max(0, parseInt(document.getElementById('da-arb-rel')?.value || '50', 10))); split = { rel, ref: 100 - rel }; out = rel === 100 ? 'seller' : rel === 0 ? 'buyer' : 'mutual'; }
    const label = out === 'seller' ? 'Release 100% to Seller' : out === 'buyer' ? 'Refund 100% to Buyer' : 'Split ' + (split ? split.rel : '') + '%/' + (split ? split.ref : '') + '%';
    if (!confirm('Issue binding decision:\n\n' + label + '\n\nThis finalizes the dispute.')) return;
    audit(id, 'arb_decision', label); notify('Arbitration Decision', label);
    await settle(id, out, { method: 'arbitration', note: note || ('Arbitrator decision: ' + label + '.'), split });
  }
  function arbitratorRequestMore(what) {
    const id = currentId; const me = roleOf(getContract(id), wallet()); if (me.key !== 'arbitrator') return;
    const d = getData(id); d.messages = d.messages || [];
    const text = what === 'evidence' ? 'The arbitrator requests additional supporting evidence from both parties.' : 'The arbitrator requests additional information/clarification from both parties.';
    d.messages.push({ wallet: wallet(), role: 'arbitrator', text, ts: Date.now(), attachments: [], readBy: { [(wallet() || '').toLowerCase()]: true } });
    save(id, d); audit(id, 'arb_request_more', what); notify('System Notification', text); activeTab = 'messages'; render();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SETTLEMENT — routes real fund movement through existing otcResolveDispute()
  // ══════════════════════════════════════════════════════════════════════════
  function daLog(stage, obj) { try { console.log('%c[DA-DRC-TX] ' + stage, 'color:#818cf8;font-weight:bold', obj || {}); } catch (_) {} }

  async function executeOtcSettlement(id, outcome) {
    const c = getContract(id);
    const base = { wallet: wallet(), contractId: id, settlementType: outcome, amount: c && c.amount, asset: c && c.asset, dealId: c && c.escrowDealId, onChain: !!(c && c.onChain && c.escrowDealId) };
    daLog('settlement:start', base);
    if (!c) return { ok: false, error: 'contract not found' };
    if (!(c.onChain && c.escrowDealId)) { daLog('settlement:offchain', base); return { ok: false, offchain: true, reason: 'This agreement is not funded in on-chain escrow — settlement is recorded only.' }; }
    if (typeof window.otcResolveDispute !== 'function') { daLog('settlement:error', { stage: 'fn', error: 'otcResolveDispute unavailable' }); toast('OTC settlement function unavailable.', 'error'); return { ok: false, error: 'fn_unavailable' }; }
    const releaseToSeller = outcome === 'seller';
    const beforeStatus = c.status;
    try {
      daLog('settlement:invoke', { method: 'otcResolveDispute', releaseToSeller });
      await window.otcResolveDispute(id, releaseToSeller); // handles confirm + wallet + on-chain + toasts + state
    } catch (err) { daLog('settlement:exception', { reason: err && (err.message || err) }); toast('❌ Settlement failed: ' + (err && (err.message || err)), 'error'); return { ok: false, error: err && (err.message || err) }; }
    const after = getContract(id);
    const terminal = after && ['RELEASED', 'CANCELLED', 'COMPLETED'].includes(after.status);
    const ok = !!(terminal && after.status !== beforeStatus);
    daLog('settlement:result', { ok, status: after && after.status, txHash: after && after.resolveTxHash });
    if (ok) return { ok: true, onChain: true, txHash: after.resolveTxHash, status: after.status };
    return { ok: false, error: 'On-chain resolution did not complete (arbiter authority required, wrong state, or rejected).' };
  }

  async function settle(id, outcome, opts) {
    opts = opts || {};
    const c = getContract(id); const me = roleOf(c, wallet()); const split = opts.split || null;
    let onchainOutcome = outcome;
    if (outcome === 'mutual' && split) { if (split.rel === 100) onchainOutcome = 'seller'; else if (split.rel === 0) onchainOutcome = 'buyer'; }
    const onchain = !!(c && c.onChain && c.escrowDealId);
    const isFull = onchainOutcome === 'seller' || onchainOutcome === 'buyer';
    if (!onchain || !isFull) {
      daLog('settlement:recorded', { contractId: id, outcome, onchain, split, reason: !onchain ? 'off-chain agreement' : 'partial split not executable on-chain' });
      finalizeWrite(id, outcome, Object.assign({ onChain: false }, opts));
      if (onchain && split && split.rel !== 100 && split.rel !== 0) toast('Settlement recorded. Note: on-chain escrow resolves fully to one party (no partial split).', 'warning');
      return;
    }
    // On-chain full outcome — try to execute via otcResolveDispute (arbiter-gated)
    const res = await executeOtcSettlement(id, onchainOutcome);
    if (res.ok) { finalizeWrite(id, outcome, Object.assign({ onChain: true, txHash: res.txHash }, opts)); }
    else if (res.offchain) { finalizeWrite(id, outcome, Object.assign({ onChain: false }, opts)); }
    else { recordPendingResolution(id, { outcome, onchainOutcome, split, note: opts.note, method: opts.method }); }
    render();
  }
  function recordPendingResolution(id, intent) {
    const d = getData(id); d.pendingResolution = Object.assign({ ts: Date.now(), requestedBy: wallet() }, intent); save(id, d);
    audit(id, 'finalize', 'settlement pending on-chain execution');
    toast('Settlement agreed — awaiting the arbiter to execute the on-chain transfer.', 'info');
  }
  async function executePending(id) {
    const pr = getData(id).pendingResolution; if (!pr) { toast('No pending settlement found.', 'warning'); return; }
    const res = await executeOtcSettlement(id, pr.onchainOutcome);
    if (res.ok) finalizeWrite(id, pr.outcome, { onChain: true, txHash: res.txHash, method: pr.method || 'settlement', note: pr.note || '', split: pr.split });
    else if (res.offchain) finalizeWrite(id, pr.outcome, { onChain: false, method: pr.method || 'settlement', note: pr.note || '', split: pr.split });
    render();
  }
  async function finalize(outcome) {
    const id = currentId; const c = getContract(id); const me = roleOf(c, wallet());
    if (me.key !== 'buyer' && me.key !== 'seller' && me.key !== 'arbitrator') { toast('Only dispute participants can finalize.', 'error'); return; }
    const label = outcome === 'seller' ? 'Release 100% to Seller' : 'Refund 100% to Buyer';
    audit(id, 'finalize', label);
    await settle(id, outcome, { method: me.key === 'arbitrator' ? 'arbitration' : 'manual', note: 'Resolved by ' + me.label + ' decision.' });
  }
  function mutualAgree() {
    const id = currentId; const c = getContract(id); const me = roleOf(c, wallet());
    if (me.key !== 'buyer' && me.key !== 'seller') { toast('Only parties can approve.', 'error'); return; }
    const dsp = getDispute(id) || {}; const ap = dsp.mutualApproval || {}; ap[(wallet() || '').toLowerCase()] = true;
    const bothOk = c && ap[(c.buyer || '').toLowerCase()] && ap[(c.seller || '').toLowerCase()];
    if (bothOk) { setDispute(id, { mutualApproval: ap }); finalizeWrite(id, 'mutual', { method: 'mutual_agreement', note: 'Mutual agreement reached.', onChain: false }); audit(id, 'mutual', 'both parties approved'); notify('Proposal Accepted', 'Mutual agreement confirmed — dispute resolved.'); }
    else { setDispute(id, { mutualApproval: ap }); audit(id, 'mutual', 'awaiting counterparty'); toast('Approval recorded — awaiting the counterparty.', 'info'); }
    render();
  }
  function finalizeWrite(id, outcome, opts) {
    opts = opts || {};
    setDispute(id, { status: 'resolved', resolution: { outcome, note: opts.note || '', resolvedBy: wallet(), resolvedAt: Date.now(), method: opts.method || 'settlement', split: opts.split || null, onChain: !!opts.onChain, txHash: opts.txHash || null } });
    const d = getData(id); if (d.pendingResolution) { delete d.pendingResolution; save(id, d); }
    daLog('resolution:written', { contractId: id, outcome, onChain: !!opts.onChain, txHash: opts.txHash || null });
    toast(opts.onChain ? 'Dispute resolved — funds transferred on-chain.' : 'Dispute resolved.', 'success');
    refreshOtc();
  }

  function notify(title, body) { toast(title + ': ' + body, 'info'); }

  // ══════════════════════════════════════════════════════════════════════════
  // CARD BUTTON INJECTION + deep-link
  // ══════════════════════════════════════════════════════════════════════════
  function injectCardButtons() {
    const ids = new Set(loadOtc().map(c => String(c.contractId)));
    const disputableStatus = ['FUNDED', 'AWAITING_PROOF', 'AWAITING_SELLER_DEPOSIT', 'READY_TO_SETTLE', 'IN_DISPUTE', 'DISPUTED', 'RELEASED', 'CANCELLED', 'COMPLETED'];
    ['#otc-my-list', '#otc-mkt-list'].forEach(sel => {
      const root = document.querySelector(sel); if (!root) return;
      root.querySelectorAll(':scope > div').forEach(card => {
        if (card.querySelector('.da-drc-open-btn')) return;
        let cid = null;
        card.querySelectorAll('.font-mono').forEach(n => { const t = (n.textContent || '').trim(); if (ids.has(t)) cid = t; });
        if (!cid) return;
        const c = getContract(cid); if (!c) return;
        if (!disputableStatus.includes(c.status)) return;
        const disputed = c.status === 'IN_DISPUTE' || c.status === 'DISPUTED' || (getData(cid).dispute);
        const resolved = ['RELEASED', 'CANCELLED', 'COMPLETED'].includes(c.status) || ((getData(cid).dispute || {}).status === 'resolved');
        const btn = document.createElement('button');
        btn.className = 'da-drc-open-btn';
        btn.setAttribute('style', 'margin-top:10px;width:100%;padding:9px;border-radius:12px;font-size:12px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px;background:linear-gradient(135deg,rgba(79,70,229,0.18),rgba(124,58,237,0.16));border:1px solid rgba(124,58,237,0.4);color:#c4b5fd;transition:filter .16s;');
        btn.onmouseenter = () => btn.style.filter = 'brightness(1.15)';
        btn.onmouseleave = () => btn.style.filter = '';
        btn.innerHTML = '<i class="fas fa-scale-balanced"></i>' + (resolved ? 'View Resolution Center' : disputed ? 'Open Resolution Center' : 'Dispute Resolution');
        btn.addEventListener('click', (e) => { e.stopPropagation(); window.daDrcOpen(cid); });
        card.appendChild(btn);
      });
    });
  }

  function install() {
    ['otcRenderMyContracts', 'otcRenderMarketplace'].forEach(fn => {
      if (window[fn] && !window[fn]._daDrcWrapped) {
        const orig = window[fn];
        const wrapped = function () { const r = orig.apply(this, arguments); try { setTimeout(injectCardButtons, 60); } catch (_) {} return r; };
        wrapped._daDrcWrapped = true; window[fn] = wrapped;
      }
    });
    // periodic sweep (cards can render without going through the wrapped fns)
    try { setInterval(injectCardButtons, 2500); } catch (_) {}
    // deep-link ?daDispute=<id>
    try {
      const did = new URLSearchParams(location.search).get('daDispute');
      if (did) { let tries = 0; const timer = setInterval(() => { tries++; const c = getContract(did); if (c && wallet()) { clearInterval(timer); window.daDrcOpen(did); } if (tries > 40) clearInterval(timer); }, 500); }
    } catch (_) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install); else install();
  setTimeout(install, 1500);
  document.addEventListener('click', function (e) {
    const t = e.target && e.target.closest && e.target.closest('#tab-otc, [onclick*="switchTab(\'otc\')"]');
    if (t) setTimeout(() => { install(); injectCardButtons(); }, 300);
  });

  console.log('%c[DA-DRC] Digital Agreements Dispute Center loaded', 'color:#818cf8;font-weight:bold', '| chat · evidence · proposals · arbitration · audit | settlement via otcResolveDispute | storage:', DADR_KEY);
})();
