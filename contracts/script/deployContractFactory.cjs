#!/usr/bin/env node
// ============================================================
//  Deploy ContractFactory.sol to Arc Testnet
//  Usage: node contracts/script/deployContractFactory.cjs <PRIVATE_KEY>
// ============================================================
'use strict';

const https  = require('https');
const path   = require('path');
const fs     = require('fs');
const { execSync } = require('child_process');

// ─── Config ─────────────────────────────────────────────────────────────────
const RPC      = 'https://rpc.testnet.arc.network';
const CHAIN_ID = 5042002;
const CHAIN_HEX = '0x4CFC12';
const EXPLORER = 'https://testnet.arcscan.app';
const USDC_ADDR = '0x3600000000000000000000000000000000000000';

// ─── Minimal ABI-encoding helpers (no ethers dependency) ────────────────────
function padLeft(hex, bytes) {
  return hex.replace(/^0x/, '').padStart(bytes * 2, '0');
}

function encodeAddress(addr) {
  return padLeft(addr.replace(/^0x/, ''), 32);
}

// ─── Solidity compiler via solc-js ───────────────────────────────────────────
async function compileSolidity(solPath) {
  // Try to require solc
  let solc;
  try {
    solc = require('solc');
  } catch (e) {
    console.log('Installing solc…');
    execSync('npm install solc --no-save 2>/dev/null', { stdio: 'pipe', cwd: path.join(__dirname, '../../') });
    solc = require('solc');
  }

  const source = fs.readFileSync(solPath, 'utf8');
  const contractName = path.basename(solPath, '.sol');

  const input = {
    language: 'Solidity',
    sources: { [contractName + '.sol']: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));

  if (output.errors) {
    const errs = output.errors.filter(e => e.severity === 'error');
    if (errs.length > 0) {
      console.error('Compilation errors:');
      errs.forEach(e => console.error(e.formattedMessage));
      process.exit(1);
    }
    output.errors.forEach(e => {
      if (e.severity !== 'error') console.warn('⚠ ' + e.message.split('\n')[0]);
    });
  }

  const contracts = output.contracts[contractName + '.sol'];
  if (!contracts || !contracts[contractName]) {
    console.error('Contract not found in compiled output:', Object.keys(contracts || {}));
    process.exit(1);
  }

  const compiled = contracts[contractName];
  return {
    abi: compiled.abi,
    bytecode: '0x' + compiled.evm.bytecode.object,
  };
}

// ─── RPC helper ─────────────────────────────────────────────────────────────
function rpcCall(method, params = []) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const url = new URL(RPC);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) reject(new Error(json.error.message || JSON.stringify(json.error)));
          else resolve(json.result);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Sign & deploy using ethers ─────────────────────────────────────────────
async function deploy(privateKey, bytecode, abi) {
  let ethers;
  try {
    ethers = require('ethers');
  } catch (e) {
    console.log('Installing ethers…');
    execSync('npm install ethers@6 --no-save 2>/dev/null', { stdio: 'pipe', cwd: path.join(__dirname, '../../') });
    ethers = require('ethers');
  }

  const provider = new ethers.JsonRpcProvider(RPC, {
    chainId: CHAIN_ID,
    name: 'arc-testnet',
  });

  const wallet = new ethers.Wallet(privateKey, provider);
  console.log('\n📍 Deployer:', wallet.address);

  // Check balance
  const balance = await provider.getBalance(wallet.address);
  const balanceUsdc = Number(balance) / 1e6;
  console.log('💰 USDC balance (native gas):', balanceUsdc.toFixed(6), 'USDC');
  if (balanceUsdc < 0.01) {
    console.error('❌ Insufficient USDC for gas. Get tokens: https://faucet.circle.com');
    process.exit(1);
  }

  // Constructor encodes USDC address
  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  console.log('\n⏳ Deploying ContractFactory with USDC =', USDC_ADDR, '…');

  const contract = await factory.deploy(USDC_ADDR);
  const deployTx = contract.deploymentTransaction();
  console.log('📤 Deploy tx hash:', deployTx.hash);
  console.log('⏳ Waiting for confirmation…');

  const receipt = await contract.waitForDeployment();
  const addr = await contract.getAddress();
  const txReceipt = await deployTx.wait(2);

  console.log('\n✅ ContractFactory deployed!');
  console.log('📍 Address:', addr);
  console.log('📦 Block:', txReceipt.blockNumber);
  console.log('⛽ Gas used:', txReceipt.gasUsed.toString());
  console.log('🔗 ArcScan:', EXPLORER + '/address/' + addr);

  // Write artifact
  const artifact = {
    address: addr,
    usdc: USDC_ADDR,
    chainId: CHAIN_ID,
    deployTxHash: deployTx.hash,
    blockNumber: txReceipt.blockNumber,
    abi,
    deployedAt: new Date().toISOString(),
  };

  const outDir = path.join(__dirname, '../out');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'ContractFactory.json');
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  console.log('💾 Artifact saved to', outPath);

  return artifact;
}

// ─── Main ────────────────────────────────────────────────────────────────────
(async () => {
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY || process.argv[2];
  if (!privateKey || !privateKey.startsWith('0x')) {
    console.error('Usage: node contracts/script/deployContractFactory.cjs <PRIVATE_KEY>');
    console.error('   or: DEPLOYER_PRIVATE_KEY=0x... node contracts/script/deployContractFactory.cjs');
    process.exit(1);
  }
  if (process.argv[2] && process.argv[2].startsWith('0x')) {
    console.warn('[SECURITY] Private key passed via CLI argument is visible in shell history and process listings.');
    console.warn('[SECURITY] Consider using: DEPLOYER_PRIVATE_KEY=0x... node contracts/script/deployContractFactory.cjs');
  }

  console.log('🔨 Compiling ContractFactory.sol…');
  const solPath = path.join(__dirname, '../src/ContractFactory.sol');

  if (!fs.existsSync(solPath)) {
    console.error('ContractFactory.sol not found at', solPath);
    process.exit(1);
  }

  const { abi, bytecode } = await compileSolidity(solPath);
  console.log('✅ Compiled. Bytecode size:', (bytecode.length - 2) / 2, 'bytes');

  const artifact = await deploy(privateKey, bytecode, abi);

  console.log('\n🎉 Deployment complete!');
  console.log('─────────────────────────────────────────');
  console.log('CONTRACT_FACTORY_ADDRESS=' + artifact.address);
  console.log('─────────────────────────────────────────');
  console.log('\nTo register in the backend, this address is auto-read from:');
  console.log('  contracts/out/ContractFactory.json');
})();
