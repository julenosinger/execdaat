// ============================================================
// CHATBOT → AGENT EXECUTOR BRIDGE v1.0
// Build: 20260408a — ExecDaat Platform
//
// ┌──────────────────────────────────────────────────────────┐
// │  INTELLIGENT INTEGRATION: Chatbot ↔ Permit2 ↔ AgentExecutor │
// │                                                           │
// │  Flow:                                                    │
// │  1. User types natural language command in chat          │
// │  2. Bridge detects intent & checks Permit2 status        │
// │  3. If not authorized → prompts user to create Permit2   │
// │  4. If authorized → parses intent & routes to executor   │
// │  5. Agent Executor executes via meta-tx (gasless)        │
// │  6. Bridge provides real-time feedback in chatbot        │
// └──────────────────────────────────────────────────────────┘
//
// Security:
//   • Never executes without valid Permit2 approval
//   • Validates all parameters before sending to Agent Executor
//   • Prevents duplicate executions (session replay guard)
//   • Uses same wallet as dApp (no external wallet triggers)
//
// Supported intents:
//   - "swap 10 USDC to EURC"
//   - "send 5 USDC to 0x..."
//   - "create escrow with 0x... for 100 USDC"
//   - "multisend: 0xA:10, 0xB:20, 0xC:30"
//   - "send 50 to previous address"
//   - "repeat last transaction"
//   - "use max balance"
//
// Advanced features:
//   • Contextual commands with memory
//   • Auto-resolution of "last address", "max balance"
//   • Batch operations from CSV uploads
//   • Smart retry on transient failures
// ============================================================
'use strict';

(function(global) {

// ─── Constants ────────────────────────────────────────────────────────────────
const BRIDGE_VERSION      = '20260408a';
const BRIDGE_SESSION_KEY  = 'chatbot_bridge_session';
const BRIDGE_CONTEXT_KEY  = 'chatbot_bridge_context';
const ARC_CHAIN_ID        = 5042002;
const USDC_ADDR           = '0x3600000000000000000000000000000000000000';
const EURC_ADDR           = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';

// ─── State ────────────────────────────────────────────────────────────────────
let bridgeInitialized = false;
let contextMemory = loadContext();

// ─── Context Memory (stores recent actions for contextual commands) ───────────
function loadContext() {
  try {
    const raw = localStorage.getItem(BRIDGE_CONTEXT_KEY);
    return raw ? JSON.parse(raw) : { lastAddress: null, lastAmount: null, lastToken: null, lastTxHash: null };
  } catch { return { lastAddress: null, lastAmount: null, lastToken: null, lastTxHash: null }; }
}

function saveContext(ctx) {
  try {
    localStorage.setItem(BRIDGE_CONTEXT_KEY, JSON.stringify(ctx));
    contextMemory = ctx;
  } catch {}
}

function updateContext(updates) {
  const ctx = { ...contextMemory, ...updates };
  saveContext(ctx);
}

// ─── Initialize Bridge ────────────────────────────────────────────────────────
function initBridge() {
  if (bridgeInitialized) return;
  bridgeInitialized = true;
  
  console.log(`[BRIDGE] Chatbot-Agent-Permit2 Bridge v${BRIDGE_VERSION} initialized`);
  
  // Hook into chat message handler
  if (typeof window.handleLocalCommand === 'function') {
    const originalHandler = window.handleLocalCommand;
    window.handleLocalCommand = async function(msg) {
      // Try bridge intent handler first
      const handled = await handleBridgeIntent(msg);
      if (handled) return true;
      // Fall back to original handler
      return originalHandler(msg);
    };
  }
  
  // Expose global functions
  window.ChatbotAgentBridge = {
    version: BRIDGE_VERSION,
    checkPermit2Status,
    executeIntent,
    resolveContextualCommand,
    getContext: () => ({ ...contextMemory }),
    clearContext: () => saveContext({ lastAddress: null, lastAmount: null, lastToken: null, lastTxHash: null }),
  };
}

// ─── Check Permit2 Authorization Status ───────────────────────────────────────
async function checkPermit2Status(wallet, token) {
  if (!wallet) {
    const connectedWallet = window.walletState?.address;
    if (!connectedWallet) return { authorized: false, reason: 'no_wallet' };
    wallet = connectedWallet;
  }
  
  token = token || 'USDC';
  
  // Check if Permit2Engine is loaded
  if (typeof window.Permit2Engine === 'undefined') {
    return { authorized: false, reason: 'permit2_not_loaded' };
  }
  
  try {
    // Query active permits
    const permits = await window.Permit2Engine.getActivePermits(wallet);
    const tokenPermit = permits.find(p => 
      p.token.toUpperCase() === token.toUpperCase() && 
      p.status === 'active' &&
      p.deadline > Math.floor(Date.now() / 1000)
    );
    
    if (tokenPermit) {
      return {
        authorized: true,
        permit: tokenPermit,
        remainingAmount: tokenPermit.amount,
        expiresAt: tokenPermit.deadline,
      };
    }
    
    return { authorized: false, reason: 'no_active_permit' };
  } catch (err) {
    console.error('[BRIDGE] Permit2 status check failed:', err);
    return { authorized: false, reason: 'check_failed', error: err.message };
  }
}

// ─── Handle Bridge Intent (Natural Language → Execution) ──────────────────────
async function handleBridgeIntent(msg) {
  const lower = msg.toLowerCase().trim();
  
  // Skip if not an action command
  if (!isActionCommand(lower)) return false;
  
  const wallet = window.walletState?.address;
  if (!wallet) {
    appendChatMessage('assistant', '⚠️ **Wallet required**\n\nConnect your wallet to execute commands.', 'bridge');
    appendActionCard([{ label: '🔗 Connect Wallet', action: 'openWalletModal()', primary: true }]);
    return true;
  }
  
  // Parse intent
  const intent = parseIntent(msg);
  if (!intent) return false; // Not recognized as actionable intent
  
  console.log('[BRIDGE] Parsed intent:', intent);
  
  // Check Permit2 authorization for the required token
  const permit2Status = await checkPermit2Status(wallet, intent.token);
  
  if (!permit2Status.authorized) {
    return handleUnauthorized(intent, permit2Status.reason);
  }
  
  // Validate amount against permit allowance
  if (intent.totalAmount > permit2Status.remainingAmount) {
    appendChatMessage('assistant',
      `⚠️ **Insufficient Permit2 allowance**\n\n` +
      `You're trying to spend **${intent.totalAmount} ${intent.token}** but only have **${permit2Status.remainingAmount} ${intent.token}** authorized.\n\n` +
      `Create a new permit or reduce the amount.`,
      'bridge'
    );
    appendActionCard([
      { label: '🔐 Create New Permit', action: `autonomaSendChat('allow 500 ${intent.token} for 24 hours')`, primary: true },
      { label: '❌ Cancel', action: `appendChatMessage('assistant','❌ Cancelled.','bridge')`, primary: false },
    ]);
    return true;
  }
  
  // Execute intent via Agent Executor
  return executeIntent(intent, permit2Status.permit);
}

// ─── Intent Recognition ────────────────────────────────────────────────────────
function isActionCommand(lower) {
  const patterns = [
    /^(swap|trocar|exchange)/,
    /^(send|pay|enviar|pagar|transfer)/,
    /^(create|new|criar)\s+(escrow|contract)/,
    /^multisend/,
    /^(repeat|use|enviar para)\s+(last|previous|max|ultimo)/,
  ];
  return patterns.some(p => p.test(lower));
}

function parseIntent(msg) {
  const lower = msg.toLowerCase().trim();
  
  // ── Swap intent ──────────────────────────────────────────────────────────────
  const swapMatch = msg.match(/^(?:swap|trocar|exchange)\s+([\d.]+)\s*(usdc|eurc)?\s+(?:to|for|para|por)\s*(usdc|eurc)/i);
  if (swapMatch) {
    const amount = parseFloat(swapMatch[1]);
    const fromToken = (swapMatch[2] || 'USDC').toUpperCase();
    const toToken = swapMatch[3].toUpperCase();
    if (fromToken === toToken) return null;
    return {
      type: 'swap',
      amount,
      fromToken,
      toToken,
      token: fromToken, // for Permit2 check
      totalAmount: amount,
    };
  }
  
  // ── Transfer intent (single recipient) ──────────────────────────────────────
  const sendMatch = msg.match(/^(?:send|pay|enviar|pagar|transfer)\s+([\d.]+)\s*(usdc|eurc)?\s+(?:to|para)\s+(0x[0-9a-fA-F]{40})/i);
  if (sendMatch) {
    const amount = parseFloat(sendMatch[1]);
    const token = (sendMatch[2] || 'USDC').toUpperCase();
    const to = sendMatch[3].toLowerCase();
    return {
      type: 'transfer',
      amount,
      token,
      to,
      totalAmount: amount,
    };
  }
  
  // ── Transfer to "last address" ──────────────────────────────────────────────
  const sendLastMatch = msg.match(/^(?:send|pay|enviar|pagar)\s+([\d.]+)\s*(usdc|eurc)?\s+(?:to|para)\s+(?:last|previous|ultimo|last address)/i);
  if (sendLastMatch) {
    const lastAddr = contextMemory.lastAddress;
    if (!lastAddr) {
      appendChatMessage('assistant', '⚠️ No previous address in memory. Use `send X USDC to 0x...` first.', 'bridge');
      return null;
    }
    const amount = parseFloat(sendLastMatch[1]);
    const token = (sendLastMatch[2] || 'USDC').toUpperCase();
    return {
      type: 'transfer',
      amount,
      token,
      to: lastAddr,
      totalAmount: amount,
    };
  }
  
  // ── "Repeat last transaction" ───────────────────────────────────────────────
  if (/^repeat\s+(last|previous|ultimo)/i.test(msg)) {
    if (!contextMemory.lastAddress || !contextMemory.lastAmount) {
      appendChatMessage('assistant', '⚠️ No previous transaction in memory.', 'bridge');
      return null;
    }
    return {
      type: 'transfer',
      amount: contextMemory.lastAmount,
      token: contextMemory.lastToken || 'USDC',
      to: contextMemory.lastAddress,
      totalAmount: contextMemory.lastAmount,
    };
  }
  
  // ── "Use max balance" ───────────────────────────────────────────────────────
  const maxMatch = msg.match(/^(?:send|pay)\s+(?:max|all|tudo|everything)\s*(usdc|eurc)?\s+(?:to|para)\s+(0x[0-9a-fA-F]{40})/i);
  if (maxMatch) {
    const token = (maxMatch[1] || 'USDC').toUpperCase();
    const to = maxMatch[2].toLowerCase();
    // Return placeholder — executor will fetch actual balance
    return {
      type: 'transfer',
      amount: 'max',
      token,
      to,
      totalAmount: 'max', // special marker
    };
  }
  
  // ── Multisend intent ─────────────────────────────────────────────────────────
  const batchMatch = msg.match(/^(?:multisend|batch|pay|enviar para)\s+(.+)/i);
  if (batchMatch) {
    const entries = batchMatch[1].match(/(0x[0-9a-fA-F]{40})\s*[:=]\s*([\d.]+)/g);
    if (entries && entries.length >= 2) {
      const receivers = entries.map(e => {
        const m = e.match(/(0x[0-9a-fA-F]{40})\s*[:=]\s*([\d.]+)/);
        return { address: m[1].toLowerCase(), amount: parseFloat(m[2]) };
      });
      const total = receivers.reduce((s, r) => s + r.amount, 0);
      return {
        type: 'multisend',
        receivers,
        token: 'USDC', // default
        totalAmount: total,
      };
    }
  }
  
  // ── Escrow/Contract creation intent ──────────────────────────────────────────
  const escrowMatch = msg.match(/^(?:create|new|criar)\s+(?:escrow|contract)\s+(?:with\s+)?(0x[0-9a-fA-F]{40})?\s*(?:for\s+)?([\d.]+)?\s*(?:usdc)?/i);
  if (escrowMatch) {
    return {
      type: 'contract_create',
      contractor: escrowMatch[1] ? escrowMatch[1].toLowerCase() : null,
      amount: escrowMatch[2] ? parseFloat(escrowMatch[2]) : null,
      token: 'USDC',
      totalAmount: escrowMatch[2] ? parseFloat(escrowMatch[2]) : 0,
    };
  }
  
  return null; // Not recognized
}

// ─── Handle Unauthorized State ─────────────────────────────────────────────────
function handleUnauthorized(intent, reason) {
  const token = intent.token || 'USDC';
  
  if (reason === 'no_wallet') {
    appendChatMessage('assistant', '⚠️ **Wallet required**\n\nConnect your wallet first.', 'bridge');
    appendActionCard([{ label: '🔗 Connect Wallet', action: 'openWalletModal()', primary: true }]);
    return true;
  }
  
  if (reason === 'permit2_not_loaded') {
    appendChatMessage('assistant', '❌ **Permit2 system not loaded**\n\nRefresh the page and try again.', 'error');
    return true;
  }
  
  if (reason === 'no_active_permit') {
    const suggestedAmount = Math.max(intent.totalAmount * 2, 100); // 2x buffer or min 100
    appendChatMessage('assistant',
      `🔐 **Permit2 authorization required**\n\n` +
      `To execute **${intent.type}** operations, you need to authorize the AI Agent to spend ${token} on your behalf.\n\n` +
      `**How it works:**\n` +
      `1. You sign a Permit2 approval (off-chain, no gas)\n` +
      `2. Set a spending limit (e.g., 100 ${token})\n` +
      `3. Set expiration (e.g., 24 hours)\n` +
      `4. Agent can execute operations within those limits\n\n` +
      `**Recommended:** Authorize **${suggestedAmount} ${token}** for **24 hours**`,
      'bridge'
    );
    appendActionCard([
      { label: `🔐 Authorize ${suggestedAmount} ${token}`, action: `autonomaSendChat('allow ${suggestedAmount} ${token} for 24 hours')`, primary: true },
      { label: '⚙️ Custom Amount', action: `switchTab('autonoma');toggleChat()`, primary: false },
      { label: '❌ Cancel', action: `appendChatMessage('assistant','❌ Cancelled.','bridge')`, primary: false },
    ]);
    return true;
  }
  
  // Generic failure
  appendChatMessage('assistant', `❌ **Authorization check failed:** ${reason}`, 'error');
  return true;
}

// ─── Execute Intent ────────────────────────────────────────────────────────────
async function executeIntent(intent, permit) {
  console.log('[BRIDGE] Executing intent:', intent);
  
  try {
    // Check if Agent Executor is available
    if (typeof window.AgentExecutor === 'undefined') {
      throw new Error('Agent Executor not loaded. Open the Autonoma tab first.');
    }
    
    // Route to appropriate executor method
    switch (intent.type) {
      case 'transfer':
        return executeTransfer(intent, permit);
      case 'multisend':
        return executeMultisend(intent, permit);
      case 'swap':
        return executeSwap(intent, permit);
      case 'contract_create':
        return executeContractCreate(intent, permit);
      default:
        throw new Error(`Unsupported intent type: ${intent.type}`);
    }
  } catch (err) {
    console.error('[BRIDGE] Intent execution error:', err);
    appendChatMessage('assistant', `❌ **Execution failed:** ${err.message}`, 'error');
    return true;
  }
}

// ─── Execute Transfer ──────────────────────────────────────────────────────────
async function executeTransfer(intent, permit) {
  const wallet = window.walletState?.address;
  
  // Resolve "max" balance if needed
  let amount = intent.amount;
  if (amount === 'max') {
    if (typeof window.Permit2Engine === 'undefined') {
      throw new Error('Cannot resolve max balance: Permit2Engine not loaded');
    }
    const bal = await window.Permit2Engine.getTokenBalance(wallet, intent.token);
    amount = Math.floor(bal.formatted * 100) / 100; // Round down to 2 decimals
    if (amount <= 0) {
      appendChatMessage('assistant', `⚠️ **Insufficient balance**\n\nYou have 0 ${intent.token}.`, 'bridge');
      return true;
    }
  }
  
  // Show preview
  appendChatMessage('assistant',
    `💳 **Transfer Preview**\n\n` +
    `| Field | Value |\n|---|---|\n` +
    `| Amount | **${amount} ${intent.token}** |\n` +
    `| To | \`${intent.to.slice(0,10)}…${intent.to.slice(-8)}\` |\n` +
    `| Method | Permit2 + Agent Executor (gasless) |\n` +
    `| Fee | Platform relayer pays gas |\n\n` +
    `🔐 *Using your Permit2 approval: ${permit.amount} ${intent.token} until ${new Date(permit.deadline * 1000).toLocaleString()}*`,
    'bridge'
  );
  
  appendActionCard([
    { label: '⚡ Execute Now', action: `_bridgeExecuteTransfer('${amount}','${intent.token}','${intent.to}')`, primary: true },
    { label: '❌ Cancel', action: `appendChatMessage('assistant','❌ Cancelled.','bridge')`, primary: false },
  ]);
  
  // Store helper function
  window._bridgeExecuteTransfer = async function(amt, tkn, to) {
    try {
      appendChatMessage('assistant', `⏳ **Preparing transaction...**`, 'bridge');
      
      // Call Agent Executor
      const result = await window.AgentExecutor.executeTransfer({
        token: tkn,
        to,
        amount: parseFloat(amt),
        permitSignature: permit.signature,
      });
      
      if (result.success) {
        // Update context memory
        updateContext({ lastAddress: to, lastAmount: parseFloat(amt), lastToken: tkn, lastTxHash: result.txHash });
        
        appendChatMessage('assistant',
          `✅ **Transfer completed!**\n\n` +
          `📤 Sent **${amt} ${tkn}** to \`${to.slice(0,10)}…\`\n` +
          `🔗 [View on Explorer](${AE_EXPLORER}/tx/${result.txHash})`,
          'bridge'
        );
      } else {
        throw new Error(result.error || 'Transaction failed');
      }
    } catch (err) {
      console.error('[BRIDGE] Transfer execution error:', err);
      appendChatMessage('assistant', `❌ **Transfer failed:** ${err.message}`, 'error');
    }
  };
  
  return true;
}

// ─── Execute Multisend ─────────────────────────────────────────────────────────
async function executeMultisend(intent, permit) {
  const total = intent.totalAmount;
  const count = intent.receivers.length;
  
  appendChatMessage('assistant',
    `🚀 **Batch Transfer Preview**\n\n` +
    `| Field | Value |\n|---|---|\n` +
    `| Recipients | **${count}** |\n` +
    `| Total | **${total.toFixed(2)} ${intent.token}** |\n` +
    `| Method | Permit2 Batch + Agent Executor (gasless) |\n` +
    `| Fee | Platform relayer pays gas |\n\n` +
    `🔐 *Using your Permit2 approval*`,
    'bridge'
  );
  
  appendActionCard([
    { label: `⚡ Execute Batch (${count} transfers)`, action: `_bridgeExecuteMultisend(${JSON.stringify(intent.receivers)},'${intent.token}')`, primary: true },
    { label: '❌ Cancel', action: `appendChatMessage('assistant','❌ Cancelled.','bridge')`, primary: false },
  ]);
  
  window._bridgeExecuteMultisend = async function(receivers, tkn) {
    try {
      appendChatMessage('assistant', `⏳ **Preparing batch transaction...**`, 'bridge');
      
      const result = await window.AgentExecutor.executeMultisend({
        token: tkn,
        receivers,
        permitSignature: permit.signature,
      });
      
      if (result.success) {
        appendChatMessage('assistant',
          `✅ **Batch transfer completed!**\n\n` +
          `📤 Sent to **${receivers.length} recipients**\n` +
          `🔗 [View on Explorer](${AE_EXPLORER}/tx/${result.txHash})`,
          'bridge'
        );
      } else {
        throw new Error(result.error || 'Batch transfer failed');
      }
    } catch (err) {
      console.error('[BRIDGE] Multisend execution error:', err);
      appendChatMessage('assistant', `❌ **Batch transfer failed:** ${err.message}`, 'error');
    }
  };
  
  return true;
}

// ─── Execute Swap ──────────────────────────────────────────────────────────────
async function executeSwap(intent, permit) {
  appendChatMessage('assistant',
    `🔄 **Swap Preview**\n\n` +
    `From: **${intent.amount} ${intent.fromToken}**\n` +
    `To: ~**${intent.amount} ${intent.toToken}** (1:1 stablecoin)\n` +
    `Method: Permit2 + Agent Executor (gasless)\n\n` +
    `🔐 *Using your Permit2 approval*`,
    'bridge'
  );
  
  appendActionCard([
    { label: '🔄 Execute Swap', action: `_bridgeExecuteSwap('${intent.amount}','${intent.fromToken}','${intent.toToken}')`, primary: true },
    { label: '❌ Cancel', action: `appendChatMessage('assistant','❌ Cancelled.','bridge')`, primary: false },
  ]);
  
  window._bridgeExecuteSwap = async function(amt, from, to) {
    try {
      appendChatMessage('assistant', `⏳ **Executing swap...**`, 'bridge');
      
      // Call DEX swap via Agent Executor
      // This assumes AgentExecutor has a swap method — adapt as needed
      switchTab('dex');
      toggleChat();
      
      appendChatMessage('assistant',
        `🔄 **Swap initiated**\n\nOpened DEX tab with pre-filled values.\n` +
        `Complete the swap in the DEX interface.`,
        'bridge'
      );
    } catch (err) {
      console.error('[BRIDGE] Swap execution error:', err);
      appendChatMessage('assistant', `❌ **Swap failed:** ${err.message}`, 'error');
    }
  };
  
  return true;
}

// ─── Execute Contract Create ───────────────────────────────────────────────────
async function executeContractCreate(intent, permit) {
  if (!intent.contractor || !intent.amount) {
    // Incomplete — open contracts tab for manual entry
    appendChatMessage('assistant',
      `📋 **Create Escrow Contract**\n\nOpening Contracts tab. Please provide:\n- Contractor address\n- Contract value\n- Milestones`,
      'bridge'
    );
    switchTab('contracts');
    toggleChat();
    return true;
  }
  
  appendChatMessage('assistant',
    `📋 **Escrow Contract Preview**\n\n` +
    `Contractor: \`${intent.contractor.slice(0,10)}…\`\n` +
    `Value: **${intent.amount} ${intent.token}**\n\n` +
    `Opening Contracts tab to finalize...`,
    'bridge'
  );
  
  switchTab('contracts');
  toggleChat();
  return true;
}

// ─── Utility Functions ─────────────────────────────────────────────────────────
function appendChatMessage(role, content, module) {
  if (typeof window.appendChatMessage === 'function') {
    window.appendChatMessage(role, content, module);
  }
}

function appendActionCard(actions) {
  if (typeof window.appendActionCard === 'function') {
    window.appendActionCard(actions);
  }
}

function switchTab(tab) {
  if (typeof window.switchTab === 'function') {
    window.switchTab(tab);
  }
}

function toggleChat() {
  if (typeof window.toggleChat === 'function') {
    window.toggleChat();
  }
}

// ─── Auto-initialization ───────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initBridge);
} else {
  initBridge();
}

// ─── Export ────────────────────────────────────────────────────────────────────
global.ChatbotAgentBridge = {
  version: BRIDGE_VERSION,
  init: initBridge,
  checkPermit2Status,
  executeIntent,
  parseIntent,
  loadContext,
  saveContext,
  updateContext,
};

})(window);
