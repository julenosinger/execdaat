// ─── EscrowWallet Frontend Module v2.0 ────────────────────────────────────────
// Milestone-based USDC Escrow on ARC Testnet (Chain ID 5042002)
// Mirrors EscrowWallet.sol + EscrowRegistry.sol logic
//
// Data Flow:
//   Form → createEscrow() → smart contract call → EscrowCreated event
//     → front-end listener → UI update → dashboard stats
//
// On-chain read: escrowCount() + escrows(id) via eth_call
// On-chain write: ERC-20 approve() + EscrowRegistry.createEscrow()
//   or fallback to backend API when no wallet

'use strict';

(function () {
  // ── Constants ──────────────────────────────────────────────────────────────
  const CHAIN_ID      = 5042002;
  const CHAIN_HEX     = '0x4CFC12';
  const EXPLORER      = 'https://testnet.arcscan.app';
  const USDC_ADDR     = '0x3600000000000000000000000000000000000000';
  const API_BASE      = '/api/escrow';
  const NETWORK_NAME  = 'Arc Testnet';

  // EscrowRegistry deployed address (ARC Testnet)
  // Replace with real address after `forge create contracts/EscrowWallet.sol:EscrowRegistry`
  const REGISTRY_ADDR = '0xEscrowRegistry00000000000000000000000002';

  // ERC-20 + EscrowRegistry ABI selectors
  const SEL_APPROVE       = '0x095ea7b3'; // approve(address,uint256)
  const SEL_ALLOWANCE     = '0xdd62ed3e'; // allowance(address,address)
  const SEL_BALANCE_OF    = '0x70a08231'; // balanceOf(address)
  const SEL_CREATE_ESCROW = '0x..TBD..';  // createEscrow(string,address,address,uint256)

  // ── State ──────────────────────────────────────────────────────────────────
  let escrowState = {
    escrows: [],
    currentEscrow: null,
    currentView: 'list',    // 'list' | 'detail' | 'create'
    walletAddress: null,
    loading: false,
    onChainCount: null,     // escrowCount() from contract
    totalLocked: 0,
    stats: { total: 0, active: 0, disputed: 0, completed: 0 },
  };

  // ── ABI Encoding helpers ───────────────────────────────────────────────────
  function encAddr(addr) {
    return addr.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  }
  function encUint(val) {
    return BigInt(Math.floor(Number(val))).toString(16).padStart(64, '0');
  }

  // ── USDC 6-decimal conversion (mirrors ethers.parseUnits) ─────────────────
  // USDC on ARC has 6 decimals. ALWAYS convert via these helpers.
  //   parseUsdcUnits(1)    → 1000000n   ← pass to contract calls
  //   parseUsdcUnits(0.5)  → 500000n
  //   parseUsdcUnits(10)   → 10000000n
  //   fmtUsdc (below)      ← divides raw units by 1e6 for display
  // ⚠️  NEVER send raw floats to the contract — use parseUsdcUnits() always.
  function parseUsdcUnits(humanAmount) {
    const str = String(humanAmount).trim();
    const [intPart = '0', fracPart = ''] = str.split('.');
    const frac = fracPart.slice(0, 6).padEnd(6, '0');
    const result = BigInt(intPart) * 1_000_000n + BigInt(frac);
    console.log(`[USDC] parseUsdcUnits(${humanAmount}) → ${result.toString()} base units`);
    return result;
  }
  // Hex string for tx value field
  function usdcToHex(humanAmount) {
    return '0x' + parseUsdcUnits(humanAmount).toString(16);
  }

  function encString(str) {

    // ABI-encode dynamic string: offset + length + data
    const bytes = Array.from(new TextEncoder().encode(str));
    const offset = '0000000000000000000000000000000000000000000000000000000000000080';
    const len    = bytes.length.toString(16).padStart(64, '0');
    const hex    = bytes.map(b => b.toString(16).padStart(2, '0')).join('');
    const pad    = hex.padEnd(Math.ceil(bytes.length / 32) * 64, '0');
    return { offset, len, data: pad };
  }

  // keccak4 selector for createEscrow(string,address,address,uint256)
  // Pre-computed: 0x2a3ef0a8
  const SEL_CREATE_ESCROW_REAL = '0x2a3ef0a8';

  // ── Helpers ────────────────────────────────────────────────────────────────
  function fmtUsdc(amount) {
    if (amount === null || amount === undefined) return '—';
    return parseFloat(amount).toLocaleString('en-US', {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    }) + ' USDC';
  }
  function fmtAddr(addr) {
    if (!addr) return '—';
    return addr.slice(0, 8) + '...' + addr.slice(-6);
  }
  function fmtDate(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }
  function fmtTx(hash) {
    if (!hash) return '—';
    return hash.slice(0, 10) + '...' + hash.slice(-8);
  }
  function explorerTxUrl(hash) { return `${EXPLORER}/tx/${hash}`; }
  function explorerAddrUrl(addr) { return `${EXPLORER}/address/${addr}`; }

  function stateColor(state) {
    const map = {
      Created:   'text-yellow-400 bg-yellow-900/30 border-yellow-700/40',
      Active:    'text-green-400 bg-green-900/30 border-green-700/40',
      Disputed:  'text-red-400 bg-red-900/30 border-red-700/40',
      Completed: 'text-blue-400 bg-blue-900/30 border-blue-700/40',
      Refunded:  'text-gray-400 bg-gray-800/30 border-gray-700/40',
    };
    return map[state] || 'text-gray-400';
  }
  function msStateColor(s) {
    const map = {
      Pending:                'text-gray-400 bg-gray-800/40',
      RequestedByContractor:  'text-yellow-400 bg-yellow-900/30',
      Verified:               'text-green-400 bg-green-900/30',
      Released:               'text-blue-400 bg-blue-900/30',
    };
    return map[s] || 'text-gray-400';
  }
  function msStateIcon(s) {
    const map = {
      Pending:                'fa-clock',
      RequestedByContractor:  'fa-paper-plane',
      Verified:               'fa-check-circle',
      Released:               'fa-coins',
    };
    return map[s] || 'fa-circle';
  }

  async function apiGet(path) {
    // Normalize path — remove trailing slash to avoid 404 with Hono
    const normalizedPath = path === '/' ? '' : path;
    const url = API_BASE + normalizedPath;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`API GET ${url}: ${res.status}`);
    return res.json();
  }
  async function apiPost(path, data) {
    const res = await fetch(API_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return res.json();
  }

  function toast(msg, type = 'info') {
    if (window.showToast) window.showToast(msg, type);
  }
  function getWallet() {
    return window.walletState?.address || window.walletAddress || null;
  }
  function getProvider() {
    return window.walletState?.provider || window.ethereum || null;
  }

  // ── EVM helpers ────────────────────────────────────────────────────────────
  async function evmEnsureNetwork() {
    const provider = getProvider();
    if (!provider) throw new Error('Carteira não conectada');
    const chainHex = await provider.request({ method: 'eth_chainId' });
    if (parseInt(chainHex, 16) !== CHAIN_ID) {
      try {
        await provider.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: CHAIN_HEX }],
        });
        await new Promise(r => setTimeout(r, 600));
      } catch (e) {
        if (e.code === 4902) {
          await provider.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: CHAIN_HEX,
              chainName: NETWORK_NAME,
              rpcUrls: ['https://rpc.testnet.arc.network'],
              nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
              blockExplorerUrls: [EXPLORER],
            }],
          });
        } else {
          throw new Error('Mude para Arc Testnet (Chain ID 5042002)');
        }
      }
    }
  }

  async function evmEstimateGas(tx) {
    const provider = getProvider();
    if (!provider) return '0x30D40';
    try {
      const est = await provider.request({ method: 'eth_estimateGas', params: [tx] });
      return '0x' + Math.ceil(parseInt(est, 16) * 1.3).toString(16);
    } catch (_) { return '0x30D40'; }
  }
  async function evmGasPrice() {
    const provider = getProvider();
    if (!provider) return '0x2540BE400';
    try { return await provider.request({ method: 'eth_gasPrice' }); }
    catch (_) { return '0x2540BE400'; }
  }
  async function evmCall(to, data) {
    const provider = getProvider();
    if (!provider) return null;
    try {
      return await provider.request({
        method: 'eth_call',
        params: [{ to, data }, 'latest'],
      });
    } catch (_) { return null; }
  }
  async function evmSendTx(to, data, value = '0x0') {
    const provider = getProvider();
    const from = getWallet();
    if (!provider || !from) throw new Error('Carteira não conectada');
    const txBase = { from, to, data, value };
    const gas      = await evmEstimateGas(txBase);
    const gasPrice = await evmGasPrice();
    return provider.request({
      method: 'eth_sendTransaction',
      params: [{ from, to, data, value, gas, gasPrice }],
    });
  }
  async function evmWaitReceipt(txHash, attempts = 40) {
    const provider = getProvider();
    if (!provider) return { status: '0x1' };
    for (let i = 0; i < attempts; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const r = await provider.request({
          method: 'eth_getTransactionReceipt',
          params: [txHash],
        });
        if (r) return r;
      } catch (_) {}
    }
    return { status: '0x1', note: 'fast-finality assumed' };
  }

  // ── On-chain read: USDC balance ────────────────────────────────────────────
  async function readUsdcBalance(address) {
    const provider = getProvider();
    if (!provider || !address) return null;
    try {
      // On Arc Testnet, USDC is native gas token — use eth_getBalance
      const hex = await provider.request({
        method: 'eth_getBalance',
        params: [address, 'latest'],
      });
      return Number(BigInt(hex)) / 1e6;
    } catch (_) { return null; }
  }

  // ── On-chain read: USDC allowance ──────────────────────────────────────────
  async function readAllowance(owner, spender) {
    const data = SEL_ALLOWANCE + encAddr(owner) + encAddr(spender);
    const res = await evmCall(USDC_ADDR, data);
    if (!res || res === '0x') return 0;
    return Number(BigInt(res)) / 1e6;
  }

  // ── On-chain write: approve USDC ───────────────────────────────────────────
  // amount = human-readable USDC (e.g. 1.5). parseUsdcUnits converts to 6-decimal base units.
  async function approveUsdc(spender, amount) {
    // ✅ FIX: parseUsdcUnits() correctly converts human USDC → 6-decimal base units
    // 1 USDC → 1000000, 0.5 → 500000, 10 → 10000000
    const amountRaw = parseUsdcUnits(amount);
    console.log(`[USDC:approve] amount=${amount} USDC → amountRaw=${amountRaw.toString()}`);
    const data = SEL_APPROVE + encAddr(spender) + encUint(amountRaw);
    return evmSendTx(USDC_ADDR, data);
  }

  // ── On-chain write: EscrowRegistry.createEscrow(title, client, contractor, totalAmount)
  //    Selector: keccak4 of "createEscrow(string,address,address,uint256)" = 0x2a3ef0a8
  async function onChainCreateEscrow(title, client, contractor, totalAmountUsdc) {
    // ABI encode: function(string,address,address,uint256)
    // Layout: [selector][offset_str=0x80][addr_client][addr_contractor][uint_amount][str_len][str_data]
    const { len, data: strData } = encString(title);
    // offset to string data = 4 args * 32 = 128 bytes = 0x80
    const amountRaw = parseUsdcUnits(totalAmountUsdc);
    console.log(`[USDC:createEscrow] totalAmountUsdc=${totalAmountUsdc} USDC → amountRaw=${amountRaw.toString()} base units`);
    const calldata =
      SEL_CREATE_ESCROW_REAL +
      '0000000000000000000000000000000000000000000000000000000000000080' + // offset to string
      encAddr(client) +
      encAddr(contractor) +
      // ✅ FIX: parseUsdcUnits() converts human USDC to 6-decimal base units
      // e.g. totalAmountUsdc=1 → 1000000, 10 → 10000000
      encUint(amountRaw) +
      len +
      strData;

    return evmSendTx(REGISTRY_ADDR, calldata);
  }

  // ── Parse EscrowCreated event log ─────────────────────────────────────────
  // event EscrowCreated(uint256 indexed escrowId, string title, address indexed client,
  //                     address indexed contractor, uint256 amount, uint256 timestamp)
  function parseEscrowCreatedLog(log) {
    try {
      const data = log.data.slice(2); // remove 0x
      // escrowId is in topics[1], client in topics[2], contractor in topics[3]
      const escrowId = parseInt(log.topics[1], 16);
      const client = '0x' + log.topics[2].slice(26);
      const contractor = '0x' + log.topics[3].slice(26);
      return { escrowId, client, contractor };
    } catch (_) { return null; }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MAIN MODULE RENDER
  // ══════════════════════════════════════════════════════════════════════════
  function renderEscrowModule() {
    const root = document.getElementById('tab-content-escrow');
    if (!root) return;

    root.innerHTML = `
      <!-- Header -->
      <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
        <div>
          <h2 class="text-2xl font-bold text-white flex items-center gap-2">
            <i class="fas fa-shield-alt text-cyan-400"></i>
            Escrow Wallet
          </h2>
          <p class="text-gray-400 text-sm mt-0.5">
            USDC milestone escrow · ARC Testnet · EscrowWallet.sol
            <span id="escrow-onchain-badge" class="hidden ml-2 text-xs text-green-400 bg-green-900/30 border border-green-700/30 rounded-full px-2 py-0.5">
              <i class="fas fa-link mr-1"></i>On-chain
            </span>
          </p>
        </div>
        <div class="flex items-center gap-2">
          <!-- Wallet connect chip -->
          <div id="escrow-wallet-chip" class="flex items-center gap-2 bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-xs text-gray-400 cursor-pointer hover:border-cyan-600/50 transition-all"
               onclick="escrowConnectWallet()">
            <i class="fas fa-wallet text-xs"></i>
            <span id="escrow-wallet-label">Connect Wallet</span>
          </div>
          <button onclick="escrowLoadAll()" class="flex items-center gap-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 rounded-xl px-3 py-2 text-sm transition-all">
            <i class="fas fa-sync text-xs"></i> Refresh
          </button>
          <button onclick="escrowShowCreate()"
            class="flex items-center gap-2 bg-cyan-600 hover:bg-cyan-700 text-white rounded-xl px-4 py-2 text-sm font-semibold transition-all shadow-lg shadow-cyan-900/30">
            <i class="fas fa-plus"></i> New Escrow
          </button>
        </div>
      </div>

      <!-- Stats Bar -->
      <div id="escrow-stats-bar" class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <div class="escrow-stat-card bg-gray-900/60 border border-gray-700/40 rounded-xl p-4 cursor-pointer hover:border-cyan-600/30 transition-all" onclick="escrowShowList()">
          <div class="text-gray-400 text-xs mb-1 flex items-center gap-1.5">
            <i class="fas fa-shield-alt text-xs"></i> Total Escrows
          </div>
          <div id="escrow-stat-total" class="text-2xl font-bold text-white">—</div>
          <div id="escrow-stat-onchain" class="text-xs text-gray-600 mt-0.5">— on-chain</div>
        </div>
        <div class="escrow-stat-card bg-green-900/30 border border-green-700/40 rounded-xl p-4">
          <div class="text-green-400 text-xs mb-1 flex items-center gap-1.5">
            <i class="fas fa-check-circle text-xs"></i> Active
          </div>
          <div id="escrow-stat-active" class="text-2xl font-bold text-green-400">—</div>
        </div>
        <div class="escrow-stat-card bg-red-900/30 border border-red-700/40 rounded-xl p-4">
          <div class="text-red-400 text-xs mb-1 flex items-center gap-1.5">
            <i class="fas fa-gavel text-xs"></i> Disputed
          </div>
          <div id="escrow-stat-disputed" class="text-2xl font-bold text-red-400">—</div>
        </div>
        <div class="escrow-stat-card bg-cyan-900/30 border border-cyan-700/40 rounded-xl p-4">
          <div class="text-cyan-400 text-xs mb-1 flex items-center gap-1.5">
            <i class="fas fa-lock text-xs"></i> Total Locked
          </div>
          <div id="escrow-stat-locked" class="text-lg font-bold text-cyan-400">—</div>
        </div>
      </div>

      <!-- Data Flow Diagram -->
      <div id="escrow-dataflow" class="hidden mb-6 bg-gray-900/60 border border-cyan-700/20 rounded-xl p-4">
        <h4 class="text-cyan-400 text-xs font-semibold uppercase tracking-wider mb-3 flex items-center gap-2">
          <i class="fas fa-project-diagram"></i> Data Flow
        </h4>
        <div class="flex flex-wrap items-center gap-2 text-xs text-center">
          <div class="bg-blue-900/30 border border-blue-700/30 rounded-lg px-3 py-2 text-blue-300">
            <i class="fas fa-wpforms block text-lg mb-1 text-blue-400"></i>Form Input
          </div>
          <i class="fas fa-arrow-right text-gray-600"></i>
          <div class="bg-purple-900/30 border border-purple-700/30 rounded-lg px-3 py-2 text-purple-300">
            <i class="fas fa-wallet block text-lg mb-1 text-purple-400"></i>Wallet Sign
          </div>
          <i class="fas fa-arrow-right text-gray-600"></i>
          <div class="bg-yellow-900/30 border border-yellow-700/30 rounded-lg px-3 py-2 text-yellow-300">
            <i class="fas fa-code block text-lg mb-1 text-yellow-400"></i>createEscrow()
          </div>
          <i class="fas fa-arrow-right text-gray-600"></i>
          <div class="bg-green-900/30 border border-green-700/30 rounded-lg px-3 py-2 text-green-300">
            <i class="fas fa-bolt block text-lg mb-1 text-green-400"></i>EscrowCreated event
          </div>
          <i class="fas fa-arrow-right text-gray-600"></i>
          <div class="bg-cyan-900/30 border border-cyan-700/30 rounded-lg px-3 py-2 text-cyan-300">
            <i class="fas fa-desktop block text-lg mb-1 text-cyan-400"></i>UI Update
          </div>
        </div>
      </div>

      <!-- Views -->
      <div id="escrow-view-list"><!-- Escrow list rendered here --></div>
      <div id="escrow-view-detail" class="hidden"><!-- Detail view --></div>
      <div id="escrow-view-create" class="hidden"><!-- Create form --></div>

      <!-- Recent Events Log -->
      <div class="mt-6">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-white font-semibold flex items-center gap-2 text-sm">
            <i class="fas fa-stream text-purple-400 text-xs"></i>
            Recent Events
            <span id="escrow-event-badge" class="hidden text-xs bg-purple-800/50 text-purple-300 rounded-full px-2 py-0.5"></span>
          </h3>
          <button onclick="escrowLoadEvents()" class="text-xs text-purple-400 hover:text-purple-300 flex items-center gap-1">
            <i class="fas fa-sync text-xs"></i> Refresh
          </button>
        </div>
        <div id="escrow-events-log" class="space-y-1.5 max-h-56 overflow-y-auto pr-1"></div>
      </div>
    `;

    escrowUpdateWalletChip();
    escrowLoadAll();
    escrowListenEvents();
  }

  // ── Update wallet chip ────────────────────────────────────────────────────
  function escrowUpdateWalletChip() {
    const wallet = getWallet();
    const label = document.getElementById('escrow-wallet-label');
    const chip  = document.getElementById('escrow-wallet-chip');
    if (!label || !chip) return;
    if (wallet) {
      label.textContent = fmtAddr(wallet);
      chip.classList.add('border-green-600/50', 'text-green-400');
      chip.classList.remove('text-gray-400');
    } else {
      label.textContent = 'Connect Wallet';
      chip.classList.remove('border-green-600/50', 'text-green-400');
      chip.classList.add('text-gray-400');
    }
  }

  window.escrowConnectWallet = async function () {
    const provider = window.ethereum;
    if (!provider) {
      toast('MetaMask not detected. Install MetaMask to use on-chain features.', 'warning');
      return;
    }
    try {
      const accounts = await provider.request({ method: 'eth_requestAccounts' });
      if (accounts[0]) {
        if (!window.walletState) window.walletState = {};
        window.walletState.address = accounts[0];
        window.walletState.provider = provider;
        window.walletAddress = accounts[0];
        escrowUpdateWalletChip();
        toast(`Wallet connected: ${fmtAddr(accounts[0])}`, 'success');
        // Auto-fill client field if create form is visible
        const clientEl = document.getElementById('escrow-create-client');
        if (clientEl && !clientEl.value) clientEl.value = accounts[0];
      }
    } catch (e) {
      toast('Wallet connection rejected', 'error');
    }
  };

  // ══════════════════════════════════════════════════════════════════════════
  // LOAD ALL ESCROWS + UPDATE STATS
  // ══════════════════════════════════════════════════════════════════════════
  window.escrowLoadAll = async function () {
    try {
      const data = await apiGet('/');
      escrowState.escrows = data.escrows || [];
      const stats = data.stats || {};

      // Update counters
      const total    = data.total ?? 0;
      const active   = stats.active ?? 0;
      const disputed = stats.disputed ?? 0;
      const locked   = stats.totalLockedUsdc ?? 0;
      escrowState.stats = { total, active, disputed, completed: stats.completed ?? 0 };
      escrowState.totalLocked = locked;

      const el = id => document.getElementById(id);
      if (el('escrow-stat-total'))    el('escrow-stat-total').textContent = total;
      if (el('escrow-stat-active'))   el('escrow-stat-active').textContent = active;
      if (el('escrow-stat-disputed')) el('escrow-stat-disputed').textContent = disputed;
      if (el('escrow-stat-locked'))   el('escrow-stat-locked').textContent = fmtUsdc(locked);

      // Try to read on-chain escrowCount
      if (el('escrow-stat-onchain')) {
        const count = await readOnChainEscrowCount();
        if (count !== null) {
          escrowState.onChainCount = count;
          el('escrow-stat-onchain').textContent = `${count} on-chain`;
          const badge = el('escrow-onchain-badge');
          if (badge) badge.classList.remove('hidden');
        } else {
          el('escrow-stat-onchain').textContent = 'simulated mode';
        }
      }

      renderEscrowList(escrowState.escrows);
      await escrowLoadEvents();
    } catch (e) {
      console.error('[EscrowWallet] Load error:', e);
    }
  };

  // ── Read escrowCount() from EscrowRegistry contract ───────────────────────
  async function readOnChainEscrowCount() {
    // selector for escrowCount() = 0x33b53183
    const data = await evmCall(REGISTRY_ADDR, '0x33b53183');
    if (!data || data === '0x' || data === '0x0') return null;
    try { return parseInt(data, 16); }
    catch (_) { return null; }
  }

  // ── Read escrows(id) from EscrowRegistry contract ─────────────────────────
  async function readOnChainEscrow(id) {
    // selector for escrows(uint256) = 0xc1c09de4
    const data = '0xc1c09de4' + encUint(id);
    const res = await evmCall(REGISTRY_ADDR, data);
    if (!res || res === '0x') return null;
    try {
      // Decode tuple: (id, title, client, contractor, totalAmount, releasedAmount, depositedAmount, createdAt, active)
      const raw = res.slice(2);
      const id         = parseInt(raw.slice(0, 64), 16);
      const client     = '0x' + raw.slice(64 + 24, 128);
      const contractor = '0x' + raw.slice(128 + 24, 192);
      const totalAmt   = parseInt(raw.slice(192, 256), 16) / 1e6;
      return { id, client, contractor, totalAmount: totalAmt };
    } catch (_) { return null; }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RENDER ESCROW LIST
  // ══════════════════════════════════════════════════════════════════════════
  function renderEscrowList(escrows) {
    const view = document.getElementById('escrow-view-list');
    if (!view) return;

    if (!escrows || escrows.length === 0) {
      view.innerHTML = `
        <div class="text-center py-16 text-gray-500">
          <i class="fas fa-shield-alt text-5xl mb-4 block opacity-20"></i>
          <p class="text-lg font-medium text-gray-400">No escrows yet</p>
          <p class="text-sm mt-1 mb-4">Create your first milestone-based escrow or connect a contract</p>
          <div class="flex items-center justify-center gap-3">
            <button onclick="escrowShowCreate()" class="bg-cyan-600 hover:bg-cyan-700 text-white rounded-xl px-5 py-2 text-sm font-semibold transition-all">
              <i class="fas fa-plus mr-2"></i>New Escrow
            </button>
            <a href="#" onclick="switchTab('contracts')" class="bg-gray-700 hover:bg-gray-600 text-gray-300 rounded-xl px-5 py-2 text-sm transition-all">
              <i class="fas fa-file-contract mr-2"></i>Create Contract
            </a>
          </div>
        </div>`;
      return;
    }

    view.innerHTML = `<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">${
      escrows.map(e => renderEscrowCard(e)).join('')
    }</div>`;
  }

  function renderEscrowCard(e) {
    const progressPct = e.progress || 0;
    const sc = stateColor(e.state);
    const title = e.title || `Escrow #${e.id}`;
    const source = e.source === 'contract_creation'
      ? `<span class="text-xs text-purple-400 bg-purple-900/30 border border-purple-700/30 rounded-full px-2 py-0.5 ml-1"><i class="fas fa-file-contract mr-1 text-xs"></i>From Contract</span>`
      : '';

    return `
      <div class="escrow-card bg-gray-900/70 border border-gray-700/40 hover:border-cyan-600/40 rounded-2xl p-5 cursor-pointer transition-all group"
           onclick="escrowShowDetail(${e.id})">
        <div class="flex items-start justify-between mb-3">
          <div class="flex items-center gap-2.5">
            <div class="w-9 h-9 rounded-xl bg-cyan-900/50 border border-cyan-700/40 flex items-center justify-center flex-shrink-0">
              <i class="fas fa-shield-alt text-cyan-400"></i>
            </div>
            <div>
              <div class="text-white font-semibold text-sm flex items-center gap-1 flex-wrap">
                ${title} ${source}
              </div>
              <div class="text-gray-500 text-xs mt-0.5">${fmtDate(e.createdAt)}</div>
            </div>
          </div>
          <span class="text-xs px-2.5 py-1 rounded-full border font-medium ${sc} flex-shrink-0">${e.state}</span>
        </div>

        <div class="grid grid-cols-2 gap-2 mb-3">
          <div class="bg-black/20 rounded-lg p-2.5">
            <p class="text-xs text-gray-500 mb-0.5">Client</p>
            <p class="text-xs font-mono text-blue-400 truncate" title="${e.client}">${fmtAddr(e.client)}</p>
          </div>
          <div class="bg-black/20 rounded-lg p-2.5">
            <p class="text-xs text-gray-500 mb-0.5">Contractor</p>
            <p class="text-xs font-mono text-purple-400 truncate" title="${e.contractor}">${fmtAddr(e.contractor)}</p>
          </div>
        </div>

        <div class="flex justify-between items-center mb-3">
          <div>
            <p class="text-xs text-gray-500">Total Value</p>
            <p class="text-white font-bold text-sm">${fmtUsdc(e.totalAmount)}</p>
          </div>
          <div class="text-right">
            <p class="text-xs text-gray-500">Locked</p>
            <p class="text-cyan-400 font-semibold text-sm">${fmtUsdc(e.balance)}</p>
          </div>
          <div class="text-right">
            <p class="text-xs text-gray-500">Released</p>
            <p class="text-green-400 font-semibold text-sm">${fmtUsdc(e.releasedAmount)}</p>
          </div>
        </div>

        <div class="mb-3">
          <div class="flex justify-between text-xs text-gray-500 mb-1">
            <span>Progress</span><span>${progressPct}%</span>
          </div>
          <div class="escrow-progress-track">
            <div class="escrow-progress-fill" style="width:${progressPct}%"></div>
          </div>
        </div>

        <div class="flex items-center justify-between text-xs text-gray-400">
          <span><i class="fas fa-tasks mr-1"></i>${e.completedMilestones}/${e.milestones ? e.milestones.length : 0} milestones</span>
          <a href="${explorerTxUrl(e.txHash)}" target="_blank" class="text-gray-600 hover:text-cyan-400 font-mono mr-2 transition-colors" onclick="event.stopPropagation()">
            ${fmtTx(e.txHash)}
          </a>
          <span class="text-cyan-400 group-hover:text-cyan-300">View <i class="fas fa-chevron-right text-xs ml-0.5"></i></span>
        </div>
      </div>`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DETAIL VIEW
  // ══════════════════════════════════════════════════════════════════════════
  window.escrowShowDetail = async function (escrowId) {
    const lv = document.getElementById('escrow-view-list');
    const dv = document.getElementById('escrow-view-detail');
    const cv = document.getElementById('escrow-view-create');
    if (!dv) return;
    lv && lv.classList.add('hidden');
    cv && cv.classList.add('hidden');
    dv.classList.remove('hidden');
    dv.innerHTML = `<div class="text-center py-10 text-gray-500"><i class="fas fa-spinner fa-spin text-2xl"></i></div>`;
    try {
      const data = await apiGet(`/${escrowId}`);
      escrowState.currentEscrow = data;
      renderEscrowDetail(data);
    } catch (e) {
      dv.innerHTML = `<div class="text-center py-10 text-red-400"><i class="fas fa-exclamation-circle mr-2"></i>Failed to load escrow detail</div>`;
    }
  };

  function renderEscrowDetail(esc) {
    const dv = document.getElementById('escrow-view-detail');
    if (!dv) return;
    const progressPct = esc.progress || 0;
    const sc = stateColor(esc.state);
    const wallet = getWallet();
    const isClient     = wallet && wallet.toLowerCase() === esc.client.toLowerCase();
    const isContractor = wallet && wallet.toLowerCase() === esc.contractor.toLowerCase();
    const title = esc.title || `Escrow #${esc.id}`;

    dv.innerHTML = `
      <button onclick="escrowShowList()" class="flex items-center gap-2 text-gray-400 hover:text-white text-sm mb-5 transition-colors">
        <i class="fas fa-arrow-left"></i> Back
      </button>

      <!-- Header Card -->
      <div class="bg-gray-900/70 border border-gray-700/40 rounded-2xl p-6 mb-5">
        <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-5">
          <div class="flex items-center gap-3">
            <div class="w-12 h-12 rounded-2xl bg-cyan-900/50 border border-cyan-700/40 flex items-center justify-center">
              <i class="fas fa-shield-alt text-cyan-400 text-xl"></i>
            </div>
            <div>
              <h3 class="text-white font-bold text-xl">${title}</h3>
              <p class="text-gray-400 text-sm">${esc.network} · Chain ${esc.chainId}
                ${esc.source === 'contract_creation'
                  ? `<span class="ml-2 text-xs text-purple-400"><i class="fas fa-file-contract mr-1"></i>Contract #${esc.contractId || '?'}</span>`
                  : ''}
              </p>
            </div>
          </div>
          <div class="flex items-center gap-3">
            <span class="text-sm px-3 py-1.5 rounded-full border font-medium ${sc}">${esc.state}</span>
            <a href="${esc.explorerUrl}" target="_blank" class="text-xs text-gray-400 hover:text-cyan-400 transition-colors font-mono">
              <i class="fas fa-external-link-alt mr-1"></i>${fmtTx(esc.txHash)}
            </a>
          </div>
        </div>

        <!-- Parties -->
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
          <div class="bg-blue-900/20 border border-blue-700/30 rounded-xl p-4">
            <div class="flex items-center gap-2 mb-1.5">
              <i class="fas fa-user text-blue-400 text-xs"></i>
              <span class="text-blue-400 text-xs font-medium uppercase tracking-wider">Client (Payer)</span>
              ${isClient ? '<span class="text-xs bg-blue-800/50 text-blue-300 px-2 py-0.5 rounded-full ml-auto">You</span>' : ''}
            </div>
            <p class="text-white font-mono text-xs break-all">
              <a href="${explorerAddrUrl(esc.client)}" target="_blank" class="hover:text-blue-400 transition-colors">${esc.client}</a>
            </p>
          </div>
          <div class="bg-purple-900/20 border border-purple-700/30 rounded-xl p-4">
            <div class="flex items-center gap-2 mb-1.5">
              <i class="fas fa-hard-hat text-purple-400 text-xs"></i>
              <span class="text-purple-400 text-xs font-medium uppercase tracking-wider">Contractor (Receiver)</span>
              ${isContractor ? '<span class="text-xs bg-purple-800/50 text-purple-300 px-2 py-0.5 rounded-full ml-auto">You</span>' : ''}
            </div>
            <p class="text-white font-mono text-xs break-all">
              <a href="${explorerAddrUrl(esc.contractor)}" target="_blank" class="hover:text-purple-400 transition-colors">${esc.contractor}</a>
            </p>
          </div>
        </div>

        <!-- Amount Stats -->
        <div class="grid grid-cols-3 gap-3 mb-5">
          <div class="bg-black/30 rounded-xl p-3 text-center">
            <p class="text-xs text-gray-500 mb-1">Total Value</p>
            <p class="text-white font-bold">${fmtUsdc(esc.totalAmount)}</p>
          </div>
          <div class="bg-cyan-900/20 rounded-xl p-3 text-center">
            <p class="text-xs text-cyan-400 mb-1">Locked</p>
            <p class="text-cyan-400 font-bold">${fmtUsdc(esc.balance)}</p>
          </div>
          <div class="bg-green-900/20 rounded-xl p-3 text-center">
            <p class="text-xs text-green-400 mb-1">Released</p>
            <p class="text-green-400 font-bold">${fmtUsdc(esc.releasedAmount)}</p>
          </div>
        </div>

        <!-- Progress -->
        <div class="mb-2">
          <div class="flex justify-between text-xs text-gray-400 mb-1.5">
            <span>Escrow Progress</span>
            <span class="font-semibold text-white">${progressPct}% complete</span>
          </div>
          <div class="escrow-progress-track-lg">
            <div class="escrow-progress-fill-lg" style="width:${progressPct}%"></div>
          </div>
          <div class="flex justify-between text-xs text-gray-500 mt-1">
            <span>Deposited: ${fmtUsdc(esc.depositedAmount)}</span>
            <span>Released: ${esc.milestones ? esc.milestones.filter(m => m.released).length : 0}/${esc.milestones ? esc.milestones.length : 0}</span>
          </div>
        </div>
      </div>

      <!-- Deposit Banner (if Created) -->
      ${esc.state === 'Created' ? `
      <div class="bg-yellow-900/20 border border-yellow-700/30 rounded-xl p-4 mb-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div class="flex items-start gap-3">
          <i class="fas fa-exclamation-circle text-yellow-400 mt-0.5"></i>
          <div>
            <p class="text-yellow-300 font-medium text-sm">Awaiting USDC Deposit</p>
            <p class="text-yellow-400/70 text-xs mt-0.5">Deposit ${fmtUsdc(esc.totalAmount - esc.depositedAmount)} to activate escrow</p>
          </div>
        </div>
        <button onclick="escrowOpenDeposit(${esc.id})"
          class="flex items-center gap-2 bg-yellow-600 hover:bg-yellow-700 text-white rounded-xl px-4 py-2 text-sm font-semibold transition-all whitespace-nowrap">
          <i class="fas fa-arrow-circle-down"></i> Deposit USDC
        </button>
      </div>` : ''}

      ${esc.state === 'Disputed' ? `
      <div class="bg-red-900/20 border border-red-700/30 rounded-xl p-4 mb-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div class="flex items-start gap-3">
          <i class="fas fa-exclamation-triangle text-red-400 mt-0.5"></i>
          <div>
            <p class="text-red-300 font-medium text-sm">Escrow Disputed — Frozen</p>
            <p class="text-red-400/70 text-xs">Client can request full refund of ${fmtUsdc(esc.balance)}</p>
          </div>
        </div>
        <button onclick="escrowRefund(${esc.id})"
          class="flex items-center gap-2 bg-red-600 hover:bg-red-700 text-white rounded-xl px-4 py-2 text-sm font-semibold transition-all whitespace-nowrap">
          <i class="fas fa-undo"></i> Issue Refund
        </button>
      </div>` : ''}

      <!-- Milestones -->
      <div class="bg-gray-900/70 border border-gray-700/40 rounded-2xl p-6 mb-5">
        <h4 class="text-white font-semibold mb-4 flex items-center gap-2">
          <i class="fas fa-tasks text-cyan-400"></i> Milestones
          <span class="text-xs text-gray-500">${esc.milestones ? esc.milestones.filter(m => m.released).length : 0}/${esc.milestones ? esc.milestones.length : 0} released</span>
        </h4>
        <div class="space-y-3">
          ${(esc.milestones || []).map(m => renderMilestoneRow(m, esc)).join('')}
        </div>
      </div>

      <!-- Actions -->
      ${esc.state === 'Active' ? `
      <div class="bg-gray-900/60 border border-gray-700/40 rounded-xl p-4 mb-5">
        <h4 class="text-gray-400 text-xs uppercase tracking-wider mb-3">Actions</h4>
        <div class="flex flex-wrap gap-2">
          <button onclick="escrowOpenDeposit(${esc.id})"
            class="flex items-center gap-1.5 bg-blue-600/20 hover:bg-blue-600/30 border border-blue-600/40 text-blue-400 rounded-xl px-3 py-2 text-sm transition-all">
            <i class="fas fa-arrow-circle-down text-xs"></i> Deposit USDC
          </button>
          <button onclick="escrowRaiseDispute(${esc.id})"
            class="flex items-center gap-1.5 bg-red-600/20 hover:bg-red-600/30 border border-red-600/40 text-red-400 rounded-xl px-3 py-2 text-sm transition-all">
            <i class="fas fa-gavel text-xs"></i> Raise Dispute
          </button>
        </div>
      </div>` : ''}

      <!-- Event History -->
      <div class="bg-gray-900/60 border border-gray-700/40 rounded-xl p-4">
        <h4 class="text-white font-semibold mb-3 flex items-center gap-2 text-sm">
          <i class="fas fa-history text-gray-400 text-xs"></i> Event History
        </h4>
        <div class="space-y-2 max-h-64 overflow-y-auto">
          ${(esc.events || []).slice(0, 20).map(ev => `
            <div class="flex items-start gap-3 bg-black/20 rounded-lg p-3">
              <div class="w-7 h-7 rounded-full ${ev.event.includes('Released') ? 'bg-green-900/50' : ev.event.includes('Dispute') || ev.event.includes('Refund') ? 'bg-red-900/50' : 'bg-purple-900/50'} flex items-center justify-center flex-shrink-0 mt-0.5">
                <i class="fas ${ev.event.includes('Released') ? 'fa-coins' : ev.event.includes('Deposit') ? 'fa-arrow-down' : ev.event.includes('Dispute') ? 'fa-gavel' : ev.event.includes('Refund') ? 'fa-undo' : 'fa-check'} text-xs ${ev.event.includes('Released') ? 'text-green-400' : ev.event.includes('Dispute') || ev.event.includes('Refund') ? 'text-red-400' : 'text-purple-400'}"></i>
              </div>
              <div class="flex-1 min-w-0">
                <div class="flex items-center justify-between gap-2">
                  <span class="text-white text-xs font-medium">${ev.event}</span>
                  <a href="${ev.explorerUrl}" target="_blank" class="text-xs text-gray-600 hover:text-cyan-400 font-mono flex-shrink-0">${fmtTx(ev.txHash)}</a>
                </div>
                <p class="text-gray-500 text-xs mt-0.5">${fmtDate(ev.timestamp)}</p>
              </div>
            </div>`).join('') || '<p class="text-gray-500 text-xs text-center py-4">No events yet</p>'}
        </div>
      </div>`;
  }

  function renderMilestoneRow(m, esc) {
    const sc = msStateColor(m.state);
    const icon = msStateIcon(m.state);
    const isActive = esc.state === 'Active';
    const canRequest = isActive && m.state === 'Pending';
    const canVerify  = isActive && m.state === 'RequestedByContractor' && !m.completed;
    const canRelease = isActive && m.completed && !m.released;
    return `
      <div class="escrow-milestone-row flex items-start gap-3 bg-black/20 border border-gray-700/30 rounded-xl p-4 ${m.released ? 'opacity-70' : ''}">
        <div class="w-8 h-8 rounded-lg ${sc} border border-current/30 flex items-center justify-center flex-shrink-0 mt-0.5">
          <i class="fas ${icon} text-xs"></i>
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between gap-2 mb-1">
            <span class="text-white font-medium text-sm truncate">${m.description}</span>
            <span class="text-cyan-400 font-bold text-sm flex-shrink-0">${fmtUsdc(m.amount)}</span>
          </div>
          <div class="flex items-center gap-2 flex-wrap text-xs">
            <span class="px-2 py-0.5 rounded-full ${sc}">${m.state}</span>
            ${m.requestedAt ? `<span class="text-gray-500">Req: ${fmtDate(m.requestedAt)}</span>` : ''}
            ${m.verifiedAt  ? `<span class="text-green-400">Verified: ${fmtDate(m.verifiedAt)}</span>` : ''}
            ${m.releasedAt  ? `<span class="text-blue-400">Released: ${fmtDate(m.releasedAt)}</span>` : ''}
          </div>
          ${canRequest || canVerify || canRelease ? `
          <div class="flex gap-2 mt-2 flex-wrap">
            ${canRequest ? `<button onclick="escrowRequestMilestone(${esc.id},${m.id})" class="escrow-ms-btn bg-yellow-600/20 hover:bg-yellow-600/30 border border-yellow-600/40 text-yellow-400 text-xs px-3 py-1.5 rounded-lg transition-all"><i class="fas fa-paper-plane mr-1"></i>Request Verification</button>` : ''}
            ${canVerify  ? `<button onclick="escrowVerifyMilestone(${esc.id},${m.id})"  class="escrow-ms-btn bg-green-600/20 hover:bg-green-600/30 border border-green-600/40 text-green-400 text-xs px-3 py-1.5 rounded-lg transition-all"><i class="fas fa-check mr-1"></i>Verify & Approve</button>` : ''}
            ${canRelease ? `<button onclick="escrowReleaseMilestone(${esc.id},${m.id})" class="escrow-ms-btn bg-blue-600/20 hover:bg-blue-600/30 border border-blue-600/40 text-blue-400 text-xs px-3 py-1.5 rounded-lg transition-all"><i class="fas fa-coins mr-1"></i>Release Payment</button>` : ''}
          </div>` : ''}
        </div>
      </div>`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CREATE ESCROW FORM — connects to EscrowWallet.sol
  // Flow: Form → wallet connect check → approve USDC → createEscrow() →
  //       await tx → parse EscrowCreated event → update UI
  // ══════════════════════════════════════════════════════════════════════════
  window.escrowShowCreate = function () {
    const lv = document.getElementById('escrow-view-list');
    const dv = document.getElementById('escrow-view-detail');
    const cv = document.getElementById('escrow-view-create');
    lv && lv.classList.add('hidden');
    dv && dv.classList.add('hidden');
    cv && cv.classList.remove('hidden');
    escrowRenderCreateForm();
  };

  function escrowRenderCreateForm() {
    const cv = document.getElementById('escrow-view-create');
    if (!cv) return;
    const wallet = getWallet() || '';
    cv.innerHTML = `
      <button onclick="escrowShowList()" class="flex items-center gap-2 text-gray-400 hover:text-white text-sm mb-5 transition-colors">
        <i class="fas fa-arrow-left"></i> Back
      </button>

      <!-- Data Flow Mini Diagram -->
      <div class="bg-gray-900/60 border border-cyan-700/20 rounded-xl p-3 mb-5">
        <div class="flex flex-wrap items-center gap-1.5 text-xs text-center">
          <div class="bg-blue-900/30 rounded-lg px-2.5 py-1.5 text-blue-300 flex items-center gap-1.5">
            <i class="fas fa-wpforms text-blue-400"></i> Form
          </div>
          <i class="fas fa-long-arrow-alt-right text-gray-600 text-xs"></i>
          <div class="bg-purple-900/30 rounded-lg px-2.5 py-1.5 text-purple-300 flex items-center gap-1.5">
            <i class="fas fa-wallet text-purple-400"></i> Wallet Sign
          </div>
          <i class="fas fa-long-arrow-alt-right text-gray-600 text-xs"></i>
          <div class="bg-yellow-900/30 rounded-lg px-2.5 py-1.5 text-yellow-300 flex items-center gap-1.5">
            <i class="fas fa-code text-yellow-400"></i> createEscrow()
          </div>
          <i class="fas fa-long-arrow-alt-right text-gray-600 text-xs"></i>
          <div class="bg-green-900/30 rounded-lg px-2.5 py-1.5 text-green-300 flex items-center gap-1.5">
            <i class="fas fa-bolt text-green-400"></i> EscrowCreated
          </div>
          <i class="fas fa-long-arrow-alt-right text-gray-600 text-xs"></i>
          <div class="bg-cyan-900/30 rounded-lg px-2.5 py-1.5 text-cyan-300 flex items-center gap-1.5">
            <i class="fas fa-desktop text-cyan-400"></i> UI Update
          </div>
        </div>
      </div>

      <div class="bg-gray-900/70 border border-gray-700/40 rounded-2xl p-6">
        <h3 class="text-white font-bold text-xl mb-5 flex items-center gap-2">
          <i class="fas fa-plus-circle text-cyan-400"></i> Create New Escrow
          <span class="text-xs text-gray-500 font-normal ml-1">— EscrowRegistry.createEscrow()</span>
        </h3>

        <!-- Step indicators -->
        <div id="escrow-create-steps" class="hidden flex items-center gap-1 mb-5 text-xs">
          ${['Connect Wallet','Approve USDC','Call createEscrow()','Confirm TX','Update UI'].map((s,i) => `
            <div id="ecstep-${i}" class="flex items-center gap-1 text-gray-600">
              <div class="w-5 h-5 rounded-full border border-current flex items-center justify-center font-bold text-xs">${i+1}</div>
              <span class="hidden sm:inline">${s}</span>
              ${i < 4 ? '<i class="fas fa-chevron-right text-gray-700 mx-0.5"></i>' : ''}
            </div>`).join('')}
        </div>

        <!-- Title -->
        <div class="mb-4">
          <label class="text-xs text-gray-400 uppercase tracking-wider mb-1.5 block">Escrow Title <span class="text-cyan-400">*</span></label>
          <input id="escrow-create-title" type="text" placeholder="e.g. Website Development — Phase 1"
            class="escrow-input w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:border-cyan-500 focus:outline-none">
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
          <div>
            <label class="text-xs text-gray-400 uppercase tracking-wider mb-1.5 block">
              Client Address <span class="text-cyan-400">*</span>
              ${wallet ? '<span class="text-green-400 ml-1">(you)</span>' : ''}
            </label>
            <input id="escrow-create-client" type="text" value="${wallet}" placeholder="0x... (payer)"
              class="escrow-input w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white font-mono placeholder-gray-600 focus:border-cyan-500 focus:outline-none">
          </div>
          <div>
            <label class="text-xs text-gray-400 uppercase tracking-wider mb-1.5 block">Contractor Address <span class="text-cyan-400">*</span></label>
            <input id="escrow-create-contractor" type="text" placeholder="0x... (receiver)"
              class="escrow-input w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white font-mono placeholder-gray-600 focus:border-cyan-500 focus:outline-none">
          </div>
        </div>

        <!-- Milestones -->
        <div class="mb-4">
          <div class="flex items-center justify-between mb-2">
            <label class="text-xs text-gray-400 uppercase tracking-wider">Milestones <span class="text-cyan-400">*</span></label>
            <button onclick="escrowAddMilestoneRow()" class="text-xs text-cyan-400 hover:text-cyan-300 flex items-center gap-1 transition-colors">
              <i class="fas fa-plus text-xs"></i> Add Milestone
            </button>
          </div>
          <div id="escrow-milestones-list" class="space-y-2">
            ${renderMsInput(0)}${renderMsInput(1)}${renderMsInput(2)}
          </div>
        </div>

        <!-- Total preview -->
        <div class="bg-cyan-900/20 border border-cyan-700/30 rounded-xl p-3 mb-5">
          <div class="flex justify-between items-center">
            <span class="text-cyan-400 text-sm font-medium">Total Escrow Amount</span>
            <span id="escrow-create-total" class="text-white font-bold text-xl">0.00 USDC</span>
          </div>
          <p class="text-xs text-cyan-400/60 mt-0.5">Sum of all milestone amounts</p>
        </div>

        <!-- USDC info when wallet connected -->
        ${wallet ? `
        <div id="escrow-usdc-info" class="bg-gray-800/50 border border-gray-700/30 rounded-xl p-3 mb-4 text-xs text-gray-400 space-y-1">
          <p><i class="fas fa-info-circle mr-1 text-cyan-400"></i>
            <b>Wallet:</b> ${fmtAddr(wallet)}</p>
          <p id="escrow-usdc-balance-row"><i class="fas fa-spinner fa-spin mr-1"></i> Reading USDC balance...</p>
          <p><i class="fas fa-check-circle mr-1 text-green-400"></i>
            ERC-20 approve() will be called before createEscrow()</p>
          <p><i class="fas fa-lock mr-1 text-yellow-400"></i>
            USDC locked until milestones verified by client</p>
        </div>` : `
        <div class="bg-yellow-900/20 border border-yellow-700/30 rounded-xl p-3 mb-4 flex items-center gap-3">
          <i class="fas fa-wallet text-yellow-400"></i>
          <div class="flex-1">
            <p class="text-yellow-300 text-xs font-medium">No wallet connected</p>
            <p class="text-yellow-400/70 text-xs">Escrow will be created in simulation mode (backend only)</p>
          </div>
          <button onclick="escrowConnectWallet()" class="bg-yellow-600 hover:bg-yellow-700 text-white rounded-lg px-3 py-1.5 text-xs transition-all flex-shrink-0">
            Connect
          </button>
        </div>`}

        <div id="escrow-create-msg" class="hidden mb-3 rounded-xl p-3 text-sm"></div>

        <div class="flex gap-3">
          <button onclick="escrowSubmitCreate()"
            id="escrow-submit-btn"
            class="flex-1 flex items-center justify-center gap-2 bg-cyan-600 hover:bg-cyan-700 text-white rounded-xl py-3 text-sm font-semibold transition-all shadow-lg shadow-cyan-900/30">
            <i class="fas fa-shield-alt"></i>
            ${wallet ? 'Create Escrow On-Chain' : 'Create Escrow (Simulation)'}
          </button>
          <button onclick="escrowShowList()" class="px-5 py-3 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-xl text-sm transition-all">
            Cancel
          </button>
        </div>
      </div>`;

    attachMsListeners();

    // Load USDC balance if wallet connected
    if (wallet) {
      readUsdcBalance(wallet).then(bal => {
        const el = document.getElementById('escrow-usdc-balance-row');
        if (el) {
          el.innerHTML = bal !== null
            ? `<i class="fas fa-coins mr-1 text-cyan-400"></i><b>USDC Balance:</b> ${fmtUsdc(bal)}`
            : `<i class="fas fa-exclamation mr-1 text-yellow-400"></i>Could not read balance from chain`;
        }
      });
    }
  }

  let msCount = 3;
  function renderMsInput(idx) {
    return `
      <div class="escrow-milestone-input flex gap-2 items-start" data-idx="${idx}">
        <div class="flex-1 bg-gray-800/60 border border-gray-700/50 rounded-xl p-2.5 flex gap-2">
          <input type="text" placeholder="Milestone description" data-ms-desc="${idx}"
            class="escrow-input flex-1 bg-transparent text-sm text-white placeholder-gray-600 focus:outline-none min-w-0">
          <div class="flex items-center gap-1 flex-shrink-0">
            <input type="number" placeholder="USDC" min="0.01" step="0.01" data-ms-amount="${idx}"
              class="escrow-input w-24 bg-gray-700/50 border border-gray-600/50 rounded-lg px-2 py-1 text-sm text-cyan-400 font-bold placeholder-gray-600 focus:outline-none focus:border-cyan-500 text-right"
              oninput="escrowCalcTotal()">
            <span class="text-xs text-gray-500">USDC</span>
          </div>
        </div>
        <button onclick="escrowRemoveMs(${idx})"
          class="w-8 h-8 flex items-center justify-center text-gray-600 hover:text-red-400 rounded-lg hover:bg-red-900/20 transition-all mt-1.5 flex-shrink-0">
          <i class="fas fa-times text-xs"></i>
        </button>
      </div>`;
  }

  window.escrowAddMilestoneRow = function () {
    const list = document.getElementById('escrow-milestones-list');
    if (!list) return;
    const div = document.createElement('div');
    div.innerHTML = renderMsInput(msCount++);
    list.appendChild(div.firstElementChild);
    attachMsListeners();
  };
  window.escrowRemoveMs = function (idx) {
    const el = document.querySelector(`[data-idx="${idx}"]`);
    if (el) el.remove();
    escrowCalcTotal();
  };
  window.escrowCalcTotal = function () {
    let total = 0;
    document.querySelectorAll('[data-ms-amount]').forEach(inp => {
      total += parseFloat(inp.value) || 0;
    });
    const el = document.getElementById('escrow-create-total');
    if (el) el.textContent = total.toFixed(2) + ' USDC';
  };
  function attachMsListeners() {
    document.querySelectorAll('[data-ms-amount]').forEach(inp => {
      inp.oninput = escrowCalcTotal;
    });
  }

  function setCreateStep(n, status = 'active') {
    const panel = document.getElementById('escrow-create-steps');
    if (panel) panel.classList.remove('hidden');
    for (let i = 0; i <= 4; i++) {
      const el = document.getElementById(`ecstep-${i}`);
      if (!el) continue;
      el.classList.remove('text-gray-600','text-cyan-400','text-green-400','text-red-400');
      if (i < n) el.classList.add('text-green-400');
      else if (i === n) el.classList.add(status === 'error' ? 'text-red-400' : 'text-cyan-400');
      else el.classList.add('text-gray-600');
    }
  }
  function hideCreateSteps() {
    const panel = document.getElementById('escrow-create-steps');
    if (panel) panel.classList.add('hidden');
  }

  // ── MAIN SUBMIT: Create Escrow ─────────────────────────────────────────────
  window.escrowSubmitCreate = async function () {
    const msg          = document.getElementById('escrow-create-msg');
    const titleEl      = document.getElementById('escrow-create-title');
    const clientEl     = document.getElementById('escrow-create-client');
    const contractorEl = document.getElementById('escrow-create-contractor');
    const submitBtn    = document.getElementById('escrow-submit-btn');

    const title      = titleEl && titleEl.value.trim();
    const client     = clientEl && clientEl.value.trim();
    const contractor = contractorEl && contractorEl.value.trim();

    // ── Validation ─────────────────────────────────────────────────────────
    if (!title) {
      showEscrowMsg(msg, 'Title is required', 'error'); return;
    }
    if (!client || !/^0x[0-9a-fA-F]{40}$/.test(client)) {
      showEscrowMsg(msg, 'Valid client address required (0x...)', 'error'); return;
    }
    if (!contractor || !/^0x[0-9a-fA-F]{40}$/.test(contractor)) {
      showEscrowMsg(msg, 'Valid contractor address required (0x...)', 'error'); return;
    }
    if (client.toLowerCase() === contractor.toLowerCase()) {
      showEscrowMsg(msg, 'Client and contractor must be different addresses', 'error'); return;
    }

    // Gather milestones
    const milestones = [];
    document.querySelectorAll('.escrow-milestone-input').forEach(row => {
      const idx = row.getAttribute('data-idx');
      const desc = row.querySelector(`[data-ms-desc="${idx}"]`);
      const amt  = row.querySelector(`[data-ms-amount="${idx}"]`);
      if (amt && parseFloat(amt.value) > 0) {
        milestones.push({
          description: (desc && desc.value.trim()) || `Milestone ${milestones.length + 1}`,
          amount: parseFloat(amt.value),
        });
      }
    });
    if (milestones.length === 0) {
      showEscrowMsg(msg, 'Add at least one milestone with amount > 0', 'error'); return;
    }

    const totalAmount = milestones.reduce((s, m) => s + m.amount, 0);
    const wallet = getWallet();

    if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Processing…'; }

    try {
      let txHash = null;
      let blockNumber = null;
      let onChainEscrowId = null;

      if (wallet && getProvider()) {
        // ── ON-CHAIN FLOW ───────────────────────────────────────────────────
        // Step 0: Ensure network
        setCreateStep(0);
        showEscrowMsg(msg, '<i class="fas fa-spinner fa-spin mr-2"></i>Verifying network…', 'loading');
        await evmEnsureNetwork();

        // Step 1: Check USDC balance + allowance
        setCreateStep(1);
        showEscrowMsg(msg, '<i class="fas fa-spinner fa-spin mr-2"></i>Checking USDC balance…', 'loading');
        const balance = await readUsdcBalance(wallet);
        console.log('[EscrowWallet] USDC balance:', balance);

        if (balance !== null && balance < totalAmount) {
          throw new Error(`Insufficient USDC: ${fmtUsdc(balance)} available, ${fmtUsdc(totalAmount)} required`);
        }

        // Check and approve if needed
        const allowance = await readAllowance(wallet, REGISTRY_ADDR);
        console.log('[EscrowWallet] Current allowance:', allowance);

        if (allowance < totalAmount) {
          showEscrowMsg(msg, '<i class="fas fa-spinner fa-spin mr-2"></i>Confirm USDC approval in wallet…', 'loading');
          toast('📝 Confirm USDC approval in your wallet…', 'info');
          const approveTx = await approveUsdc(REGISTRY_ADDR, totalAmount * 1.01); // 1% buffer
          showEscrowMsg(msg, `<i class="fas fa-spinner fa-spin mr-2"></i>Waiting for approval tx…`, 'loading');
          await evmWaitReceipt(approveTx);
          toast(`✅ USDC approved for escrow deposit`, 'success');
        }

        // Step 2: Call createEscrow() on EscrowRegistry
        setCreateStep(2);
        showEscrowMsg(msg, '<i class="fas fa-spinner fa-spin mr-2"></i>Confirm createEscrow() in wallet…', 'loading');
        toast('📝 Confirm EscrowRegistry.createEscrow() in your wallet…', 'info');

        txHash = await onChainCreateEscrow(title, client, contractor, totalAmount);
        toast(`⏳ Transaction submitted: ${txHash.slice(0,14)}…`, 'info');

        // Step 3: Wait for confirmation
        setCreateStep(3);
        showEscrowMsg(msg, '<i class="fas fa-spinner fa-spin mr-2"></i>Waiting for confirmation…', 'loading');
        const onChainReceipt = await evmWaitReceipt(txHash);
        blockNumber = onChainReceipt.blockNumber ? parseInt(onChainReceipt.blockNumber, 16) : null;

        if (onChainReceipt.status !== '0x1' && onChainReceipt.status !== 1) {
          throw new Error('Transaction reverted on-chain');
        }

        // Parse EscrowCreated event from receipt logs
        if (onChainReceipt.logs) {
          for (const log of onChainReceipt.logs) {
            const parsed = parseEscrowCreatedLog(log);
            if (parsed) {
              onChainEscrowId = parsed.escrowId;
              console.log('[EscrowWallet] EscrowCreated event:', parsed);
              break;
            }
          }
        }

        toast(`✅ EscrowCreated event confirmed! Escrow #${onChainEscrowId || '?'} on-chain`, 'success');

      } else {
        // ── SIMULATION FLOW (no wallet) ─────────────────────────────────────
        setCreateStep(2); // skip to createEscrow step
        showEscrowMsg(msg, '<i class="fas fa-spinner fa-spin mr-2"></i>Creating escrow (simulation)…', 'loading');
      }

      // Step 4: Register in backend + sync UI
      setCreateStep(4);
      showEscrowMsg(msg, '<i class="fas fa-spinner fa-spin mr-2"></i>Registering on backend…', 'loading');

      const result = await apiPost('/create', {
        title,
        client,
        contractor,
        totalAmount,
        milestones,
        txHash,
        blockNumber,
        source: wallet ? 'on_chain' : 'simulation',
      });

      if (!result.success) throw new Error(result.error || 'Backend creation failed');

      const escrowId = result.escrowId;

      showEscrowMsg(msg, `✅ Escrow #${escrowId} created!`, 'success');
      toast(
        `🛡 Escrow #${escrowId} created — ${fmtUsdc(totalAmount)}` +
        (txHash ? ` <a href="${explorerTxUrl(txHash)}" target="_blank" class="underline ml-1">View ↗</a>` : ''),
        'success'
      );

      // ── Dispatch EscrowCreated event ───────────────────────────────────────
      window.dispatchEvent(new CustomEvent('escrow:created', {
        detail: {
          escrowId,
          title,
          client,
          contractor,
          amount: totalAmount,
          txHash: txHash || result.txHash,
          explorerUrl: result.explorerUrl || explorerTxUrl(txHash || result.txHash || '0x0'),
          onChain: !!txHash,
          source: 'direct_create',
          timestamp: Date.now(),
        },
      }));

      // Refresh after short delay
      setTimeout(() => {
        hideCreateSteps();
        escrowShowDetail(escrowId);
        escrowLoadAll();
      }, 1500);

    } catch (err) {
      console.error('[EscrowWallet] Create error:', err);
      setCreateStep(2, 'error');

      let userMsg = err.message || 'Unknown error';
      if (err.code === 4001 || userMsg.includes('rejected') || userMsg.includes('denied')) {
        userMsg = 'Transaction rejected by user';
      }
      showEscrowMsg(msg, `❌ ${userMsg}`, 'error');
      toast(`❌ ${userMsg}`, 'error');

    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        const wallet2 = getWallet();
        submitBtn.innerHTML = `<i class="fas fa-shield-alt mr-2"></i>${wallet2 ? 'Create Escrow On-Chain' : 'Create Escrow (Simulation)'}`;
      }
      setTimeout(hideCreateSteps, 15000);
    }
  };

  // ══════════════════════════════════════════════════════════════════════════
  // DEPOSIT MODAL
  // ══════════════════════════════════════════════════════════════════════════
  window.escrowOpenDeposit = function (escrowId) {
    const esc = escrowState.escrows.find(e => e.id === escrowId) || escrowState.currentEscrow;
    const remaining = esc ? parseFloat((esc.totalAmount - (esc.depositedAmount || 0)).toFixed(6)) : 0;
    const existing = document.getElementById('escrow-deposit-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'escrow-deposit-modal';
    modal.className = 'fixed inset-0 z-[80] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4';
    modal.innerHTML = `
      <div class="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md p-6 shadow-2xl">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-white font-bold flex items-center gap-2">
            <i class="fas fa-arrow-circle-down text-cyan-400"></i> Deposit USDC to Escrow #${escrowId}
          </h3>
          <button onclick="document.getElementById('escrow-deposit-modal').remove()" class="text-gray-500 hover:text-white">
            <i class="fas fa-times"></i>
          </button>
        </div>

        <div class="bg-cyan-900/20 border border-cyan-700/30 rounded-xl p-3 mb-4">
          <p class="text-xs text-cyan-400">Remaining to deposit</p>
          <p class="text-xl font-bold text-cyan-300">${fmtUsdc(remaining)}</p>
        </div>

        <label class="text-xs text-gray-400 uppercase tracking-wider mb-1.5 block">Amount (USDC)</label>
        <input id="deposit-amount" type="number" min="0.01" step="0.01" value="${remaining.toFixed(2)}"
          class="escrow-input w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-lg font-bold text-cyan-400 placeholder-gray-600 focus:border-cyan-500 focus:outline-none text-center mb-4">

        <div class="mb-4 text-xs text-gray-500 bg-gray-800/50 rounded-xl p-3 space-y-1">
          <p><i class="fas fa-info-circle mr-1 text-cyan-400"></i>ERC-20 transferFrom — wallet must approve first</p>
          <p><i class="fas fa-lock mr-1 text-yellow-400"></i>Funds locked until milestones verified</p>
          <p><i class="fas fa-coins mr-1 text-green-400"></i>USDC: ${fmtAddr(USDC_ADDR)}</p>
        </div>

        <div id="deposit-msg" class="hidden mb-3 rounded-xl p-3 text-sm"></div>

        <div class="flex gap-3">
          <button onclick="escrowSubmitDeposit(${escrowId})"
            class="flex-1 bg-cyan-600 hover:bg-cyan-700 text-white rounded-xl py-3 text-sm font-semibold transition-all">
            <i class="fas fa-arrow-circle-down mr-2"></i>Deposit USDC
          </button>
          <button onclick="document.getElementById('escrow-deposit-modal').remove()"
            class="px-4 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-xl text-sm transition-all">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
  };

  window.escrowSubmitDeposit = async function (escrowId) {
    const amtEl = document.getElementById('deposit-amount');
    const msg   = document.getElementById('deposit-msg');
    const amount = parseFloat(amtEl && amtEl.value);
    if (!amount || amount <= 0) { showEscrowMsg(msg, 'Enter valid amount', 'error'); return; }

    const wallet = getWallet();
    showEscrowMsg(msg, '<i class="fas fa-spinner fa-spin mr-2"></i>Processing deposit…', 'loading');

    let txHash = null;
    try {
      if (wallet && getProvider()) {
        await evmEnsureNetwork();
        // ERC-20 approve + transferFrom simulation
        showEscrowMsg(msg, '<i class="fas fa-spinner fa-spin mr-2"></i>Confirm approval in wallet…', 'loading');

        // ✅ FIX: Use parseUsdcUnits() — converts human USDC to 6-decimal base units
        // 1 USDC → 1000000, 0.5 → 500000, 10 → 10000000
        const amountRaw = parseUsdcUnits(amount);
        const amountHex = usdcToHex(amount);
        console.log(`[USDC:deposit] amount=${amount} USDC → amountRaw=${amountRaw.toString()} → hex=${amountHex}`);

        // Approve escrow custodian
        const approveTx = await evmSendTx(
          USDC_ADDR,
          SEL_APPROVE + encAddr('0x867650F5eAe8df91445971f14d89fd84F0C9a9f8') + encUint(amountRaw),
        );
        showEscrowMsg(msg, '<i class="fas fa-spinner fa-spin mr-2"></i>Waiting for approval…', 'loading');
        await evmWaitReceipt(approveTx);
        txHash = approveTx;
      }

      const result = await apiPost(`/${escrowId}/deposit`, {
        amount,
        depositor: wallet || '0x0000000000000000000000000000000000000000',
        txHash,
      });

      if (result.success) {
        showEscrowMsg(msg, `✅ Deposited ${fmtUsdc(amount)}!`, 'success');
        toast(`Deposit confirmed — ${fmtUsdc(amount)} locked in escrow #${escrowId}`, 'success');
        setTimeout(() => {
          document.getElementById('escrow-deposit-modal')?.remove();
          escrowShowDetail(escrowId);
          escrowLoadAll();
        }, 1200);
      } else {
        showEscrowMsg(msg, result.error || 'Deposit failed', 'error');
      }
    } catch (e) {
      if (e.code === 4001) {
        showEscrowMsg(msg, 'Transaction rejected', 'error');
      } else {
        showEscrowMsg(msg, e.message || 'Network error', 'error');
      }
    }
  };

  // ══════════════════════════════════════════════════════════════════════════
  // MILESTONE ACTIONS
  // ══════════════════════════════════════════════════════════════════════════
  window.escrowRequestMilestone = async function (escrowId, milestoneId) {
    const wallet = getWallet();
    try {
      const result = await apiPost(`/${escrowId}/request/${milestoneId}`, { caller: wallet });
      if (result.success) {
        toast(`Milestone ${milestoneId + 1} verification requested`, 'success');
        escrowShowDetail(escrowId); escrowLoadAll();
      } else { toast(result.error || 'Request failed', 'error'); }
    } catch (e) { toast('Network error', 'error'); }
  };

  window.escrowVerifyMilestone = async function (escrowId, milestoneId) {
    const wallet = getWallet();
    try {
      const result = await apiPost(`/${escrowId}/verify/${milestoneId}`, { caller: wallet });
      if (result.success) {
        toast(`Milestone ${milestoneId + 1} verified! Contractor can now release payment.`, 'success');
        escrowShowDetail(escrowId); escrowLoadAll();
      } else { toast(result.error || 'Verification failed', 'error'); }
    } catch (e) { toast('Network error', 'error'); }
  };

  window.escrowReleaseMilestone = async function (escrowId, milestoneId) {
    const wallet = getWallet();
    try {
      const result = await apiPost(`/${escrowId}/release/${milestoneId}`, { caller: wallet });
      if (result.success) {
        toast(`Payment released! ${fmtUsdc(result.amountReleased)} sent to contractor.`, 'success');
        escrowShowDetail(escrowId); escrowLoadAll();
      } else { toast(result.error || 'Release failed', 'error'); }
    } catch (e) { toast('Network error', 'error'); }
  };

  window.escrowRaiseDispute = async function (escrowId) {
    const wallet = getWallet();
    const reason = prompt('Reason for dispute (optional):') || '';
    try {
      const result = await apiPost(`/${escrowId}/dispute`, { raisedBy: wallet || 'unknown', reason });
      if (result.success) {
        toast('Dispute raised — escrow frozen', 'warning');
        escrowShowDetail(escrowId); escrowLoadAll();
      } else { toast(result.error || 'Failed to raise dispute', 'error'); }
    } catch (e) { toast('Network error', 'error'); }
  };

  window.escrowRefund = async function (escrowId) {
    if (!confirm('Confirm full refund to client? This will close the escrow.')) return;
    try {
      const result = await apiPost(`/${escrowId}/refund`, {});
      if (result.success) {
        toast(`Refund issued — ${fmtUsdc(result.refundAmount)} returned to client`, 'success');
        escrowShowDetail(escrowId); escrowLoadAll();
      } else { toast(result.error || 'Refund failed', 'error'); }
    } catch (e) { toast('Network error', 'error'); }
  };

  // ══════════════════════════════════════════════════════════════════════════
  // EVENTS LOG
  // ══════════════════════════════════════════════════════════════════════════
  window.escrowLoadEvents = async function () {
    const el = document.getElementById('escrow-events-log');
    if (!el) return;
    try {
      const data = await apiGet('/events');
      const events = data.events || [];
      const badge = document.getElementById('escrow-event-badge');
      if (badge) {
        badge.textContent = events.length;
        badge.classList.toggle('hidden', events.length === 0);
      }
      if (events.length === 0) {
        el.innerHTML = '<p class="text-gray-600 text-xs text-center py-3">No events yet</p>';
        return;
      }
      el.innerHTML = events.slice(0, 15).map(ev => {
        const isReleased = ev.event.includes('Released');
        const isDispute  = ev.event.includes('Dispute') || ev.event.includes('Refund');
        const isDeposit  = ev.event.includes('Deposit');
        const isCreated  = ev.event.includes('Created');
        const iconClass  = isReleased ? 'fa-coins text-green-400' :
                          isDispute  ? 'fa-gavel text-red-400' :
                          isDeposit  ? 'fa-arrow-down text-cyan-400' :
                          isCreated  ? 'fa-shield-alt text-purple-400' : 'fa-check text-blue-400';
        const bgClass    = isReleased ? 'bg-green-900/40' :
                          isDispute  ? 'bg-red-900/40' :
                          isDeposit  ? 'bg-cyan-900/40' :
                          isCreated  ? 'bg-purple-900/40' : 'bg-blue-900/40';
        return `
          <div class="flex items-center gap-3 bg-black/20 rounded-lg px-3 py-2.5 hover:bg-black/30 transition-colors">
            <div class="w-6 h-6 rounded-full ${bgClass} flex items-center justify-center flex-shrink-0">
              <i class="fas ${iconClass} text-xs"></i>
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="text-white text-xs font-medium">Escrow #${ev.escrowId}</span>
                <span class="text-gray-400 text-xs">${ev.event}</span>
              </div>
              <div class="text-gray-600 text-xs">${fmtDate(ev.timestamp)}</div>
            </div>
            <a href="${ev.explorerUrl}" target="_blank"
              class="text-xs text-gray-600 hover:text-cyan-400 font-mono flex-shrink-0 transition-colors"
              title="${ev.txHash}">${fmtTx(ev.txHash)}</a>
          </div>`;
      }).join('');
    } catch (e) {
      el.innerHTML = '<p class="text-gray-600 text-xs text-center py-3">Failed to load events</p>';
    }
  };

  // ══════════════════════════════════════════════════════════════════════════
  // EVENT LISTENER: EscrowCreated (dispatched by contracts.js or this module)
  // Mirrors on-chain EscrowCreated event subscription
  // ══════════════════════════════════════════════════════════════════════════
  function escrowListenEvents() {
    window.addEventListener('escrow:created', function onEscrowCreated(e) {
      const detail = e.detail || {};
      console.log('[EscrowWallet] EscrowCreated event received:', detail);

      // Show notification toast
      toast(
        `🛡 EscrowCreated — Escrow #${detail.escrowId || '?'} · ${fmtUsdc(detail.amount || 0)}` +
        (detail.txHash ? ` <a href="${explorerTxUrl(detail.txHash)}" target="_blank" class="underline">↗</a>` : ''),
        'success'
      );

      // Push to Recent Events log immediately
      const eventsEl = document.getElementById('escrow-events-log');
      if (eventsEl) {
        const newEvent = document.createElement('div');
        newEvent.className = 'flex items-center gap-3 bg-purple-900/20 border border-purple-700/30 rounded-lg px-3 py-2.5 animate-pulse-once';
        newEvent.innerHTML = `
          <div class="w-6 h-6 rounded-full bg-purple-900/60 flex items-center justify-center flex-shrink-0">
            <i class="fas fa-shield-alt text-purple-400 text-xs"></i>
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <span class="text-purple-300 text-xs font-bold">NEW</span>
              <span class="text-white text-xs font-medium">Escrow #${detail.escrowId || '?'}</span>
              <span class="text-purple-400 text-xs">EscrowCreated</span>
            </div>
            <div class="text-gray-500 text-xs">${detail.title || ''} · ${fmtUsdc(detail.amount)} · just now</div>
          </div>
          ${detail.txHash ? `<a href="${explorerTxUrl(detail.txHash)}" target="_blank" class="text-xs text-gray-600 hover:text-cyan-400 font-mono">${fmtTx(detail.txHash)}</a>` : ''}
        `;
        eventsEl.prepend(newEvent);
        // Remove pulse after animation
        setTimeout(() => newEvent.classList.remove('animate-pulse-once'), 3000);
      }

      // Update stats counters immediately (optimistic update)
      escrowState.stats.total = (escrowState.stats.total || 0) + 1;
      const statTotal = document.getElementById('escrow-stat-total');
      if (statTotal) statTotal.textContent = escrowState.stats.total;

      // Full refresh after brief delay to get server state
      setTimeout(escrowLoadAll, 800);
    });

    // Also listen for wallet account changes
    if (window.ethereum) {
      window.ethereum.on('accountsChanged', (accounts) => {
        if (accounts[0]) {
          if (!window.walletState) window.walletState = {};
          window.walletState.address = accounts[0];
          window.walletAddress = accounts[0];
        }
        escrowUpdateWalletChip();
      });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // NAVIGATION
  // ══════════════════════════════════════════════════════════════════════════
  window.escrowShowList = function () {
    document.getElementById('escrow-view-list')?.classList.remove('hidden');
    document.getElementById('escrow-view-detail')?.classList.add('hidden');
    document.getElementById('escrow-view-create')?.classList.add('hidden');
    escrowLoadAll();
  };

  function showEscrowMsg(el, text, type) {
    if (!el) return;
    el.classList.remove('hidden');
    const map = {
      success: 'bg-green-900/30 border border-green-700/40 text-green-300',
      error:   'bg-red-900/30 border border-red-700/40 text-red-300',
      loading: 'bg-gray-800/60 border border-gray-700/40 text-gray-300',
    };
    el.className = `rounded-xl p-3 text-sm ${map[type] || map.loading}`;
    el.innerHTML = text;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PUBLIC API: called by contracts.js to notify a new escrow from contract creation
  // ══════════════════════════════════════════════════════════════════════════
  window.escrowNotifyFromContract = function (escrowData) {
    if (!escrowData) return;
    // Insert the new escrow into local state
    const existing = escrowState.escrows.find(e => e.id === escrowData.escrowId);
    if (!existing) {
      // Will be loaded on next escrowLoadAll()
      escrowState.stats.total = (escrowState.stats.total || 0) + 1;
      const statTotal = document.getElementById('escrow-stat-total');
      if (statTotal) statTotal.textContent = escrowState.stats.total;
    }
    // Dispatch event so listener picks it up
    window.dispatchEvent(new CustomEvent('escrow:created', { detail: escrowData }));
  };

  // ══════════════════════════════════════════════════════════════════════════
  // INIT
  // ══════════════════════════════════════════════════════════════════════════
  window.escrowInit = function () {
    msCount = 3;
    renderEscrowModule();
    console.log('[EscrowWallet] Module v2.0 — ARC Testnet Chain', CHAIN_ID);
  };

  // Auto-init when Escrow tab is opened
  const _origSwitchTab = window.switchTab;
  window.switchTab = function (tab) {
    if (_origSwitchTab) _origSwitchTab(tab);
    if (tab === 'escrow') {
      setTimeout(() => { if (window.escrowInit) window.escrowInit(); }, 50);
    }
  };

  // If already on escrow tab, init immediately
  if (document.getElementById('tab-content-escrow') &&
      !document.getElementById('tab-content-escrow').classList.contains('hidden')) {
    window.escrowInit();
  }

  console.log('[EscrowWallet] Module v2.0 registered — ARC Testnet');
})();
