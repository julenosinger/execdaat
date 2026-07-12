// ============================================================
// ExecDaat Shared Constants — single source of truth
// ============================================================
// Loaded before all feature modules. Every script can reference
// window.ExecDaat.CHAIN, window.ExecDaat.EXPLORER, etc.
// No feature scripts should redefine these values.
// ============================================================
;(function() {
  'use strict';
  if (window.ExecDaat) return;

  var D = window.ExecDaat = {};

  // ─── Chain constants ─────────────────────────────────────────────────
  D.CHAIN = {
    ID:    5042002,
    HEX:   '0x4cef52',
    NAME:  'Arc Testnet',
    RPC:   'https://rpc.testnet.arc.network',
    RPCS:  [
      'https://rpc.testnet.arc.network',
      'https://rpc.blockdaemon.testnet.arc.network',
      'https://rpc.drpc.testnet.arc.network',
      'https://rpc.quicknode.testnet.arc.network',
    ],
    WS:    'wss://rpc.testnet.arc.network',
    EXPLORER:       'https://testnet.arcscan.app',
    EXPLORER_TX:    'https://testnet.arcscan.app/tx/',
    EXPLORER_ADDR:  'https://testnet.arcscan.app/address/',
    FAUCET:         'https://faucet.circle.com',
    GAS_TOKEN:      'USDC',
    GAS_COST:       '~$0.009',
    FINALITY:       'Sub-second',
  };
})();
