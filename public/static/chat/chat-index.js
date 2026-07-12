// ============================================================
// ExecDaat Chat Module — Index / Entry Point
// ============================================================
// Load order: chat-core.js → chat-commands.js → chat-ui.js → chat-index.js
// All modules use shared global scope (no ES modules) via <script> tags.
// This file wires global event listeners, window exports, and init log.
// ============================================================
'use strict';

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

// ── Init log ───────────────────────────────────────────────────────────────────
const _active = isAgentActive();
console.log('%c[CHAT v3 — Brain/Execution Split]', 'color:#a78bfa;font-weight:bold',
  'Daat Agent:', _active ? '✅ Active' : '⚠️ Not authorized',
  '| Session:', _active ? arcPaySession?.sessionHash?.slice(0,12)+'…' : 'none',
  '| Size:', chatSize,
  '| 🧠 Brain-only mode: chatbot nunca executa blockchain'
);
