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
// Stores: { [contractId]: { clientEmail, contractorEmail, otcPoints, otcTerms, proofs: [], completedAt, receiptData } }
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
function cfTs(ts)       { if (!ts || ts === 0) return '—'; return new Date(Number(ts) * 1000).toLocaleString('pt-BR', { dateStyle: 'medium', timeStyle: 'short' }); }
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
    catch (e) { return { ok: false, error: 'provider_init', message: 'Falha ao inicializar provider: ' + e.message }; }

    let network;
    try { network = await provider.getNetwork(); }
    catch (e) { return { ok: false, error: 'network_error', message: 'Falha ao ler rede: ' + e.message }; }

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
    return { ok: false, error: 'unexpected', message: e.message || 'Erro inesperado.' };
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
          rpcUrls: [CF_RPC],
          nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
          blockExplorerUrls: [CF_EXPLORER],
        }]});
        await new Promise(r => setTimeout(r, 1000));
        cfLoadContracts();
      } catch (e2) { showToast('Could not add Arc Testnet: ' + e2.message, 'error'); }
    } else if (e.code !== 4001) { showToast('Erro ao trocar rede: ' + e.message, 'error'); }
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
  const el = cfEl('cf-contracts-list');
  if (!el) return;
  const states = {
    no_wallet:     { icon: 'fa-wallet',       color: '#3a4870', msg: 'Conecte sua carteira para ver contratos on-chain.' },
    wrong_network: { icon: 'fa-network-wired', color: '#f59e0b', msg: message || `Troque para ${CF_NETWORK_NAME}.` },
    loading:       { icon: 'fa-spinner fa-spin', color: '#60b4ff', msg: 'Carregando contratos on-chain…' },
    empty:         { icon: 'fa-file-contract', color: '#3a4870', msg: 'Nenhum contrato encontrado. Crie um acima.' },
    error:         { icon: 'fa-exclamation-triangle', color: '#f87171', msg: message || 'Erro ao carregar contratos.' },
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
  if (!wallet) {
    cfShowListState('no_wallet');
    cfRenderSummary([], null);
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
      const meta = cfGetMeta(o.id);
      return meta.createdByWallet?.toLowerCase() === address.toLowerCase() ||
             (o.contractor?.toLowerCase() === address.toLowerCase());
    });
    const merged = [...contracts, ...offchain];

    cfRenderContracts(merged, address);
    cfRenderSummary(merged, address);
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
            bar.innerHTML = `<i class="fas fa-database"></i> Cache (sync falhou: ${e.message}). <button onclick="cfLoadContracts({force:true})" style="margin-left:auto;background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.3);color:#fbbf24;padding:2px 10px;border-radius:6px;cursor:pointer;font-size:10px;">Tentar novamente</button>`;
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

// ─── Background sync handler ──────────────────────────────────────────────────
window.addEventListener('arcSyncRequest', () => {
  if (!window.walletState?.address) return;
  const tabEl = document.getElementById('tab-content-contracts');
  if (tabEl && !tabEl.classList.contains('hidden')) {
    const age = Date.now() - cfState.lastRefresh;
    if (age > 30000) {
      cfLog('arcSyncRequest: refreshing contracts');
      cfLoadContracts();
    }
  }
});

// ─── Summary bar ──────────────────────────────────────────────────────────────
function cfRenderSummary(contracts, wallet) {
  const el = cfEl('cf-summary');
  if (!el) return;
  if (!wallet || !contracts.length) { el.innerHTML = ''; return; }

  const total     = contracts.length;
  const pending   = contracts.filter(c => cfUiStatus(c) === 'Pending').length;
  const funded    = contracts.filter(c => cfUiStatus(c) === 'Funded').length;
  const active    = contracts.filter(c => cfUiStatus(c) === 'Active').length;
  const completed = contracts.filter(c => cfUiStatus(c) === 'Completed').length;

  const totalUsdc = contracts.reduce((s, c) => {
    try { return s + BigInt(c.totalValue); } catch { return s; }
  }, 0n);

  el.innerHTML = `<div style="background:rgba(8,11,24,0.9);border:1px solid rgba(55,138,221,0.15);border-radius:14px;padding:12px 16px;margin-bottom:4px;">
    <div style="display:flex;flex-wrap:wrap;gap:16px;align-items:center;">
      <div style="display:flex;flex-direction:column;">
        <span style="font-size:10px;color:#3a4870;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;">Total Escrow</span>
        <span style="font-size:18px;font-weight:800;color:#dde2f0;">$${cfFmtUsdc(totalUsdc)} <span style="font-size:11px;color:#378ADD;font-weight:600;">USDC</span></span>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-left:auto;">
        ${pending   ? `<span style="font-size:11px;background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.25);color:#fbbf24;padding:3px 10px;border-radius:999px;">${pending} Pending</span>` : ''}
        ${funded    ? `<span style="font-size:11px;background:rgba(96,165,250,0.12);border:1px solid rgba(96,165,250,0.25);color:#93c5fd;padding:3px 10px;border-radius:999px;">${funded} Funded</span>` : ''}
        ${active    ? `<span style="font-size:11px;background:rgba(34,211,238,0.12);border:1px solid rgba(34,211,238,0.25);color:#67e8f9;padding:3px 10px;border-radius:999px;">${active} Active</span>` : ''}
        ${completed ? `<span style="font-size:11px;background:rgba(52,211,153,0.12);border:1px solid rgba(52,211,153,0.25);color:#6ee7b7;padding:3px 10px;border-radius:999px;">${completed} Completed</span>` : ''}
        <span style="font-size:11px;background:rgba(55,138,221,0.08);border:1px solid rgba(55,138,221,0.18);color:#60b4ff;padding:3px 10px;border-radius:999px;">${total} Total</span>
      </div>
    </div>
    <div style="margin-top:8px;font-size:10px;color:#3a4870;">
      <a href="${CF_EXPLORER}/address/${CF_FACTORY_ADDR}" target="_blank" style="color:#378ADD;">
        <i class="fas fa-external-link-alt" style="font-size:9px;margin-right:3px;"></i>ContractFactory on ArcScan
      </a>
    </div>
  </div>`;
}

// ─── Render contracts list ─────────────────────────────────────────────────────
function cfRenderContracts(contracts, wallet) {
  const el = cfEl('cf-contracts-list');
  if (!el) return;

  const order = { Active: 0, Funded: 1, Pending: 2, Completed: 3, Cancelled: 4 };
  const sorted = [...contracts].sort((a, b) => (order[cfUiStatus(a)] ?? 9) - (order[cfUiStatus(b)] ?? 9));

  // Apply local dismiss filter — only hides from view, contract still on-chain
  const visible = sorted.filter(c => _cfDismiss.isVisible(String(c.id)));

  if (!visible.length) {
    el.innerHTML = `
      <div style="color:#8aaac8;font-size:11px;text-align:center;padding:32px 0;">
        <i class="fas fa-file-contract" style="font-size:22px;display:block;margin-bottom:8px;color:#3a4870;"></i>
        No contracts in local view. Refresh to reload from chain.
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

// ─── Contract card ─────────────────────────────────────────────────────────────
function cfContractCard(c, wallet) {
  const uiStatus  = cfUiStatus(c);
  const isClient  = c.client?.toLowerCase()     === wallet?.toLowerCase();
  const isContr   = c.contractor?.toLowerCase() === wallet?.toLowerCase();
  const isParticipant = isClient || isContr;
  const role      = isClient ? 'Payer (Client)' : isContr ? 'Receiver (Contractor)' : 'Observer';
  const roleColor = isClient ? '#60b4ff' : isContr ? '#34d399' : '#6b7280';

  const total     = BigInt(c.totalValue);
  const deposited = BigInt(c.depositedValue);
  const pct       = total > 0n ? Math.min(100, Math.round(Number(deposited * 100n / total))) : 0;
  const feeRaw    = cfCalcFee(total);
  const netRaw    = cfNetAmount(total);

  const milestones  = c.milestones || [];
  const releasedAmt = milestones.filter(m => m.status === 'Released').reduce((s, m) => s + BigInt(m.amount), 0n);

  const meta        = cfGetMeta(c.id);
  const proofs      = meta.proofs || [];
  const proofStat   = cfProofStatus(meta);
  const hasProofs   = proofStat !== 'none';
  const isCommitted = proofStat === 'committed';
  const mode        = meta.mode || 'onchain';
  const modeInfo    = CF_MODES[mode] || CF_MODES.onchain;
  const isClosed    = !!meta.contractClosed;
  const dispute     = cfGetDispute(c.id);
  const disputeStat = cfGetDisputeStatus(c.id);
  const isInDispute = disputeStat === 'open';

  // ── Action buttons ─────────────────────────────────────────────────────────
  let actionBtns = '';

  // Closed contracts: no actions at all
  if (isClosed) {
    actionBtns = `<span style="font-size:11px;color:#3a4870;display:flex;align-items:center;gap:5px;padding:6px 10px;background:rgba(74,85,104,0.1);border:1px solid rgba(74,85,104,0.2);border-radius:8px;">
      <i class="fas fa-lock" style="color:#4a5568;"></i>${t("contracts_contrato_encerrado")}
    </span>`;
  } else if (isInDispute) {
    // During active dispute: only resolution options for participants
    actionBtns = `<span style="font-size:11px;color:#f87171;display:flex;align-items:center;gap:5px;padding:6px 10px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:8px;flex-wrap:wrap;gap:8px;">
      <i class="fas fa-gavel"></i>Fundos bloqueados — disputa ativa
    </span>`;
    if (isParticipant)
      actionBtns += `<button onclick="cfShowDisputeResolution(${c.id})" class="cf-action-btn" style="background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.3);color:#f87171;">
        <i class="fas fa-balance-scale mr-1.5"></i>Resolver Disputa
      </button>`;
  } else {
    if (mode === 'onchain') {
      if ((uiStatus === 'Funded' || uiStatus === 'Pending') && isContr && !c.contractorSigned)
        actionBtns += `<button onclick="cfSignContract(${c.id})" class="cf-action-btn cf-btn-sign"><i class="fas fa-pen-nib mr-1.5"></i>Sign Contract</button>`;
      if (uiStatus === 'Active' && isContr)
        actionBtns += `<button onclick="cfShowProofUpload(${c.id})" class="cf-action-btn cf-btn-proof"><i class="fas fa-upload mr-1.5"></i>Upload Proof</button>`;
      if (uiStatus === 'Active' && isClient) {
        const proofLabel = proofStat === 'none' ? 'No proof yet' : proofStat === 'uploaded' ? 'Proof uploaded — commit first' : 'Proof committed ✓';
        const canComplete = isCommitted;
        actionBtns += `<button onclick="${canComplete ? `cfMarkComplete(${c.id})` : `showToast('${proofStat === "none" ? "Contractor must upload proof first." : "Proof must be committed before completion."}','warning')`}"
          class="cf-action-btn ${canComplete ? 'cf-btn-complete' : 'cf-btn-disabled'}"
          title="${proofLabel}">
          <i class="fas fa-flag-checkered mr-1.5"></i>Mark Complete
          ${!canComplete ? `<span style="font-size:9px;opacity:0.6;">(${proofStat === 'none' ? 'need proof' : 'commit first'})</span>` : ''}
        </button>`;
      }
      if ((uiStatus === 'Pending' || uiStatus === 'Funded' || uiStatus === 'Draft') && isClient)
        actionBtns += `<button onclick="cfCancelContract(${c.id})" class="cf-action-btn cf-btn-cancel"><i class="fas fa-times mr-1.5"></i>Cancel</button>`;
    } else {
      if (isContr)
        actionBtns += `<button onclick="cfShowProofUpload(${c.id})" class="cf-action-btn cf-btn-proof"><i class="fas fa-upload mr-1.5"></i>Upload Proof</button>`;
      if (isClient && hasProofs && !isCommitted)
        actionBtns += `<button onclick="cfCommitProof(${c.id})" class="cf-action-btn cf-btn-sign" style="background:rgba(52,211,153,0.15);border-color:rgba(52,211,153,0.4);color:#34d399;"><i class="fas fa-stamp mr-1.5"></i>Commit Proof</button>`;
      if (isClient && (meta.offchainStatus !== 'confirmed' && meta.offchainStatus !== 'disputed'))
        actionBtns += `<button onclick="cfShowOffchainActions(${c.id})" class="cf-action-btn cf-btn-receipt"><i class="fas fa-tasks mr-1.5"></i>Update Status</button>`;
    }

    // Open Dispute button — available to both parties when active/funded (not closed, not already disputed)
    if (isParticipant && (uiStatus === 'Active' || uiStatus === 'Funded' || hasProofs) && !isClosed)
      actionBtns += `<button onclick="cfShowOpenDispute(${c.id})" class="cf-action-btn" style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);color:#f87171;">
        <i class="fas fa-gavel mr-1.5"></i>Abrir Disputa
      </button>`;

    // Wallet-link
    if (uiStatus === 'Active' || uiStatus === 'Funded')
      actionBtns += `<button onclick="cfShowWalletLink(${c.id})" class="cf-action-btn" style="background:rgba(96,180,255,0.06);border:1px solid rgba(96,180,255,0.2);color:#60b4ff;"><i class="fas fa-qrcode mr-1.5"></i>Share Link</button>`;

    // View Receipt
    if (uiStatus === 'Completed' || (mode !== 'onchain' && isCommitted))
      actionBtns += `<button onclick="cfOpenReceipt(${c.id})" class="cf-action-btn cf-btn-receipt"><i class="fas fa-eye mr-1.5"></i>View Receipt</button>`;

    // View On-Chain Proofs — always available for any participant or observer
    actionBtns += `<button onclick="cfViewOnChainProofs(${c.id})" class="cf-action-btn" style="background:rgba(16,185,129,0.09);border:1px solid rgba(16,185,129,0.28);color:#34d399;">
      <i class="fas fa-search-plus mr-1.5"></i>View Proofs
    </button>`;

    // Close Contract — only when Completed and participant, dispute resolved or none
    if ((uiStatus === 'Completed' || disputeStat === 'resolved') && isParticipant && !isClosed)
      actionBtns += `<button onclick="cfCloseContract(${c.id})" class="cf-action-btn" style="background:rgba(74,85,104,0.12);border:1px solid rgba(74,85,104,0.3);color:#9ca3af;">
        <i class="fas fa-lock mr-1.5"></i>Encerrar Contrato
      </button>`;
  }

  // ── Proof status badge ─────────────────────────────────────────────────────
  const ps = CF_PROOF_STATUS[proofStat];
  const proofBadge = `<span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:600;
    background:rgba(${proofStat==='committed'?'52,211,153':proofStat==='uploaded'?'251,191,36':'74,85,104'},0.12);
    border:1px solid rgba(${proofStat==='committed'?'52,211,153':proofStat==='uploaded'?'251,191,36':'74,85,104'},0.3);
    color:${ps.color};padding:1px 8px;border-radius:999px;">
    <i class="fas ${ps.icon}" style="font-size:8px;"></i>${ps.label}
  </span>`;

  // ── Mode badge ─────────────────────────────────────────────────────────────
  const modeBadge = `<span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:600;
    background:rgba(55,138,221,0.06);border:1px solid rgba(55,138,221,0.15);
    color:${modeInfo.color};padding:1px 8px;border-radius:999px;">
    <i class="fas ${modeInfo.icon}" style="font-size:8px;"></i>${modeInfo.label}
  </span>`;

  // ── Milestones ─────────────────────────────────────────────────────────────
  const msHtml = milestones.length ? `
    <div style="margin-top:10px;">
      <p style="font-size:10px;color:#3a4870;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;margin-bottom:6px;">Milestones</p>
      ${milestones.map((m, i) => `
        <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid rgba(55,138,221,0.06);">
          <div style="width:18px;height:18px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:8px;
            ${m.status==='Released'?'background:rgba(52,211,153,0.2);border:1px solid rgba(52,211,153,0.4);color:#34d399':'background:rgba(55,138,221,0.1);border:1px solid rgba(55,138,221,0.2);color:#60b4ff'}">
            <i class="fas ${m.status==='Released'?'fa-check':'fa-clock'}"></i>
          </div>
          <span style="flex:1;font-size:12px;color:#8899bb;">${m.description}</span>
          <span style="font-size:11px;font-weight:700;color:${m.status==='Released'?'#34d399':'#60b4ff'};">$${cfFmtUsdc(m.amount)}</span>
          ${uiStatus==='Active'&&isClient&&m.status==='Pending'&&mode==='onchain'&&!isInDispute&&!isClosed
            ? `<button onclick="cfReleaseMilestone(${c.id},${i})" style="font-size:10px;background:rgba(52,211,153,0.12);border:1px solid rgba(52,211,153,0.25);color:#34d399;padding:2px 8px;border-radius:6px;cursor:pointer;">Release</button>`
            : isInDispute && m.status==='Pending'
              ? `<span style="font-size:10px;color:#f87171;" title="Fundos bloqueados por disputa"><i class="fas fa-lock mr-1"></i>Bloqueado</span>`
              : `<span style="font-size:10px;color:${m.status==='Released'?'#34d399':'#3a4870'};">${m.status}</span>`}
        </div>`).join('')}
    </div>` : '';

  // ── Proofs section ─────────────────────────────────────────────────────────
  const proofsHtml = `
    <div style="margin-top:8px;">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
        <p style="font-size:10px;color:#3a4870;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;flex:1;">Proof of Work</p>
        ${proofBadge}
        ${(uiStatus==='Active'||mode!=='onchain') && isContr
          ? `<button onclick="cfShowProofUpload(${c.id})" style="font-size:10px;color:#a78bfa;background:rgba(167,139,250,0.08);border:1px solid rgba(167,139,250,0.2);padding:2px 8px;border-radius:6px;cursor:pointer;"><i class="fas fa-upload mr-1"></i>Add</button>` : ''}
      </div>
      ${proofs.length ? proofs.map((p, pi) => `
        <div style="display:flex;align-items:center;gap:6px;padding:5px 8px;background:rgba(167,139,250,0.04);border:1px solid rgba(167,139,250,${p.committed?'0.3':'0.1'});border-radius:8px;margin-bottom:4px;">
          <i class="fas ${p.type==='image'?'fa-image':p.type==='pdf'?'fa-file-pdf':'fa-file'}" style="color:${p.committed?'#34d399':'#a78bfa'};font-size:12px;flex-shrink:0;"></i>
          <span style="flex:1;font-size:11px;color:#8899bb;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${p.name}">${p.name}</span>
          ${p.committed ? `<span style="font-size:9px;color:#34d399;flex-shrink:0;"><i class="fas fa-lock mr-1"></i>Committed</span>` : `<span style="font-size:9px;color:#fbbf24;flex-shrink:0;"><i class="fas fa-clock mr-1"></i>Pending</span>`}
          <button onclick="cfViewProof(${c.id},${pi})" style="font-size:10px;color:#a78bfa;background:rgba(167,139,250,0.08);border:1px solid rgba(167,139,250,0.18);padding:2px 8px;border-radius:6px;cursor:pointer;flex-shrink:0;"><i class="fas fa-eye mr-1"></i>Ver</button>
          ${p.hash ? `<span style="font-size:9px;color:#3a4870;font-family:monospace;" title="SHA-256: ${p.hash}">${p.hash.slice(0,8)}…</span>` : ''}
          ${isContr && !p.committed ? `<button onclick="cfDeleteProof(${c.id},${pi})" title="Delete proof" style="font-size:10px;color:#f87171;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.22);padding:2px 7px;border-radius:6px;cursor:pointer;flex-shrink:0;"><i class="fas fa-trash-alt"></i></button>` : ''}
        </div>`).join('')
        : `<p style="font-size:11px;color:#252a40;font-style:italic;padding:4px 0;">${t("cf_no_proof_submitted_yet")}</p>`}
      ${proofs.length > 0 && !isCommitted && isClient ? `
        <button onclick="cfCommitProof(${c.id})" style="width:100%;margin-top:6px;padding:7px;background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.3);color:#34d399;border-radius:8px;font-size:11px;font-weight:700;cursor:pointer;">
          <i class="fas fa-stamp mr-1.5"></i>Commit Proof — Lock & Verify
        </button>` : ''}
    </div>`;

  // ── Off-chain fields ────────────────────────────────────────────────────────
  const offchainHtml = mode !== 'onchain' ? `
    <div style="margin-top:8px;padding:8px 10px;background:rgba(${mode==='custodial'?'167,139,250':'251,191,36'},0.06);border:1px solid rgba(${mode==='custodial'?'167,139,250':'251,191,36'},0.2);border-radius:10px;">
      <div style="font-size:10px;font-weight:700;color:${modeInfo.color};text-transform:uppercase;margin-bottom:4px;"><i class="fas ${modeInfo.icon} mr-1"></i>${modeInfo.label}</div>
      ${meta.paymentNote ? `<div style="font-size:11px;color:#8899bb;margin-bottom:4px;"><i class="fas fa-sticky-note mr-1" style="color:#fbbf24;"></i>${meta.paymentNote}</div>` : ''}
      ${meta.escrowRef ? `<div style="font-size:11px;color:#8899bb;"><i class="fas fa-shield-alt mr-1" style="color:#a78bfa;"></i>Escrow Ref: <span style="font-family:monospace;">${meta.escrowRef}</span></div>` : ''}
      ${meta.offchainStatus ? `<div style="margin-top:4px;font-size:11px;font-weight:600;color:${meta.offchainStatus==='confirmed'?'#34d399':meta.offchainStatus==='disputed'?'#f87171':'#fbbf24'};">
        Status: ${meta.offchainStatus.toUpperCase()}</div>` : ''}
    </div>` : '';

  // ── Dispute section ────────────────────────────────────────────────────────
  const disputeHtml = dispute ? (() => {
    const ds = CF_DISPUTE_STATUS[dispute.status] || CF_DISPUTE_STATUS.none;
    const evidences = dispute.evidence || [];
    const resolutionHtml = dispute.resolution ? `
      <div style="margin-top:8px;padding:7px 10px;background:rgba(52,211,153,0.06);border:1px solid rgba(52,211,153,0.2);border-radius:8px;">
        <div style="font-size:10px;font-weight:700;color:#34d399;margin-bottom:4px;"><i class="fas fa-check-circle mr-1"></i>${t("cf_resolution_label")}</div>
        <div style="font-size:11px;color:#8899bb;">${dispute.resolution.outcome === 'contractor' ? t('cf_resolution_contractor') : dispute.resolution.outcome === 'client' ? t('cf_resolution_client') : t('cf_resolution_mutual')}</div>
        <div style="font-size:10px;color:#3a4870;margin-top:3px;">${new Date(dispute.resolution.resolvedAt).toLocaleString('pt-BR')}</div>
        ${dispute.resolution.note ? `<div style="font-size:11px;color:#6b7280;margin-top:3px;font-style:italic;">"${dispute.resolution.note}"</div>` : ''}
      </div>` : '';
    const approvalHtml = dispute.status === 'open' && dispute.mutualApproval ? (() => {
      const approvals = dispute.mutualApproval || {};
      const clientApproved = approvals[c.client?.toLowerCase()];
      const contrApproved  = approvals[c.contractor?.toLowerCase()];
      return `
        <div style="margin-top:6px;padding:6px 10px;background:rgba(251,191,36,0.06);border:1px solid rgba(251,191,36,0.2);border-radius:8px;font-size:11px;color:#fbbf24;">
          <i class="fas fa-handshake mr-1"></i>${t("cf_mutual_agreement_ongoing")}
          <span style="color:${clientApproved?'#34d399':'#4a5568'};margin-left:6px;"><i class="fas fa-${clientApproved?'check':'times'}-circle mr-1"></i>Cliente</span>
          <span style="color:${contrApproved?'#34d399':'#4a5568'};margin-left:6px;"><i class="fas fa-${contrApproved?'check':'times'}-circle mr-1"></i>Contratado</span>
        </div>`;
    })() : '';
    return `
    <div style="margin-top:8px;padding:10px 12px;background:rgba(${ds.bg},0.06);border:1px solid rgba(${ds.bg},0.25);border-radius:10px;">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
        <i class="fas ${ds.icon}" style="color:${ds.color};"></i>
        <span style="font-size:11px;font-weight:800;color:${ds.color};text-transform:uppercase;letter-spacing:0.05em;">${ds.label}</span>
        <span style="font-size:10px;color:#3a4870;margin-left:auto;">${new Date(dispute.openedAt).toLocaleString('pt-BR')}</span>
      </div>
      <div style="font-size:12px;color:#dde2f0;margin-bottom:6px;font-weight:600;">"${dispute.reason}"</div>
      <div style="font-size:10px;color:#4a6490;margin-bottom:6px;">
        <i class="fas fa-user mr-1"></i>Aberto por: <span style="font-family:monospace;">${cfShort(dispute.openedBy)}</span>
        ${dispute.openedBy?.toLowerCase() === c.client?.toLowerCase() ? ' (Cliente)' : ' (Contratado)'}
      </div>
      ${evidences.length ? `
        <div style="font-size:10px;color:#3a4870;text-transform:uppercase;font-weight:700;margin-bottom:4px;">${t("cf_evidences_label", evidences.length)}</div>
        ${evidences.map((ev, ei) => `
          <div style="display:flex;align-items:center;gap:6px;padding:4px 6px;background:rgba(239,68,68,0.04);border:1px solid rgba(239,68,68,0.12);border-radius:6px;margin-bottom:3px;">
            <i class="fas ${ev.type==='image'?'fa-image':ev.type==='pdf'?'fa-file-pdf':'fa-file'}" style="color:#f87171;font-size:11px;"></i>
            <span style="flex:1;font-size:10px;color:#8899bb;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${ev.name}</span>
            <button onclick="cfViewDisputeEvidence(${c.id},${ei})" style="font-size:9px;color:#f87171;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.18);padding:2px 6px;border-radius:4px;cursor:pointer;">Ver</button>
          </div>`).join('')}` : ''}
      ${approvalHtml}
      ${resolutionHtml}
    </div>`;
  })() : '';

  // ── Closed banner ──────────────────────────────────────────────────────────
  const closedHtml = isClosed ? `
    <div style="margin-top:8px;padding:10px 12px;background:rgba(74,85,104,0.1);border:1px solid rgba(74,85,104,0.25);border-radius:10px;">
      <div style="display:flex;align-items:center;gap:6px;">
        <i class="fas fa-lock" style="color:#6b7280;"></i>
        <span style="font-size:11px;font-weight:700;color:#9ca3af;">Contrato Encerrado</span>
        <span style="font-size:10px;color:#3a4870;margin-left:auto;">${new Date(meta.closedAt || 0).toLocaleString('pt-BR')}</span>
      </div>
      <div style="font-size:10px;color:#4a5568;margin-top:4px;">Encerrado por: <span style="font-family:monospace;">${cfShort(meta.closedBy)}</span></div>
      <div style="font-size:10px;color:#3a4870;margin-top:2px;">Todas as interações foram bloqueadas permanentemente.</div>
    </div>` : '';

  // ── Meta info ──────────────────────────────────────────────────────────────
  const metaHtml = (meta.clientEmail || meta.contractorEmail || meta.otcPoints) ? `
    <div style="margin-top:8px;padding:8px;background:rgba(55,138,221,0.04);border:1px solid rgba(55,138,221,0.1);border-radius:10px;">
      ${meta.clientEmail ? `<div style="font-size:11px;color:#4a6490;"><i class="fas fa-envelope mr-1" style="color:#60b4ff;"></i>Client: ${meta.clientEmail}</div>` : ''}
      ${meta.contractorEmail ? `<div style="font-size:11px;color:#4a6490;"><i class="fas fa-envelope mr-1" style="color:#34d399;"></i>Contractor: ${meta.contractorEmail}</div>` : ''}
      ${meta.otcPoints ? `<div style="font-size:11px;color:#c4b5fd;margin-top:4px;"><i class="fas fa-handshake mr-1" style="color:#a78bfa;"></i>OTC: ${meta.otcPoints}</div>` : ''}
      ${meta.otcTerms ? `<div style="font-size:10px;color:#4a3a7a;margin-top:2px;">${meta.otcTerms}</div>` : ''}
    </div>` : '';

  return `
  <div class="cf-card mb-4" id="cf-contract-${c.id}" style="overflow:hidden;">
    <div style="padding:14px 16px 0;">
      <!-- Header row -->
      <div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:10px;">
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            <span style="font-size:13px;font-weight:800;color:#dde2f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px;" title="${c.title||''}">${c.title || 'Untitled'}</span>
            <span style="font-size:10px;color:#3a4870;font-family:monospace;">#${c.id}</span>
            ${cfStatusBadge(uiStatus)}
            ${isInDispute ? `<span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:700;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.35);color:#f87171;padding:1px 8px;border-radius:999px;"><i class="fas fa-gavel" style="font-size:8px;"></i>Em Disputa</span>` : ''}
            ${isClosed ? `<span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:700;background:rgba(74,85,104,0.15);border:1px solid rgba(74,85,104,0.3);color:#9ca3af;padding:1px 8px;border-radius:999px;"><i class="fas fa-lock" style="font-size:8px;"></i>Encerrado</span>` : ''}
          </div>
          <div style="display:flex;gap:5px;margin-top:5px;flex-wrap:wrap;">
            <span style="font-size:10px;font-weight:600;background:rgba(55,138,221,0.08);border:1px solid rgba(55,138,221,0.15);color:${roleColor};padding:1px 8px;border-radius:999px;">${role}</span>
            ${modeBadge}
          </div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0;">
          <div style="text-align:right;">
            <div style="font-size:18px;font-weight:800;color:#dde2f0;">$${cfFmtUsdc(total)}</div>
            <div style="font-size:10px;color:#3a4870;">USDC · 0.2% fee</div>
            <div style="font-size:10px;color:#4a6490;">Net: $${cfFmtUsdc(netRaw)}</div>
          </div>
          <!-- ✕ Persistent hide — contract still exists on-chain, only hidden from view -->
          <button class="arc-dismiss-btn"
            onclick="event.stopPropagation();arcAnimatedDismiss('cf-contract-${c.id}',function(){if(typeof arcHideContract==='function')arcHideContract('${c.id}');cfRenderContracts(cfState.contracts,window.walletState?.address);})"
            title="Hide from view — on-chain contracts cannot be deleted, only hidden">✕</button>
        </div>
      </div>

      <!-- Escrow bar (only for on-chain) -->
      ${mode === 'onchain' ? `
      <div style="margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;font-size:10px;color:#3a4870;margin-bottom:4px;">
          <span>Escrow: $${cfFmtUsdc(deposited)} / $${cfFmtUsdc(total)}</span>
          <span>${pct}% funded</span>
        </div>
        <div style="height:4px;background:rgba(55,138,221,0.1);border-radius:4px;overflow:hidden;">
          <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#378ADD,#1D9E75);border-radius:4px;transition:width 0.5s;"></div>
        </div>
      </div>` : ''}

      <!-- Parties -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">
        <div style="background:rgba(55,138,221,0.04);border:1px solid rgba(55,138,221,0.1);border-radius:10px;padding:8px;">
          <p style="font-size:9px;color:#3a4870;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;margin-bottom:3px;">Client</p>
          <a href="${CF_EXPLORER}/address/${c.client}" target="_blank" style="font-size:11px;font-family:monospace;color:#60b4ff;">${cfShort(c.client)}</a>
        </div>
        <div style="background:rgba(29,158,117,0.04);border:1px solid rgba(29,158,117,0.1);border-radius:10px;padding:8px;">
          <p style="font-size:9px;color:#3a4870;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;margin-bottom:3px;">Contractor</p>
          <a href="${CF_EXPLORER}/address/${c.contractor}" target="_blank" style="font-size:11px;font-family:monospace;color:#34d399;">${cfShort(c.contractor)}</a>
        </div>
      </div>

      <!-- Fee breakdown (on-chain only) -->
      ${mode === 'onchain' ? `
      <div style="display:flex;gap:8px;margin-bottom:10px;font-size:10px;">
        <div style="flex:1;background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.15);border-radius:8px;padding:6px 10px;">
          <div style="color:#6b7280;">Platform Fee (0.2%)</div>
          <div style="color:#fbbf24;font-weight:700;">$${cfFmtUsdc(feeRaw)} USDC</div>
        </div>
        <div style="flex:1;background:rgba(52,211,153,0.06);border:1px solid rgba(52,211,153,0.15);border-radius:8px;padding:6px 10px;">
          <div style="color:#6b7280;">Net to Contractor</div>
          <div style="color:#34d399;font-weight:700;">$${cfFmtUsdc(netRaw)} USDC</div>
        </div>
      </div>` : ''}

      ${offchainHtml}
      ${metaHtml}
      ${msHtml}
      ${proofsHtml}
      ${disputeHtml}
      ${closedHtml}

      <!-- State progress -->
      <div style="margin:10px 0;">${cfStateProgress(uiStatus)}</div>

      <!-- Timestamps -->
      <div style="font-size:10px;color:#252a40;margin-bottom:6px;">
        Created: ${cfTs(c.createdAt)}
        ${c.startedAt ? ` · Started: ${cfTs(c.startedAt)}` : ''}
        ${c.completedAt ? ` · Completed: ${cfTs(c.completedAt)}` : ''}
        ${mode==='onchain' ? ` · <a href="${CF_EXPLORER}/address/${CF_FACTORY_ADDR}" target="_blank" style="color:#3a5a8a;">ArcScan ↗</a>` : ''}
      </div>
      <!-- Local-only disclaimer -->
      <p style="font-size:9px;color:#2a4030;margin:0 0 6px;line-height:1.3;">
        <i class="fas fa-info-circle" style="margin-right:3px;"></i>Local only — contract still exists on-chain
      </p>
    </div>
    ${actionBtns ? `<div style="padding:10px 16px 14px;display:flex;gap:6px;flex-wrap:wrap;border-top:1px solid rgba(55,138,221,0.08);">${actionBtns}</div>` : ''}
  </div>`;
}


// ─── Proof-of-Work Upload Modal ────────────────────────────────────────────────
// Allows contractor (or anyone on the contract) to upload proof files.
// Files are stored as base64 data URLs locally (localStorage via cfSetMeta).
// A SHA-256 fingerprint is computed for each file to prevent tampering.
// After upload, the client must "Commit Proof" to lock it.
function cfShowProofUpload(contractId) {
  document.getElementById('cf-proof-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'cf-proof-modal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm';
  modal.innerHTML = `
  <div style="background:#0a0c18;border:1px solid rgba(167,139,250,0.3);border-radius:20px;width:100%;max-width:500px;padding:24px;box-shadow:0 0 40px rgba(167,139,250,0.15);max-height:90vh;overflow-y:auto;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;">
      <h3 style="color:#dde2f0;font-size:15px;font-weight:800;display:flex;align-items:center;gap:8px;">
        <i class="fas fa-upload" style="color:#a78bfa;"></i>Upload Proof of Work — #${contractId}
      </h3>
      <button onclick="document.getElementById('cf-proof-modal').remove()"
        style="width:28px;height:28px;border-radius:8px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#6b7280;cursor:pointer;display:flex;align-items:center;justify-content:center;">
        <i class="fas fa-times text-xs"></i>
      </button>
    </div>

    <div style="background:rgba(167,139,250,0.06);border:1px solid rgba(167,139,250,0.15);border-radius:10px;padding:10px 14px;margin-bottom:14px;font-size:11px;color:#a78bfa;">
      <i class="fas fa-info-circle mr-1"></i>
      ${t("cf_upload_proof_desc")}
      <strong>${t("cf_upload_proof_commit_hint")}</strong>
    </div>

    <!-- Drop zone -->
    <div id="cf-proof-drop"
      style="border:2px dashed rgba(167,139,250,0.3);border-radius:14px;padding:28px;text-align:center;cursor:pointer;margin-bottom:14px;transition:all 0.2s;"
      onclick="document.getElementById('cf-proof-file-input').click()"
      ondragover="event.preventDefault();this.style.borderColor='#a78bfa';this.style.background='rgba(167,139,250,0.08)'"
      ondragleave="this.style.borderColor='rgba(167,139,250,0.3)';this.style.background=''"
      ondrop="cfHandleProofDrop(event,${contractId})">
      <i class="fas fa-cloud-upload-alt" style="font-size:28px;color:#a78bfa;margin-bottom:8px;display:block;"></i>
      <p style="color:#dde2f0;font-size:13px;font-weight:600;margin-bottom:4px;">Arraste arquivos ou clique para selecionar</p>
      <p style="color:#4a3a7a;font-size:11px;">${t("cf_file_types_hint")}</p>
    </div>
    <input type="file" id="cf-proof-file-input" multiple accept="image/*,.pdf,.doc,.docx"
      style="display:none;" onchange="cfHandleProofFiles(event,${contractId})">

    <!-- Preview list -->
    <div id="cf-proof-preview-list" style="margin-bottom:14px;"></div>

    <!-- Upload status -->
    <div id="cf-proof-status" style="display:none;margin-bottom:12px;padding:10px 14px;border-radius:10px;font-size:12px;"></div>

    <div style="display:flex;gap:10px;">
      <button onclick="cfExecuteProofUpload(${contractId})" id="cf-proof-upload-btn"
        style="flex:1;background:linear-gradient(135deg,#6d28d9,#5b21b6);color:#fff;border:none;border-radius:12px;padding:11px;font-size:13px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;">
        <i class="fas fa-cloud-upload-alt"></i>Upload & Gerar Hash
      </button>
      <button onclick="document.getElementById('cf-proof-modal').remove()"
        style="padding:11px 18px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);color:#6b7280;border-radius:12px;cursor:pointer;font-size:13px;">
        Cancelar
      </button>
    </div>
    <p style="font-size:10px;color:#3a4870;margin-top:10px;text-align:center;">
      <i class="fas fa-shield-alt mr-1"></i>${t("cf_hash_generated_locally")}
    </p>
  </div>`;
  document.body.appendChild(modal);
  window._cfProofFiles = [];
}

function cfHandleProofDrop(event, contractId) {
  event.preventDefault();
  document.getElementById('cf-proof-drop').style.borderColor = 'rgba(167,139,250,0.3)';
  document.getElementById('cf-proof-drop').style.background  = '';
  cfHandleProofFilesRaw(Array.from(event.dataTransfer.files), contractId);
}
function cfHandleProofFiles(event, contractId) {
  cfHandleProofFilesRaw(Array.from(event.target.files), contractId);
}
function cfHandleProofFilesRaw(files, contractId) {
  if (!window._cfProofFiles) window._cfProofFiles = [];
  const MAX = 10 * 1024 * 1024;
  files.forEach(f => {
    if (f.size > MAX) { showToast(`${f.name} excede 10MB.`, 'error'); return; }
    if (window._cfProofFiles.length >= 5) { showToast('Max 5 files at a time.', 'warning'); return; }
    const dup = window._cfProofFiles.find(x => x.name === f.name && x.size === f.size);
    if (dup) { showToast(`${f.name} already added.`, 'warning'); return; }
    window._cfProofFiles.push(f);
  });
  cfRenderProofPreview();
}
function cfRenderProofPreview() {
  const el = document.getElementById('cf-proof-preview-list');
  if (!el) return;
  const files = window._cfProofFiles || [];
  if (!files.length) { el.innerHTML = ''; return; }
  el.innerHTML = files.map((f, i) => {
    const icon = f.type.startsWith('image') ? 'fa-image' : f.type === 'application/pdf' ? 'fa-file-pdf' : 'fa-file-word';
    return `<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;background:rgba(167,139,250,0.06);border:1px solid rgba(167,139,250,0.15);border-radius:8px;margin-bottom:6px;">
      <i class="fas ${icon}" style="color:#a78bfa;font-size:14px;flex-shrink:0;"></i>
      <div style="flex:1;min-width:0;">
        <div style="font-size:12px;color:#8899bb;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${f.name}</div>
        <div style="font-size:10px;color:#4a3a7a;">${(f.size/1024).toFixed(0)} KB · ${f.type || 'unknown'}</div>
      </div>
      <button onclick="window._cfProofFiles.splice(${i},1);cfRenderProofPreview()"
        style="width:22px;height:22px;border-radius:4px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);color:#f87171;cursor:pointer;font-size:9px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
        <i class="fas fa-times"></i>
      </button>
    </div>`;
  }).join('');
}

// Compute SHA-256 hash of file ArrayBuffer
async function cfHashFile(file) {
  try {
    const buf    = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

// Execute proof upload — stores files as base64 + SHA-256 hash
async function cfExecuteProofUpload(contractId) {
  const files = window._cfProofFiles || [];
  if (!files.length) { showToast('Selecione pelo menos um arquivo.', 'warning'); return; }

  const btn    = document.getElementById('cf-proof-upload-btn');
  const status = document.getElementById('cf-proof-status');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Processando…'; }
  if (status) {
    status.style.display = 'block';
    status.style.cssText += ';background:rgba(55,138,221,0.08);border:1px solid rgba(55,138,221,0.2);color:#60b4ff;';
    status.textContent = 'Gerando hashes e armazenando arquivos…';
  }

  const uploaded = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      if (status) status.textContent = `[${i+1}/${files.length}] Processando: ${file.name}…`;

      // Compute SHA-256 fingerprint
      const hash = await cfHashFile(file);

      // Store as base64 data URL (secure local storage, no external dependency)
      const url = await new Promise((res, rej) => {
        const reader = new FileReader();
        reader.onload  = e => res(e.target.result);
        reader.onerror = rej;
        reader.readAsDataURL(file);
      });

      const type = file.type.startsWith('image') ? 'image' : file.type === 'application/pdf' ? 'pdf' : 'doc';
      uploaded.push({
        name:       file.name,
        url,
        type,
        hash:       hash || 'no-crypto',
        size:       file.size,
        mimeType:   file.type,
        uploadedAt: Date.now(),
        committed:  false,  // must be explicitly committed by client
      });
      cfLog(`Proof uploaded: ${file.name} | SHA-256: ${hash?.slice(0,16)}…`);
    } catch (e) {
      cfErr(`Proof upload error (${file.name}):`, e.message);
      showToast(`Erro ao processar ${file.name}: ${e.message}`, 'error');
    }
  }

  if (uploaded.length) {
    const existing = cfGetMeta(contractId).proofs || [];
    // Check for duplicate hashes
    const newProofs = uploaded.filter(u => !existing.some(e => e.hash === u.hash));
    const dupes     = uploaded.length - newProofs.length;
    if (dupes > 0) showToast(`${dupes} arquivo(s) duplicado(s) ignorado(s).`, 'warning');

    cfSetMeta(contractId, { proofs: [...existing, ...newProofs] });
    if (status) {
      status.style.background = 'rgba(52,211,153,0.08)';
      status.style.border     = '1px solid rgba(52,211,153,0.2)';
      status.style.color      = '#34d399';
      status.innerHTML = `✅ ${newProofs.length} arquivo(s) armazenado(s)!<br>
        <span style="font-size:10px;color:#60b4ff;">${t("cf_hash_click_commit")}</span>`;
    }
    showToast(`✅ ${newProofs.length} prova(s) enviada(s)! Aguardando commit do cliente.`, 'success');
    window._cfProofFiles = [];
    cfRenderProofPreview();
    setTimeout(() => {
      document.getElementById('cf-proof-modal')?.remove();
      cfLoadContracts({ force: true });
    }, 2500);
  } else {
    if (status) { status.style.color = '#f87171'; status.textContent = 'Falha ao processar arquivos. Tente novamente.'; }
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-cloud-upload-alt mr-2"></i>Upload & Gerar Hash'; }
  }
}

// ─── Proof Viewer Modal ────────────────────────────────────────────────────────
// Opens a full-screen modal to view an uploaded proof (image, PDF or download).
function cfViewProof(contractId, proofIndex) {
  const meta   = cfGetMeta(contractId);
  const proofs = meta.proofs || [];
  if (!proofs.length) { showToast('No proofs available.', 'warning'); return; }

  let idx = (proofIndex != null && proofIndex >= 0 && proofIndex < proofs.length) ? proofIndex : 0;

  document.getElementById('cf-proof-viewer-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'cf-proof-viewer-modal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.92);backdrop-filter:blur(4px);display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding:0;overflow:hidden;';

  function buildContent(p) {
    if (!p || !p.url) return `<div style="color:#f87171;font-size:14px;padding:40px;text-align:center;"><i class="fas fa-exclamation-circle" style="font-size:32px;display:block;margin-bottom:12px;"></i>${t("contracts_file_not_available")}</div>`;

    const isImg = p.type === 'image' || (p.mimeType && p.mimeType.startsWith('image/')) || /^data:image\//i.test(p.url);
    const isPdf = p.type === 'pdf' || p.mimeType === 'application/pdf' || /^data:application\/pdf/i.test(p.url);

    if (isImg) {
      return `<div style="flex:1;display:flex;align-items:center;justify-content:center;overflow:auto;padding:16px;">
        <img src="${p.url}" alt="${p.name}"
          style="max-width:100%;max-height:calc(100vh - 140px);object-fit:contain;border-radius:10px;box-shadow:0 0 40px rgba(0,0,0,0.6);"
          onerror="this.outerHTML='<div style=\\'color:#f87171;text-align:center;padding:40px;\\'><i class=\\"fas fa-image-slash\\" style=\\"font-size:40px;display:block;margin-bottom:12px;\\"></i>Não foi possível renderizar a imagem.</div>'" />
      </div>`;
    }

    if (isPdf) {
      return `<div style="flex:1;width:100%;padding:8px 16px 0;">
        <iframe src="${p.url}" style="width:100%;height:calc(100vh - 140px);border:none;border-radius:10px;background:#fff;"
          title="${p.name}" onerror="">
        </iframe>
        <div style="text-align:center;padding:8px;font-size:11px;color:#4a6490;">
          ${t("cf_pdf_download_hint").replace("{0}", `<button onclick="cfDownloadProof('${btoa(JSON.stringify({url:p.url,name:p.name}))}')" style="background:none;border:none;color:#a78bfa;cursor:pointer;font-size:11px;text-decoration:underline;">${t("contracts_download_here")}</button>`)}
        </div>
      </div>`;
    }

    // Generic / Word / unknown — offer download
    return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px;text-align:center;">
      <i class="fas fa-file-alt" style="font-size:56px;color:#a78bfa;margin-bottom:16px;"></i>
      <p style="color:#dde2f0;font-size:15px;font-weight:700;margin-bottom:6px;">${p.name}</p>
      <p style="color:#4a6490;font-size:12px;margin-bottom:20px;">${p.mimeType || 'Tipo desconhecido'} · ${p.size ? (p.size/1024).toFixed(0)+' KB' : ''}</p>
      <button onclick="cfDownloadProofByUrl('${contractId}',${proofs.indexOf(p)})"
        style="padding:11px 24px;background:linear-gradient(135deg,#6d28d9,#5b21b6);color:#fff;border:none;border-radius:12px;font-size:13px;font-weight:700;cursor:pointer;">
        <i class="fas fa-download mr-2"></i>${t("cf_download_file")}
      </button>
    </div>`;
  }

  function render() {
    const p = proofs[idx];
    const committed = p?.committed;
    const statusLabel = committed
      ? `<span style="font-size:10px;color:#34d399;"><i class="fas fa-lock mr-1"></i>Committed</span>`
      : `<span style="font-size:10px;color:#fbbf24;"><i class="fas fa-clock mr-1"></i>Pendente</span>`;
    const hashShort = p?.hash ? p.hash.slice(0,16)+'…' : '';
    const hashFull  = p?.hash || '';

    modal.innerHTML = `
      <!-- Header -->
      <div style="width:100%;display:flex;align-items:center;gap:10px;padding:14px 20px;background:rgba(10,12,24,0.95);border-bottom:1px solid rgba(55,138,221,0.12);flex-shrink:0;">
        <button onclick="document.getElementById('cf-proof-viewer-modal').remove()"
          style="width:32px;height:32px;border-radius:8px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.25);color:#f87171;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
          <i class="fas fa-times"></i>
        </button>
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:700;color:#dde2f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p?.name || t('cf_file_label')}</div>
          <div style="display:flex;align-items:center;gap:8px;margin-top:2px;flex-wrap:wrap;">
            ${statusLabel}
            ${hashShort ? `<span style="font-size:9px;font-family:monospace;color:#3a4870;" title="SHA-256: ${hashFull}">${hashShort}</span>` : ''}
            <span style="font-size:9px;color:#252a40;">${idx+1} / ${proofs.length}</span>
          </div>
        </div>
        <!-- Navigation -->
        <div style="display:flex;gap:6px;flex-shrink:0;">
          <button onclick="cfViewProofNav(${contractId},${idx - 1})"
            ${idx===0?'disabled':''} id="cf-pv-prev"
            style="width:32px;height:32px;border-radius:8px;background:rgba(55,138,221,0.08);border:1px solid rgba(55,138,221,0.2);color:${idx===0?'#252a40':'#60b4ff'};cursor:${idx===0?'default':'pointer'};font-size:13px;display:flex;align-items:center;justify-content:center;">
            <i class="fas fa-chevron-left"></i>
          </button>
          <button onclick="cfViewProofNav(${contractId},${idx + 1})"
            ${idx===proofs.length-1?'disabled':''} id="cf-pv-next"
            style="width:32px;height:32px;border-radius:8px;background:rgba(55,138,221,0.08);border:1px solid rgba(55,138,221,0.2);color:${idx===proofs.length-1?'#252a40':'#60b4ff'};cursor:${idx===proofs.length-1?'default':'pointer'};font-size:13px;display:flex;align-items:center;justify-content:center;">
            <i class="fas fa-chevron-right"></i>
          </button>
          <button onclick="cfDownloadProofByUrl(${contractId},${idx})"
            style="width:32px;height:32px;border-radius:8px;background:rgba(167,139,250,0.08);border:1px solid rgba(167,139,250,0.2);color:#a78bfa;cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center;" title="Baixar">
            <i class="fas fa-download"></i>
          </button>
        </div>
      </div>

      <!-- Thumbnail strip (when multiple proofs) -->
      ${proofs.length > 1 ? `
      <div style="width:100%;display:flex;gap:6px;padding:8px 20px;background:rgba(10,12,24,0.85);overflow-x:auto;flex-shrink:0;border-bottom:1px solid rgba(55,138,221,0.07);">
        ${proofs.map((pp,ii) => {
          const isImg2 = pp.type==='image'||(pp.mimeType&&pp.mimeType.startsWith('image/'))||/^data:image\//i.test(pp.url||'');
          const thumb = isImg2 && pp.url
            ? `<img src="${pp.url}" style="width:44px;height:44px;object-fit:cover;border-radius:6px;">`
            : `<i class="fas ${pp.type==='pdf'?'fa-file-pdf':'fa-file'}" style="font-size:20px;color:${pp.type==='pdf'?'#f87171':'#a78bfa'};"></i>`;
          return `<button onclick="cfViewProofNav(${contractId},${ii})"
            style="flex-shrink:0;width:52px;height:52px;border-radius:8px;display:flex;align-items:center;justify-content:center;overflow:hidden;
              background:rgba(${ii===idx?'167,139,250':'55,138,221'},0.1);
              border:2px solid rgba(${ii===idx?'167,139,250':'55,138,221'},${ii===idx?'0.6':'0.15'});
              cursor:pointer;padding:0;">
            ${thumb}
          </button>`;
        }).join('')}
      </div>` : ''}

      <!-- Content area -->
      <div style="flex:1;width:100%;display:flex;flex-direction:column;overflow:auto;">
        ${buildContent(p)}
      </div>
    `;
  }

  render();
  document.body.appendChild(modal);

  // Close on backdrop click (but not on content)
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

// Navigate within proof viewer
window.cfViewProofNav = function(contractId, newIdx) {
  const meta   = cfGetMeta(contractId);
  const proofs = meta.proofs || [];
  const safeIdx = Math.max(0, Math.min(proofs.length - 1, Number(newIdx) || 0));
  document.getElementById('cf-proof-viewer-modal')?.remove();
  cfViewProof(contractId, safeIdx);
};

// Download proof by contract id + index
window.cfDownloadProofByUrl = function(contractId, proofIndex) {
  const meta   = cfGetMeta(contractId);
  const proofs = meta.proofs || [];
  const p      = proofs[proofIndex];
  if (!p || !p.url) { showToast(t('contracts_file_unavailable_download'), 'error'); return; }
  try {
    const a = document.createElement('a');
    a.href     = p.url;
    a.download = p.name || `proof_${contractId}_${proofIndex}`;
    a.click();
  } catch(e) {
    showToast('Erro ao baixar arquivo: ' + e.message, 'error');
  }
};

// ─── View On-Chain Proofs Modal ────────────────────────────────────────────────
// Fetches real ARC Testnet data: TX hash, contract address, event logs,
// stored on-chain state, and local proof metadata — all in one modal.
// No mock data — everything is fetched via RPC from Arc Testnet.
window.cfViewOnChainProofs = async function(contractId) {
  document.getElementById('cf-onchain-proofs-modal')?.remove();

  // ── Build skeleton modal immediately ──────────────────────────────────────
  const modal = document.createElement('div');
  modal.id = 'cf-onchain-proofs-modal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.88);backdrop-filter:blur(6px);display:flex;align-items:flex-start;justify-content:center;padding:16px;overflow-y:auto;';

  const card = document.createElement('div');
  card.style.cssText = 'background:#0a0c18;border:1px solid rgba(16,185,129,0.3);border-radius:20px;width:100%;max-width:700px;margin:auto;overflow:hidden;box-shadow:0 0 60px rgba(16,185,129,0.1);';
  card.innerHTML = `
    <!-- Header -->
    <div style="display:flex;align-items:center;gap:10px;padding:16px 20px;background:rgba(16,185,129,0.05);border-bottom:1px solid rgba(16,185,129,0.15);">
      <div style="width:36px;height:36px;border-radius:10px;background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.3);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
        <i class="fas fa-search-plus" style="color:#34d399;font-size:14px;"></i>
      </div>
      <div style="flex:1;">
        <div style="font-size:14px;font-weight:800;color:#dde2f0;">On-Chain Proofs & Verification</div>
        <div style="font-size:11px;color:#4a6490;">Contract #${contractId} · ARC Testnet · Chain ID 5042002</div>
      </div>
      <button onclick="document.getElementById('cf-onchain-proofs-modal').remove()"
        style="width:32px;height:32px;border-radius:8px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.25);color:#f87171;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
        <i class="fas fa-times"></i>
      </button>
    </div>
    <!-- Body -->
    <div id="cf-ocp-body" style="padding:20px;">
      <div style="text-align:center;padding:32px;color:#4a6490;">
        <i class="fas fa-spinner fa-spin" style="font-size:24px;color:#34d399;display:block;margin-bottom:12px;"></i>
        Fetching on-chain data from Arc Testnet…
      </div>
    </div>`;

  modal.appendChild(card);
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  const body = document.getElementById('cf-ocp-body');

  // ── Helper: copy to clipboard ──────────────────────────────────────────────
  window._cfCopy = function(text) {
    navigator.clipboard?.writeText(text).then(() => showToast('Copied!', 'success')).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); showToast('Copied!', 'success'); } catch (_) {}
      document.body.removeChild(ta);
    });
  };

  const copyBtn = (val, label) => `<button onclick="_cfCopy('${val}')" title="Copy ${label}"
    style="width:22px;height:22px;border-radius:5px;background:rgba(55,138,221,0.08);border:1px solid rgba(55,138,221,0.2);color:#3a6090;cursor:pointer;font-size:9px;display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;margin-left:4px;">
    <i class="fas fa-copy"></i></button>`;

  const explorerLink = (path, label, color = '#60b4ff') =>
    `<a href="${CF_EXPLORER}/${path}" target="_blank" rel="noopener"
      style="color:${color};font-size:10px;text-decoration:none;display:inline-flex;align-items:center;gap:3px;background:rgba(55,138,221,0.07);border:1px solid rgba(55,138,221,0.15);padding:1px 7px;border-radius:5px;margin-left:4px;">
      <i class="fas fa-external-link-alt" style="font-size:8px;"></i>${label}
    </a>`;

  try {
    const ethers = window.ethers;
    if (!ethers) throw new Error('ethers.js not available');

    const provider = new ethers.JsonRpcProvider(CF_RPC);
    const factory  = new ethers.Contract(CF_FACTORY_ADDR, CF_ABI, provider);

    // ── Fetch on-chain contract data ─────────────────────────────────────────
    const [onChain, milestones, latestBlock] = await Promise.all([
      factory.getContract(contractId).catch(e => { throw new Error('getContract failed: ' + e.message); }),
      factory.getMilestones(contractId).catch(() => []),
      provider.getBlockNumber().catch(() => 0),
    ]);

    const createdAtMs = Number(onChain.createdAt) * 1000;
    const startedAtMs = Number(onChain.startedAt) * 1000;
    const completedAtMs = Number(onChain.completedAt) * 1000;
    const statusLabels = ['Draft', 'Active', 'Completed', 'Cancelled'];
    const onChainStatus = statusLabels[Number(onChain.status)] || `Status(${Number(onChain.status)})`;

    // ── Fetch relevant event logs from ARC Testnet ───────────────────────────
    const iface = new ethers.Interface(CF_ABI);
    const contractIdTopic = '0x' + BigInt(contractId).toString(16).padStart(64, '0');
    const fromBlock = Math.max(0, latestBlock - 100000);

    const eventTopics = {
      ContractCreated:   ethers.id('ContractCreated(uint256,address,address,string,uint256,uint256,uint256)'),
      ContractSigned:    ethers.id('ContractSigned(uint256,address,uint256)'),
      MilestoneReleased: ethers.id('MilestoneReleased(uint256,uint256,address,uint256,uint256)'),
      ContractCancelled: ethers.id('ContractCancelled(uint256,address,uint256,uint256)'),
    };

    const allLogs = [];
    for (const [evName, topic0] of Object.entries(eventTopics)) {
      try {
        const logs = await provider.getLogs({
          address: CF_FACTORY_ADDR,
          topics: [topic0, contractIdTopic],
          fromBlock,
          toBlock: latestBlock,
        });
        for (const log of logs) {
          try {
            const parsed = iface.parseLog(log);
            allLogs.push({ evName, log, parsed, blockNum: Number(log.blockNumber || log.blockNum || 0) });
          } catch(_) {
            allLogs.push({ evName, log, parsed: null, blockNum: Number(log.blockNumber || 0) });
          }
        }
      } catch (_) { /* silently skip if RPC range too large */ }
    }

    // Sort by block number
    allLogs.sort((a, b) => a.blockNum - b.blockNum);

    // Fetch block timestamps for discovered blocks
    const blockNums = [...new Set(allLogs.map(e => e.blockNum).filter(Boolean))];
    const blockTsMap = {};
    await Promise.all(blockNums.slice(0, 20).map(async bn => {
      try {
        const blk = await provider.getBlock(bn);
        if (blk) blockTsMap[bn] = blk.timestamp;
      } catch (_) {}
    }));

    // ── Local proof metadata ──────────────────────────────────────────────────
    const meta = cfGetMeta(contractId);
    const localProofs = meta.proofs || [];
    const txLog = (() => { try { return JSON.parse(localStorage.getItem(CF_TX_LOG_KEY) || '[]'); } catch(_) { return []; } })();
    const myTxLogs = txLog.filter(t => String(t.contractId) === String(contractId));

    // ── Render ─────────────────────────────────────────────────────────────────
    const totalUsdc = (Number(onChain.totalValue) / 1e6).toFixed(2);
    const deposited = (Number(onChain.depositedValue) / 1e6).toFixed(2);
    const signed = onChain.contractorSigned;

    body.innerHTML = `
      <!-- Network banner -->
      <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:rgba(16,185,129,0.06);border:1px solid rgba(16,185,129,0.2);border-radius:10px;margin-bottom:16px;font-size:11px;">
        <span style="width:8px;height:8px;border-radius:50%;background:#34d399;flex-shrink:0;box-shadow:0 0 6px #34d399;"></span>
        <span style="color:#34d399;font-weight:700;">Live Data — Arc Testnet</span>
        <span style="color:#4a6490;margin-left:auto;">Block #${latestBlock.toLocaleString()} · Fetched ${new Date().toLocaleTimeString()}</span>
        <a href="${CF_EXPLORER}/address/${CF_FACTORY_ADDR}" target="_blank" rel="noopener" style="color:#34d399;font-size:10px;text-decoration:none;background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.2);padding:2px 8px;border-radius:5px;white-space:nowrap;">
          <i class="fas fa-external-link-alt" style="font-size:8px;margin-right:3px;"></i>ArcScan
        </a>
      </div>

      <!-- Contract state from on-chain -->
      <div style="margin-bottom:16px;">
        <div style="font-size:10px;font-weight:700;color:#34d399;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px;display:flex;align-items:center;gap:6px;">
          <i class="fas fa-link"></i>On-Chain Contract State
        </div>
        <div style="background:rgba(10,12,24,0.8);border:1px solid rgba(55,138,221,0.15);border-radius:12px;padding:14px;">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">
            <div style="background:rgba(55,138,221,0.05);border-radius:8px;padding:8px 10px;">
              <div style="font-size:9px;color:#3a4870;text-transform:uppercase;font-weight:700;margin-bottom:3px;">Contract ID</div>
              <div style="font-size:12px;font-weight:800;color:#60b4ff;">#${Number(onChain.id)}</div>
            </div>
            <div style="background:rgba(${onChainStatus==='Active'?'52,211,153':onChainStatus==='Completed'?'96,180,255':onChainStatus==='Cancelled'?'239,68,68':'251,191,36'},0.07);border-radius:8px;padding:8px 10px;">
              <div style="font-size:9px;color:#3a4870;text-transform:uppercase;font-weight:700;margin-bottom:3px;">Status</div>
              <div style="font-size:12px;font-weight:800;color:${onChainStatus==='Active'?'#34d399':onChainStatus==='Completed'?'#60b4ff':onChainStatus==='Cancelled'?'#f87171':'#fbbf24'};">${onChainStatus}</div>
            </div>
            <div style="background:rgba(52,211,153,0.05);border-radius:8px;padding:8px 10px;">
              <div style="font-size:9px;color:#3a4870;text-transform:uppercase;font-weight:700;margin-bottom:3px;">Total Value</div>
              <div style="font-size:13px;font-weight:800;color:#34d399;">$${totalUsdc} USDC</div>
            </div>
            <div style="background:rgba(55,138,221,0.05);border-radius:8px;padding:8px 10px;">
              <div style="font-size:9px;color:#3a4870;text-transform:uppercase;font-weight:700;margin-bottom:3px;">Deposited</div>
              <div style="font-size:13px;font-weight:800;color:#60b4ff;">$${deposited} USDC</div>
            </div>
            <div style="background:rgba(55,138,221,0.04);border-radius:8px;padding:8px 10px;">
              <div style="font-size:9px;color:#3a4870;text-transform:uppercase;font-weight:700;margin-bottom:3px;">Contractor Signed</div>
              <div style="font-size:12px;font-weight:700;color:${signed?'#34d399':'#f87171'};">${signed ? '✓ Signed' : '✗ Unsigned'}</div>
            </div>
            <div style="background:rgba(55,138,221,0.04);border-radius:8px;padding:8px 10px;">
              <div style="font-size:9px;color:#3a4870;text-transform:uppercase;font-weight:700;margin-bottom:3px;">Milestones</div>
              <div style="font-size:12px;font-weight:700;color:#a78bfa;">${Number(onChain.completedMilestones)} / ${Number(onChain.milestoneCount)} done</div>
            </div>
          </div>

          <!-- Addresses -->
          <div style="border-top:1px solid rgba(55,138,221,0.1);padding-top:10px;">
            <div style="font-size:10px;margin-bottom:6px;">
              <span style="color:#3a4870;font-weight:700;">Factory:</span>
              <span style="font-family:monospace;font-size:10px;color:#60b4ff;">${CF_FACTORY_ADDR}</span>
              ${copyBtn(CF_FACTORY_ADDR, 'factory address')}
              ${explorerLink('address/' + CF_FACTORY_ADDR, '↗', '#60b4ff')}
            </div>
            <div style="font-size:10px;margin-bottom:6px;">
              <span style="color:#3a4870;font-weight:700;">Client:</span>
              <span style="font-family:monospace;font-size:10px;color:#60b4ff;">${onChain.client}</span>
              ${copyBtn(onChain.client, 'client address')}
              ${explorerLink('address/' + onChain.client, '↗', '#60b4ff')}
            </div>
            <div style="font-size:10px;margin-bottom:6px;">
              <span style="color:#3a4870;font-weight:700;">Contractor:</span>
              <span style="font-family:monospace;font-size:10px;color:#34d399;">${onChain.contractor}</span>
              ${copyBtn(onChain.contractor, 'contractor address')}
              ${explorerLink('address/' + onChain.contractor, '↗', '#34d399')}
            </div>
            <div style="font-size:10px;">
              <span style="color:#3a4870;font-weight:700;">USDC Token:</span>
              <span style="font-family:monospace;font-size:10px;color:#fbbf24;">${CF_USDC_ADDR}</span>
              ${copyBtn(CF_USDC_ADDR, 'USDC address')}
              ${explorerLink('address/' + CF_USDC_ADDR, '↗', '#fbbf24')}
            </div>
          </div>

          <!-- Timestamps -->
          <div style="border-top:1px solid rgba(55,138,221,0.1);padding-top:10px;margin-top:6px;display:flex;flex-wrap:wrap;gap:8px;font-size:10px;color:#4a6490;">
            ${createdAtMs > 0 ? `<span><i class="fas fa-clock mr-1"></i>Created: <span style="color:#8899bb;">${new Date(createdAtMs).toLocaleString()}</span></span>` : ''}
            ${startedAtMs > 0 ? `<span><i class="fas fa-play mr-1"></i>Started: <span style="color:#8899bb;">${new Date(startedAtMs).toLocaleString()}</span></span>` : ''}
            ${completedAtMs > 0 ? `<span><i class="fas fa-flag-checkered mr-1"></i>Completed: <span style="color:#34d399;">${new Date(completedAtMs).toLocaleString()}</span></span>` : ''}
          </div>
        </div>
      </div>

      <!-- Milestones on-chain -->
      ${milestones.length > 0 ? `
      <div style="margin-bottom:16px;">
        <div style="font-size:10px;font-weight:700;color:#a78bfa;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px;display:flex;align-items:center;gap:6px;">
          <i class="fas fa-tasks"></i>Milestones (On-Chain)
        </div>
        <div style="background:rgba(10,12,24,0.8);border:1px solid rgba(167,139,250,0.15);border-radius:12px;overflow:hidden;">
          ${milestones.map((m, i) => {
            const msStatus = ['Pending','Released'][Number(m.status)] || `Status(${Number(m.status)})`;
            const relTs = Number(m.releasedAt) > 0 ? new Date(Number(m.releasedAt)*1000).toLocaleString() : null;
            return `<div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid rgba(167,139,250,0.06);${i===milestones.length-1?'border-bottom:none;':''}">
              <div style="width:22px;height:22px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:9px;
                ${msStatus==='Released'?'background:rgba(52,211,153,0.2);border:1px solid rgba(52,211,153,0.4);color:#34d399':'background:rgba(167,139,250,0.1);border:1px solid rgba(167,139,250,0.25);color:#a78bfa'}">
                <i class="fas ${msStatus==='Released'?'fa-check':'fa-clock'}"></i>
              </div>
              <span style="flex:1;font-size:12px;color:#8899bb;">${m.description}</span>
              <span style="font-size:12px;font-weight:700;color:#a78bfa;">$${(Number(m.amount)/1e6).toFixed(2)}</span>
              <span style="font-size:10px;padding:2px 8px;border-radius:5px;
                ${msStatus==='Released'?'background:rgba(52,211,153,0.12);color:#34d399':'background:rgba(167,139,250,0.1);color:#a78bfa'}">
                ${msStatus}${relTs ? ` · ${relTs}` : ''}
              </span>
            </div>`;
          }).join('')}
        </div>
      </div>` : ''}

      <!-- Event Logs from ARC Testnet -->
      <div style="margin-bottom:16px;">
        <div style="font-size:10px;font-weight:700;color:#fbbf24;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px;display:flex;align-items:center;gap:6px;">
          <i class="fas fa-receipt"></i>On-Chain Event Logs (${allLogs.length})
          ${allLogs.length === 0 ? `<span style="font-size:9px;color:#4a6490;font-weight:400;">(scanned last 100k blocks)</span>` : ''}
        </div>
        <div style="background:rgba(10,12,24,0.8);border:1px solid rgba(245,158,11,0.15);border-radius:12px;overflow:hidden;">
          ${allLogs.length === 0 ? `
            <div style="text-align:center;padding:20px;font-size:12px;color:#4a6490;">
              <i class="fas fa-search" style="font-size:20px;display:block;margin-bottom:8px;"></i>
              No indexed events found in the scanned range.<br>
              <span style="font-size:10px;">Contract may have been created before the scan window, or no events have occurred yet.</span>
              <div style="margin-top:8px;">
                ${explorerLink('address/' + CF_FACTORY_ADDR, 'View Factory on ArcScan ↗', '#fbbf24')}
              </div>
            </div>` :
            allLogs.map((e, i) => {
              const ts = blockTsMap[e.blockNum] ? new Date(blockTsMap[e.blockNum] * 1000).toLocaleString() : `Block #${e.blockNum}`;
              const txShort = e.log.transactionHash ? e.log.transactionHash.slice(0,24) + '…' : '—';
              const evColors = {
                ContractCreated:   { bg: '52,211,153', color: '#34d399', icon: 'fa-file-contract' },
                ContractSigned:    { bg: '96,180,255', color: '#60b4ff', icon: 'fa-pen-nib' },
                MilestoneReleased: { bg: '167,139,250', color: '#a78bfa', icon: 'fa-flag-checkered' },
                ContractCancelled: { bg: '239,68,68',  color: '#f87171', icon: 'fa-times-circle' },
              };
              const ec = evColors[e.evName] || { bg: '251,191,36', color: '#fbbf24', icon: 'fa-bolt' };
              return `<div style="padding:10px 14px;border-bottom:1px solid rgba(245,158,11,0.06);${i===allLogs.length-1?'border-bottom:none;':''}">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                  <span style="display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:700;background:rgba(${ec.bg},0.12);border:1px solid rgba(${ec.bg},0.25);color:${ec.color};padding:2px 8px;border-radius:5px;">
                    <i class="fas ${ec.icon}" style="font-size:8px;"></i>${e.evName}
                  </span>
                  <span style="font-size:10px;color:#4a6490;">${ts}</span>
                  <span style="font-size:9px;font-family:monospace;color:#3a4870;margin-left:auto;">Block #${e.blockNum.toLocaleString()}</span>
                </div>
                ${e.log.transactionHash ? `
                <div style="display:flex;align-items:center;gap:4px;font-size:10px;color:#3a6090;">
                  <span style="color:#4a6490;">TX:</span>
                  <span style="font-family:monospace;color:#60b4ff;">${txShort}</span>
                  ${copyBtn(e.log.transactionHash, 'tx hash')}
                  ${explorerLink('tx/' + e.log.transactionHash, '↗', '#60b4ff')}
                </div>` : ''}
                ${e.parsed ? `<div style="margin-top:4px;font-size:9px;color:#3a4870;font-family:monospace;background:rgba(55,138,221,0.04);border-radius:5px;padding:4px 8px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;">
                  ${Object.keys(e.parsed.args).filter(k => isNaN(Number(k))).map(k => {
                    let v = e.parsed.args[k];
                    if (typeof v === 'bigint') v = v.toString();
                    else if (typeof v === 'object') v = JSON.stringify(v);
                    return `${k}: ${v}`;
                  }).join('\n')}
                </div>` : ''}
              </div>`;
            }).join('')
          }
        </div>
      </div>

      <!-- Local Proof Metadata -->
      <div style="margin-bottom:16px;">
        <div style="font-size:10px;font-weight:700;color:#a78bfa;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px;display:flex;align-items:center;gap:6px;">
          <i class="fas fa-shield-alt"></i>Proof of Work — Local Records (${localProofs.length})
        </div>
        ${localProofs.length === 0 ? `
          <div style="background:rgba(10,12,24,0.8);border:1px solid rgba(167,139,250,0.12);border-radius:12px;padding:16px;text-align:center;font-size:12px;color:#4a6490;">
            <i class="fas fa-inbox" style="font-size:18px;display:block;margin-bottom:6px;"></i>
            No proofs available. The contractor hasn't uploaded any proof of work yet.
          </div>` :
          `<div style="background:rgba(10,12,24,0.8);border:1px solid rgba(167,139,250,0.15);border-radius:12px;overflow:hidden;">
            ${localProofs.map((p, pi) => {
              const committed = !!p.committed;
              const hashShort = p.hash ? p.hash.slice(0,20) + '…' : '—';
              const sizeKb = p.size ? (p.size/1024).toFixed(0) + ' KB' : '';
              return `<div style="display:flex;align-items:flex-start;gap:10px;padding:12px 14px;border-bottom:1px solid rgba(167,139,250,0.06);${pi===localProofs.length-1?'border-bottom:none;':''}">
                <div style="width:32px;height:32px;border-radius:8px;background:rgba(167,139,250,0.1);border:1px solid rgba(167,139,250,0.2);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                  <i class="fas ${p.type==='image'?'fa-image':p.type==='pdf'?'fa-file-pdf':'fa-file'}" style="color:${committed?'#34d399':'#a78bfa'};font-size:14px;"></i>
                </div>
                <div style="flex:1;min-width:0;">
                  <div style="font-size:12px;font-weight:700;color:#dde2f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.name || 'Unnamed file'}</div>
                  <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;align-items:center;">
                    <span style="font-size:9px;padding:1px 7px;border-radius:5px;font-weight:700;
                      ${committed?'background:rgba(52,211,153,0.12);border:1px solid rgba(52,211,153,0.3);color:#34d399':'background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.25);color:#fbbf24'}">
                      <i class="fas ${committed?'fa-lock':'fa-clock'} mr-1" style="font-size:7px;"></i>${committed?'Committed':'Pending'}
                    </span>
                    ${sizeKb ? `<span style="font-size:9px;color:#4a6490;">${sizeKb}</span>` : ''}
                    ${p.uploadedAt ? `<span style="font-size:9px;color:#4a6490;">${new Date(p.uploadedAt).toLocaleDateString()}</span>` : ''}
                  </div>
                  ${p.hash ? `<div style="font-size:9px;font-family:monospace;color:#3a4870;margin-top:3px;">
                    SHA-256: <span style="color:#4a6490;">${hashShort}</span>
                    ${copyBtn(p.hash, 'SHA-256 hash')}
                  </div>` : ''}
                  ${p.committedAt ? `<div style="font-size:9px;color:#34d399;margin-top:2px;"><i class="fas fa-check mr-1"></i>Committed: ${new Date(p.committedAt).toLocaleString()}</div>` : ''}
                </div>
                <button onclick="cfViewProof(${contractId},${pi})"
                  style="flex-shrink:0;padding:5px 12px;background:rgba(167,139,250,0.1);border:1px solid rgba(167,139,250,0.25);color:#a78bfa;border-radius:7px;font-size:10px;cursor:pointer;white-space:nowrap;">
                  <i class="fas fa-eye mr-1"></i>View
                </button>
              </div>`;
            }).join('')}
          </div>`
        }
      </div>

      <!-- Local TX log for this contract -->
      ${myTxLogs.length > 0 ? `
      <div style="margin-bottom:16px;">
        <div style="font-size:10px;font-weight:700;color:#60b4ff;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px;display:flex;align-items:center;gap:6px;">
          <i class="fas fa-list"></i>Local Transaction Log (${myTxLogs.length})
        </div>
        <div style="background:rgba(10,12,24,0.8);border:1px solid rgba(96,180,255,0.15);border-radius:12px;overflow:hidden;">
          ${myTxLogs.map((t, ti) => `
            <div style="padding:10px 14px;border-bottom:1px solid rgba(96,180,255,0.06);${ti===myTxLogs.length-1?'border-bottom:none;':''}">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:${t.txHash?'4px':'0'};">
                <span style="font-size:11px;font-weight:600;color:#dde2f0;">${t.action || t.type || 'tx'}</span>
                <span style="font-size:9px;color:#4a6490;margin-left:auto;">${t.timestamp ? new Date(t.timestamp).toLocaleString() : ''}</span>
              </div>
              ${t.txHash ? `<div style="font-size:10px;font-family:monospace;color:#60b4ff;">
                ${t.txHash.slice(0,26)}…
                ${copyBtn(t.txHash, 'tx hash')}
                ${explorerLink('tx/' + t.txHash, '↗', '#60b4ff')}
              </div>` : ''}
            </div>`).join('')}
        </div>
      </div>` : ''}

      <!-- Footer actions -->
      <div style="display:flex;gap:8px;flex-wrap:wrap;border-top:1px solid rgba(55,138,221,0.1);padding-top:14px;">
        <a href="${CF_EXPLORER}/address/${CF_FACTORY_ADDR}" target="_blank" rel="noopener"
          style="display:inline-flex;align-items:center;gap:6px;padding:8px 16px;background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.25);color:#34d399;border-radius:10px;font-size:11px;font-weight:700;text-decoration:none;">
          <i class="fas fa-external-link-alt"></i>View Factory on ArcScan
        </a>
        <button onclick="document.getElementById('cf-onchain-proofs-modal').remove()"
          style="padding:8px 16px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);color:#f87171;border-radius:10px;font-size:11px;font-weight:700;cursor:pointer;">
          <i class="fas fa-times mr-1"></i>Close
        </button>
      </div>
    `;

  } catch (err) {
    console.error('[cfViewOnChainProofs]', err);
    if (body) body.innerHTML = `
      <div style="text-align:center;padding:32px;">
        <i class="fas fa-exclamation-circle" style="font-size:32px;color:#f87171;display:block;margin-bottom:12px;"></i>
        <div style="font-size:14px;font-weight:700;color:#f87171;margin-bottom:8px;">Failed to fetch on-chain data</div>
        <div style="font-size:12px;color:#4a6490;margin-bottom:16px;">${err.message}</div>

        <!-- Local proof fallback -->
        ${(() => {
          const meta2 = cfGetMeta(contractId);
          const lp = meta2.proofs || [];
          if (!lp.length) return `<div style="font-size:12px;color:#4a6490;">No local proof records found either.</div>`;
          return `<div style="text-align:left;margin-top:12px;">
            <div style="font-size:10px;font-weight:700;color:#a78bfa;margin-bottom:8px;text-transform:uppercase;">Local Proof Records (${lp.length})</div>
            ${lp.map((p, pi) => `
              <div style="display:flex;align-items:center;gap:8px;padding:8px;background:rgba(167,139,250,0.06);border:1px solid rgba(167,139,250,0.15);border-radius:8px;margin-bottom:4px;">
                <i class="fas ${p.type==='image'?'fa-image':p.type==='pdf'?'fa-file-pdf':'fa-file'}" style="color:${p.committed?'#34d399':'#a78bfa'};"></i>
                <span style="flex:1;font-size:11px;color:#8899bb;">${p.name}</span>
                <span style="font-size:9px;color:${p.committed?'#34d399':'#fbbf24'};">${p.committed?'Committed':'Pending'}</span>
                <button onclick="cfViewProof(${contractId},${pi})" style="font-size:10px;color:#a78bfa;background:rgba(167,139,250,0.08);border:1px solid rgba(167,139,250,0.18);padding:2px 8px;border-radius:5px;cursor:pointer;">View</button>
              </div>`).join('')}
          </div>`;
        })()}

        <div style="display:flex;gap:8px;justify-content:center;margin-top:16px;">
          <button onclick="cfViewOnChainProofs(${contractId})"
            style="padding:8px 16px;background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.25);color:#34d399;border-radius:8px;font-size:11px;cursor:pointer;">
            <i class="fas fa-redo mr-1"></i>Retry
          </button>
          <button onclick="document.getElementById('cf-onchain-proofs-modal').remove()"
            style="padding:8px 16px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);color:#f87171;border-radius:8px;font-size:11px;cursor:pointer;">
            Close
          </button>
        </div>
      </div>`;
  }
};

// ─── Delete Proof (contractor action) ─────────────────────────────────────────
// Allows the contractor (uploader) to delete a pending (uncommitted) proof.
// Shows a confirmation modal before deletion.
// Committed proofs are protected and cannot be deleted.
function cfDeleteProof(contractId, proofIndex) {
  const meta   = cfGetMeta(contractId);
  const proofs = meta.proofs || [];
  const proof  = proofs[proofIndex];

  if (!proof) { showToast('Proof not found.', 'error'); return; }
  if (proof.committed) {
    showToast('Committed proofs cannot be deleted.', 'warning');
    return;
  }

  // ── Confirmation modal ──────────────────────────────────────────────────────
  document.getElementById('cf-delete-proof-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'cf-delete-proof-modal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,0.82);backdrop-filter:blur(4px);';
  modal.innerHTML = `
  <div style="background:#0a0c18;border:1px solid rgba(239,68,68,0.35);border-radius:20px;width:100%;max-width:420px;padding:26px;box-shadow:0 0 40px rgba(239,68,68,0.12);">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
      <div style="width:38px;height:38px;border-radius:10px;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.3);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
        <i class="fas fa-trash-alt" style="color:#f87171;font-size:15px;"></i>
      </div>
      <div>
        <h3 style="color:#f1f5f9;font-size:15px;font-weight:800;margin:0 0 2px;">Delete Proof?</h3>
        <p style="color:#6b7280;font-size:11px;margin:0;">This action cannot be undone.</p>
      </div>
    </div>
    <div style="background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.18);border-radius:10px;padding:10px 14px;margin-bottom:18px;">
      <div style="display:flex;align-items:center;gap:8px;">
        <i class="fas fa-file" style="color:#f87171;font-size:13px;flex-shrink:0;"></i>
        <span style="font-size:12px;color:#dde2f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${proof.name}</span>
      </div>
      <div style="font-size:10px;color:#6b7280;margin-top:4px;font-family:monospace;">SHA-256: ${proof.hash ? proof.hash.slice(0,16) + '…' : 'n/a'}</div>
    </div>
    <p style="font-size:12px;color:#9ca3af;margin-bottom:20px;line-height:1.5;">
      Are you sure you want to delete this proof?<br>
      <span style="color:#fbbf24;">Only pending (uncommitted) proofs can be deleted.</span>
    </p>
    <div style="display:flex;gap:10px;">
      <button onclick="cfConfirmDeleteProof(${contractId},${proofIndex})"
        style="flex:1;background:linear-gradient(135deg,#dc2626,#b91c1c);color:#fff;border:none;border-radius:12px;padding:11px;font-size:13px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;">
        <i class="fas fa-trash-alt"></i>Yes, Delete Proof
      </button>
      <button onclick="document.getElementById('cf-delete-proof-modal').remove()"
        style="padding:11px 18px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);color:#6b7280;border-radius:12px;cursor:pointer;font-size:13px;font-weight:600;">
        Cancel
      </button>
    </div>
  </div>`;
  document.body.appendChild(modal);

  // Close on backdrop click
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

// Execute the actual deletion after confirmation
function cfConfirmDeleteProof(contractId, proofIndex) {
  document.getElementById('cf-delete-proof-modal')?.remove();

  const meta   = cfGetMeta(contractId);
  const proofs = meta.proofs || [];
  const proof  = proofs[proofIndex];

  if (!proof) { showToast('Proof not found.', 'error'); return; }
  if (proof.committed) { showToast('Cannot delete a committed proof.', 'warning'); return; }

  const proofName = proof.name;

  // Remove from array and save
  proofs.splice(proofIndex, 1);
  cfSetMeta(contractId, { proofs });

  showToast(`✅ Proof "${proofName}" deleted successfully.`, 'success');
  cfLog(`Proof deleted: contract #${contractId}, index ${proofIndex}, file: ${proofName}`);

  // Refresh contracts view
  cfLoadContracts({ force: true });
}

// ─── Commit Proof (client action) ─────────────────────────────────────────────
// Locks all uploaded proofs, marking them as committed.
// Only the client should do this after reviewing the proof.
async function cfCommitProof(contractId) {
  const wallet = window.walletState?.address;
  const c = cfState.contracts.find(x => x.id === contractId);
  const meta = cfGetMeta(contractId);
  const proofs = meta.proofs || [];

  if (!proofs.length) { showToast(t('cf_no_proof_to_confirm'), 'warning'); return; }
  const uncommitted = proofs.filter(p => !p.committed);
  if (!uncommitted.length) { showToast(t('contracts_all_proofs_committed'), 'info'); return; }

  // Show confirmation modal
  document.getElementById('cf-commit-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'cf-commit-modal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm';
  modal.innerHTML = `
  <div style="background:#0a0c18;border:1px solid rgba(52,211,153,0.3);border-radius:20px;width:100%;max-width:440px;padding:24px;">
    <h3 style="color:#dde2f0;font-size:15px;font-weight:800;margin-bottom:12px;display:flex;align-items:center;gap:8px;">
      <i class="fas fa-stamp" style="color:#34d399;"></i>Confirmar Prova de Trabalho — #${contractId}
    </h3>
    <div style="background:rgba(52,211,153,0.06);border:1px solid rgba(52,211,153,0.2);border-radius:10px;padding:12px;margin-bottom:14px;">
      <p style="font-size:12px;color:#6ee7b7;margin-bottom:8px;font-weight:600;">${t("cf_files_to_confirm", uncommitted.length)}</p>
      ${uncommitted.map(p => `
        <div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid rgba(52,211,153,0.1);">
          <i class="fas ${p.type==='image'?'fa-image':p.type==='pdf'?'fa-file-pdf':'fa-file'}" style="color:#34d399;font-size:12px;"></i>
          <span style="flex:1;font-size:11px;color:#8899bb;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.name}</span>
          <span style="font-size:9px;font-family:monospace;color:#3a4870;">${p.hash?.slice(0,12)}…</span>
        </div>`).join('')}
    </div>
    <div style="background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.2);border-radius:8px;padding:10px;margin-bottom:14px;font-size:11px;color:#fbbf24;">
      <i class="fas fa-exclamation-triangle mr-1"></i>
      Ao confirmar, você atesta que revisou a prova de trabalho e está de acordo. Esta ação <strong>não pode ser desfeita</strong>.
      ${(c?.milestoneCount || 0) > 0 ? `<br><br>${t("cf_after_confirm_hint")}` : ''}
    </div>
    <div style="display:flex;gap:10px;">
      <button onclick="cfExecuteCommitProof(${contractId})" id="cf-commit-btn"
        style="flex:1;background:linear-gradient(135deg,#065f46,#047857);color:#fff;border:none;border-radius:12px;padding:12px;font-size:13px;font-weight:700;cursor:pointer;">
        <i class="fas fa-stamp mr-2"></i>Confirmar & Bloquear Prova
      </button>
      <button onclick="document.getElementById('cf-commit-modal').remove()"
        style="padding:12px 18px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);color:#6b7280;border-radius:12px;cursor:pointer;font-size:13px;">Cancelar</button>
    </div>
  </div>`;
  document.body.appendChild(modal);
}

async function cfExecuteCommitProof(contractId) {
  const btn = document.getElementById('cf-commit-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Confirmando…'; }

  try {
    const meta = cfGetMeta(contractId);
    const proofs = (meta.proofs || []).map(p => ({
      ...p,
      committed:   true,
      committedAt: Date.now(),
      committedBy: window.walletState?.address || 'unknown',
    }));

    // Compute a combined commitment hash (SHA-256 of all individual hashes)
    const combinedInput = proofs.map(p => p.hash).join('|') + '|' + contractId + '|' + Date.now();
    const enc = new TextEncoder().encode(combinedInput);
    const digest = await crypto.subtle.digest('SHA-256', enc);
    const commitmentHash = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');

    cfSetMeta(contractId, {
      proofs,
      commitmentHash,
      commitmentTs: Date.now(),
      commitmentWallet: window.walletState?.address || 'unknown',
    });

    cfLog(`Proof committed for #${contractId} | commitment: ${commitmentHash.slice(0,16)}…`);
    cfLogTx('commitProof', commitmentHash, contractId, {
      proofCount: proofs.length,
      commitment: commitmentHash,
    });

    document.getElementById('cf-commit-modal')?.remove();
    showToast(`✅ Prova confirmada e bloqueada! Hash: ${commitmentHash.slice(0,16)}…`, 'success');
    await cfLoadContracts({ force: true });
  } catch (e) {
    cfErr('cfExecuteCommitProof:', e.message);
    showToast(`❌ Erro ao confirmar: ${e.message}`, 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-stamp mr-2"></i>Confirmar & Bloquear Prova'; }
  }
}

// ─── QR Code Generator (native canvas — no external APIs required) ───────────
// Uses Google Charts API as primary, canvas fallback as secondary.
function cfGenerateQrCanvas(text, size) {
  size = size || 200;
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'text-align:center;';
  const img = document.createElement('img');
  img.src = `https://chart.googleapis.com/chart?cht=qr&chs=${size}x${size}&chl=${encodeURIComponent(text)}&choe=UTF-8&chld=M|2`;
  img.style.cssText = `border-radius:10px;background:#fff;padding:6px;width:${size}px;height:${size}px;display:inline-block;`;
  img.alt = 'QR Code';
  img.onerror = function() {
    this.style.display = 'none';
    // Fallback: simple canvas pattern
    try {
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, size, size);
        const bytes = Array.from(text).map(function(c) { return c.charCodeAt(0); });
        const cell  = Math.max(4, Math.floor(size / 29));
        const cols  = Math.floor(size / cell);
        ctx.fillStyle = '#000000';
        // Draw corner finder patterns
        [[0,0],[0,cols-7],[cols-7,0]].forEach(function(pos) {
          var cx = pos[0], cy = pos[1];
          ctx.fillStyle = '#000000';
          ctx.fillRect(cx*cell, cy*cell, 7*cell, 7*cell);
          ctx.fillStyle = '#ffffff';
          ctx.fillRect((cx+1)*cell, (cy+1)*cell, 5*cell, 5*cell);
          ctx.fillStyle = '#000000';
          ctx.fillRect((cx+2)*cell, (cy+2)*cell, 3*cell, 3*cell);
        });
        // Encode data from URL bytes
        var bi = 0;
        for (var row = 0; row < cols; row++) {
          for (var col = 0; col < cols; col++) {
            if (row < 9 && (col < 9 || col > cols-9)) continue;
            if (row > cols-9 && col < 9) continue;
            var b   = bytes[bi % bytes.length];
            var bit = (b >> (7 - (bi % 8))) & 1;
            if (bit) { ctx.fillStyle = '#000000'; ctx.fillRect(col*cell, row*cell, cell, cell); }
            bi++;
          }
        }
        canvas.style.cssText = `border-radius:10px;display:inline-block;`;
        wrapper.appendChild(canvas);
      }
    } catch(e) {
      wrapper.innerHTML += '<p style="font-size:11px;color:#3a4870;padding:10px;">QR indispon\u00edvel \u2014 copie o link abaixo</p>';
    }
  };
  wrapper.appendChild(img);
  return wrapper;
}

// ─── Wallet-Link / QR Code (wallet-less authorization) ────────────────────────
// Generates a shareable link + QR code for the contractor to interact
// without a browser wallet extension.
function cfShowWalletLink(contractId) {
  const c    = cfState.contracts.find(function(x) { return x.id === contractId; });
  const meta = cfGetMeta(contractId);
  const mode = meta.mode || 'onchain';

  const baseUrl    = window.location.origin + window.location.pathname;
  const linkParams = new URLSearchParams({
    action:     'contract',
    id:         String(contractId),
    factory:    CF_FACTORY_ADDR,
    chain:      String(CF_CHAIN_ID),
    client:     c && c.client ? c.client : '',
    contractor: c && c.contractor ? c.contractor : '',
    title:      c && c.title ? c.title : '',
    mode:       mode,
  });
  const shareLink   = `${baseUrl}?${linkParams.toString()}#contracts`;
  const mmLink      = `https://metamask.app.link/dapp/${window.location.host}${window.location.pathname}?${linkParams.toString()}`;
  const rainbowLink = `rainbow://dapp?url=${encodeURIComponent(shareLink)}`;
  const trustLink   = `trust://open_url?coin_id=60&url=${encodeURIComponent(shareLink)}`;
  const contractorEmail = meta.contractorEmail || '';

  const emailSubject = encodeURIComponent(`ARC Contract #${contractId} \u2014 A\u00e7\u00e3o Necess\u00e1ria`);
  const emailBody    = encodeURIComponent(
    'Ol\u00e1!\n\nVoc\u00ea foi convidado para interagir com o contrato ARC #' + contractId + '.\n\n' +
    'T\u00edtulo: ' + (c && c.title ? c.title : 'Sem t\u00edtulo') + '\n' +
    'Valor: $' + (c ? cfFmtUsdc(c.totalValue) : '?') + ' USDC\n' +
    'Rede: Arc Testnet (Chain ' + CF_CHAIN_ID + ')\n\n' +
    '=== ACESSO DIRETO ===\n' + shareLink + '\n\n' +
    '=== DEEP LINKS MOBILE ===\n' +
    'MetaMask Mobile: ' + mmLink + '\n' +
    'Rainbow: ' + rainbowLink + '\n\n' +
    'Se n\u00e3o tiver wallet, baixe MetaMask: https://metamask.io/download/\n\n' +
    'Factory: ' + CF_FACTORY_ADDR + '\nChain: ' + CF_CHAIN_ID
  );
  const emailLink = `mailto:${contractorEmail}?subject=${emailSubject}&body=${emailBody}`;

  document.getElementById('cf-walletlink-modal') && document.getElementById('cf-walletlink-modal').remove();
  const modal = document.createElement('div');
  modal.id = 'cf-walletlink-modal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm';
  modal.innerHTML = `
  <div style="background:#0a0c18;border:1px solid rgba(96,180,255,0.3);border-radius:20px;width:100%;max-width:500px;padding:24px;max-height:90vh;overflow-y:auto;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;">
      <h3 style="color:#dde2f0;font-size:15px;font-weight:800;display:flex;align-items:center;gap:8px;">
        <i class="fas fa-qrcode" style="color:#60b4ff;"></i>Wallet-Link &mdash; #${contractId}
      </h3>
      <button onclick="document.getElementById('cf-walletlink-modal').remove()"
        style="width:28px;height:28px;border-radius:8px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#6b7280;cursor:pointer;">&times;</button>
    </div>

    <div style="background:rgba(96,180,255,0.06);border:1px solid rgba(96,180,255,0.15);border-radius:10px;padding:10px 14px;margin-bottom:16px;font-size:11px;color:#60b4ff;">
      <i class="fas fa-info-circle mr-1"></i>
      Compartilhe com o contratado. Ele pode assinar, enviar prova ou interagir com o contrato
      <strong>sem MetaMask instalado</strong> &mdash; basta uma wallet mobile (Rainbow, Trust, MetaMask Mobile).
    </div>

    <div id="cf-wl-qr-container" style="text-align:center;margin-bottom:16px;min-height:220px;display:flex;align-items:center;justify-content:center;"></div>

    <div style="margin-bottom:14px;">
      <label style="font-size:11px;color:#3a4870;text-transform:uppercase;font-weight:700;margin-bottom:4px;display:block;">Link de Acesso Direto</label>
      <div style="display:flex;gap:6px;">
        <input id="cf-share-link-${contractId}" value="${shareLink.replace(/"/g,'&quot;')}" readonly
          style="flex:1;background:rgba(55,138,221,0.06);border:1px solid rgba(55,138,221,0.2);color:#dde2f0;border-radius:8px;padding:8px 10px;font-size:11px;font-family:monospace;outline:none;">
        <button onclick="var inp=document.getElementById('cf-share-link-${contractId}');if(inp){navigator.clipboard.writeText(inp.value).then(function(){showToast('Link copiado!','success')});}"
          style="padding:8px 12px;background:rgba(55,138,221,0.15);border:1px solid rgba(55,138,221,0.3);color:#60b4ff;border-radius:8px;cursor:pointer;font-size:11px;white-space:nowrap;">
          <i class="fas fa-copy mr-1"></i>Copiar
        </button>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;">
      <a href="${emailLink}" style="display:flex;align-items:center;justify-content:center;gap:6px;padding:10px;background:rgba(96,180,255,0.08);border:1px solid rgba(96,180,255,0.2);color:#60b4ff;border-radius:10px;font-size:12px;font-weight:600;text-decoration:none;">
        <i class="fas fa-envelope"></i>${contractorEmail ? 'Email Contratado' : 'Abrir Email'}
      </a>
      <a href="${mmLink}" target="_blank" rel="noopener" style="display:flex;align-items:center;justify-content:center;gap:6px;padding:10px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.2);color:#fbbf24;border-radius:10px;font-size:12px;font-weight:600;text-decoration:none;">
        <i class="fas fa-mobile-alt"></i>MetaMask Mobile
      </a>
      <a href="${rainbowLink}" target="_blank" rel="noopener" style="display:flex;align-items:center;justify-content:center;gap:6px;padding:10px;background:rgba(167,139,250,0.08);border:1px solid rgba(167,139,250,0.2);color:#a78bfa;border-radius:10px;font-size:12px;font-weight:600;text-decoration:none;">
        <i class="fas fa-mobile-alt"></i>Rainbow Wallet
      </a>
      <a href="${trustLink}" target="_blank" rel="noopener" style="display:flex;align-items:center;justify-content:center;gap:6px;padding:10px;background:rgba(52,211,153,0.08);border:1px solid rgba(52,211,153,0.2);color:#34d399;border-radius:10px;font-size:12px;font-weight:600;text-decoration:none;">
        <i class="fas fa-shield-alt"></i>Trust Wallet
      </a>
    </div>

    <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:12px;font-size:11px;margin-bottom:10px;">
      <div style="color:#3a4870;font-weight:700;text-transform:uppercase;margin-bottom:6px;letter-spacing:0.06em;">Detalhes do Contrato</div>
      <div style="color:#8899bb;margin-bottom:2px;">T&iacute;tulo: <span style="color:#dde2f0;">${c && c.title ? c.title.replace(/</g,'&lt;').replace(/>/g,'&gt;') : '&mdash;'}</span></div>
      <div style="color:#8899bb;margin-bottom:2px;">Valor: <span style="color:#dde2f0;">$${c ? cfFmtUsdc(c.totalValue) : '&mdash;'} USDC</span></div>
      <div style="color:#8899bb;margin-bottom:2px;">Modo: <span style="color:${CF_MODES[mode] ? CF_MODES[mode].color : '#dde2f0'};">${CF_MODES[mode] ? CF_MODES[mode].label : mode}</span></div>
      <div style="color:#8899bb;margin-bottom:2px;">Chain: <span style="color:#dde2f0;">Arc Testnet (${CF_CHAIN_ID})</span></div>
      <div style="color:#8899bb;">Contratado: <span style="font-family:monospace;color:#34d399;">${cfShort(c && c.contractor ? c.contractor : '')}</span></div>
      ${contractorEmail ? `<div style="color:#8899bb;margin-top:4px;">Email: <span style="color:#60b4ff;">${contractorEmail}</span></div>` : ''}
    </div>

    <p style="font-size:10px;color:#252a40;text-align:center;">
      <i class="fas fa-clock mr-1"></i>Link expira quando o contrato for conclu&iacute;do ou cancelado.
    </p>
  </div>`;
  document.body.appendChild(modal);

  // Inject QR code after modal is in DOM
  const qrContainer = document.getElementById('cf-wl-qr-container');
  if (qrContainer) {
    const qrEl = cfGenerateQrCanvas(shareLink, 200);
    qrContainer.appendChild(qrEl);
  }
}

// ─── Off-Chain Status Update Modal ────────────────────────────────────────────
function cfShowOffchainActions(contractId) {
  const meta = cfGetMeta(contractId);
  document.getElementById('cf-offchain-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'cf-offchain-modal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm';
  const mode = meta.mode || 'offchain';
  modal.innerHTML = `
  <div style="background:#0a0c18;border:1px solid rgba(251,191,36,0.3);border-radius:20px;width:100%;max-width:460px;padding:24px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;">
      <h3 style="color:#dde2f0;font-size:15px;font-weight:800;display:flex;align-items:center;gap:8px;">
        <i class="fas fa-tasks" style="color:#fbbf24;"></i>Atualizar Status — #${contractId}
      </h3>
      <button onclick="document.getElementById('cf-offchain-modal').remove()"
        style="width:28px;height:28px;border-radius:8px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#6b7280;cursor:pointer;">✕</button>
    </div>

    <div style="margin-bottom:14px;">
      <label style="font-size:11px;color:#3a4870;font-weight:700;display:block;margin-bottom:6px;">Status do Pagamento</label>
      <select id="cf-offchain-status" style="width:100%;background:rgba(255,255,255,0.04);border:1px solid rgba(251,191,36,0.3);color:#dde2f0;border-radius:8px;padding:9px 12px;font-size:13px;outline:none;">
        <option value="pending"   ${meta.offchainStatus==='pending'  ?'selected':''}>${t("cf_status_pending")}</option>
        <option value="in_custody" ${meta.offchainStatus==='in_custody'?'selected':''}>${t("cf_status_in_custody")}</option>
        <option value="paid"      ${meta.offchainStatus==='paid'     ?'selected':''}>💳 Paid — Pago (aguardando confirmação)</option>
        <option value="confirmed" ${meta.offchainStatus==='confirmed'?'selected':''}>✅ Confirmed — Confirmado</option>
        <option value="disputed"  ${meta.offchainStatus==='disputed' ?'selected':''}>${t("cf_status_disputed")}</option>
        <option value="released"  ${meta.offchainStatus==='released' ?'selected':''}>🎉 Released — Liberado</option>
      </select>
    </div>

    <div style="margin-bottom:14px;">
      <label style="font-size:11px;color:#3a4870;font-weight:700;display:block;margin-bottom:6px;">Nota de Pagamento</label>
      <textarea id="cf-offchain-note" placeholder="${t('cf_offchain_note_placeholder')}"
        style="width:100%;background:rgba(255,255,255,0.04);border:1px solid rgba(251,191,36,0.2);color:#dde2f0;border-radius:8px;padding:9px 12px;font-size:12px;outline:none;resize:vertical;min-height:72px;">${meta.paymentNote || ''}</textarea>
    </div>

    ${mode === 'custodial' ? `
    <div style="margin-bottom:14px;">
      <label style="font-size:11px;color:#3a4870;font-weight:700;display:block;margin-bottom:6px;">${t("contracts_custody_reference")}</label>
      <input id="cf-escrow-ref" type="text" placeholder="Ex: escrow-abc123, hash da tx, ID da plataforma…"
        value="${meta.escrowRef || ''}"
        style="width:100%;background:rgba(255,255,255,0.04);border:1px solid rgba(167,139,250,0.2);color:#dde2f0;border-radius:8px;padding:9px 12px;font-size:12px;outline:none;">
    </div>` : ''}

    <div style="display:flex;gap:10px;">
      <button onclick="cfSaveOffchainStatus(${contractId})" id="cf-offchain-save-btn"
        style="flex:1;background:linear-gradient(135deg,#92400e,#b45309);color:#fff;border:none;border-radius:12px;padding:11px;font-size:13px;font-weight:700;cursor:pointer;">
        <i class="fas fa-save mr-2"></i>Salvar Status
      </button>
      <button onclick="document.getElementById('cf-offchain-modal').remove()"
        style="padding:11px 18px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);color:#6b7280;border-radius:12px;cursor:pointer;font-size:13px;">Cancelar</button>
    </div>
  </div>`;
  document.body.appendChild(modal);
}

function cfSaveOffchainStatus(contractId) {
  const status   = document.getElementById('cf-offchain-status')?.value;
  const note     = document.getElementById('cf-offchain-note')?.value?.trim();
  const escrowRef = document.getElementById('cf-escrow-ref')?.value?.trim();

  cfSetMeta(contractId, {
    offchainStatus:   status,
    paymentNote:      note || cfGetMeta(contractId).paymentNote,
    ...(escrowRef ? { escrowRef } : {}),
    offchainUpdatedAt: Date.now(),
    offchainUpdatedBy: window.walletState?.address || 'unknown',
  });

  cfLogTx('offchainStatusUpdate', 'local-' + Date.now(), contractId, { status, note });
  document.getElementById('cf-offchain-modal')?.remove();
  showToast(`✅ Status atualizado: ${status}`, 'success');
  cfLoadContracts({ force: true });
}

// ─── Mark as Complete (release all milestones) ─────────────────────────────────
async function cfMarkComplete(contractId) {
  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Conecte sua carteira.', 'warning'); return; }
  if (cfState.pending) { showToast(t('contracts_pending_tx'), 'warning'); return; }

  const c = cfState.contracts.find(x => x.id === contractId);
  if (!c) { showToast(t('contracts_contract_not_found'), 'error'); return; }
  if (c.client?.toLowerCase() !== wallet.toLowerCase()) { showToast('❌ Apenas o cliente pode marcar como completo.', 'error'); return; }

  const meta = cfGetMeta(contractId);
  if (!meta.proofs?.length) { showToast(t('contracts_upload_proof_first'), 'warning'); return; }

  const milestones = c.milestones || [];
  const pending = milestones.filter(m => m.status === 'Pending');

  if (!window.confirm(
    `Mark Contract #${contractId} as COMPLETE?\n\n` +
    `This will release ${pending.length} pending milestone(s) to the contractor.\n` +
    `Platform fee (0.2%) = $${cfFmtUsdc(cfCalcFee(BigInt(c.totalValue)))} USDC will be deducted.\n` +
    `Net to contractor: $${cfFmtUsdc(cfNetAmount(BigInt(c.totalValue)))} USDC.\n\n` +
    t("contracts_irreversible_action")
  )) return;

  cfState.pending = true;
  try {
    // Release all pending milestones sequentially
    const init = await cfInitProvider();
    if (!init.ok) { showToast(`❌ ${init.message}`, 'error'); return; }

    for (let i = 0; i < milestones.length; i++) {
      if (milestones[i].status === 'Pending') {
        showToast(`📝 Releasing milestone ${i+1}/${milestones.length} — confirme na carteira…`, 'info');
        const tx = await init.factory.completeMilestone(contractId, i);
        cfLog(`Milestone ${i} tx submitted:`, tx.hash);
        cfLogTx('completeMilestone', tx.hash, contractId, { milestoneIdx: i });
        const r = await tx.wait(1);
        if (r.status !== 1) throw new Error(`Milestone ${i} tx revertida.`);
        cfLog(`Milestone ${i} released at block ${r.blockNumber}`);
      }
    }

    // Save completion metadata
    const completedAt = Date.now();
    cfSetMeta(contractId, {
      completedAt,
      receiptData: {
        contractId, title: c.title,
        client: c.client, contractor: c.contractor,
        clientEmail: meta.clientEmail || '', contractorEmail: meta.contractorEmail || '',
        totalValue: cfFmtUsdc(c.totalValue), feeValue: cfFmtUsdc(cfCalcFee(BigInt(c.totalValue))),
        netValue: cfFmtUsdc(cfNetAmount(BigInt(c.totalValue))),
        proofCount: meta.proofs.length, proofRefs: meta.proofs.map(p => p.name).join(', '),
        otcPoints: meta.otcPoints || '', otcTerms: meta.otcTerms || '',
        completedAt: new Date(completedAt).toLocaleString('pt-BR'),
        network: CF_NETWORK_NAME, chainId: CF_CHAIN_ID, factory: CF_FACTORY_ADDR,
      }
    });

    showToast(`✅ Contrato #${contractId} marcado como COMPLETO! Todos os milestones liberados.`, 'success');
    setTimeout(() => cfLoadContracts({ force: true }), 1500);
  } catch (err) {
    cfErr('cfMarkComplete error:', err);
    const rej = err.code === 4001 || err.code === 'ACTION_REJECTED';
    showToast(rej ? t('cf_tx_rejected') : `❌ ${err.reason || err.message}`, rej ? 'warning' : 'error');
  } finally {
    cfState.pending = false;
  }
}

// ─── Open Receipt in new tab (replaces Download PDF Receipt) ────────────────────
function cfOpenReceipt(contractId) {
  const c    = cfState.contracts.find(x => x.id === contractId);
  const meta = cfGetMeta(contractId);
  const r    = meta.receiptData || {};

  const receiptObj = {
    id:              'cf-' + contractId + '-' + Date.now(),
    contractId,
    title:           c?.title || r.title || 'Contract',
    network:         CF_NETWORK_NAME,
    chainId:         CF_CHAIN_ID,
    factory:         CF_FACTORY_ADDR,
    client:          c?.client || r.client || '',
    contractor:      c?.contractor || r.contractor || '',
    clientEmail:     meta.clientEmail || r.clientEmail || '',
    contractorEmail: meta.contractorEmail || r.contractorEmail || '',
    totalValue:      c ? cfFmtUsdc(c.totalValue) : r.totalValue || '?',
    feeValue:        c ? cfFmtUsdc(cfCalcFee(BigInt(c?.totalValue || 0))) : r.feeValue || '?',
    netValue:        c ? cfFmtUsdc(cfNetAmount(BigInt(c?.totalValue || 0))) : r.netValue || '?',
    otcPoints:       meta.otcPoints || '',
    otcTerms:        meta.otcTerms  || '',
    proofs:          meta.proofs    || [],
    completedAt:     r.completedAt  || new Date().toLocaleString(),
    _type:           'contract',
  };

  if (typeof arcSaveContractReceipt === 'function') arcSaveContractReceipt(receiptObj).catch(() => {});

  if (typeof arcViewContractReceipt === 'function') {
    arcViewContractReceipt(receiptObj);
    return;
  }
  // Fallback to legacy HTML receipt
  cfDownloadReceipt(contractId);
}

// ─── Download Receipt (legacy — now opens in new tab) ───────────────────────────
function cfDownloadReceipt(contractId) {
  const c    = cfState.contracts.find(x => x.id === contractId);
  const meta = cfGetMeta(contractId);
  const r    = meta.receiptData || {};

  const total    = c ? cfFmtUsdc(c.totalValue) : r.totalValue || '?';
  const fee      = c ? cfFmtUsdc(cfCalcFee(BigInt(c?.totalValue || 0))) : r.feeValue || '?';
  const net      = c ? cfFmtUsdc(cfNetAmount(BigInt(c?.totalValue || 0))) : r.netValue || '?';
  const title    = c?.title || r.title || 'Contract';
  const proofs   = meta.proofs || [];
  const now      = new Date().toLocaleString('pt-BR');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>ARC Contract Receipt #${contractId}</title>
<style>
  body { font-family: 'Courier New', monospace; background: #fff; color: #111; padding: 40px; max-width: 700px; margin: 0 auto; }
  .header { text-align: center; border-bottom: 3px solid #1565c0; padding-bottom: 20px; margin-bottom: 28px; }
  .header h1 { font-size: 24px; color: #1565c0; margin: 0 0 4px; }
  .header p { color: #666; font-size: 12px; margin: 0; }
  .badge { display: inline-block; background: #d4edda; color: #155724; border: 1px solid #c3e6cb; border-radius: 4px; padding: 4px 14px; font-size: 13px; font-weight: bold; margin-top: 10px; }
  .section { margin-bottom: 24px; }
  .section h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.1em; color: #1565c0; border-bottom: 1px solid #e0e0e0; padding-bottom: 6px; margin-bottom: 12px; }
  .row { display: flex; justify-content: space-between; padding: 5px 0; border-bottom: 1px solid #f5f5f5; font-size: 12px; }
  .row .label { color: #666; }
  .row .value { font-weight: bold; color: #111; text-align: right; max-width: 60%; word-break: break-all; }
  .fee-box { background: #fff8e1; border: 1px solid #ffe082; border-radius: 6px; padding: 12px 16px; margin-top: 8px; }
  .fee-box .total { font-size: 18px; font-weight: bold; color: #1565c0; }
  .proof-item { padding: 6px 0; border-bottom: 1px solid #f5f5f5; font-size: 11px; color: #333; }
  .footer { text-align: center; margin-top: 40px; padding-top: 16px; border-top: 2px solid #1565c0; font-size: 10px; color: #999; }
  @media print { body { padding: 20px; } }
</style>
</head>
<body>
<div class="header">
  <h1>⛓ ARC CONTRACT RECEIPT</h1>
  <p>Arc Network Testnet · Trustless Escrow · On-Chain Verified</p>
  <div class="badge">✅ COMPLETED</div>
</div>

<div class="section">
  <h2>Contract Details</h2>
  <div class="row"><span class="label">Contract ID</span><span class="value">#${contractId}</span></div>
  <div class="row"><span class="label">Title</span><span class="value">${title}</span></div>
  <div class="row"><span class="label">Network</span><span class="value">${CF_NETWORK_NAME} (Chain ${CF_CHAIN_ID})</span></div>
  <div class="row"><span class="label">Factory</span><span class="value">${CF_FACTORY_ADDR}</span></div>
  <div class="row"><span class="label">Completed At</span><span class="value">${r.completedAt || now}</span></div>
  <div class="row"><span class="label">Generated At</span><span class="value">${now}</span></div>
</div>

<div class="section">
  <h2>Parties</h2>
  <div class="row"><span class="label">Client Wallet</span><span class="value">${c?.client || r.client || '—'}</span></div>
  ${(meta.clientEmail || r.clientEmail) ? `<div class="row"><span class="label">Client Email</span><span class="value">${meta.clientEmail || r.clientEmail}</span></div>` : ''}
  <div class="row"><span class="label">Contractor Wallet</span><span class="value">${c?.contractor || r.contractor || '—'}</span></div>
  ${(meta.contractorEmail || r.contractorEmail) ? `<div class="row"><span class="label">Contractor Email</span><span class="value">${meta.contractorEmail || r.contractorEmail}</span></div>` : ''}
</div>

<div class="section">
  <h2>Financial Summary</h2>
  <div class="fee-box">
    <div class="row" style="border:none;padding:4px 0;"><span class="label">Total Contract Value</span><span class="value total">$${total} USDC</span></div>
    <div class="row" style="border:none;padding:4px 0;"><span class="label">Platform Fee (0.2%)</span><span class="value" style="color:#e65100;">−$${fee} USDC</span></div>
    <div class="row" style="border:none;padding:4px 0;border-top:1px solid #ffe082;margin-top:4px;"><span class="label" style="font-weight:bold;">Net to Contractor</span><span class="value" style="color:#2e7d32;font-size:16px;">$${net} USDC</span></div>
  </div>
</div>

${meta.otcPoints ? `<div class="section">
  <h2>OTC Negotiation</h2>
  <div class="row"><span class="label">Points/Tokens</span><span class="value">${meta.otcPoints}</span></div>
  ${meta.otcTerms ? `<div class="row"><span class="label">Terms</span><span class="value">${meta.otcTerms}</span></div>` : ''}
</div>` : ''}

<div class="section">
  <h2>Proof of Work (${proofs.length} file${proofs.length !== 1 ? 's' : ''})</h2>
  ${proofs.length ? proofs.map((p, i) => `<div class="proof-item">${i+1}. ${p.name} ${p.cid ? `— IPFS: ${p.cid}` : '(stored locally)'} — ${new Date(p.uploadedAt).toLocaleString('pt-BR')}</div>`).join('') : '<p style="color:#999;font-size:12px;">No proof files.</p>'}
</div>

<div class="footer">
  <p>This receipt was generated by the ARC Contracts Module v5.</p>
  <p>All on-chain data is verifiable at <strong>testnet.arcscan.app</strong></p>
  <p style="margin-top:8px;color:#bbb;">Contract #${contractId} · ${CF_FACTORY_ADDR}</p>
</div>
</body></html>`;

  // Open in new tab (no auto-download)
  if (typeof arcOpenReceiptTab === 'function') {
    arcOpenReceiptTab(html, `Contract Receipt #${contractId}`);
    return;
  }
  // Fallback: write to new window
  const win = window.open('', '_blank');
  if (win) {
    win.document.write(html);
    win.document.close();
    setTimeout(() => win.print(), 500);
  } else {
    const blob = new Blob([html], { type: 'text/html' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url; a.download = `arc-contract-${contractId}-receipt.html`; a.click();
    URL.revokeObjectURL(url);
  }
}

// ─── Show tx badge ─────────────────────────────────────────────────────────────
function cfShowTxBadge(hash, label = '') {
  try {
    const existing = document.getElementById('cf-tx-badge');
    if (existing) existing.remove();
    const badge = document.createElement('div');
    badge.id = 'cf-tx-badge';
    badge.style.cssText = 'position:fixed;bottom:80px;right:20px;z-index:9999;background:rgba(8,11,24,0.95);border:1px solid rgba(52,211,153,0.3);border-radius:12px;padding:10px 14px;max-width:340px;box-shadow:0 0 20px rgba(52,211,153,0.15);';
    badge.innerHTML = `<div style="font-size:10px;color:#34d399;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">✅ ${label || 'Transaction Confirmed'}</div>
      <a href="${CF_EXPLORER}/tx/${hash}" target="_blank" style="font-size:11px;color:#60b4ff;font-family:monospace;display:flex;align-items:center;gap:4px;">
        <i class="fas fa-external-link-alt" style="font-size:9px;"></i>${hash.slice(0, 20)}…${hash.slice(-8)}
      </a>`;
    document.body.appendChild(badge);
    setTimeout(() => badge.remove(), 8000);
  } catch { /* non-critical */ }
}

// ─── Generic run-transaction wrapper ──────────────────────────────────────────
async function cfRunTx(label, fn, contractId = null) {
  try {
    const init = await cfInitProvider();
    if (!init.ok) { showToast(`❌ ${init.message}`, 'error'); return null; }
    if (!window.confirm(`Confirm transaction:\n${label}\n\nThis requires a wallet signature.`)) return null;
    showToast(`📝 ${label} — confirme na carteira…`, 'info');
    const tx = await fn(init);
    cfLog(`${label} tx submitted:`, tx.hash);
    if (contractId !== null) cfLogTx(label, tx.hash, contractId);
    showToast(t('cf_awaiting_confirmation'), 'info');
    const receipt = await tx.wait(1);
    if (receipt.status !== 1) throw new Error('Transação revertida on-chain.');
    cfLog(`${label} confirmed! Block: ${receipt.blockNumber}`);
    showToast(`✅ ${label} — confirmado! Bloco #${receipt.blockNumber}.`, 'success');
    cfShowTxBadge(receipt.hash, label);
    return receipt;
  } catch (err) {
    cfErr('cfRunTx error:', err);
    const rej = err.code === 4001 || err.code === 'ACTION_REJECTED';
    showToast(rej ? t('cf_tx_rejected') : `❌ ${err.reason || err.message}`, rej ? 'warning' : 'error');
    return null;
  }
}

// ─── Ensure USDC approval ──────────────────────────────────────────────────────
async function cfEnsureApproval(init, amountRaw, stepFn = null) {
  const allowance = await cfReadAllowance(init.address, CF_FACTORY_ADDR);
  if (allowance >= amountRaw) {
    cfLog('Allowance already sufficient:', cfFmtUsdc(allowance), '>= required:', cfFmtUsdc(amountRaw));
    return { alreadyApproved: true };
  }
  cfLog(`Need approval: current=$${cfFmtUsdc(allowance)} required=$${cfFmtUsdc(amountRaw)}`);
  if (stepFn) stepFn(2, 'active', 'Approving USDC — sign in wallet…');
  else cfSetStep(2, 'active', 'Approve USDC — sign in wallet…');
  showToast('📝 Aprovando USDC para ContractFactory — confirme na carteira…', 'info');
  const tx = await init.usdc.approve(CF_FACTORY_ADDR, amountRaw);
  cfLog('✅ Approve tx submitted:', tx.hash);
  cfLogTx('approve', tx.hash, null, { amount: cfFmtUsdc(amountRaw) });
  if (stepFn) stepFn(2, 'active', `Waiting approval: ${tx.hash.slice(0, 14)}…`);
  else cfSetStep(2, 'active', `Waiting: ${tx.hash.slice(0, 14)}…`);
  const r = await tx.wait(1);
  if (r.status !== 1) throw new Error('Approve revertida on-chain.');
  cfLog('✅ Approval confirmed at block', r.blockNumber);
  if (stepFn) stepFn(2, 'done');
  else cfSetStep(2, 'done');
  return { alreadyApproved: false, txHash: tx.hash, block: r.blockNumber };
}

// ─── Deposit modal ─────────────────────────────────────────────────────────────
async function cfShowDepositModal(contractId) {
  const c = cfState.contracts.find(x => x.id === contractId);
  if (!c) { showToast(t('contracts_contract_not_found'), 'error'); return; }

  // Fetch live on-chain deposited value before showing modal
  let liveDeposited = BigInt(c.depositedValue);
  if (cfState._factory) {
    try {
      const onChain = await cfReadDepositedBalance(contractId);
      if (onChain !== null) {
        liveDeposited = onChain;
        c.depositedValue = liveDeposited.toString();
        cfLog(`Deposit modal: live depositedValue=$${cfFmtUsdc(liveDeposited)}`);
      }
    } catch (e) { cfWarn('Could not fetch live deposit:', e.message); }
  }

  const remaining   = BigInt(c.totalValue) - liveDeposited;
  const humanRemain = (Number(remaining) / 1e6).toFixed(2);
  const humanTotal  = cfFmtUsdc(c.totalValue);
  const humanDep    = cfFmtUsdc(liveDeposited);

  document.getElementById('cf-deposit-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'cf-deposit-modal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm';
  modal.innerHTML = `
  <div style="background:#0a0c18;border:1px solid rgba(55,138,221,0.3);border-radius:20px;width:100%;max-width:440px;padding:24px;box-shadow:0 0 40px rgba(55,138,221,0.15);">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
      <h3 style="color:#dde2f0;font-size:15px;font-weight:800;display:flex;align-items:center;gap:8px;">
        <i class="fas fa-arrow-circle-down" style="color:#a78bfa;"></i>Deposit USDC — #${contractId}
      </h3>
      <button onclick="document.getElementById('cf-deposit-modal').remove()"
        style="width:28px;height:28px;border-radius:8px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);color:#6b7280;cursor:pointer;display:flex;align-items:center;justify-content:center;">
        <i class="fas fa-times text-xs"></i></button>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:16px;text-align:center;">
      <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:10px;">
        <div style="font-size:10px;color:#3a4870;margin-bottom:3px;">Total</div>
        <div style="font-size:13px;font-weight:800;color:#dde2f0;">$${humanTotal}</div>
      </div>
      <div style="background:rgba(34,211,238,0.05);border:1px solid rgba(34,211,238,0.15);border-radius:10px;padding:10px;">
        <div style="font-size:10px;color:#3a4870;margin-bottom:3px;">Deposited</div>
        <div style="font-size:13px;font-weight:800;color:#67e8f9;">$${humanDep}</div>
      </div>
      <div style="background:rgba(167,139,250,0.06);border:1px solid rgba(167,139,250,0.2);border-radius:10px;padding:10px;">
        <div style="font-size:10px;color:#a78bfa;margin-bottom:3px;">Remaining</div>
        <div style="font-size:13px;font-weight:800;color:#c4b5fd;">$${humanRemain}</div>
      </div>
    </div>
    <div style="margin-bottom:14px;">
      <label style="font-size:10px;color:#3a4870;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;display:block;margin-bottom:6px;">Amount (USDC)</label>
      <div style="position:relative;">
        <input id="cf-deposit-amount" type="number" value="${humanRemain}" step="0.01" min="0.01" max="${humanRemain}"
          style="width:100%;background:rgba(255,255,255,0.04);border:1px solid rgba(55,138,221,0.25);border-radius:10px;padding:10px 60px 10px 12px;color:#dde2f0;font-size:14px;font-family:monospace;outline:none;box-sizing:border-box;" />
        <button onclick="document.getElementById('cf-deposit-amount').value='${humanRemain}'"
          style="position:absolute;right:8px;top:50%;transform:translateY(-50%);font-size:10px;color:#a78bfa;background:rgba(167,139,250,0.1);border:1px solid rgba(167,139,250,0.2);padding:2px 8px;border-radius:6px;cursor:pointer;">MAX</button>
      </div>
    </div>
    <div id="cf-deposit-steps" style="display:none;margin-bottom:14px;background:rgba(255,255,255,0.02);border:1px solid rgba(55,138,221,0.1);border-radius:10px;padding:12px;">
      <p style="font-size:10px;color:#3a4870;text-transform:uppercase;font-weight:700;margin-bottom:8px;">Progress</p>
      ${[['fa-network-wired','Verify Arc Testnet'],['fa-coins','Check balance'],['fa-check-double','Approve USDC'],['fa-paper-plane','Send deposit'],['fa-hourglass-half','Awaiting confirmation'],['fa-check-circle','Confirmed']].map((s,i) => `
        <div id="cf-dep-step-${i}" class="ct-step ct-step-idle flex items-center gap-2 mb-1">
          <div class="ct-step-icon w-5 h-5 rounded-full flex items-center justify-center text-[9px] flex-shrink-0"><i class="fas ${s[0]}"></i></div>
          <span style="font-size:11px;">${s[1]}</span>
        </div>`).join('')}
      <div id="cf-dep-tx-link" style="display:none;font-size:11px;margin-top:6px;padding-top:6px;border-top:1px solid rgba(55,138,221,0.1);"></div>
    </div>
    <div style="display:flex;gap:10px;">
      <button onclick="cfExecuteDeposit(${contractId})" id="cf-deposit-btn"
        style="flex:1;background:linear-gradient(135deg,#6d28d9,#5b21b6);color:#fff;border:none;border-radius:12px;padding:12px;font-size:13px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;">
        <i class="fas fa-arrow-circle-down"></i>Deposit USDC
      </button>
      <button onclick="document.getElementById('cf-deposit-modal').remove()"
        style="padding:12px 18px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);color:#6b7280;border-radius:12px;cursor:pointer;font-size:13px;">Cancel</button>
    </div>
    <p style="font-size:10px;color:#252a40;margin-top:10px;display:flex;align-items:center;gap:4px;">
      <i class="fas fa-shield-alt"></i>Funds locked in ContractFactory escrow. No private key stored.
    </p>
  </div>`;
  document.body.appendChild(modal);
  setTimeout(() => document.getElementById('cf-deposit-amount')?.focus(), 100);
}

function cfSetDepStep(n, status = 'active', detail = '') {
  const panel = document.getElementById('cf-deposit-steps');
  if (panel) panel.style.display = 'block';
  for (let i = 0; i <= 5; i++) {
    const el = document.getElementById(`cf-dep-step-${i}`);
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

function cfDepositToContract(contractId) {
  // In ContractFactory.sol, USDC is pulled in full during createContract().
  // There is no separate depositToContract function on-chain.
  // The funds are already deposited when the contract is created.
  const c = cfState.contracts.find(x => x.id === contractId);
  const deposited = c ? `$${cfFmtUsdc(c.depositedValue)} USDC` : 'valor desconhecido';
  showToast(t('cf_contract_already_deposited', contractId, deposited), 'info');
  cfLog(`[INFO] depositToContract called but funds are already deposited at creation. Contract #${contractId} depositedValue=${c?.depositedValue}`);
}

async function cfExecuteDeposit(contractId) {
  // Not used — depositToContract does not exist in ContractFactory.sol.
  // Funds are deposited automatically during createContract().
  showToast(t('cf_deposit_auto_on_creation'), 'info');
  cfLog('[INFO] cfExecuteDeposit: no depositToContract function on-chain — funds are deposited at createContract time.');
}

// ─── Withdraw (informativo — fundos são enviados direto em completeMilestone) ──
async function cfWithdrawFromContract(contractId) {
  // In ContractFactory.sol there is NO withdrawFromContract function.
  // Payment is sent to the contractor automatically when the client calls completeMilestone().
  // Show the milestones status to the contractor so they can see what was released.
  const c = cfState.contracts.find(x => x.id === contractId);
  const released = (c?.milestones || []).filter(m => m.status === 'Released');
  const pending  = (c?.milestones || []).filter(m => m.status === 'Pending');
  const relTotal = released.reduce((s, m) => s + BigInt(m.amount), 0n);
  cfLog(`[INFO] cfWithdrawFromContract: no separate withdraw fn. Released milestones: ${released.length}, total=$${cfFmtUsdc(relTotal)}`);
  if (released.length > 0) {
    showToast(t('cf_milestones_released', released.length, cfFmtUsdc(relTotal), pending.length), 'info');
  } else {
    showToast(t('cf_no_milestone_released_yet'), 'info');
  }
}

async function cfExecuteWithdraw(contractId, releasedAmt) {
  // Stub — no withdrawFromContract on-chain.
  showToast(t('cf_payments_automatic'), 'info');
  cfLog('[INFO] cfExecuteWithdraw: no withdrawFromContract function in ContractFactory.sol.');
}

// ─── Release milestone ─────────────────────────────────────────────────────────
async function cfReleaseMilestone(contractId, milestoneIdx) {
  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Conecte sua carteira.', 'warning'); return; }
  if (cfState.pending) { showToast('Aguarde.', 'warning'); return; }
  // Block during active dispute
  if (cfGetDisputeStatus(contractId) === 'open') {
    showToast('❌ Fundos bloqueados — disputa ativa. Resolva a disputa primeiro.', 'error'); return;
  }
  const c = cfState.contracts.find(x => x.id === contractId);
  if (c?.client?.toLowerCase() !== wallet.toLowerCase()) { showToast('❌ Apenas o cliente pode liberar.', 'error'); return; }
  const ms = c?.milestones?.[milestoneIdx];
  const humanAmt = ms ? cfFmtUsdc(ms.amount) : '?';
  if (!window.confirm(`Release Milestone ${milestoneIdx+1} — $${humanAmt} USDC?\n\nEsta ação é irreversível.`)) return;

  cfState.pending = true;
  try {
    const receipt = await cfRunTx(`Release Milestone ${milestoneIdx+1} — $${humanAmt} USDC`, async({factory}) => factory.completeMilestone(contractId, milestoneIdx), contractId);
    if (receipt) setTimeout(() => cfLoadContracts({ force: true }), 1500);
  } finally { cfState.pending = false; }
}

// ─── Sign contract ─────────────────────────────────────────────────────────────
async function cfSignContract(contractId) {
  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Conecte sua carteira.', 'warning'); return; }
  if (cfState.pending) { showToast('Aguarde.', 'warning'); return; }
  const c = cfState.contracts.find(x => x.id === contractId);
  if (c?.contractor?.toLowerCase() !== wallet.toLowerCase()) { showToast('❌ Apenas o contratado pode assinar.', 'error'); return; }

  cfState.pending = true;
  try {
    const receipt = await cfRunTx(`Sign Contract #${contractId}`, async({factory}) => factory.signContract(contractId), contractId);
    if (receipt) setTimeout(() => cfLoadContracts({ force: true }), 1500);
  } finally { cfState.pending = false; }
}

// ─── Cancel contract ───────────────────────────────────────────────────────────
async function cfCancelContract(contractId) {
  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Conecte sua carteira.', 'warning'); return; }
  if (cfState.pending) { showToast('Aguarde.', 'warning'); return; }
  const c = cfState.contracts.find(x => x.id === contractId);
  if (c?.client?.toLowerCase() !== wallet.toLowerCase()) { showToast('❌ Apenas o cliente pode cancelar.', 'error'); return; }
  if (!window.confirm(`Cancel Contract #${contractId}?\n\n$${c ? cfFmtUsdc(c.depositedValue) : '?'} USDC será devolvido.\nEsta ação é irreversível.`)) return;

  cfState.pending = true;
  try {
    const receipt = await cfRunTx(`Cancel Contract #${contractId}`, async({factory}) => factory.cancelContract(contractId), contractId);
    if (receipt) setTimeout(() => cfLoadContracts({ force: true }), 1500);
  } finally { cfState.pending = false; }
}

// ─── Create Contract — Mode Selector ──────────────────────────────────────────
function cfGetSelectedMode() {
  const el = document.getElementById('cf-contract-mode');
  return el ? el.value : 'onchain';
}

// ─── Off-chain / Custodial Contract Creation (no blockchain tx) ───────────────
async function cfCreateOffchainContract(mode) {
  const wallet = window.walletState?.address || 'local-' + Date.now();

  const contractor      = (document.getElementById('cf-contractor')?.value || '').trim();
  const title           = (document.getElementById('cf-title')?.value || '').trim();
  const totalValue      = (document.getElementById('cf-value')?.value || '').trim();
  const clientEmail     = (document.getElementById('cf-client-email')?.value || '').trim();
  const contractorEmail = (document.getElementById('cf-contractor-email')?.value || '').trim();
  const otcEnabled      = document.getElementById('cf-otc-toggle')?.checked;
  const otcPoints       = (document.getElementById('cf-otc-points')?.value || '').trim();
  const otcTerms        = (document.getElementById('cf-otc-terms')?.value || '').trim();
  const msRows          = document.querySelectorAll('.cf-milestone-row');

  if (!contractor || !title || !totalValue) { showToast(t('cf_fill_required_fields'), 'warning'); return; }
  const humanAmount = parseFloat(totalValue);
  if (isNaN(humanAmount) || humanAmount <= 0) { showToast('Valor deve ser maior que 0.', 'error'); return; }

  const milestoneDescs   = [];
  const milestoneAmounts = [];
  msRows.forEach(row => {
    const d = row.querySelector('.cf-ms-desc')?.value?.trim();
    const a = parseFloat(row.querySelector('.cf-ms-amt')?.value || '0');
    if (d && a > 0) { milestoneDescs.push(d); milestoneAmounts.push(a); }
  });
  if (!milestoneDescs.length) { showToast('Adicione pelo menos 1 milestone.', 'warning'); return; }

  // Generate a local off-chain ID (negative to distinguish from on-chain)
  const localId   = -(Date.now() % 1000000);
  const paymentNote = mode === 'offchain' ? `Off-Chain Payment — $${humanAmount} USDC` : `Custodial Escrow — $${humanAmount} USDC`;
  const escrowRef   = mode === 'custodial' ? 'CUST-' + Date.now().toString(36).toUpperCase() : '';

  const meta = {
    mode,
    clientEmail,
    contractorEmail,
    otcPoints: otcEnabled ? otcPoints : '',
    otcTerms:  otcEnabled ? otcTerms  : '',
    proofs: [],
    createdAt:       Date.now(),
    offchainStatus:  'pending',
    paymentNote,
    escrowRef,
    localId,
    createdByWallet: wallet,
    milestoneDescs,
    milestoneAmounts,
  };
  cfSetMeta(localId, meta);

  const syntheticContract = {
    id:                  localId,
    client:              wallet,
    contractor:          contractor,
    title:               title,
    totalValue:          BigInt(Math.round(humanAmount * 1e6)),
    depositedValue:      0n,
    statusCode:          0,
    status:              'Draft',
    contractorSigned:    false,
    createdAt:           Math.floor(Date.now() / 1000),
    startedAt:           0,
    completedAt:         0,
    milestoneCount:      milestoneDescs.length,
    completedMilestones: 0,
    milestones:          milestoneDescs.map((d, i) => ({
      id: i, description: d,
      amount: BigInt(Math.round((milestoneAmounts[i] || 0) * 1e6)),
      status: 'Pending', releasedAt: 0,
    })),
    _isOffchain: true,
    _fetchedAt: Date.now(),
  };

  cfState.contracts = [...cfState.contracts.filter(x => x.id !== localId), syntheticContract];

  // Persist to localStorage
  try {
    const offchainKey = 'arc_cf_offchain_v1';
    const all = JSON.parse(localStorage.getItem(offchainKey) || '[]');
    const idx = all.findIndex(x => x.id === localId);
    if (idx >= 0) all[idx] = syntheticContract; else all.unshift(syntheticContract);
    localStorage.setItem(offchainKey, JSON.stringify(all.slice(0, 100)));
  } catch(e) { cfErr('cfCreateOffchainContract persist:', e); }

  cfLogTx('createOffchain', 'local-' + localId, localId, { mode, title, totalValue: humanAmount });

  const modeInfo = CF_MODES[mode] || CF_MODES.offchain;
  showToast(`✅ Contrato ${modeInfo.label} criado! ID local: ${localId}.`, 'success');

  // Reset form
  ['cf-title','cf-contractor','cf-value','cf-client-email','cf-contractor-email'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  cfResetMilestones();
  cfUpdateFeePreview();

  cfRenderContracts(cfState.contracts, wallet);
  cfRenderSummary(cfState.contracts, wallet);
}

// ─── Load off-chain contracts from localStorage ────────────────────────────────
function cfLoadOffchainContracts() {
  try {
    const all = JSON.parse(localStorage.getItem('arc_cf_offchain_v1') || '[]');
    return all.map(c => ({
      ...c,
      totalValue:     BigInt(c.totalValue || 0),
      depositedValue: BigInt(c.depositedValue || 0),
      milestones:     (c.milestones || []).map(m => ({ ...m, amount: BigInt(m.amount || 0) })),
    }));
  } catch(e) { return []; }
}

// ─── Create contract (v6: on-chain escrow + off-chain/custodial modes) ────────
async function cfCreateContract() {
  if (cfState.pending) { showToast(t('contracts_await_tx'), 'warning'); return; }
  const wallet = window.walletState?.address;
  if (!wallet) { showToast(t('cf_connect_wallet_warning'), 'warning'); return; }

  const contractMode = cfGetSelectedMode();
  if (contractMode !== 'onchain') {
    return cfCreateOffchainContract(contractMode);
  }

  // Network pre-check
  const netCheck = await cfInitProvider();
  if (!netCheck.ok && netCheck.error === 'wrong_network') {
    showToast('❌ Rede incorreta. Troque para Arc Testnet primeiro.', 'error');
    cfUpdateNetworkBanner(false);
    return;
  }

  const contractor       = cfEl('cf-contractor')?.value?.trim();
  const title            = cfEl('cf-title')?.value?.trim();
  const totalValue       = cfEl('cf-value')?.value?.trim();
  const clientEmail      = cfEl('cf-client-email')?.value?.trim();
  const contractorEmail  = cfEl('cf-contractor-email')?.value?.trim();
  const otcEnabled       = cfEl('cf-otc-toggle')?.checked;
  const otcPoints        = cfEl('cf-otc-points')?.value?.trim();
  const otcTerms         = cfEl('cf-otc-terms')?.value?.trim();
  const msRows           = document.querySelectorAll('.cf-milestone-row');

  // Validations
  if (!contractor || !title || !totalValue) { showToast(t('cf_fill_required_fields'), 'warning'); return; }
  if (!/^0x[0-9a-fA-F]{40}$/.test(contractor)) { showToast(t('cf_invalid_contractor_address'), 'error'); return; }
  if (contractor.toLowerCase() === wallet.toLowerCase()) { showToast(t('cf_client_contractor_same'), 'error'); return; }

  const humanAmount = parseFloat(totalValue);
  if (isNaN(humanAmount) || humanAmount <= 0) { showToast('Valor deve ser maior que 0.', 'error'); return; }
  if (humanAmount < 1) { showToast(t('cf_min_value'), 'error'); return; }

  if (clientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) { showToast(t('cf_invalid_client_email'), 'error'); return; }
  if (contractorEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contractorEmail)) { showToast(t('cf_invalid_contractor_email'), 'error'); return; }

  const milestoneDescs   = [];
  const milestoneAmounts = [];
  msRows.forEach(row => {
    const d = row.querySelector('.cf-ms-desc')?.value?.trim();
    const a = parseFloat(row.querySelector('.cf-ms-amt')?.value || '0');
    if (d && a > 0) { milestoneDescs.push(d); milestoneAmounts.push(cfParseUsdc(a)); }
  });

  if (!milestoneDescs.length) { showToast('Adicione pelo menos 1 milestone.', 'warning'); return; }
  if (milestoneDescs.length > 10) { showToast(t('cf_max_10_milestones'), 'error'); return; }

  const totalRaw = cfParseUsdc(humanAmount);
  const sumMs    = milestoneAmounts.reduce((a, b) => a + b, 0n);
  if (sumMs !== totalRaw) {
    const diff = Math.abs(Number(totalRaw - sumMs)) / 1e6;
    showToast(t('cf_milestone_sum_mismatch', Number(sumMs)/1e6, humanAmount, diff.toFixed(6)), 'error');
    return;
  }

  // Fee preview
  const feeRaw = cfCalcFee(totalRaw);
  const netRaw = cfNetAmount(totalRaw);

  cfState.pending = true;
  const btn = cfEl('cf-submit-btn');
  if (btn) { btn.disabled=true; btn.innerHTML='<i class="fas fa-spinner fa-spin mr-2"></i>Processando…'; }

  const unlock = () => {
    cfState.pending = false;
    if (btn) { btn.disabled=false; btn.innerHTML='<i class="fas fa-file-signature mr-2"></i>Create Contract On-Chain'; }
  };

  try {
    cfSetStep(0);
    const init = await cfInitProvider();
    if (!init.ok) {
      if (init.error === 'wrong_network') { showToast('Rede incorreta. Troque para Arc Testnet.', 'error'); cfShowListState('wrong_network', init.message); }
      else showToast(`❌ ${init.message}`, 'error');
      unlock(); return;
    }
    const { factory, usdc, address: fromAddr } = init;

    cfSetStep(1, 'active', 'Verificar saldo USDC');
    const balance = await cfReadBalance(fromAddr);
    if (balance < totalRaw) throw new Error(`Saldo insuficiente: $${cfFmtUsdc(balance)} disponível, $${humanAmount} necessário.`);
    cfSetStep(1, 'done');

    cfSetStep(2, 'active', 'Verificar allowance USDC');
    await cfEnsureApproval(init, totalRaw);
    cfSetStep(2, 'done');

    cfSetStep(3, 'active', 'Estimando gas…');
    let gasLimit;
    try {
      gasLimit = await factory.createContract.estimateGas(contractor, title, totalRaw, milestoneDescs, milestoneAmounts);
      gasLimit = (gasLimit * 125n) / 100n;
    } catch(e) { cfWarn('estimateGas failed:', e.message); gasLimit = 500000n; }
    let feeData;
    try { feeData = await init.provider.getFeeData(); } catch { feeData = { gasPrice: null }; }
    const gasPrice = feeData?.gasPrice ?? 10000000000n;
    const gasFeeUsdc = (Number(gasLimit * gasPrice) / 1e6).toFixed(6);
    showToast(`⛽ Gas: ${gasFeeUsdc} USDC. Fee: $${cfFmtUsdc(feeRaw)}. Net: $${cfFmtUsdc(netRaw)}. Confirme…`, 'info');
    cfSetStep(3, 'done');

    cfSetStep(4, 'active', 'Aguardando assinatura…');
    const createTx = await factory.createContract(contractor, title, totalRaw, milestoneDescs, milestoneAmounts, { gasLimit });
    cfState.lastTxHash = createTx.hash;
    showToast(`📤 Tx: <a href="${CF_EXPLORER}/tx/${createTx.hash}" target="_blank" class="underline font-mono">${createTx.hash.slice(0,18)}…</a>`, 'info');
    cfSetStep(4, 'done');

    cfSetStep(5, 'active', 'Aguardando confirmação…');
    const receipt = await createTx.wait(1);
    if (receipt.status !== 1) throw new Error(`Tx revertida no bloco #${receipt.blockNumber}.`);

    // Extract new contract ID from ContractCreated event
    // Event sig (7 params, matches ContractFactory.sol):
    //   ContractCreated(uint256 indexed contractId, address indexed client,
    //                   address indexed contractor, string title,
    //                   uint256 totalValue, uint256 milestoneCount, uint256 timestamp)
    let newId = null;
    try {
      const iface = new window.ethers.Interface([
        'event ContractCreated(uint256 indexed contractId, address indexed client, address indexed contractor, string title, uint256 totalValue, uint256 milestoneCount, uint256 timestamp)',
      ]);
      for (const log of receipt.logs) {
        try {
          const d = iface.parseLog(log);
          if (d?.name === 'ContractCreated') {
            newId = Number(d.args[0]); // args[0] = contractId
            cfLog(`ContractCreated event parsed: id=${newId} title="${d.args[3]}" total=${d.args[4]} milestones=${d.args[5]}`);
            break;
          }
        } catch { /* log from a different contract, skip */ }
      }
      if (newId === null) cfWarn('ContractCreated event not found in receipt logs — IDs fetched on reload');
    } catch (e) { cfWarn('Event parse error:', e.message); }
    cfSetStep(5, 'done');

    // ─── Log TX ─────────────────────────────────────────────────────────────────
    cfLog(`✅ Contract created! ID=${newId} tx=${receipt.hash} block=${receipt.blockNumber}`);
    cfLogTx('createContract', receipt.hash, newId, {
      contractor, title, totalValue: humanAmount,
      milestones: milestoneDescs.length,
      block: receipt.blockNumber,
    });

    // ─── Save metadata off-chain ────────────────────────────────────────────────
    cfSetStep(6, 'active', 'Salvando metadados…');
    if (newId !== null) {
      cfSetMeta(newId, {
        clientEmail: clientEmail || '',
        contractorEmail: contractorEmail || '',
        otcPoints: otcEnabled ? (otcPoints || '') : '',
        otcTerms:  otcEnabled ? (otcTerms  || '') : '',
        proofs: [],
        createdAt: Date.now(),
        txHash: receipt.hash,
        block: receipt.blockNumber,
      });
      // Also update the IDs cache to include the new contract immediately
      const cachedIds = cfGetCachedIds(wallet) || [];
      if (!cachedIds.includes(newId)) {
        cfCacheIds(wallet, [...cachedIds, newId]);
        cfLog(`Added contract #${newId} to local IDs cache`);
      }
    }
    cfSetStep(6, 'done');

    const arcScanLink = `${CF_EXPLORER}/tx/${receipt.hash}`;
    showToast(`✅ Contrato${newId!==null?` #${newId}`:''} criado on-chain! Fee: $${cfFmtUsdc(feeRaw)} · Net: $${cfFmtUsdc(netRaw)} · <a href="${arcScanLink}" target="_blank" class="underline">ArcScan ↗</a>`, 'success');
    cfShowTxBadge(receipt.hash, `Contract #${newId !== null ? newId : 'new'} created!`);

    // ─── Capture data for smart autofill (on-chain path) ───────────────────────
    if (typeof arcCaptureCfData === 'function') arcCaptureCfData();

    // ─── Reset form ─────────────────────────────────────────────────────────────
    cfEl('cf-title').value = '';
    cfEl('cf-contractor').value = '';
    cfEl('cf-value').value = '';
    if (cfEl('cf-client-email'))     cfEl('cf-client-email').value = '';
    if (cfEl('cf-contractor-email')) cfEl('cf-contractor-email').value = '';
    cfResetMilestones();
    cfUpdateFeePreview();

    // ─── Auto-refresh list ───────────────────────────────────────────────────────
    setTimeout(() => cfLoadContracts({ force: true }), 1500);
    // Second refresh after 5s to ensure on-chain indexing
    setTimeout(() => cfLoadContracts({ force: true }), 5000);

  } catch (err) {
    cfErr('cfCreateContract:', err);
    const rej = err.code===4001||err.code==='ACTION_REJECTED'||err.message?.includes('rejected')||err.message?.includes('denied');
    if (rej) { showToast(t('cf_tx_rejected'),'warning'); cfHideSteps(); }
    else { showToast(`❌ ${err.reason||err.message}`,'error'); cfSetStep(0,'error',err.message?.slice(0,50)); }
  } finally {
    unlock();
    setTimeout(cfHideSteps, 20000);
  }
}

// ─── OTC toggle ────────────────────────────────────────────────────────────────
function cfToggleOTC() {
  const fields = cfEl('cf-otc-fields');
  const slider = cfEl('cf-otc-slider');
  const knob   = cfEl('cf-otc-knob');
  const checked = cfEl('cf-otc-toggle')?.checked;
  if (fields) fields.classList.toggle('hidden', !checked);
  if (slider) slider.style.background = checked ? 'rgba(167,139,250,0.4)' : 'rgba(255,255,255,0.08)';
  if (knob)   knob.style.transform    = checked ? 'translateX(16px)' : 'none';
  if (knob)   knob.style.background   = checked ? '#a78bfa' : '#4b5675';
}

// ─── Fee preview ────────────────────────────────────────────────────────────────
function cfUpdateFeePreview() {
  const val = parseFloat(cfEl('cf-value')?.value || '0');
  const el  = cfEl('cf-fee-preview');
  if (!el) return;
  if (!val || isNaN(val) || val <= 0) { el.textContent = ''; return; }
  const totalRaw = cfParseUsdc(val);
  const feeRaw   = cfCalcFee(totalRaw);
  const netRaw   = cfNetAmount(totalRaw);
  el.innerHTML = `<span style="color:#fbbf24;"><i class="fas fa-info-circle" style="font-size:9px;"></i> Platform fee: $${cfFmtUsdc(feeRaw)} USDC (0.2%) · Net to contractor: <strong style="color:#34d399;">$${cfFmtUsdc(netRaw)} USDC</strong></span>`;
}

// ─── Milestones ────────────────────────────────────────────────────────────────
let cfMilestoneCount = 1;

function cfAddMilestone() {
  if (cfMilestoneCount >= 10) { showToast(t('cf_max_10_milestones'), 'warning'); return; }
  cfMilestoneCount++;
  const container = cfEl('cf-milestones-container');
  if (!container) return;
  const row = document.createElement('div');
  row.className = 'cf-milestone-row flex items-center gap-2';
  row.innerHTML = `
    <input type="text" placeholder="Milestone description" class="cf-ms-desc flex-1 cf-input px-3 py-2 text-sm" oninput="cfUpdateMilestoneSum()" />
    <input type="number" placeholder="USDC" step="0.01" min="0.01" class="cf-ms-amt w-24 cf-input px-3 py-2 text-sm" oninput="cfUpdateMilestoneSum()" />
    <button onclick="this.closest('.cf-milestone-row').remove();cfUpdateMilestoneSum()" type="button"
      style="width:28px;height:28px;border-radius:8px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);color:#f87171;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:11px;">
      <i class="fas fa-times"></i>
    </button>`;
  container.appendChild(row);
  cfUpdateMilestoneSum();
}

function cfResetMilestones() {
  cfMilestoneCount = 1;
  const container = cfEl('cf-milestones-container');
  if (!container) return;
  container.innerHTML = `
    <div class="cf-milestone-row flex items-center gap-2">
      <input type="text" placeholder="Milestone description" class="cf-ms-desc flex-1 cf-input px-3 py-2 text-sm" oninput="cfUpdateMilestoneSum()" />
      <input type="number" placeholder="USDC" step="0.01" min="0.01" class="cf-ms-amt w-24 cf-input px-3 py-2 text-sm" oninput="cfUpdateMilestoneSum()" />
    </div>`;
}

function cfUpdateMilestoneSum() {
  let sum = 0;
  document.querySelectorAll('.cf-milestone-row').forEach(r => {
    const v = parseFloat(r.querySelector('.cf-ms-amt')?.value || '0');
    if (v > 0) sum += v;
  });
  const total = parseFloat(cfEl('cf-value')?.value || '0');
  const el    = cfEl('cf-ms-sum');
  if (el) {
    const diff = Math.abs(sum - total);
    const ok   = diff < 0.000001;
    el.textContent = `Sum: $${sum.toFixed(6)} USDC${ok ? ' ✅' : ` (diff: $${diff.toFixed(6)})`}`;
    el.className   = `text-xs mt-1 ${ok ? 'text-green-400' : 'text-yellow-400'}`;
  }
}

// ─── Wallet gate ────────────────────────────────────────────────────────────────
function cfWalletGateUpdate() {
  const wallet = window.walletState?.address;
  if (!wallet) { cfShowListState('no_wallet'); cfRenderSummary([], null); cfUpdateNetworkBanner(false); }
}

// ─── Wallet event listeners ────────────────────────────────────────────────────
window.addEventListener('walletConnected', () => {
  cfLog('walletConnected event → loading contracts');
  cfLoadContracts({ force: true });
  // Init smart autofill for Contracts tab
  setTimeout(() => { if (typeof arcInitCfAutofill === 'function') arcInitCfAutofill(); }, 800);
});
window.addEventListener('walletDisconnected', () => {
  cfLog('walletDisconnected event');
  cfShowListState('no_wallet');
  cfRenderSummary([], null);
  cfState.contracts = [];
  cfState.networkOk = false;
  cfState.lastWallet = null;
  cfUpdateNetworkBanner(false);
});
window.addEventListener('walletChanged', () => {
  cfLog('walletChanged event → reloading contracts');
  cfState.contracts = [];
  cfLoadContracts({ force: true });
});

// ─── Auto-refresh every 60s when contracts tab is active ──────────────────────
setInterval(() => {
  if (document.getElementById('tab-content-contracts')?.classList.contains('hidden')) return;
  if (!window.walletState?.address) return;
  const age = Date.now() - cfState.lastRefresh;
  if (age > 60000) {
    cfLog('Auto-refresh contracts (60s interval)');
    cfLoadContracts();
  }
}, 15000);

// ─── Global exports ────────────────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════════════════════════
// DISPUTE SYSTEM — Full implementation
// ══════════════════════════════════════════════════════════════════════════════

// ── Open Dispute modal ────────────────────────────────────────────────────────
function cfShowOpenDispute(contractId) {
  const wallet = window.walletState?.address;
  const c = cfState.contracts.find(x => x.id === contractId);
  if (!c) { showToast(t('contracts_contract_not_found'), 'error'); return; }

  const isClient = c.client?.toLowerCase() === wallet?.toLowerCase();
  const isContr  = c.contractor?.toLowerCase() === wallet?.toLowerCase();
  if (!isClient && !isContr) { showToast('Apenas participantes do contrato podem abrir disputas.', 'error'); return; }

  // Check for existing open dispute
  if (cfGetDisputeStatus(contractId) === 'open') {
    showToast(t('cf_dispute_already_open'), 'warning'); return;
  }
  const meta = cfGetMeta(contractId);
  if (meta.contractClosed) { showToast(t('cf_contract_closed_blocked'), 'error'); return; }

  document.getElementById('cf-dispute-open-modal')?.remove();
  window._cfDisputeFiles = [];
  const modal = document.createElement('div');
  modal.id = 'cf-dispute-open-modal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm';
  modal.innerHTML = `
  <div style="background:#0a0c18;border:1px solid rgba(239,68,68,0.3);border-radius:20px;width:100%;max-width:480px;padding:24px;max-height:90vh;overflow-y:auto;">
    <h3 style="color:#f87171;font-size:15px;font-weight:800;margin-bottom:4px;display:flex;align-items:center;gap:8px;">
      <i class="fas fa-gavel"></i>Abrir Disputa — #${contractId}
    </h3>
    <p style="font-size:11px;color:#4a6490;margin-bottom:16px;">Contrato: <strong style="color:#8899bb;">${c.title || 'Sem título'}</strong> · Valor: <strong style="color:#60b4ff;">$${cfFmtUsdc(BigInt(c.totalValue))} USDC</strong></p>

    <div style="background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.2);border-radius:10px;padding:12px;margin-bottom:14px;font-size:11px;color:#f87171;">
      <i class="fas fa-exclamation-triangle mr-1"></i>
      Ao abrir uma disputa, os <strong>fundos em escrow serão bloqueados</strong> até a resolução.
      Apenas ${c.mode==='onchain'?'ambas as partes':'você e a contraparte'} podem resolver a disputa.
    </div>

    <!-- Reason -->
    <div style="margin-bottom:14px;">
      <label style="font-size:11px;color:#8899bb;display:block;margin-bottom:6px;font-weight:600;">
        <i class="fas fa-comment-alt mr-1" style="color:#f87171;"></i>Motivo da Disputa *
      </label>
      <textarea id="cf-dispute-reason" rows="3"
        placeholder="Descreva detalhadamente o motivo da disputa..."
        style="width:100%;background:rgba(239,68,68,0.04);border:1px solid rgba(239,68,68,0.2);border-radius:10px;padding:10px;color:#dde2f0;font-size:12px;resize:vertical;outline:none;font-family:inherit;">
      </textarea>
    </div>

    <!-- Evidence upload -->
    <div style="margin-bottom:14px;">
      <label style="font-size:11px;color:#8899bb;display:block;margin-bottom:6px;font-weight:600;">
        <i class="fas fa-paperclip mr-1" style="color:#f87171;"></i>${t("cf_evidences_optional")}
      </label>
      <div id="cf-dispute-drop"
        onclick="document.getElementById('cf-dispute-file-input').click()"
        ondragover="event.preventDefault();this.style.borderColor='#f87171'"
        ondragleave="this.style.borderColor='rgba(239,68,68,0.3)'"
        ondrop="cfHandleDisputeFileDrop(event,${contractId})"
        style="border:2px dashed rgba(239,68,68,0.3);border-radius:12px;padding:16px;text-align:center;cursor:pointer;transition:all 0.2s;">
        <i class="fas fa-cloud-upload-alt" style="font-size:22px;color:#f87171;display:block;margin-bottom:6px;"></i>
        <p style="font-size:12px;color:#8899bb;">Arraste ou clique para adicionar evidências</p>
        <p style="font-size:10px;color:#4a3a7a;">${t("cf_file_types_small")}</p>
      </div>
      <input type="file" id="cf-dispute-file-input" multiple accept="image/*,.pdf,.doc,.docx"
        style="display:none;" onchange="cfHandleDisputeFileInput(event,${contractId})">
      <div id="cf-dispute-file-list" style="margin-top:8px;"></div>
    </div>

    <div style="display:flex;gap:10px;">
      <button onclick="cfSubmitDispute(${contractId})" id="cf-dispute-submit-btn"
        style="flex:1;background:linear-gradient(135deg,#991b1b,#7f1d1d);color:#fff;border:none;border-radius:12px;padding:12px;font-size:13px;font-weight:700;cursor:pointer;">
        <i class="fas fa-gavel mr-2"></i>Confirmar & Abrir Disputa
      </button>
      <button onclick="document.getElementById('cf-dispute-open-modal').remove()"
        style="padding:12px 18px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);color:#6b7280;border-radius:12px;cursor:pointer;font-size:13px;">Cancelar</button>
    </div>
  </div>`;
  document.body.appendChild(modal);
}

function cfHandleDisputeFileDrop(event, contractId) {
  event.preventDefault();
  document.getElementById('cf-dispute-drop').style.borderColor = 'rgba(239,68,68,0.3)';
  cfHandleDisputeFilesRaw(Array.from(event.dataTransfer.files));
}
function cfHandleDisputeFileInput(event, contractId) {
  cfHandleDisputeFilesRaw(Array.from(event.target.files));
}
function cfHandleDisputeFilesRaw(files) {
  if (!window._cfDisputeFiles) window._cfDisputeFiles = [];
  const MAX = 10 * 1024 * 1024;
  files.forEach(f => {
    if (f.size > MAX) { showToast(`${f.name} excede 10MB.`, 'error'); return; }
    if (window._cfDisputeFiles.length >= 5) { showToast(t('cf_max_5_files'), 'warning'); return; }
    if (window._cfDisputeFiles.find(x => x.name === f.name && x.size === f.size)) { showToast(`${f.name} already added.`, 'warning'); return; }
    window._cfDisputeFiles.push(f);
  });
  cfRenderDisputeFileList();
}
function cfRenderDisputeFileList() {
  const el = document.getElementById('cf-dispute-file-list');
  if (!el) return;
  const files = window._cfDisputeFiles || [];
  if (!files.length) { el.innerHTML = ''; return; }
  el.innerHTML = files.map((f, i) => {
    const icon = f.type.startsWith('image') ? 'fa-image' : f.type === 'application/pdf' ? 'fa-file-pdf' : 'fa-file';
    return `<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:rgba(239,68,68,0.04);border:1px solid rgba(239,68,68,0.12);border-radius:8px;margin-bottom:4px;">
      <i class="fas ${icon}" style="color:#f87171;font-size:12px;flex-shrink:0;"></i>
      <span style="flex:1;font-size:11px;color:#8899bb;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${f.name}</span>
      <span style="font-size:10px;color:#4a3a7a;">${(f.size/1024).toFixed(0)} KB</span>
      <button onclick="window._cfDisputeFiles.splice(${i},1);cfRenderDisputeFileList()"
        style="width:20px;height:20px;border-radius:4px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);color:#f87171;cursor:pointer;font-size:9px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
        <i class="fas fa-times"></i></button>
    </div>`;
  }).join('');
}

async function cfSubmitDispute(contractId) {
  const wallet = window.walletState?.address;
  const c = cfState.contracts.find(x => x.id === contractId);
  const reason = document.getElementById('cf-dispute-reason')?.value?.trim();
  if (!reason || reason.length < 10) { showToast('Descreva o motivo com pelo menos 10 caracteres.', 'warning'); return; }

  const btn = document.getElementById('cf-dispute-submit-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Enviando…'; }

  try {
    // Process evidence files
    const evidence = [];
    const files = window._cfDisputeFiles || [];
    for (const file of files) {
      const url = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload  = e => res(e.target.result);
        r.onerror = rej;
        r.readAsDataURL(file);
      });
      const hash = await cfHashFile(file);
      const type = file.type.startsWith('image') ? 'image' : file.type === 'application/pdf' ? 'pdf' : 'doc';
      evidence.push({ name: file.name, url, type, hash: hash || 'no-crypto', size: file.size, mimeType: file.type, uploadedAt: Date.now() });
    }

    // Store dispute
    cfSetDispute(contractId, {
      status:    'open',
      reason,
      evidence,
      openedBy:  wallet,
      openedAt:  Date.now(),
      contractId,
      // Track mutual approvals (needed for mutual resolution)
      mutualApproval: null,
    });

    // Also mark in meta so cfUiStatus picks it up
    cfSetMeta(contractId, { disputeOpenedAt: Date.now(), disputeOpenedBy: wallet });

    cfLogTx('openDispute', null, contractId, { reason: reason.slice(0, 80), openedBy: wallet });
    showToast('⚖️ Disputa aberta! Fundos em escrow bloqueados.', 'error');
    document.getElementById('cf-dispute-open-modal')?.remove();
    window._cfDisputeFiles = [];
    cfLoadContracts({ force: true });
  } catch(e) {
    cfErr('cfSubmitDispute:', e);
    showToast('Erro ao abrir disputa: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-gavel mr-2"></i>Confirmar & Abrir Disputa'; }
  }
}

// ── Dispute Resolution modal ──────────────────────────────────────────────────
function cfShowDisputeResolution(contractId) {
  const wallet = window.walletState?.address;
  const c = cfState.contracts.find(x => x.id === contractId);
  const dispute = cfGetDispute(contractId);
  if (!c || !dispute) { showToast(t('cf_dispute_data_not_found'), 'error'); return; }
  if (dispute.status !== 'open') { showToast(t('cf_dispute_already_resolved'), 'info'); return; }

  const isClient = c.client?.toLowerCase() === wallet?.toLowerCase();
  const isContr  = c.contractor?.toLowerCase() === wallet?.toLowerCase();
  if (!isClient && !isContr) { showToast('Apenas participantes podem resolver disputas.', 'error'); return; }

  // Check mutual approval state
  const approvals = dispute.mutualApproval || {};
  const myApproval = approvals[wallet?.toLowerCase()];

  document.getElementById('cf-dispute-resolve-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'cf-dispute-resolve-modal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm';
  modal.innerHTML = `
  <div style="background:#0a0c18;border:1px solid rgba(239,68,68,0.3);border-radius:20px;width:100%;max-width:480px;padding:24px;max-height:90vh;overflow-y:auto;">
    <h3 style="color:#f87171;font-size:15px;font-weight:800;margin-bottom:4px;display:flex;align-items:center;gap:8px;">
      <i class="fas fa-balance-scale"></i>Resolver Disputa — #${contractId}
    </h3>
    <p style="font-size:11px;color:#4a6490;margin-bottom:14px;">${c.title || 'Sem título'} · <strong style="color:#8899bb;">$${cfFmtUsdc(BigInt(c.totalValue))} USDC</strong></p>

    <!-- Dispute details -->
    <div style="background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.2);border-radius:10px;padding:12px;margin-bottom:16px;">
      <div style="font-size:10px;color:#f87171;font-weight:700;text-transform:uppercase;margin-bottom:6px;"><i class="fas fa-gavel mr-1"></i>Detalhes da Disputa</div>
      <div style="font-size:12px;color:#dde2f0;margin-bottom:4px;">"${dispute.reason}"</div>
      <div style="font-size:10px;color:#4a6490;">Aberto por: ${cfShort(dispute.openedBy)} · ${new Date(dispute.openedAt).toLocaleString('pt-BR')}</div>
      ${dispute.evidence?.length ? `<div style="font-size:10px;color:#4a6490;margin-top:4px;">${dispute.evidence.length} evidência(s) enviada(s)</div>` : ''}
    </div>

    <!-- Note field -->
    <div style="margin-bottom:14px;">
      <label style="font-size:11px;color:#8899bb;display:block;margin-bottom:6px;font-weight:600;">Nota de resolução (opcional)</label>
      <textarea id="cf-resolve-note" rows="2"
        placeholder="Descreva os termos do acordo ou motivo da resolução..."
        style="width:100%;background:rgba(55,138,221,0.04);border:1px solid rgba(55,138,221,0.15);border-radius:10px;padding:10px;color:#dde2f0;font-size:12px;resize:vertical;outline:none;font-family:inherit;"></textarea>
    </div>

    <!-- Resolution options (manual — for client only) -->
    ${isClient ? `
    <div style="margin-bottom:16px;">
      <p style="font-size:11px;color:#8899bb;font-weight:700;margin-bottom:8px;"><i class="fas fa-user-shield mr-1" style="color:#60b4ff;"></i>${t("cf_manual_resolution_label")}</p>
      <div style="display:flex;flex-direction:column;gap:8px;">
        <button onclick="cfExecuteDisputeResolution(${contractId},'contractor')"
          style="padding:12px;background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.3);color:#34d399;border-radius:12px;font-size:12px;font-weight:700;cursor:pointer;text-align:left;">
          <i class="fas fa-arrow-right mr-2"></i><strong>Liberar para o Contratado</strong>
          <div style="font-size:10px;opacity:0.7;margin-top:2px;">Confirma que o trabalho foi entregue — $${cfFmtUsdc(BigInt(c.totalValue))} USDC para ${cfShort(c.contractor)}</div>
        </button>
        <button onclick="cfExecuteDisputeResolution(${contractId},'client')"
          style="padding:12px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);color:#f87171;border-radius:12px;font-size:12px;font-weight:700;cursor:pointer;text-align:left;">
          <i class="fas fa-undo mr-2"></i><strong>Devolver ao Cliente</strong>
          <div style="font-size:10px;opacity:0.7;margin-top:2px;">Trabalho não entregue — $${cfFmtUsdc(BigInt(c.totalValue))} USDC retorna para ${cfShort(c.client)}</div>
        </button>
      </div>
    </div>
    <div style="height:1px;background:rgba(255,255,255,0.05);margin-bottom:16px;"></div>
    ` : ''}

    <!-- Mutual agreement -->
    <div style="margin-bottom:16px;">
      <p style="font-size:11px;color:#fbbf24;font-weight:700;margin-bottom:8px;"><i class="fas fa-handshake mr-1"></i>Acordo Mútuo (ambas as partes aprovam):</p>
      ${myApproval ? `
        <div style="padding:10px;background:rgba(52,211,153,0.08);border:1px solid rgba(52,211,153,0.2);border-radius:10px;font-size:11px;color:#34d399;margin-bottom:8px;">
          <i class="fas fa-check-circle mr-1"></i>Você já aprovou este acordo. Aguardando a contraparte.
        </div>` : `
        <button onclick="cfApproveMutualResolution(${contractId})"
          style="width:100%;padding:12px;background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.3);color:#fbbf24;border-radius:12px;font-size:12px;font-weight:700;cursor:pointer;">
          <i class="fas fa-handshake mr-2"></i>Aprovar Acordo Mútuo
          <div style="font-size:10px;opacity:0.7;margin-top:2px;">Ambas as partes devem clicar para confirmar a resolução</div>
        </button>`}
    </div>

    <button onclick="document.getElementById('cf-dispute-resolve-modal').remove()"
      style="width:100%;padding:11px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);color:#6b7280;border-radius:12px;cursor:pointer;font-size:13px;">Fechar</button>
  </div>`;
  document.body.appendChild(modal);
}

async function cfExecuteDisputeResolution(contractId, outcome) {
  const wallet = window.walletState?.address;
  const c = cfState.contracts.find(x => x.id === contractId);
  const dispute = cfGetDispute(contractId);
  if (!c || !dispute) return;

  const isClient = c.client?.toLowerCase() === wallet?.toLowerCase();
  if (!isClient) { showToast(t('cf_only_client_can_resolve'), 'error'); return; }

  const note = document.getElementById('cf-resolve-note')?.value?.trim() || '';
  const outcomeLabel = outcome === 'contractor' ? 'liberar para o Contratado' : 'devolver ao Cliente';
  if (!window.confirm(`Confirmar resolução: ${outcomeLabel}?\n\nEsta ação é irreversível.`)) return;

  cfSetDispute(contractId, {
    status: 'resolved',
    resolution: {
      outcome,
      note,
      resolvedBy:  wallet,
      resolvedAt:  Date.now(),
      method:      'manual_client',
    },
  });

  cfSetMeta(contractId, {
    disputeResolvedAt: Date.now(),
    disputeOutcome: outcome,
    offchainStatus: outcome === 'contractor' ? 'confirmed' : 'refunded',
  });

  cfLogTx('resolveDispute', null, contractId, { outcome, resolvedBy: wallet });
  showToast(`✅ Disputa resolvida — ${outcomeLabel}.`, 'success');
  document.getElementById('cf-dispute-resolve-modal')?.remove();
  cfLoadContracts({ force: true });
}

async function cfApproveMutualResolution(contractId) {
  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Conecte sua carteira.', 'warning'); return; }
  const c = cfState.contracts.find(x => x.id === contractId);
  const dispute = cfGetDispute(contractId);
  if (!c || !dispute || dispute.status !== 'open') return;

  const isClient = c.client?.toLowerCase() === wallet?.toLowerCase();
  const isContr  = c.contractor?.toLowerCase() === wallet?.toLowerCase();
  if (!isClient && !isContr) { showToast('Apenas participantes podem aprovar.', 'error'); return; }

  const approvals = dispute.mutualApproval || {};
  approvals[wallet.toLowerCase()] = true;

  // Check if both parties approved
  const clientApproved = approvals[c.client?.toLowerCase()];
  const contrApproved  = approvals[c.contractor?.toLowerCase()];

  if (clientApproved && contrApproved) {
    // Both approved → resolve as mutual
    const note = document.getElementById('cf-resolve-note')?.value?.trim() || '';
    cfSetDispute(contractId, {
      status: 'resolved',
      mutualApproval: approvals,
      resolution: {
        outcome:     'mutual',
        note,
        resolvedBy:  'both_parties',
        resolvedAt:  Date.now(),
        method:      'mutual_agreement',
      },
    });
    cfSetMeta(contractId, { disputeResolvedAt: Date.now(), disputeOutcome: 'mutual' });
    cfLogTx('resolveDispute', null, contractId, { outcome: 'mutual' });
    showToast(t('cf_mutual_agreement_confirmed'), 'success');
    document.getElementById('cf-dispute-resolve-modal')?.remove();
  } else {
    // First party approved — update and wait
    cfSetDispute(contractId, { mutualApproval: approvals });
    showToast(t('cf_waiting_counterparty'), 'info');
    document.getElementById('cf-dispute-resolve-modal')?.remove();
  }
  cfLoadContracts({ force: true });
}

// ── View dispute evidence ─────────────────────────────────────────────────────
function cfViewDisputeEvidence(contractId, evidenceIndex) {
  const dispute = cfGetDispute(contractId);
  const evidences = dispute?.evidence || [];
  const ev = evidences[evidenceIndex];
  if (!ev || !ev.url) { showToast(t('cf_evidence_not_available'), 'error'); return; }

  document.getElementById('cf-dispute-evidence-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'cf-dispute-evidence-modal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.92);backdrop-filter:blur(4px);display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding:0;overflow:hidden;';

  const isImg = ev.type === 'image' || (ev.mimeType && ev.mimeType.startsWith('image/'));
  const isPdf = ev.type === 'pdf' || ev.mimeType === 'application/pdf';

  let content;
  if (isImg) {
    content = `<div style="flex:1;display:flex;align-items:center;justify-content:center;overflow:auto;padding:16px;">
      <img src="${ev.url}" alt="${ev.name}" style="max-width:100%;max-height:calc(100vh - 100px);object-fit:contain;border-radius:10px;">
    </div>`;
  } else if (isPdf) {
    content = `<div style="flex:1;width:100%;padding:8px 16px;">
      <iframe src="${ev.url}" style="width:100%;height:calc(100vh - 100px);border:none;border-radius:10px;background:#fff;" title="${ev.name}"></iframe>
    </div>`;
  } else {
    content = `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px;text-align:center;">
      <i class="fas fa-file-alt" style="font-size:56px;color:#f87171;margin-bottom:16px;"></i>
      <p style="color:#dde2f0;font-size:15px;font-weight:700;margin-bottom:20px;">${ev.name}</p>
      <button onclick="(()=>{const a=document.createElement('a');a.href='${ev.url}';a.download='${ev.name}';a.click()})()"
        style="padding:11px 24px;background:linear-gradient(135deg,#991b1b,#7f1d1d);color:#fff;border:none;border-radius:12px;font-size:13px;font-weight:700;cursor:pointer;">
        <i class="fas fa-download mr-2"></i>${t("cf_download_file")}
      </button>
    </div>`;
  }

  modal.innerHTML = `
    <div style="width:100%;display:flex;align-items:center;gap:10px;padding:14px 20px;background:rgba(10,12,24,0.95);border-bottom:1px solid rgba(239,68,68,0.15);flex-shrink:0;">
      <button onclick="document.getElementById('cf-dispute-evidence-modal').remove()"
        style="width:32px;height:32px;border-radius:8px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.25);color:#f87171;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;">
        <i class="fas fa-times"></i></button>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:700;color:#dde2f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${ev.name}</div>
        <div style="font-size:10px;color:#f87171;">Evidência de Disputa #${contractId} — ${ev.mimeType || 'Arquivo'}</div>
      </div>
      <button onclick="(()=>{const a=document.createElement('a');a.href='${ev.url}';a.download='${ev.name}';a.click()})()"
        style="width:32px;height:32px;border-radius:8px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);color:#f87171;cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center;" title="Baixar">
        <i class="fas fa-download"></i></button>
    </div>
    <div style="flex:1;width:100%;display:flex;flex-direction:column;overflow:auto;">${content}</div>`;

  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
}

// ══════════════════════════════════════════════════════════════════════════════
// CONTRACT CLOSURE — Permanent lock after completion/resolution
// ══════════════════════════════════════════════════════════════════════════════

function cfCloseContract(contractId) {
  const wallet = window.walletState?.address;
  const c = cfState.contracts.find(x => x.id === contractId);
  if (!c) { showToast(t('contracts_contract_not_found'), 'error'); return; }

  const isClient = c.client?.toLowerCase() === wallet?.toLowerCase();
  const isContr  = c.contractor?.toLowerCase() === wallet?.toLowerCase();
  if (!isClient && !isContr) { showToast('Apenas participantes podem encerrar o contrato.', 'error'); return; }

  const meta = cfGetMeta(contractId);
  if (meta.contractClosed) { showToast(t('cf_contract_already_closed'), 'info'); return; }

  // Cannot close while dispute is open
  if (cfGetDisputeStatus(contractId) === 'open') {
    showToast(t('cf_cannot_close_dispute_active'), 'error'); return;
  }

  const uiStatus = cfUiStatus(c);
  const disputeResolved = cfGetDisputeStatus(contractId) === 'resolved';
  if (uiStatus !== 'Completed' && !disputeResolved) {
    showToast('O contrato deve estar Concluído ou com Disputa Resolvida para ser encerrado.', 'warning'); return;
  }

  document.getElementById('cf-close-contract-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'cf-close-contract-modal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm';
  modal.innerHTML = `
  <div style="background:#0a0c18;border:1px solid rgba(74,85,104,0.3);border-radius:20px;width:100%;max-width:440px;padding:24px;">
    <h3 style="color:#9ca3af;font-size:15px;font-weight:800;margin-bottom:4px;display:flex;align-items:center;gap:8px;">
      <i class="fas fa-lock"></i>Encerrar Contrato — #${contractId}
    </h3>
    <p style="font-size:11px;color:#4a6490;margin-bottom:16px;">${c.title || 'Sem título'} · $${cfFmtUsdc(BigInt(c.totalValue))} USDC</p>

    <div style="background:rgba(74,85,104,0.1);border:1px solid rgba(74,85,104,0.25);border-radius:10px;padding:12px;margin-bottom:16px;font-size:11px;color:#9ca3af;">
      <i class="fas fa-exclamation-triangle mr-1" style="color:#fbbf24;"></i>
      <strong>Atenção:</strong> Ao encerrar este contrato, <strong>todas as interações serão permanentemente bloqueadas</strong>:
      <ul style="margin-top:8px;margin-left:16px;list-style:disc;color:#6b7280;">
        <li>Nenhum upload de prova adicional</li>
        <li>Nenhuma disputa pode ser aberta</li>
        <li>Nenhuma edição ou cancelamento</li>
        <li>Contrato se torna somente leitura</li>
      </ul>
    </div>

    <div style="display:flex;gap:10px;">
      <button onclick="cfExecuteCloseContract(${contractId})" id="cf-close-contract-btn"
        style="flex:1;background:linear-gradient(135deg,#374151,#1f2937);color:#9ca3af;border:1px solid rgba(74,85,104,0.4);border-radius:12px;padding:12px;font-size:13px;font-weight:700;cursor:pointer;">
        <i class="fas fa-lock mr-2"></i>Encerrar Permanentemente
      </button>
      <button onclick="document.getElementById('cf-close-contract-modal').remove()"
        style="padding:12px 18px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);color:#6b7280;border-radius:12px;cursor:pointer;font-size:13px;">Cancelar</button>
    </div>
  </div>`;
  document.body.appendChild(modal);
}

function cfExecuteCloseContract(contractId) {
  const wallet = window.walletState?.address;
  const btn = document.getElementById('cf-close-contract-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Encerrando…'; }

  try {
    cfSetMeta(contractId, {
      contractClosed: true,
      closedAt:       Date.now(),
      closedBy:       wallet,
    });
    cfLogTx('closeContract', null, contractId, { closedBy: wallet });
    showToast('🔒 Contrato encerrado permanentemente.', 'success');
    document.getElementById('cf-close-contract-modal')?.remove();
    cfLoadContracts({ force: true });
  } catch(e) {
    cfErr('cfExecuteCloseContract:', e);
    showToast('Erro ao encerrar contrato: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-lock mr-2"></i>Encerrar Permanentemente'; }
  }
}

// ─── Global exports ────────────────────────────────────────────────────────────
window.cfCreateContract       = cfCreateContract;
window.cfLoadContracts        = cfLoadContracts;
window.cfSignContract         = cfSignContract;
window.cfDepositToContract    = cfDepositToContract;
window.cfExecuteDeposit       = cfExecuteDeposit;
window.cfWithdrawFromContract = cfWithdrawFromContract;
window.cfExecuteWithdraw      = cfExecuteWithdraw;
window.cfReleaseMilestone     = cfReleaseMilestone;
window.cfCancelContract       = cfCancelContract;
window.cfMarkComplete         = cfMarkComplete;
window.cfShowProofUpload      = cfShowProofUpload;
window.cfHandleProofDrop      = cfHandleProofDrop;
window.cfHandleProofFiles     = cfHandleProofFiles;
window.cfExecuteProofUpload   = cfExecuteProofUpload;
window.cfCommitProof          = cfCommitProof;
window.cfExecuteCommitProof   = cfExecuteCommitProof;
window.cfShowWalletLink       = cfShowWalletLink;
window.cfShowOffchainActions  = cfShowOffchainActions;
window.cfSaveOffchainStatus   = cfSaveOffchainStatus;
window.cfDownloadReceipt      = cfDownloadReceipt;   // legacy — kept for compat
window.cfOpenReceipt          = cfOpenReceipt;
window.cfAddMilestone         = cfAddMilestone;
window.cfUpdateMilestoneSum   = cfUpdateMilestoneSum;
window.cfUpdateFeePreview     = cfUpdateFeePreview;
window.cfToggleOTC            = cfToggleOTC;
window.cfWalletGateUpdate     = cfWalletGateUpdate;
window.cfSwitchNetwork        = cfSwitchNetwork;
window.cfState                = cfState;
window.cfUiStatus             = cfUiStatus;
window.loadContracts          = cfLoadContracts;
window.cfRenderProofPreview   = cfRenderProofPreview;
window.cfViewProof            = cfViewProof;
window.cfUpdateNetworkBanner  = cfUpdateNetworkBanner;
window.cfLogTx                = cfLogTx;
window.cfGetSelectedMode      = cfGetSelectedMode;
window.cfCreateOffchainContract = cfCreateOffchainContract;
window.cfLoadOffchainContracts  = cfLoadOffchainContracts;
window.cfGenerateQrCanvas     = cfGenerateQrCanvas;
// Dispute system
window.cfShowOpenDispute          = cfShowOpenDispute;
window.cfHandleDisputeFileDrop    = cfHandleDisputeFileDrop;
window.cfHandleDisputeFileInput   = cfHandleDisputeFileInput;
window.cfRenderDisputeFileList    = cfRenderDisputeFileList;
window.cfSubmitDispute            = cfSubmitDispute;
window.cfShowDisputeResolution    = cfShowDisputeResolution;
window.cfExecuteDisputeResolution = cfExecuteDisputeResolution;
window.cfApproveMutualResolution  = cfApproveMutualResolution;
window.cfViewDisputeEvidence      = cfViewDisputeEvidence;
// Contract closure
window.cfCloseContract            = cfCloseContract;
window.cfExecuteCloseContract     = cfExecuteCloseContract;
// Debug helpers — exposed on window for console/devtools use
window.cfDebug = {
  getState:     () => cfState,
  getTxLog:     () => JSON.parse(localStorage.getItem(CF_TX_LOG_KEY) || '[]'),
  getMeta:      (id) => cfGetMeta(id),
  getCachedIds: (addr) => cfGetCachedIds(addr || window.walletState?.address),
  clearCache:   () => { localStorage.removeItem(CF_IDS_KEY); cfLog('ID cache cleared'); },
  setDebug:     (v) => { cfState.debugMode = v; cfLog('Debug mode:', v); },
  getOffchain:  () => cfLoadOffchainContracts(),
  clearOffchain: () => { localStorage.removeItem('arc_cf_offchain_v1'); cfLog('Off-chain contracts cleared'); },
  // Test reading a known contract directly (no wallet needed)
  testContract: async (id) => {
    id = id || 1;
    const ethers = window.ethers;
    if (!ethers) { console.error('[cfDebug] ethers.js not loaded'); return; }
    const provider = new ethers.JsonRpcProvider(CF_RPC);
    const factory  = new ethers.Contract(CF_FACTORY_ADDR, CF_ABI, provider);
    try {
      const count = Number(await factory.contractCount());
      console.log('[cfDebug] contractCount:', count);
      const c = await factory.getContract(id);
      console.log(`[cfDebug] Contract #${id}:`, {
        id: Number(c.id), title: c.title,
        client: c.client, contractor: c.contractor,
        total:    '$' + (Number(c.totalValue) / 1e6).toFixed(2),
        deposited:'$' + (Number(c.depositedValue) / 1e6).toFixed(2),
        status: Number(c.status), signed: c.contractorSigned,
      });
      const ms = await factory.getMilestones(id);
      console.log(`[cfDebug] Milestones #${id}:`, ms.map(m => ({
        id: Number(m.id), desc: m.description,
        amount: '$' + (Number(m.amount)/1e6).toFixed(2),
        status: Number(m.status),
      })));
      const wallet = window.walletState?.address;
      if (wallet) {
        const clientIds = await factory.getByClient(wallet);
        const contrIds  = await factory.getByContractor(wallet);
        console.log(`[cfDebug] getByClient(${wallet}):`,     clientIds.map(x => Number(x)));
        console.log(`[cfDebug] getByContractor(${wallet}):`, contrIds.map(x => Number(x)));
      }
    } catch (e) {
      console.error('[cfDebug] testContract failed:', e.message);
    }
  },
};

console.log('%c[CF v6] Contracts Module loaded', 'color:#60b4ff;font-weight:bold',
  '| Factory:', CF_FACTORY_ADDR,
  '| Chain:', CF_CHAIN_ID,
  '| Modes: onchain / offchain / custodial',
  '| QR: canvas fallback built-in',
  '| Proof: SHA-256 + commit lock',
  '| Debug: cfDebug.testContract(1)'
);
