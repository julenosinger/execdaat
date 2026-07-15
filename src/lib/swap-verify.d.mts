import type { RpcClient } from './arc-rpc.mjs';

export declare const SWAP_EVENT_TOPIC: string;
export declare const TRANSFER_EVENT_TOPIC: string;

export interface DecodedSwapLog {
  trader: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
  reserveA: bigint;
  reserveB: bigint;
}

export interface DecodedTransferLog {
  from: string;
  to: string;
  amount: bigint;
}

export interface VerifiedSwap {
  kind: 'amm-swap' | 'escrow-transfer';
  txHash: string;
  sender: string;
  recipient: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint | null;
  reserveAAfter?: bigint;
  reserveBAfter?: bigint;
  blockNumber: number | null;
  transactionIndex: number | null;
  gasUsed: string | null;
  blockTimestamp: number | null;
  chainId: number;
}

export type VerificationResult =
  | { valid: true; swap: VerifiedSwap }
  | { valid: false; code: string; message: string };

export interface VerifySwapOptions {
  rpcClient: RpcClient;
  txHash: string;
  ammAddress: string;
  expectedChainId: number;
  log?: (fields: Record<string, unknown>) => void;
}

export interface VerifyEscrowOptions {
  rpcClient: RpcClient;
  txHash: string;
  escrowAddress: string;
  eurcAddress: string;
  usdcAddress: string;
  expectedChainId: number;
  log?: (fields: Record<string, unknown>) => void;
}

export declare function isValidTxHashFormat(txHash: unknown): boolean;
export declare function decodeSwapLog(log: { topics?: string[]; data?: string }): DecodedSwapLog;
export declare function decodeTransferLog(log: { topics?: string[]; data?: string }): DecodedTransferLog;
export declare function verifySwapTransaction(options: VerifySwapOptions): Promise<VerificationResult>;
export declare function verifyEscrowSwapTransaction(options: VerifyEscrowOptions): Promise<VerificationResult>;
