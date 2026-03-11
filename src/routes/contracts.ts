// Rotas da API para o Agente de Contratos

import { Hono } from 'hono';
import { ContractAgent } from '../agents/ContractAgent';
import type { ContractData } from '../agents/ContractAgent';

const contractsRouter = new Hono();

let contractAgent: ContractAgent | null = null;
let contractIdCounter = 1;

function getAgent(contractAddress = '0x0000000000000000000000000000000000000002'): ContractAgent {
  if (!contractAgent) {
    contractAgent = new ContractAgent(contractAddress);
    // Adicionar contratos de demonstração
    seedDemoContracts(contractAgent);
  }
  return contractAgent;
}

function seedDemoContracts(agent: ContractAgent) {
  const demos: ContractData[] = [
    {
      id: contractIdCounter++,
      client: '0xB815A0c4bC23930119324d4359dB65e27A846A2d',
      contractor: '0x411c60F8e61B5Cbe32F9a873b16D21CA85e9A634',
      title: 'Desenvolvimento de Smart Contract DeFi',
      description: 'Desenvolvimento e auditoria de contratos inteligentes para protocolo DeFi na rede Arc. Inclui testes unitários, integração e documentação completa.',
      totalValue: 5000 * 1e6,
      status: 'Active',
      clientSigned: true,
      contractorSigned: true,
      createdAt: Date.now() - 7 * 24 * 60 * 60 * 1000,
      startedAt: Date.now() - 5 * 24 * 60 * 60 * 1000,
      milestones: [
        { id: 1, description: 'Especificação técnica e arquitetura', amount: 500 * 1e6, status: 'Completed', completedAt: Date.now() - 3 * 24 * 60 * 60 * 1000, agentVerification: 'Documento de spec entregue e aprovado' },
        { id: 2, description: 'Implementação dos contratos core', amount: 2000 * 1e6, status: 'InProgress' },
        { id: 3, description: 'Testes e auditoria de segurança', amount: 1500 * 1e6, status: 'Pending' },
        { id: 4, description: 'Deploy e documentação final', amount: 1000 * 1e6, status: 'Pending' },
      ],
      agentAnalysis: 'Contrato validado. Partes identificadas. Escrow de $5,000 USDC depositado.',
    },
    {
      id: contractIdCounter++,
      client: '0xC927B1d3fE6e12B1b72E3E5F3e3c5A7B9d4F2E1A',
      contractor: '0xD412E8b7cF5a3B9e1F2D5c8A7b3E6f9d2c5A8B1',
      title: 'Consultoria em Tokenização de Ativos RWA',
      description: 'Consultoria especializada em tokenização de ativos do mundo real (Real World Assets) na rede Arc, incluindo estrutura legal, técnica e regulatória.',
      totalValue: 12000 * 1e6,
      status: 'Draft',
      clientSigned: true,
      contractorSigned: false,
      createdAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
      milestones: [
        { id: 1, description: 'Análise de viabilidade e estrutura', amount: 3000 * 1e6, status: 'Pending' },
        { id: 2, description: 'Desenho da solução técnica', amount: 4000 * 1e6, status: 'Pending' },
        { id: 3, description: 'Implementação e testes', amount: 5000 * 1e6, status: 'Pending' },
      ],
    },
    {
      id: contractIdCounter++,
      client: '0xE523F9c8dG6b4C0f2G3E6d9B8c4D7g0e3D6C9E2B',
      contractor: '0xF634G0d9eH7c5D1g3H4F7e0C9d5E8h1f4E7D0F3C',
      title: 'Integração de Pagamentos USDC - E-commerce',
      description: 'Integração completa de pagamentos em USDC na rede Arc para plataforma de e-commerce. Inclui SDK, webhook e painel de controle.',
      totalValue: 3500 * 1e6,
      status: 'Completed',
      clientSigned: true,
      contractorSigned: true,
      createdAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
      startedAt: Date.now() - 28 * 24 * 60 * 60 * 1000,
      completedAt: Date.now() - 5 * 24 * 60 * 60 * 1000,
      milestones: [
        { id: 1, description: 'SDK de integração', amount: 1000 * 1e6, status: 'Completed', completedAt: Date.now() - 20 * 24 * 60 * 60 * 1000 },
        { id: 2, description: 'Sistema de webhooks', amount: 1000 * 1e6, status: 'Completed', completedAt: Date.now() - 12 * 24 * 60 * 60 * 1000 },
        { id: 3, description: 'Painel de controle e relatórios', amount: 1500 * 1e6, status: 'Completed', completedAt: Date.now() - 5 * 24 * 60 * 60 * 1000 },
      ],
      agentAnalysis: 'Contrato concluído com sucesso. Todos os marcos verificados e pagamentos liberados.',
    },
  ];

  demos.forEach(contract => agent.registerContract(contract));
}

// GET /api/contracts/agent - Status do agente de contratos
contractsRouter.get('/agent', (c) => {
  const agent = getAgent();
  return c.json({
    success: true,
    agent: agent.getState(),
    stats: agent.getStats(),
  });
});

// GET /api/contracts - Listar todos os contratos
contractsRouter.get('/', (c) => {
  const agent = getAgent();
  const contracts = agent.getContracts();
  return c.json({
    success: true,
    contracts: contracts.map(contract => ({
      ...contract,
      totalValueFormatted: `$${(contract.totalValue / 1e6).toFixed(2)} USDC`,
      milestonesProgress: `${contract.milestones.filter(m => m.status === 'Completed').length}/${contract.milestones.length}`,
    })),
    total: contracts.length,
  });
});

// GET /api/contracts/:id - Detalhes de um contrato
contractsRouter.get('/:id', (c) => {
  const agent = getAgent();
  const id = parseInt(c.req.param('id'));
  const contracts = agent.getContracts();
  const contract = contracts.find(c => c.id === id);

  if (!contract) {
    return c.json({ success: false, error: 'Contrato não encontrado' }, 404);
  }

  return c.json({
    success: true,
    contract: {
      ...contract,
      totalValueFormatted: `$${(contract.totalValue / 1e6).toFixed(2)} USDC`,
      milestonesProgress: `${contract.milestones.filter(m => m.status === 'Completed').length}/${contract.milestones.length}`,
    },
  });
});

// POST /api/contracts/create - Criar novo contrato
contractsRouter.post('/create', async (c) => {
  try {
    const body = await c.req.json();
    const { client, contractor, title, description, totalValue, milestones = [] } = body;

    if (!client || !contractor || !title || !description || !totalValue) {
      return c.json({ success: false, error: 'Campos obrigatórios: client, contractor, title, description, totalValue' }, 400);
    }

    const agent = getAgent();
    const contractId = contractIdCounter++;

    const newContract: ContractData = {
      id: contractId,
      client,
      contractor,
      title,
      description,
      totalValue: Math.round(parseFloat(totalValue) * 1e6),
      status: 'Draft',
      clientSigned: false,
      contractorSigned: false,
      createdAt: Date.now(),
      milestones: milestones.map((m: { description: string; amount: string | number }, i: number) => ({
        id: i + 1,
        description: m.description,
        amount: Math.round(parseFloat(String(m.amount)) * 1e6),
        status: 'Pending' as const,
      })),
    };

    agent.registerContract(newContract);

    return c.json({
      success: true,
      contractId,
      contract: newContract,
      message: `Contrato #${contractId} criado. Aguardando assinaturas de ambas as partes.`,
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// POST /api/contracts/:id/sign - Assinar contrato
contractsRouter.post('/:id/sign', async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    const body = await c.req.json();
    const { signer, role } = body; // role: 'client' | 'contractor'

    const agent = getAgent();
    const contracts = agent.getContracts();
    const contract = contracts.find(c => c.id === id);

    if (!contract) {
      return c.json({ success: false, error: 'Contrato não encontrado' }, 404);
    }

    if (role === 'client') {
      contract.clientSigned = true;
    } else if (role === 'contractor') {
      contract.contractorSigned = true;
    } else {
      return c.json({ success: false, error: 'Role deve ser "client" ou "contractor"' }, 400);
    }

    return c.json({
      success: true,
      message: `Contrato assinado por ${role}`,
      bothSigned: contract.clientSigned && contract.contractorSigned,
      readyForActivation: contract.clientSigned && contract.contractorSigned,
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// POST /api/contracts/:id/analyze - Análise do agente de IA
contractsRouter.post('/:id/analyze', async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    const agent = getAgent();
    const contracts = agent.getContracts();
    const contract = contracts.find(ct => ct.id === id);

    if (!contract) {
      return c.json({ success: false, error: 'Contrato não encontrado' }, 404);
    }

    const decision = await agent.analyzeContract(contract);

    return c.json({
      success: true,
      decision,
      contract: {
        id: contract.id,
        title: contract.title,
        totalValue: `$${(contract.totalValue / 1e6).toFixed(2)} USDC`,
        status: contract.status,
      },
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// POST /api/contracts/:id/activate - Ativar contrato (agente de IA)
contractsRouter.post('/:id/activate', async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    const agent = getAgent();
    const contracts = agent.getContracts();
    const contract = contracts.find(ct => ct.id === id);

    if (!contract) {
      return c.json({ success: false, error: 'Contrato não encontrado' }, 404);
    }

    const taskId = await agent.submitContractTask({
      type: 'activate',
      contractId: id,
    });

    const result = await agent.processTaskQueue();

    const updatedContract = contracts.find(ct => ct.id === id);

    return c.json({
      success: true,
      taskId,
      result,
      contract: updatedContract,
      message: updatedContract?.status === 'Active'
        ? `Contrato #${id} ativado com sucesso! Escrow de $${(contract.totalValue / 1e6).toFixed(2)} USDC depositado.`
        : 'Ativação pendente - verifique os requisitos',
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// POST /api/contracts/:id/milestone/:milestoneId/complete - Completar milestone
contractsRouter.post('/:id/milestone/:milestoneId/complete', async (c) => {
  try {
    const contractId = parseInt(c.req.param('id'));
    const milestoneId = parseInt(c.req.param('milestoneId'));
    const body = await c.req.json();
    const { evidence } = body;

    if (!evidence) {
      return c.json({ success: false, error: 'Evidência de conclusão é obrigatória' }, 400);
    }

    const agent = getAgent();
    const contracts = agent.getContracts();
    const contract = contracts.find(ct => ct.id === contractId);

    if (!contract) {
      return c.json({ success: false, error: 'Contrato não encontrado' }, 404);
    }

    const taskId = await agent.submitContractTask({
      type: 'verify_milestone',
      contractId,
      data: { milestoneId, evidence },
    });

    const result = await agent.processTaskQueue();
    const updatedContract = contracts.find(ct => ct.id === contractId);
    const milestone = updatedContract?.milestones.find(m => m.id === milestoneId);

    return c.json({
      success: true,
      taskId,
      result,
      milestone,
      message: milestone?.status === 'Completed'
        ? `Milestone #${milestoneId} verificado e aprovado! Pagamento de $${(milestone.amount / 1e6).toFixed(2)} USDC liberado.`
        : 'Verificação pendente - evidência insuficiente',
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// POST /api/contracts/:id/dispute - Reportar disputa
contractsRouter.post('/:id/dispute', async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    const body = await c.req.json();
    const { reason } = body;

    if (!reason) {
      return c.json({ success: false, error: 'Motivo da disputa é obrigatório' }, 400);
    }

    const agent = getAgent();
    const contracts = agent.getContracts();
    const contract = contracts.find(ct => ct.id === id);

    if (!contract) {
      return c.json({ success: false, error: 'Contrato não encontrado' }, 404);
    }

    contract.status = 'Disputed';

    const taskId = await agent.submitContractTask({
      type: 'resolve_dispute',
      contractId: id,
      data: { reason },
    });

    const result = await agent.processTaskQueue();

    return c.json({
      success: true,
      taskId,
      result,
      message: `Disputa registrada e enviada para arbitragem do agente de IA`,
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// GET /api/contracts/stats/summary - Resumo estatístico
contractsRouter.get('/stats/summary', (c) => {
  const agent = getAgent();
  return c.json({
    success: true,
    stats: agent.getStats(),
    report: agent.generateReport(),
  });
});

export default contractsRouter;
