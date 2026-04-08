// ============================================================
// Chatbot Transactional Integration v1.0
// Integrates DaatAgentTransactional with existing chat systems
// Build: 20260408h
// ============================================================
// Purpose:
//   Hook into chat.js and autonoma.js without modifying their UI
//   Route executable commands through DaatAgentTransactional
//   Preserve original NLU, context, and conversational features
//
// Architecture:
//   User Message → Original Chat Handler (NLU, context) →
//   Check if executable → DaatAgentTransactional.process() →
//   Format response → Display in chat UI
//
// Integration Points:
//   - Patches global.handleLocalCommand (main chat)
//   - Patches global.handleUnifiedMessage (autonoma chat)
//   - Preserves all original conversational features
//   - Only intercepts when DaatAgentTransactional can handle
//
// IMPORTANT: This integration does NOT replace chat intelligence.
// It only adds transactional capabilities on top of existing features.
// ============================================================

'use strict';

const CTI_VERSION = '20260408h';

console.log(`[CTI v${CTI_VERSION}] Loading Chatbot Transactional Integration...`);

// ─── Check dependencies ────────────────────────────────────────────────────────
function CTI_checkDependencies() {
  const deps = {
    DaatAgentTransactional: typeof window.DaatAgentTransactional !== 'undefined',
    appendChatMessage: typeof window.appendChatMessage === 'function',
    appendActionCard: typeof window.appendActionCard === 'function',
  };
  
  const missing = Object.entries(deps)
    .filter(([_, exists]) => !exists)
    .map(([name]) => name);
  
  if (missing.length > 0) {
    console.warn(`[CTI] Missing dependencies: ${missing.join(', ')}`);
    return false;
  }
  
  return true;
}

// ─── Check if message is executable ────────────────────────────────────────────
function CTI_isExecutable(message) {
  const msg = (message || '').toLowerCase().trim();
  
  // List of executable patterns
  const patterns = [
    // Transfers
    /^(send|transfer|pay)\s+(\d+\.?\d*)\s+(usdc|eurc)/i,
    /^send\s+max\s+(usdc|eurc)/i,
    /^(repeat|again|do\s+it\s+again)$/i,
    
    // Swaps
    /^(swap|exchange|convert)\s+(\d+\.?\d*)\s+(usdc|eurc)/i,
    
    // Payments
    /^pay\s+([a-z0-9@._-]+)\s+(\d+\.?\d*)\s+(usdc|eurc)\s+for/i,
    
    // Contracts
    /^create\s+(escrow|contract|otc)\s+(\d+\.?\d*)\s+(usdc|eurc)/i,
    
    // Multi-step
    /^swap\s+(\d+\.?\d*)\s+(usdc|eurc)\s+(then|and)\s+pay/i,
    
    // Queries (these are handled by agent but don't require execution)
    /^(show\s+)?(balance|history|context|status)$/i,
  ];
  
  return patterns.some(pattern => pattern.test(msg));
}

// ─── Format agent response for chat display ────────────────────────────────────
function CTI_formatResponse(result) {
  if (!result) return 'No response from agent.';
  
  // For completed actions, format with status emoji and details
  if (result.status === 'completed') {
    let formatted = result.message;
    
    // Add transaction link if available
    if (result.txHash) {
      formatted += `\n\n🔗 [View Transaction ↗](https://testnet.arcscan.app/tx/${result.txHash})`;
    }
    
    // Add next step suggestion if available
    if (result.nextStep) {
      formatted += `\n\n💡 **Next Step**: ${result.nextStep}`;
    }
    
    return formatted;
  }
  
  // For failed actions, show error
  if (result.status === 'failed') {
    return result.message || '❌ Action failed.';
  }
  
  // Default
  return result.message || 'Action processed.';
}

// ─── Create action card from agent result ──────────────────────────────────────
function CTI_createActionCard(result) {
  if (!result || !result.action) return null;
  
  const actionLabels = {
    transfer: '💸 Transfer',
    swap: '🔄 Swap',
    payment: '💰 Payment',
    escrow_create: '📋 Escrow Created',
    contract_create: '📝 Contract Created',
    otc_create: '🤝 OTC Deal Created',
    balance_query: '💰 Balance',
    history_query: '📜 History',
    context_query: '🧠 Context',
    status_query: '📊 Status',
  };
  
  const card = {
    type: result.action,
    title: actionLabels[result.action] || 'Action',
    status: result.status === 'completed' ? 'success' : 'error',
    details: [],
  };
  
  // Add details based on action type
  if (result.data) {
    if (result.data.amount && result.data.token) {
      card.details.push(`Amount: ${result.data.amount} ${result.data.token}`);
    }
    if (result.data.recipient) {
      card.details.push(`To: ${result.data.recipient.slice(0, 10)}...${result.data.recipient.slice(-8)}`);
    }
    if (result.data.fromToken && result.data.toToken) {
      card.details.push(`${result.data.fromToken} → ${result.data.toToken}`);
    }
  }
  
  if (result.txHash) {
    card.txHash = result.txHash;
    card.explorerLink = `https://testnet.arcscan.app/tx/${result.txHash}`;
  }
  
  return card;
}

// ─── Patch handleLocalCommand (Main Chat) ──────────────────────────────────────
function CTI_patchMainChat() {
  if (typeof window.handleLocalCommand !== 'function') {
    console.warn('[CTI] handleLocalCommand not found. Skipping main chat patch.');
    return false;
  }
  
  const originalHandler = window.handleLocalCommand;
  
  window.handleLocalCommand = async function(message) {
    console.log('[CTI] Intercepted handleLocalCommand:', message);
    
    // Check if this is an executable command
    if (!CTI_isExecutable(message)) {
      console.log('[CTI] Non-executable command. Passing to original handler.');
      return originalHandler.call(this, message);
    }
    
    // Check if DaatAgentTransactional is available
    if (!window.DaatAgentTransactional) {
      console.warn('[CTI] DaatAgentTransactional not available. Falling back to original handler.');
      return originalHandler.call(this, message);
    }
    
    try {
      // Show user message
      if (typeof window.appendChatMessage === 'function') {
        window.appendChatMessage('user', message);
      }
      
      // Show typing indicator
      if (typeof window.showTypingIndicator === 'function') {
        window.showTypingIndicator();
      }
      
      // Process through agent
      console.log('[CTI] Processing through DaatAgentTransactional...');
      const result = await window.DaatAgentTransactional.process(message);
      
      // Hide typing indicator
      if (typeof window.hideTypingIndicator === 'function') {
        window.hideTypingIndicator();
      }
      
      // Format and display response
      const formatted = CTI_formatResponse(result);
      
      if (typeof window.appendChatMessage === 'function') {
        window.appendChatMessage('assistant', formatted);
      }
      
      // Create action card if applicable
      if (result.status === 'completed' && result.action !== 'unknown') {
        const card = CTI_createActionCard(result);
        if (card && typeof window.appendActionCard === 'function') {
          window.appendActionCard(card);
        }
      }
      
      console.log('[CTI] Command processed successfully:', result);
      return true;
      
    } catch (err) {
      console.error('[CTI] Processing error:', err);
      
      // Hide typing indicator
      if (typeof window.hideTypingIndicator === 'function') {
        window.hideTypingIndicator();
      }
      
      // Show error message
      if (typeof window.appendChatMessage === 'function') {
        window.appendChatMessage('assistant', `❌ Error: ${err.message}\n\nTry asking me another way, or use a different command.`);
      }
      
      return false;
    }
  };
  
  console.log('[CTI] Main chat patched successfully');
  return true;
}

// ─── Patch handleUnifiedMessage (Autonoma Chat) ────────────────────────────────
function CTI_patchAutonomaChat() {
  if (typeof window.handleUnifiedMessage !== 'function') {
    console.warn('[CTI] handleUnifiedMessage not found. Skipping autonoma chat patch.');
    return false;
  }
  
  const originalHandler = window.handleUnifiedMessage;
  
  window.handleUnifiedMessage = async function(message) {
    console.log('[CTI] Intercepted handleUnifiedMessage:', message);
    
    // Check if this is an executable command
    if (!CTI_isExecutable(message)) {
      console.log('[CTI] Non-executable command. Passing to original handler.');
      return originalHandler.call(this, message);
    }
    
    // Check if DaatAgentTransactional is available
    if (!window.DaatAgentTransactional) {
      console.warn('[CTI] DaatAgentTransactional not available. Falling back to original handler.');
      return originalHandler.call(this, message);
    }
    
    try {
      // Show user message (autonoma-specific)
      if (typeof window.appendAutonomaMessage === 'function') {
        window.appendAutonomaMessage('user', message);
      } else if (typeof window.appendChatMessage === 'function') {
        window.appendChatMessage('user', message);
      }
      
      // Show typing indicator
      if (typeof window.showTypingIndicator === 'function') {
        window.showTypingIndicator();
      }
      
      // Process through agent
      console.log('[CTI] Processing through DaatAgentTransactional...');
      const result = await window.DaatAgentTransactional.process(message);
      
      // Hide typing indicator
      if (typeof window.hideTypingIndicator === 'function') {
        window.hideTypingIndicator();
      }
      
      // Format and display response
      const formatted = CTI_formatResponse(result);
      
      if (typeof window.appendAutonomaMessage === 'function') {
        window.appendAutonomaMessage('assistant', formatted);
      } else if (typeof window.appendChatMessage === 'function') {
        window.appendChatMessage('assistant', formatted);
      }
      
      // Create action card if applicable
      if (result.status === 'completed' && result.action !== 'unknown') {
        const card = CTI_createActionCard(result);
        if (card && typeof window.appendActionCard === 'function') {
          window.appendActionCard(card);
        }
      }
      
      console.log('[CTI] Command processed successfully:', result);
      return true;
      
    } catch (err) {
      console.error('[CTI] Processing error:', err);
      
      // Hide typing indicator
      if (typeof window.hideTypingIndicator === 'function') {
        window.hideTypingIndicator();
      }
      
      // Show error message
      if (typeof window.appendAutonomaMessage === 'function') {
        window.appendAutonomaMessage('assistant', `❌ Error: ${err.message}\n\nTry asking me another way, or use a different command.`);
      } else if (typeof window.appendChatMessage === 'function') {
        window.appendChatMessage('assistant', `❌ Error: ${err.message}\n\nTry asking me another way, or use a different command.`);
      }
      
      return false;
    }
  };
  
  console.log('[CTI] Autonoma chat patched successfully');
  return true;
}

// ─── Initialize integration ────────────────────────────────────────────────────
function CTI_init() {
  console.log('[CTI] Initializing Chatbot Transactional Integration...');
  
  // Check dependencies
  if (!CTI_checkDependencies()) {
    console.error('[CTI] Dependencies not met. Integration disabled.');
    return false;
  }
  
  // Patch handlers
  const mainPatched = CTI_patchMainChat();
  const autonomaPatched = CTI_patchAutonomaChat();
  
  if (mainPatched || autonomaPatched) {
    console.log('[CTI] Integration initialized successfully');
    console.log('[CTI] Main chat:', mainPatched ? '✅' : '❌');
    console.log('[CTI] Autonoma chat:', autonomaPatched ? '✅' : '❌');
    return true;
  }
  
  console.error('[CTI] Failed to patch any chat handlers');
  return false;
}

// ─── Auto-initialize after delay (wait for all modules to load) ────────────────
if (typeof window !== 'undefined') {
  // Expose for manual init if needed
  window.CTI_init = CTI_init;
  
  // Auto-initialize after 1 second (allows all modules to load)
  setTimeout(() => {
    if (typeof window.DaatAgentTransactional !== 'undefined') {
      CTI_init();
    } else {
      console.warn('[CTI] DaatAgentTransactional not loaded yet. Retrying in 2 seconds...');
      setTimeout(() => {
        if (typeof window.DaatAgentTransactional !== 'undefined') {
          CTI_init();
        } else {
          console.error('[CTI] DaatAgentTransactional never loaded. Integration disabled.');
        }
      }, 2000);
    }
  }, 1000);
}

console.log('[CTI] Module loaded');
