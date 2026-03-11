# ARC AI Agents - Pagamentos & Contratos Autônomos

> Agentes de Inteligência Artificial que gerenciam pagamentos e contratos digitais autonomamente na **Arc Testnet** (rede da Circle) usando USDC como token nativo.

## 🌐 Sobre o Projeto

Este projeto implementa dois agentes de IA que operam na **Arc Network** (blockchain L1 da Circle) para gerenciar:

1. **ArcPay Agent** - Gerencia e executa pagamentos em USDC de forma autônoma
2. **ArcContract Agent** - Revisa, ativa, monitora e arbitra contratos digitais com escrow em USDC

## 🔗 Rede Arc Testnet

| Configuração | Valor |
|---|---|
| **RPC URL** | `https://rpc.testnet.arc.network` |
| **Chain ID** | `5042002` |
| **Token de Gas** | USDC (nativo) |
| **USDC Address** | `0x3600000000000000000000000000000000000000` |
| **Explorer** | https://testnet.arcscan.app |
| **Faucet** | https://faucet.circle.com |
| **Gas por TX** | ~$0.009 USDC |
| **Finalidade** | Sub-segundo |

## ✅ Funcionalidades Implementadas

### Agente de Pagamentos (ArcPay Agent v1.0)
- [x] Análise de risco autônoma por valor e contexto
- [x] Auto-aprovação para pagamentos ≤ $10 USDC
- [x] Análise aumentada para $10 - $100 USDC
- [x] Escalamento para $100 - $1,000 USDC
- [x] Bloqueio automático para > $10,000 USDC
- [x] Fila de tarefas com processamento em lote
- [x] Geração de hash de transação (simulado / blockchain-ready)
- [x] Relatórios e estatísticas

### Agente de Contratos (ArcContract Agent v1.0)
- [x] Validação automática de contratos (endereços, valores, milestones)
- [x] Gestão de escrow em USDC
- [x] Verificação de marcos com análise de evidências
- [x] Arbitragem de disputas com distribuição proporcional
- [x] Fluxo completo: Draft → Assinado → Ativo → Concluído
- [x] Fila de tarefas assíncrona

### Contratos Solidity (Para Deploy na Arc Testnet)
- [x] `PaymentManager.sol` - Gerencia pagamentos com aprovação do agente
- [x] `ContractManager.sol` - Gerencia contratos digitais com escrow e milestones

## 📁 Estrutura do Projeto

```
webapp/
├── src/
│   ├── index.tsx              # App Hono principal + Frontend HTML
│   ├── agents/
│   │   ├── PaymentAgent.ts    # Lógica do agente de pagamentos
│   │   └── ContractAgent.ts   # Lógica do agente de contratos
│   ├── routes/
│   │   ├── payments.ts        # Rotas API /api/payments/*
│   │   └── contracts.ts       # Rotas API /api/contracts/*
│   └── types/
│       └── arc.ts             # Tipos TypeScript + config da rede
├── contracts/
│   └── src/
│       ├── PaymentManager.sol  # Contrato de pagamentos
│       └── ContractManager.sol # Contrato de contratos digitais
├── public/static/
│   ├── app.js                 # Frontend JavaScript
│   └── styles.css             # Estilos customizados
└── ecosystem.config.cjs       # Configuração PM2
```

## 🚀 Como Executar Localmente

```bash
# 1. Instalar dependências
npm install

# 2. Build do projeto
npm run build

# 3. Iniciar servidor
pm2 start ecosystem.config.cjs

# 4. Acessar em http://localhost:3000
```

## 📡 API Endpoints

### Pagamentos
| Método | Endpoint | Descrição |
|---|---|---|
| GET | `/api/payments/agent` | Status do agente |
| GET | `/api/payments/queue` | Fila de pagamentos |
| POST | `/api/payments/submit` | Submeter pagamento |
| POST | `/api/payments/analyze` | Analisar (sem executar) |
| POST | `/api/payments/process` | Processar fila |
| POST | `/api/payments/demo` | Criar demos |
| GET | `/api/payments/report` | Relatório |

### Contratos
| Método | Endpoint | Descrição |
|---|---|---|
| GET | `/api/contracts` | Listar contratos |
| GET | `/api/contracts/:id` | Detalhes do contrato |
| POST | `/api/contracts/create` | Criar contrato |
| POST | `/api/contracts/:id/sign` | Assinar contrato |
| POST | `/api/contracts/:id/analyze` | Análise do agente |
| POST | `/api/contracts/:id/activate` | Ativar + escrow |
| POST | `/api/contracts/:id/milestone/:id/complete` | Completar marco |
| POST | `/api/contracts/:id/dispute` | Disputar contrato |

### Sistema
| Método | Endpoint | Descrição |
|---|---|---|
| GET | `/api/status` | Status geral |

## 🔨 Deploy dos Contratos Solidity na Arc Testnet

### Pré-requisitos
```bash
# Instalar Foundry
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

### Setup
```bash
# Gerar carteira
cast wallet new

# Criar .env em contracts/
echo 'ARC_TESTNET_RPC_URL="https://rpc.testnet.arc.network"' > contracts/.env
echo 'PRIVATE_KEY="0xSUA_CHAVE_PRIVADA"' >> contracts/.env

# Obter USDC testnet em faucet.circle.com → Arc Testnet
```

### Deploy
```bash
cd contracts/
source .env
forge init --no-git

# Deploy PaymentManager
forge create src/PaymentManager.sol:PaymentManager \
  --rpc-url $ARC_TESTNET_RPC_URL \
  --private-key $PRIVATE_KEY \
  --constructor-args $SEU_ENDERECO \
  --broadcast

# Deploy ContractManager
forge create src/ContractManager.sol:ContractManager \
  --rpc-url $ARC_TESTNET_RPC_URL \
  --private-key $PRIVATE_KEY \
  --constructor-args $SEU_ENDERECO \
  --broadcast
```

## 🏗️ Arquitetura

```
Browser ←→ Hono (Edge Worker)
              ↕
         AI Agents (TypeScript)
         ├── PaymentAgent → Análise de Risco + Execução
         └── ContractAgent → Revisão + Escrow + Arbitragem
              ↕
    Arc Testnet (Chain ID: 5042002)
    ├── USDC (0x3600...0000) - Token nativo + gas
    ├── PaymentManager.sol - Controla pagamentos
    └── ContractManager.sol - Controla contratos digitais
```

## 🛠️ Stack Tecnológico

- **Backend**: Hono + TypeScript (Cloudflare Workers)
- **Frontend**: HTML + Tailwind CSS + Vanilla JS
- **Blockchain**: Arc Network Testnet (Circle L1)
- **Smart Contracts**: Solidity ^0.8.30 + Foundry
- **Token**: USDC (nativo na Arc)
- **Deploy**: Cloudflare Pages

## 📊 Modelo de Dados

### Pagamento
```typescript
{
  id: string;
  from: string;          // Endereço Arc
  to: string;            // Endereço Arc
  amount: number;        // USDC (6 decimais)
  description: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  riskScore: number;     // 0-100
  status: 'pending' | 'executing' | 'executed' | 'rejected';
  agentDecision: string;
  txHash?: string;       // Hash da transação Arc
}
```

### Contrato Digital
```typescript
{
  id: number;
  client: string;        // Endereço Arc
  contractor: string;    // Endereço Arc
  title: string;
  description: string;
  totalValue: number;    // USDC (6 decimais)
  status: 'Draft' | 'Active' | 'Completed' | 'Disputed' | 'Cancelled';
  milestones: Milestone[];
  agentAnalysis: string;
}
```

## 🔒 Segurança

- Limites de risco por valor de transação
- Análise de endereços (validação formato, anti-self-payment)
- Score de risco calculado por múltiplos fatores
- Arbitragem automatizada com distribuição proporcional
- Escrow em USDC até conclusão dos marcos

## 📋 Status do Deploy

- **Plataforma**: Cloudflare Pages
- **Ambiente**: Desenvolvimento (sandbox)
- **Smart Contracts**: Prontos para deploy na Arc Testnet
- **Última atualização**: Março 2026
