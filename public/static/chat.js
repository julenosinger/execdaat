// ===== CHAT MODULE =====
// ARC AI Assistant Chatbot

const CHAT_SESSION_ID = 'arc-session-' + (localStorage.getItem('arc-chat-session') || (() => {
  const id = Date.now().toString(36);
  localStorage.setItem('arc-chat-session', id);
  return id;
})());

let chatOpen = false;
let chatInitialized = false;
let isTyping = false;
let unreadCount = 0;

// ─── Toggle Chat ──────────────────────────────────────────────────────────────
function toggleChat() {
  const widget = document.getElementById('chat-widget');
  const fabIcon = document.getElementById('chat-fab-icon');
  const fabLabel = document.getElementById('chat-fab-label');
  if (!widget) return;

  chatOpen = !chatOpen;

  if (chatOpen) {
    widget.classList.remove('hidden');
    widget.style.opacity = '0';
    widget.style.transform = 'translateY(20px) scale(0.95)';
    requestAnimationFrame(() => {
      widget.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
      widget.style.opacity = '1';
      widget.style.transform = 'translateY(0) scale(1)';
    });
    if (fabIcon) { fabIcon.classList.remove('fa-robot'); fabIcon.classList.add('fa-times'); }
    if (fabLabel) { fabLabel.classList.add('hidden'); }
    // Clear unread
    unreadCount = 0;
    const badge = document.getElementById('chat-unread');
    if (badge) badge.classList.add('hidden');

    if (!chatInitialized) {
      chatInitialized = true;
      initChatSession();
    } else {
      scrollChatToBottom();
    }
    // Focus input
    setTimeout(() => document.getElementById('chat-input')?.focus(), 300);
  } else {
    widget.style.opacity = '0';
    widget.style.transform = 'translateY(20px) scale(0.95)';
    setTimeout(() => widget.classList.add('hidden'), 250);
    if (fabIcon) { fabIcon.classList.remove('fa-times'); fabIcon.classList.add('fa-robot'); }
    if (fabLabel) { fabLabel.classList.remove('hidden'); fabLabel.textContent = 'Ask me'; }
  }
}

// ─── Init Session ─────────────────────────────────────────────────────────────
async function initChatSession() {
  try {
    const res = await axios.get(`/api/chat/history/${CHAT_SESSION_ID}`);
    const messages = res.data.messages || [];

    if (messages.length === 0) {
      // First time — show welcome
      appendChatMessage('assistant', "Hello! I'm **ARC AI Assistant** 🤖\n\nI'm connected to all system modules:\n- 💳 Payments & Queue\n- 🏦 USDC & EURC Vaults\n- 🔄 Swap Engine\n- 📋 Contracts\n- 🧠 AI Agents\n\nHow can I help you today?", 'general');
    } else {
      // Restore history
      const container = document.getElementById('chat-messages');
      if (container) container.innerHTML = '';
      messages.forEach(m => {
        appendChatMessage(m.role, m.content, m.module, false);
      });
    }
    scrollChatToBottom();
  } catch (e) {
    appendChatMessage('assistant', "Hello! I'm **ARC AI Assistant** 🤖. Ask me anything about payments, vaults, swaps, or contracts!", 'general');
  }
}

// ─── Send Message ─────────────────────────────────────────────────────────────
async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const msg = input?.value?.trim();
  if (!msg || isTyping) return;

  input.value = '';
  appendChatMessage('user', msg);
  showTypingIndicator();

  isTyping = true;
  const sendBtn = document.getElementById('chat-send-btn');
  if (sendBtn) sendBtn.disabled = true;

  try {
    const res = await axios.post('/api/chat/message', {
      message: msg,
      sessionId: CHAT_SESSION_ID,
    });

    hideTypingIndicator();

    if (res.data.success) {
      const reply = res.data.message;
      appendChatMessage('assistant', reply.content, reply.module);

      // Increment unread if chat closed
      if (!chatOpen) {
        unreadCount++;
        const badge = document.getElementById('chat-unread');
        if (badge) {
          badge.textContent = unreadCount > 9 ? '9+' : String(unreadCount);
          badge.classList.remove('hidden');
        }
      }
    } else {
      appendChatMessage('assistant', '❌ Error: ' + (res.data.error || 'Something went wrong.'), 'error');
    }
  } catch (e) {
    hideTypingIndicator();
    appendChatMessage('assistant', '❌ Unable to connect. Please try again.', 'error');
  } finally {
    isTyping = false;
    if (sendBtn) sendBtn.disabled = false;
    input?.focus();
  }
}

// ─── Quick message ────────────────────────────────────────────────────────────
function sendQuickMessage(text) {
  const input = document.getElementById('chat-input');
  if (input) input.value = text;
  sendChatMessage();
}

// ─── Append Message ───────────────────────────────────────────────────────────
function appendChatMessage(role, content, module, scroll = true) {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  const isUser     = role === 'user';
  const moduleColor = getModuleColor(module);
  const moduleIcon  = getModuleIcon(module);
  const rendered    = renderMarkdown(content);

  const div = document.createElement('div');
  div.className = `flex ${isUser ? 'justify-end' : 'justify-start'} gap-1.5`;

  if (!isUser) {
    div.innerHTML = `
      <div class="w-5 h-5 rounded-md bg-gradient-to-br from-purple-700 to-blue-700 flex items-center justify-center flex-shrink-0 mt-0.5">
        <i class="fas ${moduleIcon} text-white" style="font-size:9px"></i>
      </div>
      <div class="max-w-[88%] rounded-xl rounded-tl-sm px-2.5 py-2 bg-gray-800 border border-gray-700/50">
        ${module && module !== 'general' ? `<div class="flex items-center gap-1 mb-1"><span class="text-[10px] ${moduleColor} font-medium">${module.toUpperCase()}</span></div>` : ''}
        <div class="text-xs text-gray-100 chat-content leading-relaxed">${rendered}</div>
        <div class="text-[10px] text-gray-600 mt-1">${new Date().toLocaleTimeString()}</div>
      </div>`;
  } else {
    div.innerHTML = `
      <div class="max-w-[80%] rounded-xl rounded-tr-sm px-2.5 py-2 bg-purple-700 border border-purple-600/50">
        <div class="text-xs text-white">${escapeHtml(content)}</div>
        <div class="text-[10px] text-purple-300 mt-1">${new Date().toLocaleTimeString()}</div>
      </div>`;
  }

  container.appendChild(div);
  if (scroll) scrollChatToBottom();
}

// ─── Typing Indicator ─────────────────────────────────────────────────────────
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
    <div class="bg-gray-800 border border-gray-700/50 rounded-xl rounded-tl-sm px-2.5 py-2">
      <div class="flex gap-1 items-center h-3">
        <div class="w-1.5 h-1.5 bg-purple-400 rounded-full animate-bounce" style="animation-delay:0ms"></div>
        <div class="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" style="animation-delay:150ms"></div>
        <div class="w-1.5 h-1.5 bg-purple-400 rounded-full animate-bounce" style="animation-delay:300ms"></div>
      </div>
    </div>`;
  container.appendChild(div);
  scrollChatToBottom();
}

function hideTypingIndicator() {
  document.getElementById('chat-typing')?.remove();
}

// ─── Clear History ────────────────────────────────────────────────────────────
async function clearChatHistory() {
  try {
    await axios.delete(`/api/chat/history/${CHAT_SESSION_ID}`);
    const container = document.getElementById('chat-messages');
    if (container) container.innerHTML = '';
    chatInitialized = false;
    appendChatMessage('assistant', "Chat cleared! 🧹 How can I help you?", 'general');
  } catch (e) {
    console.error('Clear error:', e);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function scrollChatToBottom() {
  const container = document.getElementById('chat-messages');
  if (container) {
    setTimeout(() => {
      container.scrollTop = container.scrollHeight;
    }, 50);
  }
}

function getModuleColor(module) {
  const colors = {
    payments: 'text-blue-400',
    vaults: 'text-green-400',
    swap: 'text-purple-400',
    contracts: 'text-orange-400',
    agents: 'text-red-400',
    network: 'text-cyan-400',
    general: 'text-gray-400',
  };
  return colors[module] || 'text-gray-400';
}

function getModuleIcon(module) {
  const icons = {
    payments: 'fa-dollar-sign',
    vaults: 'fa-vault',
    swap: 'fa-exchange-alt',
    contracts: 'fa-file-contract',
    agents: 'fa-brain',
    network: 'fa-network-wired',
    general: 'fa-robot',
    error: 'fa-exclamation-triangle',
  };
  return icons[module] || 'fa-robot';
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderMarkdown(text) {
  // Process block-level elements first
  let html = text
    // Tables
    .replace(/\|(.+)\|\n\|[-|: ]+\|\n((?:\|.+\|\n?)+)/g, (_, header, body) => {
      const headers = header.split('|').filter(s => s.trim()).map(s => `<th class="px-3 py-1.5 text-left text-xs text-gray-300 font-semibold border-b border-gray-700">${s.trim()}</th>`).join('');
      const rows = body.trim().split('\n').map(row => {
        const cells = row.split('|').filter(s => s.trim()).map(s => `<td class="px-3 py-1.5 text-xs text-gray-100 border-b border-gray-800">${s.trim()}</td>`).join('');
        return `<tr>${cells}</tr>`;
      }).join('');
      return `<div class="overflow-x-auto my-2"><table class="w-full text-sm"><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table></div>`;
    })
    // Code blocks
    .replace(/```[\s\S]*?```/g, m => `<code class="block bg-black/40 rounded px-3 py-2 text-xs text-green-400 font-mono my-1 whitespace-pre">${m.replace(/```/g, '')}</code>`)
    // Headers
    .replace(/^## (.+)$/gm, '<p class="font-bold text-white text-sm mb-1 mt-2">$1</p>')
    .replace(/^### (.+)$/gm, '<p class="font-semibold text-purple-300 text-xs mb-1 mt-1.5">$1</p>')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong class="font-semibold text-white">$1</strong>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code class="bg-black/30 text-green-400 px-1 rounded text-xs font-mono">$1</code>')
    // Bullets
    .replace(/^[•\-\*] (.+)$/gm, '<div class="flex items-start gap-2 my-0.5"><span class="text-purple-400 mt-0.5">•</span><span>$1</span></div>')
    // Newlines
    .replace(/\n\n/g, '<div class="h-2"></div>')
    .replace(/\n/g, '<br>');

  return html;
}

// ─── CSS for chat-content tables ──────────────────────────────────────────────
if (!document.getElementById('chat-styles')) {
  const style = document.createElement('style');
  style.id = 'chat-styles';
  style.textContent = `
    .chat-content table { border-collapse: collapse; width: 100%; }
    .chat-content th, .chat-content td { padding: 4px 8px; }
    #chat-widget { display: flex; flex-direction: column; }
    #chat-messages { scrollbar-width: thin; scrollbar-color: #4c1d95 #111827; }
    #chat-messages::-webkit-scrollbar { width: 4px; }
    #chat-messages::-webkit-scrollbar-track { background: #111827; }
    #chat-messages::-webkit-scrollbar-thumb { background: #4c1d95; border-radius: 4px; }
    .chat-quick-btn::-webkit-scrollbar { display: none; }
    #chat-quick-actions { scrollbar-width: none; }
  `;
  document.head.appendChild(style);
}

// ─── keyboard shortcut: Ctrl+/ to open chat ──────────────────────────────────
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === '/') {
    e.preventDefault();
    if (!chatOpen) toggleChat();
    else document.getElementById('chat-input')?.focus();
  }
});
