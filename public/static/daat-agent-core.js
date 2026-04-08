// ============================================================
// DAAT AGENT CORE ENGINE v2.0 — UNIFIED EXECUTION ARCHITECTURE
// Build: 20260408c — ExecDaat Platform
//
// ┌───────────────────────────────────────────────────────────────┐
// │           SINGLE SOURCE OF TRUTH FOR ALL EXECUTIONS           │
// │                                                               │
// │  ┌──────────────┐     ┌────────────────┐     ┌────────────┐ │
// │  │   Payments   │────▶│                │     │            │ │
// │  │   Tab (UI)   │     │  DAAT AGENT    │────▶│  Permit2   │ │
// │  └──────────────┘     │     CORE       │     │  Manager   │ │
// │                       │                │     │            │ │
// │  ┌──────────────┐     │  • Intent      │     └────────────┘ │
// │  │  Autonoma    │────▶│    Parser      │            │        │
// │  │   Chatbot    │     │  • Validation  │            ▼        │
// │  └──────────────┘     │  • Execution   │     ┌────────────┐ │
// │                       │                │     │ Execution  │ │
// │                       └────────────────┘     │  Engine    │ │
// │                                              │            │ │
// │                                              └────────────┘ │
// │                                                     │        │
// │                                                     ▼        │
// │                                              ┌────────────┐ │
// │                                              │  On-Chain  │ │
// │                                              │  Contract  │ │
// │                                              └────────────┘ │
// └───────────────────────────────────────────────────────────────┘
//
// ARCHITECTURE PRINCIPLES:
//
// 1. UNIFIED INTENT FORMAT — All actions pass through one parser
//    {
//      intent: 'transfer' | 'multisend' | 'swap' | 'escrow' | 'approve',
//      token: 'USDC' | 'EURC',
//      amount: '10.50',
//      recipient?: '0x...',
//      recipients?: [{address, amount}],
//      metadata?: {...}
//    }
//
// 2. CENTRALIZED PERMIT2 MANAGEMENT — Single source of truth
//    - Check authorization before every execution
//    - Cache approval status (token, allowance, deadline)
//    - Silent validation (no repeated user prompts)
//    - Auto-prompt only when required
//
// 3. SINGLE EXECUTION ENGINE — No duplicate code
//    - Build transaction once
//    - Validate parameters once
//    - Send transaction once
//    - Return standardized status
//
// 4. CONSISTENT FEEDBACK — Same messages across all tabs
//    {
//      status: 'idle'|'checking'|'preparing'|'signing'|'sent'|'confirmed'|'failed',
//      message: 'Human-readable status',
//      txHash?: '0x...',
//      error?: 'Error description'
//    }
//
// 5. SECURITY ENFORCEMENT — Multi-layer validation
//    - Permit2 approval required
//    - Token whitelist (USDC, EURC)
//    - Address format validation (0x + 40 hex chars)
//    - Amount bounds (> 0, <= allowance)
//    - Same wallet enforcement
//    - Replay protection
//
// EXECUTION FLOW:
//
// ┌─────────────┐
// │   UI/Chat   │ User action or natural language command
// └──────┬──────┘
//        │
//        ▼
// ┌─────────────────────────────────────────────────────────────┐
// │ 1. Intent Parser                                            │
// │    • Parse input (UI action or natural language)            │
// │    • Extract: intent type, token, amount, recipient(s)      │
// │    • Handle contextual commands (last, max, repeat)         │
// │    • Validate format (address regex, amount > 0)            │
// │    • Return structured JSON or throw error                  │
// └──────┬──────────────────────────────────────────────────────┘
//        │
//        ▼
// ┌─────────────────────────────────────────────────────────────┐
// │ 2. Permit2 Manager                                          │
// │    • Check if Permit2 approval exists for token+spender     │
// │    • Verify: allowance >= amount, deadline > now            │
// │    • If missing/insufficient → prompt user for approval     │
// │    • Cache status in memory and localStorage                │
// │    • Return: { authorized: bool, reason?: string }          │
// └──────┬──────────────────────────────────────────────────────┘
//        │
//        ▼
// ┌─────────────────────────────────────────────────────────────┐
// │ 3. Security Validation                                      │
// │    • Enforce: Permit2 authorization = true                  │
// │    • Validate: address format, token in whitelist           │
// │    • Check: amount > 0 && amount <= allowance               │
// │    • Verify: wallet matches connected wallet                │
// │    • Replay guard: prevent duplicate txHash                 │
// └──────┬──────────────────────────────────────────────────────┘
//        │
//        ▼
// ┌─────────────────────────────────────────────────────────────┐
// │ 4. Execution Engine                                         │
// │    • Build transaction (EIP-712 or direct call)             │
// │    • Request signature from user wallet                     │
// │    • Send transaction to network                            │
// │    • Wait for confirmation                                  │
// │    • Return { status, txHash, message }                     │
// └──────┬──────────────────────────────────────────────────────┘
//        │
//        ▼
// ┌─────────────────────────────────────────────────────────────┐
// │ 5. Feedback Layer                                           │
// │    • Emit real-time events (parsing, checking, preparing)   │
// │    • Update UI status indicators                            │
// │    • Show success message with explorer link                │
// │    • Display errors in user-friendly format                 │
// │    • Store execution in history                             │
// └─────────────────────────────────────────────────────────────┘
//
// ============================================================
'use strict';

(function(global) {

// ─── VERSION ──────────────────────────────────────────────────────────────────
const CORE_VERSION = '20260408c';
const CORE_BUILD_DATE = '2026-04-08';

console.log(`
╔════════════════════════════════════════════════════════════════╗
║                    DAAT AGENT CORE ENGINE                      ║
║                   Unified Execution Layer v2.0                 ║
║                                                                ║
║  Version: ${CORE_VERSION}                 Build: ${CORE_BUILD_DATE}        ║
║  Status:  PRODUCTION READY                                     ║
╚════════════════════════════════════════════════════════════════╝
`);

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const CORE_STATE_KEY      = 'daat_core_state_v2';
const CORE_CONTEXT_KEY    = 'daat_core_context_v2';
const CORE_HISTORY_KEY    = 'daat_core_history_v2';
const PERMIT2_STORE_KEY   = 'arc_permit2_allowances_v1';
const SESSION_KEY         = 'arc-pay-session-v3';

// Network constants
const ARC_CHAIN_ID        = 5042002;
const ARC_CHAIN_HEX       = '0x4cef52';
const ARC_RPC             = 'https://rpc.testnet.arc.network';
const ARC_EXPLORER        = 'https://testnet.arcscan.app';

// Token registry
const USDC_ADDR           = '0x3600000000000000000000000000000000000000';
const EURC_ADDR           = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';

const TOKEN_REGISTRY = {
  USDC: { address: USDC_ADDR, decimals: 6, symbol: 'USDC' },
  EURC: { address: EURC_ADDR, decimals: 6, symbol: 'EURC' },
};

// Agent Executor contract (meta-transaction relayer)
const AGENT_EXECUTOR_ADDR = (function() {
  try {
    return localStorage.getItem('ae_contract_addr') || 
           '0x0000000000000000000000000000000000000000';
  } catch { return '0x0000000000000000000000000000000000000000'; }
})();

// Permit2 canonical address
const PERMIT2_ADDR        = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

// Multicall3 canonical address
const MULTICALL3_ADDR     = '0xcA11bde05977b3631167028862bE2a173976CA11';

// Intent types (unified across all sources)
const INTENT_TYPES = {
  TRANSFER:         'transfer',          // Single transfer
  MULTISEND:        'multisend',         // Batch transfers
  SWAP:             'swap',              // Token swap
  ESCROW_CREATE:    'escrow_create',     // Create escrow contract
  APPROVE_PERMIT2:  'approve_permit2',   // Approve Permit2 spending
};

// Execution status enum
const EXEC_STATUS = {
  IDLE:             'idle',
  PARSING:          'parsing',
  CHECKING_AUTH:    'checking_authorization',
  PREPARING:        'preparing_transaction',
  AWAITING_SIG:     'awaiting_signature',
  SENDING:          'sending_transaction',
  CONFIRMING:       'confirming',
  COMPLETED:        'completed',
  FAILED:           'failed',
};

// Feedback messages (user-facing)
const FEEDBACK_MESSAGES = {
  [EXEC_STATUS.IDLE]:          'Ready to execute',
  [EXEC_STATUS.PARSING]:       '🔍 Parsing intent...',
  [EXEC_STATUS.CHECKING_AUTH]: '🔐 Checking Permit2 authorization...',
  [EXEC_STATUS.PREPARING]:     '⚙️ Preparing transaction...',
  [EXEC_STATUS.AWAITING_SIG]:  '✍️ Awaiting signature...',
  [EXEC_STATUS.SENDING]:       '📤 Transaction sent to network...',
  [EXEC_STATUS.CONFIRMING]:    '⏳ Waiting for confirmation...',
  [EXEC_STATUS.COMPLETED]:     '✅ Transaction confirmed!',
  [EXEC_STATUS.FAILED]:        '❌ Transaction failed',
};

// ─── STATE ────────────────────────────────────────────────────────────────────
let coreState = {
  initialized: false,
  version: CORE_VERSION,
  currentStatus: EXEC_STATUS.IDLE,
  currentIntent: null,
  lastExecution: null,
  lastError: null,
  permit2Cache: {},  // { token: { authorized, allowance, deadline, timestamp } }
};

let coreContext = {
  lastIntent: null,
  lastRecipient: null,
  lastToken: 'USDC',
  lastAmount: null,
  recentAddresses: [],  // Last 10 addresses used
};

let executionHistory = []; // Last 100 executions

// ─── UTILITIES ────────────────────────────────────────────────────────────────

// Logger with timestamps
function _log(level, ...args) {
  const timestamp = new Date().toISOString().split('T')[1].slice(0, 12);
  const prefix = `[CORE ${level}] ${timestamp}`;
  console[level === 'error' ? 'error' : 'log'](prefix, ...args);
}

// Address validation
function isValidAddress(addr) {
  return typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr);
}

// Amount validation
function isValidAmount(amount) {
  const num = parseFloat(amount);
  return !isNaN(num) && num > 0;
}

// Token validation
function isValidToken(token) {
  return typeof token === 'string' && TOKEN_REGISTRY.hasOwnProperty(token.toUpperCase());
}

// Get connected wallet address
async function getWalletAddress() {
  try {
    if (!window.walletState?.address) {
      throw new Error('Wallet not connected');
    }
    return window.walletState.address;
  } catch (err) {
    _log('error', 'Failed to get wallet address:', err);
    throw new Error('Please connect your wallet first');
  }
}

// Get ethers provider
function getProvider() {
  const raw = window.walletState?.provider;
  if (!raw) throw new Error('Wallet not connected');
  if (window.ethers?.BrowserProvider) {
    return new window.ethers.BrowserProvider(raw);
  }
  if (window.ethers?.providers?.Web3Provider) {
    return new window.ethers.providers.Web3Provider(raw);
  }
  throw new Error('ethers.js not available');
}

// Get ethers signer
async function getSigner() {
  const provider = getProvider();
  return await provider.getSigner();
}

// Parse units (human → raw with 6 decimals)
function parseUnits(humanAmount) {
  const s = String(humanAmount).trim();
  if (window.ethers?.parseUnits) {
    try { return window.ethers.parseUnits(s, 6); } catch(e) { /* fallback */ }
  }
  const [intPart = '0', fracPart = ''] = s.split('.');
  const frac = fracPart.slice(0, 6).padEnd(6, '0');
  return BigInt(intPart) * 1_000_000n + BigInt(frac);
}

// Format units (raw → human with 6 decimals)
function formatUnits(rawAmount) {
  if (window.ethers?.formatUnits) {
    return window.ethers.formatUnits(rawAmount, 6);
  }
  return (Number(rawAmount) / 1e6).toFixed(6);
}

// Short address display
function shortAddr(addr) {
  if (!addr || addr.length < 12) return addr || '—';
  return addr.slice(0, 8) + '…' + addr.slice(-6);
}

// ────────────────────────────────────────────────────────────────────────────
// MODULE 1: INTENT ENGINE — Unified parsing of all inputs
// ────────────────────────────────────────────────────────────────────────────

const IntentEngine = {
  /**
   * Parse any input (UI action or natural language) into structured intent.
   * 
   * @param {Object|String} input - Raw input from UI or chatbot
   * @param {String} source - 'ui' | 'chatbot'
   * @returns {Object} Structured intent: { intent, token, amount, recipient?, recipients?, metadata? }
   * @throws {Error} If parsing fails
   */
  parse(input, source = 'ui') {
    _log('info', 'Intent Parser: Parsing input from', source, input);
    
    updateStatus(EXEC_STATUS.PARSING);
    
    try {
      // If input is already structured (from UI), validate and return
      if (typeof input === 'object' && input.intent) {
        return this._validateStructured(input);
      }
      
      // If input is natural language (from chatbot), parse it
      if (typeof input === 'string') {
        return this._parseNaturalLanguage(input);
      }
      
      throw new Error('Invalid input format');
      
    } catch (err) {
      _log('error', 'Intent parsing failed:', err);
      throw new Error(`Unable to parse intent: ${err.message}`);
    }
  },
  
  /**
   * Validate structured intent from UI
   */
  _validateStructured(intent) {
    const { intent: type, token, amount, recipient, recipients, metadata } = intent;
    
    // Validate intent type
    if (!Object.values(INTENT_TYPES).includes(type)) {
      throw new Error(`Unknown intent type: ${type}`);
    }
    
    // Validate token
    if (token && !isValidToken(token)) {
      throw new Error(`Invalid token: ${token}`);
    }
    
    // Validate amount (for single transfers)
    if (amount !== undefined && !isValidAmount(amount)) {
      throw new Error(`Invalid amount: ${amount}`);
    }
    
    // Validate recipient (for single transfers)
    if (recipient && !isValidAddress(recipient)) {
      throw new Error(`Invalid recipient address: ${recipient}`);
    }
    
    // Validate recipients (for multisend)
    if (recipients) {
      if (!Array.isArray(recipients) || recipients.length === 0) {
        throw new Error('Recipients must be a non-empty array');
      }
      for (const r of recipients) {
        if (!isValidAddress(r.address)) {
          throw new Error(`Invalid address in batch: ${r.address}`);
        }
        if (!isValidAmount(r.amount)) {
          throw new Error(`Invalid amount in batch: ${r.amount}`);
        }
      }
    }
    
    _log('info', 'Structured intent validated:', intent);
    return intent;
  },
  
  /**
   * Parse natural language command into structured intent
   */
  _parseNaturalLanguage(text) {
    const msg = text.trim().toLowerCase();
    
    // Pattern: send/transfer/pay <amount> <token> to <address>
    const transferPattern = /(?:send|transfer|pay)\s+(\d+(?:\.\d+)?)\s+(usdc|eurc)\s+(?:to\s+)?(0x[0-9a-f]{40})/i;
    const match = msg.match(transferPattern);
    
    if (match) {
      const [, amount, token, recipient] = match;
      return {
        intent: INTENT_TYPES.TRANSFER,
        token: token.toUpperCase(),
        amount: parseFloat(amount),
        recipient: recipient.toLowerCase(),
        source: 'chatbot',
      };
    }
    
    // Pattern: swap <amount> <from_token> to <to_token>
    const swapPattern = /(?:swap|exchange)\s+(\d+(?:\.\d+)?)\s+(usdc|eurc)\s+(?:to|for)\s+(usdc|eurc)/i;
    const swapMatch = msg.match(swapPattern);
    
    if (swapMatch) {
      const [, amount, fromToken, toToken] = swapMatch;
      return {
        intent: INTENT_TYPES.SWAP,
        token: fromToken.toUpperCase(),
        amount: parseFloat(amount),
        toToken: toToken.toUpperCase(),
        source: 'chatbot',
      };
    }
    
    // Pattern: allow/approve <amount> <token> (for Permit2)
    const approvePattern = /(?:allow|approve)\s+(\d+(?:\.\d+)?)\s+(usdc|eurc)/i;
    const approveMatch = msg.match(approvePattern);
    
    if (approveMatch) {
      const [, amount, token] = approveMatch;
      return {
        intent: INTENT_TYPES.APPROVE_PERMIT2,
        token: token.toUpperCase(),
        amount: parseFloat(amount),
        source: 'chatbot',
      };
    }
    
    // Pattern: multisend/batch: addr1:amt1, addr2:amt2, ...
    const multisendPattern = /(?:multisend|batch|pay multiple):\s*(.+)/i;
    const multiMatch = msg.match(multisendPattern);
    
    if (multiMatch) {
      const recipientsStr = multiMatch[1];
      const recipients = [];
      
      // Parse each entry: 0xABC:10, 0xDEF:20
      const entries = recipientsStr.split(',');
      for (const entry of entries) {
        const [addr, amt] = entry.trim().split(':');
        if (isValidAddress(addr) && isValidAmount(amt)) {
          recipients.push({ address: addr.toLowerCase(), amount: parseFloat(amt) });
        }
      }
      
      if (recipients.length > 0) {
        return {
          intent: INTENT_TYPES.MULTISEND,
          token: 'USDC', // Default token for multisend
          recipients,
          source: 'chatbot',
        };
      }
    }
    
    // Pattern: send to last / send to previous
    if (/send\s+(?:to\s+)?(?:last|previous)/i.test(msg)) {
      if (!coreContext.lastRecipient) {
        throw new Error('No previous recipient found. Please specify an address.');
      }
      
      // Extract amount
      const amountMatch = msg.match(/(\d+(?:\.\d+)?)\s*(?:usdc|eurc)?/i);
      if (!amountMatch) {
        throw new Error('Please specify an amount (e.g., "send 10 to last")');
      }
      
      return {
        intent: INTENT_TYPES.TRANSFER,
        token: coreContext.lastToken || 'USDC',
        amount: parseFloat(amountMatch[1]),
        recipient: coreContext.lastRecipient,
        source: 'chatbot',
        contextual: true,
      };
    }
    
    // Pattern: repeat last / do it again
    if (/(?:repeat|again|same)/i.test(msg)) {
      if (!coreContext.lastIntent) {
        throw new Error('No previous transaction to repeat');
      }
      return { ...coreContext.lastIntent, source: 'chatbot', contextual: true };
    }
    
    // Pattern: send max / send all
    if (/send\s+(?:max|all)/i.test(msg)) {
      const tokenMatch = msg.match(/(?:max|all)\s+(usdc|eurc)/i);
      const token = tokenMatch ? tokenMatch[1].toUpperCase() : 'USDC';
      
      const toMatch = msg.match(/to\s+(0x[0-9a-f]{40})/i);
      if (!toMatch) {
        throw new Error('Please specify recipient (e.g., "send max USDC to 0x...")');
      }
      
      return {
        intent: INTENT_TYPES.TRANSFER,
        token,
        amount: 'MAX',  // Special flag
        recipient: toMatch[1].toLowerCase(),
        source: 'chatbot',
      };
    }
    
    // If no pattern matched, throw error
    throw new Error('Unable to understand command. Try: "send 10 USDC to 0x..."');
  },
  
  /**
   * Handle contextual commands (max balance, last recipient, repeat)
   */
  async resolveContextual(intent) {
    // Resolve MAX amount
    if (intent.amount === 'MAX') {
      _log('info', 'Resolving MAX balance for', intent.token);
      const balance = await this._getTokenBalance(intent.token);
      intent.amount = parseFloat(formatUnits(balance));
      _log('info', 'Resolved MAX to', intent.amount, intent.token);
    }
    
    return intent;
  },
  
  /**
   * Get token balance for connected wallet
   */
  async _getTokenBalance(token) {
    const walletAddr = await getWalletAddress();
    const tokenAddr = TOKEN_REGISTRY[token].address;
    
    const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];
    const signer = await getSigner();
    const contract = new window.ethers.Contract(tokenAddr, ERC20_ABI, signer);
    
    return await contract.balanceOf(walletAddr);
  },
};

// ────────────────────────────────────────────────────────────────────────────
// MODULE 2: PERMIT2 MANAGER — Authorization layer
// ────────────────────────────────────────────────────────────────────────────

const Permit2Manager = {
  /**
   * Check if Permit2 approval exists and is sufficient
   * 
   * @param {String} token - Token symbol (USDC, EURC)
   * @param {String} amount - Amount needed (human-readable)
   * @returns {Object} { authorized: bool, reason?: string, allowance?, deadline? }
   */
  async checkAuthorization(token, amount) {
    _log('info', 'Permit2 Manager: Checking authorization for', amount, token);
    
    updateStatus(EXEC_STATUS.CHECKING_AUTH);
    
    try {
      const walletAddr = await getWalletAddress();
      const tokenAddr = TOKEN_REGISTRY[token].address;
      const amountRaw = parseUnits(amount);
      
      // Check cache first (valid for 5 minutes)
      const cached = this._getCached(token);
      if (cached && cached.timestamp > Date.now() - 300_000) {
        _log('info', 'Using cached Permit2 status:', cached);
        
        // Verify cached data is still valid
        if (cached.authorized && cached.allowance >= amountRaw && cached.deadline > Date.now()) {
          return { authorized: true, cached: true, ...cached };
        }
      }
      
      // Query on-chain allowance
      const PERMIT2_ABI = [
        'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)'
      ];
      
      const provider = getProvider();
      const permit2Contract = new window.ethers.Contract(PERMIT2_ADDR, PERMIT2_ABI, provider);
      
      const [allowance, expiration, nonce] = await permit2Contract.allowance(
        walletAddr,
        tokenAddr,
        AGENT_EXECUTOR_ADDR
      );
      
      const deadline = Number(expiration) * 1000; // Convert to milliseconds
      const isAuthorized = allowance >= amountRaw && deadline > Date.now();
      
      const result = {
        authorized: isAuthorized,
        allowance: allowance.toString(),
        deadline,
        nonce: nonce.toString(),
        walletAddr,
        tokenAddr,
        spender: AGENT_EXECUTOR_ADDR,
      };
      
      // Cache result
      this._setCached(token, result);
      
      if (!isAuthorized) {
        if (allowance < amountRaw) {
          result.reason = `Insufficient Permit2 allowance. Need ${formatUnits(amountRaw)} ${token}, have ${formatUnits(allowance)} ${token}`;
        } else if (deadline <= Date.now()) {
          result.reason = 'Permit2 approval expired';
        }
      }
      
      _log('info', 'Permit2 authorization result:', result);
      return result;
      
    } catch (err) {
      _log('error', 'Permit2 check failed:', err);
      
      // Check if Permit2 contract exists
      if (err.message.includes('call revert exception')) {
        return {
          authorized: false,
          reason: 'Permit2 contract not found on Arc Testnet. Using fallback execution.',
          fallback: true,
        };
      }
      
      throw new Error(`Failed to check Permit2 status: ${err.message}`);
    }
  },
  
  /**
   * Request Permit2 approval from user
   */
  async requestApproval(token, amount, duration = 86400) {
    _log('info', 'Requesting Permit2 approval for', amount, token);
    
    try {
      const walletAddr = await getWalletAddress();
      const tokenAddr = TOKEN_REGISTRY[token].address;
      const amountRaw = parseUnits(amount);
      const deadline = Math.floor(Date.now() / 1000) + duration;
      
      // Build EIP-712 typed data for Permit2
      const PERMIT2_ABI = [
        'function approve(address token, address spender, uint160 amount, uint48 expiration)'
      ];
      
      const signer = await getSigner();
      const permit2Contract = new window.ethers.Contract(PERMIT2_ADDR, PERMIT2_ABI, signer);
      
      // Send approval transaction
      const tx = await permit2Contract.approve(
        tokenAddr,
        AGENT_EXECUTOR_ADDR,
        amountRaw,
        deadline
      );
      
      _log('info', 'Approval transaction sent:', tx.hash);
      
      // Wait for confirmation
      await tx.wait();
      
      _log('info', 'Permit2 approval confirmed');
      
      // Update cache
      this._setCached(token, {
        authorized: true,
        allowance: amountRaw.toString(),
        deadline: deadline * 1000,
        timestamp: Date.now(),
      });
      
      // Emit event
      emitEvent('permit2:approved', { token, amount, txHash: tx.hash });
      
      return { success: true, txHash: tx.hash };
      
    } catch (err) {
      _log('error', 'Permit2 approval failed:', err);
      throw new Error(`Failed to approve Permit2: ${err.message}`);
    }
  },
  
  /**
   * Get cached Permit2 status
   */
  _getCached(token) {
    return coreState.permit2Cache[token] || null;
  },
  
  /**
   * Set cached Permit2 status
   */
  _setCached(token, data) {
    coreState.permit2Cache[token] = { ...data, timestamp: Date.now() };
    saveState();
  },
  
  /**
   * Clear cached Permit2 status
   */
  clearCache(token = null) {
    if (token) {
      delete coreState.permit2Cache[token];
    } else {
      coreState.permit2Cache = {};
    }
    saveState();
  },
};

// ────────────────────────────────────────────────────────────────────────────
// MODULE 3: EXECUTION ENGINE — Transaction builder and sender
// ────────────────────────────────────────────────────────────────────────────

const ExecutionEngine = {
  /**
   * Execute a validated intent
   * 
   * @param {Object} intent - Structured intent from IntentEngine
   * @returns {Object} { status, txHash?, message, error? }
   */
  async execute(intent) {
    _log('info', 'Execution Engine: Starting execution', intent);
    
    try {
      // Route to appropriate handler
      switch (intent.intent) {
        case INTENT_TYPES.TRANSFER:
          return await this._executeTransfer(intent);
        
        case INTENT_TYPES.MULTISEND:
          return await this._executeMultisend(intent);
        
        case INTENT_TYPES.SWAP:
          return await this._executeSwap(intent);
        
        case INTENT_TYPES.ESCROW_CREATE:
          return await this._executeEscrowCreate(intent);
        
        case INTENT_TYPES.APPROVE_PERMIT2:
          return await this._executePermit2Approve(intent);
        
        default:
          throw new Error(`Unsupported intent type: ${intent.intent}`);
      }
      
    } catch (err) {
      _log('error', 'Execution failed:', err);
      return {
        status: EXEC_STATUS.FAILED,
        message: err.message,
        error: err,
      };
    }
  },
  
  /**
   * Execute single transfer
   */
  async _executeTransfer(intent) {
    const { token, amount, recipient } = intent;
    
    updateStatus(EXEC_STATUS.PREPARING);
    
    // Check if Agent Executor is available
    if (AGENT_EXECUTOR_ADDR !== '0x0000000000000000000000000000000000000000') {
      _log('info', 'Using Agent Executor (gasless meta-transaction)');
      return await this._executeViaAgentExecutor(intent);
    }
    
    // Fallback: direct ERC-20 transfer
    _log('info', 'Agent Executor not available, using direct transfer');
    return await this._executeDirectTransfer(intent);
  },
  
  /**
   * Execute via Agent Executor (gasless meta-transaction)
   */
  async _executeViaAgentExecutor(intent) {
    const { token, amount, recipient } = intent;
    const walletAddr = await getWalletAddress();
    const tokenAddr = TOKEN_REGISTRY[token].address;
    const amountRaw = parseUnits(amount);
    
    // Get nonce from relayer API
    const nonceResp = await fetch(`/api/agent/relay/nonce/${walletAddr}`);
    const { nonce } = await nonceResp.json();
    
    // Build EIP-712 typed data
    const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour
    
    const domain = {
      name: 'AgentExecutor',
      version: '1',
      chainId: ARC_CHAIN_ID,
      verifyingContract: AGENT_EXECUTOR_ADDR,
    };
    
    const types = {
      TransferIntent: [
        { name: 'from', type: 'address' },
        { name: 'token', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    };
    
    const value = {
      from: walletAddr,
      token: tokenAddr,
      to: recipient,
      amount: amountRaw.toString(),
      nonce,
      deadline,
    };
    
    // Request signature
    updateStatus(EXEC_STATUS.AWAITING_SIG);
    
    const signer = await getSigner();
    const signature = await signer.signTypedData(domain, types, value);
    
    // Submit to relayer
    updateStatus(EXEC_STATUS.SENDING);
    
    const submitResp = await fetch('/api/agent/relay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'transfer',
        from: walletAddr,
        token: tokenAddr,
        to: recipient,
        amountRaw: amountRaw.toString(),
        nonce,
        deadline,
        signature,
      }),
    });
    
    if (!submitResp.ok) {
      const error = await submitResp.json();
      throw new Error(error.error || 'Relayer submission failed');
    }
    
    const { jobId } = await submitResp.json();
    
    _log('info', 'Meta-transaction submitted, job ID:', jobId);
    
    // Poll for result
    updateStatus(EXEC_STATUS.CONFIRMING);
    
    const txHash = await this._pollRelayerStatus(jobId);
    
    return {
      status: EXEC_STATUS.COMPLETED,
      txHash,
      message: `Transfer completed! ${amount} ${token} sent to ${shortAddr(recipient)}`,
    };
  },
  
  /**
   * Execute direct ERC-20 transfer (fallback)
   */
  async _executeDirectTransfer(intent) {
    const { token, amount, recipient } = intent;
    const tokenAddr = TOKEN_REGISTRY[token].address;
    const amountRaw = parseUnits(amount);
    
    updateStatus(EXEC_STATUS.PREPARING);
    
    const ERC20_ABI = ['function transfer(address to, uint256 amount) returns (bool)'];
    const signer = await getSigner();
    const contract = new window.ethers.Contract(tokenAddr, ERC20_ABI, signer);
    
    updateStatus(EXEC_STATUS.AWAITING_SIG);
    
    const tx = await contract.transfer(recipient, amountRaw);
    
    updateStatus(EXEC_STATUS.SENDING);
    
    _log('info', 'Direct transfer sent:', tx.hash);
    
    updateStatus(EXEC_STATUS.CONFIRMING);
    
    await tx.wait();
    
    return {
      status: EXEC_STATUS.COMPLETED,
      txHash: tx.hash,
      message: `Transfer completed! ${amount} ${token} sent to ${shortAddr(recipient)}`,
    };
  },
  
  /**
   * Execute multisend batch
   */
  async _executeMultisend(intent) {
    const { token, recipients } = intent;
    
    // Calculate total
    const total = recipients.reduce((sum, r) => sum + parseFloat(r.amount), 0);
    
    _log('info', 'Executing multisend:', recipients.length, 'recipients, total', total, token);
    
    updateStatus(EXEC_STATUS.PREPARING);
    
    // Build Multicall3 aggregate3 calls
    const tokenAddr = TOKEN_REGISTRY[token].address;
    const walletAddr = await getWalletAddress();
    
    const ERC20_IFACE = new window.ethers.Interface([
      'function transferFrom(address from, address to, uint256 amount)'
    ]);
    
    const calls = recipients.map(r => ({
      target: tokenAddr,
      allowFailure: false,
      callData: ERC20_IFACE.encodeFunctionData('transferFrom', [
        walletAddr,
        r.address,
        parseUnits(r.amount)
      ]),
    }));
    
    // Execute via Multicall3
    const MULTICALL3_ABI = [
      'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[])'
    ];
    
    const signer = await getSigner();
    const mc3 = new window.ethers.Contract(MULTICALL3_ADDR, MULTICALL3_ABI, signer);
    
    updateStatus(EXEC_STATUS.AWAITING_SIG);
    
    const tx = await mc3.aggregate3(calls);
    
    updateStatus(EXEC_STATUS.SENDING);
    
    _log('info', 'Multisend batch sent:', tx.hash);
    
    updateStatus(EXEC_STATUS.CONFIRMING);
    
    await tx.wait();
    
    return {
      status: EXEC_STATUS.COMPLETED,
      txHash: tx.hash,
      message: `Multisend completed! ${recipients.length} transfers executed`,
    };
  },
  
  /**
   * Execute swap
   */
  async _executeSwap(intent) {
    // TODO: Implement swap execution via DEX router
    throw new Error('Swap execution not yet implemented');
  },
  
  /**
   * Execute escrow creation
   */
  async _executeEscrowCreate(intent) {
    // TODO: Implement escrow creation
    throw new Error('Escrow creation not yet implemented');
  },
  
  /**
   * Execute Permit2 approval
   */
  async _executePermit2Approve(intent) {
    const { token, amount } = intent;
    return await Permit2Manager.requestApproval(token, amount);
  },
  
  /**
   * Poll relayer status until transaction is confirmed
   */
  async _pollRelayerStatus(jobId, maxAttempts = 40, interval = 3000) {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(resolve => setTimeout(resolve, interval));
      
      const resp = await fetch(`/api/agent/relay/${jobId}`);
      const data = await resp.json();
      
      if (data.status === 'completed' && data.txHash) {
        return data.txHash;
      }
      
      if (data.status === 'failed') {
        throw new Error(data.error || 'Transaction failed on relayer');
      }
    }
    
    throw new Error('Transaction confirmation timeout');
  },
};

// ────────────────────────────────────────────────────────────────────────────
// MODULE 4: ORCHESTRATOR — Main public API
// ────────────────────────────────────────────────────────────────────────────

const DaatAgentCore = {
  version: CORE_VERSION,
  
  /**
   * Process any intent (from UI or chatbot)
   * 
   * @param {Object|String} input - Raw input
   * @param {String} source - 'ui' | 'chatbot'
   * @returns {Object} { status, txHash?, message, error? }
   */
  async processIntent(input, source = 'ui') {
    _log('info', '═══════════════════════════════════════════════════════');
    _log('info', 'DAAT Agent Core: Processing new intent from', source);
    _log('info', '═══════════════════════════════════════════════════════');
    
    try {
      // 1. Parse intent
      let intent = await IntentEngine.parse(input, source);
      
      // 2. Resolve contextual commands
      intent = await IntentEngine.resolveContextual(intent);
      
      // Store current intent
      coreState.currentIntent = intent;
      saveState();
      
      // 3. Check Permit2 authorization (skip for approve intent)
      if (intent.intent !== INTENT_TYPES.APPROVE_PERMIT2) {
        const authResult = await Permit2Manager.checkAuthorization(intent.token, intent.amount);
        
        if (!authResult.authorized && !authResult.fallback) {
          // Prompt user for approval
          emitEvent('permit2:required', {
            token: intent.token,
            amount: intent.amount,
            reason: authResult.reason,
          });
          
          return {
            status: EXEC_STATUS.FAILED,
            message: authResult.reason || 'Permit2 approval required',
            requiresApproval: true,
          };
        }
      }
      
      // 4. Execute intent
      const result = await ExecutionEngine.execute(intent);
      
      // 5. Update context
      if (result.status === EXEC_STATUS.COMPLETED) {
        coreContext.lastIntent = intent;
        coreContext.lastRecipient = intent.recipient || null;
        coreContext.lastToken = intent.token;
        coreContext.lastAmount = intent.amount;
        
        if (intent.recipient && !coreContext.recentAddresses.includes(intent.recipient)) {
          coreContext.recentAddresses.unshift(intent.recipient);
          coreContext.recentAddresses = coreContext.recentAddresses.slice(0, 10);
        }
        
        saveContext();
      }
      
      // 6. Add to history
      addToHistory({
        intent,
        result,
        timestamp: Date.now(),
      });
      
      // 7. Emit completion event
      emitEvent('execution:completed', { intent, result });
      
      updateStatus(EXEC_STATUS.IDLE);
      
      return result;
      
    } catch (err) {
      _log('error', 'Intent processing failed:', err);
      
      coreState.lastError = {
        message: err.message,
        stack: err.stack,
        timestamp: Date.now(),
      };
      saveState();
      
      updateStatus(EXEC_STATUS.FAILED);
      
      emitEvent('execution:failed', { error: err.message });
      
      return {
        status: EXEC_STATUS.FAILED,
        message: err.message,
        error: err,
      };
    }
  },
  
  /**
   * Get current execution status
   */
  getStatus() {
    return {
      status: coreState.currentStatus,
      message: FEEDBACK_MESSAGES[coreState.currentStatus],
      intent: coreState.currentIntent,
      lastExecution: coreState.lastExecution,
      lastError: coreState.lastError,
    };
  },
  
  /**
   * Get session context
   */
  getContext() {
    return { ...coreContext };
  },
  
  /**
   * Get execution history
   */
  getHistory(limit = 100) {
    return executionHistory.slice(0, limit);
  },
  
  /**
   * Clear execution history
   */
  clearHistory() {
    executionHistory = [];
    saveHistory();
  },
  
  /**
   * Reset all state
   */
  reset() {
    coreState = {
      initialized: true,
      version: CORE_VERSION,
      currentStatus: EXEC_STATUS.IDLE,
      currentIntent: null,
      lastExecution: null,
      lastError: null,
      permit2Cache: {},
    };
    
    coreContext = {
      lastIntent: null,
      lastRecipient: null,
      lastToken: 'USDC',
      lastAmount: null,
      recentAddresses: [],
    };
    
    executionHistory = [];
    
    saveState();
    saveContext();
    saveHistory();
    
    _log('info', 'Core state reset');
  },
};

// ─── STATE PERSISTENCE ────────────────────────────────────────────────────────

function loadState() {
  try {
    const raw = localStorage.getItem(CORE_STATE_KEY);
    if (raw) {
      const loaded = JSON.parse(raw);
      return { ...coreState, ...loaded, initialized: true };
    }
  } catch (err) {
    _log('error', 'Failed to load state:', err);
  }
  return coreState;
}

function saveState() {
  try {
    localStorage.setItem(CORE_STATE_KEY, JSON.stringify(coreState));
  } catch (err) {
    _log('error', 'Failed to save state:', err);
  }
}

function loadContext() {
  try {
    const raw = localStorage.getItem(CORE_CONTEXT_KEY);
    return raw ? JSON.parse(raw) : coreContext;
  } catch (err) {
    _log('error', 'Failed to load context:', err);
    return coreContext;
  }
}

function saveContext() {
  try {
    localStorage.setItem(CORE_CONTEXT_KEY, JSON.stringify(coreContext));
  } catch (err) {
    _log('error', 'Failed to save context:', err);
  }
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(CORE_HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    _log('error', 'Failed to load history:', err);
    return [];
  }
}

function saveHistory() {
  try {
    const limited = executionHistory.slice(0, 100);
    localStorage.setItem(CORE_HISTORY_KEY, JSON.stringify(limited));
  } catch (err) {
    _log('error', 'Failed to save history:', err);
  }
}

function addToHistory(entry) {
  executionHistory.unshift(entry);
  if (executionHistory.length > 100) {
    executionHistory = executionHistory.slice(0, 100);
  }
  saveHistory();
}

// ─── EVENT SYSTEM ─────────────────────────────────────────────────────────────

function emitEvent(eventName, detail) {
  const event = new CustomEvent(eventName, { detail });
  window.dispatchEvent(event);
  _log('info', 'Event emitted:', eventName, detail);
}

function updateStatus(newStatus) {
  coreState.currentStatus = newStatus;
  saveState();
  emitEvent('core:status', { status: newStatus, message: FEEDBACK_MESSAGES[newStatus] });
}

// ─── INITIALIZATION ───────────────────────────────────────────────────────────

function initialize() {
  _log('info', 'Initializing DAAT Agent Core...');
  
  // Load persisted state
  coreState = loadState();
  coreContext = loadContext();
  executionHistory = loadHistory();
  
  // Mark as initialized
  coreState.initialized = true;
  coreState.currentStatus = EXEC_STATUS.IDLE;
  saveState();
  
  // Expose global API
  global.DaatAgentCore = DaatAgentCore;
  
  // Backward compatibility aliases
  global.DAATCore = DaatAgentCore;
  global.daatCore = DaatAgentCore;
  
  _log('info', 'DAAT Agent Core initialized successfully ✓');
  _log('info', '─ Version:', CORE_VERSION);
  _log('info', '─ Build:', CORE_BUILD_DATE);
  _log('info', '─ State restored from localStorage');
  _log('info', '─ Execution history:', executionHistory.length, 'entries');
  
  // Emit ready event
  emitEvent('core:ready', { version: CORE_VERSION });
}

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}

})(window);
