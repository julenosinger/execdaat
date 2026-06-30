// build:v2-20260627-151358
// ============================================================
// AUTONOMA CHATBOT → DAAT AGENT CORE INTEGRATION
// Build: 20260408f — ExecDaat Platform
//
// ⚠️ INTEGRATION DISABLED ⚠️
//
// Purpose: This integration was DISABLED to preserve the original
// chatbot intelligence and conversational capabilities.
//
// The original chatbot includes:
// - Natural language understanding
// - Context-aware responses
// - Multi-turn conversations
// - Rich feedback messages
// - Status updates during execution
// - Error handling with helpful suggestions
//
// Hooking into the chatbot's command handlers was removing
// all of this intelligence, making the chatbot "dumb" and
// causing wallet popups without any feedback messages.
//
// STATUS: Integration layer exists but does NOT hook into
// handleLocalCommand or handleUnifiedMessage.
//
// Both chatbots now use their ORIGINAL logic:
// - Main chatbot: chat.js → handleLocalCommand()
// - Autonoma chatbot: autonoma.js → handleUnifiedMessage() → chat-bridge.js
//
// Result: Full conversational intelligence preserved.
// ============================================================
'use strict';

(function(global) {

console.log('[CHAT-CORE] Chatbot integration module loading...');
console.log('[CHAT-CORE] ⚠️ Integration DISABLED - preserving original chatbot intelligence');

// Wait for Core to be ready
function waitForDependencies(callback, maxAttempts = 50) {
  let attempts = 0;
  const interval = setInterval(() => {
    if (global.DaatAgentCore) {
      clearInterval(interval);
      console.log('[CHAT-CORE] DAAT Agent Core ready');
      callback();
    } else if (++attempts >= maxAttempts) {
      clearInterval(interval);
      console.error('[CHAT-CORE] DAAT Agent Core not found after', maxAttempts, 'attempts');
    }
  }, 100);
}

// ─── Helper Functions (NOT USED - kept for future reference) ───────────────

function shortAddr(addr) {
  if (!addr || addr.length < 12) return addr || '—';
  return addr.slice(0, 8) + '…' + addr.slice(-6);
}

function shortHash(hash) {
  if (!addr || hash.length < 12) return hash || '—';
  return hash.slice(0, 10) + '…' + hash.slice(-6);
}

/**
 * Show execution context (last transaction, recent addresses)
 * NOTE: Not currently used - original chatbot has its own context commands
 */
global.chatShowContext = function() {
  if (!global.DaatAgentCore) {
    console.warn('[CHAT-CORE] DaatAgentCore not available');
    return;
  }
  
  const context = global.DaatAgentCore.getContext();
  console.log('[CHAT-CORE] Context:', context);
  
  // This would show context in UI, but integration is disabled
  alert('Context: ' + JSON.stringify(context, null, 2));
};

/**
 * Show execution history
 * NOTE: Not currently used - original chatbot has its own history commands
 */
global.chatShowHistory = function() {
  if (!global.DaatAgentCore) {
    console.warn('[CHAT-CORE] DaatAgentCore not available');
    return;
  }
  
  const history = global.DaatAgentCore.getHistory(10);
  console.log('[CHAT-CORE] History:', history);
  
  // This would show history in UI, but integration is disabled
  alert('History: ' + JSON.stringify(history, null, 2));
};

/**
 * Handle Permit2 approval from chat button
 * NOTE: Not currently used - original chatbot handles Permit2
 */
global.chatApprovePermit2 = async function(token, amount) {
  console.log('[CHAT-CORE] Permit2 approval requested but integration is disabled');
  console.log('[CHAT-CORE] Token:', token, 'Amount:', amount);
  
  // Original chatbot will handle this
  alert('Permit2 approval: Original chatbot will handle this action');
};

// Initialize (but don't hook anything)
waitForDependencies(function() {
  
  console.log('[CHAT-CORE] ✓ DAAT Agent Core loaded');
  console.log('[CHAT-CORE] ⚠️ Integration DISABLED to preserve chatbot intelligence');
  console.log('[CHAT-CORE] ─ Chatbots will use their original logic');
  console.log('[CHAT-CORE] ─ No hooks installed - full backward compatibility');
  console.log('[CHAT-CORE] ─ Original chatbot features preserved:');
  console.log('[CHAT-CORE]   • Natural language understanding');
  console.log('[CHAT-CORE]   • Context-aware responses');
  console.log('[CHAT-CORE]   • Multi-turn conversations');
  console.log('[CHAT-CORE]   • Rich feedback messages');
  console.log('[CHAT-CORE]   • Status updates during execution');
  console.log('[CHAT-CORE]   • Error handling with suggestions');
  
  // Expose API but don't hook anything
  global.ChatbotCoreIntegration = {
    version: '20260408f',
    enabled: false,
    chatShowContext,
    chatShowHistory,
    chatApprovePermit2,
  };
  
  // Emit ready event
  window.dispatchEvent(new CustomEvent('chatbot-core:ready', {
    detail: { 
      version: '20260408f',
      enabled: false,
      preservedIntelligence: true,
      noHooks: true
    }
  }));
  
});

})(window);
