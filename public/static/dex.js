// ============================================================
//  ARC DEX — Real On-Chain AMM · EURC / USDC Pool
//  Arc Testnet · ChainId 5042002 · x * y = k
//
//  Zero mock data. All balances, reserves, and prices come
//  directly from the SimpleAMM contract on Arc Testnet.
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
  EURC: { symbol: 'EURC', name: 'Euro Coin',  address: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a', decimals: 6 },
  USDC: { symbol: 'USDC', name: 'USD Coin',   address: '0x3600000000000000000000000000000000000000', decimals: 6 },
};

// ─── Official Circle Token Icons ── centralized registry; SVG, crisp at any size
const AMM_TOKEN_ICONS = {
  USDC: `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="#2775CA"/><path d="M20.5 18.6c0-2.38-1.43-3.2-4.29-3.54-2.04-.27-2.45-.82-2.45-1.78 0-.96.69-1.57 2.07-1.57 1.24 0 1.93.41 2.28 1.44.07.2.27.34.48.34h1.1c.28 0 .48-.2.48-.48v-.07a3.42 3.42 0 00-3.09-2.8V8.86c0-.27-.2-.48-.55-.55h-1.03c-.28 0-.48.21-.55.55v1.02c-2.04.27-3.33 1.64-3.33 3.34 0 2.25 1.37 3.13 4.22 3.47 1.92.34 2.52.75 2.52 1.85 0 1.1-.96 1.85-2.27 1.85-1.79 0-2.41-.75-2.62-1.78-.07-.27-.27-.41-.48-.41h-1.16a.47.47 0 00-.48.48v.07c.27 1.64 1.3 2.8 3.57 3.13v1.03c0 .27.2.48.55.55h1.03c.28 0 .48-.21.55-.55v-1.03c2.04-.34 3.4-1.78 3.4-3.61z" fill="#FFF"/><path d="M12.95 25.15c-5.3-1.92-8.02-7.84-6.03-13.07 1.03-2.87 3.3-5.06 6.03-6.09.28-.14.41-.34.41-.68v-.96c0-.27-.13-.48-.41-.55-.07 0-.2 0-.28.07a11.3 11.3 0 00-7.4 14.24c1.17 3.68 4 6.5 7.4 7.67.28.14.55 0 .62-.27.07-.07.07-.14.07-.28v-.96c0-.2-.2-.47-.41-.61zm6.16-21.44c-.28-.14-.55 0-.62.27-.07.07-.07.13-.07.27v.96c0 .27.2.55.41.68 5.3 1.92 8.02 7.84 6.03 13.07-1.03 2.87-3.3 5.06-6.03 6.09-.28.14-.41.34-.41.68v.96c0 .27.13.48.41.55.07 0 .2 0 .28-.07a11.3 11.3 0 007.4-14.24c-1.17-3.75-4.07-6.57-7.4-7.74z" fill="#FFF"/></svg>`,
  EURC: `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="#1A65D6"/><path d="M18.9 20.3a4.6 4.6 0 01-3.55 1.63c-1.94 0-3.6-1.15-4.36-2.86h4.06l.63-1.45h-5.1a5.3 5.3 0 010-1.34h5.7l.62-1.45h-6.02a4.77 4.77 0 014.47-3.1c1.42 0 2.7.62 3.55 1.62l1.6-1.35A6.86 6.86 0 0015.35 9.3c-3.1 0-5.74 2.02-6.66 4.83H7.1l-.63 1.45h1.98a7.3 7.3 0 000 1.34H7.1l-.63 1.45h2.22c.92 2.8 3.56 4.82 6.66 4.82 2.02 0 3.85-.86 5.13-2.23l-1.58-1.34z" fill="#FFF"/></svg>`,
};

function ammTokenIcon(sym, size) {
  const s = size || 28; const key = String(sym || 'USDC').toUpperCase(); const svg = AMM_TOKEN_ICONS[key] || AMM_TOKEN_ICONS.USDC;
  return `<span class="amm-tlogo" style="width:${s}px;height:${s}px;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;overflow:hidden;flex-shrink:0;vertical-align:middle;">${svg}</span>`;
}
function ammSetSwapLogo(id, sym) { const el = $(id); if (el) el.innerHTML = ammTokenIcon(sym, 28); }

// Render all official Circle token icons across the Swap + Liquidity module.
// Nothing is hardcoded per-component: every icon is pulled from the registry.
function ammRenderTokenIcons() {
  const set = (id, sym, sz) => { const el = document.getElementById(id); if (el) el.innerHTML = ammTokenIcon(sym, sz); };
  // Swap card (dynamic — follow swap direction)
  set('amm-swap-from-logo', ammState.swapFrom, 28);
  set('amm-swap-to-logo',   ammState.swapTo,   28);
  // Liquidity add inputs (pool order: EURC = tokenA, USDC = tokenB)
  set('amm-liq-logo-a', 'EURC', 24);
  set('amm-liq-logo-b', 'USDC', 24);
  // Remove-liquidity expected returns
  set('amm-remove-icon-eurc', 'EURC', 15);
  set('amm-remove-icon-usdc', 'USDC', 15);
  // Pool reserves
  set('amm-reserve-logo-a', 'EURC', 22);
  set('amm-reserve-logo-b', 'USDC', 22);
  // Your balances
  set('amm-bal-logo-eurc', 'EURC', 22);
  set('amm-bal-logo-usdc', 'USDC', 22);
}
window.ammTokenIcon = ammTokenIcon;
window.ammRenderTokenIcons = ammRenderTokenIcons;

// Full ERC-20 ABI (human-readable, for ethers.Contract)
const AMM_ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
];

// SimpleAMM ABI (human-readable)
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
  tab:        'swap',       // 'swap' | 'liquidity'
  ammAddress: null,         // set from backend /api/dex/amm
  deployed:   false,
  reserves:   { A: 0n, B: 0n },   // raw bigint (6 dec)
  totalSupply: 0n,
  balances:   { EURC: 0n, USDC: 0n, LP: 0n },
  swapFrom:   'EURC',
  swapTo:     'USDC',
  slippage:   0.5,          // %
  pending:    false,
  quote:      null,         // last computed quote
};

// ─── DOM helpers ──────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const setText = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
const ammSetVal  = (id, val) => { const el = $(id); if (el) el.value = val; };
const show    = id => { const el = $(id); if (el) el.classList.remove('hidden'); };
const hide    = id => { const el = $(id); if (el) el.classList.add('hidden'); };
const addCls  = (id, cls) => { const el = $(id); if (el) el.classList.add(cls); };
const remCls  = (id, cls) => { const el = $(id); if (el) el.classList.remove(cls); };

// ─── ethers helpers ───────────────────────────────────────────────────────────
function ammGetProvider() {
  const raw = window.walletState?.provider;
  if (!raw) throw new Error('Wallet not connected');
  if (window.ethers?.BrowserProvider)
    return new window.ethers.BrowserProvider(raw);
  if (window.ethers?.providers?.Web3Provider)
    return new window.ethers.providers.Web3Provider(raw);
  throw new Error('ethers.js not loaded');
}

async function ammGetSigner() {
  const p = ammGetProvider();
  return p.getSigner();
}

async function ammGetERC20(symbol) {
  if (!window.ethers?.Contract) throw new Error('ethers.Contract not available');
  const signer = await ammGetSigner();
  const addr   = AMM_TOKENS[symbol].address;
  return new window.ethers.Contract(addr, AMM_ERC20_ABI, signer);
}

async function ammGetContract() {
  if (!ammState.ammAddress || ammState.ammAddress === '0x0000000000000000000000000000000000000000')
    throw new Error('SimpleAMM not deployed yet. Deploy the contract first.');
  if (!window.ethers?.Contract) throw new Error('ethers.Contract not available');
  const signer = await ammGetSigner();
  return new window.ethers.Contract(ammState.ammAddress, AMM_ABI, signer);
}

// ─── parseUnits (always string → BigInt) ─────────────────────────────────────
function ammParseUnits(humanAmount, decimals = 6) {
  let s = String(humanAmount).trim();
  if (/[eE]/.test(s)) s = Number(s).toFixed(decimals);
  const dot = s.indexOf('.');
  if (dot !== -1 && s.length - dot - 1 > decimals) s = s.slice(0, dot + decimals + 1);
  if (!s || s === '.' || s === '') s = '0';
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

// ─── Network check ────────────────────────────────────────────────────────────
async function ammEnsureNetwork() {
  const prov = window.walletState?.provider;
  if (!prov) throw new Error('Connect wallet first');
  const chainHex = await prov.request({ method: 'eth_chainId' });
  if (parseInt(chainHex, 16) !== AMM_CHAIN_ID) {
    try {
      await prov.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: AMM_CHAIN_HEX }] });
    } catch (e) {
      if (e.code === 4902) {
        await prov.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: AMM_CHAIN_HEX,
            chainName: 'Arc Testnet',
            nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
            rpcUrls: [AMM_RPC],
            blockExplorerUrls: [AMM_EXPLORER],
          }],
        });
      } else throw e;
    }
  }
}

// ─── Fetch on-chain state ─────────────────────────────────────────────────────
async function ammFetchPoolState() {
  const res = await fetch('/api/dex/amm');
  const data = await res.json();
  if (data.success && data.deployed) {
    ammState.ammAddress  = data.ammAddress;
    ammState.deployed    = true;
    ammState.reserves.A  = BigInt(data.reserveA);
    ammState.reserves.B  = BigInt(data.reserveB);
    ammState.totalSupply = BigInt(data.totalSupply);
    return data;
  } else {
    ammState.deployed = false;
    ammState.ammAddress = data.ammAddress || null;
    return data;
  }
}

async function ammFetchBalances() {
  const wallet = window.walletState?.address;
  if (!wallet) return;

  console.log('[AMM:balances] Fetching balances for', wallet);

  try {
    const res  = await fetch(`/api/dex/amm/balances/${wallet}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (data.success) {
      const eurcRaw = BigInt(data.balances.EURC.raw || '0');
      const usdcRaw = BigInt(data.balances.USDC.raw || '0');
      const lpRaw   = BigInt(data.balances.LP.raw   || '0');

      console.log('[AMM:balances] API response — EURC:', data.balances.EURC.human,
        'USDC:', data.balances.USDC.human, 'LP:', data.balances.LP.human);

      ammState.balances.EURC = eurcRaw;
      ammState.balances.USDC = usdcRaw;
      ammState.balances.LP   = lpRaw;
      ammUpdateBalanceUI();
      return;
    }

    console.warn('[AMM:balances] API error:', data.error);
  } catch (e) {
    console.warn('[AMM:balances] API fetch failed:', e.message, '— falling back to direct RPC read');
  }

  // ── Fallback: read directly from chain via provider ────────────────────────
  // This is the ONLY reliable way to get fresh LP balance right after a tx
  await ammFetchBalancesDirect(wallet);
}

// Direct on-chain balance read via the wallet provider (no backend needed)
async function ammFetchBalancesDirect(wallet) {
  if (!wallet) return;
  try {
    const provider = window.walletState?.provider;
    if (!provider) { console.warn('[AMM:balances:direct] No provider'); return; }

    const walletPadded = '0x' + wallet.replace('0x','').toLowerCase().padStart(64,'0');
    const balSel = '0x70a08231'; // balanceOf(address)

    // Fetch all 3 in parallel
    const [eurcHex, usdcHex, lpHex] = await Promise.all([
      provider.request({ method: 'eth_call', params: [{ to: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a', data: balSel + walletPadded.slice(2) }, 'latest'] }),
      provider.request({ method: 'eth_call', params: [{ to: '0x3600000000000000000000000000000000000000', data: balSel + walletPadded.slice(2) }, 'latest'] }),
      // LP balance = balanceOf() on AMM contract (SimpleAMM IS an ERC-20, not a separate LP token)
      // Use known deployed address as fallback if ammState.ammAddress is not yet set
      (function() {
        const ammAddr = ammState.ammAddress || '0x3148E2807F172D1cC354F35fB4fC4104e8b6b561';
        if (!ammAddr || ammAddr === '0x0000000000000000000000000000000000000000') return Promise.resolve('0x0');
        return provider.request({ method: 'eth_call', params: [{ to: ammAddr, data: balSel + walletPadded.slice(2) }, 'latest'] });
      })(),
    ]);

    const toBigInt = h => h && h !== '0x' ? BigInt(h) : 0n;
    const eurcRaw = toBigInt(eurcHex);
    const usdcRaw = toBigInt(usdcHex);
    const lpRaw   = toBigInt(lpHex);

    console.log('[AMM:balances:direct] EURC:', (Number(eurcRaw)/1e6).toFixed(4),
      'USDC:', (Number(usdcRaw)/1e6).toFixed(4), 'LP:', (Number(lpRaw)/1e6).toFixed(4),
      '| AMM addr:', ammState.ammAddress);

    ammState.balances.EURC = eurcRaw;
    ammState.balances.USDC = usdcRaw;
    ammState.balances.LP   = lpRaw;
    ammUpdateBalanceUI();
  } catch (e) {
    console.error('[AMM:balances:direct] Direct RPC read failed:', e.message);
  }
}

// ─── AMM quote (pure, matches Solidity) ──────────────────────────────────────
function ammQuote(amountIn, rIn, rOut) {
  if (amountIn === 0n || rIn === 0n || rOut === 0n) return 0n;
  const amountInWithFee = amountIn * 997n;
  const numerator       = amountInWithFee * rOut;
  const denominator     = rIn * 1000n + amountInWithFee;
  return numerator / denominator;
}

// ─── Update balance displays ──────────────────────────────────────────────────
function ammUpdateBalanceUI() {
  const eurc = ammFormatUnits(ammState.balances.EURC);
  const usdc = ammFormatUnits(ammState.balances.USDC);
  const lp   = ammFormatUnits(ammState.balances.LP);

  setText('amm-bal-eurc',     parseFloat(eurc).toFixed(4) + ' EURC');
  setText('amm-bal-usdc',     parseFloat(usdc).toFixed(4) + ' USDC');
  setText('amm-bal-lp',       parseFloat(lp).toFixed(4)   + ' LP');
  setText('amm-liq-bal-eurc', parseFloat(eurc).toFixed(4) + ' EURC');
  setText('amm-liq-bal-usdc', parseFloat(usdc).toFixed(4) + ' USDC');
  setText('amm-liq-bal-lp',   parseFloat(lp).toFixed(4)   + ' LP');
  setText('amm-remove-lp-bal', parseFloat(lp).toFixed(4)  + ' LP');

  // Swap balances
  const swapFromBal = ammState.swapFrom === 'EURC' ? eurc : usdc;
  const swapToBal   = ammState.swapTo   === 'EURC' ? eurc : usdc;
  setText('amm-swap-from-bal', parseFloat(swapFromBal).toFixed(4) + ' ' + ammState.swapFrom);
  setText('amm-swap-to-bal',   parseFloat(swapToBal).toFixed(4)   + ' ' + ammState.swapTo);

  // Update remove preview with fresh balances
  ammUpdateRemovePreview();
}

// ─── Update pool reserves display ────────────────────────────────────────────
function ammUpdatePoolUI(data) {
  if (!data || !data.deployed) {
    setText('amm-reserve-a', '—');
    setText('amm-reserve-b', '—');
    setText('amm-price-a',   '—');
    setText('amm-price-b',   '—');
    setText('amm-tvl',       '$0.00');
    setText('amm-status',    '⚠️ Pool not deployed');
    show('amm-deploy-notice');
    return;
  }
  hide('amm-deploy-notice');
  const rA = parseFloat(data.reserveAHuman);
  const rB = parseFloat(data.reserveBHuman);
  const hasLiq = rA > 0 && rB > 0;
  setText('amm-reserve-a',   hasLiq ? rA.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 4}) + ' EURC' : 'Empty');
  setText('amm-reserve-b',   hasLiq ? rB.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 4}) + ' USDC' : 'Empty');
  setText('amm-price-a',     hasLiq ? parseFloat(data.priceAinB).toFixed(6) + ' USDC' : '—');
  setText('amm-price-b',     hasLiq ? parseFloat(data.priceBinA).toFixed(6) + ' EURC' : '—');
  const tvl = hasLiq ? parseFloat(data.tvl) : 0;
  setText('amm-tvl',         '$' + tvl.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2}));
  setText('amm-status',      hasLiq ? '✅ Active · 0.3% fee' : '⚡ Deployed · Add liquidity');
  // Full address for the new improved display
  if (data.ammAddress) {
    setText('amm-addr-display', data.ammAddress);
  }
}

// ─── Swap quote (live, pure computation) ──────────────────────────────────────
function ammComputeSwapQuote() {
  const inputEl = $('amm-swap-input');
  const outputEl = $('amm-swap-output');
  const impactEl = $('amm-price-impact');
  const minEl    = $('amm-min-received');

  if (!inputEl || !outputEl) return;
  const rawInput = inputEl.value.trim();
  if (!rawInput || parseFloat(rawInput) <= 0) {
    if (outputEl) outputEl.value = '';
    setText('amm-price-impact', '—');
    setText('amm-min-received', '—');
    setText('amm-swap-fee', '—');
    ammState.quote = null;
    ammUpdateSwapBtn();
    // Don't auto-hide during execution or after completion — let the timer handle it
    if (ammInfoMode !== 'execution' && ammInfoMode !== 'completed') {
      ammHideSwapInfo();
    }
    return;
  }

  const amountIn = ammParseUnits(rawInput);
  const aToB = ammState.swapFrom === 'EURC';
  const rIn  = aToB ? ammState.reserves.A : ammState.reserves.B;
  const rOut = aToB ? ammState.reserves.B : ammState.reserves.A;

  if (rIn === 0n || rOut === 0n) {
    if (outputEl) outputEl.value = '0.000000';
    setText('amm-price-impact', 'Pool empty');
    setText('amm-swap-fee', '—');
    ammState.quote = null;
    ammUpdateSwapBtn();
    ammHideSwapInfo();
    return;
  }

  const amountOut = ammQuote(amountIn, rIn, rOut);
  const outHuman  = parseFloat(ammFormatUnits(amountOut));
  const inHuman   = parseFloat(rawInput);

  // Price impact
  const spotPrice  = aToB ? Number(rOut) / Number(rIn) : Number(rIn) / Number(rOut);
  const idealOut   = inHuman * spotPrice;
  const impact     = idealOut > 0 ? ((idealOut - outHuman) / idealOut) * 100 : 0;

  // Minimum received with slippage
  const slipFactor = 1 - ammState.slippage / 100;
  const minOut     = amountOut * BigInt(Math.floor(slipFactor * 10000)) / 10000n;
  const minHuman   = parseFloat(ammFormatUnits(minOut));

  outputEl.value = outHuman.toFixed(6);

  const impactColor = impact > 5 ? 'text-red-400' : impact > 2 ? 'text-yellow-400' : 'text-green-400';
  if (impactEl) {
    impactEl.textContent = impact.toFixed(4) + '%';
    impactEl.className   = impactColor + ' font-mono text-sm';
  }
  if (minEl) minEl.textContent = minHuman.toFixed(6) + ' ' + ammState.swapTo;

  const feeAmt = parseFloat(rawInput) * 0.003;
  setText('amm-swap-fee', feeAmt.toFixed(6) + ' ' + ammState.swapFrom);

  ammState.quote = { amountIn, amountOut, minOut, aToB, impact, rawInput };
  ammUpdateSwapBtn();

  // Auto-show info panel with trade preview when user fills data
  if (!ammState.pending) {
    ammShowSwapInfoPre();
  }
}

function ammUpdateSwapBtn() {
  const btn     = $('amm-swap-btn');
  const btnText = $('amm-swap-btn-text');
  const hint    = $('amm-no-wallet-hint');
  if (!btn) return;

  const setLabel = (txt) => {
    if (btnText) btnText.textContent = txt;
    else btn.textContent = txt;
  };

  if (!window.walletState?.address) {
    setLabel('Connect Wallet to Swap');
    btn.disabled = true;
    if (hint) hint.classList.remove('hidden');
    return;
  }
  if (hint) hint.classList.add('hidden');

  if (!ammState.deployed) {
    setLabel('Pool Empty — Add Liquidity First');
    btn.disabled = true;
    return;
  }
  if (!ammState.quote) {
    setLabel('Enter Amount');
    btn.disabled = true;
    return;
  }
  if (ammState.pending) {
    setLabel('⏳ Waiting for wallet confirmation…');
    btn.disabled = true;
    return;
  }
  // Check balance
  const balRaw = ammState.swapFrom === 'EURC' ? ammState.balances.EURC : ammState.balances.USDC;
  if (ammState.quote.amountIn > balRaw) {
    setLabel(`Insufficient ${ammState.swapFrom} balance`);
    btn.disabled = true;
    return;
  }
  setLabel(`Swap ${ammState.swapFrom} → ${ammState.swapTo}`);
  btn.disabled = false;
}

// ─── Tab switch ───────────────────────────────────────────────────────────────
window.ammSwitchTab = function(tab) {
  ammState.tab = tab;
  const isLiq = tab === 'liquidity';

  // ── 1. Tab button active/inactive styles ────────────────────────────────────
  ['swap', 'liquidity'].forEach(t => {
    const btn   = $('amm-tab-' + t);
    const panel = $('amm-panel-' + t);
    if (btn) {
      btn.className = t === tab
        ? 'flex-1 py-2.5 px-4 text-sm font-semibold rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 text-white shadow-lg shadow-cyan-900/30 transition-all'
        : 'flex-1 py-2.5 px-4 text-sm font-semibold rounded-xl text-gray-400 hover:text-white hover:bg-gray-800/60 transition-all';
    }
    if (panel) panel.classList.toggle('hidden', t !== tab);
  });

  // ── 2. Pool column: show on liquidity, hide on swap ─────────────────────────
  const poolCol    = $('dex-pool-col');
  const swapCenter = $('dex-swap-center');
  const swapInner  = $('dex-swap-inner');

  ammHideSwapInfo();

  if (isLiq) {
    // Switch wrapper to a 2-col grid layout
    if (swapCenter) {
      swapCenter.classList.add('amm-liq-mode');
      swapCenter.style.display      = 'grid';
      swapCenter.style.gap          = '20px';
      swapCenter.style.alignItems   = 'start';
      // Responsive: 1 col on mobile, 2 cols on ≥1024px
      swapCenter.style.gridTemplateColumns = window.innerWidth >= 1024
        ? 'minmax(0,1fr) minmax(0,1.4fr)'
        : '1fr';
    }
    // Swap inner: fill available column width, max 480 preserved
    if (swapInner) swapInner.style.maxWidth = '480px';

    // Reveal pool col with slide-in
    if (poolCol) {
      poolCol.style.display = '';      // make visible in DOM flow
      // Force reflow so the transition fires
      void poolCol.offsetWidth;
      poolCol.classList.remove('amm-pool-hidden');
      poolCol.classList.add('amm-pool-visible');
    }
  } else {
    // Hide pool col first (slide-out), then collapse
    if (poolCol) {
      poolCol.classList.remove('amm-pool-visible');
      poolCol.classList.add('amm-pool-hidden');
      // After transition ends, remove from flow by collapsing display
      // Keep display:'' so CSS opacity/transform can still animate
    }

    // Revert wrapper to centred flex
    if (swapCenter) {
      swapCenter.classList.remove('amm-liq-mode');
      swapCenter.style.display             = 'flex';
      swapCenter.style.justifyContent      = 'center';
      swapCenter.style.alignItems          = 'flex-start';
      swapCenter.style.gridTemplateColumns = '';
      swapCenter.style.gap                 = '';
    }
    if (swapInner) swapInner.style.maxWidth = '480px';
  }

  // ── 2.5 Auto-fill liquidity inputs with equalized EURC/USDC amounts ─────────
  if (isLiq && ammState.reserves.A > 0n && ammState.reserves.B > 0n) {
    const eurcBal = Number(ammFormatUnits(ammState.balances.EURC));
    const usdcBal = Number(ammFormatUnits(ammState.balances.USDC));
    if (eurcBal > 0 && usdcBal > 0) {
      const rA = Number(ammState.reserves.A) / 1e6;
      const rB = Number(ammState.reserves.B) / 1e6;
      const ratio = rB / rA; // USDC per EURC
      // Max EURC we can pair with available USDC
      const maxEurcFromUsdc = usdcBal / ratio;
      // Max USDC we can pair with available EURC
      const maxUsdcFromEurc = eurcBal * ratio;
      // Use the smaller of the two to ensure both sides are covered
      let eurcAmt, usdcAmt;
      if (eurcBal <= maxEurcFromUsdc) {
        eurcAmt = eurcBal;
        usdcAmt = eurcBal * ratio;
      } else {
        usdcAmt = usdcBal;
        eurcAmt = usdcBal / ratio;
      }
      const elA = $('amm-liq-input-a');
      const elB = $('amm-liq-input-b');
      if (elA) elA.value = eurcAmt.toFixed(6);
      if (elB) elB.value = usdcAmt.toFixed(6);
      ammUpdateLiqPreview('a');
    }
  }

  // ── 3. Responsive re-check on window resize ─────────────────────────────────
  if (!window._ammResizeHandler) {
    window._ammResizeHandler = function() {
      if (ammState.tab !== 'liquidity') return;
      const sc = $('dex-swap-center');
      if (sc && sc.style.display === 'grid') {
        sc.style.gridTemplateColumns = window.innerWidth >= 1024
          ? 'minmax(0,1fr) minmax(0,1.4fr)'
          : '1fr';
      }
    };
    window.addEventListener('resize', window._ammResizeHandler);
  }
};

// ─── Swap direction flip ───────────────────────────────────────────────────────
window.ammFlipSwap = function() {
  [ammState.swapFrom, ammState.swapTo] = [ammState.swapTo, ammState.swapFrom];
  // Update symbol labels (IDs that exist in HTML)
  setText('amm-swap-from-symbol', ammState.swapFrom);
  setText('amm-swap-to-symbol',   ammState.swapTo);
  setText('amm-swap-to-label',    ammState.swapTo);

  // Update logo (official Circle SVG icons, dynamic)
  const fromLogo = $('amm-swap-from-logo');
  const toLogo   = $('amm-swap-to-logo');
  if (fromLogo) fromLogo.innerHTML = ammTokenIcon(ammState.swapFrom, 28);
  if (toLogo)   toLogo.innerHTML   = ammTokenIcon(ammState.swapTo, 28);

  const inputEl  = $('amm-swap-input');
  const outputEl = $('amm-swap-output');
  if (inputEl)  inputEl.value  = '';
  if (outputEl) outputEl.value = '';
  ammState.quote = null;
  ammUpdateBalanceUI();
  ammUpdateSwapBtn();
  ammHideSwapInfo();
};

// ─── MAX buttons ──────────────────────────────────────────────────────────────
window.ammSetSwapMax = function() {
  const bal    = ammState.swapFrom === 'EURC' ? ammState.balances.EURC : ammState.balances.USDC;
  const human  = ammFormatUnits(bal);
  const inputEl = $('amm-swap-input');
  if (inputEl && parseFloat(human) > 0) {
    inputEl.value = parseFloat(human).toFixed(6);
    ammComputeSwapQuote();
  }
};

window.ammSetLiqMaxA = function() {
  const bal   = ammState.balances.EURC;
  const human = ammFormatUnits(bal);
  const el    = $('amm-liq-input-a');
  if (el) { el.value = parseFloat(human).toFixed(6); ammUpdateLiqPreview('a'); }
};

window.ammSetLiqMaxB = function() {
  const bal   = ammState.balances.USDC;
  const human = ammFormatUnits(bal);
  const el    = $('amm-liq-input-b');
  if (el) { el.value = parseFloat(human).toFixed(6); ammUpdateLiqPreview('b'); }
};

// ─── Liquidity preview ────────────────────────────────────────────────────────
function ammUpdateLiqPreview(source) {
  const elA = $('amm-liq-input-a');
  const elB = $('amm-liq-input-b');
  let amtA = parseFloat(elA?.value || '0') || 0;
  let amtB = parseFloat(elB?.value || '0') || 0;

  // Auto-fill proportional amount based on pool ratio
  if (ammState.reserves.A > 0n && ammState.reserves.B > 0n) {
    const rA = Number(ammState.reserves.A) / 1e6;
    const rB = Number(ammState.reserves.B) / 1e6;
    const ratio = rB / rA; // USDC per EURC
    if (source === 'a' && amtA > 0) {
      amtB = amtA * ratio;
      if (elB) elB.value = amtB.toFixed(6);
    } else if (source === 'b' && amtB > 0) {
      amtA = amtB / ratio;
      if (elA) elA.value = amtA.toFixed(6);
    }
  }

  let lpEst = 0;
  if (amtA > 0 && amtB > 0) {
    if (ammState.totalSupply === 0n || ammState.reserves.A === 0n) {
      // First liquidity: LP = sqrt(amtA * amtB) * 1e6
      lpEst = Math.sqrt(amtA * amtB);
    } else {
      const rA = Number(ammState.reserves.A) / 1e6;
      const rB = Number(ammState.reserves.B) / 1e6;
      const ts = Number(ammState.totalSupply) / 1e6;
      const lpFromA = (amtA / rA) * ts;
      const lpFromB = (amtB / rB) * ts;
      lpEst = Math.min(lpFromA, lpFromB);
    }
  }

  const totalSupplyHuman = Number(ammState.totalSupply) / 1e6;
  const poolSharePct = totalSupplyHuman > 0 && lpEst > 0
    ? (lpEst / (totalSupplyHuman + lpEst) * 100)
    : (amtA > 0 ? 100 : 0);

  setText('amm-liq-lp-est', lpEst > 0 ? lpEst.toFixed(4) + ' LP' : '—');
  setText('amm-liq-pool-share', lpEst > 0 || amtA > 0 ? poolSharePct.toFixed(4) + '%' : '—');

  const addBtn = $('amm-add-liq-btn');
  if (addBtn) {
    const ok = amtA > 0 && amtB > 0 && !!window.walletState?.address && !ammState.pending;
    addBtn.disabled = !ok;
  }

  // Update remove section expected returns based on current LP balance
  ammUpdateRemovePreview();
}

// ─── Remove Liquidity preview — shows expected EURC/USDC returns ─────────────
function ammUpdateRemovePreview() {
  const lpBalance    = Number(ammState.balances.LP) / 1e6;
  const totalSupply  = Number(ammState.totalSupply) / 1e6;
  const rA           = Number(ammState.reserves.A) / 1e6;
  const rB           = Number(ammState.reserves.B) / 1e6;
  const pctStr       = $('amm-remove-pct')?.value || '100';
  const pct          = Math.min(100, Math.max(0, parseFloat(pctStr) || 100)) / 100;
  const lpToRemove   = lpBalance * pct;

  // Pool share
  const mySharePct = totalSupply > 0 ? (lpBalance / totalSupply) * 100 : 0;
  setText('amm-position-share', mySharePct.toFixed(4) + '%');
  setText('amm-bal-lp-share',   mySharePct.toFixed(4) + '%');
  setText('amm-position-lp',    lpBalance.toFixed(4) + ' LP');

  if (lpToRemove > 0 && totalSupply > 0 && rA > 0 && rB > 0) {
    const share    = lpToRemove / totalSupply;
    const estEURC  = rA * share;
    const estUSDC  = rB * share;
    setText('amm-remove-est-eurc', estEURC.toFixed(4) + ' EURC');
    setText('amm-remove-est-usdc', estUSDC.toFixed(4) + ' USDC');
    setText('amm-remove-lp-amt',   lpToRemove.toFixed(4) + ' LP');
  } else {
    setText('amm-remove-est-eurc', '—');
    setText('amm-remove-est-usdc', '—');
    if (lpToRemove === 0) setText('amm-remove-lp-amt', '—');
  }

  // Enable/disable remove button
  const removeBtn = $('amm-remove-liq-btn');
  if (removeBtn) {
    const ok = lpBalance > 0 && !!window.walletState?.address && !ammState.pending;
    removeBtn.disabled = !ok;
  }
}

// ─── EXECUTE SWAP ────────────────────────────────────────────────────────────
window.ammExecuteSwap = async function() {
  if (ammState.pending || !ammState.quote) return;

  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Connect wallet first', 'warning'); return; }
  if (!ammState.deployed) { showToast('Pool is empty. Add liquidity first.', 'warning'); return; }

  const { amountIn, minOut, aToB, rawInput } = ammState.quote;

  ammState.pending = true;
  ammUpdateSwapBtn();

  // Transition info panel from preview to execution mode
  ammShowSwapInfo();

  try {
    await ammEnsureNetwork();

    ammSetSwapInfoStep('approval');

    // 1. Check balance
    const bal = aToB ? ammState.balances.EURC : ammState.balances.USDC;
    if (amountIn > bal) throw new Error(`Insufficient ${ammState.swapFrom} balance`);

    // 2. Approve AMM to spend input token
    const tokenSymbol = ammState.swapFrom;
    const tokenCtrl   = await ammGetERC20(tokenSymbol);
    const allowance   = await tokenCtrl.allowance(wallet, ammState.ammAddress);

    if (allowance < amountIn) {
      showToast(`📝 Approve ${tokenSymbol} — check wallet…`, 'info');
      const approveTx = await tokenCtrl.approve(ammState.ammAddress, amountIn * 2n);
      showToast(`⏳ Approving… ${approveTx.hash.slice(0,14)}`, 'info');
      ammSetSwapInfoStep('confirming');
      const approveReceipt = await approveTx.wait();
      if (!approveReceipt || approveReceipt.status !== 1)
        throw new Error('Approve failed on-chain');
      showToast('✅ Approval confirmed!', 'success');
    }

    // 3. Execute swap on SimpleAMM
    const amm = await ammGetContract();
    showToast(`📝 Confirm swap in wallet: ${rawInput} ${ammState.swapFrom} → ${ammState.swapTo}`, 'info');

    let tx;
    if (aToB) {
      tx = await amm.swapAforB(amountIn, minOut);
    } else {
      tx = await amm.swapBforA(amountIn, minOut);
    }
    const txHash = tx.hash;
    showToast(`⏳ Swap submitted: ${txHash.slice(0,14)}…`, 'info');
    ammSetSwapInfoStep('processing');

    // 4. Wait for confirmation
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error('Swap reverted on-chain');

    const amountOutActual = ammState.quote.amountOut;
    const outHuman = parseFloat(ammFormatUnits(amountOutActual)).toFixed(6);

    ammShowSwapInfoSuccess(txHash);

    showToast(`✅ Swapped! ${rawInput} ${ammState.swapFrom} → ${outHuman} ${ammState.swapTo} <a href="${AMM_EXPLORER}/tx/${txHash}" target="_blank" class="underline">ArcScan ↗</a>`, 'success');

    // 6. Record + refresh
    await fetch('/api/dex/swap/record', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet, fromToken: ammState.swapFrom, toToken: ammState.swapTo, amountIn: amountIn.toString(), amountOut: amountOutActual.toString(), txHash, blockNumber: receipt.blockNumber }),
    }).catch(() => {});

    // Clear form
    ammSetVal('amm-swap-input',  '');
    ammSetVal('amm-swap-output', '');
    ammState.quote = null;

    await ammRefreshAll();

  } catch (err) {
    console.error('[AMM:swap] Error:', err);
    const msg = err.message?.includes('user rejected') || err.code === 4001
      ? 'Transaction rejected by user.'
      : `Swap failed: ${err.message?.slice(0, 100)}`;
    showToast(`❌ ${msg.slice(0, 80)}`, 'error');
    ammShowSwapInfoError(msg);
  } finally {
    ammState.pending = false;
    ammUpdateSwapBtn();
    // Keep info panel visible for 5s after completion so user can review result
    setTimeout(() => {
      // Check that input is still empty (user hasn't started a new trade)
      const inputEl = $('amm-swap-input');
      if (!inputEl || !inputEl.value || parseFloat(inputEl.value) <= 0) {
        ammHideSwapInfo();
      }
    }, 5000);
  }
};

// ─── EXECUTE ADD LIQUIDITY ───────────────────────────────────────────────────
window.ammAddLiquidity = async function() {
  if (ammState.pending) return;

  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Connect wallet first', 'warning'); return; }

  const amtAStr = $('amm-liq-input-a')?.value?.trim() || '';
  const amtBStr = $('amm-liq-input-b')?.value?.trim() || '';

  if (!amtAStr || parseFloat(amtAStr) <= 0 || !amtBStr || parseFloat(amtBStr) <= 0) {
    showToast('Enter amounts for both tokens', 'warning');
    return;
  }

  const amountA = ammParseUnits(amtAStr);
  const amountB = ammParseUnits(amtBStr);

  if (amountA === 0n || amountB === 0n) {
    showToast('Amounts must be greater than 0', 'warning');
    return;
  }
  if (amountA > ammState.balances.EURC) {
    showToast(`Insufficient EURC balance`, 'error'); return;
  }
  if (amountB > ammState.balances.USDC) {
    showToast(`Insufficient USDC balance`, 'error'); return;
  }

  ammState.pending = true;
  hide('amm-liq-result');
  hide('amm-liq-error');
  const addBtn = $('amm-add-liq-btn');
  if (addBtn) { addBtn.disabled = true; addBtn.textContent = '⏳ Processing…'; }

  try {
    await ammEnsureNetwork();

    // Must deploy first
    if (!ammState.deployed || !ammState.ammAddress || ammState.ammAddress === '0x0000000000000000000000000000000000000000') {
      throw new Error('SimpleAMM not deployed. Deploy the contract first.');
    }

    // ── Approve EURC ──────────────────────────────────────────────────────
    const eurcCtrl = await ammGetERC20('EURC');
    const eurcAll  = await eurcCtrl.allowance(wallet, ammState.ammAddress);
    if (eurcAll < amountA) {
      showToast('📝 Approve EURC — check wallet…', 'info');
      const appTx = await eurcCtrl.approve(ammState.ammAddress, amountA * 2n);
      const appRec = await appTx.wait();
      if (!appRec || appRec.status !== 1) throw new Error('EURC approve failed');
      showToast('✅ EURC approved!', 'success');
    }

    // ── Approve USDC ──────────────────────────────────────────────────────
    const usdcCtrl = await ammGetERC20('USDC');
    const usdcAll  = await usdcCtrl.allowance(wallet, ammState.ammAddress);
    if (usdcAll < amountB) {
      showToast('📝 Approve USDC — check wallet…', 'info');
      const appTx = await usdcCtrl.approve(ammState.ammAddress, amountB * 2n);
      const appRec = await appTx.wait();
      if (!appRec || appRec.status !== 1) throw new Error('USDC approve failed');
      showToast('✅ USDC approved!', 'success');
    }

    // ── Add liquidity ──────────────────────────────────────────────────────
    const amm = await ammGetContract();

    console.log('[AMM:addLiq] Calling addLiquidity(', amountA.toString(), ',', amountB.toString(), ')');
    console.log('[AMM:addLiq] AMM address:', ammState.ammAddress);
    console.log('[AMM:addLiq] Current pool reserves — rA:', Number(ammState.reserves.A)/1e6, 'rB:', Number(ammState.reserves.B)/1e6);
    console.log('[AMM:addLiq] Current LP totalSupply:', Number(ammState.totalSupply)/1e6);
    console.log('[AMM:addLiq] User LP before:', Number(ammState.balances.LP)/1e6);

    showToast(`📝 Confirm Add Liquidity in wallet…`, 'info');
    const tx      = await amm.addLiquidity(amountA, amountB);
    const txHash  = tx.hash;
    showToast(`⏳ Tx submitted: ${txHash.slice(0,14)}…`, 'info');
    console.log('[AMM:addLiq] Tx submitted:', txHash);

    const receipt = await tx.wait();
    console.log('[AMM:addLiq] Receipt status:', receipt?.status, '| blockNumber:', receipt?.blockNumber);
    if (!receipt || receipt.status !== 1) throw new Error('addLiquidity reverted on-chain');

    console.log('[AMM:addLiq] Transaction confirmed! Reading new LP balance…');

    // Capture LP balance BEFORE refresh
    const lpBefore = ammState.balances.LP;
    console.log('[AMM:addLiq] LP balance before refresh:', Number(lpBefore)/1e6, 'LP');

    // Small delay to let the node propagate state (avoids stale eth_call results)
    await new Promise(r => setTimeout(r, 800));

    // Direct RPC read is the ONLY reliable source right after a tx
    // (backend API may be cached, ammRefreshAll introduces race conditions)
    await ammFetchBalancesDirect(wallet);
    // Refresh pool state (reserves + totalSupply) without overwriting fresh LP balance
    const poolData = await ammFetchPoolState().catch(() => null);
    if (poolData) ammUpdatePoolUI(poolData);

    const lpAfter  = ammState.balances.LP;
    const lpMinted = lpAfter > lpBefore ? lpAfter - lpBefore : lpAfter;
    console.log('[AMM:addLiq] LP balance after refresh:', Number(lpAfter)/1e6, 'LP | minted:', Number(lpMinted)/1e6, 'LP');

    console.log('[AMM:addLiq] LP before:', Number(lpBefore)/1e6, '| LP after:', Number(lpAfter)/1e6,
      '| LP minted (delta):', Number(lpMinted)/1e6);

    setText('amm-liq-result-a',    amtAStr + ' EURC');
    setText('amm-liq-result-b',    amtBStr + ' USDC');
    setText('amm-liq-result-lp',   parseFloat(ammFormatUnits(lpMinted)).toFixed(4) + ' LP');
    setText('amm-liq-result-hash', txHash.slice(0, 20) + '…');
    const liqHashLink = $('amm-liq-result-hash-link');
    if (liqHashLink) liqHashLink.href = `${AMM_EXPLORER}/tx/${txHash}`;
    show('amm-liq-result');

    showToast(`✅ Liquidity added! Tx: <a href="${AMM_EXPLORER}/tx/${txHash}" target="_blank" class="underline">${txHash.slice(0,14)}… ↗</a>`, 'success');

    await fetch('/api/dex/liquidity/record', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet, amountA: amountA.toString(), amountB: amountB.toString(), txHash, blockNumber: receipt.blockNumber }),
    }).catch(() => {});

    ammSetVal('amm-liq-input-a', '');
    ammSetVal('amm-liq-input-b', '');
    ammUpdateLiqPreview();

  } catch (err) {
    console.error('[AMM:addLiq] Error:', err);
    const msg = err.code === 4001 || err.message?.includes('rejected')
      ? 'Transaction rejected by user.'
      : `Add liquidity failed: ${err.message?.slice(0, 100)}`;
    setText('amm-liq-error-msg', msg);
    show('amm-liq-error');
    showToast(`❌ ${msg.slice(0, 80)}`, 'error');
  } finally {
    ammState.pending = false;
    if (addBtn) { addBtn.disabled = false; addBtn.textContent = '➕ Add Liquidity'; }
    ammUpdateLiqPreview();
  }
};

// ─── EXECUTE REMOVE LIQUIDITY ────────────────────────────────────────────────
window.ammRemoveLiquidity = async function() {
  if (ammState.pending) return;

  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Connect wallet first', 'warning'); return; }

  const lpBalance = ammState.balances.LP;
  if (lpBalance === 0n) {
    showToast('No LP tokens to remove', 'warning');
    return;
  }

  const pctStr = $('amm-remove-pct')?.value || '100';
  const pct    = Math.min(100, Math.max(1, parseFloat(pctStr) || 100));
  const lpAmount = lpBalance * BigInt(Math.floor(pct * 100)) / 10000n;

  if (lpAmount === 0n) { showToast('LP amount is zero', 'warning'); return; }

  ammState.pending = true;
  const removeBtn = $('amm-remove-liq-btn');
  if (removeBtn) { removeBtn.disabled = true; removeBtn.textContent = '⏳ Processing…'; }

  try {
    await ammEnsureNetwork();

    const amm = await ammGetContract();
    console.log('[AMM:removeLiq] Calling removeLiquidity(', lpAmount.toString(), ') =',
      Number(lpAmount)/1e6, 'LP |', pct + '% of', Number(lpBalance)/1e6);
    showToast(`📝 Confirm Remove Liquidity (${pct}%) in wallet…`, 'info');
    const tx = await amm.removeLiquidity(lpAmount);
    showToast(`⏳ Tx submitted: ${tx.hash.slice(0,14)}…`, 'info');
    console.log('[AMM:removeLiq] Tx submitted:', tx.hash);
    const receipt = await tx.wait();
    console.log('[AMM:removeLiq] Receipt status:', receipt?.status);
    if (!receipt || receipt.status !== 1) throw new Error('removeLiquidity reverted');

    showToast(`✅ Liquidity removed! <a href="${AMM_EXPLORER}/tx/${tx.hash}" target="_blank" class="underline">ArcScan ↗</a>`, 'success');

    // Use direct read for immediate balance update
    await ammFetchBalancesDirect(wallet);
    await ammFetchPoolState().then(d => ammUpdatePoolUI(d)).catch(() => {});
    ammUpdateLiqPreview();

  } catch (err) {
    console.error('[AMM:removeLiq] Error:', err);
    const msg = err.code === 4001 || err.message?.includes('rejected')
      ? 'Rejected by user.'
      : `Remove failed: ${err.message?.slice(0, 100)}`;
    showToast(`❌ ${msg}`, 'error');
  } finally {
    ammState.pending = false;
    if (removeBtn) { removeBtn.disabled = false; removeBtn.textContent = '🔥 Remove Liquidity'; }
  }
};

// ─── Refresh everything ───────────────────────────────────────────────────────
async function ammRefreshAll() {
  try {
    const data = await ammFetchPoolState();
    ammUpdatePoolUI(data);
    // Try backend API first, fall back to direct RPC if needed
    await ammFetchBalances();
    ammComputeSwapQuote();
    ammUpdateLiqPreview();
  } catch (e) {
    console.warn('[AMM] refreshAll error:', e.message);
  }
}

// ─── Slippage control ─────────────────────────────────────────────────────────
window.ammSetSlippage = function(pct) {
  ammState.slippage = parseFloat(pct) || 0.5;
  // Update label
  setText('amm-slip-label', ammState.slippage + '%');
  // Update button styles
  ['0.1','0.5','1.0'].forEach(v => {
    const btn = $('amm-slip-' + v.replace('.',''));
    if (!btn) return;
    btn.className = parseFloat(v) === ammState.slippage
      ? 'px-3 py-1 rounded text-xs font-bold bg-cyan-600 text-white'
      : 'px-3 py-1 rounded text-xs font-bold bg-gray-700 text-gray-300 hover:bg-gray-600';
  });
  ammComputeSwapQuote();
};

// ─── Deploy contract helper (UI) ─────────────────────────────────────────────
// SECURITY: Private keys must NEVER be entered or transmitted via the browser.
// Deployment must be done via CLI: forge create or node scripts/deployAMM.cjs
window.ammDeployContract = async function() {
  // Blocked: never accept private keys in the browser
  showToast(
    '🔒 Security: Deploy via CLI only. Never input private keys in the browser. ' +
    'Use: forge create src/SimpleAMM.sol:SimpleAMM --constructor-args <EURC> <USDC> --rpc-url <RPC>',
    'warning'
  );
  console.warn(
    '[AMM] ammDeployContract() blocked — deployment requires CLI.\n' +
    'Use: forge create or node scripts/deployAMM.cjs\n' +
    'NEVER submit private keys via browser forms.'
  );
};

// ─── Init ─────────────────────────────────────────────────────────────────────
async function ammInit() {
  console.log('[AMM] Initialising DEX · Arc Testnet', AMM_CHAIN_ID);

  // Render official Circle token icons (dynamic, from centralized registry)
  ammRenderTokenIcons();

  // Attach input listeners
  const swapInput = $('amm-swap-input');
  if (swapInput) swapInput.addEventListener('input', () => ammComputeSwapQuote());

  const liqA = $('amm-liq-input-a');
  const liqB = $('amm-liq-input-b');
  if (liqA) liqA.addEventListener('input', function() { ammUpdateLiqPreview('a'); });
  if (liqB) liqB.addEventListener('input', function() { ammUpdateLiqPreview('b'); });

  const pctInput = $('amm-remove-pct');
  if (pctInput) pctInput.addEventListener('input', () => {
    ammUpdateRemovePreview();
  });

  // Initial fetch
  await ammRefreshAll();

  // Default tab — swap mode (centred, pool col hidden)
  ammSwitchTab('swap');

  // Auto-refresh every 15s
  setInterval(ammRefreshAll, 15_000);

  console.log('[AMM] Ready · AMM:', ammState.ammAddress, '· Deployed:', ammState.deployed);
}

// ─── Wire to wallet events ────────────────────────────────────────────────────
window.addEventListener('walletConnected', async (e) => {
  console.log('[AMM] Wallet connected:', e.detail?.address);
  await ammFetchBalances();
  ammComputeSwapQuote();
  ammUpdateLiqPreview();
  ammUpdateSwapBtn();
});

window.addEventListener('accountsChanged', async () => {
  await ammFetchBalances();
  ammUpdateSwapBtn();
});

// ─── DOMContentLoaded ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('amm-panel-swap')) {
    ammInit().catch(e => console.error('[AMM] init error:', e));
  }
});

// ─── Swap Info Panel ──────────────────────────────────────────────────────────

// Track whether panel is in pre-execution (preview) or execution mode
let ammInfoMode = 'hidden'; // 'hidden' | 'preview' | 'execution'

// Show info panel in pre-execution mode (trade preview, before clicking Swap)
function ammShowSwapInfoPre() {
  const panel = $('amm-swap-info-panel');
  const center = $('dex-swap-center');
  if (!panel) return;

  const quote = ammState.quote;
  if (!quote) return;

  ammInfoMode = 'preview';

  setText('amm-info-from-symbol', ammState.swapFrom);
  setText('amm-info-to-symbol', ammState.swapTo);
  setText('amm-info-amount-in', quote.rawInput);

  const outHuman = parseFloat(ammFormatUnits(quote.amountOut)).toFixed(6);
  setText('amm-info-amount-out', outHuman + ' (est.)');

  const feeEl = $('amm-info-fee');
  if (feeEl) { const feeSrc = $('amm-swap-fee'); feeEl.textContent = feeSrc ? feeSrc.textContent : '—'; }

  setText('amm-info-slippage', ammState.slippage + '%');

  const impactEl = $('amm-info-impact');
  if (impactEl) { const src = $('amm-price-impact'); impactEl.textContent = src ? src.textContent : '—'; }

  const stepsEl = $('amm-info-steps');
  if (stepsEl) stepsEl.classList.add('hidden');

  hide('amm-info-error');
  hide('amm-info-hash-row');

  const icon = $('amm-info-icon');
  if (icon) { icon.className = 'fas fa-info-circle text-cyan-400 text-xs'; }
  setText('amm-info-title', 'Ready to Swap');

  panel.classList.remove('amm-info-hidden');
  panel.classList.add('amm-info-visible');
  if (center) center.classList.add('amm-info-mode');
}

// Show info panel in execution mode (when user clicks Swap)
function ammShowSwapInfo() {
  const panel = $('amm-swap-info-panel');
  const center = $('dex-swap-center');
  if (!panel) return;

  ammInfoMode = 'execution';

  const quote = ammState.quote;
  if (quote) {
    setText('amm-info-from-symbol', ammState.swapFrom);
    setText('amm-info-to-symbol', ammState.swapTo);
    setText('amm-info-amount-in', quote.rawInput);
    const outEst = parseFloat(ammFormatUnits(quote.amountOut)).toFixed(6) + ' (est.)';
    setText('amm-info-amount-out', outEst);

    const feeEl = $('amm-info-fee');
    if (feeEl) { const feeSrc = $('amm-swap-fee'); feeEl.textContent = feeSrc ? feeSrc.textContent : '—'; }

    setText('amm-info-slippage', ammState.slippage + '%');

    const impactEl = $('amm-info-impact');
    if (impactEl) { const src = $('amm-price-impact'); impactEl.textContent = src ? src.textContent : '—'; }
  }

  const stepsEl = $('amm-info-steps');
  if (stepsEl) stepsEl.classList.remove('hidden');

  const steps = panel.querySelectorAll('.amm-info-step');
  steps.forEach(s => s.classList.remove('amm-info-step-active', 'amm-info-step-done', 'amm-info-step-error'));

  hide('amm-info-error');
  hide('amm-info-hash-row');

  const icon = $('amm-info-icon');
  if (icon) { icon.className = 'fas fa-circle-notch fa-spin text-cyan-400 text-xs'; }
  setText('amm-info-title', 'Swap in Progress');

  panel.classList.remove('amm-info-hidden');
  panel.classList.add('amm-info-visible');
  if (center) center.classList.add('amm-info-mode');

  ammSetSwapInfoStep('approval');
}

function ammSetSwapInfoStep(step) {
  const steps = document.querySelectorAll('#amm-swap-info-panel .amm-info-step');
  const order = ['approval', 'confirming', 'processing', 'completed'];
  const idx = order.indexOf(step);
  if (idx < 0) return;

  steps.forEach((s, i) => {
    s.classList.remove('amm-info-step-active', 'amm-info-step-done', 'amm-info-step-error');
    if (i < idx) s.classList.add('amm-info-step-done');
    else if (i === idx) s.classList.add('amm-info-step-active');
  });
}

function ammShowSwapInfoError(msg) {
  ammInfoMode = 'completed';
  setText('amm-info-error-msg', msg);
  show('amm-info-error');

  const activeStep = document.querySelector('#amm-swap-info-panel .amm-info-step-active');
  if (activeStep) {
    activeStep.classList.remove('amm-info-step-active');
    activeStep.classList.add('amm-info-step-error');
  }

  const icon = $('amm-info-icon');
  if (icon) { icon.className = 'fas fa-times-circle text-red-400 text-xs'; }
  setText('amm-info-title', 'Swap Failed');
}

function ammShowSwapInfoSuccess(txHash) {
  ammInfoMode = 'completed';
  ammSetSwapInfoStep('completed');

  const icon = $('amm-info-icon');
  if (icon) { icon.className = 'fas fa-check-circle text-green-400 text-xs'; }
  setText('amm-info-title', 'Swap Complete');

  if (txHash) {
    setText('amm-info-hash', txHash.slice(0, 20) + '\u2026');
    const link = $('amm-info-hash-link');
    if (link) link.href = AMM_EXPLORER + '/tx/' + txHash;
    show('amm-info-hash-row');
  }
}

function ammHideSwapInfo() {
  const panel = $('amm-swap-info-panel');
  const center = $('dex-swap-center');
  if (!panel) return;

  ammInfoMode = 'hidden';

  panel.classList.remove('amm-info-visible');
  panel.classList.add('amm-info-hidden');
  if (center) center.classList.remove('amm-info-mode');
}

// ─── Expose globals ───────────────────────────────────────────────────────────
window.ammInit             = ammInit;
window.ammRefreshAll       = ammRefreshAll;
window.ammComputeSwapQuote = ammComputeSwapQuote;
window.ammUpdateLiqPreview = ammUpdateLiqPreview;
window.ammUpdateRemovePreview = ammUpdateRemovePreview;
window.ammFetchBalancesDirect = ammFetchBalancesDirect;

console.log('[AMM] Module loaded · Arc Testnet', AMM_CHAIN_ID);
console.log('[AMM] Tokens: EURC', AMM_TOKENS.EURC.address, '/ USDC', AMM_TOKENS.USDC.address);
console.log('[AMM] x*y=k formula · fee 0.3% · no mock data');
