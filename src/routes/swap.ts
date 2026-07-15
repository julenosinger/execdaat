// ========================================================
// SWAP API — Arc Testnet  USDC ↔ EURC
// Quote é calculado com reservas reais do AMM on-chain.
// O swap real é executado on-chain pela wallet do usuário.
// Este backend: cotação, verificação de receipt, histórico.
// AMM: 0x3148E2807F172D1cC354F35fB4fC4104e8b6b561
//
// Phase 1 hardening:
//   • Sem fallback de liquidez fabricada — NUNCA.
//   • source real: 'on-chain' | 'cache' | 'error'.
//   • Cache verificado (só atualiza após leitura on-chain OK).
//   • Failover multi-RPC com timeout/retry/backoff.
//   • /execute só aceita swaps verificados via receipt on-chain.
// ========================================================

import { Hono } from 'hono';
import { isValidEthAddress } from '../middleware/security';
import { createRpcClient } from '../lib/arc-rpc.mjs';
import { createReserveCache } from '../lib/reserve-cache.mjs';
import { makeDeadlineGuidance } from '../lib/pool-analytics.mjs';
import {
  verifySwapTransaction,
  verifyEscrowSwapTransaction,
  type VerifiedSwap,
} from '../lib/swap-verify.mjs';

const swapRouter = new Hono();

// ─── Constantes Arc Testnet ───────────────────────────────────────────────────
const AMM_ADDRESS    = '0x3148E2807F172D1cC354F35fB4fC4104e8b6b561';
const USDC_ADDRESS   = '0x3600000000000000000000000000000000000000';
const EURC_ADDRESS   = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const ESCROW_ADDRESS = '0x867650F5eAe8df91445971f14d89fd84F0C9a9f8'; // FxEscrow (Swap UI router)
const EXPLORER_URL   = 'https://testnet.arcscan.app';
const CHAIN_ID       = 5042002;
const AMM_FEE        = 0.003;   // 0.3%

// ─── Structured logging ───────────────────────────────────────────────────────
function slog(fields: Record<string, unknown>): void {
  try {
    console.log(JSON.stringify(
      { ts: new Date().toISOString(), mod: 'swap-api', ...fields },
      (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
    ));
  } catch (_) { /* logging must never throw */ }
}

// ─── RPC client (multi-endpoint failover) + verified reserve cache ────────────
const rpcClient = createRpcClient({ log: slog });
const reserveCache = createReserveCache({ rpcClient, ammAddress: AMM_ADDRESS, log: slog });

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
  // Phase 1: dados reconstruídos do receipt on-chain
  verified:         boolean;
  verificationKind: 'amm-swap' | 'escrow-transfer';
  tokenIn:          string;
  tokenOut:         string;
  blockNumber:      number | null;
  gasUsed:          string | null;
  amountOutSource:  'on-chain-event' | 'quote-estimate';
}

// Histórico em memória (limpo a cada restart) — apenas swaps verificados
const swapHistory: SwapRecord[] = [];
let totalSwaps  = 0;
let totalVolume = 0;

// ─── AMM x*y=k formula (mirrors Solidity: fee = 0.3%) ────────────────────────
//  amountOut = (rOut * amIn * 997) / (rIn * 1000 + amIn * 997)
function ammGetAmountOut(amountIn: bigint, rIn: bigint, rOut: bigint): bigint {
  if (amountIn === 0n || rIn === 0n || rOut === 0n) return 0n;
  const amInWith = amountIn * 997n;
  return (rOut * amInWith) / (rIn * 1000n + amInWith);
}

// ─── Calcular quote a partir das reservas verificadas ─────────────────────────
// Lança erro com code='RPC_UNAVAILABLE' se não houver dados verificados.
async function calcSwap(amountIn: number, fromToken: 'USDC' | 'EURC') {
  const snapshot = await reserveCache.getReserves();
  const { reserveA, reserveB } = snapshot;

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
    quote: {
      amountOut:       parseFloat(amOutHuman.toFixed(6)),
      rate:            parseFloat(rate.toFixed(6)),
      fee:             parseFloat(feeHuman.toFixed(6)),
      feePercent:      AMM_FEE * 100,
      priceImpact:     parseFloat(priceImpact.toFixed(4)),
      minimumReceived: parseFloat(minReceived.toFixed(6)),
      reserveIn:       (Number(rIn) / 1e6).toFixed(2),
      reserveOut:      (Number(rOut) / 1e6).toFixed(2),
      source:          snapshot.source,          // 'on-chain' | 'cache' — nunca fabricado
      cacheAge:        snapshot.cacheAge,
      blockNumber:     snapshot.blockNumber,
    },
    snapshot,
  };
}

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

// ─── GET /api/swap/quote ──────────────────────────────────────────────────────
swapRouter.get('/quote', async (c) => {
  const started   = Date.now();
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
    const { quote, snapshot } = await calcSwap(amount, fromToken);

    slog({
      evt: 'quote', fromToken, toToken, amount,
      source: snapshot.source, cacheAge: snapshot.cacheAge,
      blockNumber: snapshot.blockNumber,
      reserveA: snapshot.reserveA, reserveB: snapshot.reserveB,
      latencyMs: Date.now() - started,
    });

    return c.json({
      success: true,
      quote: {
        fromToken, toToken, amountIn: amount,
        ...quote,
        pool: {
          usdcReserve: (Number(snapshot.reserveB) / 1e6).toFixed(2),
          eurcReserve: (Number(snapshot.reserveA) / 1e6).toFixed(2),
          fee:         `${AMM_FEE * 100}%`,
          ammAddress:  AMM_ADDRESS,
          dataSource:  snapshot.source === 'on-chain'
            ? 'on-chain (Arc Testnet RPC)'
            : `cache (verified on-chain ${Math.round(snapshot.cacheAge / 1000)}s ago)`,
          blockNumber: snapshot.blockNumber,
          cacheAge:    snapshot.cacheAge,
        },
        network:   'Arc Testnet',
        chainId:   CHAIN_ID,
        updatedAt: new Date().toISOString(),
        // Phase 3 Part 2 — deadline protection at the quote layer
        // (deployed AMM v1 has no on-chain deadline support)
        deadline: makeDeadlineGuidance(Date.now(), null),
      },
    });
  } catch (err) {
    slog({ evt: 'quote', ok: false, error: String(err), latencyMs: Date.now() - started });
    if (isRpcUnavailable(err)) return c.json(rpcUnavailableResponse(), 503);
    return c.json({ success: false, error: String(err), source: 'error' }, 500);
  }
});

// ─── GET /api/swap/rates ──────────────────────────────────────────────────────
swapRouter.get('/rates', async (c) => {
  try {
    const snapshot = await reserveCache.getReserves();
    const { reserveA, reserveB } = snapshot;

    // Spot rate = reserveOut / reserveIn (before fee) — só de dados verificados
    const usdcToEurc = reserveB > 0n
      ? parseFloat((Number(reserveA) / Number(reserveB)).toFixed(6))
      : 0;
    const eurcToUsdc = reserveA > 0n
      ? parseFloat((Number(reserveB) / Number(reserveA)).toFixed(6))
      : 0;

    return c.json({
      success: true,
      rates: {
        USDC_TO_EURC: usdcToEurc,
        EURC_TO_USDC: eurcToUsdc,
        source:       snapshot.source,
        cacheAge:     snapshot.cacheAge,
        blockNumber:  snapshot.blockNumber,
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
    if (isRpcUnavailable(err)) return c.json(rpcUnavailableResponse(), 503);
    return c.json({ success: false, error: String(err), source: 'error' }, 500);
  }
});

// ─── POST /api/swap/execute ───────────────────────────────────────────────────
// Registra um swap SOMENTE após verificação criptográfica do receipt on-chain.
// Nada do payload do frontend é confiado: wallet, tokens e amounts são
// reconstruídos a partir dos logs da transação.
swapRouter.post('/execute', async (c) => {
  const started = Date.now();
  try {
    const body = await c.req.json();
    const { fromToken, toToken, amountIn, walletAddress, txHash } = body;

    if (!fromToken || !toToken || !amountIn || !walletAddress)
      return c.json({ success: false, error: 'Campos obrigatórios: fromToken, toToken, amountIn, walletAddress' }, 400);
    if (!['USDC','EURC'].includes(String(fromToken).toUpperCase()))
      return c.json({ success: false, error: 'fromToken deve ser USDC ou EURC' }, 400);
    if (!isValidEthAddress(walletAddress))
      return c.json({ success: false, error: 'Invalid walletAddress format' }, 400);
    const payloadAmount = parseFloat(amountIn);
    if (isNaN(payloadAmount) || payloadAmount <= 0)
      return c.json({ success: false, error: 'amountIn inválido' }, 400);
    if (payloadAmount > 100_000)
      return c.json({ success: false, error: 'Limite máximo: 100,000 por swap' }, 400);
    if (!txHash)
      return c.json({
        success: false,
        code:    'INVALID_TRANSACTION',
        error:   'txHash é obrigatório: apenas swaps executados on-chain podem ser registrados',
      }, 400);

    // Idempotência: mesma tx não entra duas vezes no histórico
    const existing = swapHistory.find((s) => s.txHash === String(txHash).toLowerCase());
    if (existing) {
      return c.json({
        success: true,
        swap:    existing,
        onChain: true,
        duplicate: true,
        explorer: `${EXPLORER_URL}/tx/${existing.txHash}`,
        message:  `✅ Swap já registrado: ${existing.amountIn} ${existing.type === 'USDC_TO_EURC' ? 'USDC' : 'EURC'}`,
      });
    }

    // ── Verificação on-chain do receipt ────────────────────────────────────
    // 1º: swap direto no SimpleAMM (evento Swap decodificado dos logs)
    // 2º: fluxo custodial do Swap UI (transfer nativo/ERC-20 → FxEscrow)
    let verification = await verifySwapTransaction({
      rpcClient, txHash, ammAddress: AMM_ADDRESS, expectedChainId: CHAIN_ID, log: slog,
    });
    if (!verification.valid && verification.code === 'INVALID_CONTRACT') {
      verification = await verifyEscrowSwapTransaction({
        rpcClient, txHash,
        escrowAddress: ESCROW_ADDRESS,
        eurcAddress:   EURC_ADDRESS,
        usdcAddress:   USDC_ADDRESS,
        expectedChainId: CHAIN_ID,
        log: slog,
      });
    }

    if (!verification.valid) {
      slog({
        evt: 'execute', ok: false, txHash,
        code: verification.code, reason: verification.message,
        verificationMs: Date.now() - started,
      });
      const httpStatus = verification.code === 'RPC_UNAVAILABLE' ? 503 : 400;
      return c.json({
        success: false,
        code:    verification.code,
        error:   verification.message,
      }, httpStatus);
    }

    const v: VerifiedSwap = verification.swap;

    // ── Reconstruir o registro a partir dos dados verificados ──────────────
    const verifiedFrom: 'USDC' | 'EURC' =
      v.tokenIn.toLowerCase() === USDC_ADDRESS.toLowerCase() ? 'USDC' : 'EURC';
    const verifiedTo: 'USDC' | 'EURC' = verifiedFrom === 'USDC' ? 'EURC' : 'USDC';
    const amountInHuman = Number(v.amountIn) / 1e6;

    let amountOutHuman: number;
    let amountOutSource: 'on-chain-event' | 'quote-estimate';
    let priceImpact = 0;
    if (v.amountOut !== null && v.amountOut !== undefined) {
      // Swap direto no AMM: amountOut vem do evento Swap (on-chain)
      amountOutHuman  = Number(v.amountOut) / 1e6;
      amountOutSource = 'on-chain-event';
    } else {
      // Fluxo escrow: liquidação ocorre em tx separada → estimar via reservas
      // verificadas (RPC está comprovadamente disponível neste ponto)
      const { quote } = await calcSwap(amountInHuman, verifiedFrom);
      amountOutHuman  = quote.amountOut;
      priceImpact     = quote.priceImpact;
      amountOutSource = 'quote-estimate';
    }

    const rate = amountInHuman > 0 ? amountOutHuman / amountInHuman : 0;
    const swapId = `swap-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;

    const record: SwapRecord = {
      id:            swapId,
      type:          verifiedFrom === 'USDC' ? 'USDC_TO_EURC' : 'EURC_TO_USDC',
      amountIn:      parseFloat(amountInHuman.toFixed(6)),
      amountOut:     parseFloat(amountOutHuman.toFixed(6)),
      rate:          parseFloat(rate.toFixed(6)),
      fee:           parseFloat((amountInHuman * AMM_FEE).toFixed(6)),
      slippage:      priceImpact,
      walletAddress: v.sender.toLowerCase(),
      txHash:        v.txHash,
      onChain:       true,
      timestamp:     v.blockTimestamp ? new Date(v.blockTimestamp).toISOString() : new Date().toISOString(),
      status:        'completed',
      verified:         true,
      verificationKind: v.kind,
      tokenIn:          v.tokenIn,
      tokenOut:         v.tokenOut,
      blockNumber:      v.blockNumber,
      gasUsed:          v.gasUsed,
      amountOutSource,
    };

    // Invalidar cache para forçar re-leitura das reservas
    reserveCache.invalidate();

    totalVolume += record.amountIn;
    totalSwaps  += 1;
    swapHistory.unshift(record);
    if (swapHistory.length > 200) swapHistory.pop();

    slog({
      evt: 'execute', ok: true, txHash: v.txHash,
      kind: v.kind, blockNumber: v.blockNumber, gasUsed: v.gasUsed,
      tokenIn: v.tokenIn, tokenOut: v.tokenOut,
      amountIn: v.amountIn, amountOut: v.amountOut,
      payloadWalletMatches: String(walletAddress).toLowerCase() === v.sender.toLowerCase(),
      verificationMs: Date.now() - started,
    });

    return c.json({
      success: true,
      swap:    record,
      onChain: true,
      verified: true,
      explorer: `${EXPLORER_URL}/tx/${v.txHash}`,
      message:  `✅ Swap on-chain verificado: ${record.amountIn} ${verifiedFrom} → ${record.amountOut.toFixed(4)} ${verifiedTo}`,
    });

  } catch (err) {
    slog({ evt: 'execute', ok: false, error: String(err), verificationMs: Date.now() - started });
    if (isRpcUnavailable(err)) return c.json(rpcUnavailableResponse(), 503);
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

  const cached = reserveCache.peek();

  return c.json({
    success: true,
    swaps:   swaps.slice(0, limit),
    total:   swaps.length,
    stats: {
      totalSwaps,
      totalVolume,
      pool: {
        usdcReserve: cached ? (Number(cached.reserveB) / 1e6).toFixed(2) : null,
        eurcReserve: cached ? (Number(cached.reserveA) / 1e6).toFixed(2) : null,
        blockNumber: cached ? cached.blockNumber : null,
        lastUpdated: cached ? new Date(cached.lastSuccessfulFetch).toISOString() : null,
      },
    },
  });
});

// ─── GET /api/swap/pool ────────────────────────────────────────────────────────
swapRouter.get('/pool', async (c) => {
  try {
    const snapshot = await reserveCache.getReserves();
    const { reserveA, reserveB, totalSupply } = snapshot;
    return c.json({
      success: true,
      pool: {
        ammAddress:   AMM_ADDRESS,
        tokenA:       { symbol: 'EURC', address: EURC_ADDRESS, reserve: (Number(reserveA) / 1e6).toFixed(6) },
        tokenB:       { symbol: 'USDC', address: USDC_ADDRESS, reserve: (Number(reserveB) / 1e6).toFixed(6) },
        totalSupplyLP: (Number(totalSupply) / 1e6).toFixed(6),
        fee:          `${AMM_FEE * 100}%`,
        source:       snapshot.source,
        cacheAge:     snapshot.cacheAge,
        blockNumber:  snapshot.blockNumber,
        dataSource:   snapshot.source === 'on-chain'
          ? 'on-chain (Arc Testnet RPC)'
          : `cache (verified on-chain ${Math.round(snapshot.cacheAge / 1000)}s ago)`,
        chainId:      CHAIN_ID,
        explorer:     `${EXPLORER_URL}/address/${AMM_ADDRESS}`,
      },
    });
  } catch (err) {
    if (isRpcUnavailable(err)) return c.json(rpcUnavailableResponse(), 503);
    return c.json({ success: false, error: String(err), source: 'error' }, 500);
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
      rpc:      rpcClient.endpoints()[0],
      rpcFallbacks: rpcClient.endpoints().slice(1),
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
