// ============================================================
// ARC Contracts Module v4 — On-chain Escrow + Proof-of-Work
// ContractFactory: 0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A
// Arc Testnet (chainId 5042002) | USDC
// Features: escrow, milestone release, proof-of-work IPFS upload,
//           0.2% platform fee, email fields, OTC negotiation,
//           Mark as Complete (requires proof), PDF receipt
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
const CF_META_KEY      = 'arc_cf_meta_v4'; // localStorage key for off-chain metadata

// IPFS via nft.storage public gateway (no key needed for small files via w3s)
// Fallback: store as data URI in localStorage if IPFS unavailable
const CF_IPFS_API      = 'https://api.web3.storage/upload';

// ─── ABIs ─────────────────────────────────────────────────────────────────────
const CF_ABI = [
  'function contractCount() view returns (uint256)',
  'function getContract(uint256 id) view returns (uint256,address,address,string,uint256,uint256,uint8,bool,uint256,uint256,uint256,uint256,uint256)',
  'function getMilestones(uint256 id) view returns (tuple(uint256 id, string description, uint256 amount, uint8 status, uint256 releasedAt)[])',
  'function getByClient(address) view returns (uint256[])',
  'function getByContractor(address) view returns (uint256[])',
  'function createContract(address,string,uint256,string[],uint256[]) returns (uint256)',
  'function signContract(uint256)',
  'function depositToContract(uint256,uint256)',
  'function withdrawFromContract(uint256,uint256)',
  'function completeMilestone(uint256,uint256)',
  'function cancelContract(uint256)',
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

// ─── Status mapping ────────────────────────────────────────────────────────────
const CF_STATUS_LABELS = ['Draft', 'Active', 'Completed', 'Cancelled'];
const CF_STATUS_MAP = {
  Pending:   { color: 'yellow', icon: 'fa-clock',        label: 'Pending' },
  Funded:    { color: 'blue',   icon: 'fa-coins',        label: 'Funded — Awaiting Signature' },
  Active:    { color: 'cyan',   icon: 'fa-bolt',         label: 'Active' },
  Completed: { color: 'green',  icon: 'fa-check-circle', label: 'Completed' },
  Cancelled: { color: 'red',    icon: 'fa-times-circle', label: 'Cancelled' },
  Draft:     { color: 'yellow', icon: 'fa-clock',        label: 'Pending' },
};

function cfUiStatus(c) {
  if (c.status === 'Cancelled') return 'Cancelled';
  if (c.status === 'Completed') return 'Completed';
  if (c.status === 'Active')    return 'Active';
  if (BigInt(c.depositedValue) > 0n) return 'Funded';
  return 'Pending';
}

// ─── Module state ─────────────────────────────────────────────────────────────
const cfState = {
  pending:    false,
  contracts:  [],
  milestones: {},
  lastTxHash: null,
  networkOk:  false,
  _provider:  null,
  _factory:   null,
  _usdc:      null,
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

// ─── Helpers ──────────────────────────────────────────────────────────────────
function cfEl(id)       { return document.getElementById(id); }
function cfShort(addr)  { if (!addr || addr.length < 12) return addr || '—'; return addr.slice(0, 8) + '…' + addr.slice(-6); }
function cfTs(ts)       { if (!ts || ts === 0) return '—'; return new Date(Number(ts) * 1000).toLocaleString('pt-BR', { dateStyle: 'medium', timeStyle: 'short' }); }
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
    if (!rawProv) return { ok: false, error: 'no_wallet', message: 'Carteira não conectada.' };
    if (!window.ethers) return { ok: false, error: 'no_ethers', message: 'ethers.js não carregado.' };

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
    catch (e) { return { ok: false, error: 'no_signer', message: 'Não foi possível obter signer: ' + e.message }; }

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

async function cfReadBalance(addr) {
  const hex = await cfRpcCall(CF_USDC_ADDR, CF_SEL.usdcBalanceOf + cfEncAddr(addr));
  return hex && hex !== '0x' ? BigInt(hex) : 0n;
}
async function cfReadAllowance(owner, spender) {
  const data = CF_SEL.usdcAllowance + cfEncAddr(owner) + cfPad(spender.replace(/^0x/, ''), 32);
  const hex  = await cfRpcCall(CF_USDC_ADDR, data);
  return hex && hex !== '0x' ? BigInt(hex) : 0n;
}

// ─── Fetch contract data ────────────────────────────────────────────────────────
async function cfFetchContract(factory, id) {
  const r = await factory.getContract(id);
  const statusCode = Number(r[6]);
  const status = CF_STATUS_LABELS[statusCode] || 'Unknown';
  return {
    id, client: r[1], contractor: r[2], title: r[3],
    totalValue: r[4], depositedValue: r[5],
    statusCode, status,
    contractorSigned: r[7],
    createdAt: Number(r[8]), startedAt: Number(r[9]), completedAt: Number(r[10]),
    milestoneCount: Number(r[11]), completedMilestones: Number(r[12]),
  };
}

async function cfFetchMilestones(factory, id) {
  const rows = await factory.getMilestones(id);
  return rows.map((m, i) => ({
    id: i, description: m.description, amount: m.amount,
    status: Number(m.status) === 1 ? 'Released' : 'Pending',
    releasedAt: Number(m.releasedAt),
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
async function cfLoadContracts() {
  const wallet = window.walletState?.address;
  if (!wallet) { cfShowListState('no_wallet'); cfRenderSummary([], null); return; }
  cfShowListState('loading');
  try {
    const init = await cfInitProvider();
    if (!init.ok) {
      if (init.error === 'wrong_network') cfShowListState('wrong_network', init.message);
      else cfShowListState('error', init.message);
      return;
    }
    const { factory, address } = init;
    const ids = await cfFetchMyIds(address);
    cfLog('Contract IDs for', address, ':', ids);
    if (!ids.length) { cfShowListState('empty'); cfRenderSummary([], address); cfState.contracts = []; return; }

    const contracts = await Promise.all(ids.map(id => cfFetchContract(factory, id)));
    const milestones = {};
    await Promise.all(contracts.map(async c => {
      try { milestones[c.id] = await cfFetchMilestones(factory, c.id); c.milestones = milestones[c.id]; }
      catch (e) { cfWarn('milestones fetch error', c.id, e.message); c.milestones = []; }
    }));

    cfState.contracts = contracts;
    cfState.milestones = milestones;
    cfRenderContracts(contracts, address);
    cfRenderSummary(contracts, address);
  } catch (e) {
    cfErr('cfLoadContracts:', e);
    cfShowListState('error', e.message);
  }
}

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
  if (!contracts.length) { cfShowListState('empty'); return; }

  const order = { Active: 0, Funded: 1, Pending: 2, Completed: 3, Cancelled: 4 };
  const sorted = [...contracts].sort((a, b) => (order[cfUiStatus(a)] ?? 9) - (order[cfUiStatus(b)] ?? 9));

  el.innerHTML = sorted.map(c => cfContractCard(c, wallet)).join('');
}

// ─── Status badge ─────────────────────────────────────────────────────────────
function cfStatusBadge(uiStatus) {
  const colors = {
    Pending:   'cf-badge-pending', Funded: 'cf-badge-funded',
    Active:    'cf-badge-active',  Completed: 'cf-badge-completed', Cancelled: 'cf-badge-cancelled',
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
  const role      = isClient ? 'Payer (Client)' : isContr ? 'Receiver (Contractor)' : 'Observer';
  const roleColor = isClient ? '#60b4ff' : isContr ? '#34d399' : '#6b7280';

  const total     = BigInt(c.totalValue);
  const deposited = BigInt(c.depositedValue);
  const pct       = total > 0n ? Math.min(100, Math.round(Number(deposited * 100n / total))) : 0;

  const feeRaw    = cfCalcFee(total);
  const netRaw    = cfNetAmount(total);

  const milestones = c.milestones || [];
  const releasedAmt = milestones.filter(m => m.status === 'Released').reduce((s, m) => s + BigInt(m.amount), 0n);

  const meta      = cfGetMeta(c.id);
  const proofs    = meta.proofs || [];
  const hasProofs = proofs.length > 0;

  // Action buttons
  let actionBtns = '';
  if (uiStatus === 'Pending' && isClient)
    actionBtns += `<button onclick="cfDepositToContract(${c.id})" class="cf-action-btn cf-btn-deposit"><i class="fas fa-arrow-circle-down mr-1.5"></i>Deposit USDC</button>`;
  if (uiStatus === 'Funded' && isContr && !c.contractorSigned)
    actionBtns += `<button onclick="cfSignContract(${c.id})" class="cf-action-btn cf-btn-sign"><i class="fas fa-pen-nib mr-1.5"></i>Sign Contract</button>`;
  if (uiStatus === 'Funded' && isClient)
    actionBtns += `<button onclick="cfDepositToContract(${c.id})" class="cf-action-btn cf-btn-deposit"><i class="fas fa-plus-circle mr-1.5"></i>Add Funds</button>`;
  if (uiStatus === 'Active' && isClient)
    actionBtns += `<button onclick="cfShowProofUpload(${c.id})" class="cf-action-btn cf-btn-proof"><i class="fas fa-upload mr-1.5"></i>Upload Proof</button>`;
  if (uiStatus === 'Active' && isContr && releasedAmt > 0n)
    actionBtns += `<button onclick="cfWithdrawFromContract(${c.id})" class="cf-action-btn cf-btn-receive"><i class="fas fa-arrow-circle-up mr-1.5"></i>Receive $${cfFmtUsdc(releasedAmt)}</button>`;
  if (uiStatus === 'Active' && isClient) {
    const completeDisabled = !hasProofs;
    actionBtns += `<button onclick="${completeDisabled ? 'showToast(\'Upload proof-of-work antes de marcar como concluído.\',\'warning\')' : `cfMarkComplete(${c.id})`}"
      class="cf-action-btn ${completeDisabled ? 'cf-btn-disabled' : 'cf-btn-complete'}"
      title="${completeDisabled ? 'Upload proof-of-work first' : 'Mark contract as complete and release all funds'}">
      <i class="fas fa-flag-checkered mr-1.5"></i>Mark as Complete
      ${completeDisabled ? '<span style="font-size:9px;opacity:0.6;">(need proof)</span>' : ''}
    </button>`;
  }
  if ((uiStatus === 'Pending' || uiStatus === 'Funded') && isClient)
    actionBtns += `<button onclick="cfCancelContract(${c.id})" class="cf-action-btn cf-btn-cancel"><i class="fas fa-times mr-1.5"></i>Cancel</button>`;
  if (uiStatus === 'Completed')
    actionBtns += `<button onclick="cfDownloadReceipt(${c.id})" class="cf-action-btn cf-btn-receipt"><i class="fas fa-file-pdf mr-1.5"></i>Download Receipt</button>`;

  // Milestones rows
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
          ${uiStatus==='Active'&&isClient&&m.status==='Pending'
            ? `<button onclick="cfReleaseMilestone(${c.id},${i})" style="font-size:10px;background:rgba(52,211,153,0.12);border:1px solid rgba(52,211,153,0.25);color:#34d399;padding:2px 8px;border-radius:6px;cursor:pointer;">Release</button>`
            : `<span style="font-size:10px;color:${m.status==='Released'?'#34d399':'#3a4870'};">${m.status}</span>`}
        </div>`).join('')}
    </div>` : '';

  // Proofs section
  const proofsHtml = `
    <div style="margin-top:8px;">
      <div style="display:flex;align-items:center;justify-content:between;gap:6px;margin-bottom:4px;">
        <p style="font-size:10px;color:#3a4870;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;flex:1;">Proof of Work</p>
        ${uiStatus==='Active'&&isContr ? `<button onclick="cfShowProofUpload(${c.id})" style="font-size:10px;color:#a78bfa;background:rgba(167,139,250,0.08);border:1px solid rgba(167,139,250,0.2);padding:2px 8px;border-radius:6px;cursor:pointer;"><i class="fas fa-upload mr-1"></i>Upload</button>` : ''}
      </div>
      ${proofs.length ? proofs.map(p => `
        <div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid rgba(167,139,250,0.06);">
          <i class="fas ${p.type==='image'?'fa-image':p.type==='pdf'?'fa-file-pdf':'fa-file'}" style="color:#a78bfa;font-size:12px;flex-shrink:0;"></i>
          <span style="flex:1;font-size:11px;color:#8899bb;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.name}</span>
          <a href="${p.url}" target="_blank" style="font-size:10px;color:#a78bfa;background:rgba(167,139,250,0.08);border:1px solid rgba(167,139,250,0.18);padding:2px 8px;border-radius:6px;">View</a>
        </div>`).join('')
        : `<p style="font-size:11px;color:#252a40;font-style:italic;">No proof uploaded yet.</p>`}
    </div>`;

  // Meta info (emails, OTC)
  const metaHtml = (meta.clientEmail || meta.contractorEmail || meta.otcPoints) ? `
    <div style="margin-top:8px;padding:8px;background:rgba(55,138,221,0.04);border:1px solid rgba(55,138,221,0.1);border-radius:10px;">
      ${meta.clientEmail ? `<div style="font-size:11px;color:#4a6490;"><i class="fas fa-envelope mr-1" style="color:#60b4ff;"></i>Client: ${meta.clientEmail}</div>` : ''}
      ${meta.contractorEmail ? `<div style="font-size:11px;color:#4a6490;"><i class="fas fa-envelope mr-1" style="color:#34d399;"></i>Contractor: ${meta.contractorEmail}</div>` : ''}
      ${meta.otcPoints ? `<div style="font-size:11px;color:#c4b5fd;margin-top:4px;"><i class="fas fa-handshake mr-1" style="color:#a78bfa;"></i>OTC: ${meta.otcPoints}</div>` : ''}
      ${meta.otcTerms ? `<div style="font-size:10px;color:#4a3a7a;margin-top:2px;">${meta.otcTerms}</div>` : ''}
    </div>` : '';

  return `
  <div class="cf-card mb-4" style="overflow:hidden;">
    <!-- Card header -->
    <div style="padding:14px 16px 0;">
      <div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:10px;">
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            <span style="font-size:13px;font-weight:800;color:#dde2f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px;">${c.title || 'Untitled'}</span>
            <span style="font-size:10px;color:#3a4870;font-family:monospace;">#${c.id}</span>
            ${cfStatusBadge(uiStatus)}
          </div>
          <div style="display:flex;gap:6px;margin-top:4px;flex-wrap:wrap;">
            <span style="font-size:10px;font-weight:600;background:rgba(55,138,221,0.08);border:1px solid rgba(55,138,221,0.15);color:${roleColor};padding:1px 8px;border-radius:999px;">${role}</span>
          </div>
        </div>
        <div style="text-align:right;flex-shrink:0;">
          <div style="font-size:18px;font-weight:800;color:#dde2f0;">$${cfFmtUsdc(total)}</div>
          <div style="font-size:10px;color:#3a4870;">USDC · 0.2% fee</div>
          <div style="font-size:10px;color:#4a6490;">Net: $${cfFmtUsdc(netRaw)}</div>
        </div>
      </div>

      <!-- Escrow bar -->
      <div style="margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;font-size:10px;color:#3a4870;margin-bottom:4px;">
          <span>Escrow: $${cfFmtUsdc(deposited)} / $${cfFmtUsdc(total)}</span>
          <span>${pct}% funded</span>
        </div>
        <div style="height:4px;background:rgba(55,138,221,0.1);border-radius:4px;overflow:hidden;">
          <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#378ADD,#1D9E75);border-radius:4px;transition:width 0.5s;"></div>
        </div>
      </div>

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

      <!-- Fee breakdown -->
      <div style="display:flex;gap:8px;margin-bottom:10px;font-size:10px;">
        <div style="flex:1;background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.15);border-radius:8px;padding:6px 10px;">
          <div style="color:#6b7280;">Platform Fee (0.2%)</div>
          <div style="color:#fbbf24;font-weight:700;">$${cfFmtUsdc(feeRaw)} USDC</div>
        </div>
        <div style="flex:1;background:rgba(52,211,153,0.06);border:1px solid rgba(52,211,153,0.15);border-radius:8px;padding:6px 10px;">
          <div style="color:#6b7280;">Net to Contractor</div>
          <div style="color:#34d399;font-weight:700;">$${cfFmtUsdc(netRaw)} USDC</div>
        </div>
      </div>

      ${metaHtml}
      ${msHtml}
      ${proofsHtml}

      <!-- State machine -->
      <div style="margin:10px 0;">${cfStateProgress(uiStatus)}</div>

      <!-- Timestamps -->
      <div style="font-size:10px;color:#252a40;margin-bottom:6px;">
        Created: ${cfTs(c.createdAt)}
        ${c.startedAt ? ` · Started: ${cfTs(c.startedAt)}` : ''}
        ${c.completedAt ? ` · Completed: ${cfTs(c.completedAt)}` : ''}
        · <a href="${CF_EXPLORER}/address/${CF_FACTORY_ADDR}" target="_blank" style="color:#3a5a8a;">ArcScan ↗</a>
      </div>
    </div>

    <!-- Action buttons -->
    ${actionBtns ? `<div style="padding:10px 16px 14px;display:flex;gap:6px;flex-wrap:wrap;border-top:1px solid rgba(55,138,221,0.08);">${actionBtns}</div>` : ''}
  </div>`;
}

// ─── Proof-of-Work Upload Modal ────────────────────────────────────────────────
function cfShowProofUpload(contractId) {
  document.getElementById('cf-proof-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'cf-proof-modal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm';
  modal.innerHTML = `
  <div style="background:#0a0c18;border:1px solid rgba(167,139,250,0.3);border-radius:20px;width:100%;max-width:480px;padding:24px;box-shadow:0 0 40px rgba(167,139,250,0.15);">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
      <h3 style="color:#dde2f0;font-size:16px;font-weight:800;display:flex;align-items:center;gap:8px;">
        <i class="fas fa-upload" style="color:#a78bfa;"></i>Upload Proof of Work — #${contractId}
      </h3>
      <button onclick="document.getElementById('cf-proof-modal').remove()"
        style="width:28px;height:28px;border-radius:8px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#6b7280;cursor:pointer;display:flex;align-items:center;justify-content:center;">
        <i class="fas fa-times text-xs"></i>
      </button>
    </div>

    <!-- Drop zone -->
    <div id="cf-proof-drop" class="cf-proof-drop"
      style="padding:32px;text-align:center;cursor:pointer;margin-bottom:16px;"
      onclick="document.getElementById('cf-proof-file-input').click()"
      ondragover="event.preventDefault();this.classList.add('drag-over')"
      ondragleave="this.classList.remove('drag-over')"
      ondrop="cfHandleProofDrop(event,${contractId})">
      <i class="fas fa-cloud-upload-alt" style="font-size:32px;color:#a78bfa;margin-bottom:10px;display:block;"></i>
      <p style="color:#dde2f0;font-size:14px;font-weight:600;margin-bottom:4px;">Drop files here or click to browse</p>
      <p style="color:#4a3a7a;font-size:11px;">Images (JPG, PNG, GIF), PDFs, Word documents · Max 10MB each</p>
    </div>
    <input type="file" id="cf-proof-file-input" multiple accept="image/*,.pdf,.doc,.docx"
      style="display:none;" onchange="cfHandleProofFiles(event,${contractId})">

    <!-- Preview list -->
    <div id="cf-proof-preview-list" style="margin-bottom:16px;space-y:8px;"></div>

    <!-- Upload status -->
    <div id="cf-proof-status" style="display:none;margin-bottom:12px;padding:10px 14px;border-radius:10px;font-size:12px;"></div>

    <div style="display:flex;gap:10px;">
      <button onclick="cfExecuteProofUpload(${contractId})" id="cf-proof-upload-btn"
        style="flex:1;background:linear-gradient(135deg,#6d28d9,#5b21b6);color:#fff;border:none;border-radius:12px;padding:11px;font-size:13px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;">
        <i class="fas fa-cloud-upload-alt"></i>Upload to IPFS
      </button>
      <button onclick="document.getElementById('cf-proof-modal').remove()"
        style="padding:11px 18px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);color:#6b7280;border-radius:12px;cursor:pointer;font-size:13px;">
        Cancel
      </button>
    </div>
    <p style="font-size:10px;color:#3a4870;margin-top:10px;text-align:center;">
      <i class="fas fa-shield-alt mr-1"></i>Files stored on IPFS via Web3.Storage. References saved locally.
    </p>
  </div>`;
  document.body.appendChild(modal);
  window._cfProofFiles = [];
}

// Drag and drop
function cfHandleProofDrop(event, contractId) {
  event.preventDefault();
  document.getElementById('cf-proof-drop')?.classList.remove('drag-over');
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
    if (window._cfProofFiles.length >= 5) { showToast('Máximo 5 arquivos por vez.', 'warning'); return; }
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
      <span style="flex:1;font-size:12px;color:#8899bb;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${f.name}</span>
      <span style="font-size:10px;color:#4a3a7a;">${(f.size/1024).toFixed(0)}KB</span>
      <button onclick="window._cfProofFiles.splice(${i},1);cfRenderProofPreview()"
        style="width:20px;height:20px;border-radius:4px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);color:#f87171;cursor:pointer;font-size:9px;display:flex;align-items:center;justify-content:center;">
        <i class="fas fa-times"></i>
      </button>
    </div>`;
  }).join('');
}

// Execute proof upload — tries IPFS first, falls back to data URL
async function cfExecuteProofUpload(contractId) {
  const files = window._cfProofFiles || [];
  if (!files.length) { showToast('Selecione pelo menos um arquivo.', 'warning'); return; }

  const btn    = document.getElementById('cf-proof-upload-btn');
  const status = document.getElementById('cf-proof-status');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Uploading…'; }
  if (status) { status.style.display = 'block'; status.style.background = 'rgba(55,138,221,0.08)'; status.style.border = '1px solid rgba(55,138,221,0.2)'; status.style.color = '#60b4ff'; status.textContent = 'Uploading files…'; }

  const uploaded = [];
  for (const file of files) {
    try {
      // Try to upload to web3.storage public IPFS gateway
      let url = null;
      let cid  = null;
      try {
        const formData = new FormData();
        formData.append('file', file, file.name);
        const resp = await fetch('https://api.web3.storage/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJkaWQ6a2V5Ono2TWtqOFpnOWtSZldvQjJuM3I1YVgxM2sya0dqWkZaaDVISFZteVliNXhiUVJoaiIsImF1ZCI6IndlYjMuc3RvcmFnZSIsImV4cCI6bnVsbH0.placeholder' },
          body: formData,
        });
        if (resp.ok) {
          const data = await resp.json();
          cid = data.cid;
          url = `https://${cid}.ipfs.w3s.link/${encodeURIComponent(file.name)}`;
        }
      } catch { /* fall through to data URL */ }

      // Fallback: FileReader data URL stored in localStorage
      if (!url) {
        url = await new Promise((res, rej) => {
          const reader = new FileReader();
          reader.onload  = e => res(e.target.result);
          reader.onerror = rej;
          reader.readAsDataURL(file);
        });
      }

      const type = file.type.startsWith('image') ? 'image' : file.type === 'application/pdf' ? 'pdf' : 'doc';
      uploaded.push({ name: file.name, url, cid: cid || null, type, uploadedAt: Date.now() });
      if (status) status.textContent = `Uploaded ${uploaded.length}/${files.length}: ${file.name}`;
    } catch (e) {
      cfErr('proof upload error:', e);
      showToast(`Erro ao enviar ${file.name}: ${e.message}`, 'error');
    }
  }

  if (uploaded.length) {
    const existing = (cfGetMeta(contractId).proofs || []);
    cfSetMeta(contractId, { proofs: [...existing, ...uploaded] });
    if (status) { status.style.background = 'rgba(52,211,153,0.08)'; status.style.border = '1px solid rgba(52,211,153,0.2)'; status.style.color = '#34d399'; status.textContent = `✅ ${uploaded.length} arquivo(s) enviado(s) com sucesso!`; }
    showToast(`✅ ${uploaded.length} prova(s) de trabalho enviada(s)!`, 'success');
    window._cfProofFiles = [];
    setTimeout(() => {
      document.getElementById('cf-proof-modal')?.remove();
      cfLoadContracts();
    }, 1500);
  } else {
    if (status) { status.style.color = '#f87171'; status.textContent = 'Falha ao enviar arquivos. Tente novamente.'; }
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-cloud-upload-alt mr-2"></i>Upload to IPFS'; }
  }
}

// ─── Mark as Complete (release all milestones) ─────────────────────────────────
async function cfMarkComplete(contractId) {
  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Conecte sua carteira.', 'warning'); return; }
  if (cfState.pending) { showToast('Aguarde a transação atual.', 'warning'); return; }

  const c = cfState.contracts.find(x => x.id === contractId);
  if (!c) { showToast('Contrato não encontrado.', 'error'); return; }
  if (c.client?.toLowerCase() !== wallet.toLowerCase()) { showToast('❌ Apenas o cliente pode marcar como completo.', 'error'); return; }

  const meta = cfGetMeta(contractId);
  if (!meta.proofs?.length) { showToast('⚠️ Faça o upload de pelo menos uma prova de trabalho primeiro.', 'warning'); return; }

  const milestones = c.milestones || [];
  const pending = milestones.filter(m => m.status === 'Pending');

  if (!window.confirm(
    `Mark Contract #${contractId} as COMPLETE?\n\n` +
    `This will release ${pending.length} pending milestone(s) to the contractor.\n` +
    `Platform fee (0.2%) = $${cfFmtUsdc(cfCalcFee(BigInt(c.totalValue)))} USDC will be deducted.\n` +
    `Net to contractor: $${cfFmtUsdc(cfNetAmount(BigInt(c.totalValue)))} USDC.\n\n` +
    `Esta ação é irreversível.`
  )) return;

  cfState.pending = true;
  try {
    // Release all pending milestones sequentially
    const init = await cfInitProvider();
    if (!init.ok) { showToast(`❌ ${init.message}`, 'error'); return; }

    for (let i = 0; i < milestones.length; i++) {
      if (milestones[i].status === 'Pending') {
        showToast(`📝 Releasing milestone ${i+1}/${milestones.length}…`, 'info');
        const tx = await init.factory.completeMilestone(contractId, i);
        await tx.wait(1);
        cfLog(`Milestone ${i} released, tx: ${tx.hash}`);
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
    setTimeout(cfLoadContracts, 1500);
  } catch (err) {
    cfErr('cfMarkComplete error:', err);
    const rej = err.code === 4001 || err.code === 'ACTION_REJECTED';
    showToast(rej ? '⚠️ Transação rejeitada.' : `❌ ${err.reason || err.message}`, rej ? 'warning' : 'error');
  } finally {
    cfState.pending = false;
  }
}

// ─── Download PDF Receipt ──────────────────────────────────────────────────────
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
  <p>This receipt was generated by the ARC Contracts Module v4.</p>
  <p>All on-chain data is verifiable at <strong>testnet.arcscan.app</strong></p>
  <p style="margin-top:8px;color:#bbb;">Contract #${contractId} · ${CF_FACTORY_ADDR}</p>
</div>
</body></html>`;

  // Open in new window for printing/saving as PDF
  const win = window.open('', '_blank');
  if (win) {
    win.document.write(html);
    win.document.close();
    setTimeout(() => win.print(), 500);
  } else {
    // Fallback: download as HTML
    const blob = new Blob([html], { type: 'text/html' });
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = `arc-contract-${contractId}-receipt.html`;
    a.click();
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
async function cfRunTx(label, fn) {
  try {
    const init = await cfInitProvider();
    if (!init.ok) { showToast(`❌ ${init.message}`, 'error'); return null; }
    if (!window.confirm(`Confirm transaction:\n${label}\n\nThis requires a wallet signature.`)) return null;
    showToast(`📝 ${label} — confirme na carteira…`, 'info');
    const tx = await fn(init);
    showToast(`⏳ Aguardando confirmação…`, 'info');
    const receipt = await tx.wait(1);
    if (receipt.status !== 1) throw new Error('Transação revertida on-chain.');
    showToast(`✅ ${label} — confirmado! Bloco #${receipt.blockNumber}.`, 'success');
    cfShowTxBadge(receipt.hash, label);
    return receipt;
  } catch (err) {
    cfErr('cfRunTx error:', err);
    const rej = err.code === 4001 || err.code === 'ACTION_REJECTED';
    showToast(rej ? '⚠️ Transação rejeitada.' : `❌ ${err.reason || err.message}`, rej ? 'warning' : 'error');
    return null;
  }
}

// ─── Ensure USDC approval ──────────────────────────────────────────────────────
async function cfEnsureApproval(init, amountRaw) {
  const allowance = await cfReadAllowance(init.address, CF_FACTORY_ADDR);
  if (allowance >= amountRaw) { cfLog('Allowance sufficient:', cfFmtUsdc(allowance)); return; }
  cfSetStep(2, 'active', 'Approve USDC — sign in wallet…');
  showToast('📝 Aprovando USDC para ContractFactory — confirme na carteira…', 'info');
  const tx = await init.usdc.approve(CF_FACTORY_ADDR, amountRaw);
  cfLog('Approve tx:', tx.hash);
  cfSetStep(2, 'active', `Waiting: ${tx.hash.slice(0, 14)}…`);
  const r = await tx.wait(1);
  if (r.status !== 1) throw new Error('Approve revertida on-chain.');
  cfSetStep(2, 'done');
  cfLog('Approval confirmed.');
}

// ─── Deposit modal ─────────────────────────────────────────────────────────────
function cfShowDepositModal(contractId) {
  const c = cfState.contracts.find(x => x.id === contractId);
  if (!c) { showToast('Contrato não encontrado.', 'error'); return; }

  const remaining   = BigInt(c.totalValue) - BigInt(c.depositedValue);
  const humanRemain = (Number(remaining) / 1e6).toFixed(2);
  const humanTotal  = cfFmtUsdc(c.totalValue);
  const humanDep    = cfFmtUsdc(c.depositedValue);

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
  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Conecte sua carteira.', 'warning'); return; }
  if (cfState.pending) { showToast('Aguarde a transação atual.', 'warning'); return; }
  const c = cfState.contracts.find(x => x.id === contractId);
  if (!c) { showToast('Contrato não encontrado.', 'error'); return; }
  if (c.client?.toLowerCase() !== wallet.toLowerCase()) { showToast('❌ Apenas o cliente pode depositar.', 'error'); return; }
  const remaining = BigInt(c.totalValue) - BigInt(c.depositedValue);
  if (remaining <= 0n) { showToast('⚠️ Contrato já totalmente financiado.', 'warning'); return; }
  cfShowDepositModal(contractId);
}

async function cfExecuteDeposit(contractId) {
  const c = cfState.contracts.find(x => x.id === contractId);
  if (!c) return;
  const humanAmount = parseFloat(document.getElementById('cf-deposit-amount')?.value || '0');
  if (isNaN(humanAmount) || humanAmount <= 0) { showToast('Valor inválido.', 'error'); return; }
  const depositAmount = cfParseUsdc(humanAmount);
  const remaining     = BigInt(c.totalValue) - BigInt(c.depositedValue);
  if (depositAmount > remaining) { showToast('❌ Valor excede o restante.', 'error'); return; }

  const btn = document.getElementById('cf-deposit-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Processing…'; }
  cfState.pending = true;

  try {
    cfSetDepStep(0, 'active');
    const init = await cfInitProvider();
    if (!init.ok) { cfSetDepStep(0, 'error', init.message.slice(0,40)); showToast(`❌ ${init.message}`, 'error'); return; }
    cfSetDepStep(0, 'done');

    cfSetDepStep(1, 'active');
    const balance = await cfReadBalance(init.address);
    if (balance < depositAmount) { cfSetDepStep(1,'error',`Saldo $${cfFmtUsdc(balance)} insuficiente`); showToast(`❌ Saldo insuficiente: $${cfFmtUsdc(balance)}.`, 'error'); return; }
    cfSetDepStep(1, 'done');

    cfSetDepStep(2, 'active', 'Approve USDC…');
    const allowance = await cfReadAllowance(init.address, CF_FACTORY_ADDR);
    if (allowance < depositAmount) {
      showToast('📝 Aprovando USDC…', 'info');
      const appTx = await init.usdc.approve(CF_FACTORY_ADDR, depositAmount);
      cfSetDepStep(2, 'active', `Waiting: ${appTx.hash.slice(0,14)}…`);
      const ar = await appTx.wait(1);
      if (ar.status !== 1) throw new Error('Approve revertida.');
    }
    cfSetDepStep(2, 'done');

    cfSetDepStep(3, 'active', 'Sign deposit…');
    showToast(`📝 Deposit $${humanAmount} USDC — confirme…`, 'info');
    let tx;
    try { tx = await init.factory.depositToContract(contractId, depositAmount); }
    catch (err) { const rej = err.code === 4001 || err.code === 'ACTION_REJECTED'; cfSetDepStep(3,'error',rej?'Rejected':'Failed'); showToast(rej?'⚠️ Rejected.':`❌ ${err.reason||err.message}`, rej?'warning':'error'); return; }

    cfSetDepStep(3, 'done');
    const txLinkEl = document.getElementById('cf-dep-tx-link');
    if (txLinkEl) { txLinkEl.style.display='block'; txLinkEl.innerHTML=`<a href="${CF_EXPLORER}/tx/${tx.hash}" target="_blank" style="color:#60b4ff;">View: ${tx.hash.slice(0,18)}…</a>`; }

    cfSetDepStep(4, 'active', 'Waiting…');
    const receipt = await tx.wait(1);
    if (receipt.status !== 1) throw new Error('Tx revertida.');
    cfSetDepStep(4, 'done');
    cfSetDepStep(5, 'done');

    showToast(`✅ Deposit de $${humanAmount} USDC confirmado! Bloco #${receipt.blockNumber}.`, 'success');
    cfShowTxBadge(receipt.hash, `Deposit $${humanAmount} USDC`);
    setTimeout(() => { document.getElementById('cf-deposit-modal')?.remove(); cfLoadContracts(); }, 2500);
  } catch (err) {
    cfErr('cfExecuteDeposit:', err);
    const rej = err.code === 4001 || err.code === 'ACTION_REJECTED';
    showToast(rej ? '⚠️ Rejeitada.' : `❌ ${err.reason||err.message}`, rej ? 'warning' : 'error');
    if (btn) { btn.disabled=false; btn.innerHTML='<i class="fas fa-arrow-circle-down mr-2"></i>Retry'; }
  } finally { cfState.pending = false; }
}

// ─── Withdraw ─────────────────────────────────────────────────────────────────
async function cfWithdrawFromContract(contractId) {
  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Conecte sua carteira.', 'warning'); return; }
  if (cfState.pending) { showToast('Aguarde.', 'warning'); return; }
  const c = cfState.contracts.find(x => x.id === contractId);
  if (!c) { showToast('Contrato não encontrado.', 'error'); return; }
  if (c.contractor?.toLowerCase() !== wallet.toLowerCase()) { showToast('❌ Apenas o contratado pode sacar.', 'error'); return; }
  if (c.status !== 'Active') { showToast('❌ Contrato não está ativo.', 'error'); return; }

  const releasedAmt = (c.milestones || []).filter(m => m.status === 'Released').reduce((s, m) => s + BigInt(m.amount), 0n);
  if (releasedAmt <= 0n) { showToast('⚠️ Nenhum milestone liberado para saque.', 'warning'); return; }

  const humanAmt = (Number(releasedAmt) / 1e6).toFixed(2);
  document.getElementById('cf-withdraw-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'cf-withdraw-modal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm';
  modal.innerHTML = `
  <div style="background:#0a0c18;border:1px solid rgba(52,211,153,0.3);border-radius:20px;width:100%;max-width:420px;padding:24px;box-shadow:0 0 40px rgba(52,211,153,0.1);">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
      <h3 style="color:#dde2f0;font-size:15px;font-weight:800;display:flex;align-items:center;gap:8px;">
        <i class="fas fa-arrow-circle-up" style="color:#34d399;"></i>Receive USDC — #${contractId}
      </h3>
      <button onclick="document.getElementById('cf-withdraw-modal').remove()"
        style="width:28px;height:28px;border-radius:8px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);color:#6b7280;cursor:pointer;display:flex;align-items:center;justify-content:center;">
        <i class="fas fa-times text-xs"></i></button>
    </div>
    <div style="background:rgba(52,211,153,0.06);border:1px solid rgba(52,211,153,0.2);border-radius:12px;padding:16px;margin-bottom:16px;text-align:center;">
      <div style="font-size:11px;color:#34d399;font-weight:700;text-transform:uppercase;margin-bottom:4px;">Available</div>
      <div style="font-size:28px;font-weight:800;color:#6ee7b7;">$${humanAmt} <span style="font-size:14px;color:#34d399;font-weight:600;">USDC</span></div>
    </div>
    <div id="cf-withdraw-steps" style="display:none;margin-bottom:14px;background:rgba(255,255,255,0.02);border:1px solid rgba(52,211,153,0.1);border-radius:10px;padding:12px;">
      <p style="font-size:10px;color:#3a4870;text-transform:uppercase;font-weight:700;margin-bottom:8px;">Progress</p>
      ${[['fa-network-wired','Verify network'],['fa-paper-plane','Send withdrawal'],['fa-hourglass-half','Awaiting confirmation'],['fa-check-circle','Confirmed']].map((s,i) => `
        <div id="cf-wd-step-${i}" class="ct-step ct-step-idle flex items-center gap-2 mb-1">
          <div class="ct-step-icon w-5 h-5 rounded-full flex items-center justify-center text-[9px] flex-shrink-0"><i class="fas ${s[0]}"></i></div>
          <span style="font-size:11px;">${s[1]}</span>
        </div>`).join('')}
      <div id="cf-wd-tx-link" style="display:none;font-size:11px;margin-top:6px;"></div>
    </div>
    <div style="display:flex;gap:10px;">
      <button onclick="cfExecuteWithdraw(${contractId},${releasedAmt}n)" id="cf-withdraw-btn"
        style="flex:1;background:linear-gradient(135deg,#065f46,#047857);color:#fff;border:none;border-radius:12px;padding:12px;font-size:13px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;">
        <i class="fas fa-arrow-circle-up"></i>Receive $${humanAmt} USDC
      </button>
      <button onclick="document.getElementById('cf-withdraw-modal').remove()"
        style="padding:12px 18px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);color:#6b7280;border-radius:12px;cursor:pointer;font-size:13px;">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(modal);
}

async function cfExecuteWithdraw(contractId, releasedAmt) {
  const humanAmt = (Number(releasedAmt) / 1e6).toFixed(2);
  const btn = document.getElementById('cf-withdraw-btn');
  if (btn) { btn.disabled=true; btn.innerHTML='<i class="fas fa-spinner fa-spin mr-2"></i>Processing…'; }

  function setWdStep(n, status='active', detail='') {
    const panel = document.getElementById('cf-withdraw-steps');
    if (panel) panel.style.display='block';
    for (let i=0;i<=3;i++) {
      const el = document.getElementById(`cf-wd-step-${i}`);
      if (!el) continue;
      el.classList.remove('ct-step-active','ct-step-done','ct-step-error','ct-step-idle');
      if (i<n) el.classList.add('ct-step-done');
      else if (i===n) el.classList.add(status==='error'?'ct-step-error':'ct-step-active');
      else el.classList.add('ct-step-idle');
      if (i===n&&detail) { const s=el.querySelector('span'); if(s){if(!s.dataset.base)s.dataset.base=s.textContent; s.textContent=detail;} }
    }
  }

  cfState.pending = true;
  try {
    setWdStep(0,'active');
    const init = await cfInitProvider();
    if (!init.ok) { setWdStep(0,'error',init.message.slice(0,40)); showToast(`❌ ${init.message}`,'error'); return; }
    setWdStep(0,'done');

    setWdStep(1,'active','Sign withdrawal…');
    showToast(`📝 Saque $${humanAmt} USDC — confirme…`,'info');
    let tx;
    try { tx = await init.factory.withdrawFromContract(contractId, releasedAmt); }
    catch(err) { const rej=err.code===4001||err.code==='ACTION_REJECTED'; setWdStep(1,'error',rej?'Rejected':'Failed'); showToast(rej?'⚠️ Rejected.':`❌ ${err.reason||err.message}`,rej?'warning':'error'); return; }
    setWdStep(1,'done');

    const txEl = document.getElementById('cf-wd-tx-link');
    if(txEl){txEl.style.display='block';txEl.innerHTML=`<a href="${CF_EXPLORER}/tx/${tx.hash}" target="_blank" style="color:#60b4ff;">${tx.hash.slice(0,20)}…</a>`;}

    setWdStep(2,'active','Waiting…');
    const receipt = await tx.wait(1);
    if(receipt.status!==1) throw new Error('Tx revertida.');
    setWdStep(2,'done');
    setWdStep(3,'done');

    showToast(`✅ Saque de $${humanAmt} USDC confirmado!`,'success');
    cfShowTxBadge(receipt.hash,`Receive $${humanAmt} USDC`);
    setTimeout(()=>{document.getElementById('cf-withdraw-modal')?.remove();cfLoadContracts();},2500);
  } catch(err) {
    cfErr('cfExecuteWithdraw:',err);
    const rej=err.code===4001||err.code==='ACTION_REJECTED';
    showToast(rej?'⚠️ Rejeitada.':`❌ ${err.reason||err.message}`,rej?'warning':'error');
    if(btn){btn.disabled=false;btn.innerHTML=`<i class="fas fa-arrow-circle-up mr-2"></i>Retry`;}
  } finally { cfState.pending=false; }
}

// ─── Release milestone ─────────────────────────────────────────────────────────
async function cfReleaseMilestone(contractId, milestoneIdx) {
  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Conecte sua carteira.', 'warning'); return; }
  if (cfState.pending) { showToast('Aguarde.', 'warning'); return; }
  const c = cfState.contracts.find(x => x.id === contractId);
  if (c?.client?.toLowerCase() !== wallet.toLowerCase()) { showToast('❌ Apenas o cliente pode liberar.', 'error'); return; }
  const ms = c?.milestones?.[milestoneIdx];
  const humanAmt = ms ? cfFmtUsdc(ms.amount) : '?';
  if (!window.confirm(`Release Milestone ${milestoneIdx+1} — $${humanAmt} USDC?\n\nEsta ação é irreversível.`)) return;

  cfState.pending = true;
  try {
    const receipt = await cfRunTx(`Release Milestone ${milestoneIdx+1} — $${humanAmt} USDC`, async({factory}) => factory.completeMilestone(contractId, milestoneIdx));
    if (receipt) setTimeout(cfLoadContracts, 1500);
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
    const receipt = await cfRunTx(`Sign Contract #${contractId}`, async({factory}) => factory.signContract(contractId));
    if (receipt) setTimeout(cfLoadContracts, 1500);
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
    const receipt = await cfRunTx(`Cancel Contract #${contractId}`, async({factory}) => factory.cancelContract(contractId));
    if (receipt) setTimeout(cfLoadContracts, 1500);
  } finally { cfState.pending = false; }
}

// ─── Create contract ───────────────────────────────────────────────────────────
async function cfCreateContract() {
  if (cfState.pending) { showToast('Transação em andamento.', 'warning'); return; }
  const wallet = window.walletState?.address;
  if (!wallet) { showToast('⚠️ Conecte sua carteira.', 'warning'); return; }

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
  if (!contractor || !title || !totalValue) { showToast('Preencha todos os campos obrigatórios.', 'warning'); return; }
  if (!/^0x[0-9a-fA-F]{40}$/.test(contractor)) { showToast('Endereço do contratado inválido.', 'error'); return; }
  if (contractor.toLowerCase() === wallet.toLowerCase()) { showToast('Cliente e contratado não podem ser iguais.', 'error'); return; }

  const humanAmount = parseFloat(totalValue);
  if (isNaN(humanAmount) || humanAmount <= 0) { showToast('Valor deve ser maior que 0.', 'error'); return; }
  if (humanAmount < 1) { showToast('Valor mínimo: $1 USDC.', 'error'); return; }

  if (clientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) { showToast('Email do cliente inválido.', 'error'); return; }
  if (contractorEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contractorEmail)) { showToast('Email do contratado inválido.', 'error'); return; }

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
    showToast(`Soma milestones ($${Number(sumMs)/1e6}) ≠ total ($${humanAmount}). Diff: $${diff.toFixed(6)}.`, 'error');
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

    // Extract new contract ID from event
    let newId = null;
    try {
      const iface = new window.ethers.Interface(['event ContractCreated(uint256 indexed contractId, address indexed client, address indexed contractor, uint256 totalValue)']);
      for (const log of receipt.logs) {
        try { const d = iface.parseLog(log); if (d?.name==='ContractCreated') { newId = Number(d.args[0]); break; } } catch { }
      }
    } catch { }
    cfSetStep(5, 'done');

    // Save metadata off-chain
    cfSetStep(6, 'active', 'Salvando metadados…');
    if (newId !== null) {
      cfSetMeta(newId, {
        clientEmail: clientEmail || '',
        contractorEmail: contractorEmail || '',
        otcPoints: otcEnabled ? (otcPoints || '') : '',
        otcTerms:  otcEnabled ? (otcTerms  || '') : '',
        proofs: [],
        createdAt: Date.now(),
      });
    }
    cfSetStep(6, 'done');

    showToast(`✅ Contrato${newId!==null?` #${newId}`:''} criado! Fee: $${cfFmtUsdc(feeRaw)} · Net: $${cfFmtUsdc(netRaw)} · <a href="${CF_EXPLORER}/tx/${receipt.hash}" target="_blank" class="underline">ArcScan ↗</a>`, 'success');
    cfShowTxBadge(receipt.hash, `createContract${newId!==null?` #${newId}`:''}`);

    // Reset form
    cfEl('cf-title').value = '';
    cfEl('cf-contractor').value = '';
    cfEl('cf-value').value = '';
    if (cfEl('cf-client-email'))     cfEl('cf-client-email').value = '';
    if (cfEl('cf-contractor-email')) cfEl('cf-contractor-email').value = '';
    cfResetMilestones();
    cfUpdateFeePreview();
    setTimeout(cfLoadContracts, 1500);

  } catch (err) {
    cfErr('cfCreateContract:', err);
    const rej = err.code===4001||err.code==='ACTION_REJECTED'||err.message?.includes('rejected')||err.message?.includes('denied');
    if (rej) { showToast('⚠️ Transação rejeitada.','warning'); cfHideSteps(); }
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
  if (cfMilestoneCount >= 10) { showToast('Máximo de 10 milestones.', 'warning'); return; }
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
  if (!wallet) { cfShowListState('no_wallet'); cfRenderSummary([], null); }
}

// ─── Wallet event listeners ────────────────────────────────────────────────────
window.addEventListener('walletConnected',    () => { cfLog('walletConnected'); cfLoadContracts(); });
window.addEventListener('walletDisconnected', () => { cfLog('walletDisconnected'); cfShowListState('no_wallet'); cfRenderSummary([],null); cfState.contracts=[]; cfState.networkOk=false; });
window.addEventListener('walletChanged',      () => { cfLog('walletChanged'); cfLoadContracts(); });

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
window.cfDownloadReceipt      = cfDownloadReceipt;
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

console.log('[CF] Contracts v4 loaded | Factory:', CF_FACTORY_ADDR, '| Fee: 0.2% | IPFS proof upload | Mark as Complete');
