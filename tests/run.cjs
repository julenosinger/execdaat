// ============================================================
// ExecDaat Test Runner — Lightweight, zero-dependency (CJS)
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');

const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');
const FILTER = (() => {
  const idx = process.argv.findIndex(a => a.startsWith('--filter='));
  return idx >= 0 ? process.argv[idx].split('=')[1].toLowerCase() : null;
})();

let passed = 0, failed = 0, skipped = 0;
const pendingAsync = [];

function it(name, fn) {
  if (FILTER && !name.toLowerCase().includes(FILTER)) { skipped++; return; }
  let result;
  try {
    result = fn();
  } catch (e) {
    failed++;
    console.log(`  \u2717 ${name}`);
    console.log(`    ${e.message}`);
    return;
  }
  if (result && typeof result.then === 'function') {
    // Async test: resolution is awaited before the summary is printed
    pendingAsync.push(result.then(
      () => { passed++; if (VERBOSE) console.log(`  \u2713 ${name}`); },
      (e) => { failed++; console.log(`  \u2717 ${name}`); console.log(`    ${e.message}`); },
    ));
    return;
  }
  passed++;
  if (VERBOSE) console.log(`  \u2713 ${name}`);
}

function describe(name, fn) {
  console.log(`\n${name}`);
  fn();
}

// Assertion helpers
const assert = {
  equal: (a, b, msg) => { if (a !== b) throw new Error(msg || `expected ${JSON.stringify(a)} === ${JSON.stringify(b)}`); },
  notEqual: (a, b, msg) => { if (a === b) throw new Error(msg || `expected ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); },
  ok: (v, msg) => { if (!v) throw new Error(msg || `expected truthy`); },
  fail: (msg) => { throw new Error(msg || 'assertion failed'); },
  throws: (fn, msg) => { try { fn(); throw new Error(msg || 'expected throw'); } catch (e) { if (e.message === (msg || 'expected throw')) throw e; } },
  deepEqual: (a, b, msg) => {
    const sa = JSON.stringify(a), sb = JSON.stringify(b);
    if (sa !== sb) throw new Error(msg || `expected ${sa} !== ${sb}`);
  },
  isNull: (v, msg) => { if (v !== null) throw new Error(msg || `expected null`); },
  isNotNull: (v, msg) => { if (v === null) throw new Error(msg || `expected not null`); },
  gt: (a, b, msg) => { if (!(a > b)) throw new Error(msg || `expected ${a} > ${b}`); },
  lt: (a, b, msg) => { if (!(a < b)) throw new Error(msg || `expected ${a} < ${b}`); },
  includes: (s, sub, msg) => { if (!String(s).includes(sub)) throw new Error(msg || `expected "${String(s).slice(0,50)}" to include "${sub}"`); },
};

// Safe global mock helper
function safeSet(name, value) {
  try { global[name] = value; } catch(e) {
    try { Object.defineProperty(global, name, { value, configurable: true, writable: true }); } catch(e2) {}
  }
}

safeSet('window', {});
safeSet('document', {
  getElementById: () => null,
  createElement: (tag) => {
    if (tag === 'textarea') return { style: {}, value: '', select() {}, setAttribute() {} };
    return { style: {}, classList: { add() {}, remove() {}, contains() { return false; } }, setAttribute() {}, appendChild() {} };
  },
  body: { appendChild() {}, removeChild() {} },
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
});
safeSet('localStorage', {
  _data: {},
  getItem(k) { return this._data[k] || null; },
  setItem(k, v) { this._data[k] = String(v); },
  removeItem(k) { delete this._data[k]; },
  clear() { this._data = {}; },
});
safeSet('sessionStorage', {
  _data: {},
  getItem(k) { return this._data[k] || null; },
  setItem(k, v) { this._data[k] = String(v); },
  removeItem(k) { delete this._data[k]; },
});
safeSet('navigator', { userAgent: 'Node.js Test', clipboard: { writeText() { return Promise.resolve(); } } });
safeSet('crypto', { getRandomValues(arr) { for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256); } });
safeSet('DOMParser', class { parseFromString(s) { return { body: { innerHTML: s, querySelectorAll() { return []; } } }; } });
safeSet('MutationObserver', class { observe() {} disconnect() {} });
global.btoa = (s) => Buffer.from(s).toString('base64');
global.atob = (s) => Buffer.from(s, 'base64').toString();
global.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = (init || {}).detail; } };
global.TextEncoder = class { encode(s) { return Buffer.from(s); } };
global.TextDecoder = class { decode(b) { return Buffer.from(b).toString(); } };
global.performance = { now: () => Date.now(), timing: { loadEventEnd: Date.now(), navigationStart: Date.now() - 500 } };
global.BigInt = BigInt;

// Make helpers available globally
global.describe = describe;
global.it = it;
global.assert = assert;

// Load test files recursively
function loadTests(dir) {
  if (!fs.existsSync(dir)) { console.log(`  Directory not found: ${dir}`); return; }
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { loadTests(full); continue; }
    if (!entry.name.endsWith('.test.cjs')) continue;
    try {
      require(full);
    } catch (e) {
      console.log(`  ERROR loading ${path.relative(process.cwd(), full)}: ${e.message}`);
      failed++;
    }
  }
}

console.log('ExecDaat Test Suite\n');

const testDir = path.join(__dirname, '..', 'tests', 'unit');
loadTests(testDir);

// Also load integration tests
const intDir = path.join(__dirname, '..', 'tests', 'integration');
if (fs.existsSync(intDir)) loadTests(intDir);

const total = passed + failed;
Promise.allSettled(pendingAsync).then(() => {
  const finalTotal = passed + failed;
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped (${finalTotal} total)`);
  console.log(`${'='.repeat(50)}`);

  // Write results to file for CI
  const results = { passed, failed, skipped, total: finalTotal, timestamp: new Date().toISOString() };
  try { fs.writeFileSync(path.join(__dirname, '..', 'test-results.json'), JSON.stringify(results, null, 2)); } catch(e) {}

  process.exit(failed > 0 ? 1 : 0);
});
