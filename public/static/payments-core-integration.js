// ============================================================
// PAYMENTS TAB → DAAT AGENT CORE INTEGRATION
// Build: 20260408c — ExecDaat Platform
//
// Purpose: Bridge existing Payments UI to DAAT Agent Core
//
// Architecture:
//   Payments UI → payExecuteWithCore() → DaatAgentCore.processIntent()
//                                      → standardized execution
//
// Changes:
//   - All paySubmit(), payExecuteNow() routed through Core
//   - Permit2 checks centralized in Core
//   - Transaction building unified in Core
//   - No UI/layout changes, only internal routing
//
// ============================================================
'use strict';

(function(global) {

console.log('[PAY-CORE] Payments → Core integration loading...');

// Wait for Core to be ready
function waitForCore(callback, maxAttempts = 50) {
  let attempts = 0;
  const interval = setInterval(() => {
    if (global.DaatAgentCore) {
      clearInterval(interval);
      console.log('[PAY-CORE] DAAT Agent Core detected, initializing integration');
      callback();
    } else if (++attempts >= maxAttempts) {
      clearInterval(interval);
      console.error('[PAY-CORE] DAAT Agent Core not found after', maxAttempts, 'attempts');
    }
  }, 100);
}

// Initialize integration
waitForCore(function() {
  
  // ─── Integration API ────────────────────────────────────────────────────────
  
  /**
   * Execute payment via DAAT Agent Core
   * 
   * @param {Object} paymentData - { token, amount, recipient, note? }
   * @returns {Promise<Object>} Execution result
   */
  async function payExecuteWithCore(paymentData) {
    console.log('[PAY-CORE] Executing payment via Core:', paymentData);
    
    try {
      // Validate input
      if (!paymentData.token || !paymentData.amount || !paymentData.recipient) {
        throw new Error('Missing required fields: token, amount, recipient');
      }
      
      // Build structured intent
      const intent = {
        intent: 'transfer',
        token: paymentData.token,
        amount: paymentData.amount,
        recipient: paymentData.recipient,
        metadata: {
          note: paymentData.note || '',
          source: 'payments_tab',
          timestamp: Date.now(),
        },
      };
      
      // Show status message
      if (typeof arcAddNotif === 'function') {
        arcAddNotif('🔄 Processing payment via DAAT Agent...', 'info', 3000);
      }
      
      // Process via Core
      const result = await global.DaatAgentCore.processIntent(intent, 'ui');
      
      console.log('[PAY-CORE] Execution result:', result);
      
      // Handle result
      if (result.status === 'completed') {
        // Success
        if (typeof arcAddNotif === 'function') {
          arcAddNotif(`✅ Payment sent! TX: ${shortHash(result.txHash)}`, 'success', 5000);
        }
        
        // Update UI receipt history
        if (typeof payAddReceipt === 'function') {
          payAddReceipt({
            token: paymentData.token,
            amount: paymentData.amount,
            recipient: paymentData.recipient,
            note: paymentData.note || '',
            txHash: result.txHash,
            timestamp: Date.now(),
            status: 'confirmed',
          });
        }
        
        // Refresh balance
        if (typeof payRefreshBalance === 'function') {
          setTimeout(() => payRefreshBalance(), 2000);
        }
        
        return { success: true, ...result };
        
      } else if (result.requiresApproval) {
        // Permit2 approval required
        if (typeof arcAddNotif === 'function') {
          arcAddNotif('⚠️ Permit2 approval required. Please authorize spending.', 'warning', 5000);
        }
        
        // Show approval modal
        if (typeof showPermit2ApprovalModal === 'function') {
          showPermit2ApprovalModal(paymentData.token, paymentData.amount);
        }
        
        return { success: false, reason: 'approval_required', ...result };
        
      } else {
        // Other failure
        throw new Error(result.message || 'Payment execution failed');
      }
      
    } catch (err) {
      console.error('[PAY-CORE] Payment execution error:', err);
      
      if (typeof arcAddNotif === 'function') {
        arcAddNotif(`❌ Payment failed: ${err.message}`, 'error', 5000);
      }
      
      return { success: false, error: err.message };
    }
  }
  
  /**
   * Execute multisend via DAAT Agent Core
   * 
   * @param {Object} multisendData - { token, recipients: [{address, amount}] }
   * @returns {Promise<Object>} Execution result
   */
  async function msExecuteWithCore(multisendData) {
    console.log('[PAY-CORE] Executing multisend via Core:', multisendData);
    
    try {
      // Validate input
      if (!multisendData.token || !multisendData.recipients || multisendData.recipients.length === 0) {
        throw new Error('Missing required fields: token, recipients');
      }
      
      // Build structured intent
      const intent = {
        intent: 'multisend',
        token: multisendData.token,
        recipients: multisendData.recipients,
        metadata: {
          source: 'multisend_tab',
          timestamp: Date.now(),
        },
      };
      
      // Show status message
      if (typeof arcAddNotif === 'function') {
        arcAddNotif('🔄 Processing multisend batch via DAAT Agent...', 'info', 3000);
      }
      
      // Process via Core
      const result = await global.DaatAgentCore.processIntent(intent, 'ui');
      
      console.log('[PAY-CORE] Multisend result:', result);
      
      // Handle result
      if (result.status === 'completed') {
        // Success
        if (typeof arcAddNotif === 'function') {
          arcAddNotif(`✅ Multisend completed! ${multisendData.recipients.length} transfers sent`, 'success', 5000);
        }
        
        // Update UI receipt history
        if (typeof msAddReceipt === 'function') {
          msAddReceipt({
            token: multisendData.token,
            recipients: multisendData.recipients,
            txHash: result.txHash,
            timestamp: Date.now(),
            status: 'confirmed',
          });
        }
        
        // Refresh balance
        if (typeof payRefreshBalance === 'function') {
          setTimeout(() => payRefreshBalance(), 2000);
        }
        
        return { success: true, ...result };
        
      } else if (result.requiresApproval) {
        // Permit2 approval required
        const total = multisendData.recipients.reduce((sum, r) => sum + parseFloat(r.amount), 0);
        
        if (typeof arcAddNotif === 'function') {
          arcAddNotif('⚠️ Permit2 approval required. Please authorize spending.', 'warning', 5000);
        }
        
        if (typeof showPermit2ApprovalModal === 'function') {
          showPermit2ApprovalModal(multisendData.token, total);
        }
        
        return { success: false, reason: 'approval_required', ...result };
        
      } else {
        // Other failure
        throw new Error(result.message || 'Multisend execution failed');
      }
      
    } catch (err) {
      console.error('[PAY-CORE] Multisend execution error:', err);
      
      if (typeof arcAddNotif === 'function') {
        arcAddNotif(`❌ Multisend failed: ${err.message}`, 'error', 5000);
      }
      
      return { success: false, error: err.message };
    }
  }
  
  // ─── Helper Functions ───────────────────────────────────────────────────────
  
  function shortHash(hash) {
    if (!hash || hash.length < 12) return hash || '—';
    return hash.slice(0, 10) + '…' + hash.slice(-6);
  }
  
  // ─── Hook into existing payment functions ───────────────────────────────────
  
  // Store original functions
  const _originalPayExecuteNow = global.payExecuteNow;
  const _originalMsExecute = global.msExecute;
  
  /**
   * Override payExecuteNow() to route through Core
   */
  global.payExecuteNow = async function() {
    console.log('[PAY-CORE] payExecuteNow() called, routing to Core');
    
    try {
      // Get payment data from UI
      const token = (global.payState?.token || 'USDC').toUpperCase();
      const amountEl = document.getElementById('pay-amount');
      const recipientEl = document.getElementById('pay-recipient');
      const noteEl = document.getElementById('pay-note');
      
      if (!amountEl || !recipientEl) {
        throw new Error('Payment form elements not found');
      }
      
      const amount = parseFloat(amountEl.value);
      const recipient = recipientEl.value.trim();
      const note = noteEl ? noteEl.value.trim() : '';
      
      if (!amount || amount <= 0) {
        throw new Error('Please enter a valid amount');
      }
      
      if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
        throw new Error('Please enter a valid recipient address');
      }
      
      // Execute via Core
      const result = await payExecuteWithCore({ token, amount, recipient, note });
      
      if (result.success) {
        // Clear form
        if (amountEl) amountEl.value = '';
        if (recipientEl) recipientEl.value = '';
        if (noteEl) noteEl.value = '';
      }
      
      return result;
      
    } catch (err) {
      console.error('[PAY-CORE] payExecuteNow error:', err);
      
      // Fallback to original function if Core fails
      if (_originalPayExecuteNow && typeof _originalPayExecuteNow === 'function') {
        console.warn('[PAY-CORE] Falling back to original payExecuteNow');
        return await _originalPayExecuteNow.apply(this, arguments);
      }
      
      throw err;
    }
  };
  
  /**
   * Override msExecute() to route through Core
   */
  global.msExecute = async function() {
    console.log('[PAY-CORE] msExecute() called, routing to Core');
    
    try {
      // Get multisend data from UI
      const token = 'USDC'; // Multisend currently only supports USDC
      const recipients = global.msValidatedRows || [];
      
      if (recipients.length === 0) {
        throw new Error('No recipients to send to');
      }
      
      // Execute via Core
      const result = await msExecuteWithCore({ token, recipients });
      
      if (result.success) {
        // Clear batch
        if (typeof msClearRows === 'function') {
          msClearRows();
        }
        
        // Reset to step 1
        if (typeof msGoToStep === 'function') {
          msGoToStep(1);
        }
      }
      
      return result;
      
    } catch (err) {
      console.error('[PAY-CORE] msExecute error:', err);
      
      // Fallback to original function if Core fails
      if (_originalMsExecute && typeof _originalMsExecute === 'function') {
        console.warn('[PAY-CORE] Falling back to original msExecute');
        return await _originalMsExecute.apply(this, arguments);
      }
      
      throw err;
    }
  };
  
  // ─── Expose API ─────────────────────────────────────────────────────────────
  
  global.PaymentsCoreIntegration = {
    version: '20260408c',
    payExecuteWithCore,
    msExecuteWithCore,
  };
  
  console.log('[PAY-CORE] ✓ Integration complete');
  console.log('[PAY-CORE] ─ payExecuteNow() hooked');
  console.log('[PAY-CORE] ─ msExecute() hooked');
  console.log('[PAY-CORE] ─ All payments now routed through DAAT Agent Core');
  
  // Emit ready event
  window.dispatchEvent(new CustomEvent('payments-core:ready', {
    detail: { version: '20260408c' }
  }));
  
});

})(window);
