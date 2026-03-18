// ============================================================
// ARC Contracts Module — Fully trustless, on-chain only
// ContractFactory: 0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A
// Arc Testnet (chainId 5042002) | USDC native gas token
//
// ⚠️  Zero mock data. All state sourced from:
//   - eth_call to ContractFactory read functions (ethers.js)
//   - eth_getLogs for ContractCreated events
//   - Connected wallet address as sole identity
//
// States: no_wallet | wrong_network | loading | empty | success | error
// ============================================================
'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const CF_FACTORY_ADDR  = '0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A';
const CF_USDC_ADDR     = '0x3600000000000000000000000000000000000000';
const CF_EXPLORER      = 'https://testnet.arcscan.app';
const CF_CHAIN_ID      = 5042002;
const CF_CHAIN_HEX     = '0x4CFC12';
const CF_NETWORK_NAME  = 'Arc Testnet';
const CF_RPC           = 'https://rpc.testnet.arc.network';
const CF_USDC_DECIMALS = 6;
const CF_USDC_SCALE    = 1_000_000n;

// ContractFactory full ABI (minimum required functions)
const CF_ABI = [
  'function contractCount() view returns (uint256)',
  'function getContract(uint256 id) view returns (uint256,address,address,string,uint256,uint256,uint8,bool,uint256,uint256,uint256,uint256,uint256)',
  'function getMilestones(uint256 id) view returns (tuple(uint256 id, string description, uint256 amount, uint8 status, uint256 releasedAt)[])',
  'function getByClient(address) view returns (uint256[])',
  'function getByContractor(address) view returns (uint256[])',
  'function createContract(address,string,uint256,string[],uint256[]) returns (uint256)',
  'function signContract(uint256)',
  'function completeMilestone(uint256,uint256)',
  'function cancelContract(uint256)',
];

const CF_USDC_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];

// ─── Module state ─────────────────────────────────────────────────────────────
const cfState = {
  pending:        false,
  contracts:      [],
  milestones:     {},
  myContractIds:  [],
  lastTxHash:     null,
  networkOk:      false,
  _provider:      null,
  _factory:       null,
  _usdc:          null,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function cfEl(id)      { return document.getElementById(id); }
function cfShort(addr) { if (!addr || addr.length < 12) return addr || '—'; return addr.slice(0, 8) + '…' + addr.slice(-6); }
function cfTs(ts)      { if (!ts || ts === 0) return '—'; return new Date(Number(ts) * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }

function cfParseUsdc(human) {
  const s = String(human).trim();
  const [int = '0', frac = ''] = s.split('.');
  return BigInt(int) * CF_USDC_SCALE + BigInt(frac.slice(0, 6).padEnd(6, '0'));
}
function cfFmtUsdc(base) {
  const n = typeof base === 'bigint' ? base : BigInt(Math.round(Number(base)));
  return (Number(n) / 1e6).toFixed(2);
}

// ─── Debug logger ─────────────────────────────────────────────────────────────
function cfLog(...args) { console.log('[CF]', ...args); }
function cfWarn(...args) { console.warn('[CF]', ...args); }
function cfErr(...args) { console.error('[CF]', ...args); }

// ─── Provider / Signer bootstrap ─────────────────────────────────────────────
// Returns { ok, provider, signer, factory, usdc, address, error }
async function cfInitProvider() {
  try {
    const rawProv = window.walletState?.provider;
    if (!rawProv) {
      return { ok: false, error: 'no_wallet', message: 'Carteira não conectada.' };
    }

    if (!window.ethers) {
      return { ok: false, error: 'no_ethers', message: 'ethers.js não carregado. Recarregue a página.' };
    }

    // Wrap with ethers BrowserProvider (v6)
    let provider;
    try {
      provider = new window.ethers.BrowserProvider(rawProv, 'any');
    } catch (e) {
      cfErr('BrowserProvider failed:', e);
      return { ok: false, error: 'provider_init', message: 'Falha ao inicializar provider: ' + e.message };
    }

    // Check network
    let network;
    try {
      network = await provider.getNetwork();
    } catch (e) {
      cfErr('getNetwork failed:', e);
      return { ok: false, error: 'network_error', message: 'Falha ao ler rede: ' + e.message };
    }

    const chainId = Number(network.chainId);
    cfLog('Network:', chainId, '| Expected:', CF_CHAIN_ID, '| Wallet:', window.walletState?.address);

    if (chainId !== CF_CHAIN_ID) {
      return {
        ok: false,
        error: 'wrong_network',
        chainId,
        message: `Rede incorreta (Chain ID ${chainId}). Troque para ${CF_NETWORK_NAME} (Chain ID ${CF_CHAIN_ID}).`
      };
    }

    // Get signer
    let signer;
    try {
      signer = await provider.getSigner();
    } catch (e) {
      cfErr('getSigner failed:', e);
      return { ok: false, error: 'no_signer', message: 'Não foi possível obter signer: ' + e.message };
    }

    const address = await signer.getAddress();
    cfLog('Signer address:', address);

    // Create contract instances
    const factory = new window.ethers.Contract(CF_FACTORY_ADDR, CF_ABI, signer);
    const usdc    = new window.ethers.Contract(CF_USDC_ADDR, CF_USDC_ABI, signer);

    // Cache
    cfState._provider = provider;
    cfState._factory  = factory;
    cfState._usdc     = usdc;
    cfState.networkOk = true;

    return { ok: true, provider, signer, factory, usdc, address };
  } catch (e) {
    cfErr('initProvider unexpected error:', e);
    return { ok: false, error: 'unexpected', message: e.message || 'Erro inesperado.' };
  }
}

// ─── Network switch helper ─────────────────────────────────────────────────────
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
        await rawProv.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: CF_CHAIN_HEX,
            chainName: CF_NETWORK_NAME,
            rpcUrls: [CF_RPC],
            nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
            blockExplorerUrls: [CF_EXPLORER],
          }]
        });
        await new Promise(r => setTimeout(r, 1000));
        cfLoadContracts();
      } catch (e2) {
        showToast('Não foi possível adicionar a rede Arc Testnet: ' + e2.message, 'error');
      }
    } else if (e.code !== 4001) {
      showToast('Erro ao trocar rede: ' + e.message, 'error');
    }
  }
}

// ─── Read-only RPC call (no wallet required for reads) ────────────────────────
async function cfRpcCall(to, data) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'eth_call', params: [{ to, data }, 'latest'] });
  const res  = await fetch(CF_RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  const json = await res.json();
  if (json.error) throw new Error('eth_call error: ' + json.error.message);
  return json.result;
}

// ─── ABI encode helpers (manual, for reads without wallet) ────────────────────
function cfPad(hex, bytes = 32) { return hex.replace(/^0x/, '').padStart(bytes * 2, '0'); }
function cfEncAddr(addr)        { return cfPad(addr.replace(/^0x/, ''), 32); }
function cfEncUint(n)           { return cfPad(BigInt(n).toString(16), 32); }

const CF_SEL = {
  contractCount:    '0x8736381a',
  getByClient:      '0x8018b98c',
  getByContractor:  '0x32db19d6',
  usdcBalanceOf:    '0x70a08231',
  usdcAllowance:    '0xdd62ed3e',
};

function cfDecodeUintArray(hex) {
  if (!hex || hex === '0x') return [];
  const s = hex.replace(/^0x/, '');
  if (s.length < 128) return [];
  const len = Number(BigInt('0x' + s.slice(64, 128)));
  const arr = [];
  for (let i = 0; i < len; i++) {
    arr.push(BigInt('0x' + s.slice(128 + i * 64, 128 + (i + 1) * 64)));
  }
  return arr;
}

// ─── On-chain reads via ethers (handles ABI decode automatically) ──────────────

// Returns array of BigInt IDs for the connected wallet
async function cfFetchMyIds(address) {
  // Use RPC directly (no signer needed for reads)
  const enc = cfEncAddr(address);
  const [hexClient, hexContractor] = await Promise.all([
    cfRpcCall(CF_FACTORY_ADDR, CF_SEL.getByClient + enc),
    cfRpcCall(CF_FACTORY_ADDR, CF_SEL.getByContractor + enc),
  ]);
  const asClient     = cfDecodeUintArray(hexClient);
  const asContractor = cfDecodeUintArray(hexContractor);
  const seen = new Set();
  return [...asClient, ...asContractor].filter(id => {
    const k = id.toString();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).map(id => Number(id));
}

// Fetch WorkContract and milestones using ethers (auto ABI decode)
async function cfFetchContract(factory, id) {
  try {
    const raw = await factory.getContract(id);
    // raw is a Result tuple: [id, client, contractor, title, totalValue, depositedValue,
    //                          status, contractorSigned, createdAt, startedAt, completedAt,
    //                          milestoneCount, completedMilestones]
    const statusLabels = ['Draft', 'Active', 'Completed', 'Cancelled'];
    return {
      id:                  Number(raw[0]),
      client:              raw[1],
      contractor:          raw[2],
      title:               raw[3],
      totalValue:          raw[4],        // BigInt (micro-USDC)
      depositedValue:      raw[5],        // BigInt
      statusCode:          Number(raw[6]),
      status:              statusLabels[Number(raw[6])] || 'Unknown',
      contractorSigned:    raw[7],
      createdAt:           Number(raw[8]),
      startedAt:           Number(raw[9]),
      completedAt:         Number(raw[10]),
      milestoneCount:      Number(raw[11]),
      completedMilestones: Number(raw[12]),
    };
  } catch (e) {
    cfErr('getContract(' + id + ') error:', e);
    return null;
  }
}

async function cfFetchMilestones(factory, id) {
  try {
    const raw = await factory.getMilestones(id);
    return raw.map(ms => ({
      id:          Number(ms[0] ?? ms.id),
      description: ms[1] ?? ms.description,
      amount:      ms[2] ?? ms.amount,     // BigInt
      status:      Number(ms[3] ?? ms.status) === 0 ? 'Pending' : 'Released',
      releasedAt:  Number(ms[4] ?? ms.releasedAt),
    }));
  } catch (e) {
    cfErr('getMilestones(' + id + ') error:', e);
    return [];
  }
}

// ─── USDC reads via RPC ────────────────────────────────────────────────────────
async function cfReadBalance(addr) {
  const hex = await cfRpcCall(CF_USDC_ADDR, CF_SEL.usdcBalanceOf + cfEncAddr(addr));
  return BigInt(hex);
}
async function cfReadAllowance(owner, spender) {
  const data = CF_SEL.usdcAllowance + cfEncAddr(owner) + cfEncAddr(spender);
  const hex  = await cfRpcCall(CF_USDC_ADDR, data);
  return BigInt(hex);
}

// ─── Gas helpers ──────────────────────────────────────────────────────────────
async function cfEstimateGas(signer, factory, fnName, args) {
  try {
    const est = await factory[fnName].estimateGas(...args);
    return (est * 125n) / 100n; // +25% buffer
  } catch (e) {
    cfWarn('estimateGas failed for', fnName, ':', e.message);
    return 200000n;
  }
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
    // Update detail text if provided
    if (i === n && detail) {
      const span = el.querySelector('span');
      const baseText = span?.dataset.base;
      if (span) {
        if (!baseText) span.dataset.base = span.textContent;
        span.textContent = detail;
      }
    } else if (i === n) {
      const span = el.querySelector('span');
      if (span?.dataset.base) span.textContent = span.dataset.base;
    }
  }
}
function cfHideSteps() {
  const panel = cfEl('cf-steps-panel');
  if (panel) panel.classList.add('hidden');
  // Reset detail texts
  for (let i = 0; i <= 6; i++) {
    const el = cfEl(`cf-step-${i}`);
    if (!el) continue;
    el.classList.remove('ct-step-active', 'ct-step-done', 'ct-step-error', 'ct-step-idle');
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
        </div>`;
      break;

    case 'wrong_network':
      el.innerHTML = `
        <div class="flex flex-col items-center gap-4 py-14 text-center">
          <div class="w-16 h-16 rounded-2xl bg-yellow-900/20 border border-yellow-700/30 flex items-center justify-center">
            <i class="fas fa-exclamation-triangle text-yellow-500 text-2xl"></i>
          </div>
          <div>
            <p class="text-yellow-400 text-sm font-semibold mb-1">Rede incorreta</p>
            <p class="text-gray-500 text-xs max-w-xs">${message || 'Conecte-se à Arc Testnet (Chain ID 5042002).'}</p>
          </div>
          <button onclick="cfSwitchNetwork()"
            class="px-5 py-2 bg-yellow-700 hover:bg-yellow-600 text-white rounded-xl text-sm font-semibold transition-all flex items-center gap-2">
            <i class="fas fa-network-wired"></i>Trocar para Arc Testnet
          </button>
        </div>`;
      break;

    case 'loading':
      el.innerHTML = `
        <div class="flex items-center justify-center gap-3 py-14 text-gray-400">
          <i class="fas fa-spinner fa-spin text-cyan-400 text-xl"></i>
          <span class="text-sm">Carregando contratos on-chain…</span>
        </div>`;
      break;

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
            <i class="fas fa-search mr-1"></i>getByClient/getByContractor → [] resultado vazio
          </div>
        </div>`;
      break;

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
        </div>`;
      break;
  }
}

// ─── Load contracts for connected wallet ──────────────────────────────────────
async function cfLoadContracts() {
  cfLog('cfLoadContracts() called');

  const wallet = window.walletState?.address;

  if (!wallet) {
    cfLog('State: no_wallet');
    cfShowListState('no_wallet');
    cfRenderSummary([], null);
    return;
  }

  cfLog('Wallet:', wallet);
  cfShowListState('loading');

  // Init provider
  const init = await cfInitProvider();
  if (!init.ok) {
    cfLog('Provider init failed:', init.error, init.message);
    if (init.error === 'wrong_network') {
      cfShowListState('wrong_network', init.message);
    } else if (init.error === 'no_wallet') {
      cfShowListState('no_wallet');
    } else {
      cfShowListState('error', init.message);
    }
    cfRenderSummary([], wallet);
    return;
  }

  const { factory } = init;

  try {
    // Fetch IDs filtered by wallet
    cfLog('Fetching contract IDs for', wallet);
    const ids = await cfFetchMyIds(wallet);
    cfLog('Contract IDs:', ids);

    if (ids.length === 0) {
      cfLog('State: empty (no contracts for this wallet)');
      cfShowListState('empty');
      cfRenderSummary([], wallet);
      return;
    }

    // Load contracts in parallel
    const contracts = await Promise.all(ids.map(async id => {
      const c  = await cfFetchContract(factory, id);
      if (!c) return null;
      const ms = await cfFetchMilestones(factory, id);
      return { ...c, milestones: ms };
    }));

    const valid = contracts.filter(Boolean);
    cfLog('Loaded contracts:', valid.length, 'contracts');
    valid.forEach(c => {
      cfLog(`  #${c.id} "${c.title}" status=${c.status} total=$${cfFmtUsdc(c.totalValue)}`);
    });

    cfState.contracts = valid;
    valid.forEach(c => { cfState.milestones[c.id] = c.milestones; });

    // Render
    cfRenderContracts(valid, wallet);
    cfRenderSummary(valid, wallet);

  } catch (err) {
    cfErr('loadContracts error:', err);
    // Distinguish RPC errors from logic errors
    const isRpcError = err.message?.includes('eth_call') || err.message?.includes('fetch') || err.message?.includes('network');
    cfShowListState('error', err.message);
    cfRenderSummary([], wallet);
  }
}

// ─── Render summary stats ──────────────────────────────────────────────────────
function cfRenderSummary(contracts, wallet) {
  const el = cfEl('cf-summary');
  if (!el) return;

  if (!wallet) {
    el.innerHTML = '';
    return;
  }

  const totalUsdc  = contracts.reduce((s, c) => s + BigInt(c.totalValue), 0n);
  const active     = contracts.filter(c => c.status === 'Active').length;
  const draft      = contracts.filter(c => c.status === 'Draft').length;
  const completed  = contracts.filter(c => c.status === 'Completed').length;

  el.innerHTML = `
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
      <div class="bg-gray-800/60 border border-gray-700/40 rounded-xl p-3 text-center">
        <div class="text-xl font-bold text-white">${contracts.length}</div>
        <div class="text-xs text-gray-500 mt-0.5">Total</div>
      </div>
      <div class="bg-cyan-900/20 border border-cyan-700/30 rounded-xl p-3 text-center">
        <div class="text-xl font-bold text-cyan-400">${active}</div>
        <div class="text-xs text-gray-500 mt-0.5">Ativos</div>
      </div>
      <div class="bg-yellow-900/20 border border-yellow-700/30 rounded-xl p-3 text-center">
        <div class="text-xl font-bold text-yellow-400">${draft}</div>
        <div class="text-xs text-gray-500 mt-0.5">Rascunho</div>
      </div>
      <div class="bg-green-900/20 border border-green-700/30 rounded-xl p-3 text-center">
        <div class="text-xl font-bold text-green-400">$${cfFmtUsdc(totalUsdc)}</div>
        <div class="text-xs text-gray-500 mt-0.5">Total USDC</div>
      </div>
    </div>
    <div class="flex items-center gap-2 text-xs text-gray-500 bg-gray-800/30 rounded-lg px-3 py-2">
      <div class="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse flex-shrink-0"></div>
      <span>Dados de <span class="font-mono text-gray-400">${cfShort(CF_FACTORY_ADDR)}</span> · ${CF_NETWORK_NAME} · Chain ${CF_CHAIN_ID}</span>
      <a href="${CF_EXPLORER}/address/${CF_FACTORY_ADDR}" target="_blank" rel="noopener" class="ml-auto text-blue-400 hover:text-blue-300">
        <i class="fas fa-external-link-alt text-[10px]"></i>
      </a>
    </div>`;
}

// ─── Render contract cards ─────────────────────────────────────────────────────
function cfRenderContracts(contracts, wallet) {
  const listEl = cfEl('cf-contracts-list');
  if (!listEl) return;

  if (contracts.length === 0) {
    cfShowListState('empty');
    return;
  }

  const order = { Active: 0, Draft: 1, Completed: 2, Cancelled: 3 };
  const sorted = [...contracts].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
  listEl.innerHTML = sorted.map(c => cfContractCard(c, wallet)).join('');
}

// ─── Single contract card ──────────────────────────────────────────────────────
function cfContractCard(c, wallet) {
  const isClient     = c.client?.toLowerCase() === wallet?.toLowerCase();
  const isContractor = c.contractor?.toLowerCase() === wallet?.toLowerCase();

  const statusColor = { Draft: 'yellow', Active: 'cyan', Completed: 'green', Cancelled: 'red' }[c.status] || 'gray';
  const statusIcon  = { Draft: 'fa-clock', Active: 'fa-bolt', Completed: 'fa-check-circle', Cancelled: 'fa-times-circle' }[c.status] || 'fa-circle';
  const progress    = c.milestoneCount > 0 ? Math.round((c.completedMilestones / c.milestoneCount) * 100) : 0;
  const usdcTotal   = cfFmtUsdc(c.totalValue);
  const deposited   = cfFmtUsdc(c.depositedValue);

  const milestonesHtml = (c.milestones || []).map((ms, idx) => {
    const released   = ms.status === 'Released';
    const canRelease = isClient && c.status === 'Active' && !released;
    return `
      <div class="flex items-start gap-2.5 py-2 border-b border-gray-700/30 last:border-0">
        <i class="fas ${released ? 'fa-check-circle text-green-400' : 'fa-circle text-gray-600'} mt-0.5 text-sm flex-shrink-0"></i>
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs text-gray-300 truncate">${ms.description}</span>
            <span class="text-xs font-mono ${released ? 'text-green-400' : 'text-gray-400'} flex-shrink-0">$${cfFmtUsdc(ms.amount)}</span>
          </div>
          ${ms.releasedAt > 0 ? `<div class="text-[10px] text-gray-600 mt-0.5"><i class="fas fa-check mr-1"></i>Liberado: ${cfTs(ms.releasedAt)}</div>` : ''}
        </div>
        ${canRelease ? `
        <button onclick="cfCompleteMilestone(${c.id}, ${idx})"
          class="flex-shrink-0 px-2 py-1 bg-green-900/30 hover:bg-green-800/40 border border-green-700/40 text-green-400 text-[10px] rounded-lg transition">
          <i class="fas fa-unlock-alt mr-1"></i>Liberar
        </button>` : ''}
      </div>`;
  }).join('');

  const canSign   = isContractor && c.status === 'Draft' && !c.contractorSigned;
  const canCancel = isClient && c.status === 'Draft';

  return `
    <div class="bg-gray-800/40 border border-gray-700/40 rounded-2xl p-4 mb-3 hover:border-gray-600/60 transition-colors" id="cf-card-${c.id}">
      <!-- Header -->
      <div class="flex items-start justify-between gap-3 mb-3">
        <div class="flex items-center gap-2.5 min-w-0">
          <div class="w-9 h-9 rounded-xl bg-${statusColor}-900/30 border border-${statusColor}-700/30 flex items-center justify-center flex-shrink-0">
            <i class="fas ${statusIcon} text-${statusColor}-400 text-sm"></i>
          </div>
          <div class="min-w-0">
            <div class="text-white font-semibold text-sm truncate">${c.title}</div>
            <div class="text-gray-500 text-[11px] font-mono">
              Contract #${c.id} ·
              <a href="${CF_EXPLORER}/address/${CF_FACTORY_ADDR}" target="_blank" rel="noopener" class="text-blue-400 hover:underline">
                ${cfShort(CF_FACTORY_ADDR)} <i class="fas fa-external-link-alt text-[9px]"></i>
              </a>
            </div>
          </div>
        </div>
        <div class="flex flex-col items-end gap-1.5 flex-shrink-0">
          <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-${statusColor}-900/30 border border-${statusColor}-700/30 text-${statusColor}-400 text-[11px] font-semibold">
            <i class="fas ${statusIcon} text-[9px]"></i>${c.status}
          </span>
          <span class="text-[11px] font-mono text-gray-400 font-semibold">$${usdcTotal} USDC</span>
          ${c.depositedValue > 0n ? `<span class="text-[10px] text-gray-600">Depositado: $${deposited}</span>` : ''}
        </div>
      </div>

      <!-- Parties -->
      <div class="grid grid-cols-2 gap-2 mb-3">
        <div class="bg-gray-900/40 rounded-lg px-3 py-2">
          <div class="text-[10px] text-gray-600 mb-0.5 uppercase tracking-wide">Cliente</div>
          <div class="text-xs font-mono text-cyan-400 truncate" title="${c.client}">${cfShort(c.client)}${isClient ? ' <span class="text-[9px] text-cyan-600">(você)</span>' : ''}</div>
        </div>
        <div class="bg-gray-900/40 rounded-lg px-3 py-2">
          <div class="text-[10px] text-gray-600 mb-0.5 uppercase tracking-wide">Contratado</div>
          <div class="text-xs font-mono text-purple-400 truncate" title="${c.contractor}">${cfShort(c.contractor)}${isContractor ? ' <span class="text-[9px] text-purple-600">(você)</span>' : ''}</div>
        </div>
      </div>

      <!-- Progress bar -->
      ${c.milestoneCount > 0 ? `
      <div class="mb-3">
        <div class="flex justify-between text-[10px] text-gray-500 mb-1">
          <span>Progresso</span>
          <span>${c.completedMilestones}/${c.milestoneCount} milestones · ${progress}%</span>
        </div>
        <div class="h-1.5 bg-gray-700/60 rounded-full overflow-hidden">
          <div class="h-full bg-gradient-to-r from-cyan-500 to-green-500 rounded-full transition-all" style="width:${progress}%"></div>
        </div>
      </div>` : ''}

      <!-- Timestamps -->
      <div class="flex flex-wrap gap-3 text-[10px] text-gray-600 mb-3">
        <span><i class="fas fa-plus-circle mr-1"></i>${cfTs(c.createdAt)}</span>
        ${c.startedAt > 0 ? `<span><i class="fas fa-play mr-1 text-cyan-600"></i>Iniciado: ${cfTs(c.startedAt)}</span>` : ''}
        ${c.completedAt > 0 ? `<span><i class="fas fa-check mr-1 text-green-600"></i>Concluído: ${cfTs(c.completedAt)}</span>` : ''}
      </div>

      <!-- Milestones (collapsible) -->
      ${c.milestones?.length > 0 ? `
      <details class="mb-3">
        <summary class="text-xs text-gray-400 hover:text-gray-300 cursor-pointer select-none font-medium flex items-center gap-2">
          <i class="fas fa-list-check text-[11px] text-gray-600"></i>
          Milestones (${c.milestones.length})
          <span class="ml-auto text-[10px] text-gray-600">▼</span>
        </summary>
        <div class="mt-2 pl-2">${milestonesHtml}</div>
      </details>` : ''}

      <!-- Actions -->
      <div class="flex gap-2 flex-wrap items-center">
        ${canSign ? `
        <button onclick="cfSignContract(${c.id})"
          class="flex items-center gap-1.5 px-3 py-1.5 bg-cyan-900/30 hover:bg-cyan-800/40 border border-cyan-700/40 text-cyan-400 text-xs rounded-xl transition">
          <i class="fas fa-signature text-xs"></i>Assinar Contrato
        </button>` : ''}
        ${canCancel ? `
        <button onclick="cfCancelContract(${c.id})"
          class="flex items-center gap-1.5 px-3 py-1.5 bg-red-900/20 hover:bg-red-900/30 border border-red-700/30 text-red-400 text-xs rounded-xl transition">
          <i class="fas fa-times text-xs"></i>Cancelar
        </button>` : ''}
        <a href="${CF_EXPLORER}/address/${CF_FACTORY_ADDR}#readContract"
           target="_blank" rel="noopener"
           class="ml-auto flex items-center gap-1.5 px-3 py-1.5 bg-gray-700/40 hover:bg-gray-700/60 border border-gray-600/40 text-gray-400 text-xs rounded-xl transition">
          <i class="fas fa-external-link-alt text-xs"></i>ArcScan
        </a>
      </div>

      <!-- Signing status indicator -->
      <div class="mt-2 flex items-center gap-4 text-[10px] text-gray-600">
        <span class="flex items-center gap-1">
          <i class="fas fa-user ${c.statusCode >= 1 ? 'text-green-500' : 'text-gray-600'}"></i>
          Cliente: ${c.statusCode >= 1 ? '<span class="text-green-400">USDC depositado</span>' : '<span class="text-yellow-500">pendente</span>'}
        </span>
        <span class="flex items-center gap-1">
          <i class="fas fa-hard-hat ${c.contractorSigned ? 'text-green-500' : 'text-gray-600'}"></i>
          Contratado: ${c.contractorSigned ? '<span class="text-green-400">assinou</span>' : '<span class="text-yellow-500">pendente</span>'}
        </span>
      </div>
    </div>`;
}

// ─── Tx badge helper ──────────────────────────────────────────────────────────
function cfShowTxBadge(txHash, label) {
  if (typeof window.showTXConfirmationBadge === 'function') {
    window.showTXConfirmationBadge(txHash, label);
  }
}

// ─── Main flow: Create Contract ────────────────────────────────────────────────
async function cfCreateContract() {
  if (cfState.pending) { showToast('Transação em andamento, aguarde.', 'warning'); return; }

  const wallet = window.walletState?.address;
  if (!wallet) {
    showToast('⚠️ Conecte sua carteira antes de criar um contrato.', 'warning');
    return;
  }

  // ── Read form inputs ───────────────────────────────────────────────────────
  const contractor  = cfEl('cf-contractor')?.value?.trim();
  const title       = cfEl('cf-title')?.value?.trim();
  const totalValue  = cfEl('cf-value')?.value?.trim();
  const msRows      = document.querySelectorAll('.cf-milestone-row');

  if (!contractor || !title || !totalValue) {
    showToast('Preencha todos os campos obrigatórios.', 'warning');
    return;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(contractor)) {
    showToast('Endereço do contratado inválido (0x + 40 hex).', 'error');
    return;
  }
  if (contractor.toLowerCase() === wallet.toLowerCase()) {
    showToast('Cliente e contratado não podem ser o mesmo endereço.', 'error');
    return;
  }

  const humanAmount = parseFloat(totalValue);
  if (isNaN(humanAmount) || humanAmount <= 0) {
    showToast('Valor total deve ser maior que 0.', 'error');
    return;
  }

  // ── Collect milestones ─────────────────────────────────────────────────────
  const milestoneDescs    = [];
  const milestoneAmounts  = [];
  msRows.forEach(row => {
    const d = row.querySelector('.cf-ms-desc')?.value?.trim();
    const a = parseFloat(row.querySelector('.cf-ms-amt')?.value || '0');
    if (d && a > 0) {
      milestoneDescs.push(d);
      milestoneAmounts.push(cfParseUsdc(a));
    }
  });

  if (milestoneDescs.length === 0) {
    showToast('Adicione pelo menos 1 milestone com descrição e valor.', 'warning');
    return;
  }
  if (milestoneDescs.length > 10) {
    showToast('Máximo de 10 milestones por contrato.', 'error');
    return;
  }

  const totalRaw = cfParseUsdc(humanAmount);
  const sumMs    = milestoneAmounts.reduce((a, b) => a + b, 0n);
  if (sumMs !== totalRaw) {
    const diff = Math.abs(Number(totalRaw - sumMs)) / 1e6;
    showToast(`Soma dos milestones ($${Number(sumMs) / 1e6} USDC) ≠ total ($${humanAmount} USDC). Diferença: $${diff.toFixed(6)}.`, 'error');
    return;
  }

  // ── Lock UI ────────────────────────────────────────────────────────────────
  cfState.pending = true;
  const btn = cfEl('cf-submit-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Processando…'; }

  const showErr = (msg) => {
    showToast(`❌ ${msg}`, 'error');
    cfSetStep(0, 'error', 'Erro: ' + msg.slice(0, 50));
  };
  const unlock = () => {
    cfState.pending = false;
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-file-plus mr-2"></i>Criar Contrato'; }
  };

  try {
    // ── Step 0: Rede ───────────────────────────────────────────────────────
    cfSetStep(0);
    const init = await cfInitProvider();
    if (!init.ok) {
      if (init.error === 'wrong_network') {
        showErr('Rede incorreta. Troque para Arc Testnet.');
        cfShowListState('wrong_network', init.message);
      } else {
        showErr(init.message);
      }
      unlock();
      return;
    }
    const { signer, factory, usdc, address: fromAddr } = init;
    cfLog('Create contract — wallet:', fromAddr, '| contractor:', contractor, '| amount:', humanAmount);

    // ── Step 1: Saldo USDC ──────────────────────────────────────────────────
    cfSetStep(1, 'active', 'Verificar saldo USDC');
    const balance = await cfReadBalance(fromAddr);
    cfLog('USDC balance:', cfFmtUsdc(balance), '| required:', humanAmount);
    if (balance < totalRaw) {
      throw new Error(`Saldo insuficiente: ${cfFmtUsdc(balance)} USDC disponível, ${humanAmount} USDC necessário.`);
    }

    // ── Step 2: Approve ─────────────────────────────────────────────────────
    cfSetStep(2, 'active', 'Verificar allowance USDC');
    const allowance = await cfReadAllowance(fromAddr, CF_FACTORY_ADDR);
    cfLog('USDC allowance:', cfFmtUsdc(allowance), '| required:', humanAmount);

    if (allowance < totalRaw) {
      cfSetStep(2, 'active', `Aprovar ${humanAmount} USDC para ContractFactory…`);
      showToast(`📝 Aprovando ${humanAmount} USDC — confirme na carteira…`, 'info');

      const approveTx = await usdc.approve(CF_FACTORY_ADDR, totalRaw);
      cfLog('Approve tx sent:', approveTx.hash);
      showToast(`⏳ Approve: <a href="${CF_EXPLORER}/tx/${approveTx.hash}" target="_blank" class="underline">${approveTx.hash.slice(0, 14)}…</a>`, 'info');

      const approveReceipt = await approveTx.wait(1);
      cfLog('Approve confirmed block:', approveReceipt.blockNumber, 'status:', approveReceipt.status);
      if (approveReceipt.status !== 1) throw new Error('Transação approve revertida.');
      showToast('✅ Approve confirmado!', 'success');
    } else {
      cfLog('Allowance already sufficient:', cfFmtUsdc(allowance));
    }

    // ── Step 3: Estimativa de gas ───────────────────────────────────────────
    cfSetStep(3, 'active', 'Estimando gas…');
    let gasLimit;
    try {
      gasLimit = await factory.createContract.estimateGas(contractor, title, totalRaw, milestoneDescs, milestoneAmounts);
      gasLimit = (gasLimit * 125n) / 100n; // +25%
    } catch (e) {
      cfWarn('estimateGas failed:', e.message);
      gasLimit = 500000n;
    }

    let feeData;
    try { feeData = await init.provider.getFeeData(); } catch { feeData = { gasPrice: null }; }
    const gasPrice   = feeData?.gasPrice ?? 10000000000n; // fallback 10 Gwei
    const gasFeeRaw  = gasLimit * gasPrice;
    const gasFeeUsdc = (Number(gasFeeRaw) / 1e6).toFixed(6); // USDC native = 6 decimals
    cfLog('Gas estimate:', gasLimit.toString(), '| Gas price:', gasPrice.toString(), '| Fee:', gasFeeUsdc, 'USDC');
    showToast(`⛽ Gas estimado: ${gasFeeUsdc} USDC (${gasLimit} gas). Confirme na carteira…`, 'info');

    // ── Step 4: Enviar createContract ───────────────────────────────────────
    cfSetStep(4, 'active', 'Aguardando assinatura na carteira…');
    const createTx = await factory.createContract(
      contractor,
      title,
      totalRaw,
      milestoneDescs,
      milestoneAmounts,
      { gasLimit }
    );
    cfState.lastTxHash = createTx.hash;
    cfLog('createContract tx sent:', createTx.hash);
    showToast(
      `📤 Tx enviada: <a href="${CF_EXPLORER}/tx/${createTx.hash}" target="_blank" class="underline font-mono">${createTx.hash.slice(0, 18)}…</a>`,
      'info'
    );

    // ── Step 5: Aguardar confirmação ────────────────────────────────────────
    cfSetStep(5, 'active', 'Aguardando confirmação on-chain (1–3 blocos)…');
    showToast('⏳ Aguardando confirmação on-chain…', 'info');
    const receipt = await createTx.wait(1);
    cfLog('createContract confirmed — block:', receipt.blockNumber, '| status:', receipt.status, '| hash:', receipt.hash);

    if (receipt.status !== 1) {
      throw new Error(`Transação revertida no bloco #${receipt.blockNumber}. Verifique allowance e saldo.`);
    }

    // ── Extract contract ID from ContractCreated event log ──────────────────
    let newContractId = null;
    try {
      const iface = new window.ethers.Interface([
        'event ContractCreated(uint256 indexed contractId, address indexed client, address indexed contractor, uint256 totalValue)'
      ]);
      for (const log of receipt.logs) {
        try {
          const decoded = iface.parseLog(log);
          if (decoded?.name === 'ContractCreated') {
            newContractId = Number(decoded.args[0]);
            cfLog('ContractCreated event — contractId:', newContractId);
            break;
          }
        } catch { /* not this event */ }
      }
    } catch (e) {
      cfWarn('Failed to decode ContractCreated event:', e.message);
    }

    // ── Step 6: Recarregar ──────────────────────────────────────────────────
    cfSetStep(6, 'active', 'Recarregando lista…');
    showToast(
      `✅ Contrato${newContractId !== null ? ` #${newContractId}` : ''} criado! Bloco #${receipt.blockNumber} · <a href="${CF_EXPLORER}/tx/${receipt.hash}" target="_blank" class="underline">ArcScan ↗</a>`,
      'success'
    );

    cfShowTxBadge(receipt.hash, `ContractFactory: createContract${ newContractId !== null ? ` #${newContractId}` : '' } — $${humanAmount} USDC`);

    // Reset form
    cfEl('cf-title').value      = '';
    cfEl('cf-contractor').value = '';
    cfEl('cf-value').value      = '';
    cfResetMilestones();

    // Reload after 1.5 s
    setTimeout(cfLoadContracts, 1500);

  } catch (err) {
    cfErr('cfCreateContract error:', err);
    const userRejected = err.code === 4001 || err.code === 'ACTION_REJECTED' ||
                         err.message?.includes('rejected') || err.message?.includes('denied') ||
                         err.message?.includes('user denied');
    if (userRejected) {
      showToast('⚠️ Transação rejeitada pelo usuário.', 'warning');
      cfHideSteps();
    } else {
      showErr(err.reason || err.message || 'Erro desconhecido');
    }
  } finally {
    unlock();
    setTimeout(cfHideSteps, 20000);
  }
}

// ─── Sign Contract ────────────────────────────────────────────────────────────
async function cfSignContract(contractId) {
  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Conecte sua carteira.', 'warning'); return; }

  const init = await cfInitProvider();
  if (!init.ok) { showToast(`❌ ${init.message}`, 'error'); return; }

  try {
    const { factory } = init;
    showToast(`📝 Assinar contrato #${contractId} — confirme na carteira…`, 'info');
    const tx = await factory.signContract(contractId);
    cfLog('signContract tx sent:', tx.hash);
    showToast(`⏳ <a href="${CF_EXPLORER}/tx/${tx.hash}" target="_blank" class="underline">${tx.hash.slice(0, 18)}…</a>`, 'info');
    const receipt = await tx.wait(1);
    cfLog('signContract confirmed — block:', receipt.blockNumber, 'status:', receipt.status);
    if (receipt.status !== 1) throw new Error('Transação revertida.');
    showToast(`✅ Contrato #${contractId} assinado! Bloco #${receipt.blockNumber}.`, 'success');
    cfShowTxBadge(receipt.hash, `signContract #${contractId}`);
    setTimeout(cfLoadContracts, 1500);
  } catch (err) {
    const rejected = err.code === 4001 || err.code === 'ACTION_REJECTED' || err.message?.includes('rejected');
    if (rejected) showToast('⚠️ Transação rejeitada.', 'warning');
    else showToast(`❌ ${err.reason || err.message}`, 'error');
    cfErr('signContract error:', err);
  }
}

// ─── Complete Milestone ───────────────────────────────────────────────────────
async function cfCompleteMilestone(contractId, milestoneIdx) {
  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Conecte sua carteira.', 'warning'); return; }

  if (!confirm(`Liberar pagamento do milestone ${milestoneIdx + 1} do contrato #${contractId}?\n\nEsta ação é irreversível — o USDC será transferido ao contratado.`)) return;

  const init = await cfInitProvider();
  if (!init.ok) { showToast(`❌ ${init.message}`, 'error'); return; }

  try {
    const { factory } = init;
    showToast(`📝 Liberando milestone ${milestoneIdx + 1} — confirme na carteira…`, 'info');
    const tx = await factory.completeMilestone(contractId, milestoneIdx);
    cfLog('completeMilestone tx sent:', tx.hash);
    showToast(`⏳ <a href="${CF_EXPLORER}/tx/${tx.hash}" target="_blank" class="underline">${tx.hash.slice(0, 18)}…</a>`, 'info');
    const receipt = await tx.wait(1);
    cfLog('completeMilestone confirmed — block:', receipt.blockNumber, 'status:', receipt.status);
    if (receipt.status !== 1) throw new Error('Transação revertida.');
    showToast(`✅ Milestone ${milestoneIdx + 1} liberado! Bloco #${receipt.blockNumber}.`, 'success');
    cfShowTxBadge(receipt.hash, `completeMilestone #${contractId}[${milestoneIdx}]`);
    setTimeout(cfLoadContracts, 1500);
  } catch (err) {
    const rejected = err.code === 4001 || err.code === 'ACTION_REJECTED' || err.message?.includes('rejected');
    if (rejected) showToast('⚠️ Transação rejeitada.', 'warning');
    else showToast(`❌ ${err.reason || err.message}`, 'error');
    cfErr('completeMilestone error:', err);
  }
}

// ─── Cancel Contract ──────────────────────────────────────────────────────────
async function cfCancelContract(contractId) {
  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Conecte sua carteira.', 'warning'); return; }

  if (!confirm(`Cancelar contrato #${contractId}?\n\nO USDC depositado será reembolsado ao cliente. Esta ação é irreversível.`)) return;

  const init = await cfInitProvider();
  if (!init.ok) { showToast(`❌ ${init.message}`, 'error'); return; }

  try {
    const { factory } = init;
    showToast(`📝 Cancelando contrato #${contractId} — confirme na carteira…`, 'info');
    const tx = await factory.cancelContract(contractId);
    cfLog('cancelContract tx sent:', tx.hash);
    showToast(`⏳ <a href="${CF_EXPLORER}/tx/${tx.hash}" target="_blank" class="underline">${tx.hash.slice(0, 18)}…</a>`, 'info');
    const receipt = await tx.wait(1);
    cfLog('cancelContract confirmed — block:', receipt.blockNumber, 'status:', receipt.status);
    if (receipt.status !== 1) throw new Error('Transação revertida.');
    showToast(`✅ Contrato #${contractId} cancelado! USDC reembolsado. Bloco #${receipt.blockNumber}.`, 'success');
    cfShowTxBadge(receipt.hash, `cancelContract #${contractId}`);
    setTimeout(cfLoadContracts, 1500);
  } catch (err) {
    const rejected = err.code === 4001 || err.code === 'ACTION_REJECTED' || err.message?.includes('rejected');
    if (rejected) showToast('⚠️ Transação rejeitada.', 'warning');
    else showToast(`❌ ${err.reason || err.message}`, 'error');
    cfErr('cancelContract error:', err);
  }
}

// ─── Milestone form management ─────────────────────────────────────────────────
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
  const rows  = document.querySelectorAll('.cf-milestone-row');
  let sum = 0;
  rows.forEach(r => {
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

// ─── Wallet gate update ────────────────────────────────────────────────────────
function cfWalletGateUpdate() {
  // No banner — handled by cfShowListState('no_wallet')
  // Just ensure the list reflects the current wallet state
  const wallet = window.walletState?.address;
  if (!wallet) {
    cfShowListState('no_wallet');
    cfRenderSummary([], null);
  }
}

// ─── Wallet event listeners ───────────────────────────────────────────────────
window.addEventListener('walletConnected',    () => {
  cfLog('walletConnected event → cfLoadContracts()');
  cfLoadContracts();
});
window.addEventListener('walletDisconnected', () => {
  cfLog('walletDisconnected event → show no_wallet state');
  cfShowListState('no_wallet');
  cfRenderSummary([], null);
  cfState.contracts     = [];
  cfState.myContractIds = [];
  cfState.networkOk     = false;
});
window.addEventListener('walletChanged', () => {
  cfLog('walletChanged event → cfLoadContracts()');
  cfLoadContracts();
});

// ─── Expose globally ──────────────────────────────────────────────────────────
window.cfCreateContract     = cfCreateContract;
window.cfLoadContracts      = cfLoadContracts;
window.cfSignContract       = cfSignContract;
window.cfCompleteMilestone  = cfCompleteMilestone;
window.cfCancelContract     = cfCancelContract;
window.cfAddMilestone       = cfAddMilestone;
window.cfUpdateMilestoneSum = cfUpdateMilestoneSum;
window.cfWalletGateUpdate   = cfWalletGateUpdate;
window.cfSwitchNetwork      = cfSwitchNetwork;
window.cfState              = cfState;

// Legacy alias
window.loadContracts = cfLoadContracts;

console.log(
  '[CF] Contracts module loaded',
  '| Factory:', CF_FACTORY_ADDR,
  '| USDC:', CF_USDC_ADDR,
  '| Chain:', CF_CHAIN_ID,
  '| RPC:', CF_RPC
);
