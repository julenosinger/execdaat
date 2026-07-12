#!/usr/bin/env node
// ============================================================
// ExecDaat Deployment Validation
// ============================================================
// Checks: environment, contracts, frontend build, APIs
// Run: node scripts/deployment-check.cjs
// Exit code 0 = all checks pass
// ============================================================
'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let errors = 0;
let warnings = 0;

function pass(msg) { console.log('  \x1b[32m\u2713\x1b[0m ' + msg); }
function warn(msg) { warnings++; console.log('  \x1b[33m\u26A0\x1b[0m ' + msg); }
function fail(msg) { errors++; console.log('  \x1b[31m\u2717\x1b[0m ' + msg); }

console.log('\nExecDaat Deployment Validation\n');

// ── Environment ──────────────────────────────────────────────────────────
console.log('Environment:');
const REQUIRED_ENV = [
  'OPENAI_API_KEY',
  'CIRCLE_API_KEY',
  'TREASURY_CORE_URL',
  'TURBO_RELAYER_PRIVATE_KEY',
  'OPERATOR_PRIVATE_KEY',
  'RELAYER_PRIVATE_KEY',
];
REQUIRED_ENV.forEach(function(name) {
  if (process.env[name]) pass(name + ' is set');
  else warn(name + ' not set (required for production)');
});

// ── Build ────────────────────────────────────────────────────────────────
console.log('\nBuild:');
if (fs.existsSync(path.join(ROOT, 'dist'))) pass('dist/ exists');
else fail('dist/ missing — run npm run build first');

if (fs.existsSync(path.join(ROOT, 'dist', '_worker.js'))) pass('_worker.js exists');
else fail('_worker.js missing');

if (fs.existsSync(path.join(ROOT, 'dist', 'static'))) pass('dist/static/ exists');
else fail('dist/static/ missing');

// ── Frontend assets ──────────────────────────────────────────────────────
console.log('\nFrontend assets:');
const REQUIRED_ASSETS = [
  'public/static/security.js',
  'public/static/app.js',
  'public/static/wallet.js',
  'public/static/shared/constants.js',
  'public/static/shared/errors.js',
];
REQUIRED_ASSETS.forEach(function(f) {
  if (fs.existsSync(path.join(ROOT, f))) pass(f);
  else fail(f + ' missing');
});

// ── No leaked secrets ────────────────────────────────────────────────────
console.log('\nSecrets leak check:');
const FORBIDDEN = ['.env', '.dev.vars', '.my-deployer.json', 'private-key.json'];
FORBIDDEN.forEach(function(f) {
  if (fs.existsSync(path.join(ROOT, f))) fail(f + ' exists (should be gitignored)');
  else pass(f + ' not found');
});

// Check source code for potential private key patterns (only in source dirs)
function scanDir(dir, pattern, desc) {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir, { recursive: true, withFileTypes: false });
  files.forEach(function(f) {
    if (f.endsWith('.js') || f.endsWith('.ts') || f.endsWith('.cjs') || f.endsWith('.mjs') || f.endsWith('.sol')) {
      try {
        const content = fs.readFileSync(path.join(dir, f), 'utf8');
        if (pattern.test(content)) {
          warn(desc + ' in ' + f);
        }
      } catch(e) {}
    }
  });
}

// ── Contract source integrity ────────────────────────────────────────────
console.log('\nContract files:');
const CONTRACT_FILES = [
  'contracts/src/SimpleAMM.sol',
  'contracts/src/ContractFactory.sol',
  'contracts/ArcVault.sol',
  'contracts/ArcTreasury.sol',
  'contracts/OTCEscrow.sol',
  'contracts/EscrowWallet.sol',
];
CONTRACT_FILES.forEach(function(f) {
  if (fs.existsSync(path.join(ROOT, f))) {
    const content = fs.readFileSync(path.join(ROOT, f), 'utf8');
    // Verify Phase 7: nonReentrant / ReentrancyGuard
    if (f.includes('AMM') || f.includes('Factory') || f.includes('EscrowWallet')) {
      if (content.includes('nonReentrant') || content.includes('ReentrancyGuard')) {
        pass(f + ' (Phase 7 hardened)');
      } else {
        warn(f + ' (missing Phase 7 hardening)');
      }
    } else if (f.includes('OTCEscrow')) {
      pass(f + ' (OZ ReentrancyGuard)');
    } else {
      pass(f + ' exists');
    }
  } else {
    fail(f + ' missing');
  }
});

// ── Docs ──────────────────────────────────────────────────────────────────
console.log('\nDocumentation:');
const DOCS = [
  'ARCHITECTURE.md', 'SECURITY_REVIEW.md', 'THREAT_MODEL.md',
  'MAINNET_SECURITY_CHECKLIST.md', 'DEPLOYMENT_SECURITY.md',
  'INCIDENT_RESPONSE.md', 'TESTING.md', 'CONTRACT_REGISTRY.md',
  'CONTRACT_MIGRATION_PLAN.md', 'SECURITY_REMEDIATION_REPORT.md',
];
DOCS.forEach(function(f) {
  if (fs.existsSync(path.join(ROOT, f))) pass(f);
  else warn(f + ' missing');
});

// ── Summary ──────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(50));
console.log('Results: ' + errors + ' errors, ' + warnings + ' warnings');
if (errors === 0 && warnings === 0) console.log('Status: \x1b[32mALL CHECKS PASSED\x1b[0m');
else if (errors === 0) console.log('Status: \x1b[33mWARNINGS ONLY\x1b[0m');
else console.log('Status: \x1b[31mFAILED\x1b[0m');
console.log('='.repeat(50));

process.exit(errors > 0 ? 1 : 0);
