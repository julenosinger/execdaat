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

// ── Drag-and-drop on the chat widget ──────────────────────────────────────────
// Moved from end of file to core module
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
