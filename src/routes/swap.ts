// Rotas API para Swap USDC ↔ EURC na Arc Testnet

import { Hono } from 'hono';

const swapRouter = new Hono();

// Pool state simulado (em produção usar D1/KV)
let swapPool = {
  usdcReserve: 500_000,   // 500k USDC
  eurcReserve: 460_000,   // 460k EURC
  fee: 0.003,             // 0.3% fee
  totalVolume: 0,
  totalSwaps: 0,
  history: [] as SwapRecord[],
};

interface SwapRecord {
  id: string;
  type: 'USDC_TO_EURC' | 'EURC_TO_USDC';
  amountIn: number;
  amountOut: number;
  rate: number;
  fee: number;
  slippage: number;
  walletAddress: string;
  txHash: string;
  timestamp: string;
  status: 'completed' | 'pending' | 'failed';
}

function getUSDCtoEURCRate(): number {
  // Simula taxa de câmbio EUR/USD (~0.92)
  const base = 0.9185;
  const jitter = (Math.random() - 0.5) * 0.004; // ±0.2% variação
  return parseFloat((base + jitter).toFixed(4));
}

function getEURCtoUSDCRate(): number {
  return parseFloat((1 / getUSDCtoEURCRate()).toFixed(4));
}

function calcSwap(amountIn: number, fromToken: 'USDC' | 'EURC') {
  const rate = fromToken === 'USDC' ? getUSDCtoEURCRate() : getEURCtoUSDCRate();
  const grossOut = amountIn * rate;
  const fee = grossOut * swapPool.fee;
  const amountOut = grossOut - fee;

  // Calcular price impact baseado no tamanho vs reservas
  const reserve = fromToken === 'USDC' ? swapPool.usdcReserve : swapPool.eurcReserve;
  const priceImpact = (amountIn / reserve) * 100;
  const slippage = Math.min(priceImpact * 0.5, 5); // max 5% slippage

  return {
    amountOut: parseFloat(amountOut.toFixed(6)),
    rate,
    fee: parseFloat(fee.toFixed(6)),
    feePercent: swapPool.fee * 100,
    slippage: parseFloat(slippage.toFixed(4)),
    priceImpact: parseFloat(priceImpact.toFixed(4)),
    minimumReceived: parseFloat((amountOut * 0.995).toFixed(6)), // 0.5% slippage tolerance
  };
}

// GET /api/swap/quote - Cotação de swap
swapRouter.get('/quote', (c) => {
  const fromToken = (c.req.query('from') || 'USDC').toUpperCase() as 'USDC' | 'EURC';
  const toToken = (c.req.query('to') || 'EURC').toUpperCase() as 'USDC' | 'EURC';
  const amountStr = c.req.query('amount') || '0';
  const amount = parseFloat(amountStr);

  if (!['USDC', 'EURC'].includes(fromToken) || !['USDC', 'EURC'].includes(toToken)) {
    return c.json({ success: false, error: 'Tokens suportados: USDC, EURC' }, 400);
  }
  if (fromToken === toToken) {
    return c.json({ success: false, error: 'fromToken e toToken devem ser diferentes' }, 400);
  }
  if (isNaN(amount) || amount <= 0) {
    return c.json({ success: false, error: 'amount inválido' }, 400);
  }

  const quote = calcSwap(amount, fromToken as 'USDC' | 'EURC');

  return c.json({
    success: true,
    quote: {
      fromToken,
      toToken,
      amountIn: amount,
      ...quote,
      pool: {
        usdcReserve: swapPool.usdcReserve,
        eurcReserve: swapPool.eurcReserve,
        fee: `${swapPool.fee * 100}%`,
      },
      network: 'Arc Testnet (Chain ID: 5042002)',
      updatedAt: new Date().toISOString(),
    },
  });
});

// POST /api/swap/execute - Executar swap
swapRouter.post('/execute', async (c) => {
  try {
    const body = await c.req.json();
    const { fromToken, toToken, amountIn, walletAddress, slippageTolerance = 0.5 } = body;

    if (!fromToken || !toToken || !amountIn || !walletAddress) {
      return c.json({ success: false, error: 'Campos obrigatórios: fromToken, toToken, amountIn, walletAddress' }, 400);
    }

    const amount = parseFloat(amountIn);
    if (isNaN(amount) || amount <= 0) {
      return c.json({ success: false, error: 'amountIn inválido' }, 400);
    }
    if (amount > 100_000) {
      return c.json({ success: false, error: 'Limite máximo por swap: 100,000' }, 400);
    }

    const calc = calcSwap(amount, fromToken as 'USDC' | 'EURC');

    // Verificar slippage
    if (calc.slippage > slippageTolerance * 2) {
      return c.json({
        success: false,
        error: `Slippage muito alto: ${calc.slippage.toFixed(2)}%. Aumente o slippage tolerance ou reduza o valor.`,
        calc,
      }, 400);
    }

    // Simular tx hash
    const txHash = '0x' + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    const swapId = `swap-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;

    const record: SwapRecord = {
      id: swapId,
      type: fromToken === 'USDC' ? 'USDC_TO_EURC' : 'EURC_TO_USDC',
      amountIn: amount,
      amountOut: calc.amountOut,
      rate: calc.rate,
      fee: calc.fee,
      slippage: calc.slippage,
      walletAddress,
      txHash,
      timestamp: new Date().toISOString(),
      status: 'completed',
    };

    // Atualizar pool
    if (fromToken === 'USDC') {
      swapPool.usdcReserve += amount;
      swapPool.eurcReserve -= calc.amountOut;
    } else {
      swapPool.eurcReserve += amount;
      swapPool.usdcReserve -= calc.amountOut;
    }
    swapPool.totalVolume += amount;
    swapPool.totalSwaps += 1;
    swapPool.history.unshift(record);
    if (swapPool.history.length > 100) swapPool.history.pop();

    return c.json({
      success: true,
      swap: record,
      explorer: `https://testnet.arcscan.app/tx/${txHash}`,
      message: `Swap executado: ${amount} ${fromToken} → ${calc.amountOut.toFixed(4)} ${toToken}`,
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// GET /api/swap/history - Histórico de swaps
swapRouter.get('/history', (c) => {
  const limit = parseInt(c.req.query('limit') || '20');
  return c.json({
    success: true,
    swaps: swapPool.history.slice(0, limit),
    total: swapPool.history.length,
    stats: {
      totalSwaps: swapPool.totalSwaps,
      totalVolume: swapPool.totalVolume,
      pool: {
        usdcReserve: swapPool.usdcReserve,
        eurcReserve: swapPool.eurcReserve,
      },
    },
  });
});

// GET /api/swap/rates - Taxas atuais
swapRouter.get('/rates', (c) => {
  return c.json({
    success: true,
    rates: {
      USDC_TO_EURC: getUSDCtoEURCRate(),
      EURC_TO_USDC: getEURCtoUSDCRate(),
      source: 'Simulated market rate (EUR/USD)',
      updatedAt: new Date().toISOString(),
    },
    pool: {
      usdcReserve: swapPool.usdcReserve,
      eurcReserve: swapPool.eurcReserve,
      fee: `${swapPool.fee * 100}%`,
      totalSwaps: swapPool.totalSwaps,
      totalVolumeUSDC: swapPool.totalVolume,
    },
  });
});

export default swapRouter;
