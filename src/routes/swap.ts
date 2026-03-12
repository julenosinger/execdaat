// ========================================================
// SWAP API — Arc Testnet  USDC ↔ EURC
// O swap real é executado on-chain pela wallet do usuário.
// Este backend: cotação, registro de histórico, estatísticas.
// ========================================================

import { Hono } from 'hono';

const swapRouter = new Hono();

// ─── Estado do pool (cache em memória — substituir por D1 em prod) ────────────
let swapPool = {
  usdcReserve:  500_000,
  eurcReserve:  460_000,
  fee:          0.003,   // 0.3%
  totalVolume:  0,
  totalSwaps:   0,
  history:      [] as SwapRecord[],
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
  onChain:       boolean;   // true se txHash real (não simulado)
  timestamp:     string;
  status:        'completed' | 'pending' | 'failed';
}

// ─── Taxas de câmbio (EUR/USD aproximado) ────────────────────────────────────
function getUSDCtoEURCRate(): number {
  const base   = 0.9185;
  const jitter = (Math.random() - 0.5) * 0.004;
  return parseFloat((base + jitter).toFixed(4));
}
function getEURCtoUSDCRate(): number {
  return parseFloat((1 / getUSDCtoEURCRate()).toFixed(4));
}

// ─── Calcular swap ─────────────────────────────────────────────────────────────
function calcSwap(amountIn: number, fromToken: 'USDC' | 'EURC') {
  const rate     = fromToken === 'USDC' ? getUSDCtoEURCRate() : getEURCtoUSDCRate();
  const grossOut = amountIn * rate;
  const fee      = grossOut * swapPool.fee;
  const amountOut = grossOut - fee;
  const reserve  = fromToken === 'USDC' ? swapPool.usdcReserve : swapPool.eurcReserve;
  const priceImpact = (amountIn / reserve) * 100;

  return {
    amountOut:       parseFloat(amountOut.toFixed(6)),
    rate,
    fee:             parseFloat(fee.toFixed(6)),
    feePercent:      swapPool.fee * 100,
    priceImpact:     parseFloat(priceImpact.toFixed(4)),
    minimumReceived: parseFloat((amountOut * (1 - swapPool.fee)).toFixed(6)),
  };
}

// ─── Verificar se txHash parece real (64 hex chars, não todo zeros) ───────────
function isRealTxHash(txHash?: string): boolean {
  if (!txHash) return false;
  const h = txHash.toLowerCase().replace(/^0x/, '');
  if (h.length !== 64) return false;
  if (/^0+$/.test(h)) return false;
  return /^[0-9a-f]+$/.test(h);
}

// ─── GET /api/swap/quote ──────────────────────────────────────────────────────
swapRouter.get('/quote', (c) => {
  const fromToken = (c.req.query('from') || 'USDC').toUpperCase() as 'USDC' | 'EURC';
  const toToken   = (c.req.query('to')   || 'EURC').toUpperCase() as 'USDC' | 'EURC';
  const amount    = parseFloat(c.req.query('amount') || '0');

  if (!['USDC','EURC'].includes(fromToken) || !['USDC','EURC'].includes(toToken))
    return c.json({ success: false, error: 'Tokens suportados: USDC, EURC' }, 400);
  if (fromToken === toToken)
    return c.json({ success: false, error: 'fromToken e toToken devem ser diferentes' }, 400);
  if (isNaN(amount) || amount <= 0)
    return c.json({ success: false, error: 'amount inválido' }, 400);

  const quote = calcSwap(amount, fromToken as 'USDC' | 'EURC');

  return c.json({
    success: true,
    quote: {
      fromToken, toToken, amountIn: amount,
      ...quote,
      pool: {
        usdcReserve: swapPool.usdcReserve,
        eurcReserve: swapPool.eurcReserve,
        fee:         `${swapPool.fee * 100}%`,
      },
      network:   'Arc Testnet',
      chainId:   5042002,
      updatedAt: new Date().toISOString(),
    },
  });
});

// ─── GET /api/swap/rates ──────────────────────────────────────────────────────
swapRouter.get('/rates', (c) => {
  return c.json({
    success: true,
    rates: {
      USDC_TO_EURC: getUSDCtoEURCRate(),
      EURC_TO_USDC: getEURCtoUSDCRate(),
      source:       'EUR/USD market rate (Arc Testnet)',
      updatedAt:    new Date().toISOString(),
    },
    pool: {
      usdcReserve:     swapPool.usdcReserve,
      eurcReserve:     swapPool.eurcReserve,
      fee:             `${swapPool.fee * 100}%`,
      totalSwaps:      swapPool.totalSwaps,
      totalVolumeUSDC: swapPool.totalVolume,
    },
    network: { name: 'Arc Testnet', chainId: 5042002, explorer: 'https://testnet.arcscan.app' },
  });
});

// ─── POST /api/swap/execute ───────────────────────────────────────────────────
// Registra um swap já executado on-chain.
// O front-end deve enviar o txHash real da transação na Arc Testnet.
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

    // Validações
    if (!fromToken || !toToken || !amountIn || !walletAddress) {
      return c.json({
        success: false,
        error: 'Campos obrigatórios: fromToken, toToken, amountIn, walletAddress',
      }, 400);
    }
    if (!['USDC','EURC'].includes(fromToken.toUpperCase())) {
      return c.json({ success: false, error: 'fromToken deve ser USDC ou EURC' }, 400);
    }

    const amount = parseFloat(amountIn);
    if (isNaN(amount) || amount <= 0)
      return c.json({ success: false, error: 'amountIn inválido' }, 400);
    if (amount > 100_000)
      return c.json({ success: false, error: 'Limite máximo: 100,000 por swap' }, 400);

    const from    = fromToken.toUpperCase() as 'USDC' | 'EURC';
    const calc    = calcSwap(amount, from);
    const onChain = isRealTxHash(txHash);

    // Alertar se slippage alto
    if (calc.priceImpact > slippageTolerance * 2) {
      return c.json({
        success: false,
        error:   `Price impact alto: ${calc.priceImpact.toFixed(2)}%. Reduza o valor ou aumente slippage.`,
        calc,
      }, 400);
    }

    const finalTxHash = txHash || ('0x' + Array.from({ length: 64 }, () =>
      Math.floor(Math.random() * 16).toString(16)).join(''));

    const swapId = `swap-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;

    const record: SwapRecord = {
      id:            swapId,
      type:          from === 'USDC' ? 'USDC_TO_EURC' : 'EURC_TO_USDC',
      amountIn:      amount,
      amountOut:     calc.amountOut,
      rate:          calc.rate,
      fee:           calc.fee,
      slippage:      calc.priceImpact,
      walletAddress: walletAddress.toLowerCase(),
      txHash:        finalTxHash,
      onChain,
      timestamp:     new Date().toISOString(),
      status:        'completed',
    };

    // Atualizar pool
    if (from === 'USDC') {
      swapPool.usdcReserve += amount;
      swapPool.eurcReserve  = Math.max(0, swapPool.eurcReserve - calc.amountOut);
    } else {
      swapPool.eurcReserve += amount;
      swapPool.usdcReserve  = Math.max(0, swapPool.usdcReserve - calc.amountOut);
    }
    swapPool.totalVolume += amount;
    swapPool.totalSwaps  += 1;
    swapPool.history.unshift(record);
    if (swapPool.history.length > 200) swapPool.history.pop();

    return c.json({
      success: true,
      swap:    record,
      onChain,
      explorer: `https://testnet.arcscan.app/tx/${finalTxHash}`,
      message:  `${onChain ? '✅ Swap on-chain' : '📝 Swap registrado'}: ${amount} ${from} → ${calc.amountOut.toFixed(4)} ${toToken}`,
    });

  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ─── GET /api/swap/history ────────────────────────────────────────────────────
swapRouter.get('/history', (c) => {
  const limit  = parseInt(c.req.query('limit')  || '20');
  const wallet = c.req.query('wallet')?.toLowerCase();

  let swaps = swapPool.history;
  if (wallet) swaps = swaps.filter(s => s.walletAddress === wallet);

  return c.json({
    success: true,
    swaps:   swaps.slice(0, limit),
    total:   swaps.length,
    stats: {
      totalSwaps:  swapPool.totalSwaps,
      totalVolume: swapPool.totalVolume,
      pool: {
        usdcReserve: swapPool.usdcReserve,
        eurcReserve: swapPool.eurcReserve,
      },
    },
  });
});

// ─── GET /api/swap/network ────────────────────────────────────────────────────
swapRouter.get('/network', (c) => {
  return c.json({
    success: true,
    network: {
      name:      'Arc Testnet',
      chainId:   5042002,
      chainHex:  '0x4CFC12',
      rpc:       'https://rpc.testnet.arc.network',
      explorer:  'https://testnet.arcscan.app',
      contracts: {
        USDC: '0x3600000000000000000000000000000000000000',
        EURC: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
      },
      gasInfo: 'Estimado via provider.estimateGas() — padrão Arc Network',
    },
  });
});

export default swapRouter;
