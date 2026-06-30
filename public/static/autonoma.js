// build:v2-20260627-151358
// ============================================================
// AUTONOMA.JS — Subpage /agents/autonoma
// Build: 20260404l
//
// ARCHITECTURE: Identical pipeline to main chatbot.
//
// KEY FIX v20260404l:
//   • Context patch is now PERMANENT while autonoma tab is active.
//     appendChatMessage / appendActionCard always route to autonoma DOM.
//     This means button callbacks (_confirmPermitFromChat, _chatAgentTransfer,
//     etc.) also write to the correct container even after sendMessage returns.
//   • No more ref-count / _withCtx dance: patch on autonomaInit, unpatch on
//     autonomaDestroy. Simple and race-condition free.
//   • handleUnifiedMessage called WITHOUT extra _patchCtx (already active).
//   • hideTypingIndicator always called via try/finally.
//   • Full response guaranteed: every path ends with a visible chat message.
//   • Fallback logging: warns if execution fires without producing output.
// ============================================================
'use strict';

(function() {

  // ── State ─────────────────────────────────────────────────────────────────────
  let autonomaActive  = false;
  let autonomaTyping  = false;
  let autonomaMsgs    = [];
  let _autonomaPollTimer = null;

  // ── Context registry ── keeps original helpers to restore on destroy ──────────
  const _orig = {};
  let   _ctxInstalled = false;

  // ── Markdown / escape helpers ─────────────────────────────────────────────────
  function _renderMd(text) {
    if (typeof renderMarkdown === 'function') return renderMarkdown(text);
    return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Append message to Autonoma chat ─────────────────────────────────────────
  function autonomaAppendMessage(role, content, module) {
    const container = document.getElementById('autonoma-chat-messages');
    if (!container) return;

    const isUser   = role === 'user';
    const rendered = isUser ? _esc(content) : _renderMd(content);

    const modColors = {
      payments:'text-green-400', swap:'text-blue-400', contracts:'text-orange-400',
      agents:'text-purple-400', permit2:'text-yellow-400', error:'text-red-400',
      general:'text-gray-400', intents:'text-purple-400', csv:'text-purple-300',
      batch:'text-indigo-400',
    };
    const modIcons = {
      payments:'fa-dollar-sign', swap:'fa-exchange-alt', contracts:'fa-file-contract',
      agents:'fa-robot', permit2:'fa-key', error:'fa-exclamation-circle',
      general:'fa-comment', intents:'fa-bolt', csv:'fa-file-csv', batch:'fa-layer-group',
    };
    const modColor = modColors[module] || 'text-gray-400';
    const modIcon  = modIcons[module]  || 'fa-comment';

    const div = document.createElement('div');
    div.className = `flex ${isUser ? 'justify-end' : 'justify-start'} gap-1.5`;

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
    container.scrollTop = container.scrollHeight;
    autonomaMsgs.push({ role, content, module, ts: Date.now() });
  }
  window.autonomaAppendMessage = autonomaAppendMessage;

  // ── Append action card to Autonoma chat ──────────────────────────────────────
  function autonomaAppendActionCard(buttons) {
    const container = document.getElementById('autonoma-chat-messages');
    if (!container) return;
    const div = document.createElement('div');
    div.className = 'flex justify-start pl-7';
    const btnsHtml = buttons.map(b =>
      `<button onclick="${b.action}"
        class="chat-action-btn ${b.danger ? 'chat-action-btn-danger' : b.success ? 'chat-action-btn-success' : b.primary ? 'chat-action-btn-primary' : 'chat-action-btn-secondary'}">
        ${b.label}
      </button>`
    ).join('');
    div.innerHTML = `<div class="chat-action-card">${btnsHtml}</div>`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  // ── Typing indicator ──────────────────────────────────────────────────────────
  function autonomaShowTyping() {
    const container = document.getElementById('autonoma-chat-messages');
    if (!container || document.getElementById('autonoma-typing')) return;
    const div = document.createElement('div');
    div.id = 'autonoma-typing';
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
    container.scrollTop = container.scrollHeight;
  }
  function autonomaHideTyping() {
    document.getElementById('autonoma-typing')?.remove();
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // PERMANENT CONTEXT PATCH
  // Installed on autonomaInit(), removed on autonomaDestroy().
  // Because it's permanent while the tab is active, ALL calls to
  // appendChatMessage / appendActionCard — including button callbacks
  // (_confirmPermitFromChat, _chatAgentTransfer, etc.) — always write
  // to the autonoma container. No ref-counting, no race conditions.
  // ══════════════════════════════════════════════════════════════════════════════
  function _installCtx() {
    if (_ctxInstalled) return;
    _orig.appendChatMessage   = window.appendChatMessage;
    _orig.appendActionCard    = window.appendActionCard;
    _orig.hideTypingIndicator = window.hideTypingIndicator;
    _orig.showTypingIndicator = window.showTypingIndicator;

    window.appendChatMessage   = autonomaAppendMessage;
    window.appendActionCard    = autonomaAppendActionCard;
    window.hideTypingIndicator = autonomaHideTyping;
    window.showTypingIndicator = autonomaShowTyping;

    _ctxInstalled = true;
    console.log('[Autonoma] Context installed — all chat output → autonoma container');
  }

  function _removeCtx() {
    if (!_ctxInstalled) return;
    window.appendChatMessage   = _orig.appendChatMessage;
    window.appendActionCard    = _orig.appendActionCard;
    window.hideTypingIndicator = _orig.hideTypingIndicator;
    window.showTypingIndicator = _orig.showTypingIndicator;
    _ctxInstalled = false;
    console.log('[Autonoma] Context removed — chat output restored to main chatbot');
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // SEND MESSAGE — identical pipeline to main chatbot's sendChatMessage()
  // Uses the same handleUnifiedMessage, same permit2 handlers, same AI fallback.
  // Context is already installed, so all helpers write to autonoma container.
  // ══════════════════════════════════════════════════════════════════════════════
  window.autonomaSendMessage = async function() {
    const input = document.getElementById('autonoma-chat-input');
    const msg   = input?.value?.trim();
    if (!msg || autonomaTyping) return;

    input.value = '';
    autonomaTyping = true;

    const sendBtn = document.getElementById('autonoma-send-btn');
    if (sendBtn) sendBtn.disabled = true;

    // Append user message (direct call — no need to go through patched helper)
    autonomaAppendMessage('user', msg);
    autonomaShowTyping();

    // Mark autonoma as active context for bridge routing
    window._autonomaActive = true;

    console.log(`[CHAT SOURCE] autonoma input="${msg.slice(0,80)}"`);

    try {
      let localHandled = false;

      // ── Unified handler (shared with main chat via chat-bridge.js) ─────────
      // Context is already patched → output goes to autonoma automatically.
      if (typeof window.handleUnifiedMessage === 'function') {
        localHandled = await window.handleUnifiedMessage(msg, 'autonoma');
      } else {
        // Graceful fallback if bridge not loaded
        localHandled = await _handleAutonomaIntentCommand(msg);
        if (!localHandled && typeof handlePermitIntent === 'function') {
          localHandled = await handlePermitIntent(msg);
        }
        if (!localHandled && typeof handleLocalCommand === 'function') {
          localHandled = await handleLocalCommand(msg);
        }
        if (!localHandled && typeof handleLocalCommandWithCSV === 'function') {
          localHandled = await handleLocalCommandWithCSV(msg);
        }
      }

      // Always hide typing after local handlers (they each call hideTypingIndicator
      // themselves, but a guard here prevents spinner from sticking on edge cases)
      autonomaHideTyping();

      if (localHandled) {
        // Verify output was produced — silent execution guard
        const container = document.getElementById('autonoma-chat-messages');
        const lastMsg   = container?.lastElementChild;
        const hasOutput = lastMsg && !lastMsg.id?.includes('typing');
        if (!hasOutput) {
          console.warn('[AUTONOMA] localHandled=true but no message was appended. Possible silent execution.');
        }
        console.log(`[RESPONSE SENT] local_cmd_handled source=autonoma msg="${msg.slice(0,40)}"`);
        return; // done
      }

      // ── Remote AI fallback (identical to main chat, context='autonoma') ────
      const CHAT_SESSION_KEY = 'arc-chat-session';
      const sessionId = 'arc-session-' + (localStorage.getItem(CHAT_SESSION_KEY) || (() => {
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        localStorage.setItem(CHAT_SESSION_KEY, id);
        return id;
      })());

      const payload = {
        message:       msg,
        sessionId,
        walletAddress: window.walletState?.address || null,
        arcPayActive:  typeof isAgentActive === 'function' ? isAgentActive() : false,
        context:       'autonoma',
      };

      console.log(`[CHAT SOURCE] autonoma→AI fallback sessionId=${sessionId.slice(0,20)}`);

      const r = await fetch('/api/chat/message', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      });

      if (!r.ok) throw new Error(`POST /api/chat/message failed: ${r.status}`);
      const res = await r.json();

      if (res.success) {
        const reply = res.message;
        autonomaAppendMessage('assistant', reply.content, reply.module);
        console.log(`[RESPONSE SENT] ai_reply source=autonoma module=${reply.module}`);

        const action = res.action || reply.action;
        if (action && action.type && action.type !== 'none') {
          // Use the shared renderBlockchainActionCard which is now context-aware.
          // It checks window._autonomaActive and routes to autonoma-chat-messages.
          // Fall back to _autonomaRenderActionCard if chat.js not loaded.
          if (typeof window.renderBlockchainActionCard === 'function') {
            window.renderBlockchainActionCard(action, res.walletConnected);
          } else {
            _autonomaRenderActionCard(action, res.walletConnected);
          }
        }
      } else {
        autonomaAppendMessage('assistant', '❌ ' + (res.error || 'Something went wrong.'), 'error');
        console.warn('[AUTONOMA] AI returned error:', res.error);
      }

    } catch (err) {
      autonomaHideTyping();
      console.error('[AUTONOMA] sendMessage error:', err);
      autonomaAppendMessage('assistant', '❌ Error: ' + (err.message || 'Please try again.'), 'error');
    } finally {
      autonomaTyping = false;
      if (sendBtn) sendBtn.disabled = false;
      input?.focus();
      window._autonomaActive = autonomaActive;
      // Refresh all status panels after any interaction
      setTimeout(() => {
        _updateAutonomaAgentStatus();
        _updateAutonomaPermitStatus();
        _autonomaUpdateCsvBanner();
        if (typeof window.autonomaRefreshIntents === 'function') window.autonomaRefreshIntents();
      }, 600);
    }
  };

  // ── Handle intent-specific commands (fallback only — bridge handles these now) ──
  async function _handleAutonomaIntentCommand(msg) {
    const lower = msg.toLowerCase().trim();

    if (/show.*intent|my intent|list.*intent/i.test(lower)) {
      autonomaHideTyping();
      await _autonomaShowIntents();
      return true;
    }
    if (/cancel.*pending|cancel all intent/i.test(lower)) {
      autonomaHideTyping();
      await _autonomaCancelPending();
      return true;
    }
    if (/agent.*status|executor.*status|status.*agent/i.test(lower)) {
      autonomaHideTyping();
      _autonomaAgentStatus();
      return true;
    }
    if (/deploy.*contract|deploy.*agent|contrato.*deploy|fazer.*deploy/i.test(lower)) {
      autonomaHideTyping();
      _handleDeployAction();
      return true;
    }
    return false;
  }

  async function _autonomaShowIntents() {
    const wallet = window.walletState?.address;
    if (!wallet) {
      autonomaAppendMessage('assistant', '⚠️ Connect your wallet to view intents.', 'error');
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
        autonomaAppendMessage('assistant',
          '📋 **No intents found.**\n\nCreate one by asking:\n`send 10 USDC to 0x…`',
          'intents');
        return;
      }

      const explorer = 'https://testnet.arcscan.app';
      const statusEmoji = { pending:'⏳', processing:'⚙️', signing:'✍️', broadcast:'📤', completed:'✅', failed:'❌', cancelled:'🚫' };
      const lines = intents.slice(0, 10).map(i => {
        const emoji = statusEmoji[i.status] || '❓';
        const tx = i.txHash ? ` · [TX](${explorer}/tx/${i.txHash})` : '';
        const amt = i.amount ? ` ${i.amount} ${i.token}` : '';
        return `${emoji} \`${i.id.slice(0,16)}…\` **${i.type}**${amt} — **${i.status}**${tx}`;
      }).join('\n');

      autonomaAppendMessage('assistant',
        `📋 **Your intents (${intents.length} total)**\n\n${lines}`,
        'intents');

      setTimeout(autonomaRefreshIntentsPanel, 300);
    } catch (e) {
      autonomaAppendMessage('assistant', '❌ Error fetching intents: ' + e.message, 'error');
    }
  }

  async function _autonomaCancelPending() {
    const wallet = window.walletState?.address;
    if (!wallet) {
      autonomaAppendMessage('assistant', '⚠️ Connect your wallet first.', 'error');
      return;
    }
    try {
      const r = await fetch(`/api/agent/intents?wallet=${encodeURIComponent(wallet)}&status=pending`);
      const d = await r.json();
      const pending = d.success ? d.intents : [];

      if (pending.length === 0) {
        autonomaAppendMessage('assistant', '✅ No pending intents to cancel.', 'intents');
        return;
      }

      let cancelled = 0;
      for (const i of pending) {
        const res = await fetch(`/api/agent/intents/${i.id}`, { method: 'DELETE' });
        const rd = await res.json();
        if (rd.success) cancelled++;
      }

      autonomaAppendMessage('assistant',
        `🗑️ **${cancelled} intent(s) cancelled** out of ${pending.length} pending.`,
        'intents');
      setTimeout(autonomaRefreshIntentsPanel, 300);
    } catch (e) {
      autonomaAppendMessage('assistant', '❌ Error: ' + e.message, 'error');
    }
  }

  function _autonomaAgentStatus() {
    const active  = typeof isAgentActive === 'function' ? isAgentActive() : false;
    const wallet  = window.walletState?.address;
    const polling = window.AgentExecutor ? (window._aePollTimer ? 'active' : 'stopped') : 'N/A';

    let permitInfo = 'No active permits';
    try {
      const raw = localStorage.getItem('arc_permit2_allowances_v1');
      if (raw && wallet) {
        const now = Date.now();
        const activ = JSON.parse(raw).filter(p =>
          p.wallet && p.wallet.toLowerCase() === wallet.toLowerCase() &&
          p.expiry > now && (p.amount - (p.amountUsed || 0)) > 0
        );
        if (activ.length > 0) {
          permitInfo = activ.map(p => {
            const rem = (p.amount - (p.amountUsed || 0)).toFixed(2);
            const exp = Math.round((p.expiry - now) / 60000);
            return `${rem} ${p.token} (${exp}m remaining)`;
          }).join(' · ');
        }
      }
    } catch {}

    const metaTx = window.AgentExecutor?.getMetaTxStatus?.() || null;
    let metaTxRow = '';
    if (metaTx) {
      const modeLabel = metaTx.contractDeployed
        ? '✅ Mode A — gasless (AgentExecutor)'
        : metaTx.relayerConfigured
          ? `🔄 Mode B — direct relay (${metaTx.relayerAddress?.slice(0,10)}…)`
          : '⚠️ Relay not configured';
      metaTxRow = `| Relay Mode | ${modeLabel} |\n`;
    }

    autonomaAppendMessage('assistant',
      `🤖 **Agent Executor Status**\n\n` +
      `| Field | Value |\n|---|---|\n` +
      `| Daat Agent | ${active ? '✅ Authorized' : '⚠️ Not authorized'} |\n` +
      `| Wallet | ${wallet ? `\`${wallet.slice(0,10)}…\`` : '—'} |\n` +
      `| Poll | ${polling} |\n` +
      `| Permits | ${permitInfo} |\n` +
      metaTxRow +
      `| Version | ${window.AgentExecutor?.version || 'N/A'} |`,
      'agents');
  }

  // ── Meta-tx status line for welcome message ───────────────────────────────────
  function _metaTxStatusLine() {
    try {
      const status = window.AgentExecutor?.getMetaTxStatus?.();
      const contractAddr = (function() {
        try { return localStorage.getItem('ae_contract_addr'); } catch { return null; }
      })();
      const isDeployed =
        (status?.contractDeployed) ||
        (contractAddr && contractAddr !== '0x0000000000000000000000000000000000000000');

      if (isDeployed) {
        const addr  = contractAddr || status?.contractAddr || '';
        const short = addr ? ` (\`${addr.slice(0,6)}…${addr.slice(-4)}\`)` : '';
        return `🚀 **Gasless mode active**${short} — relayer pays all gas\n` +
               `*Sign once per intent — no TX popup, no gas cost.*\n\n`;
      }

      const relayerConfigured = status?.relayerConfigured;
      if (relayerConfigured) {
        return `🔄 **Direct relay mode** — AgentExecutor contract not deployed yet.\n` +
               `*Relayer executes via \`transferFrom\` — one-time approval needed.*\n` +
               `For full gasless mode: [Deploy AgentExecutor ↗](/static/deploy-agent)\n\n`;
      }

      return `🔧 **Relay not configured** — [Deploy AgentExecutor ↗](/static/deploy-agent)\n` +
             `*Set RELAYER_PRIVATE_KEY to enable automatic execution.*\n\n`;
    } catch { return ''; }
  }

  // ── Deploy contract action ────────────────────────────────────────────────────
  function _handleDeployAction() {
    autonomaAppendMessage('user', 'deploy contract', 'user');
    autonomaAppendMessage('assistant',
      `🤖 **Deploy AgentExecutor — Meta-Transaction Engine**\n\n` +
      `To activate full gasless mode, deploy **AgentExecutor.sol** on Arc Testnet.\n\n` +
      `**Option 1 — Deploy via MetaMask (recommended):**\n` +
      `👉 [Open Deploy Page](/static/deploy-agent.html)\n\n` +
      `**Option 2 — Deploy via CLI:**\n` +
      `\`\`\`bash\ncd /home/user/deploy-agent\nDEPLOY_PK=0xYOUR_KEY node deploy-with-pk.mjs\n\`\`\`\n\n` +
      `**After deploy:**\n` +
      `• Save address: \`localStorage.setItem('ae_contract_addr', '0x...')\`\n` +
      `• Set \`RELAYER_PRIVATE_KEY\` in Cloudflare secrets\n` +
      `• Fund relayer: \`0xFAd3edb1aAe40C16cd30987fCEc3C3d68aEb7F45\`\n\n` +
      `*Test USDC: [faucet.circle.com](https://faucet.circle.com)*`,
      'agents'
    );
  }

  // ── sendChat helper (used by permit status button + action cards) ─────────────
  window.autonomaSendChat = function(text) {
    const input = document.getElementById('autonoma-chat-input');
    if (input) {
      input.value = text;
      autonomaSendMessage();
    }
  };

  // ── Clear chat ────────────────────────────────────────────────────────────────
  window.autonomaClearChat = function() {
    const container = document.getElementById('autonoma-chat-messages');
    if (container) container.innerHTML = '';
    autonomaMsgs = [];
    _autonomaWelcome();
  };

  // ── Welcome message ───────────────────────────────────────────────────────────
  function _autonomaWelcome() {
    const wallet = window.walletState?.address;
    const active = typeof isAgentActive === 'function' ? isAgentActive() : false;

    let permitLine = '';
    try {
      const raw = localStorage.getItem('arc_permit2_allowances_v1');
      if (raw && wallet) {
        const now = Date.now();
        const permits = JSON.parse(raw).filter(p =>
          p.wallet && p.wallet.toLowerCase() === wallet.toLowerCase() &&
          p.expiry > now && (p.amount - (p.amountUsed || 0)) > 0
        );
        permitLine = permits.length > 0
          ? `🔐 **${permits.length} active permit(s)** — autonomous execution available\n`
          : `⚡ No active permit — each transaction will require a wallet signature\n`;
      }
    } catch {}

    autonomaAppendMessage('assistant',
      `🤖 **Autonoma — Autonomous Execution Assistant**\n\n` +
      (wallet
        ? `Wallet: \`${wallet.slice(0,10)}…\`\n` +
          `Daat Agent: ${active ? '✅ Authorized' : '⚠️ Not authorized — type `authorize arcpay`'}\n` +
          permitLine + '\n'
        : `⚠️ *Connect your wallet to use all features.*\n\n`) +
      _metaTxStatusLine() +
      `**I can help with:**\n` +
      `• ⚡ *"send 10 USDC to 0x…"* — create intent, executor processes automatically\n` +
      `• 🔄 *"swap 5 USDC to EURC"* — token swap\n` +
      `• 📤 *"pay 0x…:10, 0x…:20"* — batch payments\n` +
      `• 🔐 *"allow agent to spend 100 USDC for 24 hours"* — create Permit2\n` +
      `• 📋 *"show my intents"* — view active intents\n` +
      `• ➕ *Click + button* — upload CSV for batch payments\n` +
      `• 💳 *"my wallet"* · *"check balance"* · *"my transactions"*\n` +
      `• 🛡️ *"guardian"* · *"network status"* · *"show contracts"*\n` +
      `• 🚀 *"deploy contract"* — deploy AgentExecutor for full gasless mode`,
      'agents'
    );
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // CSV UPLOAD — Autonoma
  // Context is permanently patched, so FileReader.onload callbacks also write
  // to the autonoma container — no more timed unpatch needed.
  // ══════════════════════════════════════════════════════════════════════════════

  window.autonomaHandleCSVInput = function(inputEl) {
    const file = inputEl?.files?.[0];
    if (!file) return;
    inputEl.value = '';

    if (typeof handleChatCSVFile !== 'function') {
      autonomaAppendMessage('assistant', '❌ CSV module not loaded. Please reload the page.', 'error');
      return;
    }
    if (!file.name.toLowerCase().endsWith('.csv')) {
      autonomaAppendMessage('assistant', '⚠️ Please upload a **.csv** file.', 'error');
      return;
    }

    autonomaShowTyping();
    // Context is already installed — handleChatCSVFile and its FileReader.onload
    // will call appendChatMessage which routes to autonoma automatically.
    handleChatCSVFile(file);
    // Hide typing after a short delay (FileReader is async)
    setTimeout(() => {
      autonomaHideTyping();
      _autonomaUpdateCsvBanner();
    }, 1200);
  };

  // Update CSV banner
  function _autonomaUpdateCsvBanner() {
    const banner = document.getElementById('autonoma-csv-banner');
    const text   = document.getElementById('autonoma-csv-banner-text');
    const btn    = document.getElementById('autonoma-csv-btn');
    const state  = window.chatCSVState;

    if (!banner || !text) return;

    if (state?.loaded && state?.rows?.length > 0) {
      const rows = state.rows.length;
      text.textContent = `${state.fileName || 'CSV'} · ${rows} row${rows !== 1 ? 's' : ''} · ${state.token || 'USDC'}`;
      banner.classList.remove('hidden');
      if (btn) { btn.classList.add('text-purple-400'); btn.classList.remove('text-gray-500'); }
    } else {
      banner.classList.add('hidden');
      if (btn) { btn.classList.remove('text-purple-400'); btn.classList.add('text-gray-500'); }
    }
  }
  window.autonomaUpdateCsvBanner = _autonomaUpdateCsvBanner;

  window.autonomaCsvCancel = function() {
    if (typeof window.csvCancelUpload === 'function') {
      window.csvCancelUpload();
    } else if (window.chatCSVState) {
      window.chatCSVState.loaded = false;
      window.chatCSVState.rows   = [];
    }
    _autonomaUpdateCsvBanner();
  };

  // Drag & Drop on the Autonoma chat widget
  function _attachAutonomaCsvDragDrop() {
    const widget  = document.getElementById('autonoma-chat-widget');
    const overlay = document.getElementById('autonoma-csv-drop-overlay');
    if (!widget || widget._csvDragAttached) return;
    widget._csvDragAttached = true;

    widget.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (overlay) { overlay.classList.remove('hidden'); overlay.style.display = 'flex'; }
    });

    widget.addEventListener('dragleave', (e) => {
      if (!widget.contains(e.relatedTarget)) {
        if (overlay) { overlay.classList.add('hidden'); overlay.style.display = ''; }
      }
    });

    widget.addEventListener('drop', (e) => {
      e.preventDefault();
      if (overlay) { overlay.classList.add('hidden'); overlay.style.display = ''; }

      const file = e.dataTransfer?.files?.[0];
      if (!file) return;

      if (!file.name.toLowerCase().endsWith('.csv')) {
        autonomaAppendMessage('assistant', '⚠️ Please drop a **.csv** file.', 'error');
        return;
      }
      if (typeof handleChatCSVFile !== 'function') {
        autonomaAppendMessage('assistant', '❌ CSV module not loaded.', 'error');
        return;
      }

      autonomaShowTyping();
      handleChatCSVFile(file);
      setTimeout(() => {
        autonomaHideTyping();
        _autonomaUpdateCsvBanner();
      }, 1200);
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // INTENT PANEL — Left column
  // ══════════════════════════════════════════════════════════════════════════════

  function _updateAutonomaPermitStatus() {
    const bar      = document.getElementById('autonoma-permit-status-bar');
    const txt      = document.getElementById('autonoma-permit-status-text');
    const btn      = document.getElementById('autonoma-permit-create-btn');
    const emptyMsg = document.getElementById('autonoma-empty-msg');
    if (!bar || !txt) return;

    const wallet = window.walletState?.address;

    if (!wallet) {
      bar.className = 'mb-3 p-3 rounded-lg border text-xs flex items-center justify-between gap-2 bg-gray-800/50 border-gray-700/40 text-gray-400';
      txt.innerHTML = '<i class="fas fa-wallet text-gray-500 mr-1.5"></i>Connect your wallet';
      if (btn) btn.classList.add('hidden');
      return;
    }

    let session = null;
    try {
      const raw = localStorage.getItem('arc-pay-session-v3');
      if (raw) {
        const s = JSON.parse(raw);
        if (s?.authorized && s?.wallet && s?.expiry && Date.now() < s.expiry) session = s;
      }
    } catch {}

    if (!session) {
      bar.className = 'mb-3 p-3 rounded-lg border text-xs flex items-center justify-between gap-2 bg-red-900/10 border-red-800/30 text-red-400';
      txt.innerHTML = '<i class="fas fa-lock text-red-500 mr-1.5"></i><strong>Daat Agent not authorized</strong>';
      if (btn) btn.classList.add('hidden');
      if (emptyMsg) emptyMsg.textContent = 'Authorize Daat Agent first: type "authorize arcpay"';
      return;
    }

    let activePermits = [];
    try {
      const raw = localStorage.getItem('arc_permit2_allowances_v1');
      const now = Date.now();
      activePermits = raw ? JSON.parse(raw).filter(p =>
        p.wallet && p.wallet.toLowerCase() === wallet.toLowerCase() &&
        p.expiry > now && (p.amount - (p.amountUsed || 0)) > 0
      ) : [];
    } catch {}

    if (activePermits.length === 0) {
      bar.className = 'mb-3 p-3 rounded-lg border text-xs flex items-center justify-between gap-2 bg-yellow-900/10 border-yellow-700/30 text-yellow-400';
      txt.innerHTML = '<i class="fas fa-exclamation-triangle text-yellow-500 mr-1.5"></i>No permit — each transaction will require a signature';
      if (btn) btn.classList.remove('hidden');
      if (emptyMsg) emptyMsg.textContent = 'Create a Permit2 for autonomous execution, then request a payment.';
    } else {
      const sum = activePermits.slice(0,2).map(p => {
        const rem = (p.amount - (p.amountUsed || 0)).toFixed(2);
        const exp = Math.round((p.expiry - Date.now()) / 60000);
        return `${rem} ${p.token} (${exp}m)`;
      }).join(' · ');
      bar.className = 'mb-3 p-3 rounded-lg border text-xs flex items-center justify-between gap-2 bg-green-900/10 border-green-700/30 text-green-400';
      txt.innerHTML = `<i class="fas fa-check-circle text-green-500 mr-1.5"></i><strong>${activePermits.length} active permit(s)</strong> — ${sum}`;
      if (btn) btn.classList.add('hidden');
      if (emptyMsg) emptyMsg.textContent = 'Permit active. Request a payment — agent executes automatically.';
    }
  }

  // Render intents list
  function _renderAutonomaIntents(intents) {
    const list    = document.getElementById('autonoma-intents-list');
    const empty   = document.getElementById('autonoma-intents-empty');
    const badge   = document.getElementById('autonoma-pending-badge');
    const total   = document.getElementById('autonoma-stat-total');
    const pending = document.getElementById('autonoma-stat-pending');
    const compl   = document.getElementById('autonoma-stat-completed');
    const failed  = document.getElementById('autonoma-stat-failed');
    if (!list) return;

    if (!intents || intents.length === 0) {
      if (empty) empty.classList.remove('hidden');
      if (total)   total.textContent   = '0';
      if (pending) pending.textContent = '0';
      if (compl)   compl.textContent   = '0';
      if (failed)  failed.textContent  = '0';
      if (badge)   badge.classList.add('hidden');
      return;
    }

    if (empty) empty.classList.add('hidden');

    const nPending   = intents.filter(i => ['pending','processing','signing','broadcast'].includes(i.status)).length;
    const nCompleted = intents.filter(i => i.status === 'completed').length;
    const nFailed    = intents.filter(i => i.status === 'failed').length;

    if (total)   total.textContent   = intents.length;
    if (pending) pending.textContent = nPending;
    if (compl)   compl.textContent   = nCompleted;
    if (failed)  failed.textContent  = nFailed;
    if (badge) {
      if (nPending > 0) { badge.textContent = nPending; badge.classList.remove('hidden'); }
      else badge.classList.add('hidden');
    }

    const statusMap = {
      pending:    { color:'text-yellow-400', bg:'bg-yellow-900/20 border-yellow-800/30', icon:'fa-clock',        label:'Queued'    },
      processing: { color:'text-blue-400',   bg:'bg-blue-900/20 border-blue-800/30',     icon:'fa-cog fa-spin',  label:'Running'   },
      signing:    { color:'text-purple-400', bg:'bg-purple-900/20 border-purple-800/30', icon:'fa-pen-nib',      label:'Signing'   },
      broadcast:  { color:'text-cyan-400',   bg:'bg-cyan-900/20 border-cyan-800/30',     icon:'fa-paper-plane',  label:'Broadcast' },
      completed:  { color:'text-green-400',  bg:'bg-green-900/20 border-green-800/30',   icon:'fa-check-circle', label:'Done'      },
      failed:     { color:'text-red-400',    bg:'bg-red-900/20 border-red-800/30',       icon:'fa-times-circle', label:'Failed'    },
      cancelled:  { color:'text-gray-500',   bg:'bg-gray-800/30 border-gray-700/30',     icon:'fa-ban',          label:'Cancelled' },
    };

    const explorer = 'https://testnet.arcscan.app';
    const rows = intents.slice(0, 30).map(intent => {
      const s    = statusMap[intent.status] || statusMap.pending;
      const time = new Date(intent.createdAt).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
      const to   = intent.to
        ? intent.to.slice(0,8) + '…' + intent.to.slice(-6)
        : (intent.receivers ? `${intent.receivers.length} recipients` : '—');
      const txLink = intent.txHash
        ? `<a href="${explorer}/tx/${intent.txHash}" target="_blank" class="underline text-cyan-400 font-mono">${intent.txHash.slice(0,12)}…</a>`
        : '';
      const errHtml = intent.error
        ? `<div class="text-[10px] text-red-400 mt-0.5 truncate">${intent.error.slice(0,60)}</div>`
        : '';
      return `
        <div class="flex items-start gap-2 p-2 bg-gray-800/40 border ${s.bg} rounded-lg" data-intent-id="${intent.id}">
          <i class="fas ${s.icon} ${s.color} text-xs mt-0.5 flex-shrink-0"></i>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-1.5 flex-wrap">
              <span class="text-white text-[11px] font-semibold capitalize">${intent.type}</span>
              ${intent.amount ? `<span class="text-[11px] font-mono ${s.color.replace('400','300')}">${intent.amount} ${intent.token}</span>` : ''}
              <span class="text-gray-500 text-[10px]">→ ${to}</span>
              <span class="${s.color} text-[10px] font-semibold ml-auto">${s.label}</span>
            </div>
            <div class="flex items-center gap-2 mt-0.5 flex-wrap">
              ${txLink}
              ${intent.blockNumber ? `<span class="text-gray-600 text-[10px]">Block #${intent.blockNumber}</span>` : ''}
              <span class="text-gray-700 text-[10px] ml-auto">${time}</span>
            </div>
            ${errHtml}
          </div>
          ${['pending','failed','cancelled'].includes(intent.status) ? `
            <button onclick="autonomaCancelIntent('${intent.id}')"
              class="text-[10px] text-gray-600 hover:text-red-400 transition-colors flex-shrink-0 mt-0.5">
              <i class="fas fa-times"></i>
            </button>` : ''}
        </div>`;
    }).join('');

    list.innerHTML = rows + (empty ? empty.outerHTML : '');
  }

  async function autonomaRefreshIntentsPanel() {
    _updateAutonomaPermitStatus();

    const wallet = window.walletState?.address;
    if (!wallet) { _renderAutonomaIntents([]); return; }

    try {
      let intents = [];
      if (window.AgentExecutor) {
        intents = await AgentExecutor.getIntents();
      } else {
        const r = await fetch(`/api/agent/intents?wallet=${encodeURIComponent(wallet)}&limit=30`);
        const d = await r.json();
        intents = d.success ? d.intents : [];
      }
      _renderAutonomaIntents(intents);
    } catch (e) {
      console.warn('[Autonoma] refresh intents error:', e);
    }
  }
  window.autonomaRefreshIntents = autonomaRefreshIntentsPanel;

  window.autonomaClearIntents = function() {
    document.querySelectorAll('#autonoma-intents-list [data-intent-id]').forEach(el => {
      const s = el.querySelector('.text-green-400, .text-red-400, .text-gray-500');
      if (s) el.remove();
    });
    const remaining = document.querySelectorAll('#autonoma-intents-list [data-intent-id]').length;
    const total = document.getElementById('autonoma-stat-total');
    if (total) total.textContent = remaining;
    if (remaining === 0) {
      const empty = document.getElementById('autonoma-intents-empty');
      if (empty) empty.classList.remove('hidden');
    }
  };

  window.autonomaCancelIntent = async function(intentId) {
    if (window.AgentExecutor) {
      await AgentExecutor.cancelIntent(intentId);
    } else {
      await fetch(`/api/agent/intents/${intentId}`, { method: 'DELETE' });
    }
    await autonomaRefreshIntentsPanel();
  };

  // ══════════════════════════════════════════════════════════════════════════════
  // AGENT STATUS BAR
  // ══════════════════════════════════════════════════════════════════════════════

  function _updateAutonomaAgentStatus() {
    const statusEl = document.getElementById('autonoma-arcpay-status-text');
    const authBtn  = document.getElementById('autonoma-arcpay-auth-btn');
    if (!statusEl) return;

    const active = typeof isAgentActive === 'function' ? isAgentActive() : false;
    if (active) {
      statusEl.innerHTML = '<i class="fas fa-robot text-green-400 text-[9px] mr-1"></i> Daat Agent · <span class="text-green-400">✅ Authorized</span>';
      if (authBtn) authBtn.classList.add('hidden');
    } else {
      statusEl.innerHTML = '<i class="fas fa-robot text-purple-400 text-[9px] mr-1"></i> Daat Agent · <span class="text-yellow-400">⚠️ Not authorized</span>';
      if (authBtn) authBtn.classList.remove('hidden');
    }
  }

  // Status hooks: updateArcPayBar / p2RefreshUI / p2AddPermit
  function _installStatusHooks() {
    const _origUpdateBar = window.updateArcPayBar;
    if (_origUpdateBar && !_origUpdateBar._autonomaHooked) {
      window.updateArcPayBar = function() {
        const result = _origUpdateBar.apply(this, arguments);
        if (autonomaActive) {
          _updateAutonomaAgentStatus();
          _updateAutonomaPermitStatus();
        }
        return result;
      };
      window.updateArcPayBar._autonomaHooked = true;
    }

    const _origP2Refresh = window.p2RefreshUI;
    if (_origP2Refresh && !_origP2Refresh._autonomaHooked) {
      window.p2RefreshUI = function() {
        const result = _origP2Refresh.apply(this, arguments);
        if (autonomaActive) {
          _updateAutonomaPermitStatus();
          autonomaRefreshIntentsPanel();
        }
        return result;
      };
      window.p2RefreshUI._autonomaHooked = true;
    }

    const _origP2Add = window.p2AddPermit;
    if (_origP2Add && !_origP2Add._autonomaHooked) {
      window.p2AddPermit = function() {
        const result = _origP2Add ? _origP2Add.apply(this, arguments) : undefined;
        if (autonomaActive) setTimeout(_updateAutonomaPermitStatus, 200);
        return result;
      };
      window.p2AddPermit._autonomaHooked = true;
    }

    window.addEventListener('storage', (e) => {
      if (!autonomaActive) return;
      if (e.key === 'arc-pay-session-v3' || e.key === 'arc_permit2_allowances_v1') {
        _updateAutonomaAgentStatus();
        _updateAutonomaPermitStatus();
      }
    });
  }

  // ── FAB visibility ────────────────────────────────────────────────────────────
  function _setFABVisibility(visible) {
    const fab = document.getElementById('chat-fab');
    if (!fab) return;
    fab.style.transition = 'opacity 0.2s, transform 0.2s';
    if (visible) {
      fab.style.opacity = '1'; fab.style.transform = 'scale(1)'; fab.style.pointerEvents = 'auto';
    } else {
      fab.style.opacity = '0'; fab.style.transform = 'scale(0.8)'; fab.style.pointerEvents = 'none';
    }
  }

  function _closeFloatingChat() {
    const widget = document.getElementById('chat-widget');
    if (widget && !widget.classList.contains('hidden')) {
      if (typeof toggleChat === 'function') toggleChat();
    }
  }

  // ── Action card renderer ──────────────────────────────────────────────────────
  function _autonomaRenderActionCard(action, walletConnected) {
    const typeLabels = {
      transfer:'💳 Transfer', swap:'🔄 Swap', multisend:'📤 Multisend',
      contract_deploy:'📋 Deploy Contract', contract_call:'🔍 Contract', automation:'🤖 Auto',
    };
    const label = typeLabels[action.type] || '⚡ ' + action.type;
    const d     = action.data || {};

    const actionId = 'autonoma-act-' + Date.now();
    if (!window._arcPendingActions) window._arcPendingActions = {};
    window._arcPendingActions[actionId] = action;

    const needsWallet = !walletConnected || action.status === 'requires_wallet';
    const ctaHtml = needsWallet
      ? `<button onclick="openWalletModal()" class="arc-action-cta arc-action-cta-wallet">🔗 Connect Wallet</button>`
      : `<button onclick="arcExecuteAction('${actionId}')" class="arc-action-cta arc-action-cta-execute">⚡ Go to ${label} →</button>`;

    const container = document.getElementById('autonoma-chat-messages');
    if (!container) return;

    const card = document.createElement('div');
    card.className = 'flex justify-start pl-7 mb-2';
    card.innerHTML = `
      <div class="arc-blockchain-action-card">
        <div class="arc-action-header">
          <span class="arc-action-type-badge">${label}</span>
          <span class="arc-action-status" style="color:${needsWallet ? '#f59e0b' : '#22c55e'}">
            ● ${needsWallet ? 'Wallet required' : 'Ready'}
          </span>
        </div>
        <div class="arc-action-params">
          ${d.amount ? `<div class="arc-action-param"><span>Amount</span><b>${d.amount} ${d.token || 'USDC'}</b></div>` : ''}
          ${d.to     ? `<div class="arc-action-param"><span>To</span><b class="font-mono text-xs">${d.to.slice(0,10)}…</b></div>` : ''}
        </div>
        ${ctaHtml}
      </div>`;
    container.appendChild(card);
    container.scrollTop = container.scrollHeight;
  }

  // ── Init / Destroy ────────────────────────────────────────────────────────────
  function autonomaInit() {
    if (autonomaActive) return;
    autonomaActive = true;
    window._autonomaActive = true;

    _setFABVisibility(false);
    _closeFloatingChat();

    // INSTALL permanent context patch — routes ALL chat output to autonoma
    _installCtx();

    // Install status hooks
    _installStatusHooks();

    _updateAutonomaAgentStatus();
    _updateAutonomaPermitStatus();
    autonomaRefreshIntentsPanel();
    _autonomaUpdateCsvBanner();

    setTimeout(_attachAutonomaCsvDragDrop, 200);

    // Welcome message if empty
    const container = document.getElementById('autonoma-chat-messages');
    if (container && !container.children.length) {
      _autonomaWelcome();
    }

    // Poll every 3s
    _autonomaPollTimer = setInterval(() => {
      if (!autonomaActive) return;
      autonomaRefreshIntentsPanel();
      _updateAutonomaAgentStatus();
      _autonomaUpdateCsvBanner();
    }, 3000);

    console.log('[Autonoma] Initialized v20260404l · Permanent context patch · Full response parity');
  }

  function autonomaDestroy() {
    if (!autonomaActive) return;
    autonomaActive = false;
    window._autonomaActive = false;
    _setFABVisibility(true);
    if (_autonomaPollTimer) { clearInterval(_autonomaPollTimer); _autonomaPollTimer = null; }
    // REMOVE context patch — restore main chat helpers
    _removeCtx();
  }

  // ── Hook into switchTab ───────────────────────────────────────────────────────
  const _origSwitchTab = window.switchTab;
  window.switchTab = function(tab) {
    if (tab === 'autonoma') {
      _origSwitchTab(tab);
      setTimeout(autonomaInit, 100);
    } else {
      if (autonomaActive) autonomaDestroy();
      _origSwitchTab(tab);
    }
  };

  // ── Wallet / permit / intent event listeners ──────────────────────────────────
  window.addEventListener('walletConnected', () => {
    if (autonomaActive) {
      autonomaRefreshIntentsPanel();
      _updateAutonomaAgentStatus();
      _updateAutonomaPermitStatus();
    }
  });
  window.addEventListener('walletDisconnected', () => {
    if (autonomaActive) {
      autonomaRefreshIntentsPanel();
      _updateAutonomaAgentStatus();
      _updateAutonomaPermitStatus();
    }
  });
  window.addEventListener('permit2Updated', () => {
    if (autonomaActive) {
      _updateAutonomaPermitStatus();
      autonomaRefreshIntentsPanel();
    }
  });
  window.addEventListener('agentExecutor:update', () => {
    if (autonomaActive) setTimeout(autonomaRefreshIntentsPanel, 300);
  });
  window.addEventListener('arcPayAuthorized', () => {
    if (autonomaActive) setTimeout(() => {
      _updateAutonomaAgentStatus();
      _updateAutonomaPermitStatus();
    }, 300);
  });

  // Expose active flag for bridge routing
  window._autonomaActive = false;

  console.log('[Autonoma] Module loaded · v20260404l · Permanent context patch');

})(); // IIFE
