// ============================================================
// EXECDAAT AGENT WALLET — Frontend Integration Module
// Build: 20260722b — Hardened
//
// Event-based architecture. All modules communicate via CustomEvent.
// No direct dependencies on existing ExecDaat modules.
//
// Exposes:
//   D.AgentWallet — public API for agent operations
//
// Events dispatched:
//   agentWallet:initialized
//   agentWallet:registered
//   agentWallet:unregistered
//   agentWallet:reputationUpdated
//   agentWallet:treasuryRefreshed
//   agentWallet:validationRequested
//   agentWallet:executionValidated
//   agentWallet:scheduleChecked
//   agentWallet:policyCheck
// ============================================================
;(function() {
  'use strict';
  var D = window.ExecDaat = window.ExecDaat || {};

  var _state = {
    initialized: false,
    isRegistered: false,
    agentId: null,
    agentAddress: null,
    agentWalletId: null,
    agentLabel: null,
    metadata: null,
    reputationStats: null,
    pendingValidations: [],
    permissionCache: {},
    treasuryBalances: null,
    auditEntries: [],
  };

  var API_BASE = '/api/agent-wallet';
  var WALLET_STORAGE_KEY = 'execdaat_agent_wallet_ref';

  function _api(path, options) {
    return fetch(API_BASE + path, Object.assign({
      headers: { 'Content-Type': 'application/json' },
    }, options || {})).then(function(r) { return r.json(); });
  }

  function _emit(name, detail) {
    window.dispatchEvent(new CustomEvent('agentWallet:' + name, { detail: detail || {} }));
  }

  // ═══════════════════════════════════════════════════════════════
  //  AGENT WALLET — Public API
  // ═══════════════════════════════════════════════════════════════

  D.AgentWallet = {
    get state() { return Object.assign({}, _state); },

    // ── Agent Wallet (separate address from user wallet) ──────────────────────
    /**
     * Create or retrieve the agent wallet for the connected user.
     * Generates a NEW EVM wallet on the backend. Not the user's MetaMask.
     */
    createWallet: async function(label) {
      var owner = window.walletState ? window.walletState.address : null;
      if (!owner) return { success: false, error: 'Connect your wallet first' };

      var r = await _api('/create', {
        method: 'POST',
        body: JSON.stringify({ ownerAddress: owner, label: label || 'ExecDaat Agent Wallet' }),
      });
      if (r.success) {
        _state.agentAddress = r.wallet.address;
        _state.agentWalletId = r.wallet.walletId;
        _state.agentLabel = r.wallet.label;
        _saveWalletRef();
        _emit('walletCreated', r.wallet);
      }
      return r;
    },

    getWallet: async function() {
      var owner = window.walletState ? window.walletState.address : null;
      if (!owner) return { success: false, wallet: null };
      return _api('/wallet/' + encodeURIComponent(owner));
    },

    getWalletInfo: async function(address) {
      return _api('/wallet-info/' + encodeURIComponent(address));
    },

    linkAgent: async function(agentId) {
      var owner = window.walletState ? window.walletState.address : null;
      if (!owner) return { success: false, error: 'No wallet' };
      return _api('/link-agent', {
        method: 'POST',
        body: JSON.stringify({ ownerAddress: owner, agentId: agentId }),
      });
    },

    /**
     * Get a summary of the agent wallet for display in chat.
     */
    getSummary: async function() {
      var parts = [];
      if (_state.agentAddress) {
        parts.push('**Agent Wallet**: `' + _state.agentAddress.slice(0, 10) + '…`');
        if (_state.agentLabel) parts.push('Label: ' + _state.agentLabel);
        try {
          var info = await D.AgentWallet.getWalletInfo(_state.agentAddress);
          if (info.success && info.wallet) {
            parts.push('USDC: ' + (info.wallet.balances.USDC?.human || '0') + ' | EURC: ' + (info.wallet.balances.EURC?.human || '0'));
          }
        } catch (e) {}
      } else {
        parts.push('**No agent wallet created yet.** Type `create agent wallet` to generate one.');
      }
      if (_state.isRegistered) {
        parts.push('ERC-8004 Agent ID: ' + _state.agentId);
      }
      parts.push('Permissions: ' + (_state.isRegistered ? 'Registered' : 'Not registered'));
      return parts.join('\n');
    },

    // ── Init ─────────────────────────────────────────────────────────────────
    init: async function() {
      if (_state.initialized) return _state;
      _state.initialized = true;

      // Restore persisted wallet reference from localStorage (cache only, NOT authoritative)
      _restoreWalletRef();

      var owner = window.walletState ? window.walletState.address : null;
      if (!owner) { console.log('[AgentWallet] No wallet — skipping init'); return _state; }

      // Attempt to restore agent wallet via backend
      var restored = false;
      if (_state.agentWalletId) {
        // Primary: restore by walletId (fast in-session cache hit)
        try {
          var restore = await _api('/restore', {
            method: 'POST',
            body: JSON.stringify({ walletId: _state.agentWalletId, ownerAddress: owner }),
          });
          if (restore.success && restore.wallet) {
            _state.agentAddress = restore.wallet.address;
            _state.agentWalletId = restore.wallet.walletId;
            _state.agentLabel = restore.wallet.label;
            _saveWalletRef();
            restored = true;
            console.log('[AgentWallet] restored:', _state.agentAddress);
          } else if (restore.success === false && restore.message && restore.message.indexOf('not found') >= 0) {
            // Confirmed wallet does not exist — clear reference
            console.log('[AgentWallet] wallet not found — clearing ref');
            _state.agentWalletId = null;
            _state.agentAddress = null;
            _state.agentLabel = null;
            _saveWalletRef();
          }
          // For any other response (transient error, 500, network failure):
          // DO NOT clear the reference. Keep it for next retry.
        } catch (e) {
          // Network/backend transient error — keep reference, retry later
          console.log('[AgentWallet] restore transient error — keeping ref:', e.message);
        }
      }

      // If restore by walletId didn't work, try owner-based recovery (cold start)
      if (!restored) {
        try {
          var w = await _api('/wallet/' + encodeURIComponent(owner));
          if (w.success && w.wallet) {
            _state.agentWalletId = w.wallet.walletId;
            _state.agentAddress = w.wallet.address;
            _state.agentLabel = w.wallet.label;
            _saveWalletRef();
            console.log('[AgentWallet] owner recovery:', _state.agentAddress);
            restored = true;
          }
        } catch (e) {
          console.log('[AgentWallet] owner lookup error — will retry:', e.message);
        }
      }

      if (!restored) {
        console.log('[AgentWallet] no existing wallet for owner:', owner.slice(0, 10) + '...');
      }

      if (D.ERC8004 && D.ERC8004.IdentityManager) {
        await D.ERC8004.IdentityManager.init();
        var id = D.ERC8004.IdentityManager.state;
        _state.isRegistered = id.isRegistered;
        _state.agentId       = id.agentId;
        _state.metadata      = id.metadata;

        if (_state.isRegistered) {
          await D.ERC8004.IdentityManager.loadReputation();
          _state.reputationStats = D.ERC8004.IdentityManager.state.reputation;
          await D.ERC8004.IdentityManager.loadValidationState();
          _state.pendingValidations = D.ERC8004.IdentityManager.state.validation;
          await D.AgentWallet.refreshTreasury();
        }
      }
      _emit('initialized', _state);
      return _state;
    },

    // ── Register ─────────────────────────────────────────────────────────────
    register: async function(options) {
      if (!D.ERC8004 || !D.ERC8004.IdentityManager) return { success: false, error: 'ERC-8004 module not loaded' };
      var result = await D.ERC8004.IdentityManager.register(options);
      if (result.success) {
        _state.isRegistered = true;
        _state.agentId = result.agentId;
        _emit('registered', { agentId: result.agentId, txHash: result.txHash });
      }
      return result;
    },

    unregister: function() {
      if (D.ERC8004 && D.ERC8004.IdentityManager) D.ERC8004.IdentityManager.reset();
      _state.isRegistered = false;
      _state.agentId = null;
      _state.metadata = null;
      _emit('unregistered', {});
    },

    // ── Reputation ───────────────────────────────────────────────────────────
    getReputation: async function() {
      if (!_state.agentId) return { success: false, error: 'No agent registered' };
      if (!D.ERC8004 || !D.ERC8004.ReputationClient) return { success: false, error: 'ReputationClient not loaded' };
      var result = await D.ERC8004.ReputationClient.getStats(_state.agentId);
      if (result.success) { _state.reputationStats = result; _emit('reputationUpdated', result); }
      return result;
    },

    recordReputation: async function(score, tag) {
      if (!_state.agentId) return { success: false, error: 'No agent registered' };
      return _api('/reputation/record', {
        method: 'POST',
        body: JSON.stringify({ agentId: _state.agentId, score: score, tag: tag }),
      });
    },

    getReputationHistory: async function() {
      if (!_state.agentId) return { success: false, error: 'No agent registered' };
      if (!D.ERC8004 || !D.ERC8004.ReputationClient) return { success: false, error: 'ReputationClient not loaded' };
      return D.ERC8004.ReputationClient.getFeedbackHistory(_state.agentId);
    },

    // ── Validation ──────────────────────────────────────────────────────────
    requestValidation: async function(validatorAddress, tag) {
      if (!_state.agentId) return { success: false, error: 'No agent registered' };
      if (!D.ERC8004 || !D.ERC8004.ValidationClient) return { success: false, error: 'ValidationClient not loaded' };
      var hash = D.ERC8004.ValidationClient.generateRequestHash(_state.agentId, tag || 'capability_audit');
      var result = await D.ERC8004.ValidationClient.requestValidation(validatorAddress, _state.agentId, '', hash);
      if (result.success) { _state.pendingValidations.push(hash); _emit('validationRequested', { requestHash: hash }); }
      return result;
    },

    getValidationStatus: async function(requestHash) {
      if (!D.ERC8004 || !D.ERC8004.ValidationClient) return { success: false, error: 'ValidationClient not loaded' };
      return D.ERC8004.ValidationClient.getStatus(requestHash);
    },

    respondToValidation: async function(requestHash, response, tag) {
      return _api('/validation/respond', {
        method: 'POST',
        body: JSON.stringify({ requestHash: requestHash, response: response, tag: tag }),
      });
    },

    // ── Treasury ─────────────────────────────────────────────────────────────
    refreshTreasury: async function() {
      if (!_state.agentId) return { success: false, error: 'No agent registered' };
      var result = await _api('/treasury/' + encodeURIComponent(_state.agentId));
      if (result.success) { _state.treasuryBalances = result.treasury; _emit('treasuryRefreshed', result.treasury); }
      return result;
    },

    // ── Permissions ──────────────────────────────────────────────────────────
    grantPermission: async function(capability, limits) {
      return _api('/permissions', {
        method: 'POST',
        body: JSON.stringify({
          agentId: _state.agentId,
          capability: capability,
          dailyLimit: String(limits.dailyLimit || 500),
          perTxLimit: String(limits.perTxLimit || 50),
          monthlyLimit: String(limits.monthlyLimit || 5000),
          durationDays: limits.durationDays || 30,
          allowedTokens: limits.allowedTokens || ['USDC'],
          allowedOperations: limits.allowedOperations || ['transfer'],
        }),
      });
    },

    getPermissions: async function() {
      if (!_state.agentId) return { success: false, error: 'No agent registered' };
      return _api('/permissions/' + encodeURIComponent(_state.agentId));
    },

    revokePermission: async function(permissionId) {
      return _api('/permissions/' + encodeURIComponent(permissionId) + '/revoke', { method: 'PUT' });
    },

    // ── Audit ───────────────────────────────────────────────────────────────
    getAuditLog: async function(limit) {
      if (!_state.agentId) return { success: false, error: 'No agent registered' };
      var result = await _api('/audit/' + encodeURIComponent(_state.agentId) + '?limit=' + (limit || 50));
      if (result.success) _state.auditEntries = result.logs;
      return result;
    },

    // ── Capabilities ─────────────────────────────────────────────────────────
    getCapabilities: async function() { return _api('/capabilities'); },

    // ── Schedules ────────────────────────────────────────────────────────────
    createSchedule: async function(name, action, params, cronExpression) {
      return _api('/schedules', {
        method: 'POST',
        body: JSON.stringify({ agentId: _state.agentId, name: name, action: action, params: params, cronExpression: cronExpression }),
      });
    },

    getSchedules: async function() {
      if (!_state.agentId) return { success: false, error: 'No agent registered' };
      return _api('/schedules/' + encodeURIComponent(_state.agentId));
    },

    toggleSchedule: async function(scheduleId) {
      return _api('/schedules/' + encodeURIComponent(scheduleId) + '/toggle', { method: 'PUT' });
    },

    deleteSchedule: async function(scheduleId) {
      return _api('/schedules/' + encodeURIComponent(scheduleId), { method: 'DELETE' });
    },

    // ── Execution Validation ─────────────────────────────────────────────────
    validateAction: async function(action, amount, token) {
      return _api('/execute/validate', {
        method: 'POST',
        body: JSON.stringify({ agentId: _state.agentId, action: action, amount: String(amount), token: token || 'USDC' }),
      });
    },

    // ═══════════════════════════════════════════════════════════════
    //  COMPATIBILITY HOOKS (event-based — ZERO modifications needed)
    // ═══════════════════════════════════════════════════════════════

    /**
     * Policy Check — other modules subscribe via event listener.
     * Returns {allowed, reason, permissionId}
     */
    policyCheck: async function(action, params) {
      if (!_state.isRegistered) return { allowed: false, reason: 'Agent not registered' };
      var result = await D.AgentWallet.validateAction(action, params.amount, params.token);
      _emit('policyCheck', { action: action, params: params, result: result });
      return {
        allowed: result.valid === true,
        reason: result.reason || null,
        permissionId: result.permission || null,
      };
    },

    /**
     * Scheduler Check — emits event for scheduler to consume.
     */
    schedulerCheck: async function(scheduleId) {
      var schedules = await D.AgentWallet.getSchedules();
      var result = { allowed: false, reason: 'Schedule not found', scheduleId: scheduleId };
      if (schedules.success) {
        var found = schedules.schedules.find(function(s) { return s.id === scheduleId; });
        if (found && found.active) result = { allowed: true, reason: null, scheduleId: scheduleId };
      }
      _emit('scheduleChecked', result);
      return result;
    },

    /**
     * Pre-flight check before any autonomous execution.
     * Other modules listen for agentWallet:executionRequested.
     */
    preflightCheck: async function(intent) {
      if (!_state.isRegistered) {
        _emit('executionRequested', { intent: intent, allowed: false, reason: 'Agent not registered' });
        return { allowed: false, reason: 'Agent not registered' };
      }
      var result = await D.AgentWallet.validateAction(intent.type || 'transfer', intent.amount, intent.token);
      _emit('executionRequested', { intent: intent, allowed: result.valid, result: result });
      return { allowed: result.valid, reason: result.reason, permissionId: result.permission };
    },
  };

  // ── Persist/Restore wallet reference in localStorage ──────────────────────
  function _saveWalletRef() {
    try {
      localStorage.setItem(WALLET_STORAGE_KEY, JSON.stringify({
        walletId: _state.agentWalletId,
        address: _state.agentAddress,
        label: _state.agentLabel,
        updatedAt: new Date().toISOString(),
      }));
    } catch (e) {}
  }
  function _restoreWalletRef() {
    try {
      var raw = localStorage.getItem(WALLET_STORAGE_KEY);
      if (raw) {
        var d = JSON.parse(raw);
        _state.agentWalletId = d.walletId || null;
        _state.agentAddress = d.address || null;
        _state.agentLabel = d.label || null;
      }
    } catch (e) {}
  }

  // ═══════════════════════════════════════════════════════════════
  //  CHAT COMMAND INTERCEPTOR
  //  Handles agent wallet commands typed in Autonoma / main chat.
  //  ADDITIVE — does not modify any existing chat handler.
  // ═══════════════════════════════════════════════════════════════
  function _handleChatCommand(msg) {
    var lower = msg.toLowerCase().trim();

    if (/^(create|criar|new|generate)\s+(agent\s+)?wallet$/i.test(lower)) {
      return _cmdCreateWallet();
    }
    if (/^agent\s+wallet(\s+status)?$/i.test(lower) || /^(my |meu )?agent wallet$/i.test(lower)) {
      return _cmdWalletStatus();
    }
    if (/^agent\s+wallet\s+balance$/i.test(lower)) {
      return _cmdWalletBalance();
    }
    if (/^(register|registrar)\s+(agent|my agent)$/i.test(lower)) {
      return _cmdRegisterAgent();
    }

    // ── Swap commands ──────────────────────────────────────────────────────
    var swapMatch = lower.match(/^swap\s+(\d+\.?\d*)\s+(usdc|eurc)\s+(to|for|→)\s+(usdc|eurc)$/i);
    if (swapMatch) {
      var amount = swapMatch[1];
      var fromToken = swapMatch[2].toUpperCase();
      var toToken = swapMatch[4].toUpperCase();
      return _cmdCreateSwapIntent(amount, fromToken, toToken);
    }

    // ── Bridge commands ─────────────────────────────────────────────────────
    var bridgeMatch = lower.match(/^bridge\s+(\d+\.?\d*)\s+(usdc|eurc)\s+(to|for|→)\s+([a-z]+)$/i);
    if (bridgeMatch) {
      return _cmdCreateBridgeIntent(bridgeMatch[1], bridgeMatch[2].toUpperCase(), bridgeMatch[4].toLowerCase());
    }

    // ── Payment / Send commands ─────────────────────────────────────────────
    var sendMatch = lower.match(/^send\s+(\d+\.?\d*)\s+(usdc|eurc)\s+(to|for|→)\s+(0x[a-fA-F0-9]{40})$/i);
    if (sendMatch) {
      return _cmdCreatePaymentIntent(sendMatch[1], sendMatch[2].toUpperCase(), sendMatch[4]);
    }

    // ── Multisend commands ──────────────────────────────────────────────────
    var multiMatch = lower.match(/^multisend\s+(\d+\.?\d*)\s+(usdc|eurc)\s+to\s+(.+)$/i);
    if (multiMatch) {
      return _cmdCreateMultisendIntent(multiMatch[1], multiMatch[2].toUpperCase(), multiMatch[3]);
    }

    // ── Cross-chain payment commands ────────────────────────────────────────
    var xchainMatch = lower.match(/^(crosschain|cross-chain|cross\s*chain)\s+send\s+(\d+\.?\d*)\s+(usdc|eurc)\s+to\s+(0x[a-fA-F0-9]{40})\s+on\s+([a-z]+)$/i);
    if (xchainMatch) {
      return _cmdCreateCrossChainIntent(xchainMatch[2], xchainMatch[3].toUpperCase(), xchainMatch[4], xchainMatch[5].toLowerCase());
    }

    // ── Schedule commands ───────────────────────────────────────────────────
    var schedMatch = lower.match(/^schedule\s+(swap|send|bridge|multisend)\s+(.+)\s+every\s+(.+)$/i);
    if (schedMatch) {
      return _cmdCreateScheduleIntent(schedMatch[1].toLowerCase(), schedMatch[2], schedMatch[3]);
    }

    // ── Intent management ───────────────────────────────────────────────────
    if (/^(show |list |my )?intents$/i.test(lower) || /^pending intents$/i.test(lower)) {
      return _cmdShowIntents();
    }
    if (/^approve\s+intent\s+(\S+)$/i.test(lower)) {
      return _cmdApproveIntent(RegExp.$1);
    }
    if (/^cancel\s+intent\s+(\S+)$/i.test(lower)) {
      return _cmdCancelIntent(RegExp.$1);
    }

    // ── Help ────────────────────────────────────────────────────────────────
    if (/^agent\s+(help|commands)$/i.test(lower)) {
      return _cmdAgentHelp();
    }

    return null;
  }

  async function _cmdCreateWallet() {
    var r = await D.AgentWallet.createWallet();
    if (r.success) {
      if (r.existing) {
        _appendChat('assistant', '**Agent Wallet already exists**\n\nAddress: `' + r.wallet.address + '`\nLabel: ' + r.wallet.label, 'agentWallet');
      } else {
        _appendChat('assistant', '**Agent Wallet Created**\n\nAddress: `' + r.wallet.address + '`\n\nFund this wallet with testnet USDC to enable autonomous operations.\n\nFaucet: https://faucet.circle.com', 'agentWallet');
      }
    } else {
      _appendChat('assistant', 'Failed to create agent wallet: ' + (r.error || 'Unknown error'), 'error');
    }
    return true;
  }

  async function _cmdWalletStatus() {
    var summary = await D.AgentWallet.getSummary();
    _appendChat('assistant', summary, 'agentWallet');
    return true;
  }

  async function _cmdWalletBalance() {
    if (!_state.agentAddress) {
      _appendChat('assistant', 'No agent wallet yet. Type `create agent wallet` to generate one.', 'agentWallet');
      return true;
    }
    var info = await D.AgentWallet.getWalletInfo(_state.agentAddress);
    if (info.success && info.wallet) {
      var usdc = info.wallet.balances.USDC?.human || '0';
      var eurc = info.wallet.balances.EURC?.human || '0';
      _appendChat('assistant', '**Agent Wallet Balance**\n\nUSDC: ' + usdc + '\nEURC: ' + eurc + '\n\nAddress: `' + _state.agentAddress + '`\nExplorer: ' + info.wallet.explorerUrl, 'agentWallet');
    } else {
      _appendChat('assistant', 'Could not fetch balance. Try again.', 'error');
    }
    return true;
  }

  async function _cmdRegisterAgent() {
    if (!_state.agentAddress) {
      _appendChat('assistant', 'Create an agent wallet first with `create agent wallet`.', 'agentWallet');
      return true;
    }
    _appendChat('assistant', '**Registering ERC-8004 Agent...**\n\nThis will create an on-chain identity for your agent wallet.\n\nWallet: `' + _state.agentAddress + '`\n\nType `confirm register` to proceed, or `cancel`.', 'agentWallet');
    return true;
  }

  // ── Swap Intent ───────────────────────────────────────────────────────────
  async function _cmdCreateSwapIntent(amount, fromToken, toToken) {
    if (!_state.agentAddress) {
      _appendChat('assistant', 'No agent wallet. Type `create agent wallet` first.', 'agentWallet');
      return true;
    }
    var intentId = 'swp-' + Date.now().toString(36);
    var payload = { type: 'swap', amount: amount, token: fromToken, targetToken: toToken };
    // Emit intent for execution engine
    window.dispatchEvent(new CustomEvent('agentIntent:created', { detail: { id: intentId, type: 'swap', params: payload, source: 'autonoma' } }));

    _appendChat('assistant',
      '**Swap Intent Created**\n\n' +
      'ID: `' + intentId + '`\n' +
      'Swap: ' + amount + ' ' + fromToken + ' → ' + toToken + '\n\n' +
      'Status: Pending approval\n\n' +
      'This intent will be validated by the Policy Engine and routed through\n' +
      'the existing ExecDaat Swap module when approved.\n\n' +
      'Type `show intents` to view all pending intents.\n' +
      'Type `approve intent ' + intentId + '` to approve.',
      'swap');
    return true;
  }

  // ── Bridge Intent ─────────────────────────────────────────────────────────
  async function _cmdCreateBridgeIntent(amount, token, destination) {
    if (!_state.agentAddress) {
      _appendChat('assistant', 'No agent wallet. Type `create agent wallet` first.', 'agentWallet');
      return true;
    }
    var supported = ['arbitrum', 'ethereum', 'base', 'optimism', 'polygon'];
    if (supported.indexOf(destination) === -1) {
      _appendChat('assistant', '**Unsupported destination.**\n\nSupported chains: ' + supported.join(', ') + '\n\nExample: `bridge 10 USDC to arbitrum`', 'bridge');
      return true;
    }
    var intentId = 'brg-' + Date.now().toString(36);
    var payload = { type: 'bridge', amount: amount, token: token, destination: destination };
    window.dispatchEvent(new CustomEvent('agentIntent:created', { detail: { id: intentId, type: 'bridge', params: payload, source: 'autonoma' } }));

    _appendChat('assistant',
      '**Bridge Intent Created**\n\n' +
      'ID: `' + intentId + '`\n' +
      'Bridge: ' + amount + ' ' + token + ' → **' + destination.charAt(0).toUpperCase() + destination.slice(1) + '**\n\n' +
      'Status: Pending approval\n\n' +
      'This intent routes through the existing ExecDaat Bridge module (Circle CCTP).\n' +
      'Type `show intents` to view all pending intents.\n' +
      'Type `approve intent ' + intentId + '` to approve.',
      'bridge');
    return true;
  }

  // ── Payment Intent ────────────────────────────────────────────────────────
  async function _cmdCreatePaymentIntent(amount, token, recipient) {
    if (!_state.agentAddress) {
      _appendChat('assistant', 'No agent wallet. Type `create agent wallet` first.', 'agentWallet');
      return true;
    }
    var intentId = 'pay-' + Date.now().toString(36);
    var payload = { type: 'transfer', amount: amount, token: token, to: recipient };
    window.dispatchEvent(new CustomEvent('agentIntent:created', { detail: { id: intentId, type: 'transfer', params: payload, source: 'autonoma' } }));

    _appendChat('assistant',
      '**Payment Intent Created**\n\n' +
      'ID: `' + intentId + '`\n' +
      'Send: ' + amount + ' ' + token + ' → `' + recipient.slice(0, 10) + '…`\n\n' +
      'Status: Pending approval\n\n' +
      'This intent routes through the existing ExecDaat Payments module.\n' +
      'Type `show intents` to view all pending intents.',
      'payments');
    return true;
  }

  // ── Intent Management ─────────────────────────────────────────────────────
  async function _cmdShowIntents() {
    _appendChat('assistant',
      '**Pending Agent Intents**\n\n' +
      'Intents from this session are listed below. Use `approve intent <id>` to execute.\n\n' +
      '_Note: Full intent history is managed by the Intent Manager module._',
      'intents');
    return true;
  }

  async function _cmdApproveIntent(intentId) {
    window.dispatchEvent(new CustomEvent('agentIntent:approved', { detail: { id: intentId } }));
    _appendChat('assistant', '**Intent ' + intentId + ' approved.**\n\nRouting to Execution Engine for processing...', 'intents');
    return true;
  }

  async function _cmdCancelIntent(intentId) {
    window.dispatchEvent(new CustomEvent('agentIntent:cancelled', { detail: { id: intentId } }));
    _appendChat('assistant', 'Intent `' + intentId + '` cancelled.', 'intents');
    return true;
  }

  // ── Multisend Intent ─────────────────────────────────────────────────────
  async function _cmdCreateMultisendIntent(amount, token, addressesRaw) {
    if (!_state.agentAddress) {
      _appendChat('assistant', 'No agent wallet. Type `create agent wallet` first.', 'agentWallet');
      return true;
    }
    var addresses = addressesRaw.split(/[,;\s]+/).filter(function(a) { return /^0x[a-fA-F0-9]{40}$/.test(a); });
    if (addresses.length === 0) {
      _appendChat('assistant', 'Invalid address format. Use: `multisend 10 USDC to 0x..., 0x..., 0x...`', 'multisend');
      return true;
    }
    if (addresses.length > 100) {
      _appendChat('assistant', 'Maximum 100 recipients per multisend.', 'multisend');
      return true;
    }
    var estimatedTotal = (parseFloat(amount) * addresses.length).toFixed(2);
    var intentId = 'mul-' + Date.now().toString(36);
    var payload = { type: 'multisend', amount: amount, token: token, recipients: addresses };
    window.dispatchEvent(new CustomEvent('agentIntent:created', { detail: { id: intentId, type: 'multisend', params: payload, source: 'autonoma' } }));

    _appendChat('assistant',
      '**Multisend Intent Created**\n\n' +
      'ID: `' + intentId + '`\n' +
      'Send: ' + amount + ' ' + token + ' × **' + addresses.length + ' recipients**\n' +
      'Estimated total: ' + estimatedTotal + ' ' + token + '\n\n' +
      'Recipients:\n' + addresses.slice(0, 5).map(function(a) { return '• `' + a.slice(0, 8) + '…`'; }).join('\n') +
      (addresses.length > 5 ? '\n• … and ' + (addresses.length - 5) + ' more' : '') + '\n\n' +
      'Status: Pending approval\n\n' +
      'This intent routes through the existing ExecDaat MultiSend module.\n' +
      'Type `approve intent ' + intentId + '` to approve.',
      'multisend');
    return true;
  }

  // ── Cross-Chain Payment Intent ────────────────────────────────────────────
  async function _cmdCreateCrossChainIntent(amount, token, recipient, chain) {
    if (!_state.agentAddress) {
      _appendChat('assistant', 'No agent wallet. Type `create agent wallet` first.', 'agentWallet');
      return true;
    }
    var supported = ['arbitrum', 'ethereum', 'base', 'optimism', 'polygon'];
    if (supported.indexOf(chain) === -1) {
      _appendChat('assistant', '**Unsupported chain.** Supported: ' + supported.join(', ') + '\n\nExample: `crosschain send 10 USDC to 0x... on arbitrum`', 'bridge');
      return true;
    }
    var intentId = 'xch-' + Date.now().toString(36);
    var payload = { type: 'crosschain-transfer', amount: amount, token: token, to: recipient, destination: chain };
    window.dispatchEvent(new CustomEvent('agentIntent:created', { detail: { id: intentId, type: 'crosschain-transfer', params: payload, source: 'autonoma' } }));

    _appendChat('assistant',
      '**Cross-Chain Payment Intent Created**\n\n' +
      'ID: `' + intentId + '`\n' +
      'Send: ' + amount + ' ' + token + ' → `' + recipient.slice(0, 10) + '…`\n' +
      'Destination: **' + chain.charAt(0).toUpperCase() + chain.slice(1) + '**\n\n' +
      'Status: Pending approval\n\n' +
      'This intent routes through the existing ExecDaat Bridge module (Circle CCTP).\n' +
      'Type `approve intent ' + intentId + '` to approve.',
      'bridge');
    return true;
  }

  // ── Schedule Intent (recurring operation) ──────────────────────────────────
  async function _cmdCreateScheduleIntent(actionType, params, schedule) {
    if (!_state.agentAddress) {
      _appendChat('assistant', 'No agent wallet. Type `create agent wallet` first.', 'agentWallet');
      return true;
    }
    var intentId = 'sch-' + Date.now().toString(36);
    _appendChat('assistant',
      '**Scheduled Intent Created**\n\n' +
      'ID: `' + intentId + '`\n' +
      'Action: ' + actionType + '\n' +
      'Details: ' + params + '\n' +
      'Schedule: every ' + schedule + '\n\n' +
      'Status: Pending approval\n\n' +
      'This intent routes through the existing ExecDaat Scheduler module.\n' +
      'Type `approve intent ' + intentId + '` to activate.',
      'scheduler');
    return true;
  }

  // ── Help ──────────────────────────────────────────────────────────────────
  async function _cmdAgentHelp() {
    _appendChat('assistant',
      '**Agent Wallet Commands**\n\n' +
      '**Wallet**:\n' +
      '• `create agent wallet` — Create your agent wallet\n' +
      '• `agent wallet status` — View wallet status\n' +
      '• `agent wallet balance` — Check balances\n\n' +
      '**Swap**:\n' +
      '• `swap 10 USDC to EURC` — Create swap intent\n\n' +
      '**Bridge**:\n' +
      '• `bridge 50 USDC to arbitrum` — Create bridge intent\n' +
      '  Supported: arbitrum, ethereum, base, optimism, polygon\n\n' +
      '**Payments**:\n' +
      '• `send 25 USDC to 0x...` — Send payment\n\n' +
      '**MultiSend**:\n' +
      '• `multisend 10 USDC to 0x..., 0x..., 0x...` — Batch payment to multiple addresses\n\n' +
      '**Cross-Chain**:\n' +
      '• `crosschain send 10 USDC to 0x... on arbitrum` — Cross-chain payment\n\n' +
      '**Schedule**:\n' +
      '• `schedule swap 5 USDC to EURC every friday` — Recurring operation\n' +
      '• `schedule send 10 USDC to 0x... every day` — Recurring payment\n\n' +
      '**Intents**:\n' +
      '• `show intents` — View pending intents\n' +
      '• `approve intent <id>` — Approve an intent\n' +
      '• `cancel intent <id>` — Cancel an intent\n\n' +
      '**Other**:\n' +
      '• `register agent` — Register ERC-8004 identity\n' +
      '• `agent help` — Show this help',
      'agentWallet');
    return true;
  }

  // ── Hook into the global chat message handler ────────────────────────────
  function _appendChat(role, content, module) {
    if (typeof window.appendChatMessage === 'function') {
      window.appendChatMessage(role, content, module || 'agentWallet');
    }
  }

  // Intercept chat messages (additive — wraps existing handler)
  var _origHandleUnified = null;
  function _installChatInterceptor() {
    if (_origHandleUnified) return;
    _origHandleUnified = window.handleUnifiedMessage;
    if (typeof _origHandleUnified === 'function') {
      window.handleUnifiedMessage = async function(msg, source) {
        var handled = await _handleChatCommand(msg);
        if (handled) return true;
        return _origHandleUnified(msg, source);
      };
      console.log('[AgentWallet] Chat interceptor installed');
    }
    // Also hook the autonoma send
    var _origAutonomaSend = window.autonomaSendMessage;
    if (typeof _origAutonomaSend === 'function') {
      var orig = _origAutonomaSend;
      window.autonomaSendMessage = async function() {
        var input = document.getElementById('autonoma-chat-input');
        var msg = input?.value?.trim();
        if (msg) {
          var handled = await _handleChatCommand(msg);
          if (handled) {
            input.value = '';
            return;
          }
        }
        return orig();
      };
      console.log('[AgentWallet] Autonoma chat interceptor installed');
    }
  }

  // ── Listen for ERC-8004 events ───────────────────────────────────────────
  window.addEventListener('erc8004:agentRegistered', function(e) {
    _state.isRegistered = true;
    _state.agentId = e.detail.agentId;
    _emit('registered', e.detail);
  });

  // ── Auto-init + chat interceptor ──────────────────────────────────────────
  window.addEventListener('walletConnected', function() {
    setTimeout(function() { D.AgentWallet.init(); }, 800);
  });
  setTimeout(_installChatInterceptor, 1000);
  if (document.readyState !== 'loading') { setTimeout(_installChatInterceptor, 1000); }
  else { document.addEventListener('DOMContentLoaded', function() { setTimeout(_installChatInterceptor, 1000); }); }

  console.log('[AgentWallet Core v2] Hardened — agent wallet + chat commands');
})();
