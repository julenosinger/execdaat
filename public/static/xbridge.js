// ============================================================================
//  xbridge.js — ExecDaat Premium Bridge page (Circle CCTP V2)
// ----------------------------------------------------------------------------
//  Brand-new, 100% additive page. Reuses the EXISTING bridge engine
//  (window.ArcBridge — cross-chain-service.js): real chains, quotes, balances,
//  approval + burn + attestation + mint. No new engine, no mock data — every
//  value comes from the connected wallet, ArcBridge.CHAINS, Circle CCTP V2 and
//  the live RPC/attestation services. Does not modify any existing page.
// ============================================================================
'use strict';

(function () {
  const HIST_KEY = 'execdaat_xbridge_history_v1';
  const IRIS_PING = 'https://iris-api-sandbox.circle.com/v2/messages/0?transactionHash=0x0000000000000000000000000000000000000000000000000000000000000000';
  const ARC_RPC = 'https://rpc.testnet.arc.network';
  const VERSION = '20260707x4';

  const S = {
    from: null, to: null, token: 'USDC', amount: '', recipient: '', balance: null,
    quote: null, quoting: false, executing: false, done: false, error: null, mode: 'standard', turboInfo: null,
    steps: [], log: [], txs: {}, health: {}, quoteTimer: null, healthTimer: null, built: false,
  };

  // ─── Helpers ────────────────────────────────────────────────────────────────
  const q = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const AB = () => window.ArcBridge;
  function toast(m, t) { try { if (typeof showToast === 'function') showToast(m, t || 'info'); } catch (_) {} }
  function chains() { try { return AB() ? AB().listChains() : []; } catch (_) { return []; } }
  function chain(k) { try { return AB() ? AB().getChain(k) : null; } catch (_) { return null; } }
  function chainName(k) { const c = chain(k); return c ? (c.name || c.short || k) : (k || '—'); }
  function chainShort(k) { const c = chain(k); return c ? (c.short || c.name || k) : (k || '—'); }
  function chainExplorer(k) { const c = chain(k); return c ? c.explorer : ''; }
  const num = (v) => { const n = Number(v); return isFinite(n) ? n : null; };
  const fmt = (v, d) => { const n = num(v); return n == null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: d == null ? 2 : d, maximumFractionDigits: d == null ? 2 : d }); };
  const shortHash = (h) => (!h || typeof h !== 'string' || h.length < 14) ? (h || '—') : h.slice(0, 10) + '…' + h.slice(-8);
  const shortAddr = (a) => (!a || typeof a !== 'string' || a.length < 12) ? (a || '—') : a.slice(0, 6) + '…' + a.slice(-4);
  function nowClock() { const d = new Date(); return d.toLocaleTimeString('en-US', { hour12: false }); }
  function timeAgo(ms) { if (!ms) return '—'; const s = Math.max(0, Math.floor((Date.now() - ms) / 1000)); if (s < 60) return s + 's ago'; const m = Math.floor(s / 60); if (m < 60) return m + 'm ago'; const h = Math.floor(m / 60); if (h < 24) return h + 'h ago'; return Math.floor(h / 24) + 'd ago'; }
  function fmtDur(ms) { if (!ms || ms <= 0) return '—'; const s = Math.round(ms / 1000); if (s < 60) return s + 's'; const m = Math.floor(s / 60); return m + 'm ' + (s % 60) + 's'; }
  function copyBtn(val, label) { const safe = String(val || '').replace(/'/g, "\\'"); return `<button type="button" class="xb-ic" title="Copy ${esc(label || '')}" aria-label="Copy ${esc(label || '')}" onclick="event.stopPropagation();xbCopy('${safe}','${esc(label || '')}')"><i class="fas fa-copy"></i></button>`; }
  function exLink(kind, hash, chainKey) { if (!hash) return ''; const base = chainKey ? chainExplorer(chainKey) : ''; if (!base) return ''; return `<a class="xb-ic" href="${base}/tx/${hash}" target="_blank" rel="noopener" title="Open in explorer" aria-label="Open transaction in explorer" onclick="event.stopPropagation();"><i class="fas fa-external-link-alt"></i></a>`; }
  const wallet = () => (window.walletState && window.walletState.address) || null;
  function loadHist() { try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch (_) { return []; } }
  function saveHist(entry) { try { const all = loadHist(); all.unshift(entry); localStorage.setItem(HIST_KEY, JSON.stringify(all.slice(0, 60))); } catch (_) {} }

  // ─── Execution step model ───────────────────────────────────────────────────
  const STEP_DEFS = [
    { key: 'approve',  icon: 'fa-file-signature', title: 'Approve Token',            desc: 'Authorize USDC for the CCTP TokenMessenger' },
    { key: 'burn',     icon: 'fa-fire',           title: 'Submit Burn Transaction',  desc: 'Burn USDC on the source chain (depositForBurn)' },
    { key: 'attest',   icon: 'fa-shield-halved',  title: 'Waiting Circle Attestation', desc: 'Circle signs the cross-chain message' },
    { key: 'mint',     icon: 'fa-coins',          title: 'Mint on Destination',      desc: 'Receive & mint USDC on the destination chain' },
    { key: 'complete', icon: 'fa-flag-checkered', title: 'Completed',                desc: 'Funds delivered on the destination chain' },
  ];
  function initSteps() {
    const turbo = S.mode === 'turbo';
    const O = turbo ? {
      burn:   { title: 'Submit Burn Transaction', desc: 'Burn USDC on source (mintRecipient = Treasury Vault)' },
      attest: { title: 'Treasury Fulfillment',    desc: 'Treasury Vault fronts liquidity on Arc (instant)' },
      mint:   { title: 'Settlement to Arc',       desc: 'Settlement queued on the Treasury Vault' },
    } : {};
    S.steps = STEP_DEFS.map((d) => ({ ...d, title: (O[d.key] && O[d.key].title) || d.title, desc: (O[d.key] && O[d.key].desc) || d.desc, status: 'pending', ts: null, detail: '' }));
  }
  function setStep(key, status, detail) { const st = S.steps.find((s) => s.key === key); if (st) { st.status = status; if (status === 'done' || status === 'failed') st.ts = Date.now(); if (detail != null) st.detail = detail; } renderExec(); }
  function logAdd(msg) { S.log.push({ t: nowClock(), msg }); renderLog(); }

  // ─── Style ──────────────────────────────────────────────────────────────────
  function injectStyle() {
    if (q('xb-style')) return; const st = document.createElement('style'); st.id = 'xb-style';
    st.textContent = `
      #tab-content-xbridge .xb-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:18px;}
      #tab-content-xbridge .xb-title{font-size:24px;font-weight:800;color:#eef2fb;margin:0;letter-spacing:-.02em;display:flex;align-items:center;gap:11px;}
      #tab-content-xbridge .xb-title-ic{width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,rgba(6,182,212,.18),rgba(96,180,255,.12));border:1px solid rgba(96,180,255,.28);display:flex;align-items:center;justify-content:center;color:#67e8f9;font-size:17px;}
      #tab-content-xbridge .xb-sub{font-size:13px;color:#8aaac8;margin:6px 0 0;}
      #tab-content-xbridge .xb-badges{display:flex;gap:8px;flex-wrap:wrap;}
      #tab-content-xbridge .xb-badge{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:700;padding:5px 11px;border-radius:999px;background:rgba(55,138,221,0.08);border:1px solid rgba(55,138,221,0.18);color:#9db8d8;}
      #tab-content-xbridge .xb-badge.cctp{color:#67e8f9;border-color:rgba(103,232,249,.28);background:rgba(103,232,249,.08);}
      #tab-content-xbridge .xb-main{display:grid;grid-template-columns:auto 320px;gap:18px;align-items:start;justify-content:center;}
      #tab-content-xbridge .xb-primary{display:flex;gap:18px;align-items:stretch;min-width:0;}
      #tab-content-xbridge .xb-card{flex:0 0 480px;width:480px;max-width:480px;min-width:0;background:rgba(8,11,24,0.96);border:1px solid rgba(55,138,221,0.14);border-radius:20px;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.35);}
      #tab-content-xbridge .xb-card .xb-topbar{height:3px;background:linear-gradient(90deg,transparent,#06b6d4 40%,#1D9E75 60%,transparent);}
      #tab-content-xbridge .xb-card .xb-body{padding:18px;}
      #tab-content-xbridge .xb-sec-t{font-size:11px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:#8aaac8;display:flex;align-items:center;gap:7px;margin:0 0 12px;}
      /* Route visualization */
      #tab-content-xbridge .xb-route{position:relative;display:flex;align-items:center;justify-content:space-between;gap:12px;background:radial-gradient(120% 140% at 0% 0%,rgba(6,182,212,.10),transparent 55%),linear-gradient(135deg,rgba(79,140,255,.05),rgba(14,20,34,.4));border:1px solid rgba(55,138,221,0.14);border-radius:16px;padding:18px 16px;overflow:hidden;}
      #tab-content-xbridge .xb-node{display:flex;flex-direction:column;align-items:center;gap:8px;min-width:92px;z-index:2;}
      #tab-content-xbridge .xb-node-logo{width:54px;height:54px;border-radius:16px;display:flex;align-items:center;justify-content:center;font-size:22px;background:rgba(8,11,24,.7);border:1px solid rgba(96,180,255,.25);box-shadow:0 6px 18px rgba(0,0,0,.4);}
      #tab-content-xbridge .xb-node-name{font-size:11.5px;font-weight:700;color:#cdd8ea;text-align:center;}
      #tab-content-xbridge .xb-node-tag{font-size:9px;color:#5f7ba0;text-transform:uppercase;letter-spacing:.06em;}
      #tab-content-xbridge .xb-line{position:relative;flex:1;height:2px;min-width:60px;background:linear-gradient(90deg,rgba(96,180,255,.25),rgba(29,158,117,.5));border-radius:2px;}
      #tab-content-xbridge .xb-line .xb-dot{position:absolute;top:50%;left:0;width:9px;height:9px;border-radius:50%;background:#67e8f9;box-shadow:0 0 10px #67e8f9;transform:translate(-50%,-50%);animation:xbFlow 2.6s linear infinite;}
      #tab-content-xbridge .xb-line .xb-particle{position:absolute;top:50%;width:4px;height:4px;border-radius:50%;background:rgba(103,232,249,.7);transform:translateY(-50%);animation:xbFlow 3.4s linear infinite;}
      @keyframes xbFlow{0%{left:0;opacity:0}10%{opacity:1}90%{opacity:1}100%{left:100%;opacity:0}}
      #tab-content-xbridge .xb-route-mid{position:absolute;top:8px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:3px;z-index:2;}
      #tab-content-xbridge .xb-swap{width:32px;height:32px;border-radius:10px;background:rgba(8,11,24,.8);border:1px solid rgba(96,180,255,.3);color:#67e8f9;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform .2s,border-color .2s;}
      #tab-content-xbridge .xb-swap:hover{transform:rotate(180deg);border-color:#67e8f9;}
      #tab-content-xbridge .xb-route-eta{font-size:9.5px;color:#5f7ba0;white-space:nowrap;}
      /* Fields */
      #tab-content-xbridge .xb-grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
      #tab-content-xbridge .xb-field{margin-bottom:12px;}
      #tab-content-xbridge .xb-lbl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#5f7ba0;margin-bottom:6px;display:flex;align-items:center;justify-content:space-between;}
      #tab-content-xbridge .xb-input,#tab-content-xbridge .xb-select{width:100%;background:rgba(12,16,32,0.7);border:1px solid rgba(55,138,221,0.2);border-radius:11px;color:#dbe4f2;font-size:14px;padding:11px 12px;outline:none;transition:border-color .15s,box-shadow .15s;}
      #tab-content-xbridge .xb-input:focus,#tab-content-xbridge .xb-select:focus{border-color:#67e8f9;box-shadow:0 0 0 3px rgba(103,232,249,.14);}
      #tab-content-xbridge .xb-input:disabled,#tab-content-xbridge .xb-select:disabled{opacity:.55;cursor:not-allowed;}
      #tab-content-xbridge .xb-amount-wrap{position:relative;}
      #tab-content-xbridge .xb-amount-wrap .xb-token{position:absolute;right:10px;top:50%;transform:translateY(-50%);display:inline-flex;align-items:center;gap:5px;font-weight:800;font-size:12px;color:#dbe4f2;background:rgba(96,180,255,0.12);border:1px solid rgba(96,180,255,0.24);border-radius:8px;padding:4px 9px;}
      #tab-content-xbridge .xb-quick{display:flex;gap:7px;flex-wrap:wrap;margin-top:9px;}
      #tab-content-xbridge .xb-qbtn{flex:1;min-width:48px;background:rgba(55,138,221,0.08);border:1px solid rgba(55,138,221,0.18);border-radius:9px;color:#9db8d8;font-size:12px;font-weight:700;padding:7px 4px;cursor:pointer;transition:all .15s;}
      #tab-content-xbridge .xb-qbtn:hover{background:rgba(103,232,249,.14);color:#eef2fb;border-color:rgba(103,232,249,.3);}
      #tab-content-xbridge .xb-summary{background:rgba(55,138,221,0.05);border:1px solid rgba(55,138,221,0.12);border-radius:12px;padding:12px;margin-top:6px;}
      #tab-content-xbridge .xb-srow{display:flex;align-items:center;justify-content:space-between;font-size:12px;padding:5px 0;}
      #tab-content-xbridge .xb-srow .k{color:#5f7ba0;}
      #tab-content-xbridge .xb-srow .v{color:#cdd8ea;font-weight:700;}
      #tab-content-xbridge .xb-srow.big .v{font-size:16px;color:#67e8f9;font-weight:800;}
      #tab-content-xbridge .xb-action{width:100%;margin-top:14px;padding:14px;border:none;border-radius:14px;font-size:15px;font-weight:800;color:#fff;cursor:pointer;background:linear-gradient(135deg,#0891b2,#1D9E75);box-shadow:0 8px 26px rgba(6,182,212,.28);transition:filter .15s,transform .1s,box-shadow .2s;display:flex;align-items:center;justify-content:center;gap:9px;}
      #tab-content-xbridge .xb-action:hover:not(:disabled){filter:brightness(1.08);box-shadow:0 12px 34px rgba(6,182,212,.4);}
      #tab-content-xbridge .xb-action:active:not(:disabled){transform:scale(.99);}
      #tab-content-xbridge .xb-action:disabled{opacity:.5;filter:grayscale(.3);cursor:not-allowed;box-shadow:none;}
      #tab-content-xbridge .xb-action.ok{background:linear-gradient(135deg,#059669,#10b981);}
      #tab-content-xbridge .xb-note{font-size:11px;color:#5f7ba0;margin-top:9px;text-align:center;}
      /* Execution panel */
      #tab-content-xbridge .xb-exec{flex:0 0 340px;max-width:340px;min-width:0;background:rgba(8,11,24,0.96);border:1px solid rgba(103,232,249,0.2);border-radius:20px;overflow:hidden;opacity:0;transform:translateX(28px);transition:opacity .28s ease,transform .28s ease;}
      #tab-content-xbridge .xb-exec.in{opacity:1;transform:translateX(0);}
      #tab-content-xbridge .xb-exec.hidden{display:none;}
      #tab-content-xbridge .xb-exec .xb-body{padding:16px;}
      #tab-content-xbridge .xb-prog{height:8px;border-radius:8px;background:rgba(55,138,221,0.12);overflow:hidden;}
      #tab-content-xbridge .xb-prog-fill{height:100%;border-radius:8px;background:linear-gradient(90deg,#06b6d4,#1D9E75);transition:width .4s ease;width:0;}
      #tab-content-xbridge .xb-prog-lbls{display:flex;justify-content:space-between;font-size:9px;color:#5f7ba0;margin-top:5px;}
      #tab-content-xbridge .xb-step{display:flex;gap:11px;padding:9px 0;}
      #tab-content-xbridge .xb-step-rail{display:flex;flex-direction:column;align-items:center;flex-shrink:0;}
      #tab-content-xbridge .xb-step-dot{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;border:1px solid rgba(74,85,104,.4);background:rgba(74,85,104,.12);color:#5f7ba0;transition:all .2s;}
      #tab-content-xbridge .xb-step.active .xb-step-dot{border-color:#67e8f9;color:#67e8f9;background:rgba(103,232,249,.12);box-shadow:0 0 12px rgba(103,232,249,.4);animation:xbPulse 1.6s ease-in-out infinite;}
      #tab-content-xbridge .xb-step.done .xb-step-dot{border-color:#34d399;color:#34d399;background:rgba(52,211,153,.14);}
      #tab-content-xbridge .xb-step.failed .xb-step-dot{border-color:#f87171;color:#f87171;background:rgba(239,68,68,.14);}
      @keyframes xbPulse{0%,100%{box-shadow:0 0 8px rgba(103,232,249,.3)}50%{box-shadow:0 0 18px rgba(103,232,249,.65)}}
      #tab-content-xbridge .xb-step-line{width:2px;flex:1;background:rgba(55,138,221,.18);margin-top:2px;min-height:8px;}
      #tab-content-xbridge .xb-step.done .xb-step-line{background:rgba(52,211,153,.4);}
      #tab-content-xbridge .xb-step-title{font-size:12.5px;font-weight:700;color:#cdd8ea;}
      #tab-content-xbridge .xb-step.pending .xb-step-title{color:#5f7ba0;}
      #tab-content-xbridge .xb-step-desc{font-size:10.5px;color:#5f7ba0;margin-top:1px;}
      #tab-content-xbridge .xb-step-meta{font-size:9.5px;color:#5f7ba0;margin-top:2px;display:flex;align-items:center;gap:6px;}
      #tab-content-xbridge .xb-txcard{background:rgba(12,16,32,0.6);border:1px solid rgba(55,138,221,0.12);border-radius:11px;padding:4px 11px;margin-top:6px;}
      #tab-content-xbridge .xb-txrow{display:flex;align-items:center;gap:7px;padding:7px 0;border-bottom:1px solid rgba(55,138,221,.07);font-size:11px;}
      #tab-content-xbridge .xb-txrow:last-child{border-bottom:none;}
      #tab-content-xbridge .xb-txrow .k{color:#5f7ba0;min-width:96px;flex-shrink:0;}
      #tab-content-xbridge .xb-txrow .v{color:#cdd8ea;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      #tab-content-xbridge .xb-log{background:#05070f;border:1px solid rgba(55,138,221,.12);border-radius:11px;padding:10px;max-height:150px;overflow-y:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.7;}
      #tab-content-xbridge .xb-log-line{display:flex;gap:8px;}
      #tab-content-xbridge .xb-log-line .t{color:#3a6090;flex-shrink:0;}
      #tab-content-xbridge .xb-log-line .m{color:#9db8d8;}
      /* Sidebar */
      #tab-content-xbridge .xb-side{display:flex;flex-direction:column;gap:14px;position:sticky;top:14px;}
      #tab-content-xbridge .xb-panel{background:rgba(8,11,24,0.96);border:1px solid rgba(55,138,221,0.14);border-radius:16px;padding:14px;}
      #tab-content-xbridge .xb-chain-row,#tab-content-xbridge .xb-h-row{display:flex;align-items:center;gap:9px;padding:8px 0;border-bottom:1px solid rgba(55,138,221,.07);}
      #tab-content-xbridge .xb-chain-row:last-child,#tab-content-xbridge .xb-h-row:last-child{border-bottom:none;}
      #tab-content-xbridge .xb-chain-ic{width:26px;height:26px;border-radius:8px;background:rgba(96,180,255,.1);border:1px solid rgba(96,180,255,.2);display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0;}
      #tab-content-xbridge .xb-chain-nm{font-size:12px;color:#cdd8ea;font-weight:600;flex:1;min-width:0;}
      #tab-content-xbridge .xb-chip{font-size:9px;font-weight:700;padding:2px 7px;border-radius:999px;color:#67e8f9;background:rgba(103,232,249,.1);border:1px solid rgba(103,232,249,.22);}
      #tab-content-xbridge .xb-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0;}
      #tab-content-xbridge .xb-h-lbl{font-size:12px;color:#cdd8ea;flex:1;}
      #tab-content-xbridge .xb-h-val{font-size:10.5px;font-weight:700;margin-left:auto;}
      #tab-content-xbridge .xb-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}
      #tab-content-xbridge .xb-ic{width:22px;height:22px;border-radius:6px;background:rgba(55,138,221,0.09);border:1px solid rgba(55,138,221,0.2);color:#7fa8d8;cursor:pointer;font-size:9px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;text-decoration:none;transition:all .15s;}
      #tab-content-xbridge .xb-ic:hover{background:rgba(55,138,221,0.2);color:#bcd6f5;}
      #tab-content-xbridge .xb-empty{font-size:12px;color:#5f7ba0;font-style:italic;padding:12px 2px;}
      #tab-content-xbridge .xb-mini{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid rgba(55,138,221,.06);font-size:11px;}
      #tab-content-xbridge .xb-mini:last-child{border-bottom:none;}
      #tab-content-xbridge .xb-stats{display:grid;grid-template-columns:1fr 1fr;gap:9px;}
      #tab-content-xbridge .xb-stat{background:rgba(55,138,221,0.05);border:1px solid rgba(55,138,221,0.12);border-radius:10px;padding:9px 10px;}
      #tab-content-xbridge .xb-stat .k{font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:#5f7ba0;font-weight:700;}
      #tab-content-xbridge .xb-stat .v{font-size:15px;font-weight:800;color:#dde6f5;margin-top:3px;}
      #tab-content-xbridge .xb-err{background:rgba(239,68,68,.07);border:1px solid rgba(239,68,68,.28);border-radius:12px;padding:12px;margin-top:10px;}
      #tab-content-xbridge .xb-actions2{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;}
      #tab-content-xbridge .xb-btn{display:inline-flex;align-items:center;gap:7px;background:rgba(55,138,221,0.09);border:1px solid rgba(55,138,221,0.2);border-radius:10px;color:#bcd6f5;font-size:12px;font-weight:700;padding:8px 12px;cursor:pointer;text-decoration:none;}
      #tab-content-xbridge .xb-btn:hover{background:rgba(55,138,221,0.2);}
      #tab-content-xbridge .xb-exec-toggle{display:none;}
      @media (max-width:1024px){ #tab-content-xbridge .xb-main{grid-template-columns:1fr;justify-content:stretch;} #tab-content-xbridge .xb-side{position:static;} #tab-content-xbridge .xb-primary{justify-content:center;flex-wrap:wrap;} }
      @media (max-width:760px){ #tab-content-xbridge .xb-primary{flex-direction:column;align-items:stretch;} #tab-content-xbridge .xb-card{flex-basis:auto;width:100%;max-width:none;} #tab-content-xbridge .xb-exec{flex-basis:auto;max-width:none;} #tab-content-xbridge .xb-grid2{grid-template-columns:1fr;} }
    `;
    document.head.appendChild(st);
  }

  // ─── Build UI ─────────────────────────────────────────────────────────────
  function chainOptions(sel) { return chains().map((c) => `<option value="${esc(c.key)}" ${sel === c.key ? 'selected' : ''}>${esc(c.name)}</option>`).join(''); }

  function build() {
    const root = q('xbridge-root'); if (!root) return; injectStyle();
    if (!AB()) { root.innerHTML = `<div class="xb-empty" style="text-align:center;padding:60px;">Bridge service is still loading. Please reload the page.</div>`; return; }
    // defaults
    const cs = chains();
    if (!S.from) S.from = cs.find((c) => c.key !== 'arc') ? cs.find((c) => c.key !== 'arc').key : (cs[0] && cs[0].key);
    if (!S.to) S.to = 'arc';
    if (S.from === S.to) { const alt = cs.find((c) => c.key !== S.from); if (alt) S.to = alt.key; }
    if (!S.recipient) S.recipient = wallet() || '';

    root.innerHTML = `
      <div class="xb">
        <div class="xb-head">
          <div>
            <h2 class="xb-title"><span class="xb-title-ic"><i class="fas fa-bridge"></i></span>Bridge</h2>
            <p class="xb-sub">Bridge assets securely across supported blockchains using Circle CCTP V2.</p>
          </div>
          <div class="xb-badges">
            <span class="xb-badge cctp"><i class="fas fa-shield-halved" style="font-size:9px;"></i>CCTP V2</span>
            <span class="xb-badge"><i class="fas fa-network-wired" style="font-size:9px;"></i>Arc Testnet</span>
          </div>
        </div>

        <div class="xb-main">
          <div class="xb-primary">
            <section class="xb-card">
              <div class="xb-topbar"></div>
              <div class="xb-body">
                <p class="xb-sec-t"><i class="fas fa-route" style="color:#67e8f9;"></i>Bridge Route</p>
                <div id="xb-route" class="xb-route"></div>

                <p class="xb-sec-t" style="margin-top:18px;"><i class="fas fa-sliders" style="color:#60b4ff;"></i>Bridge Details</p>
                <div class="xb-grid2">
                  <div class="xb-field"><div class="xb-lbl">Source Chain</div><select id="xb-from" class="xb-select" onchange="xbSetFrom(this.value)">${chainOptions(S.from)}</select></div>
                  <div class="xb-field"><div class="xb-lbl">Destination Chain</div><select id="xb-to" class="xb-select" onchange="xbSetTo(this.value)">${chainOptions(S.to)}</select></div>
                </div>
                <div class="xb-grid2">
                  <div class="xb-field"><div class="xb-lbl">Source Token</div><select id="xb-token" class="xb-select" disabled><option>USDC</option></select></div>
                  <div class="xb-field"><div class="xb-lbl"><span>Amount</span><span id="xb-bal" class="xb-mono" style="color:#5f7ba0;font-weight:600;">Balance: —</span></div>
                    <div class="xb-amount-wrap"><input id="xb-amount" class="xb-input" type="number" min="0" step="0.01" placeholder="0.00" oninput="xbAmount(this.value)"><span class="xb-token">USDC <button type="button" onclick="xbMax()" style="background:none;border:none;color:#67e8f9;font-weight:800;cursor:pointer;font-size:10px;">MAX</button></span></div>
                  </div>
                </div>
                <div class="xb-field"><div class="xb-lbl">Recipient Address (destination)</div><input id="xb-recipient" class="xb-input xb-mono" type="text" placeholder="0x…" value="${esc(S.recipient)}" oninput="xbSetRecipient(this.value)"></div>
                <div class="xb-quick">
                  ${[10, 50, 100, 500, 1000].map((a) => `<button class="xb-qbtn" onclick="xbQuick(${a})">${a}</button>`).join('')}
                </div>

                <div id="xb-summary" class="xb-summary"></div>
                <button id="xb-action" class="xb-action" onclick="xbBridge()"><i class="fas fa-bolt"></i>Bridge Assets</button>
                <div id="xb-note" class="xb-note"></div>
              </div>
            </section>

            <aside id="xb-exec" class="xb-exec hidden" aria-live="polite">
              <div class="xb-topbar"></div>
              <div class="xb-body">
                <p class="xb-sec-t"><i class="fas fa-gauge-high" style="color:#67e8f9;"></i>Bridge Progress</p>
                <div class="xb-prog"><div id="xb-prog-fill" class="xb-prog-fill"></div></div>
                <div class="xb-prog-lbls"><span>0%</span><span>20%</span><span>40%</span><span>60%</span><span>80%</span><span>100%</span></div>
                <p class="xb-sec-t" style="margin-top:16px;"><i class="fas fa-list-check" style="color:#60b4ff;"></i>Execution Steps</p>
                <div id="xb-steps"></div>
                <p class="xb-sec-t" style="margin-top:16px;"><i class="fas fa-receipt" style="color:#a78bfa;"></i>Transaction Details</p>
                <div id="xb-txdetails"></div>
                <p class="xb-sec-t" style="margin-top:16px;"><i class="fas fa-terminal" style="color:#34d399;"></i>Live Activity Log</p>
                <div id="xb-log" class="xb-log"></div>
                <div id="xb-exec-actions"></div>
              </div>
            </aside>
          </div>

          <div class="xb-side">
            <div class="xb-panel"><p class="xb-sec-t"><i class="fas fa-link" style="color:#60b4ff;"></i>Supported Chains</p><div id="xb-chains"></div></div>
            <div class="xb-panel"><p class="xb-sec-t"><i class="fas fa-gauge" style="color:#67e8f9;"></i>Bridge Status</p><div id="xb-status"></div></div>
            <div class="xb-panel"><p class="xb-sec-t"><i class="fas fa-heart-pulse" style="color:#34d399;"></i>Network Health</p><div id="xb-health"></div></div>
            <div class="xb-panel"><p class="xb-sec-t"><i class="fas fa-clock-rotate-left" style="color:#a78bfa;"></i>Recent Bridges</p><div id="xb-recent"></div></div>
            <div class="xb-panel"><p class="xb-sec-t"><i class="fas fa-chart-simple" style="color:#fbbf24;"></i>Session Statistics</p><div id="xb-stats" class="xb-stats"></div></div>
          </div>
        </div>
      </div>`;
    S.built = true;
    renderRoute(); renderSummary(); renderSupportedChains(); renderRecent(); renderStats(); renderHealth();
    loadBalance(); scheduleQuote();
  }

  // ─── Renderers ──────────────────────────────────────────────────────────────
  function renderRoute() {
    const el = q('xb-route'); if (!el) return; const fc = chain(S.from), tc = chain(S.to);
    const eta = S.quote ? S.quote.estTime : (tc && tc.domain === 26 ? '~15+ min' : '~1–2 min');
    el.innerHTML = `
      <div class="xb-node"><div class="xb-node-logo">${esc((fc && fc.icon) || '🔗')}</div><div class="xb-node-name">${esc(chainShort(S.from))}</div><div class="xb-node-tag">Source</div></div>
      <div class="xb-line"><span class="xb-dot"></span><span class="xb-particle" style="animation-delay:.8s;"></span><span class="xb-particle" style="animation-delay:1.6s;"></span>
        <div class="xb-route-mid"><button class="xb-swap" onclick="xbSwap()" title="Swap direction" aria-label="Swap direction"><i class="fas fa-right-left"></i></button><span class="xb-route-eta"><i class="far fa-clock"></i> ${esc(eta)}</span>${S.mode === 'turbo' ? '<span class="xb-chip" style="margin-top:1px;color:#fbbf24;background:rgba(251,191,36,.1);border-color:rgba(251,191,36,.25);"><i class="fas fa-bolt" style="font-size:8px;"></i>Turbo</span>' : '<span class="xb-chip" style="margin-top:1px;">Standard</span>'}</div>
      </div>
      <div class="xb-node"><div class="xb-node-logo">${esc((tc && tc.icon) || '🔗')}</div><div class="xb-node-name">${esc(chainShort(S.to))}</div><div class="xb-node-tag">Destination</div></div>`;
  }

  function renderSummary() {
    const el = q('xb-summary'); if (!el) return; const qo = S.quote;
    const recv = qo ? Math.max(0, qo.output - (qo.bridgeFee || 0)) : null;
    el.innerHTML = `
      <div class="xb-srow big"><span class="k">Estimated Received</span><span class="v">${recv != null ? fmt(recv) + ' USDC' : (S.quoting ? '…' : '—')}</span></div>
      <div class="xb-srow"><span class="k">Bridge Fee (relayer)</span><span class="v">${qo ? fmt(qo.bridgeFee, 2) + ' USDC' : '—'}</span></div>
      <div class="xb-srow"><span class="k">Network Fee</span><span class="v">${qo ? fmt(qo.protocolFee, 2) + ' USDC' : '—'}</span></div>
      <div class="xb-srow"><span class="k">Gas Fee (est.)</span><span class="v">${qo ? '~' + fmt(qo.gasFeeEst, 2) : '—'}</span></div>
      <div class="xb-srow"><span class="k">Estimated Time</span><span class="v">${qo ? esc(qo.estTime) : '—'}</span></div>
      <div class="xb-srow"><span class="k">Route</span><span class="v">${qo ? esc(qo.routeType) + ' · ' + esc(qo.mode) : 'Native Burn & Mint'}</span></div>`;
  }

  function renderSupportedChains() {
    const el = q('xb-chains'); if (!el) return;
    el.innerHTML = chains().map((c) => `<div class="xb-chain-row"><span class="xb-chain-ic">${esc(c.icon || '🔗')}</span><span class="xb-chain-nm">${esc(c.name)}</span><span class="xb-chip">${esc((c.nativeSymbol ? 'USDC' : 'USDC'))}</span></div>`).join('') || `<div class="xb-empty">No chains.</div>`;
  }

  function renderStatusPanel() {
    const el = q('xb-status'); if (!el) return; const qo = S.quote;
    const total = qo ? (qo.bridgeFee || 0) + (qo.protocolFee || 0) + (qo.gasFeeEst || 0) : null;
    const row = (k, v) => `<div class="xb-h-row"><span class="xb-h-lbl">${esc(k)}</span><span class="xb-h-val" style="color:#cdd8ea;">${v}</span></div>`;
    el.innerHTML = row('Estimated Time', qo ? esc(qo.estTime) : '—') + row('Bridge Fee', qo ? fmt(qo.bridgeFee, 2) + ' USDC' : '—') + row('Gas Fee (est.)', qo ? '~' + fmt(qo.gasFeeEst, 2) : '—') + row('Relayer Fee', qo ? fmt(qo.bridgeFee, 2) + ' USDC' : '—') + row('Total Cost (est.)', total != null ? '~' + fmt(total, 2) + ' USDC' : '—');
  }

  function renderHealth() {
    const el = q('xb-health'); if (!el) return; const h = S.health || {};
    const item = (label, st) => { const c = { green: '#34d399', yellow: '#fbbf24', red: '#f87171', gray: '#5f7ba0' }[st || 'gray']; const lbl = { green: 'Healthy', yellow: 'Slow', red: 'Offline', gray: '—' }[st || 'gray']; return `<div class="xb-h-row"><span class="xb-dot" style="background:${c};box-shadow:0 0 8px ${c}66;"></span><span class="xb-h-lbl">${esc(label)}</span><span class="xb-h-val" style="color:${c};">${lbl}${h[label + '_ms'] != null && st !== 'red' ? ' · ' + h[label + '_ms'] + 'ms' : ''}</span></div>`; };
    el.innerHTML = item('Circle API', h.circle) + item('RPC', h.rpc) + item('Relayer', h.relayer) + item('Attestation Service', h.attest);
  }

  function renderRecent() {
    const el = q('xb-recent'); if (!el) return; const hist = loadHist();
    if (!hist.length) { el.innerHTML = `<div class="xb-empty">No bridges yet. Your completed transfers will appear here.</div>`; return; }
    el.innerHTML = hist.slice(0, 6).map((b) => `<div class="xb-mini"><span class="xb-dot" style="background:${b.status === 'completed' ? '#34d399' : '#f87171'};"></span><div style="flex:1;min-width:0;"><div style="color:#cdd8ea;font-weight:700;">${fmt(b.amount)} USDC</div><div style="color:#5f7ba0;font-size:10px;">${esc(chainShort(b.from))} → ${esc(chainShort(b.to))} · ${b.mode === 'turbo' ? '⚡ Turbo' : 'Standard'} · ${esc(timeAgo(b.ts))}</div></div>${b.mintTxHash ? exLink('mint', b.mintTxHash, b.to) : (b.burnTxHash ? exLink('burn', b.burnTxHash, b.from) : '')}</div>`).join('');
  }

  function renderStats() {
    const el = q('xb-stats'); if (!el) return; const hist = loadHist().filter((b) => b.status === 'completed');
    const vol = hist.reduce((a, b) => a + (Number(b.amount) || 0), 0);
    const fees = hist.reduce((a, b) => a + (Number(b.fee) || 0), 0);
    const durs = hist.map((b) => b.durationMs).filter((x) => x > 0);
    const avg = durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : null;
    const cell = (k, v) => `<div class="xb-stat"><div class="k">${esc(k)}</div><div class="v">${v}</div></div>`;
    el.innerHTML = cell('Bridges Completed', String(hist.length)) + cell('Total Volume', fmt(vol) + '') + cell('Fees Paid', fmt(fees, 2)) + cell('Average Time', avg != null ? fmtDur(avg) : '—');
  }

  function renderExec() {
    const stepsEl = q('xb-steps'); if (!stepsEl) return;
    stepsEl.innerHTML = S.steps.map((s, i) => `
      <div class="xb-step ${s.status}">
        <div class="xb-step-rail"><span class="xb-step-dot"><i class="fas ${s.status === 'done' ? 'fa-check' : s.status === 'failed' ? 'fa-xmark' : s.icon}"></i></span>${i < S.steps.length - 1 ? '<span class="xb-step-line"></span>' : ''}</div>
        <div style="flex:1;min-width:0;">
          <div class="xb-step-title">${esc(s.title)}</div>
          <div class="xb-step-desc">${esc(s.detail || s.desc)}</div>
          <div class="xb-step-meta">${s.status === 'active' ? '<span style="color:#67e8f9;">In progress…</span>' : s.status === 'done' ? '<span style="color:#34d399;">Done</span>' : s.status === 'failed' ? '<span style="color:#f87171;">Failed</span>' : '<span>Waiting</span>'}${s.ts ? ' · ' + new Date(s.ts).toLocaleTimeString('en-US', { hour12: false }) : ''}</div>
        </div>
      </div>`).join('');
    // tx details
    const td = q('xb-txdetails'); const t = S.txs;
    if (td) { const row = (k, v, extra) => `<div class="xb-txrow"><span class="k">${esc(k)}</span><span class="v xb-mono" title="${esc(String(v || ''))}">${v ? esc(shortHash(String(v))) : '—'}</span>${extra || ''}</div>`;
      td.innerHTML = `<div class="xb-txcard">
        ${row('Bridge ID', t.bridgeId || '—', t.bridgeId ? copyBtn(t.bridgeId, 'bridge id') : '')}
        ${row('Source Tx', t.burnTxHash, t.burnTxHash ? (copyBtn(t.burnTxHash, 'source tx') + exLink('burn', t.burnTxHash, S.from)) : '')}
        ${row('Destination Tx', t.mintTxHash, t.mintTxHash ? (copyBtn(t.mintTxHash, 'dest tx') + exLink('mint', t.mintTxHash, S.to)) : '')}
        ${row('Attestation', t.attestation ? t.attestation.slice(0, 22) : '—', t.attestation ? copyBtn(t.attestation, 'attestation') : '')}
        <div class="xb-txrow"><span class="k">Source Network</span><span class="v">${esc(chainName(S.from))}</span></div>
        <div class="xb-txrow"><span class="k">Destination Network</span><span class="v">${esc(chainName(S.to))}</span></div>
      </div>`; }
  }
  function renderLog() { const el = q('xb-log'); if (!el) return; el.innerHTML = S.log.map((l) => `<div class="xb-log-line"><span class="t">${esc(l.t)}</span><span class="m">${esc(l.msg)}</span></div>`).join('') || '<div style="color:#3a6090;">Waiting for activity…</div>'; el.scrollTop = el.scrollHeight; }

  function setProgress(pct) { const f = q('xb-prog-fill'); if (f) f.style.width = Math.max(0, Math.min(100, pct)) + '%'; }

  // ─── Quote + balance ─────────────────────────────────────────────────────────
  function scheduleQuote() { if (S.quoteTimer) clearTimeout(S.quoteTimer); S.quoteTimer = setTimeout(doQuote, 350); }
  function normalizeQuote(raw, mode) {
    if (!raw) return null;
    return {
      mode: mode,
      provider: (raw.provider && raw.provider.name) || (mode === 'turbo' ? 'Turbo Bridge' : 'Circle CCTP V2'),
      routeType: raw.routeType || 'Native Burn & Mint',
      output: raw.output != null ? raw.output : (raw.minReceived != null ? raw.minReceived : (parseFloat(S.amount) || 0)),
      bridgeFee: raw.bridgeFee != null ? raw.bridgeFee : 0,
      protocolFee: raw.protocolFee != null ? raw.protocolFee : (raw.protFee != null ? raw.protFee : 0),
      gasFeeEst: raw.gasFeeEst != null ? raw.gasFeeEst : (raw.gasFee != null ? raw.gasFee : 0.02),
      estTime: raw.estTime || raw.time || (mode === 'turbo' ? '~8–15 sec' : '~15+ min'),
    };
  }
  async function doQuote() {
    const amt = parseFloat(S.amount) || 0;
    const note = q('xb-note'); const btn = q('xb-action');
    const sup = AB() ? AB().isRouteSupported(S.from, S.to) : { ok: false, reason: 'Bridge unavailable' };
    if (!sup.ok) { S.quote = null; S.mode = 'standard'; S.turboInfo = null; renderSummary(); renderStatusPanel(); renderRoute(); if (note) note.textContent = sup.reason; if (btn && !S.executing) btn.disabled = true; return; }
    if (amt <= 0) { S.quote = null; S.mode = 'standard'; S.turboInfo = null; renderSummary(); renderStatusPanel(); renderRoute(); if (note) note.textContent = ''; if (btn && !S.executing) btn.disabled = true; return; }
    S.quoting = true; renderSummary();
    S.mode = 'standard'; S.turboInfo = null;
    try {
      // Prefer Turbo Bridge for inbound (External → Arc) ONLY when Elligent
      // client mode is active (REMOTE — the Treasury Core relayer handles settlement).
      // In LOCAL mode the vault operator key is not available to fulfil the instant
      // payout, so Turbo would burn funds but never deliver them.
      const TB = window.TurboBridge; let usedTurbo = false;
      const remoteOk = (() => { try { if (window.TreasuryData && typeof window.TreasuryData.isRemote === 'function') return window.TreasuryData.isRemote(); } catch(_){} try { if (window.TreasuryConfig && typeof window.TreasuryConfig.isRemote === 'function') return window.TreasuryConfig.isRemote(); } catch(_){} return false; })();
      if (TB && typeof TB.isTurboRoute === 'function' && TB.isTurboRoute(S.from, S.to) && remoteOk) {
        try {
          const avail = await TB.isAvailable(S.from, amt);
          if (avail && avail.available) {
            const tq = TB.getQuote({ from: S.from, to: S.to, amount: amt, reserves: avail.reserves });
            S.quote = normalizeQuote(tq, 'turbo'); S.mode = 'turbo'; S.turboInfo = avail.info || (tq && tq._turbo) || null; usedTurbo = true;
          }
        } catch (_) {}
      }
      if (!usedTurbo) { const qo = await AB().getQuote({ from: S.from, to: S.to, amount: amt }); S.quote = normalizeQuote(qo, 'standard'); }
      if (note) note.textContent = '';
    } catch (e) { S.quote = null; if (note) note.textContent = (e && e.message) || 'Quote unavailable'; }
    S.quoting = false; renderSummary(); renderStatusPanel(); renderRoute(); updateActionState();
  }
  async function loadBalance() {
    const el = q('xb-bal'); const addr = wallet(); if (!AB() || !addr) { if (el) el.textContent = 'Balance: connect wallet'; S.balance = null; updateActionState(); return; }
    if (el) el.textContent = 'Balance: …';
    try { const b = await AB().getBalance(S.from, addr); S.balance = b; if (el) el.textContent = 'Balance: ' + (b != null ? fmt(b) + ' USDC' : '—'); }
    catch (_) { S.balance = null; if (el) el.textContent = 'Balance: —'; }
    updateActionState();
  }
  function updateActionState() {
    const btn = q('xb-action'); if (!btn || S.executing || S.done) return;
    const amt = parseFloat(S.amount) || 0;
    const sup = AB() ? AB().isRouteSupported(S.from, S.to) : { ok: false };
    const okAddr = /^0x[0-9a-fA-F]{40}$/.test(S.recipient || '');
    const enough = S.balance == null || amt <= S.balance;
    btn.disabled = !(sup.ok && amt > 0 && okAddr && wallet() && enough && S.quote);
  }

  // ─── Network health polling (real) ────────────────────────────────────────────
  async function pingHealth() {
    const set = (k, st, ms) => { S.health[k] = st; if (ms != null) S.health[k.replace('_', '') + '_ms'] = ms; };
    // RPC
    try { const t0 = performance.now(); const r = await fetch(ARC_RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }) }); const lat = Math.round(performance.now() - t0); const j = await r.json().catch(() => null); if (j && j.result) { S.health.RPC = lat < 1200 ? 'green' : 'yellow'; S.health['RPC_ms'] = lat; } else S.health.RPC = 'red'; } catch (_) { S.health.RPC = 'red'; }
    // Circle API + Attestation (Iris)
    try { const t0 = performance.now(); const r = await fetch(IRIS_PING, { method: 'GET' }); const lat = Math.round(performance.now() - t0); const ok = r.status < 500; S.health['Circle API'] = ok ? (lat < 1500 ? 'green' : 'yellow') : 'red'; S.health['Circle API_ms'] = lat; S.health['Attestation Service'] = S.health['Circle API']; S.health['Attestation Service_ms'] = lat; } catch (_) { S.health['Circle API'] = 'red'; S.health['Attestation Service'] = 'red'; }
    // Relayer (ExecDaat/Elligent treasury health)
    try { const r = await fetch('/api/treasury/health', { headers: { Accept: 'application/json' } }); const j = await r.json().catch(() => null); S.health.Relayer = j && j.ok ? 'green' : (r.status < 500 ? 'yellow' : 'red'); } catch (_) { S.health.Relayer = 'yellow'; }
    renderHealth();
  }

  // ─── Execution ─────────────────────────────────────────────────────────────
  function setInputsDisabled(on) { ['xb-from', 'xb-to', 'xb-amount', 'xb-recipient'].forEach((id) => { const e = q(id); if (e) e.disabled = on; }); document.querySelectorAll('#tab-content-xbridge .xb-qbtn').forEach((b) => { b.disabled = on; b.style.opacity = on ? '.5' : ''; b.style.pointerEvents = on ? 'none' : ''; }); }

  // Standard CCTP event mapping → 5-step model
  function _standardOnEvent(stage, data) {
    data = data || {};
    switch (stage) {
      case 'validating': logAdd('Validating route & balance…'); setProgress(4); break;
      case 'switching_source': logAdd('Switching wallet to ' + chainName(S.from) + '…'); setProgress(8); break;
      case 'approving': setStep('approve', 'active'); logAdd('Approval transaction requested…'); setProgress(15); break;
      case 'approved': setStep('approve', 'done'); logAdd('Approval confirmed'); setProgress(22); break;
      case 'burning': setStep('burn', 'active'); logAdd('Submitting burn transaction…'); setProgress(28); break;
      case 'burn_sent': S.txs.burnTxHash = data.txHash; setStep('burn', 'active', 'Burn tx: ' + shortHash(data.txHash)); logAdd('Burn transaction sent: ' + shortHash(data.txHash)); setProgress(34); renderExec(); break;
      case 'burn_confirmed': S.txs.burnTxHash = data.txHash || S.txs.burnTxHash; setStep('burn', 'done'); logAdd('Burn confirmed on ' + chainShort(S.from)); setProgress(40); break;
      case 'attesting': setStep('attest', 'active', 'Circle attestation ' + (data.attempt ? '(' + data.attempt + '/' + data.max + ')' : '…')); if (data.attempt === 0 || data.attempt == null) logAdd('Waiting Circle Attestation…'); setProgress(40 + Math.min(18, ((data.attempt || 0) / (data.max || 1)) * 18)); break;
      case 'attested': setStep('attest', 'done'); logAdd('Attestation received'); setProgress(60); break;
      case 'switching_dest': logAdd('Switching wallet to ' + chainName(S.to) + '…'); setProgress(66); break;
      case 'minting': setStep('mint', 'active'); logAdd('Submitting mint transaction…'); setProgress(72); break;
      case 'mint_sent': S.txs.mintTxHash = data.txHash; setStep('mint', 'active', 'Mint tx: ' + shortHash(data.txHash)); logAdd('Mint transaction submitted: ' + shortHash(data.txHash)); setProgress(84); renderExec(); break;
      case 'mint_confirmed': S.txs.mintTxHash = data.txHash || S.txs.mintTxHash; setStep('mint', 'done'); logAdd('Mint confirmed on ' + chainShort(S.to)); setProgress(94); break;
      case 'completed': S.txs.burnTxHash = data.burnTxHash || S.txs.burnTxHash; S.txs.mintTxHash = data.mintTxHash || S.txs.mintTxHash; S.txs.attestation = data.attestation || S.txs.attestation; break;
      case 'failed': break;
    }
  }
  // Turbo (Treasury Vault) progress mapping → 5-step model
  function _turboOnStep(stepNum) {
    switch (stepNum) {
      case 0: logAdd('Switching wallet to ' + chainName(S.from) + '…'); setProgress(8); break;
      case 1: setStep('approve', 'active'); logAdd('Approving USDC for CCTP…'); setProgress(20); break;
      case 2: setStep('approve', 'done'); setStep('burn', 'active'); logAdd('Burning USDC on ' + chainShort(S.from) + ' (CCTP → Treasury Vault)…'); setProgress(46); break;
      case 3: setStep('burn', 'done'); setStep('attest', 'active'); logAdd('Switching to Arc — Treasury reserving liquidity…'); setProgress(76); break;
      case 4: setStep('attest', 'done'); setStep('mint', 'active', 'Settlement queued'); logAdd('Treasury intent created — settling to Arc…'); setProgress(92); break;
      default: break;
    }
  }
  function _finishSuccess(amt, feeAtExec, started, res) {
    S.done = true; S.executing = false;
    saveHist({ from: S.from, to: S.to, amount: amt, burnTxHash: res.burnTxHash, mintTxHash: res.mintTxHash, ts: Date.now(), status: 'completed', durationMs: Date.now() - started, fee: feeAtExec, mode: S.mode, intentId: res.intentId || null });
    renderExec(); renderRecent(); renderStats(); onSuccess();
    toast(S.mode === 'turbo' ? 'Turbo Bridge submitted — settling to Arc ⚡' : 'Bridge completed', 'success');
  }
  function _finishError(amt, feeAtExec, started, e) {
    S.executing = false; S.error = (e && (e.message || String(e))) || 'Bridge failed';
    const cur = S.steps.find((s) => s.status === 'active'); if (cur) setStep(cur.key, 'failed', S.error);
    logAdd('ERROR: ' + S.error);
    saveHist({ from: S.from, to: S.to, amount: amt, burnTxHash: S.txs.burnTxHash, mintTxHash: S.txs.mintTxHash, ts: Date.now(), status: 'failed', durationMs: Date.now() - started, fee: feeAtExec, mode: S.mode, error: S.error });
    renderExec(); renderRecent(); onError();
    toast('Bridge failed', 'error');
  }

  window.xbBridge = async function () {
    if (S.executing) return;
    const amt = parseFloat(S.amount) || 0;
    if (!wallet()) { toast('Connect your wallet first', 'warning'); return; }
    if (!/^0x[0-9a-fA-F]{40}$/.test(S.recipient || '')) { toast('Enter a valid recipient address', 'warning'); return; }
    if (amt <= 0) { toast('Enter an amount', 'warning'); return; }
    // Pre-flight validation (real, checks source USDC balance + route)
    const v = await AB().validate({ from: S.from, to: S.to, amount: amt, address: wallet() }).catch((e) => ({ ok: false, error: e.message }));
    if (!v.ok) { toast(v.error || 'Validation failed', 'error'); const note = q('xb-note'); if (note) note.textContent = v.error || ''; return; }

    S.executing = true; S.done = false; S.error = null; S.log = []; S.txs = {}; initSteps();
    setInputsDisabled(true);
    const btn = q('xb-action'); if (btn) { btn.disabled = true; btn.classList.remove('ok'); btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>Bridging…'; }
    const exec = q('xb-exec'); if (exec) { exec.classList.remove('hidden'); requestAnimationFrame(() => exec.classList.add('in')); }
    const actionsEl = q('xb-exec-actions'); if (actionsEl) actionsEl.innerHTML = '';
    renderExec(); renderLog(); setProgress(2);
    const started = Date.now();
    const feeAtExec = S.quote ? (S.quote.bridgeFee || 0) : 0;
    S.txs.bridgeId = 'brg-' + Date.now().toString(36) + '-' + Math.random().toString(16).slice(2, 6);
    logAdd('Bridge initiated: ' + fmt(amt) + ' USDC ' + chainShort(S.from) + ' → ' + chainShort(S.to) + ' · ' + (S.mode === 'turbo' ? 'Turbo ⚡' : 'Standard'));

    // ── Turbo Bridge path (External → Arc) — falls back to Standard on any failure ──
    if (S.mode === 'turbo' && window.TurboBridge) {
      try {
        logAdd('Route: Turbo Bridge ⚡ (Treasury Vault fronts liquidity)');
        const result = await window.TurboBridge.execute({ from: S.from, to: S.to, amount: amt, recipient: S.recipient, onStep: _turboOnStep });
        S.txs.burnTxHash = result.txHash || S.txs.burnTxHash; S.txs.intentId = result.intentId || null;
        setStep('attest', 'done'); setStep('mint', 'done'); setStep('complete', 'done'); setProgress(100);
        logAdd('Turbo submitted — settling to Arc ⚡' + (result.intentId ? ' (intent ' + shortHash(result.intentId) + ')' : ''));
        _finishSuccess(amt, feeAtExec, started, { burnTxHash: result.txHash, mintTxHash: null, intentId: result.intentId });
        return;
      } catch (e) {
        logAdd('Turbo unavailable — switching to Standard Bridge (' + ((e && e.message) || 'error') + ')');
        toast('Turbo unavailable — using Standard Bridge', 'warning');
        S.mode = 'standard'; initSteps(); renderRoute(); renderExec(); setProgress(2);
      }
    }

    // ── Standard CCTP path (burn → attestation → mint) ──
    try {
      logAdd('Route: Standard CCTP (burn & mint)');
      const toArc = chain(S.to) && chain(S.to).domain === 26;
      const result = await AB().execute({ from: S.from, to: S.to, amount: amt, recipient: S.recipient, mode: toArc ? 'standard' : 'fast', onEvent: _standardOnEvent });
      S.txs.attestation = result.attestation || S.txs.attestation;
      setStep('complete', 'done'); setProgress(100); logAdd('Bridge completed ✓');
      _finishSuccess(amt, feeAtExec, started, { burnTxHash: result.burnTxHash, mintTxHash: result.mintTxHash });
    } catch (e) {
      _finishError(amt, feeAtExec, started, e);
    }
  };

  function onSuccess() {
    setInputsDisabled(false);
    const btn = q('xb-action'); if (btn) { btn.disabled = false; btn.classList.add('ok'); btn.innerHTML = '<i class="fas fa-circle-check"></i>Bridge Completed'; btn.onclick = window.xbAgain; }
    const a = q('xb-exec-actions'); if (a) a.innerHTML = `<div class="xb-actions2">
      ${S.txs.mintTxHash ? `<a class="xb-btn" href="${chainExplorer(S.to)}/tx/${S.txs.mintTxHash}" target="_blank" rel="noopener"><i class="fas fa-external-link-alt"></i>Open Explorer</a>` : ''}
      <button class="xb-btn" onclick="xbAgain()"><i class="fas fa-rotate"></i>Bridge Again</button>
      ${S.txs.burnTxHash ? `<a class="xb-btn" href="${chainExplorer(S.from)}/tx/${S.txs.burnTxHash}" target="_blank" rel="noopener"><i class="fas fa-receipt"></i>View Transaction</a>` : ''}
    </div>`;
  }
  function onError() {
    setInputsDisabled(false);
    const btn = q('xb-action'); if (btn) { btn.disabled = false; btn.classList.remove('ok'); btn.innerHTML = '<i class="fas fa-bolt"></i>Bridge Assets'; btn.onclick = window.xbBridge; }
    const failed = S.steps.find((s) => s.status === 'failed');
    const a = q('xb-exec-actions'); if (a) a.innerHTML = `<div class="xb-err">
      <div style="font-size:13px;font-weight:800;color:#f87171;"><i class="fas fa-triangle-exclamation"></i> ${esc(failed ? failed.title + ' failed' : 'Bridge failed')}</div>
      <div style="font-size:12px;color:#cdd8ea;margin-top:5px;">${esc(S.error || 'Unknown error')}</div>
      <div class="xb-actions2">
        <button class="xb-btn" onclick="xbRetry()" style="background:linear-gradient(135deg,#b45309,#f59e0b);border:none;color:#fff;"><i class="fas fa-rotate-right"></i>Retry</button>
        <button class="xb-btn" onclick="xbToggleTech()"><i class="fas fa-code"></i>Technical Details</button>
      </div>
      <pre id="xb-tech" style="display:none;white-space:pre-wrap;word-break:break-all;font-size:10px;color:#8aaac8;background:#05070f;border:1px solid rgba(55,138,221,.12);border-radius:8px;padding:9px;margin-top:9px;">${esc(JSON.stringify({ error: S.error, from: S.from, to: S.to, amount: S.amount, txs: S.txs }, null, 2))}</pre>
    </div>`;
  }

  // ─── Handlers ────────────────────────────────────────────────────────────────
  window.xbSetFrom = function (v) { if (v === S.to) { S.to = S.from; const t = q('xb-to'); if (t) t.value = S.to; } S.from = v; renderRoute(); loadBalance(); scheduleQuote(); };
  window.xbSetTo = function (v) { if (v === S.from) { S.from = S.to; const f = q('xb-from'); if (f) f.value = S.from; loadBalance(); } S.to = v; renderRoute(); scheduleQuote(); };
  window.xbSwap = function () { const a = S.from; S.from = S.to; S.to = a; const f = q('xb-from'), t = q('xb-to'); if (f) f.value = S.from; if (t) t.value = S.to; renderRoute(); loadBalance(); scheduleQuote(); };
  window.xbAmount = function (v) { S.amount = v; scheduleQuote(); updateActionState(); };
  window.xbQuick = function (a) { S.amount = String(a); const e = q('xb-amount'); if (e) e.value = a; scheduleQuote(); updateActionState(); };
  window.xbMax = function () { if (S.balance != null && S.balance > 0) { S.amount = String(Math.floor(S.balance * 1e6) / 1e6); const e = q('xb-amount'); if (e) e.value = S.amount; scheduleQuote(); updateActionState(); } };
  window.xbSetRecipient = function (v) { S.recipient = (v || '').trim(); updateActionState(); };
  window.xbCopy = function (text, label) { const done = () => toast(((label ? label + ' ' : '') + 'copied!').trim(), 'success'); try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(fb); else fb(); } catch (_) { fb(); } function fb() { try { const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); done(); } catch (_) {} } };
  window.xbToggleTech = function () { const t = q('xb-tech'); if (t) t.style.display = t.style.display === 'none' ? 'block' : 'none'; };
  window.xbRetry = function () { if (S.executing) return; window.xbBridge(); };
  window.xbAgain = function () {
    S.done = false; S.error = null; S.txs = {}; S.log = []; initSteps();
    const exec = q('xb-exec'); if (exec) { exec.classList.remove('in'); setTimeout(() => exec.classList.add('hidden'), 280); }
    const btn = q('xb-action'); if (btn) { btn.classList.remove('ok'); btn.innerHTML = '<i class="fas fa-bolt"></i>Bridge Assets'; btn.onclick = window.xbBridge; }
    setInputsDisabled(false); updateActionState();
  };

  // ─── Entry points ────────────────────────────────────────────────────────────
  function startHealth() { if (S.healthTimer) clearInterval(S.healthTimer); pingHealth(); S.healthTimer = setInterval(() => { const el = q('tab-content-xbridge'); if (el && !el.classList.contains('hidden') && !document.hidden) pingHealth(); }, 30000); }
  window.xbridgeInit = function () { try { build(); startHealth(); try { window.addEventListener('walletConnected', () => { S.recipient = S.recipient || wallet() || ''; const r = q('xb-recipient'); if (r && !r.value) r.value = S.recipient; loadBalance(); }); } catch (_) {} } catch (e) { console.error('[xbridge] init failed', e); } };
  window.xbridgeRefresh = function () { if (!S.built) { window.xbridgeInit(); return; } loadBalance(); pingHealth(); renderRecent(); renderStats(); };

  console.log('%c[xBridge] Premium Bridge page loaded', 'color:#06b6d4;font-weight:bold', '| v' + VERSION + ' | reuses ArcBridge CCTP V2 | real-data only');
})();
