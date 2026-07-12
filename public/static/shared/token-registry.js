// ============================================================
// ExecDaat Token Registry — single source for all token definitions
// ============================================================
;(function() {
  'use strict';
  var D = window.ExecDaat = window.ExecDaat || {};

  D.TOKENS = {
    USDC: {
      address:  '0x3600000000000000000000000000000000000000',
      symbol:   'USDC',
      decimals: 6,
      isNative: true,   // USDC is native gas on Arc Testnet
      icon:     '💵',
      name:     'USD Coin (Arc Native)',
    },
    EURC: {
      address:  '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
      symbol:   'EURC',
      decimals: 6,
      isNative: false,  // EURC is standard ERC-20 on Arc
      icon:     '💶',
      name:     'Euro Coin (ERC-20)',
    },
  };

  // Legacy shortcut helpers (backward compat with existing code patterns)
  D.USDC_ADDR = D.TOKENS.USDC.address;
  D.EURC_ADDR = D.TOKENS.EURC.address;
  D.USDC_DECIMALS = D.TOKENS.USDC.decimals;
  D.EURC_DECIMALS = D.TOKENS.EURC.decimals;

  // Backward-compatible globals — existing scripts check window.USDC_ADDRESS first
  window.USDC_ADDRESS = D.TOKENS.USDC.address;
  window.EURC_ADDRESS = D.TOKENS.EURC.address;
  window.ARC_EXPLORER = D.CHAIN ? D.CHAIN.EXPLORER : 'https://testnet.arcscan.app';
  window.ARC_RPC = D.CHAIN ? D.CHAIN.RPC : 'https://rpc.testnet.arc.network';
  window.ARC_CHAIN_ID = D.CHAIN ? D.CHAIN.ID : 5042002;
  window.ARC_CHAIN_HEX = D.CHAIN ? D.CHAIN.HEX : '0x4cef52';

  // Helper: get token info by address (case-insensitive)
  D.tokenByAddress = function(addr) {
    if (!addr) return null;
    var a = String(addr).toLowerCase();
    for (var k in D.TOKENS) {
      if (D.TOKENS[k].address.toLowerCase() === a) return D.TOKENS[k];
    }
    return null;
  };

  // Helper: get token info by symbol (case-insensitive)
  D.tokenBySymbol = function(sym) {
    var s = String(sym || '').toUpperCase();
    return D.TOKENS[s] || null;
  };
})();
