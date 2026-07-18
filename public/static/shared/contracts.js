// ============================================================
// ExecDaat Contract Registry — all deployed contract addresses
// ============================================================
;(function() {
  'use strict';
  var D = window.ExecDaat = window.ExecDaat || {};

  D.CONTRACTS = {
    // Core infra
    USDC:             '0x3600000000000000000000000000000000000000',
    EURC:             '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
    PERMIT2:          '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    MULTICALL3:       '0xcA11bde05977b3631167028862bE2a173976CA11',

    // AMM / DEX
    AMM:              '0x3148E2807F172D1cC354F35fB4fC4104e8b6b561',
    SWAP_ROUTER:      '0x867650F5eAe8df91445971f14d89fd84F0C9a9f8',  // FxEscrow Arc
    FACTORY:          '0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A',

    // Relayer / Operator
    RELAYER:          '0xFAd3edb1aAe40C16cd30987fCEc3C3d68aEb7F45',

    // CCTP Bridge (Circle Cross-Chain Transfer Protocol)
    CCTP_TRANSMITTER: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
    TOKEN_MESSENGER_V2: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
  };
})();
