'use strict';
// ============================================================
// Arc Transaction Memo Engine — unit tests
// Cross-checks the dependency-free ABI encoding against ethers v6
// and verifies validation, graceful degradation and builders.
// ============================================================
const path = require('path');
const root = path.resolve(__dirname, '../../..');
const ethers = require(path.join(root, 'node_modules', 'ethers'));

// Loaded for its side effect (attaches to the mocked window, same pattern as
// the shared/* tests — package.json "type":"module" makes require() return {}).
require(path.join(root, 'public/static/memo/memo-engine.js'));
const M = global.window.MemoEngine;

const MEMO_IFACE = new ethers.Interface([
  'function memo(address target, bytes data, bytes32 memoId, bytes memoData)',
]);
const ERC20_IFACE = new ethers.Interface([
  'function transfer(address to, uint256 amount) returns (bool)',
]);

const USDC = '0x3600000000000000000000000000000000000000';
const RECIPIENT = '0x1111111111111111111111111111111111111111';

function ethersEncode(target, data, memoId, memoData) {
  return MEMO_IFACE.encodeFunctionData('memo', [target, data, memoId, memoData]);
}

describe('memo-engine: constants', () => {
  it('uses the official Arc Memo contract address', () => {
    assert.equal(M.MEMO_ADDRESS, '0x5294E9927c3306DcBaDb03fe70b92e01cCede505');
  });
  it('targets Arc Testnet chain id 5042002', () => {
    assert.equal(M.ARC_CHAIN_ID, 5042002);
  });
  it('selector matches memo(address,bytes,bytes32,bytes)', () => {
    assert.equal(M.MEMO_SELECTOR, MEMO_IFACE.getFunction('memo').selector);
  });
  it('event topic matches Memo(address,address,bytes32,bytes32,bytes,uint256)', () => {
    assert.equal(M.MEMO_EVENT_TOPIC, ethers.id('Memo(address,address,bytes32,bytes32,bytes,uint256)'));
  });
});

describe('memo-engine: validate', () => {
  it('rejects empty string', () => { assert.equal(M.validate('').ok, false); assert.equal(M.validate('').reason, 'empty'); });
  it('rejects whitespace-only', () => { assert.equal(M.validate('   ').ok, false); });
  it('rejects non-strings', () => {
    assert.equal(M.validate(null).ok, false);
    assert.equal(M.validate(undefined).ok, false);
    assert.equal(M.validate(123).ok, false);
    assert.equal(M.validate({}).ok, false);
  });
  it('accepts a normal memo', () => {
    const v = M.validate('Invoice #123');
    assert.ok(v.ok); assert.equal(v.chars, 12);
  });
  it('accepts exactly max chars', () => {
    assert.ok(M.validate('a'.repeat(M.maxChars())).ok);
  });
  it('rejects above max chars', () => {
    const v = M.validate('a'.repeat(M.maxChars() + 1));
    assert.equal(v.ok, false); assert.equal(v.reason, 'too_long');
  });
  it('rejects multibyte payloads above the byte cap', () => {
    // 130 chars of a 2-byte UTF-8 char = 260 bytes > 256 byte cap (chars still <= 200)
    const v = M.validate('é'.repeat(130));
    assert.equal(v.ok, false); assert.equal(v.reason, 'too_many_bytes');
  });
});

describe('memo-engine: encoding', () => {
  it('encodeMemoData matches ethers UTF-8 encoding', () => {
    const text = 'order=2026-0001 · pagaménto ✓';
    assert.equal(M.encodeMemoData(text), ethers.hexlify(ethers.toUtf8Bytes(text)));
  });
  it('encodeMemoData returns null for invalid input', () => {
    assert.equal(M.encodeMemoData(''), null);
    assert.equal(M.encodeMemoData(null), null);
    assert.equal(M.encodeMemoData('a'.repeat(1000)), null);
  });
  it('encodeMemoCall matches ethers for a USDC transfer (short memo)', () => {
    const data = ERC20_IFACE.encodeFunctionData('transfer', [RECIPIENT, 1000000n]);
    const memoId = ethers.id('invoice-2026-0001');
    const memoData = ethers.hexlify(ethers.toUtf8Bytes('order=2026-0001'));
    assert.equal(M.encodeMemoCall(USDC, data, memoId, memoData), ethersEncode(USDC, data, memoId, memoData));
  });
  it('encodeMemoCall matches ethers for word-aligned memo bytes (32 bytes)', () => {
    const data = ERC20_IFACE.encodeFunctionData('transfer', [RECIPIENT, 42n]);
    const memoId = ethers.id('seed-b');
    const memoData = ethers.hexlify(ethers.toUtf8Bytes('a'.repeat(32)));
    assert.equal(M.encodeMemoCall(USDC, data, memoId, memoData), ethersEncode(USDC, data, memoId, memoData));
  });
  it('encodeMemoCall matches ethers for 33-byte memo (word boundary + 1)', () => {
    const data = ERC20_IFACE.encodeFunctionData('transfer', [RECIPIENT, 42n]);
    const memoId = ethers.id('seed-c');
    const memoData = ethers.hexlify(ethers.toUtf8Bytes('a'.repeat(33)));
    assert.equal(M.encodeMemoCall(USDC, data, memoId, memoData), ethersEncode(USDC, data, memoId, memoData));
  });
  it('encodeMemoCall matches ethers for long inner calldata (batch-style)', () => {
    const inner = '0x' + 'ab'.repeat(4 + 32 * 9 + 7); // non-aligned length
    const memoId = ethers.id('seed-d');
    const memoData = ethers.hexlify(ethers.toUtf8Bytes('Payroll July'));
    assert.equal(M.encodeMemoCall(USDC, inner, memoId, memoData), ethersEncode(USDC, inner, memoId, memoData));
  });
  it('encodeMemoCall rejects invalid inputs (null, bad address, empty memo)', () => {
    const data = ERC20_IFACE.encodeFunctionData('transfer', [RECIPIENT, 1n]);
    const memoId = ethers.id('x');
    assert.equal(M.encodeMemoCall('0x123', data, memoId, '0x61'), null);
    assert.equal(M.encodeMemoCall(USDC, 'nothex', memoId, '0x61'), null);
    assert.equal(M.encodeMemoCall(USDC, data, '0xshort', '0x61'), null);
    assert.equal(M.encodeMemoCall(USDC, data, memoId, '0x'), null);
  });
});

describe('memo-engine: memoId', () => {
  it('buildMemoId returns 32-byte hex', () => {
    const id = M.buildMemoId();
    assert.ok(/^0x[0-9a-f]{64}$/i.test(id));
  });
  it('buildMemoId is deterministic for a seed when ethers is available on window', () => {
    global.window.ethers = ethers;
    try {
      assert.equal(M.buildMemoId('invoice-2026-0001'), ethers.id('invoice-2026-0001'));
    } finally { delete global.window.ethers; }
  });
});

describe('memo-engine: network support', () => {
  it('isSupportedSync accepts Arc Testnet only', () => {
    assert.ok(M.isSupportedSync(5042002));
    assert.ok(M.isSupportedSync('0x4cef52'));
    assert.equal(M.isSupportedSync(1), false);
    assert.equal(M.isSupportedSync('0x1'), false);
    assert.equal(M.isSupportedSync(null), false);
    assert.equal(M.isSupportedSync(undefined), false);
  });
  it('isSupported resolves false gracefully when the provider fails (never throws)', async () => {
    M._resetSupportCache();
    const broken = { request: async () => { throw new Error('boom'); } };
    const ok = await M.isSupported({ provider: broken });
    assert.equal(ok, false);
    M._resetSupportCache();
  });
  it('isSupported resolves false on wrong chain', async () => {
    M._resetSupportCache();
    const eth1 = { request: async (o) => { if (o.method === 'eth_chainId') return '0x1'; throw new Error('no'); } };
    assert.equal(await M.isSupported({ provider: eth1 }), false);
    M._resetSupportCache();
  });
  it('isSupported resolves true on Arc when Memo bytecode exists', async () => {
    M._resetSupportCache();
    const arc = { request: async (o) => {
      if (o.method === 'eth_chainId') return '0x4cef52';
      if (o.method === 'eth_getCode') return '0x60806040';
      throw new Error('unexpected ' + o.method);
    } };
    assert.equal(await M.isSupported({ provider: arc }), true);
    M._resetSupportCache();
  });
});

describe('memo-engine: builders', () => {
  it('buildTxSync produces a wallet-agnostic tx object', () => {
    const data = ERC20_IFACE.encodeFunctionData('transfer', [RECIPIENT, 5000000n]);
    const tx = M.buildTxSync({ target: USDC, data, memoText: 'Consulting payment' });
    assert.ok(tx);
    assert.equal(tx.to, M.MEMO_ADDRESS);
    assert.equal(tx.value, '0x0');
    assert.ok(tx.data.startsWith(M.MEMO_SELECTOR));
    assert.ok(/^0x[0-9a-f]{64}$/i.test(tx.memoId));
    // decodes cleanly with the official ABI
    const decoded = MEMO_IFACE.decodeFunctionData('memo', tx.data);
    assert.equal(decoded[0].toLowerCase(), USDC.toLowerCase());
    assert.equal(decoded[1], data.toLowerCase());
    assert.equal(ethers.toUtf8String(decoded[3]), 'Consulting payment');
  });
  it('buildTxSync honours a caller-supplied memoId', () => {
    const data = ERC20_IFACE.encodeFunctionData('transfer', [RECIPIENT, 1n]);
    const memoId = ethers.id('invoice-77');
    const tx = M.buildTxSync({ target: USDC, data, memoText: 'Invoice #77', memoId });
    assert.equal(tx.memoId, memoId);
  });
  it('buildTxSync returns null for invalid memo/target/data (never throws)', () => {
    const data = ERC20_IFACE.encodeFunctionData('transfer', [RECIPIENT, 1n]);
    assert.equal(M.buildTxSync({ target: USDC, data, memoText: '' }), null);
    assert.equal(M.buildTxSync({ target: USDC, data, memoText: '   ' }), null);
    assert.equal(M.buildTxSync({ target: USDC, data, memoText: 'a'.repeat(9999) }), null);
    assert.equal(M.buildTxSync({ target: 'bad', data, memoText: 'ok' }), null);
    assert.equal(M.buildTxSync({ target: USDC, data: 'bad', memoText: 'ok' }), null);
    assert.equal(M.buildTxSync(null), null);
  });
  it('buildTx returns null when the network is unsupported (graceful, no throw)', async () => {
    M._resetSupportCache();
    const eth1 = { request: async (o) => { if (o.method === 'eth_chainId') return '0x1'; throw new Error('no'); } };
    const data = ERC20_IFACE.encodeFunctionData('transfer', [RECIPIENT, 1n]);
    assert.equal(await M.buildTx({ target: USDC, data, memoText: 'Invoice', provider: eth1 }), null);
    M._resetSupportCache();
  });
});

describe('memo-engine: wrapEthSendParams', () => {
  function arcProvider() {
    return { request: async (o) => {
      if (o.method === 'eth_chainId') return '0x4cef52';
      if (o.method === 'eth_getCode') return '0x6080';
      throw new Error('unexpected ' + o.method);
    } };
  }
  it('wraps a plain eth_sendTransaction params object', async () => {
    M._resetSupportCache();
    const data = ERC20_IFACE.encodeFunctionData('transfer', [RECIPIENT, 123n]);
    const params = { from: RECIPIENT, to: USDC, data, value: '0x0', gas: '0x5208', gasPrice: '0x1' };
    const w = await M.wrapEthSendParams(params, 'Vendor payment', { provider: arcProvider() });
    assert.ok(w);
    assert.equal(w.to, M.MEMO_ADDRESS);
    assert.equal(w.from, RECIPIENT);
    assert.equal(w.gasPrice, '0x1');
    assert.equal(w.gas, undefined, 'gas must be dropped so the wallet re-estimates');
    const decoded = MEMO_IFACE.decodeFunctionData('memo', w.data);
    assert.equal(decoded[0].toLowerCase(), USDC.toLowerCase());
    M._resetSupportCache();
  });
  it('refuses to wrap value-carrying calls (Memo.memo is nonpayable)', async () => {
    M._resetSupportCache();
    const data = ERC20_IFACE.encodeFunctionData('transfer', [RECIPIENT, 1n]);
    assert.equal(await M.wrapEthSendParams({ from: RECIPIENT, to: USDC, data, value: '0xde0b6b3a7640000' }, 'x', { provider: arcProvider() }), null);
    M._resetSupportCache();
  });
  it('returns null for malformed params (never throws)', async () => {
    assert.equal(await M.wrapEthSendParams(null, 'x'), null);
    assert.equal(await M.wrapEthSendParams({ to: 'bad', data: '0x' }, 'x'), null);
  });
});
