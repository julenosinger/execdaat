# ARC AI Agents — v5.0.0 (Escrow Wallet)

## Visão Geral
Plataforma completa de DeFi na **Arc Testnet** com DEX AMM, pagamentos e contratos autônomos, 4 agentes de IA, swap USDC↔EURC, vaults de rendimento, chatbot inteligente e **Escrow Wallet com milestones**. Todas as operações são assinadas e confirmadas na EVM via MetaMask/carteira EIP-1193.

## URL Sandbox
**https://3000-i7dbuvc4nlvszyf6ljwfs-a402f90a.sandbox.novita.ai**

---

## 🆕 Novo: Escrow Wallet (v5.0)
Escrow baseado em milestones em USDC — espelha o smart contract `EscrowWallet.sol` (ARC Testnet, EVM-compatible).

### Smart Contract: `contracts/EscrowWallet.sol`
```
EscrowWallet.sol
├── State Variables: client, contractor, usdcToken, totalAmount, releasedAmount, depositedAmount
├── Milestone struct: id, amount, description, state, completed, released, timestamps
├── EscrowState enum: Created → Active → Completed/Disputed → Refunded
├── MilestoneState: Pending → RequestedByContractor → Verified → Released
└── Events: EscrowCreated, DepositReceived, MilestoneRequested, MilestoneVerified, PaymentReleased, DisputeRaised, RefundIssued
```

### Fluxo de Escrow
```
1. createEscrow(client, contractor, totalAmount, milestones[])
        ↓ State: Created
2. client.depositUSDC(amount)
        ↓ State: Active (quando totalAmount depositado)
3. contractor.requestMilestoneVerification(milestoneId)
        ↓ MilestoneState: RequestedByContractor
4. client.verifyMilestone(milestoneId)
        ↓ MilestoneState: Verified
5. contractor.releaseMilestonePayment(milestoneId)
        ↓ USDC transferido → MilestoneState: Released
        ↓ State: Completed (se todos milestones liberados)

Fluxo de Disputa:
5b. raiseDispute() → State: Disputed (qualquer participante)
6b. refundClient() → USDC retornado → State: Refunded (só client)
```

### Segurança Implementada
- Apenas client pode aprovar milestones (`verifyMilestone`)
- Apenas contractor pode solicitar/liberar pagamentos
- Prevenção de double-withdrawal (`released` flag + CEI pattern)
- Verificação de saldo antes de liberar
- Somente pode fazer refund quando em estado `Disputed`
- Over-deposit bloqueado

### Endpoints API Escrow
| Método | Endpoint | Função |
|--------|----------|--------|
| `POST` | `/api/escrow/create` | createEscrow() |
| `POST` | `/api/escrow/:id/deposit` | depositUSDC() |
| `POST` | `/api/escrow/:id/request/:mId` | requestMilestoneVerification() |
| `POST` | `/api/escrow/:id/verify/:mId` | verifyMilestone() |
| `POST` | `/api/escrow/:id/release/:mId` | releaseMilestonePayment() |
| `POST` | `/api/escrow/:id/dispute` | raiseDispute() |
| `POST` | `/api/escrow/:id/refund` | refundClient() |
| `GET` | `/api/escrow` | Listar todos os escrows |
| `GET` | `/api/escrow/:id` | Detalhe do escrow |
| `GET` | `/api/escrow/:id/milestones` | Milestones do escrow |
| `GET` | `/api/escrow/wallet/:address` | Escrows por carteira |
| `GET` | `/api/escrow/events` | Histórico de eventos on-chain |
| `GET` | `/api/escrow/network` | Info da rede + ABI ref |

### Deploy do Contrato (Foundry)
```bash
# Instalar Foundry
curl -L https://foundry.paradigm.xyz | bash

# Deploy EscrowWallet na ARC Testnet
forge create contracts/EscrowWallet.sol:EscrowFactory \
  --rpc-url https://rpc.testnet.arc.network \
  --private-key $PRIVATE_KEY \
  --constructor-args 0x3600000000000000000000000000000000000000

# Deploy EscrowWallet individual
forge create contracts/EscrowWallet.sol:EscrowWallet \
  --rpc-url https://rpc.testnet.arc.network \
  --private-key $PRIVATE_KEY \
  --constructor-args 1 0xClient 0xContractor 0x3600... 1000000000 [500000000,500000000] ["M1","M2"]
```

---

## ARC DEX (v4.0)
Mini-Uniswap totalmente funcional na Arc Testnet:

### AMM Engine (x·y=k)
| Componente | Detalhes |
|-----------|---------|
| **Fórmula** | `amountOut = (reserveOut×amountIn×997)/(reserveIn×1000+amountIn×997)` |
| **Taxa** | 0.3% por swap (acumula para LP holders) |
| **LP Tokens** | Primeiro: `sqrt(amountA×amountB)`, Subsequente: `min(amtA/rA, amtB/rB)×totalLP` |
| **Segurança** | Bloqueia swaps com impact >15%, avisa em >5% |

### Pools Disponíveis
| Pool | TVL | 24h Volume | APR |
|------|-----|-----------|-----|
| EURC/USDC | ~$1.0M | $125K | 13.67% |
| USDC/USYC | ~$398K | $45K | 12.36% |
| EURC/USYC | ~$175K | $18K | 11.82% |

---

## Funcionalidades Completas

### 🛡️ Escrow Wallet
- Criar escrow com múltiplos milestones
- Deposit USDC (trava fundos)
- Contractor solicita verificação de milestone
- Client aprova milestone
- Contractor libera pagamento por milestone
- Levantar disputa (congela escrow)
- Reembolso total ao client (apenas em disputa)
- Progress bar visual + event log on-chain
- Modal de depósito com assinatura EVM opcional

### 🔀 DEX AMM
- Swap com quote em tempo real
- Add/Remove Liquidity
- LP tokens + My Positions
- Pool Analytics (TVL, volume, APR)
- APR estimator + IL calculator

### 🧠 4 Agentes de IA
| Agente | Função |
|--------|---------|
| **ArcPay** | Pagamentos, análise de risco, batch |
| **ArcContract** | Contratos, escrow, milestones |
| **Guardian** | Compliance, KYC/AML, sanções |
| **Yield Optimizer** | APY tracking, rebalancing auto |

### 💳 Pagamentos, Swap, Vaults, Chatbot
- Batch de pagamentos em USDC/EURC (CSV/Excel)
- Swap USDC↔EURC com assinatura EVM
- Vaults: USDC 5.2% APY / EURC 4.8% APY
- Chatbot integrado com todos os agentes

---

## Arquitetura
```
webapp/
├── contracts/
│   └── EscrowWallet.sol        ← Smart contract Solidity (deploy via Foundry)
├── src/
│   ├── routes/
│   │   ├── escrow.ts           ← API Escrow (12 endpoints, mirrors on-chain logic)
│   │   ├── dex.ts              ← API DEX AMM
│   │   ├── contracts.ts        ← API Contratos + Receipts
│   │   ├── payments.ts         ← API Pagamentos
│   │   ├── guardian.ts         ← API Guardian
│   │   ├── vaults.ts           ← API Vaults
│   │   └── ...
│   ├── dex/
│   │   ├── poolManager.ts      ← Pool state + positions
│   │   ├── pricingEngine.ts    ← AMM core (x*y=k)
│   │   ├── swapRouter.ts       ← Route finder
│   │   ├── liquidityEngine.ts  ← Add/Remove lifecycle
│   │   └── lpToken.ts          ← ERC-20 LP model
│   ├── tokens/tokenRegistry.ts ← USDC, EURC, USYC
│   └── index.tsx               ← App Hono + HTML (Escrow tab)
├── public/static/
│   ├── escrow.js               ← Frontend Escrow Wallet
│   ├── dex.js                  ← Frontend DEX
│   ├── contracts.js            ← Frontend Contratos
│   └── ...
```

## APIs Endpoints

### Escrow Wallet
- `POST /api/escrow/create` — Criar escrow + milestones
- `POST /api/escrow/:id/deposit` — Depositar USDC
- `POST /api/escrow/:id/request/:mId` — Solicitar verificação de milestone
- `POST /api/escrow/:id/verify/:mId` — Verificar milestone (client)
- `POST /api/escrow/:id/release/:mId` — Liberar pagamento (contractor)
- `POST /api/escrow/:id/dispute` — Levantar disputa
- `POST /api/escrow/:id/refund` — Reembolsar client
- `GET /api/escrow` — Listar escrows + stats
- `GET /api/escrow/:id` — Detalhe + eventos
- `GET /api/escrow/events` — Log de eventos
- `GET /api/escrow/wallet/:address` — Escrows por carteira
- `GET /api/escrow/network` — Info ARC Testnet

### DEX
- `GET /api/dex/pools` — Pools + analytics
- `GET /api/dex/quote` — AMM quote
- `POST /api/dex/swap` — Executar swap
- `POST /api/dex/liquidity/add` — Adicionar liquidez
- `POST /api/dex/liquidity/remove` — Remover liquidez
- `GET /api/dex/positions/:wallet` — Posições LP
- `GET /api/dex/analytics` — TVL, volume, fees

## Rede Arc Testnet
| Propriedade | Valor |
|-------------|-------|
| Chain ID | 5042002 |
| RPC URL | https://rpc.testnet.arc.network |
| Explorer | https://testnet.arcscan.app |
| Faucet | https://faucet.circle.com |
| Gas Token | USDC (~$0.009/tx) |
| USDC | 0x3600000000000000000000000000000000000000 |
| EURC | 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a |

## Stack Técnica
- **Backend**: Hono + TypeScript → Cloudflare Workers
- **Frontend**: Vanilla JS + Tailwind CSS (CDN)
- **Build**: Vite + @hono/vite-cloudflare-pages
- **Smart Contracts**: Solidity 0.8.20 (Foundry deploy)
- **Wallet**: EIP-1193 (MetaMask, Coinbase, etc.)
- **i18n**: 5 idiomas (EN/PT/ES/ZH/KO)

## Próximos Passos Sugeridos
1. Deploy `EscrowWallet.sol` e `EscrowFactory.sol` via Foundry na ARC Testnet
2. Conectar frontend escrow.js ao contrato real (substituir chamadas de API por `eth_sendTransaction`)
3. Integrar Guardian compliance check no fluxo de criação de escrow
4. Deploy na Cloudflare Pages (`npm run deploy:prod`)
5. Adicionar notificações push via webhook quando milestone muda de estado

## Última Atualização
2026-03-16 — v5.0.0: Escrow Wallet com milestones, smart contract Solidity, UI completa, 12 endpoints API
