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
// ============================================================

import { Hono } from 'hono';
import { isValidEthAddress, isValidTxHash, clampString, sanitizeForLog } from '../middleware/security';

const dexRouter = new Hono();

// ─── Network / Token Config ───────────────────────────────────────────────────
const ARC_RPC    = 'https://rpc.testnet.arc.network';
const CHAIN_ID   = 5042002;
const EXPLORER   = 'https://testnet.arcscan.app';

// SimpleAMM deployed on Arc Testnet — 2026-03-16
// Deploy tx: 0x35d96b9659ab438b84c606c6d47d16c883388b6552465a21f9a97d75680c5022
// ArcScan: https://testnet.arcscan.app/address/0x3148E2807F172D1cC354F35fB4fC4104e8b6b561
const AMM_ADDRESS: string = (globalThis as any).AMM_CONTRACT_ADDRESS
  || '0x3148E2807F172D1cC354F35fB4fC4104e8b6b561';

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

// ─── ABI selectors for eth_call ───────────────────────────────────────────────
// SimpleAMM read functions
const SEL = {
  getReserves:    '0x0902f1ac', // getReserves() → (uint256,uint256)
  totalSupply:    '0x18160ddd', // totalSupply() → uint256
  // LP balance: SimpleAMM IS an ERC-20 LP token — uses standard balanceOf()
  // ⚠️ getLPBalance (0x5dbe4756) does NOT exist on this contract → REVERTS
  getLPBalance:   '0x70a08231', // balanceOf(address) → uint256  [standard ERC-20]
  quoteAforB:     '0x9d33be0f', // quoteAforB(uint256) → uint256
  quoteBforA:     '0xf99bbd0c', // quoteBforA(uint256) → uint256
  priceImpactBps: '0x6e0e1a2d', // priceImpactBps(uint256,bool) → uint256
  // ERC-20
  balanceOf:      '0x70a08231', // balanceOf(address) → uint256
};

// ─── RPC helpers ─────────────────────────────────────────────────────────────
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

async function ethCall(to: string, data: string): Promise<string> {
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'eth_call',
    params: [{ to, data }, 'latest'],
  });
  const res = await fetch(ARC_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  const json = await res.json() as any;
  if (json.error) throw new Error(json.error.message);
  return json.result as string;
}

// ─── On-Chain reads ───────────────────────────────────────────────────────────
async function fetchReserves(): Promise<{ reserveA: bigint; reserveB: bigint }> {
  try {
    const result = await ethCall(AMM_ADDRESS, SEL.getReserves);
    if (!result || result === '0x') return { reserveA: 0n, reserveB: 0n };
    // Returns 2×uint256
    const reserveA = decUint256('0x' + result.slice(2, 66));
    const reserveB = decUint256('0x' + result.slice(66, 130));
    return { reserveA, reserveB };
  } catch {
    return { reserveA: 0n, reserveB: 0n };
  }
}

async function fetchTotalSupply(): Promise<bigint> {
  try {
    const result = await ethCall(AMM_ADDRESS, SEL.totalSupply);
    return decUint256(result);
  } catch {
    return 0n;
  }
}

async function fetchLPBalance(wallet: string): Promise<bigint> {
  try {
    const data   = SEL.getLPBalance + encAddr(wallet);
    const result = await ethCall(AMM_ADDRESS, data);
    return decUint256(result);
  } catch {
    return 0n;
  }
}

async function fetchERC20Balance(tokenAddr: string, wallet: string): Promise<bigint> {
  try {
    const data   = SEL.balanceOf + encAddr(wallet);
    const result = await ethCall(tokenAddr, data);
    return decUint256(result);
  } catch {
    return 0n;
  }
}

// ─── AMM formula (pure, mirrors Solidity) ────────────────────────────────────
function getAmountOut(amountIn: bigint, rIn: bigint, rOut: bigint): bigint {
  if (amountIn === 0n || rIn === 0n || rOut === 0n) return 0n;
  const amountInWithFee = amountIn * 997n;
  const numerator       = amountInWithFee * rOut;
  const denominator     = rIn * 1000n + amountInWithFee;
  return numerator / denominator;
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
  const isDeployed = AMM_ADDRESS !== '0x0000000000000000000000000000000000000000';

  if (!isDeployed) {
    return c.json({
      success:    false,
      deployed:   false,
      ammAddress: AMM_ADDRESS,
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
    const [{ reserveA, reserveB }, totalSupply] = await Promise.all([
      fetchReserves(),
      fetchTotalSupply(),
    ]);

    const rA = Number(reserveA) / 1e6;
    const rB = Number(reserveB) / 1e6;
    const priceAinB = rA > 0 ? (rB / rA).toFixed(6) : '0';
    const priceBinA = rB > 0 ? (rA / rB).toFixed(6) : '0';
    const tvl = (rA * 1.09 + rB * 1.0).toFixed(2); // EURC≈1.09 USD

    return c.json({
      success:     true,
      deployed:    true,
      ammAddress:  AMM_ADDRESS,
      tokenA:      TOKEN_REGISTRY.EURC,
      tokenB:      TOKEN_REGISTRY.USDC,
      reserveA:    reserveA.toString(),
      reserveB:    reserveB.toString(),
      reserveAHuman: rA.toFixed(6),
      reserveBHuman: rB.toFixed(6),
      totalSupply: totalSupply.toString(),
      priceAinB,   // 1 EURC = X USDC
      priceBinA,   // 1 USDC = X EURC
      tvl,
      fee: '0.30%',
      network: { name: 'Arc Testnet', chainId: CHAIN_ID, explorer: EXPLORER },
    });
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

// ─── GET /api/dex/amm/lp/:wallet ─────────────────────────────────────────────
dexRouter.get('/amm/lp/:wallet', async (c) => {
  const wallet = c.req.param('wallet');
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return c.json({ success: false, error: 'Invalid wallet address' }, 400);
  }

  try {
    const [lpBalance, totalSupply, { reserveA, reserveB }] = await Promise.all([
      fetchLPBalance(wallet),
      fetchTotalSupply(),
      fetchReserves(),
    ]);

    const share = totalSupply > 0n ? Number(lpBalance * 10000n / totalSupply) / 100 : 0;
    const userA = totalSupply > 0n ? Number(lpBalance * reserveA / totalSupply) / 1e6 : 0;
    const userB = totalSupply > 0n ? Number(lpBalance * reserveB / totalSupply) / 1e6 : 0;

    return c.json({
      success:     true,
      wallet,
      ammAddress:  AMM_ADDRESS,
      lpBalance:   lpBalance.toString(),
      lpHuman:     (Number(lpBalance) / 1e6).toFixed(6),
      totalSupply: totalSupply.toString(),
      sharePercent: share.toFixed(4),
      eurcOwned:   userA.toFixed(6),
      usdcOwned:   userB.toFixed(6),
    });
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 500);
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
    const { reserveA, reserveB } = await fetchReserves();

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
    });
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 500);
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
      AMM_ADDRESS !== '0x0000000000000000000000000000000000000000'
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
    });
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 500);
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

// ─── Legacy routes (kept for compatibility) ───────────────────────────────────
dexRouter.get('/pools', async (c) => {
  // Redirect to new AMM endpoint
  const ammRes = await fetch(`http://localhost:3000/api/dex/amm`).catch(() => null);
  if (ammRes?.ok) {
    const data = await ammRes.json() as any;
    if (data.success && data.deployed) {
      return c.json({
        success: true,
        pools: [{
          id:               'EURC-USDC',
          tokenA:           'EURC',
          tokenB:           'USDC',
          addressA:         TOKEN_REGISTRY.EURC.address,
          addressB:         TOKEN_REGISTRY.USDC.address,
          reserveA:         Number(data.reserveA),
          reserveB:         Number(data.reserveB),
          reserveAFormatted: data.reserveAHuman,
          reserveBFormatted: data.reserveBHuman,
          priceRatio:       { priceAinB: parseFloat(data.priceAinB), priceBinA: parseFloat(data.priceBinA) },
          totalLiquidity:   Number(data.totalSupply),
          tvl:              parseFloat(data.tvl),
          fee:              0.003,
          ammAddress:       data.ammAddress,
        }],
        analytics: { totalPools: 1, tvlTotal: parseFloat(data.tvl), vol24h: 0, fees24h: 0 },
      });
    }
  }
  return c.json({ success: true, pools: [], analytics: { totalPools: 0, tvlTotal: 0, vol24h: 0, fees24h: 0 } });
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

    // Legacy pool
    try {
      const [resHex, tsHex] = await Promise.all([
        ethCall(AMM_ADDRESS, SEL.getReserves),
        ethCall(AMM_ADDRESS, SEL.totalSupply),
      ]);
      const resA = decUint256('0x' + (resHex || '').slice(2, 66));
      const resB = decUint256('0x' + (resHex || '').slice(66, 130));
      pools.push({
        address: AMM_ADDRESS,
        token0: TOKEN_A, token1: TOKEN_B,
        token0Symbol: 'EURC', token1Symbol: 'USDC',
        feeBps: 30, feePct: '0.30',
        reserve0: resA.toString(), reserve1: resB.toString(),
        totalSupply: decUint256(tsHex).toString(),
        isLegacy: true,
        name: 'USDC / EURC',
      });
    } catch (_) {}

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
    const info: any = { factoryAddress: FACTORY_ADDRESS, legacyPool: AMM_ADDRESS, poolCount: 1, factoryPoolCount: 0 };
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
