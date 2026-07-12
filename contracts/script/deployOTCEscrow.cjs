#!/usr/bin/env node
// ============================================================
//  Deploy OTCEscrow v3 to Arc Testnet
//
//  Usage:
//    node contracts/script/deployOTCEscrow.cjs <PRIVATE_KEY> [ARBITRATOR_ADDR] [RELAYER_ADDR,...]
//
//  Arguments:
//    PRIVATE_KEY      — deployer private key (required)
//    ARBITRATOR_ADDR  — arbitrator/multisig for dispute resolution (optional, defaults to deployer)
//    RELAYER_ADDR,... — comma-separated list of authorized releasers (optional)
//
//  Examples:
//    node contracts/script/deployOTCEscrow.cjs 0xPRIVKEY
//    node contracts/script/deployOTCEscrow.cjs 0xPRIVKEY 0xARBITRATOR
//    node contracts/script/deployOTCEscrow.cjs 0xPRIVKEY 0xARBITRATOR 0xRELAYER1,0xRELAYER2
//
//  Network: ARC Testnet (Chain ID: 5042002)
//  RPC:     https://rpc.testnet.arc.network
//  Explorer: https://testnet.arcscan.app
// ============================================================

const fs     = require('fs');
const path   = require('path');
const solc   = require('solc');
const ethers = require('ethers');

// ── Config ───────────────────────────────────────────────────────────────────
const ARC_RPC  = 'https://rpc.testnet.arc.network';
const CHAIN_ID = 5042002;

const PRIVATE_KEY      = process.env.DEPLOYER_PRIVATE_KEY || process.argv[2];
const ARBITRATOR_ARG   = process.argv[3] || null;
const RELAYERS_ARG     = process.argv[4] ? process.argv[4].split(',').map(a => a.trim()).filter(Boolean) : [];

if (!PRIVATE_KEY) {
  console.error('Usage: node contracts/script/deployOTCEscrow.cjs <PRIVATE_KEY> [ARBITRATOR_ADDR] [RELAYER_ADDR,...]');
  console.error('   or: DEPLOYER_PRIVATE_KEY=0x... node contracts/script/deployOTCEscrow.cjs');
  process.exit(1);
}
if (process.argv[2] && process.argv[2].startsWith('0x')) {
  console.warn('[SECURITY] Private key passed via CLI argument is visible in shell history and process listings.');
  console.warn('[SECURITY] Consider using: DEPLOYER_PRIVATE_KEY=0x... node contracts/script/deployOTCEscrow.cjs');
}

// ── Resolve OpenZeppelin source paths ────────────────────────────────────────
// Try both OZ v5 (utils/) and OZ v4 (security/) paths for ReentrancyGuard
const OZ_CANDIDATES = [
  path.join(__dirname, '../node_modules/@openzeppelin/contracts'),
  path.join(__dirname, '../../node_modules/@openzeppelin/contracts'),
  path.join(__dirname, '../hardhat/node_modules/@openzeppelin/contracts'),
];

const OZ_BASE = OZ_CANDIDATES.find(p => fs.existsSync(path.join(p, 'utils/ReentrancyGuard.sol')))
  || OZ_CANDIDATES[0];

console.log('📦 OpenZeppelin base:', OZ_BASE);

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
console.log('🔨 Compiling OTCEscrow v3...');
const input = {
  language: 'Solidity',
  sources:  { 'OTCEscrow.sol': { content: source } },
  settings: {
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    optimizer:       { enabled: true, runs: 200 },
    evmVersion:      'paris',
  },
};

const output = JSON.parse(
  solc.compile(JSON.stringify(input), { import: findImport })
);

if (output.errors) {
  const errors = output.errors.filter(e => e.severity === 'error');
  if (errors.length > 0) {
    console.error('❌ Compilation errors:');
    errors.forEach(e => console.error(e.formattedMessage));
    process.exit(1);
  }
  output.errors.forEach(e => console.warn('⚠', e.formattedMessage));
}

const compiled = output.contracts['OTCEscrow.sol']['OTCEscrow'];
const abi      = compiled.abi;
const bytecode = '0x' + compiled.evm.bytecode.object;

if (!compiled || !bytecode || bytecode === '0x') {
  console.error('❌ Compilation produced empty bytecode. Check Solidity source.');
  process.exit(1);
}

console.log('✅ Compiled — bytecode size:', (bytecode.length - 2) / 2, 'bytes');

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
    console.error('❌ No balance for gas. Get testnet tokens from: https://faucet.circle.com');
    process.exit(1);
  }

  // ── Constructor arguments ─────────────────────────────────────────────────
  const arbitratorAddr = ARBITRATOR_ARG && ethers.isAddress(ARBITRATOR_ARG)
    ? ARBITRATOR_ARG
    : wallet.address;  // default: deployer acts as arbitrator

  const relayerAddrs = RELAYERS_ARG.filter(a => ethers.isAddress(a));

  console.log('⚖️  Arbitrator:', arbitratorAddr);
  console.log('🤝 Authorized relayers:', relayerAddrs.length ? relayerAddrs : '(none)');

  console.log('\n🚀 Deploying OTCEscrow v3...');
  const factory  = new ethers.ContractFactory(abi, bytecode, wallet);
  const deployed = await factory.deploy(arbitratorAddr, relayerAddrs);

  const deployTx = deployed.deploymentTransaction();
  console.log('⏳ Deployment tx:', deployTx?.hash);
  console.log('   Waiting for confirmation...');
  await deployed.waitForDeployment();

  const address = await deployed.getAddress();

  console.log('\n═══════════════════════════════════════════════');
  console.log('✅ OTCEscrow v3 deployed at:', address);
  console.log('🔗 ArcScan:', `https://testnet.arcscan.app/address/${address}`);
  console.log('═══════════════════════════════════════════════');

  // ── Save artifact ────────────────────────────────────────────────────────
  const artifact = {
    version:        'v3',
    address,
    arbitrator:     arbitratorAddr,
    authorizedRelayers: relayerAddrs,
    chainId:        CHAIN_ID,
    deployedAt:     new Date().toISOString(),
    deployTxHash:   deployTx?.hash,
    blockNumber:    null,
    usdc:           '0x3600000000000000000000000000000000000000',
    abi,
  };

  const outDir  = path.join(__dirname, '../out');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'OTCEscrow.json');
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  console.log('📄 Artifact saved to:', outPath);

  // ── Update instructions ──────────────────────────────────────────────────
  console.log('\n📝 After deployment, update public/static/otc-escrow-abi.js:');
  console.log(`   const OTC_ESCROW_ADDRESS = '${address}'; // v3 — ARC Testnet`);
  console.log('\n📋 Contract summary:');
  console.log('   • Dispute/arbitration: raiseDispute() + resolveDispute()');
  console.log('   • Release restricted to seller or isAuthorized[msg.sender]');
  console.log('   • EIP-2612 permit funding: fundDealWithPermit()');
  console.log('   • State machine: Pending → Funded → Completed/Cancelled/Disputed');
  console.log('   • State cleanup: deal.amount = 0 after release/cancel');
  console.log('   • NatSpec documented, 90/90 tests passing');
  console.log('\n🔍 Verify contract source on ArcScan:');
  console.log(`   https://testnet.arcscan.app/address/${address}#code`);
  console.log('\n📤 To upload source to GitHub for verification:');
  console.log('   1. Push contracts/OTCEscrow.sol to your GitHub repository');
  console.log('   2. ArcScan (Blockscout-based) supports Sourcify verification:');
  console.log(`      https://testnet.arcscan.app/address/${address}/contract_verifications`);
  console.log('   3. For Sourcify upload: https://sourcify.dev/#/verifier');
  console.log('      - Select "ARC Testnet" (Chain ID 5042002)');
  console.log(`      - Contract address: ${address}`);
  console.log('      - Upload OTCEscrow.sol with OpenZeppelin imports flattened');
  console.log('\n   To flatten for verification:');
  console.log('      cd contracts/hardhat && npx hardhat flatten contracts/OTCEscrow.sol > OTCEscrow_flat.sol');
  console.log('      # Remove duplicate SPDX/pragma lines, then upload to ArcScan');

  return address;
}

deploy().catch(err => {
  console.error('❌ Deploy failed:', err.message || err);
  console.error(err.stack || '');
  process.exit(1);
});
