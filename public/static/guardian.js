// ===== GUARDIAN AGENT MODULE =====
// Compliance & KYC UI — integrado com assinatura EVM

let guardianState = {
  kycAddress: '',
  lastCheck: null,
};

// ─── Load Guardian Status ─────────────────────────────────────────────────────
async function loadGuardianStatus() {
  try {
    const res = await axios.get('/api/guardian/status');
    if (!res.data.success) return;

    const stats = res.data.stats;
    setGuardianEl('guardian-total-checks', stats.totalChecks ?? 0);
    setGuardianEl('guardian-approved', stats.approved ?? 0);
    setGuardianEl('guardian-blocked', stats.blocked ?? 0);
    setGuardianEl('guardian-flagged', stats.flagged ?? 0);
    setGuardianEl('guardian-avg-risk', `${stats.averageRiskScore ?? 0}/100`);
    setGuardianEl('guardian-kyc-verified', stats.kycVerified ?? 0);
    setGuardianEl('guardian-kyc-pending', stats.kycPending ?? 0);
    setGuardianEl('guardian-status-badge', res.data.agent.status.toUpperCase());
  } catch (e) {
    console.error('Guardian status error:', e);
  }
}

// ─── Load Compliance Log ──────────────────────────────────────────────────────
async function loadComplianceLog() {
  try {
    const res = await axios.get('/api/guardian/log?limit=10');
    const container = document.getElementById('compliance-log-list');
    if (!container) return;

    if (!res.data.checks?.length) {
      container.innerHTML = '<div class="text-center py-4 text-gray-600 text-sm">No compliance checks yet</div>';
      return;
    }

    container.innerHTML = res.data.checks.map(c => {
      const approved = c.result.approved;
      const riskColor = { low: 'text-green-400', medium: 'text-yellow-400', high: 'text-orange-400', critical: 'text-red-400', blocked: 'text-red-600' }[c.result.riskLevel] || 'text-gray-400';
      const icon = approved ? 'fa-check-circle text-green-400' : 'fa-times-circle text-red-400';
      const dt = new Date(c.timestamp).toLocaleString();
      return `
        <div class="flex items-start gap-3 py-3 border-b border-gray-700/30 last:border-0">
          <i class="fas ${icon} mt-0.5 flex-shrink-0"></i>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-white text-xs font-mono">${c.fromAddress.slice(0,10)}...</span>
              <span class="text-xs px-2 py-0.5 rounded-full ${approved ? 'bg-green-900/40 text-green-400' : 'bg-red-900/40 text-red-400'}">${approved ? 'APPROVED' : 'BLOCKED'}</span>
              <span class="text-xs ${riskColor} font-medium">${c.result.riskLevel.toUpperCase()}</span>
              <span class="text-xs text-gray-500">${c.txType}</span>
            </div>
            <p class="text-xs text-gray-500 mt-0.5">${c.result.reasons[0] || ''}</p>
            ${c.result.amlFlags.length ? `<div class="flex flex-wrap gap-1 mt-1">${c.result.amlFlags.map(f => `<span class="text-xs bg-orange-900/30 text-orange-400 px-1.5 py-0.5 rounded">${f}</span>`).join('')}</div>` : ''}
          </div>
          <span class="text-xs text-gray-600 flex-shrink-0">${dt}</span>
        </div>`;
    }).join('');
  } catch (e) {
    console.error('Compliance log error:', e);
  }
}

// ─── Run Compliance Check ─────────────────────────────────────────────────────
async function runComplianceCheck() {
  const fromAddr = document.getElementById('gc-from-address')?.value?.trim();
  const toAddr = document.getElementById('gc-to-address')?.value?.trim();
  const amount = parseFloat(document.getElementById('gc-amount')?.value || '0');
  const txType = document.getElementById('gc-tx-type')?.value || 'payment';
  const token = document.getElementById('gc-token')?.value || 'USDC';

  if (!fromAddr) { showToast('Enter a sender address', 'error'); return; }
  if (!amount || isNaN(amount) || amount <= 0) { showToast('Enter a valid amount', 'error'); return; }

  const btn = document.getElementById('gc-check-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Checking...'; }

  try {
    const res = await axios.post('/api/guardian/check', { txType, fromAddress: fromAddr, toAddress: toAddr || undefined, amount, token });
    if (res.data.success) {
      displayComplianceResult(res.data);
      guardianState.lastCheck = res.data;
      loadGuardianStatus();
      loadComplianceLog();
    }
  } catch (e) {
    showToast(e.response?.data?.error || 'Check failed', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-shield-alt mr-2"></i>Run Check'; }
  }
}

function displayComplianceResult(data) {
  const container = document.getElementById('gc-result');
  if (!container) return;

  const r = data.check.result;
  const approved = r.approved;
  const riskColors = {
    low: { bg: 'bg-green-900/30', border: 'border-green-500/40', text: 'text-green-400', badge: 'bg-green-900/60 text-green-300' },
    medium: { bg: 'bg-yellow-900/30', border: 'border-yellow-500/40', text: 'text-yellow-400', badge: 'bg-yellow-900/60 text-yellow-300' },
    high: { bg: 'bg-orange-900/30', border: 'border-orange-500/40', text: 'text-orange-400', badge: 'bg-orange-900/60 text-orange-300' },
    critical: { bg: 'bg-red-900/30', border: 'border-red-500/40', text: 'text-red-400', badge: 'bg-red-900/60 text-red-300' },
    blocked: { bg: 'bg-red-950/50', border: 'border-red-600/60', text: 'text-red-400', badge: 'bg-red-900/80 text-red-200' },
  };
  const c = riskColors[r.riskLevel] || riskColors.medium;

  container.innerHTML = `
    <div class="${c.bg} border ${c.border} rounded-xl p-5">
      <div class="flex items-center gap-3 mb-4">
        <div class="w-10 h-10 rounded-xl ${approved ? 'bg-green-900/60' : 'bg-red-900/60'} flex items-center justify-center">
          <i class="fas ${approved ? 'fa-shield-check text-green-400' : 'fa-ban text-red-400'}"></i>
        </div>
        <div>
          <p class="text-white font-bold text-lg">${approved ? '✅ Approved' : '🚫 Blocked'}</p>
          <p class="${c.text} text-sm">Risk: <strong>${r.riskLevel.toUpperCase()}</strong> — Score: ${r.score}/100</p>
        </div>
        <div class="ml-auto text-right">
          <div class="text-2xl font-bold ${c.text}">${r.score}</div>
          <div class="text-xs text-gray-500">Risk Score</div>
        </div>
      </div>

      <!-- Score bar -->
      <div class="w-full bg-gray-800 rounded-full h-2 mb-4">
        <div class="h-2 rounded-full transition-all ${r.score < 25 ? 'bg-green-500' : r.score < 50 ? 'bg-yellow-500' : r.score < 70 ? 'bg-orange-500' : 'bg-red-500'}" style="width:${Math.min(r.score,100)}%"></div>
      </div>

      ${r.amlFlags.length ? `
      <div class="flex flex-wrap gap-2 mb-3">
        ${r.amlFlags.map(f => `<span class="text-xs bg-orange-900/40 text-orange-300 border border-orange-700/40 px-2 py-1 rounded-lg">⚠️ ${f.replace(/_/g,' ')}</span>`).join('')}
      </div>` : ''}

      <div class="space-y-1.5 mb-3">
        ${r.reasons.map(reason => `<div class="flex items-start gap-2 text-xs"><span class="text-gray-400 mt-0.5">•</span><span class="${approved ? 'text-gray-300' : 'text-red-300'}">${reason}</span></div>`).join('')}
      </div>

      ${r.recommendations.length ? `
      <div class="border-t border-gray-700/40 pt-3 mt-3">
        <p class="text-xs text-gray-400 uppercase tracking-wider mb-2">Recommendations</p>
        ${r.recommendations.map(rec => `<div class="flex items-start gap-2 text-xs"><span class="text-blue-400 mt-0.5">→</span><span class="text-blue-300">${rec}</span></div>`).join('')}
      </div>` : ''}

      ${r.txHash ? `
      <div class="mt-3 pt-3 border-t border-gray-700/40">
        <p class="text-xs text-gray-500">Guardian Signature: <span class="font-mono text-purple-400">${data.check.guardianSignature?.slice(0,20)}...</span></p>
      </div>` : ''}
    </div>`;
  container.classList.remove('hidden');
}

// ─── KYC Submit ───────────────────────────────────────────────────────────────
async function submitKYC() {
  const address = document.getElementById('kyc-address')?.value?.trim()
    || window.walletState?.address;
  const tier = parseInt(document.getElementById('kyc-tier')?.value || '1');
  const country = document.getElementById('kyc-country')?.value?.trim();
  const name = document.getElementById('kyc-name')?.value?.trim();

  if (!address) { showToast('Enter wallet address', 'error'); return; }

  // Require wallet signature to authorize KYC submission
  let signature = null;
  if (window.walletState?.connected && window.evmSignOperation) {
    try {
      const signResult = await evmSignOperation('KYC_SUBMIT', { address, tier, country });
      signature = signResult.signature;
    } catch (e) {
      if (e.message.includes('rejected')) { showToast('KYC signature rejected', 'error'); return; }
    }
  }

  const btn = document.getElementById('kyc-submit-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Submitting...'; }

  try {
    const res = await axios.post('/api/guardian/kyc/submit', { address, tier, country, name, signature });
    if (res.data.success) {
      showToast(`✅ KYC submitted for tier ${tier}. Auto-verification in progress...`, 'success');
      loadKYCStatus(address);
      loadGuardianStatus();
      // Poll for verification
      setTimeout(() => loadKYCStatus(address), 8000);
      setTimeout(() => loadKYCStatus(address), 16000);
    }
  } catch (e) {
    showToast(e.response?.data?.error || 'KYC submission failed', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-id-card mr-2"></i>Submit KYC'; }
  }
}

// ─── Load KYC Status ──────────────────────────────────────────────────────────
async function loadKYCStatus(address) {
  address = address || document.getElementById('kyc-address')?.value?.trim() || window.walletState?.address;
  if (!address) return;

  try {
    const res = await axios.get(`/api/guardian/kyc/${address}`);
    const container = document.getElementById('kyc-status-display');
    if (!container) return;

    if (!res.data.record) {
      container.innerHTML = `<div class="bg-gray-800/60 rounded-xl p-4 text-center">
        <i class="fas fa-user-slash text-gray-500 text-2xl mb-2"></i>
        <p class="text-gray-400 text-sm">No KYC record — Tier 0 limits apply</p>
        <p class="text-xs text-gray-600 mt-1">Max: $100 USDC per tx / $200 daily</p>
      </div>`;
      return;
    }

    const r = res.data.record;
    const lims = res.data.limitsUSDC;
    const statusColor = { verified: 'text-green-400 bg-green-900/30', pending: 'text-yellow-400 bg-yellow-900/30', failed: 'text-red-400 bg-red-900/30', not_submitted: 'text-gray-400 bg-gray-800' }[r.status];
    const tierColors = ['bg-gray-700', 'bg-blue-900/60', 'bg-purple-900/60', 'bg-green-900/60'];

    container.innerHTML = `
      <div class="bg-gray-800/60 rounded-xl p-4 space-y-3">
        <div class="flex items-center justify-between">
          <span class="text-xs text-gray-400">KYC Status</span>
          <span class="text-xs px-2 py-1 rounded-full ${statusColor}">${r.status.toUpperCase()}</span>
        </div>
        <div class="flex items-center justify-between">
          <span class="text-xs text-gray-400">KYC Tier</span>
          <span class="text-xs px-3 py-1 rounded-full ${tierColors[r.tier]} text-white font-semibold">Tier ${r.tier} — ${res.data.tierLabel}</span>
        </div>
        <div class="space-y-1.5">
          <div class="flex justify-between text-xs"><span class="text-gray-400">Max per Tx</span><span class="text-white font-mono">$${lims.maxTransaction.toLocaleString()} USDC</span></div>
          <div class="flex justify-between text-xs"><span class="text-gray-400">Daily Limit</span><span class="text-white font-mono">$${lims.maxDaily.toLocaleString()} USDC</span></div>
          <div class="flex justify-between text-xs"><span class="text-gray-400">Daily Used</span><span class="text-yellow-400 font-mono">$${lims.dailyUsed.toFixed(2)}</span></div>
          <div class="w-full bg-gray-700 rounded-full h-1.5 mt-1">
            <div class="h-1.5 rounded-full bg-purple-500" style="width:${Math.min((lims.dailyUsed/lims.maxDaily)*100,100)}%"></div>
          </div>
        </div>
        ${r.country ? `<div class="flex justify-between text-xs"><span class="text-gray-400">Country</span><span class="text-white">${r.country}</span></div>` : ''}
        ${r.verifiedAt ? `<div class="text-xs text-gray-600">Verified: ${new Date(r.verifiedAt).toLocaleDateString()}</div>` : ''}
      </div>`;
  } catch (e) {
    console.error('KYC status error:', e);
  }
}

// ─── Helper ───────────────────────────────────────────────────────────────────
function setGuardianEl(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// ─── Window hook ──────────────────────────────────────────────────────────────
window.loadGuardianData = function () {
  loadGuardianStatus();
  loadComplianceLog();
  if (window.walletState?.address) {
    loadKYCStatus(window.walletState.address);
    const kycInput = document.getElementById('kyc-address');
    if (kycInput && !kycInput.value) kycInput.value = window.walletState.address;
    const gcInput = document.getElementById('gc-from-address');
    if (gcInput && !gcInput.value) gcInput.value = window.walletState.address;
  }
};

// Auto-fill when wallet connects
window.addEventListener('walletConnected', (e) => {
  const addr = e.detail?.address;
  if (!addr) return;
  const kycInput = document.getElementById('kyc-address');
  if (kycInput) kycInput.value = addr;
  const gcInput = document.getElementById('gc-from-address');
  if (gcInput) gcInput.value = addr;
  loadKYCStatus(addr);
});

// ─── Wrapper functions para os novos IDs no HTML (aba AI Agents) ──────────────

// Chamada pelo botão "Run Compliance Check" no card da aba AI Agents
window.runGuardianCheck = async function() {
  const addr = document.getElementById('guardian-check-addr')?.value?.trim()
    || window.walletState?.address;
  const amount = parseFloat(document.getElementById('guardian-check-amt')?.value || '0');
  const token = document.getElementById('guardian-check-token')?.value || 'USDC';
  const resultDiv = document.getElementById('guardian-check-result');

  if (!addr) { if (window.showToast) showToast('Enter a wallet address', 'error'); return; }
  if (!amount || amount <= 0) { if (window.showToast) showToast('Enter amount > 0', 'error'); return; }

  if (resultDiv) {
    resultDiv.classList.remove('hidden');
    resultDiv.innerHTML = '<div class="text-center py-3 text-yellow-400 text-sm"><i class="fas fa-spinner fa-spin mr-2"></i>Running compliance check...</div>';
  }

  try {
    const res = await axios.post('/api/guardian/check', {
      txType: 'payment',
      fromAddress: addr,
      amount: amount,
      token,
    });
    if (res.data.success && resultDiv) {
      const r = res.data.check.result;
      const approved = r.approved;
      const riskColorClass = { low: 'text-green-400', medium: 'text-yellow-400', high: 'text-orange-400', critical: 'text-red-400', blocked: 'text-red-500' }[r.riskLevel] || 'text-gray-400';
      const bgClass = approved ? 'bg-green-900/20 border-green-700/40' : 'bg-red-900/20 border-red-700/40';
      resultDiv.innerHTML = `
        <div class="${bgClass} border rounded-xl p-4">
          <div class="flex items-center gap-2 mb-2">
            <i class="fas ${approved ? 'fa-check-circle text-green-400' : 'fa-times-circle text-red-400'}"></i>
            <span class="font-semibold ${approved ? 'text-green-400' : 'text-red-400'}">${approved ? 'APPROVED' : 'BLOCKED'}</span>
            <span class="${riskColorClass} ml-auto text-xs">Risk: ${r.riskLevel.toUpperCase()} (${r.score}/100)</span>
          </div>
          ${r.reasons.map(reason => `<p class="text-xs text-gray-300 mb-1">• ${reason}</p>`).join('')}
          ${r.amlFlags.length ? `<div class="flex flex-wrap gap-1 mt-2">${r.amlFlags.map(f => `<span class="text-xs bg-orange-900/30 text-orange-400 px-2 py-0.5 rounded">${f}</span>`).join('')}</div>` : ''}
          ${r.recommendations.length ? `<div class="mt-2 pt-2 border-t border-gray-700/30">${r.recommendations.map(rec => `<p class="text-xs text-blue-300">→ ${rec}</p>`).join('')}</div>` : ''}
        </div>`;
      // Update stats
      loadGuardianStatus();
    }
  } catch (e) {
    if (resultDiv) resultDiv.innerHTML = `<div class="text-red-400 text-xs p-3 bg-red-900/20 rounded-xl">Error: ${e.response?.data?.error || e.message}</div>`;
  }
};

// Chamada pelo botão "Submit KYC" no card da aba AI Agents
window.submitKYC = async function() {
  // Re-route to the existing submitKYC logic using the new IDs
  const address = document.getElementById('kyc-submit-addr')?.value?.trim()
    || window.walletState?.address;
  const tier = parseInt(document.getElementById('kyc-submit-tier')?.value || '1');
  const country = document.getElementById('kyc-submit-country')?.value?.trim() || 'US';
  const resultDiv = document.getElementById('kyc-submit-result');

  if (!address) { if (window.showToast) showToast('Enter or connect a wallet address', 'error'); return; }

  if (resultDiv) {
    resultDiv.classList.remove('hidden');
    resultDiv.innerHTML = '<div class="text-center py-3 text-orange-400 text-sm"><i class="fas fa-spinner fa-spin mr-2"></i>Submitting KYC...</div>';
  }

  try {
    const res = await axios.post('/api/guardian/kyc/submit', { address, tier, country });
    if (res.data.success && resultDiv) {
      resultDiv.innerHTML = `
        <div class="bg-green-900/20 border border-green-700/40 rounded-xl p-3">
          <p class="text-green-400 text-sm font-semibold"><i class="fas fa-check-circle mr-2"></i>KYC Submitted!</p>
          <p class="text-xs text-gray-300 mt-1">Status: <strong>Pending verification</strong></p>
          <p class="text-xs text-gray-400 mt-1">Tier ${tier} — Auto-verification in 5-15 sec (testnet)</p>
        </div>`;
      if (window.showToast) showToast(`KYC submitted for Tier ${tier}`, 'success');
      // Poll for approval
      setTimeout(() => loadGuardianStatus(), 8000);
      setTimeout(() => loadGuardianStatus(), 16000);
    }
  } catch (e) {
    if (resultDiv) resultDiv.innerHTML = `<div class="text-red-400 text-xs p-3 bg-red-900/20 rounded-xl">Error: ${e.response?.data?.error || e.message}</div>`;
  }
};

// Export loadGuardianStatus globally
window.loadGuardianStatus = loadGuardianStatus;
window.loadComplianceLog = loadComplianceLog;
