// ============================================================
// AUTONOMA.JS — Subpágina /agents/autonoma
// Layout 2 colunas: Permit2 (esquerda) + Chat embutido (direita)
//
// ARQUITETURA:
//   • Chat embutido usa funções compartilhadas (sendChatMessage,
//     appendChatMessage, handleLocalCommand) mas com DOM próprio
//   • Permit2 mirror sincroniza do painel principal via eventos
//   • FAB flutuante é ocultado quando Autonoma está ativa
// ============================================================
'use strict';

(function() {

  // ── Estado ───────────────────────────────────────────────────────────────────
  let autonomaActive   = false;
  let autonomaTyping   = false;
  let autonomaMsgs     = []; // histórico local do chat da Autonoma

  // ── Formatação de markdown (reutiliza renderMarkdown do chat.js) ─────────────
  function _renderMd(text) {
    if (typeof renderMarkdown === 'function') return renderMarkdown(text);
    return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Escape HTML ───────────────────────────────────────────────────────────────
  function _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Append mensagem no chat da Autonoma ──────────────────────────────────────
  function autonomaAppendMessage(role, content, module) {
    const container = document.getElementById('autonoma-chat-messages');
    if (!container) return;

    const isUser = role === 'user';
    const rendered = isUser ? _esc(content) : _renderMd(content);

    // Determinar cor/ícone do módulo
    const modColors = {
      payments:'text-green-400', swap:'text-blue-400', contracts:'text-orange-400',
      agents:'text-purple-400', permit2:'text-yellow-400', error:'text-red-400',
      general:'text-gray-400',
    };
    const modIcons = {
      payments:'fa-dollar-sign', swap:'fa-exchange-alt', contracts:'fa-file-contract',
      agents:'fa-robot', permit2:'fa-key', error:'fa-exclamation-circle',
      general:'fa-comment',
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

    // Persistir historico local
    autonomaMsgs.push({ role, content, module, ts: Date.now() });
  }
  window.autonomaAppendMessage = autonomaAppendMessage;

  // ── Append action card no chat da Autonoma ────────────────────────────────────
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

  // ── Enviar chat da Autonoma ───────────────────────────────────────────────────
  // Reutiliza o endpoint /api/chat/message mas com DOM próprio.
  // A lógica de Brain continua a mesma — nunca executa blockchain.
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

    try {
      // Tenta local commands primeiro (reutiliza handleLocalCommand do chat.js)
      // Porém precisa redirecionar appendChatMessage para autonomaAppendMessage

      // Patch temporário: sobrescreve appendChatMessage + appendActionCard para o chat da Autonoma
      const _origAppend = window.appendChatMessage;
      const _origCard   = window.appendActionCard;
      const _origHide   = typeof hideTypingIndicator === 'function' ? hideTypingIndicator : null;
      const _origShow   = typeof showTypingIndicator === 'function' ? showTypingIndicator : null;

      window.appendChatMessage = autonomaAppendMessage;
      window.appendActionCard  = autonomaAppendActionCard;
      if (_origHide) window.hideTypingIndicator = autonomaHideTyping;
      if (_origShow) window.showTypingIndicator  = autonomaShowTyping;

      let localHandled = false;
      try {
        if (typeof handleLocalCommand === 'function') {
          localHandled = await handleLocalCommand(msg);
        }
        // CSV extended handler
        if (!localHandled && typeof handleLocalCommandWithCSV === 'function') {
          localHandled = await handleLocalCommandWithCSV(msg);
        }
      } catch (e) {
        // ignore local errors
      }

      if (!localHandled) {
        // Remote AI
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

          // Action card: renderiza no container da Autonoma
          // arcExecuteAction apenas preenche forms (não abre wallet)
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

      // Restore original functions
      window.appendChatMessage = _origAppend;
      window.appendActionCard  = _origCard;
      if (_origHide) window.hideTypingIndicator = _origHide;
      if (_origShow) window.showTypingIndicator  = _origShow;

    } catch (err) {
      autonomaHideTyping();
      autonomaAppendMessage('assistant', '❌ Erro de rede. Tente novamente.', 'error');
      // Restore
      if (typeof appendChatMessage !== 'function') window.appendChatMessage = autonomaAppendMessage;
    } finally {
      autonomaTyping = false;
      if (sendBtn) sendBtn.disabled = false;
      input?.focus();
    }
  };

  // ── Quick message (envia via autonomaSendMessage) ──────────────────────────────
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
    // Reexibe mensagem de boas-vindas
    _autonomaWelcome();
  };

  // ── Mensagem de boas-vindas ───────────────────────────────────────────────────
  function _autonomaWelcome() {
    const wallet  = window.walletState?.address;
    const active  = typeof isAgentActive === 'function' ? isAgentActive() : false;

    autonomaAppendMessage('assistant',
      `🤖 **Olá! Sou o Assistente de Execução Autônoma**\n\n` +
      `Posso ajudar a:\n` +
      `• 🔐 Criar e gerenciar **Permits Permit2** (sem gas)\n` +
      `• 💳 Preparar transferências e lotes para execução\n` +
      `• 📋 Verificar contratos OTC e escrow\n` +
      `• 🛡️ Validar segurança via Guardian\n\n` +
      (wallet
        ? `Wallet conectada: \`${wallet.slice(0,10)}…\`\n` +
          `ArcPay Agent: ${active ? '✅ Autorizado' : '⚠️ Não autorizado'}\n\n` +
          `*Use os botões de ação rápida ou digite um comando.*`
        : `⚠️ *Conecte sua wallet para usar todas as funcionalidades.*`),
      'agents'
    );
  }

  // ── Sincronizar Permit2 mirror ────────────────────────────────────────────────
  // Copia o conteúdo do permit2-active-panel para autonoma-permit2-mirror
  function _syncPermit2Mirror() {
    const source = document.getElementById('permit2-active-panel');
    const mirror = document.getElementById('autonoma-permit2-mirror');
    const badge  = document.getElementById('autonoma-permit2-badge');

    if (!source || !mirror) return;

    // Clone para não afetar o original
    mirror.innerHTML = source.innerHTML;

    // Atualizar badge
    const wallet = window.walletState?.address;
    if (wallet && typeof p2GetActive === 'function') {
      const active = p2GetActive(wallet);
      if (badge) {
        badge.textContent = active.length + ' ativo' + (active.length !== 1 ? 's' : '');
        badge.classList.toggle('hidden', active.length === 0);
      }
    } else {
      if (badge) badge.classList.add('hidden');
    }
  }

  // ── Atualizar status bar do chat ──────────────────────────────────────────────
  function _updateAutonomaAgentStatus() {
    const statusEl  = document.getElementById('autonoma-arcpay-status-text');
    const authBtn   = document.getElementById('autonoma-arcpay-auth-btn');
    if (!statusEl) return;

    const active = typeof isAgentActive === 'function' ? isAgentActive() : false;
    if (active) {
      statusEl.innerHTML = '<i class="fas fa-robot text-green-400 text-[9px] mr-1"></i> ArcPay Agent · <span class="text-green-400">✅ Autorizado</span>';
      if (authBtn) authBtn.classList.add('hidden');
    } else {
      statusEl.innerHTML = '<i class="fas fa-robot text-purple-400 text-[9px] mr-1"></i> ArcPay Agent · <span class="text-yellow-400">Não autorizado</span>';
      if (authBtn) authBtn.classList.remove('hidden');
    }
  }

  // ── Esconder FAB quando Autonoma está ativa ───────────────────────────────────
  function _setFABVisibility(visible) {
    const fab = document.getElementById('chat-fab');
    if (!fab) return;
    fab.style.transition = 'opacity 0.2s, transform 0.2s';
    if (visible) {
      fab.style.opacity = '1';
      fab.style.transform = 'scale(1)';
      fab.style.pointerEvents = 'auto';
    } else {
      fab.style.opacity = '0';
      fab.style.transform = 'scale(0.8)';
      fab.style.pointerEvents = 'none';
    }
  }

  // ── Fechar widget flutuante se aberto ao entrar na Autonoma ──────────────────
  function _closeFloatingChat() {
    const widget = document.getElementById('chat-widget');
    if (widget && !widget.classList.contains('hidden')) {
      if (typeof toggleChat === 'function') toggleChat();
    }
  }

  // ── Action card para a Autonoma ──────────────────────────────────────────────
  // Versão simplificada que sempre redireciona para as abas via arcExecuteAction
  // (preenche forms — não executa blockchain)
  function _autonomaRenderActionCard(action, walletConnected) {
    const typeLabels = {
      transfer:'💳 Transfer', swap:'🔄 Swap', multisend:'📤 Multisend',
      contract_deploy:'📋 Deploy Contract', contract_call:'🔍 Contract', automation:'🤖 Auto',
    };
    const label = typeLabels[action.type] || '⚡ ' + action.type;
    const d     = action.data || {};

    // Registrar no mapa global para arcExecuteAction
    const actionId = 'autonoma-act-' + Date.now();
    if (!window._arcPendingActions) window._arcPendingActions = {};
    window._arcPendingActions[actionId] = action;

    const needsWallet = !walletConnected || action.status === 'requires_wallet';
    const ctaHtml = needsWallet
      ? `<button onclick="openWalletModal()" class="arc-action-cta arc-action-cta-wallet">🔗 Conectar Wallet</button>`
      : `<button onclick="arcExecuteAction('${actionId}')" class="arc-action-cta arc-action-cta-execute">⚡ Ir para ${label} →</button>`;

    autonomaAppendActionCard([]);
    // Substituir o último card vazio por um com conteúdo
    const container = document.getElementById('autonoma-chat-messages');
    if (!container) return;
    const last = container.lastElementChild;
    if (last && last.querySelector('.chat-action-card')) last.remove();

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

    // Ocultar FAB e fechar chat flutuante
    _setFABVisibility(false);
    _closeFloatingChat();

    // Sincronizar permits
    _syncPermit2Mirror();
    _updateAutonomaAgentStatus();

    // Mensagem de boas-vindas (se vazio)
    const container = document.getElementById('autonoma-chat-messages');
    if (container && !container.children.length) {
      _autonomaWelcome();
    }

    console.log('[Autonoma] Página inicializada · 2-col layout · Brain-only chat');
  }

  // ── Cleanup ao sair da página ─────────────────────────────────────────────────
  function autonomaDestroy() {
    if (!autonomaActive) return;
    autonomaActive = false;
    _setFABVisibility(true);
  }

  // ── Hook no switchTab ─────────────────────────────────────────────────────────
  // Intercepta a troca de abas para init/destroy da Autonoma
  const _origSwitchTab = window.switchTab;
  window.switchTab = function(tab) {
    if (tab === 'autonoma') {
      _origSwitchTab(tab);
      setTimeout(autonomaInit, 100); // pequeno delay para o DOM estar visível
    } else {
      if (autonomaActive) autonomaDestroy();
      _origSwitchTab(tab);
    }
  };

  // ── Escutar mudanças de wallet e permit2 para atualizar mirror ───────────────
  window.addEventListener('walletConnected', () => {
    if (autonomaActive) {
      _syncPermit2Mirror();
      _updateAutonomaAgentStatus();
    }
  });
  window.addEventListener('walletDisconnected', () => {
    if (autonomaActive) {
      _syncPermit2Mirror();
      _updateAutonomaAgentStatus();
    }
  });
  window.addEventListener('permit2Updated', () => {
    if (autonomaActive) _syncPermit2Mirror();
  });

  // Polling leve de sync (a cada 3s quando Autonoma estiver ativa)
  setInterval(() => {
    if (autonomaActive) {
      _syncPermit2Mirror();
      _updateAutonomaAgentStatus();
    }
  }, 3000);

  console.log('[Autonoma] Módulo carregado · v20260329a');

})(); // IIFE
