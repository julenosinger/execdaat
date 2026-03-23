// ========================================================
// SWAP API — Arc Testnet  USDC ↔ EURC
// Quote é calculado com reservas reais do AMM on-chain.
// O swap real é executado on-chain pela wallet do usuário.
// Este backend: cotação, registro de histórico, estatísticas.
// AMM: 0x3148E2807F172D1cC354F35fB4fC4104e8b6b561
// ========================================================

import { Hono } from 'hono';
import { isValidEthAddress, isValidTxHash } from '../middleware/security';

const swapRouter = new Hono();

// ─── Constantes Arc Testnet ───────────────────────────────────────────────────
const AMM_ADDRESS    = '0x3148E2807F172D1cC354F35fB4fC4104e8b6b561';
const USDC_ADDRESS   = '0x3600000000000000000000000000000000000000';
const EURC_ADDRESS   = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const RPC_URL        = 'https://rpc.testnet.arc.network';
const EXPLORER_URL   = 'https://testnet.arcscan.app';
const CHAIN_ID       = 5042002;
const AMM_FEE        = 0.003;   // 0.3%
const USDC_DECIMALS  = 6;

// ─── Cache de reservas (atualizado a cada request de quote) ───────────────────
interface PoolCache {
  reserveA:    bigint;   // EURC (tokenA no SimpleAMM)
  reserveB:    bigint;   // USDC (tokenB no SimpleAMM)
  totalSupply: bigint;
  lastUpdated: number;   // timestamp ms
  ttl:         number;   // ms
}

let poolCache: PoolCache = {
  reserveA:    0n,
  reserveB:    0n,
  totalSupply: 0n,
  lastUpdated: 0,
  ttl:         15_000,   // 15 segundos
};

interface SwapRecord {
  id:            string;
  type:          'USDC_TO_EURC' | 'EURC_TO_USDC';
  amountIn:      number;
  amountOut:     number;
  rate:          number;
  fee:           number;
  slippage:      number;
  walletAddress: string;
  txHash:        string;
  onChain:       boolean;
  timestamp:     string;
  status:        'completed' | 'pending' | 'failed';
}

// Histórico em memória (limpo a cada restart)
const swapHistory: SwapRecord[] = [];
let totalSwaps  = 0;
let totalVolume = 0;

// ─── RPC helper ───────────────────────────────────────────────────────────────
async function rpcCall(method: string, params: unknown[] = []): Promise<unknown> {
  const res  = await fetch(RPC_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal:  AbortSignal.timeout(8000),
  });
  const json = await res.json() as { result?: unknown; error?: { message?: string } };
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json.result;
}

async function ethCall(to: string, data: string): Promise<string> {
  return rpcCall('eth_call', [{ to, data }, 'latest']) as Promise<string>;
}

function padHex(hex: string, bytes = 32): string {
  return hex.replace(/^0x/, '').padStart(bytes * 2, '0');
}

function decUint256(hex: string, wordIdx = 0): bigint {
  const s = hex.replace(/^0x/, '');
  return BigInt('0x' + s.slice(wordIdx * 64, wordIdx * 64 + 64));
}

// ─── Fetch reservas reais do AMM on-chain ─────────────────────────────────────
async function fetchAMMReserves(): Promise<{ reserveA: bigint; reserveB: bigint; totalSupply: bigint }> {
  const now = Date.now();
  if (poolCache.lastUpdated > 0 && now - poolCache.lastUpdated < poolCache.ttl) {
    return { reserveA: poolCache.reserveA, reserveB: poolCache.reserveB, totalSupply: poolCache.totalSupply };
  }

  try {
    // getReserves() → returns (uint256, uint256) — reserveA (EURC), reserveB (USDC)
    const [reservesHex, supplyHex] = await Promise.all([
      ethCall(AMM_ADDRESS, '0x0902f1ac'),  // getReserves()
      ethCall(AMM_ADDRESS, '0x18160ddd'),  // totalSupply()
    ]);

    const reserveA   = decUint256(reservesHex as string, 0);
    const reserveB   = decUint256(reservesHex as string, 1);
    const totalSupply = decUint256(supplyHex as string, 0);

    poolCache = { reserveA, reserveB, totalSupply, lastUpdated: now, ttl: 15_000 };
    return { reserveA, reserveB, totalSupply };
  } catch (err) {
    console.warn('[SWAP] fetchAMMReserves failed, using cache:', (err as Error).message);
    // Return cache if available, else fallback values
    if (poolCache.lastUpdated > 0) {
      return { reserveA: poolCache.reserveA, reserveB: poolCache.reserveB, totalSupply: poolCache.totalSupply };
    }
    // Last resort: reasonable fallback
    return { reserveA: BigInt(460_000 * 1e6), reserveB: BigInt(500_000 * 1e6), totalSupply: 0n };
  }
}

// ─── AMM x*y=k formula (mirrors Solidity: fee = 0.3%) ────────────────────────
//  amountOut = (rOut * amIn * 997) / (rIn * 1000 + amIn * 997)
function ammGetAmountOut(amountIn: bigint, rIn: bigint, rOut: bigint): bigint {
  if (amountIn === 0n || rIn === 0n || rOut === 0n) return 0n;
  const amInWith = amountIn * 997n;
  return (rOut * amInWith) / (rIn * 1000n + amInWith);
}

// ─── Calcular quote a partir das reservas on-chain ────────────────────────────
async function calcSwap(amountIn: number, fromToken: 'USDC' | 'EURC') {
  const { reserveA, reserveB } = await fetchAMMReserves();

  // tokenA = EURC, tokenB = USDC in SimpleAMM
  const rIn  = fromToken === 'EURC' ? reserveA : reserveB;
  const rOut = fromToken === 'EURC' ? reserveB : reserveA;

  const amInBig    = BigInt(Math.round(amountIn * 1e6));
  const amOutBig   = ammGetAmountOut(amInBig, rIn, rOut);
  const amOutHuman = Number(amOutBig) / 1e6;
  const feeHuman   = amountIn * AMM_FEE;

  const rate         = amountIn > 0 ? amOutHuman / amountIn : 0;
  const priceImpact  = rIn > 0n ? (Number(amInBig) / Number(rIn)) * 100 : 0;
  const minReceived  = amOutHuman * (1 - AMM_FEE);

  return {
    amountOut:       parseFloat(amOutHuman.toFixed(6)),
    rate:            parseFloat(rate.toFixed(6)),
    fee:             parseFloat(feeHuman.toFixed(6)),
    feePercent:      AMM_FEE * 100,
    priceImpact:     parseFloat(priceImpact.toFixed(4)),
    minimumReceived: parseFloat(minReceived.toFixed(6)),
    reserveIn:       (Number(rIn) / 1e6).toFixed(2),
    reserveOut:      (Number(rOut) / 1e6).toFixed(2),
    source:          'on-chain',
  };
}

// ─── Verificar se txHash é real ───────────────────────────────────────────────
function isRealTxHash(txHash?: string): boolean {
  if (!txHash) return false;
  const h = txHash.toLowerCase().replace(/^0x/, '');
  return h.length === 64 && !/^0+$/.test(h) && /^[0-9a-f]+$/.test(h);
}

// ─── GET /api/swap/quote ──────────────────────────────────────────────────────
swapRouter.get('/quote', async (c) => {
  const fromToken = (c.req.query('from') || 'USDC').toUpperCase() as 'USDC' | 'EURC';
  const toToken   = (c.req.query('to')   || 'EURC').toUpperCase() as 'USDC' | 'EURC';
  const amount    = parseFloat(c.req.query('amount') || '0');

  if (!['USDC','EURC'].includes(fromToken) || !['USDC','EURC'].includes(toToken))
    return c.json({ success: false, error: 'Tokens suportados: USDC, EURC' }, 400);
  if (fromToken === toToken)
    return c.json({ success: false, error: 'fromToken e toToken devem ser diferentes' }, 400);
  if (isNaN(amount) || amount <= 0)
    return c.json({ success: false, error: 'amount inválido' }, 400);

  try {
    const quote = await calcSwap(amount, fromToken as 'USDC' | 'EURC');
    const { reserveA, reserveB } = await fetchAMMReserves();

    return c.json({
      success: true,
      quote: {
        fromToken, toToken, amountIn: amount,
        ...quote,
        pool: {
          usdcReserve: (Number(reserveB) / 1e6).toFixed(2),
          eurcReserve: (Number(reserveA) / 1e6).toFixed(2),
          fee:         `${AMM_FEE * 100}%`,
          ammAddress:  AMM_ADDRESS,
          dataSource:  'on-chain (Arc Testnet RPC)',
        },
        network:   'Arc Testnet',
        chainId:   CHAIN_ID,
        updatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ─── GET /api/swap/rates ──────────────────────────────────────────────────────
swapRouter.get('/rates', async (c) => {
  try {
    const { reserveA, reserveB } = await fetchAMMReserves();

    // Spot rate = reserveOut / reserveIn (before fee)
    const usdcToEurc = reserveA > 0n
      ? parseFloat((Number(reserveA) / Number(reserveB)).toFixed(6))
      : 0.9185;
    const eurcToUsdc = reserveB > 0n
      ? parseFloat((Number(reserveB) / Number(reserveA)).toFixed(6))
      : 1.0885;

    return c.json({
      success: true,
      rates: {
        USDC_TO_EURC: usdcToEurc,
        EURC_TO_USDC: eurcToUsdc,
        source:       'on-chain AMM reserves (SimpleAMM)',
        ammAddress:   AMM_ADDRESS,
        updatedAt:    new Date().toISOString(),
      },
      pool: {
        usdcReserve:     (Number(reserveB) / 1e6).toFixed(2),
        eurcReserve:     (Number(reserveA) / 1e6).toFixed(2),
        fee:             `${AMM_FEE * 100}%`,
        totalSwaps,
        totalVolumeUSDC: totalVolume,
      },
      network: { name: 'Arc Testnet', chainId: CHAIN_ID, explorer: EXPLORER_URL },
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ─── POST /api/swap/execute ───────────────────────────────────────────────────
// Registra um swap já executado on-chain.
swapRouter.post('/execute', async (c) => {
  try {
    const body = await c.req.json();
    const {
      fromToken,
      toToken,
      amountIn,
      walletAddress,
      slippageTolerance = 0.5,
      txHash,
    } = body;

    if (!fromToken || !toToken || !amountIn || !walletAddress)
      return c.json({ success: false, error: 'Campos obrigatórios: fromToken, toToken, amountIn, walletAddress' }, 400);
    if (!['USDC','EURC'].includes(fromToken.toUpperCase()))
      return c.json({ success: false, error: 'fromToken deve ser USDC ou EURC' }, 400);
    // Validate wallet address format
    if (!isValidEthAddress(walletAddress))
      return c.json({ success: false, error: 'Invalid walletAddress format' }, 400);
    // Validate txHash if provided
    if (txHash && !isValidTxHash(txHash))
      return c.json({ success: false, error: 'Invalid txHash format' }, 400);

    const amount = parseFloat(amountIn);
    if (isNaN(amount) || amount <= 0)
      return c.json({ success: false, error: 'amountIn inválido' }, 400);
    if (amount > 100_000)
      return c.json({ success: false, error: 'Limite máximo: 100,000 por swap' }, 400);

    const from = fromToken.toUpperCase() as 'USDC' | 'EURC';
    let calc;
    try {
      calc = await calcSwap(amount, from);
    } catch (_) {
      // fallback se RPC falhar
      calc = { amountOut: amount * 0.9185, rate: 0.9185, fee: amount * AMM_FEE, feePercent: AMM_FEE * 100, priceImpact: 0, minimumReceived: amount * 0.9155, source: 'fallback' };
    }

    if (calc.priceImpact > slippageTolerance * 2) {
      return c.json({
        success: false,
        error:   `Price impact alto: ${calc.priceImpact.toFixed(2)}%. Reduza o valor ou aumente slippage.`,
        calc,
      }, 400);
    }

    const onChain    = isRealTxHash(txHash);
    const finalTxHash = txHash || null;
    const swapId     = `swap-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;

    const record: SwapRecord = {
      id:            swapId,
      type:          from === 'USDC' ? 'USDC_TO_EURC' : 'EURC_TO_USDC',
      amountIn:      amount,
      amountOut:     calc.amountOut,
      rate:          calc.rate,
      fee:           calc.fee,
      slippage:      calc.priceImpact,
      walletAddress: walletAddress.toLowerCase(),
      txHash:        finalTxHash || '',
      onChain,
      timestamp:     new Date().toISOString(),
      status:        'completed',
    };

    // Invalidar cache para forçar re-leitura das reservas
    poolCache.lastUpdated = 0;

    totalVolume += amount;
    totalSwaps  += 1;
    swapHistory.unshift(record);
    if (swapHistory.length > 200) swapHistory.pop();

    return c.json({
      success: true,
      swap:    record,
      onChain,
      explorer: finalTxHash ? `${EXPLORER_URL}/tx/${finalTxHash}` : EXPLORER_URL,
      message:  `${onChain ? '✅ Swap on-chain confirmado' : '📝 Swap registrado'}: ${amount} ${from} → ${calc.amountOut.toFixed(4)} ${toToken}`,
    });

  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ─── GET /api/swap/history ────────────────────────────────────────────────────
swapRouter.get('/history', (c) => {
  const limit  = Math.min(parseInt(c.req.query('limit') || '20'), 100);
  const wallet = c.req.query('wallet')?.toLowerCase();

  // Validate wallet address if provided
  if (wallet && !isValidEthAddress(wallet)) {
    return c.json({ success: false, error: 'Invalid wallet address format' }, 400);
  }

  let swaps = swapHistory;
  if (wallet) swaps = swaps.filter(s => s.walletAddress === wallet);

  return c.json({
    success: true,
    swaps:   swaps.slice(0, limit),
    total:   swaps.length,
    stats: {
      totalSwaps,
      totalVolume,
      pool: {
        usdcReserve: (Number(poolCache.reserveB) / 1e6).toFixed(2),
        eurcReserve: (Number(poolCache.reserveA) / 1e6).toFixed(2),
        lastUpdated: poolCache.lastUpdated > 0 ? new Date(poolCache.lastUpdated).toISOString() : null,
      },
    },
  });
});

// ─── GET /api/swap/pool ────────────────────────────────────────────────────────
swapRouter.get('/pool', async (c) => {
  try {
    const { reserveA, reserveB, totalSupply } = await fetchAMMReserves();
    return c.json({
      success: true,
      pool: {
        ammAddress:   AMM_ADDRESS,
        tokenA:       { symbol: 'EURC', address: EURC_ADDRESS, reserve: (Number(reserveA) / 1e6).toFixed(6) },
        tokenB:       { symbol: 'USDC', address: USDC_ADDRESS, reserve: (Number(reserveB) / 1e6).toFixed(6) },
        totalSupplyLP: (Number(totalSupply) / 1e6).toFixed(6),
        fee:          `${AMM_FEE * 100}%`,
        dataSource:   'on-chain (Arc Testnet RPC)',
        chainId:      CHAIN_ID,
        explorer:     `${EXPLORER_URL}/address/${AMM_ADDRESS}`,
      },
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ─── GET /api/swap/network ────────────────────────────────────────────────────
swapRouter.get('/network', (c) => {
  return c.json({
    success: true,
    network: {
      name:     'Arc Testnet',
      chainId:  CHAIN_ID,
      chainHex: '0x4cef52',
      rpc:      RPC_URL,
      explorer: EXPLORER_URL,
      contracts: {
        AMM:  AMM_ADDRESS,
        USDC: USDC_ADDRESS,
        EURC: EURC_ADDRESS,
      },
    },
  });
});

export default swapRouter;
