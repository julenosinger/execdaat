// Rota API para o Chatbot IA integrado com todos os módulos

import { Hono } from 'hono';

const chatRouter = new Hono();

// ─── Histórico de conversas (in-memory, sessão) ──────────────────────────────
interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  module?: string; // 'payments' | 'vaults' | 'swap' | 'contracts' | 'agents' | 'general'
  data?: unknown;   // dados estruturados opcionais
}

interface ChatSession {
  id: string;
  messages: ChatMessage[];
  createdAt: string;
  lastActivity: string;
}

const sessions: Map<string, ChatSession> = new Map();

function getOrCreateSession(sessionId: string): ChatSession {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      id: sessionId,
      messages: [],
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
    });
  }
  const s = sessions.get(sessionId)!;
  s.lastActivity = new Date().toISOString();
  return s;
}

// ─── Motor de IA Local (sem API externa) ─────────────────────────────────────
// Engine rule-based + contextual para responder perguntas sobre o sistema

interface ModuleData {
  payments?: { queue: number; processed: number; volume: number };
  vaults?: { usdc: { balance: number; apy: number }; eurc: { balance: number; apy: number } };
  swap?: { usdcToEurc: number; eurcToUsdc: number };
  contracts?: { active: number; pending: number; total: number };
}

function detectIntent(text: string): { intent: string; module: string; entities: Record<string, string> } {
  const lower = text.toLowerCase();

  // Guardian / Compliance / KYC intents
  if (/guardian|kyc|compliance|aml|sanction|bloqueio|risco|risk score|verificar|verify|complian/.test(lower)) {
    if (/kyc|verific|identific|document/.test(lower)) return { intent: 'guardian_kyc', module: 'guardian', entities: {} };
    if (/sanction|sanctioned|bloqueado|blocked/.test(lower)) return { intent: 'guardian_sanction', module: 'guardian', entities: {} };
    return { intent: 'guardian_status', module: 'guardian', entities: {} };
  }

  // Yield Optimizer intents
  if (/yield optim|otimizador|otimizar|rebalance|rebalanc|pool|melhor apy|best apy|posicao|position/.test(lower)) {
    if (/pool|pools|melhores?.pool/.test(lower)) return { intent: 'yield_pools', module: 'yield', entities: {} };
    if (/position|posicao/.test(lower)) return { intent: 'yield_positions', module: 'yield', entities: {} };
    return { intent: 'yield_status', module: 'yield', entities: {} };
  }

  // Intents de pagamentos
  if (/pagamento|payment|pagar|send|enviar|transfer/.test(lower)) {
    if (/anali[sz]|risk|risco|check/.test(lower)) return { intent: 'analyze_payment', module: 'payments', entities: {} };
    if (/fila|queue|pending/.test(lower)) return { intent: 'payment_queue', module: 'payments', entities: {} };
    if (/histori|history|recent/.test(lower)) return { intent: 'payment_history', module: 'payments', entities: {} };
    return { intent: 'payment_info', module: 'payments', entities: {} };
  }

  // Intents de vault
  if (/vault|cofre|deposi|yield|rendimento|apy|sac|withdraw/.test(lower)) {
    if (/eurc|euro/.test(lower)) return { intent: 'vault_eurc', module: 'vaults', entities: { token: 'EURC' } };
    if (/usdc/.test(lower)) return { intent: 'vault_usdc', module: 'vaults', entities: { token: 'USDC' } };
    return { intent: 'vault_info', module: 'vaults', entities: {} };
  }

  // Intents de swap
  if (/swap|trocar|convert|cambio|câmbio|taxa|rate|eurc|usdc.*(para|to|→)/.test(lower)) {
    return { intent: 'swap_info', module: 'swap', entities: {} };
  }

  // Intents de contratos
  if (/contrat|contract|milestone|escrow|assinar|sign/.test(lower)) {
    if (/ativo|active/.test(lower)) return { intent: 'contracts_active', module: 'contracts', entities: {} };
    if (/milestone|etapa/.test(lower)) return { intent: 'contracts_milestone', module: 'contracts', entities: {} };
    return { intent: 'contract_info', module: 'contracts', entities: {} };
  }

  // Intents de agentes
  if (/agent|ia|ai|bot|autonom|aprova/.test(lower)) {
    return { intent: 'agents_status', module: 'agents', entities: {} };
  }

  // Rede
  if (/arc|testnet|rede|network|chain|rpc|usdc address/.test(lower)) {
    return { intent: 'network_info', module: 'network', entities: {} };
  }

  // Ajuda
  if (/help|ajuda|como|how|what|o que|comandos/.test(lower)) {
    return { intent: 'help', module: 'general', entities: {} };
  }

  // Saudações
  if (/^(oi|olá|ola|hey|hi|hello|bom dia|boa tarde|boa noite)/i.test(lower)) {
    return { intent: 'greeting', module: 'general', entities: {} };
  }

  return { intent: 'general', module: 'general', entities: {} };
}

async function generateResponse(
  userMsg: string,
  intent: string,
  module: string,
  _entities: Record<string, string>,
  context: ChatMessage[]
): Promise<{ content: string; data?: unknown; module: string }> {

  // Faz chamadas internas para as APIs do sistema
  const baseUrl = 'http://localhost:3000';

  const fetchApi = async (path: string) => {
    try {
      const res = await fetch(`${baseUrl}${path}`);
      return await res.json();
    } catch {
      return null;
    }
  };

  const lower = userMsg.toLowerCase();

  switch (intent) {
    case 'greeting': {
      const greetings = [
        "Hello! I'm **ARC AI Assistant** 🤖. I can help you with:\n\n• 💳 **Payments** — queue, analysis, batch processing\n• 🏦 **Vaults** — USDC & EURC deposits and yield\n• 🔄 **Swap** — exchange USDC ↔ EURC\n• 📋 **Contracts** — status and milestones\n• 🛡️ **Guardian** — compliance, KYC, AML\n• 🌱 **Yield Optimizer** — best APY, pool rebalancing\n• 🧠 **AI Agents** — all 4 agents status\n\nWhat would you like to do?",
        "Hi! I'm your **ARC AI Assistant** 👋. I'm integrated with all 4 AI agents.\n\nTry asking:\n- *\"Show vault APY\"*\n- *\"What's the USDC → EURC rate?\"*\n- *\"Guardian status\"*\n- *\"Best yield pools\"*\n- *\"How many pending payments?\"*",
      ];
      return { content: greetings[Math.floor(Math.random() * greetings.length)], module: 'general' };
    }

    case 'help': {
      return {
        content: `## Available Commands 🤖\n\n**💳 Payments**\n- *"Show payment queue"*\n- *"Pending payments"*\n\n**🏦 Vaults**\n- *"USDC vault APY"*\n- *"EURC vault balance"*\n\n**🔄 Swap**\n- *"USDC to EURC rate"*\n- *"Swap 100 USDC"*\n\n**📋 Contracts**\n- *"Active contracts"*\n\n**🛡️ Guardian (Compliance/KYC)**\n- *"Guardian status"*\n- *"KYC tiers"*\n- *"Compliance check"*\n\n**🌱 Yield Optimizer**\n- *"Best yield pools"*\n- *"Yield positions"*\n- *"Yield optimizer status"*\n\n**🧠 AI Agents**\n- *"Agent status"*\n\n**🌐 Network**\n- *"Arc testnet info"*`,
        module: 'general',
      };
    }

    case 'payment_queue':
    case 'payment_info': {
      const data = await fetchApi('/api/payments/queue');
      if (!data || !data.success) {
        return { content: 'I couldn\'t retrieve the payment queue. Please try again.', module: 'payments' };
      }
      const pending = data.pending?.length || 0;
      const processed = data.processed?.length || 0;
      const totalVol = (data.processed || []).reduce((s: number, p: { amount: number }) => s + (p.amount || 0) / 1e6, 0);

      return {
        content: `## 💳 Payment Queue\n\n- **Pending:** ${pending} payment${pending !== 1 ? 's' : ''} awaiting processing\n- **Processed:** ${processed} payment${processed !== 1 ? 's' : ''}\n- **Total Volume:** $${totalVol.toFixed(2)} USDC\n\n${pending > 0 ? `⚡ There are **${pending} pending** payments. Click **Process Queue** in the Payments tab to execute them.` : '✅ Queue is clear!'}`,
        data: { pending, processed },
        module: 'payments',
      };
    }

    case 'vault_info':
    case 'vault_usdc':
    case 'vault_eurc': {
      const token = intent === 'vault_eurc' ? 'eurc' : intent === 'vault_usdc' ? 'usdc' : null;
      const data = token ? await fetchApi(`/api/vaults/${token}`) : await fetchApi('/api/vaults');

      if (!data || !data.success) {
        return { content: 'Unable to fetch vault data at this moment.', module: 'vaults' };
      }

      if (token && data.vault) {
        const v = data.vault;
        return {
          content: `## 🏦 ${v.name}\n\n| Metric | Value |\n|--------|-------|\n| **Balance** | ${v.currentBalance.toLocaleString()} ${v.token} |\n| **APY** | ${v.apy}% |\n| **Yield Accrued** | ${v.accrued.toFixed(4)} ${v.token} |\n| **Total Deposited** | ${v.totalDeposited.toLocaleString()} ${v.token} |\n| **Participants** | ${v.participants} |\n| **Contract** | \`${v.contractAddress.slice(0, 10)}...\` |\n\n${v.description}\n\n*To deposit or withdraw, go to the **Vaults** tab.*`,
          data: v,
          module: 'vaults',
        };
      }

      const vaultList = data.vaults || [];
      const lines = vaultList.map((v: { name: string; currentBalance: number; token: string; apy: number; accrued: number }) =>
        `**${v.name}**: ${v.currentBalance.toLocaleString()} ${v.token} | APY: **${v.apy}%** | Yield: ${v.accrued.toFixed(2)} ${v.token}`
      );

      return {
        content: `## 🏦 Vaults Overview\n\n${lines.join('\n\n')}\n\n*Ask about a specific vault: "USDC vault" or "EURC vault"*`,
        data: vaultList,
        module: 'vaults',
      };
    }

    case 'swap_info': {
      const data = await fetchApi('/api/swap/rates');
      if (!data || !data.success) {
        return { content: 'Unable to fetch swap rates.', module: 'swap' };
      }

      // Check if user wants a specific amount
      const amountMatch = userMsg.match(/(\d+(?:\.\d+)?)\s*(usdc|eurc)/i);
      if (amountMatch) {
        const amount = parseFloat(amountMatch[1]);
        const fromToken = amountMatch[2].toUpperCase();
        const toToken = fromToken === 'USDC' ? 'EURC' : 'USDC';
        const rate = fromToken === 'USDC' ? data.rates.USDC_TO_EURC : data.rates.EURC_TO_USDC;
        const gross = amount * rate;
        const fee = gross * 0.003;
        const out = gross - fee;

        return {
          content: `## 🔄 Swap Quote\n\n**${amount} ${fromToken} → ${out.toFixed(4)} ${toToken}**\n\n| | |\n|---|---|\n| Rate | 1 ${fromToken} = ${rate} ${toToken} |\n| Fee (0.3%) | ${fee.toFixed(4)} ${toToken} |\n| You receive | **${out.toFixed(4)} ${toToken}** |\n\n*Go to the **Swap** tab to execute this transaction.*`,
          data: { amount, fromToken, toToken, out },
          module: 'swap',
        };
      }

      const r = data.rates;
      const pool = data.pool;
      return {
        content: `## 🔄 Current Swap Rates\n\n| Pair | Rate |\n|------|------|\n| USDC → EURC | **${r.USDC_TO_EURC}** |\n| EURC → USDC | **${r.EURC_TO_USDC}** |\n\n**Pool Stats:**\n- USDC Reserve: ${pool.usdcReserve.toLocaleString()}\n- EURC Reserve: ${pool.eurcReserve.toLocaleString()}\n- Fee: ${pool.fee}\n- Total Swaps: ${pool.totalSwaps}\n\n*Try: "swap 100 USDC" to get a quote*`,
        data: r,
        module: 'swap',
      };
    }

    case 'contracts_active':
    case 'contract_info': {
      const data = await fetchApi('/api/contracts');
      if (!data || !data.success) {
        return { content: 'Unable to fetch contracts.', module: 'contracts' };
      }

      const contracts = data.contracts || [];
      const active = contracts.filter((c: { status: string }) => c.status === 'Active');
      const draft = contracts.filter((c: { status: string }) => c.status === 'Draft');

      const lines = contracts.slice(0, 5).map((c: { title: string; status: string; totalValue: number; milestones: Array<{ status: string }> }) => {
        const statusEmoji = c.status === 'Active' ? '🟢' : c.status === 'Draft' ? '🟡' : c.status === 'Completed' ? '✅' : '🔴';
        const completed = (c.milestones || []).filter((m: { status: string }) => m.status === 'Completed').length;
        const total = (c.milestones || []).length;
        return `${statusEmoji} **${c.title}** — $${(c.totalValue / 1e6).toLocaleString()} USDC (${completed}/${total} milestones)`;
      });

      return {
        content: `## 📋 Contracts Overview\n\n- **Active:** ${active.length}\n- **Draft:** ${draft.length}\n- **Total:** ${contracts.length}\n\n${lines.join('\n')}\n\n*Go to the **Contracts** tab to manage them.*`,
        data: { active: active.length, draft: draft.length, total: contracts.length },
        module: 'contracts',
      };
    }

    case 'agents_status': {
      const payData = await fetchApi('/api/payments/agent');
      const conData = await fetchApi('/api/contracts/agent');
      const guardData = await fetchApi('/api/guardian/status');
      const yieldData = await fetchApi('/api/yield/status');

      const payStats = payData?.stats || {};
      const conStats = conData?.stats || {};
      const gStats = guardData?.stats || {};
      const yStats = yieldData?.stats || {};

      return {
        content: `## 🧠 AI Agents Status\n\n**ArcPay Agent v1.0** 🟢\n- Approved: ${payStats.approved || 0} | Rejected: ${payStats.rejected || 0} | Pending: ${payStats.pending || 0}\n- Volume: $${((payStats.totalAmount || 0) / 1e6).toFixed(2)} USDC\n\n**ArcContract Agent v1.0** 🟢\n- Active: ${conStats.active || 0} | Completed: ${conStats.completed || 0}\n\n**Guardian Agent v1.0** 🛡️\n- Total Checks: ${gStats.totalChecks || 0} | Approved: ${gStats.approved || 0} | Blocked: ${gStats.blocked || 0}\n- KYC Verified: ${gStats.kycVerified || 0} | Avg Risk: ${(gStats.averageRiskScore || 0).toFixed(1)}/100\n\n**Yield Optimizer v1.0** 🌱\n- Best APY: ${yStats.bestApy || 0}% | Active Pools: ${yStats.totalPools || 0} | Positions: ${yStats.activePositions || 0}\n\nAll 4 agents are online monitoring Arc Testnet.`,
        module: 'agents',
      };
    }

    case 'guardian_status':
    case 'guardian_sanction': {
      const data = await fetchApi('/api/guardian/status');
      if (!data?.success) return { content: 'Unable to fetch Guardian status.', module: 'guardian' };
      const s = data.stats;
      return {
        content: `## 🛡️ Guardian Agent — Compliance & KYC\n\n**Status:** ${data.agent?.status?.toUpperCase() || 'ACTIVE'}\n\n| Metric | Value |\n|--------|-------|\n| Total Checks | ${s.totalChecks} |\n| Approved | ✅ ${s.approved} |\n| Blocked | 🚫 ${s.blocked} |\n| Flagged | ⚠️ ${s.flagged} |\n| KYC Verified | 🔐 ${s.kycVerified} |\n| KYC Pending | ⏳ ${s.kycPending} |\n| Avg Risk Score | ${(s.averageRiskScore || 0).toFixed(1)}/100 |\n\n**Capabilities:**\n- 🔍 OFAC/Sanction screening\n- 🆔 KYC/AML verification (Tier 0–3)\n- 🌍 Jurisdiction risk check\n- 📊 Structuring detection\n- 🔒 On-chain compliance signatures\n\nTo check compliance for a transaction, go to **AI Agents** tab → Guardian card.`,
        module: 'guardian',
      };
    }

    case 'guardian_kyc': {
      return {
        content: `## 🆔 KYC Tiers\n\n| Tier | Label | Max per Tx | Daily Limit |\n|------|-------|-----------|-------------|\n| 0 | No KYC | $100 | $200 |\n| 1 | Basic | $1,000 | $5,000 |\n| 2 | Standard | $10,000 | $50,000 |\n| 3 | Full | $500,000 | $1,000,000 |\n\nTo submit KYC:\n1. Go to **AI Agents** → **Guardian Agent** card\n2. Click **Submit KYC Application**\n3. Enter your wallet address and select tier\n4. Auto-verification in ~15 seconds (testnet)\n\nHigher KYC tier = higher transaction limits on Arc Testnet!`,
        module: 'guardian',
      };
    }

    case 'yield_status': {
      const data = await fetchApi('/api/yield/status');
      if (!data?.success) return { content: 'Unable to fetch Yield Optimizer status.', module: 'yield' };
      const s = data.stats;
      return {
        content: `## 🌱 Yield Optimizer Agent\n\n**Status:** ${s.agentStatus?.toUpperCase() || 'IDLE'}\n\n| Metric | Value |\n|--------|-------|\n| Best APY | ${s.bestApy || 0}% |\n| Active Pools | ${s.totalPools || 0} |\n| Active Positions | ${s.activePositions || 0} |\n| Rebalances | ${s.rebalances || 0} |\n| Avg APY | ${s.averageApy || 0}% |\n\n**Strategies:**\n- 🏦 Conservative — Low risk, stable yield\n- ⚖️ Balanced — Mix of stability and yield\n- 🚀 Aggressive — Maximum yield, higher risk\n\nTo open a yield position, go to **AI Agents** tab → Yield Optimizer card.`,
        module: 'yield',
      };
    }

    case 'yield_pools': {
      const data = await fetchApi('/api/yield/pools');
      if (!data?.success) return { content: 'Unable to fetch yield pools.', module: 'yield' };
      const pools = (data.pools || []).slice(0, 6);
      const lines = pools.map((p: { name: string; token: string; apy: number; risk: string; tvl: number }) =>
        `| ${p.token === 'USDC' ? '💵' : '💶'} ${p.name} | ${p.token} | **${p.apy}%** | ${p.risk} | $${(p.tvl / 1000).toFixed(0)}k |`
      );
      return {
        content: `## 🏊 Yield Pools\n\n| Pool | Token | APY | Risk | TVL |\n|------|-------|-----|------|-----|\n${lines.join('\n')}\n\n*Best USDC pool: ${data.bestUsdc?.name || '—'} at **${data.bestUsdc?.apy || 0}% APY***\n*Best EURC pool: ${data.bestEurc?.name || '—'} at **${data.bestEurc?.apy || 0}% APY***\n\nOpen a position in **AI Agents** → **Yield Optimizer** card!`,
        module: 'yield',
      };
    }

    case 'yield_positions': {
      const data = await fetchApi('/api/yield/positions');
      if (!data?.success) return { content: 'Unable to fetch positions.', module: 'yield' };
      const positions = data.positions || [];
      if (!positions.length) {
        return {
          content: `## 📊 Yield Positions\n\nNo active positions found.\n\nTo open one:\n1. Go to **AI Agents** → **Yield Optimizer** card\n2. Select a pool and amount\n3. Click **Open Position (Sign on Arc)**\n4. Confirm the transaction in your wallet`,
          module: 'yield',
        };
      }
      const lines = positions.map((p: { poolId: string; deposited: number; token: string; entryApy: number; yieldEarned: number }) =>
        `- **${p.poolId}**: ${(p.deposited / 1e6).toFixed(2)} ${p.token} @ ${p.entryApy}% APY | Earned: +${(p.yieldEarned / 1e6).toFixed(4)}`
      );
      return {
        content: `## 📊 Active Yield Positions\n\n${lines.join('\n')}\n\n*Total: ${positions.length} position${positions.length !== 1 ? 's' : ''}*`,
        module: 'yield',
      };
    }

    case 'network_info': {
      return {
        content: `## 🌐 Arc Testnet\n\n| Property | Value |\n|----------|-------|\n| **Chain ID** | 5042002 |\n| **RPC Primário** | https://rpc.testnet.arc.network |\n| **RPC Blockdaemon** | https://rpc.blockdaemon.testnet.arc.network |\n| **RPC dRPC** | https://rpc.drpc.testnet.arc.network |\n| **RPC QuickNode** | https://rpc.quicknode.testnet.arc.network |\n| **WebSocket** | wss://rpc.testnet.arc.network |\n| **Explorer** | testnet.arcscan.app |\n| **Faucet** | faucet.circle.com |\n| **Gas Token** | USDC |\n| **Gas Cost** | ~$0.009 per tx |\n| **Finality** | Sub-second |\n| **USDC Address** | 0x3600000000000000000000000000000000000000 |\n| **EURC Address** | 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a |\n\nNative gas token is **USDC** — no need for ETH! Use any RPC endpoint above.`,
        module: 'network',
      };
    }

    default: {
      // Tenta identificar perguntas numéricas sobre valores
      if (/quanto|how much|how many|quantos|quantas/.test(lower)) {
        const data = await fetchApi('/api/payments/queue');
        const vData = await fetchApi('/api/vaults');
        const pending = data?.pending?.length || 0;
        const usdcBal = vData?.vaults?.find((v: { token: string }) => v.token === 'USDC')?.currentBalance || 0;
        return {
          content: `Here's a quick overview:\n\n- 💳 **${pending}** pending payments in queue\n- 🏦 **${usdcBal.toLocaleString()} USDC** in USDC vault\n\nAsk me something more specific! E.g.:\n- *"Show EURC vault"*\n- *"Current swap rate"*\n- *"Contracts overview"*`,
          module: 'general',
        };
      }

      // Resposta contextual baseada no histórico
      const recentModules = context.slice(-4)
        .filter(m => m.module && m.module !== 'general')
        .map(m => m.module);

      if (recentModules.length > 0) {
        const lastModule = recentModules[recentModules.length - 1];
        return {
          content: `I noticed we were talking about **${lastModule}**. Could you be more specific?\n\nFor example:\n- *"Show ${lastModule} details"*\n- *"${lastModule} status"*\n\nOr type **"help"** to see all available commands.`,
          module: lastModule || 'general',
        };
      }

      return {
        content: `I'm not sure I understood that. 🤔\n\nI can help you with:\n- 💳 **Payments** — *"payment queue"*, *"pending payments"*\n- 🏦 **Vaults** — *"USDC vault"*, *"EURC APY"*\n- 🔄 **Swap** — *"swap rate"*, *"swap 100 USDC"*\n- 📋 **Contracts** — *"active contracts"*\n- 🧠 **Agents** — *"agent status"*\n\nType **"help"** for full command list.`,
        module: 'general',
      };
    }
  }
}

// ─── Endpoints ────────────────────────────────────────────────────────────────

// POST /api/chat/message - Enviar mensagem
chatRouter.post('/message', async (c) => {
  try {
    const body = await c.req.json();
    const { message, sessionId = 'default' } = body;

    if (!message || typeof message !== 'string') {
      return c.json({ success: false, error: 'Campo "message" é obrigatório' }, 400);
    }
    if (message.length > 1000) {
      return c.json({ success: false, error: 'Mensagem muito longa (max 1000 chars)' }, 400);
    }

    const session = getOrCreateSession(sessionId);

    // Salvar mensagem do usuário
    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}-u`,
      role: 'user',
      content: message,
      timestamp: new Date().toISOString(),
    };
    session.messages.push(userMsg);

    // Detectar intenção e gerar resposta
    const { intent, module, entities } = detectIntent(message);
    const context = session.messages.slice(-10);
    const response = await generateResponse(message, intent, module, entities, context);

    const assistantMsg: ChatMessage = {
      id: `msg-${Date.now()}-a`,
      role: 'assistant',
      content: response.content,
      timestamp: new Date().toISOString(),
      module: response.module,
      data: response.data,
    };
    session.messages.push(assistantMsg);

    // Manter histórico máximo de 100 mensagens
    if (session.messages.length > 100) {
      session.messages = session.messages.slice(-80);
    }

    return c.json({
      success: true,
      message: assistantMsg,
      intent,
      module,
      sessionId,
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// GET /api/chat/history/:sessionId - Histórico da sessão
chatRouter.get('/history/:sessionId', (c) => {
  const sessionId = c.req.param('sessionId');
  const session = sessions.get(sessionId);

  if (!session) {
    return c.json({ success: true, messages: [], sessionId });
  }

  return c.json({
    success: true,
    messages: session.messages,
    sessionId,
    messageCount: session.messages.length,
    createdAt: session.createdAt,
    lastActivity: session.lastActivity,
  });
});

// DELETE /api/chat/history/:sessionId - Limpar histórico
chatRouter.delete('/history/:sessionId', (c) => {
  const sessionId = c.req.param('sessionId');
  sessions.delete(sessionId);
  return c.json({ success: true, message: 'Histórico limpo com sucesso' });
});

// GET /api/chat/sessions - Listar sessões ativas
chatRouter.get('/sessions', (c) => {
  const list = Array.from(sessions.values()).map(s => ({
    id: s.id,
    messageCount: s.messages.length,
    createdAt: s.createdAt,
    lastActivity: s.lastActivity,
  }));
  return c.json({ success: true, sessions: list });
});

export default chatRouter;
