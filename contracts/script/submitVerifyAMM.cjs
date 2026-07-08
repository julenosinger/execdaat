#!/usr/bin/env node
// Submit SimpleAMM verification to the Arc Blockscout explorer (standard JSON input).
const fs = require('fs');
const path = require('path');

const ADDRESS = '0x3148E2807F172D1cC354F35fB4fC4104e8b6b561';
const BASE = 'https://testnet.arcscan.app';
const COMPILER = 'v0.8.34+commit.80d5c536';
const stdInput = fs.readFileSync(path.join(__dirname, '../out/SimpleAMM.standard-input.json'), 'utf8');
const ctor = fs.readFileSync(path.join(__dirname, '../out/SimpleAMM.ctorargs.txt'), 'utf8').trim();

async function main() {
  const url = `${BASE}/api/v2/smart-contracts/${ADDRESS}/verification/via/standard-input`;
  const fd = new FormData();
  fd.append('compiler_version', COMPILER);
  fd.append('license_type', 'mit');
  fd.append('autodetect_constructor_args', 'false');
  fd.append('constructor_args', ctor);
  fd.append('files[0]', new Blob([stdInput], { type: 'application/json' }), 'SimpleAMM.standard-input.json');

  console.log('POST', url);
  const res = await fetch(url, { method: 'POST', body: fd });
  const text = await res.text();
  console.log('HTTP', res.status);
  console.log(text);
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
