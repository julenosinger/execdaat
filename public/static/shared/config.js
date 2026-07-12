// ============================================================
// ExecDaat Shared Configuration — feature flags, limits, timeouts
// ============================================================
;(function() {
  'use strict';
  var D = window.ExecDaat = window.ExecDaat || {};

  D.CONFIG = {
    // ─── Feature flags ───────────────────────────────────────────────────
    FEATURES: {
      GUARDIAN_ENABLED: true,       // Guardian AML/KYC compliance
      GUARDIAN_REQUIRED: true,      // Block if Guardian fails (Phase 1 hardening)
      PERMIT2_ENABLED: true,        // Permit2 EIP-712 gasless approvals
      TURBO_BRIDGE_ENABLED: true,   // Turbo Bridge (Inbound)
    },

    // ─── Limits ──────────────────────────────────────────────────────────
    LIMITS: {
      MAX_MULTISEND_RECIPIENTS: 500,
      MAX_MULTISEND_PER_ROW:    10000,   // max USDC per row
      MAX_CSV_ROWS:             1000,
      MAX_SWAP_AMOUNT:          1000000, // max USDC per swap
      MAX_MEMO_LENGTH:          200,
      MAX_TITLE_LENGTH:         100,
    },

    // ─── Timeouts (ms) ───────────────────────────────────────────────────
    TIMEOUTS: {
      TX_CONFIRMATION:    30000,   // wait for on-chain tx
      RPC_REQUEST:        15000,
      API_REQUEST:        20000,
      TOAST_DURATION:     4000,
      BALANCE_POLL:       30000,
      HISTORY_POLL:       30000,
      DEBOUNCE_INPUT:     380,     // input debounce delay
    },

    // ─── Retry settings ──────────────────────────────────────────────────
    RETRY: {
      MAX_RETRIES:         3,
      RETRY_DELAY_MS:   1000,
      RPC_FALLBACK_COUNT:  4,
    },

    // ─── Intervals (ms) ──────────────────────────────────────────────────
    INTERVALS: {
      POLL_AGENT_STATUS:  5000,
      POLL_TREASURY:     15000,
      POLL_HISTORY:      30000,
      POLL_BALANCE:      30000,
      CACHE_TTL_RATES:   15000,
    },
  };
})();
