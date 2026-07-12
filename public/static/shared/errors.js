// ============================================================
// ExecDaat Error Reporting v2 — categorized errors + codes
// ============================================================
;(function() {
  'use strict';
  var D = window.ExecDaat = window.ExecDaat || {};

  // ─── Error codes ────────────────────────────────────────────────────────
  D.ERROR_CODES = {
    // Wallet (1xxx)
    WALLET_NOT_FOUND:       { code: 1000, msg: 'No wallet provider detected. Install MetaMask or compatible wallet.' },
    WALLET_REJECTED:        { code: 1001, msg: 'Transaction rejected by wallet.' },
    WALLET_DISCONNECTED:    { code: 1002, msg: 'Wallet disconnected.' },
    WALLET_WRONG_NETWORK:   { code: 1003, msg: 'Wrong network. Switch to Arc Testnet (Chain ID 5042002).' },
    WALLET_CHAIN_NOT_ADDED: { code: 1004, msg: 'Arc Testnet not added to wallet.' },
    WALLET_PENDING_REQUEST: { code: 1005, msg: 'A wallet request is already pending. Check MetaMask.' },

    // RPC (2xxx)
    RPC_UNAVAILABLE:    { code: 2000, msg: 'Arc RPC is currently unavailable.' },
    RPC_TIMEOUT:        { code: 2001, msg: 'RPC request timed out.' },
    RPC_CIRCUIT_OPEN:   { code: 2002, msg: 'All RPC endpoints are temporarily unavailable.' },
    RPC_INVALID_RESPONSE: { code: 2003, msg: 'RPC returned an invalid response.' },

    // Guardian (3xxx)
    GUARDIAN_UNAVAILABLE: { code: 3000, msg: 'Compliance verification unavailable.' },
    GUARDIAN_BLOCKED:     { code: 3001, msg: 'Transaction blocked by compliance check.' },
    GUARDIAN_TIMEOUT:     { code: 3002, msg: 'Compliance check timed out.' },

    // Bridge (4xxx)
    BRIDGE_QUOTE_FAILED:  { code: 4000, msg: 'Bridge quote unavailable.' },
    BRIDGE_BURN_FAILED:   { code: 4001, msg: 'Bridge burn transaction failed.' },
    BRIDGE_ATTEST_FAILED: { code: 4002, msg: 'Bridge attestation failed.' },
    BRIDGE_MINT_FAILED:   { code: 4003, msg: 'Bridge mint transaction failed.' },

    // Treasury (5xxx)
    TREASURY_UNAVAILABLE:    { code: 5000, msg: 'Treasury Core API unavailable.' },
    TREASURY_INTENT_FAILED:  { code: 5001, msg: 'Intent creation failed.' },
    TREASURY_SETTLE_FAILED:  { code: 5002, msg: 'Settlement failed.' },

    // Transaction (6xxx)
    TX_INSUFFICIENT_BALANCE: { code: 6000, msg: 'Insufficient balance for this transaction.' },
    TX_INSUFFICIENT_ALLOWANCE: { code: 6001, msg: 'Insufficient token allowance. Approve first.' },
    TX_REVERTED:             { code: 6002, msg: 'Transaction reverted on-chain.' },
    TX_FAILED:               { code: 6003, msg: 'Transaction failed.' },
    TX_TIMEOUT:              { code: 6004, msg: 'Transaction confirmation timeout.' },

    // Validation (7xxx)
    VAL_INVALID_ADDRESS: { code: 7000, msg: 'Invalid EVM address.' },
    VAL_INVALID_AMOUNT:  { code: 7001, msg: 'Invalid amount.' },
    VAL_AMOUNT_TOO_LARGE:{ code: 7002, msg: 'Amount exceeds maximum allowed.' },
    VAL_AMOUNT_TOO_SMALL:{ code: 7003, msg: 'Amount below minimum.' },
    VAL_DUPLICATE_ADDR:  { code: 7004, msg: 'Duplicate address detected.' },

    // General (9xxx)
    UNKNOWN:        { code: 9000, msg: 'An unexpected error occurred.' },
    FEATURE_DISABLED:{ code: 9001, msg: 'This feature is currently disabled.' },
    NETWORK_ERROR:  { code: 9002, msg: 'Network error. Check your connection.' },
  };

  // ─── Error class ────────────────────────────────────────────────────────
  var Err = function(codeKey, detail, cause) {
    var info = D.ERROR_CODES[codeKey] || D.ERROR_CODES.UNKNOWN;
    this.name = 'ExecDaatError';
    this.code = info.code;
    this.message = (detail ? info.msg + ' — ' + detail : info.msg);
    this.codeKey = codeKey;
    this.detail = detail || null;
    this.cause = cause || null;
    this.timestamp = new Date().toISOString();
    if (cause && cause.stack) this.stack = cause.stack;
  };
  Err.prototype = Object.create(Error.prototype);
  Err.prototype.constructor = Err;

  D.ExecDaatError = Err;

  /** Create a typed error */
  D.error = function(codeKey, detail, cause) {
    return new Err(codeKey, detail, cause);
  };

  // ─── Classification ─────────────────────────────────────────────────────
  D.classifyError = function(err) {
    if (!err) return 'UNKNOWN';
    if (err.codeKey) return err.codeKey; // Already classified by us
    if (err.code === 4001 || err.code === 'ACTION_REJECTED' || /reject|denied|cancel/i.test(err.message || ''))
      return 'WALLET_REJECTED';
    if (err.code === -32002) return 'WALLET_PENDING_REQUEST';
    if (err.code === 4902 || /chain.*not.*added/i.test(err.message || '')) return 'WALLET_CHAIN_NOT_ADDED';
    if (/insufficient.*(balance|funds)/i.test(err.message || '')) return 'TX_INSUFFICIENT_BALANCE';
    if (/insufficient.*allowance/i.test(err.message || '')) return 'TX_INSUFFICIENT_ALLOWANCE';
    if (/revert/i.test(err.message || '')) return 'TX_REVERTED';
    if (/network|fetch|timeout/i.test(err.message || '')) return 'NETWORK_ERROR';
    return 'UNKNOWN';
  };

  /** Get friendly error message */
  D.friendlyError = function(err) {
    var info = D.ERROR_CODES[D.classifyError(err)];
    return info ? info.msg : (err.message || 'An unexpected error occurred.');
  };

  /** Get error code */
  D.errorCode = function(err) {
    var info = D.ERROR_CODES[D.classifyError(err)];
    return info ? info.code : 9000;
  };

  // ─── Stack sanitization ─────────────────────────────────────────────────
  D.sanitizeStack = function(stack) {
    if (!stack) return '';
    return stack.replace(/0x[0-9a-fA-F]{64}/g, '0x***')
                .replace(/\/\/[^:\s]+:[^:\s]+:[^:\s]+/g, '//[redacted]')
                .slice(0, 1000);
  };

  /** Format error for console/logging (safe — no secrets) */
  D.formatError = function(err) {
    var code = D.errorCode(err);
    var msg = D.friendlyError(err);
    return '[ExecDaat #' + code + '] ' + msg;
  };

  // ─── Safe logging (preserved from original) ─────────────────────────────
  D.safeLogError = function(context, err) {
    console.error(D.formatError(err), D.sanitizeStack(err && err.stack));
    D.telemetry && D.telemetry.record('error', context || 'app', 0, { code: D.errorCode(err) });
  };

  D.safeLogWarn = function(context, msg) {
    console.warn('[ExecDaat] [' + (context || 'app') + ']', msg);
  };

  D.safeLogInfo = function(context, msg) {
    console.log('[ExecDaat] [' + (context || 'app') + ']', msg);
  };

  // ─── Wallet error classification ────────────────────────────────────────
  D.walletError = function(err) {
    var c = D.classifyError(err);
    if (c === 'WALLET_REJECTED') return 'REJECTED';
    if (c === 'WALLET_PENDING_REQUEST') return 'PENDING_REQUEST';
    if (c === 'WALLET_CHAIN_NOT_ADDED') return 'CHAIN_NOT_ADDED';
    return 'UNKNOWN';
  };
})();
