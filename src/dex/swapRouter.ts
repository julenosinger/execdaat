// ============================================================
// ARC DEX — Swap Router
// Routes swaps through the most efficient path
// Currently: direct single-hop (A → B via pool A-B)
// Future: multi-hop routing (A → C → B)
// ============================================================

import { poolManager, type SwapEvent } from './poolManager.ts';
import { buildSwapQuote, type SwapQuote } from './pricingEngine.ts';
import { normalizePoolId } from '../tokens/tokenRegistry.ts';

export interface SwapRoute {
  path:     string[];   // e.g. ['USDC', 'EURC']
  pools:    string[];   // pool IDs in order
  hops:     number;
  quote:    SwapQuote | null;
}

// ─── Find best route ──────────────────────────────────────────────────────────
export function findBestRoute(fromToken: string, toToken: string, amountIn: number): SwapRoute {
  const from = fromToken.toUpperCase();
  const to   = toToken.toUpperCase();

  // Try direct route
  const directPid = normalizePoolId(from, to);
  const directPool = poolManager.getPool(directPid);

  if (directPool) {
    const quote = poolManager.getQuote(from, to, amountIn * 1e6);
    if (quote) {
      return {
        path:  [from, to],
        pools: [directPid],
        hops:  1,
        quote,
      };
    }
  }

  // No route found
  return {
    path:  [from, to],
    pools: [],
    hops:  0,
    quote: null,
  };
}

// ─── Execute via best route ───────────────────────────────────────────────────
export function routerExecuteSwap(params: {
  fromToken:   string;
  toToken:     string;
  amountIn:    number;
  wallet:      string;
  txHash:      string;
  slippage?:   number;
  blockNumber?: number | null;
}): ReturnType<typeof poolManager.executeSwap> {
  return poolManager.executeSwap(params);
}
