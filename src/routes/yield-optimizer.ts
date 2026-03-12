// Rotas API para o Yield Optimizer Agent

import { Hono } from 'hono';
import { YieldOptimizerAgent } from '../agents/YieldOptimizerAgent';

const yieldRouter = new Hono();
let agent: YieldOptimizerAgent | null = null;

function getAgent(): YieldOptimizerAgent {
  if (!agent) agent = new YieldOptimizerAgent();
  return agent;
}

// ─── Status ───────────────────────────────────────────────────────────────
yieldRouter.get('/status', (c) => {
  const a = getAgent();
  const rawStats = a.getStats();
  const pools = a.getPools();
  const rebalances = a.getRebalanceHistory(1000);
  return c.json({
    success: true,
    agent: {
      id: 'yield-optimizer-01',
      name: 'ARC Yield Optimizer v1.0',
      capabilities: ['pool_discovery', 'apy_tracking', 'auto_rebalance', 'portfolio_analysis', 'yield_compounding'],
      status: rawStats.agentStatus,
    },
    stats: {
      ...rawStats,
      totalPools: pools.length,
      totalRebalances: rawStats.rebalances,
      bestApy: rawStats.bestApy,
    },
    strategies: a.getStrategies(),
    network: { name: 'Arc Testnet', chainId: 5042002, rpcUrl: 'https://rpc.testnet.arc.network' },
  });
});

// ─── Get all pools ─────────────────────────────────────────────────────────
yieldRouter.get('/pools', (c) => {
  const token = c.req.query('token') as 'USDC' | 'EURC' | undefined;
  const a = getAgent();
  const pools = a.getPools(token);
  return c.json({
    success: true,
    pools,
    bestUsdc: a.getBestPool('USDC', 'balanced'),
    bestEurc: a.getBestPool('EURC', 'balanced'),
    updatedAt: new Date().toISOString(),
  });
});

// ─── Get best pool for token + strategy ───────────────────────────────────
yieldRouter.get('/pools/best', (c) => {
  const token = (c.req.query('token') || 'USDC') as 'USDC' | 'EURC';
  const strategy = (c.req.query('strategy') || 'balanced') as any;
  const a = getAgent();
  const best = a.getBestPool(token, strategy);
  return c.json({ success: true, pool: best, strategy });
});

// ─── Open position ─────────────────────────────────────────────────────────
yieldRouter.post('/positions/open', async (c) => {
  try {
    const body = await c.req.json();
    const { walletAddress, poolId, amount, strategy = 'balanced', txHash } = body;

    if (!walletAddress || !poolId || !amount) {
      return c.json({ success: false, error: 'Required: walletAddress, poolId, amount' }, 400);
    }
    if (!txHash) {
      return c.json({ success: false, error: 'txHash required — transaction must be signed on Arc Testnet first' }, 400);
    }

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return c.json({ success: false, error: 'Invalid amount' }, 400);
    }

    const a = getAgent();
    const position = await a.openPosition({
      walletAddress,
      poolId,
      amount: amountNum * 1e6,
      strategy,
      txHash,
    });

    return c.json({
      success: true,
      position,
      message: `Position opened in pool. Earning yield at ${position.entryApy}% APY.`,
      explorer: `https://testnet.arcscan.app/tx/${txHash}`,
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ─── Close position ────────────────────────────────────────────────────────
yieldRouter.post('/positions/:id/close', async (c) => {
  try {
    const posId = c.req.param('id');
    const body = await c.req.json();
    const { txHash } = body;
    if (!txHash) {
      return c.json({ success: false, error: 'txHash required — sign the withdrawal on Arc Testnet' }, 400);
    }

    const a = getAgent();
    const position = await a.closePosition(posId, txHash);
    return c.json({
      success: true,
      position,
      yieldEarned: (position.yieldEarned / 1e6).toFixed(6),
      totalReceived: ((position.currentValue) / 1e6).toFixed(6),
      explorer: `https://testnet.arcscan.app/tx/${txHash}`,
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ─── Get positions ─────────────────────────────────────────────────────────
yieldRouter.get('/positions', (c) => {
  const walletAddress = c.req.query('wallet');
  const a = getAgent();
  const positions = a.getPositions(walletAddress);
  return c.json({ success: true, positions, total: positions.length });
});

// ─── Analyze portfolio ─────────────────────────────────────────────────────
yieldRouter.get('/analyze/:wallet', (c) => {
  const wallet = c.req.param('wallet');
  const a = getAgent();
  const analysis = a.analyzePortfolio(wallet);
  return c.json({ success: true, ...analysis, wallet });
});

// ─── Auto-rebalance position ───────────────────────────────────────────────
yieldRouter.post('/positions/:id/rebalance', async (c) => {
  try {
    const posId = c.req.param('id');
    const a = getAgent();
    const action = await a.autoRebalance(posId);
    return c.json({
      success: true,
      rebalance: action,
      message: action.status === 'executed'
        ? `Rebalanced: moved to ${action.toPool} (+${action.expectedGain}% APY gain)`
        : `No rebalance needed: ${action.reason}`,
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ─── Rebalance history ─────────────────────────────────────────────────────
yieldRouter.get('/rebalances', (c) => {
  const limit = parseInt(c.req.query('limit') || '20');
  const a = getAgent();
  return c.json({
    success: true,
    rebalances: a.getRebalanceHistory(limit),
    stats: a.getStats(),
  });
});

// ─── Strategies ────────────────────────────────────────────────────────────
yieldRouter.get('/strategies', (c) => {
  const a = getAgent();
  return c.json({ success: true, strategies: a.getStrategies() });
});

// ─── APY projections for amount ───────────────────────────────────────────
yieldRouter.get('/project', (c) => {
  const amountStr = c.req.query('amount') || '1000';
  const token = (c.req.query('token') || 'USDC') as 'USDC' | 'EURC';
  const strategy = (c.req.query('strategy') || 'balanced') as any;
  const amount = parseFloat(amountStr);

  const a = getAgent();
  const best = a.getBestPool(token, strategy);
  const apy = best?.apy ?? 5.0;

  const project = (days: number) => parseFloat((amount * Math.pow(1 + apy / 100 / 365, days)).toFixed(4));

  return c.json({
    success: true,
    amount,
    token,
    strategy,
    bestPool: best,
    projections: {
      '7d': { value: project(7), yield: parseFloat((project(7) - amount).toFixed(4)) },
      '30d': { value: project(30), yield: parseFloat((project(30) - amount).toFixed(4)) },
      '90d': { value: project(90), yield: parseFloat((project(90) - amount).toFixed(4)) },
      '180d': { value: project(180), yield: parseFloat((project(180) - amount).toFixed(4)) },
      '365d': { value: project(365), yield: parseFloat((project(365) - amount).toFixed(4)) },
    },
    apy,
    gasCostPerRebalance: 0.009,
  });
});

export default yieldRouter;
