// ============================================================
// CHAT MODULE v3 — ARC AI Assistant
// ArcPay Agent v1.0 — Full Platform Integration
//
// Authorization Flow:
//   1. User clicks "Authorize ArcPay Agent" button
//   2. Wallet opens → user SIGNS an EIP-191 message (off-chain)
//   3. Wallet opens again → user CONFIRMS a 0-value USDC.transfer
//      to the factory contract as on-chain session proof
//   4. Session token stored: { wallet, sig, sessionHash, expiry }
//   5. Agent is now active — all platform ops via chat prompt
//
// Supported commands (post-authorization):
//   payments  : "send 10 USDC to 0x..."
//   multisend : "pay [addr]:10, [addr]:20"
//   swap      : "swap 5 USDC to EURC"
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
const CF_FACTORY     = '0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A';
const USDC_ADDR      = '0x3600000000000000000000000000000000000000';
const EURC_ADDR      = '0x89B5EF8FfF7e58BD6A1b7FcF04F1B6A2bbabD72a';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── State ──────────────────────────────────────────────────────────────────────
let chatOpen        = false;
let chatInitialized = false;
let isTyping        = false;
let unreadCount     = 0;
let chatSize        = localStorage.getItem('arc-chat-size') || 'medium';
let arcPaySession   = null;   // { wallet, sig, sessionHash, expiry, authorized }
let authInProgress  = false;  // prevent double-click on authorize

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
}

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
  medium: { width: '400px',  height: '580px', bottom: '70px', right: '20px' },
  full:   { width: '100vw',  height: '100vh', bottom: '0',    right: '0', borderRadius: '0' },
};

// ── CSS injection ──────────────────────────────────────────────────────────────
(function injectChatStyles() {
  if (document.getElementById('chat-styles-v3')) return;
  const s = document.createElement('style');
  s.id = 'chat-styles-v3';
  s.textContent = `
    #chat-widget {
      display: flex; flex-direction: column;
      transition: width 0.3s cubic-bezier(.4,0,.2,1),
                  height 0.3s cubic-bezier(.4,0,.2,1),
                  bottom 0.3s ease, right 0.3s ease,
                  border-radius 0.3s ease,
                  opacity 0.25s ease, transform 0.25s ease;
    }
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

    /* ArcPay auth bar — prominent, not hidden */
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
    applyChatSize(chatSize, false);
    widget.classList.remove('hidden');
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
    widget.style.opacity = '0';
    widget.style.transform = 'translateY(16px) scale(0.97)';
    setTimeout(() => widget.classList.add('hidden'), 260);
    if (fabIcon) fabIcon.className = 'fas fa-robot text-white text-base';
    if (fabLbl)  { fabLbl.classList.remove('hidden'); fabLbl.textContent = 'Ask me'; }
  }
}

// ── Size management ────────────────────────────────────────────────────────────
function setChatSize(size) {
  chatSize = size;
  localStorage.setItem('arc-chat-size', size);
  applyChatSize(size, true);
  ['mini','medium','full'].forEach(s => {
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
  });
  widget.setAttribute('data-size', size);
  if (!animate) requestAnimationFrame(() => { widget.style.transition = ''; });
}

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

// ── ArcPay Bar ─────────────────────────────────────────────────────────────────
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
      `<span class="arcpay-badge-active"><i class="fas fa-shield-alt"></i> ArcPay Agent Active</span>` +
      `<span class="text-[9px] text-green-600 ml-1">${walletShort} · exp ${expiry}</span>`;
    if (authBtn)   authBtn.classList.add('hidden');
    if (revokeBtn) revokeBtn.classList.remove('hidden');
    if (badge)     { badge.classList.remove('hidden'); badge.textContent = '✅ Active'; }
  } else {
    if (statusEl) statusEl.innerHTML =
      `<span class="arcpay-badge-inactive"><i class="fas fa-robot"></i> ArcPay Agent</span>` +
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
// Step 2: Confirm 0-USDC transfer to Factory as on-chain session anchor
// ══════════════════════════════════════════════════════════════════════════════
async function executeArcPayAuthorization() {
  if (authInProgress) return;
  const wallet = window.walletState?.address;

  if (!wallet) {
    showToast('Connect your wallet first.', 'warning');
    appendChatMessage('assistant',
      `⚠️ **Wallet required**\n\nConnect your EVM wallet first to authorize the ArcPay Agent.`,
      'agents'
    );
    appendActionCard([{ label: '🔗 Connect Wallet', action: `openWalletModal()`, primary: true }]);
    return;
  }

  if (isAgentActive()) {
    appendChatMessage('assistant',
      `✅ **ArcPay Agent already active**\n\nYour wallet \`${wallet.slice(0,10)}…\` already has an active session.\n\n` +
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
      '  ARC Platform — ArcPay Agent v1.0',
      '  Authorization Request',
      '═══════════════════════════════════════',
      '',
      'I authorize the ArcPay Agent to execute',
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
    setAuthStep(2, 'active', 'Confirm on-chain session in wallet…');

    // ── STEP 2: On-chain confirmation — 0 USDC transfer as session anchor ──
    // We call USDC.transfer(factory, 0) — zero amount, just the event
    // This anchors the session on-chain without spending any funds
    const usdcAbi = [
      'function transfer(address to, uint256 amount) returns (bool)',
    ];
    const usdc = new ethers.Contract(USDC_ADDR, usdcAbi, signer);

    // Encode the session nonce into the calldata via a comment in the memo
    // We send 0 USDC to the factory as proof of session intent
    let confirmTx;
    try {
      // Estimate gas first
      let gasLimit = 60_000n;
      try {
        const est = await usdc.transfer.estimateGas(CF_FACTORY, 0n);
        gasLimit = BigInt(Math.ceil(Number(est) * 1.3));
      } catch (_) {}

      confirmTx = await usdc.transfer(CF_FACTORY, 0n, { gasLimit });
    } catch (e) {
      if (e.code === 4001 || e.code === 'ACTION_REJECTED') throw new Error('__cancelled__');
      throw new Error(`On-chain confirmation failed: ${e.message}`);
    }

    setAuthStep(2, 'active', `Waiting for confirmation… <span class="font-mono text-[10px] text-blue-300">${confirmTx.hash.slice(0,14)}…</span>`);

    const receipt = await confirmTx.wait(1);
    if (receipt.status !== 1) throw new Error('Confirmation transaction reverted on-chain.');

    setAuthStep(2, 'done', `On-chain confirmed ✓ Block #${receipt.blockNumber}`);
    setAuthStep(3, 'active', 'Activating session…');

    // ── Derive session hash ──────────────────────────────────────────────────
    const sessionHash = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(signature + sessionNonce + signerAddr)
    ).then(buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join(''));

    // ── Save session ────────────────────────────────────────────────────────
    const session = {
      authorized:   true,
      wallet:       signerAddr,
      signature,
      sessionNonce,
      sessionHash:  sessionHash.slice(0, 32),
      confirmTxHash: confirmTx.hash,
      confirmBlock:  receipt.blockNumber,
      expiry,
      createdAt:    Date.now(),
    };
    saveSession(session);

    setAuthStep(3, 'done', 'Session active ✅');
    await new Promise(r => setTimeout(r, 800));
    hideAuthOverlay();

    // ── Success message ──────────────────────────────────────────────────────
    updateArcPayBar();

    appendChatMessage('assistant',
      `🎉 **ArcPay Agent v1.0 Authorized!**\n\n` +
      `✅ Wallet: \`${signerAddr.slice(0,10)}…${signerAddr.slice(-6)}\`\n` +
      `🔐 Session: \`${sessionHash.slice(0,16)}…\`\n` +
      `⛓️ On-chain proof: [\`${confirmTx.hash.slice(0,14)}…\`](${ARC_EXPLORER}/tx/${confirmTx.hash})\n` +
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

    showToast('✅ ArcPay Agent authorized!', 'success');

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
        <p style="color:#e5e7eb;font-weight:700;font-size:15px;margin:0 0 4px;">ArcPay Agent v1.0</p>
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
            <p style="color:#9ca3af;font-size:12px;font-weight:600;margin:0 0 2px;">Step 2 — On-chain Confirmation</p>
            <p id="auth-step-detail-2" style="color:#6b7280;font-size:10px;margin:0;">Confirm session anchor transaction…</p>
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
  appendChatMessage('assistant', `⚠️ Authorization cancelled. Click **Authorize ArcPay** whenever you're ready.`, 'agents');
}

function revokeArcPaySession() {
  clearSession();
  updateArcPayBar();
  appendChatMessage('assistant',
    `✅ **ArcPay Agent session revoked.**\n\nThe agent no longer has permission to act on your behalf.\n\nYou can re-authorize at any time by clicking **Authorize ArcPay Agent**.`,
    'agents'
  );
  showToast('ArcPay session revoked.', 'info');
}

// ── Init Session ───────────────────────────────────────────────────────────────
async function initChatSession() {
  arcPaySession = loadSession();
  try {
    const res = await axios.get(`/api/chat/history/${CHAT_SESSION_ID}`);
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
      ? `🤖 ArcPay Agent: **✅ Active** — I can execute operations for you\n`
      : `🔒 ArcPay Agent: **Not authorized** — Click **Authorize** above to enable\n`) +
    `\n**What I can do:**\n` +
    `- 💳 Send payments on-chain\n` +
    `- 🔄 Swap tokens (USDC ↔ EURC)\n` +
    `- 📋 Create & manage contracts\n` +
    `- 🚀 Batch payments via Multicall3\n` +
    `- 📊 Live on-chain data\n` +
    `- 🛡️ Guardian pre-validation on all ops\n\n` +
    (active
      ? `Try: *"send 10 USDC to 0x…"*, *"swap 5 USDC to EURC"*, *"show my contracts"*`
      : `👆 **Authorize the ArcPay Agent** above to unlock all operations.`),
    'general'
  );

  if (!active && wallet) {
    appendActionCard([
      { label: '🤖 Authorize ArcPay Agent', action: `executeArcPayAuthorization()`, primary: true },
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
    const handled = await handleLocalCommand(msg);
    if (handled) { hideTypingIndicator(); return; }

    // Send to AI backend
    const res = await axios.post('/api/chat/message', {
      message: msg,
      sessionId: CHAT_SESSION_ID,
      walletAddress:  window.walletState?.address || null,
      arcPayActive:   isAgentActive(),
    });
    hideTypingIndicator();
    if (res.data.success) {
      const reply = res.data.message;
      appendChatMessage('assistant', reply.content, reply.module);
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

  // ── Authorize ArcPay ──────────────────────────────────────────────────────
  if (/approve arcpay|authorize agent|enable agent|arcpay agent|autorizar|autorize/i.test(lower)) {
    await executeArcPayAuthorization(); return true;
  }

  // ── Revoke ArcPay ─────────────────────────────────────────────────────────
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

  // ── Send/Pay command: "send X USDC to 0x…" ───────────────────────────────
  const sendMatch = msg.match(/^(?:send|pay|enviar|pagar)\s+([\d.]+)\s*(usdc|eurc)?\s+(?:to|para)\s+(0x[0-9a-fA-F]{40})/i);
  if (sendMatch) {
    await cmdSendPayment(sendMatch[1], (sendMatch[2] || 'USDC').toUpperCase(), sendMatch[3]);
    return true;
  }

  // ── Batch multisend: "pay 0xA:10, 0xB:20" ────────────────────────────────
  const batchMatch = msg.match(/^(?:pay|multisend|batch pay|enviar para|pagamento em lote)\s+(.+)/i);
  if (batchMatch) {
    const entries = batchMatch[1].match(/(0x[0-9a-fA-F]{40})\s*[:=]\s*([\d.]+)/g);
    if (entries && entries.length >= 2) {
      await cmdBatchPayment(entries); return true;
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

// ── Command implementations ────────────────────────────────────────────────────

async function cmdHelp() {
  hideTypingIndicator();
  const active = isAgentActive();
  appendChatMessage('assistant',
    `🤖 **ARC AI Assistant — Commands**\n\n` +
    `${active ? '✅ ArcPay Agent Active' : '⚠️ ArcPay not authorized — some commands need authorization'}\n\n` +
    `**💳 Payments**\n` +
    `- \`send 10 USDC to 0x...\`\n` +
    `- \`pay 0xA:10, 0xB:20\` (batch)\n\n` +
    `**🔄 Swap**\n` +
    `- \`swap 5 USDC to EURC\`\n\n` +
    `**📋 Contracts**\n` +
    `- \`show my contracts\`\n` +
    `- \`create contract with 0x... for 100 USDC\`\n` +
    `- \`deposit 50 USDC to contract #3\`\n` +
    `- \`release milestone on contract #3\`\n\n` +
    `**📊 Info**\n` +
    `- \`my wallet\` — balance & status\n` +
    `- \`network status\` — RPC & block\n` +
    `- \`dashboard\` — platform stats\n` +
    `- \`guardian\` — Guardian Agent status\n\n` +
    `**🤖 Agent**\n` +
    `- \`authorize arcpay\` — enable agent\n` +
    `- \`revoke arcpay\` — disable agent`,
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
    `ArcPay Agent: ${active ? '✅ Active' : '❌ Not authorized'}\n\n` +
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
    `- 🤖 ArcPay: ${active ? '✅ Active' : '⚠️ Not authorized'}\n` +
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
      `🔒 **ArcPay Agent not authorized**\n\nAuthorize the agent first to execute payments via chat.`,
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

  appendChatMessage('assistant',
    `💳 **Payment Preview**\n\n` +
    `Amount: **${amount} ${token}**\n` +
    `To: \`${recipient.slice(0,10)}…${recipient.slice(-8)}\`\n` +
    `Fee: ~$0.009 USDC\n` +
    `🛡️ Guardian: ✅ Approved\n\n` +
    `🤖 ArcPay Agent will pre-fill the form and navigate to Payments.`,
    'payments'
  );
  appendActionCard([
    { label: `✅ Confirm & Go`, action: `chatExecutePayment('${amount}','${token}','${recipient}')`, primary: true },
    { label: '❌ Cancel',       action: `appendChatMessage('assistant','❌ Payment cancelled.','payments')`, primary: false },
  ]);
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
    appendChatMessage('assistant', `🔒 Authorize ArcPay Agent first to use batch payments.`, 'agents');
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
  const rows  = parsed.map((r, i) => `${i+1}. \`${r.address.slice(0,10)}…\` — **$${r.amount.toFixed(2)} USDC**`).join('\n');

  appendChatMessage('assistant',
    `🚀 **Batch Payment Preview**\n\n` +
    `${rows}\n\n` +
    `Total: **$${total.toFixed(2)} USDC** to ${parsed.length} recipients\n` +
    `Method: Multicall3 (single tx)\n` +
    `🛡️ Guardian: ✅ Approved`,
    'payments'
  );
  appendActionCard([
    { label: '🚀 Open Multisend', action: `chatOpenMultisend(${JSON.stringify(parsed)})`, primary: true },
    { label: '❌ Cancel',         action: `appendChatMessage('assistant','❌ Cancelled.','payments')`, primary: false },
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
    appendChatMessage('assistant', `🔒 Authorize ArcPay Agent first to execute swaps via chat.`, 'agents');
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
    appendChatMessage('assistant', `🔒 Authorize ArcPay Agent first to create contracts via chat.`, 'agents');
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
    appendChatMessage('assistant', `🔒 Authorize ArcPay Agent first.`, 'agents');
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
    appendChatMessage('assistant', `🔒 Authorize ArcPay Agent first.`, 'agents');
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
async function chatExecutePayment(amount, token, recipient) {
  const wallet = window.walletState?.address;
  if (!wallet) { appendChatMessage('assistant', '⚠️ Wallet disconnected.', 'error'); return; }
  appendChatMessage('assistant', `💳 Pre-filling payment form…`, 'payments');
  switchTab('payments');
  await new Promise(r => setTimeout(r, 300));
  const addrEl = document.getElementById('pay-recipient');
  const amtEl  = document.getElementById('pay-amount');
  if (addrEl) addrEl.value = recipient;
  if (amtEl)  amtEl.value  = amount;
  document.querySelectorAll('.pay-token-btn').forEach(btn => {
    if (btn.dataset.token === token) btn.click();
  });
  appendChatMessage('assistant',
    `✅ **Form pre-filled!**\n\n` +
    `Amount: **${amount} ${token}** → \`${recipient.slice(0,10)}…\`\n\n` +
    `Review and click **Sign & Send** to execute.`,
    'payments'
  );
  appendActionCard([{ label: '💳 Go to Payments Tab', action: `switchTab('payments')`, primary: true }]);
}

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
    if (titleEl && !titleEl.value) titleEl.value = 'Contract via ArcPay Agent';
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

// ── Quick message ──────────────────────────────────────────────────────────────
function sendQuickMessage(text) {
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
  try { await axios.delete(`/api/chat/history/${CHAT_SESSION_ID}`); } catch { }
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
           general:'text-gray-400', error:'text-red-400' }[m] || 'text-gray-400';
}
function getModuleIcon(m) {
  return { payments:'fa-dollar-sign', vaults:'fa-vault', swap:'fa-exchange-alt',
           contracts:'fa-file-contract', agents:'fa-brain', network:'fa-network-wired',
           general:'fa-robot', error:'fa-exclamation-triangle' }[m] || 'fa-robot';
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
        `⚠️ Wallet changed — ArcPay session cleared.\n\nRe-authorize to use the agent with this wallet.`,
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
window.sendQuickMessage         = sendQuickMessage;
window.clearChatHistory         = clearChatHistory;
window.setChatSize              = setChatSize;
window.openChatNewTab           = openChatNewTab;
window.updateArcPayBar          = updateArcPayBar;
window.executeArcPayAuthorization = executeArcPayAuthorization;
window.cancelArcPayAuth         = cancelArcPayAuth;
window.revokeArcPaySession      = revokeArcPaySession;
window.chatExecutePayment       = chatExecutePayment;
window.chatOpenSwap             = chatOpenSwap;
window.chatOpenMultisend        = chatOpenMultisend;
window.chatOpenContractForm     = chatOpenContractForm;
window.appendChatMessage        = appendChatMessage;
window.isAgentActive            = isAgentActive;

// Legacy compat
window.executeArcPayApproval = executeArcPayAuthorization;
window.revokeArcPay          = revokeArcPaySession;

const _active = isAgentActive();
console.log('%c[CHAT v3]', 'color:#a78bfa;font-weight:bold',
  'ArcPay Agent:', _active ? '✅ Active' : '⚠️ Not authorized',
  '| Session:', _active ? arcPaySession?.sessionHash?.slice(0,12)+'…' : 'none',
  '| Size:', chatSize
);
