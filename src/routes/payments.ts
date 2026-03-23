// Rotas da API para o Agente de Pagamentos

import { Hono } from 'hono';
import { PaymentAgent } from '../agents/PaymentAgent';
import {
  clampString,
  isValidEthAddress,
  isValidTxHash,
  isValidAmount,
  sanitizeForLog,
  stripTags,
} from '../middleware/security';

const paymentsRouter = new Hono();

// ─── In-memory receipt store (production: use Cloudflare KV / D1) ─────────────
interface OnChainReceipt {
  txHash: string;
  approveTxHash: string | null;
  sender: string;
  recipient: string;
  amount: number;
  token: string;
  description: string;
  gasFee: string;
  gasUsed: string;
  network: string;
  chainId: number;
  timestamp: string;
  durationMs: number;
  explorerUrl: string;
}

const onChainReceipts: OnChainReceipt[] = [];

// Singleton do agente (em produção, persistir estado em KV)
let paymentAgent: PaymentAgent | null = null;

function getAgent(contractAddress = '0x0000000000000000000000000000000000000001'): PaymentAgent {
  if (!paymentAgent) {
    paymentAgent = new PaymentAgent(contractAddress);
  }
  return paymentAgent;
}

// GET /api/payments/agent - Status do agente
paymentsRouter.get('/agent', (c) => {
  const agent = getAgent();
  return c.json({
    success: true,
    agent: agent.getState(),
    stats: agent.getStats(),
    network: {
      name: 'Arc Testnet',
      chainId: 5042002,
      rpcUrl: 'https://rpc.testnet.arc.network',
      rpcAlternatives: [
        'https://rpc.blockdaemon.testnet.arc.network',
        'https://rpc.drpc.testnet.arc.network',
        'https://rpc.quicknode.testnet.arc.network',
      ],
      rpcWebSocket: 'wss://rpc.testnet.arc.network',
      usdcAddress: '0x3600000000000000000000000000000000000000',
      eurcAddress: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
      explorerUrl: 'https://testnet.arcscan.app',
    },
  });
});

// GET /api/payments/queue - Fila de tarefas
paymentsRouter.get('/queue', (c) => {
  const agent = getAgent();
  return c.json({
    success: true,
    pending: agent.getTaskQueue(),
    processed: agent.getProcessedTasks(),
  });
});

// POST /api/payments/submit - Submeter novo pagamento
paymentsRouter.post('/submit', async (c) => {
  try {
    const body = await c.req.json();
    const { from, to, amount, description, priority = 'medium' } = body;

    if (!from || !to || !amount || !description) {
      return c.json({ success: false, error: 'Campos obrigatórios: from, to, amount, description' }, 400);
    }

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return c.json({ success: false, error: 'Valor deve ser um número positivo' }, 400);
    }

    const agent = getAgent();
    const taskId = await agent.submitPaymentTask({
      type: 'execute',
      from,
      to,
      amount: Math.round(amountNum * 1e6), // Converter para 6 decimais
      description,
      priority,
    });

    return c.json({
      success: true,
      taskId,
      message: `Pagamento de $${amountNum.toFixed(2)} USDC submetido para análise do agente`,
      network: 'Arc Testnet (Chain ID: 5042002)',
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// POST /api/payments/analyze - Analisar pagamento sem executar
paymentsRouter.post('/analyze', async (c) => {
  try {
    const body = await c.req.json();
    const { from, to, amount, description, priority = 'medium' } = body;

    if (!from || !to || !amount) {
      return c.json({ success: false, error: 'Campos obrigatórios: from, to, amount' }, 400);
    }

    const amountNum = parseFloat(amount) * 1e6;
    const agent = getAgent();

    const mockTask = {
      id: 'analysis-preview',
      type: 'analyze' as const,
      from,
      to,
      amount: amountNum,
      description: description || 'Sem descrição',
      priority,
      status: 'pending' as const,
      createdAt: Date.now(),
    };

    const decision = await agent.analyzePayment(mockTask);

    return c.json({
      success: true,
      decision,
      payment: {
        from,
        to,
        amount: parseFloat(amount),
        amountFormatted: `$${parseFloat(amount).toFixed(2)} USDC`,
        description,
      },
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// POST /api/payments/process - Processar fila de pagamentos pendentes
paymentsRouter.post('/process', async (c) => {
  try {
    const agent = getAgent();
    const result = await agent.processPendingTasks();

    return c.json({
      success: true,
      result,
      stats: agent.getStats(),
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// GET /api/payments/report - Relatório do agente
paymentsRouter.get('/report', (c) => {
  const agent = getAgent();
  return c.json({
    success: true,
    report: agent.generateReport(),
    stats: agent.getStats(),
  });
});

// POST /api/payments/batch - Pagamentos em lote (upload Excel)
paymentsRouter.post('/batch', async (c) => {
  try {
    const body = await c.req.json();
    const { payments, fileName = 'batch' } = body;

    if (!Array.isArray(payments) || payments.length === 0) {
      return c.json({ success: false, error: 'payments array is required and must not be empty' }, 400);
    }
    if (payments.length > 500) {
      return c.json({ success: false, error: 'Maximum 500 payments per batch' }, 400);
    }

    const agent = getAgent();
    const batchId = `batch-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    const taskIds: string[] = [];
    const errors: string[] = [];
    let totalAmount = 0;

    for (const [i, p] of payments.entries()) {
      try {
        const { from, to, amount, description, priority = 'medium' } = p;
        if (!from || !to || !amount) {
          errors.push(`Row ${i + 1}: missing from/to/amount`);
          continue;
        }
        const amountNum = parseFloat(amount);
        if (isNaN(amountNum) || amountNum <= 0) {
          errors.push(`Row ${i + 1}: invalid amount "${amount}"`);
          continue;
        }
        const taskId = await agent.submitPaymentTask({
          type: 'execute',
          from: String(from),
          to: String(to),
          amount: Math.round(amountNum * 1e6),
          description: description || `Batch payment ${i + 1} from ${fileName}`,
          priority: ['low','medium','high','critical'].includes(priority) ? priority : 'medium',
        });
        taskIds.push(taskId);
        totalAmount += amountNum;
      } catch (rowErr) {
        errors.push(`Row ${i + 1}: ${String(rowErr)}`);
      }
    }

    return c.json({
      success: true,
      batchId,
      submitted: taskIds.length,
      skipped: errors.length,
      totalAmount,
      taskIds,
      errors,
      message: `Batch "${fileName}": ${taskIds.length} payments queued, ${errors.length} skipped`,
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// POST /api/payments/demo - Criar pagamentos de demonstração
paymentsRouter.post('/demo', async (c) => {
  const agent = getAgent();
  
  const demoPayments = [
    {
      from: '0xB815A0c4bC23930119324d4359dB65e27A846A2d',
      to: '0x411c60F8e61B5Cbe32F9a873b16D21CA85e9A634',
      amount: 5 * 1e6,
      description: 'Pagamento de serviços de consultoria - Janeiro 2026',
      priority: 'medium' as const,
      type: 'execute' as const,
    },
    {
      from: '0xC927B1d3fE6e12B1b72E3E5F3e3c5A7B9d4F2E1A',
      to: '0xD412E8b7cF5a3B9e1F2D5c8A7b3E6f9d2c5A8B1',
      amount: 2.5 * 1e6,
      description: 'Reembolso de despesas de viagem',
      priority: 'low' as const,
      type: 'execute' as const,
    },
    {
      from: '0xE523F9c8dG6b4C0f2G3E6d9B8c4D7g0e3D6C9E2B',
      to: '0xF634G0d9eH7c5D1g3H4F7e0C9d5E8h1f4E7D0F3C',
      amount: 150 * 1e6,
      description: 'Pagamento de fornecedor - Licença de software anual',
      priority: 'high' as const,
      type: 'execute' as const,
    },
  ];

  const taskIds = [];
  for (const payment of demoPayments) {
    const taskId = await agent.submitPaymentTask(payment);
    taskIds.push(taskId);
  }

  return c.json({
    success: true,
    message: '3 pagamentos de demonstração criados',
    taskIds,
    note: 'Use POST /api/payments/process para executar a análise dos agentes',
  });
});

// POST /api/payments/record — Save on-chain receipt from frontend
paymentsRouter.post('/record', async (c) => {
  try {
    const body = await c.req.json().catch(() => null) as Partial<OnChainReceipt> | null;
    if (!body || typeof body !== 'object') {
      return c.json({ success: false, error: 'Invalid request body' }, 400);
    }
    const { txHash, sender, recipient, amount, token, timestamp } = body;

    // ── Strict validation ──────────────────────────────────────────────────
    if (!txHash || !isValidTxHash(String(txHash))) {
      return c.json({ success: false, error: 'Invalid or missing txHash' }, 400);
    }
    if (!sender || !isValidEthAddress(String(sender))) {
      return c.json({ success: false, error: 'Invalid or missing sender address' }, 400);
    }
    if (!recipient || !isValidEthAddress(String(recipient))) {
      return c.json({ success: false, error: 'Invalid or missing recipient address' }, 400);
    }
    if (amount === undefined || isNaN(Number(amount)) || Number(amount) <= 0) {
      return c.json({ success: false, error: 'Invalid amount' }, 400);
    }

    const allowedTokens = ['USDC', 'EURC'];
    if (!token || !allowedTokens.includes(String(token).toUpperCase())) {
      return c.json({ success: false, error: 'Invalid token — must be USDC or EURC' }, 400);
    }

    const receipt: OnChainReceipt = {
      txHash:         String(txHash).toLowerCase(),
      approveTxHash:  body.approveTxHash && isValidTxHash(String(body.approveTxHash)) ? String(body.approveTxHash) : null,
      sender:         String(sender).toLowerCase(),
      recipient:      String(recipient).toLowerCase(),
      amount:         Number(amount),
      token:          String(token).toUpperCase(),
      description:    clampString(stripTags(String(body.description || '')), 300),
      gasFee:         clampString(String(body.gasFee || '0'), 30),
      gasUsed:        clampString(String(body.gasUsed || '0'), 20),
      network:        'Arc Testnet',     // force — never trust client for network
      chainId:        5042002,           // force — never trust client for chainId
      timestamp:      timestamp && !isNaN(Date.parse(String(timestamp)))
                        ? String(timestamp)
                        : new Date().toISOString(),
      durationMs:     Math.min(Number(body.durationMs) || 0, 60000),
      explorerUrl:    `https://testnet.arcscan.app/tx/${txHash}`,  // build from txHash, not from client
    };

    // Avoid duplicate txHash
    const exists = onChainReceipts.some(r => r.txHash === receipt.txHash);
    if (!exists) {
      onChainReceipts.unshift(receipt);
      if (onChainReceipts.length > 200) onChainReceipts.splice(200);
    }

    return c.json({ success: true, receipt });
  } catch (err) {
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

// GET /api/payments/receipts — List on-chain receipts
paymentsRouter.get('/receipts', (c) => {
  const limit = Math.min(Number(c.req.query('limit') || '50'), 200);
  return c.json({
    success: true,
    total: onChainReceipts.length,
    receipts: onChainReceipts.slice(0, limit),
    network: {
      name: 'Arc Testnet',
      chainId: 5042002,
      explorerUrl: 'https://testnet.arcscan.app',
      usdcAddress: '0x3600000000000000000000000000000000000000',
      eurcAddress: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
    },
  });
});

// GET /api/payments/receipts/:txHash — Get specific receipt
paymentsRouter.get('/receipts/:txHash', (c) => {
  const txHash = c.req.param('txHash');
  const receipt = onChainReceipts.find(r => r.txHash.toLowerCase() === txHash.toLowerCase());
  if (!receipt) {
    return c.json({ success: false, error: 'Receipt not found' }, 404);
  }
  return c.json({ success: true, receipt });
});

// GET /api/payments/network — Network info for frontend
paymentsRouter.get('/network', (c) => {
  return c.json({
    success: true,
    network: {
      name: 'Arc Testnet',
      chainId: 5042002,
      chainHex: '0x4cef52',
      rpcUrl: 'https://rpc.testnet.arc.network',
      rpcAlternatives: [
        'https://rpc.blockdaemon.testnet.arc.network',
        'https://rpc.drpc.testnet.arc.network',
        'https://rpc.quicknode.testnet.arc.network',
      ],
      explorerUrl: 'https://testnet.arcscan.app',
      nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
      tokens: {
        USDC: { address: '0x3600000000000000000000000000000000000000', decimals: 6, type: 'native' },
        EURC: { address: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a', decimals: 6, type: 'erc20' },
      },
    },
  });
});

export default paymentsRouter;
