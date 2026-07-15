// ============================================================
// Unit tests — src/lib/swap-verify.mjs (receipt verification)
// ============================================================
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const root = path.resolve(__dirname, '../../..');
const modUrl = pathToFileURL(path.join(root, 'src/lib/swap-verify.mjs')).href;

const AMM    = '0x3148E2807F172D1cC354F35fB4fC4104e8b6b561';
const EURC   = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const USDC   = '0x3600000000000000000000000000000000000000';
const ESCROW = '0x867650F5eAe8df91445971f14d89fd84F0C9a9f8';
const TRADER = '0xA43ABD9Dc38840376d3C469bFBf5951912936c9f';
const CHAIN  = 5042002;
const TX     = '0x' + 'ab'.repeat(32);

// Public event topic hashes (keccak256 of event signatures — not secrets)
const SWAP_TOPIC     = '0x' + '0874b2d545cb271cdbda4e093020c452' + '328b24af12382ed62c4d00f5c26709db';
const TRANSFER_TOPIC = '0x' + 'ddf252ad1be2c89b69c2b068fc378daa' + '952ba7f163c4a11628f55a4df523b3ef';

const addrWord = (a) => a.slice(2).toLowerCase().padStart(64, '0');
const uintWord = (v) => BigInt(v).toString(16).padStart(64, '0');

function swapLog({ tokenIn = EURC, tokenOut = USDC, amountIn = 5_000_000n, amountOut = 6_400_000n } = {}) {
  return {
    address: AMM.toLowerCase(),
    topics:  [SWAP_TOPIC, '0x' + addrWord(TRADER)],
    data:    '0x' + addrWord(tokenIn) + addrWord(tokenOut)
                  + uintWord(amountIn) + uintWord(amountOut)
                  + uintWord(30051878421n) + uintWord(38560072953n),
  };
}

function baseReceipt(overrides = {}) {
  return {
    status: '0x1',
    to: AMM.toLowerCase(),
    from: TRADER.toLowerCase(),
    blockNumber: '0x1a2b',
    transactionIndex: '0x2',
    gasUsed: '0x5208',
    logs: [swapLog()],
    ...overrides,
  };
}

function mockRpc(handlers) {
  return {
    call: async (method, params) => {
      if (handlers[method]) return handlers[method](params);
      throw new Error('unexpected RPC method ' + method);
    },
    ethCall: async () => '0x',
    endpoints: () => ['mock'],
  };
}

function rpcFor(receipt, { chainId = '0x4cef52', tx, block = { timestamp: '0x66aabbcc' } } = {}) {
  return mockRpc({
    eth_getTransactionReceipt: () => receipt,
    eth_chainId: () => chainId,
    eth_getBlockByNumber: () => block,
    eth_getTransactionByHash: () => tx,
  });
}

describe('lib/swap-verify.mjs — on-chain receipt verification', () => {

  it('execute valid tx: AMM swap verified, amounts decoded from Swap event', async () => {
    const { verifySwapTransaction } = await import(modUrl);
    const res = await verifySwapTransaction({
      rpcClient: rpcFor(baseReceipt()), txHash: TX, ammAddress: AMM, expectedChainId: CHAIN,
    });
    assert.equal(res.valid, true);
    assert.equal(res.swap.kind, 'amm-swap');
    assert.equal(res.swap.sender.toLowerCase(), TRADER.toLowerCase());
    assert.equal(res.swap.tokenIn.toLowerCase(), EURC.toLowerCase());
    assert.equal(res.swap.tokenOut.toLowerCase(), USDC.toLowerCase());
    assert.equal(res.swap.amountIn, 5_000_000n);
    assert.equal(res.swap.amountOut, 6_400_000n);
    assert.equal(res.swap.blockNumber, 0x1a2b);
    assert.equal(res.swap.transactionIndex, 2);
    assert.equal(res.swap.gasUsed, '21000');
    assert.equal(res.swap.blockTimestamp, Number(0x66aabbccn) * 1000);
    assert.equal(res.swap.chainId, CHAIN);
  });

  it('execute reverted tx → REVERTED_TRANSACTION', async () => {
    const { verifySwapTransaction } = await import(modUrl);
    const res = await verifySwapTransaction({
      rpcClient: rpcFor(baseReceipt({ status: '0x0' })), txHash: TX, ammAddress: AMM, expectedChainId: CHAIN,
    });
    assert.equal(res.valid, false);
    assert.equal(res.code, 'REVERTED_TRANSACTION');
  });

  it('execute wrong chain → WRONG_CHAIN', async () => {
    const { verifySwapTransaction } = await import(modUrl);
    const res = await verifySwapTransaction({
      rpcClient: rpcFor(baseReceipt(), { chainId: '0x1' }), txHash: TX, ammAddress: AMM, expectedChainId: CHAIN,
    });
    assert.equal(res.valid, false);
    assert.equal(res.code, 'WRONG_CHAIN');
  });

  it('execute wrong contract → INVALID_CONTRACT', async () => {
    const { verifySwapTransaction } = await import(modUrl);
    const res = await verifySwapTransaction({
      rpcClient: rpcFor(baseReceipt({ to: '0x' + '11'.repeat(20) })), txHash: TX, ammAddress: AMM, expectedChainId: CHAIN,
    });
    assert.equal(res.valid, false);
    assert.equal(res.code, 'INVALID_CONTRACT');
  });

  it('execute missing receipt → INVALID_TRANSACTION', async () => {
    const { verifySwapTransaction } = await import(modUrl);
    const res = await verifySwapTransaction({
      rpcClient: rpcFor(null), txHash: TX, ammAddress: AMM, expectedChainId: CHAIN,
    });
    assert.equal(res.valid, false);
    assert.equal(res.code, 'INVALID_TRANSACTION');
    assert.includes(res.message, 'receipt not found');
  });

  it('execute missing Swap event → SWAP_EVENT_NOT_FOUND', async () => {
    const { verifySwapTransaction } = await import(modUrl);
    const res = await verifySwapTransaction({
      rpcClient: rpcFor(baseReceipt({ logs: [] })), txHash: TX, ammAddress: AMM, expectedChainId: CHAIN,
    });
    assert.equal(res.valid, false);
    assert.equal(res.code, 'SWAP_EVENT_NOT_FOUND');
  });

  it('execute malformed logs → MALFORMED_LOGS', async () => {
    const { verifySwapTransaction } = await import(modUrl);
    const bad = swapLog();
    bad.data = '0x1234'; // truncated event data
    const res = await verifySwapTransaction({
      rpcClient: rpcFor(baseReceipt({ logs: [bad] })), txHash: TX, ammAddress: AMM, expectedChainId: CHAIN,
    });
    assert.equal(res.valid, false);
    assert.equal(res.code, 'MALFORMED_LOGS');
  });

  it('malformed txHash rejected before any RPC call → INVALID_TRANSACTION', async () => {
    const { verifySwapTransaction } = await import(modUrl);
    let rpcTouched = false;
    const rpc = { call: async () => { rpcTouched = true; return null; }, ethCall: async () => '0x' };
    for (const h of ['0x123', 'not-a-hash', '0x' + '0'.repeat(64), null]) {
      const res = await verifySwapTransaction({
        rpcClient: rpc, txHash: h, ammAddress: AMM, expectedChainId: CHAIN,
      });
      assert.equal(res.valid, false);
      assert.equal(res.code, 'INVALID_TRANSACTION');
    }
    assert.equal(rpcTouched, false);
  });

  it('RPC totally down during verification → RPC_UNAVAILABLE', async () => {
    const { verifySwapTransaction } = await import(modUrl);
    const rpc = { call: async () => { throw Object.assign(new Error('down'), { code: 'RPC_UNAVAILABLE' }); }, ethCall: async () => '0x' };
    const res = await verifySwapTransaction({
      rpcClient: rpc, txHash: TX, ammAddress: AMM, expectedChainId: CHAIN,
    });
    assert.equal(res.valid, false);
    assert.equal(res.code, 'RPC_UNAVAILABLE');
  });

  it('escrow flow: native USDC transfer to FxEscrow verified from tx.value', async () => {
    const { verifyEscrowSwapTransaction } = await import(modUrl);
    const receipt = baseReceipt({ to: ESCROW.toLowerCase(), logs: [] });
    const tx = { from: TRADER.toLowerCase(), value: '0x' + (5n * 10n ** 18n).toString(16) };
    const res = await verifyEscrowSwapTransaction({
      rpcClient: rpcFor(receipt, { tx }), txHash: TX,
      escrowAddress: ESCROW, eurcAddress: EURC, usdcAddress: USDC, expectedChainId: CHAIN,
    });
    assert.equal(res.valid, true);
    assert.equal(res.swap.kind, 'escrow-transfer');
    assert.equal(res.swap.tokenIn.toLowerCase(), USDC.toLowerCase());
    assert.equal(res.swap.amountIn, 5_000_000n, '5 native USDC (18 dec) → 5.0 in 6-dec units');
    assert.isNull(res.swap.amountOut, 'escrow settles amountOut in a separate tx');
    assert.equal(res.swap.sender.toLowerCase(), TRADER.toLowerCase());
  });

  it('escrow flow: EURC.transfer(FxEscrow) verified from Transfer log', async () => {
    const { verifyEscrowSwapTransaction } = await import(modUrl);
    const transferLog = {
      address: EURC.toLowerCase(),
      topics: [TRANSFER_TOPIC, '0x' + addrWord(TRADER), '0x' + addrWord(ESCROW)],
      data: '0x' + uintWord(7_500_000n),
    };
    const receipt = baseReceipt({ to: EURC.toLowerCase(), logs: [transferLog] });
    const res = await verifyEscrowSwapTransaction({
      rpcClient: rpcFor(receipt), txHash: TX,
      escrowAddress: ESCROW, eurcAddress: EURC, usdcAddress: USDC, expectedChainId: CHAIN,
    });
    assert.equal(res.valid, true);
    assert.equal(res.swap.kind, 'escrow-transfer');
    assert.equal(res.swap.tokenIn.toLowerCase(), EURC.toLowerCase());
    assert.equal(res.swap.amountIn, 7_500_000n);
    assert.equal(res.swap.sender.toLowerCase(), TRADER.toLowerCase());
  });

  it('escrow flow: tx to unrelated contract → INVALID_CONTRACT', async () => {
    const { verifyEscrowSwapTransaction } = await import(modUrl);
    const receipt = baseReceipt({ to: '0x' + '22'.repeat(20), logs: [] });
    const res = await verifyEscrowSwapTransaction({
      rpcClient: rpcFor(receipt), txHash: TX,
      escrowAddress: ESCROW, eurcAddress: EURC, usdcAddress: USDC, expectedChainId: CHAIN,
    });
    assert.equal(res.valid, false);
    assert.equal(res.code, 'INVALID_CONTRACT');
  });

  it('escrow flow: zero-value transfer to escrow rejected', async () => {
    const { verifyEscrowSwapTransaction } = await import(modUrl);
    const receipt = baseReceipt({ to: ESCROW.toLowerCase(), logs: [] });
    const res = await verifyEscrowSwapTransaction({
      rpcClient: rpcFor(receipt, { tx: { from: TRADER, value: '0x0' } }), txHash: TX,
      escrowAddress: ESCROW, eurcAddress: EURC, usdcAddress: USDC, expectedChainId: CHAIN,
    });
    assert.equal(res.valid, false);
    assert.equal(res.code, 'SWAP_EVENT_NOT_FOUND');
  });

  it('decodeSwapLog: round-trips token addresses and amounts', async () => {
    const { decodeSwapLog } = await import(modUrl);
    const d = decodeSwapLog(swapLog({ tokenIn: USDC, tokenOut: EURC, amountIn: 123n, amountOut: 456n }));
    assert.equal(d.tokenIn.toLowerCase(), USDC.toLowerCase());
    assert.equal(d.tokenOut.toLowerCase(), EURC.toLowerCase());
    assert.equal(d.amountIn, 123n);
    assert.equal(d.amountOut, 456n);
    assert.equal(d.reserveA, 30051878421n);
    assert.equal(d.reserveB, 38560072953n);
  });
});
