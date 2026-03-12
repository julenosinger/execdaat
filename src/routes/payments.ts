// Rotas da API para o Agente de Pagamentos

import { Hono } from 'hono';
import { PaymentAgent } from '../agents/PaymentAgent';

const paymentsRouter = new Hono();

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
      usdcAddress: '0x3600000000000000000000000000000000000000',
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

export default paymentsRouter;
