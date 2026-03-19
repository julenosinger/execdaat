// ============================================================
// ARC Token Registry
// Arc Testnet · ChainId 5042002
//
// Official contract addresses from:
//   https://docs.arc.network/arc/references/contract-addresses
// ============================================================

export interface Token {
  symbol:   string;
  name:     string;
  address:  string;
  decimals: number;
  logo:     string;
  isNative: boolean;
  chainId:  number;
  explorerUrl?: string;
  description?: string;
  coingeckoId?: string;
  priceUSD?: number; // approximate testnet price
}

export const CHAIN_ID    = 5042002;
export const CHAIN_HEX   = '0x4cef52';
export const EXPLORER    = 'https://testnet.arcscan.app';
export const RPC         = 'https://rpc.testnet.arc.network';
export const ALT_RPCS    = [
  'https://rpc.blockdaemon.testnet.arc.network',
  'https://rpc.drpc.testnet.arc.network',
  'https://rpc.quicknode.testnet.arc.network',
];

// ─── Official Token Registry ──────────────────────────────────────────────────
export const TOKEN_REGISTRY: Record<string, Token> = {
  USDC: {
    symbol:      'USDC',
    name:        'USD Coin',
    address:     '0x3600000000000000000000000000000000000000',
    decimals:    6,
    logo:        '💵',
    isNative:    true,
    chainId:     CHAIN_ID,
    explorerUrl: `${EXPLORER}/address/0x3600000000000000000000000000000000000000`,
    description: 'Native USDC on Arc Network — gas token',
    coingeckoId: 'usd-coin',
    priceUSD:    1.0,
  },
  EURC: {
    symbol:      'EURC',
    name:        'Euro Coin',
    address:     '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
    decimals:    6,
    logo:        '💶',
    isNative:    false,
    chainId:     CHAIN_ID,
    explorerUrl: `${EXPLORER}/address/0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a`,
    description: 'Euro Coin — ERC-20 stablecoin pegged to EUR',
    coingeckoId: 'euro-coin',
    priceUSD:    1.09,
  },
  USYC: {
    symbol:      'USYC',
    name:        'US Yield Coin',
    address:     '0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C',
    decimals:    6,
    logo:        '📈',
    isNative:    false,
    chainId:     CHAIN_ID,
    explorerUrl: `${EXPLORER}/address/0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C`,
    description: 'US Yield Coin — tokenized T-bill yield product',
    coingeckoId: 'hashnote-us-yield-coin',
    priceUSD:    1.0,
  },
};

// ─── Pool Pair Definitions ────────────────────────────────────────────────────
export interface PoolPair {
  id:       string;
  tokenA:   string;
  tokenB:   string;
  fee:      number;
  active:   boolean;
}

export const POOL_PAIRS: PoolPair[] = [
  { id: 'EURC-USDC', tokenA: 'EURC', tokenB: 'USDC', fee: 0.003, active: true },
  { id: 'USDC-USYC', tokenA: 'USDC', tokenB: 'USYC', fee: 0.003, active: true },
  { id: 'EURC-USYC', tokenA: 'EURC', tokenB: 'USYC', fee: 0.003, active: true },
];

// ─── Network Infrastructure ───────────────────────────────────────────────────
export const NETWORK = {
  name:       'Arc Testnet',
  chainId:    CHAIN_ID,
  chainHex:   CHAIN_HEX,
  rpc:        RPC,
  altRpcs:    ALT_RPCS,
  explorer:   EXPLORER,
  faucet:     'https://faucet.circle.com',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },

  // Core infrastructure
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  permit2:    '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  create2:    '0x4e59b44847b379578588920cA78FbF26c0B4956C',

  // CCTP (Cross-Chain Transfer Protocol) — Domain 26
  cctp: {
    domain:             26,
    tokenMessengerV2:   '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
    messageTransmitterV2: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
    tokenMinterV2:      '0xb43db544E2c27092c107639Ad201b3dEfAbcF192',
    messageV2:          '0xbaC0179bB358A8936169a63408C8481D582390C4',
  },

  // Gateway
  gateway: {
    wallet:  '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
    minter:  '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B',
  },

  // USYC Entitlements
  usyc: {
    entitlements: '0xcc205224862c7641930c87679e98999d23c26113',
    teller:       '0x9fdF14c5B14173D74C08Af27AebFf39240dC105A',
  },

  // Payment Escrow
  fxEscrow: '0x867650F5eAe8df91445971f14d89fd84F0C9a9f8',
};

// ─── ERC-20 Function Selectors ────────────────────────────────────────────────
export const ERC20_SELECTORS = {
  transfer:       '0xa9059cbb',
  transferFrom:   '0x23b872dd',
  approve:        '0x095ea7b3',
  allowance:      '0xdd62ed3e',
  balanceOf:      '0x70a08231',
  totalSupply:    '0x18160ddd',
  name:           '0x06fdde03',
  symbol:         '0x95d89b41',
  decimals:       '0x313ce567',
};

// ─── Helper: normalize pool id (always sorted alphabetically) ─────────────────
export function normalizePoolId(tokenA: string, tokenB: string): string {
  const [a, b] = [tokenA.toUpperCase(), tokenB.toUpperCase()].sort();
  return `${a}-${b}`;
}

// ─── Helper: token price in USD ───────────────────────────────────────────────
export function tokenPriceUSD(symbol: string): number {
  return TOKEN_REGISTRY[symbol.toUpperCase()]?.priceUSD ?? 1.0;
}

// ─── Helper: format amount from raw (6 decimals) ─────────────────────────────
export function fromRaw(raw: number, decimals = 6): number {
  return raw / Math.pow(10, decimals);
}

export function toRaw(amount: number, decimals = 6): number {
  return Math.floor(amount * Math.pow(10, decimals));
}

export default TOKEN_REGISTRY;
