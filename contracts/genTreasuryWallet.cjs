#!/usr/bin/env node
/* eslint-disable */
// ============================================================================
//  genTreasuryWallet.cjs — Phase 1: create the dedicated Treasury Wallet
// ----------------------------------------------------------------------------
//  SECURITY MODEL (must be respected — matches ExecDaat policy):
//    • This script is run by the AUTHORIZED OPERATOR in a SECURE environment.
//    • It generates a brand-new EVM wallet (multi-chain: Arc/Base/Ethereum/
//      Arbitrum/Optimism/Polygon/Avalanche/BNB — one EVM key works on all).
//    • The private key / mnemonic are written ONLY to an ENCRYPTED keystore
//      inside ./.treasury-secrets/ (gitignored) using TREASURY_WALLET_PASSWORD.
//    • NOTHING sensitive is printed to stdout, committed, or shipped to the
//      frontend. Only the PUBLIC address is emitted.
//    • ExecDaat itself never stores the key (all signing stays operator-side).
//
//  Usage (from the contracts/ directory):
//    TREASURY_WALLET_PASSWORD='a-strong-password' node genTreasuryWallet.cjs
//
//  Output:
//    ./.treasury-secrets/treasury-wallet.keystore.json   (encrypted, gitignored)
//    ./.treasury-secrets/treasury-wallet.address.txt     (public address only)
//    prints the public address to register as a Treasury signer / owner.
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

async function main() {
  const password = process.env.TREASURY_WALLET_PASSWORD;
  if (!password || password.length < 10) {
    console.error('✗ Set TREASURY_WALLET_PASSWORD (>= 10 chars). The keystore is encrypted with it.');
    console.error("  Example: TREASURY_WALLET_PASSWORD='correct-horse-battery-staple' node genTreasuryWallet.cjs");
    process.exit(1);
  }

  const outDir = path.join(process.cwd(), '.treasury-secrets');
  fs.mkdirSync(outDir, { recursive: true });

  const keystorePath = path.join(outDir, 'treasury-wallet.keystore.json');
  if (fs.existsSync(keystorePath) && !process.env.FORCE_NEW) {
    console.error('✗ A treasury wallet keystore already exists at ' + keystorePath);
    console.error('  Refusing to overwrite. Set FORCE_NEW=1 to intentionally replace it.');
    process.exit(1);
  }

  console.log('• Generating a new dedicated Treasury wallet (EVM, multi-chain)…');
  const wallet = ethers.Wallet.createRandom();
  const address = wallet.address;

  console.log('• Encrypting keystore (scrypt)…');
  const keystore = await wallet.encrypt(password);

  fs.writeFileSync(keystorePath, keystore, { mode: 0o600 });
  fs.writeFileSync(path.join(outDir, 'treasury-wallet.address.txt'), address + '\n', { mode: 0o644 });

  // Minimal, non-sensitive metadata for the operator's records.
  fs.writeFileSync(path.join(outDir, 'treasury-wallet.meta.json'), JSON.stringify({
    address,
    createdAt: new Date().toISOString(),
    type: 'treasury-owner-signer',
    scope: 'EVM multi-chain (Arc/Base/Ethereum/Arbitrum/Optimism/Polygon/Avalanche/BNB)',
    keystore: 'treasury-wallet.keystore.json (encrypted, gitignored)',
    note: 'Private key / mnemonic are NEVER stored outside this encrypted keystore, never committed, never shipped to the frontend.'
  }, null, 2) + '\n', { mode: 0o644 });

  console.log('');
  console.log('✅ Treasury wallet created.');
  console.log('   Public address : ' + address);
  console.log('   Keystore       : ' + keystorePath + '  (ENCRYPTED, gitignored — keep it safe & backed up)');
  console.log('');
  console.log('   Next: fund this address with test gas on Arc, then use it as a signer/owner');
  console.log('   in deployTreasury.cjs (TREASURY_SIGNERS / TREASURY_WALLET_ADDRESS).');
  console.log('');
  console.log('   ⚠  The private key was NOT printed and is NOT stored anywhere except the');
  console.log('      encrypted keystore. Never commit .treasury-secrets/ (it is gitignored).');
}

main().catch((e) => { console.error('✗ Failed:', e && e.message ? e.message : e); process.exit(1); });
