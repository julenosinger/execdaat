# ARC AI Agents — v5.2.0 (Multisend v5 + History v2 + ChainId Fix)

## Visão Geral
Plataforma completa de DeFi na **Arc Testnet** com DEX AMM, pagamentos e contratos autônomos, 4 agentes de IA, swap USDC↔EURC, vaults de rendimento e chatbot inteligente. Todas as operações são assinadas e confirmadas na EVM via MetaMask/carteira EIP-1193.

## URLs
- **Produção:** https://arc-ai-agents-618-3v1.pages.dev
- **Sandbox Dev:** https://3000-i7dbuvc4nlvszyf6ljwfs-a402f90a.sandbox.novita.ai

---

## 🔗 Rede Arc Testnet
| Parâmetro | Valor |
|-----------|-------|
| Chain ID | `5042002` |
| Chain Hex | `0x4cef52` |
| RPC | `https://rpc.testnet.arc.network` |
| Explorer | `https://testnet.arcscan.app` |
| USDC | `0x3600000000000000000000000000000000000000` |
| EURC | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` |
| AMM | `0x3148E2807F172D1cC354F35fB4fC4104e8b6b561` |
| Factory | `0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A` |

---

## 🆕 v5.2.0 — Correções e Melhorias

### ✅ Correção Crítica: ChainId Hex
- **Bug:** Todos os arquivos JS/TS usavam `0x4CFC12` (5045266) — valor incorreto
- **Fix:** Corrigido para `0x4cef52` (5042002) em todos os arquivos:
  - `wallet.js`, `multisend.js`, `payments.js`, `contracts.js`, `dex.js`
  - `swap.js`, `vaults.js`, `evm-tx.js`, `escrow.js`
  - `src/routes/payments.ts`, `src/routes/swap.ts`, `src/tokens/tokenRegistry.ts`
- Sem essa correção, `wallet_switchEthereumChain` e `wallet_addEthereumChain` falhavam silenciosamente

### ✅ swap.ts — Reservas On-Chain Reais
- Eliminado jitter aleatório dos rates de swap
- Backend agora lê reservas diretamente do AMM via `eth_call` (getReserves + totalSupply)
- Cache de 15 segundos para evitar sobrecarga de RPC
- Fallback para cache se RPC falhar

---

## 🆕 v5.1.0 — Multisend v5 + History v2

### Multisend v5 (True Atomic Batch + PDF)
- **Precisão USDC:** `ethers.parseUnits(amount.toFixed(6), 6)` — elimina bug de zero/float
- **Balanço on-chain:** `usdc.balanceOf(from)` antes de qualquer tx — bloqueia se insuficiente
- **Decimais do contrato:** `usdc.decimals()` chamado on-chain para confirmar 6 decimais
- **Gas real:** `estimateGas` + 25% margem de segurança
- **Estratégia de batch:** Tenta Multicall3 (0xcA11bde...) → Fallback para sequential com nonces explícitos
- **Nonces explícitos:** Envia todas as txs sem esperar cada confirmação (mais rápido, ~atômico)
- **Validação:** Endereços EVM, sem duplicatas (Set), amount > 0, máx 500 linhas, máx $10k/linha
- **Recibo PDF:** jsPDF — inclui sender, recipients, amounts, total, gas fee, tx hash, timestamp, explorer link
- **Auto-sync:** Chama `historyInit()` 3s após conclusão

### History v2 (Real On-Chain)
- **Zero mock data:** Fetches reais via `provider.getLogs()` + RPC
- **Chunked scanning:** 10k blocos por query, 50k total (5 queries paralelas para USDC + EURC)
- **Timestamps reais:** `provider.getBlock()` em batch de 10
- **AMM Swap events:** Decodifica `Swap(address,bool,uint256,uint256,uint256,uint256)` com ethers.Interface
- **Multisend detection:** Agrupa ≥3 sends dentro de 60s com fee-wallet transfer → marca como MultiSend
- **Expandable details:** `<details>` com lista de recipients individuais
- **Polling 30s:** `setInterval` visível apenas quando aba está ativa (verifica `tab-content-history`)
- **Live badge:** `#history-poll-badge` animado quando polling está ativo
- **Filtros:** All, Payment, MultiSend, Swap, Contract
- **Load more:** Paginação de 30 itens
- **Auto-refresh:** `histRefreshNew()` busca apenas blocos novos (incremental)

---

## 📁 Arquivos Principais

```
webapp/
├── src/
│   ├── index.tsx            # Main Hono app — HTML + routes
│   ├── types/arc.ts         # ARC_TESTNET config (chainId, addresses)
│   └── routes/
│       ├── swap.ts          # Swap API — reservas on-chain AMM
│       ├── contracts.ts     # Contracts API — read-only metadata
│       ├── payments.ts      # Payments API
│       └── ...
├── public/static/
│   ├── multisend.js         # v5 — Atomic batch + PDF receipt
│   ├── history.js           # v2 — Real on-chain history
│   ├── wallet.js            # EIP-1193/6963 wallet — chainId 0x4cef52
│   ├── payments.js          # ERC-20 transfer UI
│   ├── dex.js               # AMM swap frontend
│   └── ...
└── wrangler.jsonc           # Cloudflare Pages config
```

---

## 🚀 Funcionalidades

| Feature | Status | Descrição |
|---------|--------|-----------|
| Payments | ✅ On-chain | ERC-20 transfer via ethers.Contract |
| MultiSend | ✅ On-chain v5 | Batch con nonces explícitos + PDF receipt |
| History | ✅ On-chain v2 | getLogs chunked, polling, filtros |
| DEX Swap | ✅ On-chain | AMM x*y=k, quotes de reservas reais |
| Contracts | ✅ On-chain | ContractFactory, 5-state machine |
| Wallet | ✅ Multi-provider | EIP-6963 + EIP-1193, chainId correto |

---

## 🔧 Desenvolvimento

```bash
# Instalar dependências
npm install

# Build
npm run build

# Iniciar servidor local (PM2)
pm2 start ecosystem.config.cjs

# Deploy produção
npx wrangler pages deploy dist --project-name arc-ai-agents-618
```

---

## 📅 Histórico de Versões

| Versão | Data | Descrição |
|--------|------|-----------|
| v5.2.0 | Mar 2026 | Fix chainId hex (0x4cef52), swap.ts on-chain reserves |
| v5.1.0 | Mar 2026 | Multisend v5 (atomic+PDF), History v2 (polling+filters) |
| v5.0.0 | Mar 2026 | Escrow wallet milestones, 5-state contracts |
| v4.0.0 | Mar 2026 | Trustless Contracts, ContractFactory on-chain |
| v3.0.0 | Mar 2026 | DEX AMM, swap USDC↔EURC, liquidity pools |
