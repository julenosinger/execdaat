// ============================================================
// CHAT-BRIDGE.JS — Unified message handler v20260404i
// Shared logic between Main Chat and Autonoma Tab chatbots.
//
// ARCHITECTURE:
//   • Both chatbots call window.handleUnifiedMessage(msg, source)
//   • source: 'main' | 'autonoma'
//   • All responses use the active UI context (patched by caller)
//   • Debug logs: [CHAT SOURCE] and [RESPONSE SENT]
//
// GUARANTEES:
//   1. Identical command parsing for both chatbots
//   2. Every action produces visible UI output
//   3. Permit creation triggers visible confirmation
//   4. Intent creation → status tracking → async update
//   5. agentMetaTx:message and agentExecutor:update → chat messages
//   6. Single source of truth: backend DB + localStorage
// ============================================================
'use strict';

(function () {

  const BRIDGE_VERSION = '20260404i';
  const AE_EXPLORER    = 'https://testnet.arcscan.app';

  // ─────────────────────────────────────────────────────────────────────────────
  // HELPERS — route output to the active context
  // _msg() and _card() delegate to whatever appendChatMessage / appendActionCard
  // is currently active (either main chat or autonoma, via context patch).
  // ─────────────────────────────────────────────────────────────────────────────
  function _msg(role, content, module) {
    if (typeof window.appendChatMessage === 'function') {
      window.appendChatMessage(role, content, module);
    }
  }
  function _card(buttons) {
    if (typeof window.appendActionCard === 'function') {
      window.appendActionCard(buttons);
    }
  }
  function _hideTyping() {
    if (typeof window.hideTypingIndicator === 'function') window.hideTypingIndicator();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // STANDARD RESPONSE PIPELINE
  // Every action returns { status, message, next } so both chatbots behave
  // identically regardless of execution path.
  // ─────────────────────────────────────────────────────────────────────────────
  function _accepted(note) {
    return { status: 'success', message: 'Agent accepted your request', next: 'processing', note };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PERMIT CONFIRMATION — broadcasts to both chatbot contexts
  // Called after a permit is created from either chat.
  // ─────────────────────────────────────────────────────────────────────────────
  function _notifyPermitCreated(permit) {
    const token  = permit.token  || 'USDC';
    const amount = permit.amount || '?';
    const expMin = permit.expiry ? Math.round((permit.expiry - Date.now()) / 60000) : '?';
    const id     = permit.id    ? permit.id.slice(0, 16) + '…' : '—';

    _msg('assistant',
      `✅ **Authorization permit created!**\n\n` +
      `| Field | Value |\n|---|---|\n` +
      `| Token | **${token}** |\n` +
      `| Authorized amount | **${amount} ${token}** |\n` +
      `| Duration | ${expMin} min |\n` +
      `| Permit ID | \`${id}\` |\n\n` +
      `🤖 *Agent can now execute transfers autonomously — no more wallet pop-ups.*`,
      'permit2'
    );
    _card([
      { label: '⚡ Send now', action: `autonomaSendChat && autonomaSendChat('send now') || sendQuickMessage('send now')`, primary: true },
      { label: '📋 Show intents', action: `autonomaSendChat && autonomaSendChat('show my intents') || sendQuickMessage('show my intents')`, primary: false },
    ]);

    // Dispatch so both panels refresh
    window.dispatchEvent(new CustomEvent('permit2Updated', { detail: permit }));
    console.log(`[RESPONSE SENT] permit_created id=${permit.id} token=${token} amount=${amount}`);
  }
  window.bridgeNotifyPermitCreated = _notifyPermitCreated;

  // ─────────────────────────────────────────────────────────────────────────────
  // INTENT STATUS UPDATER — listens to agentExecutor:update and agentMetaTx:message
  // Routes status messages to the active chat context when autonomaActive,
  // otherwise to the main chat.
  // ─────────────────────────────────────────────────────────────────────────────
  const _intentMsgShown = new Set(); // prevent duplicate status messages

  function _onAgentExecutorUpdate(evt) {
    const d = evt?.detail;
    if (!d) return;
    const key = `${d.intentId || d.id}:${d.status}`;
    if (_intentMsgShown.has(key)) return;
    _intentMsgShown.add(key);

    // Pick the right output function
    const isAutonoma = (typeof autonomaActive !== 'undefined' && window._autonomaActive) ||
                       !!document.getElementById('autonoma-chat-messages')?.children?.length;

    const addMsg = isAutonoma && typeof window.autonomaAppendMessage === 'function'
      ? (r, c, m) => window.autonomaAppendMessage(r, c, m)
      : _msg;

    switch (d.status) {
      case 'processing':
        addMsg('assistant', `⚙️ **Processing** intent \`${(d.intentId||'').slice(0,16)}…\` — relayer executing…`, 'intents');
        break;
      case 'signing':
        addMsg('assistant', `✍️ **Signing** — building meta-transaction…`, 'intents');
        break;
      case 'broadcast':
        addMsg('assistant',
          `📤 **Broadcast!** TX sent to Arc Testnet.\n\n` +
          (d.txHash ? `🔗 [View on Explorer](${AE_EXPLORER}/tx/${d.txHash})` : ''),
          'intents');
        break;
      case 'completed':
        addMsg('assistant',
          `✅ **Transfer completed!**\n\n` +
          (d.txHash ? `🔗 [TX ${d.txHash.slice(0,12)}…](${AE_EXPLORER}/tx/${d.txHash})` : '') +
          (d.blockNumber ? ` · Block #${d.blockNumber}` : ''),
          'payments');
        break;
      case 'failed':
        addMsg('assistant',
          `❌ **Transfer failed** — ${d.error || 'Unknown error'}\n\nCheck your balance and try again.`,
          'error');
        break;
    }
    console.log(`[RESPONSE SENT] agent_update intentId=${d.intentId||d.id} status=${d.status}`);
  }

  function _onAgentMetaTxMessage(evt) {
    const d = evt?.detail;
    if (!d?.message) return;

    const isAutonoma = !!document.getElementById('autonoma-chat-messages')?.children?.length;
    const addMsg = isAutonoma && typeof window.autonomaAppendMessage === 'function'
      ? (r, c, m) => window.autonomaAppendMessage(r, c, m)
      : _msg;

    const module = d.type === 'error' ? 'error' : (d.type === 'success' ? 'payments' : 'intents');
    addMsg('assistant', d.message, module);
    console.log(`[RESPONSE SENT] meta_tx_message type=${d.type} msg=${d.message.slice(0,60)}`);
  }

  window.addEventListener('agentExecutor:update',  _onAgentExecutorUpdate);
  window.addEventListener('agentMetaTx:message',   _onAgentMetaTxMessage);

  // ─────────────────────────────────────────────────────────────────────────────
  // UNIFIED AGENT TRANSFER — creates an intent and shows live status in EITHER chat
  // Replaces the bare _chatAgentTransfer call so autonoma also shows proper feedback
  // ─────────────────────────────────────────────────────────────────────────────
  async function unifiedAgentTransfer(amount, token, recipient, source) {
    const tokenStr = (token || 'USDC').toUpperCase();
    console.log(`[CHAT SOURCE] unifiedAgentTransfer source=${source} amount=${amount} token=${tokenStr}`);

    // Permit context hint
    let permitInfo = '';
    try {
      const wallet = window.walletState?.address;
      const raw    = localStorage.getItem('arc_permit2_allowances_v1');
      if (raw && wallet) {
        const now   = Date.now();
        const activ = JSON.parse(raw).filter(p =>
          p.wallet?.toLowerCase() === wallet.toLowerCase() &&
          p.expiry > now && (p.amount - (p.amountUsed || 0)) > 0 &&
          p.token?.toUpperCase() === tokenStr
        );
        if (activ.length > 0) {
          const rem = (activ[0].amount - (activ[0].amountUsed || 0)).toFixed(2);
          const exp = Math.round((activ[0].expiry - now) / 60000);
          permitInfo = `\n\n🔐 *Permit active: ${rem} ${tokenStr} remaining (${exp}m)*`;
        } else {
          permitInfo = `\n\n⚡ *No permit — wallet popup will appear to sign*`;
        }
      }
    } catch {}

    _msg('assistant',
      `🧠 **Intent accepted** — queuing transfer\n\n` +
      `**${amount} ${tokenStr}** → \`${recipient.slice(0,10)}…${recipient.slice(-8)}\`\n\n` +
      `⏳ *Submitting to Agent Executor…*${permitInfo}`,
      'payments'
    );

    try {
      const intent = await AgentExecutor.queueTransfer(
        String(amount), tokenStr, recipient, `via chat (${source})`
      );

      _msg('assistant',
        `✅ **Intent queued — Agent Executor processing**\n\n` +
        `| | |\n|---|---|\n` +
        `| Token | **${intent.token}** |\n` +
        `| Amount | **${intent.amount} ${intent.token}** |\n` +
        `| To | \`${recipient.slice(0,10)}…${recipient.slice(-8)}\` |\n` +
        `| Status | ${AgentExecutor.statusBadge ? AgentExecutor.statusBadge(intent.id, 'pending') : '⏳ pending'} |\n` +
        `| ID | \`${intent.id.slice(0,20)}…\` |\n\n` +
        (permitInfo.includes('Permit active')
          ? `🤖 *Executing autonomously — relayer will broadcast.*`
          : `⚡ *Wallet popup will appear to sign the transfer.*`),
        'payments'
      );

      console.log(`[RESPONSE SENT] intent_queued id=${intent.id} source=${source}`);

      // Refresh autonoma panel if visible
      if (typeof window.autonomaRefreshIntents === 'function') {
        setTimeout(window.autonomaRefreshIntents, 800);
      }

    } catch (err) {
      console.error('[CHAT-BRIDGE] unifiedAgentTransfer error:', err);
      _msg('assistant',
        `⚠️ **Agent issue:** ${err.message}\n\nTransfer added to manual queue instead. Click **Execute Payments** to proceed.`,
        'error'
      );
      // Fall back to queue
      window.dispatchEvent(new CustomEvent('arcPayQueue:add', {
        detail: { type: 'transfer', token: tokenStr, amount: parseFloat(amount), recipient }
      }));
    }
  }
  window.unifiedAgentTransfer = unifiedAgentTransfer;

  // ─────────────────────────────────────────────────────────────────────────────
  // UNIFIED AGENT MULTISEND — creates a batch intent for EITHER chat
  // ─────────────────────────────────────────────────────────────────────────────
  async function unifiedAgentMultisend(parsed, token, source) {
    const tokenStr = (token || 'USDC').toUpperCase();
    console.log(`[CHAT SOURCE] unifiedAgentMultisend source=${source} count=${parsed.length} token=${tokenStr}`);

    const total    = parsed.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
    const sample   = parsed.slice(0,3).map((r,i) =>
      `${i+1}. \`${r.address.slice(0,10)}…\` — **${parseFloat(r.amount).toFixed(2)} ${tokenStr}**`
    ).join('\n');
    const moreNote = parsed.length > 3 ? `\n…and ${parsed.length - 3} more recipients` : '';

    _msg('assistant',
      `🧠 **Batch intent accepted**\n\n${sample}${moreNote}\n\n` +
      `**Total: ${total.toFixed(2)} ${tokenStr}** to **${parsed.length} recipients**\n\n` +
      `⏳ *Submitting to Agent Executor…*`,
      'batch'
    );

    try {
      const intent = await AgentExecutor.queueMultisend(parsed, tokenStr, `batch via chat (${source})`);

      _msg('assistant',
        `✅ **Batch intent queued — Agent Executor processing**\n\n` +
        `| | |\n|---|---|\n` +
        `| Token | **${tokenStr}** |\n` +
        `| Total | **${total.toFixed(2)} ${tokenStr}** |\n` +
        `| Recipients | **${parsed.length}** |\n` +
        `| Status | ⏳ pending |\n` +
        `| ID | \`${intent.id.slice(0,20)}…\` |\n\n` +
        `🤖 *Relayer will process the batch automatically.*`,
        'batch'
      );

      console.log(`[RESPONSE SENT] batch_intent_queued id=${intent.id} source=${source}`);

      if (typeof window.autonomaRefreshIntents === 'function') {
        setTimeout(window.autonomaRefreshIntents, 800);
      }

    } catch (err) {
      console.error('[CHAT-BRIDGE] unifiedAgentMultisend error:', err);
      _msg('assistant',
        `⚠️ **Batch agent issue:** ${err.message}\n\nBatch added to manual queue. Click **Execute Payments** to proceed.`,
        'error'
      );
      window.dispatchEvent(new CustomEvent('arcPayQueue:addBatch', {
        detail: { type: 'batch', token: tokenStr, recipients: parsed }
      }));
    }
  }
  window.unifiedAgentMultisend = unifiedAgentMultisend;

  // ─────────────────────────────────────────────────────────────────────────────
  // UNIFIED MESSAGE HANDLER
  // Both chatbots call this AFTER patching appendChatMessage/appendActionCard.
  // Returns true if handled locally, false to fall through to AI backend.
  //
  // source: 'main' | 'autonoma'
  // ─────────────────────────────────────────────────────────────────────────────
  async function handleUnifiedMessage(msg, source) {
    source = source || 'main';
    const lower = msg.toLowerCase().trim();

    console.log(`[CHAT SOURCE] handleUnifiedMessage source=${source} msg="${msg.slice(0,80)}"`);

    // ── 1. Intent-specific commands (autonoma specialties, also available in main) ──
    if (/show.*intent|my intent|list.*intent/i.test(lower)) {
      _hideTyping();
      await _cmdShowIntents(source);
      return true;
    }
    if (/cancel.*pending|cancel all intent/i.test(lower)) {
      _hideTyping();
      await _cmdCancelPending(source);
      return true;
    }
    if (/agent.*status|executor.*status|status.*agent/i.test(lower)) {
      _hideTyping();
      _cmdAgentStatus(source);
      return true;
    }
    if (/deploy.*contract|deploy.*agent/i.test(lower)) {
      _hideTyping();
      _cmdDeployInfo(source);
      return true;
    }

    // ── 2. Permit2 intent handler ─────────────────────────────────────────────
    if (typeof window.handlePermitIntent === 'function') {
      const p2handled = await window.handlePermitIntent(msg);
      if (p2handled) {
        console.log(`[RESPONSE SENT] permit2_intent source=${source}`);
        return true;
      }
    }

    // ── 3. Standard local commands (from chat.js) ─────────────────────────────
    if (typeof window.handleLocalCommand === 'function') {
      // Override action card payloads to use unified functions when called from autonoma
      if (source === 'autonoma') {
        _patchActionCards(source);
      }
      const handled = await window.handleLocalCommand(msg);
      if (source === 'autonoma') _unpatchActionCards();
      if (handled) {
        console.log(`[RESPONSE SENT] local_cmd source=${source} msg="${lower.slice(0,40)}"`);
        return true;
      }
    }

    // ── 4. CSV extended handler ────────────────────────────────────────────────
    if (typeof window.handleLocalCommandWithCSV === 'function') {
      const csvHandled = await window.handleLocalCommandWithCSV(msg);
      if (csvHandled) {
        console.log(`[RESPONSE SENT] csv_cmd source=${source}`);
        return true;
      }
    }

    return false; // Fall through to AI backend
  }
  window.handleUnifiedMessage = handleUnifiedMessage;

  // ─────────────────────────────────────────────────────────────────────────────
  // ACTION CARD PATCH — when called from autonoma, override agent transfer actions
  // so they route to unifiedAgentTransfer instead of _chatAgentTransfer.
  // This ensures the output always goes to the currently active chat container.
  // ─────────────────────────────────────────────────────────────────────────────
  let _origChatAgentTransfer  = null;
  let _origChatAgentBatch     = null;

  function _patchActionCards(source) {
    // Patch _chatAgentTransfer to use unified version
    _origChatAgentTransfer = window._chatAgentTransfer;
    window._chatAgentTransfer = function(amount, token, recipient) {
      return unifiedAgentTransfer(amount, token, recipient, source);
    };

    // If AgentExecutor batch inline call is used, route through unified
    if (window.AgentExecutor) {
      _origChatAgentBatch = window._chatAgentBatch;
      window._chatAgentBatch = function(parsed, token) {
        return unifiedAgentMultisend(parsed, token, source);
      };
    }
  }

  function _unpatchActionCards() {
    if (_origChatAgentTransfer !== null) {
      window._chatAgentTransfer = _origChatAgentTransfer;
      _origChatAgentTransfer = null;
    }
    if (_origChatAgentBatch !== null) {
      window._chatAgentBatch = _origChatAgentBatch;
      _origChatAgentBatch = null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SHARED COMMAND IMPLEMENTATIONS
  // ─────────────────────────────────────────────────────────────────────────────

  async function _cmdShowIntents(source) {
    const wallet = window.walletState?.address;
    if (!wallet) {
      _msg('assistant', '⚠️ Connect your wallet to view intents.', 'error');
      _card([{ label: '🔗 Connect Wallet', action: 'openWalletModal()', primary: true }]);
      console.log(`[RESPONSE SENT] show_intents_no_wallet source=${source}`);
      return;
    }
    try {
      let intents = [];
      if (window.AgentExecutor) {
        intents = await AgentExecutor.getIntents();
      } else {
        const r = await fetch(`/api/agent/intents?wallet=${encodeURIComponent(wallet)}&limit=20`);
        const d = await r.json();
        intents = d.success ? d.intents : [];
      }

      if (intents.length === 0) {
        _msg('assistant',
          '📋 **No intents found.**\n\nCreate one by saying:\n`send 10 USDC to 0x…`',
          'intents');
        console.log(`[RESPONSE SENT] show_intents_empty source=${source}`);
        return;
      }

      const statusEmoji = { pending:'⏳', processing:'⚙️', signing:'✍️', broadcast:'📤', completed:'✅', failed:'❌', cancelled:'🚫' };
      const lines = intents.slice(0, 10).map(i => {
        const emoji = statusEmoji[i.status] || '❓';
        const tx    = i.txHash ? ` · [TX](${AE_EXPLORER}/tx/${i.txHash})` : '';
        const amt   = i.amount ? ` ${i.amount} ${i.token || ''}` : '';
        return `${emoji} \`${i.id.slice(0,16)}…\` **${i.type}**${amt} — **${i.status}**${tx}`;
      }).join('\n');

      _msg('assistant',
        `📋 **Your intents (${intents.length} total)**\n\n${lines}`,
        'intents');

      // Refresh panel if in autonoma
      if (typeof window.autonomaRefreshIntents === 'function') setTimeout(window.autonomaRefreshIntents, 300);
      console.log(`[RESPONSE SENT] show_intents count=${intents.length} source=${source}`);
    } catch (e) {
      _msg('assistant', '❌ Error fetching intents: ' + e.message, 'error');
    }
  }

  async function _cmdCancelPending(source) {
    const wallet = window.walletState?.address;
    if (!wallet) {
      _msg('assistant', '⚠️ Connect your wallet first.', 'error');
      return;
    }
    try {
      const r = await fetch(`/api/agent/intents?wallet=${encodeURIComponent(wallet)}&status=pending`);
      const d = await r.json();
      const pending = d.success ? d.intents : [];

      if (pending.length === 0) {
        _msg('assistant', '✅ No pending intents to cancel.', 'intents');
        return;
      }

      let cancelled = 0;
      for (const i of pending) {
        const res = await fetch(`/api/agent/intents/${i.id}`, { method: 'DELETE' });
        const rd  = await res.json();
        if (rd.success) cancelled++;
      }

      _msg('assistant', `🗑️ **${cancelled} intent(s) cancelled** out of ${pending.length} pending.`, 'intents');
      if (typeof window.autonomaRefreshIntents === 'function') setTimeout(window.autonomaRefreshIntents, 300);
      console.log(`[RESPONSE SENT] cancel_pending cancelled=${cancelled} source=${source}`);
    } catch (e) {
      _msg('assistant', '❌ Error: ' + e.message, 'error');
    }
  }

  function _cmdAgentStatus(source) {
    const active   = typeof window.isAgentActive === 'function' ? window.isAgentActive() : false;
    const wallet   = window.walletState?.address;
    const polling  = window.AgentExecutor ? (window._aePollTimer ? 'active' : 'stopped') : 'N/A';
    const metaTx   = window.AgentExecutor?.getMetaTxStatus?.() || null;

    let permitInfo = 'No active permits';
    try {
      const raw = localStorage.getItem('arc_permit2_allowances_v1');
      if (raw && wallet) {
        const now = Date.now();
        const activ = JSON.parse(raw).filter(p =>
          p.wallet?.toLowerCase() === wallet.toLowerCase() &&
          p.expiry > now && (p.amount - (p.amountUsed || 0)) > 0
        );
        if (activ.length > 0) {
          permitInfo = activ.map(p => {
            const rem = (p.amount - (p.amountUsed || 0)).toFixed(2);
            const exp = Math.round((p.expiry - Date.now()) / 60000);
            return `${rem} ${p.token} (${exp}m remaining)`;
          }).join(' · ');
        }
      }
    } catch {}

    const metaTxRow = metaTx
      ? `| Gasless Mode | ${metaTx.contractDeployed ? '✅ Active — relayer pays gas' : '⚠️ Contract not deployed'} |\n`
      : '';

    _msg('assistant',
      `🤖 **Agent Status — ${source === 'autonoma' ? 'Autonoma' : 'Main Chat'}**\n\n` +
      `| Field | Value |\n|---|---|\n` +
      `| Daat Agent | ${active ? '✅ Authorized' : '⚠️ Not authorized'} |\n` +
      `| Wallet | ${wallet ? `\`${wallet.slice(0,10)}…\`` : '—'} |\n` +
      `| Poll | ${polling} |\n` +
      `| Permits | ${permitInfo} |\n` +
      metaTxRow +
      `| Version | ${window.AgentExecutor?.version || 'N/A'} |\n` +
      `| Bridge | v${BRIDGE_VERSION} |`,
      'agents');
    console.log(`[RESPONSE SENT] agent_status source=${source} active=${active}`);
  }

  function _cmdDeployInfo(source) {
    _msg('assistant',
      `🤖 **Deploy AgentExecutor — Meta-Transaction Engine**\n\n` +
      `To activate full gasless mode, deploy **AgentExecutor.sol** on Arc Testnet.\n\n` +
      `**Option 1 — Deploy via MetaMask:**\n` +
      `👉 [Open Deploy Page](/static/deploy-agent.html)\n\n` +
      `**Option 2 — Deploy via CLI:**\n` +
      `\`\`\`bash\ncd /home/user/deploy-agent\nDEPLOY_PK=0xYOUR_KEY node deploy-with-pk.mjs\n\`\`\`\n\n` +
      `**After deploy:**\n` +
      `• Save contract address: \`localStorage.setItem('ae_contract_addr','0x...')\`\n` +
      `• Set \`RELAYER_PRIVATE_KEY\` in Cloudflare secrets\n` +
      `• Fund relayer: \`0xFAd3edb1aAe40C16cd30987fCEc3C3d68aEb7F45\`\n\n` +
      `*Test USDC: [faucet.circle.com](https://faucet.circle.com)*`,
      'agents'
    );
    console.log(`[RESPONSE SENT] deploy_info source=${source}`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PERMIT2 HOOK — intercept _confirmPermitFromChat to emit bridgeNotifyPermitCreated
  // Works for BOTH chatbots.
  // ─────────────────────────────────────────────────────────────────────────────
  function _installPermitHook() {
    const orig = window._confirmPermitFromChat;
    if (!orig || orig._bridgeHooked) return;

    window._confirmPermitFromChat = async function() {
      const result = await orig.apply(this, arguments);
      // After permit is created, the existing code appends messages via appendChatMessage
      // which is already patched to go to the active container.
      // Additionally, dispatch the unified permit notification.
      try {
        const raw = localStorage.getItem('arc_permit2_allowances_v1');
        const wallet = window.walletState?.address;
        if (raw && wallet) {
          const now = Date.now();
          const permits = JSON.parse(raw).filter(p =>
            p.wallet?.toLowerCase() === wallet.toLowerCase() &&
            p.expiry > now && (p.amount - (p.amountUsed || 0)) > 0
          );
          if (permits.length > 0) {
            const latest = permits[permits.length - 1];
            // Dispatch event so autonoma panel refreshes
            window.dispatchEvent(new CustomEvent('permit2Updated', { detail: latest }));
            console.log(`[RESPONSE SENT] permit_hook id=${latest.id} token=${latest.token}`);
          }
        }
      } catch {}
      return result;
    };
    window._confirmPermitFromChat._bridgeHooked = true;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // ARCPAY AUTHORIZATION HOOK — notify both chatbots on success
  // ─────────────────────────────────────────────────────────────────────────────
  function _installAuthHook() {
    // We listen for the saveSession call by watching localStorage
    const _origSaveSession = window.saveSession;
    if (_origSaveSession && !_origSaveSession._bridgeHooked) {
      window.saveSession = function(session) {
        const result = _origSaveSession.apply(this, arguments);
        // Dispatch event so both chatbots can show confirmation
        window.dispatchEvent(new CustomEvent('arcPayAuthorized', { detail: session }));
        console.log(`[RESPONSE SENT] arcpay_authorized wallet=${session?.wallet?.slice(0,10)}`);
        return result;
      };
      window.saveSession._bridgeHooked = true;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // ARCPAY AUTHORIZED EVENT → show confirmation in autonoma chat
  // ─────────────────────────────────────────────────────────────────────────────
  window.addEventListener('arcPayAuthorized', (evt) => {
    const session = evt?.detail;
    if (!session?.wallet) return;

    // Only show in autonoma container when it's active
    if (typeof window.autonomaAppendMessage !== 'function') return;
    if (!document.getElementById('autonoma-chat-messages')) return;

    // Avoid duplicate messages
    const key = `arcPayAuthorized:${session.wallet}:${session.sessionNonce || ''}`;
    if (_intentMsgShown.has(key)) return;
    _intentMsgShown.add(key);

    const w = session.wallet;
    window.autonomaAppendMessage('assistant',
      `✅ **Daat Agent authorized!**\n\n` +
      `Wallet: \`${w.slice(0,10)}…${w.slice(-6)}\`\n` +
      `Session expires: ${new Date(session.expiry).toLocaleTimeString()}\n\n` +
      `🤖 *You can now create intents and the agent will execute them automatically.*\n` +
      `Try: *"allow agent to spend 100 USDC"* or *"send 10 USDC to 0x…"*`,
      'agents'
    );
    console.log(`[RESPONSE SENT] arcpay_authorized_autonoma_msg wallet=${w.slice(0,10)}`);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // INIT
  // ─────────────────────────────────────────────────────────────────────────────
  function _init() {
    _installPermitHook();
    _installAuthHook();

    // Expose unified transfer/batch globally so action card buttons can call them
    window._chatAgentTransferUnified = function(amount, token, recipient) {
      return unifiedAgentTransfer(amount, token, recipient, 'action_card');
    };
    window._chatAgentBatchUnified = function(parsed, token) {
      return unifiedAgentMultisend(parsed, token, 'action_card');
    };

    console.log(`[CHAT-BRIDGE] Loaded v${BRIDGE_VERSION} — unified handler active`);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }

})();
