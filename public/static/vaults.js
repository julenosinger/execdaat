// ===== VAULTS MODULE =====
// Handles USDC and EURC vault UI

let vaultActions = { usdc: 'deposit', eurc: 'deposit' };

// ─── Load Vaults Overview ─────────────────────────────────────────────────────
async function loadVaults() {
  try {
    const res = await axios.get('/api/vaults');
    if (!res.data.success) return;

    res.data.vaults.forEach(v => {
      const tok = v.token.toLowerCase();
      setEl(`${tok}-vault-balance`, `${v.currentBalance.toLocaleString()} ${v.token}`);
      setEl(`${tok}-vault-apy`, `${v.apy}%`);
      setEl(`${tok}-vault-accrued`, `${v.accrued.toFixed(4)} ${v.token}`);
      setEl(`${tok}-vault-deposited`, `${v.totalDeposited.toLocaleString()} ${v.token}`);
      setEl(`${tok}-vault-participants`, `${v.participants}`);
    });
  } catch (e) {
    console.error('Vault load error:', e);
  }
}

function setEl(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

// ─── Toggle Deposit/Withdraw Form ─────────────────────────────────────────────
function setVaultAction(token, action) {
  vaultActions[token] = action;
  const form = document.getElementById(`${token}-vault-form`);
  if (form) form.classList.remove('hidden');

  const labelEl = document.getElementById(`${token}-vault-action-label`);
  if (labelEl) labelEl.textContent = action === 'deposit' ? 'Deposit' : 'Withdraw';

  const submitBtn = document.getElementById(`${token}-vault-submit-btn`);
  if (submitBtn) {
    const isDeposit = action === 'deposit';
    submitBtn.className = `w-full ${isDeposit ? (token === 'usdc' ? 'bg-blue-600 hover:bg-blue-500' : 'bg-yellow-600 hover:bg-yellow-500') : 'bg-gray-600 hover:bg-gray-500'} text-white rounded-xl py-2.5 text-sm font-semibold transition-all flex items-center justify-center gap-2`;
  }

  // Active button styling
  const depBtn = document.getElementById(`${token}-dep-btn`);
  const witBtn = document.getElementById(`${token}-wit-btn`);
  if (action === 'deposit') {
    depBtn?.classList.add('ring-2', 'ring-white/20');
    witBtn?.classList.remove('ring-2', 'ring-white/20');
  } else {
    witBtn?.classList.add('ring-2', 'ring-white/20');
    depBtn?.classList.remove('ring-2', 'ring-white/20');
  }

  // yield checkbox only visible for withdraw
  const yieldCheck = document.getElementById(`${token}-include-yield`);
  const yieldLabel = yieldCheck?.nextElementSibling;
  if (yieldCheck) yieldCheck.style.display = action === 'withdraw' ? '' : 'none';
  if (yieldLabel) yieldLabel.style.display = action === 'withdraw' ? '' : 'none';
}

// ─── Submit Vault Action ──────────────────────────────────────────────────────
async function submitVaultAction(token) {
  const action = vaultActions[token] || 'deposit';
  const amountEl = document.getElementById(`${token}-vault-amount`);
  const amount = parseFloat(amountEl?.value || '0');
  const includeYield = document.getElementById(`${token}-include-yield`)?.checked || false;

  if (!amount || isNaN(amount) || amount <= 0) {
    showToast('Please enter a valid amount', 'error');
    return;
  }

  const walletAddress = window._walletAddress || '0xDemo0000000000000000000000000000000000';
  const tokenSymbol = token.toUpperCase();

  const submitBtn = document.getElementById(`${token}-vault-submit-btn`);
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i> Processing...';
  }

  try {
    const endpoint = `/api/vaults/${token}/${action}`;
    const payload = { walletAddress, amount, includeYield };
    const res = await axios.post(endpoint, payload);

    if (res.data.success) {
      const msg = action === 'deposit'
        ? `✅ Deposited ${amount} ${tokenSymbol} into vault`
        : `✅ Withdrew ${amount} ${tokenSymbol} from vault`;
      showToast(msg, 'success');

      // Clear form
      if (amountEl) amountEl.value = '';

      // Reload vaults
      await loadVaults();
      await loadVaultHistory(token);
    } else {
      showToast(res.data.error || 'Vault action failed', 'error');
    }
  } catch (e) {
    const msg = e.response?.data?.error || e.message || 'Error';
    showToast(msg, 'error');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      const actionLabel = action === 'deposit' ? 'Deposit' : 'Withdraw';
      submitBtn.innerHTML = `<i class="fas fa-check mr-2"></i> ${actionLabel}`;
    }
  }
}

// ─── Load Vault History ───────────────────────────────────────────────────────
async function loadVaultHistory(token = 'usdc') {
  try {
    const res = await axios.get(`/api/vaults/${token}/history?limit=15`);
    const container = document.getElementById('vault-history-list');
    if (!container) return;

    if (!res.data.success || !res.data.history?.length) {
      container.innerHTML = `<div class="text-center py-6 text-gray-600 text-sm"><i class="fas fa-vault mr-2"></i>No ${token.toUpperCase()} vault activity yet</div>`;
      return;
    }

    const stats = res.data.stats;
    const tokenSymbol = token.toUpperCase();
    const statsHtml = `<div class="grid grid-cols-3 gap-3 mb-4">
      <div class="bg-gray-800/60 rounded-xl p-3 text-center">
        <p class="text-xs text-gray-400">Balance</p>
        <p class="text-white font-bold text-sm">${stats.currentBalance.toLocaleString()}</p>
      </div>
      <div class="bg-gray-800/60 rounded-xl p-3 text-center">
        <p class="text-xs text-gray-400">APY</p>
        <p class="text-green-400 font-bold">${stats.apy}%</p>
      </div>
      <div class="bg-gray-800/60 rounded-xl p-3 text-center">
        <p class="text-xs text-gray-400">Yield</p>
        <p class="text-yellow-400 font-bold text-sm">${stats.accrued.toFixed(4)}</p>
      </div>
    </div>`;

    const rows = res.data.history.map(h => {
      const isPositive = h.amount >= 0;
      const typeIcon = h.type === 'deposit' ? '⬇️' : h.type === 'withdraw' ? '⬆️' : '💰';
      const amtColor = isPositive ? 'text-green-400' : 'text-red-400';
      const amtPrefix = isPositive ? '+' : '';
      const dt = new Date(h.timestamp).toLocaleString();
      return `<div class="flex items-center justify-between py-2.5 border-b border-gray-700/30 last:border-0">
        <div class="flex items-center gap-3">
          <span class="text-lg">${typeIcon}</span>
          <div>
            <p class="${amtColor} font-mono font-semibold">${amtPrefix}${Math.abs(h.amount).toFixed(2)} ${tokenSymbol}</p>
            <p class="text-xs text-gray-500">${h.type.toUpperCase()}${h.note ? ` — ${h.note}` : ''}</p>
          </div>
        </div>
        <div class="text-right">
          <p class="text-xs text-gray-500">${dt}</p>
          <a href="https://testnet.arcscan.app/tx/${h.txHash}" target="_blank" class="text-xs text-blue-400 hover:underline">tx ↗</a>
        </div>
      </div>`;
    }).join('');

    container.innerHTML = statsHtml + rows;
  } catch (e) {
    console.error('Vault history error:', e);
  }
}

// ─── Window hook ──────────────────────────────────────────────────────────────
window.loadVaultData = function() {
  loadVaults();
  loadVaultHistory('usdc');
};
