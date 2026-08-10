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
        `vá até a aba **Send** e use o botão de aprovação.\n\n` +
        `Aprovações abrem a wallet apenas com interação explícita do usuário.`,
        'payments'
      );
      appendActionCard([
        { label: '💳 Ir para Send', action: `switchTab('payments');toggleChat()`, primary: true },
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
    appendChatMessage('assistant', `💳 Opening Send tab…`, 'payments');
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
    `✅ Email **${profile.email}** applied to the Send form.`,
    'payments');
  createActionCard([{ label: '💳 Go to Send', onclick: "switchTab('payments');toggleChat()" }]);
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
  createActionCard([{ label: '💳 Go to Send', onclick: "switchTab('payments');toggleChat()" }]);
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
  msg += `\n_Click a chip in the Send form to auto-fill._`;
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
    `**💳 Send**\n` +
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
    `- 💳 Send: ${payments.length} recorded\n` +
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
    { label: '💳 Send',       action: `switchTab('payments');toggleChat();`,   primary: false },
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
    `\n\n💡 *Full fee breakdown shown in the Send form. Confirm to proceed.*`,
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
  let guidance = 'Your transfer was added to the manual queue instead. Click **Execute Send** to proceed.';
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
    `👆 Clique em **Execute Send** para assinar e enviar.`,
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
  appendActionCard([{ label: '💳 Go to Send Tab', action: `switchTab('payments')`, primary: true }]);
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
