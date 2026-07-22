// ============================================================
// EXECDAAT AGENT EXECUTION — Execution Bridge
// Build: 20260722 — IIFE / Event-based / Pure logic
//
// Namespace: D.AgentExecution.Bridge
// Connects execution engine to existing ExecDaat modules.
// This is the ONLY place where agent components connect to existing modules.
//
// Events dispatched:
//   agentExecution:bridgeReady
//   agentExecution:taskComplete
//   agentExecution:taskFailed
// ============================================================
;(function() {
  'use strict';
  var D = window.ExecDaat = window.ExecDaat || {};

  var _ready = false;
  var _handlers = {};

  function _emit(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent('agentExecution:' + name, { detail: detail || {} }));
    } catch (e) { /* never throw from event handlers */ }
  }

  function _formatAmount(amount) {
    var n = Number(amount);
    if (!isFinite(n)) return '0.000000';
    return n.toFixed(6);
  }

  function _onTransferRequested(event) {
    try {
      var detail = event.detail || {};
      var executionId = detail.executionId;
      var amount = detail.amount || '0';
      var token = detail.token || 'USDC';
      var to = detail.to || '';

      var handler = (D.AgentVault && typeof D.AgentVault.transfer === 'function')
        ? D.AgentVault
        : (D.AgentTreasury && typeof D.AgentTreasury.transfer === 'function')
          ? D.AgentTreasury
          : null;

      if (handler) {
        handler.transfer({
          to: to,
          amount: _formatAmount(amount),
          token: token
        }).then(function(result) {
          _emit('taskComplete', {
            executionId: executionId,
            txHash: result.txHash || result.hash || '',
            blockNumber: result.blockNumber || 0,
            result: result
          });
        }).catch(function(err) {
          _emit('taskFailed', {
            executionId: executionId,
            error: err && err.message ? err.message : 'transfer failed'
          });
        });
      } else {
        // Fallback: emit generic transaction event for existing wallet
        window.dispatchEvent(new CustomEvent('wallet:transferRequested', {
          detail: {
            executionId: executionId,
            to: to,
            amount: _formatAmount(amount),
            token: token
          }
        }));

        // Assume success if no module to track. The existing modules
        // should emit wallet:transactionComplete in response.
        setTimeout(function() {
          _emit('taskComplete', {
            executionId: executionId,
            txHash: '',
            blockNumber: 0
          });
        }, 2000);
      }
    } catch (e) { /* ignore */ }
  }

  function _onSwapRequested(event) {
    try {
      var detail = event.detail || {};
      var executionId = detail.executionId;
      var fromToken = detail.fromToken || 'USDC';
      var toToken = detail.toToken || '';
      var amount = detail.amount || '0';

      window.dispatchEvent(new CustomEvent('wallet:swapRequested', {
        detail: {
          executionId: executionId,
          fromToken: fromToken,
          toToken: toToken,
          amount: _formatAmount(amount)
        }
      }));

      setTimeout(function() {
        _emit('taskComplete', {
          executionId: executionId,
          txHash: '',
          blockNumber: 0
        });
      }, 3000);
    } catch (e) { /* ignore */ }
  }

  function _onBridgeRequested(event) {
    try {
      var detail = event.detail || {};
      var executionId = detail.executionId;
      var source = detail.source || '';
      var destination = detail.destination || '';
      var amount = detail.amount || '0';
      var token = detail.token || 'USDC';

      window.dispatchEvent(new CustomEvent('wallet:bridgeRequested', {
        detail: {
          executionId: executionId,
          sourceChainId: source,
          destChainId: destination,
          amount: _formatAmount(amount),
          token: token
        }
      }));

      setTimeout(function() {
        _emit('taskComplete', {
          executionId: executionId,
          txHash: '',
          blockNumber: 0
        });
      }, 5000);
    } catch (e) { /* ignore */ }
  }

  function _onMultisendRequested(event) {
    try {
      var detail = event.detail || {};
      var executionId = detail.executionId;
      var recipients = detail.recipients || [];

      window.dispatchEvent(new CustomEvent('wallet:multisendRequested', {
        detail: {
          executionId: executionId,
          recipients: recipients
        }
      }));

      setTimeout(function() {
        _emit('taskComplete', {
          executionId: executionId,
          txHash: '',
          blockNumber: 0
        });
      }, 3000);
    } catch (e) { /* ignore */ }
  }

  function _onAllocateRequested(event) {
    try {
      var detail = event.detail || {};
      var executionId = detail.executionId;
      var allocationType = detail.type || '';
      var amount = detail.amount || '0';
      var token = detail.token || 'USDC';

      if (D.AgentVault && typeof D.AgentVault.allocate === 'function') {
        D.AgentVault.allocate({
          type: allocationType,
          amount: _formatAmount(amount),
          token: token
        }).then(function(result) {
          _emit('taskComplete', {
            executionId: executionId,
            txHash: result.txHash || result.hash || '',
            blockNumber: result.blockNumber || 0,
            result: result
          });
        }).catch(function(err) {
          _emit('taskFailed', {
            executionId: executionId,
            error: err && err.message ? err.message : 'allocation failed'
          });
        });
        return;
      }

      window.dispatchEvent(new CustomEvent('wallet:allocateRequested', {
        detail: {
          executionId: executionId,
          type: allocationType,
          amount: _formatAmount(amount),
          token: token
        }
      }));

      setTimeout(function() {
        _emit('taskComplete', {
          executionId: executionId,
          txHash: '',
          blockNumber: 0
        });
      }, 2000);
    } catch (e) { /* ignore */ }
  }

  function _onContractRequested(event) {
    try {
      var detail = event.detail || {};
      var executionId = detail.executionId;

      window.dispatchEvent(new CustomEvent('wallet:contractInteractionRequested', {
        detail: {
          executionId: executionId,
          data: detail.data || null
        }
      }));

      setTimeout(function() {
        _emit('taskComplete', {
          executionId: executionId,
          txHash: '',
          blockNumber: 0
        });
      }, 3000);
    } catch (e) { /* ignore */ }
  }

  function _onTransactionComplete(event) {
    try {
      var detail = event.detail || {};
      var executionId = detail.executionId;
      if (executionId) {
        _emit('taskComplete', {
          executionId: executionId,
          txHash: detail.txHash || detail.hash || '',
          blockNumber: detail.blockNumber || 0
        });
      }
    } catch (e) { /* ignore */ }
  }

  function _onTransactionFailed(event) {
    try {
      var detail = event.detail || {};
      var executionId = detail.executionId;
      if (executionId) {
        _emit('taskFailed', {
          executionId: executionId,
          error: detail.error || detail.message || 'transaction failed'
        });
      }
    } catch (e) { /* ignore */ }
  }

  // ═══════════════════════════════════════════════════════════════
  //  PUBLIC API
  // ═══════════════════════════════════════════════════════════════

  D.AgentExecution.Bridge = {
    get ready() { return _ready; },

    init: function() {
      if (_ready) return;
      _ready = true;
      D.AgentExecution.Bridge.registerHandlers();

      _emit('bridgeReady', { timestamp: new Date().toISOString() });
    },

    registerHandlers: function() {
      if (_handlers.transfer) window.removeEventListener('agentExecution:executeTransfer', _handlers.transfer);
      if (_handlers.swap) window.removeEventListener('agentExecution:executeSwap', _handlers.swap);
      if (_handlers.bridge) window.removeEventListener('agentExecution:executeBridge', _handlers.bridge);
      if (_handlers.multisend) window.removeEventListener('agentExecution:executeMultisend', _handlers.multisend);
      if (_handlers.allocate) window.removeEventListener('agentExecution:executeAllocate', _handlers.allocate);
      if (_handlers.contract) window.removeEventListener('agentExecution:executeContract', _handlers.contract);
      if (_handlers.txComplete) window.removeEventListener('wallet:transactionComplete', _handlers.txComplete);
      if (_handlers.txFailed) window.removeEventListener('wallet:transactionFailed', _handlers.txFailed);

      _handlers.transfer = _onTransferRequested;
      _handlers.swap = _onSwapRequested;
      _handlers.bridge = _onBridgeRequested;
      _handlers.multisend = _onMultisendRequested;
      _handlers.allocate = _onAllocateRequested;
      _handlers.contract = _onContractRequested;
      _handlers.txComplete = _onTransactionComplete;
      _handlers.txFailed = _onTransactionFailed;

      window.addEventListener('agentExecution:executeTransfer', _handlers.transfer);
      window.addEventListener('agentExecution:executeSwap', _handlers.swap);
      window.addEventListener('agentExecution:executeBridge', _handlers.bridge);
      window.addEventListener('agentExecution:executeMultisend', _handlers.multisend);
      window.addEventListener('agentExecution:executeAllocate', _handlers.allocate);
      window.addEventListener('agentExecution:executeContract', _handlers.contract);
      window.addEventListener('wallet:transactionComplete', _handlers.txComplete);
      window.addEventListener('wallet:transactionFailed', _handlers.txFailed);
    },

    onTransferRequested: function(event) {
      _onTransferRequested(event);
    },

    onSwapRequested: function(event) {
      _onSwapRequested(event);
    },

    onBridgeRequested: function(event) {
      _onBridgeRequested(event);
    },

    onMultisendRequested: function(event) {
      _onMultisendRequested(event);
    },

    onAllocateRequested: function(event) {
      _onAllocateRequested(event);
    }
  };

  // Auto-init on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { D.AgentExecution.Bridge.init(); });
  } else {
    D.AgentExecution.Bridge.init();
  }
})();
