# ARC AI Agents

## Project Overview
- **Name**: ARC AI Agents — Autonomous Payments & Contracts
- **Goal**: DeFi platform with AI-powered payment/contract agents, token swap, and yield vaults on Arc Testnet
- **Version**: 2.0.0

## Live URL
- **Sandbox**: https://3000-i7dbuvc4nlvszyf6ljwfs-a402f90a.sandbox.novita.ai

## Features

### ✅ Implemented
- **Dashboard** — stats cards, wallet panel, network info, recent activity, auto-refresh
- **Payments** — multi-send CSV/Excel batch, AI risk analysis, payment queue, agent decisions
- **Contracts** — create, sign, activate, milestones, disputes, AI analysis
- **AI Agents** — ArcPay Agent v1.0 + ArcContract Agent v1.0 status & logs
- **Deploy** — Foundry deploy guide for PaymentManager + ContractManager
- **🔄 Swap** — USDC ↔ EURC swap with live quotes, slippage protection, fee display, history
- **🏦 Vaults** — USDC Vault (5.2% APY) + EURC Vault (4.8% APY), deposit/withdraw, yield claim
- **🤖 Chatbot** — ARC AI Assistant floating widget, intent detection, integrated with all modules
- **⚙️ Settings** — Circle API integration config, app config, security PIN (admin only)
- **👤 Profile** — user profile modal with name, email, role, company, wallet
- **🌐 i18n** — 5 languages: EN (default), PT, ES, ZH, KO

## API Endpoints

### Swap
- `GET /api/swap/rates` — current USDC↔EURC rates
- `GET /api/swap/quote?from=USDC&to=EURC&amount=100` — swap quote
- `POST /api/swap/execute` — execute swap `{fromToken, toToken, amountIn, walletAddress}`
- `GET /api/swap/history` — swap history

### Vaults
- `GET /api/vaults` — list all vaults (USDC + EURC)
- `GET /api/vaults/:token` — vault details (token: `usdc` | `eurc`)
- `POST /api/vaults/:token/deposit` — deposit `{walletAddress, amount}`
- `POST /api/vaults/:token/withdraw` — withdraw `{walletAddress, amount, includeYield}`
- `GET /api/vaults/:token/history` — vault transaction history
- `GET /api/vaults/:token/apy` — APY projections

### Chat
- `POST /api/chat/message` — send message `{message, sessionId}`
- `GET /api/chat/history/:sessionId` — chat history
- `DELETE /api/chat/history/:sessionId` — clear history

### Payments
- `GET /api/payments/queue` — payment queue
- `POST /api/payments/submit` — submit payment
- `POST /api/payments/analyze` — risk analysis
- `POST /api/payments/process` — process queue
- `POST /api/payments/batch` — batch payments
- `GET /api/payments/agent` — agent status

### Contracts
- `GET /api/contracts` — list contracts
- `POST /api/contracts/create` — create contract
- `POST /api/contracts/:id/activate` — activate
- `POST /api/contracts/:id/milestone/:mid/complete` — complete milestone

## Chatbot Commands
- `"Show vault APY"` — vault info
- `"swap 100 USDC"` — swap quote
- `"payment queue"` — pending payments
- `"active contracts"` — contracts overview
- `"agent status"` — AI agents status
- `"Arc testnet info"` — network details
- Keyboard: **Ctrl+/** to open chat

## Network
- **Chain ID**: 5042002 (Arc Testnet)
- **RPC**: https://rpc.testnet.arc.network
- **Explorer**: https://testnet.arcscan.app
- **Faucet**: https://faucet.circle.com
- **Gas Token**: USDC (~$0.009/tx)

## Stack
- **Backend**: Hono + TypeScript → Cloudflare Workers
- **Frontend**: Vanilla JS + Tailwind CSS (CDN)
- **Build**: Vite + @hono/vite-cloudflare-pages
- **Dev Server**: wrangler pages dev (PM2)
