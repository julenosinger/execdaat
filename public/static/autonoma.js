// ============================================================
// AUTONOMA.JS — Subpágina /agents/autonoma
// Build: 20260404d
//
// Layout: 2 colunas
//   LEFT  — Agent Executor Intents (painel live de intents on-chain)
//   RIGHT — Chat embarcado com TODAS as funcionalidades do chat principal
//
// ARQUITETURA:
//   • Chat embarcado reutiliza handleLocalCommand, handlePermitIntent,
//     sendChatMessage — mesmo engine do chat flutuante
//   • Agent Executor Intents: renderiza intents via AgentExecutor API
//     e atualiza o status bar de Permit2 Spending Permissions
//   • FAB flutuante ocultado quando Autonoma está ativa
//   • auto-poll do painel de intents a cada 3s quando ativo
// ============================================================
'use strict';

(function() {

  // ── Estado ───────────────────────────────────────────────────────────────────
  let autonomaActive  = false;
  let autonomaTyping  = false;
  let autonomaMsgs    = [];
  let _autonomaPollTimer = null;

  // ── Formatação de markdown ───────────────────────────────────────────────────
  function _renderMd(text) {
    if (typeof renderMarkdown === 'function') return renderMarkdown(text);
    return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Append mensagem no chat da Autonoma ──────────────────────────────────────
  function autonomaAppendMessage(role, content, module) {
    const container = document.getElementById('autonoma-chat-messages');
    if (!container) return;

    const isUser  = role === 'user';
    const rendered = isUser ? _esc(content) : _renderMd(content);

    const modColors = {
      payments:'text-green-400', swap:'text-blue-400', contracts:'text-orange-400',
      agents:'text-purple-400', permit2:'text-yellow-400', error:'text-red-400',
      general:'text-gray-400', intents:'text-purple-400',
    };
    const modIcons = {
      payments:'fa-dollar-sign', swap:'fa-exchange-alt', contracts:'fa-file-contract',
      agents:'fa-robot', permit2:'fa-key', error:'fa-exclamation-circle',
      general:'fa-comment', intents:'fa-bolt',
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

  // ── Append action card no chat da Autonoma ───────────────────────────────────
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

  // ── Typing indicator ─────────────────────────────────────────────────────────
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

  // ── Enviar mensagem do chat da Autonoma ──────────────────────────────────────
  // Reutiliza handleLocalCommand + handlePermitIntent + API /api/chat/message
  // com DOM próprio — mesmas funcionalidades do chat flutuante
  window.autonomaSendMessage = async function() {
    const input = document.getElementById('autonoma-chat-input');
    const msg   = input?.value?.trim();
    if (!msg || autonomaTyping) return;

    input.value = '';
    autonomaTyping = true;

    const sendBtn = document.getElementById('autonoma-send-btn');
    if (sendBtn) sendBtn.disabled = true;

    autonomaAppendMessage('user', msg);
    autonomaShowTyping();

    // Patch temporário: redireciona appendChatMessage e appendActionCard para Autonoma DOM
    const _origAppend = window.appendChatMessage;
    const _origCard   = window.appendActionCard;
    const _origHide   = window.hideTypingIndicator;
    const _origShow   = window.showTypingIndicator;

    window.appendChatMessage = autonomaAppendMessage;
    window.appendActionCard  = autonomaAppendActionCard;
    window.hideTypingIndicator = autonomaHideTyping;
    window.showTypingIndicator  = autonomaShowTyping;

    try {
      let localHandled = false;

      // 1) Comandos locais de intent (show my intents / cancel intents)
      localHandled = await _handleAutonomaIntentCommand(msg);

      // 2) Permit2 intents (handlePermitIntent do permit2-chat.js)
      if (!localHandled && typeof handlePermitIntent === 'function') {
        localHandled = await handlePermitIntent(msg);
      }

      // 3) Comandos locais gerais (handleLocalCommand do chat.js)
      if (!localHandled && typeof handleLocalCommand === 'function') {
        localHandled = await handleLocalCommand(msg);
      }

      // 4) CSV extended handler
      if (!localHandled && typeof handleLocalCommandWithCSV === 'function') {
        localHandled = await handleLocalCommandWithCSV(msg);
      }

      // 5) Remote AI se nada tratou localmente
      if (!localHandled) {
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

        const r = await fetch('/api/chat/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (!r.ok) throw new Error('POST failed: ' + r.status);
        const res = await r.json();

        autonomaHideTyping();

        if (res.success) {
          const reply  = res.message;
          autonomaAppendMessage('assistant', reply.content, reply.module);

          const action = res.action || reply.action;
          if (action && action.type && action.type !== 'none') {
            _autonomaRenderActionCard(action, res.walletConnected);
          }
        } else {
          autonomaAppendMessage('assistant', '❌ ' + (res.error || 'Algo deu errado.'), 'error');
        }
      } else {
        autonomaHideTyping();
      }

    } catch (err) {
      autonomaHideTyping();
      autonomaAppendMessage('assistant', '❌ Erro de rede. Tente novamente.', 'error');
    } finally {
      // Restore original functions
      window.appendChatMessage   = _origAppend;
      window.appendActionCard    = _origCard;
      window.hideTypingIndicator = _origHide;
      window.showTypingIndicator  = _origShow;

      autonomaTyping = false;
      if (sendBtn) sendBtn.disabled = false;
      input?.focus();
    }
  };

  // ── Handle comandos de intent no chat da Autonoma ────────────────────────────
  async function _handleAutonomaIntentCommand(msg) {
    const lower = msg.toLowerCase().trim();

    // "show my intents" / "ver intents" / "listar intents"
    if (/show.*intent|my intent|listar intent|ver intent|list.*intent/i.test(lower)) {
      autonomaHideTyping();
      await _autonomaShowIntents();
      return true;
    }

    // "cancel all pending" / "cancelar pendentes"
    if (/cancel.*pending|cancelar.*pend|cancel all intent/i.test(lower)) {
      autonomaHideTyping();
      await _autonomaCancelPending();
      return true;
    }

    // "agent status" / "executor status"
    if (/agent.*status|executor.*status|status.*agent/i.test(lower)) {
      autonomaHideTyping();
      _autonomaAgentStatus();
      return true;
    }

    return false;
  }

  async function _autonomaShowIntents() {
    const wallet = window.walletState?.address;
    if (!wallet) {
      autonomaAppendMessage('assistant', '⚠️ Conecte sua wallet para ver os intents.', 'error');
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
          '📋 **Nenhum intent encontrado.**\n\nCrie um intent pedindo ao assistente:\n`send 10 USDC to 0x…`',
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
        `📋 **Seus intents (${intents.length} total)**\n\n${lines}`,
        'intents');

      // Refresh painel
      setTimeout(autonomaRefreshIntentsPanel, 300);
    } catch (e) {
      autonomaAppendMessage('assistant', '❌ Erro ao buscar intents: ' + e.message, 'error');
    }
  }

  async function _autonomaCancelPending() {
    const wallet = window.walletState?.address;
    if (!wallet) {
      autonomaAppendMessage('assistant', '⚠️ Conecte sua wallet primeiro.', 'error');
      return;
    }
    try {
      const r = await fetch(`/api/agent/intents?wallet=${encodeURIComponent(wallet)}&status=pending`);
      const d = await r.json();
      const pending = d.success ? d.intents : [];

      if (pending.length === 0) {
        autonomaAppendMessage('assistant', '✅ Nenhum intent pendente para cancelar.', 'intents');
        return;
      }

      let cancelled = 0;
      for (const i of pending) {
        const res = await fetch(`/api/agent/intents/${i.id}`, { method: 'DELETE' });
        const rd = await res.json();
        if (rd.success) cancelled++;
      }

      autonomaAppendMessage('assistant',
        `🗑️ **${cancelled} intent(s) cancelado(s)** de ${pending.length} pendentes.`,
        'intents');
      setTimeout(autonomaRefreshIntentsPanel, 300);
    } catch (e) {
      autonomaAppendMessage('assistant', '❌ Erro: ' + e.message, 'error');
    }
  }

  function _autonomaAgentStatus() {
    const active  = typeof isAgentActive === 'function' ? isAgentActive() : false;
    const wallet  = window.walletState?.address;
    const polling = window.AgentExecutor ? (window._aePollTimer ? 'ativo' : 'parado') : 'N/A';

    // Check permits
    let permitInfo = 'Nenhum permit ativo';
    try {
      const raw = localStorage.getItem('arc_permit2_allowances_v1');
      if (raw && wallet) {
        const now = Date.now();
        const active2 = JSON.parse(raw).filter(p =>
          p.wallet && p.wallet.toLowerCase() === wallet.toLowerCase() &&
          p.expiry > now && (p.amount - (p.amountUsed || 0)) > 0
        );
        if (active2.length > 0) {
          permitInfo = active2.map(p => {
            const rem = (p.amount - (p.amountUsed || 0)).toFixed(2);
            const exp = Math.round((p.expiry - now) / 60000);
            return `${rem} ${p.token} (${exp}m restantes)`;
          }).join(' · ');
        }
      }
    } catch {}

    autonomaAppendMessage('assistant',
      `🤖 **Status do Agent Executor**\n\n` +
      `| Campo | Valor |\n|---|---|\n` +
      `| Daat Agent | ${active ? '✅ Autorizado' : '⚠️ Não autorizado'} |\n` +
      `| Wallet | ${wallet ? `\`${wallet.slice(0,10)}…\`` : '—'} |\n` +
      `| Poll | ${polling} |\n` +
      `| Permits | ${permitInfo} |\n` +
      `| Versão | ${window.AgentExecutor?.version || 'N/A'} |`,
      'agents');
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // CSV UPLOAD — Autonoma
  // Reutiliza chat-csv.js (handleChatCSVFile, chatCSVState, etc.) já carregado.
  // Apenas redireciona appendChatMessage / appendActionCard para o DOM da Autonoma.
  // ══════════════════════════════════════════════════════════════════════════════

  // ── Patch temporário dos helpers para redirecionar para DOM da Autonoma ───────
  function _withAutonomaCtx(fn) {
    const _origAppend = window.appendChatMessage;
    const _origCard   = window.appendActionCard;
    const _origHide   = window.hideTypingIndicator;
    const _origShow   = window.showTypingIndicator;

    window.appendChatMessage   = autonomaAppendMessage;
    window.appendActionCard    = autonomaAppendActionCard;
    window.hideTypingIndicator = autonomaHideTyping;
    window.showTypingIndicator = autonomaShowTyping;

    const restore = () => {
      window.appendChatMessage   = _origAppend;
      window.appendActionCard    = _origCard;
      window.hideTypingIndicator = _origHide;
      window.showTypingIndicator  = _origShow;
    };

    try {
      const result = fn();
      // Se retornar Promise, restaura depois que ela resolver/rejeitar
      if (result && typeof result.then === 'function') {
        return result.finally(restore);
      }
      restore();
      return result;
    } catch (e) {
      restore();
      throw e;
    }
  }

  // ── Handler chamado pelo onchange do input file ───────────────────────────────
  window.autonomaHandleCSVInput = function(inputEl) {
    const file = inputEl?.files?.[0];
    if (!file) return;
    inputEl.value = ''; // reset para permitir re-upload do mesmo arquivo

    if (typeof handleChatCSVFile !== 'function') {
      autonomaAppendMessage('assistant',
        '❌ Módulo CSV não carregado. Recarregue a página.', 'error');
      return;
    }

    autonomaShowTyping();
    _withAutonomaCtx(() => {
      const r = handleChatCSVFile(file);
      // handleChatCSVFile pode ser sync ou async
      const finish = () => setTimeout(_autonomaUpdateCsvBanner, 300);
      if (r && typeof r.then === 'function') r.then(finish).catch(finish);
      else finish();
    });
  };

  // ── Atualiza o banner de CSV dentro da Autonoma ───────────────────────────────
  function _autonomaUpdateCsvBanner() {
    const banner = document.getElementById('autonoma-csv-banner');
    const text   = document.getElementById('autonoma-csv-banner-text');
    const btn    = document.getElementById('autonoma-csv-btn');
    const state  = window.chatCSVState;

    if (!banner || !text) return;

    if (state?.loaded && state?.rows?.length > 0) {
      text.textContent = `${state.fileName || 'CSV'} · ${state.rows.length} linha(s) · ${state.token || 'USDC'}`;
      banner.classList.remove('hidden');
      if (btn) { btn.classList.add('text-purple-400'); btn.classList.remove('text-gray-500'); }
    } else {
      banner.classList.add('hidden');
      if (btn) { btn.classList.remove('text-purple-400'); btn.classList.add('text-gray-500'); }
    }
  }
  window.autonomaUpdateCsvBanner = _autonomaUpdateCsvBanner;

  // ── Cancelar CSV carregado ────────────────────────────────────────────────────
  window.autonomaCsvCancel = function() {
    if (typeof window.csvCancelUpload === 'function') {
      _withAutonomaCtx(() => window.csvCancelUpload());
    } else if (window.chatCSVState) {
      window.chatCSVState.loaded = false;
      window.chatCSVState.rows   = [];
    }
    _autonomaUpdateCsvBanner();
  };

  // ── Drag & Drop no chat widget da Autonoma ────────────────────────────────────
  function _attachAutonomaCsvDragDrop() {
    const widget  = document.getElementById('autonoma-chat-widget');
    const overlay = document.getElementById('autonoma-csv-drop-overlay');
    if (!widget || widget._csvDragAttached) return;
    widget._csvDragAttached = true;

    widget.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (overlay) {
        overlay.classList.remove('hidden');
        overlay.style.display = 'flex';
      }
    });

    widget.addEventListener('dragleave', (e) => {
      if (!widget.contains(e.relatedTarget)) {
        if (overlay) {
          overlay.classList.add('hidden');
          overlay.style.display = '';
        }
      }
    });

    widget.addEventListener('drop', (e) => {
      e.preventDefault();
      if (overlay) { overlay.classList.add('hidden'); overlay.style.display = ''; }

      const file = e.dataTransfer?.files?.[0];
      if (!file) return;

      if (!file.name.toLowerCase().endsWith('.csv')) {
        autonomaAppendMessage('assistant',
          '⚠️ Por favor, envie um arquivo **.csv**.', 'error');
        return;
      }

      if (typeof handleChatCSVFile !== 'function') {
        autonomaAppendMessage('assistant',
          '❌ Módulo CSV não carregado.', 'error');
        return;
      }

      autonomaShowTyping();
      _withAutonomaCtx(() => {
        const r = handleChatCSVFile(file);
        const finish = () => setTimeout(_autonomaUpdateCsvBanner, 300);
        if (r && typeof r.then === 'function') r.then(finish).catch(finish);
        else finish();
      });
    });
  }

  // ── Quick message ─────────────────────────────────────────────────────────────
  window.autonomaSendChat = function(text) {
    const input = document.getElementById('autonoma-chat-input');
    if (input) {
      input.value = text;
      autonomaSendMessage();
    }
  };

  // ── Limpar chat da Autonoma ───────────────────────────────────────────────────
  window.autonomaClearChat = function() {
    const container = document.getElementById('autonoma-chat-messages');
    if (container) container.innerHTML = '';
    autonomaMsgs = [];
    _autonomaWelcome();
  };

  // ── Mensagem de boas-vindas ───────────────────────────────────────────────────
  function _autonomaWelcome() {
    const wallet = window.walletState?.address;
    const active = typeof isAgentActive === 'function' ? isAgentActive() : false;

    // Check permits
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
          ? `🔐 **${permits.length} Permit(s) ativo(s)** — execução autônoma disponível\n`
          : `⚡ Sem permit ativo — cada tx precisará de assinatura da wallet\n`;
      }
    } catch {}

    autonomaAppendMessage('assistant',
      `🤖 **Autonoma — Assistente de Execução Autônoma**\n\n` +
      (wallet
        ? `Wallet: \`${wallet.slice(0,10)}…\`\n` +
          `Daat Agent: ${active ? '✅ Autorizado' : '⚠️ Não autorizado — digite `authorize arcpay`'}\n` +
          permitLine + '\n'
        : `⚠️ *Conecte sua wallet para usar todas as funcionalidades.*\n\n`) +
      `**Posso ajudar com:**\n` +
      `• ⚡ *"send 10 USDC to 0x…"* — cria intent, executor processa automaticamente\n` +
      `• 🔄 *"swap 5 USDC to EURC"* — swap de tokens\n` +
      `• 📤 *"pay 0x…:10, 0x…:20"* — pagamento em lote\n` +
      `• 🔐 *"allow agent to spend 100 USDC for 24 hours"* — criar Permit2\n` +
      `• 📋 *"show my intents"* — ver intents ativos\n` +
      `• 💳 *"my wallet"* · *"check balance"* · *"my transactions"*\n` +
      `• 🛡️ *"guardian"* · *"network status"* · *"show contracts"*`,
      'agents'
    );
  }

  // ── Painel de Intents na coluna esquerda ─────────────────────────────────────

  // Atualiza o status bar de Permit2 na coluna esquerda
  function _updateAutonomaPermitStatus() {
    const bar  = document.getElementById('autonoma-permit-status-bar');
    const txt  = document.getElementById('autonoma-permit-status-text');
    const btn  = document.getElementById('autonoma-permit-create-btn');
    const emptyMsg = document.getElementById('autonoma-empty-msg');
    if (!bar || !txt) return;

    const wallet = window.walletState?.address;

    if (!wallet) {
      bar.className = 'mb-3 p-3 rounded-lg border text-xs flex items-center justify-between gap-2 bg-gray-800/50 border-gray-700/40 text-gray-400';
      txt.innerHTML = '<i class="fas fa-wallet text-gray-500 mr-1.5"></i>Conecte sua wallet';
      if (btn) btn.classList.add('hidden');
      return;
    }

    // Verifica sessão
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
      txt.innerHTML = '<i class="fas fa-lock text-red-500 mr-1.5"></i><strong>Daat Agent não autorizado</strong>';
      if (btn) btn.classList.add('hidden');
      if (emptyMsg) emptyMsg.textContent = 'Autorize o Daat Agent primeiro: "authorize arcpay"';
      return;
    }

    // Verifica permits
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
      txt.innerHTML = '<i class="fas fa-exclamation-triangle text-yellow-500 mr-1.5"></i>Sem permit — cada tx precisará de assinatura';
      if (btn) btn.classList.remove('hidden');
      if (emptyMsg) emptyMsg.textContent = 'Crie um Permit2 para execução autônoma, depois peça um envio.';
    } else {
      const sum = activePermits.slice(0,2).map(p => {
        const rem = (p.amount - (p.amountUsed || 0)).toFixed(2);
        const exp = Math.round((p.expiry - Date.now()) / 60000);
        return `${rem} ${p.token} (${exp}m)`;
      }).join(' · ');
      bar.className = 'mb-3 p-3 rounded-lg border text-xs flex items-center justify-between gap-2 bg-green-900/10 border-green-700/30 text-green-400';
      txt.innerHTML = `<i class="fas fa-check-circle text-green-500 mr-1.5"></i><strong>${activePermits.length} permit(s)</strong> — ${sum}`;
      if (btn) btn.classList.add('hidden');
      if (emptyMsg) emptyMsg.textContent = 'Permit ativo. Peça um pagamento — agente executa automaticamente.';
    }
  }

  // Renderiza intents na coluna esquerda
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
      pending:    { color:'text-yellow-400', bg:'bg-yellow-900/20 border-yellow-800/30', icon:'fa-clock',        label:'Aceito'    },
      processing: { color:'text-blue-400',   bg:'bg-blue-900/20 border-blue-800/30',     icon:'fa-cog fa-spin',  label:'Executando'},
      signing:    { color:'text-purple-400', bg:'bg-purple-900/20 border-purple-800/30', icon:'fa-pen-nib',      label:'Assinando' },
      broadcast:  { color:'text-cyan-400',   bg:'bg-cyan-900/20 border-cyan-800/30',     icon:'fa-paper-plane',  label:'Enviado'   },
      completed:  { color:'text-green-400',  bg:'bg-green-900/20 border-green-800/30',   icon:'fa-check-circle', label:'Concluído' },
      failed:     { color:'text-red-400',    bg:'bg-red-900/20 border-red-800/30',       icon:'fa-times-circle', label:'Falhou'    },
      cancelled:  { color:'text-gray-500',   bg:'bg-gray-800/30 border-gray-700/30',     icon:'fa-ban',          label:'Cancelado' },
    };

    const explorer = 'https://testnet.arcscan.app';
    const rows = intents.slice(0, 30).map(intent => {
      const s    = statusMap[intent.status] || statusMap.pending;
      const time = new Date(intent.createdAt).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
      const to   = intent.to
        ? intent.to.slice(0,8) + '…' + intent.to.slice(-6)
        : (intent.receivers ? `${intent.receivers.length} dest.` : '—');
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

  // Atualiza o painel de intents (fetch + render + permit status)
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
      const statusEl = el.querySelector('.text-green-400, .text-red-400, .text-gray-500');
      if (statusEl) el.remove();
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

  // ── Atualizar status bar do chat (Daat Agent) ─────────────────────────────────
  function _updateAutonomaAgentStatus() {
    const statusEl = document.getElementById('autonoma-arcpay-status-text');
    const authBtn  = document.getElementById('autonoma-arcpay-auth-btn');
    if (!statusEl) return;

    const active = typeof isAgentActive === 'function' ? isAgentActive() : false;
    if (active) {
      statusEl.innerHTML = '<i class="fas fa-robot text-green-400 text-[9px] mr-1"></i> Daat Agent · <span class="text-green-400">✅ Autorizado</span>';
      if (authBtn) authBtn.classList.add('hidden');
    } else {
      statusEl.innerHTML = '<i class="fas fa-robot text-purple-400 text-[9px] mr-1"></i> Daat Agent · <span class="text-yellow-400">⚠️ Não autorizado</span>';
      if (authBtn) authBtn.classList.remove('hidden');
    }
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

  // ── Action card para a Autonoma ───────────────────────────────────────────────
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
      ? `<button onclick="openWalletModal()" class="arc-action-cta arc-action-cta-wallet">🔗 Conectar Wallet</button>`
      : `<button onclick="arcExecuteAction('${actionId}')" class="arc-action-cta arc-action-cta-execute">⚡ Ir para ${label} →</button>`;

    const container = document.getElementById('autonoma-chat-messages');
    if (!container) return;

    const card = document.createElement('div');
    card.className = 'flex justify-start pl-7 mb-2';
    card.innerHTML = `
      <div class="arc-blockchain-action-card">
        <div class="arc-action-header">
          <span class="arc-action-type-badge">${label}</span>
          <span class="arc-action-status" style="color:${needsWallet ? '#f59e0b' : '#22c55e'}">
            ● ${needsWallet ? 'Wallet necessária' : 'Pronto'}
          </span>
        </div>
        <div class="arc-action-params">
          ${d.amount ? `<div class="arc-action-param"><span>Valor</span><b>${d.amount} ${d.token || 'USDC'}</b></div>` : ''}
          ${d.to     ? `<div class="arc-action-param"><span>Para</span><b class="font-mono text-xs">${d.to.slice(0,10)}…</b></div>` : ''}
        </div>
        ${ctaHtml}
      </div>`;
    container.appendChild(card);
    container.scrollTop = container.scrollHeight;
  }

  // ── Init ao entrar na página ──────────────────────────────────────────────────
  function autonomaInit() {
    if (autonomaActive) return;
    autonomaActive = true;

    _setFABVisibility(false);
    _closeFloatingChat();

    _updateAutonomaAgentStatus();
    autonomaRefreshIntentsPanel();
    _autonomaUpdateCsvBanner();

    // Attach drag & drop no chat widget
    setTimeout(_attachAutonomaCsvDragDrop, 200);

    // Welcome message se vazio
    const container = document.getElementById('autonoma-chat-messages');
    if (container && !container.children.length) {
      _autonomaWelcome();
    }

    // Poll de intents + CSV banner a cada 3s
    _autonomaPollTimer = setInterval(() => {
      if (autonomaActive) {
        autonomaRefreshIntentsPanel();
        _autonomaUpdateCsvBanner();
      }
    }, 3000);

    console.log('[Autonoma] Inicializado v20260404d · Agent Executor Intents + CSV Upload + Full Chat');
  }

  function autonomaDestroy() {
    if (!autonomaActive) return;
    autonomaActive = false;
    _setFABVisibility(true);
    if (_autonomaPollTimer) { clearInterval(_autonomaPollTimer); _autonomaPollTimer = null; }
  }

  // ── Hook no switchTab ─────────────────────────────────────────────────────────
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

  // ── Listeners de wallet/permit/intent ────────────────────────────────────────
  window.addEventListener('walletConnected', () => {
    if (autonomaActive) { autonomaRefreshIntentsPanel(); _updateAutonomaAgentStatus(); }
  });
  window.addEventListener('walletDisconnected', () => {
    if (autonomaActive) { autonomaRefreshIntentsPanel(); _updateAutonomaAgentStatus(); }
  });
  window.addEventListener('permit2Updated', () => {
    if (autonomaActive) autonomaRefreshIntentsPanel();
  });
  window.addEventListener('agentExecutor:update', () => {
    if (autonomaActive) setTimeout(autonomaRefreshIntentsPanel, 300);
  });

  console.log('[Autonoma] Módulo carregado · v20260404d · CSV Upload suportado');

})(); // IIFE
