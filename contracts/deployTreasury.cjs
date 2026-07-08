#!/usr/bin/env node
/* eslint-disable */
// ============================================================================
//  deployTreasury.cjs — Phases 2, 3 & 4: deploy ArcTreasury + ArcVault and
//  write the PUBLIC auto-discovery manifest for the Treasury page.
// ----------------------------------------------------------------------------
//  SECURITY: run by the AUTHORIZED OPERATOR in a secure environment.
//    • Deployer key is read from env (DEPLOYER_PRIVATE_KEY) or the encrypted
//      keystore from genTreasuryWallet.cjs (TREASURY_WALLET_PASSWORD). It is
//      NEVER written to the repo, printed, or shipped to the frontend.
//    • The manifest written to ../public/static/treasury-deployment.json contains
//      ADDRESSES ONLY (no keys, no secrets).
//
//  What it does:
//    1. Compiles ArcTreasury.sol + ArcVault.sol with solc (self-contained).
//    2. Deploys ArcTreasury(signers, threshold).
//    3. Deploys ArcVault(treasury, operators, assets, symbols)  — Treasury is
//       the governor; Vault manages inbound (External -> Arc) liquidity.
//    4. Writes the public manifest so the Treasury page auto-discovers both.
//
//  Env (all optional except a key source):
//    DEPLOYER_PRIVATE_KEY        0x…  (OR use keystore below)
//    TREASURY_WALLET_PASSWORD    unlocks ./.treasury-secrets/treasury-wallet.keystore.json
//    ARC_RPC_URL                 default https://rpc.testnet.arc.network
//    ARC_CHAIN_ID                default 5042002
//    TREASURY_SIGNERS            comma-separated addresses (default: deployer)
//    TREASURY_THRESHOLD          default 1
//    TREASURY_OPERATORS          comma-separated addresses (default: deployer)
//    TREASURY_ASSETS             "0xUSDC:USDC:6,0xEURC:EURC:6"  (default: Arc USDC+EURC)
//    TREASURY_ENV                default "testnet"
//
//  Usage (from contracts/):
//    DEPLOYER_PRIVATE_KEY=0x… node deployTreasury.cjs
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const solc = require('solc');
const { ethers } = require('ethers');

const RPC = process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network';
const CHAIN_ID = Number(process.env.ARC_CHAIN_ID || 5042002);
const ENVIRONMENT = process.env.TREASURY_ENV || 'testnet';
const NETWORK_NAME = 'Arc Testnet';
// Canonical Arc token addresses (public constants; overridable via TREASURY_ASSETS).
const DEFAULT_ASSETS = 'default'; // resolved below

function readSource(name) { return fs.readFileSync(path.join(__dirname, name), 'utf8'); }

function compile() {
  const input = {
    language: 'Solidity',
    sources: {
      'ArcTreasury.sol': { content: readSource('ArcTreasury.sol') },
      'ArcVault.sol':    { content: readSource('ArcVault.sol') },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  if (out.errors) {
    const fatal = out.errors.filter((e) => e.severity === 'error');
    out.errors.forEach((e) => console.log((e.severity === 'error' ? '✗ ' : '• ') + e.formattedMessage.trim()));
    if (fatal.length) { console.error('✗ Compilation failed.'); process.exit(1); }
  }
  const T = out.contracts['ArcTreasury.sol'].ArcTreasury;
  const V = out.contracts['ArcVault.sol'].ArcVault;
  return {
    treasury: { abi: T.abi, bytecode: '0x' + T.evm.bytecode.object },
    vault: { abi: V.abi, bytecode: '0x' + V.evm.bytecode.object },
  };
}

async function loadWallet(provider) {
  if (process.env.DEPLOYER_PRIVATE_KEY) return new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const ksPath = path.join(process.cwd(), '.treasury-secrets', 'treasury-wallet.keystore.json');
  if (fs.existsSync(ksPath) && process.env.TREASURY_WALLET_PASSWORD) {
    const ks = fs.readFileSync(ksPath, 'utf8');
    const w = await ethers.Wallet.fromEncryptedJson(ks, process.env.TREASURY_WALLET_PASSWORD);
    return w.connect(provider);
  }
  console.error('✗ No deployer key. Set DEPLOYER_PRIVATE_KEY, or provide TREASURY_WALLET_PASSWORD to unlock the keystore.');
  process.exit(1);
}

function parseList(v) { return (v || '').split(',').map((s) => s.trim()).filter(Boolean); }
function resolveAssets() {
  if (process.env.TREASURY_ASSETS) {
    return process.env.TREASURY_ASSETS.split(',').map((t) => {
      const [address, symbol, decimals] = t.split(':').map((x) => x && x.trim());
      return { address, symbol: symbol || 'TOKEN', decimals: Number(decimals || 6) };
    }).filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a.address || ''));
  }
  return [
    { address: '0x3600000000000000000000000000000000000000', symbol: 'USDC', decimals: 6 },
    { address: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a', symbol: 'EURC', decimals: 6 },
  ];
}

async function main() {
  console.log('• Compiling ArcTreasury + ArcVault…');
  const art = compile();

  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
  const wallet = await loadWallet(provider);
  const deployer = await wallet.getAddress();
  console.log('• Deployer     :', deployer);
  const bal = await provider.getBalance(deployer).catch(() => 0n);
  console.log('• Gas balance  :', ethers.formatEther(bal));
  if (bal === 0n) { console.error('✗ Deployer has no gas on', NETWORK_NAME); process.exit(1); }

  const signers = parseList(process.env.TREASURY_SIGNERS);
  if (!signers.length) signers.push(process.env.TREASURY_WALLET_ADDRESS && /^0x[0-9a-fA-F]{40}$/.test(process.env.TREASURY_WALLET_ADDRESS) ? process.env.TREASURY_WALLET_ADDRESS : deployer);
  const threshold = Number(process.env.TREASURY_THRESHOLD || 1);
  const operators = parseList(process.env.TREASURY_OPERATORS);
  if (!operators.length) operators.push(deployer);
  const assets = resolveAssets();

  // ── Phase 2: ArcTreasury ──────────────────────────────────────────────────
  console.log('• Deploying ArcTreasury(signers=%o, threshold=%d)…', signers, threshold);
  const TF = new ethers.ContractFactory(art.treasury.abi, art.treasury.bytecode, wallet);
  const treasury = await TF.deploy(signers, threshold);
  const treasuryRcpt = await treasury.deploymentTransaction().wait();
  const treasuryAddr = await treasury.getAddress();
  console.log('  ✓ ArcTreasury:', treasuryAddr, '(block', treasuryRcpt.blockNumber + ')');

  // ── Phase 3: ArcVault (governed by Treasury) ──────────────────────────────
  console.log('• Deploying ArcVault(governor=Treasury, operators, assets)…');
  const VF = new ethers.ContractFactory(art.vault.abi, art.vault.bytecode, wallet);
  const vault = await VF.deploy(treasuryAddr, operators, assets.map((a) => a.address), assets.map((a) => a.symbol));
  const vaultRcpt = await vault.deploymentTransaction().wait();
  const vaultAddr = await vault.getAddress();
  console.log('  ✓ ArcVault   :', vaultAddr, '(block', vaultRcpt.blockNumber + ')');

  // ── Phase 4: public manifest (addresses only) ─────────────────────────────
  const manifest = {
    configured: true,
    network: NETWORK_NAME,
    chainId: CHAIN_ID,
    environment: ENVIRONMENT,
    wallet: { address: signers[0] },
    treasury: { address: treasuryAddr, version: '1.0.0', type: 'multisig-governance', deployBlock: treasuryRcpt.blockNumber, signers, threshold },
    vault: { address: vaultAddr, version: '1.0.0', type: 'inbound-liquidity', deployBlock: vaultRcpt.blockNumber, governor: treasuryAddr, operators },
    assets: assets,
    chains: ['arc'],
    direction: 'inbound (External Chains -> Arc)',
    deployedAt: new Date().toISOString(),
    note: 'Addresses only — never contains keys or secrets. Consumed by the Treasury page for auto-discovery.'
  };
  const manifestPath = path.join(__dirname, '..', 'public', 'static', 'treasury-deployment.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log('  ✓ Manifest   :', manifestPath);

  console.log('');
  console.log('✅ Treasury infrastructure deployed. The Treasury page will auto-discover both contracts.');
  console.log('   Run:  node validateTreasury.cjs   to verify the deployment.');
}

main().catch((e) => { console.error('✗ Deploy failed:', e && e.message ? e.message : e); process.exit(1); });
