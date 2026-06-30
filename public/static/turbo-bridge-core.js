// ============================================================
// Turbo Bridge Core — ExecDaat
// Ported from Elligentt Treasury/Vault system
// External chain → ARC only. Uses real CCTP depositForBurn.
// Treasury liquidity for instant ARC fulfillment.
// ============================================================
'use strict';

(function() {

const VAULT_STORE_KEY  = 'execdaat_vault_v3';
const CCTP_ATTEST_URL  = 'https://iris-api-sandbox.circle.com/attestations/';
const TURBO_FEE_BPS    = 100;  // 1.00%
const SETTLE_FEE_BPS   = 5;    // 0.05% settlement rebate

const TREASURY_VAULT_ADDRESS = '0xbfC9E8F79bd30b912081ae88F9ad0A515F08c2F1';
const TREASURY_OWNER_ADDRESS = '0xA43ABD9Dc38840376d3C469bFBf5951912936c9f';

const TREASURY_ASSETS = {
  usdc: '0x3600000000000000000000000000000000000000',
  eurc: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
};

const TREASURY_DEPOSIT_WHITELIST = [
  '0xA43ABD9Dc38840376d3C469bFBf5951912936c9f',
  '0x01dE545e8Fea5EcAAb78eC2C09E6D98117f7687d',
  '0xBBE4Bf2D53A4A752c0eF21573FA0162BddafCD12',
  '0xC77F058339Bb0ff06554b2D0Efcb0E2FD4852cb0',
];

const TURBO_OPERATORS = [
  '0xA43ABD9Dc38840376d3C469bFBf5951912936c9f',
  '0x01dE545e8Fea5EcAAb78eC2C09E6D98117f7687d',
  '0xBBE4Bf2D53A4A752c0eF21573FA0162BddafCD12',
  '0xC77F058339Bb0ff06554b2D0Efcb0E2FD4852cb0',
];

const TREASURY_VAULT_ABI = [
  "function isOperator(address) view returns (bool)",
  "function intentState(bytes32 intentId) view returns (uint8)",
  "function turboFeeBps() view returns (uint256)",
  "function setTurboFeeBps(uint256) external",
  "function fulfillAndPayWithFee(address asset, uint256 grossAmount, uint256 feeAmount, bytes32 intentId, address receiver) external",
  "function getReserves(address asset) view returns (uint256 available, uint256 locked, uint256 pendingSettlement, uint256 pendingRepayment)",
  "event TurboFeeCollected(bytes32 indexed intentId, address indexed asset, uint256 feeAmount)",
  "event TurboFeeUpdated(uint256 oldBps, uint256 newBps)",
  "event IntentCreated(bytes32 indexed intentId, address indexed creator, address asset, uint256 grossAmount, uint256 feeAmount, address indexed receiver)",
  "event IntentFulfilled(bytes32 indexed intentId, address fulfiller)",
  "event IntentSettled(bytes32 indexed intentId, address settler, uint256 settledAmount)",
  "event IntentFailed(bytes32 indexed intentId, string reason)",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
const _fmt = (n) => { if (!n && n !== 0) return '0'; return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
const _log  = (...a) => console.log('%c[TURBO]', 'color:#f59e0b', ...a);
const _warn = (...a) => console.warn('%c[TURBO]', 'color:#f59e0b', ...a);
const _err  = (...a) => console.error('%c[TURBO]', 'color:#f59e0b', ...a);
const shortAddr = (a) => a ? a.slice(0,6)+'…'+a.slice(-4) : '—';

function isTurboOperator(addr) {
  if (!addr) return false;
  return TURBO_OPERATORS.some(a => a.toLowerCase() === addr.toLowerCase());
}

async function fetchTurboFeeBps() {
  try {
    if (!window.ethers) return TURBO_FEE_BPS;
    const rpc = 'https://rpc.testnet.arc.network';
    const p = new window.ethers.JsonRpcProvider(rpc);
    const vc = new window.ethers.Contract(TREASURY_VAULT_ADDRESS, TREASURY_VAULT_ABI, p);
    const bps = await vc.turboFeeBps();
    return Number(bps);
  } catch(e) { return TURBO_FEE_BPS; }
}

function toUsdc(s) {
  return window.ethers?.parseUnits ? window.ethers.parseUnits(s, 6) : BigInt(Math.floor(parseFloat(s) * 1e6));
}
function fromUsdc(n) {
  return window.ethers?.formatUnits ? window.ethers.formatUnits(n, 6) : (Number(n) / 1e6).toString();
}

// ─── VaultStore ──────────────────────────────────────────────────────────────
const VaultStore = (() => {
  const _empty = () => ({
    version: 3,
    intents: [],
    fees: { standard: 0, turbo: 0, settlement: 0 },
    bridgeVolume: { standard: 0, turbo: 0, stdCount: 0, turboCount: 0 },
    lockedAmounts: {},
    pendingSettlementAmounts: {},
    pendingRepaymentAmounts: {},
    turboFeeCollected: {},
    chainBalances: {},
    rebalConfig: {},
    lastChainFetch: 0,
  });
  let _s = null;

  function load() {
    try {
      const raw = localStorage.getItem(VAULT_STORE_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        _s = Object.assign(_empty(), p);
        _s.fees = Object.assign(_empty().fees, p.fees || {});
        _s.bridgeVolume = Object.assign(_empty().bridgeVolume, p.bridgeVolume || {});
        _s.lockedAmounts = Object.assign(_empty().lockedAmounts, p.lockedAmounts || {});
        _s.pendingSettlementAmounts = Object.assign(_empty().pendingSettlementAmounts, p.pendingSettlementAmounts || {});
        _s.pendingRepaymentAmounts = Object.assign(_empty().pendingRepaymentAmounts, p.pendingRepaymentAmounts || {});
        _s.turboFeeCollected = Object.assign(_empty().turboFeeCollected, p.turboFeeCollected || {});
        _s.chainBalances = p.chainBalances || {};
        _s.rebalConfig = Object.assign(_empty().rebalConfig, p.rebalConfig || {});
      } else {
        _s = _empty();
      }
    } catch(e) { _s = _empty(); }
    return _s;
  }

  function save() { try { localStorage.setItem(VAULT_STORE_KEY, JSON.stringify(_s)); } catch(e) {} }

  function get()   { if (!_s) load(); return _s; }
  function mutate(fn) { if (!_s) load(); fn(_s); save(); }

  function lockFunds(asset, amount) {
    mutate(s => { s.lockedAmounts[asset] = (s.lockedAmounts[asset] || 0) + amount; });
  }
  function addTurboFee(asset, amount) {
    mutate(s => {
      s.turboFeeCollected[asset] = (s.turboFeeCollected[asset] || 0) + amount;
      s.fees.turbo = (s.fees.turbo || 0) + amount;
    });
  }
  function addVolume(mode, amount) {
    mutate(s => {
      if (mode === 'turbo') {
        s.bridgeVolume.turbo = (s.bridgeVolume.turbo || 0) + amount;
        s.bridgeVolume.turboCount = (s.bridgeVolume.turboCount || 0) + 1;
      } else {
        s.bridgeVolume.standard = (s.bridgeVolume.standard || 0) + amount;
        s.bridgeVolume.stdCount = (s.bridgeVolume.stdCount || 0) + 1;
      }
    });
  }

  return { get, mutate, load, lockFunds, addTurboFee, addVolume };
})();

// ─── VaultAccounting ─────────────────────────────────────────────────────────
const VaultAccounting = (() => {
  let _cachedAvailable = null;
  let _lastFetch = 0;
  const CACHE_TTL = 30000; // 30s

  async function fetchOnChainReserves() {
    try {
      if (!window.ethers) return null;
      const rpc = 'https://rpc.testnet.arc.network';
      const p = new window.ethers.JsonRpcProvider(rpc);
      const vc = new window.ethers.Contract(TREASURY_VAULT_ADDRESS, TREASURY_VAULT_ABI, p);
      const [availableRaw, lockedRaw] = await vc.getReserves(TREASURY_ASSETS.usdc);
      const available = parseFloat(window.ethers.formatUnits(availableRaw, 6));
      const locked = parseFloat(window.ethers.formatUnits(lockedRaw, 6));
      VaultStore.mutate(s => {
        s.chainBalances['usdc'] = { available, locked };
        s.lastChainFetch = Date.now();
      });
      _cachedAvailable = available;
      _lastFetch = Date.now();
      _log('[VAULT] On-chain reserves: available=' + available + ' locked=' + locked);
      return available;
    } catch(e) {
      _warn('[VAULT] Failed to fetch on-chain reserves:', e.message || e);
      return null;
    }
  }

  function getTotalAvailable(asset) {
    const s = VaultStore.get();
    const cached = (s.chainBalances[asset] || {}).available;
    if (cached !== undefined && cached !== null) return cached;
    return 0;
  }

  async function ensureAvailable(asset) {
    if (_cachedAvailable !== null && (Date.now() - _lastFetch) < CACHE_TTL) return _cachedAvailable;
    return await fetchOnChainReserves();
  }

  function getTotalFees() {
    const s = VaultStore.get();
    return (s.fees.standard || 0) + (s.fees.turbo || 0) + (s.fees.settlement || 0);
  }

  return { getTotalAvailable, getTotalFees, fetchOnChainReserves, ensureAvailable };
})();

// ─── RepaymentContract ───────────────────────────────────────────────────────
const RepaymentContract = (() => {
  const STORAGE_KEY = 'execdaat_repayment_v3';

  function getAll() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch(e) { return []; }
  }
  function saveAll(arr) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(arr)); } catch(e) {}
  }

  function createIntent({ asset, amount, userAddress, srcChain, dstChain, txHash, sourceDomain }) {
    const id = 'intent_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const feeAmount = (amount * TURBO_FEE_BPS) / 10000;
    const grossAmount = amount;
    const intentBytes32 = window.ethers.id ? window.ethers.id(id) : id;

    const intent = {
      id, intentId: id, intentBytes32,
      asset, grossAmount, feeAmount, netAmount: grossAmount - feeAmount,
      userAddress, srcChain, dstChain, sourceDomain,
      txHash, status: 'Created',
      createdAt: Date.now(), updatedAt: Date.now(),
    };

    const all = getAll();
    all.unshift(intent);
    if (all.length > 50) all.length = 50;
    saveAll(all);

    VaultStore.mutate(s => { s.intents.unshift(intent); });
    _log('[INTENT] Created:', id, 'amount:', amount, 'fee:', feeAmount);
    return id;
  }

  async function fulfill(intentId, txHash) {
    const all = getAll();
    const idx = all.findIndex(i => i.id === intentId);
    if (idx === -1) throw new Error('Intent not found: ' + intentId);

    const intent = all[idx];
    if (!window.walletState?.address) throw new Error('WALLET_NOT_CONNECTED');
    if (!window.ethers) throw new Error('ETHERS_NOT_LOADED');

    const assetAddr = TREASURY_ASSETS[intent.asset];
    const rawGross = toUsdc(intent.grossAmount.toFixed(6));
    const rawFee   = toUsdc(intent.feeAmount.toFixed(6));
    const bytes32  = intent.intentBytes32;

    const provider = new window.ethers.BrowserProvider(window.walletState.provider);
    const signer = await provider.getSigner();
    const vaultWrite = new window.ethers.Contract(TREASURY_VAULT_ADDRESS, TREASURY_VAULT_ABI, signer);

    let isOp = false;
    try { isOp = await vaultWrite.isOperator(await signer.getAddress()); } catch(e) {}
    if (!isOp) throw new Error('NOT_OPERATOR');

    const tx = await vaultWrite.fulfillAndPayWithFee(assetAddr, rawGross, rawFee, bytes32, intent.userAddress);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error('FULFILL_FAILED');

    intent.status = 'Fulfilled';
    intent.arcTxHash = tx.hash;
    intent.arcFulfillmentTimestamp = Date.now();
    intent.updatedAt = Date.now();

    VaultStore.lockFunds(intent.asset, intent.grossAmount);
    VaultStore.addTurboFee(intent.asset, intent.feeAmount);
    VaultStore.addVolume('turbo', intent.grossAmount);

    saveAll(all);
    _log('[INTENT] Fulfilled:', intentId, 'arcTX:', shortAddr(tx.hash));
    return { success: true, arcTxHash: tx.hash };
  }

  function initiateSettlement(intentId, cctpMsgHash, sourceDomain) {
    const all = getAll();
    const idx = all.findIndex(i => i.id === intentId);
    if (idx === -1) return;
    all[idx].settlementStarted = true;
    all[idx].cctpMsgHash = cctpMsgHash;
    all[idx].updatedAt = Date.now();
    saveAll(all);
  }

  function verifyAndSettle(intentId, { attestation, mintTxHash }) {
    const all = getAll();
    const idx = all.findIndex(i => i.id === intentId);
    if (idx === -1) return;
    all[idx].status = 'Settled';
    all[idx].settlementTxHash = mintTxHash || all[idx].settlementTxHash;
    all[idx].settledAt = Date.now();
    all[idx].updatedAt = Date.now();
    saveAll(all);
  }

  function markFailed(intentId, reason) {
    const all = getAll();
    const idx = all.findIndex(i => i.id === intentId);
    if (idx === -1) return;
    all[idx].status = 'Failed';
    all[idx].settlementError = reason;
    all[idx].updatedAt = Date.now();
    saveAll(all);
  }

  return { getAll, createIntent, fulfill, initiateSettlement, verifyAndSettle, markFailed };
})();

// ─── FulfillerEngine ─────────────────────────────────────────────────────────
const FulfillerEngine = (() => {
  const _activePollerTimers = {};

  async function execute(srcChainId, dstChainId, asset, amount, userAddress, onProgress) {
    const wallet = window.walletState?.address;
    if (!wallet) throw new Error('WALLET_NOT_CONNECTED');

    const fromKey = Object.keys(window.BRIDGE_CHAINS || {}).find(k => window.BRIDGE_CHAINS[k].chainId === (typeof srcChainId === 'number' ? srcChainId : window.BRIDGE_CHAINS[srcChainId]?.chainId));
    if (!fromKey) throw new Error('UNKNOWN_SOURCE_CHAIN: ' + srcChainId);
    const fromChain = window.BRIDGE_CHAINS[fromKey];
    const toChain = window.BRIDGE_CHAINS['arc'] || Object.values(window.BRIDGE_CHAINS).find(c => c.chainId === 5042002);
    if (!toChain) throw new Error('ARC_CHAIN_NOT_CONFIGURED');

    if (onProgress) onProgress(0, 'Switching to ' + fromChain.shortName + '...');

    const rawProvider = window.walletState.provider;
    const p = new window.ethers.BrowserProvider(rawProvider);
    await rawProvider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: fromChain.chainHex }] });
    const signer = await p.getSigner();

    if (onProgress) onProgress(1, 'Approving USDC...');

    const usdcAbi = ['function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)'];
    const usdc = new window.ethers.Contract(fromChain.usdcAddress, usdcAbi, signer);
    const amtBig = toUsdc(amount.toFixed(6));

    const allowance = await usdc.allowance(wallet, fromChain.tokenMessengerV2);
    if (allowance < amtBig) {
      const approveTx = await usdc.approve(fromChain.tokenMessengerV2, amtBig);
      await approveTx.wait();
    }

    if (onProgress) onProgress(2, 'Burning via CCTP on ' + fromChain.shortName + '...');

    const tmAbi = ['function depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32) external returns (uint64)'];
    const tm = new window.ethers.Contract(fromChain.tokenMessengerV2, tmAbi, signer);
    const destAddr32 = window.ethers.zeroPadValue(TREASURY_VAULT_ADDRESS, 32);
    const zero32 = window.ethers.zeroPadValue('0x0000000000000000000000000000000000000000', 32);
    const maxFee = window.ethers.parseUnits('0.5', 6);

    const burnTx = await tm.depositForBurn(amtBig, toChain.domain, destAddr32, fromChain.usdcAddress, zero32, maxFee, 2000);
    const burnReceipt = await burnTx.wait();
    if (!burnReceipt || burnReceipt.status !== 1) throw new Error('depositForBurn failed');

    _log('[Fulfiller] Burn confirmed:', shortAddr(burnTx.hash));

    let cctpMsgBytes = null, cctpMsgHash = null;
    try {
      const mtIface = new window.ethers.Interface(['event MessageSent(bytes message)']);
      for (const log of burnReceipt.logs) {
        try {
          const parsed = mtIface.parseLog({ topics: log.topics, data: log.data });
          if (parsed?.name === 'MessageSent') { cctpMsgBytes = parsed.args.message; cctpMsgHash = window.ethers.keccak256(cctpMsgBytes); break; }
        } catch(e) {}
      }
    } catch(e) {}

    const intentId = RepaymentContract.createIntent({
      asset, amount, userAddress,
      srcChain: fromKey, dstChain: 'arc',
      txHash: burnTx.hash, sourceDomain: fromChain.domain,
    });

    if (cctpMsgBytes) {
      VaultStore.mutate(s => {
        const i = s.intents.find(x => x.id === intentId);
        if (i) { i._cctpMessageBytes = cctpMsgBytes; i._cctpMessageHash = cctpMsgHash; i.cctpMsgHash = cctpMsgHash; }
      });
    }

    if (onProgress) onProgress(3, 'Switching to ARC for fulfillment...');
    await rawProvider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: toChain.chainHex }] });

    if (onProgress) onProgress(3, 'Locking Treasury liquidity (1% fee)...');
    try {
      await RepaymentContract.fulfill(intentId, burnTx.hash);
    } catch(fulfillErr) {
      VaultStore.mutate(s => {
        const i = s.intents.find(x => x.id === intentId);
        if (i && i.status === 'Created') {
          i.status = 'Awaiting Operator';
          i.settlementError = 'Awaiting operator: ' + ((fulfillErr.shortMessage || fulfillErr.message || '').slice(0, 80));
          i.lastAttempt = Date.now();
        }
      });
      _startOperatorFulfillmentPoller(intentId);
    }

    const intentAfter = RepaymentContract.getAll().find(i => i.id === intentId);
    if (intentAfter && intentAfter.status === 'Fulfilled') {
      if (onProgress) onProgress(4, 'Turbo complete — CCTP settling...');
      RepaymentContract.initiateSettlement(intentId, burnTx.hash, fromChain.domain);
      _startSettlementPoller(intentId, fromChain, burnTx.hash);
    } else {
      if (onProgress) onProgress(4, 'Turbo queued — operator will fulfill');
    }

    return { intentId, txHash: burnTx.hash };
  }

  function _startOperatorFulfillmentPoller(intentId) {
    const maxPolls = 300;
    let pollCount = 0;
    const INTERVAL = 6000;

    VaultStore.mutate(s => {
      const i = s.intents.find(x => x.id === intentId);
      if (i) { i.lastPollAt = Date.now(); i.pollCount = 0; i.lastError = null; }
    });

    const ARC_READ_PROVIDER = new window.ethers.JsonRpcProvider('https://rpc.testnet.arc.network');

    const timer = setInterval(async () => {
      pollCount++;
      const intent = RepaymentContract.getAll().find(i => i.id === intentId);
      if (!intent || !['Created','Awaiting Operator'].includes(intent.status)) {
        clearInterval(timer); delete _activePollerTimers['op-' + intentId]; return;
      }

      VaultStore.mutate(s => { const i = s.intents.find(x => x.id === intentId); if (i) { i.lastPollAt = Date.now(); i.pollCount = pollCount; } });

      try {
        const vc = new window.ethers.Contract(TREASURY_VAULT_ADDRESS, TREASURY_VAULT_ABI, ARC_READ_PROVIDER);
        const state = await vc.intentState(intent.intentBytes32);
        if (Number(state) === 2) {
          clearInterval(timer); delete _activePollerTimers['op-' + intentId];
          _log('[OPERATOR] Fulfillment detected on-chain:', intentId);
          VaultStore.lockFunds(intent.asset, intent.grossAmount);
          VaultStore.addTurboFee(intent.asset, intent.feeAmount);
          VaultStore.addVolume('turbo', intent.grossAmount);
          VaultStore.mutate(s => {
            const i = s.intents.find(x => x.id === intentId);
            if (i) { i.status = 'Fulfilled'; i.arcFulfillmentTimestamp = Date.now(); i.updatedAt = Date.now(); }
          });
          RepaymentContract.initiateSettlement(intentId, intent.cctpMsgHash || intent.txHash, intent.sourceDomain);
          _startSettlementPoller(intentId, null, intent.txHash || intent.cctpMsgHash);
        } else if (Number(state) === 3) {
          clearInterval(timer); delete _activePollerTimers['op-' + intentId];
          RepaymentContract.verifyAndSettle(intentId, { mintTxHash: 'on-chain-settled' });
        } else if (Number(state) === 4) {
          clearInterval(timer); delete _activePollerTimers['op-' + intentId];
          RepaymentContract.markFailed(intentId, 'On-chain failed');
        }
      } catch(e) {}

      if (pollCount >= maxPolls) {
        clearInterval(timer); delete _activePollerTimers['op-' + intentId];
        VaultStore.mutate(s => { const i = s.intents.find(x => x.id === intentId); if (i) i.lastError = 'Operator fulfillment timed out'; });
        RepaymentContract.markFailed(intentId, 'Operator fulfillment timed out');
      }
    }, INTERVAL);
    _activePollerTimers['op-' + intentId] = timer;
  }

  function _startSettlementPoller(intentId, fromChain, burnHash) {
    const maxPolls = 120;
    let pollCount = 0;
    const INTERVAL = 5000;

    const timer = setInterval(async () => {
      pollCount++;
      const intent = RepaymentContract.getAll().find(i => i.id === intentId);
      if (!intent || ['Settled','Failed'].includes(intent.status)) {
        clearInterval(timer); delete _activePollerTimers['settle-' + intentId]; return;
      }

      try {
        const msgHash = intent.cctpMsgHash || burnHash;
        if (!msgHash) { clearInterval(timer); return; }
        const resp = await fetch(CCTP_ATTEST_URL + msgHash);
        if (resp.status === 200) {
          const data = await resp.json();
          if (data.status === 'complete' && data.attestation) {
            clearInterval(timer); delete _activePollerTimers['settle-' + intentId];
            _log('[SETTLE] Attestation complete:', intentId);
            RepaymentContract.verifyAndSettle(intentId, { attestation: data.attestation, mintTxHash: 'attested' });
          }
        }
      } catch(e) {}

      if (pollCount >= maxPolls) {
        clearInterval(timer); delete _activePollerTimers['settle-' + intentId];
      }
    }, INTERVAL);
    _activePollerTimers['settle-' + intentId] = timer;
  }

  return { execute, _startOperatorFulfillmentPoller, _startSettlementPoller };
})();

// ─── TurboExecutor ────────────────────────────────────────────────────────────
const TurboExecutor = (() => {
  function checkLiquidity() {
    const avail = VaultAccounting.getTotalAvailable('usdc');
    const badge = document.getElementById('turbo-avail-badge');
    if (badge) {
      if (avail > 1) {
        badge.innerHTML = '<i class="fas fa-bolt"></i> Treasury Pool Available (' + _fmt(avail) + ' USDC)';
        badge.className = 'turbo-avail-badge available';
      } else {
        badge.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Insufficient Treasury Liquidity';
        badge.className = 'turbo-avail-badge unavailable';
      }
    }
    return avail;
  }

  async function execute(srcChainId, dstChainId, asset, amount, userAddress, onStep) {
    // Fetch on-chain reserves first
    await VaultAccounting.ensureAvailable(asset);
    const avail = VaultAccounting.getTotalAvailable(asset);
    if (avail < amount) {
      var warnMsg = 'Treasury liquidity low (' + _fmt(avail) + ' available, need ' + amount + '). ';
      if (window.isTurboOperator && window.isTurboOperator(window.walletState?.address)) {
        warnMsg += 'Falling back to operator fulfillment queue.';
      } else {
        warnMsg += 'Intent will queue for operator fulfillment.';
      }
      _warn('[Turbo] ' + warnMsg);
    }
    return await FulfillerEngine.execute(srcChainId, dstChainId, asset, amount, userAddress, onStep);
  }

  return { execute, checkLiquidity };
})();

// ─── Expose to window ─────────────────────────────────────────────────────────
window.TurboExecutor      = TurboExecutor;
window.VaultStore         = VaultStore;
window.VaultAccounting    = VaultAccounting;
window.RepaymentContract  = RepaymentContract;
window.FulfillerEngine    = FulfillerEngine;
window.TURBO_FEE_BPS      = TURBO_FEE_BPS;
window.TURBO_OPERATORS    = TURBO_OPERATORS;
window.isTurboOperator    = isTurboOperator;
window.fetchTurboFeeBps   = fetchTurboFeeBps;
window.TREASURY_VAULT_ADDRESS = TREASURY_VAULT_ADDRESS;

VaultStore.load();
_log('Turbo Bridge Core loaded — Vault v3, TreasuryVault:', shortAddr(TREASURY_VAULT_ADDRESS));

})();
