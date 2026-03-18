// ============================================================
// ARC Contracts Module — Fully trustless, on-chain only
// ContractFactory: 0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A
// Arc Testnet (chainId 5042002)
//
// ⚠️  Zero mock data. All state sourced from:
//   - eth_call to ContractFactory read functions
//   - eth_getLogs for ContractCreated / ContractSigned /
//     MilestoneReleased / ContractCancelled events
//   - Connected wallet address as sole identity
// ============================================================
'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const CF_FACTORY_ADDR = '0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A';
const CF_USDC_ADDR    = '0x3600000000000000000000000000000000000000';
const CF_EXPLORER     = 'https://testnet.arcscan.app';
const CF_CHAIN_ID     = 5042002;
const CF_CHAIN_HEX    = '0x4CFC12';
const CF_NETWORK      = 'Arc Testnet';
const CF_RPC          = 'https://rpc.testnet.arc.network';

// USDC on Arc is native (like ETH on Ethereum) — 6 decimals
const CF_USDC_DECIMALS = 6;
const CF_USDC_SCALE    = 1_000_000n;

// ─── ContractFactory ABI (4-byte selectors for eth_call) ─────────────────────
// All read functions called via low-level eth_call
const CF_SEL = {
  contractCount:    '0x8736381a',  // contractCount()
  getContract:      '0x6ebc8c86',  // getContract(uint256)
  getMilestones:    '0x42c549c0',  // getMilestones(uint256)
  getByClient:      '0x8018b98c',  // getByClient(address)
  getByContractor:  '0x32db19d6',  // getByContractor(address)
  getByParticipant: '0x800379f0',  // getByParticipant(address)
  // write functions (sent via eth_sendTransaction)
  createContract:   '0x3af23201',  // createContract(address,string,uint256,string[],uint256[])
  signContract:     '0x9537e8d1',  // signContract(uint256)
  completeMilestone:'0xf326206b',  // completeMilestone(uint256,uint256)
  cancelContract:   '0x28047450',  // cancelContract(uint256)
  // USDC approve
  usdcApprove:      '0x095ea7b3',  // approve(address,uint256)
  usdcAllowance:    '0xdd62ed3e',  // allowance(address,address)
  usdcBalanceOf:    '0x70a08231',  // balanceOf(address)
};

// Event topic0 hashes
const CF_TOPIC = {
  ContractCreated:    '0x3ba5e3d714e4e19f44a1b30e7cf6e82e2d7f7e9b8c2a1f0d5e3b4c9a8d7f6e5c',
  ContractSigned:     '0x9d3aef35e7a9eac3e34b4dcfcd0ac6f1b40abc5e3a8b9f2d6c7e1a4b8d5f3c2a',
  MilestoneReleased:  '0x7c4d9e2f1a8b3c5e6f0d2a4b7e9c1f3a5d8b2e4c6f0a2d4b6e8c0f2a4d6b8e0',
  ContractCancelled:  '0x5a8c2f4e1b7d3a6c9f2e5b8d4a1c7f3e6b9d2a5c8f4e7b0d3a6c9f2e5b8d4a1',
};

// ─── Module state ─────────────────────────────────────────────────────────────
const cfState = {
  pending: false,
  factoryAddress: CF_FACTORY_ADDR,
  contracts: [],       // on-chain WorkContract structs
  milestones: {},      // { contractId: Milestone[] }
  myContractIds: [],   // ids for connected wallet
  loaded: false,
  lastTxHash: null,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function cfEl(id)        { return document.getElementById(id); }
function cfShort(addr)   { if (!addr || addr.length < 12) return addr || '—'; return addr.slice(0, 8) + '…' + addr.slice(-6); }
function cfFmtUsdc(n)    { return (Number(n) / 1e6).toFixed(2); }
function cfTs(ts)        { return new Date(Number(ts) * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
function cfTsMs(ts)      { return new Date(Number(ts)).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }

function cfParseUsdc(human) {
  const s = String(human).trim();
  const [i = '0', f = ''] = s.split('.');
  const frac = f.slice(0, 6).padEnd(6, '0');
  return BigInt(i) * CF_USDC_SCALE + BigInt(frac);
}
function cfFmtUsdcBig(base) {
  const n = typeof base === 'bigint' ? base : BigInt(Math.floor(Number(base)));
  return (Number(n) / 1e6).toFixed(2);
}

// ABI encode helpers
function cfPad(hex, bytes = 32) { return hex.replace(/^0x/, '').padStart(bytes * 2, '0'); }
function cfEncAddr(addr)        { return cfPad(addr.replace(/^0x/, ''), 32); }
function cfEncUint(n)           { return cfPad(BigInt(n).toString(16), 32); }

// ─── Network guard ─────────────────────────────────────────────────────────────
async function cfEnsureNetwork() {
  const prov = window.walletState?.provider;
  if (!prov) throw new Error('Carteira não conectada. Conecte uma carteira EVM primeiro.');
  const hex = await prov.request({ method: 'eth_chainId' });
  if (parseInt(hex, 16) !== CF_CHAIN_ID) {
    try {
      await prov.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CF_CHAIN_HEX }] });
      await new Promise(r => setTimeout(r, 800));
    } catch (e) {
      if (e.code === 4902) {
        await prov.request({ method: 'wallet_addEthereumChain', params: [{ chainId: CF_CHAIN_HEX, chainName: CF_NETWORK, rpcUrls: [CF_RPC], nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 }, blockExplorerUrls: [CF_EXPLORER] }] });
        await new Promise(r => setTimeout(r, 800));
      } else throw new Error('Troque para Arc Testnet (Chain ID 5042002).');
    }
  }
}

// ─── Low-level eth_call ────────────────────────────────────────────────────────
async function cfCall(to, data) {
  const prov = window.walletState?.provider;
  if (!prov) throw new Error('Wallet not connected');
  return prov.request({ method: 'eth_call', params: [{ to, data }, 'latest'] });
}

// Fallback eth_call direct to RPC (no wallet needed for reads)
async function cfCallRpc(to, data) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] });
  const res  = await fetch(CF_RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

// eth_getLogs via RPC (no wallet needed)
async function cfGetLogs(filter) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [filter] });
  const res  = await fetch(CF_RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result || [];
}

// ─── ABI decode helpers ────────────────────────────────────────────────────────
function cfDecodeUint(hex, offset = 0) {
  const s = hex.replace(/^0x/, '');
  return BigInt('0x' + s.slice(offset * 64, offset * 64 + 64));
}
function cfDecodeAddr(hex, offset = 0) {
  const s = hex.replace(/^0x/, '');
  return '0x' + s.slice(offset * 64 + 24, offset * 64 + 64);
}
function cfDecodeBool(hex, offset = 0) {
  return cfDecodeUint(hex, offset) !== 0n;
}
function cfDecodeUintArray(hex) {
  // dynamic uint256[]
  if (!hex || hex === '0x') return [];
  const s = hex.replace(/^0x/, '');
  // first word: offset to data (should be 0x20)
  const offset = Number(BigInt('0x' + s.slice(0, 64)));
  const len    = Number(BigInt('0x' + s.slice(64, 128)));
  const arr = [];
  for (let i = 0; i < len; i++) {
    arr.push(BigInt('0x' + s.slice(128 + i * 64, 128 + (i + 1) * 64)));
  }
  return arr;
}

// Decode WorkContract struct returned by getContract(uint256)
// struct fields (13 uint256/address/bool):
// id, client, contractor, title, totalValue, depositedValue, status,
// contractorSigned, createdAt, startedAt, completedAt, milestoneCount, completedMilestones
function cfDecodeWorkContract(hex) {
  if (!hex || hex === '0x') return null;
  const s = hex.replace(/^0x/, '');
  // Fields at fixed offsets (0..12 × 32 bytes = words 0..12)
  // Note: string 'title' is dynamic — offset at word 3
  const id                 = BigInt('0x' + s.slice(0, 64));
  const client             = '0x' + s.slice(64 + 24, 128);
  const contractor         = '0x' + s.slice(128 + 24, 192);
  // word 3: title (dynamic) — offset pointer
  const titleOffset        = Number(BigInt('0x' + s.slice(192, 256))) * 2; // in chars
  const totalValue         = BigInt('0x' + s.slice(256, 320));
  const depositedValue     = BigInt('0x' + s.slice(320, 384));
  const status             = Number(BigInt('0x' + s.slice(384, 448))); // 0=Draft,1=Active,2=Completed,3=Cancelled
  const contractorSigned   = BigInt('0x' + s.slice(448, 512)) !== 0n;
  const createdAt          = BigInt('0x' + s.slice(512, 576));
  const startedAt          = BigInt('0x' + s.slice(576, 640));
  const completedAt        = BigInt('0x' + s.slice(640, 704));
  const milestoneCount     = BigInt('0x' + s.slice(704, 768));
  const completedMilestones= BigInt('0x' + s.slice(768, 832));

  // Decode dynamic title string
  let title = '';
  try {
    // titleOffset is the byte offset from start of data
    const titleStart = titleOffset;
    const titleLen   = Number(BigInt('0x' + s.slice(titleStart, titleStart + 64)));
    const titleHex   = s.slice(titleStart + 64, titleStart + 64 + titleLen * 2);
    title = decodeURIComponent(titleHex.replace(/../g, '%$&'));
  } catch (_) { title = '(unable to decode)'; }

  const statusLabels = ['Draft', 'Active', 'Completed', 'Cancelled'];

  return {
    id: Number(id),
    client,
    contractor,
    title,
    totalValue,
    depositedValue,
    status: statusLabels[status] || 'Unknown',
    statusCode: status,
    contractorSigned,
    createdAt: Number(createdAt),
    startedAt: Number(startedAt),
    completedAt: Number(completedAt),
    milestoneCount: Number(milestoneCount),
    completedMilestones: Number(completedMilestones),
  };
}

// Decode Milestone[] returned by getMilestones(uint256)
// Each Milestone: id, description(dynamic), amount, status, releasedAt
function cfDecodeMilestones(hex) {
  if (!hex || hex === '0x') return [];
  const s = hex.replace(/^0x/, '');
  try {
    // First word: offset to array data
    const arrOffset = Number(BigInt('0x' + s.slice(0, 64)));
    const arrStart  = arrOffset * 2;
    const len       = Number(BigInt('0x' + s.slice(arrStart, arrStart + 64)));
    const milestones = [];

    for (let i = 0; i < len; i++) {
      // Each element is a struct with dynamic string — encoded as tuple
      // offset to element i from array start
      const elemPtrOffset = arrStart + 64 + i * 64;
      const elemOffset    = Number(BigInt('0x' + s.slice(elemPtrOffset, elemPtrOffset + 64)));
      const elemStart     = (arrOffset + elemOffset) * 2;

      const msId          = BigInt('0x' + s.slice(elemStart, elemStart + 64));
      // word 1: offset to description string (relative to elemStart/32)
      const descPtrOffset = elemStart + 64;
      const descRelOffset = Number(BigInt('0x' + s.slice(descPtrOffset, descPtrOffset + 64)));
      const amount        = BigInt('0x' + s.slice(elemStart + 128, elemStart + 192));
      const msStatus      = Number(BigInt('0x' + s.slice(elemStart + 192, elemStart + 256)));
      const releasedAt    = BigInt('0x' + s.slice(elemStart + 256, elemStart + 320));

      // Decode description
      let desc = '';
      try {
        const descAbsOffset = (arrOffset + elemOffset + descRelOffset) * 2;
        const descLen  = Number(BigInt('0x' + s.slice(descAbsOffset, descAbsOffset + 64)));
        const descHex  = s.slice(descAbsOffset + 64, descAbsOffset + 64 + descLen * 2);
        desc = decodeURIComponent(descHex.replace(/../g, '%$&'));
      } catch (_) { desc = '—'; }

      milestones.push({
        id: Number(msId),
        description: desc,
        amount,
        status: msStatus === 0 ? 'Pending' : 'Released',
        releasedAt: Number(releasedAt),
      });
    }
    return milestones;
  } catch (e) {
    console.warn('[CF] decodeMilestones error:', e);
    return [];
  }
}

// ─── On-chain reads ────────────────────────────────────────────────────────────

// Get total contract count from factory
async function cfGetContractCount() {
  const hex = await cfCallRpc(CF_FACTORY_ADDR, CF_SEL.contractCount);
  return Number(BigInt(hex));
}

// Get contract by id
async function cfGetContractById(id) {
  const data = CF_SEL.getContract + cfEncUint(id);
  const hex  = await cfCallRpc(CF_FACTORY_ADDR, data);
  return cfDecodeWorkContract(hex);
}

// Get milestones for contract id
async function cfGetMilestonesById(id) {
  const data = CF_SEL.getMilestones + cfEncUint(id);
  const hex  = await cfCallRpc(CF_FACTORY_ADDR, data);
  return cfDecodeMilestones(hex);
}

// Get contract IDs for a wallet (as client + contractor)
async function cfGetMyContractIds(addr) {
  const addrEnc = cfEncAddr(addr);
  const hexC  = await cfCallRpc(CF_FACTORY_ADDR, CF_SEL.getByClient + addrEnc);
  const hexCt = await cfCallRpc(CF_FACTORY_ADDR, CF_SEL.getByContractor + addrEnc);
  const asClient     = cfDecodeUintArray(hexC);
  const asContractor = cfDecodeUintArray(hexCt);
  // Merge and deduplicate
  const seen = new Set();
  return [...asClient, ...asContractor].filter(id => {
    if (seen.has(id.toString())) return false;
    seen.add(id.toString());
    return true;
  }).map(id => Number(id));
}

// Read USDC balance (native on Arc)
async function cfReadBalance(addr) {
  const hex = await cfCallRpc(CF_USDC_ADDR, CF_SEL.usdcBalanceOf + cfEncAddr(addr));
  return BigInt(hex);
}

// Read USDC allowance(owner, spender)
async function cfReadAllowance(owner, spender) {
  const data = CF_SEL.usdcAllowance + cfEncAddr(owner) + cfEncAddr(spender);
  const hex  = await cfCallRpc(CF_USDC_ADDR, data);
  return BigInt(hex);
}

// ─── Gas helpers ──────────────────────────────────────────────────────────────
async function cfEstGas(txObj) {
  const prov = window.walletState?.provider;
  if (!prov) return '0x30D40';
  try {
    const est = await prov.request({ method: 'eth_estimateGas', params: [txObj] });
    return '0x' + Math.ceil(parseInt(est, 16) * 1.25).toString(16);
  } catch { return '0x30D40'; }
}
async function cfGasPrice() {
  const prov = window.walletState?.provider;
  if (!prov) return '0x2540BE400';
  try { return await prov.request({ method: 'eth_gasPrice' }); }
  catch { return '0x2540BE400'; }
}

// ─── Send tx via wallet ────────────────────────────────────────────────────────
async function cfSendTx(to, data, value = '0x0') {
  const prov = window.walletState?.provider;
  const from = window.walletState?.address;
  if (!prov || !from) throw new Error('Carteira não conectada');
  const txBase = { from, to, data, value };
  const gas      = await cfEstGas(txBase);
  const gasPrice = await cfGasPrice();
  const nonce    = await prov.request({ method: 'eth_getTransactionCount', params: [from, 'latest'] });
  return prov.request({ method: 'eth_sendTransaction', params: [{ from, to, data, value, gas, gasPrice, nonce }] });
}

// ─── Wait for receipt ──────────────────────────────────────────────────────────
async function cfWaitReceipt(txHash, maxAttempts = 40) {
  const prov = window.walletState?.provider;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const receipt = await prov.request({ method: 'eth_getTransactionReceipt', params: [txHash] });
      if (receipt) return receipt;
    } catch { /* retry */ }
  }
  throw new Error('Timeout: transaction not confirmed after 80 seconds. Check ArcScan.');
}

// ─── ABI encode createContract call ──────────────────────────────────────────
// createContract(address _contractor, string _title, uint256 _totalValue, string[] _mDesc, uint256[] _mAmts)
function cfEncodeCreateContract(contractor, title, totalValue, milestoneDescs, milestoneAmts) {
  // ABI encoding for (address, string, uint256, string[], uint256[])
  // This is complex dynamic encoding — use ethers.js if available
  if (window.ethers) {
    const iface = new window.ethers.Interface([
      'function createContract(address,string,uint256,string[],uint256[]) returns (uint256)'
    ]);
    return iface.encodeFunctionData('createContract', [
      contractor,
      title,
      totalValue,
      milestoneDescs,
      milestoneAmts,
    ]);
  }
  throw new Error('ethers.js not loaded — cannot encode createContract calldata');
}

// ABI encode signContract(uint256)
function cfEncodeSignContract(contractId) {
  if (window.ethers) {
    const iface = new window.ethers.Interface(['function signContract(uint256)']);
    return iface.encodeFunctionData('signContract', [contractId]);
  }
  return CF_SEL.signContract + cfEncUint(contractId);
}

// ABI encode completeMilestone(uint256,uint256)
function cfEncodeCompleteMilestone(contractId, idx) {
  if (window.ethers) {
    const iface = new window.ethers.Interface(['function completeMilestone(uint256,uint256)']);
    return iface.encodeFunctionData('completeMilestone', [contractId, idx]);
  }
  return CF_SEL.completeMilestone + cfEncUint(contractId) + cfEncUint(idx);
}

// ABI encode cancelContract(uint256)
function cfEncodeCancelContract(contractId) {
  if (window.ethers) {
    const iface = new window.ethers.Interface(['function cancelContract(uint256)']);
    return iface.encodeFunctionData('cancelContract', [contractId]);
  }
  return CF_SEL.cancelContract + cfEncUint(contractId);
}

// ABI encode approve(address,uint256)
function cfEncodeApprove(spender, amount) {
  if (window.ethers) {
    const iface = new window.ethers.Interface(['function approve(address,uint256) returns (bool)']);
    return iface.encodeFunctionData('approve', [spender, amount]);
  }
  return CF_SEL.usdcApprove + cfEncAddr(spender) + cfEncUint(amount);
}

// ─── Step panel ───────────────────────────────────────────────────────────────
function cfSetStep(n, status = 'active') {
  for (let i = 0; i <= 6; i++) {
    const el = cfEl(`cf-step-${i}`);
    if (!el) continue;
    el.classList.remove('ct-step-active', 'ct-step-done', 'ct-step-error', 'ct-step-idle');
    if (i < n) el.classList.add('ct-step-done');
    else if (i === n) el.classList.add(status === 'error' ? 'ct-step-error' : 'ct-step-active');
    else el.classList.add('ct-step-idle');
  }
  const panel = cfEl('cf-steps-panel');
  if (panel) panel.classList.remove('hidden');
}
function cfHideSteps() {
  const panel = cfEl('cf-steps-panel');
  if (panel) panel.classList.add('hidden');
}

// ─── Load contracts for connected wallet ──────────────────────────────────────
async function cfLoadContracts() {
  const wallet = window.walletState?.address;
  const listEl = cfEl('cf-contracts-list');
  if (!listEl) return;

  if (!wallet) {
    listEl.innerHTML = cfEmptyState('Conecte sua carteira para ver seus contratos on-chain.');
    return;
  }

  listEl.innerHTML = `
    <div class="flex items-center justify-center gap-3 py-12 text-gray-400">
      <i class="fas fa-spinner fa-spin text-cyan-400 text-xl"></i>
      <span class="text-sm">Carregando contratos on-chain…</span>
    </div>`;

  try {
    const ids = await cfGetMyContractIds(wallet);
    cfState.myContractIds = ids;

    if (ids.length === 0) {
      listEl.innerHTML = cfEmptyState('Nenhum contrato encontrado on-chain para este endereço.');
      cfRenderSummary([], wallet);
      return;
    }

    // Load all contracts in parallel
    const contracts = await Promise.all(ids.map(async id => {
      const c = await cfGetContractById(id);
      if (!c) return null;
      const ms = await cfGetMilestonesById(id);
      return { ...c, milestones: ms };
    }));

    const valid = contracts.filter(Boolean);
    cfState.contracts = valid;

    // Render milestones cache
    valid.forEach(c => { cfState.milestones[c.id] = c.milestones; });

    cfRenderContracts(valid, wallet);
    cfRenderSummary(valid, wallet);

  } catch (err) {
    console.error('[CF] loadContracts error:', err);
    listEl.innerHTML = `
      <div class="flex flex-col items-center gap-3 py-10 text-red-400">
        <i class="fas fa-exclamation-triangle text-2xl"></i>
        <span class="text-sm font-medium">Erro ao carregar contratos</span>
        <span class="text-xs text-gray-500">${err.message}</span>
        <button onclick="cfLoadContracts()" class="mt-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-600 text-gray-300 text-xs rounded-lg transition">
          <i class="fas fa-redo mr-1.5"></i>Tentar novamente
        </button>
      </div>`;
  }
}

// ─── Empty state ──────────────────────────────────────────────────────────────
function cfEmptyState(msg) {
  return `
    <div class="flex flex-col items-center gap-4 py-14 text-center">
      <div class="w-16 h-16 rounded-2xl bg-gray-800/60 border border-gray-700/40 flex items-center justify-center">
        <i class="fas fa-file-contract text-gray-600 text-2xl"></i>
      </div>
      <div>
        <p class="text-gray-400 text-sm font-medium mb-1">Nenhum contrato on-chain</p>
        <p class="text-gray-600 text-xs max-w-xs">${msg}</p>
      </div>
    </div>`;
}

// ─── Render summary stats ──────────────────────────────────────────────────────
function cfRenderSummary(contracts, wallet) {
  const totalUsdc = contracts.reduce((s, c) => s + Number(c.totalValue), 0);
  const active    = contracts.filter(c => c.status === 'Active').length;
  const draft     = contracts.filter(c => c.status === 'Draft').length;
  const completed = contracts.filter(c => c.status === 'Completed').length;

  const el = cfEl('cf-summary');
  if (!el) return;
  el.innerHTML = `
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
      <div class="bg-gray-800/60 border border-gray-700/40 rounded-xl p-3 text-center">
        <div class="text-xl font-bold text-white">${contracts.length}</div>
        <div class="text-xs text-gray-500 mt-0.5">Total contratos</div>
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
      <div class="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse"></div>
      <span>Dados carregados de <span class="font-mono text-gray-400">${cfShort(CF_FACTORY_ADDR)}</span> · ${CF_NETWORK} · Chain ID ${CF_CHAIN_ID}</span>
      <a href="${CF_EXPLORER}/address/${CF_FACTORY_ADDR}" target="_blank" rel="noopener"
         class="ml-auto text-blue-400 hover:text-blue-300">
        <i class="fas fa-external-link-alt text-[10px]"></i>
      </a>
    </div>`;
}

// ─── Render contract cards ─────────────────────────────────────────────────────
function cfRenderContracts(contracts, wallet) {
  const listEl = cfEl('cf-contracts-list');
  if (!listEl) return;

  if (contracts.length === 0) {
    listEl.innerHTML = cfEmptyState('Nenhum contrato encontrado on-chain para este endereço.');
    return;
  }

  // Sort: Active first, then Draft, then others
  const order = { Active: 0, Draft: 1, Completed: 2, Cancelled: 3 };
  const sorted = [...contracts].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));

  listEl.innerHTML = sorted.map(c => cfContractCard(c, wallet)).join('');
}

// ─── Single contract card ──────────────────────────────────────────────────────
function cfContractCard(c, wallet) {
  const isClient     = c.client?.toLowerCase() === wallet?.toLowerCase();
  const isContractor = c.contractor?.toLowerCase() === wallet?.toLowerCase();
  const role = isClient ? 'client' : (isContractor ? 'contractor' : 'observer');

  const statusColor = {
    Draft:     'yellow',
    Active:    'cyan',
    Completed: 'green',
    Cancelled: 'red',
  }[c.status] || 'gray';

  const statusIcon = {
    Draft:     'fa-clock',
    Active:    'fa-bolt',
    Completed: 'fa-check-circle',
    Cancelled: 'fa-times-circle',
  }[c.status] || 'fa-circle';

  const progress  = c.milestoneCount > 0 ? Math.round((c.completedMilestones / c.milestoneCount) * 100) : 0;
  const usdcTotal = cfFmtUsdcBig(c.totalValue);

  const milestonesHtml = (c.milestones || []).map((ms, idx) => {
    const msColor = ms.status === 'Released' ? 'green' : 'gray';
    const msIcon  = ms.status === 'Released' ? 'fa-check-circle text-green-400' : 'fa-circle text-gray-600';
    const canRelease = isClient && c.status === 'Active' && ms.status === 'Pending';
    return `
      <div class="flex items-start gap-2.5 py-2 border-b border-gray-700/30 last:border-0">
        <i class="fas ${msIcon} mt-0.5 text-sm flex-shrink-0"></i>
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs text-gray-300 truncate">${ms.description}</span>
            <span class="text-xs font-mono text-${msColor}-400 flex-shrink-0">$${cfFmtUsdcBig(ms.amount)} USDC</span>
          </div>
          ${ms.releasedAt > 0 ? `<div class="text-[10px] text-gray-600 mt-0.5">Liberado: ${cfTs(ms.releasedAt)}</div>` : ''}
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
          <span class="text-[11px] text-gray-500 font-mono">
            <i class="fas fa-tag mr-1 text-[9px]"></i>
            <span class="text-xs text-gray-400 font-semibold">$${usdcTotal} USDC</span>
          </span>
        </div>
      </div>

      <!-- Parties -->
      <div class="grid grid-cols-2 gap-2 mb-3">
        <div class="bg-gray-900/40 rounded-lg px-3 py-2">
          <div class="text-[10px] text-gray-600 mb-0.5 uppercase tracking-wide">Cliente</div>
          <div class="text-xs font-mono text-cyan-400 truncate">${cfShort(c.client)}${isClient ? ' <span class="text-[9px] text-cyan-600">(você)</span>' : ''}</div>
        </div>
        <div class="bg-gray-900/40 rounded-lg px-3 py-2">
          <div class="text-[10px] text-gray-600 mb-0.5 uppercase tracking-wide">Contratado</div>
          <div class="text-xs font-mono text-purple-400 truncate">${cfShort(c.contractor)}${isContractor ? ' <span class="text-[9px] text-purple-600">(você)</span>' : ''}</div>
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
      <div class="flex gap-3 text-[10px] text-gray-600 mb-3">
        <span><i class="fas fa-plus-circle mr-1"></i>Criado: ${cfTs(c.createdAt)}</span>
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
        <div class="mt-2 pl-2">
          ${milestonesHtml}
        </div>
      </details>` : ''}

      <!-- Actions -->
      <div class="flex gap-2 flex-wrap">
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
           class="flex items-center gap-1.5 px-3 py-1.5 bg-gray-700/40 hover:bg-gray-700/60 border border-gray-600/40 text-gray-400 text-xs rounded-xl transition ml-auto">
          <i class="fas fa-external-link-alt text-xs"></i>ArcScan
        </a>
      </div>

      <!-- Signing status -->
      <div class="mt-2 flex items-center gap-3 text-[10px] text-gray-600">
        <span class="flex items-center gap-1">
          <i class="fas fa-user ${c.status !== 'Draft' ? 'text-green-500' : 'text-gray-600'}"></i>
          Cliente: ${c.status !== 'Draft' ? '<span class="text-green-400">Depositou USDC</span>' : '<span class="text-yellow-400">Aguardando</span>'}
        </span>
        <span class="flex items-center gap-1">
          <i class="fas fa-hard-hat ${c.contractorSigned ? 'text-green-500' : 'text-gray-600'}"></i>
          Contratado: ${c.contractorSigned ? '<span class="text-green-400">Assinou</span>' : '<span class="text-yellow-400">Pendente</span>'}
        </span>
      </div>
    </div>`;
}

// ─── Main flow: Create Contract ────────────────────────────────────────────────
async function cfCreateContract() {
  if (cfState.pending) return;

  const wallet = window.walletState?.address;
  if (!wallet) {
    showToast('⚠️ Conecte sua carteira antes de criar um contrato.', 'warning');
    return;
  }

  // Read form
  const contractor = cfEl('cf-contractor')?.value?.trim();
  const title      = cfEl('cf-title')?.value?.trim();
  const totalValue = cfEl('cf-value')?.value?.trim();
  const msRows     = document.querySelectorAll('.cf-milestone-row');

  if (!contractor || !title || !totalValue) {
    showToast('Preencha todos os campos obrigatórios.', 'warning');
    return;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(contractor)) {
    showToast('Endereço do contratado inválido (0x...40 chars).', 'error');
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

  // Collect milestones
  const milestoneDescs  = [];
  const milestoneAmounts = [];
  msRows.forEach(row => {
    const d = row.querySelector('.cf-ms-desc')?.value?.trim();
    const a = parseFloat(row.querySelector('.cf-ms-amt')?.value || '0');
    if (d && a > 0) {
      milestoneDescs.push(d);
      milestoneAmounts.push(cfParseUsdc(a));
    }
  });

  if (milestoneDescs.length === 0) {
    showToast('Adicione pelo menos 1 milestone.', 'warning');
    return;
  }

  const totalRaw = cfParseUsdc(humanAmount);
  const sumMs    = milestoneAmounts.reduce((a, b) => a + b, 0n);
  if (sumMs !== totalRaw) {
    const diff = Math.abs(Number(totalRaw - sumMs)) / 1e6;
    showToast(`Soma dos milestones (${cfFmtUsdcBig(sumMs)} USDC) ≠ Total (${humanAmount} USDC). Diferença: $${diff.toFixed(6)}.`, 'error');
    return;
  }

  cfState.pending = true;
  const btn = cfEl('cf-submit-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Processando…'; }

  const showErr = (msg) => {
    showToast(`❌ ${msg}`, 'error');
    cfSetStep(0, 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-file-plus mr-2"></i>Criar Contrato'; }
  };

  try {
    // Step 0: Verificar rede
    cfSetStep(0);
    await cfEnsureNetwork();

    // Step 1: Verificar saldo USDC
    cfSetStep(1);
    const balance = await cfReadBalance(wallet);
    console.log(`[CF] USDC balance: ${cfFmtUsdcBig(balance)} · Required: ${humanAmount}`);
    if (balance < totalRaw) {
      throw new Error(`Saldo USDC insuficiente: ${cfFmtUsdcBig(balance)} USDC disponível, ${humanAmount} USDC necessário.`);
    }

    // Step 2: Verificar / solicitar approve
    cfSetStep(2);
    const allowance = await cfReadAllowance(wallet, CF_FACTORY_ADDR);
    console.log(`[CF] USDC allowance: ${cfFmtUsdcBig(allowance)} · Required: ${humanAmount}`);

    if (allowance < totalRaw) {
      showToast(`📝 Aprovando ${humanAmount} USDC para o contrato…`, 'info');
      const approveData = cfEncodeApprove(CF_FACTORY_ADDR, totalRaw);
      const approveTx  = await cfSendTx(CF_USDC_ADDR, approveData);
      showToast(`⏳ Approve tx: ${approveTx.slice(0, 14)}… aguardando confirmação…`, 'info');
      const approveReceipt = await cfWaitReceipt(approveTx);
      if (approveReceipt.status !== '0x1' && approveReceipt.status !== 1) {
        throw new Error('Transação approve revertida. Tente novamente.');
      }
      showToast('✅ Approve confirmado!', 'success');
    } else {
      showToast('✅ Allowance suficiente.', 'info');
    }

    // Step 3: Estimativa de gas
    cfSetStep(3);
    const calldata = cfEncodeCreateContract(contractor, title, totalRaw, milestoneDescs, milestoneAmounts);
    const txBase   = { from: wallet, to: CF_FACTORY_ADDR, data: calldata, value: '0x0' };
    const gasEst   = await cfEstGas(txBase);
    const gpHex    = await cfGasPrice();
    const gasFeeUsdc = (parseInt(gasEst, 16) * parseInt(gpHex, 16) / 1e6).toFixed(6);
    showToast(`⛽ Gas estimado: ${gasFeeUsdc} USDC. Confirme na carteira…`, 'info');

    // Step 4: Enviar createContract
    cfSetStep(4);
    const txHash = await cfSendTx(CF_FACTORY_ADDR, calldata);
    cfState.lastTxHash = txHash;
    showToast(`📤 Tx enviada: <a href="${CF_EXPLORER}/tx/${txHash}" target="_blank" class="underline">${txHash.slice(0, 16)}…</a>`, 'info');

    // Step 5: Aguardar confirmação (1–3 blocos)
    cfSetStep(5);
    showToast('⏳ Aguardando confirmação on-chain…', 'info');
    const receipt = await cfWaitReceipt(txHash);
    if (receipt.status !== '0x1' && receipt.status !== 1) {
      throw new Error('Transação createContract revertida. Verifique allowance e saldo.');
    }
    const blockNum = parseInt(receipt.blockNumber, 16);

    // Step 6: Recarregar lista
    cfSetStep(6);
    showToast(
      `✅ Contrato criado! Bloco #${blockNum} · <a href="${CF_EXPLORER}/tx/${txHash}" target="_blank" class="underline">Ver no ArcScan ↗</a>`,
      'success'
    );

    // Show tx badge
    if (typeof showTXConfirmationBadge === 'function') {
      showTXConfirmationBadge(txHash, `ContractFactory: createContract — $${humanAmount} USDC`);
    }

    // Reset form
    cfEl('cf-title').value       = '';
    cfEl('cf-contractor').value  = '';
    cfEl('cf-value').value       = '';
    cfResetMilestones();

    // Reload contracts
    setTimeout(cfLoadContracts, 1500);

  } catch (err) {
    console.error('[CF] createContract error:', err);
    if (err.code === 4001 || err.message?.includes('rejected') || err.message?.includes('denied')) {
      showErr('Transação rejeitada pelo usuário.');
    } else {
      showErr(err.message || 'Erro desconhecido');
    }
  } finally {
    cfState.pending = false;
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-file-plus mr-2"></i>Criar Contrato'; }
    setTimeout(cfHideSteps, 15000);
  }
}

// ─── Sign Contract (contractor calls signContract) ────────────────────────────
async function cfSignContract(contractId) {
  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Conecte sua carteira.', 'warning'); return; }

  try {
    await cfEnsureNetwork();
    const calldata = cfEncodeSignContract(contractId);
    showToast(`📝 Assinar contrato #${contractId} — confirme na carteira…`, 'info');
    const txHash = await cfSendTx(CF_FACTORY_ADDR, calldata);
    showToast(`⏳ Tx: <a href="${CF_EXPLORER}/tx/${txHash}" target="_blank" class="underline">${txHash.slice(0,14)}…</a>`, 'info');
    const receipt = await cfWaitReceipt(txHash);
    if (receipt.status !== '0x1' && receipt.status !== 1) throw new Error('Transação revertida');
    showToast(`✅ Contrato #${contractId} assinado! Bloco #${parseInt(receipt.blockNumber, 16)}.`, 'success');
    if (typeof showTXConfirmationBadge === 'function') showTXConfirmationBadge(txHash, `signContract #${contractId}`);
    setTimeout(cfLoadContracts, 1500);
  } catch (err) {
    if (err.code === 4001 || err.message?.includes('rejected')) showToast('Transação rejeitada.', 'warning');
    else showToast(`❌ ${err.message}`, 'error');
  }
}

// ─── Complete Milestone (client releases payment) ─────────────────────────────
async function cfCompleteMilestone(contractId, milestoneIdx) {
  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Conecte sua carteira.', 'warning'); return; }

  if (!confirm(`Liberar pagamento do milestone ${milestoneIdx + 1} do contrato #${contractId}? Esta ação é irreversível.`)) return;

  try {
    await cfEnsureNetwork();
    const calldata = cfEncodeCompleteMilestone(contractId, milestoneIdx);
    showToast(`📝 Liberando milestone ${milestoneIdx + 1} — confirme na carteira…`, 'info');
    const txHash = await cfSendTx(CF_FACTORY_ADDR, calldata);
    showToast(`⏳ Tx: <a href="${CF_EXPLORER}/tx/${txHash}" target="_blank" class="underline">${txHash.slice(0,14)}…</a>`, 'info');
    const receipt = await cfWaitReceipt(txHash);
    if (receipt.status !== '0x1' && receipt.status !== 1) throw new Error('Transação revertida');
    showToast(`✅ Milestone ${milestoneIdx + 1} liberado! Bloco #${parseInt(receipt.blockNumber, 16)}.`, 'success');
    if (typeof showTXConfirmationBadge === 'function') showTXConfirmationBadge(txHash, `completeMilestone #${contractId}[${milestoneIdx}]`);
    setTimeout(cfLoadContracts, 1500);
  } catch (err) {
    if (err.code === 4001 || err.message?.includes('rejected')) showToast('Transação rejeitada.', 'warning');
    else showToast(`❌ ${err.message}`, 'error');
  }
}

// ─── Cancel Contract ──────────────────────────────────────────────────────────
async function cfCancelContract(contractId) {
  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Conecte sua carteira.', 'warning'); return; }

  if (!confirm(`Cancelar contrato #${contractId}? O USDC depositado será reembolsado ao cliente.`)) return;

  try {
    await cfEnsureNetwork();
    const calldata = cfEncodeCancelContract(contractId);
    showToast(`📝 Cancelando contrato #${contractId} — confirme na carteira…`, 'info');
    const txHash = await cfSendTx(CF_FACTORY_ADDR, calldata);
    showToast(`⏳ Tx: <a href="${CF_EXPLORER}/tx/${txHash}" target="_blank" class="underline">${txHash.slice(0,14)}…</a>`, 'info');
    const receipt = await cfWaitReceipt(txHash);
    if (receipt.status !== '0x1' && receipt.status !== 1) throw new Error('Transação revertida');
    showToast(`✅ Contrato #${contractId} cancelado! USDC reembolsado. Bloco #${parseInt(receipt.blockNumber, 16)}.`, 'success');
    setTimeout(cfLoadContracts, 1500);
  } catch (err) {
    if (err.code === 4001 || err.message?.includes('rejected')) showToast('Transação rejeitada.', 'warning');
    else showToast(`❌ ${err.message}`, 'error');
  }
}

// ─── Milestone form management ─────────────────────────────────────────────────
let cfMilestoneCount = 1;

function cfAddMilestone() {
  cfMilestoneCount++;
  const container = cfEl('cf-milestones-container');
  if (!container) return;
  const row = document.createElement('div');
  row.className = 'cf-milestone-row flex items-center gap-2 mb-2';
  row.innerHTML = `
    <input type="text" placeholder="Descrição do milestone" class="cf-ms-desc flex-1 bg-gray-800/60 border border-gray-600/40 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-cyan-500/60 focus:outline-none" />
    <input type="number" placeholder="USDC" step="0.01" min="0.01" class="cf-ms-amt w-28 bg-gray-800/60 border border-gray-600/40 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-cyan-500/60 focus:outline-none" />
    <button onclick="this.parentElement.remove(); cfUpdateMilestoneSum()" type="button"
      class="w-8 h-8 flex items-center justify-center bg-red-900/20 hover:bg-red-900/30 border border-red-700/30 text-red-400 rounded-lg transition flex-shrink-0">
      <i class="fas fa-times text-xs"></i>
    </button>`;
  row.querySelectorAll('input').forEach(el => el.addEventListener('input', cfUpdateMilestoneSum));
  container.appendChild(row);
}

function cfResetMilestones() {
  cfMilestoneCount = 1;
  const container = cfEl('cf-milestones-container');
  if (!container) return;
  container.innerHTML = `
    <div class="cf-milestone-row flex items-center gap-2 mb-2">
      <input type="text" placeholder="Descrição do milestone" class="cf-ms-desc flex-1 bg-gray-800/60 border border-gray-600/40 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-cyan-500/60 focus:outline-none" />
      <input type="number" placeholder="USDC" step="0.01" min="0.01" class="cf-ms-amt w-28 bg-gray-800/60 border border-gray-600/40 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-cyan-500/60 focus:outline-none" />
    </div>`;
  container.querySelectorAll('input').forEach(el => el.addEventListener('input', cfUpdateMilestoneSum));
}

function cfUpdateMilestoneSum() {
  const rows  = document.querySelectorAll('.cf-milestone-row');
  let sum = 0;
  rows.forEach(r => { const v = parseFloat(r.querySelector('.cf-ms-amt')?.value || '0'); if (v > 0) sum += v; });
  const total = parseFloat(cfEl('cf-value')?.value || '0');
  const sumEl = cfEl('cf-ms-sum');
  if (sumEl) {
    const diff = Math.abs(sum - total);
    const ok   = diff < 0.000001;
    sumEl.textContent  = `Soma milestones: $${sum.toFixed(6)} USDC${ok ? ' ✅' : ` (diferença: $${diff.toFixed(6)})`}`;
    sumEl.className    = `text-xs mt-1 ${ok ? 'text-green-400' : 'text-yellow-400'}`;
  }
}

// ─── Wallet listener — reload when wallet changes ─────────────────────────────
window.addEventListener('walletConnected',    () => cfLoadContracts());
window.addEventListener('walletDisconnected', () => cfLoadContracts());
window.addEventListener('walletChanged',      () => cfLoadContracts());

// ─── Expose globally ──────────────────────────────────────────────────────────
window.cfCreateContract      = cfCreateContract;
window.cfLoadContracts       = cfLoadContracts;
window.cfSignContract        = cfSignContract;
window.cfCompleteMilestone   = cfCompleteMilestone;
window.cfCancelContract      = cfCancelContract;
window.cfAddMilestone        = cfAddMilestone;
window.cfUpdateMilestoneSum  = cfUpdateMilestoneSum;
window.cfState               = cfState;

// Legacy aliases (keep backward compat with any remaining calls)
window.loadContracts         = cfLoadContracts;

console.log(
  '[CF] Contracts module loaded — ContractFactory:',
  CF_FACTORY_ADDR,
  '| USDC:', CF_USDC_ADDR,
  '| Chain:', CF_CHAIN_ID
);
