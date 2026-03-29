#!/usr/bin/env node
// ============================================================
//  Deploy OTCEscrow to Arc Testnet
//  Usage:  node contracts/script/deployOTCEscrow.cjs <PRIVATE_KEY>
//
//  Network: ARC Testnet (Chain ID: 5042002)
//  RPC:     https://rpc.testnet.arc.network
//  Explorer: https://testnet.arcscan.app
// ============================================================

const fs     = require('fs');
const path   = require('path');
const solc   = require('solc');
const ethers = require('ethers');

// ── Config ──────────────────────────────────────────────────────────────────
const ARC_RPC  = 'https://rpc.testnet.arc.network';
const CHAIN_ID = 5042002;

const PRIVATE_KEY = process.argv[2];
if (!PRIVATE_KEY) {
  console.error('Usage: node contracts/script/deployOTCEscrow.cjs <PRIVATE_KEY>');
  process.exit(1);
}

// ── Resolve OpenZeppelin source paths ────────────────────────────────────────
const OZ_BASE = path.join(__dirname, '../../node_modules/@openzeppelin/contracts');

function findImport(importPath) {
  if (importPath.startsWith('@openzeppelin/contracts/')) {
    const relative = importPath.replace('@openzeppelin/contracts/', '');
    const fullPath = path.join(OZ_BASE, relative);
    try {
      return { contents: fs.readFileSync(fullPath, 'utf8') };
    } catch (e) {
      return { error: `File not found: ${fullPath}` };
    }
  }
  return { error: `Unknown import: ${importPath}` };
}

// ── Read Solidity source ─────────────────────────────────────────────────────
const solPath = path.join(__dirname, '../OTCEscrow.sol');
const source  = fs.readFileSync(solPath, 'utf8');
console.log('📄 Source:', solPath);

// ── Compile ──────────────────────────────────────────────────────────────────
console.log('🔨 Compiling OTCEscrow.sol...');
const input = {
  language: 'Solidity',
  sources:  { 'OTCEscrow.sol': { content: source } },
  settings: {
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    optimizer:       { enabled: true, runs: 200 },
  },
};

const output = JSON.parse(
  solc.compile(JSON.stringify(input), { import: findImport })
);

// Check errors
if (output.errors) {
  const errors = output.errors.filter(e => e.severity === 'error');
  if (errors.length > 0) {
    console.error('❌ Compilation errors:');
    errors.forEach(e => console.error(e.formattedMessage));
    process.exit(1);
  }
  output.errors.forEach(e => console.warn('⚠', e.formattedMessage));
}

const compiled  = output.contracts['OTCEscrow.sol']['OTCEscrow'];
const abi       = compiled.abi;
const bytecode  = '0x' + compiled.evm.bytecode.object;

console.log('✅ Compiled — bytecode size:', bytecode.length / 2, 'bytes');

// ── Deploy ───────────────────────────────────────────────────────────────────
async function deploy() {
  const provider = new ethers.JsonRpcProvider(ARC_RPC, {
    chainId: CHAIN_ID,
    name:    'arc-testnet',
  });

  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log('🔑 Deployer:', wallet.address);

  const balance = await provider.getBalance(wallet.address);
  console.log('💰 Balance:', ethers.formatUnits(balance, 6), 'USDC (native gas)');

  if (balance === 0n) {
    console.error('❌ No balance for gas. Get testnet tokens from the ARC faucet.');
    process.exit(1);
  }

  console.log('🚀 Deploying OTCEscrow...');

  const factory  = new ethers.ContractFactory(abi, bytecode, wallet);
  const deployed = await factory.deploy();

  console.log('⏳ Waiting for deployment tx:', deployed.deploymentTransaction()?.hash);
  await deployed.waitForDeployment();

  const address = await deployed.getAddress();
  console.log('\n✅ OTCEscrow deployed at:', address);
  console.log('🔗 ArcScan:', `https://testnet.arcscan.app/address/${address}`);

  // Save artifact
  const artifact = {
    address,
    chainId:    CHAIN_ID,
    deployedAt: new Date().toISOString(),
    deployTx:   deployed.deploymentTransaction()?.hash,
    abi,
  };

  const outDir = path.join(__dirname, '../out');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'OTCEscrow.json');
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  console.log('📄 Artifact saved to:', outPath);

  // Print update instruction
  console.log('\n📝 Update otc-escrow-abi.js:');
  console.log(`   const OTC_ESCROW_ADDRESS = '${address}';`);

  return address;
}

deploy().catch(err => {
  console.error('❌ Deploy failed:', err.message);
  process.exit(1);
});
