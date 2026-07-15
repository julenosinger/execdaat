// ============================================================
// ARC Contracts Module v5 — On-chain Escrow + Full Sync
// ContractFactory: 0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A
// Arc Testnet (chainId 5042002) | USDC
// v5 Improvements:
//   - On-chain storage: getByClient/getByContractor mappings
//   - ContractCreated event parsing → immediate UI refresh
//   - USDC approve+deposit flow with balance/allowance checks
//   - Multicall batching for creation (approve + create in one session)
//   - Live depositedValue display from on-chain data
//   - Network validation: blocks ops on wrong chain
//   - Debug logs: tx hash, address, block, balance
//   - Auto-refresh after create/deposit/complete
//   - Loading states on all async operations
// ============================================================
'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const CF_FACTORY_ADDR  = '0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A';
const CF_USDC_ADDR     = '0x3600000000000000000000000000000000000000';
const CF_EXPLORER      = 'https://testnet.arcscan.app';
const CF_CHAIN_ID      = 5042002;
const CF_CHAIN_HEX     = '0x4cef52';
const CF_NETWORK_NAME  = 'Arc Testnet';
const CF_RPC           = 'https://rpc.testnet.arc.network';
const CF_USDC_DECIMALS = 6;
const CF_USDC_SCALE    = 1_000_000n;
const CF_PLATFORM_FEE  = 0.002; // 0.2%
const CF_META_KEY      = 'arc_cf_meta_v5'; // localStorage key for off-chain metadata
const CF_IDS_KEY       = 'arc_cf_ids_v5';  // localStorage cache for contract IDs per wallet
const CF_TX_LOG_KEY    = 'arc_cf_txlog_v5'; // localStorage tx history log

// IPFS via nft.storage public gateway (no key needed for small files via w3s)
// Fallback: store as data URI in localStorage if IPFS unavailable
const CF_IPFS_API      = 'https://api.web3.storage/upload';

// ─── Dispute & Closure constants ──────────────────────────────────────────────
const CF_DISPUTE_KEY   = 'arc_cf_disputes_v1'; // localStorage key for dispute data
// Dispute statuses
const CF_DISPUTE_STATUS = {
  open:     { label: 'In Dispute',  icon: 'fa-gavel',        color: '#f87171', bg: '239,68,68'   },
  resolved: { label: 'Resolved',   icon: 'fa-check-circle', color: '#34d399', bg: '52,211,153'  },
  none:     { label: 'No Dispute', icon: 'fa-shield-alt',   color: '#4a5568', bg: '74,85,104'   },
};
// Contract closure statuses stored in meta
const CF_CLOSED_LABEL  = 'Closed';

// ─── ABIs ─────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// ROOT CAUSE FIX: getContract() returns a WorkContract STRUCT in Solidity,
// which ABI-encodes as a tuple with a dynamic offset prefix (0x20...).
// ethers v6 REQUIRES the return type declared as 'tuple(...)' — using flat
// 'returns (uint256,address,...)' causes BAD_DATA on every single decode call.
// getMilestones elements are also Milestone structs → must be tuple[].
// ─────────────────────────────────────────────────────────────────────────────
const CF_ABI = [
  // ── Read-only ────────────────────────────────────────────────────────────
  'function contractCount() view returns (uint256)',
  // CRITICAL: must be tuple — WorkContract is a Solidity struct
  'function getContract(uint256 id) view returns (tuple(uint256 id, address client, address contractor, string title, uint256 totalValue, uint256 depositedValue, uint8 status, bool contractorSigned, uint256 createdAt, uint256 startedAt, uint256 completedAt, uint256 milestoneCount, uint256 completedMilestones))',
  // CRITICAL: must be tuple[] — Milestone is a Solidity struct
  'function getMilestones(uint256 id) view returns (tuple(uint256 id, string description, uint256 amount, uint8 status, uint256 releasedAt)[])',
  'function getByClient(address) view returns (uint256[])',
  'function getByContractor(address) view returns (uint256[])',
  // ── Write ────────────────────────────────────────────────────────────────
  // Flow: client → USDC.approve(factory, totalValue) → createContract()
  //       contractor → signContract()   [Draft → Active]
  //       client     → completeMilestone() [releases USDC to contractor]
  //       client     → cancelContract()  [refund while Draft]
  'function createContract(address contractor, string title, uint256 totalValue, string[] milestoneDescs, uint256[] milestoneAmounts) returns (uint256)',
  'function signContract(uint256 contractId)',
  'function completeMilestone(uint256 contractId, uint256 milestoneIndex)',
  'function cancelContract(uint256 contractId)',
  // ── Events (exact Solidity signatures — required for parseLog) ────────────
  'event ContractCreated(uint256 indexed contractId, address indexed client, address indexed contractor, string title, uint256 totalValue, uint256 milestoneCount, uint256 timestamp)',
  'event ContractSigned(uint256 indexed contractId, address indexed contractor, uint256 timestamp)',
  'event MilestoneReleased(uint256 indexed contractId, uint256 indexed milestoneIndex, address indexed contractor, uint256 amount, uint256 timestamp)',
  'event ContractCancelled(uint256 indexed contractId, address indexed client, uint256 refundAmount, uint256 timestamp)',
];

const CF_USDC_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];

// ─── Contract Modes ────────────────────────────────────────────────────────────
const CF_MODES = {
  onchain:   { label: 'On-Chain Escrow',      icon: 'fa-link',          color: '#60b4ff' },
  offchain:  { label: 'Off-Chain Payment',    icon: 'fa-money-bill-wave', color: '#fbbf24' },
  custodial: { label: 'Custodial Escrow',     icon: 'fa-shield-alt',    color: '#a78bfa' },
};

// ─── Proof status labels ───────────────────────────────────────────────────────
const CF_PROOF_STATUS = {
  none:      { label: 'Not Submitted', icon: 'fa-times-circle',   color: '#4a5568' },
  uploaded:  { label: 'Uploaded',      icon: 'fa-cloud-upload-alt', color: '#fbbf24' },
  committed: { label: 'Committed',     icon: 'fa-check-circle',   color: '#34d399' },
};

// Compute proof status for a contract
function cfProofStatus(meta) {
  const proofs = meta.proofs || [];
  if (!proofs.length) return 'none';
  if (proofs.some(p => p.committed)) return 'committed';
  return 'uploaded';
}
const CF_STATUS_LABELS = ['Draft', 'Active', 'Completed', 'Cancelled'];
const CF_STATUS_MAP = {
  Pending:    { color: 'yellow', icon: 'fa-clock',        label: 'Pending' },
  Funded:     { color: 'blue',   icon: 'fa-coins',        label: 'Funded — Awaiting Signature' },
  Active:     { color: 'cyan',   icon: 'fa-bolt',         label: 'Active' },
  Completed:  { color: 'green',  icon: 'fa-check-circle', label: 'Completed' },
  Cancelled:  { color: 'red',    icon: 'fa-times-circle', label: 'Cancelled' },
  Draft:      { color: 'yellow', icon: 'fa-clock',        label: 'Pending' },
  'In Dispute': { color: 'red',  icon: 'fa-gavel',        label: 'In Dispute' },
  Closed:     { color: 'gray',   icon: 'fa-lock',         label: 'Closed' },
};

function cfUiStatus(c) {
  // Check meta-level overrides first (dispute, closure)
  const meta = cfGetMeta(c.id);
  if (meta.contractClosed)            return 'Closed';
  if (cfGetDisputeStatus(c.id) === 'open') return 'In Dispute';
  if (c.status === 'Cancelled') return 'Cancelled';
  if (c.status === 'Completed') return 'Completed';
  if (c.status === 'Active')    return 'Active';
  if (BigInt(c.depositedValue) > 0n) return 'Funded';
  return 'Pending';
}

// ─── Module state ─────────────────────────────────────────────────────────────
const cfState = {
  pending:      false,
  contracts:    [],
  milestones:   {},
  lastTxHash:   null,
  networkOk:    false,
  _provider:    null,
  _factory:     null,
  _usdc:        null,
  loadingIds:   false,   // prevent concurrent fetches
  lastWallet:   null,    // track wallet changes
  lastRefresh:  0,       // timestamp of last successful fetch
  debugMode:    true,    // verbose on-chain debug logging
};

// ─── Persistent Hide State (Contracts) ──────────────────────────────────────────
// Uses localStorage key 'hiddenContracts' — survives page reload.
const _cfDismiss = {
  isVisible: (id) => typeof arcIsVisibleContract === 'function' ? arcIsVisibleContract(id) : true,
  dismiss:   (id) => typeof arcHideContract      === 'function' ? arcHideContract(id)      : undefined,
  reset:     ()   => { /* no-op: persistent hide does NOT reset on reload */ },
};

// ─── Off-chain metadata (localStorage) ────────────────────────────────────────
// Stores: { [contractId]: { clientEmail, contractorEmail, custodianAddr, escrowRef, proofs: [], completedAt, receiptData } }
function cfGetMeta(id) {
  try {
    const all = JSON.parse(localStorage.getItem(CF_META_KEY) || '{}');
    return all[String(id)] || {};
  } catch { return {}; }
}
function cfSetMeta(id, data) {
  try {
    const all = JSON.parse(localStorage.getItem(CF_META_KEY) || '{}');
    all[String(id)] = { ...(all[String(id)] || {}), ...data };
    localStorage.setItem(CF_META_KEY, JSON.stringify(all));
  } catch (e) { cfErr('cfSetMeta:', e); }
}

// ─── Dispute storage helpers ───────────────────────────────────────────────────
function cfGetDispute(contractId) {
  try {
    const all = JSON.parse(localStorage.getItem(CF_DISPUTE_KEY) || '{}');
    return all[String(contractId)] || null;
  } catch { return null; }
}
function cfSetDispute(contractId, data) {
  try {
    const all = JSON.parse(localStorage.getItem(CF_DISPUTE_KEY) || '{}');
    const existing = all[String(contractId)] || {};
    all[String(contractId)] = { ...existing, ...data };
    localStorage.setItem(CF_DISPUTE_KEY, JSON.stringify(all));
  } catch (e) { cfErr('cfSetDispute:', e); }
}
function cfGetDisputeStatus(contractId) {
  const d = cfGetDispute(contractId);
  if (!d) return 'none';
  return d.status || 'none';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function cfEl(id)       { return document.getElementById(id); }
function cfShort(addr)  { if (!addr || addr.length < 12) return addr || '—'; return addr.slice(0, 8) + '…' + addr.slice(-6); }
// Escape untrusted text before it is interpolated into innerHTML (prevents
// stored XSS from on-chain titles, dispute reasons, file names, emails, etc.).
// Safe for both element content and quoted attribute values.
function cfEsc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
// Newest-first ordering + "NEW" tag. Uses the on-chain `createdAt` (shared by
// both client and contractor), so a freshly created contract appears at the top
// with a NEW badge for BOTH parties. Within each view tab all contracts share the
// same unit (on-chain: seconds, off-chain: ms), so comparisons are consistent.
var CF_NEW_WINDOW_MS = 24 * 60 * 60 * 1000; // show "NEW" for 24h after creation
function cfCreatedTs(c) {
  var raw = Number(c && c.createdAt) || 0;
  if (raw > 0) return raw > 1e12 ? raw : raw * 1000; // normalize seconds → ms
  // Unknown createdAt (freshly created, not yet indexed on-chain) → treat as
  // newest so a brand-new contract always appears first in the list.
  return Date.now();
}
function cfIsNew(c) {
  var raw = Number(c && c.createdAt) || 0;
  if (raw <= 0) return false;
  var ms = raw > 1e12 ? raw : raw * 1000; // normalize seconds → ms
  return (Date.now() - ms) < CF_NEW_WINDOW_MS && ms <= Date.now() + 60000;
}
function cfTs(ts)       { if (!ts || ts === 0) return '—'; return new Date(Number(ts) * 1000).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }); }
function cfLog(...a)    { if (cfState.debugMode) console.log('%c[CF v5]', 'color:#60b4ff;font-weight:bold', ...a); }
function cfWarn(...a)   { console.warn('[CF v5]', ...a); }
function cfErr(...a)    { console.error('[CF v5]', ...a); }

// ─── TX Log (debug history + hybrid persistence) ─────────────────────────────
function cfLogTx(action, txHash, contractId, extra = {}) {
  try {
    const log = JSON.parse(localStorage.getItem(CF_TX_LOG_KEY) || '[]');
    const entry = {
      action, txHash, contractId,
      ts: Date.now(),
      wallet: window.walletState?.address,
      ...extra,
    };
    log.unshift(entry);
    localStorage.setItem(CF_TX_LOG_KEY, JSON.stringify(log.slice(0, 50)));
    cfLog(`📝 TX LOG [${action}] contractId=${contractId} tx=${txHash}`);

    // Also persist to IndexedDB via persistence layer
    if (typeof arcSave === 'function' && txHash) {
      const record = {
        id: 'cf_tx_' + (txHash || contractId + '_' + action + '_' + Date.now()),
        txHash,
        contractId: String(contractId),
        action,
        type: 'contract',
        status: extra.status || 'confirmed',
        timestamp: new Date().toISOString(),
        wallet: window.walletState?.address,
        network: CF_NETWORK_NAME,
        chainId: CF_CHAIN_ID,
        ...extra,
      };
      arcSave(window.ARC_STORE_CF || 'contracts', record).catch(() => {});
    }
  } catch { /* non-critical */ }
}

// ─── ID cache per wallet ─────────────────────────────────────────────────────
function cfCacheIds(wallet, ids) {
  try {
    const all = JSON.parse(localStorage.getItem(CF_IDS_KEY) || '{}');
    all[wallet.toLowerCase()] = { ids, ts: Date.now() };
    localStorage.setItem(CF_IDS_KEY, JSON.stringify(all));
  } catch { /* non-critical */ }
}
function cfGetCachedIds(wallet) {
  try {
    const all = JSON.parse(localStorage.getItem(CF_IDS_KEY) || '{}');
    const entry = all[wallet.toLowerCase()];
    if (!entry) return null;
    // Cache valid for 30s only
    if (Date.now() - entry.ts > 30000) return null;
    return entry.ids;
  } catch { return null; }
}

// ─── Network banner ──────────────────────────────────────────────────────────
function cfUpdateNetworkBanner(ok) {
  const banner = document.getElementById('cf-network-banner');
  if (!banner) return;
  if (ok) {
    banner.style.display = 'none';
  } else {
    banner.style.display = 'flex';
    banner.innerHTML = `<i class="fas fa-exclamation-triangle" style="color:#f59e0b;margin-right:6px;"></i>
      <span style="font-size:12px;color:#fbbf24;">Wrong network. Switch to <strong>Arc Testnet (${CF_CHAIN_ID})</strong></span>
      <button onclick="cfSwitchNetwork()" style="margin-left:auto;font-size:11px;background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.3);color:#fbbf24;padding:3px 12px;border-radius:6px;cursor:pointer;">Switch</button>`;
  }
}

function cfParseUsdc(human) {
  const s = String(human).trim();
  const [int = '0', frac = ''] = s.split('.');
  return BigInt(int) * CF_USDC_SCALE + BigInt(frac.slice(0, 6).padEnd(6, '0'));
}
function cfFmtUsdc(base) {
  const n = typeof base === 'bigint' ? base : BigInt(Math.round(Number(base)));
  return (Number(n) / 1e6).toFixed(2);
}
function cfCalcFee(totalRaw) {
  // 0.2% platform fee
  return (BigInt(totalRaw) * 2n) / 1000n;
}
function cfNetAmount(totalRaw) {
  return BigInt(totalRaw) - cfCalcFee(BigInt(totalRaw));
}

// ─── Provider / Signer bootstrap ──────────────────────────────────────────────
async function cfInitProvider() {
  try {
    const rawProv = window.walletState?.provider;
    if (!rawProv) return { ok: false, error: 'no_wallet', message: t('contracts_carteira_nao_conectada') };
    if (!window.ethers) return { ok: false, error: 'no_ethers', message: t('contracts_ethers_not_loaded') };

    let provider;
    try { provider = new window.ethers.BrowserProvider(rawProv, 'any'); }
    catch (e) { return { ok: false, error: 'provider_init', message: 'Failed to initialize provider: ' + e.message }; }

    let network;
    try { network = await provider.getNetwork(); }
    catch (e) { return { ok: false, error: 'network_error', message: 'Failed to read network: ' + e.message }; }

    const chainId = Number(network.chainId);
    if (chainId !== CF_CHAIN_ID) {
      return { ok: false, error: 'wrong_network', chainId,
        message: `Rede incorreta (Chain ID ${chainId}). Troque para ${CF_NETWORK_NAME} (${CF_CHAIN_ID}).` };
    }

    let signer;
    try { signer = await provider.getSigner(); }
    catch (e) { return { ok: false, error: 'no_signer', message: t('contracts_no_signer', e.message) }; }

    const address = await signer.getAddress();
    const factory = new window.ethers.Contract(CF_FACTORY_ADDR, CF_ABI, signer);
    const usdc    = new window.ethers.Contract(CF_USDC_ADDR, CF_USDC_ABI, signer);

    cfState._provider = provider;
    cfState._factory  = factory;
    cfState._usdc     = usdc;
    cfState.networkOk = true;

    return { ok: true, provider, signer, factory, usdc, address };
  } catch (e) {
    cfErr('initProvider unexpected:', e);
    return { ok: false, error: 'unexpected', message: e.message || 'Unexpected error.' };
  }
}

async function cfSwitchNetwork() {
  const rawProv = window.walletState?.provider;
  if (!rawProv) { showToast(t('contracts_connect_wallet'), 'warning'); return; }
  try {
    await rawProv.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CF_CHAIN_HEX }] });
    await new Promise(r => setTimeout(r, 1000));
    cfLoadContracts();
  } catch (e) {
    if (e.code === 4902) {
      try {
        await rawProv.request({ method: 'wallet_addEthereumChain', params: [{
          chainId: CF_CHAIN_HEX, chainName: CF_NETWORK_NAME,
          rpcUrls: [CF_RPC, 'https://rpc.blockdaemon.testnet.arc.network', 'https://rpc.drpc.testnet.arc.network', 'https://rpc.quicknode.testnet.arc.network'],
          nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
          blockExplorerUrls: [CF_EXPLORER],
        }]});
        await new Promise(r => setTimeout(r, 1000));
        cfLoadContracts();
      } catch (e2) { showToast('Could not add Arc Testnet: ' + e2.message, 'error'); }
    } else if (e.code !== 4001) { showToast('Error switching network: ' + e.message, 'error'); }
  }
}

// ─── RPC helpers ──────────────────────────────────────────────────────────────
async function cfRpcCall(to, data) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'eth_call', params: [{ to, data }, 'latest'] });
  const res  = await fetch(CF_RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  const json = await res.json();
  if (json.error) throw new Error('eth_call error: ' + json.error.message);
  return json.result;
}
function cfPad(hex, bytes = 32)  { return hex.replace(/^0x/, '').padStart(bytes * 2, '0'); }
function cfEncAddr(addr)          { return cfPad(addr.replace(/^0x/, ''), 32); }

const CF_SEL = {
  getByClient:     '0x8018b98c',
  getByContractor: '0x32db19d6',
  usdcBalanceOf:   '0x70a08231',
  usdcAllowance:   '0xdd62ed3e',
};

function cfDecodeUintArray(hex) {
  if (!hex || hex === '0x') return [];
  const s = hex.replace(/^0x/, '');
  if (s.length < 128) return [];
  const len = Number(BigInt('0x' + s.slice(64, 128)));
  const arr = [];
  for (let i = 0; i < len; i++) arr.push(Number(BigInt('0x' + s.slice(128 + i * 64, 128 + (i + 1) * 64))));
  return arr;
}

async function cfFetchMyIds(address) {
  const enc = cfEncAddr(address);
  cfLog('Fetching contract IDs for', address);
  let hexC, hexA;
  try {
    [hexC, hexA] = await Promise.all([
      cfRpcCall(CF_FACTORY_ADDR, CF_SEL.getByClient + enc),
      cfRpcCall(CF_FACTORY_ADDR, CF_SEL.getByContractor + enc),
    ]);
  } catch (e) {
    cfErr('cfFetchMyIds RPC error:', e.message);
    // Try fallback: sequential calls
    try { hexC = await cfRpcCall(CF_FACTORY_ADDR, CF_SEL.getByClient + enc); } catch { hexC = '0x'; }
    try { hexA = await cfRpcCall(CF_FACTORY_ADDR, CF_SEL.getByContractor + enc); } catch { hexA = '0x'; }
  }
  const clientIds     = cfDecodeUintArray(hexC);
  const contractorIds = cfDecodeUintArray(hexA);
  cfLog(`Found ${clientIds.length} as client, ${contractorIds.length} as contractor`);
  const seen = new Set();
  const ids = [...clientIds, ...contractorIds].filter(id => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  // Cache locally
  cfCacheIds(address, ids);
  return ids;
}

async function cfReadBalance(addr) {
  const hex = await cfRpcCall(CF_USDC_ADDR, CF_SEL.usdcBalanceOf + cfEncAddr(addr));
  const bal = hex && hex !== '0x' ? BigInt(hex) : 0n;
  cfLog(`USDC balance for ${cfShort(addr)}: $${cfFmtUsdc(bal)}`);
  return bal;
}
async function cfReadAllowance(owner, spender) {
  const data = CF_SEL.usdcAllowance + cfEncAddr(owner) + cfPad(spender.replace(/^0x/, ''), 32);
  const hex  = await cfRpcCall(CF_USDC_ADDR, data);
  const allow = hex && hex !== '0x' ? BigInt(hex) : 0n;
  cfLog(`USDC allowance ${cfShort(owner)} → ${cfShort(spender)}: $${cfFmtUsdc(allow)}`);
  return allow;
}

// ─── Read deposited balance directly from chain ───────────────────────────────
async function cfReadDepositedBalance(contractId) {
  try {
    if (!cfState._factory) return null;
    const r = await cfState._factory.getContract(contractId);
    // r is a named tuple — use .depositedValue (not r[5])
    const deposited = BigInt(r.depositedValue);
    cfLog(`Contract #${contractId} depositedValue on-chain: $${cfFmtUsdc(deposited)}`);
    return deposited;
  } catch (e) {
    cfErr('cfReadDepositedBalance error:', e.message);
    return null;
  }
}

// ─── Fetch contract data ──────────────────────────────────────────────────────
// ROOT CAUSE FIX: getContract() returns a WorkContract STRUCT (tuple).
// ethers v6 decodes tuple returns as objects with NAMED properties.
// We MUST access r.fieldName — using r[index] was wrong because the dynamic
// 'title' field shifts numeric offsets unpredictably.
async function cfFetchContract(factory, id) {
  let r;
  try {
    r = await factory.getContract(id);
  } catch (e) {
    cfErr(`cfFetchContract(#${id}) DECODE ERROR — likely wrong ABI:`, e.message);
    throw e;
  }
  const statusCode = Number(r.status);
  const status = CF_STATUS_LABELS[statusCode] || 'Unknown';
  const c = {
    id:                  Number(r.id),
    client:              r.client,
    contractor:          r.contractor,
    title:               r.title,
    totalValue:          r.totalValue,        // BigInt
    depositedValue:      r.depositedValue,    // BigInt
    statusCode,
    status,
    contractorSigned:    r.contractorSigned,
    createdAt:           Number(r.createdAt),
    startedAt:           Number(r.startedAt),
    completedAt:         Number(r.completedAt),
    milestoneCount:      Number(r.milestoneCount),
    completedMilestones: Number(r.completedMilestones),
    _fetchedAt:          Date.now(),
  };
  cfLog(
    `✅ Contract #${id}: "${c.title}" | ${status}(${statusCode})` +
    ` | deposited=$${cfFmtUsdc(c.depositedValue)}/$${cfFmtUsdc(c.totalValue)}` +
    ` | client=${cfShort(c.client)}`
  );
  return c;
}

async function cfFetchMilestones(factory, id) {
  let rows;
  try {
    rows = await factory.getMilestones(id);
  } catch (e) {
    cfErr(`cfFetchMilestones(#${id}) error:`, e.message);
    return [];
  }
  return rows.map((m, i) => ({
    id:          Number(m.id) || i,
    description: m.description,
    amount:      m.amount,   // BigInt
    status:      Number(m.status) === 1 ? 'Released' : 'Pending',
    releasedAt:  Number(m.releasedAt),
  }));
}

// ─── Step panel helpers ────────────────────────────────────────────────────────
function cfSetStep(n, status = 'active', detail = '') {
  const panel = cfEl('cf-steps-panel');
  if (panel) panel.classList.remove('hidden');
  for (let i = 0; i <= 6; i++) {
    const el = cfEl(`cf-step-${i}`);
    if (!el) continue;
    el.classList.remove('ct-step-active', 'ct-step-done', 'ct-step-error', 'ct-step-idle');
    if (i < n)        el.classList.add('ct-step-done');
    else if (i === n) el.classList.add(status === 'error' ? 'ct-step-error' : 'ct-step-active');
    else              el.classList.add('ct-step-idle');
    if (i === n && detail) {
      const span = el.querySelector('span');
      if (span) { if (!span.dataset.base) span.dataset.base = span.textContent; span.textContent = detail; }
    }
  }
}
function cfHideSteps() {
  const panel = cfEl('cf-steps-panel');
  if (panel) {
    panel.classList.add('hidden');
    for (let i = 0; i <= 6; i++) {
      const el = cfEl(`cf-step-${i}`);
      if (!el) continue;
      el.classList.remove('ct-step-active', 'ct-step-done', 'ct-step-error');
      el.classList.add('ct-step-idle');
      const span = el.querySelector('span');
      if (span?.dataset.base) { span.textContent = span.dataset.base; delete span.dataset.base; }
    }
  }
}

// ─── List state placeholder ────────────────────────────────────────────────────
function cfShowListState(state, message = '') {
  // Never show on-chain loading/error states while the user is on a local tab
  const vm = window._cfViewMode || 'onchain';
  if (vm !== 'onchain' && (state === 'loading' || state === 'no_wallet' || state === 'empty' || state === 'wrong_network')) return;

  const el = cfEl('cf-contracts-list');
  if (!el) return;
  const states = {
    no_wallet:     { icon: 'fa-wallet',       color: '#3a4870', msg: 'Connect your wallet to view on-chain contracts.' },
    wrong_network: { icon: 'fa-network-wired', color: '#f59e0b', msg: message || `Switch to ${CF_NETWORK_NAME}.` },
    loading:       { icon: 'fa-spinner fa-spin', color: '#60b4ff', msg: 'Loading on-chain contracts…' },
    empty:         { icon: 'fa-file-contract', color: '#3a4870', msg: 'No contracts found. Create one above.' },
    error:         { icon: 'fa-exclamation-triangle', color: '#f87171', msg: message || 'Error loading contracts.' },
  };
  const s = states[state] || states.error;
  el.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;gap:12px;padding:48px 0;text-align:center;">
    <div style="width:56px;height:56px;border-radius:16px;background:rgba(55,138,221,0.06);border:1px solid rgba(55,138,221,0.12);display:flex;align-items:center;justify-content:center;">
      <i class="fas ${s.icon}" style="color:${s.color};font-size:22px;"></i>
    </div>
    <p style="color:${s.color};font-size:13px;max-width:280px;">${s.msg}</p>
    ${state === 'wrong_network' ? `<button onclick="cfSwitchNetwork()" style="font-size:12px;background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.3);color:#fbbf24;padding:6px 16px;border-radius:8px;cursor:pointer;">Switch to Arc Testnet</button>` : ''}
  </div>`;
}

// ─── Load contracts ────────────────────────────────────────────────────────────
async function cfLoadContracts(opts = {}) {
  const wallet = window.walletState?.address;
  const currentViewMode = window._cfViewMode || 'onchain';

  // ── Off-chain / Custodial view: always render from localStorage immediately,
  //    never show a loading spinner or trigger any on-chain fetch.
  //    The on-chain data is kept in _allContracts for when the user switches back.
  if (currentViewMode !== 'onchain') {
    const offchainAll = cfLoadOffchainContracts();
    // Merge with cached on-chain so _allContracts stays complete
    const cachedOnchain = (cfState._allContracts || cfState.contracts || []).filter(c => !c._isOffchain);
    const merged = [...cachedOnchain, ...offchainAll];
    cfState._allContracts = merged;
    cfRenderContracts(merged, wallet || null);
    cfRenderSummary(merged, wallet || null);
    cfUpdateNetworkBanner(!!wallet);
    return;
  }

  // ── No wallet: show local off-chain only (no spinner, no on-chain fetch) ────
  if (!wallet) {
    const offchainAll = cfLoadOffchainContracts();
    cfState._allContracts = offchainAll;
    if (offchainAll.length > 0) {
      cfState.contracts = offchainAll;
      cfRenderContracts(offchainAll, null);
      cfRenderSummary(offchainAll, null);
    } else {
      cfShowListState('no_wallet');
      cfRenderSummary([], null);
    }
    cfUpdateNetworkBanner(false);
    return;
  }

  if (cfState.loadingIds && !opts.force) {
    cfLog('cfLoadContracts: already loading, skip');
    return;
  }

  // NOTE: persistent hide — items stay hidden across reloads (user can unhide via 'Show Hidden')

  cfState.loadingIds = true;
  cfShowListState('loading');
  cfLog('━━━ cfLoadContracts START ━━━ wallet:', wallet);

  try {
    // ── 1. Init provider & validate network ──────────────────────────────────
    const init = await cfInitProvider();
    cfLog('cfInitProvider:', init.ok ? `OK (${init.address})` : `FAIL(${init.error}): ${init.message}`);

    if (!init.ok) {
      cfState.networkOk = false;
      cfUpdateNetworkBanner(false);
      cfShowListState(init.error === 'wrong_network' ? 'wrong_network' : 'error', init.message);
      return;
    }
    cfUpdateNetworkBanner(true);
    const { factory, address } = init;

    // ── 2. Sanity check: read contractCount ───────────────────────────────────
    let totalOnChain = 0;
    try {
      totalOnChain = Number(await factory.contractCount());
      cfLog(`contractCount on-chain: ${totalOnChain} contracts exist`);
    } catch (e) {
      cfWarn('contractCount read failed:', e.message);
    }

    // ── 3. Fetch IDs via getByClient + getByContractor ────────────────────────
    let ids;
    try {
      ids = await cfFetchMyIds(address);
      cfLog(`IDs for ${address}: [${ids.join(', ')}] (${ids.length} total)`);
    } catch (e) {
      cfWarn('cfFetchMyIds failed, using cache:', e.message);
      ids = cfGetCachedIds(address) || [];
      cfLog(`IDs from cache: [${ids.join(', ')}]`);
    }

    // ── 4. Debug: if 0 IDs report state clearly ───────────────────────────────
    if (!ids.length) {
      cfLog(`🔍 No contracts found for wallet ${address}`);
      cfLog(`   contractCount = ${totalOnChain} (other wallets may have contracts)`);
      cfShowListState('empty');
      cfRenderSummary([], address);
      cfState.contracts = [];
      cfState.lastRefresh = Date.now();
      // Append debug card to empty list
      const listEl = cfEl('cf-contracts-list');
      if (listEl && totalOnChain > 0) {
        listEl.insertAdjacentHTML('beforeend', `
          <div style="background:rgba(55,138,221,0.04);border:1px dashed rgba(55,138,221,0.2);border-radius:10px;padding:10px 14px;margin-top:8px;font-size:11px;">
            <div style="color:#60b4ff;font-weight:700;margin-bottom:4px;"><i class="fas fa-info-circle mr-1"></i>Debug</div>
            <div style="color:#3a4870;">Total on-chain: <span style="color:#dde2f0;">${totalOnChain}</span></div>
            <div style="color:#3a4870;">Wallet: <span style="font-family:monospace;color:#dde2f0;">${address}</span></div>
            <div style="color:#3a4870;margin-top:2px;">No contracts for this wallet. Create one above.</div>
          </div>`);
      }
      return;
    }

    // ── 5. Fetch contract details (tuple ABI) ─────────────────────────────────
    cfLog(`Fetching ${ids.length} contracts…`);
    const settled = await Promise.allSettled(ids.map(id => cfFetchContract(factory, id)));
    const contracts = settled.map((r, i) => {
      if (r.status === 'rejected') {
        cfErr(`Contract #${ids[i]} failed:`, r.reason?.message);
        return null;
      }
      return r.value;
    }).filter(Boolean);
    cfLog(`Fetched ${contracts.length}/${ids.length} successfully`);

    // ── 6. Fetch milestones ───────────────────────────────────────────────────
    const milestones = {};
    await Promise.allSettled(contracts.map(async c => {
      try {
        milestones[c.id] = await cfFetchMilestones(factory, c.id);
        c.milestones = milestones[c.id];
      } catch (e) {
        cfWarn(`Milestones #${c.id}:`, e.message);
        c.milestones = [];
      }
    }));

    // ── 7. Update state & render ──────────────────────────────────────────────
    cfState.contracts  = contracts;
    cfState.milestones = milestones;
    cfState.lastWallet = address;
    cfState.lastRefresh = Date.now();

    // Merge with any off-chain contracts
    const offchain = cfLoadOffchainContracts().filter(o => {
      if (!address) return true; // no wallet: show all offchain contracts
      const meta = cfGetMeta(o.id);
      return meta.createdByWallet?.toLowerCase() === address.toLowerCase() ||
             (o.contractor?.toLowerCase() === address.toLowerCase());
    });
    const merged = [...contracts, ...offchain];

    // Always save full merged list so view-mode tabs can re-filter later.
    cfState._allContracts = merged;

    // Only update the visible list if the user is still on the On-Chain tab.
    // If they switched to Off-Chain or Custodial while the fetch was running,
    // do NOT overwrite their view — they will see their local data.
    if ((window._cfViewMode || 'onchain') === 'onchain') {
      cfRenderContracts(merged, address);
      cfRenderSummary(merged, address);
    }
    cfLog(`━━━ cfLoadContracts DONE: ${contracts.length} on-chain + ${offchain.length} off-chain ━━━`);
    // Dispatch event so smart-autofill can learn from contract history
    window.dispatchEvent(new CustomEvent('arcContractHistoryLoaded', { detail: { contracts: merged } }));
    // Init smart autofill
    if (typeof arcInitCfAutofill === 'function') setTimeout(arcInitCfAutofill, 300);

    // ── 8. Persist to IndexedDB (non-blocking) ────────────────────────────────
    if (typeof arcSave === 'function') {
      for (const c of contracts) {
        arcSave(window.ARC_STORE_CF || 'contracts', {
          id: 'cf_contract_' + c.id,
          contractId: String(c.id),
          type: 'contract',
          status: cfUiStatus(c).toLowerCase(),
          timestamp: new Date().toISOString(),
          wallet: address,
          network: CF_NETWORK_NAME,
          chainId: CF_CHAIN_ID,
          ...cfGetMeta(c.id),
          _onChainData: c,
        }).catch(() => {});
      }
    }

  } catch (e) {
    cfErr('cfLoadContracts UNEXPECTED error:', e.message);
    cfErr(e.stack);
    const w2 = window.walletState?.address;
    if (w2 && typeof arcLoad === 'function') {
      arcLoad(window.ARC_STORE_CF || 'contracts').then(cached => {
        const hits = (cached || []).filter(r => r._onChainData);
        if (hits.length) {
          cfRenderContracts(hits.map(r => r._onChainData), w2);
          cfRenderSummary(hits.map(r => r._onChainData), w2);
          const listEl = cfEl('cf-contracts-list');
          if (listEl) {
            const bar = document.createElement('div');
            bar.style.cssText = 'background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.2);border-radius:8px;padding:8px 12px;margin-bottom:8px;font-size:11px;color:#fbbf24;display:flex;align-items:center;gap:6px;';
            bar.innerHTML = `<i class="fas fa-database"></i> Cached data (sync failed: ${e.message}). <button onclick="cfLoadContracts({force:true})" style="margin-left:auto;background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.3);color:#fbbf24;padding:2px 10px;border-radius:6px;cursor:pointer;font-size:10px;">Retry</button>`;
            listEl.insertBefore(bar, listEl.firstChild);
          }
          return;
        }
        cfShowListState('error', e.message);
      }).catch(() => cfShowListState('error', e.message));
    } else {
      cfShowListState('error', e.message);
    }
  } finally {
    cfState.loadingIds = false;
  }
}


// ─── Summary bar (mode-aware) ──────────────────────────────────────────────────
function cfRenderSummaryForMode(contracts, wallet, viewMode) {
  const el = cfEl('cf-summary');
  if (!el) return;
  if (!contracts.length) { el.innerHTML = ''; return; }

  const vm         = viewMode || 'onchain';
  const modeColors = { onchain: '#378ADD', offchain: '#fbbf24', custodial: '#a78bfa' };
  const borderCol  = { onchain: 'rgba(55,138,221,0.15)', offchain: 'rgba(251,191,36,0.18)', custodial: 'rgba(167,139,250,0.18)' };

  const total     = contracts.length;
  const pending   = contracts.filter(c => cfUiStatus(c) === 'Pending').length;
  const funded    = contracts.filter(c => cfUiStatus(c) === 'Funded').length;
  const active    = contracts.filter(c => cfUiStatus(c) === 'Active').length;
  const completed = contracts.filter(c => cfUiStatus(c) === 'Completed').length;

  const totalUsdc = contracts.reduce((s, c) => {
    try { return s + BigInt(c.totalValue); } catch { return s; }
  }, 0n);

  el.innerHTML = `<div style="background:rgba(8,11,24,0.9);border:1px solid ${borderCol[vm]};border-radius:14px;padding:12px 16px;margin-bottom:4px;">
    <div style="display:flex;flex-wrap:wrap;gap:16px;align-items:center;">
      <div style="display:flex;flex-direction:column;">
        <span style="font-size:10px;color:#3a4870;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;">Total Value</span>
        <span style="font-size:18px;font-weight:800;color:#dde2f0;">$${cfFmtUsdc(totalUsdc)} <span style="font-size:11px;color:${modeColors[vm]};font-weight:600;">USDC</span></span>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-left:auto;">
        ${pending   ? `<span style="font-size:11px;background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.25);color:#fbbf24;padding:3px 10px;border-radius:999px;">${pending} Pending</span>` : ''}
        ${funded    ? `<span style="font-size:11px;background:rgba(96,165,250,0.12);border:1px solid rgba(96,165,250,0.25);color:#93c5fd;padding:3px 10px;border-radius:999px;">${funded} Funded</span>` : ''}
        ${active    ? `<span style="font-size:11px;background:rgba(34,211,238,0.12);border:1px solid rgba(34,211,238,0.25);color:#67e8f9;padding:3px 10px;border-radius:999px;">${active} Active</span>` : ''}
        ${completed ? `<span style="font-size:11px;background:rgba(52,211,153,0.12);border:1px solid rgba(52,211,153,0.25);color:#6ee7b7;padding:3px 10px;border-radius:999px;">${completed} Completed</span>` : ''}
        <span style="font-size:11px;background:rgba(55,138,221,0.08);border:1px solid rgba(55,138,221,0.18);color:#60b4ff;padding:3px 10px;border-radius:999px;">${total} Total</span>
      </div>
    </div>
    ${vm === 'onchain' ? `<div style="margin-top:8px;font-size:10px;color:#3a4870;">
      <a href="${CF_EXPLORER}/address/${CF_FACTORY_ADDR}" target="_blank" style="color:#378ADD;">
        <i class="fas fa-external-link-alt" style="font-size:9px;margin-right:3px;"></i>ContractFactory on ArcScan
      </a>
    </div>` : ''}
  </div>`;
}

// ─── Summary bar ──────────────────────────────────────────────────────────────
function cfRenderSummary(contracts, wallet) {
  // Only overwrite _allContracts when it is a meaningful list, or when we are
  // on the on-chain tab. Never wipe the cached local-contracts list just because
  // the on-chain data returned empty (e.g. cfWalletGateUpdate with no wallet).
  const viewMode = (window._cfViewMode) || 'onchain';
  if (contracts.length > 0 || viewMode === 'onchain') {
    cfState._allContracts = contracts;
  }
  // Filter summary to match the active view tab
  const filtered = contracts.filter(c => cfContractViewMode(c) === viewMode);
  cfRenderSummaryForMode(filtered, wallet, viewMode);
}

// ─── Helper: classify a contract by its view mode ─────────────────────────────
function cfContractViewMode(c) {
  // On-chain contracts: never have _isOffchain flag
  if (!c._isOffchain) return 'onchain';

  // Off-chain / custodial: prefer the mode stored directly on the object,
  // fall back to the meta entry (for contracts created before this fix).
  const directMode = c.mode;
  if (directMode === 'custodial') return 'custodial';
  if (directMode === 'offchain')  return 'offchain';

  // Fallback: read from meta (arc_cf_meta_v5)
  const meta = cfGetMeta(c.id);
  const m = meta.mode || 'offchain';
  return (m === 'custodial') ? 'custodial' : 'offchain';
}

// ─── Re-render using the currently selected view-mode tab ─────────────────────
function cfRenderContractsByViewMode() {
  // cfState._allContracts holds the full merged list saved during the last load
  const all    = cfState._allContracts || cfState.contracts || [];
  const wallet = cfState.lastWallet    || window.walletState?.address || null;
  const mode   = (window._cfViewMode) || 'onchain';

  // Filter to only contracts matching the active view-mode tab
  const filtered = all.filter(c => cfContractViewMode(c) === mode);

  cfRenderContractsByMode(filtered, wallet, mode);
  cfRenderSummaryForMode(filtered, wallet, mode);
}

// ─── Render contracts list (mode-aware, used by both direct calls & view tabs) ─
function cfRenderContractsByMode(contracts, wallet, viewMode) {
  const el = cfEl('cf-contracts-list');
  if (!el) return;

  const order = { Active: 0, Funded: 1, Pending: 2, Completed: 3, Cancelled: 4 };
  const sorted = [...contracts].sort((a, b) => (cfCreatedTs(b) - cfCreatedTs(a)) || (Number(b.id) - Number(a.id)));

  // Apply local dismiss filter — only hides from view, contract still on-chain
  const visible = sorted.filter(c => _cfDismiss.isVisible(String(c.id)));

  if (!visible.length) {
    const modeLabels = { onchain: 'On-Chain Escrow', offchain: 'Off-Chain Payment', custodial: 'Custodial Escrow' };
    const modeColors = { onchain: '#60b4ff', offchain: '#fbbf24', custodial: '#a78bfa' };
    const modeIcons  = { onchain: 'fa-link', offchain: 'fa-money-bill-wave', custodial: 'fa-shield-alt' };
    const vm = viewMode || 'onchain';
    el.innerHTML = `
      <div style="color:#8aaac8;font-size:12px;text-align:center;padding:40px 0;display:flex;flex-direction:column;align-items:center;gap:10px;">
        <div style="width:52px;height:52px;border-radius:14px;background:rgba(55,138,221,0.06);border:1px solid rgba(55,138,221,0.12);display:flex;align-items:center;justify-content:center;">
          <i class="fas ${modeIcons[vm]}" style="color:${modeColors[vm]};font-size:20px;"></i>
        </div>
        <span style="color:#8aaac8;">No <strong style="color:${modeColors[vm]};">${modeLabels[vm]}</strong> contracts found.</span>
        <span style="font-size:11px;color:#3a4870;">Switch mode in the form to create one, or refresh.</span>
      </div>`;
    return;
  }

  el.innerHTML = visible.map(c => cfContractCard(c, wallet)).join('');
}

// ─── Render contracts list ─────────────────────────────────────────────────────
// (public entry-point called by cfLoadContracts — delegates to mode-aware renderer)
function cfRenderContracts(contracts, wallet) {
  // Save the full merged list so view-mode tabs can re-filter without reloading.
  // Only overwrite when we have a meaningful list or we are on the on-chain tab —
  // this prevents on-chain-only calls from erasing the cached local contracts.
  const _vm = window._cfViewMode || 'onchain';
  if (contracts.length > 0 || _vm === 'onchain') {
    cfState._allContracts = contracts;
  }

  const el = cfEl('cf-contracts-list');
  if (!el) return;

  // Focused "live page" mode (opened via /contracts?focus=<id> or the Open Page
  // button). Renders only the selected contract, fully interactive. Additive:
  // only active when window.cfFocusId is set, so normal rendering is untouched.
  if (window.cfFocusId != null && String(window.cfFocusId) !== '') {
    return cfRenderFocused(el, contracts, wallet, String(window.cfFocusId));
  }

  // Determine which view-mode tab is active (default: onchain)
  const viewMode = (window._cfViewMode) || 'onchain';

  // Filter to the active tab's mode
  const filtered = contracts.filter(c => cfContractViewMode(c) === viewMode);

  const order = { Active: 0, Funded: 1, Pending: 2, Completed: 3, Cancelled: 4 };
  const sorted = [...filtered].sort((a, b) => (cfCreatedTs(b) - cfCreatedTs(a)) || (Number(b.id) - Number(a.id)));

  // Apply local dismiss filter — only hides from view, contract still on-chain
  const visible = sorted.filter(c => _cfDismiss.isVisible(String(c.id)));

  if (!visible.length) {
    const modeLabels = { onchain: 'On-Chain Escrow', offchain: 'Off-Chain Payment', custodial: 'Custodial Escrow' };
    const modeColors = { onchain: '#60b4ff', offchain: '#fbbf24', custodial: '#a78bfa' };
    const modeIcons  = { onchain: 'fa-link', offchain: 'fa-money-bill-wave', custodial: 'fa-shield-alt' };
    const vm = viewMode;
    el.innerHTML = `
      <div style="color:#8aaac8;font-size:12px;text-align:center;padding:40px 0;display:flex;flex-direction:column;align-items:center;gap:10px;">
        <div style="width:52px;height:52px;border-radius:14px;background:rgba(55,138,221,0.06);border:1px solid rgba(55,138,221,0.12);display:flex;align-items:center;justify-content:center;">
          <i class="fas ${modeIcons[vm]}" style="color:${modeColors[vm]};font-size:20px;"></i>
        </div>
        <span style="color:#8aaac8;">No <strong style="color:${modeColors[vm]};">${modeLabels[vm]}</strong> contracts found.</span>
        <span style="font-size:11px;color:#3a4870;">Switch mode in the form to create one, or refresh.</span>
      </div>`;
    return;
  }

  el.innerHTML = visible.map(c => cfContractCard(c, wallet)).join('');
}

// ─── Status badge ─────────────────────────────────────────────────────────────
function cfStatusBadge(uiStatus) {
  const colors = {
    Pending:      'cf-badge-pending',
    Funded:       'cf-badge-funded',
    Active:       'cf-badge-active',
    Completed:    'cf-badge-completed',
    Cancelled:    'cf-badge-cancelled',
    'In Dispute': 'cf-badge-dispute',
    Closed:       'cf-badge-closed',
  };
  const sm = CF_STATUS_MAP[uiStatus] || { icon: 'fa-circle', label: uiStatus };
  return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-semibold ${colors[uiStatus] || ''}">
    <i class="fas ${sm.icon} text-[9px]"></i>${sm.label}
  </span>`;
}

// ─── State progress bar ────────────────────────────────────────────────────────
function cfStateProgress(uiStatus) {
  const steps = [
    { key: 'Pending', label: 'Pending', icon: 'fa-clock' },
    { key: 'Funded',  label: 'Funded',  icon: 'fa-coins' },
    { key: 'Active',  label: 'Active',  icon: 'fa-bolt'  },
    { key: 'Completed', label: 'Completed', icon: 'fa-check-circle' },
  ];
  const order = { Pending: 0, Funded: 1, Active: 2, Completed: 3, Cancelled: -1 };
  const cur = order[uiStatus] ?? -1;

  if (uiStatus === 'Cancelled') return `<div class="flex items-center gap-2 text-xs text-red-400/70 bg-red-900/10 border border-red-800/20 rounded-lg px-3 py-1.5">
    <i class="fas fa-times-circle text-red-500"></i><span>Contract Cancelled — funds refunded</span></div>`;

  return `<div class="flex items-center gap-0 text-[10px]">
    ${steps.map((s, i) => {
      const done   = cur > i, active = cur === i;
      const dotCls = done   ? 'bg-cyan-500 border-cyan-500 text-white'
                   : active ? 'bg-purple-600 border-purple-500 text-white ring-2 ring-purple-500/30'
                   :          'bg-gray-800 border-gray-600 text-gray-500';
      const line = i < steps.length - 1 ? `<div class="flex-1 h-0.5 mb-3 ${done ? 'bg-cyan-500' : 'bg-gray-700'}"></div>` : '';
      return `<div class="flex flex-col items-center gap-1">
        <div class="w-6 h-6 rounded-full border flex items-center justify-center flex-shrink-0 ${dotCls}">
          <i class="fas ${s.icon} text-[9px]"></i></div>
        <span class="${active ? 'text-white font-semibold' : done ? 'text-cyan-400' : 'text-gray-600'} whitespace-nowrap">${s.label}</span>
      </div>${line}`;
    }).join('')}
  </div>`;
}

// ─── Presentation helpers (v6 UI refresh — no logic/data changes) ───────────────
// Deterministic wallet avatar (identicon-style). Purely visual, derived from the
// address only — introduces no new data and never alters wallet handling.
function cfAvatar(addr, size = 36) {
  const a = (addr || '0x0').toLowerCase().replace(/^0x/, '');
  let h = 0;
  for (let i = 0; i < a.length; i++) h = (h * 31 + a.charCodeAt(i)) >>> 0;
  const hue1 = h % 360;
  const hue2 = (hue1 + 120) % 360;
  const initials = (a.slice(0, 2) || '00').toUpperCase();
  return `<span class="cf-avatar" aria-hidden="true" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.34)}px;background:linear-gradient(135deg,hsl(${hue1},68%,46%),hsl(${hue2},64%,38%));">${initials}</span>`;
}

// Copy-to-clipboard with graceful fallback + accessible toast confirmation.
function cfCopy(text, label) {
  const done = () => { if (typeof showToast === 'function') showToast(((label ? label + ' ' : '') + 'copied!').trim(), 'success'); };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => cfCopyFallback(text, done));
    } else { cfCopyFallback(text, done); }
  } catch (_) { cfCopyFallback(text, done); }
}
function cfCopyFallback(text, done) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    if (typeof done === 'function') done();
  } catch (_) { /* non-critical */ }
}

// Format a millisecond timestamp (local metadata) consistently with cfTs (seconds).
function cfTsMs(ms) {
  if (!ms) return '—';
  return new Date(Number(ms)).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

// Collapsible-section state is remembered in-memory so re-renders keep the view.
window._cfCollapse = window._cfCollapse || {};
function cfToggleSection(key) {
  const body = document.getElementById('cf-sec-body-' + key);
  const btn  = document.getElementById('cf-sec-btn-' + key);
  if (!body) return;
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : '';
  window._cfCollapse[key] = isOpen ? 'closed' : 'open';
  if (btn) {
    btn.setAttribute('aria-expanded', String(!isOpen));
    const chev = btn.querySelector('.cf-chevron');
    if (chev) chev.style.transform = isOpen ? 'rotate(-90deg)' : 'rotate(0deg)';
  }
}

// Small copy-button markup (address / hash) used across the detail sections.
function cfCopyBtn(val, label) {
  const safe = String(val || '').replace(/'/g, "\\'");
  return `<button type="button" class="cf-icon-btn" title="Copy ${cfEsc(label || '')}" aria-label="Copy ${cfEsc(label || '')}" onclick="event.stopPropagation();cfCopy('${safe}','${cfEsc(label || '')}')"><i class="fas fa-copy"></i></button>`;
}
function cfExplorerBtn(path, label) {
  return `<a class="cf-icon-btn" href="${CF_EXPLORER}/${path}" target="_blank" rel="noopener" title="View ${cfEsc(label || '')} on ArcScan" aria-label="View ${cfEsc(label || '')} on ArcScan" onclick="event.stopPropagation();"><i class="fas fa-external-link-alt"></i></a>`;
}

// Section wrapper — consistent card, optional collapsible header (a11y-friendly).
function cfSection(key, title, icon, iconColor, bodyHtml, opts) {
  opts = opts || {};
  const collapsible = !!opts.collapsible;
  const defState = opts.defaultOpen === false ? 'closed' : 'open';
  const state = collapsible ? (window._cfCollapse[key] || defState) : 'open';
  const isOpen = state === 'open';
  const titleHtml = `<span class="cf-sec-title"><i class="fas ${icon}" style="color:${iconColor};"></i>${title}</span>`;
  const head = collapsible
    ? `<button type="button" id="cf-sec-btn-${key}" class="cf-sec-toggle" aria-expanded="${isOpen}" aria-controls="cf-sec-body-${key}" onclick="cfToggleSection('${key}')">${titleHtml}<i class="fas fa-chevron-down cf-chevron" style="transform:${isOpen ? 'rotate(0deg)' : 'rotate(-90deg)'};"></i></button>`
    : titleHtml;
  return `<section class="cf-sec" aria-label="${cfEsc(title)}">
    <div class="cf-sec-head">${head}${opts.right ? `<span class="cf-sec-head-actions">${opts.right}</span>` : ''}</div>
    <div class="cf-sec-body" id="cf-sec-body-${key}"${collapsible && !isOpen ? ' style="display:none;"' : ''}>${bodyHtml}</div>
  </section>`;
}

