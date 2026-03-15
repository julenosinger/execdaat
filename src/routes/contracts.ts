// Rotas da API para o Agente de Contratos
// Inclui: Receipt struct, ContractReceiptIssued event, Escrow deposit tracking

import { Hono } from 'hono';
import { ContractAgent } from '../agents/ContractAgent';
import type { ContractData } from '../agents/ContractAgent';

const contractsRouter = new Hono();

// ─── Receipt Struct (mirrors Solidity Receipt struct) ─────────────────────────
interface ContractReceipt {
  id: number;                  // receiptCount (auto-increment)
  contractId: number;
  client: string;
  contractor: string;
  amount: number;              // in micro-USDC (6 decimals)
  contractTitle: string;
  timestamp: number;           // Unix ms
  txHash: string;              // on-chain tx hash (real or simulated)
  blockNumber: number | null;
  escrowAddress: string;       // escrow/custodian address
  eventName: 'ContractReceiptIssued' | 'EscrowDepositIssued';
  network: string;
  chainId: number;
  explorerUrl: string;
  type: 'creation' | 'escrow_deposit';
}

// ─── In-memory receipt store (mirrors on-chain mapping(uint256 => Receipt)) ───
const contractReceipts: ContractReceipt[] = [];
let receiptCount = 0; // mirrors uint256 public receiptCount

// ─── Escrow contract address (ARC Testnet — deploy real contract here) ────────
const ESCROW_ADDRESS = '0x867650F5eAe8df91445971f14d89fd84F0C9a9f8';
const USDC_ADDRESS   = '0x3600000000000000000000000000000000000000';
const NETWORK_NAME   = 'Arc Testnet';
const CHAIN_ID       = 5042002;
const EXPLORER_URL   = 'https://testnet.arcscan.app';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateTxHash(): string {
  const bytes = Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
  );
  return '0x' + bytes.join('');
}

function issueReceipt(
  contractId: number,
  client: string,
  contractor: string,
  amount: number,
  contractTitle: string,
  txHash: string,
  type: 'creation' | 'escrow_deposit',
  blockNumber: number | null = null
): ContractReceipt {
  receiptCount++;
  const receipt: ContractReceipt = {
    id: receiptCount,
    contractId,
    client,
    contractor,
    amount,
    contractTitle,
    timestamp: Date.now(),
    txHash,
    blockNumber,
    escrowAddress: ESCROW_ADDRESS,
    eventName: type === 'creation' ? 'ContractReceiptIssued' : 'EscrowDepositIssued',
    network: NETWORK_NAME,
    chainId: CHAIN_ID,
    explorerUrl: `${EXPLORER_URL}/tx/${txHash}`,
    type,
  };
  contractReceipts.unshift(receipt);
  return receipt;
}

// ─── Agent Singleton ──────────────────────────────────────────────────────────
let contractAgent: ContractAgent | null = null;
let contractIdCounter = 1;

function getAgent(contractAddress = '0x0000000000000000000000000000000000000002'): ContractAgent {
  if (!contractAgent) {
    contractAgent = new ContractAgent(contractAddress);
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
      client: '0xE523F9c8dA6b4C0f2A3E6d9B8c4D7A0e3D6C9E2B',
      contractor: '0xF634A0d9eB7c5D1a3B4F7e0C9d5E8b1f4E7D0F3C',
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

  // Seed demo receipts for existing contracts
  demos.forEach(contract => {
    agent.registerContract(contract);
    // Issue creation receipt for active/completed demo contracts
    if (contract.status === 'Active' || contract.status === 'Completed') {
      const txHash = generateTxHash();
      issueReceipt(
        contract.id,
        contract.client,
        contract.contractor,
        contract.totalValue,
        contract.title,
        txHash,
        'creation',
        Math.floor(Math.random() * 1000000) + 5000000
      );
      // Also issue escrow deposit receipt
      const escrowTx = generateTxHash();
      issueReceipt(
        contract.id,
        contract.client,
        contract.contractor,
        contract.totalValue,
        contract.title,
        escrowTx,
        'escrow_deposit',
        Math.floor(Math.random() * 1000000) + 5000000
      );
    }
  });
}

// ─── GET /api/contracts/agent ─────────────────────────────────────────────────
contractsRouter.get('/agent', (c) => {
  const agent = getAgent();
  return c.json({
    success: true,
    agent: agent.getState(),
    stats: agent.getStats(),
    escrowAddress: ESCROW_ADDRESS,
    usdcAddress: USDC_ADDRESS,
    network: { name: NETWORK_NAME, chainId: CHAIN_ID, explorerUrl: EXPLORER_URL },
  });
});

// ─── GET /api/contracts ───────────────────────────────────────────────────────
contractsRouter.get('/', (c) => {
  const agent = getAgent();
  const contracts = agent.getContracts();
  return c.json({
    success: true,
    contracts: contracts.map(contract => ({
      ...contract,
      totalValueFormatted: `$${(contract.totalValue / 1e6).toFixed(2)} USDC`,
      milestonesProgress: `${contract.milestones.filter(m => m.status === 'Completed').length}/${contract.milestones.length}`,
      // Attach latest receipt for this contract
      receipt: contractReceipts.find(r => r.contractId === contract.id && r.type === 'creation') || null,
      escrowReceipt: contractReceipts.find(r => r.contractId === contract.id && r.type === 'escrow_deposit') || null,
    })),
    total: contracts.length,
  });
});

// ─── GET /api/contracts/:id ───────────────────────────────────────────────────
contractsRouter.get('/:id', (c) => {
  const agent = getAgent();
  const id = parseInt(c.req.param('id'));
  const contracts = agent.getContracts();
  const contract = contracts.find(ct => ct.id === id);

  if (!contract) {
    return c.json({ success: false, error: 'Contrato não encontrado' }, 404);
  }

  return c.json({
    success: true,
    contract: {
      ...contract,
      totalValueFormatted: `$${(contract.totalValue / 1e6).toFixed(2)} USDC`,
      milestonesProgress: `${contract.milestones.filter(m => m.status === 'Completed').length}/${contract.milestones.length}`,
      receipt: contractReceipts.find(r => r.contractId === contract.id && r.type === 'creation') || null,
      escrowReceipt: contractReceipts.find(r => r.contractId === contract.id && r.type === 'escrow_deposit') || null,
    },
  });
});

// ─── POST /api/contracts/create ───────────────────────────────────────────────
// When "Create Contract" is executed:
//   1. Validates input
//   2. Creates contract in agent store
//   3. Increments receiptCount (mirrors Solidity)
//   4. Stores receipt (mirrors mapping(uint256 => Receipt))
//   5. Returns receipt with event data (mirrors emit ContractReceiptIssued)
contractsRouter.post('/create', async (c) => {
  try {
    const body = await c.req.json();
    const { client, contractor, title, description, totalValue, milestones = [], txHash, blockNumber } = body;

    if (!client || !contractor || !title || !description || !totalValue) {
      return c.json({ success: false, error: 'Campos obrigatórios: client, contractor, title, description, totalValue' }, 400);
    }

    const agent = getAgent();
    const contractId = contractIdCounter++;
    const amountRaw = Math.round(parseFloat(totalValue) * 1e6);

    const newContract: ContractData = {
      id: contractId,
      client,
      contractor,
      title,
      description,
      totalValue: amountRaw,
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

    // ── Issue ContractReceiptIssued (mirrors Solidity emit) ────────────────────
    const resolvedTxHash = txHash || generateTxHash();
    const receipt = issueReceipt(
      contractId,
      client,
      contractor,
      amountRaw,
      title,
      resolvedTxHash,
      'creation',
      blockNumber || null
    );

    return c.json({
      success: true,
      contractId,
      contract: newContract,
      receipt,
      // Mirror Solidity event fields
      event: {
        name: 'ContractReceiptIssued',
        receiptId: receipt.id,
        client,
        contractor,
        amount: amountRaw,
        amountFormatted: `$${(amountRaw / 1e6).toFixed(2)} USDC`,
        contractTitle: title,
        timestamp: receipt.timestamp,
        txHash: resolvedTxHash,
        explorerUrl: receipt.explorerUrl,
        escrowAddress: ESCROW_ADDRESS,
        network: NETWORK_NAME,
        chainId: CHAIN_ID,
      },
      message: `Contrato #${contractId} criado. Receipt #${receipt.id} emitido na Arc Testnet.`,
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ─── POST /api/contracts/:id/escrow-deposit ───────────────────────────────────
// Called after on-chain USDC transfer to escrow:
//   mirrors: transfer USDC to escrow + emit EscrowDepositIssued
contractsRouter.post('/:id/escrow-deposit', async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    const body = await c.req.json();
    const { txHash, blockNumber, depositor } = body;

    const agent = getAgent();
    const contracts = agent.getContracts();
    const contract = contracts.find(ct => ct.id === id);

    if (!contract) {
      return c.json({ success: false, error: 'Contrato não encontrado' }, 404);
    }

    if (!txHash) {
      return c.json({ success: false, error: 'txHash é obrigatório para registrar depósito em escrow' }, 400);
    }

    const receipt = issueReceipt(
      id,
      depositor || contract.client,
      contract.contractor,
      contract.totalValue,
      contract.title,
      txHash,
      'escrow_deposit',
      blockNumber || null
    );

    // Update contract status to Active after escrow deposit
    contract.clientSigned = true;
    contract.contractorSigned = true;
    if (contract.status === 'Draft') {
      contract.status = 'Active';
      contract.startedAt = Date.now();
    }

    return c.json({
      success: true,
      receipt,
      contract: {
        ...contract,
        totalValueFormatted: `$${(contract.totalValue / 1e6).toFixed(2)} USDC`,
      },
      event: {
        name: 'EscrowDepositIssued',
        receiptId: receipt.id,
        contractId: id,
        depositor: depositor || contract.client,
        amount: contract.totalValue,
        amountFormatted: `$${(contract.totalValue / 1e6).toFixed(2)} USDC`,
        txHash,
        explorerUrl: receipt.explorerUrl,
        escrowAddress: ESCROW_ADDRESS,
        timestamp: receipt.timestamp,
        network: NETWORK_NAME,
        chainId: CHAIN_ID,
      },
      message: `Escrow de $${(contract.totalValue / 1e6).toFixed(2)} USDC depositado. Receipt #${receipt.id} emitido.`,
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ─── GET /api/contracts/receipts/all ──────────────────────────────────────────
contractsRouter.get('/receipts/all', (c) => {
  const limit = Math.min(Number(c.req.query('limit') || '50'), 200);
  return c.json({
    success: true,
    receiptCount,
    total: contractReceipts.length,
    receipts: contractReceipts.slice(0, limit),
    escrowAddress: ESCROW_ADDRESS,
    network: { name: NETWORK_NAME, chainId: CHAIN_ID, explorerUrl: EXPLORER_URL },
  });
});

// ─── GET /api/contracts/receipts/:contractId ──────────────────────────────────
contractsRouter.get('/receipts/:contractId', (c) => {
  const contractId = parseInt(c.req.param('contractId'));
  const receipts = contractReceipts.filter(r => r.contractId === contractId);
  return c.json({
    success: true,
    contractId,
    receipts,
    total: receipts.length,
  });
});

// ─── POST /api/contracts/:id/sign ─────────────────────────────────────────────
contractsRouter.post('/:id/sign', async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    const body = await c.req.json();
    const { signer, role } = body;

    const agent = getAgent();
    const contracts = agent.getContracts();
    const contract = contracts.find(ct => ct.id === id);

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

// ─── POST /api/contracts/:id/analyze ──────────────────────────────────────────
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

// ─── POST /api/contracts/:id/activate ─────────────────────────────────────────
contractsRouter.post('/:id/activate', async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    const body = await c.req.json().catch(() => ({}));
    const { txHash, blockNumber } = body as { txHash?: string; blockNumber?: number };

    const agent = getAgent();
    const contracts = agent.getContracts();
    const contract = contracts.find(ct => ct.id === id);

    if (!contract) {
      return c.json({ success: false, error: 'Contrato não encontrado' }, 404);
    }

    const taskId = await agent.submitContractTask({ type: 'activate', contractId: id });
    const result = await agent.processTaskQueue();
    const updatedContract = contracts.find(ct => ct.id === id);

    // Issue escrow receipt on activation
    let escrowReceipt: ContractReceipt | null = null;
    if (updatedContract?.status === 'Active') {
      const resolvedTxHash = txHash || generateTxHash();
      escrowReceipt = issueReceipt(
        id,
        contract.client,
        contract.contractor,
        contract.totalValue,
        contract.title,
        resolvedTxHash,
        'escrow_deposit',
        blockNumber || null
      );
    }

    return c.json({
      success: true,
      taskId,
      result,
      contract: updatedContract,
      escrowReceipt,
      event: escrowReceipt ? {
        name: 'EscrowDepositIssued',
        receiptId: escrowReceipt.id,
        contractId: id,
        amount: contract.totalValue,
        amountFormatted: `$${(contract.totalValue / 1e6).toFixed(2)} USDC`,
        txHash: escrowReceipt.txHash,
        explorerUrl: escrowReceipt.explorerUrl,
        escrowAddress: ESCROW_ADDRESS,
        timestamp: escrowReceipt.timestamp,
      } : null,
      message: updatedContract?.status === 'Active'
        ? `Contrato #${id} ativado! Escrow de $${(contract.totalValue / 1e6).toFixed(2)} USDC depositado. Receipt #${escrowReceipt?.id} emitido.`
        : 'Ativação pendente — verifique os requisitos',
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ─── POST /api/contracts/:id/milestone/:milestoneId/complete ──────────────────
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
        : 'Verificação pendente — evidência insuficiente',
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ─── POST /api/contracts/:id/dispute ──────────────────────────────────────────
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
    const taskId = await agent.submitContractTask({ type: 'resolve_dispute', contractId: id, data: { reason } });
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

// ─── GET /api/contracts/stats/summary ─────────────────────────────────────────
contractsRouter.get('/stats/summary', (c) => {
  const agent = getAgent();
  return c.json({
    success: true,
    stats: agent.getStats(),
    report: agent.generateReport(),
    receiptStats: {
      totalReceipts: receiptCount,
      creationReceipts: contractReceipts.filter(r => r.type === 'creation').length,
      escrowReceipts: contractReceipts.filter(r => r.type === 'escrow_deposit').length,
      totalEscrowedUSDC: contractReceipts
        .filter(r => r.type === 'escrow_deposit')
        .reduce((sum, r) => sum + r.amount, 0) / 1e6,
    },
  });
});

export default contractsRouter;
