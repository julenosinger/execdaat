// ============================================================================
// ExecDaat — Enterprise Dispute Resolution Center  (dispute-center.js)
// ----------------------------------------------------------------------------
// A professional, Escrow.com / Kleros-style mediation & arbitration workspace
// layered ON TOP of the existing Contracts dispute system. 100% additive:
//   • Does NOT modify smart-contracts, backend, APIs, wallet, escrow logic,
//     financial flow, routes, workers or ANY existing business logic.
//   • Reuses the existing dispute record (arc_cf_disputes_v1) verbatim and
//     writes resolutions in the exact same shape the legacy code expects, so
//     the rest of the app keeps working with zero regressions.
//   • All new collaboration data (messages, evidence, proposals, arbitration,
//     audit log) lives in a NEW localStorage namespace and never touches the
//     legacy keys' schema.
//   • UI is 100% English, uses the ExecDaat design tokens, and is responsive.
//
// Entry points (all safe, wrapped defensively):
//   window.cfShowDisputeResolution  -> opens this center (legacy kept as fallback)
//   window.drcOpen(contractId)      -> public opener (also for arbitrator links)
//   cfRenderContracts wrapper       -> injects a "Resolution Center" button on
//                                      every disputed contract card.
// ============================================================================
(function () {
  'use strict';

  // ── Namespaced storage (additive — never collides with legacy keys) ────────
  const DRC_KEY  = 'arc_cf_dispute_center_v1';   // collaboration data per contract
  const DRC_SNAP = 'arc_cf_dispute_snap_v1';     // minimal contract snapshots (arbitrator/link reopen)
  const DRC_SLA_HOURS = 72;                       // suggested resolution SLA
  const DRC_MAX_FILE  = 10 * 1024 * 1024;         // 10 MB per file (matches legacy)

  // Module-level UI state (never persisted)
  let drcActiveTab = 'messages';
  let drcCurrentId = null;
  let drcPollTimer = null;

  // ── Safe access to host helpers (contracts.js / app.js globals) ────────────
  const toast = (m, t) => { try { (window.showToast || function(){})(m, t || 'info'); } catch (_) {} };
  const esc = (s) => {
    if (typeof window.cfEsc === 'function') return window.cfEsc(s);
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  };
  const shortAddr = (a) => (typeof window.cfShort === 'function')
    ? window.cfShort(a)
    : (!a || a.length < 12 ? (a || '—') : a.slice(0,8) + '…' + a.slice(-6));
  const fmtUsdc = (v) => {
    try { if (typeof window.cfFmtUsdc === 'function') return window.cfFmtUsdc(v); } catch (_) {}
    const n = typeof v === 'bigint' ? v : BigInt(Math.round(Number(v) || 0));
    return (Number(n) / 1e6).toFixed(2);
  };
  const EXPLORER = (typeof window.CF_EXPLORER === 'string' && window.CF_EXPLORER) ||
                   'https://testnet.arcscan.app';
  const wallet = () => (window.walletState && window.walletState.address) || null;

  // ── Legacy dispute record helpers (read the SAME data the app uses) ─────────
  function getDispute(id) {
    if (typeof window.cfGetDispute === 'function') return window.cfGetDispute(id);
    try { return (JSON.parse(localStorage.getItem('arc_cf_disputes_v1') || '{}'))[String(id)] || null; }
    catch (_) { return null; }
  }
  function setDispute(id, patch) {
    if (typeof window.cfSetDispute === 'function') return window.cfSetDispute(id, patch);
    try {
      const all = JSON.parse(localStorage.getItem('arc_cf_disputes_v1') || '{}');
      all[String(id)] = Object.assign({}, all[String(id)] || {}, patch);
      localStorage.setItem('arc_cf_disputes_v1', JSON.stringify(all));
    } catch (_) {}
  }
  function getMeta(id) {
    if (typeof window.cfGetMeta === 'function') return window.cfGetMeta(id);
    try { return (JSON.parse(localStorage.getItem('arc_cf_meta_v5') || '{}'))[String(id)] || {}; }
    catch (_) { return {}; }
  }
  function setMeta(id, patch) {
    if (typeof window.cfSetMeta === 'function') return window.cfSetMeta(id, patch);
    try {
      const all = JSON.parse(localStorage.getItem('arc_cf_meta_v5') || '{}');
      all[String(id)] = Object.assign({}, all[String(id)] || {}, patch);
      localStorage.setItem('arc_cf_meta_v5', JSON.stringify(all));
    } catch (_) {}
  }
  function refreshContracts() {
    try { if (typeof window.cfLoadContracts === 'function') window.cfLoadContracts({ force: true }); } catch (_) {}
  }

  // ── Collaboration store (NEW namespace) ─────────────────────────────────────
  function drcAll() { try { return JSON.parse(localStorage.getItem(DRC_KEY) || '{}'); } catch (_) { return {}; } }
  function drcGet(id) {
    const d = drcAll()[String(id)];
    return d || { messages: [], evidence: [], proposals: [], arbitration: null, auditLog: [], phase: null };
  }
  function drcSave(id, data) {
    try {
      const all = drcAll();
      all[String(id)] = data;
      localStorage.setItem(DRC_KEY, JSON.stringify(all));
      return true;
    } catch (e) {
      toast('Storage limit reached — try smaller attachments.', 'error');
      return false;
    }
  }
  function drcAudit(id, action, detail) {
    const d = drcGet(id);
    d.auditLog = d.auditLog || [];
    d.auditLog.push({ ts: Date.now(), wallet: wallet(), role: roleOf(getContract(id), wallet()).key, action, detail: detail || '' });
    drcSave(id, d);
  }

  // ── Contract resolution (cfState → snapshot cache → null) ───────────────────
  function getContract(id) {
    try {
      const list = (window.cfState && window.cfState.contracts) || [];
      const c = list.find(x => String(x.id) === String(id));
      if (c) { snapshot(c); return c; }
    } catch (_) {}
    try {
      const snap = JSON.parse(localStorage.getItem(DRC_SNAP) || '{}')[String(id)];
      if (snap) return snap;
    } catch (_) {}
    return null;
  }
  function snapshot(c) {
    try {
      const all = JSON.parse(localStorage.getItem(DRC_SNAP) || '{}');
      all[String(c.id)] = {
        id: c.id, client: c.client, contractor: c.contractor, title: c.title,
        totalValue: String(c.totalValue), depositedValue: String(c.depositedValue || '0'),
        createdAt: c.createdAt, startedAt: c.startedAt, completedAt: c.completedAt,
        milestones: (c.milestones || []).map(m => ({ description: m.description, amount: String(m.amount), status: m.status })),
      };
      localStorage.setItem(DRC_SNAP, JSON.stringify(all));
    } catch (_) {}
  }

  // ── Roles & access control ──────────────────────────────────────────────────
  function roleOf(c, w) {
    const lw = (w || '').toLowerCase();
    if (!c || !lw) return { key: 'observer', label: 'Observer', color: '#8b93a7', bg: '139,147,167' };
    if (c.client && c.client.toLowerCase() === lw)      return { key: 'client',     label: 'Client',     color: '#60b4ff', bg: '96,180,255' };
    if (c.contractor && c.contractor.toLowerCase() === lw) return { key: 'contractor', label: 'Contractor', color: '#34d399', bg: '52,211,153' };
    const arb = arbitratorAddr(c.id);
    if (arb && arb.toLowerCase() === lw)                return { key: 'arbitrator', label: 'Arbitrator', color: '#a78bfa', bg: '167,139,250' };
    return { key: 'observer', label: 'Observer', color: '#8b93a7', bg: '139,147,167' };
  }
  function arbitratorAddr(id) {
    const a = drcGet(id).arbitration;
    if (a && a.arbitrator && a.arbitrator.type === 'wallet') return a.arbitrator.value || null;
    return null;
  }
  function canAccess(c) {
    const r = roleOf(c, wallet());
    return r.key === 'client' || r.key === 'contractor' || r.key === 'arbitrator';
  }

  // ── Phase / status derivation ───────────────────────────────────────────────
  const PHASES = {
    negotiation: { label: 'Negotiation',       dot: '#34d399', bg: '52,211,153',  icon: 'fa-comments'      },
    awaiting:    { label: 'Awaiting Response', dot: '#fbbf24', bg: '251,191,36',  icon: 'fa-hourglass-half'},
    mediation:   { label: 'In Mediation',      dot: '#38bdf8', bg: '56,189,248',  icon: 'fa-people-arrows' },
    arbitration: { label: 'Arbitration',       dot: '#a78bfa', bg: '167,139,250', icon: 'fa-gavel'         },
    resolved:    { label: 'Resolved',          dot: '#f87171', bg: '248,113,113', icon: 'fa-flag-checkered'},
  };
  function phaseOf(id) {
    const dsp = getDispute(id);
    if (!dsp) return 'negotiation';
    if (dsp.status === 'resolved') return 'resolved';
    const drc = drcGet(id);
    if (drc.arbitration && drc.arbitration.started) return 'arbitration';
    if (drc.arbitration && drc.arbitration.requested) return 'mediation';
    const props = drc.proposals || [];
    const lastPending = props.filter(p => p.status === 'pending').pop();
    if (lastPending) {
      // waiting on the party that did NOT author the latest pending proposal
      return 'awaiting';
    }
    if (drc.messages && drc.messages.length) return 'negotiation';
    return 'negotiation';
  }

  // ── Time helpers ─────────────────────────────────────────────────────────────
  function fmtDateTime(ts) { try { return new Date(Number(ts)).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }); } catch (_) { return '—'; } }
  function fmtTime(ts)     { try { return new Date(Number(ts)).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }); } catch (_) { return '—'; } }
  function fmtDate(ts)     { try { return new Date(Number(ts)).toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' }); } catch (_) { return '—'; } }
  function tsFromUnix(u)   { return (Number(u) || 0) * 1000; }
  function durationSince(ms) {
    if (!ms) return '—';
    let s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600);  s -= h * 3600;
    const m = Math.floor(s / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }
  function priorityOf(openedAt, resolved) {
    if (resolved) return { label: 'Resolved',  color: '#8b93a7', bg: '139,147,167' };
    const ageH = openedAt ? (Date.now() - openedAt) / 3600000 : 0;
    if (ageH >= 48) return { label: 'High Priority',   color: '#f87171', bg: '248,113,113' };
    if (ageH >= 24) return { label: 'Medium Priority', color: '#fbbf24', bg: '251,191,36'  };
    return { label: 'Standard', color: '#34d399', bg: '52,211,153' };
  }

  // ── File helpers ──────────────────────────────────────────────────────────────
  function fileKind(mime, name) {
    const m = (mime || '').toLowerCase(); const n = (name || '').toLowerCase();
    if (m.startsWith('image/')) return 'image';
    if (m === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
    if (m.startsWith('video/')) return 'video';
    if (m.includes('zip') || n.endsWith('.zip') || n.endsWith('.rar') || n.endsWith('.7z')) return 'zip';
    return 'doc';
  }
  function kindIcon(k) {
    return k === 'image' ? 'fa-image' : k === 'pdf' ? 'fa-file-pdf' : k === 'video' ? 'fa-file-video'
         : k === 'zip' ? 'fa-file-archive' : 'fa-file-lines';
  }
  function humanSize(b) {
    b = Number(b) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }
  function readFile(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = e => resolve({
        name: file.name, url: e.target.result, size: file.size,
        mimeType: file.type, kind: fileKind(file.type, file.name),
      });
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  // ── Badges ────────────────────────────────────────────────────────────────────
  function badge(label, color, bg, icon) {
    return `<span class="drc-badge" style="color:${color};background:rgba(${bg},0.12);border-color:rgba(${bg},0.35);">
      ${icon ? `<i class="fas ${icon}"></i>` : ''}${esc(label)}</span>`;
  }
  function roleBadge(rkey) {
    const map = {
      client:     { label: 'Client',     color: '#60b4ff', bg: '96,180,255',  icon: 'fa-user'        },
      contractor: { label: 'Contractor', color: '#34d399', bg: '52,211,153',  icon: 'fa-briefcase'   },
      arbitrator: { label: 'Arbitrator', color: '#a78bfa', bg: '167,139,250', icon: 'fa-scale-balanced' },
      system:     { label: 'System',     color: '#8b93a7', bg: '139,147,167', icon: 'fa-robot'       },
      observer:   { label: 'Observer',   color: '#8b93a7', bg: '139,147,167', icon: 'fa-eye'         },
    };
    const r = map[rkey] || map.system;
    return badge(r.label, r.color, r.bg, r.icon);
  }

  // ── Styles (injected once) ──────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('drc-styles')) return;
    const s = document.createElement('style');
    s.id = 'drc-styles';
    s.textContent = `
    /* Overlay is confined to the MAIN CONTENT AREA (offset by the sidebar width via
       the app's --sidebar-w variable) and sits ABOVE the sidebar (z-index:200) and
       sticky topbar (z-index:100). Root-cause fix for the modal rendering behind the
       sidebar. On mobile --sidebar-w is 0 (drawer), so it spans full width. */
    #drc-overlay{position:fixed;top:0;right:0;bottom:0;left:var(--sidebar-w,0px);z-index:9990;
      display:flex;align-items:center;justify-content:center;
      padding:16px;background:rgba(2,4,12,0.82);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
      animation:drcFade .18s ease;}
    @keyframes drcFade{from{opacity:0}to{opacity:1}}
    @keyframes drcSlideUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
    #drc-shell{width:100%;max-width:1120px;height:92vh;display:flex;flex-direction:column;
      background:radial-gradient(120% 80% at 0% 0%,rgba(59,130,246,0.06),transparent 60%),#0a0c18;
      border:1px solid rgba(96,180,255,0.20);border-radius:20px;overflow:hidden;
      box-shadow:0 24px 80px rgba(0,0,0,0.55),0 0 0 1px rgba(96,180,255,0.05);animation:drcSlideUp .22s ease;}
    .drc-badge{display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:700;letter-spacing:.02em;
      padding:2px 9px;border-radius:999px;border:1px solid;white-space:nowrap;}
    .drc-head{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid rgba(96,180,255,0.12);
      background:rgba(10,14,28,0.9);flex-shrink:0;}
    .drc-x{width:32px;height:32px;border-radius:9px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.10);
      color:#9aa7c4;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .18s;}
    .drc-x:hover{background:rgba(239,68,68,0.14);border-color:rgba(239,68,68,0.35);color:#f87171;}
    .drc-body{flex:1;display:grid;grid-template-columns:340px 1fr;min-height:0;}
    .drc-side{border-right:1px solid rgba(96,180,255,0.10);overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:12px;
      background:rgba(9,12,24,0.55);}
    .drc-main{display:flex;flex-direction:column;min-height:0;}
    .drc-panel{background:rgba(96,180,255,0.035);border:1px solid rgba(96,180,255,0.12);border-radius:14px;padding:13px 14px;}
    .drc-panel h4{font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#6f83ad;margin:0 0 9px;
      display:flex;align-items:center;gap:6px;}
    .drc-row{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11.5px;margin-bottom:6px;}
    .drc-row .k{color:#6f83ad;} .drc-row .v{color:#dde2f0;font-weight:600;text-align:right;}
    .drc-tabs{display:flex;gap:4px;padding:10px 12px 0;flex-shrink:0;flex-wrap:wrap;}
    .drc-tab{flex:1;min-width:96px;padding:9px 8px;border-radius:10px 10px 0 0;font-size:12px;font-weight:700;cursor:pointer;
      border:1px solid transparent;color:#7b8eb8;background:transparent;transition:all .16s;display:flex;align-items:center;
      justify-content:center;gap:6px;position:relative;}
    .drc-tab:hover{color:#c9d3e7;background:rgba(96,180,255,0.06);}
    .drc-tab.active{color:#fff;background:linear-gradient(135deg,#1a63ff,#6d3cff);box-shadow:0 4px 14px rgba(80,100,255,0.28);}
    .drc-tab .pill{position:absolute;top:3px;right:6px;font-size:8px;font-weight:800;background:#ef4444;color:#fff;
      min-width:15px;height:15px;padding:0 4px;border-radius:999px;display:flex;align-items:center;justify-content:center;}
    .drc-tabwrap{flex:1;min-height:0;display:flex;flex-direction:column;border-top:1px solid rgba(96,180,255,0.12);}
    .drc-scroll{flex:1;overflow-y:auto;padding:14px;}
    .drc-msg{display:flex;gap:9px;margin-bottom:14px;animation:drcSlideUp .2s ease;}
    .drc-msg.me{flex-direction:row-reverse;}
    .drc-av{width:34px;height:34px;border-radius:10px;flex-shrink:0;display:flex;align-items:center;justify-content:center;
      font-size:13px;font-weight:800;color:#fff;}
    .drc-bub{max-width:74%;border-radius:14px;padding:9px 12px;font-size:12.5px;line-height:1.5;color:#e6ecfb;
      background:rgba(255,255,255,0.045);border:1px solid rgba(255,255,255,0.07);}
    .drc-msg.me .drc-bub{background:rgba(96,180,255,0.10);border-color:rgba(96,180,255,0.22);}
    .drc-meta{display:flex;align-items:center;gap:7px;margin-bottom:3px;font-size:10px;}
    .drc-att{display:flex;align-items:center;gap:8px;margin-top:7px;padding:7px 9px;border-radius:9px;cursor:pointer;
      background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.08);transition:all .16s;}
    .drc-att:hover{border-color:rgba(96,180,255,0.4);background:rgba(96,180,255,0.08);}
    .drc-composer{flex-shrink:0;border-top:1px solid rgba(96,180,255,0.12);padding:11px 12px;background:rgba(9,12,24,0.7);}
    .drc-input{width:100%;background:rgba(255,255,255,0.04);border:1px solid rgba(96,180,255,0.16);border-radius:12px;
      padding:10px 12px;color:#e6ecfb;font-size:12.5px;font-family:inherit;resize:none;outline:none;transition:border-color .18s,box-shadow .2s;}
    .drc-input:focus{border-color:rgba(59,130,246,0.55);box-shadow:0 0 0 1px rgba(59,130,246,0.2),0 0 14px rgba(59,130,246,0.16);}
    .drc-btn{border:none;border-radius:11px;padding:9px 14px;font-size:12px;font-weight:700;cursor:pointer;
      display:inline-flex;align-items:center;justify-content:center;gap:6px;transition:transform .14s,filter .18s,box-shadow .2s;}
    .drc-btn:hover{filter:brightness(1.08);} .drc-btn:active{transform:scale(.97);} .drc-btn:disabled{opacity:.4;cursor:not-allowed;}
    .drc-btn-primary{background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;box-shadow:0 6px 18px rgba(80,50,200,0.3);}
    .drc-btn-ghost{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.10);color:#9aa7c4;}
    .drc-btn-green{background:rgba(52,211,153,0.14);border:1px solid rgba(52,211,153,0.35);color:#34d399;}
    .drc-btn-red{background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.32);color:#f87171;}
    .drc-btn-amber{background:rgba(251,191,36,0.12);border:1px solid rgba(251,191,36,0.32);color:#fbbf24;}
    .drc-btn-purple{background:rgba(167,139,250,0.12);border:1px solid rgba(167,139,250,0.34);color:#a78bfa;}
    .drc-chip{padding:7px 10px;border-radius:10px;font-size:11px;font-weight:700;cursor:pointer;border:1px solid rgba(96,180,255,0.18);
      background:rgba(96,180,255,0.06);color:#9fb4dd;transition:all .16s;}
    .drc-chip:hover{border-color:rgba(96,180,255,0.5);color:#dde2f0;background:rgba(96,180,255,0.12);}
    .drc-chip.sel{background:linear-gradient(135deg,#1a63ff,#6d3cff);color:#fff;border-color:transparent;}
    .drc-tl{position:relative;padding-left:22px;}
    .drc-tl::before{content:'';position:absolute;left:6px;top:4px;bottom:4px;width:2px;background:rgba(96,180,255,0.16);}
    .drc-tl-item{position:relative;margin-bottom:12px;animation:drcSlideUp .3s ease;}
    .drc-tl-dot{position:absolute;left:-22px;top:2px;width:14px;height:14px;border-radius:50%;border:2px solid #0a0c18;
      display:flex;align-items:center;justify-content:center;font-size:6px;color:#fff;}
    .drc-prop{border:1px solid rgba(96,180,255,0.14);border-radius:14px;padding:13px;margin-bottom:12px;background:rgba(96,180,255,0.03);
      animation:drcSlideUp .22s ease;}
    .drc-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:44px 20px;text-align:center;color:#5b6a8c;}
    .drc-empty i{font-size:30px;color:rgba(96,180,255,0.35);}
    .drc-typing{display:flex;align-items:center;gap:4px;padding:0 4px;height:0;overflow:hidden;transition:height .2s;font-size:10px;color:#6f83ad;}
    .drc-typing.on{height:16px;}
    .drc-typing span{width:5px;height:5px;border-radius:50%;background:#6f83ad;animation:drcBlink 1.2s infinite;}
    .drc-typing span:nth-child(2){animation-delay:.2s;} .drc-typing span:nth-child(3){animation-delay:.4s;}
    @keyframes drcBlink{0%,60%,100%{opacity:.25}30%{opacity:1}}
    .drc-skel{background:linear-gradient(90deg,rgba(96,180,255,0.06),rgba(96,180,255,0.14),rgba(96,180,255,0.06));
      background-size:200% 100%;animation:drcShimmer 1.3s infinite;border-radius:10px;}
    @keyframes drcShimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
    .drc-progress{height:4px;border-radius:4px;background:rgba(96,180,255,0.12);overflow:hidden;margin-top:6px;}
    .drc-progress>div{height:100%;background:linear-gradient(90deg,#378ADD,#7c3aed);width:0;transition:width .25s;}
    @media (max-width:820px){
      #drc-shell{height:96vh;max-width:100%;}
      .drc-body{grid-template-columns:1fr;}
      .drc-side{border-right:none;border-bottom:1px solid rgba(96,180,255,0.10);max-height:38vh;}
      .drc-bub{max-width:82%;}
    }
    @media (prefers-reduced-motion:reduce){#drc-overlay,#drc-shell,.drc-msg,.drc-tl-item,.drc-prop{animation:none!important;}}
    `;
    document.head.appendChild(s);
  }

  // ── Open / close ────────────────────────────────────────────────────────────
  window.drcOpen = function (contractId) {
    injectStyles();
    const id = contractId;
    const c = getContract(id);
    if (!c) { toast('Contract data not available on this device.', 'error'); return; }
    if (!canAccess(c)) { toast('Only the Client, Contractor or assigned Arbitrator can access this dispute.', 'error'); return; }

    drcCurrentId = id;
    drcActiveTab = 'messages';
    // mark messages as read by me
    markRead(id);

    document.getElementById('drc-overlay')?.remove();
    const ov = document.createElement('div');
    ov.id = 'drc-overlay';
    ov.innerHTML = `<div id="drc-shell"></div>`;
    document.body.appendChild(ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) closeCenter(); });

    // event delegation (click + change)
    ov.addEventListener('click', onClick);
    ov.addEventListener('change', onChange);
    ov.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeCenter();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && document.activeElement?.id === 'drc-msg-input') {
        sendMessage();
      }
    });

    render();
    // light polling so a second tab/party's localStorage changes reflect live
    clearInterval(drcPollTimer);
    drcPollTimer = setInterval(() => { if (document.getElementById('drc-overlay')) softRefresh(); else clearInterval(drcPollTimer); }, 4000);
  };

  function closeCenter() {
    clearInterval(drcPollTimer);
    document.getElementById('drc-overlay')?.remove();
    drcCurrentId = null;
  }

  function markRead(id) {
    const d = drcGet(id); const w = (wallet() || '').toLowerCase(); if (!w) return;
    let changed = false;
    (d.messages || []).forEach(m => {
      if ((m.wallet || '').toLowerCase() !== w) { m.readBy = m.readBy || {}; if (!m.readBy[w]) { m.readBy[w] = true; changed = true; } }
    });
    if (changed) drcSave(id, d);
  }

  let _lastSig = '';
  function softRefresh() {
    const id = drcCurrentId; if (id == null) return;
    const d = drcGet(id); const dsp = getDispute(id);
    const sig = JSON.stringify([(d.messages||[]).length, (d.evidence||[]).length, (d.proposals||[]).map(p=>p.status), d.arbitration, dsp && dsp.status]);
    if (sig !== _lastSig) { _lastSig = sig; markRead(id); render(); }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════════════════
  function render() {
    const shell = document.getElementById('drc-shell'); if (!shell) return;
    const id = drcCurrentId;
    const c = getContract(id);
    const dsp = getDispute(id) || {};
    const drc = drcGet(id);
    const phaseKey = phaseOf(id);
    const ph = PHASES[phaseKey];
    const resolved = dsp.status === 'resolved';
    const me = roleOf(c, wallet());
    const unread = unreadCount(id);

    _lastSig = JSON.stringify([(drc.messages||[]).length, (drc.evidence||[]).length, (drc.proposals||[]).map(p=>p.status), drc.arbitration, dsp && dsp.status]);

    shell.innerHTML = `
      ${headerHTML(c, dsp, ph, resolved)}
      <div class="drc-body">
        <div class="drc-side">
          ${statusHTML(id, c, dsp, ph, resolved)}
          ${contractHTML(c, dsp)}
          ${arbitrationHTML(id, c, drc, me, resolved)}
          ${resolutionHTML(id, c, dsp, drc, me, resolved)}
          ${timelineHTML(id, c, dsp, drc)}
          ${auditHTML(drc)}
        </div>
        <div class="drc-main">
          <div class="drc-tabs">
            ${tabBtn('messages', 'Messages', 'fa-comments', unread)}
            ${tabBtn('evidence', 'Evidence', 'fa-paperclip', 0)}
            ${tabBtn('proposals', 'Proposals', 'fa-handshake', pendingForMe(id, me))}
          </div>
          <div class="drc-tabwrap">
            ${tabContent(id, c, dsp, drc, me, resolved)}
          </div>
        </div>
      </div>`;

    if (drcActiveTab === 'messages') {
      const sc = document.getElementById('drc-msg-scroll');
      if (sc) sc.scrollTop = sc.scrollHeight;
      const inp = document.getElementById('drc-msg-input');
      if (inp && !resolved && me.key !== 'observer') setTimeout(() => inp.focus(), 30);
    }
  }

  function tabBtn(key, label, icon, count) {
    return `<button class="drc-tab ${drcActiveTab === key ? 'active' : ''}" data-act="tab" data-tab="${key}">
      <i class="fas ${icon}"></i>${label}${count > 0 ? `<span class="pill">${count > 9 ? '9+' : count}</span>` : ''}</button>`;
  }

  // ── Header ────────────────────────────────────────────────────────────────
  function headerHTML(c, dsp, ph, resolved) {
    const prio = priorityOf(dsp.openedAt, resolved);
    return `
    <div class="drc-head">
      <div style="width:38px;height:38px;border-radius:11px;display:flex;align-items:center;justify-content:center;
        background:rgba(${ph.bg},0.14);border:1px solid rgba(${ph.bg},0.3);flex-shrink:0;">
        <i class="fas fa-scale-balanced" style="color:${ph.dot};font-size:16px;"></i>
      </div>
      <div style="flex:1;min-width:0;">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span style="font-size:15px;font-weight:800;color:#eaf0ff;">Dispute Resolution</span>
          <span style="font-size:11px;color:#5b6a8c;font-family:monospace;">DISP-${String(c ? c.id : '—').padStart(4,'0')}</span>
          ${badge(ph.label, ph.dot, ph.bg, ph.icon)}
        </div>
        <div style="font-size:11px;color:#6f83ad;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
          ${esc((c && c.title) || 'Untitled Contract')} · Escrow $${c ? fmtUsdc(BigInt(c.totalValue)) : '0.00'} USDC
        </div>
      </div>
      ${badge(prio.label, prio.color, prio.bg, 'fa-flag')}
      <button class="drc-x" data-act="close" title="Close"><i class="fas fa-times"></i></button>
    </div>`;
  }

  // ── Status card ─────────────────────────────────────────────────────────────
  function statusHTML(id, c, dsp, ph, resolved) {
    const opened = dsp.openedAt;
    const prio = priorityOf(opened, resolved);
    const slaLeft = opened ? Math.max(0, DRC_SLA_HOURS - (Date.now() - opened) / 3600000) : DRC_SLA_HOURS;
    const slaPct = Math.min(100, Math.round(((DRC_SLA_HOURS - slaLeft) / DRC_SLA_HOURS) * 100));
    const steps = ['negotiation','awaiting','mediation','arbitration','resolved'];
    const curIdx = steps.indexOf(ph === PHASES.resolved ? 'resolved' : phaseOf(id));
    return `
    <div class="drc-panel" style="border-color:rgba(${ph.bg},0.28);background:rgba(${ph.bg},0.05);">
      <h4><i class="fas fa-signal"></i>Current Status</h4>
      <div style="display:flex;align-items:center;gap:9px;margin-bottom:10px;">
        <span style="width:11px;height:11px;border-radius:50%;background:${ph.dot};box-shadow:0 0 10px ${ph.dot};flex-shrink:0;"></span>
        <span style="font-size:14px;font-weight:800;color:${ph.dot};">${ph.label}</span>
      </div>
      <div style="display:flex;gap:4px;margin-bottom:12px;">
        ${steps.map((sk, i) => {
          const p = PHASES[sk]; const done = i <= curIdx;
          return `<div title="${p.label}" style="flex:1;height:5px;border-radius:3px;background:${done ? p.dot : 'rgba(96,180,255,0.12)'};
            ${done ? `box-shadow:0 0 8px rgba(${p.bg},0.5);` : ''}transition:all .3s;"></div>`;
        }).join('')}
      </div>
      <div class="drc-row"><span class="k">Priority</span><span class="v" style="color:${prio.color};">${prio.label}</span></div>
      <div class="drc-row"><span class="k">Opened</span><span class="v">${opened ? durationSince(opened) + ' ago' : '—'}</span></div>
      <div class="drc-row"><span class="k">Suggested SLA</span><span class="v">${DRC_SLA_HOURS}h</span></div>
      ${!resolved ? `
      <div class="drc-row" style="margin-bottom:4px;"><span class="k">SLA Progress</span><span class="v">${slaLeft.toFixed(0)}h left</span></div>
      <div class="drc-progress"><div style="width:${slaPct}%;${slaPct>=100?'background:linear-gradient(90deg,#ef4444,#b91c1c);':''}"></div></div>` : ''}
    </div>`;
  }

  // ── Contract details ─────────────────────────────────────────────────────────
  function contractHTML(c, dsp) {
    if (!c) return '';
    const opener = dsp.openedBy;
    const openerRole = opener && c.client && opener.toLowerCase() === c.client.toLowerCase() ? 'Client'
                     : opener && c.contractor && opener.toLowerCase() === c.contractor.toLowerCase() ? 'Contractor' : '—';
    return `
    <div class="drc-panel">
      <h4><i class="fas fa-file-contract"></i>Contract Details</h4>
      <div class="drc-row"><span class="k">Contract</span><span class="v">#${c.id}</span></div>
      <div class="drc-row"><span class="k">Escrow Amount</span><span class="v" style="color:#60b4ff;">$${fmtUsdc(BigInt(c.totalValue))} USDC</span></div>
      <div style="height:1px;background:rgba(96,180,255,0.1);margin:8px 0;"></div>
      <div class="drc-row"><span class="k"><i class="fas fa-user" style="color:#60b4ff;"></i> Client</span>
        <a class="v" style="color:#60b4ff;font-family:monospace;" href="${EXPLORER}/address/${c.client}" target="_blank" rel="noopener">${shortAddr(c.client)}</a></div>
      <div class="drc-row"><span class="k"><i class="fas fa-briefcase" style="color:#34d399;"></i> Contractor</span>
        <a class="v" style="color:#34d399;font-family:monospace;" href="${EXPLORER}/address/${c.contractor}" target="_blank" rel="noopener">${shortAddr(c.contractor)}</a></div>
      <div style="height:1px;background:rgba(96,180,255,0.1);margin:8px 0;"></div>
      <div class="drc-row"><span class="k">Opened By</span><span class="v">${openerRole} · ${shortAddr(opener)}</span></div>
      <div class="drc-row"><span class="k">Opened On</span><span class="v">${opened(dsp.openedAt)}</span></div>
      ${dsp.reason ? `<div style="margin-top:8px;padding:8px 10px;background:rgba(239,68,68,0.05);border:1px solid rgba(239,68,68,0.18);border-radius:9px;">
        <div style="font-size:9px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#f87171;margin-bottom:3px;">Reason</div>
        <div style="font-size:11.5px;color:#e6ecfb;line-height:1.5;">${esc(dsp.reason)}</div></div>` : ''}
    </div>`;
    function opened(t) { return t ? fmtDate(t) : '—'; }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TABS: Messages / Evidence / Proposals
  // ══════════════════════════════════════════════════════════════════════════
  function tabContent(id, c, dsp, drc, me, resolved) {
    if (drcActiveTab === 'evidence')  return evidenceTab(id, drc, me, resolved);
    if (drcActiveTab === 'proposals') return proposalsTab(id, c, drc, me, resolved);
    return messagesTab(id, c, drc, me, resolved);
  }

  // ── Messages / Chat ───────────────────────────────────────────────────────
  function messagesTab(id, c, drc, me, resolved) {
    const msgs = drc.messages || [];
    const myw = (wallet() || '').toLowerCase();
    const body = msgs.length ? msgs.map(m => {
      const mine = (m.wallet || '').toLowerCase() === myw;
      const rk = m.role || 'system';
      const rcolor = rk === 'client' ? '#60b4ff' : rk === 'contractor' ? '#34d399' : rk === 'arbitrator' ? '#a78bfa' : '#8b93a7';
      const rbg = rk === 'client' ? '96,180,255' : rk === 'contractor' ? '52,211,153' : rk === 'arbitrator' ? '167,139,250' : '139,147,167';
      const initials = (rk === 'client' ? 'CL' : rk === 'contractor' ? 'CO' : rk === 'arbitrator' ? 'AR' : 'SY');
      const readByOther = m.readBy && Object.keys(m.readBy).some(k => k !== myw);
      const atts = (m.attachments || []).map((a, ai) => `
        <div class="drc-att" data-act="viewFile" data-scope="msg" data-mi="${msgs.indexOf(m)}" data-ai="${ai}">
          <i class="fas ${kindIcon(a.kind)}" style="color:${rcolor};"></i>
          <span style="flex:1;font-size:11px;color:#c9d3e7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(a.name)}</span>
          <span style="font-size:9px;color:#6f83ad;">${humanSize(a.size)}</span>
          <i class="fas fa-eye" style="color:#6f83ad;font-size:10px;"></i>
        </div>`).join('');
      return `
      <div class="drc-msg ${mine ? 'me' : ''}">
        <div class="drc-av" style="background:linear-gradient(135deg,rgba(${rbg},0.9),rgba(${rbg},0.5));">${initials}</div>
        <div style="min-width:0;">
          <div class="drc-meta" style="${mine ? 'justify-content:flex-end;' : ''}">
            ${roleBadge(rk)}
            <span style="color:#6f83ad;">${fmtTime(m.ts)} · ${fmtDate(m.ts)}</span>
          </div>
          <div class="drc-bub">
            ${m.text ? esc(m.text).replace(/\n/g,'<br>').replace(/(https?:\/\/[^\s<]+)/g,'<a href="$1" target="_blank" rel="noopener" style="color:#60b4ff;">$1</a>') : ''}
            ${atts}
          </div>
          ${mine ? `<div style="text-align:right;font-size:9px;color:${readByOther ? '#34d399' : '#6f83ad'};margin-top:2px;">
            <i class="fas fa-check${readByOther ? '-double' : ''}"></i> ${readByOther ? 'Read' : 'Sent'}</div>` : ''}
        </div>
      </div>`;
    }).join('') : `<div class="drc-empty"><i class="fas fa-comments"></i>
        <div><strong style="color:#8aaac8;">No messages yet</strong><br>
        <span style="font-size:11px;">Start the conversation to reach a consensus before releasing funds.</span></div></div>`;

    const disabled = resolved || me.key === 'observer';
    return `
      <div class="drc-scroll" id="drc-msg-scroll">${body}</div>
      <div class="drc-typing" id="drc-typing"><span></span><span></span><span></span><em style="margin-left:4px;">typing…</em></div>
      ${disabled ? `<div class="drc-composer" style="text-align:center;color:#5b6a8c;font-size:11px;">
          <i class="fas fa-lock mr-1"></i>${resolved ? 'This dispute is resolved — the conversation is read-only.' : 'Only dispute participants can send messages.'}</div>`
        : `
      <div class="drc-composer">
        <div id="drc-msg-atts" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;"></div>
        <div style="display:flex;gap:8px;align-items:flex-end;">
          <button class="drc-btn drc-btn-ghost" data-act="pickMsgFile" title="Attach file" style="padding:9px 11px;"><i class="fas fa-paperclip"></i></button>
          <textarea id="drc-msg-input" class="drc-input" rows="1" placeholder="Write a message…  (Ctrl/Cmd + Enter to send)"
            style="flex:1;max-height:120px;" oninput="this.style.height='auto';this.style.height=Math.min(120,this.scrollHeight)+'px';"></textarea>
          <button class="drc-btn drc-btn-primary" data-act="send"><i class="fas fa-paper-plane"></i>Send</button>
        </div>
        <input type="file" id="drc-msg-file" multiple accept="image/*,application/pdf,video/*,.zip,.rar,.7z,.doc,.docx,.txt" style="display:none;">
      </div>`}`;
  }

  // ── Evidence ────────────────────────────────────────────────────────────────
  function evidenceTab(id, drc, me, resolved) {
    const ev = (drc.evidence || []).slice().sort((a, b) => a.ts - b.ts);
    const list = ev.length ? ev.map((e, i) => `
      <div style="display:flex;align-items:center;gap:11px;padding:11px 12px;border:1px solid rgba(96,180,255,0.12);
        border-radius:12px;margin-bottom:9px;background:rgba(96,180,255,0.03);animation:drcSlideUp .2s ease;">
        <div style="width:40px;height:40px;border-radius:10px;flex-shrink:0;display:flex;align-items:center;justify-content:center;
          background:rgba(${e.role==='client'?'96,180,255':e.role==='contractor'?'52,211,153':'167,139,250'},0.14);">
          <i class="fas ${kindIcon(e.kind)}" style="color:${e.role==='client'?'#60b4ff':e.role==='contractor'?'#34d399':'#a78bfa'};font-size:16px;"></i>
        </div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:12.5px;font-weight:700;color:#e6ecfb;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(e.name)}</div>
          <div style="font-size:10px;color:#6f83ad;margin-top:2px;display:flex;gap:8px;flex-wrap:wrap;">
            ${roleBadge(e.role)}<span>${humanSize(e.size)}</span><span>${(e.kind||'file').toUpperCase()}</span><span>${fmtDateTime(e.ts)}</span></div>
        </div>
        <button class="drc-btn drc-btn-ghost" data-act="viewFile" data-scope="ev" data-i="${i}" style="padding:8px 10px;"><i class="fas fa-eye"></i></button>
        <button class="drc-btn drc-btn-ghost" data-act="dlFile" data-scope="ev" data-i="${i}" style="padding:8px 10px;"><i class="fas fa-download"></i></button>
      </div>`).join('') : `<div class="drc-empty"><i class="fas fa-folder-open"></i>
        <div><strong style="color:#8aaac8;">No evidence submitted</strong><br>
        <span style="font-size:11px;">Upload supporting documents, screenshots, PDFs, video or ZIP archives.</span></div></div>`;

    const disabled = resolved || me.key === 'observer';
    return `
      <div class="drc-scroll">
        ${disabled ? '' : `
        <div id="drc-ev-drop" data-act="pickEvFile" style="border:2px dashed rgba(96,180,255,0.3);border-radius:14px;padding:22px;
          text-align:center;cursor:pointer;margin-bottom:14px;transition:all .2s;">
          <i class="fas fa-cloud-arrow-up" style="font-size:26px;color:#60b4ff;display:block;margin-bottom:8px;"></i>
          <div style="font-size:12.5px;font-weight:700;color:#c9d3e7;">Upload Evidence</div>
          <div style="font-size:10px;color:#5b6a8c;margin-top:3px;">Images · PDF · Video · ZIP · Documents — up to 10 MB each</div>
          <div class="drc-progress" id="drc-ev-progress" style="display:none;"><div></div></div>
          <input type="file" id="drc-ev-file" multiple accept="image/*,application/pdf,video/*,.zip,.rar,.7z,.doc,.docx,.txt,.csv,.xlsx" style="display:none;">
        </div>`}
        <div style="font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#6f83ad;margin-bottom:9px;">
          Supporting Documents (${ev.length})</div>
        ${list}
      </div>`;
  }

  // ── Proposals ─────────────────────────────────────────────────────────────
  const PROPOSAL_TEMPLATES = [
    { key: 'release100', label: 'Release 100%',  rel: 100, ref: 0  },
    { key: 'refund100',  label: 'Refund 100%',   rel: 0,   ref: 100},
    { key: 'split5050',  label: 'Split 50 / 50', rel: 50,  ref: 50 },
    { key: 'split7030',  label: 'Split 70 / 30', rel: 70,  ref: 30 },
    { key: 'split9010',  label: 'Split 90 / 10', rel: 90,  ref: 10 },
    { key: 'custom',     label: 'Custom',        rel: null,ref: null},
  ];
  function proposalsTab(id, c, drc, me, resolved) {
    const props = (drc.proposals || []).slice().sort((a, b) => a.ts - b.ts);
    const total = c ? BigInt(c.totalValue) : 0n;
    const myw = (wallet() || '').toLowerCase();

    const list = props.length ? props.map((p, i) => {
      const mine = (p.wallet || '').toLowerCase() === myw;
      const relAmt = fmtUsdc(total * BigInt(p.rel) / 100n);
      const refAmt = fmtUsdc(total * BigInt(p.ref) / 100n);
      const st = p.status;
      const stColor = st === 'accepted' ? '#34d399' : st === 'rejected' ? '#f87171' : st === 'countered' ? '#8b93a7' : '#fbbf24';
      const stBg    = st === 'accepted' ? '52,211,153' : st === 'rejected' ? '248,113,113' : st === 'countered' ? '139,147,167' : '251,191,36';
      const stLabel = st === 'accepted' ? 'Accepted' : st === 'rejected' ? 'Rejected' : st === 'countered' ? 'Superseded' : 'Pending Approval';
      const canRespond = !resolved && st === 'pending' && !mine && (me.key === 'client' || me.key === 'contractor');
      return `
      <div class="drc-prop" style="border-color:rgba(${stBg},0.25);">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:9px;flex-wrap:wrap;">
          ${roleBadge(p.role)}<span style="font-size:10px;color:#6f83ad;">${fmtDateTime(p.ts)}</span>
          ${badge(stLabel, stColor, stBg, st==='accepted'?'fa-check':st==='rejected'?'fa-times':st==='countered'?'fa-rotate':'fa-clock')}
        </div>
        <div style="display:flex;gap:9px;margin-bottom:8px;">
          <div style="flex:1;padding:9px;border-radius:10px;background:rgba(52,211,153,0.06);border:1px solid rgba(52,211,153,0.18);">
            <div style="font-size:9px;color:#6f83ad;text-transform:uppercase;letter-spacing:.05em;">Release → Contractor</div>
            <div style="font-size:15px;font-weight:800;color:#34d399;">${p.rel}%</div>
            <div style="font-size:10px;color:#8aaac8;">$${relAmt} USDC</div>
          </div>
          <div style="flex:1;padding:9px;border-radius:10px;background:rgba(96,180,255,0.06);border:1px solid rgba(96,180,255,0.18);">
            <div style="font-size:9px;color:#6f83ad;text-transform:uppercase;letter-spacing:.05em;">Refund → Client</div>
            <div style="font-size:15px;font-weight:800;color:#60b4ff;">${p.ref}%</div>
            <div style="font-size:10px;color:#8aaac8;">$${refAmt} USDC</div>
          </div>
        </div>
        ${p.note ? `<div style="font-size:11.5px;color:#c9d3e7;line-height:1.5;margin-bottom:8px;padding:7px 9px;background:rgba(0,0,0,0.2);border-radius:8px;">
          <i class="fas fa-quote-left" style="color:#5b6a8c;font-size:9px;margin-right:5px;"></i>${esc(p.note)}</div>` : ''}
        ${canRespond ? `
        <div style="display:flex;gap:7px;flex-wrap:wrap;">
          <button class="drc-btn drc-btn-green" data-act="acceptProp" data-i="${i}"><i class="fas fa-check"></i>Accept Proposal</button>
          <button class="drc-btn drc-btn-red" data-act="rejectProp" data-i="${i}"><i class="fas fa-times"></i>Reject</button>
          <button class="drc-btn drc-btn-amber" data-act="counterProp" data-i="${i}"><i class="fas fa-reply"></i>Send Counter Offer</button>
        </div>` : (st === 'pending' && mine ? `<div style="font-size:10.5px;color:#fbbf24;"><i class="fas fa-hourglass-half mr-1"></i>Awaiting the counterparty's response.</div>` : '')}
      </div>`;
    }).join('') : `<div class="drc-empty"><i class="fas fa-handshake"></i>
        <div><strong style="color:#8aaac8;">No settlement proposals yet</strong><br>
        <span style="font-size:11px;">Create a proposal to reach a mutual agreement.</span></div></div>`;

    const canCreate = !resolved && (me.key === 'client' || me.key === 'contractor');
    return `
      <div class="drc-scroll">
        ${canCreate ? `
        <div class="drc-panel" style="margin-bottom:14px;">
          <h4><i class="fas fa-plus-circle"></i>New Settlement Proposal</h4>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;" id="drc-prop-templates">
            ${PROPOSAL_TEMPLATES.map(t => `<button class="drc-chip" data-act="propTpl" data-tpl="${t.key}">${t.label}</button>`).join('')}
          </div>
          <div id="drc-prop-custom" style="display:none;gap:9px;margin-bottom:10px;">
            <div style="display:flex;gap:9px;">
              <div style="flex:1;">
                <label style="font-size:10px;color:#6f83ad;">Release to Contractor (%)</label>
                <input type="number" id="drc-prop-rel" min="0" max="100" value="50" class="drc-input" oninput="if(document.getElementById('drc-prop-ref'))document.getElementById('drc-prop-ref').value=Math.max(0,100-(+this.value||0));">
              </div>
              <div style="flex:1;">
                <label style="font-size:10px;color:#6f83ad;">Refund to Client (%)</label>
                <input type="number" id="drc-prop-ref" min="0" max="100" value="50" class="drc-input" readonly>
              </div>
            </div>
          </div>
          <textarea id="drc-prop-note" class="drc-input" rows="2" placeholder="Justification (optional) — explain the reasoning behind this settlement…" style="margin-bottom:10px;"></textarea>
          <button class="drc-btn drc-btn-primary" data-act="createProp" style="width:100%;"><i class="fas fa-paper-plane"></i>Submit Proposal</button>
        </div>` : ''}
        <div style="font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#6f83ad;margin-bottom:9px;">
          Proposal History (${props.length})</div>
        ${list}
      </div>`;
  }

  // ── Arbitration panel ─────────────────────────────────────────────────────
  function arbitrationHTML(id, c, drc, me, resolved) {
    const a = drc.arbitration;
    const myKey = me.key;
    const isParty = myKey === 'client' || myKey === 'contractor';

    // Not requested yet
    if (!a || !a.requested) {
      return `
      <div class="drc-panel" style="border-color:rgba(167,139,250,0.22);">
        <h4 style="color:#a78bfa;"><i class="fas fa-gavel"></i>Arbitration</h4>
        <p style="font-size:11px;color:#8aaac8;line-height:1.55;margin:0 0 10px;">
          If both parties cannot reach a consensus, either side can request consensual arbitration by a neutral third party.</p>
        ${(!resolved && isParty) ? `<button class="drc-btn drc-btn-purple" data-act="reqArb" style="width:100%;"><i class="fas fa-gavel"></i>Request Arbitration</button>`
          : `<div style="font-size:10.5px;color:#5b6a8c;">${resolved ? 'Dispute already resolved.' : 'Only parties can request arbitration.'}</div>`}
      </div>`;
    }

    const approvals = a.requested || {};
    const clientOk = c && approvals[(c.client || '').toLowerCase()];
    const contrOk  = c && approvals[(c.contractor || '').toLowerCase()];
    const started  = a.started;
    const arb      = a.arbitrator;

    // Requested, awaiting both approvals
    if (!started) {
      const iApproved = approvals[(wallet() || '').toLowerCase()];
      return `
      <div class="drc-panel" style="border-color:rgba(167,139,250,0.28);background:rgba(167,139,250,0.05);">
        <h4 style="color:#a78bfa;"><i class="fas fa-gavel"></i>Arbitration Requested</h4>
        <p style="font-size:11px;color:#8aaac8;margin:0 0 10px;">Both parties must approve to begin arbitration.</p>
        <div class="drc-row"><span class="k"><i class="fas fa-user" style="color:#60b4ff;"></i> Client</span>
          <span class="v" style="color:${clientOk?'#34d399':'#6f83ad'};"><i class="fas fa-${clientOk?'check-circle':'clock'}"></i> ${clientOk?'Approved':'Pending'}</span></div>
        <div class="drc-row"><span class="k"><i class="fas fa-briefcase" style="color:#34d399;"></i> Contractor</span>
          <span class="v" style="color:${contrOk?'#34d399':'#6f83ad'};"><i class="fas fa-${contrOk?'check-circle':'clock'}"></i> ${contrOk?'Approved':'Pending'}</span></div>
        ${(!resolved && isParty && !iApproved) ? `<button class="drc-btn drc-btn-purple" data-act="approveArb" style="width:100%;margin-top:8px;"><i class="fas fa-check"></i>Approve Arbitration</button>`
          : iApproved ? `<div style="margin-top:8px;font-size:10.5px;color:#34d399;"><i class="fas fa-check-circle mr-1"></i>You approved — awaiting the counterparty.</div>` : ''}
      </div>`;
    }

    // Started — appoint / assigned arbitrator
    return `
    <div class="drc-panel" style="border-color:rgba(167,139,250,0.3);background:rgba(167,139,250,0.06);">
      <h4 style="color:#a78bfa;"><i class="fas fa-scale-balanced"></i>Arbitration Active</h4>
      ${arb && arb.value ? `
        <div class="drc-row"><span class="k">Assigned Arbitrator</span><span class="v" style="color:#a78bfa;">${arb.type==='wallet'?'Wallet':'User'}</span></div>
        <div style="font-size:11px;color:#c9d3e7;font-family:monospace;word-break:break-all;padding:7px 9px;background:rgba(0,0,0,0.2);border-radius:8px;margin-bottom:8px;">
          ${esc(arb.name || arb.value)}</div>
        ${myKey === 'arbitrator' ? `<div style="font-size:10.5px;color:#34d399;margin-bottom:8px;"><i class="fas fa-user-check mr-1"></i>You are the assigned arbitrator. Use the panel below to issue a decision.</div>` : ''}
        <button class="drc-btn drc-btn-ghost" data-act="copyArbLink" style="width:100%;"><i class="fas fa-link"></i>Copy Arbitrator Access Link</button>
      ` : `
        <p style="font-size:11px;color:#8aaac8;margin:0 0 10px;">Appoint a neutral third-party arbitrator (wallet address or registered user).</p>
        ${(!resolved && isParty) ? `
        <input type="text" id="drc-arb-value" class="drc-input" placeholder="0x… wallet address or username" style="margin-bottom:8px;">
        <button class="drc-btn drc-btn-purple" data-act="appointArb" style="width:100%;"><i class="fas fa-user-plus"></i>Appoint Arbitrator</button>` : ''}
      `}
    </div>
    ${myKey === 'arbitrator' && arb && arb.value && !resolved ? arbitratorPanel(id, c) : ''}`;
  }

  function arbitratorPanel(id, c) {
    return `
    <div class="drc-panel" style="border-color:rgba(167,139,250,0.4);background:linear-gradient(135deg,rgba(167,139,250,0.08),rgba(124,58,237,0.05));">
      <h4 style="color:#a78bfa;"><i class="fas fa-user-shield"></i>Arbitrator Decision Panel</h4>
      <p style="font-size:10.5px;color:#8aaac8;margin:0 0 10px;">Review the full case (messages, evidence, proposals, timeline) then issue a binding decision.</p>
      <textarea id="drc-arb-note" class="drc-input" rows="2" placeholder="Decision rationale (recorded in the audit log)…" style="margin-bottom:9px;"></textarea>
      <div style="display:flex;flex-direction:column;gap:7px;">
        <button class="drc-btn drc-btn-green" data-act="arbDecide" data-outcome="contractor" style="width:100%;justify-content:flex-start;"><i class="fas fa-arrow-right"></i>Release 100% to Contractor</button>
        <button class="drc-btn drc-btn-red" data-act="arbDecide" data-outcome="client" style="width:100%;justify-content:flex-start;"><i class="fas fa-undo"></i>Refund 100% to Client</button>
        <div style="display:flex;gap:7px;align-items:center;">
          <input type="number" id="drc-arb-rel" min="0" max="100" value="50" class="drc-input" style="width:80px;" title="Release % to contractor">
          <span style="font-size:10px;color:#6f83ad;">% release / rest refunded</span>
          <button class="drc-btn drc-btn-purple" data-act="arbDecide" data-outcome="split" style="flex:1;"><i class="fas fa-scale-balanced"></i>Custom Split</button>
        </div>
        <div style="display:flex;gap:7px;">
          <button class="drc-btn drc-btn-ghost" data-act="arbRequest" data-what="evidence" style="flex:1;"><i class="fas fa-folder-plus"></i>Request Evidence</button>
          <button class="drc-btn drc-btn-ghost" data-act="arbRequest" data-what="messages" style="flex:1;"><i class="fas fa-comment-dots"></i>Request Info</button>
        </div>
      </div>
    </div>`;
  }

  // ── Resolution / Final Result ───────────────────────────────────────────────
  function resolutionHTML(id, c, dsp, drc, me, resolved) {
    if (resolved && dsp.resolution) {
      const r = dsp.resolution;
      const outLabel = r.outcome === 'contractor' ? 'Funds Released to Contractor'
                     : r.outcome === 'client' ? 'Funds Refunded to Client'
                     : 'Mutual Settlement';
      const total = c ? BigInt(c.totalValue) : 0n;
      let releasedTxt = '—', refundedTxt = '—';
      if (r.split && typeof r.split.rel === 'number') {
        releasedTxt = '$' + fmtUsdc(total * BigInt(r.split.rel) / 100n) + ` (${r.split.rel}%)`;
        refundedTxt = '$' + fmtUsdc(total * BigInt(r.split.ref) / 100n) + ` (${r.split.ref}%)`;
      } else if (r.outcome === 'contractor') { releasedTxt = '$' + fmtUsdc(total) + ' (100%)'; refundedTxt = '$0.00 (0%)'; }
      else if (r.outcome === 'client') { releasedTxt = '$0.00 (0%)'; refundedTxt = '$' + fmtUsdc(total) + ' (100%)'; }
      const decidedBy = r.method === 'arbitration' ? 'Arbitrator' : r.method === 'mutual_agreement' ? 'Both Parties' : 'Client';
      const totalTime = dsp.openedAt ? durationSince2(dsp.openedAt, r.resolvedAt) : '—';
      const tx = r.txHash || (getMeta(id) || {}).disputeTxHash;
      const settledOnChain = !!(r.onChain && tx);
      return `
      <div class="drc-panel" style="border-color:rgba(52,211,153,0.3);background:linear-gradient(135deg,rgba(52,211,153,0.07),rgba(16,185,129,0.03));">
        <h4 style="color:#34d399;"><i class="fas fa-flag-checkered"></i>Resolution Summary</h4>
        <div style="text-align:center;padding:8px 0 12px;">
          <i class="fas fa-circle-check" style="font-size:26px;color:#34d399;"></i>
          <div style="font-size:14px;font-weight:800;color:#e6ecfb;margin-top:6px;">${outLabel}</div>
          <div style="margin-top:6px;">${settledOnChain ? badge('Settled On-Chain', '#34d399', '52,211,153', 'fa-link') : badge('Recorded Settlement', '#8b93a7', '139,147,167', 'fa-file-signature')}</div>
        </div>
        <div class="drc-row"><span class="k">Decided By</span><span class="v">${decidedBy}</span></div>
        <div class="drc-row"><span class="k">Released</span><span class="v" style="color:#34d399;">${releasedTxt}</span></div>
        <div class="drc-row"><span class="k">Refunded</span><span class="v" style="color:#60b4ff;">${refundedTxt}</span></div>
        <div class="drc-row"><span class="k">Resolved On</span><span class="v">${fmtDateTime(r.resolvedAt)}</span></div>
        <div class="drc-row"><span class="k">Total Time</span><span class="v">${totalTime}</span></div>
        ${r.block ? `<div class="drc-row"><span class="k">Block</span><span class="v">#${r.block}</span></div>` : ''}
        ${r.note ? `<div style="margin-top:8px;padding:8px 10px;background:rgba(0,0,0,0.22);border-radius:9px;font-size:11px;color:#c9d3e7;font-style:italic;">"${esc(r.note)}"</div>` : ''}
        ${tx ? `<div class="drc-row" style="margin-top:8px;"><span class="k">Transaction Hash</span><span class="v" style="font-family:monospace;font-size:9.5px;">${esc(String(tx).slice(0,10))}…${esc(String(tx).slice(-6))}</span></div>
          <a class="drc-btn drc-btn-ghost" href="${EXPLORER}/tx/${tx}" target="_blank" rel="noopener" style="width:100%;margin-top:6px;text-decoration:none;"><i class="fas fa-arrow-up-right-from-square"></i>View on Explorer</a>` : ''}
      </div>`;
    }

    // Pending settlement — a full on-chain outcome was agreed but the CLIENT must
    // execute the escrow transfer (contract owner check). Shown until funds move.
    const pr = drc.pendingResolution;
    if (pr) {
      const label = pr.onchainOutcome === 'contractor' ? 'Release 100% to Contractor' : pr.onchainOutcome === 'client' ? 'Refund 100% to Client' : 'Agreed Settlement';
      const amClient = me.key === 'client';
      return `
      <div class="drc-panel" style="border-color:rgba(251,191,36,0.32);background:rgba(251,191,36,0.05);">
        <h4 style="color:#fbbf24;"><i class="fas fa-hourglass-half"></i>Settlement Pending Execution</h4>
        <div style="font-size:12px;color:#e6ecfb;font-weight:700;margin-bottom:6px;">${label}</div>
        <p style="font-size:10.5px;color:#8aaac8;line-height:1.5;margin:0 0 10px;">
          The parties agreed on this outcome. Only the <strong style="color:#60b4ff;">Client</strong> wallet can broadcast the on-chain escrow transfer.</p>
        ${pr.note ? `<div style="font-size:10.5px;color:#c9d3e7;font-style:italic;margin-bottom:10px;">"${esc(pr.note)}"</div>` : ''}
        ${amClient
          ? `<button class="drc-btn drc-btn-primary" data-act="execPending" style="width:100%;"><i class="fas fa-arrow-up-from-bracket"></i>Execute Settlement On-Chain</button>`
          : `<div style="font-size:10.5px;color:#fbbf24;"><i class="fas fa-clock mr-1"></i>Awaiting the Client to execute the on-chain transfer.</div>`}
      </div>`;
    }

    // Active dispute — finalization actions (execute on-chain via existing escrow fns)
    if (me.key === 'observer') return '';
    return `
    <div class="drc-panel" style="border-color:rgba(251,191,36,0.22);">
      <h4 style="color:#fbbf24;"><i class="fas fa-flag-checkered"></i>Finalize Dispute</h4>
      <p style="font-size:10.5px;color:#8aaac8;line-height:1.5;margin:0 0 10px;">
        The Client can execute the on-chain escrow transfer directly. Reaching a mutual agreement or an accepted proposal is recommended first.</p>
      ${me.key === 'client' ? `
        <div style="display:flex;flex-direction:column;gap:7px;">
          <button class="drc-btn drc-btn-green" data-act="finalize" data-outcome="contractor" style="width:100%;justify-content:flex-start;"><i class="fas fa-arrow-right"></i>Release Funds → Contractor</button>
          <button class="drc-btn drc-btn-red" data-act="finalize" data-outcome="client" style="width:100%;justify-content:flex-start;"><i class="fas fa-undo"></i>Refund → Client</button>
        </div>
        <div style="height:1px;background:rgba(255,255,255,0.06);margin:10px 0;"></div>` : ''}
      <button class="drc-btn drc-btn-amber" data-act="mutualAgree" style="width:100%;"><i class="fas fa-handshake"></i>Approve Mutual Agreement</button>
      ${mutualState(id, c)}
    </div>`;
  }

  function mutualState(id, c) {
    const dsp = getDispute(id) || {};
    const ap = dsp.mutualApproval || {};
    if (!c) return '';
    const clientOk = ap[(c.client || '').toLowerCase()];
    const contrOk  = ap[(c.contractor || '').toLowerCase()];
    if (!clientOk && !contrOk) return '';
    return `<div style="margin-top:8px;font-size:10px;color:#8aaac8;display:flex;gap:12px;">
      <span style="color:${clientOk?'#34d399':'#6f83ad'};"><i class="fas fa-${clientOk?'check-circle':'clock'}"></i> Client</span>
      <span style="color:${contrOk?'#34d399':'#6f83ad'};"><i class="fas fa-${contrOk?'check-circle':'clock'}"></i> Contractor</span></div>`;
  }

  function durationSince2(a, b) {
    let s = Math.max(0, Math.floor((b - a) / 1000));
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600);  s -= h * 3600;
    const m = Math.floor(s / 60);
    return (d > 0 ? d + 'd ' : '') + (h > 0 ? h + 'h ' : '') + m + 'm';
  }

  // ── Timeline (Activity) ───────────────────────────────────────────────────
  function timelineHTML(id, c, dsp, drc) {
    const ev = [];
    if (c && c.createdAt)   ev.push({ ts: tsFromUnix(c.createdAt),   icon: 'fa-file-contract', color: '#60b4ff', title: 'Contract created' });
    if (c && Number(c.depositedValue) > 0) ev.push({ ts: tsFromUnix(c.createdAt) + 1, icon: 'fa-coins', color: '#fbbf24', title: 'Funds deposited into escrow' });
    if (c && c.startedAt)   ev.push({ ts: tsFromUnix(c.startedAt),   icon: 'fa-play', color: '#34d399', title: 'Service started (contract signed)' });
    if (c && c.completedAt) ev.push({ ts: tsFromUnix(c.completedAt), icon: 'fa-flag-checkered', color: '#34d399', title: 'Delivery completed' });
    if (dsp && dsp.openedAt) ev.push({ ts: dsp.openedAt, icon: 'fa-gavel', color: '#f87171', title: 'Dispute opened' });
    (drc.auditLog || []).forEach(a => {
      const m = auditToTimeline(a);
      if (m) ev.push({ ts: a.ts, icon: m.icon, color: m.color, title: m.title });
    });
    if (dsp && dsp.resolution) ev.push({ ts: dsp.resolution.resolvedAt, icon: 'fa-circle-check', color: '#34d399', title: 'Dispute resolved' });
    ev.sort((a, b) => a.ts - b.ts);

    return `
    <div class="drc-panel">
      <h4><i class="fas fa-timeline"></i>Activity Timeline</h4>
      <div class="drc-tl">
        ${ev.length ? ev.map(e => `
          <div class="drc-tl-item">
            <span class="drc-tl-dot" style="background:${e.color};box-shadow:0 0 8px ${e.color};"><i class="fas ${e.icon}"></i></span>
            <div style="font-size:11.5px;color:#dde2f0;font-weight:600;">${esc(e.title)}</div>
            <div style="font-size:9.5px;color:#6f83ad;">${fmtDateTime(e.ts)}</div>
          </div>`).join('') : '<div style="font-size:11px;color:#5b6a8c;">No activity recorded yet.</div>'}
      </div>
    </div>`;
  }
  function auditToTimeline(a) {
    switch (a.action) {
      case 'message':        return { icon: 'fa-comment', color: '#60b4ff', title: 'New message sent' };
      case 'evidence':       return { icon: 'fa-paperclip', color: '#38bdf8', title: 'Evidence submitted' };
      case 'proposal':       return { icon: 'fa-handshake', color: '#fbbf24', title: 'Settlement proposal created' };
      case 'proposal_accept':return { icon: 'fa-check', color: '#34d399', title: 'Proposal accepted' };
      case 'proposal_reject':return { icon: 'fa-times', color: '#f87171', title: 'Proposal rejected' };
      case 'counter':        return { icon: 'fa-rotate', color: '#fbbf24', title: 'Counter offer sent' };
      case 'arb_request':    return { icon: 'fa-gavel', color: '#a78bfa', title: 'Arbitration requested' };
      case 'arb_approve':    return { icon: 'fa-check-double', color: '#a78bfa', title: 'Arbitration approved' };
      case 'arb_start':      return { icon: 'fa-scale-balanced', color: '#a78bfa', title: 'Arbitration started' };
      case 'arb_appoint':    return { icon: 'fa-user-plus', color: '#a78bfa', title: 'Arbitrator appointed' };
      case 'arb_decision':   return { icon: 'fa-gavel', color: '#a78bfa', title: 'Arbitrator issued a decision' };
      case 'arb_request_more':return { icon: 'fa-circle-question', color: '#a78bfa', title: 'Arbitrator requested more information' };
      default: return null;
    }
  }

  // ── Audit log panel ─────────────────────────────────────────────────────────
  function auditHTML(drc) {
    const log = (drc.auditLog || []).slice().reverse().slice(0, 40);
    if (!log.length) return '';
    return `
    <div class="drc-panel">
      <h4><i class="fas fa-clipboard-list"></i>Audit Log</h4>
      <div style="max-height:180px;overflow-y:auto;">
        ${log.map(a => `<div style="font-size:10px;color:#8aaac8;padding:5px 0;border-bottom:1px solid rgba(96,180,255,0.07);display:flex;justify-content:space-between;gap:8px;">
          <span><i class="fas fa-circle" style="font-size:5px;color:#60b4ff;margin-right:5px;vertical-align:middle;"></i>${esc(prettyAction(a.action))} · <span style="color:#6f83ad;">${a.role || '—'}</span></span>
          <span style="color:#5b6a8c;white-space:nowrap;">${fmtTime(a.ts)}</span>
        </div>`).join('')}
      </div>
    </div>`;
  }
  function prettyAction(a) {
    return ({
      message: 'Message sent', evidence: 'Evidence submitted', proposal: 'Proposal created',
      proposal_accept: 'Proposal accepted', proposal_reject: 'Proposal rejected', counter: 'Counter offer',
      arb_request: 'Arbitration requested', arb_approve: 'Arbitration approved', arb_start: 'Arbitration started',
      arb_appoint: 'Arbitrator appointed', arb_decision: 'Arbitrator decision', arb_request_more: 'Info requested',
      finalize: 'Dispute finalized', mutual: 'Mutual agreement',
    })[a] || a;
  }

  // ── Unread helpers ─────────────────────────────────────────────────────────
  function unreadCount(id) {
    const d = drcGet(id); const w = (wallet() || '').toLowerCase(); if (!w) return 0;
    return (d.messages || []).filter(m => (m.wallet || '').toLowerCase() !== w && !(m.readBy && m.readBy[w])).length;
  }
  function pendingForMe(id, me) {
    if (me.key !== 'client' && me.key !== 'contractor') return 0;
    const w = (wallet() || '').toLowerCase();
    return (drcGet(id).proposals || []).filter(p => p.status === 'pending' && (p.wallet || '').toLowerCase() !== w).length;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // EVENT HANDLERS (delegation)
  // ══════════════════════════════════════════════════════════════════════════
  let _pendingMsgFiles = [];
  function onClick(e) {
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const act = btn.getAttribute('data-act');
    const id = drcCurrentId;
    switch (act) {
      case 'close': closeCenter(); break;
      case 'tab': drcActiveTab = btn.getAttribute('data-tab'); _pendingMsgFiles = []; markRead(id); render(); break;
      case 'send': sendMessage(); break;
      case 'pickMsgFile': document.getElementById('drc-msg-file')?.click(); break;
      case 'pickEvFile': document.getElementById('drc-ev-file')?.click(); break;
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
      case 'execPending': executePending(drcCurrentId); break;
      case 'mutualAgree': mutualAgree(); break;
    }
  }
  function onChange(e) {
    if (e.target.id === 'drc-msg-file') { queueMsgFiles(e.target.files); }
    else if (e.target.id === 'drc-ev-file') { uploadEvidence(e.target.files); }
  }

  // ── Chat actions ────────────────────────────────────────────────────────────
  async function queueMsgFiles(files) {
    for (const f of Array.from(files)) {
      if (f.size > DRC_MAX_FILE) { toast(`${f.name} exceeds 10 MB.`, 'error'); continue; }
      if (_pendingMsgFiles.length >= 4) { toast('Up to 4 attachments per message.', 'warning'); break; }
      try { _pendingMsgFiles.push(await readFile(f)); } catch (_) { toast('Failed to read ' + f.name, 'error'); }
    }
    renderMsgAtts();
  }
  function renderMsgAtts() {
    const wrap = document.getElementById('drc-msg-atts'); if (!wrap) return;
    wrap.innerHTML = _pendingMsgFiles.map((a, i) => `
      <span style="display:inline-flex;align-items:center;gap:6px;padding:5px 9px;border-radius:8px;background:rgba(96,180,255,0.09);border:1px solid rgba(96,180,255,0.2);font-size:10.5px;color:#c9d3e7;">
        <i class="fas ${kindIcon(a.kind)}"></i>${esc(a.name)} <span style="color:#6f83ad;">${humanSize(a.size)}</span>
        <i class="fas fa-times" style="cursor:pointer;color:#f87171;" onclick="window.__drcRmAtt(${i})"></i></span>`).join('');
  }
  window.__drcRmAtt = function (i) { _pendingMsgFiles.splice(i, 1); renderMsgAtts(); };

  function sendMessage() {
    const id = drcCurrentId;
    const c = getContract(id);
    const me = roleOf(c, wallet());
    if (me.key === 'observer') { toast('Only participants can send messages.', 'error'); return; }
    const inp = document.getElementById('drc-msg-input');
    const text = (inp ? inp.value : '').trim();
    if (!text && !_pendingMsgFiles.length) { toast('Type a message or attach a file.', 'warning'); return; }
    const d = drcGet(id);
    d.messages = d.messages || [];
    d.messages.push({
      wallet: wallet(), role: me.key, text, ts: Date.now(),
      attachments: _pendingMsgFiles.slice(), readBy: { [(wallet() || '').toLowerCase()]: true },
    });
    if (!drcSave(id, d)) return;
    drcAudit(id, 'message', text.slice(0, 60));
    _pendingMsgFiles = [];
    notify(id, 'New Message', `${me.label} sent a message.`);
    render();
  }

  // ── Evidence actions ─────────────────────────────────────────────────────────
  async function uploadEvidence(files) {
    const id = drcCurrentId; const c = getContract(id); const me = roleOf(c, wallet());
    if (me.key === 'observer') { toast('Only participants can upload evidence.', 'error'); return; }
    const prog = document.getElementById('drc-ev-progress');
    if (prog) { prog.style.display = 'block'; }
    const arr = Array.from(files); let done = 0;
    const d = drcGet(id); d.evidence = d.evidence || [];
    for (const f of arr) {
      if (f.size > DRC_MAX_FILE) { toast(`${f.name} exceeds 10 MB.`, 'error'); continue; }
      try {
        const fo = await readFile(f);
        let hash = null;
        try { if (typeof window.cfHashFile === 'function') hash = await window.cfHashFile(f); } catch (_) {}
        d.evidence.push(Object.assign(fo, { role: me.key, wallet: wallet(), ts: Date.now(), hash: hash || 'n/a' }));
      } catch (_) { toast('Failed to read ' + f.name, 'error'); }
      done++;
      if (prog) prog.firstElementChild.style.width = Math.round((done / arr.length) * 100) + '%';
    }
    if (!drcSave(id, d)) return;
    drcAudit(id, 'evidence', arr.map(f => f.name).join(', ').slice(0, 60));
    notify(id, 'New Evidence Submitted', `${me.label} uploaded ${arr.length} file(s).`);
    setTimeout(() => render(), 250);
  }

  function getFileRef(btn) {
    const id = drcCurrentId; const d = drcGet(id);
    const scope = btn.getAttribute('data-scope');
    if (scope === 'ev') return (d.evidence || [])[+btn.getAttribute('data-i')];
    if (scope === 'msg') { const m = (d.messages || [])[+btn.getAttribute('data-mi')]; return m && (m.attachments || [])[+btn.getAttribute('data-ai')]; }
    return null;
  }
  function viewFile(btn) {
    const f = getFileRef(btn); if (!f || !f.url) { toast('File not available.', 'error'); return; }
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:9995;background:rgba(0,0,0,0.92);backdrop-filter:blur(4px);display:flex;flex-direction:column;';
    let content;
    if (f.kind === 'image') content = `<div style="flex:1;display:flex;align-items:center;justify-content:center;padding:16px;overflow:auto;"><img src="${f.url}" style="max-width:100%;max-height:calc(100vh - 90px);object-fit:contain;border-radius:10px;"></div>`;
    else if (f.kind === 'pdf') content = `<div style="flex:1;padding:8px 16px;"><iframe src="${f.url}" sandbox="allow-scripts" style="width:100%;height:calc(100vh - 90px);border:none;border-radius:10px;background:#fff;"></iframe></div>`;
    else if (f.kind === 'video') content = `<div style="flex:1;display:flex;align-items:center;justify-content:center;padding:16px;"><video src="${f.url}" controls style="max-width:100%;max-height:calc(100vh - 90px);border-radius:10px;"></video></div>`;
    else content = `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;color:#c9d3e7;">
      <i class="fas ${kindIcon(f.kind)}" style="font-size:52px;color:#60b4ff;"></i><div style="font-weight:700;">${esc(f.name)}</div>
      <a href="${f.url}" download="${esc(f.name)}" class="drc-btn drc-btn-primary" style="text-decoration:none;"><i class="fas fa-download"></i>Download</a></div>`;
    ov.innerHTML = `<div style="display:flex;align-items:center;gap:10px;padding:13px 18px;background:rgba(10,12,24,0.95);border-bottom:1px solid rgba(96,180,255,0.15);">
        <div style="flex:1;min-width:0;"><div style="font-size:13px;font-weight:700;color:#e6ecfb;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(f.name)}</div>
        <div style="font-size:10px;color:#6f83ad;">${(f.kind||'file').toUpperCase()} · ${humanSize(f.size)}</div></div>
        <a href="${f.url}" download="${esc(f.name)}" class="drc-x" style="text-decoration:none;"><i class="fas fa-download"></i></a>
        <button class="drc-x" id="drc-fv-x"><i class="fas fa-times"></i></button></div>${content}`;
    ov.addEventListener('click', (e) => { if (e.target === ov || e.target.closest('#drc-fv-x')) ov.remove(); });
    document.body.appendChild(ov);
  }
  function dlFile(btn) {
    const f = getFileRef(btn); if (!f || !f.url) { toast('File not available.', 'error'); return; }
    const a = document.createElement('a'); a.href = f.url; a.download = f.name || 'evidence'; a.click();
  }

  // ── Proposal actions ─────────────────────────────────────────────────────────
  let _tpl = null;
  function selectTemplate(btn) {
    const key = btn.getAttribute('data-tpl');
    _tpl = PROPOSAL_TEMPLATES.find(t => t.key === key);
    document.querySelectorAll('#drc-prop-templates .drc-chip').forEach(el => el.classList.remove('sel'));
    btn.classList.add('sel');
    const custom = document.getElementById('drc-prop-custom');
    if (custom) {
      custom.style.display = key === 'custom' ? 'block' : 'none';
      if (key !== 'custom') {
        const rel = document.getElementById('drc-prop-rel'); const ref = document.getElementById('drc-prop-ref');
        if (rel) rel.value = _tpl.rel; if (ref) ref.value = _tpl.ref;
      }
    }
  }
  function createProposal() {
    const id = drcCurrentId; const c = getContract(id); const me = roleOf(c, wallet());
    if (me.key !== 'client' && me.key !== 'contractor') { toast('Only parties can create proposals.', 'error'); return; }
    if (!_tpl) { toast('Select a proposal type first.', 'warning'); return; }
    let rel, ref;
    if (_tpl.key === 'custom') {
      rel = Math.min(100, Math.max(0, parseInt(document.getElementById('drc-prop-rel')?.value || '0', 10)));
      ref = 100 - rel;
    } else { rel = _tpl.rel; ref = _tpl.ref; }
    const note = (document.getElementById('drc-prop-note')?.value || '').trim();
    const d = drcGet(id); d.proposals = d.proposals || [];
    d.proposals.push({ wallet: wallet(), role: me.key, rel, ref, note, ts: Date.now(), status: 'pending' });
    if (!drcSave(id, d)) return;
    drcAudit(id, 'proposal', `${rel}% release / ${ref}% refund`);
    _tpl = null;
    notify(id, 'New Settlement Proposal', `${me.label} proposed ${rel}% release / ${ref}% refund.`);
    drcActiveTab = 'proposals'; render();
  }
  async function respondProposal(idx, action) {
    const id = drcCurrentId; const c = getContract(id); const me = roleOf(c, wallet());
    const d = drcGet(id); const p = (d.proposals || [])[idx]; if (!p || p.status !== 'pending') return;
    if ((p.wallet || '').toLowerCase() === (wallet() || '').toLowerCase()) { toast('You cannot respond to your own proposal.', 'warning'); return; }

    if (action === 'accept') {
      if (!confirm(`Accept this settlement?\n\nRelease ${p.rel}% to Contractor · Refund ${p.ref}% to Client.\n\nThis will finalize the dispute.`)) return;
      p.status = 'accepted'; p.respondedBy = wallet(); p.respondedAt = Date.now();
      drcSave(id, d);
      drcAudit(id, 'proposal_accept', `${p.rel}% / ${p.ref}%`);
      notify(id, 'Proposal Accepted', `Settlement of ${p.rel}% release / ${p.ref}% refund accepted.`);
      // Route to on-chain execution (client) or pending settlement (other party)
      const outcome = p.rel === 100 ? 'contractor' : p.ref === 100 ? 'client' : 'mutual';
      await settle(id, outcome, {
        method: 'mutual_agreement', note: `Accepted settlement: ${p.rel}% release / ${p.ref}% refund.` + (p.note ? ` — ${p.note}` : ''),
        split: { rel: p.rel, ref: p.ref }, resolvedBy: 'both_parties',
      });
    } else if (action === 'reject') {
      p.status = 'rejected'; p.respondedBy = wallet(); p.respondedAt = Date.now();
      drcSave(id, d); drcAudit(id, 'proposal_reject', `${p.rel}% / ${p.ref}%`);
      notify(id, 'Proposal Rejected', `${me.label} rejected the settlement proposal.`);
      render();
    } else if (action === 'counter') {
      p.status = 'countered'; p.respondedBy = wallet(); p.respondedAt = Date.now();
      drcSave(id, d); drcAudit(id, 'counter', `counter to ${p.rel}%/${p.ref}%`);
      _tpl = { key: 'custom', rel: p.ref, ref: p.rel }; // pre-suggest mirrored split
      notify(id, 'Counter Offer', `${me.label} is preparing a counter offer.`);
      drcActiveTab = 'proposals'; render();
      setTimeout(() => {
        const custom = document.getElementById('drc-prop-custom'); const rel = document.getElementById('drc-prop-rel'); const ref = document.getElementById('drc-prop-ref');
        if (custom) custom.style.display = 'block';
        if (rel) rel.value = p.ref; if (ref) ref.value = p.rel;
        document.querySelectorAll('#drc-prop-templates .drc-chip').forEach(el => { if (el.getAttribute('data-tpl') === 'custom') el.classList.add('sel'); });
        document.getElementById('drc-prop-note')?.focus();
      }, 60);
    }
  }

  // ── Arbitration actions ───────────────────────────────────────────────────
  function requestArbitration() {
    const id = drcCurrentId; const c = getContract(id); const me = roleOf(c, wallet());
    if (me.key !== 'client' && me.key !== 'contractor') { toast('Only parties can request arbitration.', 'error'); return; }
    const d = drcGet(id);
    d.arbitration = d.arbitration || { requested: {}, started: false, arbitrator: null };
    d.arbitration.requested = d.arbitration.requested || {};
    d.arbitration.requested[(wallet() || '').toLowerCase()] = true;
    drcSave(id, d);
    drcAudit(id, 'arb_request', '');
    checkArbStart(id, c);
    notify(id, 'Arbitration Started', `${me.label} requested arbitration.`);
    render();
  }
  function approveArbitration() {
    const id = drcCurrentId; const c = getContract(id); const me = roleOf(c, wallet());
    if (me.key !== 'client' && me.key !== 'contractor') { toast('Only parties can approve arbitration.', 'error'); return; }
    const d = drcGet(id);
    d.arbitration.requested[(wallet() || '').toLowerCase()] = true;
    drcSave(id, d);
    drcAudit(id, 'arb_approve', '');
    checkArbStart(id, c);
    render();
  }
  function checkArbStart(id, c) {
    const d = drcGet(id); const ap = d.arbitration.requested || {};
    if (c && ap[(c.client || '').toLowerCase()] && ap[(c.contractor || '').toLowerCase()] && !d.arbitration.started) {
      d.arbitration.started = true; d.arbitration.startedAt = Date.now();
      drcSave(id, d); drcAudit(id, 'arb_start', '');
      toast('Arbitration started — appoint a neutral arbitrator.', 'info');
    }
  }
  function appointArbitrator() {
    const id = drcCurrentId; const c = getContract(id); const me = roleOf(c, wallet());
    if (me.key !== 'client' && me.key !== 'contractor') { toast('Only parties can appoint an arbitrator.', 'error'); return; }
    const val = (document.getElementById('drc-arb-value')?.value || '').trim();
    if (!val) { toast('Enter a wallet address or username.', 'warning'); return; }
    const isWallet = /^0x[a-fA-F0-9]{40}$/.test(val);
    if (isWallet && c && (val.toLowerCase() === (c.client || '').toLowerCase() || val.toLowerCase() === (c.contractor || '').toLowerCase())) {
      toast('The arbitrator must be a neutral third party.', 'error'); return;
    }
    const d = drcGet(id);
    d.arbitration.arbitrator = { type: isWallet ? 'wallet' : 'user', value: val, name: val, assignedAt: Date.now(), assignedBy: wallet() };
    drcSave(id, d);
    drcAudit(id, 'arb_appoint', isWallet ? shortAddr(val) : val);
    notify(id, 'Assigned Arbitrator', `A ${isWallet ? 'wallet' : 'user'} arbitrator has been appointed.`);
    render();
  }
  function copyArbLink() {
    const id = drcCurrentId;
    const url = `${location.origin}${location.pathname}?dispute=${id}`;
    try { navigator.clipboard.writeText(url); toast('Arbitrator access link copied to clipboard.', 'success'); }
    catch (_) { toast(url, 'info'); }
  }
  async function arbitratorDecide(outcome) {
    const id = drcCurrentId; const c = getContract(id); const me = roleOf(c, wallet());
    if (me.key !== 'arbitrator') { toast('Only the assigned arbitrator can decide.', 'error'); return; }
    const note = (document.getElementById('drc-arb-note')?.value || '').trim();
    let split = null, out = outcome;
    if (outcome === 'split') {
      const rel = Math.min(100, Math.max(0, parseInt(document.getElementById('drc-arb-rel')?.value || '50', 10)));
      split = { rel, ref: 100 - rel };
      out = rel === 100 ? 'contractor' : rel === 0 ? 'client' : 'mutual';
    }
    const label = out === 'contractor' ? 'Release 100% to Contractor' : out === 'client' ? 'Refund 100% to Client' : `Split ${split ? split.rel : ''}%/${split ? split.ref : ''}%`;
    if (!confirm(`Issue binding decision:\n\n${label}\n\nThis finalizes the dispute.`)) return;
    drcAudit(id, 'arb_decision', label);
    notify(id, 'Arbitration Decision', label);
    await settle(id, out, { method: 'arbitration', note: note || `Arbitrator decision: ${label}.`, split, resolvedBy: wallet() });
  }
  function arbitratorRequestMore(what) {
    const id = drcCurrentId; const me = roleOf(getContract(id), wallet());
    if (me.key !== 'arbitrator') return;
    const d = drcGet(id); d.messages = d.messages || [];
    const text = what === 'evidence'
      ? 'The arbitrator requests additional supporting evidence from both parties.'
      : 'The arbitrator requests additional information/clarification from both parties.';
    d.messages.push({ wallet: wallet(), role: 'arbitrator', text, ts: Date.now(), attachments: [], readBy: { [(wallet() || '').toLowerCase()]: true } });
    drcSave(id, d); drcAudit(id, 'arb_request_more', what);
    notify(id, 'System Notification', text);
    drcActiveTab = 'messages'; render();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SETTLEMENT ENGINE — executes real fund movement via the EXISTING escrow
  // functions (completeMilestone → release to contractor, cancelContract →
  // refund to client). No ABI/contract change. Full structured logging, on-chain
  // simulation (staticCall), gas estimation, receipt verification — no silent errors.
  // ══════════════════════════════════════════════════════════════════════════
  function drcLog(stage, obj) {
    try { console.log('%c[DRC-TX] ' + stage, 'color:#a78bfa;font-weight:bold', obj || {}); } catch (_) {}
  }

  function afterSettle(id) {
    // Refresh Contracts / Status / Timeline / Unified Balance / Balances / History
    try { if (typeof window.cfLoadContracts === 'function') setTimeout(() => window.cfLoadContracts({ force: true }), 1200); } catch (_) {}
    try { if (typeof window.ubRefresh === 'function') setTimeout(window.ubRefresh, 2500); } catch (_) {}
    try { if (typeof window.refreshSwapBalances === 'function') setTimeout(window.refreshSwapBalances, 2600); } catch (_) {}
    try { if (typeof window.loadSwapHistory === 'function') setTimeout(window.loadSwapHistory, 2700); } catch (_) {}
    try { document.dispatchEvent(new CustomEvent('drc:settled', { detail: { contractId: id } })); } catch (_) {}
  }

  async function executeOnChainSettlement(id, c, outcome, split) {
    const total = c ? c.totalValue : '0';
    const base = {
      wallet: wallet(), contractId: id, disputeId: 'DISP-' + String(id).padStart(4, '0'),
      settlementType: outcome, split: split || null, amount: fmtUsdc(BigInt(total || 0)), token: 'USDC',
      tokenAddress: window.CF_USDC_ADDR || '', chain: window.CF_CHAIN_ID || 5042002,
      contractAddress: window.CF_FACTORY_ADDR || '',
    };
    drcLog('settlement:start', base);
    if (window.cfState && window.cfState.pending) { toast('Please wait for the current transaction to finish.', 'warning'); return { ok: false, error: 'busy' }; }
    if (typeof window.cfInitProvider !== 'function') { drcLog('settlement:error', { stage: 'init', error: 'cfInitProvider unavailable' }); toast('On-chain module unavailable.', 'error'); return { ok: false, error: 'init_unavailable' }; }

    if (window.cfState) window.cfState.pending = true;
    try {
      const init = await window.cfInitProvider();
      if (!init.ok) { drcLog('settlement:error', Object.assign({}, base, { stage: 'provider', code: init.error, error: init.message })); toast('❌ ' + init.message, 'error'); return { ok: false, error: init.message, stage: 'provider' }; }
      drcLog('settlement:provider', { method: 'connect', address: init.address, chain: base.chain, factory: base.contractAddress });

      if ((c.client || '').toLowerCase() !== (init.address || '').toLowerCase()) {
        const reason = 'Only the Client wallet can execute this on-chain settlement (escrow owner check).';
        drcLog('settlement:needsClient', { expectedClient: c.client, connected: init.address });
        toast('⚠️ ' + reason, 'warning');
        return { ok: false, needsClient: true, reason };
      }

      const factory = init.factory;

      if (outcome === 'contractor') {
        const ms = c.milestones || [];
        const pending = ms.map((m, i) => ({ m, i })).filter(x => (x.m.status || '') !== 'Released');
        if (!pending.length) { toast('No pending milestones to release.', 'warning'); drcLog('settlement:noop', { reason: 'no pending milestones' }); return { ok: false, error: 'no_pending' }; }
        let last = null;
        for (const { i } of pending) {
          drcLog('settlement:simulate', { method: 'completeMilestone', params: [id, i] });
          try { await factory.completeMilestone.staticCall(id, i); }
          catch (sig) { const reason = sig.reason || sig.shortMessage || sig.message; drcLog('settlement:revert', { method: 'completeMilestone', milestone: i, reason }); toast('❌ Simulation reverted: ' + reason, 'error'); return { ok: false, error: reason, stage: 'simulate' }; }
          let gas = null; try { gas = await factory.completeMilestone.estimateGas(id, i); } catch (_) {}
          drcLog('settlement:broadcast', { method: 'completeMilestone', milestone: i, gas: gas ? gas.toString() : 'auto' });
          toast(`📝 Release milestone ${i + 1} → contractor — confirm in wallet…`, 'info');
          const tx = await factory.completeMilestone(id, i);
          drcLog('settlement:signature', { method: 'completeMilestone', milestone: i, hash: tx.hash });
          try { if (typeof window.cfLogTx === 'function') window.cfLogTx('disputeRelease', tx.hash, id, { milestoneIdx: i, settlement: outcome }); } catch (_) {}
          const rc = await tx.wait(1);
          if (!rc || rc.status !== 1) { drcLog('settlement:failure', { hash: tx.hash, milestone: i, status: rc && rc.status }); toast('❌ Transaction reverted on-chain.', 'error'); return { ok: false, error: 'reverted', txHash: tx.hash }; }
          drcLog('settlement:receipt', { hash: tx.hash, block: rc.blockNumber, milestone: i, eventLogs: (rc.logs || []).length, success: true });
          last = { hash: tx.hash, block: rc.blockNumber };
        }
        toast('✅ Funds released to contractor on-chain.', 'success');
        afterSettle(id);
        return { ok: true, onChain: true, txHash: last.hash, block: last.block };
      }

      // outcome === 'client' → refund via cancelContract
      drcLog('settlement:simulate', { method: 'cancelContract', params: [id] });
      try { await factory.cancelContract.staticCall(id); }
      catch (sig) {
        const reason = sig.reason || sig.shortMessage || sig.message;
        drcLog('settlement:revert', { method: 'cancelContract', reason });
        toast('❌ Refund simulation reverted: ' + reason + ' — the escrow may not permit a refund in the current state.', 'error');
        return { ok: false, error: reason, stage: 'simulate' };
      }
      let gas = null; try { gas = await factory.cancelContract.estimateGas(id); } catch (_) {}
      drcLog('settlement:broadcast', { method: 'cancelContract', gas: gas ? gas.toString() : 'auto' });
      toast('📝 Refund to client — confirm in wallet…', 'info');
      const tx = await factory.cancelContract(id);
      drcLog('settlement:signature', { method: 'cancelContract', hash: tx.hash });
      try { if (typeof window.cfLogTx === 'function') window.cfLogTx('disputeRefund', tx.hash, id, { settlement: outcome }); } catch (_) {}
      const rc = await tx.wait(1);
      if (!rc || rc.status !== 1) { drcLog('settlement:failure', { hash: tx.hash, status: rc && rc.status }); toast('❌ Refund reverted on-chain.', 'error'); return { ok: false, error: 'reverted', txHash: tx.hash }; }
      drcLog('settlement:receipt', { hash: tx.hash, block: rc.blockNumber, eventLogs: (rc.logs || []).length, success: true });
      toast('✅ Funds refunded to client on-chain.', 'success');
      afterSettle(id);
      return { ok: true, onChain: true, txHash: tx.hash, block: rc.blockNumber };
    } catch (err) {
      const rej = err && (err.code === 4001 || err.code === 'ACTION_REJECTED');
      const reason = (err && (err.reason || err.shortMessage || err.message)) || 'Unknown error';
      drcLog('settlement:exception', Object.assign({}, base, { code: err && err.code, reason, stack: (err && err.stack || '').slice(0, 240), success: false }));
      toast(rej ? 'Transaction rejected in wallet.' : '❌ Settlement failed: ' + reason, rej ? 'warning' : 'error');
      return { ok: false, error: reason, rejected: rej };
    } finally {
      if (window.cfState) window.cfState.pending = false;
    }
  }

  // Central dispatcher: decides between real on-chain execution and recorded settlement.
  async function settle(id, outcome, opts) {
    opts = opts || {};
    const c = getContract(id); const me = roleOf(c, wallet());
    const mode = (getMeta(id) || {}).mode || 'onchain';
    const split = opts.split || null;

    // Normalise mutual/full splits to a concrete on-chain outcome
    let onchainOutcome = outcome;
    if (outcome === 'mutual' && split) {
      if (split.rel === 100) onchainOutcome = 'contractor';
      else if (split.rel === 0) onchainOutcome = 'client';
    }
    const isFullOnChain = (mode === 'onchain') && (onchainOutcome === 'contractor' || onchainOutcome === 'client');

    if (!isFullOnChain) {
      // Off-chain / custodial contract OR partial split → record settlement (no escrowed
      // on-chain funds to move / immutable escrow cannot split). Logged, never silent.
      drcLog('settlement:recorded', { contractId: id, outcome, mode, split, reason: mode !== 'onchain' ? 'off-chain/custodial contract' : 'partial split unsupported by immutable escrow' });
      finalizeWrite(id, outcome, Object.assign({ onChain: false }, opts));
      if (mode === 'onchain' && split && split.rel !== 100 && split.rel !== 0) {
        toast('Settlement recorded. Note: the on-chain escrow cannot execute a partial split automatically.', 'warning');
      }
      return;
    }

    if (me.key === 'client') {
      const res = await executeOnChainSettlement(id, c, onchainOutcome, split);
      if (res.ok) {
        finalizeWrite(id, outcome, Object.assign({ onChain: true, txHash: res.txHash, block: res.block }, opts));
      } else if (res.needsClient) {
        recordPendingResolution(id, { outcome, onchainOutcome, split, note: opts.note, method: opts.method });
      } // else: error already surfaced + logged; leave dispute open for retry
      render();
      return;
    }

    // A non-client party (contractor accepting / arbitrator deciding) agreed to a full
    // on-chain outcome — only the Client wallet can broadcast the escrow transfer.
    recordPendingResolution(id, { outcome, onchainOutcome, split, note: opts.note, method: opts.method, by: me.key });
    toast('Settlement agreed — awaiting the Client to execute the on-chain transfer.', 'info');
    render();
  }

  function recordPendingResolution(id, intent) {
    const d = drcGet(id);
    d.pendingResolution = Object.assign({ ts: Date.now(), requestedBy: wallet() }, intent);
    drcSave(id, d);
    drcAudit(id, 'finalize', 'settlement pending client on-chain execution');
  }

  async function executePending(id) {
    const c = getContract(id); const me = roleOf(c, wallet());
    if (me.key !== 'client') { toast('Only the Client can execute the on-chain settlement.', 'error'); return; }
    const pr = drcGet(id).pendingResolution;
    if (!pr) { toast('No pending settlement found.', 'warning'); return; }
    const res = await executeOnChainSettlement(id, c, pr.onchainOutcome, pr.split);
    if (res.ok) {
      finalizeWrite(id, pr.outcome, { onChain: true, txHash: res.txHash, block: res.block, method: pr.method || 'settlement', note: pr.note || '', split: pr.split, resolvedBy: 'both_parties' });
    }
    render();
  }

  // ── Finalize buttons (Client — executes the real on-chain escrow transfer) ────
  async function finalize(outcome) {
    const id = drcCurrentId; const c = getContract(id); const me = roleOf(c, wallet());
    if (me.key !== 'client') { toast('A full release/refund can only be executed by the Client wallet (escrow rules).', 'error'); return; }
    const label = outcome === 'contractor' ? 'Release 100% to Contractor' : 'Refund 100% to Client';
    if (!confirm(`Finalize dispute — ${label}?\n\nThis executes the on-chain escrow transfer and requires a wallet signature.`)) return;
    drcAudit(id, 'finalize', label);
    await settle(id, outcome, { method: 'manual_client', note: 'Resolved by client decision.', resolvedBy: wallet() });
  }

  function mutualAgree() {
    const id = drcCurrentId; const c = getContract(id); const me = roleOf(c, wallet());
    if (me.key !== 'client' && me.key !== 'contractor') { toast('Only parties can approve.', 'error'); return; }
    const dsp = getDispute(id) || {};
    const ap = dsp.mutualApproval || {};
    ap[(wallet() || '').toLowerCase()] = true;
    const bothOk = c && ap[(c.client || '').toLowerCase()] && ap[(c.contractor || '').toLowerCase()];
    if (bothOk) {
      setDispute(id, { mutualApproval: ap });
      finalizeWrite(id, 'mutual', { method: 'mutual_agreement', note: 'Mutual agreement reached.', resolvedBy: 'both_parties', onChain: false });
      drcAudit(id, 'mutual', 'both parties approved');
      notify(id, 'Proposal Accepted', 'Mutual agreement confirmed — dispute resolved.');
    } else {
      setDispute(id, { mutualApproval: ap });
      drcAudit(id, 'mutual', 'awaiting counterparty');
      toast('Approval recorded — awaiting the counterparty.', 'info');
    }
    render();
  }

  // Writes resolution in the EXACT shape legacy code reads (arc_cf_disputes_v1 + meta),
  // now enriched with on-chain proof (txHash/block). Fully backward compatible.
  function finalizeWrite(id, outcome, opts) {
    opts = opts || {};
    setDispute(id, {
      status: 'resolved',
      resolution: {
        outcome, note: opts.note || '', resolvedBy: opts.resolvedBy || wallet(),
        resolvedAt: Date.now(), method: opts.method || 'settlement',
        split: opts.split || null, onChain: !!opts.onChain, txHash: opts.txHash || null, block: opts.block || null,
      },
    });
    setMeta(id, {
      disputeResolvedAt: Date.now(),
      disputeOutcome: outcome,
      offchainStatus: outcome === 'contractor' ? 'confirmed' : outcome === 'client' ? 'refunded' : 'confirmed',
      disputeTxHash: opts.txHash || undefined,
    });
    try { if (typeof window.cfLogTx === 'function') window.cfLogTx('resolveDispute', opts.txHash || null, id, { outcome, method: opts.method, onChain: !!opts.onChain }); } catch (_) {}
    const dd = drcGet(id); if (dd.pendingResolution) { delete dd.pendingResolution; drcSave(id, dd); }
    drcLog('resolution:written', { contractId: id, outcome, onChain: !!opts.onChain, txHash: opts.txHash || null, block: opts.block || null });
    toast(opts.onChain ? 'Dispute resolved — funds transferred on-chain.' : 'Dispute resolved.', 'success');
    refreshContracts();
  }

  // ── Notifications (client-side; both parties see on next view) ───────────────
  function notify(id, title, body) {
    toast(`${title}: ${body}`, 'info');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // INTEGRATION — override entry points defensively (no legacy logic changed)
  // ══════════════════════════════════════════════════════════════════════════
  function install() {
    // 1) Route the existing "Resolve Dispute" button to the new center.
    try {
      if (typeof window.cfShowDisputeResolution === 'function' && !window.cfShowDisputeResolution._drc) {
        window._cfLegacyResolve = window.cfShowDisputeResolution;
      }
      const opener = function (contractId) { window.drcOpen(contractId); };
      opener._drc = true;
      window.cfShowDisputeResolution = opener;
    } catch (_) {}

    // 2) Inject a "Resolution Center" button on every disputed contract card.
    try {
      if (typeof window.cfRenderContracts === 'function' && !window.cfRenderContracts._drcWrapped) {
        const orig = window.cfRenderContracts;
        const wrapped = function () {
          const r = orig.apply(this, arguments);
          try { setTimeout(injectCardButtons, 0); } catch (_) {}
          return r;
        };
        wrapped._drcWrapped = true;
        window.cfRenderContracts = wrapped;
      }
    } catch (_) {}

    // 3) Arbitrator / deep-link access: ?dispute=<id>
    try {
      const params = new URLSearchParams(location.search);
      const did = params.get('dispute');
      if (did) {
        let tries = 0;
        const timer = setInterval(() => {
          tries++;
          const c = getContract(did);
          if (c && (window.walletState && window.walletState.address)) {
            clearInterval(timer);
            if (getDispute(did)) window.drcOpen(did);
          }
          if (tries > 40) clearInterval(timer);
        }, 500);
      }
    } catch (_) {}
  }

  function injectCardButtons() {
    document.querySelectorAll('[id^="cf-contract-"]').forEach(card => {
      const id = card.id.replace('cf-contract-', '');
      if (!getDispute(id)) return;                    // only disputed contracts
      if (card.querySelector('.drc-open-btn')) return; // avoid duplicates
      const dsp = getDispute(id);
      const resolved = dsp && dsp.status === 'resolved';
      const btn = document.createElement('button');
      btn.className = 'cf-action-btn drc-open-btn';
      btn.setAttribute('style', 'background:linear-gradient(135deg,rgba(37,99,235,0.18),rgba(124,58,237,0.16));border:1px solid rgba(124,58,237,0.4);color:#c4b5fd;');
      btn.innerHTML = `<i class="fas fa-scale-balanced mr-1.5"></i>${resolved ? 'View Resolution Center' : 'Open Resolution Center'}`;
      btn.addEventListener('click', (e) => { e.stopPropagation(); window.drcOpen(id); });
      // place into the action bar (last flex row) or append to card
      const bar = card.querySelector(':scope > div[style*="border-top"]') || card.lastElementChild;
      if (bar && bar.tagName === 'DIV') bar.appendChild(btn);
      else card.appendChild(btn);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
  // Re-assert overrides after other late scripts finish (belt & suspenders)
  setTimeout(install, 1200);

  console.log('%c[DRC] Dispute Resolution Center loaded', 'color:#a78bfa;font-weight:bold',
    '| chat · evidence · proposals · arbitration · audit | storage:', DRC_KEY);
})();
