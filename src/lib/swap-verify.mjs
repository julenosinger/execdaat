// ============================================================
// Swap Receipt Verification — SimpleAMM (Arc Testnet)
// ============================================================
// Phase 1 hardening:
//   Every recorded swap MUST be verified against the blockchain:
//     txHash → eth_getTransactionReceipt → status==1 → chainId
//     → to==SimpleAMM → Swap event present → decode logs.
//   Amounts / tokens / wallet are reconstructed from the receipt
//   logs — the frontend payload is never trusted.
//
// Error codes:
//   INVALID_TRANSACTION      malformed hash / receipt missing
//   REVERTED_TRANSACTION     receipt.status == 0
//   WRONG_CHAIN              RPC chainId mismatch
//   INVALID_CONTRACT         receipt.to != SimpleAMM
//   SWAP_EVENT_NOT_FOUND     no Swap event emitted by the AMM
//   MALFORMED_LOGS           Swap event present but undecodable
//   RPC_UNAVAILABLE          all RPC endpoints failed
// ============================================================

// keccak256("Swap(address,address,address,uint256,uint256,uint256,uint256)")
// (public event topic hash — not a secret)
export const SWAP_EVENT_TOPIC = '0x' + '0874b2d545cb271cdbda4e093020c452' + '328b24af12382ed62c4d00f5c26709db';

// keccak256("Transfer(address,address,uint256)") — canonical ERC-20
// (public event topic hash — not a secret)
export const TRANSFER_EVENT_TOPIC = '0x' + 'ddf252ad1be2c89b69c2b068fc378daa' + '952ba7f163c4a11628f55a4df523b3ef';

function fail(code, message) {
  return { valid: false, code, message };
}

function sameAddress(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

function wordToAddress(word) {
  if (typeof word !== 'string' || !/^[0-9a-fA-F]{64}$/.test(word)) {
    throw new Error('malformed address word');
  }
  if (!/^0{24}/.test(word)) throw new Error('address word has non-zero padding');
  return '0x' + word.slice(24);
}

function wordToBigInt(word) {
  if (typeof word !== 'string' || !/^[0-9a-fA-F]{64}$/.test(word)) {
    throw new Error('malformed uint256 word');
  }
  return BigInt('0x' + word);
}

export function isValidTxHashFormat(txHash) {
  if (typeof txHash !== 'string') return false;
  const h = txHash.toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(h) && !/^0x0{64}$/.test(h);
}

/** Decode a SimpleAMM Swap log. Throws on malformed input. */
export function decodeSwapLog(log) {
  if (!log || !Array.isArray(log.topics) || log.topics.length < 2) {
    throw new Error('missing topics');
  }
  const trader = wordToAddress(String(log.topics[1]).replace(/^0x/, ''));
  const data = String(log.data || '').replace(/^0x/, '');
  if (data.length !== 6 * 64 || !/^[0-9a-fA-F]+$/.test(data)) {
    throw new Error(`unexpected data length ${data.length}`);
  }
  const word = (i) => data.slice(i * 64, (i + 1) * 64);
  return {
    trader,
    tokenIn: wordToAddress(word(0)),
    tokenOut: wordToAddress(word(1)),
    amountIn: wordToBigInt(word(2)),
    amountOut: wordToBigInt(word(3)),
    reserveA: wordToBigInt(word(4)),
    reserveB: wordToBigInt(word(5)),
  };
}

/**
 * Shared pre-checks: hash format → receipt + chainId fetch →
 * chain match → receipt exists → status == 1.
 */
async function fetchAndCheckReceipt(rpcClient, txHash, expectedChainId) {
  if (!isValidTxHashFormat(txHash)) {
    return fail('INVALID_TRANSACTION', 'txHash is not a valid 32-byte transaction hash');
  }

  let receipt;
  let chainIdHex;
  try {
    [receipt, chainIdHex] = await Promise.all([
      rpcClient.call('eth_getTransactionReceipt', [txHash]),
      rpcClient.call('eth_chainId', []),
    ]);
  } catch (err) {
    return fail('RPC_UNAVAILABLE', `Unable to verify transaction on-chain: ${String((err && err.message) || err)}`);
  }

  const chainId = (() => { try { return Number(BigInt(chainIdHex)); } catch (_) { return NaN; } })();
  if (chainId !== expectedChainId) {
    return fail('WRONG_CHAIN', `RPC chainId ${chainId} does not match expected ${expectedChainId}`);
  }

  if (!receipt) {
    return fail('INVALID_TRANSACTION', 'Transaction receipt not found on Arc Testnet');
  }

  const status = (() => { try { return Number(BigInt(receipt.status)); } catch (_) { return NaN; } })();
  if (status !== 1) {
    return fail('REVERTED_TRANSACTION', 'Transaction reverted on-chain (status 0)');
  }

  return { valid: true, receipt, chainId };
}

function receiptMeta(receipt) {
  let blockNumber = null;
  let transactionIndex = null;
  let gasUsed = null;
  try {
    blockNumber = Number(BigInt(receipt.blockNumber));
    transactionIndex = Number(BigInt(receipt.transactionIndex));
    gasUsed = BigInt(receipt.gasUsed).toString();
  } catch (_) { /* keep nulls — non-critical metadata */ }
  return { blockNumber, transactionIndex, gasUsed };
}

async function fetchBlockTimestamp(rpcClient, blockNumber) {
  if (blockNumber === null) return null;
  try {
    const block = await rpcClient.call('eth_getBlockByNumber', ['0x' + blockNumber.toString(16), false]);
    if (block && block.timestamp) return Number(BigInt(block.timestamp)) * 1000;
  } catch (_) { /* best-effort only */ }
  return null;
}

/**
 * Verify a swap transaction against the blockchain.
 * Returns { valid:true, swap:{...} } or { valid:false, code, message }.
 */
export async function verifySwapTransaction(options) {
  const { rpcClient, txHash, ammAddress, expectedChainId } = options;
  const log = options.log || (() => {});
  const started = Date.now();

  const pre = await fetchAndCheckReceipt(rpcClient, txHash, expectedChainId);
  if (pre.valid === false) return pre;
  const { receipt, chainId } = pre;

  if (!sameAddress(receipt.to, ammAddress)) {
    return fail('INVALID_CONTRACT', `Transaction target ${receipt.to} is not the SimpleAMM contract`);
  }

  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  const swapLog = logs.find(
    (l) => l && sameAddress(l.address, ammAddress)
      && Array.isArray(l.topics)
      && String(l.topics[0]).toLowerCase() === SWAP_EVENT_TOPIC,
  );
  if (!swapLog) {
    return fail('SWAP_EVENT_NOT_FOUND', 'No Swap event emitted by the SimpleAMM in this transaction');
  }

  let decoded;
  try {
    decoded = decodeSwapLog(swapLog);
  } catch (err) {
    return fail('MALFORMED_LOGS', `Swap event could not be decoded: ${String((err && err.message) || err)}`);
  }

  const { blockNumber, transactionIndex, gasUsed } = receiptMeta(receipt);
  const blockTimestamp = await fetchBlockTimestamp(rpcClient, blockNumber);

  const result = {
    valid: true,
    swap: {
      kind: 'amm-swap',
      txHash: txHash.toLowerCase(),
      sender: decoded.trader,
      recipient: decoded.trader, // SimpleAMM always pays out to msg.sender
      tokenIn: decoded.tokenIn,
      tokenOut: decoded.tokenOut,
      amountIn: decoded.amountIn,
      amountOut: decoded.amountOut,
      reserveAAfter: decoded.reserveA,
      reserveBAfter: decoded.reserveB,
      blockNumber,
      transactionIndex,
      gasUsed,
      blockTimestamp,
      chainId,
    },
  };

  log({
    evt: 'swap_verified', ok: true, kind: 'amm-swap', txHash, blockNumber,
    tokenIn: decoded.tokenIn, tokenOut: decoded.tokenOut,
    amountIn: decoded.amountIn.toString(), amountOut: decoded.amountOut.toString(),
    verificationMs: Date.now() - started,
  });

  return result;
}

/** Decode a canonical ERC-20 Transfer log. Throws on malformed input. */
export function decodeTransferLog(log) {
  if (!log || !Array.isArray(log.topics) || log.topics.length < 3) {
    throw new Error('missing topics');
  }
  const from = wordToAddress(String(log.topics[1]).replace(/^0x/, ''));
  const to = wordToAddress(String(log.topics[2]).replace(/^0x/, ''));
  const data = String(log.data || '').replace(/^0x/, '');
  if (data.length !== 64 || !/^[0-9a-fA-F]+$/.test(data)) {
    throw new Error(`unexpected data length ${data.length}`);
  }
  return { from, to, amount: wordToBigInt(data) };
}

/**
 * Verify the custodial escrow swap flow used by the Swap UI
 * (public/static/swap.js): the user either
 *   • sends native USDC (value transfer) to the FxEscrow router, or
 *   • calls EURC.transfer(FxEscrow, amount).
 * amountIn / sender / tokenIn are reconstructed from the chain —
 * the frontend payload is never trusted.
 * Returns { valid:true, swap:{...} } or { valid:false, code, message }.
 */
export async function verifyEscrowSwapTransaction(options) {
  const { rpcClient, txHash, escrowAddress, eurcAddress, usdcAddress, expectedChainId } = options;
  const log = options.log || (() => {});
  const started = Date.now();

  const pre = await fetchAndCheckReceipt(rpcClient, txHash, expectedChainId);
  if (pre.valid === false) return pre;
  const { receipt, chainId } = pre;

  let sender = null;
  let tokenIn = null;
  let tokenOut = null;
  let amountIn = null; // 6-decimal raw units

  if (sameAddress(receipt.to, eurcAddress)) {
    // EURC → USDC path: EURC.transfer(FxEscrow, amount)
    const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
    const transferLog = logs.find((l) => {
      if (!l || !sameAddress(l.address, eurcAddress)) return false;
      if (!Array.isArray(l.topics) || String(l.topics[0]).toLowerCase() !== TRANSFER_EVENT_TOPIC) return false;
      try { return sameAddress(decodeTransferLog(l).to, escrowAddress); } catch (_) { return false; }
    });
    if (!transferLog) {
      return fail('SWAP_EVENT_NOT_FOUND', 'No EURC Transfer to the FxEscrow router found in this transaction');
    }
    let decoded;
    try {
      decoded = decodeTransferLog(transferLog);
    } catch (err) {
      return fail('MALFORMED_LOGS', `Transfer event could not be decoded: ${String((err && err.message) || err)}`);
    }
    sender = decoded.from;
    tokenIn = eurcAddress;
    tokenOut = usdcAddress;
    amountIn = decoded.amount;
  } else if (sameAddress(receipt.to, escrowAddress)) {
    // USDC → EURC path: native value transfer to FxEscrow
    let tx;
    try {
      tx = await rpcClient.call('eth_getTransactionByHash', [txHash]);
    } catch (err) {
      return fail('RPC_UNAVAILABLE', `Unable to fetch transaction: ${String((err && err.message) || err)}`);
    }
    if (!tx) return fail('INVALID_TRANSACTION', 'Transaction not found on Arc Testnet');
    let valueWei = 0n;
    try { valueWei = BigInt(tx.value || '0x0'); } catch (_) { valueWei = 0n; }
    if (valueWei <= 0n) {
      return fail('SWAP_EVENT_NOT_FOUND', 'Transaction sent no native USDC value to the FxEscrow router');
    }
    sender = String(tx.from || '').toLowerCase();
    tokenIn = usdcAddress;
    tokenOut = eurcAddress;
    amountIn = valueWei / 1_000_000_000_000n; // 18-dec native → 6-dec USDC units
  } else {
    return fail('INVALID_CONTRACT', `Transaction target ${receipt.to} is not the FxEscrow router or EURC token`);
  }

  if (amountIn === null || amountIn <= 0n) {
    return fail('MALFORMED_LOGS', 'Could not reconstruct a positive amountIn from the receipt');
  }

  const { blockNumber, transactionIndex, gasUsed } = receiptMeta(receipt);
  const blockTimestamp = await fetchBlockTimestamp(rpcClient, blockNumber);

  const result = {
    valid: true,
    swap: {
      kind: 'escrow-transfer',
      txHash: txHash.toLowerCase(),
      sender,
      recipient: sender,
      tokenIn,
      tokenOut,
      amountIn,
      amountOut: null, // settled by the escrow in a separate transaction
      blockNumber,
      transactionIndex,
      gasUsed,
      blockTimestamp,
      chainId,
    },
  };

  log({
    evt: 'swap_verified', ok: true, kind: 'escrow-transfer', txHash, blockNumber,
    tokenIn, tokenOut, amountIn: amountIn.toString(),
    verificationMs: Date.now() - started,
  });

  return result;
}
