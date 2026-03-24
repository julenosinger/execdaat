// ============================================================
//  ARC DEX — Real On-Chain AMM · EURC / USDC Pool
//  Arc Testnet · ChainId 5042002 · x * y = k
//
//  Zero mock data. All state comes directly from SimpleAMM
//  contract on Arc Testnet via ethers.js + MetaMask signer.
//
//  Tokens:
//    EURC  0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a (ERC-20, 6 dec)
//    USDC  0x3600000000000000000000000000000000000000 (ERC-20, 6 dec)
//
//  AMM Formula: amountOut = (rOut * amIn * 997) / (rIn * 1000 + amIn * 997)
// ============================================================
'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const AMM_CHAIN_ID  = 5042002;
const AMM_CHAIN_HEX = '0x4cef52';
const AMM_EXPLORER  = 'https://testnet.arcscan.app';
const AMM_RPC       = 'https://rpc.testnet.arc.network';

const AMM_TOKENS = {
  EURC: { symbol: 'EURC', name: 'Euro Coin', address: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a', decimals: 6, logo: '💶' },
  USDC: { symbol: 'USDC', name: 'USD Coin',  address: '0x3600000000000000000000000000000000000000', decimals: 6, logo: '💵' },
};

const AMM_ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
];

const AMM_ABI = [
  'function tokenA() view returns (address)',
  'function tokenB() view returns (address)',
  'function reserveA() view returns (uint256)',
  'function reserveB() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function getReserves() view returns (uint256,uint256)',
  'function getAmountOut(uint256 amountIn, uint256 rIn, uint256 rOut) pure returns (uint256)',
  'function quoteAforB(uint256 amountA) view returns (uint256)',
  'function quoteBforA(uint256 amountB) view returns (uint256)',
  'function priceImpactBps(uint256 amountIn, bool aToB) view returns (uint256)',
  'function addLiquidity(uint256 amountA, uint256 amountB) returns (uint256 lpMinted)',
  'function removeLiquidity(uint256 lpAmount) returns (uint256 amountA, uint256 amountB)',
  'function swapAforB(uint256 amountA, uint256 minOut) returns (uint256 amountOut)',
  'function swapBforA(uint256 amountB, uint256 minOut) returns (uint256 amountOut)',
  'event LiquidityAdded(address indexed provider, uint256 amountA, uint256 amountB, uint256 lpMinted, uint256 reserveA, uint256 reserveB)',
  'event LiquidityRemoved(address indexed provider, uint256 amountA, uint256 amountB, uint256 lpBurned, uint256 reserveA, uint256 reserveB)',
  'event Swap(address indexed trader, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, uint256 reserveA, uint256 reserveB)',
];

// ─── State ────────────────────────────────────────────────────────────────────
const ammState = {
  tab:         'swap',
  ammAddress:  null,
  deployed:    false,
  reserves:    { A: 0n, B: 0n },
  totalSupply: 0n,
  balances:    { EURC: 0n, USDC: 0n, LP: 0n },
  swapFrom:    'EURC',
  swapTo:      'USDC',
  slippage:    0.5,
  pending:     false,
  quote:       null,
  poolLoaded:  false,   // lazy: only load pool when Liquidity tab is open
};

// ─── DOM helpers ──────────────────────────────────────────────────────────────
const $       = id  => document.getElementById(id);
const setText = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
const setVal  = (id, val) => { const el = $(id); if (el) el.value = val; };
const show    = id  => { const el = $(id); if (el) el.classList.remove('hidden'); };
const hide    = id  => { const el = $(id); if (el) el.classList.add('hidden'); };

// ─── ethers helpers ──────────────────────────────────────────────────────────
// walletState.provider is the raw EIP-1193 object (window.ethereum / WalletConnect)
function _getEthersProvider() {
  const raw = window.walletState?.provider;
  if (!raw) throw new Error('Wallet not connected. Please connect your wallet first.');
  if (window.ethers?.BrowserProvider)
    return new window.ethers.BrowserProvider(raw);
  if (window.ethers?.providers?.Web3Provider)
    return new window.ethers.providers.Web3Provider(raw);
  throw new Error('ethers.js not loaded. Refresh the page.');
}

async function _getSigner() {
  const provider = _getEthersProvider();
  return provider.getSigner();
}

async function _getERC20(symbol) {
  const signer = await _getSigner();
  return new window.ethers.Contract(AMM_TOKENS[symbol].address, AMM_ERC20_ABI, signer);
}

async function _getAMM() {
  if (!ammState.ammAddress || ammState.ammAddress === '0x0000000000000000000000000000000000000000')
    throw new Error('SimpleAMM not deployed yet.');
  const signer = await _getSigner();
  return new window.ethers.Contract(ammState.ammAddress, AMM_ABI, signer);
}

// ─── Unit helpers ─────────────────────────────────────────────────────────────
function ammParseUnits(humanAmount, decimals = 6) {
  let s = String(humanAmount).trim();
  if (!s || s === '' || s === '.') s = '0';
  if (/[eE]/.test(s)) s = Number(s).toFixed(decimals);
  const dot = s.indexOf('.');
  if (dot !== -1 && s.length - dot - 1 > decimals)
    s = s.slice(0, dot + decimals + 1);
  if (window.ethers?.parseUnits) {
    try { return window.ethers.parseUnits(s, decimals); } catch (_) {}
  }
  const [int = '0', frac = ''] = s.split('.');
  const f = frac.slice(0, decimals).padEnd(decimals, '0');
  return BigInt(int) * BigInt(10 ** decimals) + BigInt(f);
}

function ammFormatUnits(raw, decimals = 6) {
  if (window.ethers?.formatUnits) return window.ethers.formatUnits(raw, decimals);
  return (Number(raw) / 10 ** decimals).toFixed(6);
}

// ─── Network guard ────────────────────────────────────────────────────────────
async function _ensureNetwork() {
  const prov = window.walletState?.provider;
  if (!prov) throw new Error('Connect wallet first.');
  const chainHex = await prov.request({ method: 'eth_chainId' });
  if (parseInt(chainHex, 16) === AMM_CHAIN_ID) return; // already correct

  try {
    await prov.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: AMM_CHAIN_HEX }] });
  } catch (e) {
    if (e.code === 4902 || e.code === -32603) {
      await prov.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: AMM_CHAIN_HEX,
          chainName: 'Arc Testnet',
          nativeCurrency: { name: 'tARC', symbol: 'tARC', decimals: 18 },
          rpcUrls: [AMM_RPC],
          blockExplorerUrls: [AMM_EXPLORER],
        }],
      });
    } else {
      throw e;
    }
  }
}

// ─── Approve helper ───────────────────────────────────────────────────────────
// Approves spender to use `amount` of `tokenSymbol`.
// Uses MaxUint256 so the user only needs to approve once.
async function _ensureApproval(tokenSymbol, spender, amount) {
  const wallet  = window.walletState?.address;
  const erc20   = await _getERC20(tokenSymbol);
  const current = await erc20.allowance(wallet, spender);

  console.log(`[AMM:approve] ${tokenSymbol} allowance=${current} needed=${amount}`);

  if (current >= amount) {
    console.log(`[AMM:approve] ${tokenSymbol} — sufficient allowance, skipping`);
    return;
  }

  // Use MaxUint256 to avoid repeated approvals
  const MAX = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
  showToast(`📝 Approve ${tokenSymbol} — confirm in wallet…`, 'info');
  const tx = await erc20.approve(spender, MAX);
  console.log(`[AMM:approve] ${tokenSymbol} approve tx: ${tx.hash}`);
  showToast(`⏳ Approving ${tokenSymbol}… ${tx.hash.slice(0, 14)}`, 'info');
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1)
    throw new Error(`${tokenSymbol} approval failed on-chain (tx reverted)`);
  console.log(`[AMM:approve] ${tokenSymbol} approved. Block: ${receipt.blockNumber}`);
  showToast(`✅ ${tokenSymbol} approved!`, 'success');
}

// ─── Fetch pool state from backend ────────────────────────────────────────────
async function ammFetchPoolState() {
  const res  = await fetch('/api/dex/amm');
  const data = await res.json();
  if (data.success && data.deployed) {
    ammState.ammAddress  = data.ammAddress;
    ammState.deployed    = true;
    ammState.reserves.A  = BigInt(data.reserveA);
    ammState.reserves.B  = BigInt(data.reserveB);
    ammState.totalSupply = BigInt(data.totalSupply);
  } else {
    ammState.deployed   = false;
    ammState.ammAddress = data.ammAddress || null;
  }
  return data;
}

// ─── Fetch on-chain balances ──────────────────────────────────────────────────
async function ammFetchBalances() {
  const wallet = window.walletState?.address;
  if (!wallet) return;
  try {
    const res  = await fetch(`/api/dex/amm/balances/${wallet}`);
    const data = await res.json();
    if (data.success) {
      ammState.balances.EURC = BigInt(data.balances.EURC.raw);
      ammState.balances.USDC = BigInt(data.balances.USDC.raw);
      ammState.balances.LP   = BigInt(data.balances.LP.raw);
      _updateBalanceUI();
    }
  } catch (e) {
    console.warn('[AMM] fetchBalances error:', e.message);
  }
}

// ─── Pure AMM quote ───────────────────────────────────────────────────────────
function _ammQuote(amountIn, rIn, rOut) {
  if (amountIn === 0n || rIn === 0n || rOut === 0n) return 0n;
  const amountInFee = amountIn * 997n;
  return (amountInFee * rOut) / (rIn * 1000n + amountInFee);
}

// ─── Update balance UI ────────────────────────────────────────────────────────
function _updateBalanceUI() {
  const eurc = ammFormatUnits(ammState.balances.EURC);
  const usdc = ammFormatUnits(ammState.balances.USDC);
  const lp   = ammFormatUnits(ammState.balances.LP);
  const fmtE = parseFloat(eurc).toFixed(4);
  const fmtU = parseFloat(usdc).toFixed(4);
  const fmtL = parseFloat(lp).toFixed(4);

  setText('amm-bal-eurc',         fmtE + ' EURC');
  setText('amm-bal-usdc',         fmtU + ' USDC');
  setText('amm-bal-lp',           fmtL + ' LP');
  setText('amm-liq-eurc-bal',     'Bal: ' + fmtE);
  setText('amm-liq-usdc-bal',     'Bal: ' + fmtU);
  setText('amm-liq-lp-bal-label', 'LP: ' + fmtL);

  const swapFromBal = ammState.swapFrom === 'EURC' ? fmtE : fmtU;
  setText('amm-swap-from-bal', swapFromBal + ' ' + ammState.swapFrom);
}

// ─── Update pool UI (right panel — Liquidity tab only) ───────────────────────
function _updatePoolUI(data) {
  if (!data || !data.deployed) {
    setText('amm-reserve-a', '—');
    setText('amm-reserve-b', '—');
    setText('amm-price-a',   '—');
    setText('amm-price-b',   '—');
    setText('amm-tvl',       '$0.00');
    show('amm-deploy-notice');
    return;
  }
  hide('amm-deploy-notice');
  const rA    = parseFloat(data.reserveAHuman || 0);
  const rB    = parseFloat(data.reserveBHuman || 0);
  const hasLiq = rA > 0 && rB > 0;
  const fmt4  = v => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });

  setText('amm-reserve-a', hasLiq ? fmt4(rA) + ' EURC' : 'Empty');
  setText('amm-reserve-b', hasLiq ? fmt4(rB) + ' USDC' : 'Empty');
  setText('amm-price-a',   hasLiq ? parseFloat(data.priceAinB).toFixed(6) + ' USDC' : '—');
  setText('amm-price-b',   hasLiq ? parseFloat(data.priceBinA).toFixed(6) + ' EURC' : '—');
  const tvl = hasLiq ? parseFloat(data.tvl || 0) : 0;
  setText('amm-tvl', '$' + tvl.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  if (data.ammAddress) setText('amm-addr-display', data.ammAddress);
}

// ─── Swap quote ───────────────────────────────────────────────────────────────
function ammComputeSwapQuote() {
  const inputEl  = $('amm-swap-input');
  const outputEl = $('amm-swap-output');
  if (!inputEl || !outputEl) return;

  const rawInput = inputEl.value.trim();
  if (!rawInput || parseFloat(rawInput) <= 0) {
    outputEl.value = '';
    setText('amm-swap-impact', '—');
    setText('amm-swap-min',    '—');
    setText('amm-swap-rate',   '—');
    setText('amm-swap-fee',    '—');
    ammState.quote = null;
    _updateSwapBtn();
    return;
  }

  const amountIn = ammParseUnits(rawInput);
  const aToB     = ammState.swapFrom === 'EURC';
  const rIn      = aToB ? ammState.reserves.A : ammState.reserves.B;
  const rOut     = aToB ? ammState.reserves.B : ammState.reserves.A;

  if (rIn === 0n || rOut === 0n) {
    outputEl.value = '0.000000';
    setText('amm-swap-impact', 'Pool empty');
    ammState.quote = null;
    _updateSwapBtn();
    return;
  }

  const amountOut  = _ammQuote(amountIn, rIn, rOut);
  const outHuman   = parseFloat(ammFormatUnits(amountOut));
  const inHuman    = parseFloat(rawInput);

  // Price impact
  const spotPrice  = aToB ? Number(rOut) / Number(rIn) : Number(rIn) / Number(rOut);
  const idealOut   = inHuman * spotPrice;
  const impact     = idealOut > 0 ? ((idealOut - outHuman) / idealOut) * 100 : 0;

  // Minimum received
  const slipFactor = 1 - ammState.slippage / 100;
  const minOut     = amountOut * BigInt(Math.floor(slipFactor * 10000)) / 10000n;
  const minHuman   = parseFloat(ammFormatUnits(minOut));

  outputEl.value = outHuman.toFixed(6);

  const impactEl = $('amm-swap-impact');
  if (impactEl) {
    impactEl.textContent = impact.toFixed(4) + '%';
    impactEl.className   = (impact > 5 ? 'text-red-400' : impact > 2 ? 'text-yellow-400' : 'text-green-400') + ' dex-info-value';
  }
  setText('amm-swap-min',  minHuman.toFixed(6) + ' ' + ammState.swapTo);
  setText('amm-swap-rate', outHuman > 0 ? (outHuman / inHuman).toFixed(4) + ' ' + ammState.swapTo : '—');
  setText('amm-swap-fee',  (inHuman * 0.003).toFixed(6) + ' ' + ammState.swapFrom);

  ammState.quote = { amountIn, amountOut, minOut, aToB, rawInput, impact };
  _updateSwapBtn();
}

// ─── Swap button state ────────────────────────────────────────────────────────
function _updateSwapBtn() {
  const btn     = $('amm-swap-btn');
  const btnText = $('amm-swap-btn-text');
  if (!btn) return;
  const setLabel = t => { if (btnText) btnText.textContent = t; else btn.textContent = t; };

  if (!window.walletState?.address) {
    setLabel('Connect Wallet to Swap'); btn.disabled = true; return;
  }
  if (!ammState.deployed) {
    setLabel('Pool Empty — Add Liquidity First'); btn.disabled = true; return;
  }
  if (!ammState.quote) {
    setLabel('Enter Amount'); btn.disabled = true; return;
  }
  if (ammState.pending) {
    setLabel('⏳ Waiting…'); btn.disabled = true; return;
  }
  const balRaw = ammState.swapFrom === 'EURC' ? ammState.balances.EURC : ammState.balances.USDC;
  if (ammState.quote.amountIn > balRaw) {
    setLabel(`Insufficient ${ammState.swapFrom}`); btn.disabled = true; return;
  }
  setLabel(`Swap ${ammState.swapFrom} → ${ammState.swapTo}`);
  btn.disabled = false;
}

// ─── Tab switch ───────────────────────────────────────────────────────────────
window.ammSwitchTab = function(tab) {
  ammState.tab = tab;

  ['swap', 'liquidity'].forEach(t => {
    const btn   = $('amm-tab-' + t);
    const panel = $('amm-panel-' + t);
    if (btn)   btn.classList.toggle('active', t === tab);
    if (panel) panel.classList.toggle('hidden', t !== tab);
  });

  // ── Pool Status: only visible on Liquidity tab ──────────────────────────
  const poolCol = $('dex-pool-col');
  if (poolCol) poolCol.classList.toggle('hidden', tab !== 'liquidity');

  // Lazy-load pool state when entering Liquidity tab
  if (tab === 'liquidity') {
    ammFetchPoolState().then(_updatePoolUI).catch(e => console.warn('[AMM] pool fetch:', e.message));
    if (window.walletState?.address) ammFetchBalances();
  }
};

// ─── Flip swap direction ──────────────────────────────────────────────────────
window.ammFlipSwap = window.ammFlipTokens = function() {
  [ammState.swapFrom, ammState.swapTo] = [ammState.swapTo, ammState.swapFrom];
  setText('amm-swap-from-symbol', ammState.swapFrom);
  setText('amm-swap-to-symbol',   ammState.swapTo);
  setText('amm-swap-to-label',    ammState.swapTo);
  const fromLogo = $('amm-swap-from-logo');
  const toLogo   = $('amm-swap-to-logo');
  if (fromLogo) fromLogo.textContent = AMM_TOKENS[ammState.swapFrom].logo;
  if (toLogo)   toLogo.textContent   = AMM_TOKENS[ammState.swapTo].logo;
  setVal('amm-swap-input',  '');
  setVal('amm-swap-output', '');
  ammState.quote = null;
  _updateBalanceUI();
  _updateSwapBtn();
};

// ─── MAX buttons ──────────────────────────────────────────────────────────────
window.ammSetSwapMax = window.ammSetMaxSwap = function() {
  const bal   = ammState.swapFrom === 'EURC' ? ammState.balances.EURC : ammState.balances.USDC;
  const human = ammFormatUnits(bal);
  if (parseFloat(human) > 0) {
    setVal('amm-swap-input', parseFloat(human).toFixed(6));
    ammComputeSwapQuote();
  }
};

window.ammSetLiqMaxA = function() {
  const human = ammFormatUnits(ammState.balances.EURC);
  setVal('amm-liq-eurc', parseFloat(human).toFixed(6));
  ammUpdateLiqPreview();
};

window.ammSetLiqMaxB = function() {
  const human = ammFormatUnits(ammState.balances.USDC);
  setVal('amm-liq-usdc', parseFloat(human).toFixed(6));
  ammUpdateLiqPreview();
};

// ─── Liquidity add preview ────────────────────────────────────────────────────
function ammUpdateLiqPreview() {
  const amtA = parseFloat($('amm-liq-eurc')?.value || '0') || 0;
  const amtB = parseFloat($('amm-liq-usdc')?.value || '0') || 0;

  let lpEst = 0;
  if (amtA > 0 && amtB > 0) {
    if (ammState.totalSupply === 0n || ammState.reserves.A === 0n) {
      lpEst = Math.sqrt(amtA * amtB);
    } else {
      const rA = Number(ammState.reserves.A) / 1e6;
      const rB = Number(ammState.reserves.B) / 1e6;
      const ts = Number(ammState.totalSupply) / 1e6;
      lpEst = Math.min((amtA / rA) * ts, (amtB / rB) * ts);
    }
  }

  const tsHuman = Number(ammState.totalSupply) / 1e6;
  const shareVal = tsHuman > 0 && lpEst > 0
    ? (lpEst / (tsHuman + lpEst) * 100).toFixed(4) + '%'
    : amtA > 0 ? '100.00%' : '—';
  const rateVal = ammState.reserves.A > 0n && ammState.reserves.B > 0n
    ? (Number(ammState.reserves.B) / Number(ammState.reserves.A)).toFixed(4) + ' USDC/EURC'
    : '—';

  setText('amm-liq-lp-out',    lpEst > 0 ? lpEst.toFixed(4) + ' LP' : '—');
  setText('amm-liq-lp-est',    lpEst > 0 ? lpEst.toFixed(4) + ' LP' : '—');
  setText('amm-liq-share',     shareVal);
  setText('amm-liq-pool-share',shareVal);
  setText('amm-liq-rate',      rateVal);

  const prevEl = $('amm-liq-preview');
  if (prevEl) prevEl.classList.toggle('hidden', !(amtA > 0 && amtB > 0));

  const addBtn = $('amm-add-liq-btn');
  if (addBtn) {
    const ok = amtA > 0 && amtB > 0 && !!window.walletState?.address && !ammState.pending;
    addBtn.disabled = !ok;
  }
}

// ─── Remove liquidity preview ─────────────────────────────────────────────────
window.ammOnRemoveInput = function() {
  const el = $('amm-remove-lp');
  if (!el) return;
  const lp     = parseFloat(el.value) || 0;
  const prevEl = $('amm-remove-preview');

  if (lp <= 0 || ammState.totalSupply === 0n) {
    if (prevEl) prevEl.classList.add('hidden');
    const btn = $('amm-remove-liq-btn');
    if (btn) btn.disabled = true;
    return;
  }

  const ts    = Number(ammState.totalSupply) / 1e6;
  const rA    = Number(ammState.reserves.A)  / 1e6;
  const rB    = Number(ammState.reserves.B)  / 1e6;
  const share = ts > 0 ? lp / ts : 0;

  setText('amm-remove-eurc-out', (rA * share).toFixed(6) + ' EURC');
  setText('amm-remove-usdc-out', (rB * share).toFixed(6) + ' USDC');
  setText('amm-remove-share',    (share * 100).toFixed(4) + '%');
  if (prevEl) prevEl.classList.remove('hidden');

  const removeBtn = $('amm-remove-liq-btn');
  if (removeBtn) {
    const lpBal = Number(ammFormatUnits(ammState.balances.LP));
    removeBtn.disabled = !(lp > 0 && lp <= lpBal && !!window.walletState?.address && !ammState.pending);
  }
};

// ─── Remove % shortcuts ───────────────────────────────────────────────────────
window.ammSetRemovePct = function(pct) {
  const human = parseFloat(ammFormatUnits(ammState.balances.LP));
  if (human <= 0) { showToast('No LP tokens available', 'warning'); return; }
  setVal('amm-remove-lp', (human * pct / 100).toFixed(6));
  window.ammOnRemoveInput();
};

// ─── EXECUTE SWAP ────────────────────────────────────────────────────────────
window.ammExecuteSwap = async function() {
  if (ammState.pending || !ammState.quote) return;

  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Connect wallet first', 'warning'); return; }
  if (!ammState.deployed) { showToast('Pool is empty. Add liquidity first.', 'warning'); return; }

  const { amountIn, amountOut, minOut, aToB, rawInput } = ammState.quote;

  ammState.pending = true;
  _updateSwapBtn();
  hide('amm-swap-result');
  hide('amm-swap-error');

  try {
    await _ensureNetwork();

    // 1. Balance check
    const bal = aToB ? ammState.balances.EURC : ammState.balances.USDC;
    if (amountIn > bal)
      throw new Error(`Insufficient ${ammState.swapFrom} balance (have ${ammFormatUnits(bal)}, need ${rawInput})`);

    // 2. Approve input token
    await _ensureApproval(ammState.swapFrom, ammState.ammAddress, amountIn);

    // 3. Execute on-chain swap
    const amm = await _getAMM();
    console.log(`[AMM:swap] ${aToB ? 'swapAforB' : 'swapBforA'} amountIn=${amountIn} minOut=${minOut}`);
    showToast(`📝 Confirm swap: ${rawInput} ${ammState.swapFrom} → ${ammState.swapTo}`, 'info');

    const tx = aToB
      ? await amm.swapAforB(amountIn, minOut)
      : await amm.swapBforA(amountIn, minOut);

    console.log(`[AMM:swap] tx submitted: ${tx.hash}`);
    showToast(`⏳ Swap pending… ${tx.hash.slice(0, 14)}`, 'info');

    // 4. Wait for on-chain confirmation
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1)
      throw new Error('Swap reverted on-chain. Check ArcScan for details.');

    console.log(`[AMM:swap] confirmed block=${receipt.blockNumber} gas=${receipt.gasUsed}`);

    // 5. Parse actual output from Swap event if possible
    let actualOut = amountOut;
    try {
      const swapTopic = amm.interface.getEvent('Swap').topicHash;
      const swapLog   = receipt.logs?.find(l => l.topics?.[0] === swapTopic);
      if (swapLog) {
        const decoded = amm.interface.decodeEventLog('Swap', swapLog.data, swapLog.topics);
        actualOut = decoded.amountOut;
      }
    } catch (_) {}
    const outHuman = parseFloat(ammFormatUnits(actualOut)).toFixed(6);

    // 6. Show success
    setText('amm-result-in',   rawInput + ' ' + ammState.swapFrom);
    setText('amm-result-out',  outHuman + ' ' + ammState.swapTo);
    setText('amm-result-hash', tx.hash.slice(0, 20) + '…');
    const hashLink = $('amm-result-hash-link');
    if (hashLink) hashLink.href = `${AMM_EXPLORER}/tx/${tx.hash}`;
    show('amm-swap-result');
    showToast(`✅ Swapped ${rawInput} ${ammState.swapFrom} → ${outHuman} ${ammState.swapTo} <a href="${AMM_EXPLORER}/tx/${tx.hash}" target="_blank" class="underline">↗</a>`, 'success');

    // 7. Record + clear form
    fetch('/api/dex/swap/record', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet, fromToken: ammState.swapFrom, toToken: ammState.swapTo, amountIn: amountIn.toString(), amountOut: actualOut.toString(), txHash: tx.hash, blockNumber: receipt.blockNumber }),
    }).catch(() => {});
    setVal('amm-swap-input',  '');
    setVal('amm-swap-output', '');
    ammState.quote = null;

    // 8. Refresh balances + pool
    await ammFetchPoolState().then(_updatePoolUI).catch(() => {});
    await ammFetchBalances();
    ammComputeSwapQuote();

  } catch (err) {
    console.error('[AMM:swap] Error:', err);
    const msg = (err.code === 4001 || err.message?.includes('user rejected') || err.message?.includes('rejected'))
      ? 'Transaction rejected by user.'
      : `Swap failed: ${err.message?.slice(0, 120)}`;
    setText('amm-swap-error-msg', msg);
    show('amm-swap-error');
    showToast(`❌ ${msg.slice(0, 80)}`, 'error');
  } finally {
    ammState.pending = false;
    _updateSwapBtn();
  }
};

// ─── EXECUTE ADD LIQUIDITY ───────────────────────────────────────────────────
window.ammAddLiquidity = async function() {
  if (ammState.pending) return;

  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Connect wallet first', 'warning'); return; }

  const amtAStr = $('amm-liq-eurc')?.value?.trim() || '';
  const amtBStr = $('amm-liq-usdc')?.value?.trim() || '';
  if (!amtAStr || parseFloat(amtAStr) <= 0 || !amtBStr || parseFloat(amtBStr) <= 0) {
    showToast('Enter EURC and USDC amounts', 'warning'); return;
  }

  const amountA = ammParseUnits(amtAStr);
  const amountB = ammParseUnits(amtBStr);
  if (amountA === 0n || amountB === 0n) { showToast('Amounts must be > 0', 'warning'); return; }
  if (amountA > ammState.balances.EURC) { showToast('Insufficient EURC balance', 'error'); return; }
  if (amountB > ammState.balances.USDC) { showToast('Insufficient USDC balance', 'error'); return; }

  if (!ammState.deployed || !ammState.ammAddress)
    throw new Error('SimpleAMM not deployed.');

  ammState.pending = true;
  hide('amm-liq-result');
  hide('amm-liq-error');
  const addBtn = $('amm-add-liq-btn');
  if (addBtn) { addBtn.disabled = true; addBtn.innerHTML = '<i class="fas fa-spinner fa-spin text-xs"></i> Processing…'; }

  try {
    await _ensureNetwork();

    // Approve both tokens
    await _ensureApproval('EURC', ammState.ammAddress, amountA);
    await _ensureApproval('USDC', ammState.ammAddress, amountB);

    // Add liquidity
    const amm = await _getAMM();
    console.log(`[AMM:addLiq] addLiquidity amountA=${amountA} amountB=${amountB}`);
    showToast('📝 Confirm Add Liquidity in wallet…', 'info');
    const tx      = await amm.addLiquidity(amountA, amountB);
    console.log(`[AMM:addLiq] tx submitted: ${tx.hash}`);
    showToast(`⏳ Adding liquidity… ${tx.hash.slice(0, 14)}`, 'info');
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1)
      throw new Error('addLiquidity reverted on-chain.');

    console.log(`[AMM:addLiq] confirmed block=${receipt.blockNumber}`);

    // Parse LiquidityAdded event for actual LP minted
    let lpMinted = 0n;
    try {
      const topic  = amm.interface.getEvent('LiquidityAdded').topicHash;
      const log    = receipt.logs?.find(l => l.topics?.[0] === topic);
      if (log) {
        const d  = amm.interface.decodeEventLog('LiquidityAdded', log.data, log.topics);
        lpMinted = d.lpMinted;
      }
    } catch (_) {}

    // Refresh to get new LP balance if event parse failed
    await ammFetchPoolState().then(_updatePoolUI).catch(() => {});
    await ammFetchBalances();
    if (lpMinted === 0n) lpMinted = ammState.balances.LP;

    const lpHuman = parseFloat(ammFormatUnits(lpMinted)).toFixed(4);
    setText('amm-liq-result-a',    amtAStr + ' EURC');
    setText('amm-liq-result-b',    amtBStr + ' USDC');
    setText('amm-liq-result-lp',   lpHuman + ' LP');
    setText('amm-liq-result-hash', tx.hash.slice(0, 20) + '…');
    const liqHashLink = $('amm-liq-result-hash-link');
    if (liqHashLink) liqHashLink.href = `${AMM_EXPLORER}/tx/${tx.hash}`;
    show('amm-liq-result');

    showToast(`✅ Liquidity added! ${amtAStr} EURC + ${amtBStr} USDC → ${lpHuman} LP <a href="${AMM_EXPLORER}/tx/${tx.hash}" target="_blank" class="underline">↗</a>`, 'success');

    fetch('/api/dex/liquidity/record', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet, amountA: amountA.toString(), amountB: amountB.toString(), txHash: tx.hash, blockNumber: receipt.blockNumber }),
    }).catch(() => {});

    // Clear inputs
    setVal('amm-liq-eurc', '');
    setVal('amm-liq-usdc', '');
    ammUpdateLiqPreview();

  } catch (err) {
    console.error('[AMM:addLiq] Error:', err);
    const msg = (err.code === 4001 || err.message?.includes('rejected'))
      ? 'Transaction rejected by user.'
      : `Add liquidity failed: ${err.message?.slice(0, 120)}`;
    setText('amm-liq-error-msg', msg);
    show('amm-liq-error');
    showToast(`❌ ${msg.slice(0, 80)}`, 'error');
  } finally {
    ammState.pending = false;
    if (addBtn) {
      addBtn.disabled = false;
      addBtn.innerHTML = '<i class="fas fa-plus text-xs"></i> Add Liquidity';
    }
    ammUpdateLiqPreview();
  }
};

// ─── EXECUTE REMOVE LIQUIDITY ────────────────────────────────────────────────
window.ammRemoveLiquidity = async function() {
  if (ammState.pending) return;

  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Connect wallet first', 'warning'); return; }

  const lpBalance = ammState.balances.LP;
  if (lpBalance === 0n) { showToast('No LP tokens to remove', 'warning'); return; }

  // Read LP amount from the redesigned input field
  const lpInputEl = $('amm-remove-lp');
  let lpAmount;
  if (lpInputEl && lpInputEl.value && parseFloat(lpInputEl.value) > 0) {
    lpAmount = ammParseUnits(lpInputEl.value);
  } else {
    lpAmount = lpBalance; // fallback: remove 100%
  }
  if (lpAmount > lpBalance) lpAmount = lpBalance;
  if (lpAmount === 0n) { showToast('LP amount is zero', 'warning'); return; }

  const lpHumanStr = ammFormatUnits(lpAmount);
  ammState.pending = true;
  const removeBtn = $('amm-remove-liq-btn');
  if (removeBtn) { removeBtn.disabled = true; removeBtn.innerHTML = '<i class="fas fa-spinner fa-spin text-xs"></i> Processing…'; }

  try {
    await _ensureNetwork();

    const amm = await _getAMM();
    console.log(`[AMM:removeLiq] removeLiquidity lpAmount=${lpAmount}`);
    showToast(`📝 Confirm Remove ${lpHumanStr} LP in wallet…`, 'info');
    const tx = await amm.removeLiquidity(lpAmount);
    console.log(`[AMM:removeLiq] tx submitted: ${tx.hash}`);
    showToast(`⏳ Removing liquidity… ${tx.hash.slice(0, 14)}`, 'info');
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1)
      throw new Error('removeLiquidity reverted on-chain.');

    console.log(`[AMM:removeLiq] confirmed block=${receipt.blockNumber}`);

    // Parse LiquidityRemoved event
    let eurcOut = 0n, usdcOut = 0n;
    try {
      const topic = amm.interface.getEvent('LiquidityRemoved').topicHash;
      const log   = receipt.logs?.find(l => l.topics?.[0] === topic);
      if (log) {
        const d  = amm.interface.decodeEventLog('LiquidityRemoved', log.data, log.topics);
        eurcOut  = d.amountA;
        usdcOut  = d.amountB;
      }
    } catch (_) {}

    const eurcHuman = parseFloat(ammFormatUnits(eurcOut)).toFixed(6);
    const usdcHuman = parseFloat(ammFormatUnits(usdcOut)).toFixed(6);
    showToast(`✅ Removed ${lpHumanStr} LP → ${eurcHuman} EURC + ${usdcHuman} USDC <a href="${AMM_EXPLORER}/tx/${tx.hash}" target="_blank" class="underline">↗</a>`, 'success');

    await ammFetchPoolState().then(_updatePoolUI).catch(() => {});
    await ammFetchBalances();

    // Clear input + hide preview
    setVal('amm-remove-lp', '');
    hide('amm-remove-preview');

  } catch (err) {
    console.error('[AMM:removeLiq] Error:', err);
    const msg = (err.code === 4001 || err.message?.includes('rejected'))
      ? 'Rejected by user.'
      : `Remove failed: ${err.message?.slice(0, 120)}`;
    showToast(`❌ ${msg}`, 'error');
  } finally {
    ammState.pending = false;
    if (removeBtn) {
      removeBtn.disabled = false;
      removeBtn.innerHTML = '<i class="fas fa-minus text-xs"></i> <span>Remove Liquidity</span>';
    }
    window.ammOnRemoveInput();
  }
};

// ─── Refresh all (only pool data + balances) ──────────────────────────────────
async function ammRefreshAll() {
  try {
    const data = await ammFetchPoolState();
    // Only update pool UI if we are on the Liquidity tab (avoid unnecessary renders)
    if (ammState.tab === 'liquidity') _updatePoolUI(data);
    if (window.walletState?.address) await ammFetchBalances();
    ammComputeSwapQuote();
    ammUpdateLiqPreview();
  } catch (e) {
    console.warn('[AMM] refreshAll error:', e.message);
  }
}

// ─── Slippage control ─────────────────────────────────────────────────────────
window.ammSetSlippage = function(pct) {
  ammState.slippage = parseFloat(pct) || 0.5;
  setText('amm-slip-label', ammState.slippage + '%');
  ['01', '05', '10'].forEach(id => {
    const btn = $('slip-' + id);
    if (!btn) return;
    const val = { '01': 0.1, '05': 0.5, '10': 1.0 }[id];
    if (val === ammState.slippage) {
      btn.classList.add('border-blue-700/40', 'text-blue-400');
      btn.classList.remove('text-gray-500');
    } else {
      btn.classList.remove('border-blue-700/40', 'text-blue-400');
      btn.classList.add('text-gray-500');
    }
  });
  ammComputeSwapQuote();
};

// ─── Init ─────────────────────────────────────────────────────────────────────
async function ammInit() {
  console.log('[AMM] Init · Arc Testnet', AMM_CHAIN_ID);
  console.log('[AMM] EURC:', AMM_TOKENS.EURC.address, '/ USDC:', AMM_TOKENS.USDC.address);

  // Attach input listeners
  const swapInput = $('amm-swap-input');
  if (swapInput) swapInput.addEventListener('input', ammComputeSwapQuote);

  const liqA = $('amm-liq-eurc');
  const liqB = $('amm-liq-usdc');
  if (liqA) liqA.addEventListener('input', ammUpdateLiqPreview);
  if (liqB) liqB.addEventListener('input', ammUpdateLiqPreview);

  const removeEl = $('amm-remove-lp');
  if (removeEl) removeEl.addEventListener('input', window.ammOnRemoveInput);

  // Fetch initial pool state (needed for swap quote)
  try {
    const data = await ammFetchPoolState();
    // Do NOT call _updatePoolUI here — pool panel is hidden until Liquidity tab
  } catch (e) {
    console.warn('[AMM] init pool fetch:', e.message);
  }

  // Fetch balances if wallet already connected
  if (window.walletState?.address) await ammFetchBalances();

  // Default to Swap tab (Pool Status hidden)
  ammSwitchTab('swap');

  // Auto-refresh only swap-relevant state every 20s — no pool UI unless on Liquidity
  setInterval(() => {
    ammFetchPoolState().then(data => {
      if (ammState.tab === 'liquidity') _updatePoolUI(data);
    }).catch(() => {});
    if (window.walletState?.address) ammFetchBalances().catch(() => {});
    ammComputeSwapQuote();
  }, 20_000);

  _updateSwapBtn();
  console.log('[AMM] Ready · AMM:', ammState.ammAddress, '· Deployed:', ammState.deployed);
}

// ─── Wallet events ────────────────────────────────────────────────────────────
window.addEventListener('walletConnected', async (e) => {
  console.log('[AMM] walletConnected:', e.detail?.address);
  await ammFetchBalances();
  ammComputeSwapQuote();
  ammUpdateLiqPreview();
  _updateSwapBtn();
  if (ammState.tab === 'liquidity') {
    ammFetchPoolState().then(_updatePoolUI).catch(() => {});
  }
});

window.addEventListener('accountsChanged', async () => {
  await ammFetchBalances();
  _updateSwapBtn();
});

// ─── DOMContentLoaded ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if ($('amm-panel-swap')) {
    ammInit().catch(e => console.error('[AMM] init error:', e));
  }
});

// ─── Expose globals ───────────────────────────────────────────────────────────
window.ammInit             = ammInit;
window.ammRefreshAll       = ammRefreshAll;
window.ammComputeSwapQuote = ammComputeSwapQuote;
window.ammUpdateLiqPreview = ammUpdateLiqPreview;
window.ammOnSwapInput      = ammComputeSwapQuote;
window.ammOnLiquidityInput = ammUpdateLiqPreview;

console.log('[AMM] Module loaded · zero mock data · real on-chain only');
