// ============================================================
// Unit tests — src/lib/reserve-cache.mjs (verified reserve cache)
// ============================================================
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const root = path.resolve(__dirname, '../../..');
const modUrl = pathToFileURL(path.join(root, 'src/lib/reserve-cache.mjs')).href;

const AMM = '0x3148E2807F172D1cC354F35fB4fC4104e8b6b561';
const RESERVE_A = 30051878421n;   // EURC
const RESERVE_B = 38560072953n;   // USDC
const LP_SUPPLY = 8186623396n;

const w = (v) => v.toString(16).padStart(64, '0');
const RESERVES_HEX = '0x' + w(RESERVE_A) + w(RESERVE_B);
const SUPPLY_HEX   = '0x' + w(LP_SUPPLY);

function mockRpc(overrides = {}) {
  let ethCalls = 0;
  const client = {
    ethCall: async (_to, selector) => {
      ethCalls++;
      if (overrides.fail) throw Object.assign(new Error('all RPCs down'), { code: 'RPC_UNAVAILABLE' });
      if (selector === '0x0902f1ac') return overrides.reservesHex || RESERVES_HEX;
      if (selector === '0x18160ddd') return SUPPLY_HEX;
      throw new Error('unexpected selector ' + selector);
    },
    call: async (method) => {
      if (overrides.fail) throw Object.assign(new Error('all RPCs down'), { code: 'RPC_UNAVAILABLE' });
      if (method === 'eth_blockNumber') return overrides.blockHex || '0x1000';
      throw new Error('unexpected method ' + method);
    },
    endpoints: () => ['mock'],
    stats: () => ethCalls,
  };
  return client;
}

describe('lib/reserve-cache.mjs — verified reserve cache', () => {

  it('RPC success: decodes real reserves, source = on-chain', async () => {
    const { createReserveCache } = await import(modUrl);
    const cache = createReserveCache({ rpcClient: mockRpc(), ammAddress: AMM, log: () => {} });
    const snap = await cache.getReserves();
    assert.equal(snap.reserveA, RESERVE_A);
    assert.equal(snap.reserveB, RESERVE_B);
    assert.equal(snap.totalSupply, LP_SUPPLY);
    assert.equal(snap.blockNumber, 0x1000);
    assert.equal(snap.source, 'on-chain');
    assert.equal(snap.cacheAge, 0);
  });

  it('cache hit: second read within TTL → source = cache + cacheAge, no RPC', async () => {
    const { createReserveCache } = await import(modUrl);
    let t = 1_000_000;
    const rpc = mockRpc();
    const cache = createReserveCache({ rpcClient: rpc, ammAddress: AMM, now: () => t, log: () => {} });
    await cache.getReserves();
    const rpcCallsAfterFirst = rpc.stats();
    t += 5_000; // still < 15s TTL
    const snap = await cache.getReserves();
    assert.equal(snap.source, 'cache');
    assert.equal(snap.cacheAge, 5_000);
    assert.equal(snap.reserveA, RESERVE_A);
    assert.equal(rpc.stats(), rpcCallsAfterFirst, 'must not hit RPC on fresh cache');
  });

  it('cache expiration: read after TTL refreshes from chain (source = on-chain)', async () => {
    const { createReserveCache } = await import(modUrl);
    let t = 1_000_000;
    const rpc = mockRpc();
    const cache = createReserveCache({ rpcClient: rpc, ammAddress: AMM, now: () => t, log: () => {} });
    await cache.getReserves();
    const callsAfterFirst = rpc.stats();
    t += 30_001; // TTL expired (request-optimization: TTL raised 15s → 30s)
    const snap = await cache.getReserves();
    assert.equal(snap.source, 'on-chain');
    assert.equal(snap.cacheAge, 0);
    assert.gt(rpc.stats(), callsAfterFirst, 'expired cache must refetch');
  });

  it('cache refresh failure: stale cache served as source = cache, never overwritten', async () => {
    const { createReserveCache } = await import(modUrl);
    let t = 1_000_000;
    let failNow = false;
    const good = mockRpc();
    const rpc = {
      ethCall: (...a) => failNow ? Promise.reject(Object.assign(new Error('down'), { code: 'RPC_UNAVAILABLE' })) : good.ethCall(...a),
      call:    (...a) => failNow ? Promise.reject(Object.assign(new Error('down'), { code: 'RPC_UNAVAILABLE' })) : good.call(...a),
    };
    const cache = createReserveCache({ rpcClient: rpc, ammAddress: AMM, now: () => t, log: () => {} });
    await cache.getReserves();
    t += 60_000;
    failNow = true;
    const snap = await cache.getReserves();
    assert.equal(snap.source, 'cache');
    assert.equal(snap.cacheAge, 60_000);
    assert.equal(snap.reserveA, RESERVE_A, 'stale cache must keep last VERIFIED reserves');
    assert.equal(snap.reserveB, RESERVE_B);
  });

  it('no cache + RPC failure → throws RPC_UNAVAILABLE (never fabricates 460k/500k)', async () => {
    const { createReserveCache } = await import(modUrl);
    const cache = createReserveCache({ rpcClient: mockRpc({ fail: true }), ammAddress: AMM, log: () => {} });
    try {
      await cache.getReserves();
      assert.fail('expected RPC_UNAVAILABLE throw');
    } catch (e) {
      assert.equal(e.code, 'RPC_UNAVAILABLE');
      assert.includes(e.message, 'Unable to fetch on-chain reserves');
    }
  });

  it('invalidate(): next read bypasses TTL and refetches on-chain', async () => {
    const { createReserveCache } = await import(modUrl);
    let t = 1_000_000;
    const rpc = mockRpc();
    const cache = createReserveCache({ rpcClient: rpc, ammAddress: AMM, now: () => t, log: () => {} });
    await cache.getReserves();
    cache.invalidate();
    t += 1;
    const snap = await cache.getReserves();
    assert.equal(snap.source, 'on-chain');
  });

  it('malformed eth_call result is rejected, cache stays clean', async () => {
    const { createReserveCache } = await import(modUrl);
    const cache = createReserveCache({
      rpcClient: mockRpc({ reservesHex: '0x' }), ammAddress: AMM, log: () => {},
    });
    try {
      await cache.getReserves();
      assert.fail('expected throw on malformed data');
    } catch (e) {
      assert.equal(e.code, 'RPC_UNAVAILABLE');
    }
    assert.isNull(cache.peek(), 'failed decode must never populate cache');
  });

  it('lastSuccessfulFetch is exposed and only moves on success', async () => {
    const { createReserveCache } = await import(modUrl);
    let t = 1_000_000;
    const rpc = mockRpc();
    const cache = createReserveCache({ rpcClient: rpc, ammAddress: AMM, now: () => t, log: () => {} });
    const first = await cache.getReserves();
    assert.equal(first.lastSuccessfulFetch, 1_000_000);
    t += 3_000;
    const second = await cache.getReserves();
    assert.equal(second.lastSuccessfulFetch, 1_000_000, 'cache hit must not bump lastSuccessfulFetch');
  });
});
