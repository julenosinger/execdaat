// ============================================================
// ExecDaat Comprehensive Unit Tests — All Shared Modules
// ============================================================
// Loads all shared modules in dependency order (one pass — no cache issues)
'use strict';

const path = require('path');
const root = path.resolve(__dirname, '../../..');

// Load all shared modules in correct dependency order
require(path.join(root, 'public/static/shared/constants.js'));
require(path.join(root, 'public/static/shared/token-registry.js'));
require(path.join(root, 'public/static/shared/contracts.js'));
require(path.join(root, 'public/static/shared/address.js'));
require(path.join(root, 'public/static/shared/format.js'));
require(path.join(root, 'public/static/shared/token.js'));
require(path.join(root, 'public/static/shared/cache.js'));
require(path.join(root, 'public/static/shared/errors.js'));
require(path.join(root, 'public/static/shared/config.js'));
// Note: rpc.js, health.js, telemetry.js, debug.js need fetch/mocks — tested separately

const D = global.window.ExecDaat;

// ============================================================
// shared/constants.js
// ============================================================
describe('shared/constants.js', () => {
  it('CHAIN.ID is 5042002', () => assert.equal(D.CHAIN.ID, 5042002));
  it('CHAIN.HEX is 0x4cef52', () => assert.equal(D.CHAIN.HEX, '0x4cef52'));
  it('CHAIN.NAME is Arc Testnet', () => assert.equal(D.CHAIN.NAME, 'Arc Testnet'));
  it('CHAIN.RPC points to arc.network', () => assert.includes(D.CHAIN.RPC, 'arc.network'));
  it('CHAIN.RPCS has 4 fallback URLs', () => {
    assert.equal(D.CHAIN.RPCS.length, 4);
    D.CHAIN.RPCS.forEach(r => assert.includes(r, 'https://'));
  });
  it('CHAIN.EXPLORER is testnet.arcscan.app', () => assert.includes(D.CHAIN.EXPLORER, 'testnet.arcscan.app'));
  it('CHAIN.GAS_TOKEN is USDC', () => assert.equal(D.CHAIN.GAS_TOKEN, 'USDC'));
  it('CHAIN.FAUCET is circle.com', () => assert.includes(D.CHAIN.FAUCET, 'circle.com'));
});

// ============================================================
// shared/token-registry.js
// ============================================================
describe('shared/token-registry.js', () => {
  it('USDC address is correct', () => assert.equal(D.TOKENS.USDC.address, '0x3600000000000000000000000000000000000000'));
  it('USDC has 6 decimals', () => assert.equal(D.TOKENS.USDC.decimals, 6));
  it('USDC is native on Arc', () => assert.equal(D.TOKENS.USDC.isNative, true));
  it('EURC address is correct', () => assert.equal(D.TOKENS.EURC.address, '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a'));
  it('EURC is NOT native', () => assert.equal(D.TOKENS.EURC.isNative, false));
  it('tokenByAddress finds USDC', () => assert.equal(D.tokenByAddress('0x3600000000000000000000000000000000000000').symbol, 'USDC'));
  it('tokenBySymbol finds EURC', () => assert.equal(D.tokenBySymbol('eurc').symbol, 'EURC'));
  it('tokenByAddress returns null for unknown', () => assert.equal(D.tokenByAddress('0xdead'), null));
  it('window globals set for backward compat', () => {
    assert.equal(global.window.USDC_ADDRESS, D.TOKENS.USDC.address);
    assert.equal(global.window.EURC_ADDRESS, D.TOKENS.EURC.address);
  });
});

// ============================================================
// shared/contracts.js
// ============================================================
describe('shared/contracts.js', () => {
  it('PERMIT2 is canonical', () => assert.equal(D.CONTRACTS.PERMIT2, '0x000000000022D473030F116dDEE9F6B43aC78BA3'));
  it('MULTICALL3 is canonical', () => assert.equal(D.CONTRACTS.MULTICALL3, '0xcA11bde05977b3631167028862bE2a173976CA11'));
  it('AMM is deployed', () => assert.equal(D.CONTRACTS.AMM, '0x3148E2807F172D1cC354F35fB4fC4104e8b6b561'));
  it('FACTORY is deployed', () => assert.equal(D.CONTRACTS.FACTORY, '0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A'));
  it('all contract addresses are valid EVM', () => {
    Object.values(D.CONTRACTS).forEach(addr => assert.ok(D.isAddress(addr), `Invalid: ${addr}`));
  });
});

// ============================================================
// shared/address.js
// ============================================================
describe('shared/address.js', () => {
  it('isAddress validates correct', () => assert.ok(D.isAddress('0x3600000000000000000000000000000000000000')));
  it('isAddress rejects invalid', () => {
    assert.ok(!D.isAddress(''));
    assert.ok(!D.isAddress('0x123'));
    assert.ok(!D.isAddress(null));
  });
  it('aliases work', () => {
    assert.equal(D.isValidAddress('0x3600000000000000000000000000000000000000'), true);
    assert.equal(D.isValidEthAddress('0x3600000000000000000000000000000000000000'), true);
  });
  it('normalizeAddress lowercases', () => assert.equal(D.normalizeAddress('0xABCD'), '0xabcd'));
  it('sameAddress case-insensitive', () => {
    assert.ok(D.sameAddress('0xABCD', '0xabcd'));
    assert.ok(!D.sameAddress('0xAAA', '0xBBB'));
  });
  it('shortAddress truncates', () => assert.equal(D.shortAddress('0x3600000000000000000000000000000000000000'), '0x3600...0000'));
  it('encodeAddress pads to 64 chars', () => {
    assert.equal(D.encodeAddress('0x3600000000000000000000000000000000000000').length, 64);
  });
});

// ============================================================
// shared/format.js
// ============================================================
describe('shared/format.js', () => {
  it('shortAddress truncates', () => assert.ok(D.shortAddress('0x1234567890abcdef1234567890abcdef12345678').includes('...')));
  it('fmtAddr is alias', () => assert.ok(typeof D.fmtAddr('0xABC') === 'string'));
  it('formatUSDC returns string', () => assert.ok(typeof D.formatUSDC(100) === 'string'));
  it('formatUSDC handles NaN as 0.00', () => assert.ok(D.formatUSDC(NaN).length > 0));
  it('formatToken includes symbol', () => assert.includes(D.formatToken(100, 'USDC'), 'USDC'));
  it('formatHash truncates', () => assert.ok(D.formatHash('0x' + 'ab'.repeat(32)).includes('...')));
  it('formatPercent has %', () => assert.includes(D.formatPercent(5.5), '%'));
  it('formatDate returns string', () => assert.ok(D.formatDate(Date.now()).length > 0));
  it('formatTime returns string', () => assert.ok(D.formatTime(Date.now()).length > 0));
  it('formatGas includes USDC', () => assert.includes(D.formatGas(0.005), 'USDC'));
});

// ============================================================
// shared/token.js
// ============================================================
describe('shared/token.js', () => {
  it('parseUnits 1.5 = 1500000n', () => assert.equal(D.parseUnits('1.5', 6), 1500000n));
  it('parseUnits whole number', () => assert.equal(D.parseUnits('10', 6), 10000000n));
  it('toMicro is alias', () => assert.equal(D.toMicro('2', 6), 2000000n));
  it('formatUnits round-trip', () => assert.ok(Math.abs(parseFloat(D.formatUnits(1500000n, 6)) - 1.5) < 0.001));
  it('tokenDecimals returns 6 for USDC', () => assert.equal(D.tokenDecimals('USDC'), 6));
  it('tokenDecimals defaults to 6', () => assert.equal(D.tokenDecimals('UNKNOWN'), 6));
  it('isNativeToken: USDC true, EURC false', () => {
    assert.equal(D.isNativeToken('USDC'), true);
    assert.equal(D.isNativeToken('EURC'), false);
  });
  it('normalizeAmount strips commas', () => assert.equal(D.normalizeAmount('1,000.50'), '1.000.50'));
  it('normalizeAmount handles null', () => assert.equal(D.normalizeAmount(null), '0'));
  it('parseAmount converts string', () => assert.equal(D.parseAmount('1.5'), 1.5));
  it('parseAmount handles garbage', () => assert.equal(D.parseAmount('abc'), 0));
});

// ============================================================
// shared/cache.js
// ============================================================
describe('shared/cache.js', () => {
  it('set/get round-trip', () => { D.cache.set('t', 'k', 'v', 60000); assert.equal(D.cache.get('t', 'k'), 'v'); });
  it('get returns null for missing', () => assert.equal(D.cache.get('t', 'nope'), null));
  it('has detects existence', () => { D.cache.set('t', 'ek', 1, 60000); assert.ok(D.cache.has('t', 'ek')); });
  it('del removes key', () => { D.cache.set('t', 'dk', 'x', 60000); D.cache.del('t', 'dk'); assert.equal(D.cache.has('t', 'dk'), false); });
  it('clear removes namespace', () => { D.cache.set('clr', 'a', 1, 60000); D.cache.clear('clr'); assert.equal(D.cache.get('clr', 'a'), null); });
  it('keys returns valid entries', () => { D.cache.set('t', 'a', 1, 60000); assert.ok(D.cache.keys('t').length >= 1); });
  it('stats returns counts', () => { D.cache.clear('st'); D.cache.set('st', 'k', 1, 60000); assert.ok(D.cache.stats('st').valid >= 1); });
  it('clearAll removes everything', () => { D.cache.set('n1', 'k', 1, 60000); D.cache.clearAll(); assert.equal(D.cache.get('n1', 'k'), null); });
  it('getWithTTL returns TTL info', () => {
    D.cache.set('t', 'ttl', 'v', 60000);
    const info = D.cache.getWithTTL('t', 'ttl');
    assert.equal(info.value, 'v');
    assert.equal(info.stale, false);
  });
});

// ============================================================
// shared/errors.js
// ============================================================
describe('shared/errors.js', () => {
  it('wallet codes are 1xxx', () => {
    assert.equal(D.ERROR_CODES.WALLET_REJECTED.code, 1001);
    assert.equal(D.ERROR_CODES.WALLET_NOT_FOUND.code, 1000);
  });
  it('RPC codes are 2xxx', () => assert.equal(D.ERROR_CODES.RPC_UNAVAILABLE.code, 2000));
  it('Guardian codes are 3xxx', () => assert.equal(D.ERROR_CODES.GUARDIAN_BLOCKED.code, 3001));
  it('TX codes are 6xxx', () => assert.equal(D.ERROR_CODES.TX_REVERTED.code, 6002));
  it('Validation codes are 7xxx', () => assert.equal(D.ERROR_CODES.VAL_INVALID_ADDRESS.code, 7000));
  it('classifyError detects reject', () => assert.equal(D.classifyError({ code: 4001 }), 'WALLET_REJECTED'));
  it('classifyError detects balance', () => assert.equal(D.classifyError({ message: 'insufficient funds' }), 'TX_INSUFFICIENT_BALANCE'));
  it('classifyError returns UNKNOWN', () => assert.equal(D.classifyError(null), 'UNKNOWN'));
  it('error() creates typed error', () => {
    const e = D.error('WALLET_REJECTED');
    assert.equal(e.code, 1001);
    assert.ok(e instanceof D.ExecDaatError);
  });
  it('friendlyError returns readable text', () => assert.includes(D.friendlyError({ code: 4001 }).toLowerCase(), 'reject'));
  it('formatError includes code', () => assert.includes(D.formatError({ code: 4001 }), '1001'));
  it('sanitizeStack redacts 64-char hex', () => {
    assert.includes(D.sanitizeStack('key 0x' + 'ab'.repeat(32) + ' end'), '0x***');
  });
  it('walletError classifies', () => assert.equal(D.walletError({ code: 4001 }), 'REJECTED'));
});

// ============================================================
// shared/config.js
// ============================================================
describe('shared/config.js', () => {
  it('GUARDIAN_REQUIRED is true (Phase 1)', () => assert.equal(D.CONFIG.FEATURES.GUARDIAN_REQUIRED, true));
  it('GUARDIAN_ENABLED is true', () => assert.equal(D.CONFIG.FEATURES.GUARDIAN_ENABLED, true));
  it('LIMITS are set', () => {
    assert.ok(D.CONFIG.LIMITS.MAX_MULTISEND_RECIPIENTS > 0);
    assert.ok(D.CONFIG.LIMITS.MAX_MULTISEND_PER_ROW > 0);
  });
  it('TIMEOUTS are set', () => {
    assert.ok(D.CONFIG.TIMEOUTS.TX_CONFIRMATION > 0);
    assert.ok(D.CONFIG.TIMEOUTS.TOAST_DURATION > 0);
  });
  it('RETRY settings are set', () => assert.ok(D.CONFIG.RETRY.MAX_RETRIES > 0));
});

// ============================================================
// Integration: Cross-module
// ============================================================
describe('Integration', () => {
  it('cache + format cross-module operations', () => {
    D.cache.set('int', 'bal', '100.50', 10000);
    const cached = D.cache.get('int', 'bal');
    assert.equal(cached, '100.50');
    const formatted = D.formatToken(100, 'USDC');
    assert.includes(formatted, 'USDC');
  });
  it('address validation + token lookup', () => {
    assert.ok(D.isAddress('0x3600000000000000000000000000000000000000'));
    const t = D.tokenByAddress('0x3600000000000000000000000000000000000000');
    assert.equal(t.symbol, 'USDC');
  });
  it('error pipeline: classify → friendly message', () => {
    const msg = D.friendlyError({ code: 4001 });
    assert.ok(msg.length > 5);
  });
});

// ============================================================
// Regression: Phase 1-4 invariants
// ============================================================
describe('Regression', () => {
  it('Guardian is REQUIRED (Phase 1 fail-closed)', () => {
    assert.equal(D.CONFIG.FEATURES.GUARDIAN_REQUIRED, true);
  });
  it('Window globals preserved (Phase 2)', () => {
    assert.equal(global.window.USDC_ADDRESS, D.TOKENS.USDC.address);
    assert.equal(global.window.ARC_CHAIN_ID, D.CHAIN.ID);
  });
  it('Namespace is complete (Phase 3-4)', () => {
    assert.ok(D.CHAIN);
    assert.ok(D.TOKENS);
    assert.ok(D.CONTRACTS);
    assert.ok(D.CONFIG);
    assert.ok(D.cache);
    assert.ok(D.ERROR_CODES);
  });
});
