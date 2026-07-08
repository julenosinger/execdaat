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
  const VERSION = '20260708x-complete-fix';

  const S = {
    from: null, to: null, token: 'USDC', amount: '', recipient: '', balance: null,
    quote: null, quoting: false, executing: false, done: false, error: null, mode: 'standard', turboInfo: null,
    steps: [], log: [], txs: {}, health: {}, quoteTimer: null, healthTimer: null, built: false,
    turboLive: null, turboMonitor: null,
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

  // ─── Official brand logos (inline SVG — CSP-safe, no external assets) ─────────
  // High-fidelity vector marks for every supported chain + token. Rendered inline
  // so they respect the strict img-src CSP and scale crisply at any size.
  const CHAIN_LOGOS = {
    sepolia: '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><g fill="none" fill-rule="evenodd"><circle cx="16" cy="16" r="16" fill="#627EEA"/><g fill="#FFF" fill-rule="nonzero"><path fill-opacity=".602" d="M16.498 4v8.87l7.497 3.35z"/><path d="M16.498 4L9 16.22l7.498-3.35z"/><path fill-opacity=".602" d="M16.498 21.968v6.027L24 17.616z"/><path d="M16.498 27.995v-6.028L9 17.616z"/><path fill-opacity=".2" d="M16.498 20.573l7.497-4.353-7.497-3.348z"/><path fill-opacity=".602" d="M9 16.22l7.498 4.353v-7.701z"/></g></g></svg>',
    arbsepolia: '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><g fill="none" fill-rule="evenodd"><circle cx="16" cy="16" r="16" fill="#2D374B"/><path d="M16 4l8.66 5v10L16 24l-8.66-5V9z" fill="#2D374B"/><path d="M17.9 13.6l-1.9-3.3-4.9 8.4h2.5l1.1-2 3.1 5.4 2.1-1.2-2.1-7.3zm1.2-2.1l-.9 1.6 3.4 5.9V9.9z" fill="#28A0F0"/><path d="M11.1 18.7l-.9 1.6L12 21.4l2.4-4.1z" fill="#FFF"/></g></svg>',
    basesepolia: '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="#0052FF"/><path d="M15.96 26c5.523 0 10-4.477 10-10s-4.477-10-10-10c-5.24 0-9.538 4.03-9.965 9.16h13.23v1.68H5.995C6.422 21.97 10.72 26 15.96 26z" fill="#FFF"/></svg>',
    optsepolia: '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="#FF0420"/><path d="M11.35 19.6c-.98 0-1.78-.23-2.4-.69-.62-.47-.93-1.14-.93-2 0-.18.02-.4.06-.66.11-.6.26-1.32.46-2.16.57-2.3 2.04-3.45 4.41-3.45.65 0 1.23.11 1.74.33.51.21.92.53 1.21.96.29.42.44.92.44 1.5 0 .17-.02.39-.06.65-.13.74-.28 1.46-.46 2.16-.29 1.15-.8 2.01-1.52 2.58-.72.56-1.68.85-2.9.85l.44-.02zm.16-1.8c.47 0 .87-.14 1.2-.42.34-.28.58-.71.72-1.29.19-.79.34-1.47.44-2.05.03-.17.05-.35.05-.53 0-.74-.38-1.11-1.15-1.11-.47 0-.88.14-1.21.42-.33.28-.57.71-.71 1.29-.15.58-.3 1.26-.45 2.05-.03.16-.05.33-.05.51 0 .75.4 1.13 1.18 1.13h.03zm5.6 1.68c-.09 0-.16-.03-.21-.09-.04-.06-.05-.14-.03-.23l1.55-7.3c.02-.1.07-.18.15-.24.07-.06.15-.09.24-.09h2.99c.83 0 1.5.17 2 .52.51.34.77.84.77 1.49 0 .19-.02.38-.07.59-.19.87-.57 1.51-1.16 1.93-.58.41-1.37.62-2.38.62h-1.52l-.52 2.48c-.02.1-.07.18-.15.24-.07.06-.15.09-.24.09h-1.42zm3.65-4.13c.32 0 .6-.09.84-.27.24-.18.4-.43.47-.76.02-.13.04-.24.04-.34 0-.22-.06-.38-.19-.5-.13-.11-.35-.17-.66-.17h-1.35l-.43 2.04h1.43z" fill="#FFF"/></svg>',
    arc: '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><linearGradient id="xbArcG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8B5CF6"/><stop offset="1" stop-color="#6D28D9"/></linearGradient></defs><circle cx="16" cy="16" r="16" fill="url(#xbArcG)"/><path d="M10 22l4.6-12h2.8L22 22h-2.7l-1-2.8h-4.6L12.7 22H10zm4.5-4.9h3l-1.5-4.4-1.5 4.4z" fill="#FFF"/></svg>',
    polygonAmoy: '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="#8247E5"/><path d="M20.7 13.1c-.3-.18-.7-.18-1.05 0l-2.4 1.4-1.63.92-2.36 1.4c-.3.18-.7.18-1.05 0l-1.86-1.1a1.06 1.06 0 01-.52-.9v-2.14c0-.36.18-.7.52-.9l1.85-1.06c.3-.18.7-.18 1.05 0l1.85 1.07c.3.18.53.53.53.9v1.4l1.63-.95v-1.42c0-.36-.18-.7-.52-.9l-3.44-2a1.11 1.11 0 00-1.05 0l-3.52 2.03c-.35.18-.53.53-.53.9v4.02c0 .36.18.7.53.9l3.48 2c.3.18.7.18 1.05 0l2.36-1.37 1.63-.95 2.36-1.37c.3-.18.7-.18 1.05 0l1.85 1.06c.3.18.53.53.53.9v2.14c0 .36-.18.7-.53.9l-1.82 1.07c-.3.18-.7.18-1.05 0l-1.85-1.06a1.06 1.06 0 01-.53-.9v-1.38l-1.63.95v1.4c0 .36.18.7.53.9l3.48 2c.3.18.7.18 1.05 0l3.48-2c.3-.18.53-.53.53-.9v-4.05c0-.36-.18-.7-.53-.9l-3.5-2.03z" fill="#FFF"/></svg>',
    solanaDevnet: '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><linearGradient id="xbSolG" x1="2" y1="26" x2="30" y2="6" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#9945FF"/><stop offset="1" stop-color="#14F195"/></linearGradient></defs><circle cx="16" cy="16" r="16" fill="#0B0B14"/><g fill="url(#xbSolG)"><path d="M9.4 20.1c.12-.12.28-.19.46-.19h13.2c.3 0 .45.36.24.57l-2.6 2.6a.65.65 0 01-.46.19H7.04c-.3 0-.45-.36-.24-.57l2.6-2.6z"/><path d="M9.4 9.1a.65.65 0 01.46-.19h13.2c.3 0 .45.36.24.57l-2.6 2.6a.65.65 0 01-.46.19H7.04c-.3 0-.45-.36-.24-.57l2.6-2.6z"/><path d="M20.7 14.56a.65.65 0 00-.46-.19H7.04c-.3 0-.45.36-.24.57l2.6 2.6c.12.12.28.19.46.19h13.2c.3 0 .45-.36.24-.57l-2.6-2.6z"/></g></svg>',
  };
  const TOKEN_LOGOS = {
    USDC: '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="#2775CA"/><path d="M20.5 18.6c0-2.38-1.43-3.2-4.29-3.54-2.04-.27-2.45-.82-2.45-1.78 0-.96.69-1.57 2.07-1.57 1.24 0 1.93.41 2.28 1.44.07.2.27.34.48.34h1.1c.28 0 .48-.2.48-.48v-.07a3.42 3.42 0 00-3.09-2.8V8.86c0-.27-.2-.48-.55-.55h-1.03c-.28 0-.48.21-.55.55v1.02c-2.04.27-3.33 1.64-3.33 3.34 0 2.25 1.37 3.13 4.22 3.47 1.92.34 2.52.75 2.52 1.85 0 1.1-.96 1.85-2.27 1.85-1.79 0-2.41-.75-2.62-1.78-.07-.27-.27-.41-.48-.41h-1.16a.47.47 0 00-.48.48v.07c.27 1.64 1.3 2.8 3.57 3.13v1.03c0 .27.2.48.55.55h1.03c.28 0 .48-.21.55-.55v-1.03c2.04-.34 3.4-1.78 3.4-3.61z" fill="#FFF"/><path d="M12.95 25.15c-5.3-1.92-8.02-7.84-6.03-13.07 1.03-2.87 3.3-5.06 6.03-6.09.28-.14.41-.34.41-.68v-.96c0-.27-.13-.48-.41-.55-.07 0-.2 0-.28.07a11.3 11.3 0 00-7.4 14.24c1.17 3.68 4 6.5 7.4 7.67.28.14.55 0 .62-.27.07-.07.07-.14.07-.28v-.96c0-.2-.2-.47-.41-.61zm6.16-21.44c-.28-.14-.55 0-.62.27-.07.07-.07.13-.07.27v.96c0 .27.2.55.41.68 5.3 1.92 8.02 7.84 6.03 13.07-1.03 2.87-3.3 5.06-6.03 6.09-.28.14-.41.34-.41.68v.96c0 .27.13.48.41.55.07 0 .2 0 .28-.07a11.3 11.3 0 007.4-14.24c-1.17-3.75-4.07-6.57-7.4-7.74z" fill="#FFF"/></svg>',
    EURC: '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="#1A65D6"/><path d="M18.9 20.3a4.6 4.6 0 01-3.55 1.63c-1.94 0-3.6-1.15-4.36-2.86h4.06l.63-1.45h-5.1a5.3 5.3 0 010-1.34h5.7l.62-1.45h-6.02a4.77 4.77 0 014.47-3.1c1.42 0 2.7.62 3.55 1.62l1.6-1.35A6.86 6.86 0 0015.35 9.3c-3.1 0-5.74 2.02-6.66 4.83H7.1l-.63 1.45h1.98a7.3 7.3 0 000 1.34H7.1l-.63 1.45h2.22c.92 2.8 3.56 4.82 6.66 4.82 2.02 0 3.85-.86 5.13-2.23l-1.58-1.34z" fill="#FFF"/></svg>',
    ETH: '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><g fill="none" fill-rule="evenodd"><circle cx="16" cy="16" r="16" fill="#627EEA"/><g fill="#FFF" fill-rule="nonzero"><path fill-opacity=".602" d="M16.498 4v8.87l7.497 3.35z"/><path d="M16.498 4L9 16.22l7.498-3.35z"/><path fill-opacity=".602" d="M16.498 21.968v6.027L24 17.616z"/><path d="M16.498 27.995v-6.028L9 17.616z"/><path fill-opacity=".2" d="M16.498 20.573l7.497-4.353-7.497-3.348z"/><path fill-opacity=".602" d="M9 16.22l7.498 4.353v-7.701z"/></g></g></svg>',
    cirBTC: '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="#F7931A"/><path d="M22.5 14.2c.28-1.9-1.16-2.92-3.14-3.6l.64-2.57-1.57-.4-.62 2.5c-.41-.1-.83-.2-1.26-.3l.63-2.5-1.56-.4-.64 2.58c-.34-.08-.68-.16-1-.24v-.01l-2.16-.54-.42 1.67s1.16.27 1.14.28c.63.16.75.58.73.9l-.73 2.94c.04.01.1.03.17.06l-.18-.04-1.03 4.12c-.08.2-.28.48-.72.37.02.02-1.14-.28-1.14-.28l-.78 1.8 2.04.5c.38.1.75.2 1.11.29l-.65 2.6 1.56.4.64-2.58c.43.12.84.22 1.25.32l-.64 2.56 1.57.4.65-2.6c2.66.5 4.66.3 5.5-2.1.68-1.94-.03-3.06-1.43-3.79 1.02-.24 1.79-.9 1.99-2.28zm-3.56 5c-.48 1.94-3.75.89-4.81.63l.86-3.44c1.06.26 4.46.79 3.95 2.81zm.48-5.03c-.44 1.76-3.16.87-4.04.65l.78-3.12c.88.22 3.72.63 3.26 2.47z" fill="#FFF"/></svg>',
  };
  function chainLogo(key, size) {
    const s = size || 34; const svg = CHAIN_LOGOS[key];
    if (svg) return `<span class="xb-logo" style="width:${s}px;height:${s}px;">${svg}</span>`;
    const c = chain(key);
    return `<span class="xb-logo xb-logo-fb" style="width:${s}px;height:${s}px;font-size:${Math.round(s * 0.5)}px;">${esc((c && c.icon) || '🔗')}</span>`;
  }
  function tokenLogo(sym, size) {
    const s = size || 18; const key = String(sym || 'USDC').toUpperCase(); const svg = TOKEN_LOGOS[key] || TOKEN_LOGOS.USDC;
    return `<span class="xb-tlogo" style="width:${s}px;height:${s}px;">${svg}</span>`;
  }

  // ─── Execution step model ───────────────────────────────────────────────────
  const STEP_DEFS = [
    { key: 'approve',  icon: 'fa-file-signature', title: 'Approve Token',            desc: 'Authorize USDC for the CCTP TokenMessenger' },
    { key: 'burn',     icon: 'fa-fire',           title: 'Submit Burn Transaction',  desc: 'Burn USDC on the source chain (depositForBurn)' },
    { key: 'attest',   icon: 'fa-shield-halved',  title: 'Waiting Circle Attestation', desc: 'Circle signs the cross-chain message' },
    { key: 'mint',     icon: 'fa-coins',          title: 'Mint on Destination',      desc: 'Receive & mint USDC on the destination chain' },
    { key: 'complete', icon: 'fa-flag-checkered', title: 'Completed',                desc: 'Funds delivered on the destination chain' },
  ];
  // Turbo Bridge (Other Networks → Arc) real lifecycle — 6 steps + completion
  const TURBO_STEP_DEFS = [
    { key: 'connect',  icon: 'fa-wallet',         title: 'Wallet Connected',         desc: 'Wallet connected & source network selected' },
    { key: 'approve',  icon: 'fa-file-signature', title: 'Approval Confirmed',       desc: 'USDC authorized for the CCTP TokenMessenger' },
    { key: 'intent',   icon: 'fa-bolt',           title: 'Turbo Intent Created',     desc: 'USDC burned → Turbo intent registered with Treasury' },
    { key: 'accept',   icon: 'fa-handshake',      title: 'Intent Accepted',          desc: 'Treasury Vault accepts & fronts liquidity on Arc' },
    { key: 'settle',   icon: 'fa-shield-halved',  title: 'Settlement Executed',      desc: 'Treasury settlement executed on Arc' },
    { key: 'credit',   icon: 'fa-coins',          title: 'Assets Credited on Arc',   desc: 'USDC delivered to the recipient on Arc Testnet' },
    { key: 'complete', icon: 'fa-flag-checkered', title: 'Completed',                desc: 'Turbo Bridge complete — funds available on Arc' },
  ];
  function initSteps() {
    const turbo = S.mode === 'turbo';
    if (turbo) { S.steps = TURBO_STEP_DEFS.map((d) => ({ ...d, status: 'pending', ts: null, detail: '' })); return; }
    S.steps = STEP_DEFS.map((d) => ({ ...d, status: 'pending', ts: null, detail: '' }));
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
      #tab-content-xbridge .xb-main{display:grid;grid-template-columns:1fr auto;gap:24px;align-items:start;max-width:1600px;margin:0 auto;}
      #tab-content-xbridge .xb-primary{display:flex;gap:20px;align-items:stretch;min-width:0;justify-content:center;}
      #tab-content-xbridge .xb-card{position:relative;flex:0 0 500px;width:500px;max-width:500px;min-width:0;background:linear-gradient(165deg,rgba(15,20,38,0.92),rgba(8,11,24,0.96));backdrop-filter:blur(18px) saturate(140%);-webkit-backdrop-filter:blur(18px) saturate(140%);border:1px solid rgba(96,180,255,0.16);border-radius:22px;overflow:hidden;box-shadow:0 24px 60px -18px rgba(0,0,0,.65),0 2px 0 rgba(255,255,255,.04) inset,0 0 0 1px rgba(103,232,249,.04);}
      #tab-content-xbridge .xb-card::before{content:'';position:absolute;inset:0;border-radius:22px;padding:1px;background:linear-gradient(140deg,rgba(103,232,249,.35),rgba(96,180,255,.06) 30%,transparent 55%,rgba(167,139,250,.14));-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none;}
      #tab-content-xbridge .xb-card::after{content:'';position:absolute;top:-40%;left:-10%;width:60%;height:60%;background:radial-gradient(closest-side,rgba(103,232,249,.10),transparent);pointer-events:none;}
      #tab-content-xbridge .xb-card .xb-topbar{position:relative;height:3px;background:linear-gradient(90deg,transparent,#06b6d4 40%,#1D9E75 60%,transparent);z-index:1;}
      #tab-content-xbridge .xb-card .xb-body{position:relative;padding:16px 18px;z-index:1;}
      #tab-content-xbridge .xb-sec-t{font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#8aaac8;display:flex;align-items:center;gap:7px;margin:0 0 9px;}
      /* Brand logos */
      #tab-content-xbridge .xb-logo{display:inline-flex;align-items:center;justify-content:center;border-radius:50%;overflow:hidden;flex-shrink:0;box-shadow:0 3px 10px rgba(0,0,0,.4),0 0 0 1px rgba(255,255,255,.06);}
      #tab-content-xbridge .xb-logo svg{width:100%;height:100%;display:block;}
      #tab-content-xbridge .xb-logo-fb{background:rgba(96,180,255,.12);border:1px solid rgba(96,180,255,.2);}
      #tab-content-xbridge .xb-tlogo{display:inline-flex;align-items:center;justify-content:center;border-radius:50%;overflow:hidden;flex-shrink:0;vertical-align:middle;box-shadow:0 1px 4px rgba(0,0,0,.35);}
      #tab-content-xbridge .xb-tlogo svg{width:100%;height:100%;display:block;}
      /* Route visualization — premium animated bridge */
      #tab-content-xbridge .xb-route{position:relative;display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:120px;background:radial-gradient(120% 150% at 0% 0%,rgba(6,182,212,.12),transparent 55%),radial-gradient(120% 150% at 100% 100%,rgba(167,139,250,.10),transparent 55%),linear-gradient(135deg,rgba(79,140,255,.06),rgba(10,14,26,.55));border:1px solid rgba(96,180,255,0.16);border-radius:18px;padding:14px 18px;overflow:hidden;box-shadow:0 1px 0 rgba(255,255,255,.03) inset,0 10px 30px -14px rgba(0,0,0,.6);}
      #tab-content-xbridge .xb-route-canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1;}
      #tab-content-xbridge .xb-node{position:relative;display:flex;flex-direction:column;align-items:center;gap:10px;min-width:104px;z-index:3;}
      #tab-content-xbridge .xb-node-logo{position:relative;width:52px;height:52px;border-radius:18px;display:flex;align-items:center;justify-content:center;background:linear-gradient(160deg,rgba(20,26,46,.9),rgba(8,11,24,.8));border:1px solid rgba(96,180,255,.28);box-shadow:0 10px 26px -8px rgba(0,0,0,.7),0 0 0 1px rgba(255,255,255,.04) inset;transition:transform .25s cubic-bezier(.34,1.56,.64,1),box-shadow .25s,border-color .25s;}
      #tab-content-xbridge .xb-node-logo:hover{transform:translateY(-4px) scale(1.05);border-color:rgba(103,232,249,.55);box-shadow:0 16px 36px -10px rgba(6,182,212,.5),0 0 0 1px rgba(103,232,249,.15) inset;}
      #tab-content-xbridge .xb-node-logo .xb-logo{width:44px;height:44px;box-shadow:none;}
      #tab-content-xbridge .xb-node-logo::after{content:'';position:absolute;inset:-6px;border-radius:24px;background:radial-gradient(closest-side,rgba(103,232,249,.22),transparent);opacity:.8;z-index:-1;filter:blur(4px);}
      #tab-content-xbridge .xb-node.dest .xb-node-logo::after{background:radial-gradient(closest-side,rgba(167,139,250,.24),transparent);}
      #tab-content-xbridge .xb-node-name{font-size:12px;font-weight:800;color:#dbe6f7;text-align:center;letter-spacing:-.01em;}
      #tab-content-xbridge .xb-node-tag{font-size:9px;color:#5f7ba0;text-transform:uppercase;letter-spacing:.1em;font-weight:700;}
      #tab-content-xbridge .xb-bridgewrap{position:relative;flex:1;min-width:70px;height:120px;z-index:2;display:flex;align-items:center;justify-content:center;}
      #tab-content-xbridge .xb-bridge-svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;}
      #tab-content-xbridge .xb-flow-dash{stroke-dasharray:5 9;animation:xbDash 1.1s linear infinite;}
      @keyframes xbDash{to{stroke-dashoffset:-28;}}
      #tab-content-xbridge .xb-spark{filter:drop-shadow(0 0 5px rgba(103,232,249,.9));}
      #tab-content-xbridge .xb-route-mid{position:relative;z-index:4;display:flex;flex-direction:column;align-items:center;gap:6px;}
      #tab-content-xbridge .xb-swap{width:38px;height:38px;border-radius:12px;background:linear-gradient(160deg,rgba(20,26,46,.95),rgba(8,11,24,.9));border:1px solid rgba(103,232,249,.35);color:#67e8f9;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform .35s cubic-bezier(.34,1.56,.64,1),border-color .2s,box-shadow .2s;box-shadow:0 6px 18px -6px rgba(6,182,212,.5);}
      #tab-content-xbridge .xb-swap:hover{transform:rotate(180deg) scale(1.08);border-color:#67e8f9;box-shadow:0 8px 24px -6px rgba(6,182,212,.75);}
      #tab-content-xbridge .xb-swap:active{transform:rotate(180deg) scale(.95);}
      #tab-content-xbridge .xb-route-eta{display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:700;color:#9db8d8;background:rgba(8,11,24,.7);border:1px solid rgba(96,180,255,.2);border-radius:999px;padding:4px 10px;white-space:nowrap;backdrop-filter:blur(6px);}
      #tab-content-xbridge .xb-route-cctp{position:absolute;bottom:10px;left:50%;transform:translateX(-50%);z-index:4;display:inline-flex;align-items:center;gap:5px;font-size:9px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#67e8f9;background:rgba(103,232,249,.08);border:1px solid rgba(103,232,249,.24);border-radius:999px;padding:3px 10px;}
      /* Fields */
      #tab-content-xbridge .xb-grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
      #tab-content-xbridge .xb-field{margin-bottom:9px;}
      #tab-content-xbridge .xb-lbl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#5f7ba0;margin-bottom:7px;display:flex;align-items:center;justify-content:space-between;}
      #tab-content-xbridge .xb-input,#tab-content-xbridge .xb-select{width:100%;background:rgba(12,16,32,0.65);border:1px solid rgba(96,180,255,0.16);border-radius:12px;color:#dbe4f2;font-size:14px;padding:12px 13px;outline:none;transition:border-color .18s,box-shadow .18s,background .18s;}
      #tab-content-xbridge .xb-input:hover:not(:disabled),#tab-content-xbridge .xb-select:hover:not(:disabled){border-color:rgba(103,232,249,.3);}
      #tab-content-xbridge .xb-input:focus,#tab-content-xbridge .xb-select:focus{border-color:#67e8f9;box-shadow:0 0 0 3px rgba(103,232,249,.16);background:rgba(12,16,32,0.85);}
      #tab-content-xbridge .xb-input:disabled,#tab-content-xbridge .xb-select:disabled{opacity:.55;cursor:not-allowed;}
      #tab-content-xbridge .xb-tokendisp{display:flex;align-items:center;gap:8px;width:100%;background:rgba(12,16,32,0.65);border:1px solid rgba(96,180,255,0.16);border-radius:12px;color:#dbe4f2;font-size:14px;font-weight:700;padding:11px 13px;}
      #tab-content-xbridge .xb-amount-wrap{position:relative;}
      #tab-content-xbridge .xb-amount-wrap .xb-input{padding-right:118px;}
      #tab-content-xbridge .xb-amount-wrap .xb-token{position:absolute;right:8px;top:50%;transform:translateY(-50%);display:inline-flex;align-items:center;gap:6px;font-weight:800;font-size:12px;color:#dbe4f2;background:rgba(96,180,255,0.14);border:1px solid rgba(96,180,255,0.26);border-radius:10px;padding:5px 10px;}
      #tab-content-xbridge .xb-quick{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;}
      #tab-content-xbridge .xb-qbtn{position:relative;flex:1;min-width:52px;background:linear-gradient(160deg,rgba(55,138,221,0.1),rgba(55,138,221,0.04));border:1px solid rgba(96,180,255,0.2);border-radius:11px;color:#9db8d8;font-size:12.5px;font-weight:800;padding:9px 4px;cursor:pointer;transition:transform .12s,box-shadow .18s,border-color .18s,color .18s,background .18s;}
      #tab-content-xbridge .xb-qbtn:hover{background:linear-gradient(160deg,rgba(103,232,249,.18),rgba(103,232,249,.06));color:#eef6ff;border-color:rgba(103,232,249,.45);transform:translateY(-2px);box-shadow:0 8px 20px -8px rgba(6,182,212,.55);}
      #tab-content-xbridge .xb-qbtn:active{transform:translateY(0) scale(.96);box-shadow:0 2px 8px -4px rgba(6,182,212,.4);}
      #tab-content-xbridge .xb-qbtn.sel{background:linear-gradient(160deg,rgba(103,232,249,.22),rgba(96,180,255,.1));color:#eef6ff;border-color:rgba(103,232,249,.6);box-shadow:0 0 0 1px rgba(103,232,249,.2) inset,0 6px 18px -8px rgba(6,182,212,.5);}
      #tab-content-xbridge .xb-summary{background:linear-gradient(160deg,rgba(96,180,255,0.06),rgba(96,180,255,0.02));border:1px solid rgba(96,180,255,0.14);border-radius:14px;padding:11px 13px;margin-top:6px;}
      #tab-content-xbridge .xb-srow{display:flex;align-items:center;justify-content:space-between;font-size:12px;padding:4px 0;}
      #tab-content-xbridge .xb-srow .k{color:#5f7ba0;}
      #tab-content-xbridge .xb-srow .v{color:#cdd8ea;font-weight:700;display:inline-flex;align-items:center;gap:6px;}
      #tab-content-xbridge .xb-srow.big{padding-bottom:9px;margin-bottom:3px;border-bottom:1px solid rgba(96,180,255,.1);}
      #tab-content-xbridge .xb-srow.big .v{font-size:17px;color:#67e8f9;font-weight:800;}
      #tab-content-xbridge .xb-action{position:relative;overflow:hidden;width:100%;margin-top:11px;padding:12px;border:none;border-radius:15px;font-size:15px;font-weight:800;letter-spacing:.01em;color:#fff;cursor:pointer;background:linear-gradient(120deg,#2563eb,#6d28d9 55%,#7c3aed);background-size:180% 100%;box-shadow:0 10px 30px -8px rgba(109,40,217,.55),0 0 0 1px rgba(255,255,255,.06) inset;transition:filter .15s,transform .1s,box-shadow .25s,background-position .5s;display:flex;align-items:center;justify-content:center;gap:10px;}
      #tab-content-xbridge .xb-action::before{content:'';position:absolute;top:0;left:-60%;width:45%;height:100%;background:linear-gradient(100deg,transparent,rgba(255,255,255,.35),transparent);transform:skewX(-18deg);animation:xbShimmer 3.4s ease-in-out infinite;}
      @keyframes xbShimmer{0%{left:-60%}55%,100%{left:130%}}
      #tab-content-xbridge .xb-action:hover:not(:disabled){filter:brightness(1.08);background-position:100% 0;transform:translateY(-2px);box-shadow:0 16px 40px -8px rgba(109,40,217,.7),0 0 0 1px rgba(255,255,255,.08) inset;}
      #tab-content-xbridge .xb-action:active:not(:disabled){transform:translateY(0) scale(.99);}
      #tab-content-xbridge .xb-action:disabled{opacity:.5;filter:grayscale(.3);cursor:not-allowed;box-shadow:none;}
      #tab-content-xbridge .xb-action:disabled::before{display:none;}
      #tab-content-xbridge .xb-action.ok{background:linear-gradient(120deg,#059669,#10b981);animation:xbOkPop .4s ease;}
      #tab-content-xbridge .xb-action.ok::before{display:none;}
      @keyframes xbOkPop{0%{transform:scale(.96)}50%{transform:scale(1.02)}100%{transform:scale(1)}}
      #tab-content-xbridge .xb-note{font-size:11px;color:#5f7ba0;margin-top:10px;text-align:center;}
      /* Execution panel */
      #tab-content-xbridge .xb-exec{position:relative;flex:0 0 408px;max-width:408px;min-width:0;background:linear-gradient(165deg,rgba(15,20,38,0.92),rgba(8,11,24,0.96));backdrop-filter:blur(18px) saturate(140%);-webkit-backdrop-filter:blur(18px) saturate(140%);border:1px solid rgba(103,232,249,0.22);border-radius:22px;overflow:hidden;opacity:0;transform:translateX(28px);transition:opacity .28s ease,transform .28s ease;box-shadow:0 24px 60px -18px rgba(0,0,0,.65),0 1px 0 rgba(255,255,255,.04) inset;}
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
      /* Sidebar — compact right-edge information panel */
      #tab-content-xbridge .xb-side{display:flex;flex-direction:column;gap:12px;position:sticky;top:24px;width:260px;flex-shrink:0;}
      #tab-content-xbridge .xb-panel{position:relative;background:linear-gradient(165deg,rgba(15,20,38,0.9),rgba(8,11,24,0.95));backdrop-filter:blur(16px) saturate(140%);-webkit-backdrop-filter:blur(16px) saturate(140%);border:1px solid rgba(96,180,255,0.14);border-radius:15px;padding:14px;box-shadow:0 14px 34px -16px rgba(0,0,0,.6),0 1px 0 rgba(255,255,255,.03) inset;transition:transform .2s,box-shadow .2s,border-color .2s;}
      #tab-content-xbridge .xb-panel:hover{transform:translateY(-2px);border-color:rgba(103,232,249,.2);box-shadow:0 18px 42px -16px rgba(6,182,212,.24),0 1px 0 rgba(255,255,255,.04) inset;}
      #tab-content-xbridge .xb-panel .xb-sec-t{margin:0 0 10px;font-size:10px;}
      #tab-content-xbridge .xb-scroll{max-height:220px;overflow-y:auto;margin:-2px -4px;padding:0 4px;}
      #tab-content-xbridge .xb-scroll::-webkit-scrollbar{width:5px;}
      #tab-content-xbridge .xb-scroll::-webkit-scrollbar-thumb{background:rgba(96,180,255,.18);border-radius:6px;}
      #tab-content-xbridge .xb-chain-row,#tab-content-xbridge .xb-h-row{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid rgba(96,180,255,.07);}
      #tab-content-xbridge .xb-chain-row{border-radius:8px;padding:5px 5px;transition:background .18s;}
      #tab-content-xbridge .xb-chain-row:hover{background:rgba(96,180,255,.06);}
      #tab-content-xbridge .xb-chain-row:last-child,#tab-content-xbridge .xb-h-row:last-child{border-bottom:none;}
      #tab-content-xbridge .xb-chain-ic{width:22px;height:22px;flex-shrink:0;}
      #tab-content-xbridge .xb-chain-nm{font-size:11px;color:#cdd8ea;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      #tab-content-xbridge .xb-chip{display:inline-flex;align-items:center;gap:3px;font-size:8.5px;font-weight:800;padding:2px 6px;border-radius:999px;color:#67e8f9;background:rgba(103,232,249,.1);border:1px solid rgba(103,232,249,.22);}
      #tab-content-xbridge .xb-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0;}
      #tab-content-xbridge .xb-dot-pulse{animation:xbDotPulse 1.4s ease-in-out infinite;}
      @keyframes xbDotPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(1.25)}}
      #tab-content-xbridge .xb-h-row{padding:5px 0;}
      #tab-content-xbridge .xb-h-lbl{font-size:11px;color:#cdd8ea;flex:1;}
      #tab-content-xbridge .xb-h-val{font-size:10px;font-weight:700;margin-left:auto;}
      #tab-content-xbridge .xb-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}
      #tab-content-xbridge .xb-ic{width:22px;height:22px;border-radius:6px;background:rgba(55,138,221,0.09);border:1px solid rgba(55,138,221,0.2);color:#7fa8d8;cursor:pointer;font-size:9px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;text-decoration:none;transition:all .15s;}
      #tab-content-xbridge .xb-ic:hover{background:rgba(55,138,221,0.2);color:#bcd6f5;}
      #tab-content-xbridge .xb-empty{font-size:11px;color:#5f7ba0;font-style:italic;padding:8px 2px;}
      #tab-content-xbridge .xb-mini{display:flex;align-items:center;gap:7px;padding:6px 0;border-bottom:1px solid rgba(55,138,221,.06);font-size:11px;}
      #tab-content-xbridge .xb-mini:last-child{border-bottom:none;}
      #tab-content-xbridge .xb-stats{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
      #tab-content-xbridge .xb-stat{background:rgba(55,138,221,0.05);border:1px solid rgba(55,138,221,0.12);border-radius:9px;padding:7px 9px;}
      #tab-content-xbridge .xb-stat .k{font-size:8.5px;text-transform:uppercase;letter-spacing:.05em;color:#5f7ba0;font-weight:700;}
      #tab-content-xbridge .xb-stat .v{font-size:14px;font-weight:800;color:#dde6f5;margin-top:2px;}
      #tab-content-xbridge .xb-err{background:rgba(239,68,68,.07);border:1px solid rgba(239,68,68,.28);border-radius:12px;padding:12px;margin-top:10px;}
      #tab-content-xbridge .xb-actions2{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;}
      #tab-content-xbridge .xb-btn{display:inline-flex;align-items:center;gap:7px;background:rgba(55,138,221,0.09);border:1px solid rgba(55,138,221,0.2);border-radius:10px;color:#bcd6f5;font-size:12px;font-weight:700;padding:8px 12px;cursor:pointer;text-decoration:none;}
      #tab-content-xbridge .xb-btn:hover{background:rgba(55,138,221,0.2);}
      #tab-content-xbridge .xb-exec-toggle{display:none;}
      @media (max-width:1180px){ #tab-content-xbridge .xb-card{flex-basis:460px;width:460px;} #tab-content-xbridge .xb-side{width:220px;} }
      @media (max-width:1024px){ #tab-content-xbridge .xb-main{grid-template-columns:1fr;max-width:640px;} #tab-content-xbridge .xb-side{position:static;width:100%;flex-direction:row;flex-wrap:wrap;} #tab-content-xbridge .xb-side>.xb-panel{flex:1 1 240px;} #tab-content-xbridge .xb-primary{justify-content:center;flex-wrap:wrap;} #tab-content-xbridge .xb-card{flex-basis:auto;width:100%;max-width:560px;} }
      @media (max-width:760px){ #tab-content-xbridge .xb-side{flex-direction:column;} #tab-content-xbridge .xb-side>.xb-panel{flex:1 1 auto;} #tab-content-xbridge .xb-primary{flex-direction:column;align-items:stretch;} #tab-content-xbridge .xb-card{flex-basis:auto;width:100%;max-width:none;} #tab-content-xbridge .xb-exec{flex-basis:auto;max-width:none;} #tab-content-xbridge .xb-grid2{grid-template-columns:1fr;} #tab-content-xbridge .xb-node{min-width:78px;} #tab-content-xbridge .xb-node-logo{width:56px;height:56px;} #tab-content-xbridge .xb-card .xb-body{padding:16px;} }
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

                <p class="xb-sec-t" style="margin-top:12px;"><i class="fas fa-sliders" style="color:#60b4ff;"></i>Bridge Details</p>
                <div class="xb-grid2">
                  <div class="xb-field"><div class="xb-lbl">Source Chain</div><select id="xb-from" class="xb-select" onchange="xbSetFrom(this.value)">${chainOptions(S.from)}</select></div>
                  <div class="xb-field"><div class="xb-lbl">Destination Chain</div><select id="xb-to" class="xb-select" onchange="xbSetTo(this.value)">${chainOptions(S.to)}</select></div>
                </div>
                <div class="xb-grid2">
                  <div class="xb-field"><div class="xb-lbl">Source Token</div><div class="xb-tokendisp">${tokenLogo('USDC', 20)}<span>USDC</span><i class="fas fa-lock" style="margin-left:auto;font-size:9px;color:#5f7ba0;"></i></div></div>
                  <div class="xb-field"><div class="xb-lbl"><span>Amount</span><span id="xb-bal" class="xb-mono" style="color:#5f7ba0;font-weight:600;">Balance: —</span></div>
                    <div class="xb-amount-wrap"><input id="xb-amount" class="xb-input" type="number" min="0" step="0.01" placeholder="0.00" oninput="xbAmount(this.value)"><span class="xb-token">${tokenLogo('USDC', 16)}USDC <button type="button" onclick="xbMax()" style="background:none;border:none;color:#67e8f9;font-weight:800;cursor:pointer;font-size:10px;">MAX</button></span></div>
                  </div>
                </div>
                <div class="xb-field"><div class="xb-lbl">Recipient Address (destination)</div><input id="xb-recipient" class="xb-input xb-mono" type="text" placeholder="0x…" value="${esc(S.recipient)}" oninput="xbSetRecipient(this.value)"></div>
                <div class="xb-quick">
                  ${[10, 50, 100, 500, 1000].map((a) => `<button class="xb-qbtn" data-amt="${a}" onclick="xbQuick(${a})">${a}</button>`).join('')}
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
                <div id="xb-turbo-status" style="display:none;"></div>
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
    reconcileTurboHistory();
    renderRoute(); renderSummary(); renderSupportedChains(); renderRecent(); renderStats(); renderHealth();
    loadBalance(); scheduleQuote();
  }

  // ─── Renderers ──────────────────────────────────────────────────────────────
  function renderRoute() {
    const el = q('xb-route'); if (!el) return; const tc = chain(S.to);
    const eta = S.quote ? S.quote.estTime : (tc && tc.domain === 26 ? '~15+ min' : '~1–2 min');
    const modeChip = S.mode === 'turbo'
      ? '<span class="xb-chip" style="color:#fbbf24;background:rgba(251,191,36,.1);border-color:rgba(251,191,36,.25);"><i class="fas fa-bolt" style="font-size:8px;"></i>Turbo Route</span>'
      : '<span class="xb-chip">Standard</span>';
    const bottomLabel = S.mode === 'turbo'
      ? '<span class="xb-route-cctp" style="color:#fbbf24;background:rgba(251,191,36,.08);border-color:rgba(251,191,36,.24);"><i class="fas fa-bolt" style="font-size:8px;"></i> Turbo Bridge · Treasury-fronted · CCTP V2</span>'
      : '<span class="xb-route-cctp"><i class="fas fa-shield-halved" style="font-size:8px;"></i> Powered by Circle CCTP V2</span>';
    el.innerHTML = `
      <svg class="xb-route-canvas" viewBox="0 0 600 168" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="xbWaveG" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stop-color="#60b4ff" stop-opacity="0"/>
            <stop offset="0.5" stop-color="#67e8f9" stop-opacity="0.5"/>
            <stop offset="1" stop-color="#a78bfa" stop-opacity="0"/>
          </linearGradient>
          <radialGradient id="xbDepthG" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stop-color="#67e8f9" stop-opacity="0.12"/>
            <stop offset="1" stop-color="#67e8f9" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <ellipse cx="300" cy="90" rx="230" ry="46" fill="url(#xbDepthG)"/>
        <path d="M40,84 C170,34 430,34 560,84" fill="none" stroke="rgba(96,180,255,.12)" stroke-width="14" stroke-linecap="round"/>
        <path d="M40,84 C170,34 430,34 560,84" fill="none" stroke="url(#xbWaveG)" stroke-width="5" stroke-linecap="round"/>
        <path d="M40,84 C170,34 430,34 560,84" fill="none" stroke="#67e8f9" stroke-width="2.5" stroke-linecap="round" class="xb-flow-dash" opacity="0.85"/>
        <path d="M40,104 C170,150 430,150 560,104" fill="none" stroke="rgba(167,139,250,.18)" stroke-width="2" stroke-linecap="round"/>
        <g class="xb-spark">
          <circle r="4.5" fill="#67e8f9">
            <animateMotion dur="2.6s" repeatCount="indefinite" path="M40,84 C170,34 430,34 560,84"/>
            <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.1;0.9;1" dur="2.6s" repeatCount="indefinite"/>
          </circle>
          <circle r="3" fill="#a78bfa">
            <animateMotion dur="2.6s" begin="0.9s" repeatCount="indefinite" path="M40,84 C170,34 430,34 560,84"/>
            <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.1;0.9;1" dur="2.6s" begin="0.9s" repeatCount="indefinite"/>
          </circle>
          <circle r="2.5" fill="#60b4ff">
            <animateMotion dur="2.6s" begin="1.7s" repeatCount="indefinite" path="M40,84 C170,34 430,34 560,84"/>
            <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.1;0.9;1" dur="2.6s" begin="1.7s" repeatCount="indefinite"/>
          </circle>
        </g>
      </svg>

      <div class="xb-node src">
        <div class="xb-node-logo">${chainLogo(S.from, 44)}</div>
        <div class="xb-node-name">${esc(chainShort(S.from))}</div>
        <div class="xb-node-tag">Source</div>
      </div>

      <div class="xb-bridgewrap">
        <div class="xb-route-mid">
          <button class="xb-swap" onclick="xbSwap()" title="Swap direction" aria-label="Swap direction"><i class="fas fa-right-left"></i></button>
          <span class="xb-route-eta"><i class="far fa-clock"></i> ${esc(eta)}</span>
          ${modeChip}
        </div>
      </div>

      <div class="xb-node dest">
        <div class="xb-node-logo">${chainLogo(S.to, 44)}</div>
        <div class="xb-node-name">${esc(chainShort(S.to))}</div>
        <div class="xb-node-tag">Destination</div>
      </div>

      ${bottomLabel}`;
  }

  function renderSummary() {
    const el = q('xb-summary'); if (!el) return; const qo = S.quote;
    const recv = qo ? Math.max(0, qo.output - (qo.bridgeFee || 0)) : null;
    const tk = tokenLogo('USDC', 16);
    el.innerHTML = `
      <div class="xb-srow big"><span class="k">Estimated Received</span><span class="v">${recv != null ? tk + fmt(recv) + ' USDC' : (S.quoting ? '…' : '—')}</span></div>
      <div class="xb-srow"><span class="k">Bridge Fee (relayer)</span><span class="v">${qo ? fmt(qo.bridgeFee, 2) + ' USDC' : '—'}</span></div>
      <div class="xb-srow"><span class="k">Network Fee</span><span class="v">${qo ? fmt(qo.protocolFee, 2) + ' USDC' : '—'}</span></div>
      <div class="xb-srow"><span class="k">Gas Fee (est.)</span><span class="v">${qo ? '~' + fmt(qo.gasFeeEst, 2) : '—'}</span></div>
      <div class="xb-srow"><span class="k">Estimated Time</span><span class="v">${qo ? esc(qo.estTime) : '—'}</span></div>
      <div class="xb-srow"><span class="k">Route</span><span class="v">${qo ? esc(qo.routeType) + ' · ' + esc(qo.mode) : 'Native Burn & Mint'}</span></div>`;
  }

  function renderSupportedChains() {
    const el = q('xb-chains'); if (!el) return;
    const rows = chains().map((c) => `<div class="xb-chain-row">${chainLogo(c.key, 22).replace('class="xb-logo', 'class="xb-chain-ic xb-logo')}<span class="xb-chain-nm">${esc(c.name)}</span><span class="xb-chip">${tokenLogo('USDC', 11)}USDC</span></div>`).join('');
    el.innerHTML = rows ? `<div class="xb-scroll">${rows}</div>` : `<div class="xb-empty">No chains.</div>`;
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
    const dotColor = (s) => s === 'completed' ? '#34d399' : (s === 'processing' ? '#fbbf24' : '#f87171');
    const dotGlow = (s) => s === 'completed' ? 'rgba(52,211,153,.6)' : (s === 'processing' ? 'rgba(251,191,36,.6)' : 'rgba(248,113,113,.6)');
    el.innerHTML = hist.slice(0, 3).map((b) => `<div class="xb-mini"><span class="xb-dot ${b.status === 'processing' ? 'xb-dot-pulse' : ''}" style="background:${dotColor(b.status)};box-shadow:0 0 7px ${dotGlow(b.status)};"></span><div style="flex:1;min-width:0;"><div style="color:#cdd8ea;font-weight:700;display:flex;align-items:center;gap:5px;">${tokenLogo('USDC', 12)}${fmt(b.amount)} USDC${b.status === 'processing' ? '<span style="color:#fbbf24;font-size:8.5px;font-weight:800;margin-left:2px;">SETTLING</span>' : ''}</div><div style="color:#5f7ba0;font-size:9.5px;display:flex;align-items:center;gap:3px;flex-wrap:wrap;">${chainLogo(b.from, 12)} ${esc(chainShort(b.from))} <i class="fas fa-arrow-right" style="font-size:7px;"></i> ${chainLogo(b.to, 12)} ${esc(chainShort(b.to))} · ${b.mode === 'turbo' ? '⚡' : 'Std'} · ${esc(timeAgo(b.ts))}</div></div>${b.mintTxHash ? exLink('mint', b.mintTxHash, b.to) : (b.burnTxHash ? exLink('burn', b.burnTxHash, b.from) : '')}</div>`).join('');
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
    renderTurboStatus();
  }
  function renderLog() { const el = q('xb-log'); if (!el) return; el.innerHTML = S.log.map((l) => `<div class="xb-log-line"><span class="t">${esc(l.t)}</span><span class="m">${esc(l.msg)}</span></div>`).join('') || '<div style="color:#3a6090;">Waiting for activity…</div>'; el.scrollTop = el.scrollHeight; }

  // Live Turbo status — real values sourced from the intent record + reserves.
  function renderTurboStatus() {
    const el = q('xb-turbo-status'); if (!el) return;
    if (S.mode !== 'turbo' || !S.turboLive) { el.style.display = 'none'; el.innerHTML = ''; return; }
    el.style.display = 'block';
    const L = S.turboLive;
    const info = S.turboInfo || {};
    const statusColor = { Submitting: '#67e8f9', Created: '#67e8f9', 'Awaiting Operator': '#fbbf24', Fulfilled: '#34d399', Settled: '#34d399', Failed: '#f87171' }[L.status] || '#9db8d8';
    const arrival = L.status === 'Settled' ? 'Delivered' : (L.status === 'Fulfilled' ? 'Credited · finalizing' : '~8–15 sec');
    const settlement = L.status === 'Settled' ? 'Confirmed' : (L.status === 'Fulfilled' ? 'Fronted · settling' : (L.status === 'Failed' ? 'Failed' : 'In progress'));
    const srcTx = L.srcTxHash || S.txs.burnTxHash;
    const dstTx = L.arcTxHash || S.txs.mintTxHash;
    const row = (k, v, extra) => `<div class="xb-txrow"><span class="k">${esc(k)}</span><span class="v xb-mono" title="${esc(String(v == null ? '' : v))}">${v != null && v !== '' ? v : '—'}</span>${extra || ''}</div>`;
    el.innerHTML = `
      <p class="xb-sec-t" style="margin-top:16px;"><i class="fas fa-bolt" style="color:#fbbf24;"></i>Turbo Bridge · Live Status</p>
      <div class="xb-txcard" style="border-color:rgba(251,191,36,.18);">
        ${row('Turbo Intent ID', L.intentId ? esc(shortHash(L.intentId)) : '—', L.intentId ? copyBtn(L.intentId, 'intent id') : '')}
        <div class="xb-txrow"><span class="k">Current Status</span><span class="v" style="color:${statusColor};font-weight:800;">${esc(L.status || '—')}</span></div>
        <div class="xb-txrow"><span class="k">Settlement Status</span><span class="v" style="color:${statusColor};">${esc(settlement)}</span></div>
        ${row('Source Tx Hash', srcTx ? esc(shortHash(srcTx)) : '—', srcTx ? (copyBtn(srcTx, 'source tx') + exLink('burn', srcTx, S.from)) : '')}
        ${row('Destination Tx Hash', dstTx ? esc(shortHash(dstTx)) : '—', dstTx ? (copyBtn(dstTx, 'arc tx') + exLink('mint', dstTx, S.to)) : '')}
        <div class="xb-txrow"><span class="k">Estimated Arrival</span><span class="v">${esc(arrival)}</span></div>
        <div class="xb-txrow"><span class="k">Net Received</span><span class="v">${L.netAmount != null ? fmt(L.netAmount) + ' USDC' : '—'}</span></div>
        <div class="xb-txrow"><span class="k">Turbo Fee</span><span class="v">${L.feeAmount != null ? fmt(L.feeAmount, 2) + ' USDC' : '—'}</span></div>
        <div class="xb-txrow"><span class="k">Treasury Vault</span><span class="v xb-mono" title="${esc(info.vault || '')}">${info.vault ? esc(shortAddr(info.vault)) : '—'}</span>${info.vault ? copyBtn(info.vault, 'vault') : ''}</div>
        <div class="xb-txrow"><span class="k">Liquidity Reserves</span><span class="v">${info.reserves != null ? fmt(info.reserves) + ' USDC' : '—'}</span></div>
      </div>`;
  }

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
      // ── Turbo Bridge auto-selection (Other Networks → Arc Testnet ONLY) ──
      // Turbo is chosen automatically whenever the destination is Arc AND the
      // Treasury Vault has enough on-chain liquidity to front the transfer.
      // The outbound Arc→* route (and any non-Arc destination) always stays on
      // the Standard CCTP bridge. Availability failures fall back silently.
      const TB = window.TurboBridge; let usedTurbo = false;
      if (TB && typeof TB.isTurboRoute === 'function' && TB.isTurboRoute(S.from, S.to)) {
        try {
          const avail = await TB.isAvailable(S.from, amt);
          if (avail && avail.available) {
            const tq = TB.getQuote({ from: S.from, to: S.to, amount: amt, reserves: avail.reserves });
            S.quote = normalizeQuote(tq, 'turbo'); S.mode = 'turbo'; S.turboInfo = avail.info || (tq && tq._turbo) || null; usedTurbo = true;
          } else if (note && avail && avail.reason) {
            // Route is Turbo-eligible but unavailable → Standard fallback (informational only)
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
  // ─── Bridge Steps preview visibility ───────────────────────────────────────
  // The Bridge Steps (execution) panel becomes visible as soon as the form holds
  // a valid bridge configuration — Source Chain, Destination Chain, Token and
  // Amount > 0 — with every step in its initial "Waiting" state, so the user can
  // preview the whole flow BEFORE clicking Bridge. While a bridge is executing or
  // finished, the existing execution logic owns the panel (this is a no-op then).
  function readyForPreview() {
    const amt = parseFloat(S.amount) || 0;
    const sup = AB() ? AB().isRouteSupported(S.from, S.to) : { ok: false };
    return !!(S.from && S.to && S.from !== S.to && S.token && amt > 0 && sup && sup.ok);
  }
  function updateStepsPreview() {
    const exec = q('xb-exec'); if (!exec) return;
    if (S.executing || S.done) return; // execution controls the panel while running
    if (readyForPreview()) {
      initSteps();          // all steps → 'pending' (renders as "Waiting")
      renderExec();
      if (exec.classList.contains('hidden')) {
        exec.classList.remove('hidden');
        requestAnimationFrame(() => exec.classList.add('in'));
      }
    } else if (!exec.classList.contains('hidden')) {
      exec.classList.remove('in');
      exec.classList.add('hidden');
    }
  }

  function updateActionState() {
    updateStepsPreview();
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
  // Turbo (Treasury Vault) core progress mapping → 6-step lifecycle model.
  // turbo-bridge-core emits onStep(n): 0=switch/connect, 1=approve, 2=burn/intent,
  // 3=switch-to-Arc/reserve, 4=intent created & settling.
  function _turboOnStep(stepNum, msg) {
    switch (stepNum) {
      case 0:
        setStep('connect', 'done');
        setStep('approve', 'active');
        logAdd('Wallet connected — switching to ' + chainName(S.from) + '…');
        setProgress(8);
        break;
      case 1:
        setStep('approve', 'active');
        logAdd('Requesting USDC approval for CCTP TokenMessenger…');
        setProgress(16);
        break;
      case 2:
        setStep('approve', 'done');
        setStep('intent', 'active');
        logAdd('Burning USDC on ' + chainShort(S.from) + ' → registering Turbo intent…');
        setProgress(34);
        break;
      case 3:
        setStep('intent', 'done');
        setStep('accept', 'active');
        logAdd('Switching to Arc — Treasury Vault reserving liquidity…');
        setProgress(52);
        break;
      case 4:
        setStep('accept', 'done');
        setStep('settle', 'active', 'Settlement executing on Arc');
        logAdd('Turbo intent accepted — settlement executing on Arc…');
        setProgress(70);
        break;
      default: break;
    }
    if (msg) logAdd(String(msg));
    renderTurboStatus();
  }

  // ── Real-time Turbo intent lifecycle monitor ──
  // After the burn + intent creation returns, poll the RepaymentContract store
  // (updated by turbo-core's on-chain operator + settlement pollers) until the
  // intent reaches Fulfilled → Settled (or Failed). No simulated progress: every
  // status transition is driven by the real intent record.
  function _turboFindIntent(intentId) {
    try {
      if (window.RepaymentContract && typeof window.RepaymentContract.getAll === 'function') {
        return window.RepaymentContract.getAll().find((i) => i.id === intentId || i.intentId === intentId) || null;
      }
    } catch (_) {}
    return null;
  }
  // ── Derived completion — the UI must NOT depend on a single event/status. ──
  // A Turbo bridge is finalized when ANY real-state signal confirms delivery:
  // destination tx confirmed (arcTxHash), assets credited (Fulfilled/Credited),
  // settlement completed, or intent status Settled/Completed. Any one finalizes.
  function _turboIsComplete(it) {
    if (!it) return false;
    const st = String(it.status || '').toLowerCase();
    const settle = String(it.settlementStatus || it.settlement || '').toLowerCase();
    return (
      !!it.arcTxHash ||                                             // destination tx / assets credited
      it.completed === true ||
      /^(settled|completed|complete|fulfilled|credited|delivered)$/.test(st) ||
      /^(settled|completed|complete|done)$/.test(settle)
    );
  }
  function _turboStopMonitor() { if (S.turboMonitor) { clearInterval(S.turboMonitor); S.turboMonitor = null; } }
  function _turboMonitorIntent(intentId, amt, feeAtExec, started, onDone) {
    _turboStopMonitor();
    let ticks = 0;
    const MAX_TICKS = 300; // ~15 min at 3s
    const tick = () => {
      ticks++;
      const it = _turboFindIntent(intentId);
      if (it) {
        S.turboLive = Object.assign({}, S.turboLive, {
          intentId: it.id, status: it.status,
          arcTxHash: it.arcTxHash || null,
          settlementTxHash: it.settlementTxHash || null,
          cctpMsgHash: it.cctpMsgHash || null,
          netAmount: it.netAmount, feeAmount: it.feeAmount,
          updatedAt: it.updatedAt,
        });
        // Map REAL intent state → completion (derived, not event-only).
        const st = String(it.status || '');
        const arcTx = it.arcTxHash || S.txs.mintTxHash || null;
        if (arcTx) S.txs.mintTxHash = arcTx;

        if (_turboIsComplete(it)) {
          setStep('intent', 'done');
          setStep('accept', 'done');
          setStep('settle', 'done');
          setStep('credit', 'done', arcTx ? 'Credited · ' + shortHash(arcTx) : 'Assets credited on ' + chainShort(S.to));
          setStep('complete', 'done', 'Funds available on ' + chainShort(S.to));
          setProgress(100);
          logAdd('Turbo Bridge complete — funds available on ' + chainShort(S.to) + (arcTx ? ' (' + shortHash(arcTx) + ')' : ''));
          _turboStopMonitor();
          onSuccess();
          if (typeof onDone === 'function') onDone(true, it);
          renderExec(); renderTurboStatus();
          return;
        }
        if (st === 'Failed') {
          _turboStopMonitor();
          logAdd('Turbo settlement failed: ' + (it.settlementError || 'unknown'));
          if (typeof onDone === 'function') onDone(false, it);
          renderTurboStatus();
          return;
        }
        renderExec(); renderTurboStatus();
      }
      if (ticks >= MAX_TICKS) {
        _turboStopMonitor();
        // Timeout: intent remains queued (operator will still fulfil). Treat as
        // submitted-success so the user is not blocked; recent list shows pending.
        if (typeof onDone === 'function') onDone(true, it, true);
      }
    };
    tick();
    S.turboMonitor = setInterval(tick, 3000);
  }
  function _finishSuccess(amt, feeAtExec, started, res) {
    S.done = true; S.executing = false;
    saveHist({ from: S.from, to: S.to, amount: amt, burnTxHash: res.burnTxHash, mintTxHash: res.mintTxHash, ts: Date.now(), status: 'completed', durationMs: Date.now() - started, fee: feeAtExec, mode: S.mode, intentId: res.intentId || null });
    renderExec(); renderRecent(); renderStats(); onSuccess();
    toast(S.mode === 'turbo' ? 'Turbo Bridge submitted — settling to Arc ⚡' : 'Bridge completed', 'success');
  }
  // Turbo submitted — burn + intent confirmed. Unblocks the UI while the real
  // settlement lifecycle keeps updating the panel/status via the monitor.
  function _finishTurboSubmitted() {
    S.done = true; S.executing = false;
    setInputsDisabled(false);
    const btn = q('xb-action'); if (btn) { btn.disabled = false; btn.classList.add('ok'); btn.innerHTML = '<i class="fas fa-bolt"></i>Turbo Submitted — Settling…'; btn.onclick = window.xbAgain; }
    const a = q('xb-exec-actions'); if (a) a.innerHTML = `<div class="xb-actions2">
      ${S.txs.burnTxHash ? `<a class="xb-btn" href="${chainExplorer(S.from)}/tx/${S.txs.burnTxHash}" target="_blank" rel="noopener"><i class="fas fa-receipt"></i>View Source Tx</a>` : ''}
      <button class="xb-btn" onclick="xbAgain()"><i class="fas fa-rotate"></i>Bridge Again</button>
    </div>`;
    renderExec();
  }
  // Update the persisted history entry for a Turbo intent once its real status is known.
  function _turboUpdateHistory(intentId, ok, it) {
    try {
      const all = loadHist();
      const idx = all.findIndex((h) => h.intentId && h.intentId === intentId);
      if (idx === -1) return;
      const settled = ok && _turboIsComplete(it);
      all[idx].status = settled ? 'completed' : (ok ? 'processing' : 'failed');
      if (it && it.arcTxHash) all[idx].mintTxHash = it.arcTxHash;
      if (settled) all[idx].durationMs = Date.now() - (all[idx].ts || Date.now());
      localStorage.setItem(HIST_KEY, JSON.stringify(all.slice(0, 60)));
      renderRecent(); renderStats();
    } catch (_) {}
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

    // ── Turbo Bridge path (Other Networks → Arc) — falls back to Standard on any failure ──
    if (S.mode === 'turbo' && window.TurboBridge) {
      // Re-verify availability at execution time (reserves may have changed)
      let stillAvailable = true;
      try {
        const av = await window.TurboBridge.isAvailable(S.from, amt);
        stillAvailable = !!(av && av.available);
        if (!stillAvailable) logAdd('Turbo route unavailable (' + ((av && av.reason) || 'no liquidity') + ').');
      } catch (_) { stillAvailable = false; }

      if (stillAvailable) {
        try {
          logAdd('Route: Turbo Bridge ⚡ (Treasury Vault fronts liquidity on Arc)');
          setStep('connect', 'done');
          S.turboLive = { intentId: null, status: 'Submitting', feeAmount: feeAtExec, netAmount: Math.max(0, amt - feeAtExec) };
          renderTurboStatus();

          const result = await window.TurboBridge.execute({ from: S.from, to: S.to, amount: amt, recipient: S.recipient, onStep: _turboOnStep });
          S.txs.burnTxHash = result.txHash || S.txs.burnTxHash;
          S.txs.intentId = result.intentId || null;
          S.turboLive = Object.assign({}, S.turboLive, { intentId: result.intentId || null, status: 'Created', srcTxHash: result.txHash || null });

          setStep('intent', 'done');
          setStep('accept', 'active');
          setProgress(58);
          logAdd('Turbo intent created' + (result.intentId ? ' (' + shortHash(result.intentId) + ')' : '') + ' — monitoring settlement…');
          renderExec(); renderTurboStatus();

          // Persist as processing; monitor updates it to completed on real settlement.
          saveHist({ from: S.from, to: S.to, amount: amt, burnTxHash: result.txHash, mintTxHash: null, ts: Date.now(), status: 'processing', durationMs: null, fee: feeAtExec, mode: 'turbo', intentId: result.intentId || null });
          renderRecent(); renderStats();

          // Submitted successfully — unblock the UI immediately while the real
          // intent lifecycle continues to update the panel via the monitor.
          _finishTurboSubmitted();

          _turboMonitorIntent(result.intentId, amt, feeAtExec, started, (ok, it, timedOut) => {
            _turboUpdateHistory(result.intentId, ok, it);
            if (ok && _turboIsComplete(it)) {
              toast('Turbo Bridge complete — assets credited on ' + chainShort(S.to) + ' ⚡', 'success');
            } else if (timedOut) {
              logAdd('Settlement still processing — operator will complete fulfillment. Track it in Recent Bridges.');
            } else if (!ok) {
              toast('Turbo settlement failed', 'error');
            }
          });
          return;
        } catch (e) {
          _turboStopMonitor();
          logAdd('Turbo execution failed — switching to Standard Bridge (' + ((e && e.message) || 'error') + ')');
          toast('Turbo route unavailable. Switching to Standard Bridge.', 'warning');
          S.mode = 'standard'; S.turboLive = null; initSteps(); renderRoute(); renderExec(); renderTurboStatus(); setProgress(2);
        }
      } else {
        // Turbo eligible but not available now → automatic Standard fallback.
        logAdd('Turbo route unavailable. Switching to Standard Bridge.');
        toast('Turbo route unavailable. Switching to Standard Bridge.', 'warning');
        S.mode = 'standard'; S.turboLive = null; initSteps(); renderRoute(); renderExec(); renderTurboStatus(); setProgress(2);
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
  function syncQuickBtns() { try { const cur = String(parseFloat(S.amount) || ''); document.querySelectorAll('#tab-content-xbridge .xb-qbtn').forEach((b) => { b.classList.toggle('sel', b.getAttribute('data-amt') === cur); }); } catch (_) {} }
  window.xbAmount = function (v) { S.amount = v; scheduleQuote(); updateActionState(); syncQuickBtns(); };
  window.xbQuick = function (a) { S.amount = String(a); const e = q('xb-amount'); if (e) e.value = a; scheduleQuote(); updateActionState(); syncQuickBtns(); };
  window.xbMax = function () { if (S.balance != null && S.balance > 0) { S.amount = String(Math.floor(S.balance * 1e6) / 1e6); const e = q('xb-amount'); if (e) e.value = S.amount; scheduleQuote(); updateActionState(); syncQuickBtns(); } };
  window.xbSetRecipient = function (v) { S.recipient = (v || '').trim(); updateActionState(); };
  window.xbCopy = function (text, label) { const done = () => toast(((label ? label + ' ' : '') + 'copied!').trim(), 'success'); try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(fb); else fb(); } catch (_) { fb(); } function fb() { try { const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); done(); } catch (_) {} } };
  window.xbToggleTech = function () { const t = q('xb-tech'); if (t) t.style.display = t.style.display === 'none' ? 'block' : 'none'; };
  window.xbRetry = function () { if (S.executing) return; window.xbBridge(); };
  window.xbAgain = function () {
    _turboStopMonitor();
    S.done = false; S.error = null; S.txs = {}; S.log = []; S.turboLive = null; initSteps();
    const ts = q('xb-turbo-status'); if (ts) { ts.style.display = 'none'; ts.innerHTML = ''; }
    const exec = q('xb-exec'); if (exec) { exec.classList.remove('in'); setTimeout(() => { if (!readyForPreview()) exec.classList.add('hidden'); }, 280); }
    const btn = q('xb-action'); if (btn) { btn.classList.remove('ok'); btn.innerHTML = '<i class="fas fa-bolt"></i>Bridge Assets'; btn.onclick = window.xbBridge; }
    setInputsDisabled(false); updateActionState();
  };

  // Reconcile any 'processing' Turbo history entries against the real intent
  // store (turbo-core's independent on-chain pollers keep it fresh). Ensures the
  // Recent Bridges list finalizes even if the user left the panel mid-settlement.
  function reconcileTurboHistory() {
    try {
      const all = loadHist();
      let changed = false;
      all.forEach((h) => {
        if (h.mode === 'turbo' && h.status === 'processing' && h.intentId) {
          const it = _turboFindIntent(h.intentId);
          if (it) {
            const st = String(it.status || '');
            if (it.arcTxHash && !h.mintTxHash) { h.mintTxHash = it.arcTxHash; changed = true; }
            if (_turboIsComplete(it)) { h.status = 'completed'; if (!h.durationMs) h.durationMs = Date.now() - (h.ts || Date.now()); changed = true; }
            else if (st === 'Failed') { h.status = 'failed'; changed = true; }
          }
        }
      });
      if (changed) localStorage.setItem(HIST_KEY, JSON.stringify(all.slice(0, 60)));
    } catch (_) {}
  }

  // ─── Entry points ────────────────────────────────────────────────────────────
  function startHealth() { if (S.healthTimer) clearInterval(S.healthTimer); pingHealth(); S.healthTimer = setInterval(() => { const el = q('tab-content-xbridge'); if (el && !el.classList.contains('hidden') && !document.hidden) pingHealth(); }, 30000); }
  window.xbridgeInit = function () { try { build(); startHealth(); try { window.addEventListener('walletConnected', () => { S.recipient = S.recipient || wallet() || ''; const r = q('xb-recipient'); if (r && !r.value) r.value = S.recipient; loadBalance(); }); } catch (_) {} } catch (e) { console.error('[xbridge] init failed', e); } };
  window.xbridgeRefresh = function () { if (!S.built) { window.xbridgeInit(); return; } reconcileTurboHistory(); loadBalance(); pingHealth(); renderRecent(); renderStats(); };

  console.log('%c[xBridge] Premium Bridge page loaded', 'color:#06b6d4;font-weight:bold', '| v' + VERSION + ' | reuses ArcBridge CCTP V2 | real-data only');
})();
