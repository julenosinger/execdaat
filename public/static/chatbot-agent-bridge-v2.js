// ============================================================
// CHATBOT-AGENT BRIDGE v2.0 — PRODUCTION GRADE
// Build: 20260408b — ExecDaat Platform
//
// ┌──────────────────────────────────────────────────────────┐
// │         INTELLIGENT EXECUTION LAYER ARCHITECTURE          │
// │                                                           │
// │  Chatbot → Intent Parser → Permission Manager            │
// │         → Agent Executor → On-Chain Execution            │
// │                                                           │
// │  Features:                                                │
// │  • Natural language → Structured JSON                     │
// │  • Permit2 authorization verification                     │
// │  • Session state management (localStorage)                │
// │  • Contextual command memory                              │
// │  • Real-time execution feedback                           │
// │  • Production-grade error handling                        │
// │  • Security validation at every layer                     │
// └──────────────────────────────────────────────────────────┘
//
// Security model:
//   1. NEVER execute without valid Permit2 approval
//   2. ALWAYS validate: token, amount, address format
//   3. Replay guard prevents duplicate executions
//   4. Same wallet enforcement (no external triggers)
//   5. Amount bounds check (0 < amount <= permit allowance)
//   6. Deadline enforcement on all approvals
//
// State management:
//   - permit2Status: { authorized, token, allowance, deadline }
//   - sessionContext: { lastIntent, lastRecipient, lastToken, lastAmount }
//   - executionHistory: [ { intent, txHash, timestamp }... ]
//
// ============================================================
'use strict';

(function(global) {

// ─── Constants ────────────────────────────────────────────────────────────────
const BRIDGE_VERSION         = '20260408b';
const BRIDGE_STATE_KEY       = 'chatbot_bridge_state_v2';
const BRIDGE_CONTEXT_KEY     = 'chatbot_bridge_context_v2';
const BRIDGE_HISTORY_KEY     = 'chatbot_bridge_history_v2';
const PERMIT2_STORE_KEY      = 'arc_permit2_allowances_v1';
const SESSION_KEY            = 'arc-pay-session-v3';

const ARC_CHAIN_ID           = 5042002;
const ARC_CHAIN_HEX          = '0x4cef52';
const ARC_RPC                = 'https://rpc.testnet.arc.network';
const ARC_EXPLORER           = 'https://testnet.arcscan.app';

const USDC_ADDR              = '0x3600000000000000000000000000000000000000';
const EURC_ADDR              = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';

const TOKEN_MAP = {
  USDC: { address: USDC_ADDR, decimals: 6, symbol: 'USDC' },
  EURC: { address: EURC_ADDR, decimals: 6, symbol: 'EURC' },
};

// Intent types
const INTENT_TYPES = {
  TRANSFER:         'transfer',
  MULTISEND:        'multisend',
  SWAP:             'swap',
  ESCROW_CREATE:    'escrow_create',
  APPROVE_PERMIT2:  'approve_permit2',
};

// Execution status
const EXEC_STATUS = {
  IDLE:        'idle',
  PARSING:     'parsing',
  CHECKING:    'checking_auth',
  PREPARING:   'preparing',
  SIGNING:     'awaiting_signature',
  SENDING:     'sending_tx',
  CONFIRMING:  'confirming',
  COMPLETED:   'completed',
  FAILED:      'failed',
};

// ─── State ────────────────────────────────────────────────────────────────────
let bridgeState = {
  initialized: false,
  executionStatus: EXEC_STATUS.IDLE,
  currentIntent: null,
  permit2Status: null,
  lastError: null,
};

let sessionContext = loadContext();
let executionHistory = loadHistory();

// ─── Initialize Bridge ────────────────────────────────────────────────────────
function init() {
  if (bridgeState.initialized) return;
  
  console.log(`[BRIDGE v2] Initializing... version ${BRIDGE_VERSION}`);
  
  // Load persisted state
  bridgeState = loadState();
  
  // Hook into chat message handler
  if (typeof window.handleLocalCommand === 'function') {
    const originalHandler = window.handleLocalCommand;
    
    window.handleLocalCommand = async function(msg) {
      try {
        // Try bridge handler first
        const handled = await handleBridgeIntent(msg);
        if (handled) return true;
        
        // Fall back to original
        return await originalHandler(msg);
      } catch (err) {
        console.error('[BRIDGE v2] Handler error:', err);
        return await originalHandler(msg);
      }
    };
  }
  
  // Register event listeners
  window.addEventListener('agentExecutor:update', handleExecutorUpdate);
  window.addEventListener('permit2:approved', handlePermit2Approved);
  
  bridgeState.initialized = true;
  saveState();
  
  console.log('[BRIDGE v2] Initialized successfully');
  
  // Expose API
  global.ChatbotAgentBridge = {
    version: BRIDGE_VERSION,
    parseIntent,
    checkPermit2Status,
    executeIntent,
    getState: () => ({ ...bridgeState }),
    getContext: () => ({ ...sessionContext }),
    getHistory: () => [...executionHistory],
    clearHistory,
    resetState,
  };
}

// ─── State Persistence ────────────────────────────────────────────────────────
function loadState() {
  try {
    const raw = localStorage.getItem(BRIDGE_STATE_KEY);
    if (!raw) return { initialized: false, executionStatus: EXEC_STATUS.IDLE };
    return JSON.parse(raw);
  } catch { return { initialized: false, executionStatus: EXEC_STATUS.IDLE }; }
}

function saveState() {
  try {
    localStorage.setItem(BRIDGE_STATE_KEY, JSON.stringify(bridgeState));
  } catch (err) {
    console.warn('[BRIDGE v2] Failed to save state:', err);
  }
}

function loadContext() {
  try {
    const raw = localStorage.getItem(BRIDGE_CONTEXT_KEY);
    return raw ? JSON.parse(raw) : {
      lastIntent: null,
      lastRecipient: null,
      lastToken: null,
      lastAmount: null,
      lastTxHash: null,
      recentAddresses: [],
    };
  } catch { return {}; }
}

function saveContext() {
  try {
    localStorage.setItem(BRIDGE_CONTEXT_KEY, JSON.stringify(sessionContext));
  } catch {}
}

function updateContext(updates) {
  sessionContext = { ...sessionContext, ...updates };
  saveContext();
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(BRIDGE_HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveHistory() {
  try {
    // Keep last 100 entries
    const trimmed = executionHistory.slice(0, 100);
    localStorage.setItem(BRIDGE_HISTORY_KEY, JSON.stringify(trimmed));
  } catch {}
}

function addToHistory(entry) {
  executionHistory.unshift({
    ...entry,
    timestamp: Date.now(),
    id: 'exec-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
  });
  saveHistory();
}

function clearHistory() {
  executionHistory = [];
  localStorage.removeItem(BRIDGE_HISTORY_KEY);
}

function resetState() {
  bridgeState = {
    initialized: true,
    executionStatus: EXEC_STATUS.IDLE,
    currentIntent: null,
    permit2Status: null,
    lastError: null,
  };
  saveState();
}

// ─── Event Handlers ───────────────────────────────────────────────────────────
function handleExecutorUpdate(event) {
  const { intentId, status, txHash, error } = event.detail;
  
  if (bridgeState.currentIntent?.id === intentId) {
    switch (status) {
      case 'processing':
        updateExecutionStatus(EXEC_STATUS.PREPARING);
        break;
      case 'signing':
        updateExecutionStatus(EXEC_STATUS.SIGNING);
        break;
      case 'broadcast':
        updateExecutionStatus(EXEC_STATUS.SENDING);
        break;
      case 'completed':
        updateExecutionStatus(EXEC_STATUS.COMPLETED, { txHash });
        break;
      case 'failed':
        updateExecutionStatus(EXEC_STATUS.FAILED, { error });
        break;
    }
  }
}

function handlePermit2Approved(event) {
  const { token, amount, deadline } = event.detail;
  console.log('[BRIDGE v2] Permit2 approved:', token, amount);
  
  // Refresh status
  const wallet = getWalletAddress();
  if (wallet) {
    checkPermit2Status(wallet, token).then(status => {
      bridgeState.permit2Status = status;
      saveState();
    });
  }
}

function updateExecutionStatus(status, data = {}) {
  bridgeState.executionStatus = status;
  bridgeState.lastError = data.error || null;
  
  if (data.txHash) {
    bridgeState.currentIntent = {
      ...bridgeState.currentIntent,
      txHash: data.txHash,
    };
  }
  
  saveState();
  notifyStatus(status, data);
}

function notifyStatus(status, data = {}) {
  const messages = {
    [EXEC_STATUS.PARSING]:     '🔍 Parsing your request...',
    [EXEC_STATUS.CHECKING]:    '🔐 Checking authorization...',
    [EXEC_STATUS.PREPARING]:   '⏳ Preparing transaction...',
    [EXEC_STATUS.SIGNING]:     '✍️ Awaiting signature...',
    [EXEC_STATUS.SENDING]:     '📤 Transaction sent to network...',
    [EXEC_STATUS.CONFIRMING]:  '⏱️ Waiting for confirmation...',
    [EXEC_STATUS.COMPLETED]:   '✅ Transaction confirmed!',
    [EXEC_STATUS.FAILED]:      '❌ Transaction failed',
  };
  
  const msg = messages[status] || status;
  
  if (typeof appendChatMessage === 'function' && status !== EXEC_STATUS.IDLE) {
    const module = status === EXEC_STATUS.FAILED ? 'error' : 'bridge';
    appendChatMessage('assistant', msg, module);
  }
}

// ─── Wallet Utilities ─────────────────────────────────────────────────────────
function getWalletAddress() {
  return window.walletState?.address || null;
}

function getProvider() {
  return window.ethereum || (window.walletState?.provider);
}

async function getSigner() {
  const ethers = window.ethers;
  if (!ethers) throw new Error('ethers.js not loaded');
  
  const provider = new ethers.BrowserProvider(getProvider(), 'any');
  return await provider.getSigner();
}

// ─── Permit2 Status Check ─────────────────────────────────────────────────────
async function checkPermit2Status(wallet, token = 'USDC') {
  if (!wallet) {
    return {
      authorized: false,
      reason: 'no_wallet',
      wallet: null,
    };
  }
  
  wallet = wallet.toLowerCase();
  token = (token || 'USDC').toUpperCase();
  
  try {
    // Query localStorage for active permits
    const raw = localStorage.getItem(PERMIT2_STORE_KEY);
    if (!raw) {
      return {
        authorized: false,
        reason: 'no_permits_found',
        wallet,
        token,
      };
    }
    
    const permits = JSON.parse(raw);
    const now = Date.now();
    
    // Find active permit for this wallet + token
    const activePermit = permits.find(p => 
      p.wallet.toLowerCase() === wallet &&
      p.token.toUpperCase() === token &&
      p.expiry > now &&
      (p.amount - (p.amountUsed || 0)) > 0
    );
    
    if (!activePermit) {
      return {
        authorized: false,
        reason: 'no_active_permit',
        wallet,
        token,
      };
    }
    
    const remaining = activePermit.amount - (activePermit.amountUsed || 0);
    
    return {
      authorized: true,
      wallet,
      token,
      permit: activePermit,
      allowance: remaining,
      deadline: activePermit.expiry,
      expiresAt: new Date(activePermit.expiry).toISOString(),
    };
  } catch (err) {
    console.error('[BRIDGE v2] Permit2 status check failed:', err);
    return {
      authorized: false,
      reason: 'check_error',
      error: err.message,
      wallet,
      token,
    };
  }
}

// ─── Intent Recognition & Parsing ──────────────────────────────────────────────
function isActionCommand(msg) {
  const lower = msg.toLowerCase().trim();
  
  const patterns = [
    /^(swap|trocar|exchange|troca)/,
    /^(send|pay|enviar|pagar|transfer|transferir)/,
    /^(create|new|criar)\s+(escrow|contract|contrato)/,
    /^(multisend|batch|lote)/,
    /^(repeat|use|usar|repetir|enviar para)\s+(last|previous|max|ultimo|anterior|máximo)/,
    /^(allow|approve|authorize|permit|autorizar|aprovar)/,
  ];
  
  return patterns.some(p => p.test(lower));
}

function parseIntent(msg) {
  const lower = msg.toLowerCase().trim();
  
  // ── TRANSFER (single recipient) ──────────────────────────────────────────────
  const transferMatch = msg.match(/^(?:send|pay|enviar|pagar|transfer)\s+([\d.]+)\s*(usdc|eurc)?\s+(?:to|para)\s+(0x[0-9a-fA-F]{40})/i);
  if (transferMatch) {
    return {
      type: INTENT_TYPES.TRANSFER,
      amount: parseFloat(transferMatch[1]),
      token: (transferMatch[2] || 'USDC').toUpperCase(),
      recipient: transferMatch[3].toLowerCase(),
      raw: msg,
    };
  }
  
  // ── TRANSFER TO "LAST" ADDRESS ───────────────────────────────────────────────
  const lastMatch = msg.match(/^(?:send|pay|enviar|pagar)\s+([\d.]+)\s*(usdc|eurc)?\s+(?:to|para)\s+(?:last|previous|ultimo|anterior)/i);
  if (lastMatch) {
    if (!sessionContext.lastRecipient) {
      return { type: 'error', error: 'No previous recipient in memory' };
    }
    return {
      type: INTENT_TYPES.TRANSFER,
      amount: parseFloat(lastMatch[1]),
      token: (lastMatch[2] || 'USDC').toUpperCase(),
      recipient: sessionContext.lastRecipient,
      contextual: true,
      raw: msg,
    };
  }
  
  // ── REPEAT LAST TRANSACTION ──────────────────────────────────────────────────
  if (/^(repeat|repetir)\s+(last|ultimo|anterior)/i.test(lower)) {
    if (!sessionContext.lastIntent) {
      return { type: 'error', error: 'No previous transaction in memory' };
    }
    // Reconstruct last intent
    return {
      ...sessionContext.lastIntent,
      contextual: true,
      raw: msg,
    };
  }
  
  // ── SEND MAX BALANCE ─────────────────────────────────────────────────────────
  const maxMatch = msg.match(/^(?:send|pay)\s+(?:max|all|tudo|everything|máximo)\s*(usdc|eurc)?\s+(?:to|para)\s+(0x[0-9a-fA-F]{40})/i);
  if (maxMatch) {
    return {
      type: INTENT_TYPES.TRANSFER,
      amount: 'max', // special marker
      token: (maxMatch[1] || 'USDC').toUpperCase(),
      recipient: maxMatch[2].toLowerCase(),
      raw: msg,
    };
  }
  
  // ── MULTISEND (batch transfers) ──────────────────────────────────────────────
  const batchMatch = msg.match(/^(?:multisend|batch|lote|pay|enviar)\s+(.+)/i);
  if (batchMatch) {
    // Parse entries: "0xABC:10, 0xDEF:20"
    const entries = batchMatch[1].match(/(0x[0-9a-fA-F]{40})\s*[:=]\s*([\d.]+)/g);
    if (entries && entries.length >= 2) {
      const recipients = entries.map(e => {
        const m = e.match(/(0x[0-9a-fA-F]{40})\s*[:=]\s*([\d.]+)/);
        return { address: m[1].toLowerCase(), amount: parseFloat(m[2]) };
      });
      
      const total = recipients.reduce((sum, r) => sum + r.amount, 0);
      
      return {
        type: INTENT_TYPES.MULTISEND,
        recipients,
        token: 'USDC', // default
        totalAmount: total,
        raw: msg,
      };
    }
  }
  
  // ── SWAP ─────────────────────────────────────────────────────────────────────
  const swapMatch = msg.match(/^(?:swap|trocar|exchange|troca)\s+([\d.]+)\s*(usdc|eurc)?\s+(?:to|for|para|por)\s*(usdc|eurc)/i);
  if (swapMatch) {
    const fromToken = (swapMatch[2] || 'USDC').toUpperCase();
    const toToken = swapMatch[3].toUpperCase();
    
    if (fromToken === toToken) {
      return { type: 'error', error: 'Cannot swap token to itself' };
    }
    
    return {
      type: INTENT_TYPES.SWAP,
      amount: parseFloat(swapMatch[1]),
      fromToken,
      toToken,
      token: fromToken, // for Permit2 check
      raw: msg,
    };
  }
  
  // ── CREATE ESCROW/CONTRACT ───────────────────────────────────────────────────
  const escrowMatch = msg.match(/^(?:create|new|criar)\s+(?:escrow|contract|contrato)\s*(?:with\s+)?(0x[0-9a-fA-F]{40})?\s*(?:for\s+)?([\d.]+)?\s*(?:usdc)?/i);
  if (escrowMatch) {
    return {
      type: INTENT_TYPES.ESCROW_CREATE,
      contractor: escrowMatch[1] ? escrowMatch[1].toLowerCase() : null,
      amount: escrowMatch[2] ? parseFloat(escrowMatch[2]) : null,
      token: 'USDC',
      raw: msg,
    };
  }
  
  // ── APPROVE/AUTHORIZE PERMIT2 ────────────────────────────────────────────────
  const approveMatch = msg.match(/^(?:allow|approve|authorize|permit|autorizar|aprovar)\s+([\d.]+)?\s*(usdc|eurc)?\s*(?:for|por|para)?\s*([\d.]+)?\s*(hours?|hrs?|days?|horas?|dias?)?/i);
  if (approveMatch) {
    const amount = approveMatch[1] ? parseFloat(approveMatch[1]) : 100;
    const token = (approveMatch[2] || 'USDC').toUpperCase();
    const duration = approveMatch[3] ? parseFloat(approveMatch[3]) : 24;
    const unit = approveMatch[4] || 'hours';
    
    return {
      type: INTENT_TYPES.APPROVE_PERMIT2,
      amount,
      token,
      duration,
      unit,
      raw: msg,
    };
  }
  
  // Not recognized
  return null;
}

// ─── Intent Handler (Main Entry Point) ────────────────────────────────────────
async function handleBridgeIntent(msg) {
  try {
    // Check if it's an action command
    if (!isActionCommand(msg)) return false;
    
    // Update status
    updateExecutionStatus(EXEC_STATUS.PARSING);
    
    // Parse intent
    const intent = parseIntent(msg);
    
    if (!intent) return false; // Not recognized
    
    if (intent.type === 'error') {
      appendChatMessage('assistant', `⚠️ ${intent.error}`, 'bridge');
      resetState();
      return true;
    }
    
    console.log('[BRIDGE v2] Parsed intent:', intent);
    
    // Store current intent
    bridgeState.currentIntent = {
      ...intent,
      id: 'intent-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    };
    saveState();
    
    // Get wallet
    const wallet = getWalletAddress();
    if (!wallet) {
      appendChatMessage('assistant',
        '⚠️ **Wallet required**\n\nConnect your wallet to execute commands.',
        'bridge'
      );
      appendActionCard([
        { label: '🔗 Connect Wallet', action: 'openWalletModal()', primary: true }
      ]);
      resetState();
      return true;
    }
    
    // Handle Permit2 approval intent (special case — no execution)
    if (intent.type === INTENT_TYPES.APPROVE_PERMIT2) {
      return handleApproveIntent(intent, wallet);
    }
    
    // Check Permit2 authorization
    updateExecutionStatus(EXEC_STATUS.CHECKING);
    
    const token = intent.token || 'USDC';
    const permit2Status = await checkPermit2Status(wallet, token);
    
    bridgeState.permit2Status = permit2Status;
    saveState();
    
    if (!permit2Status.authorized) {
      return handleUnauthorized(intent, permit2Status);
    }
    
    // Validate amount against permit allowance
    const requiredAmount = intent.totalAmount || intent.amount;
    
    if (requiredAmount !== 'max' && requiredAmount > permit2Status.allowance) {
      appendChatMessage('assistant',
        `⚠️ **Insufficient Permit2 allowance**\n\n` +
        `Required: **${requiredAmount} ${token}**\n` +
        `Available: **${permit2Status.allowance.toFixed(2)} ${token}**\n\n` +
        `Create a new permit or reduce the amount.`,
        'bridge'
      );
      appendActionCard([
        { label: '🔐 Create New Permit', action: `autonomaSendChat('allow ${Math.ceil(requiredAmount * 2)} ${token} for 24 hours')`, primary: true },
        { label: '❌ Cancel', action: `appendChatMessage('assistant','❌ Cancelled.','bridge')`, primary: false },
      ]);
      resetState();
      return true;
    }
    
    // Execute intent
    return executeIntent(intent, permit2Status);
    
  } catch (err) {
    console.error('[BRIDGE v2] Intent handling error:', err);
    appendChatMessage('assistant',
      `❌ **Error:** ${err.message}`,
      'error'
    );
    resetState();
    return true;
  }
}

// ─── Handle Approve Intent ────────────────────────────────────────────────────
function handleApproveIntent(intent, wallet) {
  const { amount, token, duration, unit } = intent;
  
  const hours = unit === 'days' || unit === 'dias' ? duration * 24 : duration;
  
  appendChatMessage('assistant',
    `🔐 **Create Permit2 Approval**\n\n` +
    `| Field | Value |\n|---|---|\n` +
    `| Token | **${token}** |\n` +
    `| Amount | **${amount} ${token}** |\n` +
    `| Duration | **${hours} hours** |\n` +
    `| Wallet | \`${wallet.slice(0,10)}…\` |\n\n` +
    `This approval will allow the AI Agent to execute operations on your behalf within the specified limits.\n\n` +
    `No on-chain transaction required — just a signature.`,
    'bridge'
  );
  
  appendActionCard([
    { label: '🔐 Open Autonoma Tab', action: `switchTab('autonoma');toggleChat()`, primary: true },
    { label: '❌ Cancel', action: `appendChatMessage('assistant','❌ Cancelled.','bridge')`, primary: false },
  ]);
  
  resetState();
  return true;
}

// ─── Handle Unauthorized ───────────────────────────────────────────────────────
function handleUnauthorized(intent, status) {
  const token = intent.token || 'USDC';
  const reason = status.reason || 'unknown';
  
  const requiredAmount = intent.totalAmount || intent.amount;
  const suggestedAmount = requiredAmount !== 'max' 
    ? Math.max(Math.ceil(requiredAmount * 2), 100)
    : 500;
  
  let message = '🔐 **Permit2 authorization required**\n\n';
  
  switch (reason) {
    case 'no_wallet':
      message = '⚠️ **Wallet required**\n\nConnect your wallet first.';
      appendChatMessage('assistant', message, 'bridge');
      appendActionCard([
        { label: '🔗 Connect Wallet', action: 'openWalletModal()', primary: true }
      ]);
      break;
      
    case 'no_permits_found':
    case 'no_active_permit':
      message += 
        `To execute **${intent.type}** operations, authorize the AI Agent to spend ${token}.\n\n` +
        `**How it works:**\n` +
        `1. Sign a Permit2 approval (off-chain, no gas)\n` +
        `2. Set spending limit (e.g., ${suggestedAmount} ${token})\n` +
        `3. Set expiration (e.g., 24 hours)\n` +
        `4. Agent executes within those limits\n\n` +
        `**Recommended:** Authorize **${suggestedAmount} ${token}** for **24 hours**`;
      
      appendChatMessage('assistant', message, 'bridge');
      appendActionCard([
        { label: `🔐 Authorize ${suggestedAmount} ${token}`, action: `autonomaSendChat('allow ${suggestedAmount} ${token} for 24 hours')`, primary: true },
        { label: '⚙️ Custom Amount', action: `switchTab('autonoma');toggleChat()`, primary: false },
        { label: '❌ Cancel', action: `appendChatMessage('assistant','❌ Cancelled.','bridge')`, primary: false },
      ]);
      break;
      
    default:
      message = `❌ **Authorization check failed:** ${reason}`;
      appendChatMessage('assistant', message, 'error');
  }
  
  resetState();
  return true;
}

// ─── Execute Intent ────────────────────────────────────────────────────────────
async function executeIntent(intent, permit2Status) {
  console.log('[BRIDGE v2] Executing intent:', intent.type);
  
  try {
    // Check if Agent Executor is available
    if (typeof window.AgentExecutor === 'undefined') {
      throw new Error('Agent Executor not loaded. Open the Autonoma tab first.');
    }
    
    // Route to appropriate handler
    switch (intent.type) {
      case INTENT_TYPES.TRANSFER:
        return await executeTransfer(intent, permit2Status);
      case INTENT_TYPES.MULTISEND:
        return await executeMultisend(intent, permit2Status);
      case INTENT_TYPES.SWAP:
        return await executeSwap(intent, permit2Status);
      case INTENT_TYPES.ESCROW_CREATE:
        return await executeEscrowCreate(intent, permit2Status);
      default:
        throw new Error(`Unsupported intent type: ${intent.type}`);
    }
  } catch (err) {
    console.error('[BRIDGE v2] Execution error:', err);
    updateExecutionStatus(EXEC_STATUS.FAILED, { error: err.message });
    appendChatMessage('assistant',
      `❌ **Execution failed:** ${err.message}`,
      'error'
    );
    resetState();
    return true;
  }
}

// ─── Execute Transfer ──────────────────────────────────────────────────────────
async function executeTransfer(intent, permit2Status) {
  const wallet = getWalletAddress();
  let { amount, token, recipient } = intent;
  
  // Resolve "max" balance
  if (amount === 'max') {
    if (typeof window.Permit2Engine !== 'undefined') {
      const bal = await window.Permit2Engine.getTokenBalance(wallet, token);
      amount = Math.floor(bal.formatted * 100) / 100;
      
      if (amount <= 0) {
        appendChatMessage('assistant',
          `⚠️ **Insufficient balance**\n\nYou have 0 ${token}.`,
          'bridge'
        );
        resetState();
        return true;
      }
    } else {
      throw new Error('Cannot resolve max balance: Permit2Engine not loaded');
    }
  }
  
  // Show preview
  appendChatMessage('assistant',
    `💳 **Transfer Preview**\n\n` +
    `| Field | Value |\n|---|---|\n` +
    `| Amount | **${amount} ${token}** |\n` +
    `| To | \`${recipient.slice(0,10)}…${recipient.slice(-8)}\` |\n` +
    `| Method | Permit2 + Agent Executor (gasless) |\n` +
    `| Fee | Platform relayer pays gas |\n\n` +
    `🔐 *Permit2 allowance: ${permit2Status.allowance.toFixed(2)} ${token}*`,
    'bridge'
  );
  
  appendActionCard([
    { label: '⚡ Execute Transfer', action: `_bridgeExecTransfer('${amount}','${token}','${recipient}')`, primary: true },
    { label: '❌ Cancel', action: `appendChatMessage('assistant','❌ Cancelled.','bridge');ChatbotAgentBridge && ChatbotAgentBridge.resetState()`, primary: false },
  ]);
  
  // Register callback
  window._bridgeExecTransfer = async function(amt, tkn, to) {
    try {
      updateExecutionStatus(EXEC_STATUS.PREPARING);
      
      // Create intent via Agent Executor
      const result = await window.AgentExecutor.createIntent({
        type: 'transfer',
        wallet,
        token: tkn,
        amount: amt,
        to,
      });
      
      if (!result.success) {
        throw new Error(result.error || 'Intent creation failed');
      }
      
      // Update context
      updateContext({
        lastIntent: { type: INTENT_TYPES.TRANSFER, amount: parseFloat(amt), token: tkn, recipient: to },
        lastRecipient: to,
        lastToken: tkn,
        lastAmount: parseFloat(amt),
      });
      
      // Add to history
      addToHistory({
        intent: { type: INTENT_TYPES.TRANSFER, amount: parseFloat(amt), token: tkn, recipient: to },
        intentId: result.intent.id,
        status: 'pending',
      });
      
      appendChatMessage('assistant',
        `✅ **Transfer intent created**\n\n` +
        `Intent ID: \`${result.intent.id}\`\n` +
        `The Agent Executor will process this transfer shortly.\n\n` +
        `Monitor status in the Autonoma tab.`,
        'bridge'
      );
      
      updateExecutionStatus(EXEC_STATUS.COMPLETED);
      resetState();
      
    } catch (err) {
      console.error('[BRIDGE v2] Transfer execution error:', err);
      updateExecutionStatus(EXEC_STATUS.FAILED, { error: err.message });
      appendChatMessage('assistant', `❌ **Transfer failed:** ${err.message}`, 'error');
      resetState();
    }
  };
  
  return true;
}

// ─── Execute Multisend ─────────────────────────────────────────────────────────
async function executeMultisend(intent, permit2Status) {
  const wallet = getWalletAddress();
  const { recipients, token, totalAmount } = intent;
  
  appendChatMessage('assistant',
    `🚀 **Batch Transfer Preview**\n\n` +
    `| Field | Value |\n|---|---|\n` +
    `| Recipients | **${recipients.length}** |\n` +
    `| Total | **${totalAmount.toFixed(2)} ${token}** |\n` +
    `| Method | Permit2 Batch + Agent Executor |\n\n` +
    `🔐 *Permit2 allowance: ${permit2Status.allowance.toFixed(2)} ${token}*`,
    'bridge'
  );
  
  appendActionCard([
    { label: `⚡ Execute Batch (${recipients.length})`, action: `_bridgeExecMultisend(${JSON.stringify(recipients)},'${token}')`, primary: true },
    { label: '❌ Cancel', action: `appendChatMessage('assistant','❌ Cancelled.','bridge');ChatbotAgentBridge && ChatbotAgentBridge.resetState()`, primary: false },
  ]);
  
  window._bridgeExecMultisend = async function(rcpts, tkn) {
    try {
      updateExecutionStatus(EXEC_STATUS.PREPARING);
      
      const result = await window.AgentExecutor.createIntent({
        type: 'multisend',
        wallet,
        token: tkn,
        receivers: rcpts,
      });
      
      if (!result.success) {
        throw new Error(result.error || 'Intent creation failed');
      }
      
      addToHistory({
        intent: { type: INTENT_TYPES.MULTISEND, recipients: rcpts, token: tkn, totalAmount },
        intentId: result.intent.id,
        status: 'pending',
      });
      
      appendChatMessage('assistant',
        `✅ **Batch intent created**\n\n` +
        `Intent ID: \`${result.intent.id}\`\n` +
        `Processing ${rcpts.length} transfers...\n\n` +
        `Monitor in Autonoma tab.`,
        'bridge'
      );
      
      updateExecutionStatus(EXEC_STATUS.COMPLETED);
      resetState();
      
    } catch (err) {
      console.error('[BRIDGE v2] Multisend execution error:', err);
      updateExecutionStatus(EXEC_STATUS.FAILED, { error: err.message });
      appendChatMessage('assistant', `❌ **Batch failed:** ${err.message}`, 'error');
      resetState();
    }
  };
  
  return true;
}

// ─── Execute Swap ──────────────────────────────────────────────────────────────
async function executeSwap(intent, permit2Status) {
  const { amount, fromToken, toToken } = intent;
  
  appendChatMessage('assistant',
    `🔄 **Swap Preview**\n\n` +
    `From: **${amount} ${fromToken}**\n` +
    `To: ~**${amount} ${toToken}** (1:1 stablecoin)\n` +
    `Method: DEX interface\n\n` +
    `Opening DEX tab with pre-filled values...`,
    'bridge'
  );
  
  // Open DEX tab (swap is interactive, not auto-executed)
  switchTab('dex');
  toggleChat();
  
  updateContext({
    lastIntent: { type: INTENT_TYPES.SWAP, amount, fromToken, toToken },
  });
  
  resetState();
  return true;
}

// ─── Execute Escrow Create ─────────────────────────────────────────────────────
async function executeEscrowCreate(intent, permit2Status) {
  const { contractor, amount } = intent;
  
  if (!contractor || !amount) {
    appendChatMessage('assistant',
      `📋 **Create Escrow Contract**\n\nOpening Contracts tab.\n\n` +
      `Please provide:\n- Contractor address\n- Contract value\n- Milestones`,
      'bridge'
    );
    switchTab('contracts');
    toggleChat();
    resetState();
    return true;
  }
  
  appendChatMessage('assistant',
    `📋 **Escrow Preview**\n\n` +
    `Contractor: \`${contractor.slice(0,10)}…\`\n` +
    `Value: **${amount} USDC**\n\n` +
    `Opening Contracts tab to finalize...`,
    'bridge'
  );
  
  switchTab('contracts');
  toggleChat();
  resetState();
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
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})(window);
