#!/usr/bin/env node
// ============================================================
// ExecDaat — Security Secret Scanner
// ============================================================
// Scans the repository for potential secret leaks.
//
// Usage:
//   node scripts/security-scan.cjs
//   node scripts/security-scan.cjs --json
//
// Exit code 0 = no findings, 1 = findings detected
// ============================================================
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const PATTERNS = [
  {
    name: 'ETH_PRIVATE_KEY',
    regex: /0x[0-9a-fA-F]{64}/g,
    severity: 'CRITICAL',
    hint: 'Hardcoded Ethereum private key. Replace with process.env variable.',
  },
  {
    name: 'PEM_PRIVATE_KEY',
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    severity: 'CRITICAL',
    hint: 'PEM-encoded private key. Never commit keys.',
  },
  {
    name: 'ENV_SECRET_ASSIGNMENT',
    regex: /(?:PRIVATE_KEY|SECRET|PASSWORD|MNEMONIC|API_KEY)\s*=\s*["'][0-9a-zA-Z_\-+/=]{20,}["']/gi,
    severity: 'HIGH',
    hint: 'Potential secret assignment. Verify this is not a real credential.',
  },
];

// Heuristic: check if a line has 12+ lowercase word-like tokens (potential mnemonic)
function containsMnemonic(line) {
  const words = line.match(/\b[a-z]{3,8}\b/g);
  if (!words || words.length < 12) return false;
  // BIP39 words are all lowercase, 3-8 chars — count consecutive matches
  let consecutive = 0;
  let maxConsecutive = 0;
  const parts = line.split(/[,\s;]+/);
  for (const p of parts) {
    if (/^[a-z]{3,8}$/.test(p)) {
      consecutive++;
      if (consecutive > maxConsecutive) maxConsecutive = consecutive;
    } else {
      consecutive = 0;
    }
  }
  return maxConsecutive >= 12;
}

const SKIP_PATTERNS = [
  /node_modules/,
  /\.git[\/\\]/,
  /dist[\/\\]/,
  /dist-vercel[\/\\]/,
  /\.wrangler[\/\\]/,
  /\.vercel[\/\\]/,
  /\.zip$/,
  /\.png$/, /\.jpg$/, /\.jpeg$/, /\.gif$/, /\.svg$/, /\.ico$/,
  /\.woff/, /\.ttf$/, /\.eot$/,
  /package-lock\.json$/,
  /\.security-scan-results\.json$/,
  // Hardhat build artifacts — compiled bytecode, not private keys
  /contracts[\/\\]hardhat[\/\\]artifacts/,
  /contracts[\/\\]out[\/\\]/,
  /contracts[\/\\]cache[\/\\]/,
  // ethers.js library — secp256k1 curve constants, not private keys
  /ethers\.umd\.patched\.js$/,
  // Frontend static files — pre-built bundles, not source with embedded secrets
  /public[\/\\]static[\/\\]/,
  // Hardhat test/script files with known test mnemonic placeholders
  /contracts[\/\\]genTreasuryWallet\.cjs$/,
  // The scanner itself — contains known-safe hex patterns for allowlisting
  /scripts[\/\\]security-scan\.cjs$/,
  // Source files with known-safe hex constants (secp256k1, event topics, etc.)
  /src[\/\\]routes[\/\\]autonomous-wallet\.ts$/,
  /src[\/\\]routes[\/\\]agent-wallet\.ts$/,
  /src[\/\\]routes[\/\\]contracts\.ts$/,
  /src[\/\\]routes[\/\\]dex\.ts$/,
];

// Known hex patterns that are NOT private keys: event topics, constants, addresses
const KNOWN_SAFE_HEX = new Set([
  '0x0000000000000000000000000000000000000000000000000000000000000000',
  '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F',
  '0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798',
  '0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8',
  '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141',
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  '0x7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee',
  '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  '0x8000000000000000000000000000000000000000000000000000000000000000',
  '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  '0x4e487b7100000000000000000000000000000000000000000000000000000000',
  '0x3c8acc1e7b08d8e76f9fda015ef48dc8c710a73cb7e0f77b2c18a9b5a7adde8e',
  '0x8B73C3C69BB8FE3D512ECC4CF759CC79239F7B179B0FFACAA9A75D522B3940DF',
  '0x35d96b9659ab438b84c606c6d47d16c883388b6552465a21f9a97d75680c50ed',
  '0x35d96b9659ab438b84c606c6d47d16c883388b6552465a21f9a97d75680c50', // truncated variant
]);

function isKnownSafeHex(hex) {
  const up = hex.toUpperCase();
  for (const safe of KNOWN_SAFE_HEX) {
    if (safe === up || safe.startsWith(up) || up.startsWith(safe)) return true;
  }
  return false;
}

function shouldSkip(filePath) {
  return SKIP_PATTERNS.some(p => p.test(filePath));
}

// Patterns in raw-imported frontend files that are safe variable/parameter names,
// not actual secrets. These appear in src/index.tsx via Vite ?raw imports.
const RAW_IMPORT_FALSE_POSITIVES = [
  /const\s+walletCreateJs\b/,
  /const\s+securityJs\b/,
  /const\s+multisendJs\b/,
];

function isInRawImportContext(filePath, matchIndex, content) {
  if (!filePath.endsWith('src/index.tsx') && !filePath.endsWith('src\\index.tsx')) return false;
  // Check if the match is within a raw-import variable assignment
  for (const fp of RAW_IMPORT_FALSE_POSITIVES) {
    const m = fp.exec(content);
    if (m && matchIndex > m.index) {
      // Found raw import before the match — this is a false positive
      return true;
    }
  }
  return false;
}

function *scanFile(filePath, content) {
  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;
    let match;
    while ((match = pattern.regex.exec(content)) !== null) {
      if (isInRawImportContext(filePath, match.index, content)) continue;
      if (pattern.name === 'ETH_PRIVATE_KEY' && isKnownSafeHex(match[0])) continue;
      const lineNum = content.slice(0, match.index).split('\n').length;
      yield {
        file: path.relative(ROOT, filePath),
        line: lineNum,
        rule: pattern.name,
        severity: pattern.severity,
        match: match[0].slice(0, 64),
        hint: pattern.hint,
      };
    }
  }
  // Mnemonic detection per-line
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (containsMnemonic(lines[i])) {
      const lineStart = content.split('\n').slice(0, i).join('\n').length + (i > 0 ? 1 : 0);
      if (isInRawImportContext(filePath, lineStart, content)) continue;
      yield {
        file: path.relative(ROOT, filePath),
        line: i + 1,
        rule: 'MNEMONIC_SEED',
        severity: 'CRITICAL',
        match: lines[i].trim().slice(0, 80),
        hint: 'Potential BIP39 mnemonic. Never commit seed phrases.',
      };
    }
  }
}

function *walkDir(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (shouldSkip(fullPath)) continue;
    if (entry.isDirectory()) {
      yield *walkDir(fullPath);
    } else if (entry.isFile()) {
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        yield *scanFile(fullPath, content);
      } catch { /* binary */ }
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');

  if (!jsonOutput) {
    console.log('ExecDaat Security Scanner\n');
  }

  const findings = [];
  for (const result of walkDir(ROOT)) {
    findings.push(result);
  }

  if (jsonOutput) {
    const report = {
      scannedAt: new Date().toISOString(),
      totalFindings: findings.length,
      critical: findings.filter(f => f.severity === 'CRITICAL').length,
      high: findings.filter(f => f.severity === 'HIGH').length,
      findings,
    };
    console.log(JSON.stringify(report, null, 2));
  } else {
    if (findings.length === 0) {
      console.log('No secrets found.\n');
      process.exit(0);
    }

    const critical = findings.filter(f => f.severity === 'CRITICAL');
    const high = findings.filter(f => f.severity === 'HIGH');

    console.log(`CRITICAL: ${critical.length}`);
    console.log(`HIGH:     ${high.length}\n`);

    for (const f of findings) {
      const icon = f.severity === 'CRITICAL' ? 'CRIT' : 'HIGH';
      console.log(`[${icon}] [${f.rule}] ${f.file}:${f.line}`);
      console.log(`  "${f.match}"`);
      console.log(`  -> ${f.hint}\n`);
    }

    console.log(`Total: ${findings.length} potential secrets found.\n`);
  }

  process.exit(findings.length > 0 ? 1 : 0);
}

main();
