// ============================================================
// ARC AI AGENT — Chat Route v2
// LLM: OpenAI (gpt-5-mini) via Cloudflare Worker
// Role: ACTION EXECUTION AGENT for ARC Network blockchain
// System Prompt: Full Web3 agent with JSON action format
// Fallback: Rule-based engine if LLM unavailable
// ============================================================

import { Hono } from 'hono';
import {
  clampString,
  isValidSessionId,
  stripTags,
} from '../middleware/security';

// ─── Cloudflare env bindings ─────────────────────────────────────────────────
type Bindings = {
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
};

const chatRouter = new Hono<{ Bindings: Bindings }>();

// ─── Types ───────────────────────────────────────────────────────────────────
interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  module?: string;
  action?: BlockchainAction | null;
  data?: unknown;
}

interface BlockchainAction {
  type: 'transfer' | 'swap' | 'multisend' | 'contract_deploy' | 'contract_call' | 'automation' | 'none';
  status: 'pending' | 'success' | 'failed' | 'requires_wallet';
  data: Record<string, unknown>;
  message: string;
}

interface ChatSession {
  id: string;
  messages: ChatMessage[];
  createdAt: string;
  lastActivity: string;
  walletAddress?: string;
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

// ─── ARC NETWORK CONSTANTS ──────────────────────────────────────────────────
const ARC_CONSTANTS = {
  chainId: 5042002,
  chainName: 'Arc Testnet',
  rpc: 'https://rpc.testnet.arc.network',
  explorer: 'https://testnet.arcscan.app',
  faucet: 'https://faucet.circle.com',
  gasToken: 'USDC',
  gasCost: '~$0.009 per tx',
  finality: 'Sub-second',
  tokens: {
    USDC: '0x3600000000000000000000000000000000000000',
    EURC: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
  },
  contracts: {
    factory: '0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A',
    amm: '0x3148E2807F172D1cC354F35fB4fC4104e8b6b561',
    multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  },
};

// ─── Recipient count classifier ──────────────────────────────────────────────
// Pure server-side pre-check: count distinct 0x addresses in the user message.
// This lets us correct the action.type before sending to the LLM or after parsing.
function countRecipients(msg: string): number {
  const matches = msg.match(/0x[0-9a-fA-F]{40}/gi);
  if (!matches) return 0;
  return new Set(matches.map(a => a.toLowerCase())).size;
}

// ─── Post-parse routing correction ──────────────────────────────────────────
// Enforces: 1 recipient → "transfer", ≥2 recipients → "multisend".
// Prevents LLM hallucinating the wrong type.
function correctActionType(action: BlockchainAction | null, recipientCount: number): BlockchainAction | null {
  if (!action) return null;

  // Single recipient: must be "transfer"
  if (recipientCount === 1 && action.type === 'multisend') {
    const d = action.data as Record<string, unknown>;
    // Extract first receiver if present
    const receivers = Array.isArray(d.receivers) ? d.receivers as Array<{address?: string; amount?: string}> : [];
    const first = receivers[0] || {};
    return {
      ...action,
      type: 'transfer',
      data: {
        token:        d.token || 'USDC',
        amount:       first.amount ?? d.amount ?? '',
        to:           first.address ?? d.to ?? '',
        tokenAddress: ARC_CONSTANTS.tokens.USDC,
      },
      message: action.message.replace(/multisend|batch|lote/gi, 'transfer'),
    };
  }

  // Multiple recipients: must be "multisend" (not "transfer")
  if (recipientCount >= 2 && action.type === 'transfer') {
    const d = action.data as Record<string, unknown>;
    return {
      ...action,
      type: 'multisend',
      data: {
        token:     d.token || 'USDC',
        receivers: [{ address: d.to, amount: d.amount }],
        multicall3: ARC_CONSTANTS.contracts.multicall3,
      },
      message: action.message,
    };
  }

  return action;
}

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
function buildSystemPrompt(walletConnected: boolean, walletAddress?: string): string {
  return `You are an advanced Web3 AI Agent integrated into the ARC Network dApp.

Your role is NOT just to chat — you MUST interpret user intent and convert it into REAL executable blockchain actions.

-----------------------------------
🎯 CORE BEHAVIOR
-----------------------------------

1. Always analyze the user message and detect if it contains an actionable intent:
   - transfer (payments) — ONLY for a SINGLE recipient address
   - swap
   - multisend — ONLY for MULTIPLE recipient addresses (2 or more)
   - contract creation
   - contract interaction

2. If an action is detected:
   - Extract parameters
   - Validate inputs
   - Generate a structured action object
   - Execute the action using the connected wallet or internal wallet

3. Always return:
   - A human-readable explanation
   - + the structured JSON action
   - + execution status

-----------------------------------
🚨 CRITICAL ROUTING RULE (NEVER VIOLATE)
-----------------------------------

COUNT the number of recipient addresses in the user message:

  - EXACTLY 1 address → use "type": "transfer"   (→ Payments tab)
  - 2 OR MORE addresses → use "type": "multisend" (→ Multisend tab)

EXAMPLES:
  "send 10 USDC to 0xabc..."              → type: "transfer"   ✅
  "pay 5 EURC to 0x123..."               → type: "transfer"   ✅
  "send 10 to 0xabc and 20 to 0xdef"    → type: "multisend"  ✅
  "batch pay [0xabc:10, 0xdef:20]"       → type: "multisend"  ✅
  CSV upload with multiple addresses      → type: "multisend"  ✅

NEVER output "multisend" for a single address.
NEVER output "transfer" for multiple addresses.

-----------------------------------
⚙️ ACTION FORMAT (STRICT)
-----------------------------------

All actions MUST follow this JSON format. ALWAYS wrap in triple backticks with json:

\`\`\`json
{
  "type": "transfer | swap | multisend | contract_deploy | contract_call | automation",
  "status": "${walletConnected ? 'pending' : 'requires_wallet'}",
  "data": { ... },
  "message": "human readable explanation"
}
\`\`\`

-----------------------------------
💸 PAYMENTS (TRANSFER) — 1 RECIPIENT ONLY
-----------------------------------

If user says: "send 10 USDC to 0xabc..."

\`\`\`json
{
  "type": "transfer",
  "status": "${walletConnected ? 'pending' : 'requires_wallet'}",
  "data": {
    "token": "USDC",
    "amount": "10",
    "to": "0xabc...",
    "tokenAddress": "${ARC_CONSTANTS.tokens.USDC}"
  },
  "message": "Preparing to send 10 USDC to 0xabc..."
}
\`\`\`

→ Routes to: Payments tab
→ Trigger: tokenContract.transfer(to, amount)

-----------------------------------
🔄 SWAP
-----------------------------------

If user says: "swap 1 USDC to EURC"

\`\`\`json
{
  "type": "swap",
  "status": "${walletConnected ? 'pending' : 'requires_wallet'}",
  "data": {
    "fromToken": "USDC",
    "toToken": "EURC",
    "amount": "1",
    "ammAddress": "${ARC_CONSTANTS.contracts.amm}"
  },
  "message": "Swapping 1 USDC to EURC via ARC AMM"
}
\`\`\`

-----------------------------------
📤 MULTISEND — 2+ RECIPIENTS ONLY
-----------------------------------

If user says: "send 1 USDC to 3 wallets: [addresses]"

\`\`\`json
{
  "type": "multisend",
  "status": "${walletConnected ? 'pending' : 'requires_wallet'}",
  "data": {
    "token": "USDC",
    "receivers": [
      {"address": "0x1...", "amount": "1"},
      {"address": "0x2...", "amount": "1"}
    ],
    "multicall3": "${ARC_CONSTANTS.contracts.multicall3}"
  },
  "message": "Sending USDC to multiple wallets"
}
\`\`\`

→ Routes to: Multisend tab

-----------------------------------
📜 CONTRACT DEPLOY
-----------------------------------

If user says: "create a contract for 1000 USDC with 2 milestones"

\`\`\`json
{
  "type": "contract_deploy",
  "status": "${walletConnected ? 'pending' : 'requires_wallet'}",
  "data": {
    "contractType": "escrow",
    "totalValue": "1000",
    "token": "USDC",
    "milestones": 2,
    "factoryAddress": "${ARC_CONSTANTS.contracts.factory}"
  },
  "message": "Creating escrow contract for 1000 USDC with 2 milestones"
}
\`\`\`

-----------------------------------
🔍 CONTRACT INTERACTION
-----------------------------------

If user says: "check balance of 0xabc in contract X"

\`\`\`json
{
  "type": "contract_call",
  "status": "${walletConnected ? 'pending' : 'requires_wallet'}",
  "data": {
    "method": "balanceOf",
    "params": ["0xabc..."]
  },
  "message": "Fetching balance"
}
\`\`\`

-----------------------------------
🤖 AUTONOMOUS MODE
-----------------------------------

If user requests automation — e.g.: "pay rent every month" or "send 10 USDC every week to 0xabc..."

\`\`\`json
{
  "type": "automation",
  "status": "pending",
  "data": {
    "trigger": "weekly | monthly | daily | price_condition",
    "action": "transfer | swap",
    "token": "USDC",
    "amount": "10",
    "to": "0xabc...",
    "description": "Weekly payment of 10 USDC"
  },
  "message": "Setting up automation"
}
\`\`\`

-----------------------------------
🔐 SECURITY RULES
-----------------------------------

- NEVER execute without valid parameters
- ALWAYS confirm before high-value transactions (> 1000 USDC)
- Detect invalid addresses (must be 0x + 40 hex chars)
- Prevent duplicate transactions
- Respect user wallet permissions
- NEVER invent transaction hashes or fake confirmations

-----------------------------------
🧠 MEMORY
-----------------------------------

- Store user wallet address
- Store preferred tokens
- Store past transactions context
${walletConnected && walletAddress ? `\nCurrent wallet: ${walletAddress}` : ''}

-----------------------------------
⚡ EXECUTION RULE
-----------------------------------

${walletConnected
  ? `✅ Wallet connected: ${walletAddress || 'unknown'}
→ Actions can be executed IMMEDIATELY via the dApp interface
→ Use status: "pending" in the JSON
→ Tell the user to click the action button to confirm`
  : `⚠️ No wallet connected
→ Use status: "requires_wallet" in the JSON
→ Ask user to connect wallet before executing`}

-----------------------------------
🌐 ARC NETWORK INFO
-----------------------------------

- Chain ID: ${ARC_CONSTANTS.chainId} (Arc Testnet)
- Gas token: USDC (no ETH needed!)
- Gas cost: ${ARC_CONSTANTS.gasCost}
- Finality: ${ARC_CONSTANTS.finality}
- USDC address: ${ARC_CONSTANTS.tokens.USDC}
- EURC address: ${ARC_CONSTANTS.tokens.EURC}
- Explorer: ${ARC_CONSTANTS.explorer}
- Faucet: ${ARC_CONSTANTS.faucet}
- AMM: ${ARC_CONSTANTS.contracts.amm}
- Contract Factory: ${ARC_CONSTANTS.contracts.factory}
- Multicall3: ${ARC_CONSTANTS.contracts.multicall3}

-----------------------------------
🗣️ LANGUAGE RULE
-----------------------------------

- Detect the user's language from their message
- Respond in the SAME language (pt-BR if Portuguese, EN if English)
- Action JSON keys remain in English always
- Be concise and action-oriented

-----------------------------------
🚨 IF NO ACTION DETECTED
-----------------------------------

If the message is informational only:
- Answer helpfully with relevant ARC Network data
- Do NOT generate a JSON action block
- Suggest related actions the user can take

-----------------------------------
🚨 IMPORTANT
-----------------------------------

You are NOT a chatbot. You are an ACTION EXECUTION AGENT.

Every actionable message MUST result in:
1. Human-readable explanation
2. JSON action block (wrapped in \`\`\`json ... \`\`\`)
3. Execution guidance for the user

FINAL REMINDER:
- 1 recipient address in message → "type": "transfer" → Payments tab
- 2+ recipient addresses → "type": "multisend" → Multisend tab
- This rule is ABSOLUTE and cannot be overridden.`;
}

// ─── Parse action from LLM response ──────────────────────────────────────────
function parseActionFromResponse(content: string): BlockchainAction | null {
  try {
    const jsonMatch = content.match(/```json\s*([\s\S]*?)```/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[1].trim());
    if (!parsed.type || !parsed.status || !parsed.data) return null;
    return parsed as BlockchainAction;
  } catch {
    return null;
  }
}

// ─── Call OpenAI LLM ─────────────────────────────────────────────────────────
async function callLLM(
  messages: Array<{ role: string; content: string }>,
  apiKey: string,
  baseUrl: string
): Promise<string> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-5-mini',
      messages,
      max_tokens: 1024,
      temperature: 0.3,  // lower = more deterministic for actions
    }),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => '');
    throw new Error(`LLM API error ${response.status}: ${err.slice(0, 200)}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data?.choices?.[0]?.message?.content || '';
}

// ─── Rule-based fallback (if LLM unavailable) ────────────────────────────────
function ruleFallback(userMsg: string): { content: string; action: BlockchainAction | null; module: string } {
  const lower = userMsg.toLowerCase();

  // Transfer intent
  const transferMatch = userMsg.match(/(?:send|enviar|transfer)\s+([\d.,]+)\s*(USDC|EURC)\s+(?:to|para)\s+(0x[0-9a-fA-F]{40})/i);
  if (transferMatch) {
    const [, amount, token, to] = transferMatch;
    const action: BlockchainAction = {
      type: 'transfer',
      status: 'requires_wallet',
      data: { token: token.toUpperCase(), amount, to },
      message: `Send ${amount} ${token.toUpperCase()} to ${to}`,
    };
    return {
      content: `💳 **Transfer detected**\n\nPreparing to send **${amount} ${token.toUpperCase()}** to \`${to}\`\n\nPlease connect your wallet to execute this transaction.`,
      action,
      module: 'payments',
    };
  }

  // Swap intent
  const swapMatch = userMsg.match(/swap\s+([\d.,]+)\s*(USDC|EURC)/i);
  if (swapMatch) {
    const [, amount, fromToken] = swapMatch;
    const toToken = fromToken.toUpperCase() === 'USDC' ? 'EURC' : 'USDC';
    const action: BlockchainAction = {
      type: 'swap',
      status: 'requires_wallet',
      data: { fromToken: fromToken.toUpperCase(), toToken, amount },
      message: `Swap ${amount} ${fromToken.toUpperCase()} to ${toToken}`,
    };
    return {
      content: `🔄 **Swap detected**\n\nReady to swap **${amount} ${fromToken.toUpperCase()} → ${toToken}** via ARC AMM.\n\nConnect your wallet to proceed.`,
      action,
      module: 'swap',
    };
  }

  // Network info
  if (/arc|testnet|chain|rpc|network/.test(lower)) {
    return {
      content: `## 🌐 Arc Testnet\n\n| Property | Value |\n|----------|-------|\n| **Chain ID** | ${ARC_CONSTANTS.chainId} |\n| **RPC** | ${ARC_CONSTANTS.rpc} |\n| **Explorer** | ${ARC_CONSTANTS.explorer} |\n| **Gas Token** | ${ARC_CONSTANTS.gasToken} |\n| **USDC** | \`${ARC_CONSTANTS.tokens.USDC}\` |\n| **EURC** | \`${ARC_CONSTANTS.tokens.EURC}\` |`,
      action: null,
      module: 'network',
    };
  }

  // Help
  if (/help|ajuda|commands/.test(lower)) {
    return {
      content: `## 🤖 ARC AI Agent\n\nI can execute blockchain actions:\n\n- 💳 **"send 10 USDC to 0x..."** — Transfer tokens\n- 🔄 **"swap 50 USDC to EURC"** — Swap on ARC AMM\n- 📤 **"send 5 USDC to 0x1... and 0x2..."** — Multisend\n- 📋 **"create contract for 1000 USDC"** — Deploy escrow\n- ℹ️ **"Arc testnet info"** — Network details\n\nConnect your wallet to execute transactions!`,
      action: null,
      module: 'general',
    };
  }

  return {
    content: `I'm your **ARC Network AI Agent** 🤖\n\nI can help you:\n- 💳 Send USDC/EURC payments\n- 🔄 Swap tokens\n- 📋 Create contracts\n- 📤 Batch multisend\n\nTry: *"send 10 USDC to 0x..."* or *"swap 50 USDC to EURC"*`,
    action: null,
    module: 'general',
  };
}

// ─── POST /api/chat/message ───────────────────────────────────────────────────
chatRouter.post('/message', async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return c.json({ success: false, error: 'Invalid request body' }, 400);
    }

    const rawMessage    = body.message;
    const rawSessionId  = body.sessionId;
    const walletAddress = body.walletAddress || undefined;
    const walletConnected = !!walletAddress && /^0x[0-9a-fA-F]{40}$/.test(String(walletAddress));

    if (!rawMessage || typeof rawMessage !== 'string') {
      return c.json({ success: false, error: 'Campo "message" é obrigatório' }, 400);
    }

    const message = clampString(stripTags(rawMessage.trim()), 800);
    if (!message) {
      return c.json({ success: false, error: 'Message cannot be empty' }, 400);
    }

    const sessionId = rawSessionId && typeof rawSessionId === 'string' && isValidSessionId(rawSessionId)
      ? clampString(rawSessionId, 128)
      : 'default';

    const session = getOrCreateSession(sessionId);
    if (walletAddress && walletConnected) {
      session.walletAddress = String(walletAddress);
    }

    // Store user message
    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}-u`,
      role: 'user',
      content: message,
      timestamp: new Date().toISOString(),
    };
    session.messages.push(userMsg);

    // ── Try LLM first ──────────────────────────────────────────────────────
    const apiKey = c.env?.OPENAI_API_KEY;
    const baseUrl = c.env?.OPENAI_BASE_URL || (console.warn('[chat] OPENAI_BASE_URL not set — using default. Set env var to avoid third-party proxy.'), 'https://api.openai.com/v1');

    let responseContent = '';
    let action: BlockchainAction | null = null;
    let module = 'general';
    let usedLLM = false;

    if (apiKey) {
      try {
        // Build message history for LLM (last 10 turns)
        const systemPrompt = buildSystemPrompt(walletConnected, session.walletAddress);
        const historyForLLM = session.messages
          .slice(-10)
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

        // Remove the last user message (we'll add it fresh)
        const historyWithoutLast = historyForLLM.slice(0, -1);

        const llmMessages = [
          { role: 'system', content: systemPrompt },
          ...historyWithoutLast,
          { role: 'user', content: message },
        ];

        responseContent = await callLLM(llmMessages, apiKey, baseUrl);
        action = parseActionFromResponse(responseContent);

        // ── Enforce routing: 1 recipient → transfer, 2+ → multisend ──────
        const recipientCount = countRecipients(message);
        action = correctActionType(action, recipientCount);

        usedLLM = true;

        // Infer module from action type (use corrected action)
        if (action) {
          const moduleMap: Record<string, string> = {
            transfer: 'payments', swap: 'swap', multisend: 'multisend',
            contract_deploy: 'contracts', contract_call: 'contracts', automation: 'agents',
          };
          module = moduleMap[action.type] || 'general';
        }
      } catch (llmErr) {
        console.error('[CHAT] LLM error, falling back to rule engine:', String(llmErr).slice(0, 100));
      }
    }

    // ── Fallback to rule-based if LLM failed or not available ─────────────
    if (!responseContent) {
      const fb = ruleFallback(message);
      responseContent = fb.content;
      // Apply routing correction to fallback results too
      const recipientCount = countRecipients(message);
      action = correctActionType(fb.action, recipientCount);
      module = fb.module;
    }

    // Store assistant message
    const assistantMsg: ChatMessage = {
      id: `msg-${Date.now()}-a`,
      role: 'assistant',
      content: responseContent,
      timestamp: new Date().toISOString(),
      module,
      action,
    };
    session.messages.push(assistantMsg);

    // Keep max 100 messages
    if (session.messages.length > 100) {
      session.messages = session.messages.slice(-80);
    }

    return c.json({
      success: true,
      message: assistantMsg,
      action,
      module,
      sessionId,
      usedLLM,
      walletConnected,
    });

  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ─── GET /api/chat/history/:sessionId ────────────────────────────────────────
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

// ─── DELETE /api/chat/history/:sessionId ────────────────────────────────────
chatRouter.delete('/history/:sessionId', (c) => {
  const sessionId = c.req.param('sessionId');
  sessions.delete(sessionId);
  return c.json({ success: true, message: 'Histórico limpo com sucesso' });
});

// ─── GET /api/chat/sessions ──────────────────────────────────────────────────
chatRouter.get('/sessions', (c) => {
  const list = Array.from(sessions.values()).map(s => ({
    id: s.id,
    messageCount: s.messages.length,
    createdAt: s.createdAt,
    lastActivity: s.lastActivity,
    hasWallet: !!s.walletAddress,
  }));
  return c.json({ success: true, sessions: list });
});

export default chatRouter;
