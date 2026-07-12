# ExecDaat Architecture

## Overview
ExecDaat is a decentralized application (dApp) on **Arc Testnet** (Chain ID 5042002) for autonomous payments, token swaps, escrow contracts, and multi-send. Built with Hono.js (Cloudflare Workers / Vercel Serverless) backend and vanilla JavaScript frontend.

```
┌─────────────────────────────────────────────────┐
│                   Browser                       │
│  ┌──────────┐ ┌──────────┐ ┌───────────────┐   │
│  │ security │→│  shared/ │→│ feature modules│   │
│  │  .js     │ │  *.js    │ │ contracts/    │   │
│  │          │ │          │ │ chat/         │   │
│  │          │ │          │ │ multisend/    │   │
│  │          │ │          │ │ *.js files    │   │
│  └──────────┘ └──────────┘ └───────────────┘   │
│                       ↓                         │
│              ┌────────────────┐                 │
│              │  window.ExecDaat│ (namespace)     │
│              └────────────────┘                 │
└──────────────────┬──────────────────────────────┘
                   │ HTTPS
┌──────────────────▼──────────────────────────────┐
│         Cloudflare Pages / Vercel               │
│  ┌──────────────────────────────────────────┐   │
│  │  Hono.js App (src/index.tsx)             │   │
│  │  ├── securityMiddleware                  │   │
│  │  ├── CORS                                │   │
│  │  ├── /api/payments                       │   │
│  │  ├── /api/contracts                      │   │
│  │  ├── /api/swap                           │   │
│  │  ├── /api/chat                           │   │
│  │  ├── /api/guardian                       │   │
│  │  ├── /api/dex                            │   │
│  │  ├── /api/core/v1 (Treasury Core)        │   │
│  │  ├── /api/treasury                       │   │
│  │  └── SPA shell (src/app.html)            │   │
│  └──────────────────────────────────────────┘   │
└──────────────────┬──────────────────────────────┘
                   │ RPC
┌──────────────────▼──────────────────────────────┐
│            Arc Testnet Blockchain               │
│  USDC · EURC · AMM · Factory · Vault · CCTP    │
└─────────────────────────────────────────────────┘
```

## Dependency Graph

```
security.js (loaded FIRST)
    ↓
shared/constants.js  ← chain IDs, explorers, RPCs
shared/token-registry.js ← USDC/EURC addresses, window globals
shared/contracts.js  ← all deployed contract addresses
shared/address.js    ← isAddress, shortAddress
shared/format.js     ← formatUSDC, formatToken
shared/token.js      ← parseUnits, isNativeToken
shared/rpc.js        ← RPC selection, fallback, retry, health
shared/config.js     ← feature flags, limits, timeouts
shared/errors.js     ← error codes, classification, logging
shared/ui.js         ← toast, loading, clipboard
    ↓
shared/cache.js      ← TTL cache for balances, metadata
shared/health.js     ← app health monitor (wallet/RPC/guardian/etc.)
shared/telemetry.js  ← performance metrics (privacy-first)
shared/debug.js      ← developer overlay (Ctrl+Shift+D)
    ↓
wallet.js        ← EVM wallet connection (EIP-1193/6963)
wallet-create.js ← soft wallet generation
router.js        ← hash-based SPA router
    ↓
app.js           ← main application shell, tabs, shared UI
    ↓
payments.js      ← ERC-20 payment module
contracts/       ← smart contract management (4 files)
chat/            ← AI chatbot (4 files)
multisend/       ← batch payments (4 files)
swap.js          ← token swap (USDC↔EURC)
dex.js           ← AMM/dex interface
bridge.js        ← CCTP bridge
treasury.js      ← treasury management
vaults.js        ← vault deposit/withdraw
history.js       ← transaction history
+ 50+ other feature modules
```

## State Containers

| Container | Location | Purpose |
|-----------|----------|---------|
| `window.walletState` | wallet.js | Wallet connection, address, network, balances |
| `window.ExecDaat.CHAIN` | shared/constants.js | Chain ID, RPCs, explorer |
| `window.ExecDaat.TOKENS` | shared/token-registry.js | USDC/EURC token metadata |
| `window.ExecDaat.CONTRACTS` | shared/contracts.js | All deployed addresses |
| `window.ExecDaat.CONFIG` | shared/config.js | Feature flags, limits, timeouts |
| `window.cfState` | contracts/contracts-core.js | Contract loading state |
| `window.msReceipts` | multisend/multisend-core.js | Multisend receipt history |
| `window.arcPaySession` | chat/chat-core.js | Daat Agent authorization session |
| `window.ExecDaat.health` | shared/health.js | Component health status |
| `window.ExecDaat.telemetry` | shared/telemetry.js | Performance metrics |
| `window.ExecDaat.cache` | shared/cache.js | TTL in-memory cache |

## Key Window Exports

| Namespace | Count | Examples |
|-----------|-------|----------|
| `window.cf*` | 72 | cfLoadContracts, cfCreateContract, cfSignContract... |
| `window.ms*` | 25 | msInit, msExecute, msPdfReceipt... |
| `window.chat*` / general | 33 | toggleChat, sendChatMessage, executeArcPayAuthorization... |
| `window.ExecDaat.*` | ~60 | shortAddress, formatUSDC, parseUnits, getRPC, rpcFetch... |

## Initialization Flow

1. Browser loads app.html
2. security.js executes first (frame-busting, CSP, XSS prevention)
3. Third-party CDN libs load (Tailwind, FontAwesome, ethers.js, jsPDF)
4. shared/ modules execute (constants, tokens, contracts, format, etc.)
5. Phase 4 modules execute (cache, health, telemetry, debug)
6. wallet.js initializes EIP-1193 provider detection
7. router.js activates hash-based routing
8. app.js bootstraps tab system, initializes current tab
9. Feature modules load on-demand via switchTab()

## API Routes

| Route | Purpose |
|-------|---------|
| GET /api/health | Health check |
| GET /api/status | Platform status |
| POST /api/payments | Payment processing |
| GET/POST /api/contracts | Contract management |
| GET/POST /api/swap | Token swap operations |
| POST /api/chat | AI chatbot interaction |
| POST /api/guardian/check | AML/KYC compliance |
| GET /api/dex | DEX/AMM operations |
| GET/POST /api/core/v1/* | Treasury Core (native) |
| GET/POST /api/treasury | Treasury meta/proxy |
| POST /api/csv/validate | CSV validation |
| POST /api/security/log | Frontend security events |

## Smart Contracts (Arc Testnet)

| Contract | Address | Purpose |
|----------|---------|---------|
| USDC | 0x3600...0000 | Native gas token |
| EURC | 0x89B5...D72a | ERC-20 stablecoin |
| Permit2 | 0x0000...8BA3 | Gasless approvals |
| SimpleAMM | 0x3148...b561 | AMM DEX |
| ContractFactory | 0xbbC9...aF2A | On-chain contracts |
| ArcVault | 0x1e03...7B87 | Liquidity vault |
| ArcTreasury | 0x1fd3...853D | Multisig governance |
| Multicall3 | 0xcA11...CA11 | Batch calls |
| OTCEscrow | (deployed) | OTC settlement |

## Phase History

| Phase | Date | Changes |
|-------|------|---------|
| Phase 1 | 2026-07-12 | Critical security hardening (keys, Guardian, XSS) |
| Phase 2 | 2026-07-12 | Shared infrastructure (10 modules) |
| Phase 3 | 2026-07-12 | Modularization (contracts, chat, multisend split) |
| Phase 4 | 2026-07-12 | Reliability, testing, production readiness |
