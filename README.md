# ARC AI Agents — v3.0.0

## Visão Geral
Plataforma de pagamentos e contratos autônomos na **Arc Testnet** com 4 agentes de IA integrados, swap USDC↔EURC, vaults de rendimento e chatbot inteligente. Todas as operações são assinadas e confirmadas na EVM via MetaMask/carteira EIP-1193.

## URL Sandbox
**https://3000-i7dbuvc4nlvszyf6ljwfs-a402f90a.sandbox.novita.ai**

## Funcionalidades Implementadas

### 🧠 4 Agentes de IA
| Agente | Função | Status |
|--------|---------|--------|
| **ArcPay Agent v1.0** | Pagamentos, análise de risco, batch | ✅ Ativo |
| **ArcContract Agent v1.0** | Contratos, escrow, milestones | ✅ Ativo |
| **Guardian Agent v1.0** | Compliance, KYC/AML, sanções | ✅ Ativo |
| **Yield Optimizer v1.0** | APY tracking, rebalancing auto | ✅ Ativo |

### 💳 Pagamentos (Multi-send)
- Batch de pagamentos em USDC/EURC
- Upload CSV/Excel com validação
- Assinatura EVM + verificação Guardian
- Análise de risco por agente de pagamentos

### 🔄 Swap USDC ↔ EURC
- Taxa em tempo real com variação ±0.2%
- Slippage configurável (0.5%/1%/2%/custom)
- **Assinatura EVM obrigatória** com MetaMask
- Guardian compliance check antes do swap
- Histórico com links para explorer

### 🏦 Vaults (2 vaults)
- **USDC Vault**: 5.2% APY
- **EURC Vault**: 4.8% APY
- Depósito/saque com **assinatura EVM**
- Guardian check automático
- Histórico de transações

### 🛡️ Guardian Agent (Compliance/KYC)
- Sanction screening OFAC/OFSI
- KYC em 4 tiers (0=nenhum → 3=full)
- Detecção de structuring (smurfing)
- Verificação de jurisdição
- Check automático em swap, vault, payments
- API: `GET /api/guardian/status`, `POST /api/guardian/check`, `/kyc/submit`

### 🌱 Yield Optimizer Agent
- 7 pools ativos (USDC + EURC)
- APY até 11.5% (ARC High Yield USDC)
- Auto-rebalancing baseado em APY diff
- 3 estratégias: conservative/balanced/aggressive
- Projeção de rendimentos (7d/30d/90d/180d/365d)
- **EVM signing** para abertura de posições
- Guardian check antes de cada depósito
- API: `GET /api/yield/pools`, `POST /api/yield/positions/open`

### 💬 Chatbot IA
- Integrado com todos os 4 agentes
- Comandos: `guardian status`, `yield pools`, `best APY`, `swap rate`, etc.
- Detecção de intents + respostas contextuais
- Sessões persistentes via sessionId

## APIs Endpoints

### Guardian
- `GET /api/guardian/status` — Status e estatísticas
- `POST /api/guardian/check` — Compliance check
- `POST /api/guardian/kyc/submit` — Enviar KYC
- `GET /api/guardian/kyc/:address` — Status KYC
- `GET /api/guardian/log` — Log de compliance

### Yield Optimizer
- `GET /api/yield/status` — Status e stats
- `GET /api/yield/pools` — Lista pools com APY
- `GET /api/yield/pools/best` — Melhor pool por token/estratégia
- `POST /api/yield/positions/open` — Abrir posição (requer txHash)
- `GET /api/yield/positions` — Posições ativas
- `POST /api/yield/positions/:id/close` — Fechar posição
- `POST /api/yield/positions/:id/rebalance` — Rebalancear
- `GET /api/yield/project` — Projeção de rendimento

### Swap
- `GET /api/swap/rates` — Taxas USDC/EURC
- `POST /api/swap/execute` — Executar swap (aceita txHash)
- `GET /api/swap/history` — Histórico

### Vaults
- `GET /api/vaults` — Info dos vaults
- `POST /api/vaults/usdc/deposit` — Depositar USDC (aceita txHash)
- `POST /api/vaults/usdc/withdraw` — Sacar USDC
- `POST /api/vaults/eurc/deposit` — Depositar EURC
- `GET /api/vaults/usdc/history` — Histórico

### Payments
- `POST /api/payments/batch` — Batch payments (aceita batchTxHash)
- `GET /api/payments/queue` — Fila de pagamentos
- `POST /api/payments/analyze` — Análise de risco

## Integração EVM (Arc Testnet)

### Como funciona
```
Usuário inicia operação
    ↓
Guardian compliance check (automático)
    ↓
Wallet assina tx via MetaMask (eth_sendTransaction / personal_sign)
    ↓
txHash enviado para a API backend
    ↓
Operação registrada + confirmada
```

### Fluxo por operação
| Operação | Tipo de Assinatura | Contrato |
|----------|-------------------|---------|
| Swap | `evmTransferToken` | USDC/EURC contract |
| Vault Deposit | `evmTransferToken` | Vault contract |
| Vault Withdraw | `evmTransferToken` | Self (retorno) |
| Batch Payment | `evmSignOperation` (EIP-191) | Off-chain auth |
| Yield Position | `evmTransferToken` | Pool contract |

## Rede Arc Testnet
| Propriedade | Valor |
|-------------|-------|
| Chain ID | 5042002 |
| RPC URL | https://rpc.testnet.arc.network |
| Explorer | https://testnet.arcscan.app |
| Faucet | https://faucet.circle.com |
| Gas Token | USDC |
| Gas/tx | ~$0.009 USDC |
| Finalidade | Sub-segundo |
| USDC Address | 0x3600000000000000000000000000000000000000 |
| EURC Address | 0x4700000000000000000000000000000000000000 |

## Stack Técnica
- **Backend**: Hono + TypeScript → Cloudflare Workers
- **Frontend**: Vanilla JS + Tailwind CSS (CDN)
- **Build**: Vite + @hono/vite-cloudflare-pages
- **Wallet**: EIP-1193 (MetaMask, Coinbase, etc.)
- **EVM**: evm-tx.js (sem ethers.js, puro Web3)
- **i18n**: 5 idiomas (EN/PT/ES/ZH/KO)

## Próximos Passos Sugeridos
1. Deploy real na Cloudflare Pages (`npm run deploy:prod`)
2. Deploy dos contratos Solidity via Foundry
3. Substituir vaults/pools simulados por contratos reais
4. Implementar EURC na Arc via Circle CCTP
5. Adicionar notificações push via webhook

## Última Atualização
2026-03-12 — v3.0.0: Guardian Agent, Yield Optimizer, EVM signing completo
