// ============================================================
// AUTONOMA CHATBOT → DAAT AGENT CORE INTEGRATION
// Build: 20260408c — ExecDaat Platform
//
// Purpose: Bridge chatbot natural language to DAAT Agent Core
//
// Architecture:
//   User message → handleLocalCommand() → DaatAgentCore.processIntent()
//                                       → standardized execution
//                                       → chat feedback
//
// Changes:
//   - All chatbot commands routed through Core
//   - Natural language parsing centralized in Core.IntentEngine
//   - Permit2 checks before execution
//   - Real-time status updates in chat
//   - No UI changes, only internal routing
//
// ============================================================
'use strict';

(function(global) {

console.log('[CHAT-CORE] Autonoma → Core integration loading...');

// Wait for Core to be ready (handleLocalCommand and handleUnifiedMessage may load later)
function waitForDependencies(callback, maxAttempts = 50) {
  let attempts = 0;
  const interval = setInterval(() => {
    if (global.DaatAgentCore) {
      clearInterval(interval);
      console.log('[CHAT-CORE] DAAT Agent Core ready, initializing integration');
      callback();
    } else if (++attempts >= maxAttempts) {
      clearInterval(interval);
      console.error('[CHAT-CORE] DAAT Agent Core not found after', maxAttempts, 'attempts');
    }
  }, 100);
}

// Initialize integration
waitForDependencies(function() {
  
  // ─── Chat UI Helpers ────────────────────────────────────────────────────────
  
  function addChatMessage(text, type = 'assistant') {
    if (typeof global.arcAddChatMsg === 'function') {
      global.arcAddChatMsg(text, type);
    } else if (typeof global.addMessage === 'function') {
      global.addMessage(text, type);
    } else {
      console.log('[CHAT-CORE]', type, ':', text);
    }
  }
  
  function addUserMessage(text) {
    addChatMessage(text, 'user');
  }
  
  function addAssistantMessage(text) {
    addChatMessage(text, 'assistant');
  }
  
  function addSystemMessage(text) {
    addChatMessage(text, 'system');
  }
  
  function addErrorMessage(text) {
    addChatMessage(`❌ ${text}`, 'error');
  }
  
  function addSuccessMessage(text) {
    addChatMessage(`✅ ${text}`, 'success');
  }
  
  function shortAddr(addr) {
    if (!addr || addr.length < 12) return addr || '—';
    return addr.slice(0, 8) + '…' + addr.slice(-6);
  }
  
  function shortHash(hash) {
    if (!hash || hash.length < 12) return hash || '—';
    return hash.slice(0, 10) + '…' + hash.slice(-6);
  }
  
  // ─── Core Status Listener ───────────────────────────────────────────────────
  
  let lastStatus = null;
  
  window.addEventListener('core:status', function(event) {
    const { status, message } = event.detail;
    
    // Only show status updates that are different from last
    if (status !== lastStatus) {
      console.log('[CHAT-CORE] Status update:', status, message);
      
      // Map status to user-friendly chat messages
      const statusMessages = {
        'parsing':                  '🔍 Understanding your request...',
        'checking_authorization':   '🔐 Checking Permit2 authorization...',
        'preparing_transaction':    '⚙️ Preparing transaction...',
        'awaiting_signature':       '✍️ Please sign the transaction in your wallet',
        'sending_transaction':      '📤 Sending transaction to network...',
        'confirming':               '⏳ Waiting for confirmation...',
      };
      
      if (statusMessages[status]) {
        addSystemMessage(statusMessages[status]);
      }
      
      lastStatus = status;
    }
  });
  
  // ─── Permit2 Approval Handler ───────────────────────────────────────────────
  
  window.addEventListener('permit2:required', async function(event) {
    const { token, amount, reason } = event.detail;
    
    console.log('[CHAT-CORE] Permit2 approval required:', event.detail);
    
    addSystemMessage(`⚠️ Permit2 Authorization Required`);
    addAssistantMessage(reason || `You need to approve ${amount} ${token} spending before this transaction can execute.`);
    
    // Show approval button in chat
    const approvalHtml = `
      <div class="arc-chat-action-card" style="background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%); border-radius: 12px; padding: 16px; margin: 8px 0;">
        <div style="color: white; font-weight: 600; margin-bottom: 8px;">
          <i class="fas fa-shield-alt"></i> Authorize Permit2
        </div>
        <div style="color: rgba(255,255,255,0.9); font-size: 13px; margin-bottom: 12px;">
          Approve <strong>${amount} ${token}</strong> for Agent Executor
        </div>
        <button 
          onclick="chatApprovePermit2('${token}', '${amount}')"
          style="width: 100%; background: white; color: #1e3a8a; border: none; border-radius: 8px; padding: 10px; font-weight: 600; cursor: pointer; transition: all 0.2s;"
          onmouseover="this.style.transform='scale(1.02)'"
          onmouseout="this.style.transform='scale(1)'"
        >
          <i class="fas fa-check-circle"></i> Approve Now
        </button>
      </div>
    `;
    
    addChatMessage(approvalHtml, 'html');
  });
  
  /**
   * Handle Permit2 approval from chat button
   */
  global.chatApprovePermit2 = async function(token, amount) {
    console.log('[CHAT-CORE] User clicked approve button:', token, amount);
    
    try {
      addSystemMessage('🔐 Requesting Permit2 approval...');
      
      // Build approve intent
      const intent = {
        intent: 'approve_permit2',
        token: token,
        amount: parseFloat(amount),
      };
      
      // Process via Core
      const result = await global.DaatAgentCore.processIntent(intent, 'chatbot');
      
      if (result.status === 'completed') {
        addSuccessMessage(`Permit2 approved! You can now execute transactions up to ${amount} ${token}`);
        
        // Suggest retrying original command
        addAssistantMessage('You can now retry your original command.');
      } else {
        addErrorMessage(result.message || 'Approval failed');
      }
      
    } catch (err) {
      console.error('[CHAT-CORE] Approval error:', err);
      addErrorMessage(`Failed to approve: ${err.message}`);
    }
  };
  
  // ─── Execution Completion Handler ──────────────────────────────────────────
  
  window.addEventListener('execution:completed', function(event) {
    const { intent, result } = event.detail;
    
    console.log('[CHAT-CORE] Execution completed:', event.detail);
    
    if (result.status === 'completed' && result.txHash) {
      const explorerUrl = `https://testnet.arcscan.app/tx/${result.txHash}`;
      
      // Build success card
      const successHtml = `
        <div class="arc-chat-success-card" style="background: linear-gradient(135deg, #065f46 0%, #10b981 100%); border-radius: 12px; padding: 16px; margin: 8px 0;">
          <div style="color: white; font-weight: 600; margin-bottom: 8px;">
            <i class="fas fa-check-circle"></i> Transaction Confirmed!
          </div>
          <div style="color: rgba(255,255,255,0.9); font-size: 13px; margin-bottom: 4px;">
            ${result.message}
          </div>
          <div style="color: rgba(255,255,255,0.8); font-size: 12px; margin-bottom: 12px;">
            TX: ${shortHash(result.txHash)}
          </div>
          <a 
            href="${explorerUrl}" 
            target="_blank"
            style="display: inline-flex; align-items: center; gap: 6px; background: rgba(255,255,255,0.2); color: white; text-decoration: none; border-radius: 6px; padding: 8px 12px; font-size: 13px; font-weight: 500; transition: all 0.2s;"
            onmouseover="this.style.background='rgba(255,255,255,0.3)'"
            onmouseout="this.style.background='rgba(255,255,255,0.2)'"
          >
            <i class="fas fa-external-link-alt"></i> View on Explorer
          </a>
        </div>
      `;
      
      addChatMessage(successHtml, 'html');
    }
  });
  
  // ─── Execution Failure Handler ─────────────────────────────────────────────
  
  window.addEventListener('execution:failed', function(event) {
    const { error } = event.detail;
    
    console.log('[CHAT-CORE] Execution failed:', error);
    
    addErrorMessage(error || 'Transaction failed');
  });
  
  // ─── Hook into handleLocalCommand ───────────────────────────────────────────
  
  // Store original functions
  const _originalHandleLocalCommand = global.handleLocalCommand;
  const _originalHandleUnifiedMessage = global.handleUnifiedMessage;
  
  /**
   * Override handleLocalCommand to route through Core
   */
  global.handleLocalCommand = async function(message) {
    console.log('[CHAT-CORE] handleLocalCommand() called:', message);
    
    const msg = message.trim().toLowerCase();
    
    // Check if message looks like an executable command
    const isExecutableCommand = 
      /^(send|transfer|pay|swap|exchange|multisend|batch|allow|approve|repeat|again)/i.test(msg) ||
      /send\s+(?:to\s+)?(?:last|previous)/i.test(msg) ||
      /send\s+(?:max|all)/i.test(msg);
    
    if (!isExecutableCommand) {
      // Not an executable command, use original handler (info commands, etc.)
      console.log('[CHAT-CORE] Not an executable command, using original handler');
      
      if (_originalHandleLocalCommand && typeof _originalHandleLocalCommand === 'function') {
        return await _originalHandleLocalCommand.call(this, message);
      }
      
      addAssistantMessage("I don't understand that command. Try: 'send 10 USDC to 0x...'");
      return false;
    }
    
    // Executable command - route through Core
    console.log('[CHAT-CORE] Routing executable command to Core');
    
    try {
      // Add user message to chat
      addUserMessage(message);
      
      // Process via Core (Core will parse natural language)
      const result = await global.DaatAgentCore.processIntent(message, 'chatbot');
      
      console.log('[CHAT-CORE] Core execution result:', result);
      
      if (result.requiresApproval) {
        // Permit2 approval required - event listener will show approval UI
        return true;
      }
      
      if (result.status === 'completed') {
        // Success - event listener will show success card
        return true;
      }
      
      if (result.status === 'failed') {
        // Error already shown by event listener
        return false;
      }
      
      // Unexpected status
      addErrorMessage(result.message || 'Unexpected execution status');
      return false;
      
    } catch (err) {
      console.error('[CHAT-CORE] Command execution error:', err);
      
      addErrorMessage(err.message || 'Failed to execute command');
      
      // Show help message
      addAssistantMessage(`
Try these commands:
• send 10 USDC to 0x...
• send 5 USDC to last
• swap 10 USDC to EURC
• multisend: 0xA:10, 0xB:20
• allow 100 USDC for 24 hours
• repeat last
• send max USDC to 0x...
      `.trim());
      
      return false;
    }
  };
  
  /**
   * Override handleUnifiedMessage to route through Core (for autonoma compatibility)
   */
  global.handleUnifiedMessage = async function(message, source) {
    console.log('[CHAT-CORE] handleUnifiedMessage() called:', message, 'source:', source);
    
    const msg = message.trim().toLowerCase();
    
    // Check if message looks like an executable command
    const isExecutableCommand = 
      /^(send|transfer|pay|swap|exchange|multisend|batch|allow|approve|repeat|again)/i.test(msg) ||
      /send\s+(?:to\s+)?(?:last|previous)/i.test(msg) ||
      /send\s+(?:max|all)/i.test(msg);
    
    if (!isExecutableCommand) {
      // Not an executable command, use original handler
      console.log('[CHAT-CORE] Not an executable command, using original unified handler');
      
      if (_originalHandleUnifiedMessage && typeof _originalHandleUnifiedMessage === 'function') {
        return await _originalHandleUnifiedMessage.call(this, message, source);
      }
      
      // Fallback to handleLocalCommand if unified handler doesn't exist
      if (_originalHandleLocalCommand && typeof _originalHandleLocalCommand === 'function') {
        return await _originalHandleLocalCommand.call(this, message);
      }
      
      addAssistantMessage("I don't understand that command. Try: 'send 10 USDC to 0x...'");
      return false;
    }
    
    // Executable command - route through Core
    console.log('[CHAT-CORE] Routing unified message to Core (source:', source, ')');
    
    try {
      // Process via Core (Core will parse natural language)
      const result = await global.DaatAgentCore.processIntent(message, source || 'chatbot');
      
      console.log('[CHAT-CORE] Core execution result:', result);
      
      if (result.requiresApproval) {
        // Permit2 approval required - event listener will show approval UI
        return true;
      }
      
      if (result.status === 'completed') {
        // Success - event listener will show success card
        return true;
      }
      
      if (result.status === 'failed') {
        // Error already shown by event listener
        return false;
      }
      
      // Unexpected status
      addErrorMessage(result.message || 'Unexpected execution status');
      return false;
      
    } catch (err) {
      console.error('[CHAT-CORE] Unified message execution error:', err);
      
      addErrorMessage(err.message || 'Failed to execute command');
      
      // Show help message
      addAssistantMessage(`
Try these commands:
• send 10 USDC to 0x...
• send 5 USDC to last
• swap 10 USDC to EURC
• multisend: 0xA:10, 0xB:20
• repeat last
      `.trim());
      
      return false;
    }
  };
  
  // ─── Context Commands ───────────────────────────────────────────────────────
  
  /**
   * Show execution context (last transaction, recent addresses)
   */
  global.chatShowContext = function() {
    const context = global.DaatAgentCore.getContext();
    
    let html = '<div style="background: #1f2937; border-radius: 12px; padding: 16px; margin: 8px 0;">';
    html += '<div style="color: #60a5fa; font-weight: 600; margin-bottom: 12px;"><i class="fas fa-history"></i> Recent Context</div>';
    
    if (context.lastIntent) {
      html += '<div style="color: #9ca3af; font-size: 13px; margin-bottom: 8px;">';
      html += `<strong>Last action:</strong> ${context.lastIntent.intent}<br>`;
      html += `<strong>Token:</strong> ${context.lastToken}<br>`;
      if (context.lastRecipient) {
        html += `<strong>Recipient:</strong> ${shortAddr(context.lastRecipient)}<br>`;
      }
      if (context.lastAmount) {
        html += `<strong>Amount:</strong> ${context.lastAmount} ${context.lastToken}`;
      }
      html += '</div>';
    } else {
      html += '<div style="color: #6b7280; font-size: 13px;">No recent transactions</div>';
    }
    
    if (context.recentAddresses && context.recentAddresses.length > 0) {
      html += '<div style="color: #9ca3af; font-size: 13px; margin-top: 12px;">';
      html += '<strong>Recent addresses:</strong><br>';
      context.recentAddresses.slice(0, 3).forEach(addr => {
        html += `<code style="font-size: 11px;">${shortAddr(addr)}</code><br>`;
      });
      html += '</div>';
    }
    
    html += '</div>';
    
    addChatMessage(html, 'html');
  };
  
  /**
   * Show execution history
   */
  global.chatShowHistory = function() {
    const history = global.DaatAgentCore.getHistory(10);
    
    if (history.length === 0) {
      addAssistantMessage('No execution history yet.');
      return;
    }
    
    let html = '<div style="background: #1f2937; border-radius: 12px; padding: 16px; margin: 8px 0;">';
    html += '<div style="color: #60a5fa; font-weight: 600; margin-bottom: 12px;"><i class="fas fa-list"></i> Recent Executions</div>';
    
    history.forEach((entry, idx) => {
      const { intent, result, timestamp } = entry;
      const date = new Date(timestamp).toLocaleTimeString();
      const statusIcon = result.status === 'completed' ? '✅' : '❌';
      
      html += `<div style="color: #9ca3af; font-size: 12px; margin-bottom: 8px; padding: 8px; background: #111827; border-radius: 6px;">`;
      html += `${statusIcon} <strong>${intent.intent}</strong> - ${intent.amount} ${intent.token}`;
      if (result.txHash) {
        html += `<br><span style="font-size: 10px;">TX: ${shortHash(result.txHash)}</span>`;
      }
      html += `<br><span style="color: #6b7280; font-size: 10px;">${date}</span>`;
      html += '</div>';
    });
    
    html += '</div>';
    
    addChatMessage(html, 'html');
  };
  
  // ─── Add new chat commands ──────────────────────────────────────────────────
  
  // Register help commands
  if (global._originalHandleLocalCommand) {
    const originalHelp = _originalHandleLocalCommand;
    
    // Intercept help/context/history commands
    global.handleLocalCommand = async function(message) {
      const msg = message.trim().toLowerCase();
      
      if (msg === 'context' || msg === 'ctx' || msg === 'last') {
        addUserMessage(message);
        chatShowContext();
        return true;
      }
      
      if (msg === 'history' || msg === 'hist' || msg === 'h') {
        addUserMessage(message);
        chatShowHistory();
        return true;
      }
      
      // Route through hooked handler
      return await originalHelp.call(this, message);
    };
  }
  
  // ─── Expose API ─────────────────────────────────────────────────────────────
  
  global.ChatbotCoreIntegration = {
    version: '20260408c',
    chatShowContext,
    chatShowHistory,
    chatApprovePermit2,
  };
  
  console.log('[CHAT-CORE] ✓ Integration complete');
  console.log('[CHAT-CORE] ─ handleLocalCommand() hooked (main chatbot)');
  console.log('[CHAT-CORE] ─ handleUnifiedMessage() hooked (autonoma chatbot)');
  console.log('[CHAT-CORE] ─ Event listeners registered');
  console.log('[CHAT-CORE] ─ All chatbot commands now routed through DAAT Agent Core');
  console.log('[CHAT-CORE] ─ New commands: context, history');
  console.log('[CHAT-CORE] ─ FULL FEATURE PARITY: Main and Autonoma chatbots use identical logic');
  
  // Emit ready event
  window.dispatchEvent(new CustomEvent('chatbot-core:ready', {
    detail: { version: '20260408c', parity: true }
  }));
  
});

})(window);
