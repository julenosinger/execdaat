# ExecDaat Testing Guide

## Overview

ExecDaat uses a lightweight, zero-dependency test runner for unit and integration tests. Smart contract tests use Hardhat.

## Quick Start

```bash
# Run all tests
npm test

# Run with verbose output
npm run test:verbose

# Run filtered tests
npm run test:filter -- "cache"

# Run smart contract tests
npm run test:contracts
```

## Test Architecture

```
tests/
├── run.cjs                    # Test runner (CJS)
├── unit/
│   └── shared/
│       └── all-shared.test.cjs  # All 14 shared modules tested
├── integration/               # End-to-end integration tests
├── e2e/                       # Browser tests (future)
├── fixtures/                  # Test data
├── mocks/                     # Mock objects
└── contracts.cjs              # Smart contract tests
```

## Writing Tests

Tests use a simple describe/it pattern:

```js
describe('Module name', () => {
  it('should do something', () => {
    const result = myFunction('input');
    assert.equal(result, 'expected');
  });
});
```

### Available Assertions

| Method | Usage |
|--------|-------|
| `assert.equal(a, b)` | Strict equality |
| `assert.ok(v)` | Truthy check |
| `assert.includes(s, sub)` | String contains |
| `assert.notEqual(a, b)` | Not equal |
| `assert.throws(fn)` | Expects throw |
| `assert.deepEqual(a, b)` | JSON equality |
| `assert.isNull(v)` / `assert.isNotNull(v)` | Null checks |

## Mock Environment

Tests run in Node.js with browser APIs mocked:
- `window`, `document`, `localStorage`, `sessionStorage`
- `navigator`, `fetch`, `crypto`, `DOMParser`
- `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`

No real wallets, no real private keys, no network access.

## CI/CD

GitHub Actions runs on every push and PR:
1. **Security Scan** — `npm run security:scan`
2. **Unit Tests** — `npm test`
3. **Integration Tests** — `npm test`
4. **Build** — `npm run build`
5. **Type Check** — `npx tsc --noEmit`

## Coverage Goals

| Area | Target | Status |
|------|--------|--------|
| Shared modules | 80%+ | 83 tests, all modules covered |
| Smart contracts | 60%+ | OTCEscrow, ContractFactory |
| Wallet flows | 40%+ | Mocked (no real wallet) |
| UI rendering | 20%+ | Needs browser environment |

## Debugging Failures

```bash
# Verbose mode shows passing tests
npm run test:verbose

# Filter to specific test
node tests/run.cjs --filter="cache"

# Check test results JSON
cat test-results.json
```

## Test Safety Rules

- Never use production wallets
- Never use real private keys
- Never send real funds
- Never modify production state
- Never require user credentials
- Never make real network calls (use mocks)
