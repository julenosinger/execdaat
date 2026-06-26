// ============================================================
// ARC DEX — Liquidity Engine
// Handles add/remove liquidity lifecycle and LP token management
// ============================================================

import { poolManager, type LPPosition, type Pool } from './poolManager.ts';

// ─── Add Liquidity ─────────────────────────────────────────────────────────────
export function addLiquidity(params: {
  tokenA:      string;
  tokenB:      string;
  amountA:     number;
  amountB:     number;
  wallet:      string;
  txHash:      string;
  blockNumber?: number | null;
}) {
  return poolManager.addLiquidity(params);
}

// ─── Remove Liquidity ──────────────────────────────────────────────────────────
export function removeLiquidity(params: {
  poolId:      string;
  lpAmount:    number;
  wallet:      string;
  txHash:      string;
  blockNumber?: number | null;
}) {
  return poolManager.removeLiquidity(params);
}

// ─── Get user positions ────────────────────────────────────────────────────────
export function getUserPositions(wallet: string) {
  return poolManager.getUserPositions(wallet);
}

// ─── Estimate LP output ────────────────────────────────────────────────────────
export function estimateLP(tokenA: string, tokenB: string, amountA: number, amountB: number) {
  return poolManager.estimateLP(tokenA, tokenB, amountA, amountB);
}
