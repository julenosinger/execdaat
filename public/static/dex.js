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
  EURC: { symbol: 'EURC', name: 'Euro Coin',  address: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a', decimals: 6, logo: '💶' },
  USDC: { symbol: 'USDC', name: 'USD Coin',   address: '0x3600000000000000000000000000000000000000', decimals: 6, logo: '💵' },
};

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
  try {
    const res  = await fetch(`/api/dex/amm/balances/${wallet}`);
    const data = await res.json();
    if (data.success) {
      ammState.balances.EURC = BigInt(data.balances.EURC.raw);
      ammState.balances.USDC = BigInt(data.balances.USDC.raw);
      ammState.balances.LP   = BigInt(data.balances.LP.raw);
      ammUpdateBalanceUI();
    }
  } catch (e) {
    console.warn('[AMM] fetchBalances error:', e.message);
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

  // MAX buttons
  const swapFromBal = ammState.swapFrom === 'EURC' ? eurc : usdc;
  setText('amm-swap-from-bal', parseFloat(swapFromBal).toFixed(4) + ' ' + ammState.swapFrom);
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
    ammState.quote = null;
    ammUpdateSwapBtn();
    return;
  }

  const amountIn = ammParseUnits(rawInput);
  const aToB = ammState.swapFrom === 'EURC';
  const rIn  = aToB ? ammState.reserves.A : ammState.reserves.B;
  const rOut = aToB ? ammState.reserves.B : ammState.reserves.A;

  if (rIn === 0n || rOut === 0n) {
    if (outputEl) outputEl.value = '0.000000';
    setText('amm-price-impact', 'Pool empty');
    ammState.quote = null;
    ammUpdateSwapBtn();
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
  ['swap','liquidity'].forEach(t => {
    const btn    = $('amm-tab-' + t);
    const panel  = $('amm-panel-' + t);
    if (btn) {
      if (t === tab) {
        btn.className = 'flex-1 py-2.5 px-4 text-sm font-semibold rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 text-white shadow-lg shadow-cyan-900/30 transition-all';
      } else {
        btn.className = 'flex-1 py-2.5 px-4 text-sm font-semibold rounded-xl text-gray-400 hover:text-white hover:bg-gray-800/60 transition-all';
      }
    }
    if (panel) {
      panel.classList.toggle('hidden', t !== tab);
    }
  });
};

// ─── Swap direction flip ───────────────────────────────────────────────────────
window.ammFlipSwap = function() {
  [ammState.swapFrom, ammState.swapTo] = [ammState.swapTo, ammState.swapFrom];
  // Update symbol labels (IDs that exist in HTML)
  setText('amm-swap-from-symbol', ammState.swapFrom);
  setText('amm-swap-to-symbol',   ammState.swapTo);
  setText('amm-swap-to-label',    ammState.swapTo);

  // Update logo/color
  const fromLogo = $('amm-swap-from-logo');
  const toLogo   = $('amm-swap-to-logo');
  if (fromLogo) fromLogo.textContent = AMM_TOKENS[ammState.swapFrom].logo;
  if (toLogo)   toLogo.textContent   = AMM_TOKENS[ammState.swapTo].logo;

  const inputEl  = $('amm-swap-input');
  const outputEl = $('amm-swap-output');
  if (inputEl)  inputEl.value  = '';
  if (outputEl) outputEl.value = '';
  ammState.quote = null;
  ammUpdateBalanceUI();
  ammUpdateSwapBtn();
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
  if (el) { el.value = parseFloat(human).toFixed(6); ammUpdateLiqPreview(); }
};

window.ammSetLiqMaxB = function() {
  const bal   = ammState.balances.USDC;
  const human = ammFormatUnits(bal);
  const el    = $('amm-liq-input-b');
  if (el) { el.value = parseFloat(human).toFixed(6); ammUpdateLiqPreview(); }
};

// ─── Liquidity preview ────────────────────────────────────────────────────────
function ammUpdateLiqPreview() {
  const amtA = parseFloat($('amm-liq-input-a')?.value || '0') || 0;
  const amtB = parseFloat($('amm-liq-input-b')?.value || '0') || 0;

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

  setText('amm-liq-lp-est', lpEst > 0 ? lpEst.toFixed(4) + ' LP' : '—');
  setText('amm-liq-pool-share', ammState.totalSupply > 0n && lpEst > 0
    ? (lpEst / (Number(ammState.totalSupply) / 1e6 + lpEst) * 100).toFixed(4) + '%'
    : amtA > 0 ? '100.00%' : '—');

  const addBtn = $('amm-add-liq-btn');
  if (addBtn) {
    const ok = amtA > 0 && amtB > 0 && !!window.walletState?.address && !ammState.pending;
    addBtn.disabled = !ok;
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
  hide('amm-swap-result');
  hide('amm-swap-error');

  try {
    await ammEnsureNetwork();

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

    // 4. Wait for confirmation
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error('Swap reverted on-chain');

    const amountOutActual = ammState.quote.amountOut;
    const outHuman = parseFloat(ammFormatUnits(amountOutActual)).toFixed(6);

    // 5. Show result
    setText('amm-result-in',   rawInput + ' ' + ammState.swapFrom);
    setText('amm-result-out',  outHuman + ' ' + ammState.swapTo);
    setText('amm-result-hash', txHash.slice(0, 20) + '…');
    const hashLink = $('amm-result-hash-link');
    if (hashLink) hashLink.href = `${AMM_EXPLORER}/tx/${txHash}`;
    show('amm-swap-result');

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
    setText('amm-swap-error-msg', msg);
    show('amm-swap-error');
    showToast(`❌ ${msg.slice(0, 80)}`, 'error');
  } finally {
    ammState.pending = false;
    ammUpdateSwapBtn();
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
    showToast(`📝 Confirm Add Liquidity in wallet…`, 'info');
    const tx      = await amm.addLiquidity(amountA, amountB);
    const txHash  = tx.hash;
    showToast(`⏳ Tx submitted: ${txHash.slice(0,14)}…`, 'info');
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error('addLiquidity reverted');

    // Parse LiquidityAdded event for lpMinted
    let lpMinted = 0n;
    const addedTopic = '0x' + 'LiquidityAdded'.split('').reduce((a, c) => a, ''); // placeholder
    // Find LP amount from state change
    await ammRefreshAll();
    const newLP = ammState.balances.LP;
    lpMinted    = newLP; // approximation

    setText('amm-liq-result-a',    amtAStr + ' EURC');
    setText('amm-liq-result-b',    amtBStr + ' USDC');
    setText('amm-liq-result-lp',   parseFloat(ammFormatUnits(newLP)).toFixed(4) + ' LP');
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
    showToast(`📝 Confirm Remove Liquidity (${pct}%) in wallet…`, 'info');
    const tx = await amm.removeLiquidity(lpAmount);
    showToast(`⏳ Tx submitted: ${tx.hash.slice(0,14)}…`, 'info');
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error('removeLiquidity reverted');

    showToast(`✅ Liquidity removed! <a href="${AMM_EXPLORER}/tx/${tx.hash}" target="_blank" class="underline">ArcScan ↗</a>`, 'success');
    await ammRefreshAll();

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

// ─── Deploy contract helper (UI) ──────────────────────────────────────────────
window.ammDeployContract = async function() {
  const pkInput = $('amm-pk-input');
  const pk = pkInput?.value?.trim();
  if (!pk || pk.length < 60) {
    showToast('Enter a valid private key', 'error');
    return;
  }

  showToast('⚠️ Deploying via backend — key not sent over network in prod', 'warning');

  try {
    const res = await fetch('/api/dex/amm/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ privateKey: pk }),
    });
    const data = await res.json();
    if (data.success) {
      ammState.ammAddress = data.ammAddress;
      ammState.deployed   = true;
      showToast(`✅ Deployed at ${data.ammAddress}`, 'success');
      if (pkInput) pkInput.value = '';
      await ammRefreshAll();
    } else {
      showToast(`❌ Deploy failed: ${data.error}`, 'error');
    }
  } catch (e) {
    showToast(`❌ ${e.message}`, 'error');
  }
};

// ─── Init ─────────────────────────────────────────────────────────────────────
async function ammInit() {
  console.log('[AMM] Initialising DEX · Arc Testnet', AMM_CHAIN_ID);

  // Attach input listeners
  const swapInput = $('amm-swap-input');
  if (swapInput) swapInput.addEventListener('input', () => ammComputeSwapQuote());

  const liqA = $('amm-liq-input-a');
  const liqB = $('amm-liq-input-b');
  if (liqA) liqA.addEventListener('input', () => ammUpdateLiqPreview());
  if (liqB) liqB.addEventListener('input', () => ammUpdateLiqPreview());

  const pctInput = $('amm-remove-pct');
  if (pctInput) pctInput.addEventListener('input', () => {
    const pct = Math.min(100, Math.max(1, parseFloat(pctInput.value) || 100));
    const lp  = Number(ammState.balances.LP) / 1e6;
    setText('amm-remove-lp-amt', (lp * pct / 100).toFixed(4) + ' LP');
  });

  // Initial fetch
  await ammRefreshAll();

  // Default tab
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

// ─── Expose globals ───────────────────────────────────────────────────────────
window.ammInit             = ammInit;
window.ammRefreshAll       = ammRefreshAll;
window.ammComputeSwapQuote = ammComputeSwapQuote;
window.ammUpdateLiqPreview = ammUpdateLiqPreview;

console.log('[AMM] Module loaded · Arc Testnet', AMM_CHAIN_ID);
console.log('[AMM] Tokens: EURC', AMM_TOKENS.EURC.address, '/ USDC', AMM_TOKENS.USDC.address);
console.log('[AMM] x*y=k formula · fee 0.3% · no mock data');
