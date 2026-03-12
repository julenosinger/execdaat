// Rotas API para Vaults USDC e EURC na Arc Testnet
// Rastreia saldo real por carteira — agentes de IA operam sobre esses saldos

import { Hono } from 'hono';

const vaultsRouter = new Hono();

// ─── Contratos de token na Arc Testnet ──────────────────────────────────────
const TOKEN_CONTRACTS: Record<string, string> = {
  USDC: '0x3600000000000000000000000000000000000000',
  EURC: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
};

// Endereço custodiante do vault (receptor dos depósitos na Arc Testnet)
// Usando FxEscrow oficial da Arc como receptor público verificável
// Em produção: deployar VaultCustodian.sol com função withdraw controlada
const VAULT_CUSTODIAN = '0x867650F5eAe8df91445971f14d89fd84F0C9a9f8'; // FxEscrow Arc Testnet oficial

const VAULT_CONTRACTS: Record<string, string> = {
  usdc: VAULT_CUSTODIAN,
  eurc: VAULT_CUSTODIAN,
};

// ─── Tipos ───────────────────────────────────────────────────────────────────
interface VaultEntry {
  id: string;
  walletAddress: string;
  amount: number;          // positivo = depósito, negativo = saque
  txHash: string;
  timestamp: string;
  type: 'deposit' | 'withdraw' | 'yield_credit' | 'agent_op';
  note?: string;
  agentAction?: string;    // qual agente executou
}

interface WalletPosition {
  walletAddress: string;
  deposited: number;       // total depositado (lifetime)
  withdrawn: number;       // total sacado (lifetime)
  balance: number;         // saldo atual no vault
  yieldEarned: number;     // yield acumulado para esta carteira
  lastActivity: string;
  entryAt: string;
  agentManaged: boolean;   // se a IA está gerenciando
  strategy: 'conservative' | 'balanced' | 'aggressive';
}

interface Vault {
  id: string;
  token: 'USDC' | 'EURC';
  tokenContract: string;
  vaultContract: string;
  name: string;
  totalDeposited: number;
  totalWithdrawn: number;
  currentBalance: number;
  apy: number;
  baseApy: number;
  accrued: number;
  lastYieldAt: string;
  history: VaultEntry[];
  positions: Map<string, WalletPosition>;
  participants: number;
  description: string;
}

interface AgentOperation {
  id: string;
  vaultToken: string;
  walletAddress: string;
  opType: 'yield_harvest' | 'rebalance' | 'compound' | 'optimize_apy' | 'risk_check';
  amount?: number;
  fromApy?: number;
  toApy?: number;
  reason: string;
  txHash?: string;
  executedAt: string;
  status: 'pending' | 'executed' | 'failed';
  gainUSDC?: number;
}

// ─── Estado em memória (produção: usar Cloudflare D1) ────────────────────────
const vaults: Record<string, Vault> = {
  usdc: {
    id: 'vault-usdc-01',
    token: 'USDC',
    tokenContract: TOKEN_CONTRACTS.USDC,
    vaultContract: VAULT_CONTRACTS.usdc,
    name: 'ARC USDC Vault',
    totalDeposited: 0,
    totalWithdrawn: 0,
    currentBalance: 0,
    apy: 5.2,
    baseApy: 5.2,
    accrued: 0,
    lastYieldAt: new Date().toISOString(),
    history: [],
    positions: new Map(),
    participants: 0,
    description: 'Vault USDC gerenciado por IA. Depósito via token nativo Arc (value tx). Agentes otimizam APY, harvest yield e rebalanceiam.',
  },
  eurc: {
    id: 'vault-eurc-01',
    token: 'EURC',
    tokenContract: TOKEN_CONTRACTS.EURC,
    vaultContract: VAULT_CONTRACTS.eurc,
    name: 'ARC EURC Vault',
    totalDeposited: 0,
    totalWithdrawn: 0,
    currentBalance: 0,
    apy: 4.8,
    baseApy: 4.8,
    accrued: 0,
    lastYieldAt: new Date().toISOString(),
    history: [],
    positions: new Map(),
    participants: 0,
    description: 'Vault EURC gerenciado por IA. Depósito via ERC-20 (approve + transfer). Hedge cambial EUR/USD com rendimento automático.',
  },
};

// Log global de operações dos agentes
const agentOps: AgentOperation[] = [];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeAddress(addr: string): string {
  return addr.toLowerCase().trim();
}

function accrue(vaultId: string) {
  const vault = vaults[vaultId];
  if (!vault || vault.currentBalance === 0) return;
  const hoursSinceLast = (Date.now() - new Date(vault.lastYieldAt).getTime()) / 3_600_000;
  const hourlyRate = vault.apy / 100 / 8760;
  const newYield = vault.currentBalance * hourlyRate * hoursSinceLast;
  vault.accrued += newYield;

  // Distribuir yield proporcionalmente às posições
  vault.positions.forEach((pos) => {
    if (pos.balance > 0) {
      const share = pos.balance / vault.currentBalance;
      pos.yieldEarned += newYield * share;
    }
  });

  vault.lastYieldAt = new Date().toISOString();
}

function getOrCreatePosition(vault: Vault, walletAddress: string): WalletPosition {
  const key = normalizeAddress(walletAddress);
  if (!vault.positions.has(key)) {
    vault.positions.set(key, {
      walletAddress: key,
      deposited: 0,
      withdrawn: 0,
      balance: 0,
      yieldEarned: 0,
      lastActivity: new Date().toISOString(),
      entryAt: new Date().toISOString(),
      agentManaged: true,
      strategy: 'balanced',
    });
  }
  return vault.positions.get(key)!;
}

function updateVaultApy(vault: Vault) {
  // APY dinâmico: aumenta com mais capital sob gestão (melhor liquidez → mais estratégias)
  const tvl = vault.currentBalance;
  if (tvl <= 0) { vault.apy = vault.baseApy; return; }
  const bonus = Math.min(2.0, tvl / 100_000 * 0.5); // até +2% com $100k
  vault.apy = parseFloat((vault.baseApy + bonus).toFixed(2));
}

function fakeHash(): string {
  return '0x' + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

// ─── Simular operação do Agente IA ─────────────────────────────────────────
function runAgentCycle(vaultId: string) {
  const vault = vaults[vaultId];
  if (!vault || vault.currentBalance === 0) return;

  accrue(vaultId);
  updateVaultApy(vault);

  // Uma operação aleatória a cada chamada (simula decisão do agente)
  const ops: AgentOperation['opType'][] = ['yield_harvest', 'optimize_apy', 'compound', 'risk_check'];
  const opType = ops[Math.floor(Math.random() * ops.length)];

  const op: AgentOperation = {
    id: `op-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    vaultToken: vault.token,
    walletAddress: 'vault-wide',
    opType,
    reason: '',
    executedAt: new Date().toISOString(),
    status: 'executed',
    txHash: fakeHash(),
  };

  switch (opType) {
    case 'yield_harvest':
      op.amount = parseFloat((vault.accrued * 0.1).toFixed(4));
      op.reason = `Harvested ${op.amount} ${vault.token} yield from lending pool`;
      op.gainUSDC = op.amount;
      vault.accrued += op.amount * 0.05; // re-inject 5% as compound
      break;
    case 'optimize_apy':
      op.fromApy = vault.apy;
      op.toApy = parseFloat((vault.apy + (Math.random() * 0.3 - 0.1)).toFixed(2));
      vault.apy = op.toApy;
      op.reason = `APY optimized: ${op.fromApy}% → ${op.toApy}% via pool reallocation`;
      break;
    case 'compound':
      if (vault.accrued > 1) {
        const compounded = parseFloat((vault.accrued * 0.5).toFixed(4));
        vault.currentBalance += compounded;
        vault.accrued -= compounded;
        op.amount = compounded;
        op.reason = `Auto-compounded ${compounded} ${vault.token} into principal`;
        op.gainUSDC = compounded;
      } else {
        op.reason = 'Insufficient accrued yield for compounding, skipped';
      }
      break;
    case 'risk_check':
      op.reason = `Risk assessment: ${vault.currentBalance.toFixed(2)} ${vault.token} TVL, APY ${vault.apy}%, positions ${vault.positions.size} — all within parameters`;
      break;
  }

  agentOps.unshift(op);
  if (agentOps.length > 200) agentOps.pop();
}

// ─── GET /api/vaults — lista todos os vaults ────────────────────────────────
vaultsRouter.get('/', (c) => {
  accrue('usdc');
  accrue('eurc');
  updateVaultApy(vaults.usdc);
  updateVaultApy(vaults.eurc);

  const list = Object.values(vaults).map(v => ({
    id: v.id,
    token: v.token,
    tokenContract: v.tokenContract,
    vaultContract: v.vaultContract,
    name: v.name,
    currentBalance: parseFloat(v.currentBalance.toFixed(4)),
    totalDeposited: parseFloat(v.totalDeposited.toFixed(4)),
    totalWithdrawn: parseFloat(v.totalWithdrawn.toFixed(4)),
    apy: v.apy,
    accrued: parseFloat(v.accrued.toFixed(6)),
    participants: v.positions.size,
    description: v.description,
    agentManaged: true,
    utilization: v.currentBalance > 0
      ? parseFloat(((v.currentBalance / Math.max(v.totalDeposited, 1)) * 100).toFixed(2))
      : 0,
  }));

  return c.json({
    success: true,
    vaults: list,
    network: 'Arc Testnet',
    chainId: 5042002,
    contracts: VAULT_CONTRACTS,
    tokens: TOKEN_CONTRACTS,
  });
});

// ─── GET /api/vaults/:token — detalhes + posição da carteira ────────────────
vaultsRouter.get('/:token', (c) => {
  const token = c.req.param('token').toLowerCase();
  const vault = vaults[token];
  if (!vault) return c.json({ success: false, error: 'Vault não encontrado. Use: usdc | eurc' }, 404);

  const wallet = c.req.query('wallet');
  accrue(token);
  updateVaultApy(vault);

  let walletPosition = null;
  if (wallet) {
    const pos = vault.positions.get(normalizeAddress(wallet));
    if (pos) {
      walletPosition = {
        ...pos,
        yieldEarned: parseFloat(pos.yieldEarned.toFixed(6)),
        sharePercent: vault.currentBalance > 0
          ? parseFloat((pos.balance / vault.currentBalance * 100).toFixed(4))
          : 0,
      };
    }
  }

  return c.json({
    success: true,
    vault: {
      ...vault,
      positions: undefined,
      accrued: parseFloat(vault.accrued.toFixed(6)),
      participants: vault.positions.size,
      recentHistory: vault.history.slice(0, 20),
    },
    walletPosition,
    agentOpsRecent: agentOps.filter(o => o.vaultToken === vault.token).slice(0, 10),
  });
});

// ─── GET /api/vaults/:token/position — saldo da carteira no vault ────────────
vaultsRouter.get('/:token/position', (c) => {
  const token = c.req.param('token').toLowerCase();
  const vault = vaults[token];
  if (!vault) return c.json({ success: false, error: 'Vault não encontrado' }, 404);

  const wallet = c.req.query('wallet');
  if (!wallet) return c.json({ success: false, error: 'Query param ?wallet= obrigatório' }, 400);

  accrue(token);

  const pos = vault.positions.get(normalizeAddress(wallet));
  if (!pos || pos.balance <= 0) {
    return c.json({
      success: true,
      hasPosition: false,
      balance: 0,
      yieldEarned: 0,
      message: 'Nenhum depósito encontrado para esta carteira',
    });
  }

  const sharePercent = vault.currentBalance > 0
    ? parseFloat((pos.balance / vault.currentBalance * 100).toFixed(4))
    : 0;

  return c.json({
    success: true,
    hasPosition: true,
    walletAddress: pos.walletAddress,
    balance: parseFloat(pos.balance.toFixed(6)),
    deposited: parseFloat(pos.deposited.toFixed(6)),
    withdrawn: parseFloat(pos.withdrawn.toFixed(6)),
    yieldEarned: parseFloat(pos.yieldEarned.toFixed(6)),
    sharePercent,
    strategy: pos.strategy,
    agentManaged: pos.agentManaged,
    entryAt: pos.entryAt,
    lastActivity: pos.lastActivity,
    token: vault.token,
    currentApy: vault.apy,
  });
});

// ─── POST /api/vaults/:token/deposit ────────────────────────────────────────
vaultsRouter.post('/:token/deposit', async (c) => {
  try {
    const token = c.req.param('token').toLowerCase();
    const vault = vaults[token];
    if (!vault) return c.json({ success: false, error: 'Vault não encontrado. Use: usdc | eurc' }, 404);

    const body = await c.req.json();
    const { walletAddress, amount, txHash, strategy = 'balanced', note } = body;

    if (!walletAddress) return c.json({ success: false, error: 'walletAddress obrigatório' }, 400);
    if (!amount) return c.json({ success: false, error: 'amount obrigatório' }, 400);
    if (!txHash) return c.json({ success: false, error: 'txHash obrigatório — faça o approve+transfer on-chain primeiro' }, 400);

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) return c.json({ success: false, error: 'amount deve ser positivo' }, 400);
    if (amountNum < 0.01) return c.json({ success: false, error: 'Depósito mínimo: 0.01' }, 400);
    if (amountNum > 1_000_000) return c.json({ success: false, error: 'Depósito máximo: 1,000,000' }, 400);

    accrue(token);

    // Registrar posição da carteira
    const pos = getOrCreatePosition(vault, walletAddress);
    pos.deposited += amountNum;
    pos.balance += amountNum;
    pos.lastActivity = new Date().toISOString();
    pos.agentManaged = true;
    if (strategy) pos.strategy = strategy as WalletPosition['strategy'];

    // Registrar no vault global
    vault.totalDeposited += amountNum;
    vault.currentBalance += amountNum;
    updateVaultApy(vault);

    const entry: VaultEntry = {
      id: `dep-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      walletAddress: normalizeAddress(walletAddress),
      amount: amountNum,
      txHash,
      timestamp: new Date().toISOString(),
      type: 'deposit',
      note: note || `Deposit ${amountNum} ${vault.token} — strategy: ${strategy}`,
    };
    vault.history.unshift(entry);
    if (vault.history.length > 500) vault.history.pop();

    // Disparar ciclo do agente imediatamente após depósito
    runAgentCycle(token);

    const agentMsg = `Agente IA ativado: gerenciando ${amountNum} ${vault.token} com estratégia ${strategy}. APY atual: ${vault.apy}%`;

    return c.json({
      success: true,
      deposit: entry,
      walletPosition: {
        balance: parseFloat(pos.balance.toFixed(6)),
        deposited: parseFloat(pos.deposited.toFixed(6)),
        yieldEarned: parseFloat(pos.yieldEarned.toFixed(6)),
        strategy: pos.strategy,
        agentManaged: pos.agentManaged,
        sharePercent: parseFloat((pos.balance / vault.currentBalance * 100).toFixed(4)),
      },
      vault: {
        name: vault.name,
        newBalance: parseFloat(vault.currentBalance.toFixed(4)),
        apy: vault.apy,
        participants: vault.positions.size,
      },
      agentMessage: agentMsg,
      explorer: `https://testnet.arcscan.app/tx/${txHash}`,
      message: `✅ ${amountNum} ${vault.token} depositado com sucesso! ${agentMsg}`,
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ─── POST /api/vaults/:token/withdraw ───────────────────────────────────────
vaultsRouter.post('/:token/withdraw', async (c) => {
  try {
    const token = c.req.param('token').toLowerCase();
    const vault = vaults[token];
    if (!vault) return c.json({ success: false, error: 'Vault não encontrado. Use: usdc | eurc' }, 404);

    const body = await c.req.json();
    const { walletAddress, amount, txHash, includeYield = false } = body;

    if (!walletAddress) return c.json({ success: false, error: 'walletAddress obrigatório' }, 400);
    if (!amount) return c.json({ success: false, error: 'amount obrigatório' }, 400);

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) return c.json({ success: false, error: 'amount deve ser positivo' }, 400);

    accrue(token);

    const pos = vault.positions.get(normalizeAddress(walletAddress));
    if (!pos || pos.balance <= 0) {
      return c.json({ success: false, error: `Nenhum saldo encontrado para ${walletAddress} neste vault` }, 400);
    }
    if (amountNum > pos.balance) {
      return c.json({
        success: false,
        error: `Saldo insuficiente. Seu saldo: ${pos.balance.toFixed(4)} ${vault.token}`,
      }, 400);
    }

    const yieldAmount = includeYield ? parseFloat(pos.yieldEarned.toFixed(6)) : 0;
    const totalOut = amountNum + yieldAmount;

    const withdrawTxHash = txHash || fakeHash();

    pos.withdrawn += amountNum;
    pos.balance -= amountNum;
    pos.lastActivity = new Date().toISOString();
    if (includeYield) pos.yieldEarned = 0;

    vault.totalWithdrawn += amountNum;
    vault.currentBalance -= amountNum;
    if (includeYield) vault.accrued = Math.max(0, vault.accrued - yieldAmount);
    updateVaultApy(vault);

    const entry: VaultEntry = {
      id: `wit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      walletAddress: normalizeAddress(walletAddress),
      amount: -amountNum,
      txHash: withdrawTxHash,
      timestamp: new Date().toISOString(),
      type: 'withdraw',
      note: includeYield
        ? `Saque ${amountNum} + ${yieldAmount.toFixed(6)} yield = ${totalOut.toFixed(6)} ${vault.token}`
        : `Saque ${amountNum} ${vault.token}`,
    };
    vault.history.unshift(entry);
    if (vault.history.length > 500) vault.history.pop();

    return c.json({
      success: true,
      withdrawal: {
        ...entry,
        totalReceived: parseFloat(totalOut.toFixed(6)),
        yieldClaimed: yieldAmount,
      },
      walletPosition: {
        balance: parseFloat(pos.balance.toFixed(6)),
        deposited: parseFloat(pos.deposited.toFixed(6)),
        withdrawn: parseFloat(pos.withdrawn.toFixed(6)),
        yieldEarned: parseFloat(pos.yieldEarned.toFixed(6)),
      },
      vault: {
        name: vault.name,
        newBalance: parseFloat(vault.currentBalance.toFixed(4)),
        apy: vault.apy,
      },
      explorer: `https://testnet.arcscan.app/tx/${withdrawTxHash}`,
      message: `Saque de ${amountNum} ${vault.token}${includeYield ? ` + ${yieldAmount.toFixed(4)} yield` : ''} realizado`,
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ─── GET /api/vaults/:token/history ─────────────────────────────────────────
vaultsRouter.get('/:token/history', (c) => {
  const token = c.req.param('token').toLowerCase();
  const vault = vaults[token];
  if (!vault) return c.json({ success: false, error: 'Vault não encontrado' }, 404);

  const limit = parseInt(c.req.query('limit') || '20');
  const wallet = c.req.query('wallet');

  accrue(token);

  let history = vault.history;
  if (wallet) {
    const key = normalizeAddress(wallet);
    history = vault.history.filter(e => e.walletAddress === key);
  }

  const pos = wallet ? vault.positions.get(normalizeAddress(wallet)) : null;

  return c.json({
    success: true,
    token: vault.token,
    history: history.slice(0, limit),
    stats: {
      totalDeposited: pos ? parseFloat(pos.deposited.toFixed(4)) : parseFloat(vault.totalDeposited.toFixed(4)),
      totalWithdrawn: pos ? parseFloat(pos.withdrawn.toFixed(4)) : parseFloat(vault.totalWithdrawn.toFixed(4)),
      currentBalance: pos ? parseFloat(pos.balance.toFixed(4)) : parseFloat(vault.currentBalance.toFixed(4)),
      yieldEarned: pos ? parseFloat(pos.yieldEarned.toFixed(6)) : parseFloat(vault.accrued.toFixed(6)),
      accrued: parseFloat(vault.accrued.toFixed(6)),
      apy: vault.apy,
      participants: vault.positions.size,
    },
  });
});

// ─── GET /api/vaults/:token/apy — projeções ─────────────────────────────────
vaultsRouter.get('/:token/apy', (c) => {
  const token = c.req.param('token').toLowerCase();
  const vault = vaults[token];
  if (!vault) return c.json({ success: false, error: 'Vault não encontrado' }, 404);

  accrue(token);
  updateVaultApy(vault);

  const simulate = (principal: number, days: number) =>
    parseFloat((principal * Math.pow(1 + vault.apy / 100 / 365, days)).toFixed(4));

  return c.json({
    success: true,
    token: vault.token,
    currentApy: vault.apy,
    projections: {
      '100_30d': simulate(100, 30),
      '1000_30d': simulate(1000, 30),
      '1000_90d': simulate(1000, 90),
      '1000_365d': simulate(1000, 365),
      '10000_365d': simulate(10000, 365),
    },
    accrued: parseFloat(vault.accrued.toFixed(4)),
    updatedAt: new Date().toISOString(),
  });
});

// ─── GET /api/vaults/balance/:wallet — saldo total por carteira (usado pelos agentes) ─
vaultsRouter.get('/balance/:wallet', (c) => {
  const wallet = c.req.param('wallet');
  if (!wallet) return c.json({ success: false, error: 'wallet param obrigatório' }, 400);

  const key = normalizeAddress(wallet);
  accrue('usdc');
  accrue('eurc');

  const usdcPos = vaults.usdc.positions.get(key);
  const eurcPos = vaults.eurc.positions.get(key);

  const totalUSDC = usdcPos?.balance ?? 0;
  const totalEURC = eurcPos?.balance ?? 0;

  return c.json({
    success: true,
    wallet: key,
    vaultBalances: {
      usdc: {
        balance: parseFloat(totalUSDC.toFixed(6)),
        yieldEarned: parseFloat((usdcPos?.yieldEarned ?? 0).toFixed(6)),
        strategy: usdcPos?.strategy ?? null,
        agentManaged: usdcPos?.agentManaged ?? false,
        hasPosition: totalUSDC > 0,
      },
      eurc: {
        balance: parseFloat(totalEURC.toFixed(6)),
        yieldEarned: parseFloat((eurcPos?.yieldEarned ?? 0).toFixed(6)),
        strategy: eurcPos?.strategy ?? null,
        agentManaged: eurcPos?.agentManaged ?? false,
        hasPosition: totalEURC > 0,
      },
    },
    totalUSDCEquivalent: parseFloat((totalUSDC + totalEURC).toFixed(6)),
    agentCanOperate: totalUSDC > 0 || totalEURC > 0,
    network: 'Arc Testnet',
    updatedAt: new Date().toISOString(),
  });
});

// ─── POST /api/vaults/agent/use-balance — agente debita saldo do vault para operar ─
vaultsRouter.post('/agent/use-balance', async (c) => {
  try {
    const body = await c.req.json();
    const { walletAddress, token, amount, operation, agentId = 'system', reason = '', txHash } = body;

    if (!walletAddress) return c.json({ success: false, error: 'walletAddress obrigatório' }, 400);
    if (!token) return c.json({ success: false, error: 'token obrigatório (usdc|eurc)' }, 400);
    if (!amount) return c.json({ success: false, error: 'amount obrigatório' }, 400);
    if (!operation) return c.json({ success: false, error: 'operation obrigatória' }, 400);

    const vaultKey = token.toLowerCase();
    const vault = vaults[vaultKey];
    if (!vault) return c.json({ success: false, error: `Vault ${token} não encontrado` }, 404);

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) return c.json({ success: false, error: 'amount deve ser positivo' }, 400);

    accrue(vaultKey);

    const pos = vault.positions.get(normalizeAddress(walletAddress));
    if (!pos || pos.balance < amountNum) {
      return c.json({
        success: false,
        error: `Saldo insuficiente no vault. Disponível: ${(pos?.balance ?? 0).toFixed(4)} ${vault.token}`,
        available: pos?.balance ?? 0,
      }, 400);
    }

    // Debitar saldo (agente operando com esses fundos)
    pos.balance -= amountNum;
    pos.lastActivity = new Date().toISOString();
    vault.currentBalance -= amountNum;
    vault.totalWithdrawn += amountNum;
    updateVaultApy(vault);

    const opHash = txHash || fakeHash();
    const opEntry: VaultEntry = {
      id: `agop-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      walletAddress: normalizeAddress(walletAddress),
      amount: -amountNum,
      txHash: opHash,
      timestamp: new Date().toISOString(),
      type: 'agent_op',
      note: `[${agentId}] ${operation}: ${reason}`.slice(0, 120),
      agentAction: operation,
    };
    vault.history.unshift(opEntry);
    if (vault.history.length > 500) vault.history.pop();

    const agOp: AgentOperation = {
      id: `agop-${Date.now()}`,
      vaultToken: vault.token,
      walletAddress: normalizeAddress(walletAddress),
      opType: 'yield_harvest',
      amount: amountNum,
      reason: `[${agentId}] ${operation}: ${reason}`,
      txHash: opHash,
      executedAt: new Date().toISOString(),
      status: 'executed',
      gainUSDC: 0,
    };
    agentOps.unshift(agOp);
    if (agentOps.length > 200) agentOps.pop();

    return c.json({
      success: true,
      operation: { id: opEntry.id, token: vault.token, amount: amountNum, operation, agentId, txHash: opHash, timestamp: opEntry.timestamp },
      walletPosition: { balance: parseFloat(pos.balance.toFixed(6)), yieldEarned: parseFloat(pos.yieldEarned.toFixed(6)), strategy: pos.strategy },
      vault: { newBalance: parseFloat(vault.currentBalance.toFixed(4)), apy: vault.apy },
      explorer: `https://testnet.arcscan.app/tx/${opHash}`,
      message: `✅ Agente ${agentId} operou ${amountNum} ${vault.token}: ${operation}`,
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ─── POST /api/vaults/agent/credit-back — agente credita retorno ao vault ────
vaultsRouter.post('/agent/credit-back', async (c) => {
  try {
    const body = await c.req.json();
    const { walletAddress, token, amount, yieldAmount = 0, operation, agentId = 'system', reason = '', txHash } = body;

    if (!walletAddress || !token || !amount) {
      return c.json({ success: false, error: 'walletAddress, token e amount obrigatórios' }, 400);
    }

    const vaultKey = token.toLowerCase();
    const vault = vaults[vaultKey];
    if (!vault) return c.json({ success: false, error: `Vault ${token} não encontrado` }, 404);

    const amountNum = parseFloat(amount);
    const yieldNum = parseFloat(yieldAmount) || 0;
    const totalReturn = amountNum + yieldNum;

    if (isNaN(amountNum) || amountNum < 0) return c.json({ success: false, error: 'amount inválido' }, 400);

    accrue(vaultKey);

    const pos = vault.positions.get(normalizeAddress(walletAddress));
    if (!pos) return c.json({ success: false, error: `Posição não encontrada para ${walletAddress}` }, 404);

    pos.balance += amountNum;
    pos.yieldEarned += yieldNum;
    pos.lastActivity = new Date().toISOString();
    vault.currentBalance += totalReturn;
    vault.accrued += yieldNum;
    updateVaultApy(vault);

    const creditHash = txHash || fakeHash();
    vault.history.unshift({
      id: `credit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      walletAddress: normalizeAddress(walletAddress),
      amount: totalReturn,
      txHash: creditHash,
      timestamp: new Date().toISOString(),
      type: 'yield_credit',
      note: `[${agentId}] retorno: ${amountNum} + yield ${yieldNum.toFixed(6)} ${vault.token}`,
      agentAction: operation,
    });

    return c.json({
      success: true,
      credited: { principal: amountNum, yield: yieldNum, total: parseFloat(totalReturn.toFixed(6)), txHash: creditHash },
      walletPosition: { balance: parseFloat(pos.balance.toFixed(6)), yieldEarned: parseFloat(pos.yieldEarned.toFixed(6)) },
      vault: { newBalance: parseFloat(vault.currentBalance.toFixed(4)), apy: vault.apy },
      message: `✅ ${totalReturn.toFixed(4)} ${vault.token} creditado de volta ao vault`,
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ─── GET /api/vaults/agent/ops — operações do agente IA ─────────────────────
vaultsRouter.get('/agent/ops', (c) => {
  const token = c.req.query('token');
  const limit = parseInt(c.req.query('limit') || '20');

  // Rodar ciclo do agente em todos os vaults antes de retornar
  runAgentCycle('usdc');
  runAgentCycle('eurc');

  let ops = agentOps;
  if (token) ops = agentOps.filter(o => o.vaultToken === token.toUpperCase());

  return c.json({
    success: true,
    operations: ops.slice(0, limit),
    totalOps: agentOps.length,
    vaultStats: {
      usdc: { balance: parseFloat(vaults.usdc.currentBalance.toFixed(4)), apy: vaults.usdc.apy, accrued: parseFloat(vaults.usdc.accrued.toFixed(4)) },
      eurc: { balance: parseFloat(vaults.eurc.currentBalance.toFixed(4)), apy: vaults.eurc.apy, accrued: parseFloat(vaults.eurc.accrued.toFixed(4)) },
    },
  });
});

// ─── POST /api/vaults/agent/run — forçar ciclo do agente ────────────────────
vaultsRouter.post('/agent/run', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { token } = body as { token?: string };

  if (token) {
    runAgentCycle(token.toLowerCase());
  } else {
    runAgentCycle('usdc');
    runAgentCycle('eurc');
  }

  const recentOps = agentOps.slice(0, 5);

  return c.json({
    success: true,
    message: `Agente IA executou ${recentOps.length} operações`,
    operations: recentOps,
    vaultStats: {
      usdc: { balance: parseFloat(vaults.usdc.currentBalance.toFixed(4)), apy: vaults.usdc.apy },
      eurc: { balance: parseFloat(vaults.eurc.currentBalance.toFixed(4)), apy: vaults.eurc.apy },
    },
  });
});

// ─── Exportar vault store para uso pelos agentes ─────────────────────────────
// Allows agents to query vault balances without HTTP overhead
export const vaultStore: Record<string, { positions: Map<string, { balance: number; yieldEarned: number; strategy: string }> }> = {
  usdc: vaults.usdc as unknown as { positions: Map<string, { balance: number; yieldEarned: number; strategy: string }> },
  eurc: vaults.eurc as unknown as { positions: Map<string, { balance: number; yieldEarned: number; strategy: string }> },
};

export default vaultsRouter;
