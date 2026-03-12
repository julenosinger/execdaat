// ===== SWAP MODULE =====
// Handles USDC ↔ EURC swap UI and API calls

let swapState = {
  fromToken: 'USDC',
  toToken: 'EURC',
  amountIn: 0,
  quote: null,
  slippage: 0.5,
  rates: null,
  debounceTimer: null,
};

// ─── Init ────────────────────────────────────────────────────────────────────
function initSwap() {
  loadSwapRates();
}

// ─── Load Rates ──────────────────────────────────────────────────────────────
async function loadSwapRates() {
  try {
    const icon = document.getElementById('swap-rate-spinner');
    if (icon) icon.classList.add('fa-spin');

    const res = await axios.get('/api/swap/rates');
    if (res.data.success) {
      swapState.rates = res.data.rates;
      const from = swapState.fromToken;
      const to = swapState.toToken;
      const key = `${from}_TO_${to}`;
      const rate = res.data.rates[key] || '—';
      const el = document.getElementById('swap-rate-display');
      if (el) el.textContent = `1 ${from} = ${rate} ${to}`;
    }
  } catch (e) {
    console.error('Swap rates error:', e);
  } finally {
    const icon = document.getElementById('swap-rate-spinner');
    if (icon) icon.classList.remove('fa-spin');
  }
}

// ─── Debounced Input Handler ──────────────────────────────────────────────────
function onSwapInputChange() {
  clearTimeout(swapState.debounceTimer);
  swapState.debounceTimer = setTimeout(fetchSwapQuote, 400);
}

// ─── Fetch Quote ──────────────────────────────────────────────────────────────
async function fetchSwapQuote() {
  const fromToken = document.getElementById('swap-from-token')?.value || 'USDC';
  const amountRaw = document.getElementById('swap-amount-in')?.value || '';
  const amount = parseFloat(amountRaw);

  // Update to-token display
  const toToken = fromToken === 'USDC' ? 'EURC' : 'USDC';
  swapState.fromToken = fromToken;
  swapState.toToken = toToken;
  const toIcon = document.getElementById('swap-to-token-icon');
  const toName = document.getElementById('swap-to-token-name');
  if (toIcon) toIcon.textContent = toToken === 'USDC' ? '💵' : '💶';
  if (toName) toName.textContent = toToken;

  // Update rate display
  loadSwapRates();

  if (!amount || isNaN(amount) || amount <= 0) {
    const outEl = document.getElementById('swap-amount-out');
    if (outEl) outEl.textContent = '—';
    document.getElementById('swap-quote-details')?.classList.add('hidden');
    return;
  }

  try {
    const res = await axios.get('/api/swap/quote', {
      params: { from: fromToken, to: toToken, amount }
    });

    if (res.data.success) {
      const q = res.data.quote;
      swapState.quote = q;

      // Update output
      const outEl = document.getElementById('swap-amount-out');
      if (outEl) outEl.textContent = `${q.amountOut.toFixed(4)} ${toToken}`;

      // Update fee display
      const feeEl = document.getElementById('swap-fee-display');
      if (feeEl) feeEl.textContent = `Fee: ${q.fee.toFixed(4)} ${toToken}`;

      // Quote details
      const details = document.getElementById('swap-quote-details');
      if (details) {
        details.classList.remove('hidden');
        document.getElementById('sq-rate').textContent = `1 ${fromToken} = ${q.rate} ${toToken}`;
        document.getElementById('sq-fee').textContent = `${q.fee.toFixed(4)} ${toToken} (${q.feePercent}%)`;

        const impactEl = document.getElementById('sq-impact');
        const impact = q.priceImpact;
        impactEl.textContent = `${impact.toFixed(3)}%`;
        impactEl.className = impact < 0.5 ? 'text-green-400' : impact < 2 ? 'text-yellow-400' : 'text-red-400';

        document.getElementById('sq-min').textContent = `${q.minimumReceived.toFixed(4)} ${toToken}`;
      }
    }
  } catch (e) {
    const outEl = document.getElementById('swap-amount-out');
    if (outEl) outEl.textContent = 'Error';
    console.error('Quote error:', e);
  }
}

// ─── Flip token sides ─────────────────────────────────────────────────────────
function swapTokenSides() {
  const sel = document.getElementById('swap-from-token');
  if (!sel) return;
  sel.value = sel.value === 'USDC' ? 'EURC' : 'USDC';
  const amtEl = document.getElementById('swap-amount-in');
  const outEl = document.getElementById('swap-amount-out');
  // Swap amounts if quote exists
  if (swapState.quote && amtEl && outEl) {
    const oldIn = parseFloat(amtEl.value) || 0;
    const oldOut = swapState.quote.amountOut || 0;
    amtEl.value = oldOut.toFixed(4);
  }
  onSwapInputChange();
}

// ─── Set Slippage ─────────────────────────────────────────────────────────────
function setSlippage(val) {
  swapState.slippage = val || 0.5;
  document.querySelectorAll('.slippage-btn').forEach(b => {
    b.classList.remove('active', 'bg-purple-800', 'text-purple-200', 'border-purple-600');
    b.classList.add('bg-gray-800', 'text-gray-400', 'border-gray-700');
  });
  const btns = document.querySelectorAll('.slippage-btn');
  const presets = [0.5, 1, 2];
  presets.forEach((p, i) => {
    if (Math.abs(val - p) < 0.01 && btns[i]) {
      btns[i].classList.add('active', 'bg-purple-800', 'text-purple-200', 'border-purple-600');
      btns[i].classList.remove('bg-gray-800', 'text-gray-400', 'border-gray-700');
    }
  });
}

// ─── Execute Swap ─────────────────────────────────────────────────────────────
async function executeSwap() {
  const fromToken = document.getElementById('swap-from-token')?.value;
  const amountRaw = document.getElementById('swap-amount-in')?.value;
  const amount = parseFloat(amountRaw);

  if (!amount || isNaN(amount) || amount <= 0) {
    showToast('Please enter a valid amount', 'error');
    return;
  }
  if (amount > 100000) {
    showToast('Maximum swap: 100,000 per transaction', 'error');
    return;
  }

  const toToken = fromToken === 'USDC' ? 'EURC' : 'USDC';

  // Get wallet address from connected wallet or use placeholder
  const walletAddress = window._walletAddress || '0xDemo0000000000000000000000000000000000';

  const btn = document.getElementById('swap-submit-btn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i> Processing...';
  }

  try {
    const res = await axios.post('/api/swap/execute', {
      fromToken,
      toToken,
      amountIn: amount,
      walletAddress,
      slippageTolerance: swapState.slippage,
    });

    if (res.data.success) {
      const swap = res.data.swap;
      showToast(`✅ Swapped ${amount} ${fromToken} → ${swap.amountOut.toFixed(4)} ${toToken}`, 'success');
      // Clear form
      const amtEl = document.getElementById('swap-amount-in');
      if (amtEl) amtEl.value = '';
      const outEl = document.getElementById('swap-amount-out');
      if (outEl) outEl.textContent = '—';
      document.getElementById('swap-quote-details')?.classList.add('hidden');
      // Reload history
      loadSwapHistory();
      loadSwapRates();
    } else {
      showToast(res.data.error || 'Swap failed', 'error');
    }
  } catch (e) {
    const msg = e.response?.data?.error || e.message || 'Swap error';
    showToast(msg, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-exchange-alt mr-2"></i> <span data-i18n="swap_execute">Swap Tokens</span>';
      if (window.applyTranslations) applyTranslations();
    }
  }
}

// ─── Load Swap History ────────────────────────────────────────────────────────
async function loadSwapHistory() {
  try {
    const res = await axios.get('/api/swap/history?limit=15');
    const container = document.getElementById('swap-history-list');
    if (!container) return;

    if (!res.data.success || !res.data.swaps?.length) {
      container.innerHTML = '<div class="text-center py-6 text-gray-600 text-sm"><i class="fas fa-exchange-alt mr-2"></i>No swaps yet</div>';
      return;
    }

    const stats = res.data.stats;
    const statsHtml = `<div class="grid grid-cols-3 gap-3 mb-4">
      <div class="bg-gray-800/60 rounded-xl p-3 text-center">
        <p class="text-xs text-gray-400">Total Swaps</p>
        <p class="text-white font-bold">${stats.totalSwaps}</p>
      </div>
      <div class="bg-gray-800/60 rounded-xl p-3 text-center">
        <p class="text-xs text-gray-400">Volume</p>
        <p class="text-blue-400 font-bold">${stats.totalVolume.toLocaleString()}</p>
      </div>
      <div class="bg-gray-800/60 rounded-xl p-3 text-center">
        <p class="text-xs text-gray-400">Pool USDC</p>
        <p class="text-green-400 font-bold">${(stats.pool.usdcReserve/1000).toFixed(0)}k</p>
      </div>
    </div>`;

    const rows = res.data.swaps.map(s => {
      const from = s.type === 'USDC_TO_EURC' ? 'USDC' : 'EURC';
      const to = s.type === 'USDC_TO_EURC' ? 'EURC' : 'USDC';
      const fromIcon = from === 'USDC' ? '💵' : '💶';
      const toIcon = to === 'USDC' ? '💵' : '💶';
      const dt = new Date(s.timestamp).toLocaleString();
      return `<div class="flex items-center justify-between py-2.5 border-b border-gray-700/30 last:border-0">
        <div class="flex items-center gap-2">
          <span>${fromIcon}</span>
          <span class="text-white font-mono text-sm">${s.amountIn.toFixed(2)}</span>
          <i class="fas fa-arrow-right text-purple-400 text-xs"></i>
          <span>${toIcon}</span>
          <span class="text-green-400 font-mono text-sm">${s.amountOut.toFixed(4)}</span>
        </div>
        <div class="text-right">
          <p class="text-xs text-gray-500">${dt}</p>
          <a href="https://testnet.arcscan.app/tx/${s.txHash}" target="_blank" class="text-xs text-blue-400 hover:underline">tx ↗</a>
        </div>
      </div>`;
    }).join('');

    container.innerHTML = statsHtml + rows;
  } catch (e) {
    console.error('Swap history error:', e);
  }
}

// Auto-init when tab is activated (called from app.js switchTab)
window.loadSwap = function() {
  loadSwapRates();
  loadSwapHistory();
};
