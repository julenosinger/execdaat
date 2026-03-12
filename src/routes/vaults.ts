// Rotas API para Vaults USDC e EURC na Arc Testnet

import { Hono } from 'hono';

const vaultsRouter = new Hono();

// ─── Tipos ─────────────────────────────────────────────────────────────
interface VaultDeposit {
  id: string;
  walletAddress: string;
  amount: number;
  txHash: string;
  timestamp: string;
  type: 'deposit' | 'withdraw' | 'yield';
  note?: string;
}

interface Vault {
  id: string;
  token: 'USDC' | 'EURC';
  name: string;
  totalDeposited: number;
  totalWithdrawn: number;
  currentBalance: number;
  apy: number;
  accrued: number; // yield acumulado
  lastYieldAt: string;
  deposits: VaultDeposit[];
  participants: number;
  contractAddress: string;
  description: string;
}

// ─── State (em produção usar D1/KV) ────────────────────────────────────
const vaults: Record<string, Vault> = {
  usdc: {
    id: 'vault-usdc-01',
    token: 'USDC',
    name: 'ARC USDC Vault',
    totalDeposited: 1_250_000,
    totalWithdrawn: 320_000,
    currentBalance: 930_000,
    apy: 5.2,
    accrued: 18_420,
    lastYieldAt: new Date().toISOString(),
    deposits: [],
    participants: 47,
    contractAddress: '0x1100000000000000000000000000000000000001',
    description: 'Yield vault para USDC na Arc Testnet. APY dinâmico baseado em utilização do pool.',
  },
  eurc: {
    id: 'vault-eurc-01',
    token: 'EURC',
    name: 'ARC EURC Vault',
    totalDeposited: 890_000,
    totalWithdrawn: 210_000,
    currentBalance: 680_000,
    apy: 4.8,
    accrued: 12_650,
    lastYieldAt: new Date().toISOString(),
    deposits: [],
    participants: 31,
    contractAddress: '0x1100000000000000000000000000000000000002',
    description: 'Yield vault para EURC na Arc Testnet. Hedge cambial EUR com rendimento automático.',
  },
};

// Simula acúmulo de yield a cada chamada
function accrue(vaultId: string) {
  const vault = vaults[vaultId];
  if (!vault) return;
  const hoursSinceLast = (Date.now() - new Date(vault.lastYieldAt).getTime()) / 3_600_000;
  const hourlyRate = vault.apy / 100 / 8760;
  const newYield = vault.currentBalance * hourlyRate * hoursSinceLast;
  vault.accrued += newYield;
  vault.lastYieldAt = new Date().toISOString();
}

// ─── Rotas ─────────────────────────────────────────────────────────────

// GET /api/vaults - Listar todos os vaults
vaultsRouter.get('/', (c) => {
  accrue('usdc');
  accrue('eurc');

  const list = Object.values(vaults).map(v => ({
    id: v.id,
    token: v.token,
    name: v.name,
    currentBalance: v.currentBalance,
    totalDeposited: v.totalDeposited,
    apy: v.apy,
    accrued: parseFloat(v.accrued.toFixed(4)),
    participants: v.participants,
    contractAddress: v.contractAddress,
    description: v.description,
    utilization: parseFloat(((v.currentBalance / (v.currentBalance + v.totalWithdrawn)) * 100).toFixed(2)),
  }));

  return c.json({ success: true, vaults: list, network: 'Arc Testnet (Chain ID: 5042002)' });
});

// GET /api/vaults/:token - Detalhes de um vault
vaultsRouter.get('/:token', (c) => {
  const token = c.req.param('token').toLowerCase();
  const vault = vaults[token];
  if (!vault) {
    return c.json({ success: false, error: 'Vault não encontrado. Use: usdc | eurc' }, 404);
  }
  accrue(token);

  return c.json({
    success: true,
    vault: {
      ...vault,
      accrued: parseFloat(vault.accrued.toFixed(4)),
      recentDeposits: vault.deposits.slice(0, 10),
    },
  });
});

// POST /api/vaults/:token/deposit - Depositar no vault
vaultsRouter.post('/:token/deposit', async (c) => {
  try {
    const token = c.req.param('token').toLowerCase();
    const vault = vaults[token];
    if (!vault) {
      return c.json({ success: false, error: 'Vault não encontrado. Use: usdc | eurc' }, 404);
    }

    const body = await c.req.json();
    const { walletAddress, amount, note } = body;

    if (!walletAddress || !amount) {
      return c.json({ success: false, error: 'Campos obrigatórios: walletAddress, amount' }, 400);
    }
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return c.json({ success: false, error: 'amount deve ser um número positivo' }, 400);
    }
    if (amountNum > 500_000) {
      return c.json({ success: false, error: 'Limite máximo de depósito: 500,000' }, 400);
    }

    accrue(token);

    const txHash = '0x' + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    const depositId = `dep-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;

    const record: VaultDeposit = {
      id: depositId,
      walletAddress,
      amount: amountNum,
      txHash,
      timestamp: new Date().toISOString(),
      type: 'deposit',
      note,
    };

    vault.deposits.unshift(record);
    vault.totalDeposited += amountNum;
    vault.currentBalance += amountNum;
    vault.participants = Math.max(vault.participants, vault.participants + (Math.random() > 0.7 ? 1 : 0));
    if (vault.deposits.length > 200) vault.deposits.pop();

    // APY dinâmico: mais depósitos → ligeiramente menor APY (utilização)
    vault.apy = parseFloat((vault.apy * 0.9995 + 0.0005 * 4.0).toFixed(2));

    return c.json({
      success: true,
      deposit: record,
      vault: {
        name: vault.name,
        newBalance: vault.currentBalance,
        apy: vault.apy,
        accrued: parseFloat(vault.accrued.toFixed(4)),
      },
      explorer: `https://testnet.arcscan.app/tx/${txHash}`,
      message: `Depósito de ${amountNum} ${vault.token} no ${vault.name} realizado com sucesso`,
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// POST /api/vaults/:token/withdraw - Sacar do vault
vaultsRouter.post('/:token/withdraw', async (c) => {
  try {
    const token = c.req.param('token').toLowerCase();
    const vault = vaults[token];
    if (!vault) {
      return c.json({ success: false, error: 'Vault não encontrado. Use: usdc | eurc' }, 404);
    }

    const body = await c.req.json();
    const { walletAddress, amount, includeYield = false } = body;

    if (!walletAddress || !amount) {
      return c.json({ success: false, error: 'Campos obrigatórios: walletAddress, amount' }, 400);
    }
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return c.json({ success: false, error: 'amount deve ser um número positivo' }, 400);
    }
    if (amountNum > vault.currentBalance) {
      return c.json({ success: false, error: `Saldo insuficiente no vault. Disponível: ${vault.currentBalance.toFixed(2)} ${vault.token}` }, 400);
    }

    accrue(token);

    const yieldAmount = includeYield ? vault.accrued : 0;
    const totalOut = amountNum + yieldAmount;

    const txHash = '0x' + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    const withdrawId = `wit-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;

    const record: VaultDeposit = {
      id: withdrawId,
      walletAddress,
      amount: -amountNum,
      txHash,
      timestamp: new Date().toISOString(),
      type: 'withdraw',
      note: includeYield ? `Inclui ${yieldAmount.toFixed(4)} de yield` : undefined,
    };

    vault.deposits.unshift(record);
    vault.totalWithdrawn += amountNum;
    vault.currentBalance -= amountNum;
    if (includeYield) vault.accrued = 0;
    if (vault.deposits.length > 200) vault.deposits.pop();

    return c.json({
      success: true,
      withdrawal: {
        ...record,
        totalReceived: parseFloat(totalOut.toFixed(6)),
        yieldClaimed: parseFloat(yieldAmount.toFixed(6)),
      },
      vault: {
        name: vault.name,
        newBalance: vault.currentBalance,
        apy: vault.apy,
      },
      explorer: `https://testnet.arcscan.app/tx/${txHash}`,
      message: `Saque de ${amountNum} ${vault.token} + ${yieldAmount.toFixed(4)} yield realizado`,
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// GET /api/vaults/:token/history - Histórico do vault
vaultsRouter.get('/:token/history', (c) => {
  const token = c.req.param('token').toLowerCase();
  const vault = vaults[token];
  if (!vault) {
    return c.json({ success: false, error: 'Vault não encontrado' }, 404);
  }

  const limit = parseInt(c.req.query('limit') || '20');

  return c.json({
    success: true,
    token: vault.token,
    history: vault.deposits.slice(0, limit),
    stats: {
      totalDeposited: vault.totalDeposited,
      totalWithdrawn: vault.totalWithdrawn,
      currentBalance: vault.currentBalance,
      accrued: parseFloat(vault.accrued.toFixed(4)),
      apy: vault.apy,
      participants: vault.participants,
    },
  });
});

// GET /api/vaults/:token/apy - APY e projeções
vaultsRouter.get('/:token/apy', (c) => {
  const token = c.req.param('token').toLowerCase();
  const vault = vaults[token];
  if (!vault) return c.json({ success: false, error: 'Vault não encontrado' }, 404);

  accrue(token);

  const simulate = (principal: number, days: number) => {
    const r = vault.apy / 100 / 365;
    return parseFloat((principal * Math.pow(1 + r, days)).toFixed(4));
  };

  return c.json({
    success: true,
    token: vault.token,
    currentApy: vault.apy,
    projections: {
      '1000_30d': simulate(1000, 30),
      '1000_90d': simulate(1000, 90),
      '1000_365d': simulate(1000, 365),
      '10000_365d': simulate(10000, 365),
    },
    accrued: parseFloat(vault.accrued.toFixed(4)),
    updatedAt: new Date().toISOString(),
  });
});

export default vaultsRouter;
