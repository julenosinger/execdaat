// ============================================================
// Unit tests — src/lib/rpc-proxy-core.mjs (/api/rpc validation)
// ============================================================
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const root = path.resolve(__dirname, '../../..');
const modUrl = pathToFileURL(path.join(root, 'src/lib/rpc-proxy-core.mjs')).href;

describe('lib/rpc-proxy-core.mjs — /api/rpc validation', () => {

  it('accepts single read-only request', async () => {
    const { validateRpcPayload } = await import(modUrl);
    const v = validateRpcPayload({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] });
    assert.equal(v.ok, true);
    assert.equal(v.isBatch, false);
    assert.deepEqual(v.methods, ['eth_call']);
  });

  it('accepts batch payloads (ethers v6 batches by default)', async () => {
    const { validateRpcPayload } = await import(modUrl);
    const v = validateRpcPayload([
      { jsonrpc: '2.0', id: 1, method: 'eth_chainId' },
      { jsonrpc: '2.0', id: 2, method: 'eth_blockNumber' },
      { jsonrpc: '2.0', id: 3, method: 'eth_getBalance', params: ['0x' + '1'.repeat(40), 'latest'] },
    ]);
    assert.equal(v.ok, true);
    assert.equal(v.isBatch, true);
    assert.equal(v.methods.length, 3);
  });

  it('accepts eth_sendRawTransaction (broadcast only) and eth_gasPrice (the failing wallet call)', async () => {
    const { validateRpcPayload } = await import(modUrl);
    assert.equal(validateRpcPayload({ id: 1, method: 'eth_gasPrice' }).ok, true);
    assert.equal(validateRpcPayload({ id: 1, method: 'eth_sendRawTransaction', params: ['0x02f8...'] }).ok, true);
  });

  it('rejects non-whitelisted methods (accounts, signing, admin)', async () => {
    const { validateRpcPayload } = await import(modUrl);
    for (const method of ['eth_accounts', 'eth_sign', 'eth_sendTransaction', 'personal_sign', 'admin_peers', 'debug_traceCall', '']) {
      const v = validateRpcPayload({ jsonrpc: '2.0', id: 1, method });
      assert.equal(v.ok, false, `should reject ${method || '(empty)'}`);
      assert.equal(v.code, -32601);
    }
  });

  it('rejects empty and oversized batches', async () => {
    const { validateRpcPayload, MAX_RPC_BATCH } = await import(modUrl);
    assert.equal(validateRpcPayload([]).ok, false);
    const huge = Array.from({ length: MAX_RPC_BATCH + 1 }, (_, i) => ({ id: i, method: 'eth_call' }));
    const v = validateRpcPayload(huge);
    assert.equal(v.ok, false);
    assert.equal(v.code, -32600);
  });

  it('detects upstream rate-limit errors (single and batch)', async () => {
    const { isRateLimitError } = await import(modUrl);
    assert.equal(isRateLimitError({ jsonrpc: '2.0', id: 1, error: { code: -32011, message: 'request limit reached' } }), true);
    assert.equal(isRateLimitError({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'rate limit exceeded' } }), true);
    assert.equal(isRateLimitError([{ id: 1, result: '0x1' }, { id: 2, error: { code: 429, message: 'Too Many Requests' } }]), true);
    assert.equal(isRateLimitError({ jsonrpc: '2.0', id: 1, result: '0x1' }), false);
    assert.equal(isRateLimitError({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } }), false);
  });

  it('buildErrorResponse echoes request ids and shape', async () => {
    const { buildErrorResponse } = await import(modUrl);
    const single = buildErrorResponse([{ id: 7 }], false, -32000, 'down');
    assert.equal(single.id, 7);
    assert.equal(single.error.code, -32000);
    const batch = buildErrorResponse([{ id: 1 }, { id: 'abc' }], true, -32601, 'no');
    assert.equal(batch.length, 2);
    assert.equal(batch[1].id, 'abc');
  });
});
