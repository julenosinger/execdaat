// ============================================================
// ARC Contracts Module — Fully trustless, on-chain only
// Self-contained Escrow + Contract lifecycle
//
// ContractFactory: 0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A
// Arc Testnet (chainId 5042002) | USDC native gas token
//
// Contract is its own escrow:
//   Client (payer)     → Deposit USDC → approve + depositToContract
//   Contractor (recv)  → Withdraw USDC per milestone or full release
//   Client             → Release milestone → completeMilestone
//   Client             → Cancel (refund) → cancelContract
//
// States:
//   Draft      (0) – created, no funds deposited
//   Active     (1) – funds deposited & contractor signed
//   Completed  (2) – all milestones released
//   Cancelled  (3) – cancelled, funds refunded
//
// Role-based UI:
//   isClient     → "Deposit" button, "Release Milestone", "Cancel"
//   isContractor → "Sign Contract", "Receive / Withdraw" button
//
// Real-time data: eth_call reads, event log parsing, tx.wait(1)
// Zero mock data — every value from on-chain.
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

// ContractFactory ABI — includes deposit and withdrawal functions
const CF_ABI = [
  // Read
  'function contractCount() view returns (uint256)',
  'function getContract(uint256 id) view returns (uint256,address,address,string,uint256,uint256,uint8,bool,uint256,uint256,uint256,uint256,uint256)',
  'function getMilestones(uint256 id) view returns (tuple(uint256 id, string description, uint256 amount, uint8 status, uint256 releasedAt)[])',
  'function getByClient(address) view returns (uint256[])',
  'function getByContractor(address) view returns (uint256[])',
  // Write – creation
  'function createContract(address,string,uint256,string[],uint256[]) returns (uint256)',
  // Write – lifecycle
  'function signContract(uint256)',
  'function depositToContract(uint256,uint256)',    // client deposits USDC
  'function withdrawFromContract(uint256,uint256)', // contractor withdraws available USDC
  'function completeMilestone(uint256,uint256)',    // client releases a milestone
  'function cancelContract(uint256)',               // client cancels (refund)
  // Events
  'event ContractCreated(uint256 indexed contractId, address indexed client, address indexed contractor, uint256 totalValue)',
  'event FundsDeposited(uint256 indexed contractId, address indexed depositor, uint256 amount)',
  'event MilestoneCompleted(uint256 indexed contractId, uint256 indexed milestoneId, uint256 amount)',
  'event FundsWithdrawn(uint256 indexed contractId, address indexed recipient, uint256 amount)',
];

const CF_USDC_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];

// ─── Status labels & mapping ──────────────────────────────────────────────────
// On-chain status codes:
//   0 = Draft  (created, not yet funded / not yet both-signed)
//   1 = Active (funded + contractor signed)
//   2 = Completed
//   3 = Cancelled
//
// UI-level 5-state machine (adds "Funded" as an intermediary):
//   Pending   – Draft, no deposit
//   Funded    – Draft, deposit > 0, waiting for contractor to sign
//   Active    – on-chain Active (both funded + signed)
//   Completed – all milestones released
//   Cancelled – refunded / cancelled
const CF_STATUS_LABELS = ['Draft', 'Active', 'Completed', 'Cancelled'];
const CF_STATUS_MAP = {
  Pending:   { color: 'yellow', icon: 'fa-clock',        label: 'Pending' },
  Funded:    { color: 'blue',   icon: 'fa-coins',        label: 'Funded — Awaiting Signature' },
  Active:    { color: 'cyan',   icon: 'fa-bolt',         label: 'Active' },
  Completed: { color: 'green',  icon: 'fa-check-circle', label: 'Completed' },
  Cancelled: { color: 'red',    icon: 'fa-times-circle', label: 'Cancelled' },
  Draft:     { color: 'yellow', icon: 'fa-clock',        label: 'Pending' }, // fallback
};

// Derive 5-state UI label from on-chain data
function cfUiStatus(c) {
  if (c.status === 'Cancelled') return 'Cancelled';
  if (c.status === 'Completed') return 'Completed';
  if (c.status === 'Active')    return 'Active';
  // Draft:
  if (BigInt(c.depositedValue) > 0n) return 'Funded'; // deposit made, contractor not yet signed
  return 'Pending'; // nothing deposited yet
}

// ─── Status badge & state-progress helpers ────────────────────────────────────
function cfStatusBadge(uiStatus) {
  const colors = {
    Pending:   'bg-yellow-900/30 border-yellow-700/30 text-yellow-400',
    Funded:    'bg-blue-900/30 border-blue-700/30 text-blue-400',
    Active:    'bg-cyan-900/30 border-cyan-700/30 text-cyan-400',
    Completed: 'bg-green-900/30 border-green-700/30 text-green-400',
    Cancelled: 'bg-red-900/30 border-red-700/30 text-red-400',
  };
  const sm = CF_STATUS_MAP[uiStatus] || { icon: 'fa-circle', label: uiStatus };
  const cls = colors[uiStatus] || 'bg-gray-800/40 border-gray-600/30 text-gray-400';
  return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-semibold ${cls}">
    <i class="fas ${sm.icon} text-[9px]"></i>${sm.label}
  </span>`;
}

// 5-step horizontal progress bar for the contract state machine
function cfStateProgress(uiStatus) {
  const steps = [
    { key: 'Pending',   label: 'Pending',   icon: 'fa-clock' },
    { key: 'Funded',    label: 'Funded',    icon: 'fa-coins' },
    { key: 'Active',    label: 'Active',    icon: 'fa-bolt' },
    { key: 'Completed', label: 'Completed', icon: 'fa-check-circle' },
  ];
  const order = { Pending: 0, Funded: 1, Active: 2, Completed: 3, Cancelled: -1 };
  const cur = order[uiStatus] ?? -1;

  if (uiStatus === 'Cancelled') {
    return `<div class="flex items-center gap-2 text-xs text-red-400/70 bg-red-900/10 border border-red-800/20 rounded-lg px-3 py-1.5">
      <i class="fas fa-times-circle text-red-500 text-sm"></i>
      <span>Contract Cancelled — funds refunded to payer</span>
    </div>`;
  }

  return `<div class="flex items-center gap-0 text-[10px]">
    ${steps.map((s, i) => {
      const done    = cur > i;
      const active  = cur === i;
      const pending = cur < i;
      const dotCls  = done   ? 'bg-cyan-500 border-cyan-500 text-white'
                    : active ? 'bg-purple-600 border-purple-500 text-white ring-2 ring-purple-500/30'
                    : 'bg-gray-800 border-gray-600 text-gray-500';
      const lineCls = i < steps.length - 1
        ? (done ? 'flex-1 h-0.5 bg-cyan-500' : 'flex-1 h-0.5 bg-gray-700')
        : '';
      return `
        <div class="flex flex-col items-center gap-1">
          <div class="w-6 h-6 rounded-full border flex items-center justify-center flex-shrink-0 ${dotCls}">
            <i class="fas ${s.icon} text-[9px]"></i>
          </div>
          <span class="${active ? 'text-white font-semibold' : done ? 'text-cyan-400' : 'text-gray-600'} whitespace-nowrap">${s.label}</span>
        </div>
        ${lineCls ? `<div class="${lineCls} mb-3"></div>` : ''}`;
    }).join('')}
  </div>`;
}

// ─── Module state ─────────────────────────────────────────────────────────────
const cfState = {
  pending:        false,
  contracts:      [],
  milestones:     {},
  lastTxHash:     null,
  networkOk:      false,
  _provider:      null,
  _factory:       null,
  _usdc:          null,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function cfEl(id)       { return document.getElementById(id); }
function cfShort(addr)  { if (!addr || addr.length < 12) return addr || '—'; return addr.slice(0, 8) + '…' + addr.slice(-6); }
function cfTs(ts)       { if (!ts || ts === 0) return '—'; return new Date(Number(ts) * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
function cfLog(...a)    { console.log('[CF]', ...a); }
function cfWarn(...a)   { console.warn('[CF]', ...a); }
function cfErr(...a)    { console.error('[CF]', ...a); }

function cfParseUsdc(human) {
  const s = String(human).trim();
  const [int = '0', frac = ''] = s.split('.');
  return BigInt(int) * CF_USDC_SCALE + BigInt(frac.slice(0, 6).padEnd(6, '0'));
}
function cfFmtUsdc(base) {
  const n = typeof base === 'bigint' ? base : BigInt(Math.round(Number(base)));
  return (Number(n) / 1e6).toFixed(2);
}

// ─── Provider / Signer bootstrap ──────────────────────────────────────────────
async function cfInitProvider() {
  try {
    const rawProv = window.walletState?.provider;
    if (!rawProv) return { ok: false, error: 'no_wallet', message: 'Carteira não conectada.' };
    if (!window.ethers) return { ok: false, error: 'no_ethers', message: 'ethers.js não carregado.' };

    let provider;
    try { provider = new window.ethers.BrowserProvider(rawProv, 'any'); }
    catch (e) { return { ok: false, error: 'provider_init', message: 'Falha ao inicializar provider: ' + e.message }; }

    let network;
    try { network = await provider.getNetwork(); }
    catch (e) { return { ok: false, error: 'network_error', message: 'Falha ao ler rede: ' + e.message }; }

    const chainId = Number(network.chainId);
    cfLog('Network:', chainId, '| Expected:', CF_CHAIN_ID, '| Wallet:', window.walletState?.address);

    if (chainId !== CF_CHAIN_ID) {
      return { ok: false, error: 'wrong_network', chainId,
        message: `Rede incorreta (Chain ID ${chainId}). Troque para ${CF_NETWORK_NAME} (Chain ID ${CF_CHAIN_ID}).` };
    }

    let signer;
    try { signer = await provider.getSigner(); }
    catch (e) { return { ok: false, error: 'no_signer', message: 'Não foi possível obter signer: ' + e.message }; }

    const address = await signer.getAddress();
    cfLog('Signer:', address);

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

// ─── Network switch ────────────────────────────────────────────────────────────
async function cfSwitchNetwork() {
  const rawProv = window.walletState?.provider;
  if (!rawProv) { showToast('Conecte sua carteira primeiro.', 'warning'); return; }
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
      } catch (e2) { showToast('Não foi possível adicionar Arc Testnet: ' + e2.message, 'error'); }
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
  const [hexC, hexA] = await Promise.all([
    cfRpcCall(CF_FACTORY_ADDR, CF_SEL.getByClient + enc),
    cfRpcCall(CF_FACTORY_ADDR, CF_SEL.getByContractor + enc),
  ]);
  const seen = new Set();
  return [...cfDecodeUintArray(hexC), ...cfDecodeUintArray(hexA)].filter(id => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

async function cfFetchContract(factory, id) {
  try {
    const raw = await factory.getContract(id);
    return {
      id:                  Number(raw[0]),
      client:              raw[1],
      contractor:          raw[2],
      title:               raw[3],
      totalValue:          raw[4],
      depositedValue:      raw[5],
      statusCode:          Number(raw[6]),
      status:              CF_STATUS_LABELS[Number(raw[6])] || 'Unknown',
      contractorSigned:    raw[7],
      createdAt:           Number(raw[8]),
      startedAt:           Number(raw[9]),
      completedAt:         Number(raw[10]),
      milestoneCount:      Number(raw[11]),
      completedMilestones: Number(raw[12]),
    };
  } catch (e) { cfErr('getContract(' + id + '):', e); return null; }
}

async function cfFetchMilestones(factory, id) {
  try {
    const raw = await factory.getMilestones(id);
    return raw.map(ms => ({
      id:          Number(ms[0] ?? ms.id),
      description: ms[1] ?? ms.description,
      amount:      ms[2] ?? ms.amount,
      status:      Number(ms[3] ?? ms.status) === 0 ? 'Pending' : 'Released',
      releasedAt:  Number(ms[4] ?? ms.releasedAt),
    }));
  } catch (e) { cfErr('getMilestones(' + id + '):', e); return []; }
}

async function cfReadBalance(addr) {
  const hex = await cfRpcCall(CF_USDC_ADDR, CF_SEL.usdcBalanceOf + cfEncAddr(addr));
  return BigInt(hex);
}
async function cfReadAllowance(owner, spender) {
  return BigInt(await cfRpcCall(CF_USDC_ADDR, CF_SEL.usdcAllowance + cfEncAddr(owner) + cfEncAddr(spender)));
}

// ─── Step panel ───────────────────────────────────────────────────────────────
function cfSetStep(n, status = 'active', detail = '') {
  const panel = cfEl('cf-steps-panel');
  if (panel) panel.classList.remove('hidden');
  for (let i = 0; i <= 6; i++) {
    const el = cfEl(`cf-step-${i}`);
    if (!el) continue;
    el.classList.remove('ct-step-active', 'ct-step-done', 'ct-step-error', 'ct-step-idle');
    if (i < n)       el.classList.add('ct-step-done');
    else if (i === n) el.classList.add(status === 'error' ? 'ct-step-error' : 'ct-step-active');
    else              el.classList.add('ct-step-idle');
    if (i === n && detail) {
      const span = el.querySelector('span');
      if (span) { if (!span.dataset.base) span.dataset.base = span.textContent; span.textContent = detail; }
    } else if (i === n) {
      const span = el.querySelector('span');
      if (span?.dataset.base) span.textContent = span.dataset.base;
    }
  }
}
function cfHideSteps() {
  const panel = cfEl('cf-steps-panel');
  if (panel) panel.classList.add('hidden');
  for (let i = 0; i <= 6; i++) {
    const el = cfEl(`cf-step-${i}`);
    if (!el) continue;
    el.classList.remove('ct-step-active', 'ct-step-done', 'ct-step-error');
    el.classList.add('ct-step-idle');
    const span = el.querySelector('span');
    if (span?.dataset.base) { span.textContent = span.dataset.base; delete span.dataset.base; }
  }
}

// ─── List state renderers ─────────────────────────────────────────────────────
function cfShowListState(state, message = '') {
  const el = cfEl('cf-contracts-list');
  if (!el) return;
  switch (state) {
    case 'no_wallet':
      el.innerHTML = `
        <div class="flex flex-col items-center gap-4 py-16 text-center">
          <div class="w-16 h-16 rounded-2xl bg-gray-800/60 border border-gray-700/40 flex items-center justify-center">
            <i class="fas fa-wallet text-gray-600 text-2xl"></i>
          </div>
          <div>
            <p class="text-gray-400 text-sm font-medium mb-1">Carteira não conectada</p>
            <p class="text-gray-600 text-xs">Conecte uma carteira EVM para ver seus contratos on-chain.</p>
          </div>
          <button onclick="openWalletModal()"
            class="px-5 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-sm font-semibold transition-all flex items-center gap-2">
            <i class="fas fa-plug"></i>Conectar Carteira
          </button>
        </div>`; break;

    case 'wrong_network':
      el.innerHTML = `
        <div class="flex flex-col items-center gap-4 py-14 text-center">
          <div class="w-16 h-16 rounded-2xl bg-yellow-900/20 border border-yellow-700/30 flex items-center justify-center">
            <i class="fas fa-exclamation-triangle text-yellow-500 text-2xl"></i>
          </div>
          <p class="text-yellow-400 text-sm font-semibold mb-1">Rede incorreta</p>
          <p class="text-gray-500 text-xs max-w-xs">${message || 'Conecte-se à Arc Testnet (Chain ID 5042002).'}</p>
          <button onclick="cfSwitchNetwork()"
            class="px-5 py-2 bg-yellow-700 hover:bg-yellow-600 text-white rounded-xl text-sm font-semibold transition-all flex items-center gap-2">
            <i class="fas fa-network-wired"></i>Trocar para Arc Testnet
          </button>
        </div>`; break;

    case 'loading':
      el.innerHTML = `
        <div class="flex items-center justify-center gap-3 py-14 text-gray-400">
          <i class="fas fa-spinner fa-spin text-cyan-400 text-xl"></i>
          <span class="text-sm">Carregando contratos on-chain…</span>
        </div>`; break;

    case 'empty':
      el.innerHTML = `
        <div class="flex flex-col items-center gap-4 py-16 text-center">
          <div class="w-16 h-16 rounded-2xl bg-gray-800/60 border border-gray-700/40 flex items-center justify-center">
            <i class="fas fa-file-contract text-gray-600 text-2xl"></i>
          </div>
          <div>
            <p class="text-gray-400 text-sm font-medium mb-1">Nenhum contrato on-chain</p>
            <p class="text-gray-600 text-xs max-w-xs">Nenhum contrato encontrado para este endereço na Arc Testnet. Crie seu primeiro contrato acima.</p>
          </div>
          <div class="text-[11px] text-gray-600 font-mono bg-gray-800/30 rounded-lg px-3 py-2">
            <i class="fas fa-search mr-1"></i>getByClient / getByContractor → [] vazio
          </div>
        </div>`; break;

    case 'error':
      el.innerHTML = `
        <div class="flex flex-col items-center gap-3 py-12 text-center">
          <i class="fas fa-exclamation-circle text-red-500 text-3xl"></i>
          <p class="text-red-400 text-sm font-medium">Erro ao carregar contratos</p>
          <p class="text-gray-500 text-xs max-w-xs">${message}</p>
          <button onclick="cfLoadContracts()"
            class="mt-1 px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-600 text-gray-300 text-xs rounded-lg transition flex items-center gap-2">
            <i class="fas fa-redo"></i>Tentar novamente
          </button>
        </div>`; break;
  }
}

// ─── Load contracts ────────────────────────────────────────────────────────────
async function cfLoadContracts() {
  cfLog('cfLoadContracts()');
  const wallet = window.walletState?.address;
  if (!wallet) { cfShowListState('no_wallet'); cfRenderSummary([], null); return; }

  cfLog('Wallet:', wallet);
  cfShowListState('loading');

  const init = await cfInitProvider();
  if (!init.ok) {
    if (init.error === 'wrong_network') cfShowListState('wrong_network', init.message);
    else if (init.error === 'no_wallet') cfShowListState('no_wallet');
    else cfShowListState('error', init.message);
    cfRenderSummary([], wallet);
    return;
  }

  try {
    const ids = await cfFetchMyIds(wallet);
    cfLog('IDs:', ids);
    if (ids.length === 0) { cfShowListState('empty'); cfRenderSummary([], wallet); return; }

    const contracts = await Promise.all(ids.map(async id => {
      const c  = await cfFetchContract(init.factory, id);
      if (!c) return null;
      const ms = await cfFetchMilestones(init.factory, id);
      return { ...c, milestones: ms };
    }));

    const valid = contracts.filter(Boolean);
    cfLog('Loaded', valid.length, 'contracts');
    valid.forEach(c => cfLog(`  #${c.id} "${c.title}" status=${c.status} deposited=$${cfFmtUsdc(c.depositedValue)}/${cfFmtUsdc(c.totalValue)}`));

    cfState.contracts = valid;
    valid.forEach(c => { cfState.milestones[c.id] = c.milestones; });

    cfRenderContracts(valid, wallet);
    cfRenderSummary(valid, wallet);
  } catch (err) {
    cfErr('loadContracts error:', err);
    cfShowListState('error', err.message);
    cfRenderSummary([], wallet);
  }
}

// ─── Summary stats ────────────────────────────────────────────────────────────
function cfRenderSummary(contracts, wallet) {
  const el = cfEl('cf-summary');
  if (!el) return;
  if (!wallet) { el.innerHTML = ''; return; }

  const totalUsdc  = contracts.reduce((s, c) => s + BigInt(c.totalValue), 0n);
  const pending    = contracts.filter(c => cfUiStatus(c) === 'Pending').length;
  const funded     = contracts.filter(c => cfUiStatus(c) === 'Funded').length;
  const active     = contracts.filter(c => cfUiStatus(c) === 'Active').length;
  const completed  = contracts.filter(c => cfUiStatus(c) === 'Completed').length;

  el.innerHTML = `
    <div class="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-4">
      <div class="bg-gray-800/60 border border-gray-700/40 rounded-xl p-3 text-center">
        <div class="text-xl font-bold text-white">${contracts.length}</div>
        <div class="text-[11px] text-gray-500 mt-0.5">Total</div>
      </div>
      <div class="bg-yellow-900/20 border border-yellow-700/30 rounded-xl p-3 text-center">
        <div class="text-xl font-bold text-yellow-400">${pending}</div>
        <div class="text-[11px] text-gray-500 mt-0.5">Pending</div>
      </div>
      <div class="bg-blue-900/20 border border-blue-700/30 rounded-xl p-3 text-center">
        <div class="text-xl font-bold text-blue-400">${funded}</div>
        <div class="text-[11px] text-gray-500 mt-0.5">Funded</div>
      </div>
      <div class="bg-cyan-900/20 border border-cyan-700/30 rounded-xl p-3 text-center">
        <div class="text-xl font-bold text-cyan-400">${active}</div>
        <div class="text-[11px] text-gray-500 mt-0.5">Active</div>
      </div>
      <div class="bg-green-900/20 border border-green-700/30 rounded-xl p-3 text-center">
        <div class="text-xl font-bold text-green-400">$${cfFmtUsdc(totalUsdc)}</div>
        <div class="text-[11px] text-gray-500 mt-0.5">Total USDC</div>
      </div>
    </div>
    <div class="flex items-center gap-2 text-xs text-gray-500 bg-gray-800/30 rounded-lg px-3 py-2">
      <div class="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse flex-shrink-0"></div>
      <span>Live data from <span class="font-mono text-gray-400">${cfShort(CF_FACTORY_ADDR)}</span> · ${CF_NETWORK_NAME} · Chain ${CF_CHAIN_ID}</span>
      <a href="${CF_EXPLORER}/address/${CF_FACTORY_ADDR}" target="_blank" rel="noopener" class="ml-auto text-blue-400 hover:text-blue-300">
        <i class="fas fa-external-link-alt text-[10px]"></i>
      </a>
    </div>`;
}

// ─── Render contract list ─────────────────────────────────────────────────────
function cfRenderContracts(contracts, wallet) {
  const listEl = cfEl('cf-contracts-list');
  if (!listEl) return;
  if (!contracts.length) { cfShowListState('empty'); return; }
  // Sort by UI state priority: Active first, then Funded, Pending, Completed, Cancelled
  const order = { Active: 0, Funded: 1, Pending: 2, Completed: 3, Cancelled: 4 };
  const sorted = [...contracts].sort((a, b) => (order[cfUiStatus(a)] ?? 9) - (order[cfUiStatus(b)] ?? 9));
  listEl.innerHTML = sorted.map(c => cfContractCard(c, wallet)).join('');
}

// ─── Single contract card — full escrow lifecycle ──────────────────────────────
function cfContractCard(c, wallet) {
  const walletLow    = wallet?.toLowerCase() ?? '';
  const isClient     = c.client?.toLowerCase() === walletLow;
  const isContractor = c.contractor?.toLowerCase() === walletLow;

  const uiStatus = cfUiStatus(c);
  const sm = CF_STATUS_MAP[uiStatus] || CF_STATUS_MAP[c.status] || { color: 'gray', icon: 'fa-circle', label: c.status };
  const progress = c.milestoneCount > 0 ? Math.round((c.completedMilestones / c.milestoneCount) * 100) : 0;

  const usdcTotal   = cfFmtUsdc(c.totalValue);
  const deposited   = cfFmtUsdc(c.depositedValue);
  const remaining   = cfFmtUsdc(BigInt(c.totalValue) - BigInt(c.depositedValue));
  const fundedPct   = c.totalValue > 0n
    ? Math.min(100, Math.round(Number(BigInt(c.depositedValue) * 100n / BigInt(c.totalValue))))
    : 0;

  // ── Role badge ───────────────────────────────────────────────────────────
  const roleBadge = isClient
    ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-900/30 border border-purple-700/30 text-purple-300 text-[10px] font-semibold"><i class="fas fa-user text-[9px]"></i>Payer</span>`
    : isContractor
    ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-cyan-900/30 border border-cyan-700/30 text-cyan-300 text-[10px] font-semibold"><i class="fas fa-hard-hat text-[9px]"></i>Receiver</span>`
    : `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-800/60 border border-gray-700/30 text-gray-400 text-[10px]"><i class="fas fa-eye text-[9px]"></i>Observer</span>`;

  // ── Milestone rows ────────────────────────────────────────────────────────
  const milestonesHtml = (c.milestones || []).map((ms, idx) => {
    const released   = ms.status === 'Released';
    // Only client can release a milestone; only if contract is Active
    const canRelease = isClient && uiStatus === 'Active' && !released && BigInt(c.depositedValue) > 0n;
    return `
      <div class="flex items-start gap-2.5 py-2 border-b border-gray-700/30 last:border-0">
        <i class="fas ${released ? 'fa-check-circle text-green-400' : 'fa-circle text-gray-600'} mt-0.5 text-sm flex-shrink-0"></i>
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs text-gray-300 truncate">${ms.description}</span>
            <span class="text-xs font-mono ${released ? 'text-green-400' : 'text-gray-400'} flex-shrink-0">$${cfFmtUsdc(ms.amount)}</span>
          </div>
          ${ms.releasedAt > 0 ? `<div class="text-[10px] text-gray-600 mt-0.5"><i class="fas fa-check mr-1"></i>${cfTs(ms.releasedAt)}</div>` : ''}
        </div>
        ${canRelease ? `
        <button onclick="cfReleaseMilestone(${c.id}, ${idx})"
          class="flex-shrink-0 px-2 py-1 bg-green-900/30 hover:bg-green-800/40 border border-green-700/40 text-green-400 text-[10px] rounded-lg transition font-semibold">
          <i class="fas fa-unlock-alt mr-1"></i>Release
        </button>` : ''}
      </div>`;
  }).join('');

  // ── Action buttons: role-based (5-state machine) ───────────────────────────
  // State: Pending  → Client can Deposit; Contractor can Sign (after client deposits)
  // State: Funded   → Client deposited; Contractor should Sign; Client can add more deposit
  // State: Active   → Client can Release milestones; Contractor can Receive released funds; Client can Cancel
  // State: Completed → read-only
  // State: Cancelled → read-only
  const canDeposit  = isClient &&
    (uiStatus === 'Pending' || uiStatus === 'Funded') &&
    BigInt(c.depositedValue) < BigInt(c.totalValue);
  const canCancel   = isClient && (uiStatus === 'Pending' || uiStatus === 'Funded' || uiStatus === 'Active');
  const canSign     = isContractor && c.status === 'Draft' && !c.contractorSigned;
  // Contractor can withdraw if Active and at least one milestone is Released
  const releasedAmt = (c.milestones || []).filter(ms => ms.status === 'Released').reduce((s, ms) => s + BigInt(ms.amount), 0n);
  const canReceive  = isContractor && uiStatus === 'Active' && releasedAmt > 0n;

  const depositBtn = canDeposit ? `
    <button onclick="cfDepositToContract(${c.id})"
      class="flex items-center gap-1.5 px-3 py-1.5 bg-purple-900/40 hover:bg-purple-800/50 border border-purple-700/50 text-purple-300 text-xs rounded-xl transition font-semibold">
      <i class="fas fa-arrow-circle-down text-xs"></i>Deposit USDC
    </button>` : '';

  const receiveBtn = canReceive ? `
    <button onclick="cfWithdrawFromContract(${c.id})"
      class="flex items-center gap-1.5 px-3 py-1.5 bg-green-900/40 hover:bg-green-800/50 border border-green-700/50 text-green-300 text-xs rounded-xl transition font-semibold">
      <i class="fas fa-arrow-circle-up text-xs"></i>Receive $${cfFmtUsdc(releasedAmt)} USDC
    </button>` : '';

  const signBtn = canSign ? `
    <button onclick="cfSignContract(${c.id})"
      class="flex items-center gap-1.5 px-3 py-1.5 bg-cyan-900/30 hover:bg-cyan-800/40 border border-cyan-700/40 text-cyan-400 text-xs rounded-xl transition">
      <i class="fas fa-signature text-xs"></i>Sign Contract
    </button>` : '';

  const cancelBtn = canCancel ? `
    <button onclick="cfCancelContract(${c.id})"
      class="flex items-center gap-1.5 px-3 py-1.5 bg-red-900/20 hover:bg-red-900/30 border border-red-700/30 text-red-400 text-xs rounded-xl transition">
      <i class="fas fa-times text-xs"></i>Cancel
    </button>` : '';

  return `
<div class="bg-gray-800/40 border border-gray-700/40 rounded-2xl p-4 mb-3 hover:border-gray-600/60 transition-colors" id="cf-card-${c.id}">

  <!-- ── Header ─────────────────────────────────────────────────────────── -->
  <div class="flex items-start justify-between gap-3 mb-3">
    <div class="flex items-center gap-2.5 min-w-0">
      <div class="w-9 h-9 rounded-xl bg-gray-800/60 border border-gray-600/40 flex items-center justify-center flex-shrink-0">
        <i class="fas ${sm.icon} text-${sm.color}-400 text-sm"></i>
      </div>
      <div class="min-w-0">
        <div class="text-white font-semibold text-sm truncate">${c.title}</div>
        <div class="text-gray-500 text-[11px] font-mono">
          #${c.id} ·
          <a href="${CF_EXPLORER}/address/${CF_FACTORY_ADDR}" target="_blank" rel="noopener" class="text-blue-400 hover:underline">
            ${cfShort(CF_FACTORY_ADDR)} <i class="fas fa-external-link-alt text-[9px]"></i>
          </a>
        </div>
      </div>
    </div>
    <div class="flex flex-col items-end gap-1.5 flex-shrink-0">
      ${cfStatusBadge(uiStatus)}
      ${roleBadge}
    </div>
  </div>

  <!-- ── Escrow balance bar ──────────────────────────────────────────────── -->
  <div class="mb-3 bg-gray-900/40 rounded-xl p-3">
    <div class="flex items-center justify-between text-xs mb-2">
      <span class="text-gray-500 font-semibold uppercase tracking-wide text-[10px]">Escrow Balance</span>
      <span class="font-mono font-bold ${BigInt(c.depositedValue) > 0n ? 'text-cyan-400' : 'text-gray-600'}">
        $${deposited} / $${usdcTotal} USDC
      </span>
    </div>
    <div class="h-2 bg-gray-700/60 rounded-full overflow-hidden">
      <div class="h-full bg-gradient-to-r from-cyan-500 to-purple-500 rounded-full transition-all" style="width:${fundedPct}%"></div>
    </div>
    <div class="flex justify-between text-[10px] text-gray-600 mt-1">
      <span>${fundedPct}% funded</span>
      ${BigInt(c.depositedValue) < BigInt(c.totalValue) ? `<span class="text-yellow-600">$${remaining} remaining</span>` : `<span class="text-green-600">Fully funded ✓</span>`}
    </div>
  </div>

  <!-- ── Parties ────────────────────────────────────────────────────────── -->
  <div class="grid grid-cols-2 gap-2 mb-3">
    <div class="bg-gray-900/40 rounded-lg px-3 py-2">
      <div class="text-[10px] text-gray-600 mb-0.5 uppercase tracking-wide flex items-center gap-1">
        <i class="fas fa-user text-purple-600 text-[9px]"></i>Payer (Client)
      </div>
      <div class="text-xs font-mono text-purple-300 truncate" title="${c.client}">${cfShort(c.client)}${isClient ? ' <span class="text-[9px] text-purple-500">(you)</span>' : ''}</div>
    </div>
    <div class="bg-gray-900/40 rounded-lg px-3 py-2">
      <div class="text-[10px] text-gray-600 mb-0.5 uppercase tracking-wide flex items-center gap-1">
        <i class="fas fa-hard-hat text-cyan-600 text-[9px]"></i>Receiver (Contractor)
      </div>
      <div class="text-xs font-mono text-cyan-300 truncate" title="${c.contractor}">${cfShort(c.contractor)}${isContractor ? ' <span class="text-[9px] text-cyan-500">(you)</span>' : ''}</div>
    </div>
  </div>

  <!-- ── Milestone progress ─────────────────────────────────────────────── -->
  ${c.milestoneCount > 0 ? `
  <div class="mb-3">
    <div class="flex justify-between text-[10px] text-gray-500 mb-1">
      <span>Milestone progress</span>
      <span>${c.completedMilestones}/${c.milestoneCount} completed · ${progress}%</span>
    </div>
    <div class="h-1.5 bg-gray-700/60 rounded-full overflow-hidden">
      <div class="h-full bg-gradient-to-r from-green-500 to-emerald-400 rounded-full transition-all" style="width:${progress}%"></div>
    </div>
  </div>` : ''}

  <!-- ── Timestamps ────────────────────────────────────────────────────── -->
  <div class="flex flex-wrap gap-3 text-[10px] text-gray-600 mb-3">
    <span><i class="fas fa-plus-circle mr-1"></i>${cfTs(c.createdAt)}</span>
    ${c.startedAt > 0 ? `<span><i class="fas fa-play mr-1 text-cyan-600"></i>${cfTs(c.startedAt)}</span>` : ''}
    ${c.completedAt > 0 ? `<span><i class="fas fa-check mr-1 text-green-600"></i>${cfTs(c.completedAt)}</span>` : ''}
  </div>

  <!-- ── Milestones collapsible ──────────────────────────────────────────── -->
  ${c.milestones?.length > 0 ? `
  <details class="mb-3">
    <summary class="text-xs text-gray-400 hover:text-gray-300 cursor-pointer select-none font-medium flex items-center gap-2">
      <i class="fas fa-list-check text-[11px] text-gray-600"></i>
      Milestones (${c.milestones.length})
      ${releasedAmt > 0n ? `<span class="text-green-400 text-[10px]">$${cfFmtUsdc(releasedAmt)} released</span>` : ''}
      <span class="ml-auto text-[10px] text-gray-600">▼</span>
    </summary>
    <div class="mt-2 pl-2">${milestonesHtml}</div>
  </details>` : ''}

  <!-- ── State machine progress ────────────────────────────────────────── -->
  <div class="mb-3">
    ${cfStateProgress(uiStatus)}
  </div>

  <!-- ── Signing status ─────────────────────────────────────────────────── -->
  <div class="flex items-center gap-4 text-[10px] text-gray-600 mb-3">
    <span class="flex items-center gap-1">
      <i class="fas fa-user ${BigInt(c.depositedValue) > 0n ? 'text-green-500' : 'text-gray-600'}"></i>
      Payer: ${BigInt(c.depositedValue) > 0n ? `<span class="text-green-400">$${cfFmtUsdc(c.depositedValue)} deposited</span>` : '<span class="text-yellow-500">awaiting deposit</span>'}
    </span>
    <span class="flex items-center gap-1">
      <i class="fas fa-hard-hat ${c.contractorSigned ? 'text-green-500' : 'text-gray-600'}"></i>
      Receiver: ${c.contractorSigned ? '<span class="text-green-400">signed</span>' : '<span class="text-yellow-500">not signed</span>'}
    </span>
  </div>

  <!-- ── Action buttons ─────────────────────────────────────────────────── -->
  <div class="flex gap-2 flex-wrap items-center">
    ${depositBtn}
    ${receiveBtn}
    ${signBtn}
    ${cancelBtn}
    <a href="${CF_EXPLORER}/address/${CF_FACTORY_ADDR}#readContract"
       target="_blank" rel="noopener"
       class="ml-auto flex items-center gap-1.5 px-3 py-1.5 bg-gray-700/40 hover:bg-gray-700/60 border border-gray-600/40 text-gray-400 text-xs rounded-xl transition">
      <i class="fas fa-external-link-alt text-xs"></i>ArcScan
    </a>
  </div>

</div>`;
}

// ─── Tx badge helper ──────────────────────────────────────────────────────────
function cfShowTxBadge(txHash, label) {
  if (typeof window.showTXConfirmationBadge === 'function') window.showTXConfirmationBadge(txHash, label);
}

// ─── Generic signed-tx wrapper ────────────────────────────────────────────────
// Shows approval + tx steps, waits for receipt, shows link
async function cfRunTx(label, txFn) {
  const init = await cfInitProvider();
  if (!init.ok) { showToast(`❌ ${init.message}`, 'error'); return false; }
  try {
    showToast(`📝 ${label} — confirme na carteira…`, 'info');
    const tx = await txFn(init);
    cfLog(`${label} tx:`, tx.hash);
    showToast(`⏳ <a href="${CF_EXPLORER}/tx/${tx.hash}" target="_blank" class="underline font-mono">${tx.hash.slice(0, 18)}…</a>`, 'info');
    const receipt = await tx.wait(1);
    cfLog(`${label} confirmed — block:`, receipt.blockNumber, 'status:', receipt.status);
    if (receipt.status !== 1) throw new Error('Transação revertida on-chain.');
    showToast(`✅ ${label} confirmado! Bloco #${receipt.blockNumber}.`, 'success');
    cfShowTxBadge(receipt.hash, label);
    return receipt;
  } catch (err) {
    const rejected = err.code === 4001 || err.code === 'ACTION_REJECTED' || err.message?.includes('rejected');
    if (rejected) showToast('⚠️ Transação rejeitada pelo usuário.', 'warning');
    else showToast(`❌ ${err.reason || err.message}`, 'error');
    cfErr(label, 'error:', err);
    return false;
  }
}

// ─── Approve USDC helper ──────────────────────────────────────────────────────
async function cfEnsureApproval(init, amount) {
  const { usdc, address } = init;
  const allowance = await cfReadAllowance(address, CF_FACTORY_ADDR);
  cfLog('Allowance:', cfFmtUsdc(allowance), '| needed:', cfFmtUsdc(amount));
  if (allowance >= amount) return true;
  showToast(`📝 Aprovando USDC para ContractFactory — confirme na carteira…`, 'info');
  const approveTx = await usdc.approve(CF_FACTORY_ADDR, amount);
  cfLog('Approve tx:', approveTx.hash);
  showToast(`⏳ Approve: <a href="${CF_EXPLORER}/tx/${approveTx.hash}" target="_blank" class="underline">${approveTx.hash.slice(0, 14)}…</a>`, 'info');
  const r = await approveTx.wait(1);
  if (r.status !== 1) throw new Error('Approve revertida.');
  showToast('✅ Approve confirmado!', 'success');
  return true;
}

// ─── Deposit modal ────────────────────────────────────────────────────────────
// Shows an inline modal inside the contract card for a clean UX
function cfShowDepositModal(contractId) {
  const c = cfState.contracts.find(x => x.id === contractId);
  if (!c) { showToast('Contrato não encontrado.', 'error'); return; }

  const remaining    = BigInt(c.totalValue) - BigInt(c.depositedValue);
  const humanRemain  = (Number(remaining) / 1e6).toFixed(2);
  const humanTotal   = cfFmtUsdc(c.totalValue);
  const humanDep     = cfFmtUsdc(c.depositedValue);

  // Remove any existing modal
  document.getElementById('cf-deposit-modal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'cf-deposit-modal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm';
  modal.innerHTML = `
    <div class="bg-gray-900 border border-gray-700/60 rounded-2xl w-full max-w-md p-6 shadow-2xl">
      <div class="flex items-center justify-between mb-5">
        <h3 class="text-white font-bold text-base flex items-center gap-2">
          <i class="fas fa-arrow-circle-down text-purple-400"></i>
          Deposit USDC — Contract #${contractId}
        </h3>
        <button onclick="document.getElementById('cf-deposit-modal').remove()"
          class="w-7 h-7 flex items-center justify-center rounded-lg bg-gray-700/60 hover:bg-gray-600 text-gray-400 hover:text-white transition">
          <i class="fas fa-times text-xs"></i>
        </button>
      </div>

      <!-- Summary row -->
      <div class="grid grid-cols-3 gap-2 mb-5 text-center">
        <div class="bg-gray-800/60 rounded-xl p-3">
          <div class="text-xs text-gray-500 mb-1">Total</div>
          <div class="text-sm font-bold text-white">$${humanTotal}</div>
        </div>
        <div class="bg-gray-800/60 rounded-xl p-3">
          <div class="text-xs text-gray-500 mb-1">Deposited</div>
          <div class="text-sm font-bold text-cyan-400">$${humanDep}</div>
        </div>
        <div class="bg-purple-900/30 border border-purple-700/30 rounded-xl p-3">
          <div class="text-xs text-purple-400 mb-1">Remaining</div>
          <div class="text-sm font-bold text-purple-300">$${humanRemain}</div>
        </div>
      </div>

      <!-- Amount input -->
      <div class="mb-4">
        <label class="text-xs text-gray-400 mb-1.5 block font-medium">Amount to deposit (USDC)</label>
        <div class="relative">
          <input id="cf-deposit-amount" type="number" value="${humanRemain}"
            step="0.01" min="0.01" max="${humanRemain}"
            class="w-full bg-gray-800/60 border border-gray-600/40 rounded-xl pl-3 pr-16 py-2.5 text-white text-sm font-mono focus:border-purple-500/60 focus:outline-none"
            placeholder="0.00" />
          <button onclick="document.getElementById('cf-deposit-amount').value='${humanRemain}'"
            class="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-purple-400 hover:text-purple-300 bg-purple-900/30 hover:bg-purple-800/40 px-2 py-1 rounded-lg transition">
            MAX
          </button>
        </div>
        <div class="text-[11px] text-gray-600 mt-1">
          <i class="fas fa-info-circle mr-1"></i>
          USDC will be locked in the contract escrow until milestones are released.
        </div>
      </div>

      <!-- Transaction lifecycle panel -->
      <div id="cf-deposit-steps" class="hidden mb-4 space-y-1 bg-gray-800/40 border border-gray-700/30 rounded-xl p-3">
        <p class="text-[10px] text-gray-500 uppercase tracking-wider mb-2 font-semibold">Transaction Progress</p>
        <div id="cf-dep-step-0" class="ct-step ct-step-idle flex items-center gap-2">
          <div class="ct-step-icon w-5 h-5 rounded-full flex items-center justify-center text-[9px] flex-shrink-0"><i class="fas fa-network-wired"></i></div>
          <span class="text-[11px]">Verify Arc Testnet connection</span>
        </div>
        <div id="cf-dep-step-1" class="ct-step ct-step-idle flex items-center gap-2">
          <div class="ct-step-icon w-5 h-5 rounded-full flex items-center justify-center text-[9px] flex-shrink-0"><i class="fas fa-coins"></i></div>
          <span class="text-[11px]">Check USDC balance</span>
        </div>
        <div id="cf-dep-step-2" class="ct-step ct-step-idle flex items-center gap-2">
          <div class="ct-step-icon w-5 h-5 rounded-full flex items-center justify-center text-[9px] flex-shrink-0"><i class="fas fa-check-double"></i></div>
          <span class="text-[11px]">Approve USDC (sign in wallet)</span>
        </div>
        <div id="cf-dep-step-3" class="ct-step ct-step-idle flex items-center gap-2">
          <div class="ct-step-icon w-5 h-5 rounded-full flex items-center justify-center text-[9px] flex-shrink-0"><i class="fas fa-paper-plane"></i></div>
          <span class="text-[11px]">Send deposit transaction (sign in wallet)</span>
        </div>
        <div id="cf-dep-step-4" class="ct-step ct-step-idle flex items-center gap-2">
          <div class="ct-step-icon w-5 h-5 rounded-full flex items-center justify-center text-[9px] flex-shrink-0"><i class="fas fa-hourglass-half"></i></div>
          <span class="text-[11px]">Waiting for on-chain confirmation…</span>
        </div>
        <div id="cf-dep-step-5" class="ct-step ct-step-idle flex items-center gap-2">
          <div class="ct-step-icon w-5 h-5 rounded-full flex items-center justify-center text-[9px] flex-shrink-0"><i class="fas fa-check-circle"></i></div>
          <span class="text-[11px]">Confirmed — contract funded</span>
        </div>
        <div id="cf-dep-tx-link" class="hidden text-[11px] mt-1 pt-1 border-t border-gray-700/30"></div>
      </div>

      <div class="flex gap-3">
        <button onclick="cfExecuteDeposit(${contractId})" id="cf-deposit-btn"
          class="flex-1 bg-gradient-to-r from-purple-600 to-purple-700 hover:from-purple-500 hover:to-purple-600 text-white rounded-xl py-2.5 text-sm font-semibold transition-all flex items-center justify-center gap-2">
          <i class="fas fa-arrow-circle-down"></i>Deposit USDC
        </button>
        <button onclick="document.getElementById('cf-deposit-modal').remove()"
          class="px-4 py-2.5 bg-gray-700/60 hover:bg-gray-600/60 text-gray-300 rounded-xl text-sm transition">
          Cancel
        </button>
      </div>

      <div class="mt-3 text-[10px] text-gray-600 flex items-start gap-1.5">
        <i class="fas fa-shield-alt text-gray-600 mt-0.5 flex-shrink-0"></i>
        Funds are held in the ContractFactory smart contract. No private key is required or stored.
      </div>
    </div>`;
  document.body.appendChild(modal);
  // Focus amount input
  setTimeout(() => document.getElementById('cf-deposit-amount')?.focus(), 100);
}

// Helper to set deposit step state
function cfSetDepStep(n, status = 'active', detail = '') {
  const panel = document.getElementById('cf-deposit-steps');
  if (panel) panel.classList.remove('hidden');
  for (let i = 0; i <= 5; i++) {
    const el = document.getElementById(`cf-dep-step-${i}`);
    if (!el) continue;
    el.classList.remove('ct-step-active', 'ct-step-done', 'ct-step-error', 'ct-step-idle');
    if (i < n)       el.classList.add('ct-step-done');
    else if (i === n) el.classList.add(status === 'error' ? 'ct-step-error' : 'ct-step-active');
    else              el.classList.add('ct-step-idle');
    if (i === n && detail) {
      const span = el.querySelector('span');
      if (span) { if (!span.dataset.base) span.dataset.base = span.textContent; span.textContent = detail; }
    }
  }
}

// ─── Deposit USDC to Contract ──────────────────────────────────────────────────
// Called from the deposit button on a contract card
function cfDepositToContract(contractId) {
  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Conecte sua carteira.', 'warning'); return; }
  if (cfState.pending) { showToast('Aguarde a transação atual.', 'warning'); return; }
  const c = cfState.contracts.find(x => x.id === contractId);
  if (!c) { showToast('Contrato não encontrado. Atualize a lista.', 'error'); return; }
  if (c.client?.toLowerCase() !== wallet.toLowerCase()) {
    showToast('❌ Apenas o cliente (payer) pode depositar fundos.', 'error'); return;
  }
  const remaining = BigInt(c.totalValue) - BigInt(c.depositedValue);
  if (remaining <= 0n) { showToast('⚠️ Contrato já totalmente financiado.', 'warning'); return; }
  cfShowDepositModal(contractId);
}

// ─── Execute Deposit (called from modal button) ────────────────────────────────
async function cfExecuteDeposit(contractId) {
  const c = cfState.contracts.find(x => x.id === contractId);
  if (!c) return;

  const amountInput = document.getElementById('cf-deposit-amount');
  const humanAmount = parseFloat(amountInput?.value || '0');
  if (isNaN(humanAmount) || humanAmount <= 0) { showToast('Valor inválido.', 'error'); return; }

  const depositAmount = cfParseUsdc(humanAmount);
  const remaining     = BigInt(c.totalValue) - BigInt(c.depositedValue);
  if (depositAmount > remaining) {
    showToast(`❌ Valor excede o restante necessário.`, 'error'); return;
  }

  const btn = document.getElementById('cf-deposit-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Processing…'; }

  cfState.pending = true;
  try {
    // Step 0: Network check
    cfSetDepStep(0, 'active');
    const init = await cfInitProvider();
    if (!init.ok) {
      cfSetDepStep(0, 'error', init.message.slice(0, 40));
      showToast(`❌ ${init.message}`, 'error');
      return;
    }
    cfSetDepStep(0, 'done');
    const { address } = init;

    // Step 1: Balance check
    cfSetDepStep(1, 'active');
    cfLog(`Deposit #${contractId} — $${humanAmount} USDC | wallet: ${address}`);
    const balance = await cfReadBalance(address);
    if (balance < depositAmount) {
      cfSetDepStep(1, 'error', `Balance $${cfFmtUsdc(balance)} < needed $${humanAmount}`);
      showToast(`❌ Saldo insuficiente: $${cfFmtUsdc(balance)} disponível.`, 'error');
      return;
    }
    cfSetDepStep(1, 'done');

    // Step 2: Approve
    cfSetDepStep(2, 'active', 'Approve USDC — sign in wallet…');
    const allowance = await cfReadAllowance(address, CF_FACTORY_ADDR);
    if (allowance < depositAmount) {
      showToast('📝 Aprovando USDC para ContractFactory — confirme na carteira…', 'info');
      const approveTx = await init.usdc.approve(CF_FACTORY_ADDR, depositAmount);
      cfLog('Approve tx:', approveTx.hash);
      cfSetDepStep(2, 'active', `Waiting: ${approveTx.hash.slice(0, 14)}…`);
      const r = await approveTx.wait(1);
      if (r.status !== 1) throw new Error('Approve revertida on-chain.');
    }
    cfSetDepStep(2, 'done');

    // Step 3: Send deposit tx
    cfSetDepStep(3, 'active', 'Sign deposit in wallet…');
    showToast(`📝 Deposit $${humanAmount} USDC — confirme na carteira…`, 'info');
    let tx;
    try { tx = await init.factory.depositToContract(contractId, depositAmount); }
    catch (err) {
      const rej = err.code === 4001 || err.code === 'ACTION_REJECTED';
      cfSetDepStep(3, 'error', rej ? 'Rejected by user' : 'Failed to send');
      showToast(rej ? '⚠️ Rejected.' : `❌ ${err.reason || err.message}`, rej ? 'warning' : 'error');
      return;
    }
    cfLog('Deposit tx:', tx.hash);
    cfSetDepStep(3, 'done');

    // Show tx link
    const txLinkEl = document.getElementById('cf-dep-tx-link');
    if (txLinkEl) {
      txLinkEl.classList.remove('hidden');
      txLinkEl.innerHTML = `<a href="${CF_EXPLORER}/tx/${tx.hash}" target="_blank" rel="noopener"
        class="text-blue-400 hover:text-blue-300 flex items-center gap-1">
        <i class="fas fa-external-link-alt text-[9px]"></i>
        View on ArcScan: ${tx.hash.slice(0, 18)}…
      </a>`;
    }

    // Step 4: Waiting for confirmation
    cfSetDepStep(4, 'active', 'Waiting for block confirmation…');
    showToast(`⏳ Aguardando confirmação…`, 'info');
    const receipt = await tx.wait(1);
    if (receipt.status !== 1) throw new Error('Transação revertida on-chain.');
    cfSetDepStep(4, 'done');

    // Step 5: Confirmed
    cfSetDepStep(5, 'done');
    showToast(`✅ Deposit de $${humanAmount} USDC confirmado! Bloco #${receipt.blockNumber}.`, 'success');
    cfShowTxBadge(receipt.hash, `Deposit $${humanAmount} USDC`);

    // Parse FundsDeposited event
    try {
      const iface = new window.ethers.Interface([
        'event FundsDeposited(uint256 indexed contractId, address indexed depositor, uint256 amount)'
      ]);
      for (const log of receipt.logs) {
        try {
          const decoded = iface.parseLog(log);
          if (decoded?.name === 'FundsDeposited')
            cfLog('FundsDeposited — amount:', cfFmtUsdc(decoded.args[2]));
        } catch { /* other events */ }
      }
    } catch (e) { cfWarn('FundsDeposited parse:', e.message); }

    // Close modal after a short delay
    setTimeout(() => {
      document.getElementById('cf-deposit-modal')?.remove();
      cfLoadContracts();
    }, 2500);

  } catch (err) {
    cfErr('cfExecuteDeposit error:', err);
    const rej = err.code === 4001 || err.code === 'ACTION_REJECTED';
    showToast(rej ? '⚠️ Transação rejeitada.' : `❌ ${err.reason || err.message}`, rej ? 'warning' : 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-arrow-circle-down mr-2"></i>Retry Deposit'; }
  } finally {
    cfState.pending = false;
  }
}

// ─── Withdraw / Receive from Contract ─────────────────────────────────────────
// Only contractor (receiver) can withdraw released funds
async function cfWithdrawFromContract(contractId) {
  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Conecte sua carteira.', 'warning'); return; }
  if (cfState.pending) { showToast('Aguarde a transação atual.', 'warning'); return; }

  const c = cfState.contracts.find(x => x.id === contractId);
  if (!c) { showToast('Contrato não encontrado.', 'error'); return; }

  if (c.contractor?.toLowerCase() !== wallet.toLowerCase()) {
    showToast('❌ Apenas o contratado (receiver) pode sacar fundos.', 'error');
    return;
  }
  if (c.status !== 'Active') {
    showToast('❌ Contrato não está ativo. Verifique o status.', 'error');
    return;
  }

  const releasedAmt = (c.milestones || []).filter(ms => ms.status === 'Released').reduce((s, ms) => s + BigInt(ms.amount), 0n);
  if (releasedAmt <= 0n) {
    showToast('⚠️ Nenhum milestone liberado para saque. Aguarde o cliente liberar milestones.', 'warning');
    return;
  }

  const humanAmt = (Number(releasedAmt) / 1e6).toFixed(2);

  // Show inline withdraw modal
  document.getElementById('cf-withdraw-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'cf-withdraw-modal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm';
  modal.innerHTML = `
    <div class="bg-gray-900 border border-gray-700/60 rounded-2xl w-full max-w-md p-6 shadow-2xl">
      <div class="flex items-center justify-between mb-5">
        <h3 class="text-white font-bold text-base flex items-center gap-2">
          <i class="fas fa-arrow-circle-up text-green-400"></i>
          Receive USDC — Contract #${contractId}
        </h3>
        <button onclick="document.getElementById('cf-withdraw-modal').remove()"
          class="w-7 h-7 flex items-center justify-center rounded-lg bg-gray-700/60 hover:bg-gray-600 text-gray-400 hover:text-white transition">
          <i class="fas fa-times text-xs"></i>
        </button>
      </div>

      <div class="bg-green-900/20 border border-green-700/30 rounded-xl p-4 mb-5">
        <div class="text-xs text-green-400 mb-1 font-semibold uppercase tracking-wide">Available to Receive</div>
        <div class="text-2xl font-bold text-green-300">$${humanAmt} <span class="text-base font-normal text-green-500">USDC</span></div>
        <div class="text-[11px] text-green-600 mt-1">From released milestones on Contract #${contractId}</div>
      </div>

      <!-- Transaction lifecycle panel -->
      <div id="cf-withdraw-steps" class="hidden mb-4 space-y-1 bg-gray-800/40 border border-gray-700/30 rounded-xl p-3">
        <p class="text-[10px] text-gray-500 uppercase tracking-wider mb-2 font-semibold">Transaction Progress</p>
        <div id="cf-wd-step-0" class="ct-step ct-step-idle flex items-center gap-2">
          <div class="ct-step-icon w-5 h-5 rounded-full flex items-center justify-center text-[9px] flex-shrink-0"><i class="fas fa-network-wired"></i></div>
          <span class="text-[11px]">Verify Arc Testnet connection</span>
        </div>
        <div id="cf-wd-step-1" class="ct-step ct-step-idle flex items-center gap-2">
          <div class="ct-step-icon w-5 h-5 rounded-full flex items-center justify-center text-[9px] flex-shrink-0"><i class="fas fa-paper-plane"></i></div>
          <span class="text-[11px]">Submit withdrawal transaction (sign in wallet)</span>
        </div>
        <div id="cf-wd-step-2" class="ct-step ct-step-idle flex items-center gap-2">
          <div class="ct-step-icon w-5 h-5 rounded-full flex items-center justify-center text-[9px] flex-shrink-0"><i class="fas fa-hourglass-half"></i></div>
          <span class="text-[11px]">Waiting for on-chain confirmation…</span>
        </div>
        <div id="cf-wd-step-3" class="ct-step ct-step-idle flex items-center gap-2">
          <div class="ct-step-icon w-5 h-5 rounded-full flex items-center justify-center text-[9px] flex-shrink-0"><i class="fas fa-check-circle"></i></div>
          <span class="text-[11px]">Confirmed — USDC transferred to your wallet</span>
        </div>
        <div id="cf-wd-tx-link" class="hidden text-[11px] mt-1 pt-1 border-t border-gray-700/30"></div>
      </div>

      <div class="flex gap-3">
        <button onclick="cfExecuteWithdraw(${contractId}, ${releasedAmt}n)" id="cf-withdraw-btn"
          class="flex-1 bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-500 hover:to-emerald-500 text-white rounded-xl py-2.5 text-sm font-semibold transition-all flex items-center justify-center gap-2">
          <i class="fas fa-arrow-circle-up"></i>Receive $${humanAmt} USDC
        </button>
        <button onclick="document.getElementById('cf-withdraw-modal').remove()"
          class="px-4 py-2.5 bg-gray-700/60 hover:bg-gray-600/60 text-gray-300 rounded-xl text-sm transition">
          Cancel
        </button>
      </div>

      <div class="mt-3 text-[10px] text-gray-600 flex items-start gap-1.5">
        <i class="fas fa-shield-alt text-gray-600 mt-0.5 flex-shrink-0"></i>
        Only released milestones can be withdrawn. Contract conditions verified on-chain.
      </div>
    </div>`;
  document.body.appendChild(modal);
}

// ─── Execute Withdraw (called from modal button) ───────────────────────────────
async function cfExecuteWithdraw(contractId, releasedAmt) {
  const humanAmt = (Number(releasedAmt) / 1e6).toFixed(2);
  const btn = document.getElementById('cf-withdraw-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Processing…'; }

  // Helper to set withdraw step
  function setWdStep(n, status = 'active', detail = '') {
    const panel = document.getElementById('cf-withdraw-steps');
    if (panel) panel.classList.remove('hidden');
    for (let i = 0; i <= 3; i++) {
      const el = document.getElementById(`cf-wd-step-${i}`);
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

  cfState.pending = true;
  try {
    // Step 0: Network
    setWdStep(0, 'active');
    const init = await cfInitProvider();
    if (!init.ok) {
      setWdStep(0, 'error', init.message.slice(0, 40));
      showToast(`❌ ${init.message}`, 'error');
      return;
    }
    setWdStep(0, 'done');
    cfLog(`Withdraw #${contractId} — $${humanAmt} USDC | wallet: ${init.address}`);

    // Step 1: Send tx
    setWdStep(1, 'active', 'Sign withdrawal in wallet…');
    showToast(`📝 Saque $${humanAmt} USDC — confirme na carteira…`, 'info');
    let tx;
    try { tx = await init.factory.withdrawFromContract(contractId, releasedAmt); }
    catch (err) {
      const rej = err.code === 4001 || err.code === 'ACTION_REJECTED';
      setWdStep(1, 'error', rej ? 'Rejected by user' : 'Failed to send');
      showToast(rej ? '⚠️ Rejected.' : `❌ ${err.reason || err.message}`, rej ? 'warning' : 'error');
      return;
    }
    cfLog('Withdraw tx:', tx.hash);
    setWdStep(1, 'done');

    // Show tx link
    const txLinkEl = document.getElementById('cf-wd-tx-link');
    if (txLinkEl) {
      txLinkEl.classList.remove('hidden');
      txLinkEl.innerHTML = `<a href="${CF_EXPLORER}/tx/${tx.hash}" target="_blank" rel="noopener"
        class="text-blue-400 hover:text-blue-300 flex items-center gap-1">
        <i class="fas fa-external-link-alt text-[9px]"></i>
        View on ArcScan: ${tx.hash.slice(0, 18)}…
      </a>`;
    }

    // Step 2: Waiting
    setWdStep(2, 'active', 'Waiting for block confirmation…');
    showToast('⏳ Aguardando confirmação on-chain…', 'info');
    const receipt = await tx.wait(1);
    if (receipt.status !== 1) throw new Error('Transação revertida on-chain.');
    setWdStep(2, 'done');

    // Step 3: Confirmed
    setWdStep(3, 'done');
    showToast(`✅ Saque de $${humanAmt} USDC confirmado! Bloco #${receipt.blockNumber}.`, 'success');
    cfShowTxBadge(receipt.hash, `Receive $${humanAmt} USDC`);

    // Parse FundsWithdrawn event
    try {
      const iface = new window.ethers.Interface([
        'event FundsWithdrawn(uint256 indexed contractId, address indexed recipient, uint256 amount)'
      ]);
      for (const log of receipt.logs) {
        try {
          const decoded = iface.parseLog(log);
          if (decoded?.name === 'FundsWithdrawn')
            cfLog('FundsWithdrawn — amount:', cfFmtUsdc(decoded.args[2]));
        } catch { /* other events */ }
      }
    } catch (e) { cfWarn('FundsWithdrawn parse:', e.message); }

    setTimeout(() => {
      document.getElementById('cf-withdraw-modal')?.remove();
      cfLoadContracts();
    }, 2500);

  } catch (err) {
    cfErr('cfExecuteWithdraw error:', err);
    const rej = err.code === 4001 || err.code === 'ACTION_REJECTED';
    showToast(rej ? '⚠️ Transação rejeitada.' : `❌ ${err.reason || err.message}`, rej ? 'warning' : 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = `<i class="fas fa-arrow-circle-up mr-2"></i>Retry Receive`; }
  } finally {
    cfState.pending = false;
  }
}

// ─── Release Milestone (client releases payment to contractor) ─────────────────
async function cfReleaseMilestone(contractId, milestoneIdx) {
  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Conecte sua carteira.', 'warning'); return; }
  if (cfState.pending) { showToast('Aguarde a transação atual.', 'warning'); return; }

  const c = cfState.contracts.find(x => x.id === contractId);
  if (c && c.client?.toLowerCase() !== wallet.toLowerCase()) {
    showToast('❌ Apenas o cliente pode liberar milestones.', 'error');
    return;
  }

  const ms = c?.milestones?.[milestoneIdx];
  const humanAmt = ms ? cfFmtUsdc(ms.amount) : '?';

  if (!window.confirm(
    `Release Milestone ${milestoneIdx + 1} of Contract #${contractId}?\n\n` +
    `Amount: $${humanAmt} USDC will be made available for the contractor to withdraw.\n` +
    `This action is irreversible.`
  )) return;

  cfState.pending = true;
  try {
    cfLog(`Release milestone #${milestoneIdx} of contract #${contractId}`);
    const receipt = await cfRunTx(
      `Release Milestone ${milestoneIdx + 1} — $${humanAmt} USDC`,
      async ({ factory }) => factory.completeMilestone(contractId, milestoneIdx)
    );
    if (!receipt) return;

    // Parse MilestoneCompleted event
    try {
      const iface = new window.ethers.Interface([
        'event MilestoneCompleted(uint256 indexed contractId, uint256 indexed milestoneId, uint256 amount)'
      ]);
      for (const log of receipt.logs) {
        try {
          const decoded = iface.parseLog(log);
          if (decoded?.name === 'MilestoneCompleted')
            cfLog('MilestoneCompleted — contractId:', Number(decoded.args[0]), 'milestoneId:', Number(decoded.args[1]));
        } catch { /* other events */ }
      }
    } catch (e) { cfWarn('MilestoneCompleted parse:', e.message); }

    setTimeout(cfLoadContracts, 1500);
  } finally {
    cfState.pending = false;
  }
}

// ─── Sign Contract ─────────────────────────────────────────────────────────────
async function cfSignContract(contractId) {
  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Conecte sua carteira.', 'warning'); return; }
  if (cfState.pending) { showToast('Aguarde a transação atual.', 'warning'); return; }

  const c = cfState.contracts.find(x => x.id === contractId);
  if (c && c.contractor?.toLowerCase() !== wallet.toLowerCase()) {
    showToast('❌ Apenas o contratado pode assinar o contrato.', 'error');
    return;
  }

  cfState.pending = true;
  try {
    const receipt = await cfRunTx(
      `Sign Contract #${contractId}`,
      async ({ factory }) => factory.signContract(contractId)
    );
    if (receipt) setTimeout(cfLoadContracts, 1500);
  } finally {
    cfState.pending = false;
  }
}

// ─── Cancel Contract ──────────────────────────────────────────────────────────
async function cfCancelContract(contractId) {
  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Conecte sua carteira.', 'warning'); return; }
  if (cfState.pending) { showToast('Aguarde a transação atual.', 'warning'); return; }

  const c = cfState.contracts.find(x => x.id === contractId);
  if (c && c.client?.toLowerCase() !== wallet.toLowerCase()) {
    showToast('❌ Apenas o cliente pode cancelar o contrato.', 'error');
    return;
  }

  if (!window.confirm(
    `Cancel Contract #${contractId}?\n\n` +
    `Deposited USDC ($${c ? cfFmtUsdc(c.depositedValue) : '?'}) will be refunded to you.\n` +
    `Esta ação é irreversível.`
  )) return;

  cfState.pending = true;
  try {
    const receipt = await cfRunTx(
      `Cancel Contract #${contractId}`,
      async ({ factory }) => factory.cancelContract(contractId)
    );
    if (receipt) setTimeout(cfLoadContracts, 1500);
  } finally {
    cfState.pending = false;
  }
}

// ─── Create Contract ──────────────────────────────────────────────────────────
async function cfCreateContract() {
  if (cfState.pending) { showToast('Transação em andamento, aguarde.', 'warning'); return; }
  const wallet = window.walletState?.address;
  if (!wallet) { showToast('⚠️ Conecte sua carteira antes de criar um contrato.', 'warning'); return; }

  const contractor  = cfEl('cf-contractor')?.value?.trim();
  const title       = cfEl('cf-title')?.value?.trim();
  const totalValue  = cfEl('cf-value')?.value?.trim();
  const msRows      = document.querySelectorAll('.cf-milestone-row');

  if (!contractor || !title || !totalValue) { showToast('Preencha todos os campos obrigatórios.', 'warning'); return; }
  if (!/^0x[0-9a-fA-F]{40}$/.test(contractor)) { showToast('Endereço do contratado inválido.', 'error'); return; }
  if (contractor.toLowerCase() === wallet.toLowerCase()) { showToast('Cliente e contratado não podem ser o mesmo endereço.', 'error'); return; }

  const humanAmount = parseFloat(totalValue);
  if (isNaN(humanAmount) || humanAmount <= 0) { showToast('Valor total deve ser maior que 0.', 'error'); return; }

  const milestoneDescs   = [];
  const milestoneAmounts = [];
  msRows.forEach(row => {
    const d = row.querySelector('.cf-ms-desc')?.value?.trim();
    const a = parseFloat(row.querySelector('.cf-ms-amt')?.value || '0');
    if (d && a > 0) { milestoneDescs.push(d); milestoneAmounts.push(cfParseUsdc(a)); }
  });

  if (!milestoneDescs.length) { showToast('Adicione pelo menos 1 milestone.', 'warning'); return; }
  if (milestoneDescs.length > 10) { showToast('Máximo de 10 milestones.', 'error'); return; }

  const totalRaw = cfParseUsdc(humanAmount);
  const sumMs    = milestoneAmounts.reduce((a, b) => a + b, 0n);
  if (sumMs !== totalRaw) {
    const diff = Math.abs(Number(totalRaw - sumMs)) / 1e6;
    showToast(`Soma dos milestones ($${Number(sumMs)/1e6} USDC) ≠ total ($${humanAmount} USDC). Diferença: $${diff.toFixed(6)}.`, 'error');
    return;
  }

  cfState.pending = true;
  const btn = cfEl('cf-submit-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Processando…'; }

  const unlock = () => {
    cfState.pending = false;
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-file-plus mr-2"></i>Criar Contrato'; }
  };

  try {
    cfSetStep(0);
    const init = await cfInitProvider();
    if (!init.ok) {
      if (init.error === 'wrong_network') { showToast('Rede incorreta. Troque para Arc Testnet.', 'error'); cfShowListState('wrong_network', init.message); }
      else showToast(`❌ ${init.message}`, 'error');
      unlock(); return;
    }
    const { signer, factory, usdc, address: fromAddr } = init;

    // Step 1: Balance
    cfSetStep(1, 'active', 'Verificar saldo USDC');
    const balance = await cfReadBalance(fromAddr);
    cfLog('Create — wallet:', fromAddr, '| balance:', cfFmtUsdc(balance), '| needed:', humanAmount);
    if (balance < totalRaw) {
      throw new Error(`Saldo insuficiente: $${cfFmtUsdc(balance)} disponível, $${humanAmount} necessário.`);
    }

    // Step 2: Approve
    cfSetStep(2, 'active', 'Verificar allowance USDC');
    await cfEnsureApproval(init, totalRaw);

    // Step 3: Gas estimate
    cfSetStep(3, 'active', 'Estimando gas…');
    let gasLimit;
    try {
      gasLimit = await factory.createContract.estimateGas(contractor, title, totalRaw, milestoneDescs, milestoneAmounts);
      gasLimit = (gasLimit * 125n) / 100n;
    } catch (e) { cfWarn('estimateGas failed:', e.message); gasLimit = 500000n; }

    let feeData;
    try { feeData = await init.provider.getFeeData(); } catch { feeData = { gasPrice: null }; }
    const gasPrice  = feeData?.gasPrice ?? 10000000000n;
    const gasFeeUsdc = (Number(gasLimit * gasPrice) / 1e6).toFixed(6);
    cfLog('Gas:', gasLimit.toString(), '| price:', gasPrice.toString(), '| fee:', gasFeeUsdc, 'USDC');
    showToast(`⛽ Gas estimado: ${gasFeeUsdc} USDC. Confirme na carteira…`, 'info');

    // Step 4: Send
    cfSetStep(4, 'active', 'Aguardando assinatura…');
    const createTx = await factory.createContract(contractor, title, totalRaw, milestoneDescs, milestoneAmounts, { gasLimit });
    cfState.lastTxHash = createTx.hash;
    cfLog('createContract tx:', createTx.hash);
    showToast(`📤 Tx: <a href="${CF_EXPLORER}/tx/${createTx.hash}" target="_blank" class="underline font-mono">${createTx.hash.slice(0, 18)}…</a>`, 'info');

    // Step 5: Confirm
    cfSetStep(5, 'active', 'Aguardando confirmação (1–3 blocos)…');
    const receipt = await createTx.wait(1);
    cfLog('createContract confirmed — block:', receipt.blockNumber, 'status:', receipt.status);
    if (receipt.status !== 1) throw new Error(`Tx revertida no bloco #${receipt.blockNumber}.`);

    // Extract ContractCreated event
    let newId = null;
    try {
      const iface = new window.ethers.Interface([
        'event ContractCreated(uint256 indexed contractId, address indexed client, address indexed contractor, uint256 totalValue)'
      ]);
      for (const log of receipt.logs) {
        try {
          const d = iface.parseLog(log);
          if (d?.name === 'ContractCreated') { newId = Number(d.args[0]); cfLog('ContractCreated #', newId); break; }
        } catch { /* other events */ }
      }
    } catch (e) { cfWarn('ContractCreated parse:', e.message); }

    // Step 6: Reload
    cfSetStep(6, 'active', 'Recarregando…');
    showToast(
      `✅ Contrato${newId !== null ? ` #${newId}` : ''} criado! Bloco #${receipt.blockNumber} · <a href="${CF_EXPLORER}/tx/${receipt.hash}" target="_blank" class="underline">ArcScan ↗</a>`,
      'success'
    );
    cfShowTxBadge(receipt.hash, `createContract${newId !== null ? ` #${newId}` : ''} — $${humanAmount} USDC`);

    cfEl('cf-title').value      = '';
    cfEl('cf-contractor').value = '';
    cfEl('cf-value').value      = '';
    cfResetMilestones();
    setTimeout(cfLoadContracts, 1500);

  } catch (err) {
    cfErr('cfCreateContract error:', err);
    const rejected = err.code === 4001 || err.code === 'ACTION_REJECTED' || err.message?.includes('rejected') || err.message?.includes('denied');
    if (rejected) { showToast('⚠️ Transação rejeitada.', 'warning'); cfHideSteps(); }
    else { showToast(`❌ ${err.reason || err.message}`, 'error'); cfSetStep(0, 'error', err.message?.slice(0, 50)); }
  } finally {
    unlock();
    setTimeout(cfHideSteps, 20000);
  }
}

// ─── Milestone form ────────────────────────────────────────────────────────────
let cfMilestoneCount = 1;

function cfAddMilestone() {
  if (cfMilestoneCount >= 10) { showToast('Máximo de 10 milestones.', 'warning'); return; }
  cfMilestoneCount++;
  const container = cfEl('cf-milestones-container');
  if (!container) return;
  const row = document.createElement('div');
  row.className = 'cf-milestone-row flex items-center gap-2';
  row.innerHTML = `
    <input type="text" placeholder="Descrição do milestone"
      class="cf-ms-desc flex-1 bg-gray-800/60 border border-gray-600/40 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-cyan-500/60 focus:outline-none"
      oninput="cfUpdateMilestoneSum()" />
    <input type="number" placeholder="USDC" step="0.01" min="0.01"
      class="cf-ms-amt w-28 bg-gray-800/60 border border-gray-600/40 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-cyan-500/60 focus:outline-none"
      oninput="cfUpdateMilestoneSum()" />
    <button onclick="this.parentElement.remove(); cfUpdateMilestoneSum()" type="button"
      class="w-8 h-8 flex items-center justify-center bg-red-900/20 hover:bg-red-900/30 border border-red-700/30 text-red-400 rounded-lg transition flex-shrink-0">
      <i class="fas fa-times text-xs"></i>
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
      <input type="text" placeholder="Descrição do milestone"
        class="cf-ms-desc flex-1 bg-gray-800/60 border border-gray-600/40 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-cyan-500/60 focus:outline-none"
        oninput="cfUpdateMilestoneSum()" />
      <input type="number" placeholder="USDC" step="0.01" min="0.01"
        class="cf-ms-amt w-28 bg-gray-800/60 border border-gray-600/40 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-cyan-500/60 focus:outline-none"
        oninput="cfUpdateMilestoneSum()" />
    </div>`;
}

function cfUpdateMilestoneSum() {
  let sum = 0;
  document.querySelectorAll('.cf-milestone-row').forEach(r => {
    const v = parseFloat(r.querySelector('.cf-ms-amt')?.value || '0');
    if (v > 0) sum += v;
  });
  const total = parseFloat(cfEl('cf-value')?.value || '0');
  const sumEl = cfEl('cf-ms-sum');
  if (sumEl) {
    const diff = Math.abs(sum - total);
    const ok   = diff < 0.000001;
    sumEl.textContent = `Soma: $${sum.toFixed(6)} USDC${ok ? ' ✅' : ` (diferença: $${diff.toFixed(6)})`}`;
    sumEl.className   = `text-xs mt-1 ${ok ? 'text-green-400' : 'text-yellow-400'}`;
  }
}

// ─── Wallet gate ───────────────────────────────────────────────────────────────
function cfWalletGateUpdate() {
  const wallet = window.walletState?.address;
  if (!wallet) { cfShowListState('no_wallet'); cfRenderSummary([], null); }
}

// ─── Wallet event listeners ────────────────────────────────────────────────────
window.addEventListener('walletConnected', () => {
  cfLog('walletConnected → cfLoadContracts()');
  cfLoadContracts();
});
window.addEventListener('walletDisconnected', () => {
  cfLog('walletDisconnected → no_wallet');
  cfShowListState('no_wallet');
  cfRenderSummary([], null);
  cfState.contracts = [];
  cfState.networkOk = false;
});
window.addEventListener('walletChanged', () => {
  cfLog('walletChanged → cfLoadContracts()');
  cfLoadContracts();
});

// ─── Expose globally ──────────────────────────────────────────────────────────
window.cfCreateContract        = cfCreateContract;
window.cfLoadContracts         = cfLoadContracts;
window.cfSignContract          = cfSignContract;
window.cfDepositToContract     = cfDepositToContract;
window.cfExecuteDeposit        = cfExecuteDeposit;
window.cfWithdrawFromContract  = cfWithdrawFromContract;
window.cfExecuteWithdraw       = cfExecuteWithdraw;
window.cfReleaseMilestone      = cfReleaseMilestone;
window.cfCancelContract        = cfCancelContract;
window.cfAddMilestone          = cfAddMilestone;
window.cfUpdateMilestoneSum    = cfUpdateMilestoneSum;
window.cfWalletGateUpdate      = cfWalletGateUpdate;
window.cfSwitchNetwork         = cfSwitchNetwork;
window.cfState                 = cfState;
window.cfUiStatus              = cfUiStatus;
window.loadContracts           = cfLoadContracts; // legacy alias

console.log(
  '[CF] Contracts module loaded (5-state machine: Pending→Funded→Active→Completed→Cancelled)',
  '| Factory:', CF_FACTORY_ADDR,
  '| USDC:', CF_USDC_ADDR,
  '| Chain:', CF_CHAIN_ID
);
