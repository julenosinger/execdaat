// ============================================================
// ExecDaat — Advanced Cross-Chain Center
// Powered by Arc CCTP V2 (same protocol as bridge.js)
// Build: 20260703
// Architecture: completely independent module — zero coupling
// with existing bridge.js, swap.js, or other modules.
// ============================================================
'use strict';

/* ═══════════════════════════════════════════════════════════
   CHAIN REGISTRY — All CCTP testnet chains (Arc official)
   Source: https://docs.arc.io/app-kit/references/supported-blockchains
   ═══════════════════════════════════════════════════════════ */
const ACC_CHAINS = {
  arc: {
    key: 'arc', label: 'Arc Testnet', short: 'Arc',
    chainId: 5042002, chainHex: '0x4cef52',
    domain: 26, icon: '🟣', color: '#a78bfa',
    rpc: 'https://rpc.testnet.arc.network',
    rpcAlternatives: [
      'https://rpc.blockdaemon.testnet.arc.network',
      'https://rpc.drpc.testnet.arc.network',
      'https://rpc.quicknode.testnet.arc.network',
    ],
    explorer: 'https://testnet.arcscan.app',
    usdc: '0x3600000000000000000000000000000000000000',
    tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
    msgTransmitter: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
    isNative: true,
  },
  sepolia: {
    key: 'sepolia', label: 'Ethereum Sepolia', short: 'Sepolia',
    chainId: 11155111, chainHex: '0xaa36a7',
    domain: 0, icon: '🔷', color: '#627EEA',
    rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
    explorer: 'https://sepolia.etherscan.io',
    usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    tokenMessenger: '0x8fe6b999dc680ccfdd5bf7c5f412b27e4e99e6d7',
    msgTransmitter: '0xe737e5cebeeba77efe34d4aa090756590b1ce275',
  },
  basesepolia: {
    key: 'basesepolia', label: 'Base Sepolia', short: 'Base Sep',
    chainId: 84532, chainHex: '0x14a34',
    domain: 6, icon: '🔵', color: '#0052FF',
    rpc: 'https://sepolia.base.org',
    explorer: 'https://sepolia.basescan.org',
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    tokenMessenger: '0x8fe6b999dc680ccfdd5bf7c5f412b27e4e99e6d7',
    msgTransmitter: '0xe737e5cebeeba77efe34d4aa090756590b1ce275',
  },
  arbsepolia: {
    key: 'arbsepolia', label: 'Arbitrum Sepolia', short: 'Arb Sep',
    chainId: 421614, chainHex: '0x66eee',
    domain: 3, icon: '🔵', color: '#28A0F0',
    rpc: 'https://sepolia-rollup.arbitrum.io/rpc',
    explorer: 'https://sepolia.arbiscan.io',
    usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    tokenMessenger: '0x8fe6b999dc680ccfdd5bf7c5f412b27e4e99e6d7',
    msgTransmitter: '0xe737e5cebeeba77efe34d4aa090756590b1ce275',
  },
  optsepolia: {
    key: 'optsepolia', label: 'OP Sepolia', short: 'OP Sep',
    chainId: 11155420, chainHex: '0xaa37dc',
    domain: 2, icon: '🔴', color: '#FF0420',
    rpc: 'https://sepolia.optimism.io',
    explorer: 'https://sepolia-optimism.etherscan.io',
    usdc: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7',
    tokenMessenger: '0x8fe6b999dc680ccfdd5bf7c5f412b27e4e99e6d7',
    msgTransmitter: '0xe737e5cebeeba77efe34d4aa090756590b1ce275',
  },
  polygonAmoy: {
    key: 'polygonAmoy', label: 'Polygon Amoy', short: 'Amoy',
    chainId: 80002, chainHex: '0x13882',
    domain: 7, icon: '🟪', color: '#8247E5',
    rpc: 'https://rpc-amoy.polygon.technology',
    explorer: 'https://amoy.polygonscan.com',
    usdc: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
    tokenMessenger: '0x8fe6b999dc680ccfdd5bf7c5f412b27e4e99e6d7',
    msgTransmitter: '0xe737e5cebeeba77efe34d4aa090756590b1ce275',
  },
};

/* ═══════════════════════════════════════════════════════════
   ROUTE PROVIDERS — scoring system for best route selection
   ═══════════════════════════════════════════════════════════ */
const ACC_PROVIDERS = [
  { id: 'across',   name: 'Across Protocol',  time: '2m 47s', fee: 0.23, slippage: 0.15, score: 9.8, reliability: 'Very High', liquidity: '$13.4M', badge: 'Best Route', badgeColor: '#22c55e', outputPct: 0.9987 },
  { id: 'stargate', name: 'Stargate',         time: '3m 21s', fee: 0.31, slippage: 0.20, score: 9.1, reliability: 'High',      liquidity: '$8.2M',  badge: null,         badgeColor: null,      outputPct: 0.9980 },
  { id: 'lifi',     name: 'Li.Fi',            time: '4m 05s', fee: 0.41, slippage: 0.30, score: 8.6, reliability: 'High',      liquidity: '$6.1M',  badge: null,         badgeColor: null,      outputPct: 0.9970 },
  { id: 'relay',    name: 'Relay',            time: '5m 18s', fee: 0.52, slippage: 0.35, score: 7.9, reliability: 'Medium',    liquidity: '$4.8M',  badge: null,         badgeColor: null,      outputPct: 0.9958 },
  { id: 'hop',      name: 'Hop Protocol',     time: '6m 12s', fee: 0.61, slippage: 0.40, score: 7.2, reliability: 'Medium',    liquidity: '$3.2M',  badge: null,         badgeColor: null,      outputPct: 0.9945 },
];

/* ═══════════════════════════════════════════════════════════
   MODULE STATE
   ═══════════════════════════════════════════════════════════ */
const _accState = {
  initialized: false,
  fromChain: 'sepolia',
  toChain: 'arc',
  token: 'USDC',
  amount: '',
  slippage: 0.15,         // %
  autoRoute: true,
  fastRoute: false,
  lowestCost: false,
  highestOutput: false,
  expertMode: false,
  gasStrategy: 'standard',
  preferredBridge: 'auto',
  retryFailed: true,

  // quote state
  quoting: false,
  quoteError: null,
  quote: null,             // { provider, output, fee, gas, time, score, expiry }
  selectedProvider: null,
  quoteExpiry: null,
  quoteTimer: null,

  // bridge mode: 'standard' (Arc App Kit / CCTP) or 'turbo' (Treasury/Vault)
  bridgeMode: 'standard',
  turboInfo: null,

  // execution state
  executing: false,
  execSteps: [],           // [{id,label,status,txHash,time}]
  execError: null,
  activeTxHash: null,

  // balances
  fromBalance: null,
  toBalance: null,
  loadingBalance: false,

  // live activity
  networkHealth: 'Good',
  networkCongestion: 'Low',
  rpcStatus: 'Operational',
  bridgeStatus: 'All Systems Operational',
  avgConfirmation: 3.2,
  uptime: 99.97,

  // history (stored in localStorage)
  history: [],
};

/* ═══════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════ */
function _accFmt(n, dec = 4) {
  if (n === null || n === undefined || isNaN(Number(n))) return '--';
  const v = Number(n);
  if (v === 0) return '0.00';
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: dec });
}

function _accFmtUSD(n) {
  if (n === null || n === undefined || isNaN(Number(n))) return '$0.00';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(n));
}

function _accShortAddr(addr) {
  if (!addr) return '--';
  return addr.slice(0, 6) + '…' + addr.slice(-4);
}

function _accTimeAgo(ts) {
  if (!ts) return '--';
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60)   return diff + 's ago';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  return Math.floor(diff / 3600) + 'h ago';
}

function _accSaveHistory() {
  try {
    localStorage.setItem('acc_history', JSON.stringify(_accState.history.slice(0, 50)));
  } catch(e) {}
}

function _accLoadHistory() {
  try {
    const raw = localStorage.getItem('acc_history');
    if (raw) _accState.history = JSON.parse(raw);
  } catch(e) {}
}

/* ─── RPC call helper (same pattern as bridge.js / wallet.js) ─── */
async function _accRpcCall(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || 'RPC error');
  return json.result;
}

/* ─── ERC-20 balanceOf via eth_call ─── */
async function _accFetchBalance(chainKey, walletAddress) {
  const chain = ACC_CHAINS[chainKey];
  if (!chain || !walletAddress) return null;
  try {
    const sel  = '0x70a08231';
    const data = sel + walletAddress.slice(2).padStart(64, '0');
    const hex  = await _accRpcCall(chain.rpc, 'eth_call', [{ to: chain.usdc, data }, 'latest']);
    if (!hex || hex === '0x') return 0;
    return Number(BigInt(hex)) / 1e6;
  } catch(e) {
    console.warn('[ACC] Balance fetch error:', chainKey, e.message);
    return null;
  }
}

/* ─── Generate a realistic quote from real inputs ─── */
function _accBuildQuote(amount, provider) {
  const amtNum = parseFloat(amount) || 0;
  if (amtNum <= 0) return null;
  const slipMult = 1 - (provider.outputPct);
  const bridgeFee = parseFloat((amtNum * (provider.fee / 100)).toFixed(4));
  const gasFee    = parseFloat((0.04 + Math.random() * 0.02).toFixed(4));
  const protFee   = parseFloat((amtNum * 0.0003).toFixed(4));
  const output    = parseFloat((amtNum - bridgeFee - gasFee - protFee).toFixed(6));
  return {
    provider,
    input:    amtNum,
    output:   Math.max(output, 0),
    bridgeFee,
    gasFee,
    protFee,
    totalCost: parseFloat((bridgeFee + gasFee + protFee).toFixed(4)),
    slippage:  provider.slippage,
    time:      provider.time,
    score:     provider.score,
    minReceived: parseFloat((output * (1 - provider.slippage / 100)).toFixed(6)),
    liquidity: provider.liquidity,
    reliability: provider.reliability,
    routeType: 'Direct',
    expiry: Date.now() + 58000, // ~58 seconds
  };
}

/* ─── Get chain ID from wallet provider ─── */
async function _accGetWalletChainId() {
  const prov = window.walletState?.provider;
  if (!prov) return null;
  try {
    const hex = await prov.request({ method: 'eth_chainId', params: [] });
    return parseInt(hex, 16);
  } catch(e) { return null; }
}

/* ─── Switch wallet to chain ─── */
async function _accSwitchChain(chainKey) {
  const chain = ACC_CHAINS[chainKey];
  const prov  = window.walletState?.provider;
  if (!chain || !prov) return;
  try {
    await prov.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chain.chainHex }] });
  } catch(e) {
    if (e.code === 4902) {
      await prov.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: chain.chainHex,
          chainName: chain.label,
          nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
          rpcUrls: [chain.rpc].concat(chain.rpcAlternatives || []),
          blockExplorerUrls: [chain.explorer],
        }],
      });
    }
  }
}

/* ═══════════════════════════════════════════════════════════
   BALANCE LOADER
   ═══════════════════════════════════════════════════════════ */
async function accLoadBalances() {
  const addr = window.walletState?.address;
  if (!addr) {
    _accState.fromBalance = null;
    _accState.toBalance   = null;
    _accUpdateBalanceUI();
    return;
  }
  _accState.loadingBalance = true;
  _accUpdateBalanceUI();

  const [fromBal, toBal] = await Promise.all([
    _accFetchBalance(_accState.fromChain, addr),
    _accFetchBalance(_accState.toChain,   addr),
  ]);
  _accState.fromBalance = fromBal;
  _accState.toBalance   = toBal;
  _accState.loadingBalance = false;
  _accUpdateBalanceUI();
}

function _accUpdateBalanceUI() {
  const fromEl = document.getElementById('acc-from-balance');
  const toEl   = document.getElementById('acc-to-balance');
  const loading = _accState.loadingBalance;
  const addr    = window.walletState?.address;

  if (fromEl) {
    if (!addr)  fromEl.textContent = 'Balance: --';
    else if (loading) fromEl.innerHTML = '<span class="acc-skeleton-inline" style="width:80px;height:10px;display:inline-block;"></span>';
    else fromEl.textContent = 'Balance: ' + (_accState.fromBalance !== null ? _accFmt(_accState.fromBalance) + ' USDC' : '--');
  }
  if (toEl) {
    if (!addr)  toEl.textContent = 'Balance: --';
    else if (loading) toEl.innerHTML = '<span class="acc-skeleton-inline" style="width:80px;height:10px;display:inline-block;"></span>';
    else toEl.textContent = 'Balance: ' + (_accState.toBalance !== null ? _accFmt(_accState.toBalance) + ' USDC' : '--');
  }

  // Update MAX button availability
  const maxBtn = document.getElementById('acc-amount-max');
  if (maxBtn) {
    maxBtn.disabled = !addr || _accState.fromBalance === null || _accState.fromBalance <= 0;
  }
}

/* ═══════════════════════════════════════════════════════════
   QUOTE ENGINE
   ═══════════════════════════════════════════════════════════ */
/* Adapt the ArcBridge canonical quote → the shape the render fns expect */
function _accAdaptQuote(q) {
  return {
    provider:    q.provider,
    input:       q.input,
    output:      q.output,
    bridgeFee:   q.bridgeFee,
    gasFee:      q.gasFeeEst,
    protFee:     q.protocolFee,
    totalCost:   parseFloat((q.bridgeFee + q.protocolFee + q.gasFeeEst).toFixed(4)),
    slippage:    q.slippage,
    time:        q.estTime,
    score:       q.score,
    minReceived: q.minReceived,
    liquidity:   q.liquidity,
    reliability: q.reliability,
    routeType:   q.routeType,
    expiry:      q.expiry,
    _mode:       q.mode,
  };
}

async function accGetQuote() {
  const amount = parseFloat(_accState.amount) || 0;
  if (amount <= 0) {
    _accShowError('quote', 'Enter an amount to get a quote.');
    return;
  }
  if (!window.ArcBridge) {
    _accShowError('quote', 'Bridge service unavailable. Reload the page.');
    return;
  }

  // Real CCTP route-support check (e.g. Arc cannot be the source)
  const sup = window.ArcBridge.isRouteSupported(_accState.fromChain, _accState.toChain);
  if (!sup.ok) {
    _accState.quote = null;
    _accState.quoteError = sup.reason;
    _accRenderQuoteError();
    _accSetLayoutMode('plan');
    _accShowError('quote', sup.reason);
    return;
  }

  // Inbound (Other Chains → Arc) is ENABLED — continue to the real quote/route flow below.

  // Clear previous quote
  _accClearQuoteTimer();
  _accState.quoting = true;
  _accState.quoteError = null;
  _accState.quote = null;
  _accState.selectedProvider = null;
  _accState.bridgeMode = 'standard';
  _accState.turboInfo = null;
  _accRenderQuoteLoading();
  _accRenderComparisonLoading();
  _accRenderPreview();

  try {
    // Official Arc/Circle CCTP quote (single native route)
    const raw = await window.ArcBridge.getQuote({
      from:   _accState.fromChain,
      to:     _accState.toChain,
      amount: amount,
      mode:   _accState.fastRoute ? 'fast' : 'standard',
    });
    const best = _accAdaptQuote(raw);

    _accState.quote = best;
    _accState.selectedProvider = best.provider.id;
    _accState.quoting = false;

    _accRenderBestRoute(best);
    _accRenderComparison([best]);
    _accRenderPreview();
    _accStartQuoteTimer(best.expiry);
    _accSetLayoutMode('exec');   // visual-only: prioritise execution cards

  } catch(err) {
    console.error('[ACC] Quote error:', err);
    _accState.quoting = false;
    _accState.quoteError = err.message || 'Failed to fetch quote';
    _accRenderQuoteError();
    _accSetLayoutMode('plan');   // visual-only: no valid quote → planning layout
  }
}

/* ─── Quote countdown timer ─── */
function _accStartQuoteTimer(expiry) {
  _accClearQuoteTimer();
  const timerEl = document.getElementById('acc-quote-timer');
  _accState.quoteTimer = setInterval(() => {
    const rem = Math.max(0, Math.floor((expiry - Date.now()) / 1000));
    if (timerEl) timerEl.textContent = 'Route expires in ' + String(rem).padStart(2,'0') + ':' + String(rem % 60).padStart(2,'0');
    if (rem <= 0) {
      _accClearQuoteTimer();
      if (timerEl) timerEl.textContent = 'Quote expired — refresh';
      _accState.quote = null;
      _accSetLayoutMode('plan');   // visual-only: quote expired → planning layout
    }
  }, 1000);
}

function _accClearQuoteTimer() {
  if (_accState.quoteTimer) {
    clearInterval(_accState.quoteTimer);
    _accState.quoteTimer = null;
  }
}

/* ═══════════════════════════════════════════════════════════
   BRIDGE EXECUTION (CCTP V2 — same approach as bridge.js)
   ═══════════════════════════════════════════════════════════ */
async function accExecuteBridge() {
  const ws = window.walletState;
  if (!ws?.connected || !ws.provider) {
    _accShowToast('Connect your wallet first.', 'warning');
    return;
  }
  if (!_accState.quote) {
    _accShowToast('Get a quote first.', 'warning');
    return;
  }
  if (!window.ArcBridge) {
    _accShowToast('Bridge service unavailable. Reload the page.', 'error');
    return;
  }

  const amount  = parseFloat(_accState.amount);
  if (!amount || amount <= 0) return;

  const fromKey   = _accState.fromChain;
  const toKey     = _accState.toChain;
  const fromChain = ACC_CHAINS[fromKey];
  const toChain   = ACC_CHAINS[toKey];
  const addr      = ws.address;
  const mode      = _accState.fastRoute ? 'fast' : 'standard';

  _accState.executing    = true;
  _accState.execError    = null;
  _accState.activeTxHash = null;
  _accClearQuoteTimer();
  _accSetLayoutMode('exec', true);   // visual-only: bridge running → execution layout immediately
  _accRenderPreview();               // reflect "Bridging…" button state

  // Reset timeline (real steps, driven by ArcBridge events below)
  _accState.execSteps = [
    { id: 'prepare',   label: 'Preparing',               status: 'active',  time: _accNow(), txHash: null },
    { id: 'quote',     label: 'Quote Accepted',          status: 'pending', time: null,       txHash: null },
    { id: 'sign',      label: 'Signing',                 status: 'pending', time: null,       txHash: null },
    { id: 'sent',      label: 'Transaction Sent',        status: 'pending', time: null,       txHash: null },
    { id: 'srcconf',   label: 'Waiting Source Conf.',    status: 'pending', time: null,       txHash: null },
    { id: 'bridge',    label: 'Bridge Processing',       status: 'pending', time: null,       txHash: null },
    { id: 'relay',     label: 'Relaying',                status: 'pending', time: null,       txHash: null },
    { id: 'dstconf',   label: 'Destination Confirmation',status: 'pending', time: null,       txHash: null },
    { id: 'completed', label: 'Completed',               status: 'pending', time: null,       txHash: null },
  ];
  _accRenderTimeline();

  // Map real ArcBridge (CCTP) events → the visual timeline steps
  function _accStepSet(id, props) { const s = _accState.execSteps.find(x => x.id === id); if (s) Object.assign(s, props); }
  function onEvent(stage, data) {
    data = data || {};
    switch (stage) {
      case 'validating':       _accStepActive('prepare'); break;
      case 'switching_source': _accStepDone('prepare'); _accStepDone('quote'); _accStepActive('sign'); break;
      case 'approving':        _accStepActive('sign'); break;
      case 'approved':         _accStepDone('sign'); _accStepActive('sent'); break;
      case 'burning':          _accStepActive('sent'); break;
      case 'burn_sent':
        _accStepActive('sent');
        _accState.activeTxHash = data.txHash;         // source (burn) tx → matches source explorer
        _accStepSet('sent', { txHash: data.txHash });
        break;
      case 'burn_confirmed':
        _accStepDone('sent'); _accStepActive('srcconf');
        _accStepSet('sent', { txHash: data.txHash });
        break;
      case 'attesting':
        _accStepDone('srcconf'); _accStepActive('bridge');
        _accStepSet('bridge', { label: 'Bridge Processing' + (data.max ? ` — Circle attestation (${data.attempt || 0}/${data.max})` : '') });
        break;
      case 'attested':         _accStepDone('bridge'); _accStepActive('relay'); break;
      case 'switching_dest':   _accStepActive('relay'); break;
      case 'minting':          _accStepDone('relay'); _accStepActive('dstconf'); break;
      case 'mint_sent':        _accStepActive('dstconf'); break;
      case 'mint_confirmed':   _accStepDone('dstconf'); _accStepActive('completed'); break;
      case 'completed':        _accStepDone('completed'); break;
      case 'failed':           _accMarkCurrentFailed(); break;
    }
    _accRenderTimeline();
  }

  try {
    // ── Real Circle/Arc CCTP V2 execution via the shared ArcBridge service
    const result = await window.ArcBridge.execute({
      from: fromKey, to: toKey, amount, recipient: addr, mode, onEvent,
    });

    _accState.executing = false;

    // Real history entry (real burn/mint hashes + real explorer)
    _accState.history.unshift({
      id:         result.burnTxHash,
      token:      'USDC',
      from:       fromChain.label,
      to:         toChain.label,
      amount:     amount,
      received:   amount,                 // CCTP is 1:1
      status:     'completed',
      provider:   _accState.quote?.provider?.name || 'Circle CCTP V2',
      txHash:     result.burnTxHash,      // source tx → matches "from" explorer
      mintTxHash: result.mintTxHash,
      ts:         Date.now(),
      bridgeType: 'Standard',
    });
    _accSaveHistory();
    _accRenderHistory();

    // Update balances + Unified Balance without reloading the page
    setTimeout(accLoadBalances, 2500);
    setTimeout(() => { if (window.ubRefresh) window.ubRefresh(); }, 3000);

    _accRenderPreview();
    _accShowToast('Bridge completed successfully! 🎉', 'success');
    _accSetLayoutMode('plan');   // visual-only: bridge finished → back to original layout

  } catch(err) {
    console.error('[ACC] Bridge execution error:', err);
    _accState.executing = false;
    _accState.execError = (err && err.message) || 'Bridge failed';
    _accMarkCurrentFailed();
    _accRenderTimeline();
    _accRenderPreview();
    _accShowToast('Bridge failed: ' + _accState.execError, 'error');
    _accSetLayoutMode('plan');   // visual-only: bridge failed → back to original layout
  }
}

/* ─── CCTP helpers ─── */
async function _accCheckAllowance(chain, owner, amountRaw) {
  try {
    const sel  = '0xdd62ed3e'; // allowance(address,address)
    const data = sel
      + owner.slice(2).padStart(64,'0')
      + chain.tokenMessenger.slice(2).padStart(64,'0');
    const hex = await _accRpcCall(chain.rpc, 'eth_call', [{ to: chain.usdc, data }, 'latest']);
    const allowance = hex && hex !== '0x' ? BigInt(hex) : 0n;
    return allowance >= BigInt(amountRaw);
  } catch(e) { return false; }
}

async function _accApproveUsdc(chain, _owner, amountRaw) {
  const prov = window.walletState?.provider;
  if (!prov) return null;
  try {
    // approve(spender, amount)
    const sel  = '0x095ea7b3';
    const data = sel
      + chain.tokenMessenger.slice(2).padStart(64,'0')
      + BigInt(amountRaw).toString(16).padStart(64,'0');
    const txHash = await prov.request({
      method: 'eth_sendTransaction',
      params: [{
        from: window.walletState.address,
        to:   chain.usdc,
        data,
      }],
    });
    return txHash;
  } catch(e) {
    console.warn('[ACC] Approve failed:', e.message);
    return null;
  }
}

async function _accDepositForBurn(fromChain, toChain, addr, amountRaw) {
  const prov = window.walletState?.provider;
  if (!prov) return null;
  try {
    // depositForBurn(amount, destinationDomain, mintRecipient, burnToken)
    const sel = '0x6fd3504e';
    const amount256    = BigInt(amountRaw).toString(16).padStart(64, '0');
    const domain32     = toChain.domain.toString(16).padStart(64, '0');
    const recipient32  = addr.slice(2).padStart(64, '0');
    const token32      = fromChain.usdc.slice(2).padStart(64, '0');
    const data = sel + amount256 + domain32 + recipient32 + token32;

    const txHash = await prov.request({
      method: 'eth_sendTransaction',
      params: [{
        from:  addr,
        to:    fromChain.tokenMessenger,
        data,
        value: '0x0',
      }],
    });
    return txHash;
  } catch(e) {
    console.warn('[ACC] depositForBurn failed:', e.message);
    return null;
  }
}

async function _accWaitConfirmation(chain, txHash) {
  if (!txHash) return;
  for (let i = 0; i < 30; i++) {
    await _accWait(2000);
    try {
      const receipt = await _accRpcCall(chain.rpc, 'eth_getTransactionReceipt', [txHash]);
      if (receipt && receipt.blockNumber) return receipt;
    } catch(e) {}
  }
  return null; // timeout
}

/* ─── Timeline step helpers ─── */
function _accStepDone(id)   { const s = _accState.execSteps.find(x=>x.id===id); if(s){ s.status='done';   if(!s.time) s.time=_accNow(); } }
function _accStepActive(id) { const s = _accState.execSteps.find(x=>x.id===id); if(s){ s.status='active'; if(!s.time) s.time=_accNow(); } }
function _accMarkCurrentFailed() {
  const active = _accState.execSteps.find(x=>x.status==='active');
  if (active) active.status = 'failed';
}
function _accNow() { return new Date().toLocaleTimeString(); }
function _accWait(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ═══════════════════════════════════════════════════════════
   RENDER FUNCTIONS
   ═══════════════════════════════════════════════════════════ */

/* ─── Hero stats bar ─── */
function _accRenderHero() {
  const chains = Object.keys(ACC_CHAINS).length;
  const el = document.getElementById('acc-hero-chains');
  if (el) el.textContent = chains;

  _accUpdateNetworkStatus();
}

function _accUpdateNetworkStatus() {
  const stEl   = document.getElementById('acc-network-status');
  const healEl = document.getElementById('acc-network-health');
  if (stEl)   stEl.textContent   = _accState.bridgeStatus;
  if (healEl) healEl.textContent = _accState.networkHealth;
}

/* ─── Chain selectors ─── */
function _accRenderChainSelectors() {
  _accPopulateSelect('acc-from-chain', _accState.fromChain, null);
  _accPopulateSelect('acc-to-chain',   _accState.toChain,   _accState.fromChain);
}

function _accPopulateSelect(id, selected, exclude) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = Object.values(ACC_CHAINS).map(c => {
    if (c.key === exclude) return '';
    const sel = c.key === selected ? ' selected' : '';
    return `<option value="${c.key}"${sel}>${c.icon} ${c.label}</option>`;
  }).join('');
}

/* ─── Quote loading skeleton ─── */
function _accRenderQuoteLoading() {
  const el = document.getElementById('acc-best-route-body');
  if (!el) return;
  el.innerHTML = `
    <div class="acc-quote-loading">
      <div class="acc-spin-ring"></div>
      <span>Fetching best route…</span>
    </div>
  `;
}

function _accRenderComparisonLoading() {
  const el = document.getElementById('acc-route-comparison-list');
  if (!el) return;
  el.innerHTML = [1,2,3].map(() => `
    <div class="acc-route-row acc-skeleton-row">
      <div class="acc-skeleton" style="width:120px;height:14px;border-radius:6px;"></div>
      <div class="acc-skeleton" style="width:60px;height:14px;border-radius:6px;"></div>
      <div class="acc-skeleton" style="width:50px;height:14px;border-radius:6px;"></div>
      <div class="acc-skeleton" style="width:80px;height:14px;border-radius:6px;"></div>
      <div class="acc-skeleton" style="width:40px;height:14px;border-radius:6px;"></div>
      <div class="acc-skeleton" style="width:30px;height:14px;border-radius:6px;"></div>
    </div>
  `).join('');
}

function _accRenderQuoteError() {
  const el = document.getElementById('acc-best-route-body');
  if (!el) return;
  el.innerHTML = `
    <div class="acc-empty-state">
      <i class="fas fa-exclamation-triangle" style="color:#f87171;font-size:22px;"></i>
      <div style="color:#f87171;font-weight:600;margin-top:8px;">Quote failed</div>
      <div style="color:#9ca3af;font-size:12px;margin-top:4px;">${_accState.quoteError || 'Unknown error'}</div>
      <button class="acc-btn acc-btn-sm acc-btn-ghost" onclick="accGetQuote()" style="margin-top:12px;">
        <i class="fas fa-redo"></i> Retry
      </button>
    </div>
  `;
}

/* ─── Best Route card ─── */
function _accRenderBestRoute(q) {
  const el = document.getElementById('acc-best-route-body');
  if (!el) return;

  const fromChain = ACC_CHAINS[_accState.fromChain];
  const toChain   = ACC_CHAINS[_accState.toChain];
  const scoreColor = q.score >= 9 ? '#22c55e' : q.score >= 8 ? '#eab308' : '#f87171';
  const relColor   = q.reliability === 'Very High' ? '#22c55e' : q.reliability === 'High' ? '#3b82f6' : '#eab308';
  const isTurbo    = _accState.bridgeMode === 'turbo';
  const modeBadge  = isTurbo
    ? '<span class="acc-tag" style="background:rgba(245,158,11,0.14);color:#f59e0b;border-color:rgba(245,158,11,0.35);"><i class="fas fa-bolt"></i> Turbo Bridge</span>'
    : '<span class="acc-tag" style="background:rgba(96,165,250,0.12);color:#60a5fa;border-color:rgba(96,165,250,0.28);"><i class="fas fa-shield-alt"></i> Standard Bridge</span>';

  el.innerHTML = `
    <div class="acc-best-route-inner">
      <div class="acc-best-route-provider">
        <div class="acc-provider-icon">
          <i class="fas fa-route" style="font-size:18px;color:#a78bfa;"></i>
        </div>
        <div class="acc-provider-info">
          <div class="acc-provider-name">${q.provider.name}</div>
          <div class="acc-provider-sub">${fromChain.short} → ${toChain.short}</div>
        </div>
        <div class="acc-score-badge" style="background:${scoreColor}22;border-color:${scoreColor};color:${scoreColor};">
          ${q.score.toFixed(1)}
        </div>
      </div>

      <div class="acc-route-flow">
        <div class="acc-route-side">
          <div class="acc-route-label">You Send</div>
          <div class="acc-route-val">${_accFmt(q.input, 6)} USDC</div>
          <div class="acc-route-sub">${_accFmtUSD(q.input)}</div>
        </div>
        <div class="acc-route-arrow"><i class="fas fa-long-arrow-alt-right"></i></div>
        <div class="acc-route-side">
          <div class="acc-route-label">You Receive (est.)</div>
          <div class="acc-route-val" style="color:#22c55e;">${_accFmt(q.output, 6)} USDC</div>
          <div class="acc-route-sub">${_accFmtUSD(q.output)}</div>
        </div>
      </div>

      <div class="acc-route-meta">
        <div class="acc-meta-item"><span class="acc-meta-lbl">Time</span><span class="acc-meta-val">${q.time}</span></div>
        <div class="acc-meta-item"><span class="acc-meta-lbl">Total Cost</span><span class="acc-meta-val">$${_accFmt(q.totalCost, 4)}</span></div>
        <div class="acc-meta-item"><span class="acc-meta-lbl">Gas (est.)</span><span class="acc-meta-val">$${_accFmt(q.gasFee, 4)}</span></div>
        <div class="acc-meta-item"><span class="acc-meta-lbl">Slippage</span><span class="acc-meta-val">${q.slippage}%</span></div>
      </div>

      <div class="acc-route-tags">
        ${modeBadge}
        <span class="acc-tag" style="background:${relColor}22;color:${relColor};border-color:${relColor}44;">
          <i class="fas fa-shield-alt"></i> ${q.reliability}
        </span>
        <span class="acc-tag" style="background:rgba(167,139,250,0.12);color:#a78bfa;border-color:rgba(167,139,250,0.28);">
          <i class="fas fa-tint"></i> ${q.liquidity}
        </span>
        <span class="acc-tag" style="background:rgba(6,182,212,0.12);color:#06b6d4;border-color:rgba(6,182,212,0.28);">
          <i class="fas fa-code-branch"></i> ${q.routeType}
        </span>
      </div>

      <div class="acc-quote-footer">
        <span id="acc-quote-timer" class="acc-quote-timer">Route expires in 00:58</span>
        <button class="acc-btn acc-btn-sm acc-btn-ghost" onclick="accGetQuote()">
          <i class="fas fa-sync-alt"></i> Refresh
        </button>
      </div>
    </div>
  `;
}

/* ─── Route comparison list ─── */
function _accRenderComparison(quotes) {
  const el = document.getElementById('acc-route-comparison-list');
  if (!el) return;

  el.innerHTML = quotes.map((q, idx) => {
    const isSelected = q.provider.id === _accState.selectedProvider;
    const scoreColor = q.score >= 9 ? '#22c55e' : q.score >= 8 ? '#eab308' : '#f87171';
    const bestBadge  = idx === 0 ? '<span class="acc-best-pill">Best Route</span>' : '';
    return `
      <div class="acc-route-row ${isSelected ? 'acc-route-row-selected' : ''}"
           onclick="accSelectProvider('${q.provider.id}')" style="cursor:pointer;">
        <div class="acc-route-row-provider">
          ${bestBadge}
          <span class="acc-route-row-name">${q.provider.name}</span>
        </div>
        <div class="acc-route-row-time">${q.time}</div>
        <div class="acc-route-row-cost">$${_accFmt(q.totalCost, 3)}</div>
        <div class="acc-route-row-recv" style="color:#22c55e;">${_accFmt(q.output, 4)} USDC</div>
        <div class="acc-route-row-slip">${q.slippage}%</div>
        <div class="acc-route-row-score" style="color:${scoreColor};font-weight:700;">${q.score.toFixed(1)}</div>
      </div>
    `;
  }).join('');
}

function accSelectProvider(providerId) {
  // Turbo Bridge is a single fixed route (Treasury/Vault) — no provider
  // switching. Ignore selection clicks while in Turbo mode.
  if (_accState.bridgeMode === 'turbo') return;
  _accState.selectedProvider = providerId;
  // Re-rank and rebuild quote with selected provider
  const amount = parseFloat(_accState.amount) || 0;
  const prov   = ACC_PROVIDERS.find(p => p.id === providerId);
  if (prov && amount > 0) {
    _accState.quote = _accBuildQuote(amount, prov);
    _accRenderBestRoute(_accState.quote);
    _accRenderPreview();
    _accStartQuoteTimer(_accState.quote.expiry);
  }
  // Highlight selection
  document.querySelectorAll('.acc-route-row').forEach(r => r.classList.remove('acc-route-row-selected'));
  // Re-render comparison to update highlight
  const allQ = ACC_PROVIDERS.map(p => _accBuildQuote(amount, p)).filter(Boolean);
  _accRenderComparison(allQ);
}

/* ─── Execution Preview ─── */
function _accRenderPreview() {
  try { _accRenderRouteStrip(); } catch (e) {}
  const el = document.getElementById('acc-preview-body');
  if (!el) return;

  const q = _accState.quote;
  if (!q) {
    if (!_accState.quoting) _accSetLayoutMode('plan');   // visual-only: reset/clear/expired → planning layout (skip while a quote is loading)
    el.innerHTML = `
      <div class="acc-preview-placeholder">
        <i class="fas fa-route" style="color:#4b5563;font-size:22px;"></i>
        <div style="color:#6b7280;margin-top:8px;font-size:13px;">Get a quote to see execution preview</div>
      </div>`;
    return;
  }

  const fromChain = ACC_CHAINS[_accState.fromChain];
  const toChain   = ACC_CHAINS[_accState.toChain];
  const connected = window.walletState?.connected;
  const isTurbo   = _accState.bridgeMode === 'turbo';
  const tInfo     = _accState.turboInfo || (q && q._turbo) || null;

  const modeRow = `
    <div class="acc-preview-row">
      <span class="acc-preview-lbl">Bridge Mode</span>
      <span class="acc-preview-val" style="color:${isTurbo ? '#f59e0b' : '#60a5fa'};font-weight:700;">
        <i class="fas ${isTurbo ? 'fa-bolt' : 'fa-shield-alt'}"></i> ${isTurbo ? 'Turbo Bridge' : 'Standard Bridge'}
      </span>
    </div>
    <div class="acc-preview-row">
      <span class="acc-preview-lbl">Provider</span>
      <span class="acc-preview-val">${q.provider.name}</span>
    </div>`;

  const turboRows = (isTurbo && tInfo) ? `
    <div class="acc-preview-row">
      <span class="acc-preview-lbl">Treasury</span>
      <span class="acc-preview-val" title="${tInfo.treasury}">${_accShortAddr(tInfo.treasury)}</span>
    </div>
    <div class="acc-preview-row">
      <span class="acc-preview-lbl">Vault</span>
      <span class="acc-preview-val" title="${tInfo.vault}">${_accShortAddr(tInfo.vault)}</span>
    </div>` : '';

  el.innerHTML = `
    ${modeRow}
    ${turboRows}
    <div class="acc-preview-divider"></div>
    <div class="acc-preview-row">
      <span class="acc-preview-lbl">You Send</span>
      <span class="acc-preview-val">${_accFmt(q.input, 6)} USDC</span>
    </div>
    <div class="acc-preview-row acc-preview-row-highlight">
      <span class="acc-preview-lbl">You Receive (est.)</span>
      <span class="acc-preview-val" style="color:#22c55e;">${_accFmt(q.output, 6)} USDC</span>
    </div>
    <div class="acc-preview-divider"></div>
    <div class="acc-preview-row">
      <span class="acc-preview-lbl">Bridge Fee</span>
      <span class="acc-preview-val">$${_accFmt(q.bridgeFee, 4)}</span>
    </div>
    <div class="acc-preview-row">
      <span class="acc-preview-lbl">Protocol Fee</span>
      <span class="acc-preview-val">$${_accFmt(q.protFee, 4)}</span>
    </div>
    <div class="acc-preview-row">
      <span class="acc-preview-lbl">Gas (est.)</span>
      <span class="acc-preview-val">$${_accFmt(q.gasFee, 4)}</span>
    </div>
    <div class="acc-preview-row">
      <span class="acc-preview-lbl">Estimated Time</span>
      <span class="acc-preview-val">${q.time}</span>
    </div>
    <div class="acc-preview-row">
      <span class="acc-preview-lbl">Minimum Received</span>
      <span class="acc-preview-val">${_accFmt(q.minReceived, 6)} USDC</span>
    </div>
    <div class="acc-preview-divider"></div>
    <div class="acc-preview-row">
      <span class="acc-preview-lbl" style="color:#f59e0b;"><i class="fas fa-clock"></i> Expires in</span>
      <span class="acc-preview-val" style="color:#f59e0b;">00:58</span>
    </div>
    <div class="acc-preview-footer">
      <div class="acc-preview-route">${fromChain.short} <i class="fas fa-arrow-right" style="margin:0 4px;color:#6b7280;"></i> ${q.provider.name} <i class="fas fa-arrow-right" style="margin:0 4px;color:#6b7280;"></i> ${toChain.short}</div>
      ${connected
        ? `<button class="acc-btn acc-btn-primary acc-btn-full" onclick="accExecuteBridge()" ${_accState.executing ? 'disabled' : ''}>
            ${_accState.executing ? '<i class="fas fa-spinner fa-spin"></i> Bridging...' : '<i class="fas fa-bolt"></i> Execute Bridge'}
           </button>`
        : `<button class="acc-btn acc-btn-primary acc-btn-full" onclick="openWalletModal()">
            <i class="fas fa-plug"></i> Connect Wallet
           </button>`
      }
    </div>
  `;
}

/* ─── Transaction Timeline ─── */
function _accRenderTimeline() {
  const el = document.getElementById('acc-timeline-body');
  if (!el) return;

  if (_accState.execSteps.length === 0) {
    el.innerHTML = `
      <div class="acc-timeline-placeholder">
        <i class="fas fa-stream" style="color:#374151;font-size:18px;"></i>
        <div style="color:#6b7280;margin-top:8px;font-size:12px;">Timeline appears after execution starts</div>
      </div>`;
    return;
  }

  el.innerHTML = _accState.execSteps.map((step, i) => {
    const isLast = i === _accState.execSteps.length - 1;
    let iconClass, iconColor, lineColor;
    switch(step.status) {
      case 'done':
        iconClass = 'fas fa-check-circle'; iconColor = '#22c55e'; lineColor = '#22c55e'; break;
      case 'active':
        iconClass = 'fas fa-circle-notch fa-spin'; iconColor = '#a78bfa'; lineColor = '#374151'; break;
      case 'failed':
        iconClass = 'fas fa-times-circle'; iconColor = '#f87171'; lineColor = '#374151'; break;
      default:
        iconClass = 'far fa-circle'; iconColor = '#374151'; lineColor = '#1f2937'; break;
    }
    return `
      <div class="acc-timeline-item">
        <div class="acc-timeline-left">
          <i class="${iconClass}" style="color:${iconColor};font-size:16px;"></i>
          ${!isLast ? `<div class="acc-timeline-line" style="background:${lineColor};"></div>` : ''}
        </div>
        <div class="acc-timeline-content">
          <div class="acc-timeline-label" style="color:${step.status === 'pending' ? '#4b5563' : '#e2e8f0'};">${step.label}</div>
          ${step.time ? `<div class="acc-timeline-time">${step.time}</div>` : ''}
          ${step.txHash ? `<div class="acc-timeline-hash">
            <a href="${ACC_CHAINS[_accState.fromChain].explorer}/tx/${step.txHash}" target="_blank" rel="noopener" style="color:#a78bfa;font-size:10px;">
              <i class="fas fa-external-link-alt"></i> ${_accShortAddr(step.txHash)}
            </a>
          </div>` : ''}
          ${step.status === 'active' && step.id === 'completed' ? '<div style="color:#22c55e;font-size:11px;margin-top:2px;">You will receive ' + _accFmt(_accState.quote?.output) + ' USDC</div>' : ''}
        </div>
      </div>
    `;
  }).join('');

  // View on Explorer button
  const explorerBtn = document.getElementById('acc-timeline-explorer');
  if (explorerBtn && _accState.activeTxHash) {
    explorerBtn.href    = ACC_CHAINS[_accState.fromChain].explorer + '/tx/' + _accState.activeTxHash;
    explorerBtn.style.display = 'inline-flex';
  }

  _accRenderExecBar();
}

/* ─── Official chain/token logos (inline SVG — CSP-safe, no emojis/circles) ─── */
const ACC_LOGOS = {
  eth: '<svg viewBox="0 0 32 32" class="acc-logo-svg"><circle cx="16" cy="16" r="16" fill="#627EEA"/><g fill="#fff"><path fill-opacity=".6" d="M16.5 4v8.87l7.49 3.35z"/><path d="M16.5 4 9 16.22l7.5-3.35z"/><path fill-opacity=".6" d="M16.5 21.97V28l7.5-10.37z"/><path d="M16.5 28v-6.03L9 17.63z"/><path fill-opacity=".2" d="m16.5 20.57 7.49-4.35-7.49-3.34z"/><path fill-opacity=".6" d="m9 16.22 7.5 4.35v-7.69z"/></g></svg>',
  base: '<svg viewBox="0 0 32 32" class="acc-logo-svg"><circle cx="16" cy="16" r="16" fill="#0052FF"/><path fill="#fff" d="M15.9 26c5.55 0 10.05-4.48 10.05-10S21.45 6 15.9 6C10.63 6 6.3 9.96 6 15.02h13.2v1.96H6C6.3 22.04 10.63 26 15.9 26z"/></svg>',
  arb: '<svg viewBox="0 0 32 32" class="acc-logo-svg"><circle cx="16" cy="16" r="16" fill="#213147"/><path fill="#12AAFF" d="M9 22l3.4-9 3.4 9h-2.1l-1.3-3.7L11.1 22z"/><path fill="#9DCCED" d="M16.9 9.5 22 22h-2.2l-3.9-10.2z"/><path fill="#fff" d="M16.6 12.6 20 22h-2.1l-2.4-6.4z"/></svg>',
  op: '<svg viewBox="0 0 32 32" class="acc-logo-svg"><circle cx="16" cy="16" r="16" fill="#FF0420"/><path fill="#fff" d="M11.7 20.6c-1.9 0-3.1-1-3.1-2.7 0-.3 0-.6.1-.9.4-1.9.9-3 3.2-3 1.9 0 3.1 1 3.1 2.7 0 .3 0 .6-.1.9-.4 1.9-1 3-3.2 3zm.2-4.9c-.7 0-1.1.4-1.3 1.2-.1.3-.1.5-.1.7 0 .6.3.9 1 .9.7 0 1.1-.4 1.3-1.2.1-.3.1-.5.1-.7 0-.6-.4-.9-1-.9zm4.2 4.8 1.3-6.3h2.5c1.4 0 2.2.6 2.2 1.7 0 .2 0 .4-.1.6-.3 1.3-1.2 1.9-2.7 1.9h-1.1l-.4 2.1zm2-3.6h.9c.6 0 1-.2 1.1-.8v-.3c0-.4-.3-.5-.8-.5h-.9z"/></svg>',
  polygon: '<svg viewBox="0 0 32 32" class="acc-logo-svg"><circle cx="16" cy="16" r="16" fill="#8247E5"/><path fill="#fff" d="M20.7 13.4c-.3-.2-.7-.2-1 0l-2.3 1.3-1.6.9-2.3 1.3c-.3.2-.7.2-1 0l-1.8-1c-.3-.2-.5-.5-.5-.9v-2c0-.4.2-.7.5-.9l1.8-1c.3-.2.7-.2 1 0l1.8 1c.3.2.5.5.5.9v1.3l1.6-.9v-1.4c0-.4-.2-.7-.5-.9l-3.3-1.9c-.3-.2-.7-.2-1 0l-3.4 1.9c-.3.2-.5.5-.5.9v3.8c0 .4.2.7.5.9l3.4 1.9c.3.2.7.2 1 0l2.3-1.3 1.6-.9 2.3-1.3c.3-.2.7-.2 1 0l1.8 1c.3.2.5.5.5.9v2c0 .4-.2.7-.5.9l-1.8 1.1c-.3.2-.7.2-1 0l-1.8-1c-.3-.2-.5-.5-.5-.9v-1.3l-1.6.9v1.4c0 .4.2.7.5.9l3.4 1.9c.3.2.7.2 1 0l3.4-1.9c.3-.2.5-.5.5-.9v-3.9c0-.4-.2-.7-.5-.9z"/></svg>',
  arc: '<img src="/static/arc-mark-256.png" class="acc-logo-svg" alt="Arc" style="border-radius:9px;object-fit:cover;" loading="lazy">',
  usdc: '<svg viewBox="0 0 32 32" class="acc-logo-svg"><circle cx="16" cy="16" r="16" fill="#2775CA"/><path fill="#fff" d="M16 6.5a9.5 9.5 0 100 19 9.5 9.5 0 000-19zm2.4 12.9c0 1.3-1 2.1-2.6 2.3v1.3h-1.1v-1.3c-1.1-.1-2.1-.4-2.7-.8l.4-1.3c.6.4 1.5.7 2.5.7 1 0 1.7-.4 1.7-1s-.5-.9-1.6-1.3c-1.5-.5-2.6-1.1-2.6-2.5 0-1.2.9-2.1 2.4-2.3V12h1.1v1.3c.9.1 1.6.3 2.1.6l-.4 1.3c-.4-.2-1.1-.5-2-.5-1.1 0-1.5.5-1.5.9 0 .5.5.8 1.8 1.3 1.6.5 2.5 1.2 2.5 2.5z"/></svg>',
};
const ACC_CHAIN_LOGO_KEY = { arc: 'arc', sepolia: 'eth', basesepolia: 'base', arbsepolia: 'arb', optsepolia: 'op', polygonAmoy: 'polygon' };
function _accChainLogo(chainKey) {
  const k = ACC_CHAIN_LOGO_KEY[chainKey];
  if (k && ACC_LOGOS[k]) return ACC_LOGOS[k];
  const c = ACC_CHAINS[chainKey] || {};
  const color = c.color || '#4F8CFF';
  const letter = (c.short ? c.short[0] : '?').toUpperCase();
  return '<svg viewBox="0 0 32 32" class="acc-logo-svg"><rect width="32" height="32" rx="9" fill="' + color + '"/><text x="16" y="21" text-anchor="middle" font-size="14" font-weight="700" fill="#fff" font-family="Inter,Arial,sans-serif">' + letter + '</text></svg>';
}

/* ─── Payment Route strip (official logos: From → Arc → To) ─── */
function _accEnsureRouteStrip() {
  if (document.getElementById('acc-route-strip')) return;
  const grid = document.querySelector('#tab-content-advanced-crosschain .acc-grid');
  if (!grid || !grid.parentNode) return;
  const strip = document.createElement('div');
  strip.id = 'acc-route-strip';
  strip.style.cssText = 'margin-bottom:16px;background:#0E1422;border:1px solid rgba(110,120,255,.18);border-radius:18px;padding:16px 20px;box-shadow:0 6px 30px rgba(0,0,0,.30);';
  grid.parentNode.insertBefore(strip, grid);
}
function _accNode(chainKey) {
  const c = ACC_CHAINS[chainKey] || {};
  return '<div class="acc-rs-node"><div class="acc-rs-logo">' + _accChainLogo(chainKey) + '</div><div class="acc-rs-name">' + (c.short || chainKey) + '</div></div>';
}
function _accRenderRouteStrip() {
  _accEnsureRouteStrip();
  const el = document.getElementById('acc-route-strip');
  if (!el) return;
  const from = _accState.fromChain, to = _accState.toChain, ARC = 'arc';
  const line = '<div class="acc-rs-line" style="background-size:26px 2px;animation:acc-rs-dash 1s linear infinite;background-image:repeating-linear-gradient(90deg,#6C4CFF 0,#6C4CFF 8px,transparent 8px,transparent 14px);"></div>';
  const nodes = [_accNode(from)];
  if (from !== ARC && to !== ARC) { nodes.push(line, _accNode(ARC)); }
  nodes.push(line, _accNode(to));
  el.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">' +
      '<span style="font-size:13px;font-weight:600;color:#fff;"><i class="fas fa-route" style="color:#4F8CFF;margin-right:7px;"></i>Payment Route</span>' +
      '<span style="font-size:11px;color:#7180A6;">Powered by Arc CCTP</span>' +
    '</div>' +
    '<div style="display:flex;align-items:center;gap:6px;">' + nodes.join('') + '</div>';
}

function _accEnsureExecBar() {
  if (document.getElementById('acc-exec-bar')) return;
  const grid = document.querySelector('#tab-content-advanced-crosschain .acc-grid');
  if (!grid || !grid.parentNode) return;
  const bar = document.createElement('div');
  bar.id = 'acc-exec-bar';
  bar.style.display = 'none';
  grid.parentNode.insertBefore(bar, grid);
}

function _accRenderExecBar() {
  _accEnsureExecBar();
  const bar = document.getElementById('acc-exec-bar');
  if (!bar) return;
  const steps = _accState.execSteps || [];
  const total = steps.length;
  if (!_accState.executing || total === 0) { bar.style.display = 'none'; bar.innerHTML = ''; return; }

  const done   = steps.filter(s => s.status === 'done').length;
  const active  = steps.find(s => s.status === 'active');
  const failed  = steps.find(s => s.status === 'failed');
  const pct     = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
  const label   = failed ? 'Failed' : (active ? active.label : (done === total ? 'Completed' : 'Preparing…'));
  const barColor = failed ? '#f87171' : (pct >= 100 ? '#22c55e' : '#a78bfa');
  const icon    = failed ? '<i class="fas fa-times-circle" style="color:#f87171;"></i> '
                : (pct >= 100 ? '<i class="fas fa-check-circle" style="color:#22c55e;"></i> '
                : '<i class="fas fa-circle-notch fa-spin" style="color:#a78bfa;"></i> ');
  const turbo   = _accState.bridgeMode === 'turbo';
  const badge   = turbo
    ? '<span style="margin-left:8px;font-size:10px;font-weight:700;padding:2px 8px;border-radius:999px;background:rgba(245,158,11,0.16);color:#f59e0b;">⚡ Turbo Bridge</span>'
    : '<span style="margin-left:8px;font-size:10px;font-weight:700;padding:2px 8px;border-radius:999px;background:rgba(96,165,250,0.14);color:#60a5fa;">🌉 Standard</span>';

  const from = ACC_CHAINS[_accState.fromChain] || {};
  const to   = ACC_CHAINS[_accState.toChain] || {};
  const hash = _accState.activeTxHash || '';
  const actBtn = 'display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;padding:6px 12px;border-radius:9px;text-decoration:none;cursor:pointer;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#c7d2e5;transition:all .15s;';
  let actions = '';
  if (hash && from.explorer) actions += '<a style="' + actBtn + '" href="' + from.explorer + '/tx/' + hash + '" target="_blank" rel="noopener"><i class="fas fa-external-link-alt"></i> View Explorer</a>';
  if (hash) actions += '<button style="' + actBtn + '" onclick="accCopyHash()"><i class="fas fa-copy"></i> Copy TX</button>';
  if (to.explorer) actions += '<a style="' + actBtn + '" href="' + to.explorer + '" target="_blank" rel="noopener"><i class="fas fa-bullseye"></i> Destination Explorer</a>';
  actions += '<button style="' + actBtn + '" onclick="if(window.accRefreshBalances)accRefreshBalances()"><i class="fas fa-sync"></i> Refresh Status</button>';

  bar.style.display = '';
  bar.style.marginBottom = '16px';
  bar.innerHTML =
    '<div style="background:linear-gradient(135deg,rgba(167,139,250,0.08),rgba(6,182,212,0.06));border:1px solid rgba(167,139,250,0.22);border-radius:14px;padding:14px 16px;">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px;">' +
        '<div style="display:flex;align-items:center;font-size:13px;font-weight:700;color:#e2e8f0;">' + icon + label + badge + '</div>' +
        '<div style="font-size:16px;font-weight:800;color:' + barColor + ';">' + pct + '%</div>' +
      '</div>' +
      '<div style="height:8px;border-radius:999px;background:rgba(255,255,255,0.06);overflow:hidden;"><div style="height:100%;width:' + pct + '%;background:' + barColor + ';border-radius:999px;transition:width .5s ease;"></div></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">' + actions + '</div>' +
    '</div>';
}

window.accCopyHash = function () {
  try { navigator.clipboard.writeText(_accState.activeTxHash || ''); _accShowToast('Transaction hash copied', 'success'); } catch (e) {}
};

/* ─── Live Activity ─── */
function _accRenderLiveActivity() {
  const fields = [
    ['acc-live-health',      _accState.networkHealth],
    ['acc-live-congestion',  _accState.networkCongestion],
    ['acc-live-rpc',         _accState.rpcStatus],
    ['acc-live-bridge',      _accState.bridgeStatus],
    ['acc-live-avgconf',     _accState.avgConfirmation + 's'],
    ['acc-live-uptime',      _accState.uptime + '%'],
  ];
  fields.forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  });

  // color coding
  const healthEl = document.getElementById('acc-live-health');
  if (healthEl) healthEl.style.color = _accState.networkHealth === 'Good' ? '#22c55e' : '#eab308';
  const congEl = document.getElementById('acc-live-congestion');
  if (congEl) congEl.style.color = _accState.networkCongestion === 'Low' ? '#22c55e' : _accState.networkCongestion === 'Medium' ? '#eab308' : '#f87171';
}

/* ─── History ─── */
function _accRenderHistory() {
  const el = document.getElementById('acc-history-list');
  if (!el) return;

  if (_accState.history.length === 0) {
    el.innerHTML = `
      <div class="acc-empty-state" style="padding:24px;">
        <i class="fas fa-history" style="color:#374151;font-size:22px;"></i>
        <div style="color:#6b7280;margin-top:8px;font-size:13px;">No cross-chain transactions yet</div>
      </div>`;
    return;
  }

  el.innerHTML = _accState.history.slice(0, 10).map(h => {
    const statusColor = h.status === 'completed' ? '#22c55e' : h.status === 'pending' ? '#eab308' : '#f87171';
    const fromShort   = Object.values(ACC_CHAINS).find(c => c.label === h.from)?.short || h.from;
    const toShort     = Object.values(ACC_CHAINS).find(c => c.label === h.to)?.short   || h.to;
    const explorerUrl = (Object.values(ACC_CHAINS).find(c => c.label === h.from)?.explorer || 'https://testnet.arcscan.app') + '/tx/' + (h.txHash || '');
    const isTurboH    = (h.bridgeType === 'Turbo') || (h.provider === 'Turbo Bridge');
    const typeBadge   = isTurboH
      ? '<span style="display:inline-block;margin-left:6px;padding:1px 6px;border-radius:6px;font-size:9px;font-weight:700;background:rgba(245,158,11,0.14);color:#f59e0b;border:1px solid rgba(245,158,11,0.35);"><i class="fas fa-bolt"></i> Turbo</span>'
      : '<span style="display:inline-block;margin-left:6px;padding:1px 6px;border-radius:6px;font-size:9px;font-weight:700;background:rgba(96,165,250,0.12);color:#60a5fa;border:1px solid rgba(96,165,250,0.28);">Standard</span>';
    return `
      <div class="acc-history-row">
        <div class="acc-hist-token">
          <span class="acc-hist-token-badge">USDC</span>
        </div>
        <div class="acc-hist-from">${fromShort}</div>
        <div class="acc-hist-to">${toShort}</div>
        <div class="acc-hist-amount">${_accFmt(h.amount)} USDC</div>
        <div class="acc-hist-recv">${_accFmt(h.received)} USDC</div>
        <div class="acc-hist-status" style="color:${statusColor};">
          <i class="fas fa-circle" style="font-size:6px;vertical-align:middle;margin-right:4px;"></i>
          ${h.status.charAt(0).toUpperCase() + h.status.slice(1)}
        </div>
        <div class="acc-hist-provider">${h.provider}${typeBadge}</div>
        <div class="acc-hist-hash">
          ${h.txHash
            ? `<a href="${explorerUrl}" target="_blank" rel="noopener" style="color:#a78bfa;">${_accShortAddr(h.txHash)}</a>`
            : '<span style="color:#4b5563;">--</span>'}
        </div>
        <div class="acc-hist-time">${_accTimeAgo(h.ts)}</div>
      </div>
    `;
  }).join('');
}

/* ─── Advanced Options ─── */
function _accRenderOptions() {
  const opts = [
    { id: 'acc-opt-auto',     label: 'Auto Route',    icon: 'fas fa-magic',       state: 'autoRoute',       badge: 'Best Route' },
    { id: 'acc-opt-fast',     label: 'Fast Route',    icon: 'fas fa-bolt',        state: 'fastRoute',       badge: '~2m' },
    { id: 'acc-opt-lowest',   label: 'Lowest Cost',   icon: 'fas fa-tag',         state: 'lowestCost',      badge: 'Save Fees' },
    { id: 'acc-opt-highest',  label: 'Highest Output',icon: 'fas fa-arrow-up',    state: 'highestOutput',   badge: 'Max Receive' },
    { id: 'acc-opt-expert',   label: 'Expert Mode',   icon: 'fas fa-terminal',    state: 'expertMode',      badge: 'Advanced' },
    { id: 'acc-opt-gas',      label: 'Gas Strategy',  icon: 'fas fa-gas-pump',    state: 'gasStrategy',     badge: 'Standard' },
    { id: 'acc-opt-preferred',label: 'Preferred Bridge',icon:'fas fa-route',       state: 'preferredBridge', badge: 'Across Protocol' },
    { id: 'acc-opt-retry',    label: 'Retry Failed',  icon: 'fas fa-redo',        state: 'retryFailed',     badge: 'Automatic' },
  ];

  const el = document.getElementById('acc-options-grid');
  if (!el) return;
  el.innerHTML = opts.map(o => {
    const active = _accState[o.state] === true || _accState[o.state] === 'standard' || _accState[o.state] === 'auto' || _accState[o.state] === 'across';
    return `
      <div class="acc-opt-card ${active ? 'acc-opt-active' : ''}" id="${o.id}"
           onclick="accToggleOption('${o.state}', '${o.id}')">
        <div class="acc-opt-icon"><i class="${o.icon}"></i></div>
        <div class="acc-opt-label">${o.label}</div>
        <div class="acc-opt-badge">${o.badge}</div>
      </div>
    `;
  }).join('');
}

function accToggleOption(stateKey, _elId) {
  if (typeof _accState[stateKey] === 'boolean') {
    _accState[stateKey] = !_accState[stateKey];
  }
  _accRenderOptions();
  // Refresh quote if active
  if (_accState.quote) accGetQuote();
}

/* ═══════════════════════════════════════════════════════════
   LIVE ACTIVITY POLLING
   ═══════════════════════════════════════════════════════════ */
let _accLiveInterval = null;

function _accStartLivePolling() {
  if (_accLiveInterval) return;
  _accLiveInterval = setInterval(async () => {
    // Request-optimization: only poll when the crosschain tab is visible
    if (document.hidden) return;
    const tabEl = document.getElementById('tab-content-advanced-crosschain');
    if (tabEl && tabEl.classList.contains('hidden')) return;
    // Check Arc RPC responsiveness
    try {
      const t0 = Date.now();
      await _accRpcCall(ACC_CHAINS.arc.rpc, 'eth_blockNumber', []);
      const latency = Date.now() - t0;
      _accState.networkHealth      = latency < 500 ? 'Good' : latency < 1500 ? 'Degraded' : 'Poor';
      _accState.networkCongestion  = latency < 300 ? 'Low' : latency < 800 ? 'Medium' : 'High';
      _accState.rpcStatus          = 'Operational';
      _accState.bridgeStatus       = 'All Systems Operational';
    } catch(e) {
      _accState.networkHealth     = 'Unknown';
      _accState.rpcStatus         = 'Degraded';
      _accState.bridgeStatus      = 'Check Connection';
    }
    _accRenderLiveActivity();
  }, 60000); // request-optimization: 15s → 60s
  if (window.PollingManager) window.PollingManager.register('acc-live-polling', _accLiveInterval, { ms: 60000, scope: 'tab' });
}

function _accStopLivePolling() {
  if (_accLiveInterval) { clearInterval(_accLiveInterval); _accLiveInterval = null; }
}

/* ═══════════════════════════════════════════════════════════
   TOAST
   ═══════════════════════════════════════════════════════════ */
function _accShowToast(msg, type = 'info') {
  if (typeof window.showToast === 'function') {
    window.showToast(msg, type);
  } else {
    console.log('[ACC Toast]', type, msg);
  }
}

function _accShowError(_context, msg) {
  _accShowToast(msg, 'warning');
}

/* ═══════════════════════════════════════════════════════════
   LAYOUT MODE — visual-only card reflow (FLIP animation)
   'plan' = original planning layout · 'exec' = execution-focused.
   This NEVER touches state, quotes, balances, APIs, polling or DOM
   structure. It only toggles a CSS attribute on the grid and animates
   the resulting position delta, so every card keeps its identity,
   listeners, inputs, scroll and internal values intact.

   Entering 'exec' is delayed (~3s) so the user can read the Best Route
   where it first appeared before the cards reorganise. Returning to
   'plan' (finish/fail/expire/reset) is immediate and cancels any
   pending reflow. Bridge execution can force immediate reflow.
   ═══════════════════════════════════════════════════════════ */
var _accLayoutTimer = null;
var ACC_LAYOUT_EXEC_DELAY = 3000;   // ms to wait before moving cards into exec mode

function _accApplyLayout(target) {
  try {
    var grid = document.querySelector('#tab-content-advanced-crosschain .acc-grid');
    if (!grid) return;
    var current = grid.getAttribute('data-acc-layout') || 'plan';
    if (current === target) return;

    var cards   = Array.prototype.slice.call(grid.children);
    var visible = grid.offsetParent !== null && grid.getBoundingClientRect().height > 0;
    var reduce  = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Not visible or reduced-motion → switch instantly, no animation.
    if (!visible || reduce) { grid.setAttribute('data-acc-layout', target); return; }

    // FLIP · First: capture current geometry
    var first = cards.map(function(c){ return c.getBoundingClientRect(); });
    // Apply the new layout (pure CSS reflow)
    grid.setAttribute('data-acc-layout', target);
    // Last: capture new geometry
    var last = cards.map(function(c){ return c.getBoundingClientRect(); });
    // Invert: move each card back to where it was
    cards.forEach(function(c, i){
      var dx = first[i].left - last[i].left;
      var dy = first[i].top  - last[i].top;
      if (!dx && !dy) return;
      c.style.transition = 'none';
      c.style.transform  = 'translate(' + dx + 'px,' + dy + 'px)';
      c.style.willChange = 'transform';
    });
    // Play: release to natural position with a smooth transition
    requestAnimationFrame(function(){
      cards.forEach(function(c, i){
        var dx = first[i].left - last[i].left;
        var dy = first[i].top  - last[i].top;
        if (!dx && !dy) return;
        c.style.transition = 'transform 460ms cubic-bezier(0.22, 1, 0.36, 1)';
        c.style.transform  = '';
      });
    });
    // Cleanup inline styles after the animation completes
    setTimeout(function(){
      cards.forEach(function(c){ c.style.transition = ''; c.style.transform = ''; c.style.willChange = ''; });
    }, 540);
  } catch (e) { /* visual only — must never break the bridge flow */ }
}

function _accSetLayoutMode(mode, immediate) {
  var target = (mode === 'exec') ? 'exec' : 'plan';
  // Any explicit mode change cancels a pending scheduled reflow.
  if (_accLayoutTimer) { clearTimeout(_accLayoutTimer); _accLayoutTimer = null; }

  // Keep the execution command bar in sync with the layout mode.
  try { if (typeof _accRenderExecBar === 'function') _accRenderExecBar(); } catch (e) {}

  // Return to plan (or forced) → apply right away.
  if (target === 'plan' || immediate) { _accApplyLayout(target); return; }

  // Enter exec → hold for a few seconds, then reorganise.
  var grid    = document.querySelector('#tab-content-advanced-crosschain .acc-grid');
  var current = grid ? (grid.getAttribute('data-acc-layout') || 'plan') : 'plan';
  if (current === 'exec') return;
  _accLayoutTimer = setTimeout(function(){
    _accLayoutTimer = null;
    _accApplyLayout('exec');
  }, ACC_LAYOUT_EXEC_DELAY);
}
window.accSetLayoutMode = _accSetLayoutMode;

/* ═══════════════════════════════════════════════════════════
   PUBLIC API
   ═══════════════════════════════════════════════════════════ */

/* Called by switchTab('advanced-crosschain') via app.js */
window.accInit = function() {
  if (window._accInitialized) {
    // Already initialized — just refresh data if wallet changed
    const curAddr = window.walletState?.address;
    if (curAddr !== window._accLastAddr) {
      window._accLastAddr = curAddr;
      accLoadBalances();
    }
    _accRenderLiveActivity();
    _accRenderHistory();
    _accStartLivePolling();
    return;
  }
  window._accInitialized = true;
  window._accLastAddr    = window.walletState?.address || null;

  // Load persisted history
  _accLoadHistory();

  // Bind wallet events
  document.addEventListener('walletConnected', function() {
    const newAddr = window.walletState?.address;
    if (newAddr !== window._accLastAddr) {
      window._accLastAddr = newAddr;
      const tab = document.getElementById('tab-content-advanced-crosschain');
      if (tab && !tab.classList.contains('hidden')) accLoadBalances();
    }
    _accUpdatePreviewConnectBtn();
  });
  document.addEventListener('walletDisconnected', function() {
    window._accLastAddr    = null;
    _accState.fromBalance  = null;
    _accState.toBalance    = null;
    _accUpdateBalanceUI();
    _accUpdatePreviewConnectBtn();
    _accSetLayoutMode('plan');   // visual-only: wallet disconnected → planning layout
  });

  // Initial render
  _accRenderHero();
  _accRenderChainSelectors();
  _accRenderTimeline();
  _accRenderLiveActivity();
  _accRenderHistory();
  _accRenderOptions();
  _accRenderPreview();

  // Load balances if wallet already connected
  if (window.walletState?.connected) accLoadBalances();

  // Start live polling
  _accStartLivePolling();
  // Initial live poll immediately
  setTimeout(() => _accRenderLiveActivity(), 500);
};

function _accUpdatePreviewConnectBtn() {
  // Re-render preview to update the connect/execute button
  _accRenderPreview();
}

/* Called by switchTab leaving the tab (app.js can call this) */
window.accDestroy = function() {
  _accStopLivePolling();
  _accClearQuoteTimer();
};

/* Public: get best route */
window.accGetQuote = accGetQuote;

/* Public: execute bridge */
window.accExecuteBridge = accExecuteBridge;

/* Public: select provider */
window.accSelectProvider = accSelectProvider;

/* Public: toggle option */
window.accToggleOption = accToggleOption;

/* Public: refresh balances */
window.accRefreshBalances = accLoadBalances;

/* ═══════════════════════════════════════════════════════════
   EVENT BINDINGS (called from HTML via onchange/oninput)
   ═══════════════════════════════════════════════════════════ */
window.accOnFromChainChange = function(val) {
  if (val === _accState.toChain) {
    // Auto-swap to avoid same-chain
    const next = Object.keys(ACC_CHAINS).find(k => k !== val);
    _accState.toChain = next || _accState.fromChain;
  }
  _accState.fromChain = val;
  _accState.fromBalance = null;
  _accState.toBalance   = null;
  _accUpdateBalanceUI();
  _accPopulateSelect('acc-to-chain', _accState.toChain, val);
  if (window.walletState?.connected) accLoadBalances();
  // Clear quote on chain change
  _accState.quote = null;
  _accClearQuoteTimer();
  _accRenderPreview();
  const brEl = document.getElementById('acc-best-route-body');
  if (brEl) brEl.innerHTML = '<div class="acc-preview-placeholder" style="padding:24px;text-align:center;"><i class="fas fa-route" style="color:#374151;font-size:18px;"></i><div style="color:#6b7280;margin-top:6px;font-size:12px;">Select chains and amount, then Get Best Route</div></div>';
};

window.accOnToChainChange = function(val) {
  if (val === _accState.fromChain) {
    const next = Object.keys(ACC_CHAINS).find(k => k !== val);
    _accState.fromChain = next || _accState.toChain;
  }
  _accState.toChain   = val;
  _accState.toBalance = null;
  _accUpdateBalanceUI();
  _accPopulateSelect('acc-from-chain', _accState.fromChain, val);
  if (window.walletState?.connected) accLoadBalances();
  _accState.quote = null;
  _accClearQuoteTimer();
  _accRenderPreview();
};

window.accOnAmountInput = function(val) {
  _accState.amount = val;
  // Reset quote on amount change
  _accState.quote = null;
  _accClearQuoteTimer();
  const brEl = document.getElementById('acc-best-route-body');
  if (brEl && !_accState.quoting) {
    brEl.innerHTML = '<div class="acc-preview-placeholder" style="padding:24px;text-align:center;"><i class="fas fa-route" style="color:#374151;font-size:18px;"></i><div style="color:#6b7280;margin-top:6px;font-size:12px;">Click "Get Best Route" to see available routes</div></div>';
  }
  _accRenderPreview();
};

window.accSetMax = function() {
  const bal = _accState.fromBalance;
  if (bal !== null && bal > 0) {
    _accState.amount = String(Math.floor(bal * 1e6) / 1e6);
    const input = document.getElementById('acc-amount-input');
    if (input) { input.value = _accState.amount; }
    _accRenderPreview();
  }
};

window.accSwapChains = function() {
  const tmp           = _accState.fromChain;
  _accState.fromChain = _accState.toChain;
  _accState.toChain   = tmp;
  const tmpBal        = _accState.fromBalance;
  _accState.fromBalance = _accState.toBalance;
  _accState.toBalance   = tmpBal;
  _accRenderChainSelectors();
  _accUpdateBalanceUI();
  _accState.quote = null;
  _accClearQuoteTimer();
  _accRenderPreview();
};

window.accOnSlippageInput = function(val) {
  const v = parseFloat(val);
  if (!isNaN(v) && v >= 0 && v <= 50) _accState.slippage = v;
};

/* ─── DOMContentLoaded: do NOT auto-init — wait for switchTab call ─── */
document.addEventListener('DOMContentLoaded', function() {
  console.log('[ACC] Advanced Cross-Chain Center module loaded');
});
