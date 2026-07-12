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
  /\.git\//,
  /dist\//,
  /dist-vercel\//,
  /\.wrangler\//,
  /\.vercel\//,
  /\.zip$/,
  /\.png$/, /\.jpg$/, /\.jpeg$/, /\.gif$/, /\.svg$/, /\.ico$/,
  /\.woff/, /\.ttf$/, /\.eot$/,
  /package-lock\.json$/,
  /\.security-scan-results\.json$/,
];

function shouldSkip(filePath) {
  return SKIP_PATTERNS.some(p => p.test(filePath));
}

function *scanFile(filePath, content) {
  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;
    let match;
    while ((match = pattern.regex.exec(content)) !== null) {
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
