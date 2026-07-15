// ============================================================
// Unit tests — src/lib/dex-cache.mjs (verified DEX cache engine)
// ============================================================
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const root = path.resolve(__dirname, '../../..');
const modUrl = pathToFileURL(path.join(root, 'src/lib/dex-cache.mjs')).href;

const AMM  = '0x3148E2807F172D1cC354F35fB4fC4104e8b6b561';
const EURC = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const USDC = '0x3600000000000000000000000000000000000000';

const RESERVE_A = 30051878421n;
const RESERVE_B = 38560072953n;
const LP_SUPPLY = 8186623396n;
const BALANCE_A = RESERVE_A;                 // EURC exact
const BALANCE_B = RESERVE_B + 5_798_953n;    // audited +5.798953 USDC surplus

const w = (v) => v.toString(16).padStart(64, '0');

const SEL_RESERVES = '0x0902f1ac';
const SEL_SUPPLY   = '0x18160ddd';
const SEL_BALANCE  = '0x70a08231';

function mockRpc(overrides = {}) {
  let calls = 0;
  return {
    stats: () => calls,
    ethCall: async (to, data) => {
      calls++;
      if (overrides.fail) throw Object.assign(new Error('down'), { code: 'RPC_UNAVAILABLE' });
      const t = to.toLowerCase();
      if (t === AMM.toLowerCase() && data === SEL_RESERVES) return overrides.reservesHex || ('0x' + w(RESERVE_A) + w(RESERVE_B));
      if (t === AMM.toLowerCase() && data === SEL_SUPPLY) return '0x' + w(LP_SUPPLY);
      if (t === AMM.toLowerCase() && data.startsWith(SEL_BALANCE) && data.endsWith('0'.repeat(40))) return '0x' + w(1000n); // MINIMUM_LIQUIDITY at address(0)
      if (t === EURC.toLowerCase() && data.startsWith(SEL_BALANCE)) return '0x' + w(BALANCE_A);
      if (t === USDC.toLowerCase() && data.startsWith(SEL_BALANCE)) return '0x' + w(BALANCE_B);
      throw new Error(`unexpected ethCall ${to} ${data.slice(0, 10)}`);
    },
    call: async (method) => {
      calls++;
      if (overrides.fail) throw Object.assign(new Error('down'), { code: 'RPC_UNAVAILABLE' });
      if (method === 'eth_blockNumber') return overrides.blockHex !== undefined ? overrides.blockHex : '0x1000';
      throw new Error(`unexpected method ${method}`);
    },
    endpoints: () => ['mock'],
  };
}

describe('lib/dex-cache.mjs — verified DEX cache engine', () => {

  it('successful fetch: decodes reserves, TVL, priceRatio, donation, block', async () => {
    const { createDexCache } = await import(modUrl);
    const cache = createDexCache({ rpcClient: mockRpc(), ammAddress: AMM, eurcAddress: EURC, usdcAddress: USDC, log: () => {} });
    const s = await cache.getSnapshot();
    assert.equal(s.source, 'on-chain');
    assert.equal(s.reserveA, RESERVE_A);
    assert.equal(s.reserveB, RESERVE_B);
    assert.equal(s.totalSupply, LP_SUPPLY);
    assert.equal(s.blockNumber, 0x1000);
    assert.ok(Math.abs(s.tvl - 77120.145906) < 0.001);
    assert.ok(Math.abs(s.priceRatio.priceAinB - 1.283117) < 0.0001);
    assert.equal(s.donation.status, 'EXCESS_DETECTED');
    assert.equal(s.donation.excess[0].excessAmount, 5.798953);
  });

  it('cache hit within 15s TTL → source=cache, no extra RPC', async () => {
    const { createDexCache } = await import(modUrl);
    let t = 1_000_000;
    const rpc = mockRpc();
    const cache = createDexCache({ rpcClient: rpc, ammAddress: AMM, eurcAddress: EURC, usdcAddress: USDC, now: () => t, log: () => {} });
    await cache.getSnapshot();
    const after = rpc.stats();
    t += 14_999;
    const s = await cache.getSnapshot();
    assert.equal(s.source, 'cache');
    assert.equal(s.cacheAge, 14_999);
    assert.equal(rpc.stats(), after, 'fresh cache must not hit RPC');
  });

  it('cache expiration after TTL → refetches on-chain', async () => {
    const { createDexCache } = await import(modUrl);
    let t = 1_000_000;
    const rpc = mockRpc();
    const cache = createDexCache({ rpcClient: rpc, ammAddress: AMM, eurcAddress: EURC, usdcAddress: USDC, now: () => t, log: () => {} });
    await cache.getSnapshot();
    const after = rpc.stats();
    t += 15_001;
    const s = await cache.getSnapshot();
    assert.equal(s.source, 'on-chain');
    assert.gt(rpc.stats(), after);
  });

  it('RPC failure never overwrites valid cache → stale served as source=cache', async () => {
    const { createDexCache } = await import(modUrl);
    let t = 1_000_000;
    let failing = false;
    const good = mockRpc();
    const rpc = {
      ethCall: (...a) => failing ? Promise.reject(Object.assign(new Error('down'), { code: 'RPC_UNAVAILABLE' })) : good.ethCall(...a),
      call:    (...a) => failing ? Promise.reject(Object.assign(new Error('down'), { code: 'RPC_UNAVAILABLE' })) : good.call(...a),
    };
    const cache = createDexCache({ rpcClient: rpc, ammAddress: AMM, eurcAddress: EURC, usdcAddress: USDC, now: () => t, log: () => {} });
    await cache.getSnapshot();
    t += 60_000;
    failing = true;
    const s = await cache.getSnapshot();
    assert.equal(s.source, 'cache');
    assert.equal(s.cacheAge, 60_000);
    assert.equal(s.reserveA, RESERVE_A, 'stale cache keeps last verified reserves');
    assert.equal(s.tvl > 0, true);
  });

  it('no cache + RPC down → 503-grade RPC_UNAVAILABLE (never zero liquidity)', async () => {
    const { createDexCache } = await import(modUrl);
    const cache = createDexCache({ rpcClient: mockRpc({ fail: true }), ammAddress: AMM, eurcAddress: EURC, usdcAddress: USDC, log: () => {} });
    try {
      await cache.getSnapshot();
      assert.fail('expected RPC_UNAVAILABLE');
    } catch (e) {
      assert.equal(e.code, 'RPC_UNAVAILABLE');
    }
    assert.isNull(cache.peek());
  });

  it('invalid block number rejects the fetch — cache is not poisoned', async () => {
    const { createDexCache } = await import(modUrl);
    const cache = createDexCache({ rpcClient: mockRpc({ blockHex: '0x0' }), ammAddress: AMM, eurcAddress: EURC, usdcAddress: USDC, log: () => {} });
    try {
      await cache.getSnapshot();
      assert.fail('expected throw on invalid block');
    } catch (e) {
      assert.equal(e.code, 'RPC_UNAVAILABLE');
    }
    assert.isNull(cache.peek());
  });

  it('malformed reserves hex rejects the fetch — cache stays clean', async () => {
    const { createDexCache } = await import(modUrl);
    const cache = createDexCache({ rpcClient: mockRpc({ reservesHex: '0x' }), ammAddress: AMM, eurcAddress: EURC, usdcAddress: USDC, log: () => {} });
    try {
      await cache.getSnapshot();
      assert.fail('expected throw on malformed data');
    } catch (e) {
      assert.equal(e.code, 'RPC_UNAVAILABLE');
    }
    assert.isNull(cache.peek());
  });

  it('invalidate() forces refetch before TTL expiry', async () => {
    const { createDexCache } = await import(modUrl);
    let t = 1_000_000;
    const rpc = mockRpc();
    const cache = createDexCache({ rpcClient: rpc, ammAddress: AMM, eurcAddress: EURC, usdcAddress: USDC, now: () => t, log: () => {} });
    await cache.getSnapshot();
    cache.invalidate();
    t += 1;
    const s = await cache.getSnapshot();
    assert.equal(s.source, 'on-chain');
  });

  it('getMinimumLiquidity reads the locked 1000 units and memoizes', async () => {
    const { createDexCache } = await import(modUrl);
    const rpc = mockRpc();
    const cache = createDexCache({ rpcClient: rpc, ammAddress: AMM, eurcAddress: EURC, usdcAddress: USDC, log: () => {} });
    const min1 = await cache.getMinimumLiquidity();
    const callsAfter = rpc.stats();
    const min2 = await cache.getMinimumLiquidity();
    assert.equal(min1, 1000n);
    assert.equal(min2, 1000n);
    assert.equal(rpc.stats(), callsAfter, 'second read must be memoized');
  });

  it('ammAddress can be dynamic (function) — used at fetch time', async () => {
    const { createDexCache } = await import(modUrl);
    let addr = AMM;
    const cache = createDexCache({ rpcClient: mockRpc(), ammAddress: () => addr, eurcAddress: EURC, usdcAddress: USDC, log: () => {} });
    const s = await cache.getSnapshot();
    assert.equal(s.ammAddress, AMM);
  });
});
