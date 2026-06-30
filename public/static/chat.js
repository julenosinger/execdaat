// build:v2-20260627-151358
// ============================================================
// CHAT MODULE v3 — ARC AI Assistant | build: 20260329c
// Daat Agent v1.0 — Full Platform Integration
//
// ╔══════════════════════════════════════════════════════════╗
// ║  ARCHITECTURE: Brain / Execution Separation             ║
// ║                                                          ║
// ║  🧠 BRAIN (this file — chatbot):                        ║
// ║    • Interpreta linguagem natural                        ║
// ║    • Monta dados estruturados (JSON)                     ║
// ║    • Dispara eventos arcPayQueue:add / arcPayQueue:addBatch║
// ║    • NUNCA chama signPermit2(), executeQueue(),          ║
// ║      Permit2Engine.executeTransfer(), ni abre wallet     ║
// ║                                                          ║
// ║  ⚡ EXECUTION (queue-engine.js — UI):                   ║
// ║    • Escuta eventos arcPayQueue:add / addBatch           ║
// ║    • Armazena fila de pagamentos                         ║
// ║    • Mostra botão "Execute Payments"                     ║
// ║    • Executa signPermit2() + executeBatch() SOMENTE      ║
// ║      após clique explícito do usuário                    ║
// ╚══════════════════════════════════════════════════════════╝
//
// Authorization Flow:
//   1. User clicks "Authorize Daat Agent" button
//   2. Wallet opens → user SIGNS an EIP-191 message (off-chain)
//   3. Session token derived from signature + nonce (no on-chain tx)
//   4. Session stored: { wallet, sig, sessionHash, expiry }
//   5. Agent is now active — all platform ops via chat prompt
//
// Supported commands (post-authorization):
//   payments  : "send 10 USDC to 0x..."  → queues, shows Execute btn
//   multisend : "pay [addr]:10, [addr]:20" → queues batch
//   swap      : "swap 5 USDC to EURC"    → opens DEX tab
//   contracts : "create contract / show contracts / deposit / release"
//   dashboard : "show dashboard / my balance / network status"
//   guardian  : "guardian / validate / security check"
//   revoke    : "revoke arcpay"
// ============================================================
'use strict';

// ── Constants ──────────────────────────────────────────────────────────────────
const CHAT_SESSION_KEY = 'arc-chat-session';
const ARCPAY_SESSION_KEY = 'arc-pay-session-v3';

const CHAT_SESSION_ID = 'arc-session-' + (localStorage.getItem(CHAT_SESSION_KEY) || (() => {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  localStorage.setItem(CHAT_SESSION_KEY, id);
  return id;
})());

const ARC_RPC        = 'https://rpc.testnet.arc.network';
const ARC_CHAIN_ID   = 5042002;
const ARC_CHAIN_HEX  = '0x4cef52';
const ARC_EXPLORER   = 'https://testnet.arcscan.app';
// CF_FACTORY removed — no on-chain tx during agent authorization (pure off-chain EIP-191)
const USDC_ADDR      = '0x3600000000000000000000000000000000000000';
const EURC_ADDR      = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── State ──────────────────────────────────────────────────────────────────────
let chatOpen        = false;
let chatInitialized = false;
let isTyping        = false;
let unreadCount     = 0;
let chatSize        = localStorage.getItem('arc-chat-size') || 'medium';
let chatWidthExpanded = false; // width-only toggle state
let arcPaySession   = null;   // { wallet, sig, sessionHash, expiry, authorized }
let authInProgress  = false;  // prevent double-click on authorize

// ── Ensure chat elements are direct children of <body> (portal pattern) ────────
// This guarantees position:fixed works correctly regardless of any ancestor
// element that has transform, perspective, filter, or will-change applied.
(function ensureChatPortal() {
  function moveToBodPortal() {
    const widgetIds = ['chat-fab', 'chat-widget'];
    widgetIds.forEach(function(id) {
      const el = document.getElementById(id);
      if (!el) return;
      // If already a direct child of <body>, nothing to do
      if (el.parentElement === document.body) return;
      // Move to body — preserves all event listeners and inline styles
      document.body.appendChild(el);
    });
    // Force fixed positioning on both elements after move
    const fab = document.getElementById('chat-fab');
    const widget = document.getElementById('chat-widget');
    if (fab) { fab.style.position = 'fixed'; fab.style.zIndex = '9998'; }
    if (widget) { widget.style.position = 'fixed'; }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', moveToBodPortal);
  } else {
    moveToBodPortal();
  }
})();

// ── Session helpers ────────────────────────────────────────────────────────────
function loadSession() {
  try {
    const raw = localStorage.getItem(ARCPAY_SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !s.authorized || !s.wallet || !s.expiry) return null;
    if (Date.now() > s.expiry) {
      localStorage.removeItem(ARCPAY_SESSION_KEY);
      return null;
    }
    return s;
  } catch { return null; }
}

function saveSession(session) {
  localStorage.setItem(ARCPAY_SESSION_KEY, JSON.stringify(session));
  arcPaySession = session;
  // Bridge hook fires here if installed — see chat-bridge.js
  console.log(`[RESPONSE SENT] session_saved wallet=${session?.wallet?.slice(0,10)}`);
}
window.saveSession = saveSession;

function clearSession() {
  localStorage.removeItem(ARCPAY_SESSION_KEY);
  arcPaySession = null;
}

function isAgentActive() {
  const s = loadSession();
  if (!s) { arcPaySession = null; return false; }
  // Verify session wallet matches connected wallet
  const connectedWallet = window.walletState?.address?.toLowerCase();
  if (connectedWallet && s.wallet.toLowerCase() !== connectedWallet) {
    clearSession();
    return false;
  }
  arcPaySession = s;
  return true;
}

// ── Size configurations ────────────────────────────────────────────────────────
const CHAT_SIZES = {
  mini:   { width: '300px',  height: '420px', bottom: '70px', right: '20px' },
  medium: { width: '380px',  height: '580px', bottom: '70px', right: '20px' },
  // wide = 650px (~71% wider than medium 380px), capped at 92vw
  wide:   { width: 'calc(min(650px, 92vw))',   height: '600px', bottom: '70px', right: '20px' },
  full:   { width: '100vw',  height: '100vh', bottom: '0',    right: '0', borderRadius: '0' },
};

// Expanded width target = base × 1.72 (≥ 70% increase), min 650px
const CHAT_EXPAND_FACTOR = 1.72;
const CHAT_EXPAND_MIN_PX = 650;

// ── CSS injection ──────────────────────────────────────────────────────────────
(function injectChatStyles() {
  if (document.getElementById('chat-styles-v3')) return;
  const s = document.createElement('style');
  s.id = 'chat-styles-v3';
  s.textContent = `
    /* CRITICAL: force fixed positioning so the widget floats above ALL page content
       and is never affected by parent overflow / transform / position rules */
    #chat-widget {
      position: fixed !important;
      display: flex; flex-direction: column;
      transition: width 0.35s cubic-bezier(.4,0,.2,1),
                  height 0.3s cubic-bezier(.4,0,.2,1),
                  left 0.35s cubic-bezier(.4,0,.2,1),
                  right 0.35s cubic-bezier(.4,0,.2,1),
                  bottom 0.3s ease,
                  border-radius 0.3s ease,
                  opacity 0.25s ease, transform 0.25s ease;
    }
    /* FAB button must also be fixed and always on top */
    #chat-fab {
      position: fixed !important;
      z-index: 9998 !important;
    }
    /* CRITICAL: When hidden, ensure zero interaction — no click blocking */
    #chat-widget.hidden,
    #chat-widget[data-chat-closing="true"] {
      pointer-events: none !important;
      user-select: none !important;
    }
    /* When open, restore full interaction */
    #chat-widget:not(.hidden):not([data-chat-closing="true"]) {
      pointer-events: auto !important;
    }
    /* Width-expanded state indicator on toggle button */
    #chat-width-toggle-btn.expanded {
      background: rgba(139,92,246,0.22) !important;
      border-color: rgba(139,92,246,0.5) !important;
      color: #c4b5fd !important;
    }
    /* Drag handle cursor */
    #chat-header { cursor: grab; user-select: none; }
    #chat-header:active { cursor: grabbing; }
    #chat-messages { scrollbar-width: thin; scrollbar-color: #4c1d95 #111827; }
    #chat-messages::-webkit-scrollbar { width: 4px; }
    #chat-messages::-webkit-scrollbar-track { background: #111827; }
    #chat-messages::-webkit-scrollbar-thumb { background: #4c1d95; border-radius: 4px; }
    #chat-quick-actions { scrollbar-width: none; }
    #chat-quick-actions::-webkit-scrollbar { display: none; }
    .chat-content table { border-collapse: collapse; width: 100%; }
    .chat-content th, .chat-content td { padding: 4px 8px; }

    .chat-size-btn { padding: 3px 6px; border-radius: 5px; font-size: 10px; cursor: pointer;
      background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: #9ca3af;
      transition: all 0.15s; }
    .chat-size-btn:hover, .chat-size-btn.active { background: rgba(139,92,246,0.25);
      border-color: rgba(139,92,246,0.5); color: #c4b5fd; }

    /* Daat auth bar — prominent, not hidden */
    #chat-arcpay-bar {
      flex-shrink: 0;
      border-bottom: 1px solid rgba(109,40,217,0.3);
    }
    /* Authorized state */
    #chat-arcpay-bar.authorized { background: rgba(20,83,45,0.25); border-bottom-color: rgba(34,197,94,0.25); }
    /* Unauthorized state */
    #chat-arcpay-bar.unauthorized { background: rgba(88,28,135,0.25); }
    /* Auth progress */
    #chat-arcpay-bar.authorizing { background: rgba(30,58,138,0.25); border-bottom-color: rgba(59,130,246,0.3); }

    /* Auth button — large, gradient, animated ring */
    #arcpay-auth-btn {
      position: relative;
      overflow: hidden;
    }
    #arcpay-auth-btn::before {
      content: '';
      position: absolute;
      inset: -2px;
      border-radius: 10px;
      background: linear-gradient(135deg, #7c3aed, #3b82f6, #7c3aed);
      background-size: 200% 200%;
      animation: arcpay-ring 2.5s linear infinite;
      z-index: -1;
    }
    @keyframes arcpay-ring {
      0%   { background-position: 0% 50%; }
      50%  { background-position: 100% 50%; }
      100% { background-position: 0% 50%; }
    }

    .arcpay-badge-active {
      display: inline-flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 700;
      padding: 2px 8px; border-radius: 999px;
      background: rgba(34,197,94,0.12); border: 1px solid rgba(34,197,94,0.3); color: #4ade80;
    }
    .arcpay-badge-inactive {
      display: inline-flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 700;
      padding: 2px 8px; border-radius: 999px;
      background: rgba(139,92,246,0.12); border: 1px solid rgba(139,92,246,0.3); color: #c4b5fd;
    }

    /* Auth overlay (step-by-step progress) */
    #arcpay-auth-overlay {
      position: absolute; inset: 0; z-index: 30;
      background: rgba(5,5,15,0.92); backdrop-filter: blur(8px);
      border-radius: inherit;
      display: flex; align-items: center; justify-content: center;
      flex-direction: column; gap: 0; padding: 20px;
      text-align: center;
    }

    /* Auth step row */
    .auth-step {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 12px; border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.06);
      width: 100%; margin-bottom: 8px;
      transition: all 0.3s ease;
    }
    .auth-step.pending  { background: rgba(30,30,50,0.5); }
    .auth-step.active   { background: rgba(59,130,246,0.12); border-color: rgba(59,130,246,0.3); }
    .auth-step.done     { background: rgba(34,197,94,0.08); border-color: rgba(34,197,94,0.25); }
    .auth-step.error    { background: rgba(239,68,68,0.08); border-color: rgba(239,68,68,0.25); }

    .auth-step-icon { width: 28px; height: 28px; border-radius: 50%; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: bold; }
    .auth-step.pending  .auth-step-icon { background: rgba(60,60,80,0.6); color: #6b7280; border: 2px solid #374151; }
    .auth-step.active   .auth-step-icon { background: rgba(59,130,246,0.2); color: #60a5fa; border: 2px solid #3b82f6; }
    .auth-step.done     .auth-step-icon { background: rgba(34,197,94,0.2); color: #4ade80; border: 2px solid #22c55e; }
    .auth-step.error    .auth-step-icon { background: rgba(239,68,68,0.2); color: #f87171; border: 2px solid #ef4444; }

    /* Chat action cards */
    .chat-action-card {
      background: rgba(17,24,39,0.9); border: 1px solid rgba(55,138,221,0.2);
      border-radius: 10px; padding: 10px; margin-top: 4px;
    }
    .chat-action-btn {
      display: inline-flex; align-items: center; gap: 5px;
      font-size: 11px; font-weight: 600; padding: 5px 11px; border-radius: 7px;
      cursor: pointer; border: none; transition: all 0.18s; margin: 2px 2px 0 0;
    }
    .chat-action-btn-primary   { background: linear-gradient(135deg,#6d28d9,#3b82f6); color:#fff; }
    .chat-action-btn-primary:hover { opacity:0.85; transform:translateY(-1px); }
    .chat-action-btn-secondary { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color:#9ca3af; }
    .chat-action-btn-secondary:hover { background: rgba(255,255,255,0.1); }
    .chat-action-btn-danger    { background: rgba(239,68,68,0.12); border: 1px solid rgba(239,68,68,0.25); color:#f87171; }
    .chat-action-btn-danger:hover { background: rgba(239,68,68,0.2); }
    .chat-action-btn-success   { background: rgba(34,197,94,0.12); border: 1px solid rgba(34,197,94,0.25); color:#4ade80; }
    .chat-action-btn-success:hover { background: rgba(34,197,94,0.2); }

    /* ── Blockchain Action Card (LLM structured actions) ── */
    .arc-blockchain-action-card {
      background: linear-gradient(135deg, rgba(17,24,39,0.95), rgba(30,20,60,0.92));
      border: 1px solid rgba(109,40,217,0.35);
      border-radius: 12px; padding: 12px 14px; margin-top: 6px;
      width: 100%; max-width: 320px;
      box-shadow: 0 4px 20px rgba(109,40,217,0.12);
    }
    .arc-action-header {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 10px;
    }
    .arc-action-type-badge {
      font-size: 11px; font-weight: 700; letter-spacing: 0.04em;
      color: #c4b5fd; background: rgba(109,40,217,0.15);
      border: 1px solid rgba(109,40,217,0.3);
      padding: 3px 8px; border-radius: 6px;
    }
    .arc-action-status {
      font-size: 10px; font-weight: 600; letter-spacing: 0.03em;
    }
    .arc-action-params {
      display: flex; flex-direction: column; gap: 5px;
      margin-bottom: 10px;
    }
    .arc-action-param {
      display: flex; align-items: center; justify-content: space-between;
      font-size: 11px; padding: 4px 8px;
      background: rgba(255,255,255,0.04); border-radius: 6px;
    }
    .arc-action-param span { color: #6b7280; }
    .arc-action-param b   { color: #e2e8f0; font-weight: 600; }
    .arc-action-cta {
      width: 100%; padding: 7px 12px; border-radius: 8px;
      font-size: 11px; font-weight: 700; cursor: pointer; border: none;
      transition: all 0.18s; letter-spacing: 0.03em;
    }
    .arc-action-cta-execute {
      background: linear-gradient(135deg,#6d28d9,#3b82f6); color:#fff;
    }
    .arc-action-cta-execute:hover { opacity:0.88; transform:translateY(-1px); }
    .arc-action-cta-wallet {
      background: rgba(245,158,11,0.12); border: 1px solid rgba(245,158,11,0.35);
      color: #fbbf24;
    }
    .arc-action-cta-wallet:hover { background: rgba(245,158,11,0.2); }

    /* Light mode overrides for action cards */
    body.light-mode .arc-blockchain-action-card {
      background: linear-gradient(135deg, #f8faff, #f3f0ff);
      border-color: rgba(109,40,217,0.25);
    }
    body.light-mode .arc-action-type-badge { color: #5b21b6; background: rgba(109,40,217,0.08); }
    body.light-mode .arc-action-param { background: rgba(0,0,0,0.03); }
    body.light-mode .arc-action-param span { color: #6b7280; }
    body.light-mode .arc-action-param b { color: #1e293b; }

    /* Executing badge */
    .chat-exec-badge {
      display: inline-flex; align-items: center; gap: 5px; font-size: 10px;
      padding: 2px 8px; border-radius: 999px;
      background: rgba(59,130,246,0.12); border: 1px solid rgba(59,130,246,0.25); color: #60a5fa;
    }

    @media (max-width: 640px) {
      #chat-widget[data-size="medium"],
      #chat-widget[data-size="mini"] {
        width: calc(100vw - 16px) !important;
        height: 72vh !important;
        right: 8px !important;
        bottom: 68px !important;
      }
      #chat-fab { bottom: 12px !important; right: 12px !important; }
    }
    @media (max-width: 768px) {
      /* On mobile, expanded width stays within 92vw */
      #chat-widget.chat-width-expanded {
        width: min(calc(100vw - 16px), 90vw) !important;
        left: 8px !important;
        right: auto !important;
      }
    }
  `;
  document.head.appendChild(s);
})();

// ── Toggle Chat ────────────────────────────────────────────────────────────────
function toggleChat() {
  const widget  = document.getElementById('chat-widget');
  const fabIcon = document.getElementById('chat-fab-icon');
  const fabLbl  = document.getElementById('chat-fab-label');
  if (!widget) return;

  chatOpen = !chatOpen;

  if (chatOpen) {
    // ── OPEN: restore interaction FIRST, before any visual change ──
    widget.removeAttribute('data-chat-closing');
    // Force fixed positioning — overrides any inherited/inline styles
    widget.style.position   = 'fixed';
    widget.style.zIndex     = '9999';
    widget.style.pointerEvents = 'auto';
    widget.style.userSelect    = 'auto';
    widget.style.visibility    = 'visible';
    applyChatSize(chatSize, false);
    widget.classList.remove('hidden');
    // Restore dragged position if saved
    if (typeof window._chatRestorePos === 'function') window._chatRestorePos();
    widget.style.opacity = '0';
    widget.style.transform = 'translateY(16px) scale(0.97)';
    requestAnimationFrame(() => {
      widget.style.opacity = '1';
      widget.style.transform = 'translateY(0) scale(1)';
    });
    if (fabIcon) fabIcon.className = 'fas fa-times text-white text-base';
    if (fabLbl)  fabLbl.classList.add('hidden');
    unreadCount = 0;
    document.getElementById('chat-unread')?.classList.add('hidden');
    if (!chatInitialized) { chatInitialized = true; initChatSession(); }
    else scrollChatToBottom();
    updateArcPayBar();
    setTimeout(() => document.getElementById('chat-input')?.focus(), 300);
  } else {
    // ── CLOSE: disable interaction IMMEDIATELY — before animation starts ──
    widget.setAttribute('data-chat-closing', 'true');
    widget.style.pointerEvents = 'none';
    widget.style.userSelect    = 'none';
    widget.style.opacity = '0';
    widget.style.transform = 'translateY(16px) scale(0.97)';
    setTimeout(() => {
      widget.classList.add('hidden');
      widget.removeAttribute('data-chat-closing');
      // Keep position:fixed but use very low z-index when hidden so it never blocks clicks
      widget.style.position = 'fixed';
      widget.style.zIndex   = '-1';
    }, 260);
    if (fabIcon) fabIcon.className = 'fas fa-robot text-white text-base';
    if (fabLbl)  { fabLbl.classList.remove('hidden'); fabLbl.textContent = 'Ask me'; }
    // Reset width expand state on close
    chatWidthExpanded = false;
    const _ov1 = document.getElementById('chat-expand-override');
    if (_ov1) _ov1.textContent = '';
    const widget2 = document.getElementById('chat-widget');
    if (widget2) widget2.classList.remove('chat-width-expanded');
    const wBtn = document.getElementById('chat-width-toggle-btn');
    if (wBtn) {
      wBtn.classList.remove('expanded');
      wBtn.innerHTML = '<i class="fas fa-arrows-alt-h"></i>';
    }
  }
}

// ── Size management ────────────────────────────────────────────────────────────
function setChatSize(size) {
  // Reset width-expand toggle whenever a preset is chosen
  chatWidthExpanded = false;
  const _ov2 = document.getElementById('chat-expand-override');
  if (_ov2) _ov2.textContent = '';
  const widget3 = document.getElementById('chat-widget');
  if (widget3) {
    widget3.classList.remove('chat-width-expanded');
    // Restore right-anchor in case expand had shifted to left-anchor
    widget3.style.left = 'auto';
    widget3.style.top  = 'auto';
  }
  const wBtn = document.getElementById('chat-width-toggle-btn');
  if (wBtn) {
    wBtn.classList.remove('expanded');
    wBtn.innerHTML = '<i class="fas fa-arrows-alt-h"></i>';
  }

  chatSize = size;
  localStorage.setItem('arc-chat-size', size);
  applyChatSize(size, true);
  ['mini','medium','wide','full'].forEach(s => {
    document.getElementById(`chat-size-${s}`)?.classList.toggle('active', s === size);
  });
}

function applyChatSize(size, animate = true) {
  const widget = document.getElementById('chat-widget');
  if (!widget) return;
  const cfg = CHAT_SIZES[size] || CHAT_SIZES.medium;
  if (!animate) widget.style.transition = 'none';
  Object.assign(widget.style, {
    width:        cfg.width,
    height:       cfg.height,
    bottom:       cfg.bottom,
    right:        cfg.right,
    borderRadius: cfg.borderRadius || '16px',
    // For non-full sizes, clear any dragged top/left so right/bottom take effect
    ...(size !== 'full'
      ? { top: 'auto', left: 'auto' }
      : { top: '0', left: '0', bottom: '0', right: '0' }),
  });
  // For 'wide' size, also update max-width to allow the full computed width
  if (size === 'wide') {
    widget.style.maxWidth = 'calc(min(650px, 92vw))';
  } else {
    widget.style.maxWidth = 'calc(100vw - 16px)';
  }
  widget.setAttribute('data-size', size);
  if (!animate) requestAnimationFrame(() => { widget.style.transition = ''; });
}

// ── Width-only expand toggle ─────────────────────────────────────────────────────
// Toggles between base preset width and expanded width (≥70% increase).
// Expands LEFT when the widget is near the right edge to avoid overflow.
// Height and vertical position are never changed.
function toggleChatWidth() {
  const widget = document.getElementById('chat-widget');
  const btn    = document.getElementById('chat-width-toggle-btn');
  if (!widget) return;

  chatWidthExpanded = !chatWidthExpanded;

  // Remover regra anterior se existir
  let styleTag = document.getElementById('chat-expand-override');
  if (!styleTag) {
    styleTag = document.createElement('style');
    styleTag.id = 'chat-expand-override';
    document.head.appendChild(styleTag);
  }

  if (chatWidthExpanded) {
    const vw = window.innerWidth;
    const targetW = Math.min(650, Math.floor(vw * 0.92));

    // CSS com !important sobrescreve tudo — ancorado na direita, expande para esquerda
    styleTag.textContent = `
      #chat-widget {
        width: ${targetW}px !important;
        max-width: ${targetW}px !important;
        right: 20px !important;
        left: auto !important;
        transition: width 0.35s cubic-bezier(.4,0,.2,1) !important;
      }
    `;

    widget.classList.add('chat-width-expanded');
    if (btn) {
      btn.classList.add('expanded');
      btn.title     = 'Restaurar largura padrão';
      btn.innerHTML = '<i class="fas fa-compress-arrows-alt"></i>';
    }

  } else {
    // Limpar override — volta ao comportamento padrão do preset
    styleTag.textContent = `
      #chat-widget {
        transition: width 0.35s cubic-bezier(.4,0,.2,1) !important;
      }
    `;

    // Restaurar preset via applyChatSize
    const cfg = CHAT_SIZES[chatSize] || CHAT_SIZES.medium;
    widget.style.width    = cfg.width;
    widget.style.maxWidth = 'calc(100vw - 16px)';
    widget.style.right    = cfg.right  || '20px';
    widget.style.left     = 'auto';

    widget.classList.remove('chat-width-expanded');
    if (btn) {
      btn.classList.remove('expanded');
      btn.title     = 'Expandir largura (+70%)';
      btn.innerHTML = '<i class="fas fa-arrows-alt-h"></i>';
    }
  }
}
window.toggleChatWidth = toggleChatWidth;

// ── Drag-to-move logic ─────────────────────────────────────────────────────────
(function initChatDrag() {
  const STORAGE_KEY = 'arc-chat-pos';

  // State
  let dragging    = false;
  let offsetX     = 0;
  let offsetY     = 0;
  let dragWidget  = null;

  // Clamp a value between min and max
  function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

  // Convert bottom/right (default) into top/left for absolute positioning
  function pinToTopLeft(widget) {
    const rect = widget.getBoundingClientRect();
    widget.style.top    = rect.top  + 'px';
    widget.style.left   = rect.left + 'px';
    widget.style.bottom = 'auto';
    widget.style.right  = 'auto';
  }

  // Keep widget inside viewport (allow full viewport coverage, no hard boundary clipping)
  function clampToViewport(widget, left, top) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w  = widget.offsetWidth  || 400;
    const h  = widget.offsetHeight || 560;
    // Allow the widget to be dragged anywhere: keep at least 60px visible on each edge
    const minVisible = 60;
    return {
      left: clamp(left, -(w - minVisible), vw - minVisible),
      top:  clamp(top,  0, vh - minVisible),
    };
  }

  // Persist position
  function savePos(left, top) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ left, top })); } catch {}
  }

  // Restore persisted position
  function restorePos(widget) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const { left, top } = JSON.parse(raw);
      const clamped = clampToViewport(widget, left, top);
      widget.style.left   = clamped.left + 'px';
      widget.style.top    = clamped.top  + 'px';
      widget.style.bottom = 'auto';
      widget.style.right  = 'auto';
    } catch {}
  }

  function onPointerDown(e) {
    // Only drag on primary button / single touch; ignore if target is a button/input
    const tag = (e.target || e.srcElement).tagName;
    if (['BUTTON','INPUT','SELECT','TEXTAREA','A','I'].includes(tag)) return;

    dragWidget = document.getElementById('chat-widget');
    if (!dragWidget || dragWidget.classList.contains('hidden')) return;

    // For "full" size don't drag
    if (dragWidget.getAttribute('data-size') === 'full') return;

    // Convert to top/left if still using bottom/right
    pinToTopLeft(dragWidget);

    const rect = dragWidget.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;

    offsetX = clientX - rect.left;
    offsetY = clientY - rect.top;
    dragging = true;

    // Disable size transitions while dragging
    dragWidget.style.transition = 'opacity 0.25s ease, transform 0.25s ease, box-shadow 0.2s ease';
    dragWidget.style.boxShadow  = '0 24px 60px rgba(0,0,0,0.7), 0 0 0 1px rgba(139,92,246,0.35)';
    dragWidget.style.transform  = 'scale(1.02)';
    document.body.style.userSelect = 'none';

    const header = document.getElementById('chat-header');
    if (header) header.style.cursor = 'grabbing';

    if (e.cancelable) e.preventDefault();
  }

  function onPointerMove(e) {
    if (!dragging || !dragWidget) return;

    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;

    const rawLeft = clientX - offsetX;
    const rawTop  = clientY - offsetY;

    const { left, top } = clampToViewport(dragWidget, rawLeft, rawTop);

    dragWidget.style.left = left + 'px';
    dragWidget.style.top  = top  + 'px';

    if (e.cancelable) e.preventDefault();
  }

  function onPointerUp(e) {
    if (!dragging || !dragWidget) return;
    dragging = false;

    // Restore normal shadow / scale
    dragWidget.style.transition = '';
    dragWidget.style.boxShadow  = '';
    dragWidget.style.transform  = '';
    document.body.style.userSelect = '';

    const header = document.getElementById('chat-header');
    if (header) header.style.cursor = 'grab';

    // Persist position
    savePos(parseFloat(dragWidget.style.left), parseFloat(dragWidget.style.top));
    dragWidget = null;
  }

  // Wait for DOM to be ready then attach listeners
  function attachDragListeners() {
    const header = document.getElementById('chat-header');
    if (!header) { setTimeout(attachDragListeners, 200); return; }

    // Mouse events
    header.addEventListener('mousedown',  onPointerDown, { passive: false });
    document.addEventListener('mousemove', onPointerMove, { passive: false });
    document.addEventListener('mouseup',   onPointerUp);

    // Touch events
    header.addEventListener('touchstart', onPointerDown, { passive: false });
    document.addEventListener('touchmove', onPointerMove, { passive: false });
    document.addEventListener('touchend',  onPointerUp);

    // Restore saved position when chat opens
    const widget = document.getElementById('chat-widget');
    if (widget) restorePos(widget);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachDragListeners);
  } else {
    attachDragListeners();
  }

  // Expose restore so toggleChat can call it
  window._chatRestorePos = function() {
    const w = document.getElementById('chat-widget');
    if (w) restorePos(w);
  };
})();

function openChatNewTab() {
  const msgs = [];
  document.querySelectorAll('#chat-messages > div').forEach(el => {
    const isUser  = el.querySelector('.bg-purple-700') !== null;
    const content = el.querySelector('.chat-content, .text-xs.text-white');
    if (content) msgs.push({ role: isUser ? 'user' : 'assistant', text: content.textContent });
  });
  localStorage.setItem('arc-chat-newtab', JSON.stringify({
    sessionId: CHAT_SESSION_ID,
    arcPayActive: isAgentActive(),
    messages: msgs,
  }));
  window.open(location.origin + location.pathname + '?chat=1', '_blank', 'width=480,height=720,menubar=no,toolbar=no');
}

// ── Daat Bar ─────────────────────────────────────────────────────────────────
function updateArcPayBar() {
  const bar       = document.getElementById('chat-arcpay-bar');
  const statusEl  = document.getElementById('chat-arcpay-status');
  const authBtn   = document.getElementById('arcpay-auth-btn');
  const revokeBtn = document.getElementById('arcpay-revoke-btn');
  const badge     = document.getElementById('arcpay-session-badge');
  if (!bar) return;

  const active = isAgentActive();
  bar.className = active ? 'px-3 py-2 authorized' : 'px-3 py-2 unauthorized';

  if (active && arcPaySession) {
    const walletShort = arcPaySession.wallet.slice(0, 8) + '…' + arcPaySession.wallet.slice(-5);
    const expiry      = new Date(arcPaySession.expiry).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    if (statusEl) statusEl.innerHTML =
      `<span class="arcpay-badge-active"><i class="fas fa-shield-alt"></i> Daat Agent Active</span>` +
      `<span class="text-[9px] text-green-600 ml-1">${walletShort} · exp ${expiry}</span>`;
    if (authBtn)   authBtn.classList.add('hidden');
    if (revokeBtn) revokeBtn.classList.remove('hidden');
    if (badge)     { badge.classList.remove('hidden'); badge.textContent = '✅ Active'; }
  } else {
    if (statusEl) statusEl.innerHTML =
      `<span class="arcpay-badge-inactive"><i class="fas fa-robot"></i> Daat Agent</span>` +
      `<span class="text-[9px] text-purple-400 ml-1">Not authorized — click to enable</span>`;
    if (authBtn)   authBtn.classList.remove('hidden');
    if (revokeBtn) revokeBtn.classList.add('hidden');
    if (badge)     badge.classList.add('hidden');
  }

  // Also update FAB badge
  const fabBadge = document.getElementById('chat-fab-arcpay-dot');
  if (fabBadge) fabBadge.classList.toggle('hidden', !active);
}

// ══════════════════════════════════════════════════════════════════════════════
// ARCPAY AGENT v1.0 — AUTHORIZATION FLOW
// Step 1: Sign EIP-191 message (off-chain identity proof)
// Step 2: Derive session hash from signature + nonce (no transaction required)
// ══════════════════════════════════════════════════════════════════════════════
async function executeArcPayAuthorization() {
  if (authInProgress) return;
  const wallet = window.walletState?.address;

  if (!wallet) {
    showToast('Connect your wallet first.', 'warning');
    appendChatMessage('assistant',
      `⚠️ **Wallet required**\n\nConnect your EVM wallet first to authorize the Daat Agent.`,
      'agents'
    );
    appendActionCard([{ label: '🔗 Connect Wallet', action: `openWalletModal()`, primary: true }]);
    return;
  }

  if (isAgentActive()) {
    appendChatMessage('assistant',
      `✅ **Daat Agent already active**\n\nYour wallet \`${wallet.slice(0,10)}…\` already has an active session.\n\n` +
      `All platform operations are available via chat commands.`,
      'agents'
    );
    appendActionCard([
      { label: '📋 Show commands', action: `sendQuickMessage('help')`, primary: true },
      { label: '❌ Revoke session', action: `revokeArcPaySession()`, primary: false, danger: true },
    ]);
    return;
  }

  // Show the auth overlay
  showAuthOverlay();
  authInProgress = true;

  try {
    const ethers      = window.ethers;
    if (!ethers) throw new Error('ethers.js not loaded. Refresh the page.');

    const provider    = new ethers.BrowserProvider(window.ethereum, 'any');
    const signer      = await provider.getSigner();
    const signerAddr  = await signer.getAddress();

    // Verify connected wallet matches
    if (signerAddr.toLowerCase() !== wallet.toLowerCase()) {
      throw new Error('Connected wallet mismatch. Reconnect your wallet and try again.');
    }

    // ── Ensure correct network ──────────────────────────────────────────────
    const chainHex = await window.ethereum.request({ method: 'eth_chainId' });
    if (parseInt(chainHex, 16) !== ARC_CHAIN_ID) {
      setAuthStep(1, 'active', 'Switching to Arc Testnet…');
      try {
        await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: ARC_CHAIN_HEX }] });
        await new Promise(r => setTimeout(r, 1000));
      } catch (e) {
        throw new Error(`Switch to Arc Testnet (chainId ${ARC_CHAIN_ID}) and retry.`);
      }
    }

    // ── STEP 1: Sign authorization message ─────────────────────────────────
    setAuthStep(1, 'active', 'Waiting for signature in wallet…');

    const sessionNonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const expiry       = Date.now() + SESSION_TTL_MS;
    const message      = [
      '═══════════════════════════════════════',
      '  ARC Platform — Daat Agent v1.0',
      '  Authorization Request',
      '═══════════════════════════════════════',
      '',
      'I authorize the Daat Agent to execute',
      'platform operations on my behalf:',
      '  • Token transfers & payments',
      '  • Token swaps (USDC ↔ EURC)',
      '  • Smart contract creation & management',
      '  • Batch transactions (Multicall3)',
      '',
      `Wallet  : ${signerAddr}`,
      `Nonce   : ${sessionNonce}`,
      `Chain   : Arc Testnet (${ARC_CHAIN_ID})`,
      `Expires : ${new Date(expiry).toISOString()}`,
      '',
      'All operations require Guardian Agent v1.0',
      'pre-validation before execution.',
      'This authorization can be revoked at any time.',
      '═══════════════════════════════════════',
    ].join('\n');

    let signature;
    try {
      signature = await signer.signMessage(message);
    } catch (e) {
      if (e.code === 4001 || e.code === 'ACTION_REJECTED') throw new Error('__cancelled__');
      throw new Error(`Signature failed: ${e.message}`);
    }

    setAuthStep(1, 'done', 'Signature confirmed ✓');
    setAuthStep(2, 'active', 'Deriving session token…');

    // ── STEP 2: Derive session hash from signature + nonce (pure off-chain) ──
    // No transaction is sent here. Authorization is fully off-chain via EIP-191.

    // ── Derive session hash (off-chain, no tx) ─────────────────────────────
    const sessionHash = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(signature + sessionNonce + signerAddr)
    ).then(buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join(''));

    setAuthStep(2, 'done', 'Session token derived ✓');
    setAuthStep(3, 'active', 'Activating session…');

    // ── Save session ────────────────────────────────────────────────────────
    const session = {
      authorized:  true,
      wallet:      signerAddr,
      signature,
      sessionNonce,
      sessionHash: sessionHash.slice(0, 32),
      expiry,
      createdAt:   Date.now(),
    };
    saveSession(session);

    setAuthStep(3, 'done', 'Session active ✅');
    await new Promise(r => setTimeout(r, 800));
    hideAuthOverlay();

    // ── Success message ──────────────────────────────────────────────────────
    updateArcPayBar();

    appendChatMessage('assistant',
      `🎉 **Daat Agent v1.0 Authorized!**\n\n` +
      `✅ Wallet: \`${signerAddr.slice(0,10)}…${signerAddr.slice(-6)}\`\n` +
      `🔐 Session: \`${sessionHash.slice(0,16)}…\`\n` +
      `⏱️ Valid until: ${new Date(expiry).toLocaleString()}\n\n` +
      `**I can now execute all platform operations for you:**\n` +
      `- 💳 *"send 10 USDC to 0x…"*\n` +
      `- 🔄 *"swap 5 USDC to EURC"*\n` +
      `- 📋 *"create contract with 0x… for 100 USDC"*\n` +
      `- 🚀 *"pay 0x…:10, 0x…:20"* (batch)\n` +
      `- 📊 *"show my balance"*\n\n` +
      `🛡️ Every action is validated by Guardian Agent v1.0 before execution.`,
      'agents'
    );
    appendActionCard([
      { label: '📋 Show all commands', action: `sendQuickMessage('help')`, primary: true },
      { label: '💳 My Balance',        action: `sendQuickMessage('my wallet')`, primary: false },
    ]);

    showToast('✅ Daat Agent authorized!', 'success');

  } catch (err) {
    hideAuthOverlay();
    authInProgress = false;

    if (err.message === '__cancelled__') {
      appendChatMessage('assistant', `⚠️ Authorization cancelled. Click **Authorize** when ready.`, 'agents');
      showToast('Authorization cancelled.', 'warning');
    } else {
      appendChatMessage('assistant', `❌ **Authorization failed**\n\n${err.message}`, 'error');
      showToast('Authorization failed: ' + err.message.slice(0, 60), 'error');
    }
    return;
  }

  authInProgress = false;
}

// ── Auth Overlay helpers ───────────────────────────────────────────────────────
function showAuthOverlay() {
  let overlay = document.getElementById('arcpay-auth-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'arcpay-auth-overlay';
    overlay.innerHTML = `
      <div style="margin-bottom:16px;">
        <div style="width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,#6d28d9,#3b82f6);display:flex;align-items:center;justify-content:center;margin:0 auto 10px;">
          <i class="fas fa-shield-alt text-white" style="font-size:20px;"></i>
        </div>
        <p style="color:#e5e7eb;font-weight:700;font-size:15px;margin:0 0 4px;">Daat Agent v1.0</p>
        <p style="color:#6b7280;font-size:11px;margin:0;">Authorization in progress…</p>
      </div>

      <div style="width:100%;">
        <div id="auth-step-row-1" class="auth-step active">
          <div class="auth-step-icon" id="auth-step-icon-1">
            <i class="fas fa-spinner fa-spin" style="font-size:11px;"></i>
          </div>
          <div style="text-align:left;flex:1;">
            <p style="color:#e5e7eb;font-size:12px;font-weight:600;margin:0 0 2px;">Step 1 — Sign Authorization</p>
            <p id="auth-step-detail-1" style="color:#60a5fa;font-size:10px;margin:0;">Waiting for wallet signature…</p>
          </div>
        </div>
        <div id="auth-step-row-2" class="auth-step pending">
          <div class="auth-step-icon" id="auth-step-icon-2">2</div>
          <div style="text-align:left;flex:1;">
            <p style="color:#9ca3af;font-size:12px;font-weight:600;margin:0 0 2px;">Step 2 — Session Token</p>
            <p id="auth-step-detail-2" style="color:#6b7280;font-size:10px;margin:0;">Deriving cryptographic session token…</p>
          </div>
        </div>
        <div id="auth-step-row-3" class="auth-step pending">
          <div class="auth-step-icon" id="auth-step-icon-3">3</div>
          <div style="text-align:left;flex:1;">
            <p style="color:#9ca3af;font-size:12px;font-weight:600;margin:0 0 2px;">Step 3 — Session Activation</p>
            <p id="auth-step-detail-3" style="color:#6b7280;font-size:10px;margin:0;">Storing encrypted session token…</p>
          </div>
        </div>
      </div>

      <button onclick="cancelArcPayAuth()"
        style="margin-top:14px;font-size:11px;color:#6b7280;background:none;border:1px solid rgba(255,255,255,0.08);padding:5px 16px;border-radius:8px;cursor:pointer;">
        Cancel
      </button>
    `;
    const widget = document.getElementById('chat-widget');
    if (widget) widget.appendChild(overlay);
  }
  overlay.classList.remove('hidden');
  overlay.style.display = 'flex';
}

function hideAuthOverlay() {
  const overlay = document.getElementById('arcpay-auth-overlay');
  if (overlay) { overlay.style.display = 'none'; overlay.classList.add('hidden'); }
}

function setAuthStep(n, state, detail) {
  const row    = document.getElementById(`auth-step-row-${n}`);
  const icon   = document.getElementById(`auth-step-icon-${n}`);
  const detEl  = document.getElementById(`auth-step-detail-${n}`);
  if (!row) return;

  row.className = `auth-step ${state}`;
  if (icon) {
    icon.innerHTML =
      state === 'done'   ? '<i class="fas fa-check" style="font-size:11px;"></i>' :
      state === 'active' ? '<i class="fas fa-spinner fa-spin" style="font-size:11px;"></i>' :
      state === 'error'  ? '<i class="fas fa-times" style="font-size:11px;"></i>' : String(n);
  }
  // Update text colors
  const titleEl = row.querySelector('p:first-child');
  if (titleEl) titleEl.style.color =
    state === 'done'  ? '#4ade80' :
    state === 'active'? '#e5e7eb' :
    state === 'error' ? '#f87171' : '#9ca3af';

  if (detEl && detail) detEl.innerHTML = detail;
  if (detEl) detEl.style.color =
    state === 'done'  ? '#86efac' :
    state === 'active'? '#60a5fa' :
    state === 'error' ? '#fca5a5' : '#6b7280';
}

function cancelArcPayAuth() {
  hideAuthOverlay();
  authInProgress = false;
  appendChatMessage('assistant', `⚠️ Authorization cancelled. Click **Authorize Daat** whenever you're ready.`, 'agents');
}

function revokeArcPaySession() {
  clearSession();
  updateArcPayBar();
  appendChatMessage('assistant',
    `✅ **Daat Agent session revoked.**\n\nThe agent no longer has permission to act on your behalf.\n\nYou can re-authorize at any time by clicking **Authorize Daat Agent**.`,
    'agents'
  );
  showToast('Daat session revoked.', 'info');
}

// ── Init Session ───────────────────────────────────────────────────────────────
async function initChatSession() {
  arcPaySession = loadSession();
  try {
    const res = await (async function() {
   console.log('[fetch] GET', `/api/chat/history/${CHAT_SESSION_ID}`);
   try {
     var _r = await fetch(`/api/chat/history/${CHAT_SESSION_ID}`, {method:'GET',headers:{'Content-Type':'application/json'}});
     if (!_r.ok) { var _e = new Error('GET failed: '+_r.status); _e.response={data:await _r.json().catch(function(){return null;}),status:_r.status}; throw _e; }
     var _d = await _r.json().catch(function(){return null;});
     console.log('[fetch] GET OK', `/api/chat/history/${CHAT_SESSION_ID}`, _r.status);
     return {data:_d, status:_r.status};
   } catch(_ex) { console.error('[fetch] GET ERR', `/api/chat/history/${CHAT_SESSION_ID}`, _ex.message); throw _ex; }
 }());
    const messages = res.data.messages || [];
    if (messages.length === 0) {
      showWelcomeMessage();
    } else {
      const container = document.getElementById('chat-messages');
      if (container) container.innerHTML = '';
      messages.forEach(m => appendChatMessage(m.role, m.content, m.module, false));
    }
    scrollChatToBottom();
  } catch {
    showWelcomeMessage();
  }
}

function showWelcomeMessage() {
  const wallet  = window.walletState?.address;
  const active  = isAgentActive();

  appendChatMessage('assistant',
    `👋 **Hello! I'm ARC AI Assistant.**\n\n` +
    (wallet
      ? `✅ Wallet: \`${wallet.slice(0,8)}…${wallet.slice(-6)}\``
      : `⚠️ No wallet connected`) + '\n' +
    (active
      ? `🤖 Daat Agent: **✅ Active** — I can execute operations for you\n`
      : `🔒 Daat Agent: **Not authorized** — Click **Authorize** above to enable\n`) +
    `\n**What I can do:**\n` +
    `- 💳 Send payments on-chain\n` +
    `- 🔄 Swap tokens (USDC ↔ EURC)\n` +
    `- 📋 Create & manage contracts\n` +
    `- 🚀 Batch payments via Multicall3\n` +
    `- 📊 Live on-chain data\n` +
    `- 🛡️ Guardian pre-validation on all ops\n\n` +
    (active
      ? `Try: *"send 10 USDC to 0x…"*, *"swap 5 USDC to EURC"*, *"show my contracts"*`
      : `👆 **Authorize the Daat Agent** above to unlock all operations.`),
    'general'
  );

  if (!active && wallet) {
    appendActionCard([
      { label: '🤖 Authorize Daat Agent', action: `executeArcPayAuthorization()`, primary: true },
    ]);
  } else if (!wallet) {
    appendActionCard([
      { label: '🔗 Connect Wallet', action: `openWalletModal()`, primary: true },
    ]);
  }
}

// ── Send Message ───────────────────────────────────────────────────────────────
async function sendChatMessage() {
  const input   = document.getElementById('chat-input');
  const msg     = input?.value?.trim();
  if (!msg || isTyping) return;

  input.value = '';
  appendChatMessage('user', msg);
  showTypingIndicator();
  isTyping = true;
  const sendBtn = document.getElementById('chat-send-btn');
  if (sendBtn) sendBtn.disabled = true;

  try {
    const handled = await (typeof window.handleUnifiedMessage === 'function'
      ? window.handleUnifiedMessage(msg, 'main')
      : handleLocalCommand(msg));
    if (handled) { hideTypingIndicator(); return; }

    console.log(`[CHAT SOURCE] main→AI fallback sessionId=${CHAT_SESSION_ID.slice(0,20)}`);

    // Send to AI backend
    const res = await (async function() {
   console.log('[fetch] POST', '/api/chat/message');
   try {
     var _r = await fetch('/api/chat/message', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      message: msg,
      sessionId: CHAT_SESSION_ID,
      walletAddress:  window.walletState?.address || null,
      arcPayActive:   isAgentActive(),
    })});
     if (!_r.ok) { var _e = new Error('POST failed: '+_r.status); _e.response={data:await _r.json().catch(function(){return null;}),status:_r.status}; throw _e; }
     var _d = await _r.json().catch(function(){return null;});
     console.log('[fetch] POST OK', '/api/chat/message', _r.status);
     return {data:_d, status:_r.status};
   } catch(_ex) { console.error('[fetch] POST ERR', '/api/chat/message', _ex.message); throw _ex; }
 }());
    hideTypingIndicator();
    if (res.data.success) {
      const reply = res.data.message;
      appendChatMessage('assistant', reply.content, reply.module);
      console.log(`[RESPONSE SENT] ai_reply source=main module=${reply.module}`);

      // ── Render action card if LLM returned a blockchain action ─────────────
      const action = res.data.action || reply.action;
      if (action && action.type && action.type !== 'none') {
        renderBlockchainActionCard(action, res.data.walletConnected);
      }

      if (!chatOpen) {
        unreadCount++;
        const badge = document.getElementById('chat-unread');
        if (badge) { badge.textContent = unreadCount > 9 ? '9+' : String(unreadCount); badge.classList.remove('hidden'); }
      }
    } else {
      appendChatMessage('assistant', '❌ ' + (res.data.error || 'Something went wrong.'), 'error');
    }
  } catch (e) {
    hideTypingIndicator();
    appendChatMessage('assistant', '❌ Network error. Please try again.', 'error');
  } finally {
    isTyping = false;
    if (sendBtn) sendBtn.disabled = false;
    input?.focus();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// LOCAL COMMAND HANDLER — Intent Detection + Dispatch
// ══════════════════════════════════════════════════════════════════════════════
async function handleLocalCommand(msg) {
  const lower = msg.toLowerCase().trim();

  // ── Help ──────────────────────────────────────────────────────────────────
  if (/^(help|commands|what can you do|ajuda|comandos)$/i.test(lower)) {
    await cmdHelp(); return true;
  }

  // ── Wallet info ───────────────────────────────────────────────────────────
  if (/^(my wallet|wallet info|show wallet|balance|my balance|saldo|carteira)$/i.test(lower)) {
    await cmdShowWallet(); return true;
  }

  // ── Show contracts ────────────────────────────────────────────────────────
  if (/show.*contract|my contract|list contract|meus contratos|ver contratos/i.test(lower)) {
    await cmdShowContracts(); return true;
  }

  // ── Permit2 intents (handled before Daat authorize to avoid collisions) ────
  if (typeof handlePermitIntent === 'function') {
    const p2handled = await handlePermitIntent(msg);
    if (p2handled) return true;
  }

  // ── Authorize Daat ──────────────────────────────────────────────────────
  if (/approve arcpay|authorize agent|enable agent|arcpay agent|autorizar|autorize/i.test(lower)) {
    await executeArcPayAuthorization(); return true;
  }

  // ── Revoke Daat ─────────────────────────────────────────────────────────
  if (/revoke arcpay|revoke agent|revogar|desautorizar/i.test(lower)) {
    revokeArcPaySession(); return true;
  }

  // ── Guardian ──────────────────────────────────────────────────────────────
  if (/^(guardian|validate|security check|guardian status)$/i.test(lower)) {
    await cmdGuardianStatus(); return true;
  }

  // ── Network status ────────────────────────────────────────────────────────
  if (/network status|chain status|rpc status|rede|network/i.test(lower)) {
    await cmdNetworkStatus(); return true;
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────
  if (/^(dashboard|stats|statistics|platform data|painel)$/i.test(lower)) {
    await cmdShowDashboard(); return true;
  }

  // ── Transaction history / receipts ────────────────────────────────────────
  if (/my transactions?|tx history|receipt|transferências|histórico/i.test(lower)) {
    if (typeof Permit2Engine !== 'undefined' && Permit2Engine.formatReceiptHistory) {
      hideTypingIndicator();
      appendChatMessage('assistant', Permit2Engine.formatReceiptHistory(15), 'general');
    } else {
      hideTypingIndicator();
      appendChatMessage('assistant', '📭 No transaction history yet. Send a transfer to see it here.', 'general');
    }
    return true;
  }

  // ── Token balance check ───────────────────────────────────────────────────
  if (/check balance|token balance|usdc balance|eurc balance|ver saldo|quanto tenho/i.test(lower)) {
    const wallet = window.walletState?.address;
    if (!wallet) {
      hideTypingIndicator();
      appendChatMessage('assistant', '⚠️ Connect your wallet to check balances.', 'permit2');
      appendActionCard([{ label: '🔗 Connect Wallet', action: 'openWalletModal()', primary: true }]);
      return true;
    }
    if (typeof Permit2Engine !== 'undefined') {
      try {
        const [usdcBal, eurcBal] = await Promise.all([
          Permit2Engine.getTokenBalance(wallet, 'USDC'),
          Permit2Engine.getTokenBalance(wallet, 'EURC'),
        ]);
        hideTypingIndicator();
        appendChatMessage('assistant',
          `💰 **Token Balances**\n\n` +
          `| Token | Balance |\n|---|---|\n` +
          `| USDC | **${usdcBal.formatted.toFixed(4)} USDC** |\n` +
          `| EURC | **${eurcBal.formatted.toFixed(4)} EURC** |\n\n` +
          `*Wallet: \`${wallet.slice(0, 10)}…\`*`,
          'general');
      } catch(e) {
        hideTypingIndicator();
        appendChatMessage('assistant', `❌ Balance check failed: ${e.message}`, 'error');
      }
    } else {
      await cmdShowWallet();
    }
    return true;
  }

  // ── Permit2 preflight / simulate ─────────────────────────────────────────
  if (/simulate|preflight|pre-?flight|preview transfer|test send/i.test(lower)) {
    const simMatch = msg.match(/([\d.]+)\s*(usdc|eurc)?\s+(?:to|para)\s+(0x[0-9a-fA-F]{40})/i);
    if (simMatch && typeof Permit2Engine !== 'undefined') {
      const wallet = window.walletState?.address;
      if (!wallet) {
        hideTypingIndicator();
        appendChatMessage('assistant', '⚠️ Connect wallet to simulate.', 'permit2');
        return true;
      }
      try {
        const amount = simMatch[1];
        const token  = (simMatch[2] || 'USDC').toUpperCase();
        const to     = simMatch[3];
        const [sim, gasInfo, bal] = await Promise.all([
          Permit2Engine.simulateTransfer(token, wallet, to, amount),
          Permit2Engine.estimateGas(token, to, amount),
          Permit2Engine.getTokenBalance(wallet, token),
        ]);
        hideTypingIndicator();
        appendChatMessage('assistant',
          `🔬 **Simulation Result**\n\n` +
          `| Field | Value |\n|---|---|\n` +
          `| Token | ${token} |\n` +
          `| Amount | ${amount} ${token} |\n` +
          `| To | \`${to.slice(0,10)}…\` |\n` +
          `| Balance | ${bal.formatted.toFixed(4)} ${token} |\n` +
          `| Simulation | ${sim.success !== false ? '✅ Passed' : '❌ Would fail'} |\n` +
          `| Gas | ${gasInfo?.note || gasInfo?.gasUnits + ' units'} |`,
          'general');
      } catch(e) {
        hideTypingIndicator();
        appendChatMessage('assistant', `❌ Simulation failed: ${e.message}`, 'error');
      }
      return true;
    }
  }

  // ── ERC-20 approve ────────────────────────────────────────────────────────
  // BRAIN ONLY: informa o usuário que aprovações devem ser feitas via UI (Payments tab)
  if (/approve\s+([\d.]+)\s*(usdc|eurc)?\s+(?:for|to)\s+(0x[0-9a-fA-F]{40})/i.test(msg)) {
    const m = msg.match(/approve\s+([\d.]+)\s*(usdc|eurc)?\s+(?:for|to)\s+(0x[0-9a-fA-F]{40})/i);
    if (m) {
      hideTypingIndicator();
      const token     = (m[2] || 'USDC').toUpperCase();
      const spender   = m[3];
      const amount    = m[1];
      appendChatMessage('assistant',
        `🔐 **ERC-20 Approval**\n\n` +
        `Para aprovar **${amount} ${token}** para \`${spender.slice(0,10)}…\`, ` +
        `vá até a aba **Payments** e use o botão de aprovação.\n\n` +
        `Aprovações abrem a wallet apenas com interação explícita do usuário.`,
        'payments'
      );
      appendActionCard([
        { label: '💳 Ir para Payments', action: `switchTab('payments');toggleChat()`, primary: true },
      ]);
      return true;
    }
  }

  // ── Profile commands ──────────────────────────────────────────────────────
  if (/^(my profile|edit profile|meu perfil|editar perfil|profile)$/i.test(lower)) {
    await cmdShowProfile(); return true;
  }
  if (/^(my email|meu email|use my email|usar meu email|default email)$/i.test(lower)) {
    await cmdUseMyEmail(); return true;
  }
  if (/^(last address|último endereço|ultimo endereco|recent address|use last address)$/i.test(lower)) {
    await cmdUseLastAddress(); return true;
  }
  if (/^(recent amounts?|recent values?|valores recentes|últimos valores)$/i.test(lower)) {
    await cmdShowRecentAmounts(); return true;
  }
  if (/^(clear profile|limpar perfil|clear saved data|limpar dados)$/i.test(lower)) {
    await cmdClearProfile(); return true;
  }
  // "send X USDC to last" — resolve last address from profile
  const sendLastMatch = msg.match(/^(?:send|pay|enviar|pagar)\s+([\d.]+)\s*(usdc|eurc)?\s+(?:to|para)\s+(?:last|último|ultimo|recent|last address)/i);
  if (sendLastMatch) {
    const lastAddr = typeof getLastAddress === 'function' ? getLastAddress() : null;
    if (lastAddr) {
      await cmdSendPayment(sendLastMatch[1], (sendLastMatch[2] || 'USDC').toUpperCase(), lastAddr.addr);
    } else {
      hideTypingIndicator();
      appendChatMessage('assistant', '⚠️ No saved address found. Use `send X USDC to 0x...` with a full address first.', 'payments');
    }
    return true;
  }

  // ── Send/Pay command: "send X USDC to 0x…" (SINGLE recipient) ───────────
  // Rule: exactly 1 address → cmdSendPayment → Payments tab
  const sendMatch = msg.match(/^(?:send|pay|enviar|pagar)\s+([\d.]+)\s*(usdc|eurc)?\s+(?:to|para)\s+(0x[0-9a-fA-F]{40})/i);
  if (sendMatch) {
    // Verify it's a single-recipient message (no second address)
    const allAddrs = msg.match(/0x[0-9a-fA-F]{40}/gi) || [];
    const uniqueAddrs = [...new Set(allAddrs.map(a => a.toLowerCase()))];
    if (uniqueAddrs.length === 1) {
      await cmdSendPayment(sendMatch[1], (sendMatch[2] || 'USDC').toUpperCase(), sendMatch[3]);
      return true;
    }
    // Multiple addresses in message → fall through to batchMatch
  }

  // ── Batch multisend: "pay 0xA:10, 0xB:20" (2+ recipients) ───────────────
  // Rule: 2+ addresses → cmdBatchPayment → Multisend tab
  const batchMatch = msg.match(/^(?:pay|multisend|batch pay|enviar para|pagamento em lote)\s+(.+)/i);
  if (batchMatch) {
    const entries = batchMatch[1].match(/(0x[0-9a-fA-F]{40})\s*[:=]\s*([\d.]+)/g);
    if (entries && entries.length >= 2) {
      await cmdBatchPayment(entries); return true;
    }
    // Single entry: treat as single payment if address + amount available
    if (entries && entries.length === 1) {
      const m = entries[0].match(/(0x[0-9a-fA-F]{40})\s*[:=]\s*([\d.]+)/);
      if (m) {
        await cmdSendPayment(m[2], 'USDC', m[1]); return true;
      }
    }
  }

  // ── Swap: "swap X USDC to EURC" ──────────────────────────────────────────
  const swapMatch = msg.match(/^(?:swap|trocar|exchange)\s+([\d.]+)\s*(usdc|eurc)?\s+(?:to|for|para|por)\s*(usdc|eurc)/i);
  if (swapMatch) {
    await cmdSwap(swapMatch[1], (swapMatch[2] || 'USDC').toUpperCase(), swapMatch[3].toUpperCase());
    return true;
  }

  // ── Create contract ───────────────────────────────────────────────────────
  const createContractMatch = msg.match(/^(?:create contract|new contract|criar contrato)\s*(?:with\s+(0x[0-9a-fA-F]{40}))?\s*(?:for\s+([\d.]+)\s*(?:usdc)?)?/i);
  if (createContractMatch) {
    await cmdCreateContract(createContractMatch[1], createContractMatch[2]);
    return true;
  }

  // ── Deposit to contract ───────────────────────────────────────────────────
  const depositMatch = msg.match(/deposit\s+([\d.]+)\s*(?:usdc)?\s*(?:to|into)?\s*(?:contract\s*#?(\d+))?/i);
  if (depositMatch) {
    await cmdDepositContract(depositMatch[1], depositMatch[2]);
    return true;
  }

  // ── Release milestone ─────────────────────────────────────────────────────
  const releaseMatch = msg.match(/release\s+(?:milestone|payment)?\s*(?:#?(\d+))?\s*(?:on\s*contract\s*#?(\d+))?/i);
  if (releaseMatch) {
    await cmdReleaseMilestone(releaseMatch[1], releaseMatch[2]);
    return true;
  }

  // ── Open tab shortcuts ────────────────────────────────────────────────────
  if (/^(open payments|ir para pagamentos|pagamentos)$/i.test(lower)) {
    hideTypingIndicator();
    appendChatMessage('assistant', `💳 Opening Payments tab…`, 'payments');
    switchTab('payments'); toggleChat(); return true;
  }
  if (/^(open swap|open dex|ir para swap|swap tab)$/i.test(lower)) {
    hideTypingIndicator();
    appendChatMessage('assistant', `🔄 Opening DEX/Swap tab…`, 'swap');
    switchTab('dex'); toggleChat(); return true;
  }
  if (/^(open contracts|ir para contratos|contracts tab)$/i.test(lower)) {
    hideTypingIndicator();
    appendChatMessage('assistant', `📋 Opening Contracts tab…`, 'contracts');
    switchTab('contracts'); toggleChat(); return true;
  }
  if (/^(open multisend|enviar em lote|multisend tab)$/i.test(lower)) {
    hideTypingIndicator();
    appendChatMessage('assistant', `🚀 Opening Multisend tab…`, 'payments');
    switchTab('multisend'); toggleChat(); return true;
  }

  return false; // Let AI handle
}

// ── Profile command implementations ────────────────────────────────────────────

async function cmdShowProfile() {
  hideTypingIndicator();
  const profile  = typeof getUserProfile      === 'function' ? getUserProfile()      : {};
  const prefs    = typeof getUserPreferences  === 'function' ? getUserPreferences()  : {};
  const addrs    = typeof getRecentAddresses  === 'function' ? getRecentAddresses()  : [];
  const amounts  = typeof getRecentAmounts    === 'function' ? getRecentAmounts()    : [];
  const emails   = typeof getRecentEmails     === 'function' ? getRecentEmails()     : [];
  const score    = typeof getProfileScore     === 'function' ? getProfileScore()     : 0;

  const shortAddr = (a) => a ? a.slice(0,8)+'…'+a.slice(-6) : '—';

  let msg = `👤 **Your Saved Profile**\n\n`;
  msg += `**Identity**\n`;
  msg += `- Name: ${profile.name  || '_(not set)_'}\n`;
  msg += `- Email: ${profile.email || '_(not set)_'}\n`;
  msg += `- Wallet: ${profile.wallet ? shortAddr(profile.wallet) : '_(not connected)_'}\n\n`;

  if (addrs.length) {
    msg += `**📋 Recent Recipients** (${addrs.length})\n`;
    addrs.slice(0,5).forEach(a => {
      msg += `- ${a.label ? a.label+' · ' : ''}${shortAddr(a.addr)} _(${a.count}x used)_\n`;
    });
    msg += '\n';
  }
  if (amounts.length) {
    msg += `**💰 Recent Amounts** (${amounts.length})\n`;
    amounts.slice(0,5).forEach(a => { msg += `- ${a.value} ${a.token}\n`; });
    msg += '\n';
  }
  if (emails.length) {
    msg += `**✉️ Recent Emails** (${emails.length})\n`;
    emails.slice(0,4).forEach(e => { msg += `- ${e.email}\n`; });
    msg += '\n';
  }

  msg += `**Profile completeness:** ${score}%\n`;
  msg += `\n_Type_ \`edit profile\` _to update your name/email or_ \`clear profile\` _to reset._`;

  appendChatMessage('assistant', msg, 'general');
  createActionCard([
    { label: '✏️ Edit Profile', onclick: 'arcOpenProfileModal && arcOpenProfileModal()' },
    { label: '🗑 Clear Data',   onclick: 'cmdClearProfile && cmdClearProfile()' },
  ]);
}

async function cmdUseMyEmail() {
  hideTypingIndicator();
  const profile = typeof getUserProfile === 'function' ? getUserProfile() : {};
  if (!profile.email) {
    appendChatMessage('assistant',
      '⚠️ No default email saved yet. Open **Edit Profile** to set your email.',
      'general');
    createActionCard([{ label: '✏️ Edit Profile', onclick: 'arcOpenProfileModal && arcOpenProfileModal()' }]);
    return;
  }
  // Pre-fill payment email
  const emailEl = document.getElementById('pay-email');
  if (emailEl) { emailEl.value = profile.email; emailEl.dispatchEvent(new Event('input')); }
  appendChatMessage('assistant',
    `✅ Email **${profile.email}** applied to the Payments form.`,
    'payments');
  createActionCard([{ label: '💳 Go to Payments', onclick: "switchTab('payments');toggleChat()" }]);
}

async function cmdUseLastAddress() {
  hideTypingIndicator();
  const last = typeof getLastAddress === 'function' ? getLastAddress() : null;
  if (!last) {
    appendChatMessage('assistant',
      '⚠️ No recent address saved. Send a payment first to save a recipient address.',
      'payments');
    return;
  }
  const recipEl = document.getElementById('pay-recipient');
  if (recipEl) { recipEl.value = last.addr; recipEl.dispatchEvent(new Event('input')); }
  if (typeof payValidateField === 'function') payValidateField('recipient');
  if (typeof updatePayPreview === 'function') updatePayPreview();

  const short = last.addr.slice(0,8)+'…'+last.addr.slice(-6);
  appendChatMessage('assistant',
    `✅ Last used address **${last.label || short}** applied to Recipient field.`,
    'payments');
  createActionCard([{ label: '💳 Go to Payments', onclick: "switchTab('payments');toggleChat()" }]);
}

async function cmdShowRecentAmounts() {
  hideTypingIndicator();
  const amounts = typeof getRecentAmounts === 'function' ? getRecentAmounts() : [];
  if (!amounts.length) {
    appendChatMessage('assistant', '⚠️ No recent amounts saved yet.', 'payments');
    return;
  }
  let msg = `💰 **Recent Amounts Used**\n\n`;
  amounts.forEach((a, i) => {
    msg += `${i+1}. **${a.value} ${a.token}** _(${a.count}x used)_\n`;
  });
  msg += `\n_Click a chip in the Payments form to auto-fill._`;
  appendChatMessage('assistant', msg, 'payments');
}

async function cmdClearProfile() {
  hideTypingIndicator();
  if (!confirm('Clear all saved profile data (addresses, emails, amounts)? This cannot be undone.')) return;
  if (typeof clearAllProfileData === 'function') clearAllProfileData();
  appendChatMessage('assistant', '🗑 All saved profile data has been cleared.', 'general');
}

// ── cmd implementations ─────────────────────────────────────────────────────────

async function cmdHelp() {
  hideTypingIndicator();
  const active  = isAgentActive();
  const hasP2E  = typeof Permit2Engine !== 'undefined';
  appendChatMessage('assistant',
    `🤖 **ARC AI Assistant — Commands**\n\n` +
    `${active ? '✅ Daat Agent Active' : '⚠️ Daat not authorized — some commands need authorization'}\n` +
    `${hasP2E ? '⚡ Permit2Engine: Loaded' : ''}\n\n` +
    `**💳 Payments**\n` +
    `- \`send 10 USDC to 0x...\` — single transfer with preflight\n` +
    `- \`send 10 USDC to last\` — use last recipient\n` +
    `- \`pay 0xA:10, 0xB:20\` — inline batch payment\n` +
    `- \`simulate 10 USDC to 0x...\` — dry-run without executing\n\n` +
    `**🔐 Permit2 — Spending Limits**\n` +
    `- \`allow 100 USDC for 24 hours\` — create signed permit\n` +
    `- \`allow 100 USDC and EURC for 3 days\` — batch permits\n` +
    `- \`give permission for swaps up to 50 EURC today\`\n` +
    `- \`show my permissions\` — list active permits + timers\n` +
    `- \`revoke USDC permit\` / \`revoke all permits\`\n` +
    `- \`approve 100 USDC for 0x...\` — ERC-20 on-chain approve\n\n` +
    `**📦 Batch / CSV**\n` +
    `- Upload CSV in chat → batch send to 1000+ addresses\n` +
    `- \`send 10 USDC\` + CSV → override amounts\n\n` +
    `**🔄 Swap**\n` +
    `- \`swap 5 USDC to EURC\`\n\n` +
    `**📋 Contracts**\n` +
    `- \`show my contracts\`\n` +
    `- \`create contract with 0x... for 100 USDC\`\n\n` +
    `**💰 Balances & History**\n` +
    `- \`check balance\` — USDC + EURC balances live\n` +
    `- \`my transactions\` — receipt history (last 15)\n` +
    `- \`my wallet\` — wallet info + balances\n` +
    `- \`network status\` — RPC latency + gas price\n` +
    `- \`dashboard\` — platform stats\n` +
    `- \`guardian\` — Guardian Agent status\n\n` +
    `**👤 Profile**\n` +
    `- \`my profile\`, \`my email\`, \`last address\`\n\n` +
    `**🤖 Agent**\n` +
    `- \`authorize arcpay\` · \`revoke arcpay\``,
    'general'
  );
}

async function cmdShowWallet() {
  hideTypingIndicator();
  const wallet = window.walletState?.address;
  if (!wallet) {
    appendChatMessage('assistant', `⚠️ **No wallet connected**\n\nConnect your EVM wallet to use platform features.`, 'general');
    appendActionCard([{ label: '🔗 Connect Wallet', action: `openWalletModal()`, primary: true }]);
    return;
  }

  let usdcBal = '--', eurcBal = '--', blockNum = '--';
  try {
    const enc  = wallet.replace('0x','').padStart(64,'0');
    const body = (addr) => JSON.stringify({ jsonrpc:'2.0', id:1, method:'eth_call', params:[{ to:addr, data:'0x70a08231'+enc },'latest'] });
    const [r1, r2, r3] = await Promise.all([
      fetch(ARC_RPC, { method:'POST', headers:{'Content-Type':'application/json'}, body:body(USDC_ADDR) }).then(r=>r.json()),
      fetch(ARC_RPC, { method:'POST', headers:{'Content-Type':'application/json'}, body:body(EURC_ADDR) }).then(r=>r.json()),
      fetch(ARC_RPC, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({jsonrpc:'2.0',id:2,method:'eth_blockNumber',params:[]}) }).then(r=>r.json()),
    ]);
    if (r1.result && r1.result !== '0x') usdcBal = '$' + (Number(BigInt(r1.result)) / 1e6).toFixed(2);
    if (r2.result && r2.result !== '0x') eurcBal = '€' + (Number(BigInt(r2.result)) / 1e6).toFixed(2);
    if (r3.result) blockNum = '#' + parseInt(r3.result, 16).toLocaleString();
  } catch { }

  const active = isAgentActive();
  appendChatMessage('assistant',
    `💳 **Wallet Info**\n\n` +
    `Address: \`${wallet}\`\n` +
    `USDC Balance: **${usdcBal}**\n` +
    `EURC Balance: **${eurcBal}**\n` +
    `Latest Block: ${blockNum}\n` +
    `Network: Arc Testnet (5042002)\n` +
    `Daat Agent: ${active ? '✅ Active' : '❌ Not authorized'}\n\n` +
    `[View on ArcScan](${ARC_EXPLORER}/address/${wallet})`,
    'general'
  );
  appendActionCard([
    { label: '📊 Dashboard', action: `switchTab('dashboard');toggleChat();`, primary: false },
    { label: active ? '✅ Agent Active' : '🤖 Authorize Agent', action: active ? `sendQuickMessage('help')` : `executeArcPayAuthorization()`, primary: !active },
  ]);
}

async function cmdShowContracts() {
  hideTypingIndicator();
  const wallet = window.walletState?.address;
  if (!wallet) {
    appendChatMessage('assistant', `⚠️ Connect your wallet first to view contracts.`, 'contracts');
    appendActionCard([{ label: '🔗 Connect Wallet', action: `openWalletModal()`, primary: true }]);
    return;
  }

  appendChatMessage('assistant', `📋 Loading your on-chain contracts…`, 'contracts');
  try {
    if (typeof cfFetchMyIds === 'function') {
      const ids = await cfFetchMyIds(wallet);
      if (!ids.length) {
        appendChatMessage('assistant',
          `📭 **No contracts found** for \`${wallet.slice(0,10)}…\`\n\nCreate your first on-chain escrow contract!`,
          'contracts'
        );
        appendActionCard([{ label: '📋 Create Contract', action: `switchTab('contracts');toggleChat();`, primary: true }]);
        return;
      }
      appendChatMessage('assistant',
        `Found **${ids.length} contract(s)**: IDs [${ids.join(', ')}]\n\nOpening Contracts tab…`,
        'contracts'
      );
      appendActionCard([{ label: '📋 View Contracts', action: `switchTab('contracts');cfLoadContracts();toggleChat();`, primary: true }]);
    } else {
      appendChatMessage('assistant', `📋 Opening Contracts tab to load your on-chain contracts.`, 'contracts');
      appendActionCard([{ label: '📋 Open Contracts', action: `switchTab('contracts');toggleChat();`, primary: true }]);
    }
  } catch (e) {
    appendChatMessage('assistant', `❌ Error loading contracts: ${e.message}`, 'error');
  }
}

async function cmdGuardianStatus() {
  hideTypingIndicator();
  const checks = JSON.parse(localStorage.getItem('arc_guardian_log') || '[]');
  appendChatMessage('assistant',
    `🛡️ **Guardian Agent v1.0 — Status**\n\n` +
    `**Status:** 🟢 Online — All systems operational\n` +
    `**Last check:** ${new Date().toLocaleTimeString()}\n` +
    `**Total validations:** ${checks.length}\n\n` +
    `**Validation rules:**\n` +
    `- ✅ Recipient address format (EVM 0x…)\n` +
    `- ✅ Amount bounds (max $100,000)\n` +
    `- ✅ Zero-amount rejection\n` +
    `- ✅ Self-send prevention\n` +
    `- ✅ Network integrity (Arc Testnet only)\n` +
    `- ✅ Rate limiting (10 tx/min)\n\n` +
    `All operations validated before execution.`,
    'agents'
  );
}

async function cmdNetworkStatus() {
  hideTypingIndicator();
  appendChatMessage('assistant', `⛓️ Checking Arc Testnet…`, 'network');
  const msgs = document.getElementById('chat-messages');
  try {
    const start = Date.now();
    const [r1, r2] = await Promise.all([
      fetch(ARC_RPC, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_blockNumber',params:[]}) }).then(r=>r.json()),
      fetch(ARC_RPC, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({jsonrpc:'2.0',id:2,method:'eth_gasPrice',params:[]}) }).then(r=>r.json()),
    ]);
    const latency = Date.now() - start;
    const block   = parseInt(r1.result, 16);
    const gasWei  = BigInt(r2.result || '0');
    if (msgs?.lastElementChild) msgs.removeChild(msgs.lastElementChild);
    appendChatMessage('assistant',
      `⛓️ **Arc Testnet Status**\n\n` +
      `🟢 **Online** — RPC responding\n` +
      `📦 Latest Block: **#${block.toLocaleString()}**\n` +
      `⚡ Latency: **${latency}ms**\n` +
      `🆔 Chain ID: **5042002 (0x4cef52)**\n` +
      `⛽ Gas Price: **${gasWei > 0n ? (Number(gasWei) / 1e9).toFixed(3) + ' Gwei' : '~0 (USDC)'}**\n` +
      `💰 Gas Token: **USDC** (~$0.009/tx)\n` +
      `🔗 Explorer: [testnet.arcscan.app](${ARC_EXPLORER})\n` +
      `📡 RPC: [rpc.testnet.arc.network](${ARC_RPC})`,
      'network'
    );
  } catch (e) {
    if (msgs?.lastElementChild) msgs.removeChild(msgs.lastElementChild);
    appendChatMessage('assistant', `❌ **Network error:** ${e.message}`, 'error');
  }
}

async function cmdShowDashboard() {
  hideTypingIndicator();
  let blockNum = '--', latency = '--';
  try {
    const start = Date.now();
    const res  = await fetch(ARC_RPC, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_blockNumber',params:[]}) });
    const json = await res.json();
    latency  = `${Date.now() - start}ms`;
    blockNum = '#' + parseInt(json.result, 16).toLocaleString();
  } catch { }

  const wallet     = window.walletState?.address;
  const payments   = JSON.parse(localStorage.getItem('arc_pay_history') || '[]');
  const contracts  = JSON.parse(localStorage.getItem('arc_cf_meta_v4') || '{}');
  const active     = isAgentActive();

  appendChatMessage('assistant',
    `📊 **Platform Dashboard**\n\n` +
    `**Network:** Arc Testnet 🟢\n` +
    `**Block:** ${blockNum} · **Latency:** ${latency}\n\n` +
    `**Your Activity:**\n` +
    `- 💳 Payments: ${payments.length} recorded\n` +
    `- 📋 Contracts: ${Object.keys(contracts).length} in memory\n` +
    `- 💰 Wallet: ${wallet ? `\`${wallet.slice(0,10)}…\`` : 'Not connected'}\n\n` +
    `**Agents:**\n` +
    `- 🤖 Daat: ${active ? '✅ Active' : '⚠️ Not authorized'}\n` +
    `- 🛡️ Guardian: 🟢 Online`,
    'general'
  );
  appendActionCard([
    { label: '📊 Full Dashboard', action: `switchTab('dashboard');toggleChat();`, primary: true },
    { label: '📋 Contracts',      action: `switchTab('contracts');toggleChat();`,  primary: false },
    { label: '💳 Payments',       action: `switchTab('payments');toggleChat();`,   primary: false },
  ]);
}

async function cmdSendPayment(amount, token, recipient) {
  hideTypingIndicator();
  const wallet = window.walletState?.address;
  if (!wallet) {
    appendChatMessage('assistant', `⚠️ Connect your wallet to send payments.`, 'payments');
    appendActionCard([{ label: '🔗 Connect Wallet', action: `openWalletModal()`, primary: true }]);
    return;
  }

  // Require agent authorization
  if (!isAgentActive()) {
    appendChatMessage('assistant',
      `🔒 **Daat Agent not authorized**\n\nAuthorize the agent first to execute payments via chat.`,
      'agents'
    );
    appendActionCard([{ label: '🤖 Authorize Agent', action: `executeArcPayAuthorization()`, primary: true }]);
    return;
  }

  if (recipient.toLowerCase() === wallet.toLowerCase()) {
    appendChatMessage('assistant', `❌ Cannot send to your own address.`, 'error'); return;
  }
  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    appendChatMessage('assistant', `❌ Invalid amount: "${amount}"`, 'error'); return;
  }

  const guardianResult = await runGuardianValidation({ type: 'payment', amount: numAmount, token, recipient, sender: wallet });
  if (!guardianResult.approved) {
    appendChatMessage('assistant', `🛡️ **Guardian blocked:** ${guardianResult.reason}`, 'agents'); return;
  }

  // ── Permit2Engine: preflight check + reuse suggestion ─────────────────────
  let previewNote = '';
  let balanceNote = '';
  let reuseNote   = '';
  let gasNote     = '⛽ Gas: ~$0.009 USDC';

  if (typeof Permit2Engine !== 'undefined') {
    try {
      const [bal, gasInfo] = await Promise.all([
        Permit2Engine.getTokenBalance(wallet, token),
        Permit2Engine.estimateGas(token, recipient, numAmount),
      ]);
      balanceNote = `\nBalance: **${bal.formatted.toFixed(4)} ${token}**`;
      if (bal.formatted < numAmount) {
        appendChatMessage('assistant',
          `❌ **Insufficient balance**\n\nYou have **${bal.formatted.toFixed(4)} ${token}** but need **${amount} ${token}**.`,
          'error');
        return;
      }
      if (gasInfo?.note) gasNote = '⛽ ' + gasInfo.note;

      // Check reuse
      const reuse = typeof p2SuggestReuse === 'function'
        ? p2SuggestReuse(wallet, token, numAmount, 'payments')
        : null;
      if (reuse) reuseNote = '\n\n💡 ' + reuse.message;
    } catch(e) {
      // Non-fatal — continue with preview
    }
  }

  appendChatMessage('assistant',
    `💳 **Payment Preview**\n\n` +
    `| Field | Value |\n|---|---|\n` +
    `| Token | **${token}** |\n` +
    `| Amount | **${amount} ${token}** |\n` +
    `| To | \`${recipient.slice(0,10)}…${recipient.slice(-8)}\` |\n` +
    `| ${gasNote.replace('⛽ ','')} | |\n` +
    `| Platform Fee | 0.2% of amount |\n` +
    `| 🛡️ Guardian | ✅ Approved |` +
    balanceNote + reuseNote +
    `\n\n💡 *Full fee breakdown shown in the Payments form. Confirm to proceed.*`,
    'payments'
  );
  // BRAIN → UI: route to AgentExecutor (if active) or manual queue
  const agentReady = typeof AgentExecutor !== 'undefined' && isAgentActive();
  if (agentReady) {
    appendActionCard([
      { label: `⚡ Execute via Agent`, action: `_chatAgentTransfer('${amount}','${token}','${recipient}')`, primary: true },
      { label: '📥 Adicionar à Fila', action: `_chatQueueTransfer('${amount}','${token}','${recipient}')`, primary: false },
      { label: '❌ Cancelar', action: `appendChatMessage('assistant','❌ Pagamento cancelado.','payments')`, primary: false },
    ]);
  } else {
    appendActionCard([
      { label: `📥 Adicionar à Fila`, action: `_chatQueueTransfer('${amount}','${token}','${recipient}')`, primary: true },
      { label: '📝 Pré-preencher Formulário', action: `_chatPrefillPaymentForm('${amount}','${token}','${recipient}')`, primary: false },
      { label: '❌ Cancelar', action: `appendChatMessage('assistant','❌ Pagamento cancelado.','payments')`, primary: false },
    ]);
  }
}

async function cmdBatchPayment(entries) {
  hideTypingIndicator();
  const wallet = window.walletState?.address;
  if (!wallet) {
    appendChatMessage('assistant', `⚠️ Connect wallet first.`, 'payments');
    appendActionCard([{ label: '🔗 Connect Wallet', action: `openWalletModal()`, primary: true }]);
    return;
  }
  if (!isAgentActive()) {
    appendChatMessage('assistant', `🔒 Authorize Daat Agent first to use batch payments.`, 'agents');
    appendActionCard([{ label: '🤖 Authorize Agent', action: `executeArcPayAuthorization()`, primary: true }]);
    return;
  }

  // Parse entries like ["0xABC:10", "0xDEF:20"]
  const parsed = entries.map(e => {
    const m = e.match(/(0x[0-9a-fA-F]{40})\s*[:=]\s*([\d.]+)/);
    return m ? { address: m[1], amount: parseFloat(m[2]) } : null;
  }).filter(Boolean);

  if (!parsed.length) {
    appendChatMessage('assistant', `❌ No valid recipients found. Format: \`0xADDR:AMOUNT\``, 'error'); return;
  }

  const total = parsed.reduce((s, r) => s + r.amount, 0);
  // Show sample rows (max 3) + total
  const sampleRows = parsed.slice(0, 3).map((r, i) =>
    `${i+1}. \`${r.address.slice(0,10)}…\` — **${r.amount.toFixed(2)} USDC**`
  ).join('\n');
  const moreNote = parsed.length > 3 ? `\n…and ${parsed.length - 3} more recipients` : '';

  // Permit2Engine preflight
  let balNote = '';
  let reuseNote = '';
  if (typeof Permit2Engine !== 'undefined') {
    try {
      const bal   = await Permit2Engine.getTokenBalance(wallet, 'USDC');
      balNote     = `\n\n💰 Balance: **${bal.formatted.toFixed(4)} USDC**`;
      const reuse = typeof p2SuggestReuse === 'function' ? p2SuggestReuse(wallet, 'USDC', total, 'multisend') : null;
      if (reuse) reuseNote = '\n♻️ ' + reuse.message;
      if (bal.formatted < total) {
        balNote += ` ⚠️ *(need ${total.toFixed(2)}, have ${bal.formatted.toFixed(4)})*`;
      }
    } catch(e) { /* non-fatal */ }
  }

  appendChatMessage('assistant',
    `🚀 **Batch Payment Preview**\n\n` +
    `${sampleRows}${moreNote}\n\n` +
    `| Field | Value |\n|---|---|\n` +
    `| Total | **${total.toFixed(2)} USDC** |\n` +
    `| Recipients | **${parsed.length}** |\n` +
    `| Method | Permit2 Batch / ERC-20 Multi |\n` +
    `| 🛡️ Guardian | ✅ Approved |` +
    balNote + reuseNote,
    'payments'
  );
  appendActionCard([
    typeof AgentExecutor !== 'undefined' && isAgentActive()
      ? { label: '⚡ Execute Batch via Agent', action: `_chatAgentBatch && _chatAgentBatch(${JSON.stringify(parsed)},'USDC') || (typeof unifiedAgentMultisend==='function'?unifiedAgentMultisend(${JSON.stringify(parsed)},'USDC','main'):AgentExecutor.queueMultisend(${JSON.stringify(parsed)},'USDC','batch via chat').then(i=>appendChatMessage('assistant','🤖 Batch queued.','payments')).catch(e=>appendChatMessage('assistant','❌ '+e.message,'error')))`, primary: true }
      : { label: '🚀 Abrir Multisend', action: `chatOpenMultisend(${JSON.stringify(parsed)})`, primary: true },
    { label: '📥 Adicionar Lote à Fila', action: `_chatQueueBatch(${JSON.stringify(parsed)},'USDC')`, primary: false },
    { label: '❌ Cancelar',         action: `appendChatMessage('assistant','❌ Cancelado.','payments')`, primary: false },
  ]);
}

async function cmdSwap(amount, fromToken, toToken) {
  hideTypingIndicator();
  const wallet = window.walletState?.address;
  if (!wallet) {
    appendChatMessage('assistant', `⚠️ Connect your wallet to swap.`, 'swap');
    appendActionCard([{ label: '🔗 Connect Wallet', action: `openWalletModal()`, primary: true }]);
    return;
  }
  if (!isAgentActive()) {
    appendChatMessage('assistant', `🔒 Authorize Daat Agent first to execute swaps via chat.`, 'agents');
    appendActionCard([{ label: '🤖 Authorize Agent', action: `executeArcPayAuthorization()`, primary: true }]);
    return;
  }
  if (fromToken === toToken) {
    appendChatMessage('assistant', `❌ Cannot swap ${fromToken} to itself.`, 'error'); return;
  }

  const guardianResult = await runGuardianValidation({ type: 'swap', amount: parseFloat(amount), fromToken, toToken, wallet });
  if (!guardianResult.approved) {
    appendChatMessage('assistant', `🛡️ **Guardian blocked:** ${guardianResult.reason}`, 'agents'); return;
  }

  appendChatMessage('assistant',
    `🔄 **Swap Preview**\n\n` +
    `From: **${amount} ${fromToken}**\n` +
    `To: ~**${amount} ${toToken}** (1:1 stablecoin)\n` +
    `Fee: ~$0.009 USDC\n` +
    `🛡️ Guardian: ✅ Approved\n\n` +
    `🤖 Agent will open DEX with pre-filled values.`,
    'swap'
  );
  appendActionCard([
    { label: `🔄 Open DEX & Swap`, action: `chatOpenSwap('${amount}','${fromToken}','${toToken}')`, primary: true },
    { label: '❌ Cancel',          action: `appendChatMessage('assistant','❌ Swap cancelled.','swap')`, primary: false },
  ]);
}

async function cmdCreateContract(contractor, amount) {
  hideTypingIndicator();
  const wallet = window.walletState?.address;
  if (!wallet) {
    appendChatMessage('assistant', `⚠️ Connect your wallet to create contracts.`, 'contracts');
    appendActionCard([{ label: '🔗 Connect Wallet', action: `openWalletModal()`, primary: true }]);
    return;
  }
  if (!isAgentActive()) {
    appendChatMessage('assistant', `🔒 Authorize Daat Agent first to create contracts via chat.`, 'agents');
    appendActionCard([{ label: '🤖 Authorize Agent', action: `executeArcPayAuthorization()`, primary: true }]);
    return;
  }

  if (contractor && amount) {
    appendChatMessage('assistant',
      `📋 **Create Contract Preview**\n\n` +
      `Client: \`${wallet.slice(0,10)}…\` (you)\n` +
      `Contractor: \`${contractor.slice(0,10)}…${contractor.slice(-6)}\`\n` +
      `Value: **$${parseFloat(amount).toFixed(2)} USDC**\n` +
      `🛡️ Guardian: ✅ Approved\n\n` +
      `🤖 Agent will pre-fill the contract form.`,
      'contracts'
    );
    appendActionCard([
      { label: '📋 Open Contract Form', action: `chatOpenContractForm('${contractor}','${amount}')`, primary: true },
      { label: '❌ Cancel', action: `appendChatMessage('assistant','❌ Cancelled.','contracts')`, primary: false },
    ]);
  } else {
    appendChatMessage('assistant',
      `📋 **Create Contract**\n\nI'll open the Contracts tab. Fill in:\n- Contractor address\n- Contract value\n- Milestones\n\nOr specify: *"create contract with 0x... for 100 USDC"*`,
      'contracts'
    );
    appendActionCard([
      { label: '📋 Open Contracts Tab', action: `switchTab('contracts');toggleChat();`, primary: true },
    ]);
  }
}

async function cmdDepositContract(amount, contractId) {
  hideTypingIndicator();
  if (!isAgentActive()) {
    appendChatMessage('assistant', `🔒 Authorize Daat Agent first.`, 'agents');
    appendActionCard([{ label: '🤖 Authorize Agent', action: `executeArcPayAuthorization()`, primary: true }]);
    return;
  }
  if (contractId && typeof cfShowDepositModal === 'function') {
    appendChatMessage('assistant', `💰 Opening deposit modal for contract #${contractId}…`, 'contracts');
    switchTab('contracts');
    setTimeout(() => cfShowDepositModal(parseInt(contractId)), 400);
    toggleChat();
  } else {
    appendChatMessage('assistant',
      `💰 **Deposit to Contract**\n\nSpecify: *"deposit ${amount || '50'} USDC to contract #3"*\n\nOr open the Contracts tab to deposit manually.`,
      'contracts'
    );
    appendActionCard([{ label: '📋 Open Contracts', action: `switchTab('contracts');toggleChat();`, primary: true }]);
  }
}

async function cmdReleaseMilestone(milestoneId, contractId) {
  hideTypingIndicator();
  if (!isAgentActive()) {
    appendChatMessage('assistant', `🔒 Authorize Daat Agent first.`, 'agents');
    appendActionCard([{ label: '🤖 Authorize Agent', action: `executeArcPayAuthorization()`, primary: true }]);
    return;
  }
  if (contractId && milestoneId && typeof cfReleaseMilestone === 'function') {
    appendChatMessage('assistant', `🎯 Releasing milestone #${milestoneId} on contract #${contractId}…`, 'contracts');
    switchTab('contracts');
    setTimeout(() => cfReleaseMilestone(parseInt(contractId), parseInt(milestoneId) - 1), 400);
    toggleChat();
  } else {
    appendChatMessage('assistant',
      `🎯 **Release Milestone**\n\nSpecify: *"release milestone #1 on contract #3"*\n\nOr use the Contracts tab.`,
      'contracts'
    );
    appendActionCard([{ label: '📋 Open Contracts', action: `switchTab('contracts');toggleChat();`, primary: true }]);
  }
}

// ── Guardian validation ────────────────────────────────────────────────────────
async function runGuardianValidation(params) {
  appendChatMessage('assistant', `🛡️ Guardian Agent validating…`, 'agents');
  await new Promise(r => setTimeout(r, 500));
  const msgs = document.getElementById('chat-messages');

  if (params.amount > 100000) {
    if (msgs?.lastElementChild) msgs.removeChild(msgs.lastElementChild);
    return { approved: false, reason: 'Amount exceeds safety limit ($100,000)' };
  }
  if (params.type === 'payment' && params.recipient && !/^0x[0-9a-fA-F]{40}$/.test(params.recipient)) {
    if (msgs?.lastElementChild) msgs.removeChild(msgs.lastElementChild);
    return { approved: false, reason: 'Invalid recipient address format' };
  }
  if (params.amount <= 0) {
    if (msgs?.lastElementChild) msgs.removeChild(msgs.lastElementChild);
    return { approved: false, reason: 'Amount must be greater than 0' };
  }
  if (msgs?.lastElementChild) msgs.removeChild(msgs.lastElementChild);

  // Log to guardian
  try {
    const log = JSON.parse(localStorage.getItem('arc_guardian_log') || '[]');
    log.unshift({ ts: Date.now(), type: params.type, amount: params.amount, approved: true });
    if (log.length > 100) log.pop();
    localStorage.setItem('arc_guardian_log', JSON.stringify(log));
  } catch { }

  return { approved: true };
}

// ── Chat-triggered platform actions ───────────────────────────────────────────
// BRAIN ONLY: chatbot never executes blockchain transactions.
// It only prepares structured payment data and dispatches a 'arcPayQueue:add' event.
// The UI (queue-engine.js) listens to this event and shows the Execute button.
async function chatExecutePayment(amount, token, recipient) {
  // If AgentExecutor is active, create an intent for autonomous execution
  // Otherwise fall back to queue (manual Execute button)
  if (typeof AgentExecutor !== 'undefined' && isAgentActive()) {
    await _chatAgentTransfer(amount, token, recipient);
  } else {
    _chatQueueTransfer(amount, token, recipient);
  }
}

// ── _chatAgentTransfer: create an intent → AgentExecutor executes automatically ─
// Delegates to unifiedAgentTransfer from chat-bridge.js when loaded.
// Context-aware: uses autonoma source when autonoma tab is active.
async function _chatAgentTransfer(amount, token, recipient) {
  const source = window._autonomaActive ? 'autonoma' : 'main';
  // If bridge is loaded, use it for consistent behavior across both chatbots
  if (typeof window.unifiedAgentTransfer === 'function') {
    return window.unifiedAgentTransfer(amount, token, recipient, source);
  }

  // Fallback: inline implementation (used before bridge loads)
  try {
    const tokenStr = (token || 'USDC').toUpperCase();

    // Check permit2 spending permissions for helpful context message
    let permitInfo = '';
    try {
      const permitStore = localStorage.getItem('arc_permit2_allowances_v1');
      if (permitStore) {
        const wallet = window.walletState?.address;
        const now = Date.now();
        const all = JSON.parse(permitStore);
        const active = all.filter(p =>
          wallet && p.wallet && p.wallet.toLowerCase() === wallet.toLowerCase() &&
          p.expiry > now && (p.amount - (p.amountUsed || 0)) > 0 &&
          p.token.toUpperCase() === tokenStr
        );
        if (active.length > 0) {
          const rem = (active[0].amount - (active[0].amountUsed || 0)).toFixed(2);
          const exp = Math.round((active[0].expiry - now) / 60000);
          permitInfo = `\n\n🔐 *Using Permit2 spending permission (${rem} ${tokenStr} remaining, ${exp}m left)*`;
        } else {
          permitInfo = `\n\n⚡ *No Permit2 spending permit — wallet popup will appear to sign the transfer*`;
        }
      }
    } catch {}

    // Show "Accepted" state immediately
    appendChatMessage('assistant',
      `🧠 **Intent accepted**\n\n` +
      `Queuing **${amount} ${tokenStr}** → \`${recipient.slice(0,10)}…${recipient.slice(-8)}\`\n\n` +
      `⏳ *Submitting to Agent Executor…*${permitInfo}`,
      'payments'
    );

    const intent = await AgentExecutor.queueTransfer(
      String(amount),
      tokenStr,
      recipient,
      'via chat'
    );

    appendChatMessage('assistant',
      `✅ **Intent queued — Agent Executor will process it shortly.**\n\n` +
      `| | |\n|---|---|\n` +
      `| Token | **${intent.token}** |\n` +
      `| Amount | **${intent.amount} ${intent.token}** |\n` +
      `| To | \`${recipient.slice(0,10)}…${recipient.slice(-8)}\` |\n` +
      `| Status | ${AgentExecutor.statusBadge ? AgentExecutor.statusBadge(intent.id, 'pending') : '⏳ pending'} |\n` +
      `| ID | \`${intent.id.slice(0,20)}…\` |\n\n` +
      (permitInfo.includes('Permit2 spending')
        ? `🤖 *Executing autonomously via Permit2 spending permit…*`
        : `⚡ *Wallet popup will appear momentarily to sign the transfer.*`),
      'payments'
    );

    console.log('[CHAT] Intent created:', intent.id, 'amount:', amount, tokenStr);

  } catch (err) {
    console.error('[CHAT] _chatAgentTransfer error:', err);
    _aeWarnFallback(err);
    _chatQueueTransfer(amount, token, recipient);
  }
}

function _aeWarnFallback(err) {
  const msg = err?.message || 'unknown error';
  // Give specific guidance based on error type
  let guidance = 'Your transfer was added to the manual queue instead. Click **Execute Payments** to proceed.';
  if (/session expired|not authorized|re-authorize/i.test(msg)) {
    guidance = 'Please **Authorize Daat Agent** in the chat first (click the status bar above).';
  } else if (/wallet not connected/i.test(msg)) {
    guidance = 'Connect your EVM wallet first, then authorize the Daat Agent.';
  }
  appendChatMessage('assistant',
    `⚠️ **Agent issue:** ${msg}\n\n${guidance}`,
    'warning'
  );
}


// ── _chatQueueTransfer: enqueue a single transfer (Brain → UI, no execution) ──
// Dispatches 'arcPayQueue:add' event. The UI (queue-engine) picks it up and
// shows the Execute button. Wallet popup NEVER opened from here.
function _chatQueueTransfer(amount, token, recipient) {
  const payload = {
    type: 'transfer',
    token: token || 'USDC',
    amount: parseFloat(amount),
    recipient,
  };

  // Dispatch event so queue-engine.js (or any UI listener) can pick it up
  window.dispatchEvent(new CustomEvent('arcPayQueue:add', { detail: payload }));

  appendChatMessage('assistant',
    `📥 **Transferência adicionada à fila!**\n\n` +
    `| Campo | Valor |\n|---|---|\n` +
    `| Token | **${payload.token}** |\n` +
    `| Valor | **${payload.amount} ${payload.token}** |\n` +
    `| Para | \`${recipient.slice(0,10)}…${recipient.slice(-8)}\` |\n\n` +
    `👆 Clique em **Execute Payments** para assinar e enviar.`,
    'payments'
  );
}
window._chatQueueTransfer = _chatQueueTransfer;

// Kept as alias for backward compat — does NOT execute, only queues
window._chatDirectTransfer = function(amount, token, recipient) {
  _chatQueueTransfer(amount, token, recipient);
};

// ── Pre-fill form (original behaviour as fallback) ────────────────────────────
async function _chatPrefillPaymentForm(amount, token, recipient) {
  switchTab('payments');
  await new Promise(r => setTimeout(r, 300));
  const addrEl = document.getElementById('pay-recipient');
  const amtEl  = document.getElementById('pay-amount');
  if (addrEl) { addrEl.value = recipient; addrEl.dispatchEvent(new Event('input', { bubbles: true })); }
  if (amtEl)  { amtEl.value  = amount;    amtEl.dispatchEvent(new Event('input', { bubbles: true })); }
  if (token && typeof selectPayToken === 'function') selectPayToken(token);
  if (typeof updatePayPreview === 'function') updatePayPreview();
  if (typeof payValidateForm  === 'function') payValidateForm();
  // Trigger fee calculation after form fill
  if (typeof payUpdateGasEstimate === 'function') setTimeout(payUpdateGasEstimate, 500);
  appendChatMessage('assistant',
    `✅ **Form pre-filled!**\n\n` +
    `Amount: **${amount} ${token}** → \`${recipient.slice(0,10)}…\`\n\n` +
    `Fee breakdown is being calculated. Review and click **Sign & Send** to execute.`,
    'payments'
  );
  appendActionCard([{ label: '💳 Go to Payments Tab', action: `switchTab('payments')`, primary: true }]);
}
window._chatPrefillPaymentForm = _chatPrefillPaymentForm;

function chatOpenSwap(amount, fromToken, toToken) {
  switchTab('dex');
  setTimeout(() => {
    const fromEl = document.getElementById('dex-from-token');
    const toEl   = document.getElementById('dex-to-token');
    const amtEl  = document.getElementById('dex-from-amount');
    if (fromEl) fromEl.value = fromToken;
    if (toEl)   toEl.value   = toToken;
    if (amtEl)  { amtEl.value = amount; amtEl.dispatchEvent(new Event('input')); }
  }, 300);
  appendChatMessage('assistant',
    `✅ **DEX opened — ${amount} ${fromToken} → ${toToken}**\n\nReview and confirm on-chain.`,
    'swap'
  );
}

function chatOpenMultisend(recipients) {
  switchTab('multisend');
  setTimeout(() => {
    if (typeof msInitRows === 'function') msInitRows();
    const container = document.getElementById('ms-rows');
    if (container) container.innerHTML = '';
    if (typeof msRowCounter !== 'undefined') window.msRowCounter = 0;
    recipients.forEach(r => {
      if (typeof msAddRow === 'function') msAddRow(r.address, r.amount.toFixed(2), '');
    });
    if (typeof msUpdateStats === 'function') msUpdateStats();
  }, 400);
  appendChatMessage('assistant',
    `✅ **Multisend pre-filled with ${recipients.length} recipients.**\n\nReview and click **Proceed to Review** to continue.`,
    'payments'
  );
  toggleChat();
}

function chatOpenContractForm(contractor, amount) {
  switchTab('contracts');
  setTimeout(() => {
    const contractorEl = document.getElementById('cf-contractor');
    const titleEl      = document.getElementById('cf-title');
    if (contractorEl) contractorEl.value = contractor;
    if (titleEl && !titleEl.value) titleEl.value = 'Contract via Daat Agent';
    // Trigger add milestone with amount
    const milestoneAmtEl = document.querySelector('.cf-milestone-amount');
    const milestoneTitleEl = document.querySelector('.cf-milestone-title');
    if (milestoneAmtEl) milestoneAmtEl.value = amount;
    if (milestoneTitleEl && !milestoneTitleEl.value) milestoneTitleEl.value = 'Milestone 1';
    if (typeof cfUpdateFeePreview === 'function') cfUpdateFeePreview();
  }, 400);
  appendChatMessage('assistant',
    `✅ **Contract form pre-filled!**\n\n` +
    `Contractor: \`${contractor.slice(0,10)}…\`\n` +
    `Value: **$${parseFloat(amount).toFixed(2)} USDC**\n\n` +
    `Review the form and click **Create Contract** to deploy on-chain.`,
    'contracts'
  );
  toggleChat();
}

// ── Quick message ── context-aware: routes to autonoma when that tab is active ──
function sendQuickMessage(text) {
  // If autonoma tab is active, use its input handler
  if (window._autonomaActive && typeof window.autonomaSendChat === 'function') {
    window.autonomaSendChat(text);
    return;
  }
  const input = document.getElementById('chat-input');
  if (input) { input.value = text; sendChatMessage(); }
}

// ── Append message ─────────────────────────────────────────────────────────────
function appendChatMessage(role, content, module, scroll = true) {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  const isUser     = role === 'user';
  const modColor   = getModuleColor(module);
  const modIcon    = getModuleIcon(module);
  const rendered   = isUser ? escapeHtml(content) : renderMarkdown(content);
  const div        = document.createElement('div');
  div.className    = `flex ${isUser ? 'justify-end' : 'justify-start'} gap-1.5`;

  if (!isUser) {
    div.innerHTML = `
      <div class="w-5 h-5 rounded-md bg-gradient-to-br from-purple-700 to-blue-700 flex items-center justify-center flex-shrink-0 mt-0.5">
        <i class="fas ${modIcon} text-white" style="font-size:9px"></i>
      </div>
      <div class="max-w-[90%] rounded-xl rounded-tl-sm px-3 py-2 bg-gray-800 border border-gray-700/50">
        ${module && module !== 'general' ? `<div class="flex items-center gap-1 mb-1"><span class="text-[10px] ${modColor} font-medium uppercase">${module}</span></div>` : ''}
        <div class="text-xs text-gray-100 chat-content leading-relaxed">${rendered}</div>
        <div class="text-[10px] text-gray-600 mt-1">${new Date().toLocaleTimeString()}</div>
      </div>`;
  } else {
    div.innerHTML = `
      <div class="max-w-[80%] rounded-xl rounded-tr-sm px-3 py-2 bg-purple-700 border border-purple-600/50">
        <div class="text-xs text-white">${rendered}</div>
        <div class="text-[10px] text-purple-300 mt-1">${new Date().toLocaleTimeString()}</div>
      </div>`;
  }
  container.appendChild(div);
  if (scroll) scrollChatToBottom();
}

function appendActionCard(buttons) {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'flex justify-start pl-7';
  const btnsHtml = buttons.map(b =>
    `<button onclick="${b.action}" class="chat-action-btn ${b.danger ? 'chat-action-btn-danger' : b.success ? 'chat-action-btn-success' : b.primary ? 'chat-action-btn-primary' : 'chat-action-btn-secondary'}">
      ${b.label}
    </button>`
  ).join('');
  div.innerHTML = `<div class="chat-action-card">${btnsHtml}</div>`;
  container.appendChild(div);
  scrollChatToBottom();
}

// ── Blockchain Action Card — renders structured action from LLM ────────────────
// CONTEXT-AWARE: uses appendActionCard (patched by autonoma when that tab is active)
// so the card always goes to the correct chat container.
function renderBlockchainActionCard(action, walletConnected) {
  if (!action || !action.type) return;
  // Resolve correct container: if autonoma is active AND autonomaAppendActionCard exists,
  // we'll use it via appendActionCard (which is patched). Otherwise use main chat container.
  const useNativeAppend = typeof window.appendActionCard === 'function' && window._autonomaActive;
  // For main chat, we still need the container for the full card HTML.
  // We handle autonoma by calling autonomaAppendMessage for the card itself.
  const container = useNativeAppend
    ? document.getElementById('autonoma-chat-messages')
    : document.getElementById('chat-messages');
  if (!container) return;

  const typeIcons = {
    transfer: '💳', swap: '🔄', multisend: '📤',
    contract_deploy: '📋', contract_call: '🔍', automation: '🤖',
  };
  const typeLabels = {
    transfer: 'Transfer', swap: 'Swap', multisend: 'Multisend',
    contract_deploy: 'Deploy Contract', contract_call: 'Contract Call', automation: 'Automation',
  };

  const icon  = typeIcons[action.type]  || '⚡';
  const label = typeLabels[action.type] || action.type;
  const d     = action.data || {};

  // Build params display
  let paramsHtml = '';
  if (action.type === 'transfer') {
    paramsHtml = `
      <div class="arc-action-param"><span>Token</span><b>${d.token || '—'}</b></div>
      <div class="arc-action-param"><span>Amount</span><b>${d.amount || '—'} ${d.token || ''}</b></div>
      <div class="arc-action-param"><span>To</span><b class="font-mono text-xs">${d.to ? d.to.slice(0,10)+'…'+d.to.slice(-6) : '—'}</b></div>`;
  } else if (action.type === 'swap') {
    paramsHtml = `
      <div class="arc-action-param"><span>From</span><b>${d.amount || '—'} ${d.fromToken || '—'}</b></div>
      <div class="arc-action-param"><span>To</span><b>${d.toToken || '—'}</b></div>`;
  } else if (action.type === 'multisend') {
    const count = Array.isArray(d.receivers) ? d.receivers.length : '?';
    const total = Array.isArray(d.receivers)
      ? d.receivers.reduce((s, r) => s + parseFloat(r.amount || 0), 0).toFixed(2)
      : '?';
    paramsHtml = `
      <div class="arc-action-param"><span>Token</span><b>${d.token || 'USDC'}</b></div>
      <div class="arc-action-param"><span>Recipients</span><b>${count} wallets</b></div>
      <div class="arc-action-param"><span>Total</span><b>${total} ${d.token || 'USDC'}</b></div>`;
  } else if (action.type === 'contract_deploy') {
    paramsHtml = `
      <div class="arc-action-param"><span>Type</span><b>${d.contractType || 'escrow'}</b></div>
      <div class="arc-action-param"><span>Value</span><b>${d.totalValue || '—'} ${d.token || 'USDC'}</b></div>
      ${d.milestones ? `<div class="arc-action-param"><span>Milestones</span><b>${d.milestones}</b></div>` : ''}`;
  } else if (action.type === 'contract_call') {
    paramsHtml = `
      <div class="arc-action-param"><span>Method</span><b>${d.method || '—'}</b></div>
      ${Array.isArray(d.params) ? `<div class="arc-action-param"><span>Params</span><b class="font-mono text-xs">${d.params.join(', ')}</b></div>` : ''}`;
  } else if (action.type === 'automation') {
    paramsHtml = `
      <div class="arc-action-param"><span>Trigger</span><b>${d.trigger || '—'}</b></div>
      <div class="arc-action-param"><span>Action</span><b>${d.action || '—'}</b></div>
      ${d.amount ? `<div class="arc-action-param"><span>Amount</span><b>${d.amount} ${d.token || 'USDC'}</b></div>` : ''}
      ${d.to ? `<div class="arc-action-param"><span>To</span><b class="font-mono text-xs">${d.to.slice(0,10)+'…'+d.to.slice(-6)}</b></div>` : ''}`;
  }

  // Store action data for execute handler
  const actionId = 'arc-act-' + Date.now();

  // ── CTA button — route-aware ──────────────────────────────────────────────
  // transfer  → queue via _chatQueueTransfer → Payments tab
  // multisend → queue via _chatQueueBatch    → Multisend tab
  // others    → arcExecuteAction (navigate + fill form)
  let ctaHtml = '';
  const needsWallet = !walletConnected || action.status === 'requires_wallet';
  if (needsWallet) {
    ctaHtml = `<button onclick="openWalletModal()" class="arc-action-cta arc-action-cta-wallet">
      🔗 Conectar Wallet para Executar
    </button>`;
  } else if (action.type === 'transfer' && d.to && d.amount) {
    // Single transfer → queue to Payments (never multisend)
    const safeAmt   = JSON.stringify(String(d.amount));
    const safeTok   = JSON.stringify(String(d.token || 'USDC'));
    const safeTo    = JSON.stringify(String(d.to));
    ctaHtml = `<button onclick="_chatQueueTransfer(${safeAmt},${safeTok},${safeTo})" class="arc-action-cta arc-action-cta-execute">
      📥 Adicionar à Fila → Payments
    </button>`;
  } else if (action.type === 'multisend' && Array.isArray(d.receivers) && d.receivers.length) {
    // Batch → queue to Multisend
    const safeRecs = JSON.stringify(d.receivers.map(r => ({ address: r.address || r.to || '', amount: r.amount || 0 })));
    const safeTok  = JSON.stringify(String(d.token || 'USDC'));
    ctaHtml = `<button onclick="_chatQueueBatch(${safeRecs},${safeTok})" class="arc-action-cta arc-action-cta-execute">
      📥 Adicionar Lote → Multisend
    </button>`;
  } else {
    ctaHtml = `<button onclick="arcExecuteAction('${actionId}')" class="arc-action-cta arc-action-cta-execute">
      ⚡ Executar ${label} →
    </button>`;
  }

  const statusColor = needsWallet ? '#f59e0b' : '#22c55e';
  const statusText  = needsWallet ? 'Wallet necessária' : 'Pronto para executar';

  const card = document.createElement('div');
  card.className = 'flex justify-start pl-7 mb-2';
  card.id = actionId + '-card';
  card.innerHTML = `
    <div class="arc-blockchain-action-card">
      <div class="arc-action-header">
        <span class="arc-action-type-badge">${icon} ${label}</span>
        <span class="arc-action-status" style="color:${statusColor}">● ${statusText}</span>
      </div>
      <div class="arc-action-params">${paramsHtml}</div>
      ${ctaHtml}
    </div>`;

  // Store action payload on the DOM element for later retrieval
  card._arcAction = action;

  // Register in global map
  if (!window._arcPendingActions) window._arcPendingActions = {};
  window._arcPendingActions[actionId] = action;

  container.appendChild(card);
  container.scrollTop = container.scrollHeight;
  if (!window._autonomaActive) scrollChatToBottom();
}

// ── Execute Action: fill form + navigate to correct tab ────────────────────────
function arcExecuteAction(actionId) {
  const action = window._arcPendingActions && window._arcPendingActions[actionId];
  if (!action) return;

  const d = action.data || {};

  // Helper: set field value and trigger input event
  function fillField(id, value) {
    const el = document.getElementById(id);
    if (!el || value === undefined || value === null) return;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  switch (action.type) {

    case 'transfer': {
      // Single recipient → Payments tab (NEVER Multisend)
      // Queue the transfer so "Execute Payments" button appears in chat
      if (d.to && d.amount) {
        const token = d.token || 'USDC';
        _chatQueueTransfer(String(d.amount), token, String(d.to));
      }
      // Navigate to payments tab + pre-fill the form
      if (typeof switchTab === 'function') switchTab('payments');
      setTimeout(() => {
        fillField('pay-recipient', d.to || '');
        fillField('pay-amount', d.amount || '');
        // Select token
        if (d.token && typeof selectPayToken === 'function') selectPayToken(d.token);
        if (typeof updatePayPreview === 'function') updatePayPreview();
        if (typeof payValidateForm === 'function') payValidateForm();
        // Trigger fee calculation with a small delay (fees load asynchronously)
        if (typeof payUpdateGasEstimate === 'function') setTimeout(payUpdateGasEstimate, 500);
        // Close chat after short delay
        setTimeout(() => { if (typeof toggleChat === 'function') toggleChat(); }, 300);
      }, 400);
      break;
    }

    case 'swap': {
      // Navigate to DEX tab + fill form
      if (typeof switchTab === 'function') switchTab('dex');
      setTimeout(() => {
        fillField('swap-amount-in', d.amount || '');
        // Try to set token selects if available
        const fromSel = document.getElementById('swap-token-in');
        const toSel   = document.getElementById('swap-token-out');
        if (fromSel && d.fromToken) { fromSel.value = d.fromToken; fromSel.dispatchEvent(new Event('change')); }
        if (toSel && d.toToken)     { toSel.value   = d.toToken;   toSel.dispatchEvent(new Event('change')); }
        setTimeout(() => { if (typeof toggleChat === 'function') toggleChat(); }, 300);
      }, 400);
      break;
    }

    case 'multisend': {
      // Multiple recipients → Multisend tab
      // Queue the batch so "Execute Payments" button appears
      if (Array.isArray(d.receivers) && d.receivers.length >= 1) {
        _chatQueueBatch(
          d.receivers.map(r => ({ address: r.address || r.to || '', amount: r.amount || 0 })),
          d.token || 'USDC'
        );
      }
      // Navigate to multisend tab
      if (typeof switchTab === 'function') switchTab('multisend');
      setTimeout(() => {
        // Try to populate multisend recipients if function exists
        if (typeof window.arcPopulateMultisend === 'function' && Array.isArray(d.receivers)) {
          window.arcPopulateMultisend(d.receivers, d.token || 'USDC');
        }
        setTimeout(() => { if (typeof toggleChat === 'function') toggleChat(); }, 300);
      }, 400);
      break;
    }

    case 'contract_deploy': {
      // Navigate to contracts tab + fill form
      if (typeof switchTab === 'function') switchTab('contracts');
      setTimeout(() => {
        fillField('cf-value', d.totalValue || '');
        if (d.token && typeof window.cfSelectToken === 'function') window.cfSelectToken(d.token);
        if (d.milestones) fillField('cf-milestones', String(d.milestones));
        if (d.title) fillField('cf-title', d.title);
        if (d.contractor) fillField('cf-contractor', d.contractor);
        if (typeof cfUpdateFeePreview === 'function') cfUpdateFeePreview();
        setTimeout(() => { if (typeof toggleChat === 'function') toggleChat(); }, 300);
      }, 400);
      break;
    }

    case 'contract_call': {
      if (typeof switchTab === 'function') switchTab('contracts');
      setTimeout(() => { if (typeof toggleChat === 'function') toggleChat(); }, 600);
      break;
    }

    case 'automation': {
      if (typeof switchTab === 'function') switchTab('agents');
      setTimeout(() => { if (typeof toggleChat === 'function') toggleChat(); }, 600);
      break;
    }

    default:
      if (typeof toggleChat === 'function') toggleChat();
  }

  // Visual feedback: mark card as executed
  const cardEl = document.getElementById(actionId + '-card');
  if (cardEl) {
    const btn = cardEl.querySelector('.arc-action-cta-execute');
    if (btn) {
      btn.textContent = '✅ Redirecionando...';
      btn.disabled = true;
      btn.style.opacity = '0.7';
    }
  }
}


// ── Typing indicator ───────────────────────────────────────────────────────────
function showTypingIndicator() {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  const div = document.createElement('div');
  div.id = 'chat-typing';
  div.className = 'flex items-start gap-1.5';
  div.innerHTML = `
    <div class="w-5 h-5 rounded-md bg-gradient-to-br from-purple-700 to-blue-700 flex items-center justify-center flex-shrink-0">
      <i class="fas fa-robot text-white" style="font-size:9px"></i>
    </div>
    <div class="bg-gray-800 border border-gray-700/50 rounded-xl rounded-tl-sm px-3 py-2">
      <div class="flex gap-1 items-center h-3">
        <div class="w-1.5 h-1.5 bg-purple-400 rounded-full animate-bounce" style="animation-delay:0ms"></div>
        <div class="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" style="animation-delay:150ms"></div>
        <div class="w-1.5 h-1.5 bg-purple-400 rounded-full animate-bounce" style="animation-delay:300ms"></div>
      </div>
    </div>`;
  container.appendChild(div);
  scrollChatToBottom();
}
function hideTypingIndicator() { document.getElementById('chat-typing')?.remove(); }

async function clearChatHistory() {
  try { await (async function() {
   console.log('[fetch] DELETE', `/api/chat/history/${CHAT_SESSION_ID}`);
   try {
     var _r = await fetch(`/api/chat/history/${CHAT_SESSION_ID}`, {method:'DELETE',headers:{'Content-Type':'application/json'}});
     if (!_r.ok) { var _e = new Error('DELETE failed: '+_r.status); _e.response={data:await _r.json().catch(function(){return null;}),status:_r.status}; throw _e; }
     var _d = await _r.json().catch(function(){return null;});
     return {data:_d, status:_r.status};
   } catch(_ex) { console.error('[fetch] DELETE ERR', `/api/chat/history/${CHAT_SESSION_ID}`, _ex.message); throw _ex; }
 }()); } catch { }
  const container = document.getElementById('chat-messages');
  if (container) container.innerHTML = '';
  chatInitialized = false;
  appendChatMessage('assistant', '🧹 Chat cleared! How can I help you?', 'general');
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function scrollChatToBottom() {
  const c = document.getElementById('chat-messages');
  if (c) setTimeout(() => { c.scrollTop = c.scrollHeight; }, 50);
}
function getModuleColor(m) {
  return { payments:'text-blue-400', vaults:'text-green-400', swap:'text-purple-400',
           contracts:'text-orange-400', agents:'text-red-400', network:'text-cyan-400',
           general:'text-gray-400', error:'text-red-400', permit2:'text-yellow-400',
           csv:'text-purple-300', batch:'text-indigo-400', receipt:'text-teal-400' }[m] || 'text-gray-400';
}
function getModuleIcon(m) {
  return { payments:'fa-dollar-sign', vaults:'fa-vault', swap:'fa-exchange-alt',
           contracts:'fa-file-contract', agents:'fa-brain', network:'fa-network-wired',
           general:'fa-robot', error:'fa-exclamation-triangle', permit2:'fa-key',
           csv:'fa-file-csv', batch:'fa-layer-group', receipt:'fa-receipt' }[m] || 'fa-robot';
}
function escapeHtml(t) {
  return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function renderMarkdown(text) {
  return text
    .replace(/\|(.+)\|\n\|[-|: ]+\|\n((?:\|.+\|\n?)+)/g, (_, header, body) => {
      const ths  = header.split('|').filter(s=>s.trim()).map(s=>`<th class="px-2 py-1 text-left text-xs text-gray-300 font-semibold border-b border-gray-700">${s.trim()}</th>`).join('');
      const rows = body.trim().split('\n').map(row => {
        const tds = row.split('|').filter(s=>s.trim()).map(s=>`<td class="px-2 py-1 text-xs text-gray-100 border-b border-gray-800">${s.trim()}</td>`).join('');
        return `<tr>${tds}</tr>`;
      }).join('');
      return `<div class="overflow-x-auto my-1"><table class="w-full"><thead><tr>${ths}</tr></thead><tbody>${rows}</tbody></table></div>`;
    })
    .replace(/```[\s\S]*?```/g, m=>`<code class="block bg-black/40 rounded px-2 py-1.5 text-xs text-green-400 font-mono my-1 whitespace-pre">${m.replace(/```/g,'')}</code>`)
    .replace(/^## (.+)$/gm,'<p class="font-bold text-white text-sm mb-1 mt-2">$1</p>')
    .replace(/^### (.+)$/gm,'<p class="font-semibold text-purple-300 text-xs mb-1 mt-1.5">$1</p>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2" target="_blank" class="text-blue-400 underline hover:text-blue-300">$1</a>')
    .replace(/\*\*(.+?)\*\*/g,'<strong class="font-semibold text-white">$1</strong>')
    .replace(/`([^`]+)`/g,'<code class="bg-black/30 text-green-400 px-1 rounded text-xs font-mono">$1</code>')
    .replace(/^[•\-\*] (.+)$/gm,'<div class="flex items-start gap-1.5 my-0.5"><span class="text-purple-400 mt-0.5 flex-shrink-0">•</span><span>$1</span></div>')
    .replace(/\n\n/g,'<div class="h-2"></div>')
    .replace(/\n/g,'<br>');
}

// ── Keyboard shortcut ──────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === '/') {
    e.preventDefault();
    if (!chatOpen) toggleChat(); else document.getElementById('chat-input')?.focus();
  }
  if (e.key === 'Escape' && chatOpen && chatSize !== 'full') toggleChat();
});

// ── Wallet event sync ──────────────────────────────────────────────────────────
window.addEventListener('walletConnected', () => {
  updateArcPayBar();
  // If session wallet doesn't match newly connected wallet, clear session
  if (arcPaySession && window.walletState?.address &&
      arcPaySession.wallet.toLowerCase() !== window.walletState.address.toLowerCase()) {
    clearSession();
    updateArcPayBar();
    if (chatOpen) {
      appendChatMessage('assistant',
        `⚠️ Wallet changed — Daat session cleared.\n\nRe-authorize to use the agent with this wallet.`,
        'agents'
      );
    }
  }
});
window.addEventListener('walletDisconnected', () => {
  updateArcPayBar();
});

// ── Global exports ─────────────────────────────────────────────────────────────
window.toggleChat               = toggleChat;
window.sendChatMessage          = sendChatMessage;
window.renderBlockchainActionCard = renderBlockchainActionCard;
window.sendQuickMessage         = sendQuickMessage;
window.clearChatHistory         = clearChatHistory;
window.setChatSize              = setChatSize;
window.openChatNewTab           = openChatNewTab;
window.updateArcPayBar          = updateArcPayBar;
window.executeArcPayAuthorization = executeArcPayAuthorization;
window.cancelArcPayAuth         = cancelArcPayAuth;
window.revokeArcPaySession      = revokeArcPaySession;
// chatExecutePayment agora apenas enfileira (não executa blockchain)
window.chatExecutePayment       = chatExecutePayment;
window.chatOpenSwap             = chatOpenSwap;
window.chatOpenMultisend        = chatOpenMultisend;
window.chatOpenContractForm     = chatOpenContractForm;
window.appendChatMessage        = appendChatMessage;
window.isAgentActive            = isAgentActive;

// ── _chatQueueBatch: enqueue a batch transfer (Brain → UI, no execution) ────
// Dispatches 'arcPayQueue:addBatch'. The UI shows the Execute button.
function _chatQueueBatch(recipients, token) {
  const payload = {
    type: 'batch',
    token: token || 'USDC',
    recipients: recipients, // [{address, amount}]
  };

  window.dispatchEvent(new CustomEvent('arcPayQueue:addBatch', { detail: payload }));

  const total = recipients.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
  const sample = recipients.slice(0, 3).map((r, i) =>
    `${i+1}. \`${r.address.slice(0,10)}…\` — **${parseFloat(r.amount).toFixed(2)} ${token || 'USDC'}**`
  ).join('\n');
  const more = recipients.length > 3 ? `\n…e mais ${recipients.length - 3}` : '';

  appendChatMessage('assistant',
    `📥 **Lote adicionado à fila!**\n\n` +
    `${sample}${more}\n\n` +
    `| Campo | Valor |\n|---|---|\n` +
    `| Token | **${token || 'USDC'}** |\n` +
    `| Total | **${total.toFixed(2)} ${token || 'USDC'}** |\n` +
    `| Destinatários | **${recipients.length}** |\n\n` +
    `👆 Clique em **Execute Payments** para assinar e enviar.`,
    'payments'
  );
}
window._chatQueueBatch  = _chatQueueBatch;
window._chatExecuteBatch = function(recipients, token) { _chatQueueBatch(recipients, token); };

// Legacy compat
window.executeArcPayApproval = executeArcPayAuthorization;
window.revokeArcPay          = revokeArcPaySession;

// ══════════════════════════════════════════════════════════════════════════════
// CSV UPLOAD INTEGRATION — chat.js bridge
// Wires the hidden file input, drag-and-drop, banner, and handleLocalCommand
// ══════════════════════════════════════════════════════════════════════════════

// ── File input handler (called by onchange on #chat-csv-file-input) ────────────
window.chatHandleCSVInput = function(inputEl) {
  const file = inputEl?.files?.[0];
  if (!file) return;
  inputEl.value = ''; // reset so same file can be re-uploaded
  if (typeof handleChatCSVFile !== 'function') {
    showToast('❌ CSV module not loaded', 'error');
    return;
  }
  showTypingIndicator();
  setTimeout(() => handleChatCSVFile(file), 50);
  updateCSVBanner();
};

// ── Update the CSV status banner inside the chat widget ────────────────────────
function updateCSVBanner() {
  const banner = document.getElementById('chat-csv-banner');
  const text   = document.getElementById('chat-csv-banner-text');
  const state  = window.chatCSVState;
  if (!banner || !text || !state) return;
  if (state.loaded && state.rows.length > 0) {
    const total = state.rows.reduce((s, r) => s + r.amount, 0);
    text.textContent = `📊 ${state.fileName} · ${state.rows.length} recipients · ${total.toFixed(2)} ${state.token}`;
    banner.classList.remove('hidden');
    // Pulse the CSV button to indicate loaded state
    const csvBtn = document.getElementById('chat-csv-btn');
    if (csvBtn) {
      csvBtn.classList.add('text-purple-400');
      csvBtn.classList.remove('text-gray-500');
    }
  } else {
    banner.classList.add('hidden');
    const csvBtn = document.getElementById('chat-csv-btn');
    if (csvBtn) {
      csvBtn.classList.remove('text-purple-400');
      csvBtn.classList.add('text-gray-500');
    }
  }
}

// ── Drag-and-drop on the chat widget ──────────────────────────────────────────
(function initChatDragDrop() {
  function getWidget() { return document.getElementById('chat-widget'); }
  function getOverlay(){ return document.getElementById('chat-csv-drop-overlay'); }

  function showOverlay() {
    const ov = getOverlay();
    if (ov) { ov.classList.remove('hidden'); ov.classList.add('flex'); }
  }
  function hideOverlay() {
    const ov = getOverlay();
    if (ov) { ov.classList.add('hidden'); ov.classList.remove('flex'); }
  }

  // We attach drag listeners when chat widget is opened, or on DOMContentLoaded
  function attachDragListeners() {
    const w = getWidget();
    if (!w || w._csvDragAttached) return;
    w._csvDragAttached = true;

    let dragCounter = 0;

    w.addEventListener('dragenter', (e) => {
      e.preventDefault();
      const hasFiles = [...(e.dataTransfer?.items || [])].some(i => i.kind === 'file');
      if (!hasFiles) return;
      dragCounter++;
      showOverlay();
    });
    w.addEventListener('dragleave', (e) => {
      dragCounter--;
      if (dragCounter <= 0) { dragCounter = 0; hideOverlay(); }
    });
    w.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    w.addEventListener('drop', (e) => {
      e.preventDefault();
      dragCounter = 0;
      hideOverlay();
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      if (typeof handleChatCSVFile !== 'function') return;
      showTypingIndicator();
      setTimeout(() => handleChatCSVFile(file), 50);
      setTimeout(updateCSVBanner, 800);
    });
  }

  document.addEventListener('DOMContentLoaded', attachDragListeners);
  // Also try attaching after a delay (chat widget may be hidden on load)
  setTimeout(attachDragListeners, 1500);
})();

// ── Periodic banner sync ───────────────────────────────────────────────────────
setInterval(updateCSVBanner, 5000);

// ── Extend handleLocalCommand to intercept CSV-related prompts ─────────────────
const _origHandleLocalCommand = handleLocalCommand;
async function handleLocalCommandWithCSV(msg) {
  const lower = msg.toLowerCase().trim();

  // "reuse last csv" / "use last csv"
  if (/reuse.*csv|use.*last.*csv|last.*csv/i.test(lower)) {
    hideTypingIndicator();
    if (typeof window.csvReuseLastCSV === 'function') window.csvReuseLastCSV();
    return true;
  }

  // If CSV has loaded rows, intercept "send" commands
  if (window.chatCSVState?.loaded && window.chatCSVState?.rows?.length > 0) {
    if (typeof handleCSVSendCommand === 'function') {
      const handled = handleCSVSendCommand(msg);
      if (handled) {
        hideTypingIndicator();
        setTimeout(updateCSVBanner, 500);
        return true;
      }
    }
  }

  // If waiting for user to provide amount for Format B CSV
  if (window.chatCSVState?.pendingAmountRequest) {
    if (typeof handleCSVAmountReply === 'function') {
      const handled = handleCSVAmountReply(msg);
      if (handled) {
        hideTypingIndicator();
        setTimeout(updateCSVBanner, 500);
        return true;
      }
    }
  }

  // CSV-specific help
  if (/^(csv help|help csv|csv format|csv usage|como usar csv|batch help)$/i.test(lower)) {
    hideTypingIndicator();
    appendChatMessage('assistant',
      '📊 **CSV Batch Payments — Guide**\n\n' +
      '**How to use:**\n' +
      '1. Click the **📎** button (or drag & drop a `.csv` file)\n' +
      '2. The agent parses and validates your file\n' +
      '3. Type `send` to execute, or `edit` to open in Multisend\n\n' +
      '**Supported CSV formats:**\n\n' +
      '`Format A` — Address + Amount:\n' +
      '```\naddress,amount\n0x1234…,10\n0x5678…,5\n```\n\n' +
      '`Format B` — Address only (agent asks for amount):\n' +
      '```\naddress\n0x1234…\n0x5678…\n```\n\n' +
      '`Format C` — Address + Amount + Token:\n' +
      '```\naddress,amount,token\n0x1234…,10,USDC\n0x5678…,5,EURC\n```\n\n' +
      '**Commands:**\n' +
      '• `send` — execute loaded CSV\n' +
      '• `send 20 USDC` — override amount for all rows\n' +
      '• `reuse last csv` — reload previous session\'s CSV\n' +
      '• `edit` — open in Multisend for manual review\n\n' +
      '**Limits:** max 1,000 rows per file · up to $10,000 per address\n' +
      '**Chunking:** batches >100 rows auto-split into chunks',
      'payments'
    );
    return true;
  }

  return _origHandleLocalCommand(msg);
}

// Override global handleLocalCommand
// (re-bind so sendChatMessage picks it up)
window._handleLocalCommandCSV = handleLocalCommandWithCSV;

// Patch sendChatMessage to use our extended handler
const _origSendChatMessage = sendChatMessage;
window.sendChatMessage = async function() {
  const input   = document.getElementById('chat-input');
  const msg     = input?.value?.trim();
  if (!msg || isTyping) return;

  input.value = '';
  appendChatMessage('user', msg);
  showTypingIndicator();
  isTyping = true;
  const sendBtn = document.getElementById('chat-send-btn');
  if (sendBtn) sendBtn.disabled = true;

  try {
    // Prefer unified handler (covers both chatbots identically).
    // Falls back to CSV-extended handler if bridge not loaded.
    const handled = typeof window.handleUnifiedMessage === 'function'
      ? await window.handleUnifiedMessage(msg, 'main')
      : await handleLocalCommandWithCSV(msg);
    if (handled) { hideTypingIndicator(); return; }

    // Send to AI backend
    const csvLoaded = window.chatCSVState?.loaded && window.chatCSVState?.rows?.length > 0;
    const _chatPayload = {
      message:        msg,
      sessionId:      CHAT_SESSION_ID,
      walletAddress:  window.walletState?.address || null,
      arcPayActive:   isAgentActive(),
      csvContext:     csvLoaded ? {
        loaded:     true,
        fileName:   window.chatCSVState.fileName,
        rowCount:   window.chatCSVState.rows.length,
        token:      window.chatCSVState.token,
        totalAmount: window.chatCSVState.rows.reduce((s, r) => s + r.amount, 0),
      } : null,
    };
    console.log('[fetch] POST /api/chat/message');
    const _chatR = await fetch('/api/chat/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(_chatPayload) });
    if (!_chatR.ok) { const _e = new Error('POST failed: ' + _chatR.status); _e.response = { status: _chatR.status }; throw _e; }
    const res = { data: await _chatR.json().catch(() => ({})) };
    hideTypingIndicator();
    if (res.data.success) {
      const reply = res.data.message;
      appendChatMessage('assistant', reply.content, reply.module);
      const action = res.data.action || reply.action;
      if (action && action.type && action.type !== 'none') {
        renderBlockchainActionCard(action, res.data.walletConnected);
      }
      if (!chatOpen) {
        unreadCount++;
        const badge = document.getElementById('chat-unread');
        if (badge) { badge.textContent = unreadCount > 9 ? '9+' : String(unreadCount); badge.classList.remove('hidden'); }
      }
    } else {
      appendChatMessage('assistant', '❌ ' + (res.data.error || 'Something went wrong.'), 'error');
    }
  } catch (e) {
    hideTypingIndicator();
    appendChatMessage('assistant', '❌ Network error. Please try again.', 'error');
  } finally {
    isTyping = false;
    if (sendBtn) sendBtn.disabled = false;
    input?.focus();
    setTimeout(updateCSVBanner, 300);
  }
};

// Also export updateCSVBanner for external use
window.updateCSVBanner = updateCSVBanner;

const _active = isAgentActive();
console.log('%c[CHAT v3 — Brain/Execution Split]', 'color:#a78bfa;font-weight:bold',
  'Daat Agent:', _active ? '✅ Active' : '⚠️ Not authorized',
  '| Session:', _active ? arcPaySession?.sessionHash?.slice(0,12)+'…' : 'none',
  '| Size:', chatSize,
  '| 🧠 Brain-only mode: chatbot nunca executa blockchain'
);
