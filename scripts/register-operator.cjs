// ============================================================================
// register-operator.cjs — Add 0xBBE4...CD12 as ArcVault operator on-chain
// ----------------------------------------------------------------------------
// USAGE: node scripts/register-operator.cjs
//
// Uses the ArcTreasury multisig governance to execute a proposal that calls
// ArcVault.setOperator(0xBBE4Bf2D53A4A752c0eF21573FA0162BddafCD12, true).
// The ArcTreasury (0x1fd3cd...) is the ArcVault's governor; only the Treasury
// contract can call governor-gated functions on the vault.
// ============================================================================

const { ethers } = require('ethers');

const PRIVATE_KEY = '0xd385cb85f60fcb6ad677a841ba9d5bb69af3b9a91a1dae00250bec3df7f75674';
const RPC_URL = 'https://rpc.testnet.arc.network';

const TREASURY_ADDR = '0x1fd3cd592b58e838ab778Baa14f842EBEa52853D';
const VAULT_ADDR    = '0x1e039fF538Ed84Ad54610D644ca36D4b03167B87';
const NEW_OPERATOR  = '0xBBE4Bf2D53A4A752c0eF21573FA0162BddafCD12';

const TREASURY_ABI = [
  'function submitProposal(address target, uint256 value, bytes data, string metadata) external returns (uint256)',
  'function executeProposal(uint256 id) external returns (bytes)',
  'function getProposal(uint256 id) view returns (tuple(address target, uint256 value, bytes data, string metadata, address proposer, uint64 createdAt, bool executed, bool cancelled, uint256 approvals))',
  'function proposalCount() view returns (uint256)',
];

const VAULT_ABI = [
  'function setOperator(address op, bool enabled) external',
  'function isOperator(address) view returns (bool)',
];

function shortAddr(a) {
  return a ? a.slice(0, 10) + '...' + a.slice(-6) : '?';
}

async function main() {
  console.log('=== ArcVault Operator Registration ===\n');

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
  const signer   = wallet.address;
  console.log('Signer:   ', signer, '(' + shortAddr(signer) + ')');
  console.log('Treasury: ', TREASURY_ADDR);
  console.log('Vault:    ', VAULT_ADDR);
  console.log('Operator to add:', NEW_OPERATOR, '(' + shortAddr(NEW_OPERATOR) + ')');

  // ── Check current on-chain operator status ─────────────────────────────────
  const vaultRO = new ethers.Contract(VAULT_ADDR, VAULT_ABI, provider);
  const alreadyOp = await vaultRO.isOperator(NEW_OPERATOR);
  if (alreadyOp) {
    console.log('\n✓ ' + shortAddr(NEW_OPERATOR) + ' is ALREADY an operator on ArcVault. Nothing to do.');
    return;
  }
  console.log('\n× ' + shortAddr(NEW_OPERATOR) + ' is NOT an operator yet. Registering...');

  // ── Step 1: Submit proposal on ArcTreasury ──────────────────────────────────
  const treasury = new ethers.Contract(TREASURY_ADDR, TREASURY_ABI, wallet);
  const vaultIface = new ethers.Interface(VAULT_ABI);
  const callData = vaultIface.encodeFunctionData('setOperator', [NEW_OPERATOR, true]);

  console.log('\n[1/3] Submitting proposal via ArcTreasury...');
  const submitTx = await treasury.submitProposal(
    VAULT_ADDR,
    0,         // no native value
    callData,
    'Add operator: ' + NEW_OPERATOR + ' (TURBO_RELAYER_PRIVATE_KEY for autonomous settlement)'
  );
  const submitReceipt = await submitTx.wait();
  console.log('  Submit tx:', submitTx.hash, '— confirmed in block', submitReceipt.blockNumber);

  // Get the proposal ID from events
  let proposalId = null;
  for (const log of submitReceipt.logs) {
    try {
      const parsed = treasury.interface.parseLog({ topics: log.topics, data: log.data });
      if (parsed?.name === 'ProposalCreated') {
        proposalId = Number(parsed.args.id);
        break;
      }
    } catch (_) {}
  }
  if (proposalId === null) {
    // fallback: read the last proposal
    const count = Number(await treasury.proposalCount());
    proposalId = count - 1;
  }
  console.log('  Proposal ID:', proposalId);

  // ── Step 2: Check proposal status ──────────────────────────────────────────
  const prop = await treasury.getProposal(proposalId);
  console.log('\n[2/3] Proposal status:');
  console.log('  Target:   ', prop.target);
  console.log('  Proposer: ', prop.proposer);
  console.log('  Approvals:', Number(prop.approvals), '/ 1 (threshold)');
  console.log('  Executed: ', prop.executed);
  console.log('  Cancelled:', prop.cancelled);

  if (prop.executed) {
    console.log('  Proposal already executed.');
  } else if (Number(prop.approvals) >= 1) {
    // ── Step 3: Execute proposal ─────────────────────────────────────────────
    console.log('\n[3/3] Executing proposal (threshold met)...');
    const execTx = await treasury.executeProposal(proposalId);
    const execReceipt = await execTx.wait();
    console.log('  Execute tx:', execTx.hash, '— confirmed in block', execReceipt.blockNumber);

    // Verify
    const isOp = await vaultRO.isOperator(NEW_OPERATOR);
    if (isOp) {
      console.log('\n✅ SUCCESS — ' + shortAddr(NEW_OPERATOR) + ' is now an ArcVault operator!');
    } else {
      console.log('\n⚠️  Execute tx confirmed but isOperator still returned false.');
    }
  } else {
    console.log('\n⚠️  Threshold not met. Approvals:', Number(prop.approvals), '/ 1');
  }
}

main().catch(e => {
  console.error('\n❌ Error:', e.shortMessage || e.message || e);
  process.exit(1);
});
