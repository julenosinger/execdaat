// ============================================================
// Unit tests — src/lib/arc-rpc.mjs (multi-RPC failover)
// ============================================================
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const root = path.resolve(__dirname, '../../..');
const modUrl = pathToFileURL(path.join(root, 'src/lib/arc-rpc.mjs')).href;

function okJson(result) {
  return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
}
function errJson(code, message) {
  return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, error: { code, message } }) };
}

describe('lib/arc-rpc.mjs — multi-RPC failover', () => {

  it('RPC success: returns result from primary endpoint only', async () => {
    const { createRpcClient } = await import(modUrl);
    const calls = [];
    const client = createRpcClient({
      rpcs: ['https://rpc-a', 'https://rpc-b'],
      fetchFn: async (url) => { calls.push(url); return okJson('0x4cef52'); },
      log: () => {}, sleepFn: async () => {},
    });
    const res = await client.call('eth_chainId');
    assert.equal(res, '0x4cef52');
    assert.deepEqual(calls, ['https://rpc-a']);
  });

  it('RPC failover: JSON-RPC error on primary → secondary answers', async () => {
    const { createRpcClient } = await import(modUrl);
    const calls = [];
    const client = createRpcClient({
      rpcs: ['https://rpc-a', 'https://rpc-b'],
      retriesPerEndpoint: 1,
      fetchFn: async (url) => {
        calls.push(url);
        if (url === 'https://rpc-a') return errJson(-32011, 'request limit reached');
        return okJson('0xabc');
      },
      log: () => {}, sleepFn: async () => {},
    });
    const res = await client.call('eth_blockNumber');
    assert.equal(res, '0xabc');
    assert.deepEqual(calls, ['https://rpc-a', 'https://rpc-b']);
  });

  it('RPC timeout: hanging primary → failover to secondary', async () => {
    const { createRpcClient } = await import(modUrl);
    const calls = [];
    const client = createRpcClient({
      rpcs: ['https://rpc-hang', 'https://rpc-ok'],
      retriesPerEndpoint: 1,
      timeoutMs: 20,
      fetchFn: (url) => {
        calls.push(url);
        if (url === 'https://rpc-hang') return new Promise(() => {}); // never resolves
        return Promise.resolve(okJson('0x1'));
      },
      log: () => {}, sleepFn: async () => {},
    });
    const res = await client.call('eth_chainId');
    assert.equal(res, '0x1');
    assert.deepEqual(calls, ['https://rpc-hang', 'https://rpc-ok']);
  });

  it('RPC retry: exponential backoff within one endpoint', async () => {
    const { createRpcClient } = await import(modUrl);
    const sleeps = [];
    let attempts = 0;
    const client = createRpcClient({
      rpcs: ['https://rpc-flaky'],
      retriesPerEndpoint: 3,
      backoffBaseMs: 100,
      fetchFn: async () => {
        attempts++;
        if (attempts < 3) throw new Error('ECONNRESET');
        return okJson('0x2');
      },
      log: () => {}, sleepFn: async (ms) => { sleeps.push(ms); },
    });
    const res = await client.call('eth_blockNumber');
    assert.equal(res, '0x2');
    assert.equal(attempts, 3);
    assert.deepEqual(sleeps, [100, 200]); // 100 * 2^0, 100 * 2^1
  });

  it('all endpoints fail → throws code RPC_UNAVAILABLE (never fabricates)', async () => {
    const { createRpcClient } = await import(modUrl);
    const client = createRpcClient({
      rpcs: ['https://rpc-a', 'https://rpc-b', 'https://rpc-c'],
      retriesPerEndpoint: 2,
      fetchFn: async () => { throw new Error('network down'); },
      log: () => {}, sleepFn: async () => {},
    });
    try {
      await client.call('eth_chainId');
      assert.fail('expected RPC_UNAVAILABLE throw');
    } catch (e) {
      assert.equal(e.code, 'RPC_UNAVAILABLE');
      assert.includes(e.message, 'eth_chainId');
    }
  });

  it('HTTP non-ok response is treated as failure → failover', async () => {
    const { createRpcClient } = await import(modUrl);
    const client = createRpcClient({
      rpcs: ['https://rpc-500', 'https://rpc-ok'],
      retriesPerEndpoint: 1,
      fetchFn: async (url) => {
        if (url === 'https://rpc-500') return { ok: false, status: 500, json: async () => ({}) };
        return okJson('0x3');
      },
      log: () => {}, sleepFn: async () => {},
    });
    assert.equal(await client.call('eth_blockNumber'), '0x3');
  });

  it('default endpoint list has 4 Arc Testnet RPCs', async () => {
    const { ARC_RPC_URLS, createRpcClient } = await import(modUrl);
    assert.equal(ARC_RPC_URLS.length, 4);
    ARC_RPC_URLS.forEach((u) => assert.includes(u, 'arc.network'));
    const client = createRpcClient({ fetchFn: async () => okJson(null), log: () => {} });
    assert.equal(client.endpoints().length, 4);
  });

  it('structured log emitted for every attempt', async () => {
    const { createRpcClient } = await import(modUrl);
    const logs = [];
    const client = createRpcClient({
      rpcs: ['https://rpc-a', 'https://rpc-b'],
      retriesPerEndpoint: 1,
      fetchFn: async (url) => {
        if (url === 'https://rpc-a') throw new Error('boom');
        return okJson('0x1');
      },
      log: (f) => logs.push(f), sleepFn: async () => {},
    });
    await client.call('eth_chainId');
    assert.equal(logs.length, 2);
    assert.equal(logs[0].ok, false);
    assert.equal(logs[0].rpc, 'https://rpc-a');
    assert.equal(logs[1].ok, true);
    assert.ok(typeof logs[1].latencyMs === 'number');
  });
});
