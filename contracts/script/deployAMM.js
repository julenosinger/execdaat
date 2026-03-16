#!/usr/bin/env node
// ============================================================
//  Deploy SimpleAMM to Arc Testnet
//  Usage:  node contracts/script/deployAMM.js <PRIVATE_KEY>
//
//  EURC: 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a
//  USDC: 0x3600000000000000000000000000000000000000
// ============================================================

const fs      = require('fs');
const path    = require('path');
const solc    = require('solc');
const ethers  = require('ethers');

// ── Config ──────────────────────────────────────────────────────────────────
const ARC_RPC    = 'https://rpc.testnet.arc.network';
const CHAIN_ID   = 5042002;
const TOKEN_A    = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a'; // EURC
const TOKEN_B    = '0x3600000000000000000000000000000000000000'; // USDC

const PRIVATE_KEY = process.argv[2];
if (!PRIVATE_KEY) {
  console.error('Usage: node deployAMM.js <PRIVATE_KEY>');
  process.exit(1);
}

// ── Read Solidity source ─────────────────────────────────────────────────────
const solPath = path.join(__dirname, '../src/SimpleAMM.sol');
const source  = fs.readFileSync(solPath, 'utf8');

// ── Compile ──────────────────────────────────────────────────────────────────
console.log('🔨 Compiling SimpleAMM.sol...');
const input = {
  language: 'Solidity',
  sources:  { 'SimpleAMM.sol': { content: source } },
  settings: {
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    optimizer: { enabled: true, runs: 200 },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));

// Check errors
if (output.errors) {
  const errors = output.errors.filter(e => e.severity === 'error');
  if (errors.length > 0) {
    console.error('Compilation errors:');
    errors.forEach(e => console.error(e.formattedMessage));
    process.exit(1);
  }
  output.errors.forEach(e => console.warn('⚠', e.formattedMessage));
}

const contract  = output.contracts['SimpleAMM.sol']['SimpleAMM'];
const abi       = contract.abi;
const bytecode  = '0x' + contract.evm.bytecode.object;

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
    console.error('❌ No USDC balance for gas. Get testnet tokens from https://faucet.circle.com');
    process.exit(1);
  }

  console.log('🚀 Deploying SimpleAMM(', TOKEN_A, ',', TOKEN_B, ')...');

  const factory  = new ethers.ContractFactory(abi, bytecode, wallet);
  const deployed = await factory.deploy(TOKEN_A, TOKEN_B);

  console.log('⏳ Waiting for deployment tx:', deployed.deploymentTransaction()?.hash);
  await deployed.waitForDeployment();

  const address = await deployed.getAddress();
  console.log('\n✅ SimpleAMM deployed at:', address);
  console.log('🔗 ArcScan:', `https://testnet.arcscan.app/address/${address}`);

  // Save artifact
  const artifact = {
    address,
    tokenA:    TOKEN_A,
    tokenB:    TOKEN_B,
    chainId:   CHAIN_ID,
    deployedAt: new Date().toISOString(),
    deployTx:   deployed.deploymentTransaction()?.hash,
    abi,
  };

  const outDir = path.join(__dirname, '../out');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'SimpleAMM.json');
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  console.log('📄 Artifact saved to:', outPath);

  return address;
}

deploy().catch(err => {
  console.error('❌ Deploy failed:', err.message);
  process.exit(1);
});
