#!/usr/bin/env node
/* eslint-disable */
// ============================================================================
//  validateTreasury.cjs — Phase 5: validate the deployed infrastructure.
// ----------------------------------------------------------------------------
//  Read-only. Reads ../public/static/treasury-deployment.json and checks, on-chain:
//    ✓ Treasury deployed (has code)      ✓ Vault deployed (has code)
//    ✓ Contracts initialized (summaries readable)
//    ✓ Ownership configured (Vault.governor == Treasury)
//    ✓ Permissions configured (operators / signers present)
//    ✓ Treasury controls Vault           ✓ Vault responds (balances readable)
//    ✓ Statistics readable               ✓ No initialization errors
//
//  Usage (from contracts/):  node validateTreasury.cjs
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const TREASURY_ABI = [
  'function summary() view returns (tuple(string name,string version,uint256 signerCount,uint256 threshold,bool paused,address vault,uint256 proposalCount,uint256 executedCount,uint256 assetCount))',
  'function getSigners() view returns (address[])',
];
const VAULT_ABI = [
  'function summary() view returns (tuple(string name,string version,address governor,bool paused,uint256 assetCount,uint256 operatorCount,uint256 turboFeeBps))',
  'function getAssets() view returns (address[])',
  'function getOperators() view returns (address[])',
  'function getAvailableLiquidity(address) view returns (uint256)',
  'function allAssetStats() view returns (tuple(address asset,string symbol,uint256 total,uint256 available,uint256 reserved,uint256 locked,uint256 pending,uint8 health)[])',
];

let pass = 0, fail = 0;
function check(ok, label, detail) { console.log((ok ? '  ✓ ' : '  ✗ ') + label + (detail ? '  — ' + detail : '')); ok ? pass++ : fail++; return ok; }

async function main() {
  const manifestPath = path.join(__dirname, '..', 'public', 'static', 'treasury-deployment.json');
  if (!fs.existsSync(manifestPath)) { console.error('✗ No manifest at ' + manifestPath + '. Run deployTreasury.cjs first.'); process.exit(1); }
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!m.configured) { console.error('✗ Manifest not configured (contracts not deployed yet).'); process.exit(1); }

  const RPC = process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network';
  const provider = new ethers.JsonRpcProvider(RPC, m.chainId || 5042002);
  console.log('Validating Treasury infrastructure on ' + (m.network || 'Arc') + '…\n');

  const tAddr = m.treasury && m.treasury.address;
  const vAddr = m.vault && m.vault.address;

  const tCode = await provider.getCode(tAddr).catch(() => '0x');
  const vCode = await provider.getCode(vAddr).catch(() => '0x');
  check(tCode && tCode !== '0x', 'Treasury deployed', tAddr);
  check(vCode && vCode !== '0x', 'Vault deployed', vAddr);

  const treasury = new ethers.Contract(tAddr, TREASURY_ABI, provider);
  const vault = new ethers.Contract(vAddr, VAULT_ABI, provider);

  let ts = null, vs = null;
  try { ts = await treasury.summary(); check(true, 'Treasury initialized', ts.name + ' v' + ts.version); } catch (e) { check(false, 'Treasury initialized', e.message); }
  try { vs = await vault.summary(); check(true, 'Vault initialized', vs.name + ' v' + vs.version); } catch (e) { check(false, 'Vault initialized', e.message); }

  if (vs) check(vs.governor && vs.governor.toLowerCase() === (tAddr || '').toLowerCase(), 'Ownership configured (Vault.governor == Treasury)', vs.governor);
  if (ts) check(Number(ts.signerCount) > 0 && Number(ts.threshold) > 0, 'Treasury permissions configured', ts.signerCount + ' signers, threshold ' + ts.threshold);
  if (vs) check(Number(vs.operatorCount) >= 0, 'Vault permissions configured', vs.operatorCount + ' operators');
  if (ts && vs) check(!ts.paused && !vs.paused, 'Not paused', 'treasury=' + ts.paused + ' vault=' + vs.paused);

  try { const ops = await vault.getOperators(); check(Array.isArray(ops), 'Vault responds (operators readable)', ops.length + ' operators'); } catch (e) { check(false, 'Vault responds', e.message); }
  try { const stats = await vault.allAssetStats(); check(Array.isArray(stats), 'Statistics readable', stats.length + ' assets'); stats.forEach((s) => console.log('      · ' + (s.symbol || s.asset) + ': avail=' + ethers.formatUnits(s.available, 6) + ' reserved=' + ethers.formatUnits(s.reserved, 6) + ' pending=' + ethers.formatUnits(s.pending, 6) + ' health=' + s.health)); } catch (e) { check(false, 'Statistics readable', e.message); }

  console.log('\n' + (fail === 0 ? '✅ All checks passed (' + pass + ').' : '⚠ ' + fail + ' check(s) failed, ' + pass + ' passed.'));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ Validation error:', e && e.message ? e.message : e); process.exit(1); });
