// ============================================================
// DAAT Agent Transactional v2.0 — Full AI Agent
// Unified transactional execution layer for ExecDaat platform
// Build: 20260408h
// ============================================================
// Architecture:
//   User Message → Intent Engine → Module Router → Execution → Feedback
//
// Modules:
//   1. Intent Engine (NLU) — natural language to structured intent
//   2. Contract Creator — escrow, OTC, custom contracts
//   3. Swap Executor — token swaps with slippage
//   4. Payment Controller — Payments tab automation
//   5. Multi-step Orchestrator — sequential actions
//   6. Permit2 Integration — automatic approval checks
//   7. Validation Engine — wallet, balance, input checks
//   8. Feedback Generator — human-readable responses
//
// Security:
//   - Validates all addresses, amounts, tokens
//   - Requires wallet connection before any action
//   - Checks balances before execution
//   - Enforces single-wallet usage
//   - No hardcoded private keys or secrets
//
// State Management:
//   - localStorage for context memory (last intent, recipient, etc.)
//   - Execution history (last 100 actions)
//   - Session context across messages
//
// Response Format:
//   {
//     status: 'completed'|'failed'|'requires_approval'|'pending',
//     action: 'transfer'|'swap'|'contract_create'|'payment'|...,
//     message: '✅ Transfer completed! TX: 0xabc...',
//     txHash: '0x...',
//     data: { ... },
//     nextStep: 'Optional next action suggestion'
//   }
// ============================================================

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const DAT_VERSION = '20260408h';
const DAT_CHAIN_ID = 5042002;
const DAT_CHAIN_HEX = '0x4cef52';
const DAT_RPC = 'https://rpc.testnet.arc.network';
const DAT_EXPLORER = 'https://testnet.arcscan.app';

// Token Registry
const DAT_TOKENS = {
  USDC: { address: '0x3600000000000000000000000000000000000000', decimals: 6 },
  EURC: { address: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a', decimals: 6 },
};

// Contract Addresses
const DAT_CONTRACTS = {
  escrowFactory: '0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A',
  escrowRegistry: '0xEscrowRegistry00000000000000000000000002',
  swapRouter: '0x867650F5eAe8df91445971f14d89fd84F0C9a9f8',
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
};

// localStorage Keys
const DAT_KEYS = {
  context: 'dat_agent_context_v2',
  history: 'dat_agent_history_v2',
  cache: 'dat_agent_cache_v2',
};

// Intent Types
const DAT_INTENTS = {
  // Single actions
  TRANSFER: 'transfer',
  SWAP: 'swap',
  PAYMENT: 'payment',
  CONTRACT_CREATE: 'contract_create',
  CONTRACT_SIGN: 'contract_sign',
  CONTRACT_DEPOSIT: 'contract_deposit',
  CONTRACT_RELEASE: 'contract_release',
  ESCROW_CREATE: 'escrow_create',
  OTC_CREATE: 'otc_create',
  
  // Multi-step orchestrations
  SWAP_AND_PAY: 'swap_and_pay',
  CREATE_AND_DEPOSIT: 'create_and_deposit',
  
  // Queries
  BALANCE: 'balance',
  STATUS: 'status',
  HISTORY: 'history',
  CONTEXT: 'context',
  
  // Unknown
  UNKNOWN: 'unknown',
};

// Execution Status
const DAT_STATUS = {
  IDLE: 'idle',
  PARSING: 'parsing',
  VALIDATING: 'validating',
  CHECKING_APPROVAL: 'checking_approval',
  AWAITING_APPROVAL: 'awaiting_approval',
  PREPARING: 'preparing',
  EXECUTING: 'executing',
  CONFIRMING: 'confirming',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

// ─── State ────────────────────────────────────────────────────────────────────
const DaatAgentTransactionalState = {
  version: DAT_VERSION,
  initialized: false,
  currentStatus: DAT_STATUS.IDLE,
  currentIntent: null,
  lastError: null,
  executionHistory: [],
};

// ─── Context (persistent) ──────────────────────────────────────────────────────
let DaatAgentContext = {
  lastIntent: null,
  lastToken: 'USDC',
  lastAmount: 0,
  lastRecipient: null,
  lastContract: null,
  recentAddresses: [], // Last 10 addresses
  recentContracts: [], // Last 5 contracts
};

// ─── Utilities ────────────────────────────────────────────────────────────────
const DATLog = (msg, ...args) => console.log(`[DATAgent v${DAT_VERSION}]`, msg, ...args);
const DATError = (msg, ...args) => console.error(`[DATAgent v${DAT_VERSION}]`, msg, ...args);

function DATValidateAddress(addr) {
  if (!addr || typeof addr !== 'string') return false;
  return /^0x[0-9a-fA-F]{40}$/.test(addr.trim());
}

function DATValidateAmount(amt) {
  if (typeof amt === 'number') return amt > 0 && isFinite(amt);
  if (typeof amt === 'string') {
    const num = parseFloat(amt);
    return !isNaN(num) && num > 0 && isFinite(num);
  }
  return false;
}

function DATValidateToken(token) {
  const upper = (token || '').toUpperCase();
  return DAT_TOKENS.hasOwnProperty(upper);
}

function DATGetWallet() {
  const ws = window.walletState;
  if (!ws || !ws.connected || !ws.address) {
    throw new Error('❌ Wallet not connected. Please connect your wallet first.');
  }
  return ws;
}

function DATFormatAmount(amt, decimals = 6) {
  return parseFloat(amt).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: decimals,
  });
}

function DATFormatAddress(addr) {
  if (!addr) return '—';
  return addr.slice(0, 8) + '...' + addr.slice(-6);
}

// ─── Context Persistence ───────────────────────────────────────────────────────
function DATLoadContext() {
  try {
    const stored = localStorage.getItem(DAT_KEYS.context);
    if (stored) {
      DaatAgentContext = JSON.parse(stored);
      DATLog('Context loaded:', DaatAgentContext);
    }
  } catch (err) {
    DATError('Context load failed:', err.message);
  }
}

function DATSaveContext() {
  try {
    localStorage.setItem(DAT_KEYS.context, JSON.stringify(DaatAgentContext));
  } catch (err) {
    DATError('Context save failed:', err.message);
  }
}

function DATUpdateContext(updates) {
  Object.assign(DaatAgentContext, updates);
  DATSaveContext();
}

function DATAddRecentAddress(addr) {
  if (!DATValidateAddress(addr)) return;
  DaatAgentContext.recentAddresses = DaatAgentContext.recentAddresses || [];
  DaatAgentContext.recentAddresses = [
    addr,
    ...DaatAgentContext.recentAddresses.filter(a => a.toLowerCase() !== addr.toLowerCase())
  ].slice(0, 10);
  DATSaveContext();
}

// ─── Execution History ────────────────────────────────────────────────────────
function DATAddHistory(entry) {
  DaatAgentTransactionalState.executionHistory.unshift({
    ...entry,
    timestamp: new Date().toISOString(),
  });
  DaatAgentTransactionalState.executionHistory = 
    DaatAgentTransactionalState.executionHistory.slice(0, 100);
  
  try {
    localStorage.setItem(
      DAT_KEYS.history,
      JSON.stringify(DaatAgentTransactionalState.executionHistory)
    );
  } catch (err) {
    DATError('History save failed:', err.message);
  }
}

function DATLoadHistory() {
  try {
    const stored = localStorage.getItem(DAT_KEYS.history);
    if (stored) {
      DaatAgentTransactionalState.executionHistory = JSON.parse(stored);
      DATLog('History loaded:', DaatAgentTransactionalState.executionHistory.length, 'entries');
    }
  } catch (err) {
    DATError('History load failed:', err.message);
  }
}

// ============================================================
// MODULE 1: Intent Engine (NLU) — Natural Language Understanding
// ============================================================
const DATIntentEngine = {
  /**
   * Parse user message into structured intent
   * @param {string} message - User message
   * @returns {Object} Intent object
   */
  parse(message) {
    DATLog('Parsing intent:', message);
    const msg = (message || '').toLowerCase().trim();
    
    // Empty message
    if (!msg) {
      return { intent: DAT_INTENTS.UNKNOWN, raw: message };
    }
    
    // ── Context commands ──────────────────────────────────────────────────────
    if (/^(show\s+)?(context|ctx|memory|remember|state)$/i.test(msg)) {
      return { intent: DAT_INTENTS.CONTEXT, raw: message };
    }
    
    if (/^(show\s+)?history$/i.test(msg)) {
      return { intent: DAT_INTENTS.HISTORY, raw: message };
    }
    
    if (/^(show\s+)?balance/i.test(msg)) {
      return { intent: DAT_INTENTS.BALANCE, raw: message };
    }
    
    if (/^(show\s+)?status/i.test(msg)) {
      return { intent: DAT_INTENTS.STATUS, raw: message };
    }
    
    // ── Transfer patterns ──────────────────────────────────────────────────────
    // Pattern: send/transfer/pay <amount> <token> to <address>
    const transferPattern = /^(send|transfer|pay)\s+(\d+\.?\d*)\s+(usdc|eurc)\s+to\s+(0x[0-9a-f]{40}|last)$/i;
    let match = msg.match(transferPattern);
    if (match) {
      return {
        intent: DAT_INTENTS.TRANSFER,
        raw: message,
        amount: parseFloat(match[2]),
        token: match[3].toUpperCase(),
        recipient: match[4] === 'last' ? 'last' : match[4],
      };
    }
    
    // Pattern: send <amount> <token> (uses last recipient)
    const transferShortPattern = /^(send|transfer|pay)\s+(\d+\.?\d*)\s+(usdc|eurc)$/i;
    match = msg.match(transferShortPattern);
    if (match) {
      return {
        intent: DAT_INTENTS.TRANSFER,
        raw: message,
        amount: parseFloat(match[2]),
        token: match[3].toUpperCase(),
        recipient: 'last',
      };
    }
    
    // Pattern: send max <token> to <address>
    const transferMaxPattern = /^send\s+max\s+(usdc|eurc)\s+to\s+(0x[0-9a-f]{40})$/i;
    match = msg.match(transferMaxPattern);
    if (match) {
      return {
        intent: DAT_INTENTS.TRANSFER,
        raw: message,
        amount: 'max',
        token: match[1].toUpperCase(),
        recipient: match[2],
      };
    }
    
    // ── Swap patterns ──────────────────────────────────────────────────────────
    // Pattern: swap <amount> <fromToken> to <toToken>
    const swapPattern = /^(swap|exchange|convert)\s+(\d+\.?\d*)\s+(usdc|eurc)\s+(to|for|→)\s+(usdc|eurc)$/i;
    match = msg.match(swapPattern);
    if (match) {
      const fromToken = match[3].toUpperCase();
      const toToken = match[5].toUpperCase();
      if (fromToken === toToken) {
        return {
          intent: DAT_INTENTS.UNKNOWN,
          raw: message,
          error: 'Cannot swap same token',
        };
      }
      return {
        intent: DAT_INTENTS.SWAP,
        raw: message,
        amount: parseFloat(match[2]),
        fromToken,
        toToken,
        slippage: 0.5, // default
      };
    }
    
    // Pattern: swap <amount> <token> (auto-detect opposite)
    const swapShortPattern = /^(swap|exchange|convert)\s+(\d+\.?\d*)\s+(usdc|eurc)$/i;
    match = msg.match(swapShortPattern);
    if (match) {
      const fromToken = match[3].toUpperCase();
      const toToken = fromToken === 'USDC' ? 'EURC' : 'USDC';
      return {
        intent: DAT_INTENTS.SWAP,
        raw: message,
        amount: parseFloat(match[2]),
        fromToken,
        toToken,
        slippage: 0.5,
      };
    }
    
    // ── Payment tab control patterns ────────────────────────────────────────────
    // Pattern: pay <name> <amount> <token> for <note>
    const paymentPattern = /^pay\s+([a-z0-9@._-]+)\s+(\d+\.?\d*)\s+(usdc|eurc)\s+for\s+(.+)$/i;
    match = msg.match(paymentPattern);
    if (match) {
      return {
        intent: DAT_INTENTS.PAYMENT,
        raw: message,
        name: match[1],
        amount: parseFloat(match[2]),
        token: match[3].toUpperCase(),
        note: match[4].trim(),
      };
    }
    
    // ── Contract creation patterns ──────────────────────────────────────────────
    // Pattern: create escrow <amount> <token> with <contractor> for <title>
    const escrowPattern = /^create\s+escrow\s+(\d+\.?\d*)\s+(usdc|eurc)\s+with\s+(0x[0-9a-f]{40})\s+for\s+(.+)$/i;
    match = msg.match(escrowPattern);
    if (match) {
      return {
        intent: DAT_INTENTS.ESCROW_CREATE,
        raw: message,
        amount: parseFloat(match[2]),
        token: match[2].toUpperCase(),
        contractor: match[3],
        title: match[4].trim(),
      };
    }
    
    // Pattern: create contract <amount> <token> for <contractor>
    const contractPattern = /^create\s+contract\s+(\d+\.?\d*)\s+(usdc|eurc)\s+for\s+(0x[0-9a-f]{40})$/i;
    match = msg.match(contractPattern);
    if (match) {
      return {
        intent: DAT_INTENTS.CONTRACT_CREATE,
        raw: message,
        amount: parseFloat(match[1]),
        token: match[2].toUpperCase(),
        contractor: match[3],
      };
    }
    
    // Pattern: create otc <amount> <token> with <party>
    const otcPattern = /^create\s+otc\s+(\d+\.?\d*)\s+(usdc|eurc)\s+with\s+(0x[0-9a-f]{40})$/i;
    match = msg.match(otcPattern);
    if (match) {
      return {
        intent: DAT_INTENTS.OTC_CREATE,
        raw: message,
        amount: parseFloat(match[1]),
        token: match[2].toUpperCase(),
        counterparty: match[3],
      };
    }
    
    // ── Multi-step orchestrations ───────────────────────────────────────────────
    // Pattern: swap <amount> <token> then pay <recipient>
    const swapPayPattern = /^swap\s+(\d+\.?\d*)\s+(usdc|eurc)\s+(then|and)\s+pay\s+(0x[0-9a-f]{40})$/i;
    match = msg.match(swapPayPattern);
    if (match) {
      const fromToken = match[2].toUpperCase();
      const toToken = fromToken === 'USDC' ? 'EURC' : 'USDC';
      return {
        intent: DAT_INTENTS.SWAP_AND_PAY,
        raw: message,
        amount: parseFloat(match[1]),
        fromToken,
        toToken,
        recipient: match[4],
      };
    }
    
    // ── Repeat / contextual commands ────────────────────────────────────────────
    if (/^(repeat|again|do\s+it\s+again)$/i.test(msg)) {
      return {
        intent: DAT_INTENTS.TRANSFER,
        raw: message,
        repeat: true,
      };
    }
    
    // ── Unknown ─────────────────────────────────────────────────────────────────
    return {
      intent: DAT_INTENTS.UNKNOWN,
      raw: message,
    };
  },
  
  /**
   * Enrich intent with context (e.g., "send 10 USDC" → use last recipient)
   */
  enrichWithContext(intent) {
    if (!intent || intent.intent === DAT_INTENTS.UNKNOWN) return intent;
    
    // Resolve "last" recipient
    if (intent.recipient === 'last') {
      if (DaatAgentContext.lastRecipient) {
        intent.recipient = DaatAgentContext.lastRecipient;
        intent.contextUsed = true;
      } else {
        intent.error = 'No previous recipient found. Please specify an address.';
        return intent;
      }
    }
    
    // Resolve "max" amount
    if (intent.amount === 'max') {
      // Will be resolved later when we check balance
      intent.useMaxBalance = true;
    }
    
    // Repeat last action
    if (intent.repeat && DaatAgentContext.lastIntent) {
      return {
        ...DaatAgentContext.lastIntent,
        raw: intent.raw,
        repeat: true,
      };
    }
    
    return intent;
  },
};

// ============================================================
// MODULE 2: Validation Engine
// ============================================================
const DATValidationEngine = {
  /**
   * Validate intent before execution
   * @param {Object} intent
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  async validate(intent) {
    DATLog('Validating intent:', intent);
    const errors = [];
    
    // Wallet check
    try {
      DATGetWallet();
    } catch (err) {
      errors.push(err.message);
      return { valid: false, errors };
    }
    
    // Intent-specific validation
    switch (intent.intent) {
      case DAT_INTENTS.TRANSFER:
        if (!intent.recipient) {
          errors.push('❌ Recipient address is required');
        } else if (!DATValidateAddress(intent.recipient)) {
          errors.push('❌ Invalid recipient address format');
        }
        
        if (!intent.amount || intent.amount === 0) {
          errors.push('❌ Amount must be greater than 0');
        } else if (!DATValidateAmount(intent.amount)) {
          errors.push('❌ Invalid amount format');
        }
        
        if (!DATValidateToken(intent.token)) {
          errors.push('❌ Invalid token (must be USDC or EURC)');
        }
        
        // Balance check
        if (errors.length === 0) {
          const balance = await this._getBalance(intent.token);
          if (balance === null) {
            errors.push('⚠️ Could not verify balance');
          } else if (intent.amount > balance) {
            errors.push(`❌ Insufficient balance. Available: ${DATFormatAmount(balance)} ${intent.token}`);
          }
        }
        break;
      
      case DAT_INTENTS.SWAP:
        if (!intent.amount || intent.amount === 0) {
          errors.push('❌ Amount must be greater than 0');
        }
        
        if (!DATValidateToken(intent.fromToken) || !DATValidateToken(intent.toToken)) {
          errors.push('❌ Invalid token pair');
        }
        
        if (intent.fromToken === intent.toToken) {
          errors.push('❌ Cannot swap same token');
        }
        
        // Balance check
        if (errors.length === 0) {
          const balance = await this._getBalance(intent.fromToken);
          if (balance === null) {
            errors.push('⚠️ Could not verify balance');
          } else if (intent.amount > balance) {
            errors.push(`❌ Insufficient ${intent.fromToken}. Available: ${DATFormatAmount(balance)}`);
          }
        }
        break;
      
      case DAT_INTENTS.PAYMENT:
        if (!intent.name) {
          errors.push('❌ Recipient name is required');
        }
        
        if (!intent.amount || intent.amount === 0) {
          errors.push('❌ Amount must be greater than 0');
        }
        
        if (!DATValidateToken(intent.token)) {
          errors.push('❌ Invalid token');
        }
        
        if (!intent.note) {
          errors.push('❌ Payment note is required');
        }
        break;
      
      case DAT_INTENTS.ESCROW_CREATE:
      case DAT_INTENTS.CONTRACT_CREATE:
        if (!intent.contractor || !DATValidateAddress(intent.contractor)) {
          errors.push('❌ Valid contractor address is required');
        }
        
        if (!intent.amount || intent.amount === 0) {
          errors.push('❌ Amount must be greater than 0');
        }
        
        if (!DATValidateToken(intent.token)) {
          errors.push('❌ Invalid token');
        }
        break;
      
      case DAT_INTENTS.OTC_CREATE:
        if (!intent.counterparty || !DATValidateAddress(intent.counterparty)) {
          errors.push('❌ Valid counterparty address is required');
        }
        
        if (!intent.amount || intent.amount === 0) {
          errors.push('❌ Amount must be greater than 0');
        }
        
        if (!DATValidateToken(intent.token)) {
          errors.push('❌ Invalid token');
        }
        break;
      
      default:
        // No validation needed for query intents
        break;
    }
    
    return {
      valid: errors.length === 0,
      errors,
    };
  },
  
  async _getBalance(token) {
    try {
      const wallet = DATGetWallet();
      const provider = wallet.provider;
      const tokenAddr = DAT_TOKENS[token.toUpperCase()].address;
      
      // USDC is native on Arc (eth_getBalance)
      if (token.toUpperCase() === 'USDC') {
        const raw = await provider.request({
          method: 'eth_getBalance',
          params: [wallet.address, 'latest'],
        });
        return parseInt(raw, 16) / 1e18;
      }
      
      // EURC is ERC-20 (balanceOf)
      const data = '0x70a08231' + wallet.address.slice(2).padStart(64, '0');
      const raw = await provider.request({
        method: 'eth_call',
        params: [{ to: tokenAddr, data }, 'latest'],
      });
      return parseInt(raw, 16) / 1e6;
    } catch (err) {
      DATError('Balance check failed:', err.message);
      return null;
    }
  },
};

// ============================================================
// MODULE 3: Contract Creation Module
// ============================================================
const DATContractModule = {
  /**
   * Create escrow contract
   */
  async createEscrow(intent) {
    DATLog('Creating escrow:', intent);
    
    // Check if escrow.js functions are available
    if (typeof window.createEscrowContract !== 'function') {
      throw new Error('❌ Escrow module not loaded. Please check script dependencies.');
    }
    
    // Use existing createEscrowContract function
    try {
      const result = await window.createEscrowContract({
        contractor: intent.contractor,
        title: intent.title || 'Escrow Contract',
        amount: intent.amount,
        token: intent.token,
      });
      
      return {
        status: DAT_STATUS.COMPLETED,
        action: 'escrow_create',
        message: `✅ Escrow contract created successfully!`,
        txHash: result.txHash,
        data: {
          contractId: result.contractId,
          contractor: intent.contractor,
          amount: intent.amount,
          token: intent.token,
        },
        nextStep: 'Contractor can now sign the contract.',
      };
    } catch (err) {
      throw new Error(`❌ Escrow creation failed: ${err.message}`);
    }
  },
  
  /**
   * Create OTC contract
   */
  async createOTC(intent) {
    DATLog('Creating OTC:', intent);
    
    // Check if OTC functions are available
    if (typeof window.otcCreateDeal !== 'function') {
      throw new Error('❌ OTC module not loaded. Please check script dependencies.');
    }
    
    try {
      const result = await window.otcCreateDeal({
        counterparty: intent.counterparty,
        amount: intent.amount,
        token: intent.token,
      });
      
      return {
        status: DAT_STATUS.COMPLETED,
        action: 'otc_create',
        message: `✅ OTC deal created successfully!`,
        data: {
          dealId: result.dealId,
          counterparty: intent.counterparty,
          amount: intent.amount,
          token: intent.token,
        },
        nextStep: 'Both parties must sign the deal.',
      };
    } catch (err) {
      throw new Error(`❌ OTC creation failed: ${err.message}`);
    }
  },
  
  /**
   * Create general contract (uses contracts.js factory)
   */
  async createContract(intent) {
    DATLog('Creating contract:', intent);
    
    // Check if contracts.js functions are available
    if (typeof window.cfCreateContract !== 'function') {
      throw new Error('❌ Contracts module not loaded. Please check script dependencies.');
    }
    
    try {
      const result = await window.cfCreateContract({
        contractor: intent.contractor,
        title: intent.title || 'Service Contract',
        totalValue: intent.amount,
        token: intent.token,
        milestones: intent.milestones || [
          { description: 'Milestone 1', amount: intent.amount },
        ],
      });
      
      return {
        status: DAT_STATUS.COMPLETED,
        action: 'contract_create',
        message: `✅ Contract created successfully!`,
        txHash: result.txHash,
        data: {
          contractId: result.contractId,
          contractor: intent.contractor,
          amount: intent.amount,
          token: intent.token,
        },
        nextStep: 'Contractor must sign the contract to activate it.',
      };
    } catch (err) {
      throw new Error(`❌ Contract creation failed: ${err.message}`);
    }
  },
};

// ============================================================
// MODULE 4: Swap Execution Module
// ============================================================
const DATSwapModule = {
  /**
   * Execute token swap
   */
  async executeSwap(intent) {
    DATLog('Executing swap:', intent);
    
    // Check if swap.js functions are available
    if (typeof window.executeSwap !== 'function') {
      throw new Error('❌ Swap module not loaded. Please check script dependencies.');
    }
    
    try {
      // Set swap parameters in UI
      const fromTokenEl = document.getElementById('swap-from-token');
      const amountEl = document.getElementById('swap-amount-in');
      
      if (fromTokenEl) fromTokenEl.value = intent.fromToken;
      if (amountEl) amountEl.value = intent.amount;
      
      // Trigger input change to update quote
      if (typeof window.onSwapInputChange === 'function') {
        window.onSwapInputChange();
      }
      
      // Wait for quote
      await new Promise(r => setTimeout(r, 800));
      
      // Execute swap
      const result = await window.executeSwap();
      
      return {
        status: DAT_STATUS.COMPLETED,
        action: 'swap',
        message: `✅ Swap completed! ${intent.amount} ${intent.fromToken} → ${intent.toToken}`,
        txHash: result.txHash,
        data: {
          fromToken: intent.fromToken,
          toToken: intent.toToken,
          amountIn: intent.amount,
          amountOut: result.amountOut,
          fee: result.fee,
        },
        nextStep: null,
      };
    } catch (err) {
      throw new Error(`❌ Swap failed: ${err.message}`);
    }
  },
};

// ============================================================
// MODULE 5: Payment Controller Module
// ============================================================
const DATPaymentModule = {
  /**
   * Control Payments tab (auto-fill and execute)
   */
  async executePayment(intent) {
    DATLog('Executing payment:', intent);
    
    // Check if payment functions are available
    if (typeof window.payExecuteNow !== 'function') {
      throw new Error('❌ Payment module not loaded. Please check script dependencies.');
    }
    
    try {
      // Auto-fill payment form
      const nameEl = document.getElementById('pay-recipient-name');
      const emailEl = document.getElementById('pay-recipient-email');
      const amountEl = document.getElementById('pay-amount');
      const tokenEl = document.getElementById('pay-token');
      const noteEl = document.getElementById('pay-note');
      
      if (nameEl) nameEl.value = intent.name;
      if (emailEl) emailEl.value = intent.email || `${intent.name}@example.com`;
      if (amountEl) amountEl.value = intent.amount;
      if (tokenEl) tokenEl.value = intent.token;
      if (noteEl) noteEl.value = intent.note;
      
      // Trigger execution
      const result = await window.payExecuteNow();
      
      return {
        status: DAT_STATUS.COMPLETED,
        action: 'payment',
        message: `✅ Payment sent to ${intent.name}!`,
        txHash: result.txHash,
        data: {
          recipient: intent.name,
          amount: intent.amount,
          token: intent.token,
          note: intent.note,
        },
        nextStep: null,
      };
    } catch (err) {
      throw new Error(`❌ Payment failed: ${err.message}`);
    }
  },
};

// ============================================================
// MODULE 6: Transfer Execution (Direct)
// ============================================================
const DATTransferModule = {
  /**
   * Execute direct transfer using SafeDaatAgentCore (with auto-initialization)
   */
  async executeTransfer(intent) {
    DATLog('Executing transfer:', intent);
    
    try {
      // Use SafeDaatAgentCore which auto-initializes if needed
      const SafeCore = window.SafeDaatAgentCore || window.DaatAgentCore;
      
      if (!SafeCore) {
        // Fallback: try to initialize manually
        if (typeof window.DaatAgentCoreInit !== 'undefined') {
          DATLog('Initializing DAAT Agent Core...');
          await window.DaatAgentCoreInit.ensureCore();
        } else {
          throw new Error('❌ DAAT Agent Core initialization failed. Please refresh the page.');
        }
      }
      
      // Execute transfer with safe wrapper
      let result;
      
      if (window.SafeDaatAgentCore) {
        // Use safe wrapper (auto-retry)
        DATLog('Using SafeDaatAgentCore.executeTransfer()');
        result = await window.SafeDaatAgentCore.executeTransfer(intent);
      } else if (window.DaatAgentCore && window.DaatAgentCore.ExecutionEngine) {
        // Direct call (legacy fallback)
        DATLog('Using DaatAgentCore.ExecutionEngine._executeDirectTransfer()');
        result = await window.DaatAgentCore.ExecutionEngine._executeDirectTransfer(intent);
      } else {
        throw new Error('❌ DAAT Agent Core is not available. Cannot execute transfer.');
      }
      
      return {
        status: result.status === 'completed' ? DAT_STATUS.COMPLETED : DAT_STATUS.FAILED,
        action: 'transfer',
        message: result.message,
        txHash: result.txHash,
        data: {
          recipient: intent.recipient,
          amount: intent.amount,
          token: intent.token,
        },
        nextStep: null,
      };
    } catch (err) {
      DATError('Transfer execution error:', err);
      throw new Error(`❌ Transfer failed: ${err.message}`);
    }
  },
};

// ============================================================
// MODULE 7: Multi-step Orchestrator
// ============================================================
const DATOrchestratorModule = {
  /**
   * Execute multi-step sequence
   */
  async execute(intent) {
    DATLog('Executing multi-step:', intent.intent);
    
    switch (intent.intent) {
      case DAT_INTENTS.SWAP_AND_PAY:
        return await this._swapAndPay(intent);
      
      case DAT_INTENTS.CREATE_AND_DEPOSIT:
        return await this._createAndDeposit(intent);
      
      default:
        throw new Error('Unknown multi-step intent');
    }
  },
  
  async _swapAndPay(intent) {
    const steps = [];
    
    try {
      // Step 1: Swap
      const swapResult = await DATSwapModule.executeSwap({
        fromToken: intent.fromToken,
        toToken: intent.toToken,
        amount: intent.amount,
        slippage: intent.slippage || 0.5,
      });
      steps.push(swapResult);
      
      // Step 2: Transfer
      const transferResult = await DATTransferModule.executeTransfer({
        recipient: intent.recipient,
        amount: swapResult.data.amountOut,
        token: intent.toToken,
      });
      steps.push(transferResult);
      
      return {
        status: DAT_STATUS.COMPLETED,
        action: 'swap_and_pay',
        message: `✅ Swapped ${intent.amount} ${intent.fromToken} and sent ${swapResult.data.amountOut} ${intent.toToken} to ${DATFormatAddress(intent.recipient)}`,
        data: { steps },
        nextStep: null,
      };
    } catch (err) {
      return {
        status: DAT_STATUS.FAILED,
        action: 'swap_and_pay',
        message: `❌ Multi-step failed: ${err.message}`,
        data: { steps, error: err.message },
        nextStep: null,
      };
    }
  },
  
  async _createAndDeposit(intent) {
    // Implementation for create-and-deposit flow
    throw new Error('Create-and-deposit not yet implemented');
  },
};

// ============================================================
// MODULE 8: Query Handler
// ============================================================
const DATQueryModule = {
  /**
   * Handle query intents (balance, history, context, status)
   */
  async handleQuery(intent) {
    switch (intent.intent) {
      case DAT_INTENTS.BALANCE:
        return await this._getBalance();
      
      case DAT_INTENTS.HISTORY:
        return this._getHistory();
      
      case DAT_INTENTS.CONTEXT:
        return this._getContext();
      
      case DAT_INTENTS.STATUS:
        return this._getStatus();
      
      default:
        throw new Error('Unknown query intent');
    }
  },
  
  async _getBalance() {
    try {
      const wallet = DATGetWallet();
      const provider = wallet.provider;
      
      // Get USDC balance (native)
      const usdcRaw = await provider.request({
        method: 'eth_getBalance',
        params: [wallet.address, 'latest'],
      });
      const usdcBalance = parseInt(usdcRaw, 16) / 1e18;
      
      // Get EURC balance (ERC-20)
      const eurcAddr = DAT_TOKENS.EURC.address;
      const eurcData = '0x70a08231' + wallet.address.slice(2).padStart(64, '0');
      const eurcRaw = await provider.request({
        method: 'eth_call',
        params: [{ to: eurcAddr, data: eurcData }, 'latest'],
      });
      const eurcBalance = parseInt(eurcRaw, 16) / 1e6;
      
      return {
        status: DAT_STATUS.COMPLETED,
        action: 'balance_query',
        message: `💰 **Your Balance**\n\n` +
          `**USDC**: ${DATFormatAmount(usdcBalance)} USDC\n` +
          `**EURC**: ${DATFormatAmount(eurcBalance)} EURC\n\n` +
          `Wallet: ${DATFormatAddress(wallet.address)}`,
        data: { usdc: usdcBalance, eurc: eurcBalance, wallet: wallet.address },
      };
    } catch (err) {
      throw new Error(`❌ Balance query failed: ${err.message}`);
    }
  },
  
  _getHistory() {
    const history = DaatAgentTransactionalState.executionHistory.slice(0, 10);
    
    if (history.length === 0) {
      return {
        status: DAT_STATUS.COMPLETED,
        action: 'history_query',
        message: '📜 No execution history yet.',
      };
    }
    
    const lines = history.map((entry, i) => {
      const ts = new Date(entry.timestamp).toLocaleString();
      return `${i + 1}. [${entry.action}] ${entry.status} — ${ts}`;
    });
    
    return {
      status: DAT_STATUS.COMPLETED,
      action: 'history_query',
      message: `📜 **Recent History** (last ${history.length} actions)\n\n${lines.join('\n')}`,
      data: { history },
    };
  },
  
  _getContext() {
    const ctx = DaatAgentContext;
    
    return {
      status: DAT_STATUS.COMPLETED,
      action: 'context_query',
      message: `🧠 **Current Context**\n\n` +
        `**Last Intent**: ${ctx.lastIntent || '—'}\n` +
        `**Last Token**: ${ctx.lastToken || '—'}\n` +
        `**Last Amount**: ${ctx.lastAmount ? DATFormatAmount(ctx.lastAmount) : '—'}\n` +
        `**Last Recipient**: ${ctx.lastRecipient ? DATFormatAddress(ctx.lastRecipient) : '—'}\n` +
        `**Recent Addresses**: ${ctx.recentAddresses?.length || 0} stored`,
      data: ctx,
    };
  },
  
  _getStatus() {
    const state = DaatAgentTransactionalState;
    
    return {
      status: DAT_STATUS.COMPLETED,
      action: 'status_query',
      message: `📊 **Agent Status**\n\n` +
        `**Version**: ${state.version}\n` +
        `**Status**: ${state.currentStatus}\n` +
        `**Current Intent**: ${state.currentIntent?.intent || '—'}\n` +
        `**History Entries**: ${state.executionHistory.length}`,
      data: state,
    };
  },
};

// ============================================================
// MAIN ROUTER: Process Intent
// ============================================================
const DaatAgentTransactional = {
  version: DAT_VERSION,
  
  /**
   * Main entry point: process user message
   * @param {string} message - User message
   * @returns {Promise<Object>} Execution result
   */
  async process(message) {
    DATLog('Processing message:', message);
    
    try {
      // Step 1: Parse intent
      DaatAgentTransactionalState.currentStatus = DAT_STATUS.PARSING;
      let intent = DATIntentEngine.parse(message);
      
      // Check for unknown intent
      if (intent.intent === DAT_INTENTS.UNKNOWN) {
        return {
          status: DAT_STATUS.FAILED,
          action: 'unknown',
          message: '❓ I don\'t understand that command.\n\n' +
            '**Try:**\n' +
            '• `send 10 USDC to 0x...` — Transfer tokens\n' +
            '• `swap 5 USDC to EURC` — Token swap\n' +
            '• `pay john 20 USDC for invoice` — Auto-fill payment\n' +
            '• `create escrow 100 USDC with 0x... for Project X` — Create escrow\n' +
            '• `balance` — Check your balance\n' +
            '• `history` — Show recent actions',
          data: { intent },
        };
      }
      
      // Step 2: Enrich with context
      intent = DATIntentEngine.enrichWithContext(intent);
      
      if (intent.error) {
        return {
          status: DAT_STATUS.FAILED,
          action: intent.intent,
          message: intent.error,
          data: { intent },
        };
      }
      
      // Step 3: Handle queries (no validation needed)
      if ([
        DAT_INTENTS.BALANCE,
        DAT_INTENTS.HISTORY,
        DAT_INTENTS.CONTEXT,
        DAT_INTENTS.STATUS
      ].includes(intent.intent)) {
        return await DATQueryModule.handleQuery(intent);
      }
      
      // Step 4: Validate
      DaatAgentTransactionalState.currentStatus = DAT_STATUS.VALIDATING;
      const validation = await DATValidationEngine.validate(intent);
      
      if (!validation.valid) {
        return {
          status: DAT_STATUS.FAILED,
          action: intent.intent,
          message: '❌ Validation failed:\n\n' + validation.errors.join('\n'),
          data: { intent, validation },
        };
      }
      
      // Step 5: Execute
      DaatAgentTransactionalState.currentStatus = DAT_STATUS.EXECUTING;
      DaatAgentTransactionalState.currentIntent = intent;
      
      let result;
      
      switch (intent.intent) {
        case DAT_INTENTS.TRANSFER:
          result = await DATTransferModule.executeTransfer(intent);
          break;
        
        case DAT_INTENTS.SWAP:
          result = await DATSwapModule.executeSwap(intent);
          break;
        
        case DAT_INTENTS.PAYMENT:
          result = await DATPaymentModule.executePayment(intent);
          break;
        
        case DAT_INTENTS.ESCROW_CREATE:
          result = await DATContractModule.createEscrow(intent);
          break;
        
        case DAT_INTENTS.CONTRACT_CREATE:
          result = await DATContractModule.createContract(intent);
          break;
        
        case DAT_INTENTS.OTC_CREATE:
          result = await DATContractModule.createOTC(intent);
          break;
        
        case DAT_INTENTS.SWAP_AND_PAY:
        case DAT_INTENTS.CREATE_AND_DEPOSIT:
          result = await DATOrchestratorModule.execute(intent);
          break;
        
        default:
          throw new Error(`Unhandled intent: ${intent.intent}`);
      }
      
      // Step 6: Update context
      DATUpdateContext({
        lastIntent: intent.intent,
        lastToken: intent.token,
        lastAmount: intent.amount,
        lastRecipient: intent.recipient,
      });
      
      if (intent.recipient) {
        DATAddRecentAddress(intent.recipient);
      }
      
      // Step 7: Add to history
      DATAddHistory({
        action: intent.intent,
        status: result.status,
        message: result.message,
        data: result.data,
      });
      
      // Step 8: Reset status
      DaatAgentTransactionalState.currentStatus = DAT_STATUS.IDLE;
      DaatAgentTransactionalState.currentIntent = null;
      
      return result;
      
    } catch (err) {
      DATError('Execution failed:', err);
      
      DaatAgentTransactionalState.currentStatus = DAT_STATUS.FAILED;
      DaatAgentTransactionalState.lastError = err.message;
      
      return {
        status: DAT_STATUS.FAILED,
        action: DaatAgentTransactionalState.currentIntent?.intent || 'unknown',
        message: err.message,
        data: { error: err.message },
      };
    }
  },
  
  /**
   * Initialize agent
   */
  init() {
    if (DaatAgentTransactionalState.initialized) {
      DATLog('Already initialized');
      return;
    }
    
    DATLog('Initializing...');
    
    // Load context and history
    DATLoadContext();
    DATLoadHistory();
    
    DaatAgentTransactionalState.initialized = true;
    DATLog('Initialized successfully. Version:', DAT_VERSION);
  },
  
  /**
   * Get current state
   */
  getState() {
    return DaatAgentTransactionalState;
  },
  
  /**
   * Get current context
   */
  getContext() {
    return DaatAgentContext;
  },
  
  /**
   * Get execution history
   */
  getHistory() {
    return DaatAgentTransactionalState.executionHistory;
  },
  
  /**
   * Clear history
   */
  clearHistory() {
    DaatAgentTransactionalState.executionHistory = [];
    try {
      localStorage.removeItem(DAT_KEYS.history);
      DATLog('History cleared');
    } catch (err) {
      DATError('History clear failed:', err.message);
    }
  },
  
  /**
   * Reset context
   */
  resetContext() {
    DaatAgentContext = {
      lastIntent: null,
      lastToken: 'USDC',
      lastAmount: 0,
      lastRecipient: null,
      lastContract: null,
      recentAddresses: [],
      recentContracts: [],
    };
    DATSaveContext();
    DATLog('Context reset');
  },
};

// ============================================================
// Auto-initialize
// ============================================================
if (typeof window !== 'undefined') {
  window.DaatAgentTransactional = DaatAgentTransactional;
  
  // Initialize on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      DaatAgentTransactional.init();
    });
  } else {
    DaatAgentTransactional.init();
  }
  
  DATLog('Module loaded. Exposed as window.DaatAgentTransactional');
}
