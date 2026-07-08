#!/usr/bin/env node
// Reproduce the exact deploy-time compilation of SimpleAMM and compare the
// generated runtime bytecode against the deployed on-chain code. Read-only.
const fs = require('fs');
const path = require('path');
const https = require('https');
const solc = require('solc');
const ethers = require('ethers');

const ADDRESS = '0x3148E2807F172D1cC354F35fB4fC4104e8b6b561';
const RPC = 'https://rpc.testnet.arc.network';
const TOKEN_A = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a'; // EURC
const TOKEN_B = '0x3600000000000000000000000000000000000000'; // USDC

const source = fs.readFileSync(path.join(__dirname, '../src/SimpleAMM.sol'), 'utf8');

// EXACT deploy-time Standard JSON input (outputSelection extended only for
// reporting — outputSelection is NOT part of the metadata hash, so bytecode
// is byte-identical to deployment).
const input = {
  language: 'Solidity',
  sources: { 'SimpleAMM.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'] } },
  },
};

console.log('solc version:', solc.version());
const out = JSON.parse(solc.compile(JSON.stringify(input)));
if (out.errors) {
  const errs = out.errors.filter(e => e.severity === 'error');
  if (errs.length) { errs.forEach(e => console.error(e.formattedMessage)); process.exit(1); }
}
const c = out.contracts['SimpleAMM.sol']['SimpleAMM'];
const runtime = '0x' + c.evm.deployedBytecode.object;
const creation = '0x' + c.evm.bytecode.object;
const metadata = c.metadata;

const ctorArgs = ethers.AbiCoder.defaultAbiCoder().encode(['address', 'address'], [TOKEN_A, TOKEN_B]);
console.log('constructor args (encoded):', ctorArgs);

fs.writeFileSync(path.join(__dirname, '../out/SimpleAMM.standard-input.json'), JSON.stringify(input, null, 2));
fs.writeFileSync(path.join(__dirname, '../out/SimpleAMM.metadata.json'), metadata);
fs.writeFileSync(path.join(__dirname, '../out/SimpleAMM.runtime.txt'), runtime);
fs.writeFileSync(path.join(__dirname, '../out/SimpleAMM.creation.txt'), creation + ctorArgs.slice(2));
fs.writeFileSync(path.join(__dirname, '../out/SimpleAMM.ctorargs.txt'), ctorArgs.slice(2));

// Fetch on-chain runtime code
const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [ADDRESS, 'latest'] });
const u = new URL(RPC);
const req = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
  let data = ''; res.on('data', d => data += d); res.on('end', () => {
    const onchain = (JSON.parse(data).result || '').toLowerCase();
    const local = runtime.toLowerCase();
    console.log('on-chain runtime bytes:', (onchain.length - 2) / 2);
    console.log('compiled runtime bytes:', (local.length - 2) / 2);
    const exact = onchain === local;
    console.log('EXACT MATCH:', exact);
    if (!exact) {
      // Compare ignoring trailing metadata (last 43 bytes CBOR) to localize diff
      const strip = (h) => h.slice(0, h.length - 86);
      console.log('MATCH (ignoring metadata hash):', strip(onchain) === strip(local));
      // find first diff
      let i = 0; while (i < Math.min(onchain.length, local.length) && onchain[i] === local[i]) i++;
      console.log('first diff at nibble', i, 'of', onchain.length, '/', local.length);
      console.log('onchain@diff:', onchain.slice(i, i + 40));
      console.log('local@diff  :', local.slice(i, i + 40));
    }
  });
});
req.on('error', e => console.error('RPC error:', e.message));
req.write(body); req.end();
