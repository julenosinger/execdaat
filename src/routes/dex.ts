// ============================================================
//  ARC DEX Backend — Real On-Chain Data
//  Arc Testnet · ChainId 5042002 · x * y = k
//
//  SimpleAMM contract reads reserves directly from chain via RPC.
//  NO mock data — all pool state comes from the deployed contract.
//
//  Token Registry:
//    EURC  0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a  (ERC-20, 6 dec)
//    USDC  0x3600000000000000000000000000000000000000  (ERC-20, 6 dec)
//
//  SimpleAMM contract address is stored in AMM_ADDRESS below.
//  Update it after deploying with: node contracts/script/deployAMM.js
//
//  Phase 2 hardening:
//    • Multi-RPC failover (timeout, retry, exponential backoff)
//    • Verified DEX cache (TTL 15s, never overwritten by failures)
//    • source = 'on-chain' | 'cache' | 'error' — no silent fallbacks
//    • RPC down + no cache → HTTP 503 RPC_UNAVAILABLE
//    • Pool health engine, liquidity depth, donation detection
//      (all read-only, informational, verified reserves only)
// ============================================================

import { Hono } from 'hono';
import { isValidEthAddress, isValidTxHash, clampString } from '../middleware/security';
import { createRpcClient } from '../lib/arc-rpc.mjs';
import { createDexCache } from '../lib/dex-cache.mjs';
import {
  ammGetAmountOut,
  calcLpValueIndex,
  type PoolClassification,
} from '../lib/dex-metrics.mjs';
import {
  createAnalyticsEngine,
  calcLpPosition,
  analyzeLiquidityAddition,
  scanBytecodeCapabilities,
  analyzeTwapFeasibility,
  makeDeadlineGuidance,
  type AmmCapabilities,
  type PoolAnalyticsSnapshot,
} from '../lib/pool-analytics.mjs';

const dexRouter = new Hono();

// ─── Network / Token Config ───────────────────────────────────────────────────
const CHAIN_ID   = 5042002;
const EXPLORER   = 'https://testnet.arcscan.app';

// SimpleAMM deployed on Arc Testnet — 2026-03-16
// Deploy tx: 0x35d96b9659ab438b84c606c6d47d16c883388b6552465a21f9a97d75680c5022
// ArcScan: https://testnet.arcscan.app/address/0x3148E2807F172D1cC354F35fB4fC4104e8b6b561
const DEFAULT_AMM_ADDRESS = '0x3148E2807F172D1cC354F35fB4fC4104e8b6b561';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function currentAmm(): string {
  return (globalThis as any).AMM_CONTRACT_ADDRESS || DEFAULT_AMM_ADDRESS;
}

export const TOKEN_REGISTRY = {
  EURC: {
    symbol: 'EURC', name: 'Euro Coin',
    address: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
    decimals: 6, logo: '💶', isNative: false, chainId: CHAIN_ID,
  },
  USDC: {
    symbol: 'USDC', name: 'USD Coin',
    address: '0x3600000000000000000000000000000000000000',
    decimals: 6, logo: '💵', isNative: false, chainId: CHAIN_ID,
  },
};

// ─── Structured logging (Phase 2 Part 7 — no sensitive data) ─────────────────
function slog(fields: Record<string, unknown>): void {
  try {
    console.log(JSON.stringify(
      { ts: new Date().toISOString(), mod: 'dex-api', ...fields },
      (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
    ));
  } catch (_) { /* logging must never throw */ }
}

// ─── Hardened RPC client + verified DEX cache ────────────────────────────────
const rpcClient = createRpcClient({ log: slog });
const dexCache = createDexCache({
  rpcClient,
  ammAddress: currentAmm,
  eurcAddress: TOKEN_REGISTRY.EURC.address,
  usdcAddress: TOKEN_REGISTRY.USDC.address,
  log: slog,
});

// ─── Canonical PoolAnalyticsSnapshot engine (Phase 3 Part 5) ─────────────────
// One verified snapshot (shared dexCache) → memoized analytics for ALL
// endpoints: /health /stats /depth /rates /pool /donation /lp /risk /analytics
const analyticsEngine = createAnalyticsEngine({ dexCache, log: slog });

// ─── AMM capability probe (Phase 3 Parts 1/2/7 — bytecode scan, memoized) ────
let capabilitiesMemo: { amm: string; caps: AmmCapabilities } | null = null;
async function getAmmCapabilities(): Promise<AmmCapabilities | null> {
  const amm = currentAmm();
  if (capabilitiesMemo && capabilitiesMemo.amm === amm) return capabilitiesMemo.caps;
  try {
    const code = await rpcClient.call('eth_getCode', [amm, 'latest']) as string;
    const caps = scanBytecodeCapabilities(code);
    capabilitiesMemo = { amm, caps };
    slog({
      evt: 'amm_capabilities_probed', amm,
      bytecodeSize: caps.bytecodeSize,
      deadlineSupportedOnChain: caps.deadlineSupportedOnChain,
      twapAccumulatorsOnChain: caps.twapAccumulatorsOnChain,
    });
    return caps;
  } catch (err) {
    slog({ evt: 'amm_capabilities_probe_failed', error: String(err) });
    return null; // best-effort — never blocks quotes or analytics
  }
}

// ─── ABI selectors for eth_call ───────────────────────────────────────────────
// SimpleAMM read functions
const SEL = {
  getReserves:    '0x0902f1ac', // getReserves() → (uint256,uint256)
  totalSupply:    '0x18160ddd', // totalSupply() → uint256
  // LP balance: SimpleAMM IS an ERC-20 LP token — uses standard balanceOf()
  // ⚠️ getLPBalance (0x5dbe4756) does NOT exist on this contract → REVERTS
  getLPBalance:   '0x70a08231', // balanceOf(address) → uint256  [standard ERC-20]
  balanceOf:      '0x70a08231', // balanceOf(address) → uint256
};

// ─── RPC helpers (failover-backed) ───────────────────────────────────────────
function encUint256(val: bigint | number): string {
  return BigInt(val).toString(16).padStart(64, '0');
}
function encAddr(addr: string): string {
  return addr.replace('0x', '').toLowerCase().padStart(64, '0');
}
function decUint256(hex: string): bigint {
  if (!hex || hex === '0x') return 0n;
  return BigInt(hex.startsWith('0x') ? hex : '0x' + hex);
}

// All eth_call traffic goes through the multi-RPC failover client.
async function ethCall(to: string, data: string): Promise<string> {
  return rpcClient.ethCall(to, data);
}

// Wallet-specific reads (not cacheable). Errors PROPAGATE — never silent zeros.
async function fetchLPBalance(wallet: string): Promise<bigint> {
  const result = await ethCall(currentAmm(), SEL.getLPBalance + encAddr(wallet));
  return decUint256(result);
}

async function fetchERC20Balance(tokenAddr: string, wallet: string): Promise<bigint> {
  const result = await ethCall(tokenAddr, SEL.balanceOf + encAddr(wallet));
  return decUint256(result);
}

// ─── AMM formula (pure, mirrors Solidity) ────────────────────────────────────
function getAmountOut(amountIn: bigint, rIn: bigint, rOut: bigint): bigint {
  return ammGetAmountOut(amountIn, rIn, rOut);
}

// ─── Shared helpers (Phase 2) ────────────────────────────────────────────────
function isRpcUnavailable(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === 'RPC_UNAVAILABLE';
}

function rpcUnavailableResponse() {
  return {
    success: false as const,
    code:    'RPC_UNAVAILABLE',
    message: 'Unable to fetch on-chain reserves.',
    error:   'Unable to fetch on-chain reserves.', // compat: frontend lê .error
    source:  'error' as const,
  };
}

function dataSourceLabel(snapshot: { source: string; cacheAge: number }): string {
  return snapshot.source === 'on-chain'
    ? 'on-chain (Arc Testnet RPC)'
    : `cache (verified on-chain ${Math.round(snapshot.cacheAge / 1000)}s ago)`;
}

interface HealthResult {
  classification: PoolClassification;
  impact1000Pct: number | null;
}

// Health is served from the canonical PoolAnalyticsSnapshot — the
// analytics engine memoizes per verified fetch (zero recomputation).
function healthFromAnalytics(analytics: PoolAnalyticsSnapshot): HealthResult {
  return { classification: analytics.poolHealth, impact1000Pct: analytics.impact1000Pct };
}

// ─── GET /api/dex/tokens ──────────────────────────────────────────────────────
dexRouter.get('/tokens', (c) => {
  return c.json({
    success: true,
    tokens:  Object.values(TOKEN_REGISTRY),
    network: { name: 'Arc Testnet', chainId: CHAIN_ID, explorer: EXPLORER },
  });
});

// ─── GET /api/dex/amm ────────────────────────────────────────────────────────
// Returns real on-chain pool state from SimpleAMM contract
dexRouter.get('/amm', async (c) => {
  const isDeployed = currentAmm() !== ZERO_ADDRESS;

  if (!isDeployed) {
    return c.json({
      success:    false,
      deployed:   false,
      ammAddress: currentAmm(),
      message:    'SimpleAMM not yet deployed. Run: node contracts/script/deployAMM.js <PRIVATE_KEY>',
      reserveA:   '0',
      reserveB:   '0',
      totalSupply: '0',
      priceAinB:  '0',
      priceBinA:  '0',
      tvl:        '0',
    });
  }

  try {
    const analytics = await analyticsEngine.getAnalytics();
    const snapshot = analytics; // canonical snapshot (same verified data)
    const { reserveA, reserveB, totalSupply } = snapshot;

    const rA = Number(reserveA) / 1e6;
    const rB = Number(reserveB) / 1e6;
    const health = healthFromAnalytics(analytics);

    slog({
      evt: 'amm_state', source: snapshot.source, cacheAge: snapshot.cacheAge,
      blockNumber: snapshot.blockNumber, tvl: snapshot.tvl,
      poolHealth: health.classification.status,
    });

    return c.json({
      success:     true,
      deployed:    true,
      ammAddress:  snapshot.ammAddress,
      tokenA:      TOKEN_REGISTRY.EURC,
      tokenB:      TOKEN_REGISTRY.USDC,
      reserveA:    reserveA.toString(),
      reserveB:    reserveB.toString(),
      reserveAHuman: rA.toFixed(6),
      reserveBHuman: rB.toFixed(6),
      totalSupply: totalSupply.toString(),
      priceAinB:   snapshot.priceRatio.priceAinB.toFixed(6),   // 1 EURC = X USDC
      priceBinA:   snapshot.priceRatio.priceBinA.toFixed(6),   // 1 USDC = X EURC
      tvl:         snapshot.tvl.toFixed(2), // USDC terms, derived from verified reserves only
      fee: '0.30%',
      // Phase 2 read-only additions (backward compatible)
      source:      snapshot.source,
      cacheAge:    snapshot.cacheAge,
      blockNumber: snapshot.blockNumber,
      reserveRatio: snapshot.reserveRatio,
      poolHealth:  health.classification,
      donationStatus: snapshot.donation.status,
      dataSource:  dataSourceLabel(snapshot),
      network: { name: 'Arc Testnet', chainId: CHAIN_ID, explorer: EXPLORER },
    });
  } catch (err: any) {
    if (isRpcUnavailable(err)) return c.json(rpcUnavailableResponse(), 503);
    return c.json({ success: false, error: err.message, source: 'error' }, 500);
  }
});

// ─── GET /api/dex/amm/lp/:wallet ─────────────────────────────────────────────
dexRouter.get('/amm/lp/:wallet', async (c) => {
  const wallet = c.req.param('wallet');
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return c.json({ success: false, error: 'Invalid wallet address' }, 400);
  }

  try {
    const [lpBalance, snapshot] = await Promise.all([
      fetchLPBalance(wallet),
      dexCache.getSnapshot(),
    ]);
    const { reserveA, reserveB, totalSupply } = snapshot;

    const share = totalSupply > 0n ? Number(lpBalance * 10000n / totalSupply) / 100 : 0;
    const userA = totalSupply > 0n ? Number(lpBalance * reserveA / totalSupply) / 1e6 : 0;
    const userB = totalSupply > 0n ? Number(lpBalance * reserveB / totalSupply) / 1e6 : 0;

    return c.json({
      success:     true,
      wallet,
      ammAddress:  snapshot.ammAddress,
      lpBalance:   lpBalance.toString(),
      lpHuman:     (Number(lpBalance) / 1e6).toFixed(6),
      totalSupply: totalSupply.toString(),
      sharePercent: share.toFixed(4),
      eurcOwned:   userA.toFixed(6),
      usdcOwned:   userB.toFixed(6),
      source:      snapshot.source,
      cacheAge:    snapshot.cacheAge,
      blockNumber: snapshot.blockNumber,
    });
  } catch (err: any) {
    if (isRpcUnavailable(err)) return c.json(rpcUnavailableResponse(), 503);
    return c.json({ success: false, error: err.message, source: 'error' }, 500);
  }
});

// ─── GET /api/dex/amm/quote ──────────────────────────────────────────────────
// ?fromToken=EURC&toToken=USDC&amountIn=1000000
dexRouter.get('/amm/quote', async (c) => {
  const fromToken = c.req.query('fromToken') || 'EURC';
  const toToken   = c.req.query('toToken')   || 'USDC';
  const amountInS = c.req.query('amountIn')  || '0';
  const amountIn  = BigInt(amountInS);

  if (amountIn === 0n) {
    return c.json({ success: false, error: 'amountIn must be > 0' });
  }

  const aToB = fromToken === 'EURC' && toToken === 'USDC';
  const bToA = fromToken === 'USDC' && toToken === 'EURC';

  if (!aToB && !bToA) {
    return c.json({ success: false, error: 'Supported pairs: EURC/USDC or USDC/EURC' });
  }

  try {
    const snapshot = await dexCache.getSnapshot();
    const { reserveA, reserveB } = snapshot;

    if (reserveA === 0n || reserveB === 0n) {
      return c.json({ success: false, error: 'Pool is empty. Add liquidity first.' });
    }

    const rIn  = aToB ? reserveA : reserveB;
    const rOut = aToB ? reserveB : reserveA;

    const amountOut   = getAmountOut(amountIn, rIn, rOut);
    const spotPrice   = aToB
      ? Number(reserveB) / Number(reserveA)
      : Number(reserveA) / Number(reserveB);
    const idealOut    = Number(amountIn) * spotPrice;
    const priceImpact = idealOut > 0
      ? ((idealOut - Number(amountOut)) / idealOut) * 100
      : 0;

    const minOut997 = amountOut * 997n / 1000n; // 0.3% slippage default
    const minOut995 = amountOut * 995n / 1000n; // 0.5%
    const minOut990 = amountOut * 990n / 1000n; // 1%

    slog({
      evt: 'quote', fromToken, toToken, amountIn,
      source: snapshot.source, cacheAge: snapshot.cacheAge, blockNumber: snapshot.blockNumber,
    });

    // Phase 3 Part 2: deadline protection at the quote layer.
    // Best-effort probe (memoized) — never blocks the quote.
    const capabilities = await getAmmCapabilities().catch(() => null);
    const deadline = makeDeadlineGuidance(Date.now(), capabilities);

    return c.json({
      success:      true,
      fromToken,
      toToken,
      amountIn:     amountIn.toString(),
      amountInHuman:(Number(amountIn) / 1e6).toFixed(6),
      amountOut:    amountOut.toString(),
      amountOutHuman:(Number(amountOut) / 1e6).toFixed(6),
      priceImpact:  priceImpact.toFixed(4),
      spotPrice:    spotPrice.toFixed(6),
      fee:          (Number(amountIn) * 0.003 / 1e6).toFixed(6),
      minOut:       {
        '0.3%': minOut997.toString(),
        '0.5%': minOut995.toString(),
        '1.0%': minOut990.toString(),
      },
      reserveA: reserveA.toString(),
      reserveB: reserveB.toString(),
      source:      snapshot.source,
      cacheAge:    snapshot.cacheAge,
      blockNumber: snapshot.blockNumber,
      deadline,
    });
  } catch (err: any) {
    if (isRpcUnavailable(err)) return c.json(rpcUnavailableResponse(), 503);
    return c.json({ success: false, error: err.message, source: 'error' }, 500);
  }
});

// ─── GET /api/dex/amm/balances/:wallet ───────────────────────────────────────
dexRouter.get('/amm/balances/:wallet', async (c) => {
  const wallet = c.req.param('wallet');
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return c.json({ success: false, error: 'Invalid address' }, 400);
  }

  try {
    const [eurcBal, usdcBal, lpBal] = await Promise.all([
      fetchERC20Balance(TOKEN_REGISTRY.EURC.address, wallet),
      fetchERC20Balance(TOKEN_REGISTRY.USDC.address, wallet),
      currentAmm() !== ZERO_ADDRESS
        ? fetchLPBalance(wallet)
        : Promise.resolve(0n),
    ]);

    return c.json({
      success: true,
      wallet,
      balances: {
        EURC: { raw: eurcBal.toString(), human: (Number(eurcBal) / 1e6).toFixed(6) },
        USDC: { raw: usdcBal.toString(), human: (Number(usdcBal) / 1e6).toFixed(6) },
        LP:   { raw: lpBal.toString(),   human: (Number(lpBal)   / 1e6).toFixed(6) },
      },
      source: 'on-chain',
    });
  } catch (err: any) {
    if (isRpcUnavailable(err)) return c.json(rpcUnavailableResponse(), 503);
    return c.json({ success: false, error: err.message, source: 'error' }, 500);
  }
});

// ─── POST /api/dex/amm/config ────────────────────────────────────────────────
// Called after deploy to register contract address
dexRouter.post('/amm/config', async (c) => {
  const body = await c.req.json() as any;
  const addr = body?.ammAddress;
  if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    return c.json({ success: false, error: 'Invalid address' }, 400);
  }
  (globalThis as any).AMM_CONTRACT_ADDRESS = addr;
  dexCache.invalidate(); // snapshot must be re-verified against the new contract
  analyticsEngine.invalidate();
  capabilitiesMemo = null; // re-probe deployed bytecode capabilities
  return c.json({ success: true, ammAddress: addr, message: 'AMM address updated' });
});

// ─── POST /api/dex/amm/deploy ────────────────────────────────────────────────
// Deploys SimpleAMM contract to Arc Testnet using provided private key
// ⚠️ TESTNET ONLY — never use production keys in browser/API calls
dexRouter.post('/amm/deploy', async (c) => {
  return c.json({
    success: false,
    error: 'Use CLI to deploy: node contracts/script/deployAMM.js <PRIVATE_KEY>',
    instructions: [
      '1. Get testnet USDC from https://faucet.circle.com',
      '2. Run: node contracts/script/deployAMM.js 0x<YOUR_PRIVATE_KEY>',
      '3. The contract address will be saved to contracts/out/SimpleAMM.json',
      '4. Call POST /api/dex/amm/config with { "ammAddress": "0x..." } to register',
    ],
  }, 400);
});

// ─── POST /api/dex/swap/record ────────────────────────────────────────────────
// Records an on-chain swap (called after tx confirmed)
const swapHistory: any[] = [];
dexRouter.post('/swap/record', async (c) => {
  try {
    const body = await c.req.json() as any;
    if (!body || typeof body !== 'object') {
      return c.json({ success: false, error: 'Invalid request body' }, 400);
    }
    // Validate critical fields if present
    if (body.txHash && !isValidTxHash(body.txHash)) {
      return c.json({ success: false, error: 'Invalid txHash format' }, 400);
    }
    if (body.walletAddress && !isValidEthAddress(body.walletAddress)) {
      return c.json({ success: false, error: 'Invalid wallet address' }, 400);
    }
    // Sanitise string fields
    const safe = {
      fromToken:     clampString(String(body.fromToken  || ''), 10),
      toToken:       clampString(String(body.toToken    || ''), 10),
      amountIn:      typeof body.amountIn  === 'number' ? body.amountIn  : 0,
      amountOut:     typeof body.amountOut === 'number' ? body.amountOut : 0,
      txHash:        body.txHash        ? clampString(String(body.txHash),        66) : '',
      walletAddress: body.walletAddress ? clampString(String(body.walletAddress), 42) : '',
      status:        clampString(String(body.status || 'completed'), 20),
    };
    swapHistory.unshift({ ...safe, id: `swap-${Date.now()}`, timestamp: Date.now() });
    if (swapHistory.length > 100) swapHistory.pop();
    // A swap changes reserves — force re-verification on next read
    dexCache.invalidate();
    return c.json({ success: true });
  } catch {
    return c.json({ success: false, error: 'Invalid request' }, 400);
  }
});

// ─── POST /api/dex/liquidity/record ──────────────────────────────────────────
const liquidityHistory: any[] = [];
dexRouter.post('/liquidity/record', async (c) => {
  try {
    const body = await c.req.json() as any;
    if (!body || typeof body !== 'object') {
      return c.json({ success: false, error: 'Invalid request body' }, 400);
    }
    if (body.txHash && !isValidTxHash(body.txHash)) {
      return c.json({ success: false, error: 'Invalid txHash format' }, 400);
    }
    if (body.walletAddress && !isValidEthAddress(body.walletAddress)) {
      return c.json({ success: false, error: 'Invalid wallet address' }, 400);
    }
    const safe = {
      action:        clampString(String(body.action || 'add'), 10),
      tokenA:        clampString(String(body.tokenA || ''), 10),
      tokenB:        clampString(String(body.tokenB || ''), 10),
      amountA:       typeof body.amountA === 'number' ? body.amountA : 0,
      amountB:       typeof body.amountB === 'number' ? body.amountB : 0,
      txHash:        body.txHash        ? clampString(String(body.txHash),        66) : '',
      walletAddress: body.walletAddress ? clampString(String(body.walletAddress), 42) : '',
    };
    liquidityHistory.unshift({ ...safe, id: `liq-${Date.now()}`, timestamp: Date.now() });
    if (liquidityHistory.length > 100) liquidityHistory.pop();
    // Liquidity changes reserves — force re-verification on next read
    dexCache.invalidate();
    return c.json({ success: true });
  } catch {
    return c.json({ success: false, error: 'Invalid request' }, 400);
  }
});

// ─── GET /api/dex/history ─────────────────────────────────────────────────────
dexRouter.get('/history', (c) => {
  return c.json({
    success:   true,
    swaps:     swapHistory.slice(0, 20),
    liquidity: liquidityHistory.slice(0, 20),
  });
});

// ─── GET /api/dex/pool (Phase 2) ─────────────────────────────────────────────
// Structured pool state from the verified DEX cache
dexRouter.get('/pool', async (c) => {
  try {
    const snapshot = await analyticsEngine.getAnalytics();
    const health = healthFromAnalytics(snapshot);
    return c.json({
      success: true,
      pool: {
        ammAddress: snapshot.ammAddress,
        tokenA: { ...TOKEN_REGISTRY.EURC, reserve: snapshot.reserveA.toString(), reserveHuman: (Number(snapshot.reserveA) / 1e6).toFixed(6) },
        tokenB: { ...TOKEN_REGISTRY.USDC, reserve: snapshot.reserveB.toString(), reserveHuman: (Number(snapshot.reserveB) / 1e6).toFixed(6) },
        totalSupplyLP: snapshot.totalSupply.toString(),
        totalSupplyLPHuman: (Number(snapshot.totalSupply) / 1e6).toFixed(6),
        fee: '0.30%',
        tvl: snapshot.tvl,
        reserveRatio: snapshot.reserveRatio,
        priceRatio: snapshot.priceRatio,
        poolHealth: health.classification,
        donationStatus: snapshot.donation.status,
        source: snapshot.source,
        cacheAge: snapshot.cacheAge,
        blockNumber: snapshot.blockNumber,
        dataSource: dataSourceLabel(snapshot),
        explorer: `${EXPLORER}/address/${snapshot.ammAddress}`,
      },
      network: { name: 'Arc Testnet', chainId: CHAIN_ID, explorer: EXPLORER },
    });
  } catch (err: any) {
    if (isRpcUnavailable(err)) return c.json(rpcUnavailableResponse(), 503);
    return c.json({ success: false, error: err.message, source: 'error' }, 500);
  }
});

// ─── GET /api/dex/rates (Phase 2) ────────────────────────────────────────────
dexRouter.get('/rates', async (c) => {
  try {
    const snapshot = await analyticsEngine.getAnalytics();
    return c.json({
      success: true,
      rates: {
        EURC_TO_USDC: snapshot.priceRatio.priceAinB,
        USDC_TO_EURC: snapshot.priceRatio.priceBinA,
        ammAddress: snapshot.ammAddress,
        updatedAt: new Date().toISOString(),
      },
      source: snapshot.source,
      cacheAge: snapshot.cacheAge,
      blockNumber: snapshot.blockNumber,
      network: { name: 'Arc Testnet', chainId: CHAIN_ID, explorer: EXPLORER },
    });
  } catch (err: any) {
    if (isRpcUnavailable(err)) return c.json(rpcUnavailableResponse(), 503);
    return c.json({ success: false, error: err.message, source: 'error' }, 500);
  }
});

// ─── GET /api/dex/stats (Phase 2) ────────────────────────────────────────────
dexRouter.get('/stats', async (c) => {
  try {
    const snapshot = await analyticsEngine.getAnalytics();
    const health = healthFromAnalytics(snapshot);
    const minimumLiquidity: string | null = snapshot.lpMetrics.minimumLiquidityLock;

    slog({
      evt: 'stats', source: snapshot.source, blockNumber: snapshot.blockNumber,
      tvl: snapshot.tvl, poolHealth: health.classification.status,
      donationStatus: snapshot.donation.status,
    });

    return c.json({
      success: true,
      stats: {
        tvl: snapshot.tvl,
        reserveRatio: snapshot.reserveRatio,
        priceRatio: snapshot.priceRatio,
        lpSupply: snapshot.totalSupply.toString(),
        lpSupplyHuman: (Number(snapshot.totalSupply) / 1e6).toFixed(6),
        lpValueIndex: calcLpValueIndex(snapshot.reserveA, snapshot.reserveB, snapshot.totalSupply),
        minimumLiquidity,
        impact1000Pct: health.impact1000Pct,
        poolHealth: health.classification,
        donation: snapshot.donation,
        blockNumber: snapshot.blockNumber,
      },
      source: snapshot.source,
      cacheAge: snapshot.cacheAge,
      blockNumber: snapshot.blockNumber,
    });
  } catch (err: any) {
    if (isRpcUnavailable(err)) return c.json(rpcUnavailableResponse(), 503);
    return c.json({ success: false, error: err.message, source: 'error' }, 500);
  }
});

// ─── GET /api/dex/health (Phase 2 Part 3 — read-only) ────────────────────────
dexRouter.get('/health', async (c) => {
  try {
    const snapshot = await analyticsEngine.getAnalytics();
    const health = healthFromAnalytics(snapshot);
    const minimumLiquidity: string | null = snapshot.lpMetrics.minimumLiquidityLock;

    slog({
      evt: 'pool_health', status: health.classification.status,
      tvl: snapshot.tvl, impact1000Pct: health.impact1000Pct,
      blockNumber: snapshot.blockNumber, source: snapshot.source,
    });

    return c.json({
      success: true,
      health: {
        status: health.classification.status,
        label: health.classification.label,
        reasons: health.classification.reasons,
        metrics: {
          tvl: snapshot.tvl,
          reserveRatio: snapshot.reserveRatio,
          priceRatio: snapshot.priceRatio,
          liquidityDepthImpact1000Usdc: health.impact1000Pct,
          poolUtilization: snapshot.lpMetrics.utilization,
          lpSupply: snapshot.totalSupply.toString(),
          minimumLiquidity,
          reserveA: snapshot.reserveA.toString(),
          reserveB: snapshot.reserveB.toString(),
          donationStatus: snapshot.donation.status,
        },
        blockNumber: snapshot.blockNumber,
        timestamp: new Date(snapshot.timestamp).toISOString(),
      },
      source: snapshot.source,
      cacheAge: snapshot.cacheAge,
      blockNumber: snapshot.blockNumber,
    });
  } catch (err: any) {
    if (isRpcUnavailable(err)) return c.json(rpcUnavailableResponse(), 503);
    return c.json({ success: false, error: err.message, source: 'error' }, 500);
  }
});

// ─── GET /api/dex/depth (Phase 2 Part 4 — read-only simulator) ───────────────
dexRouter.get('/depth', async (c) => {
  try {
    const snapshot = await analyticsEngine.getAnalytics();
    const levels = snapshot.liquidityDepth;

    slog({
      evt: 'depth_calc', blockNumber: snapshot.blockNumber, source: snapshot.source,
      levels: levels.map((l) => ({ in: l.amountIn, impact: l.priceImpact })),
    });

    return c.json({
      success: true,
      direction: 'USDC_TO_EURC',
      depth: levels,
      reserves: {
        EURC: snapshot.reserveA.toString(),
        USDC: snapshot.reserveB.toString(),
      },
      source: snapshot.source,
      cacheAge: snapshot.cacheAge,
      blockNumber: snapshot.blockNumber,
    });
  } catch (err: any) {
    if (isRpcUnavailable(err)) return c.json(rpcUnavailableResponse(), 503);
    return c.json({ success: false, error: err.message, source: 'error' }, 500);
  }
});

// ─── GET /api/dex/donation (Phase 2 Part 5 — read-only monitor) ──────────────
dexRouter.get('/donation', async (c) => {
  try {
    const snapshot = await analyticsEngine.getAnalytics();

    slog({
      evt: 'donation_check', status: snapshot.donation.status,
      excessCount: snapshot.donation.excess.length,
      blockNumber: snapshot.blockNumber, source: snapshot.source,
    });

    return c.json({
      success: true,
      donation: snapshot.donation,
      balances: {
        EURC: { tracked: snapshot.reserveA.toString(), actual: snapshot.balanceA.toString() },
        USDC: { tracked: snapshot.reserveB.toString(), actual: snapshot.balanceB.toString() },
      },
      source: snapshot.source,
      cacheAge: snapshot.cacheAge,
      blockNumber: snapshot.blockNumber,
    });
  } catch (err: any) {
    if (isRpcUnavailable(err)) return c.json(rpcUnavailableResponse(), 503);
    return c.json({ success: false, error: err.message, source: 'error' }, 500);
  }
});

// ─── GET /api/dex/lp (Phase 3 Part 4 — LP Analytics Engine, read-only) ───────
// Optional ?wallet=0x... → adds the wallet's LP position (share %, withdrawal
// estimate, USDC value). All values derive from verified reserves only.
dexRouter.get('/lp', async (c) => {
  const wallet = c.req.query('wallet');
  if (wallet && !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return c.json({ success: false, error: 'Invalid wallet address' }, 400);
  }

  try {
    const snapshot = await analyticsEngine.getAnalytics();

    let position = null;
    if (wallet) {
      const lpBalance = await fetchLPBalance(wallet);
      position = calcLpPosition(snapshot, lpBalance);
    }

    slog({
      evt: 'lp_analytics', blockNumber: snapshot.blockNumber, source: snapshot.source,
      lpSupply: snapshot.totalSupply, lpHealth: snapshot.lpMetrics.lpHealth,
      hasWallet: !!wallet,
    });

    return c.json({
      success: true,
      lp: {
        ...snapshot.lpMetrics,
        tvl: snapshot.tvl,
        priceRatio: snapshot.priceRatio,
        position,
      },
      source: snapshot.source,
      cacheAge: snapshot.cacheAge,
      blockNumber: snapshot.blockNumber,
    });
  } catch (err: any) {
    if (isRpcUnavailable(err)) return c.json(rpcUnavailableResponse(), 503);
    return c.json({ success: false, error: err.message, source: 'error' }, 500);
  }
});

// ─── GET /api/dex/liquidity-analysis (Phase 3 Part 3 — informational only) ───
// ?amountA=<EURC human>&amountB=<USDC human>
// Verdict: OPTIMAL or WARNING: EXCESS TOKENS WILL BE DONATED.
// The transaction is NEVER modified — pre-submission analysis only.
dexRouter.get('/liquidity-analysis', async (c) => {
  const amountAStr = c.req.query('amountA') || '0';
  const amountBStr = c.req.query('amountB') || '0';
  const amountAF = parseFloat(amountAStr);
  const amountBF = parseFloat(amountBStr);

  if (!Number.isFinite(amountAF) || !Number.isFinite(amountBF) || amountAF <= 0 || amountBF <= 0) {
    return c.json({ success: false, error: 'amountA (EURC) and amountB (USDC) must be positive numbers' }, 400);
  }

  try {
    const snapshot = await analyticsEngine.getAnalytics();
    const amountA = BigInt(Math.round(amountAF * 1e6));
    const amountB = BigInt(Math.round(amountBF * 1e6));
    const analysis = analyzeLiquidityAddition(snapshot, amountA, amountB);

    slog({
      evt: 'liquidity_analysis', amountA, amountB,
      verdict: analysis.verdict || 'INVALID',
      donationUsdc: analysis.donation ? analysis.donation.totalUsdc : null,
      blockNumber: snapshot.blockNumber, source: snapshot.source,
    });

    return c.json({
      success: true,
      analysis,
      input: { amountA: amountAF, amountB: amountBF, tokenA: 'EURC', tokenB: 'USDC' },
      reserves: {
        EURC: snapshot.reserveA.toString(),
        USDC: snapshot.reserveB.toString(),
      },
      source: snapshot.source,
      cacheAge: snapshot.cacheAge,
      blockNumber: snapshot.blockNumber,
    });
  } catch (err: any) {
    if (isRpcUnavailable(err)) return c.json(rpcUnavailableResponse(), 503);
    return c.json({ success: false, error: err.message, source: 'error' }, 500);
  }
});

// ─── GET /api/dex/risk (Phase 3 Part 6 — Risk Engine, informational only) ────
dexRouter.get('/risk', async (c) => {
  try {
    const snapshot = await analyticsEngine.getAnalytics();

    slog({
      evt: 'risk_assessment', overall: snapshot.risk.overall,
      blockNumber: snapshot.blockNumber, source: snapshot.source,
    });

    return c.json({
      success: true,
      risk: snapshot.risk,
      context: {
        tvl: snapshot.tvl,
        priceRatio: snapshot.priceRatio,
        impact1000Pct: snapshot.impact1000Pct,
        donationStatus: snapshot.donationStatus,
        poolHealth: snapshot.poolHealth.status,
      },
      source: snapshot.source,
      cacheAge: snapshot.cacheAge,
      blockNumber: snapshot.blockNumber,
    });
  } catch (err: any) {
    if (isRpcUnavailable(err)) return c.json(rpcUnavailableResponse(), 503);
    return c.json({ success: false, error: err.message, source: 'error' }, 500);
  }
});

// ─── GET /api/dex/analytics (Phase 3 Part 5 — canonical snapshot) ────────────
dexRouter.get('/analytics', async (c) => {
  try {
    const snapshot = await analyticsEngine.getAnalytics();
    const capabilities = await getAmmCapabilities().catch(() => null);
    const twap = analyzeTwapFeasibility(capabilities);
    const deadline = makeDeadlineGuidance(Date.now(), capabilities);

    return c.json({
      success: true,
      analytics: {
        ammAddress: snapshot.ammAddress,
        reserveA: snapshot.reserveA.toString(),
        reserveB: snapshot.reserveB.toString(),
        totalSupply: snapshot.totalSupply.toString(),
        tvl: snapshot.tvl,
        priceRatio: snapshot.priceRatio,
        reserveRatio: snapshot.reserveRatio,
        liquidityDepth: snapshot.liquidityDepth,
        donationStatus: snapshot.donationStatus,
        donation: snapshot.donation,
        poolHealth: snapshot.poolHealth,
        lpMetrics: snapshot.lpMetrics,
        risk: snapshot.risk,
        blockNumber: snapshot.blockNumber,
        timestamp: new Date(snapshot.timestamp).toISOString(),
        source: snapshot.source,
      },
      contract: {
        capabilities,
        twapFeasibility: twap,
        deadline,
        compatibilityReport: 'audit/PHASE3_COMPATIBILITY_REPORT.md',
      },
      source: snapshot.source,
      cacheAge: snapshot.cacheAge,
      blockNumber: snapshot.blockNumber,
    });
  } catch (err: any) {
    if (isRpcUnavailable(err)) return c.json(rpcUnavailableResponse(), 503);
    return c.json({ success: false, error: err.message, source: 'error' }, 500);
  }
});

// ─── Legacy routes (kept for compatibility) ───────────────────────────────────
dexRouter.get('/pools', async (c) => {
  try {
    const snapshot = await dexCache.getSnapshot();
    return c.json({
      success: true,
      pools: [{
        id:               'EURC-USDC',
        tokenA:           'EURC',
        tokenB:           'USDC',
        addressA:         TOKEN_REGISTRY.EURC.address,
        addressB:         TOKEN_REGISTRY.USDC.address,
        reserveA:         Number(snapshot.reserveA),
        reserveB:         Number(snapshot.reserveB),
        reserveAFormatted: (Number(snapshot.reserveA) / 1e6).toFixed(6),
        reserveBFormatted: (Number(snapshot.reserveB) / 1e6).toFixed(6),
        priceRatio:       { priceAinB: snapshot.priceRatio.priceAinB, priceBinA: snapshot.priceRatio.priceBinA },
        totalLiquidity:   Number(snapshot.totalSupply),
        tvl:              snapshot.tvl,
        fee:              0.003,
        ammAddress:       snapshot.ammAddress,
      }],
      analytics: { totalPools: 1, tvlTotal: snapshot.tvl, vol24h: 0, fees24h: 0 },
      source: snapshot.source,
      cacheAge: snapshot.cacheAge,
      blockNumber: snapshot.blockNumber,
    });
  } catch (err: any) {
    if (isRpcUnavailable(err)) return c.json(rpcUnavailableResponse(), 503);
    return c.json({ success: false, error: err.message, source: 'error' }, 500);
  }
});

// Keep /api/dex/liquidity/add for backward compat
dexRouter.post('/liquidity/add', async (c) => {
  try {
    const body = await c.req.json() as any;
    if (!body || typeof body !== 'object') {
      return c.json({ success: false, error: 'Invalid request body' }, 400);
    }
    return c.json({ success: true, message: 'Recorded' });
  } catch {
    return c.json({ success: false, error: 'Invalid request' }, 400);
  }
});

// ─── PoolFactory endpoints ─────────────────────────────────────────────────────

// Factory address — update after deploying with deployPoolFactory.js
const FACTORY_ADDRESS: string = (globalThis as any).FACTORY_ADDRESS
  || '0x0000000000000000000000000000000000000000';

// Minimal PoolFactory ABI for read operations
const FACTORY_ABI = [
  'function getAllPools() view returns (address[])',
  'function getPoolCount() view returns (uint256)',
  'function findPool(address,address,uint256) view returns (address)',
  'function createPool(address,address,uint256,string,string) returns (address)',
  'event PoolCreated(address indexed token0, address indexed token1, uint256 feeBps, address pool, uint256 poolIndex)',
];

// Minimal LiquidityPool ABI for read operations
const LP_POOL_ABI = [
  'function getReserves() view returns (uint256,uint256)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function feeBps() view returns (uint256)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function quoteSwap(uint256,bool) view returns (uint256)',
];

function getTokenInfo(addr: string) {
  const lower = addr.toLowerCase();
  const eurcAddr = TOKEN_REGISTRY.EURC.address.toLowerCase();
  const usdcAddr = TOKEN_REGISTRY.USDC.address.toLowerCase();
  if (lower === eurcAddr) return { symbol: 'EURC', decimals: 6 };
  if (lower === usdcAddr) return { symbol: 'USDC', decimals: 6 };
  return { symbol: addr.slice(0, 6) + '\u2026' + addr.slice(-4), decimals: 6 };
}

// Decode string from eth_call result (offset at 32 bytes, then length, then string)
function decodeString(hex: string): string {
  if (!hex || hex === '0x') return '';
  const data = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (data.length < 128) return '';
  const offset = parseInt(data.slice(0, 64), 16) * 2;
  const length = parseInt(data.slice(offset, offset + 64), 16) * 2;
  const strHex = data.slice(offset + 64, offset + 64 + length);
  let str = '';
  for (let i = 0; i < strHex.length; i += 2) str += String.fromCharCode(parseInt(strHex.slice(i, i + 2), 16));
  return str;
}

// GET /api/dex/factory/pools — list all factory pools + legacy pool
dexRouter.get('/factory/pools', async (c) => {
  try {
    const pools: any[] = [];

    // Legacy pool — from verified DEX cache (failover + TTL)
    try {
      const snapshot = await dexCache.getSnapshot();
      pools.push({
        address: snapshot.ammAddress,
        token0: TOKEN_REGISTRY.EURC.address, token1: TOKEN_REGISTRY.USDC.address,
        token0Symbol: 'EURC', token1Symbol: 'USDC',
        feeBps: 30, feePct: '0.30',
        reserve0: snapshot.reserveA.toString(), reserve1: snapshot.reserveB.toString(),
        totalSupply: snapshot.totalSupply.toString(),
        isLegacy: true,
        name: 'USDC / EURC',
        source: snapshot.source,
        blockNumber: snapshot.blockNumber,
      });
    } catch (_) { /* legacy pool unavailable — factory pools may still resolve */ }

    // Factory pools
    if (FACTORY_ADDRESS !== '0x0000000000000000000000000000000000000000') {
      try {
        // getPoolCount() → uint256
        const countHex = await ethCall(FACTORY_ADDRESS, '0x2e1a7d4d');
        const count = Number(decUint256(countHex));
        // allPools(uint256) → address
        for (let i = 0; i < Math.min(count, 50); i++) {
          try {
            const idxHex = encUint256(i);
            const addrRes = await ethCall(FACTORY_ADDRESS, '0xb5d3ca00' + idxHex);
            const addr = '0x' + (addrRes || '').slice(26, 66);
            if (addr === '0x' + '0'.repeat(40)) continue;

            const [t0Hex, t1Hex, feeHex, nameHex, symHex, tsHex2, resHex2] = await Promise.all([
              ethCall(addr, '0x0dfe1681'),
              ethCall(addr, '0xd21220a7'),
              ethCall(addr, '0x5404911a'),
              ethCall(addr, '0x06fdde03'),
              ethCall(addr, '0x95d89b41'),
              ethCall(addr, '0x18160ddd'),
              ethCall(addr, '0x0902f1ac'),
            ]);

            const t0 = '0x' + (t0Hex || '').slice(26, 66);
            const t1 = '0x' + (t1Hex || '').slice(26, 66);
            const t0Info = getTokenInfo(t0);
            const t1Info = getTokenInfo(t1);

            pools.push({
              address: addr, token0: t0, token1: t1,
              token0Symbol: t0Info.symbol, token1Symbol: t1Info.symbol,
              feeBps: Number(decUint256(feeHex)),
              feePct: (Number(decUint256(feeHex)) / 100).toFixed(2),
              reserve0: decUint256('0x' + (resHex2 || '').slice(2, 66)).toString(),
              reserve1: decUint256('0x' + (resHex2 || '').slice(66, 130)).toString(),
              totalSupply: decUint256(tsHex2).toString(),
              isLegacy: false,
              name: decodeString(nameHex),
              symbol: decodeString(symHex),
            });
          } catch (_) {}
        }
      } catch (_) {}
    }

    return c.json({ success: true, pools });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// GET /api/dex/factory/info
dexRouter.get('/factory/info', async (c) => {
  try {
    const info: any = { factoryAddress: FACTORY_ADDRESS, legacyPool: currentAmm(), poolCount: 1, factoryPoolCount: 0 };
    if (FACTORY_ADDRESS !== '0x0000000000000000000000000000000000000000') {
      try {
        const countHex = await ethCall(FACTORY_ADDRESS, '0x2e1a7d4d');
        info.factoryPoolCount = Number(decUint256(countHex));
        info.poolCount = 1 + info.factoryPoolCount;
      } catch (_) {}
    }
    return c.json({ success: true, ...info });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

export default dexRouter;
