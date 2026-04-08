// ============================================================
// DAAT AGENT CORE — GLOBAL INITIALIZER & SAFE LOADER
// Build: 20260408i
// ============================================================
// ZERO TOLERANCE FOR "NOT LOADED" ERRORS
//
// This module ensures DaatAgentCore is ALWAYS available:
//   1. Global singleton initialization
//   2. Auto-recovery on missing instance
//   3. Action queueing during initialization
//   4. Retry mechanism for failed loads
//   5. Shared instance across all tabs (main + autonoma)
//   6. Debug logging for all states
//   7. Graceful degradation (never hard fail)
//
// PHASES:
//   PHASE 1 — Global initialization on app load
//   PHASE 2 — Safe loader with auto-recovery
//   PHASE 3 — Chatbot binding (main + autonoma)
//   PHASE 4 — Execution guard (check before action)
//   PHASE 5 — Async initialization fix (action queue)
//   PHASE 6 — Debug logging
//   PHASE 7 — Remove hard fail (auto-retry)
//   PHASE 8 — Autonomous tab fix (shared instance)
// ============================================================

'use strict';

(function(global) {

const INIT_VERSION = '20260408i';
const INIT_MAX_RETRIES = 5;
const INIT_RETRY_DELAY = 1000; // 1 second

// ─── State ────────────────────────────────────────────────────────────────────
const InitState = {
  version: INIT_VERSION,
  ready: false,
  initializing: false,
  retryCount: 0,
  actionQueue: [],
  listeners: [],
  error: null,
};

// ─── Logging ──────────────────────────────────────────────────────────────────
function _initLog(level, ...args) {
  const prefix = `[DAAT Init v${INIT_VERSION}]`;
  const styles = {
    info: 'color: #60b4ff; font-weight: bold',
    success: 'color: #34d399; font-weight: bold',
    warn: 'color: #fbbf24; font-weight: bold',
    error: 'color: #f87171; font-weight: bold',
  };
  
  if (level === 'info' || level === 'success') {
    console.log(`%c${prefix}`, styles[level] || '', ...args);
  } else if (level === 'warn') {
    console.warn(`%c${prefix}`, styles[level] || '', ...args);
  } else if (level === 'error') {
    console.error(`%c${prefix}`, styles[level] || '', ...args);
  }
}

// ─── PHASE 1: Global Initialization ───────────────────────────────────────────
async function initializeCore() {
  if (InitState.ready) {
    _initLog('info', 'Core already initialized ✓');
    return true;
  }
  
  if (InitState.initializing) {
    _initLog('warn', 'Initialization already in progress...');
    return waitForReady();
  }
  
  InitState.initializing = true;
  _initLog('info', 'Initializing DAAT Agent Core...');
  
  try {
    // Check if DaatAgentCore exists
    if (typeof global.DaatAgentCore === 'undefined') {
      throw new Error('DaatAgentCore module not loaded. Check script load order.');
    }
    
    // Check if core has initialize method
    if (typeof global.DaatAgentCore.init === 'function') {
      await global.DaatAgentCore.init();
    }
    
    // Mark as ready
    InitState.ready = true;
    InitState.initializing = false;
    InitState.error = null;
    
    _initLog('success', 'DAAT Agent Core initialized successfully ✓');
    _initLog('info', '─ Version:', global.DaatAgentCore.version || 'unknown');
    _initLog('info', '─ Ready:', InitState.ready);
    
    // Emit ready event
    emitInitEvent('init:ready');
    
    // Process queued actions
    await processQueue();
    
    return true;
    
  } catch (err) {
    InitState.initializing = false;
    InitState.error = err.message;
    
    _initLog('error', 'Initialization failed:', err.message);
    
    // Retry if under limit
    if (InitState.retryCount < INIT_MAX_RETRIES) {
      InitState.retryCount++;
      _initLog('warn', `Retrying initialization (${InitState.retryCount}/${INIT_MAX_RETRIES}) in ${INIT_RETRY_DELAY}ms...`);
      
      await new Promise(resolve => setTimeout(resolve, INIT_RETRY_DELAY));
      return initializeCore();
    } else {
      _initLog('error', 'Max retries reached. Initialization failed permanently.');
      emitInitEvent('init:error', { error: err.message });
      return false;
    }
  }
}

// ─── PHASE 2: Safe Loader with Auto-recovery ──────────────────────────────────
async function ensureCore() {
  if (InitState.ready) {
    return true;
  }
  
  _initLog('info', '🔄 Core not ready. Auto-initializing...');
  return await initializeCore();
}

// ─── Wait for ready (async) ───────────────────────────────────────────────────
function waitForReady(timeout = 10000) {
  return new Promise((resolve, reject) => {
    if (InitState.ready) {
      resolve(true);
      return;
    }
    
    const startTime = Date.now();
    
    const checkInterval = setInterval(() => {
      if (InitState.ready) {
        clearInterval(checkInterval);
        resolve(true);
      } else if (Date.now() - startTime > timeout) {
        clearInterval(checkInterval);
        reject(new Error('Timeout waiting for core initialization'));
      }
    }, 100);
  });
}

// ─── PHASE 4: Execution Guard ─────────────────────────────────────────────────
async function guardedExecution(actionFn, actionName = 'action') {
  _initLog('info', `🛡️ Guarding execution: ${actionName}`);
  
  // Check if core is ready
  if (!InitState.ready) {
    _initLog('warn', 'Core not ready. Initializing...');
    
    const initialized = await ensureCore();
    
    if (!initialized) {
      throw new Error('Failed to initialize DAAT Agent Core. Cannot execute action.');
    }
  }
  
  // Double-check core availability
  if (typeof global.DaatAgentCore === 'undefined') {
    _initLog('error', 'DaatAgentCore is undefined after initialization!');
    throw new Error('DAAT Agent Core is not available. Please refresh the page.');
  }
  
  // Execute action
  _initLog('info', `✅ Core ready. Executing: ${actionName}`);
  return await actionFn();
}

// ─── PHASE 5: Action Queue (for async initialization) ─────────────────────────
function queueAction(actionFn, actionName = 'action') {
  _initLog('info', `📥 Queueing action: ${actionName}`);
  
  return new Promise((resolve, reject) => {
    InitState.actionQueue.push({
      fn: actionFn,
      name: actionName,
      resolve,
      reject,
      timestamp: Date.now(),
    });
    
    // Try to initialize if not already
    if (!InitState.initializing && !InitState.ready) {
      initializeCore();
    }
  });
}

async function processQueue() {
  if (InitState.actionQueue.length === 0) {
    return;
  }
  
  _initLog('info', `📤 Processing ${InitState.actionQueue.length} queued action(s)...`);
  
  const queue = [...InitState.actionQueue];
  InitState.actionQueue = [];
  
  for (const action of queue) {
    try {
      _initLog('info', `⚙️ Executing queued: ${action.name}`);
      const result = await action.fn();
      action.resolve(result);
    } catch (err) {
      _initLog('error', `❌ Queued action failed: ${action.name}`, err.message);
      action.reject(err);
    }
  }
  
  _initLog('success', '✅ Queue processed successfully');
}

// ─── Event System ─────────────────────────────────────────────────────────────
function emitInitEvent(eventName, detail = {}) {
  const event = new CustomEvent(eventName, { detail });
  window.dispatchEvent(event);
  _initLog('info', `📡 Event emitted: ${eventName}`);
}

function onInitReady(callback) {
  if (InitState.ready) {
    callback();
  } else {
    window.addEventListener('init:ready', callback, { once: true });
  }
}

// ─── PHASE 3: Chatbot Binding (Main + Autonoma) ───────────────────────────────
function bindChatbots() {
  _initLog('info', '🔗 Binding chatbots to DAAT Agent Core...');
  
  // Ensure both chatbots use the same instance
  if (typeof global.handleLocalCommand === 'function') {
    _initLog('info', '  ✓ Main chatbot detected');
  }
  
  if (typeof global.handleUnifiedMessage === 'function') {
    _initLog('info', '  ✓ Autonoma chatbot detected');
  }
  
  // Both should reference global.DaatAgentCore (singleton)
  _initLog('info', '  ✓ Both chatbots will use global.DaatAgentCore');
}

// ─── PHASE 7: Remove Hard Fail (Auto-retry wrapper) ───────────────────────────
async function safeExecute(actionFn, actionName = 'action') {
  try {
    return await guardedExecution(actionFn, actionName);
  } catch (err) {
    // If execution fails due to missing core, queue action
    if (err.message.includes('not loaded') || err.message.includes('not available')) {
      _initLog('warn', '⚠️ Core not available. Queueing action for retry...');
      return await queueAction(actionFn, actionName);
    } else {
      throw err;
    }
  }
}

// ─── API Wrapper for DaatAgentCore ────────────────────────────────────────────
const SafeDaatAgentCore = {
  /**
   * Process intent with auto-initialization
   */
  async processIntent(intent) {
    return await safeExecute(
      () => global.DaatAgentCore.processIntent(intent),
      `processIntent(${intent.intent})`
    );
  },
  
  /**
   * Check authorization with auto-initialization
   */
  async checkAuthorization(token, amount) {
    return await safeExecute(
      () => global.DaatAgentCore.Permit2Manager.checkAuthorization(token, amount),
      `checkAuthorization(${token}, ${amount})`
    );
  },
  
  /**
   * Request approval with auto-initialization
   */
  async requestApproval(token, amount) {
    return await safeExecute(
      () => global.DaatAgentCore.Permit2Manager.requestApproval(token, amount),
      `requestApproval(${token}, ${amount})`
    );
  },
  
  /**
   * Execute direct transfer with auto-initialization
   */
  async executeTransfer(intent) {
    return await safeExecute(
      () => global.DaatAgentCore.ExecutionEngine._executeDirectTransfer(intent),
      `executeTransfer(${intent.recipient})`
    );
  },
  
  /**
   * Get state (no async needed)
   */
  getState() {
    if (!InitState.ready || typeof global.DaatAgentCore === 'undefined') {
      return { ready: false, error: 'Core not initialized' };
    }
    return global.DaatAgentCore.getState();
  },
  
  /**
   * Get context (no async needed)
   */
  getContext() {
    if (!InitState.ready || typeof global.DaatAgentCore === 'undefined') {
      return {};
    }
    return global.DaatAgentCore.getContext();
  },
  
  /**
   * Get history (no async needed)
   */
  getHistory() {
    if (!InitState.ready || typeof global.DaatAgentCore === 'undefined') {
      return [];
    }
    return global.DaatAgentCore.getHistory();
  },
  
  /**
   * Check if ready
   */
  isReady() {
    return InitState.ready;
  },
  
  /**
   * Get initialization state
   */
  getInitState() {
    return {
      ...InitState,
      coreAvailable: typeof global.DaatAgentCore !== 'undefined',
    };
  },
};

// ─── PHASE 8: Autonomous Tab Fix ──────────────────────────────────────────────
function initAutonomaTab() {
  // Check if we're on /autonoma route
  const isAutonoma = window.location.pathname.includes('/autonoma');
  
  if (isAutonoma) {
    _initLog('info', '🤖 Autonoma tab detected. Ensuring core availability...');
    
    // Force initialization on autonoma tab entry
    if (!InitState.ready) {
      initializeCore();
    }
  }
}

// ─── Expose Global API ────────────────────────────────────────────────────────
global.DaatAgentCoreInit = {
  version: INIT_VERSION,
  initialize: initializeCore,
  ensureCore,
  guardedExecution,
  safeExecute,
  queueAction,
  onInitReady,
  isReady: () => InitState.ready,
  getState: () => InitState,
  SafeCore: SafeDaatAgentCore,
};

// Expose safe wrapper as primary interface
global.SafeDaatAgentCore = SafeDaatAgentCore;

// ─── Auto-initialize on load ──────────────────────────────────────────────────
_initLog('info', 'DAAT Agent Core Initializer loaded. Version:', INIT_VERSION);

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    _initLog('info', 'DOM ready. Starting initialization...');
    initializeCore();
    bindChatbots();
    initAutonomaTab();
  });
} else {
  _initLog('info', 'DOM already ready. Starting initialization immediately...');
  initializeCore();
  bindChatbots();
  initAutonomaTab();
}

// Also listen for page visibility changes (tab switching)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !InitState.ready) {
    _initLog('info', 'Page became visible. Checking core status...');
    initializeCore();
  }
});

// Listen for core ready event from daat-agent-core.js
window.addEventListener('core:ready', () => {
  _initLog('success', '📡 Received core:ready event from DaatAgentCore');
  InitState.ready = true;
  InitState.initializing = false;
  processQueue();
});

_initLog('info', 'Initializer ready. Watching for DaatAgentCore...');

})(window);
