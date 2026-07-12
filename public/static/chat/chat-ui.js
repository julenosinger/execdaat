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
