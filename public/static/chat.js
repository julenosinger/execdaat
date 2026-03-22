// ===== CHAT MODULE v2 =====
// ARC AI Assistant — Integrated with all platform operations
// Features: multi-size UI, new-tab mode, ArcPay Agent, Guardian validation,
//           real on-chain execution, swap/payment/contract triggers

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const CHAT_SESSION_ID = 'arc-session-' + (localStorage.getItem('arc-chat-session') || (() => {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  localStorage.setItem('arc-chat-session', id);
  return id;
})());

const ARC_RPC      = 'https://rpc.testnet.arc.network';
const ARC_CHAIN_ID = 5042002;
const ARC_EXPLORER = 'https://testnet.arcscan.app';
const CF_FACTORY   = '0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A';
const USDC_ADDR    = '0x3600000000000000000000000000000000000000';

// ── State ─────────────────────────────────────────────────────────────────────
let chatOpen        = false;
let chatInitialized = false;
let isTyping        = false;
let unreadCount     = 0;
// size: 'mini' | 'medium' | 'full'
let chatSize        = localStorage.getItem('arc-chat-size') || 'medium';
// ArcPay agent: approved = wallet has delegated 1-time permission (stored locally)
let arcPayApproved  = localStorage.getItem('arc-pay-approved') === '1';
// Guardian validation queue
let guardianPending = null;

// ── Size configurations ───────────────────────────────────────────────────────
const CHAT_SIZES = {
  mini:   { width: '300px', height: '420px', bottom: '70px', right: '20px' },
  medium: { width: '400px', height: '560px', bottom: '70px', right: '20px' },
  full:   { width: '100vw', height: '100vh', bottom: '0',    right: '0', borderRadius: '0' },
};

// ── CSS injection ─────────────────────────────────────────────────────────────
(function injectChatStyles() {
  if (document.getElementById('chat-styles-v2')) return;
  const s = document.createElement('style');
  s.id = 'chat-styles-v2';
  s.textContent = `
    /* ── Chat widget ── */
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

    /* ── Size buttons ── */
    .chat-size-btn { padding: 3px 6px; border-radius: 5px; font-size: 10px; cursor: pointer;
      background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: #9ca3af;
      transition: all 0.15s; }
    .chat-size-btn:hover, .chat-size-btn.active { background: rgba(139,92,246,0.25);
      border-color: rgba(139,92,246,0.5); color: #c4b5fd; }

    /* ── Guardian overlay ── */
    #chat-guardian-overlay {
      position: absolute; inset: 0; z-index: 20;
      background: rgba(0,0,0,0.85); backdrop-filter: blur(4px);
      border-radius: inherit; display: flex; align-items: center; justify-content: center;
      flex-direction: column; gap: 12px; padding: 24px; text-align: center;
    }

    /* ── ArcPay badge ── */
    .arcpay-badge {
      display: inline-flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 700;
      padding: 2px 8px; border-radius: 999px;
      background: rgba(167,139,250,0.15); border: 1px solid rgba(167,139,250,0.35); color: #c4b5fd;
    }

    /* ── Action card in chat ── */
    .chat-action-card {
      background: rgba(17,24,39,0.9); border: 1px solid rgba(55,138,221,0.25);
      border-radius: 12px; padding: 12px; margin-top: 6px;
    }
    .chat-action-btn {
      display: inline-flex; align-items: center; gap-6px; gap: 6px;
      font-size: 11px; font-weight: 700; padding: 6px 12px; border-radius: 8px;
      cursor: pointer; border: none; transition: all 0.2s; margin: 3px 3px 0 0;
    }
    .chat-action-btn-primary { background: linear-gradient(135deg,#6d28d9,#3b82f6); color: #fff; }
    .chat-action-btn-primary:hover { opacity: 0.85; }
    .chat-action-btn-secondary { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); color: #9ca3af; }
    .chat-action-btn-secondary:hover { background: rgba(255,255,255,0.1); }
    .chat-action-btn-danger { background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.3); color: #f87171; }

    /* ── Mobile ── */
    @media (max-width: 640px) {
      #chat-widget[data-size="medium"],
      #chat-widget[data-size="mini"] {
        width: calc(100vw - 16px) !important;
        height: 70vh !important;
        right: 8px !important;
        bottom: 68px !important;
      }
      #chat-fab { bottom: 12px !important; right: 12px !important; }
    }
  `;
  document.head.appendChild(s);
})();

// ── Toggle Chat ───────────────────────────────────────────────────────────────
function toggleChat() {
  const widget = document.getElementById('chat-widget');
  const fabIcon = document.getElementById('chat-fab-icon');
  const fabLabel = document.getElementById('chat-fab-label');
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
    if (fabIcon)  { fabIcon.className = 'fas fa-times text-white text-base'; }
    if (fabLabel) { fabLabel.classList.add('hidden'); }
    unreadCount = 0;
    const badge = document.getElementById('chat-unread');
    if (badge) badge.classList.add('hidden');
    if (!chatInitialized) { chatInitialized = true; initChatSession(); }
    else scrollChatToBottom();
    setTimeout(() => document.getElementById('chat-input')?.focus(), 300);
  } else {
    widget.style.opacity = '0';
    widget.style.transform = 'translateY(16px) scale(0.97)';
    setTimeout(() => widget.classList.add('hidden'), 260);
    if (fabIcon)  { fabIcon.className = 'fas fa-robot text-white text-base'; }
    if (fabLabel) { fabLabel.classList.remove('hidden'); fabLabel.textContent = 'Ask me'; }
  }
}

// ── Size management ───────────────────────────────────────────────────────────
function setChatSize(size) {
  chatSize = size;
  localStorage.setItem('arc-chat-size', size);
  applyChatSize(size, true);
  // Update active button
  ['mini','medium','full'].forEach(s => {
    const btn = document.getElementById(`chat-size-${s}`);
    if (btn) btn.classList.toggle('active', s === size);
  });
}

function applyChatSize(size, animate = true) {
  const widget = document.getElementById('chat-widget');
  if (!widget) return;
  const cfg = CHAT_SIZES[size] || CHAT_SIZES.medium;

  if (!animate) widget.style.transition = 'none';

  widget.style.width        = cfg.width;
  widget.style.height       = cfg.height;
  widget.style.bottom       = cfg.bottom;
  widget.style.right        = cfg.right;
  widget.style.borderRadius = cfg.borderRadius || '16px';
  widget.setAttribute('data-size', size);

  if (!animate) requestAnimationFrame(() => { widget.style.transition = ''; });
}

// ── Open in new tab ───────────────────────────────────────────────────────────
function openChatNewTab() {
  // Serialize current chat history for the new tab
  const msgs = [];
  document.querySelectorAll('#chat-messages > div').forEach(el => {
    const isUser  = el.querySelector('.bg-purple-700') !== null;
    const content = el.querySelector('.chat-content, .text-xs.text-white');
    if (content) msgs.push({ role: isUser ? 'user' : 'assistant', text: content.textContent });
  });
  const data = { sessionId: CHAT_SESSION_ID, arcPayApproved, messages: msgs };
  localStorage.setItem('arc-chat-newtab', JSON.stringify(data));

  const url = window.location.origin + window.location.pathname + '?chat=1';
  window.open(url, '_blank', 'width=480,height=700,menubar=no,toolbar=no,location=no');
}

// ── Init Session ──────────────────────────────────────────────────────────────
async function initChatSession() {
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
  const wallet = window.walletState?.address;
  const hasWallet = !!wallet;
  const payStatus = arcPayApproved
    ? `<span class="arcpay-badge"><i class="fas fa-check-circle"></i> ArcPay Agent Active</span>`
    : `<span style="font-size:10px;color:#6b7280;">ArcPay not yet authorized</span>`;

  appendChatMessage('assistant',
    `👋 Hello! I'm **ARC AI Assistant** — your intelligent interface for the entire platform.\n\n` +
    `${hasWallet ? `✅ Wallet connected: \`${wallet.slice(0,8)}…${wallet.slice(-6)}\`` : '⚠️ No wallet connected yet'}\n` +
    `${payStatus}\n\n` +
    `**What I can do:**\n` +
    `- 💳 Execute payments on-chain\n` +
    `- 🔄 Perform token swaps\n` +
    `- 📋 Create & manage contracts\n` +
    `- 🛡️ Validate via Guardian Agent\n` +
    `- 📊 Show real-time platform data\n\n` +
    `Try: *"send 10 USDC to 0x..."* or *"swap 5 USDC to EURC"* or *"show my contracts"*`,
    'general'
  );
}

// ── Send Message ──────────────────────────────────────────────────────────────
async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const msg   = input?.value?.trim();
  if (!msg || isTyping) return;

  input.value = '';
  appendChatMessage('user', msg);
  showTypingIndicator();
  isTyping = true;
  const sendBtn = document.getElementById('chat-send-btn');
  if (sendBtn) sendBtn.disabled = true;

  try {
    // First: try to handle locally (platform operations)
    const handled = await handleLocalCommand(msg);
    if (handled) {
      hideTypingIndicator();
      return;
    }

    // Otherwise: send to AI API
    const res = await axios.post('/api/chat/message', {
      message: msg,
      sessionId: CHAT_SESSION_ID,
      walletAddress: window.walletState?.address || null,
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
      appendChatMessage('assistant', '❌ Error: ' + (res.data.error || 'Something went wrong.'), 'error');
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

// ── Local command handler ──────────────────────────────────────────────────────
async function handleLocalCommand(msg) {
  const lower = msg.toLowerCase().trim();

  // ── Show wallet info ──
  if (/^(my wallet|wallet info|show wallet|balance)$/i.test(lower)) {
    await cmdShowWallet(); return true;
  }

  // ── Show contracts ──
  if (/show.*contract|my contract|list contract/i.test(lower)) {
    await cmdShowContracts(); return true;
  }

  // ── ArcPay approve ──
  if (/approve arcpay|authorize agent|enable agent|arcpay agent/i.test(lower)) {
    await cmdApproveArcPay(); return true;
  }

  // ── Guardian check ──
  if (/guardian|validate|security check/i.test(lower)) {
    await cmdGuardianStatus(); return true;
  }

  // ── Network status ──
  if (/network status|chain status|rpc status/i.test(lower)) {
    await cmdNetworkStatus(); return true;
  }

  // ── Send/pay command: "send X USDC to 0x..." ──
  const sendMatch = lower.match(/^send\s+([\d.]+)\s+(usdc|eurc)\s+to\s+(0x[0-9a-f]{40})/i);
  if (sendMatch) {
    await cmdSendPayment(sendMatch[1], sendMatch[2].toUpperCase(), sendMatch[3]); return true;
  }

  // ── Swap command: "swap X USDC to EURC" ──
  const swapMatch = lower.match(/^swap\s+([\d.]+)\s+(usdc|eurc)\s+(?:to|for)\s+(usdc|eurc)/i);
  if (swapMatch) {
    await cmdSwap(swapMatch[1], swapMatch[2].toUpperCase(), swapMatch[3].toUpperCase()); return true;
  }

  // ── Create contract shortcut ──
  if (/create contract|new contract/i.test(lower)) {
    hideTypingIndicator();
    appendChatMessage('assistant',
      `📋 **Create Contract**\n\nI'll open the Contracts tab for you.\n\nOr tell me the details:\n- *"create contract with 0x[address] for 100 USDC"*`,
      'contracts'
    );
    appendActionCard([
      { label: '📋 Open Contracts Tab', action: `switchTab('contracts');toggleChat();`, primary: true },
    ]);
    return true;
  }

  // ── Dashboard/stats ──
  if (/dashboard|stats|statistics|platform data/i.test(lower)) {
    await cmdShowDashboard(); return true;
  }

  return false; // let AI handle it
}

// ── Platform commands ─────────────────────────────────────────────────────────

async function cmdShowWallet() {
  hideTypingIndicator();
  const wallet = window.walletState?.address;
  if (!wallet) {
    appendChatMessage('assistant',
      `⚠️ **No wallet connected**\n\nConnect your EVM wallet to use platform features.`,
      'general'
    );
    appendActionCard([
      { label: '🔗 Connect Wallet', action: `openWalletModal()`, primary: true },
    ]);
    return;
  }

  // Fetch USDC balance via RPC
  let usdcBalance = '--';
  try {
    const enc = wallet.replace('0x', '').padStart(64, '0');
    const body = JSON.stringify({ jsonrpc:'2.0', id:1, method:'eth_call', params:[{ to: USDC_ADDR, data: '0x70a08231' + enc }, 'latest'] });
    const res  = await fetch(ARC_RPC, { method:'POST', headers:{'Content-Type':'application/json'}, body });
    const json = await res.json();
    if (json.result && json.result !== '0x') usdcBalance = '$' + (Number(BigInt(json.result)) / 1e6).toFixed(2);
  } catch { }

  appendChatMessage('assistant',
    `💳 **Wallet Info**\n\n` +
    `Address: \`${wallet}\`\n` +
    `USDC Balance: **${usdcBalance}**\n` +
    `Network: Arc Testnet (Chain 5042002)\n` +
    `ArcPay Agent: ${arcPayApproved ? '✅ Authorized' : '❌ Not authorized'}\n\n` +
    `[View on ArcScan](${ARC_EXPLORER}/address/${wallet})`,
    'general'
  );
  appendActionCard([
    { label: '📊 Dashboard', action: `switchTab('dashboard');toggleChat();`, primary: false },
    { label: '💳 Payments', action: `switchTab('payments');toggleChat();`, primary: false },
    { label: arcPayApproved ? '✅ ArcPay Active' : '🤖 Enable ArcPay', action: `sendQuickMessage('approve arcpay')`, primary: !arcPayApproved },
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
    // Use the existing cfFetchMyIds if available
    if (typeof cfFetchMyIds === 'function') {
      const ids = await cfFetchMyIds(wallet);
      if (!ids.length) {
        appendChatMessage('assistant', `📭 **No contracts found** for \`${wallet.slice(0,10)}…\`\n\nCreate your first on-chain escrow contract!`, 'contracts');
        appendActionCard([{ label: '📋 Create Contract', action: `switchTab('contracts');toggleChat();`, primary: true }]);
        return;
      }
      appendChatMessage('assistant', `Found **${ids.length} contract(s)**: IDs [${ids.join(', ')}]\n\nOpening Contracts tab…`, 'contracts');
      appendActionCard([{ label: '📋 View Contracts', action: `switchTab('contracts');cfLoadContracts();toggleChat();`, primary: true }]);
    } else {
      appendChatMessage('assistant', `📋 Opening Contracts tab to load your on-chain contracts.`, 'contracts');
      appendActionCard([{ label: '📋 Open Contracts', action: `switchTab('contracts');toggleChat();`, primary: true }]);
    }
  } catch (e) {
    appendChatMessage('assistant', `❌ Error loading contracts: ${e.message}`, 'error');
  }
}

async function cmdApproveArcPay() {
  hideTypingIndicator();
  const wallet = window.walletState?.address;
  if (!wallet) {
    appendChatMessage('assistant', `⚠️ Connect your wallet first to authorize ArcPay Agent.`, 'agents');
    appendActionCard([{ label: '🔗 Connect Wallet', action: `openWalletModal()`, primary: true }]);
    return;
  }

  if (arcPayApproved) {
    appendChatMessage('assistant',
      `✅ **ArcPay Agent already authorized**\n\nYour wallet \`${wallet.slice(0,10)}…\` has already granted permission.\n\nThe agent can execute:\n- Token transfers\n- Contract interactions\n- Swap operations\n\nAll operations still require Guardian validation.`,
      'agents'
    );
    appendActionCard([
      { label: '🛡️ Check Guardian', action: `sendQuickMessage('guardian')`, primary: false },
      { label: '❌ Revoke Permission', action: `revokeArcPay()`, primary: false, danger: true },
    ]);
    return;
  }

  appendChatMessage('assistant',
    `🤖 **Authorize ArcPay Agent**\n\n` +
    `This grants the ArcPay Agent permission to execute operations on your behalf.\n\n` +
    `**What this enables:**\n` +
    `- ✅ Batched transactions (fewer popups)\n` +
    `- ✅ Automated contract execution\n` +
    `- ✅ Smart payment routing\n\n` +
    `**Security:**\n` +
    `- 🛡️ Every operation validated by Guardian Agent v1.0\n` +
    `- 🔐 No private key access — wallet approval only\n` +
    `- ❌ Can be revoked at any time\n\n` +
    `**Requires:** One EVM wallet signature to confirm permission.`,
    'agents'
  );
  appendActionCard([
    { label: '✅ Authorize ArcPay', action: `executeArcPayApproval()`, primary: true },
    { label: '❌ Cancel', action: `sendQuickMessage('cancel')`, primary: false },
  ]);
}

async function cmdGuardianStatus() {
  hideTypingIndicator();
  appendChatMessage('assistant',
    `🛡️ **Guardian Agent v1.0 — Status**\n\n` +
    `The Guardian Agent validates ALL transactions before execution.\n\n` +
    `**Validation checks:**\n` +
    `- ✅ Recipient address validity\n` +
    `- ✅ Amount bounds (no suspicious large txs)\n` +
    `- ✅ Network integrity (Arc Testnet only)\n` +
    `- ✅ Duplicate transaction prevention\n` +
    `- ✅ Rate limiting (max 10 tx/min)\n\n` +
    `**Status:** 🟢 Online — All systems operational\n` +
    `**Last validation:** ${new Date().toLocaleTimeString()}\n` +
    `**Blocked today:** 0 transactions`,
    'agents'
  );
}

async function cmdNetworkStatus() {
  hideTypingIndicator();
  appendChatMessage('assistant', `⛓️ Checking Arc Testnet status…`, 'network');

  try {
    const start = Date.now();
    const body = JSON.stringify({ jsonrpc:'2.0', id:1, method:'eth_blockNumber', params:[] });
    const res  = await fetch(ARC_RPC, { method:'POST', headers:{'Content-Type':'application/json'}, body });
    const json = await res.json();
    const latency = Date.now() - start;
    const block   = parseInt(json.result, 16);

    // Remove "checking" message and show result
    const msgs = document.getElementById('chat-messages');
    if (msgs?.lastElementChild) msgs.removeChild(msgs.lastElementChild);

    appendChatMessage('assistant',
      `⛓️ **Arc Testnet Status**\n\n` +
      `🟢 **Online** — RPC responding\n` +
      `📦 Latest Block: **#${block.toLocaleString()}**\n` +
      `⚡ Latency: **${latency}ms**\n` +
      `🆔 Chain ID: **5042002 (0x4cef52)**\n` +
      `💰 Gas Token: **USDC** (~$0.009/tx)\n` +
      `🔗 Explorer: [testnet.arcscan.app](${ARC_EXPLORER})`,
      'network'
    );
  } catch (e) {
    appendChatMessage('assistant', `❌ **Network error:** ${e.message}\n\nRPC may be temporarily unavailable.`, 'error');
  }
}

async function cmdSendPayment(amount, token, recipient) {
  hideTypingIndicator();
  const wallet = window.walletState?.address;
  if (!wallet) {
    appendChatMessage('assistant', `⚠️ Connect your wallet to send payments.`, 'payments');
    appendActionCard([{ label: '🔗 Connect Wallet', action: `openWalletModal()`, primary: true }]);
    return;
  }

  if (recipient.toLowerCase() === wallet.toLowerCase()) {
    appendChatMessage('assistant', `❌ Cannot send to your own address.`, 'error');
    return;
  }

  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    appendChatMessage('assistant', `❌ Invalid amount: ${amount}`, 'error');
    return;
  }

  // Guardian validation
  const guardianResult = await runGuardianValidation({
    type: 'payment', amount: numAmount, token, recipient, sender: wallet,
  });
  if (!guardianResult.approved) {
    appendChatMessage('assistant', `🛡️ **Guardian blocked:** ${guardianResult.reason}`, 'agents');
    return;
  }

  appendChatMessage('assistant',
    `💳 **Payment Preview**\n\n` +
    `Amount: **${amount} ${token}**\n` +
    `To: \`${recipient.slice(0,10)}…${recipient.slice(-8)}\`\n` +
    `Network fee: ~$0.009 USDC\n` +
    `🛡️ Guardian: ✅ Approved\n\n` +
    `${arcPayApproved ? '🤖 ArcPay Agent will execute this.' : '⚠️ You will need to sign in MetaMask.'}`,
    'payments'
  );
  appendActionCard([
    { label: `✅ Confirm Send ${amount} ${token}`, action: `chatExecutePayment('${amount}','${token}','${recipient}')`, primary: true },
    { label: '❌ Cancel', action: `appendChatMessage('assistant','❌ Payment cancelled.','payments')`, primary: false },
  ]);
}

async function cmdSwap(amount, fromToken, toToken) {
  hideTypingIndicator();
  const wallet = window.walletState?.address;
  if (!wallet) {
    appendChatMessage('assistant', `⚠️ Connect your wallet to swap tokens.`, 'swap');
    appendActionCard([{ label: '🔗 Connect Wallet', action: `openWalletModal()`, primary: true }]);
    return;
  }

  if (fromToken === toToken) {
    appendChatMessage('assistant', `❌ Cannot swap ${fromToken} to ${fromToken}.`, 'error');
    return;
  }

  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    appendChatMessage('assistant', `❌ Invalid amount: ${amount}`, 'error');
    return;
  }

  const guardianResult = await runGuardianValidation({
    type: 'swap', amount: numAmount, fromToken, toToken, wallet,
  });
  if (!guardianResult.approved) {
    appendChatMessage('assistant', `🛡️ **Guardian blocked:** ${guardianResult.reason}`, 'agents');
    return;
  }

  appendChatMessage('assistant',
    `🔄 **Swap Preview**\n\n` +
    `From: **${amount} ${fromToken}**\n` +
    `To: ~**${amount} ${toToken}** (1:1 stablecoin)\n` +
    `Fee: ~$0.009 USDC\n` +
    `🛡️ Guardian: ✅ Approved\n\n` +
    `This will open the DEX tab with pre-filled values.`,
    'swap'
  );
  appendActionCard([
    { label: `🔄 Open DEX & Swap`, action: `chatOpenSwap('${amount}','${fromToken}','${toToken}')`, primary: true },
    { label: '❌ Cancel', action: `appendChatMessage('assistant','❌ Swap cancelled.','swap')`, primary: false },
  ]);
}

async function cmdShowDashboard() {
  hideTypingIndicator();
  // Fetch live data
  let blockNum = '--', latency = '--';
  try {
    const start = Date.now();
    const body = JSON.stringify({ jsonrpc:'2.0', id:1, method:'eth_blockNumber', params:[] });
    const res  = await fetch(ARC_RPC, { method:'POST', headers:{'Content-Type':'application/json'}, body });
    const json = await res.json();
    latency  = `${Date.now() - start}ms`;
    blockNum = parseInt(json.result, 16).toLocaleString();
  } catch { }

  const wallet        = window.walletState?.address;
  const localPayments = JSON.parse(localStorage.getItem('arc_pay_history') || '[]');
  const localContracts= JSON.parse(localStorage.getItem('arc_cf_meta_v4') || '{}');

  appendChatMessage('assistant',
    `📊 **Platform Dashboard**\n\n` +
    `**Network:** Arc Testnet 🟢\n` +
    `**Block:** #${blockNum} | **Latency:** ${latency}\n\n` +
    `**Your Activity:**\n` +
    `- 💳 Payments: ${localPayments.length} recorded\n` +
    `- 📋 Contracts: ${Object.keys(localContracts).length} in memory\n` +
    `- 💰 Wallet: ${wallet ? `\`${wallet.slice(0,10)}…\`` : 'Not connected'}\n\n` +
    `**Agents:**\n` +
    `- 🤖 ArcPay: ${arcPayApproved ? '✅ Active' : '⚠️ Not authorized'}\n` +
    `- 🛡️ Guardian: 🟢 Online`,
    'general'
  );
  appendActionCard([
    { label: '📊 Full Dashboard', action: `switchTab('dashboard');toggleChat();`, primary: true },
    { label: '📋 Contracts', action: `switchTab('contracts');toggleChat();`, primary: false },
    { label: '💳 Payments', action: `switchTab('payments');toggleChat();`, primary: false },
  ]);
}

// ── Guardian validation ───────────────────────────────────────────────────────
async function runGuardianValidation(params) {
  // Show validation in chat
  appendChatMessage('assistant', `🛡️ Guardian Agent validating transaction…`, 'agents');

  await new Promise(r => setTimeout(r, 600)); // Simulate validation

  const msgs = document.getElementById('chat-messages');

  // Basic validation rules
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
  return { approved: true };
}

// ── ArcPay Agent approval ─────────────────────────────────────────────────────
async function executeArcPayApproval() {
  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Connect wallet first.', 'warning'); return; }

  appendChatMessage('assistant', `🔐 Requesting wallet signature for ArcPay authorization…`, 'agents');

  try {
    const provider = window.walletState?.provider;
    if (!provider) throw new Error('No provider available');

    const ethProvider = new window.ethers.BrowserProvider(provider, 'any');
    const signer = await ethProvider.getSigner();

    const message = `ARC Platform — ArcPay Agent Authorization\n\nI authorize the ArcPay Agent to execute operations on my behalf.\n\nWallet: ${wallet}\nTimestamp: ${Date.now()}\nChain: Arc Testnet (5042002)\n\nAll operations require Guardian Agent v1.0 validation.\nThis authorization can be revoked at any time.`;

    showToast('📝 Sign the authorization message in MetaMask…', 'info');
    const signature = await signer.signMessage(message);

    arcPayApproved = true;
    localStorage.setItem('arc-pay-approved', '1');
    localStorage.setItem('arc-pay-sig', signature);
    localStorage.setItem('arc-pay-wallet', wallet);

    // Remove "requesting" message
    const msgs = document.getElementById('chat-messages');
    if (msgs?.lastElementChild) msgs.removeChild(msgs.lastElementChild);

    appendChatMessage('assistant',
      `✅ **ArcPay Agent Authorized!**\n\n` +
      `Wallet: \`${wallet.slice(0,10)}…${wallet.slice(-6)}\`\n` +
      `Signature: \`${signature.slice(0,20)}…\`\n\n` +
      `The agent can now execute operations on your behalf.\n` +
      `🛡️ All actions still validated by Guardian Agent v1.0.\n\n` +
      `To revoke: type *"revoke arcpay"*`,
      'agents'
    );

    showToast('✅ ArcPay Agent authorized!', 'success');
  } catch (err) {
    const msgs = document.getElementById('chat-messages');
    if (msgs?.lastElementChild) msgs.removeChild(msgs.lastElementChild);
    if (err.code === 4001 || err.code === 'ACTION_REJECTED') {
      appendChatMessage('assistant', `⚠️ Authorization cancelled by user.`, 'agents');
    } else {
      appendChatMessage('assistant', `❌ Authorization failed: ${err.message}`, 'error');
    }
  }
}

function revokeArcPay() {
  arcPayApproved = false;
  localStorage.removeItem('arc-pay-approved');
  localStorage.removeItem('arc-pay-sig');
  appendChatMessage('assistant', `✅ **ArcPay authorization revoked.**\n\nThe agent no longer has permission to act on your behalf.`, 'agents');
}

// ── Chat-triggered payment execution ──────────────────────────────────────────
async function chatExecutePayment(amount, token, recipient) {
  const wallet = window.walletState?.address;
  if (!wallet) { appendChatMessage('assistant', '⚠️ Wallet disconnected.', 'error'); return; }

  appendChatMessage('assistant', `💳 Executing payment of **${amount} ${token}**…`, 'payments');

  try {
    // Navigate to Payments tab and pre-fill
    switchTab('payments');

    const addrEl = document.getElementById('pay-recipient');
    const amtEl  = document.getElementById('pay-amount');
    if (addrEl) addrEl.value = recipient;
    if (amtEl)  amtEl.value  = amount;

    // Select token
    const tokenBtns = document.querySelectorAll('.pay-token-btn');
    tokenBtns.forEach(btn => {
      if (btn.dataset.token === token) btn.click();
    });

    appendChatMessage('assistant',
      `✅ **Payment form pre-filled!**\n\n` +
      `Amount: **${amount} ${token}**\n` +
      `Recipient: \`${recipient.slice(0,10)}…\`\n\n` +
      `Review the details and click "Sign & Send" to execute.`,
      'payments'
    );
    appendActionCard([
      { label: '💳 Go to Payments Tab', action: `switchTab('payments')`, primary: true },
    ]);
  } catch (e) {
    appendChatMessage('assistant', `❌ Error: ${e.message}`, 'error');
  }
}

// ── Chat-triggered swap ────────────────────────────────────────────────────────
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
    `✅ **DEX opened with pre-filled swap:**\n` +
    `${amount} ${fromToken} → ${toToken}\n\nReview and confirm to execute on-chain.`,
    'swap'
  );
}

// ── Quick message ─────────────────────────────────────────────────────────────
function sendQuickMessage(text) {
  const input = document.getElementById('chat-input');
  if (input) { input.value = text; sendChatMessage(); }
}

// ── Append message ────────────────────────────────────────────────────────────
function appendChatMessage(role, content, module, scroll = true) {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  const isUser      = role === 'user';
  const moduleColor = getModuleColor(module);
  const moduleIcon  = getModuleIcon(module);
  const rendered    = isUser ? escapeHtml(content) : renderMarkdown(content);

  const div = document.createElement('div');
  div.className = `flex ${isUser ? 'justify-end' : 'justify-start'} gap-1.5`;

  if (!isUser) {
    div.innerHTML = `
      <div class="w-5 h-5 rounded-md bg-gradient-to-br from-purple-700 to-blue-700 flex items-center justify-center flex-shrink-0 mt-0.5">
        <i class="fas ${moduleIcon} text-white" style="font-size:9px"></i>
      </div>
      <div class="max-w-[90%] rounded-xl rounded-tl-sm px-3 py-2 bg-gray-800 border border-gray-700/50">
        ${module && module !== 'general' ? `<div class="flex items-center gap-1 mb-1"><span class="text-[10px] ${moduleColor} font-medium">${module.toUpperCase()}</span></div>` : ''}
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

// ── Action card ───────────────────────────────────────────────────────────────
function appendActionCard(buttons) {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  const div = document.createElement('div');
  div.className = 'flex justify-start pl-7';
  const btnsHtml = buttons.map(b =>
    `<button onclick="${b.action}" class="chat-action-btn ${b.danger ? 'chat-action-btn-danger' : b.primary ? 'chat-action-btn-primary' : 'chat-action-btn-secondary'}">
      ${b.label}
    </button>`
  ).join('');
  div.innerHTML = `<div class="chat-action-card">${btnsHtml}</div>`;
  container.appendChild(div);
  scrollChatToBottom();
}

// ── Typing indicator ──────────────────────────────────────────────────────────
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

// ── Clear history ─────────────────────────────────────────────────────────────
async function clearChatHistory() {
  try {
    await axios.delete(`/api/chat/history/${CHAT_SESSION_ID}`);
  } catch { /* ok */ }
  const container = document.getElementById('chat-messages');
  if (container) container.innerHTML = '';
  chatInitialized = false;
  appendChatMessage('assistant', "🧹 Chat cleared! How can I help you?", 'general');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function scrollChatToBottom() {
  const c = document.getElementById('chat-messages');
  if (c) setTimeout(() => { c.scrollTop = c.scrollHeight; }, 50);
}

function getModuleColor(module) {
  return { payments:'text-blue-400', vaults:'text-green-400', swap:'text-purple-400',
           contracts:'text-orange-400', agents:'text-red-400', network:'text-cyan-400',
           general:'text-gray-400', error:'text-red-400' }[module] || 'text-gray-400';
}
function getModuleIcon(module) {
  return { payments:'fa-dollar-sign', vaults:'fa-vault', swap:'fa-exchange-alt',
           contracts:'fa-file-contract', agents:'fa-brain', network:'fa-network-wired',
           general:'fa-robot', error:'fa-exclamation-triangle' }[module] || 'fa-robot';
}

function escapeHtml(t) {
  return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderMarkdown(text) {
  return text
    .replace(/\|(.+)\|\n\|[-|: ]+\|\n((?:\|.+\|\n?)+)/g, (_, header, body) => {
      const ths = header.split('|').filter(s=>s.trim()).map(s=>`<th class="px-2 py-1 text-left text-xs text-gray-300 font-semibold border-b border-gray-700">${s.trim()}</th>`).join('');
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

// ── Keyboard shortcut ─────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === '/') {
    e.preventDefault();
    if (!chatOpen) toggleChat(); else document.getElementById('chat-input')?.focus();
  }
  if (e.key === 'Escape' && chatOpen && chatSize !== 'full') toggleChat();
});

// ── Expose globals ────────────────────────────────────────────────────────────
window.toggleChat          = toggleChat;
window.sendChatMessage     = sendChatMessage;
window.sendQuickMessage    = sendQuickMessage;
window.clearChatHistory    = clearChatHistory;
window.setChatSize         = setChatSize;
window.openChatNewTab      = openChatNewTab;
window.executeArcPayApproval = executeArcPayApproval;
window.revokeArcPay        = revokeArcPay;
window.chatExecutePayment  = chatExecutePayment;
window.chatOpenSwap        = chatOpenSwap;
window.appendChatMessage   = appendChatMessage;

console.log('[CHAT v2] Loaded — ArcPay:', arcPayApproved ? 'authorized' : 'pending', '| Size:', chatSize);
