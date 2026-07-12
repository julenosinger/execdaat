// ExecDaat - Frontend Application
// Pagamentos e Contratos Autônomos na Arc Testnet

const API = {
  base: '',
  
  async get(path) {
    const url = this.base + path;
    console.log('[fetch] GET', url);
    try {
      const _r = await fetch(url);
      if (!_r.ok) { const _e = new Error('GET failed: ' + _r.status); _e.response = { data: await _r.json().catch(() => null), status: _r.status }; throw _e; }
      const _d = await _r.json().catch(() => null);
      console.log('[fetch] GET OK', url, _r.status);
      return _d;
    } catch (_ex) { console.error('[fetch] GET ERR', url, _ex.message); throw _ex; }
  },
  
  async post(path, data) {
    const url = this.base + path;
    console.log('[fetch] POST', url);
    try {
      const _r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      if (!_r.ok) { const _e = new Error('POST failed: ' + _r.status); _e.response = { data: await _r.json().catch(() => null), status: _r.status }; throw _e; }
      const _d = await _r.json().catch(() => null);
      console.log('[fetch] POST OK', url, _r.status);
      return _d;
    } catch (_ex) { console.error('[fetch] POST ERR', url, _ex.message); throw _ex; }
  }
};

// ============================================================
// STATE
// ============================================================
let currentTab = 'payments';
let logCount = 0;

// ============================================================
// TABS
// ============================================================
function switchTab(tab) {
  // Track previous tab for close-button navigation
  if (currentTab && currentTab !== tab) {
    window._historyPrevTab = currentTab;
  }

  // Animate out current tab content
  const prevContent = document.getElementById(`tab-content-${currentTab}`);
  if (prevContent && !prevContent.classList.contains('hidden')) {
    prevContent.style.transition = 'opacity 0.15s ease, transform 0.15s ease';
    prevContent.style.opacity = '0';
    prevContent.style.transform = 'translateY(6px)';
  }

  setTimeout(() => {
    // Hide all contents
    document.querySelectorAll('.tab-content').forEach(el => {
      el.classList.add('hidden');
      el.style.opacity = '';
      el.style.transform = '';
    });

    // Deactivate all tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.remove('active');
      btn.classList.remove('border-purple-500', 'text-purple-400', 'border-green-500', 'text-green-400',
                           'border-blue-500', 'text-blue-400', 'border-cyan-500', 'text-cyan-400');
      btn.classList.add('border-transparent', 'text-gray-400');
    });

    // Show selected content with fade-in
    const content = document.getElementById(`tab-content-${tab}`);
    const tabBtn = document.getElementById(`tab-${tab}`);

    if (content) {
      content.classList.remove('hidden');
      content.style.opacity = '0';
      content.style.transform = 'translateY(6px)';
      content.style.transition = 'opacity 0.18s ease, transform 0.18s ease';
      requestAnimationFrame(() => {
        content.style.opacity = '1';
        content.style.transform = 'translateY(0)';
      });
    }
    if (tabBtn) {
      tabBtn.classList.add('active');
      tabBtn.classList.remove('border-transparent', 'text-gray-400');
      // Per-tab accent color
      const tabColors = {
        home:      ['border-purple-500', 'text-purple-400'],
        agents:    ['border-purple-500', 'text-purple-400'],
        payments:  ['border-green-500',  'text-green-400'],
        contracts: ['border-blue-500',   'text-blue-400'],
        otc:       ['border-indigo-500', 'text-indigo-400'],
        dex:       ['border-yellow-500', 'text-yellow-400'],
        treasury:  ['border-amber-500',  'text-amber-400'],
        reimbursements: ['border-emerald-500', 'text-emerald-400'],
        toc:       ['border-cyan-500',   'text-cyan-400'],
        xbridge:   ['border-cyan-500',   'text-cyan-400'],
        bridge:    ['border-cyan-500',   'text-cyan-400'],
        multisend: ['border-cyan-500',   'text-cyan-400'],
        autonoma:  ['border-purple-500', 'text-purple-400'],
        history:   ['border-blue-500',   'text-blue-400'],
        unifiedbalance: ['border-purple-500',  'text-purple-400'],
        'advanced-crosschain': ['border-purple-500', 'text-purple-400'],
        dashboard: ['border-indigo-500', 'text-indigo-400'],
        about:     ['border-emerald-500','text-emerald-400'],
      };
      const [bc, tc] = tabColors[tab] || ['border-purple-500', 'text-purple-400'];
      tabBtn.classList.add(bc, tc);
    }

    currentTab = tab;

    // Load data for the tab
    if (tab === 'dashboard') loadDashboard();
    if (tab === 'payments') {
      loadPayments();
      if (window.initPayments && !window._payInitialized) {
        window._payInitialized = true;
        window.initPayments();
      } else {
        if (window.refreshPaymentBalances) window.refreshPaymentBalances().catch(() => {});
        if (window.renderPaymentHistory) window.renderPaymentHistory();
      }
      // Smart autofill
      if (typeof arcInitPayAutofill === 'function') setTimeout(arcInitPayAutofill, 400);
    }
    if (tab === 'contracts') {
      cfWalletGateUpdate();
      // Only fetch from chain when the On-Chain tab is active.
      // For Off-Chain / Custodial tabs, render immediately from localStorage —
      // no network call, no spinner.
      var _vm = window._cfViewMode || 'onchain';
      if (_vm === 'onchain') {
        cfLoadContracts();
      } else if (typeof cfRenderContractsByViewMode === 'function') {
        // Re-read localStorage and render the local tab without touching the chain
        if (typeof cfLoadOffchainContracts === 'function' && typeof cfState !== 'undefined') {
          var _fresh = cfLoadOffchainContracts();
          var _onchain = (cfState._allContracts || cfState.contracts || []).filter(function(c){ return !c._isOffchain; });
          cfState._allContracts = _onchain.concat(_fresh);
        }
        cfRenderContractsByViewMode();
      }
      // Smart autofill
      if (typeof arcInitCfAutofill === 'function') setTimeout(arcInitCfAutofill, 600);
    }
    if (tab === 'multisend') {
      if (window.msInit) window.msInit();
      const gate = document.getElementById('ms-wallet-gate');
      if (gate) gate.classList.toggle('hidden', !!window.walletState?.connected);
    }
    if (tab === 'agents') {
      loadAgentsDetails();
      if (window.loadGuardianStatus) window.loadGuardianStatus();
      if (window.loadYieldData) window.loadYieldData();
      if (window.aeRefreshPanel) setTimeout(window.aeRefreshPanel, 300);
    }
    if (tab === 'dex') {
      if (window.ammInit && !window._ammInitialized) {
        window._ammInitialized = true;
        window.ammInit();
      } else if (window.ammRefreshAll) {
        window.ammRefreshAll();
      }
    }
    if (tab === 'treasury') {
      if (window.treasuryInit && !window._treasuryInitialized) {
        window._treasuryInitialized = true;
        window.treasuryInit();
      } else if (window.treasuryRefresh) {
        window.treasuryRefresh();
      }
      // Pre-load Reimbursements + Operations Center (now live inside Treasury tab)
      setTimeout(function() {
        if (window.reimbursementsInit && !window._reimbursementsInitialized) {
          window._reimbursementsInitialized = true;
          window.reimbursementsInit();
        }
        if (window.tocInit && !window._tocInitialized) {
          window._tocInitialized = true;
          window.tocInit();
        }
      }, 600);
    }
    if (tab === 'reimbursements' || tab === 'toc') {
      // Redirect old links to Treasury tab + scroll to section
      switchTab('treasury');
      var targetId = tab === 'reimbursements' ? 'reim-root' : 'toc-root';
      setTimeout(function() {
        var el = document.getElementById(targetId);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 800);
    }
    if (tab === 'xbridge') {
      if (window.xbridgeInit && !window._xbridgeInitialized) {
        window._xbridgeInitialized = true;
        window.xbridgeInit();
      } else if (window.xbridgeRefresh) {
        window.xbridgeRefresh();
      }
    }
    if (tab === 'bridge') {
      if (window.bridgeInit && !window._bridgeInitialized) {
        window._bridgeInitialized = true;
        window.bridgeInit();
      } else {
        if (window.bridgeRefreshBalance) window.bridgeRefreshBalance();
        if (window.bridgeRenderHistory) window.bridgeRenderHistory();
        if (window.bridgeUpdateBtn) window.bridgeUpdateBtn();
      }
      // Update recipient address display
      const recipEl = document.getElementById('bridge-recipient-addr');
      if (recipEl) recipEl.textContent = window.walletState?.address || '—';
    }
    if (tab === 'history') {
      if (window.historyInit) window.historyInit();
    }
    if (tab === 'unifiedbalance') {
      if (window.ubInit) window.ubInit();
    }
    if (tab === 'advanced-crosschain') {
      if (window.accInit) window.accInit();
    }
    if (tab === 'otc') {
      // Auto-fill wallet and re-render
      setTimeout(() => {
        if (typeof otcSwitchSub === 'function') otcSwitchSub(window._otcSubTab || 'create');
        if (typeof _otcAutoFillWallet === 'function') _otcAutoFillWallet();
        if (typeof _otcCheckAlerts === 'function') _otcCheckAlerts();
      }, 50);
    }

  }, prevContent && !prevContent.classList.contains('hidden') ? 150 : 0);
}

// ============================================================
// TOAST NOTIFICATIONS
// ============================================================
function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  const content = document.getElementById('toast-content');
  
  const colors = {
    success: 'text-green-400',
    error: 'text-red-400',
    warning: 'text-yellow-400',
    info: 'text-blue-400',
  };
  
  const escaped = typeof arcEscapeHtml === 'function' ? arcEscapeHtml(message) : String(message).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  content.innerHTML = `<span class="${colors[type] || colors.info}">${escaped}</span>`;
  toast.classList.remove('hidden');
  
  setTimeout(() => {
    toast.classList.add('hidden');
  }, 4000);
}

// ============================================================
// LOGGING
// ============================================================
function addLog(message, type = 'info') {
  const logs = document.getElementById('agent-logs');
  if (!logs) return;
  
  const colors = {
    success: 'text-green-400',
    error: 'text-red-400',
    warning: 'text-yellow-400',
    info: 'text-blue-400',
    system: 'text-purple-400',
    agent: 'text-cyan-400',
  };
  
  const time = new Date().toLocaleTimeString();
  const div = document.createElement('div');
  div.className = colors[type] || colors.info;
  div.textContent = `[${time}] ${message}`;
  logs.appendChild(div);
  logs.scrollTop = logs.scrollHeight;
  logCount++;
}

function clearLogs() {
  const logs = document.getElementById('agent-logs');
  if (logs) logs.innerHTML = '';
  logCount = 0;
}

// ============================================================
// DASHBOARD
// ============================================================
async function loadDashboard() {
  try {
    // Load payment stats
    const payData = await API.get('/api/payments/agent');
    const ctData = await API.get('/api/contracts/agent');
    
    // Update stats
    document.getElementById('stat-payments').textContent = payData.stats.totalProcessed;
    document.getElementById('stat-volume').textContent = `$${(payData.stats.totalValueProcessed / 1e6).toFixed(2)}`;
    document.getElementById('stat-contracts').textContent = ctData.stats.activeContracts;
    document.getElementById('stat-pending').textContent = payData.stats.pending + ctData.stats.pendingTasks;
    
    // Agent status cards
    const agentCards = document.getElementById('agent-status-cards');
    agentCards.innerHTML = `
      <div class="flex items-center gap-3 bg-gray-800/50 rounded-lg p-3">
        <div class="w-8 h-8 rounded-lg bg-purple-600/30 flex items-center justify-center">
          <i class="fas fa-money-bill-wave text-purple-400 text-sm"></i>
        </div>
        <div class="flex-1">
          <div class="text-sm text-white font-medium">${payData.agent.name}</div>
          <div class="text-xs text-gray-400">${payData.agent.lastAction}</div>
        </div>
        <span class="text-xs px-2 py-1 rounded-full ${getAgentStatusClass(payData.agent.status)}">
          ${payData.agent.status}
        </span>
      </div>
      <div class="flex items-center gap-3 bg-gray-800/50 rounded-lg p-3">
        <div class="w-8 h-8 rounded-lg bg-blue-600/30 flex items-center justify-center">
          <i class="fas fa-file-contract text-blue-400 text-sm"></i>
        </div>
        <div class="flex-1">
          <div class="text-sm text-white font-medium">${ctData.agent.name}</div>
          <div class="text-xs text-gray-400">${ctData.agent.lastAction}</div>
        </div>
        <span class="text-xs px-2 py-1 rounded-full ${getAgentStatusClass(ctData.agent.status)}">
          ${ctData.agent.status}
        </span>
      </div>
    `;
    
    // Recent activity - load processed payments and contracts
    const queueData = await API.get('/api/payments/queue');
    // Contracts list now comes from on-chain; use count only for dashboard
    let recentContracts = [];
    try {
      const contractsList = await API.get('/api/contracts/count');
      // Show factory stats instead of contract list in dashboard
      recentContracts = [];
    } catch { recentContracts = []; }
    
    const activity = document.getElementById('recent-activity');
    const recentPayments = queueData.processed.slice(-3);
    // recentContracts already defined above
    
    let activityHtml = '';
    
    recentPayments.forEach(p => {
      activityHtml += `
        <div class="flex items-center gap-3 py-2 border-b border-gray-700/20 last:border-0">
          <div class="w-8 h-8 rounded-lg bg-purple-900/40 flex items-center justify-center flex-shrink-0">
            <i class="fas fa-exchange-alt text-purple-400 text-xs"></i>
          </div>
          <div class="flex-1 min-w-0">
            <div class="text-sm text-white truncate">${p.description}</div>
            <div class="text-xs text-gray-500">$${(p.amount / 1e6).toFixed(2)} USDC • ${p.from.substring(0, 10)}... → ${p.to.substring(0, 10)}...</div>
          </div>
          <span class="text-xs px-2 py-0.5 rounded-full flex-shrink-0 ${getPaymentStatusClass(p.status)}">${p.status}</span>
        </div>
      `;
    });
    
    recentContracts.forEach(ct => {
      activityHtml += `
        <div class="flex items-center gap-3 py-2 border-b border-gray-700/20 last:border-0">
          <div class="w-8 h-8 rounded-lg bg-blue-900/40 flex items-center justify-center flex-shrink-0">
            <i class="fas fa-file-contract text-blue-400 text-xs"></i>
          </div>
          <div class="flex-1 min-w-0">
            <div class="text-sm text-white truncate">${ct.title}</div>
            <div class="text-xs text-gray-500">${ct.totalValueFormatted} • ${ct.milestonesProgress} marcos</div>
          </div>
          <span class="text-xs px-2 py-0.5 rounded-full flex-shrink-0 status-${ct.status.toLowerCase()}">${ct.status}</span>
        </div>
      `;
    });
    
    activity.innerHTML = activityHtml || `<div class="text-gray-500 text-sm text-center py-4">${t('no_activity')}</div>`;
    
  } catch (err) {
    console.error('Dashboard load error:', err);
    showToast(t('toast_error_load_dashboard'), 'error');
  }
}

// ============================================================
// PAYMENTS — Agent Queue Panel
// This loads the AI agent payment queue (NOT personal payment history).
// Personal payment history is handled separately by renderPaymentHistory()
// in payments.js using localStorage/IndexedDB data.
// ============================================================
async function loadPayments() {
  const list = document.getElementById('payments-list');
  if (!list) return;

  // Show loading state
  list.innerHTML = `
    <div style="color:#8aaac8;font-size:11px;text-align:center;padding:24px 0;">
      <i class="fas fa-spinner fa-spin" style="font-size:18px;display:block;margin-bottom:8px;color:#5a7898;"></i>
      Loading payment queue…
    </div>`;

  try {
    console.log('[PAY:queue] Fetching /api/payments/queue…');
    const res = await fetch('/api/payments/queue');
    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new Error(`HTTP ${res.status}: ${errText.slice(0, 120)}`);
    }
    const data = await res.json();
    console.log('[PAY:queue] Response:', data);
    renderPaymentsList(data);
  } catch (err) {
    console.error('[PAY:queue] loadPayments error:', err);
    // Show real error in the panel — never fail silently
    if (list) {
      list.innerHTML = `
        <div style="color:#f87171;font-size:11px;text-align:center;padding:20px 12px;background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.2);border-radius:8px;margin:8px;">
          <i class="fas fa-exclamation-triangle" style="font-size:16px;display:block;margin-bottom:6px;"></i>
          <span style="font-weight:600;">Queue unavailable</span><br>
          <span style="color:#9ca3af;font-size:10px;">${err.message || 'Unknown error'}</span><br>
          <button onclick="loadPayments()" style="margin-top:8px;font-size:10px;color:#60b4ff;background:rgba(55,138,221,0.1);border:1px solid rgba(55,138,221,0.3);border-radius:6px;padding:3px 10px;cursor:pointer;">
            <i class="fas fa-redo"></i> Retry
          </button>
        </div>`;
    }
  }
}

function renderPaymentsList(data) {
  const list = document.getElementById('payments-list');
  if (!list) return;

  // Guard: ensure data has expected shape
  const pending   = Array.isArray(data?.pending)   ? data.pending   : [];
  const processed = Array.isArray(data?.processed) ? data.processed : [];
  const allTasks  = [...pending, ...processed];
  
  if (allTasks.length === 0) {
    list.innerHTML = `
      <div style="color:#8aaac8;font-size:11px;text-align:center;padding:24px 0;">
        <i class="fas fa-inbox" style="font-size:24px;display:block;margin-bottom:8px;color:#5a7898;"></i>
        ${t ? t('no_payments') : 'No payments in queue'}
      </div>
    `;
    return;
  }
  
  list.innerHTML = allTasks.reverse().map(task => `
    <div class="bg-gray-900/60 border border-gray-700/40 rounded-xl p-4 contract-card">
      <div class="flex items-start justify-between mb-2">
        <div class="flex items-center gap-2">
          <i class="fas fa-exchange-alt text-purple-400"></i>
          <span class="text-white font-medium text-sm">${task.description}</span>
        </div>
        <span class="text-xs px-2 py-0.5 rounded-full ${getPaymentStatusClass(task.status)}">${task.status}</span>
      </div>
      <div class="grid grid-cols-2 gap-3 mb-3">
        <div>
          <div class="text-xs text-gray-500">${t('from_label')}</div>
          <div class="text-xs text-gray-300 font-mono truncate">${task.from}</div>
        </div>
        <div>
          <div class="text-xs text-gray-500">${t('to_label')}</div>
          <div class="text-xs text-gray-300 font-mono truncate">${task.to}</div>
        </div>
      </div>
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <span class="text-lg font-bold text-white">$${(task.amount / 1e6).toFixed(2)}</span>
          <span class="text-xs text-gray-500">USDC</span>
          <span class="text-xs px-1.5 py-0.5 rounded bg-gray-700/50 text-gray-400 capitalize">${task.priority}</span>
        </div>
        ${task.riskScore !== undefined ? `<div class="text-xs text-gray-400">${t('risk_label')}: <span class="${getRiskClass(task.riskScore)}">${task.riskScore}/100</span></div>` : ''}
      </div>
      ${task.agentDecision ? `
        <div class="mt-3 p-2 bg-gray-800/50 rounded-lg">
          <div class="text-xs text-gray-500 mb-1">${t('agent_decision')}:</div>
          <div class="text-xs text-gray-300">${task.agentDecision}</div>
        </div>
      ` : ''}
      ${task.txHash ? `
        <div class="mt-2 text-xs">
          <span class="text-gray-500">TX: </span>
          <a href="https://testnet.arcscan.app/tx/${task.txHash}" target="_blank" class="text-purple-400 hover:underline font-mono">${task.txHash.substring(0, 20)}...</a>
        </div>
      ` : ''}
    </div>
  `).join('');
}

// analyzePayment() substituída por analyzeMultisend() em csv-upload.js
function analyzePayment() { if (typeof analyzeMultisend === 'function') analyzeMultisend(); }

async function createDemoPayments() {
  try {
    const result = await API.post('/api/payments/demo', {});
    showToast(result.message, 'success');
    addLog(`[AGENT:PAY] ${t('toast_demo_created')}`, 'system');
    await loadPayments();
  } catch (err) {
    showToast(`${t('toast_error')}: ${err.message}`, 'error');
  }
}

async function processPayments() {
  try {
    showToast(t('toast_processing'), 'info');
    addLog(`[AGENT:PAY] ${t('toast_processing')}`, 'agent');
    
    const result = await API.post('/api/payments/process', {});
    showToast(`✅ ${result.result.processed} ${t('toast_processed')}`, 'success');
    addLog(`[AGENT:PAY] Processed ${result.result.processed} tasks. Errors: ${result.result.errors.length}`, 'success');
    
    await loadPayments();
    if (currentTab === 'dashboard') await loadDashboard();
  } catch (err) {
    showToast(`${t('toast_error')}: ${err.message}`, 'error');
  }
}

// payment-form removido — usar submitMultisend() de csv-upload.js

// ============================================================
// CONTRACTS — delegate to contracts.js (cfLoadContracts)
// ============================================================
async function loadContracts() {
  // Delegate to on-chain contracts module
  if (typeof window.cfLoadContracts === 'function') {
    await window.cfLoadContracts();
  }
}

// Show/hide wallet gate based on connection
function cfWalletGateUpdate() {
  const gate = document.getElementById('cf-wallet-gate');
  if (!gate) return;
  gate.style.display = window.walletState?.address ? 'none' : '';
}

// renderContractsList kept for backward compat — now handled by contracts.js
function renderContractsList(contracts) {
  // No-op: contracts.js handles rendering via cfRenderContracts
  // Only called if cfLoadContracts is not available
  const list = document.getElementById('cf-contracts-list') || document.getElementById('contracts-list');
  if (!list || !contracts) return;
  if (contracts.length === 0) {
    list.innerHTML = `<div class="text-gray-500 text-sm text-center py-8">${t('no_contracts')}</div>`;
    return;
  }
  list.innerHTML = contracts.map(ct => {
    const completedMilestones = ct.milestones.filter(m => m.status === 'Completed').length;
    const progressPct = ct.milestones.length > 0 ? (completedMilestones / ct.milestones.length * 100) : 0;
    
    return `
      <div class="bg-gray-900/60 border border-gray-700/40 rounded-xl p-5 contract-card">
        <div class="flex items-start justify-between mb-3">
          <div>
            <div class="flex items-center gap-2 mb-1">
              <h4 class="text-white font-semibold">${ct.title}</h4>
              <span class="text-xs px-2 py-0.5 rounded-full status-${ct.status.toLowerCase()}">${ct.status}</span>
            </div>
            <div class="text-xs text-gray-400">#${ct.id} • ${new Date(ct.createdAt).toLocaleDateString()}</div>
          </div>
          <div class="text-right">
            <div class="text-lg font-bold text-white">${ct.totalValueFormatted}</div>
            <div class="text-xs text-gray-400">${ct.milestonesProgress} ${t('milestones')}</div>
          </div>
        </div>
        
        <p class="text-sm text-gray-400 mb-3 line-clamp-2">${ct.description}</p>
        
        <!-- Addresses -->
        <div class="grid grid-cols-2 gap-2 mb-3">
          <div class="bg-gray-800/50 rounded-lg p-2">
            <div class="text-xs text-gray-500 mb-0.5">${t('client_label')}</div>
            <div class="text-xs text-gray-300 font-mono truncate">${ct.client}</div>
            ${ct.clientSigned ? `<div class="text-xs text-green-400 mt-0.5"><i class="fas fa-check-circle mr-1"></i>${t('signed')}</div>` : `<div class="text-xs text-gray-500 mt-0.5">${t('unsigned')}</div>`}
          </div>
          <div class="bg-gray-800/50 rounded-lg p-2">
            <div class="text-xs text-gray-500 mb-0.5">${t('contractor_label')}</div>
            <div class="text-xs text-gray-300 font-mono truncate">${ct.contractor}</div>
            ${ct.contractorSigned ? `<div class="text-xs text-green-400 mt-0.5"><i class="fas fa-check-circle mr-1"></i>${t('signed')}</div>` : `<div class="text-xs text-gray-500 mt-0.5">${t('unsigned')}</div>`}
          </div>
        </div>
        
        <!-- Progress -->
        ${ct.milestones.length > 0 ? `
          <div class="mb-3">
            <div class="flex justify-between text-xs text-gray-400 mb-1">
              <span>${t('contract_progress')}</span>
              <span>${progressPct.toFixed(0)}%</span>
            </div>
            <div class="milestone-bar">
              <div class="milestone-fill" style="width: ${progressPct}%"></div>
            </div>
          </div>
          <!-- Milestones -->
          <div class="space-y-1.5 mb-3">
            ${ct.milestones.map(m => `
              <div class="flex items-center gap-2 text-xs">
                <i class="fas fa-${getMilestoneIcon(m.status)} ${getMilestoneColor(m.status)} flex-shrink-0"></i>
                <span class="text-gray-300 flex-1 truncate">${m.description}</span>
                <span class="text-gray-400 flex-shrink-0">$${(m.amount / 1e6).toFixed(0)}</span>
              </div>
            `).join('')}
          </div>
        ` : ''}

        <!-- ── Blockchain Receipt Panel (below progress bar) ── -->
        ${(() => {
          const receipts = (window.ctState?.receiptsByContract?.[ct.id] || []);
          const best = receipts.find(r => r.type === 'creation') || ct.receipt;
          if (!best) return '';
          if (typeof window.renderContractReceiptPanel === 'function') return window.renderContractReceiptPanel(best);
          return '';
        })()}
        
        <!-- Actions -->
        <div class="flex gap-2 flex-wrap mt-3">
          <button onclick="analyzeContract(${ct.id})" class="text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 rounded-lg px-3 py-1.5 transition-colors">
            <i class="fas fa-brain mr-1"></i>${t('btn_analyze_ai')}
          </button>
          ${ct.status === 'Draft' && ct.clientSigned && ct.contractorSigned ? `
            <button onclick="activateContract(${ct.id})" class="text-xs bg-green-700 hover:bg-green-600 text-white rounded-lg px-3 py-1.5 transition-colors">
              <i class="fas fa-bolt mr-1"></i>${t('btn_activate')}
            </button>
          ` : ''}
          ${ct.status === 'Active' ? `
            <button onclick="completeMilestone(${ct.id})" class="text-xs bg-blue-700 hover:bg-blue-600 text-white rounded-lg px-3 py-1.5 transition-colors">
              <i class="fas fa-check mr-1"></i>${t('btn_verify_milestone')}
            </button>
            <button onclick="disputeContract(${ct.id})" class="text-xs bg-red-900/50 hover:bg-red-800/50 text-red-400 rounded-lg px-3 py-1.5 transition-colors">
              <i class="fas fa-exclamation-triangle mr-1"></i>${t('btn_dispute')}
            </button>
          ` : ''}
          ${(() => {
            // Explorer link: use receipt's explorerUrl if available, else default
            const receipts2 = (window.ctState?.receiptsByContract?.[ct.id] || []);
            const anyReceipt = receipts2.find(r => r.explorerUrl) || ct.receipt;
            const explorerBase = anyReceipt?.explorerUrl
              ? anyReceipt.explorerUrl.replace(/\/tx\/.*/, '')
              : 'https://testnet.arcscan.app';
            return `<a href="${explorerBase}" target="_blank" rel="noopener" class="text-xs bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-lg px-3 py-1.5 transition-colors">
              <i class="fas fa-external-link-alt mr-1"></i>Explorer
            </a>`;
          })()}
        </div>
        
        ${ct.agentAnalysis ? `
          <div class="mt-3 p-2 bg-purple-900/20 border border-purple-700/30 rounded-lg">
            <div class="text-xs text-purple-400 mb-1"><i class="fas fa-robot mr-1"></i>${t('agent_decision')}:</div>
            <div class="text-xs text-gray-300">${ct.agentAnalysis}</div>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

// analyzeContract / activateContract / completeMilestone / disputeContract
// now delegated to contracts.js trustless functions (cfSignContract, cfCompleteMilestone, etc.)
async function analyzeContract(contractId) {
  showToast('Use ArcScan to verify contract state on-chain.', 'info');
  window.open(`https://testnet.arcscan.app/address/0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A#readContract`, '_blank');
}

async function activateContract(contractId) {
  if (typeof window.cfSignContract === 'function') await window.cfSignContract(contractId);
}

async function completeMilestone(contractId) {
  const idx = prompt('Índice do milestone (0 = primeiro, 1 = segundo…):');
  if (idx === null || idx === '') return;
  const i = parseInt(idx);
  if (isNaN(i) || i < 0) { showToast(t('err_invalid_index'), 'error'); return; }
  if (typeof window.cfCompleteMilestone === 'function') await window.cfCompleteMilestone(contractId, i);
  else {
  
  }
}

async function disputeContract(contractId) {
  if (typeof window.cfCancelContract === 'function') await window.cfCancelContract(contractId);
}

// ============================================================
// AGENTS
// ============================================================
async function loadAgentsDetails() {
  try {
    const payData = await API.get('/api/payments/agent');
    const ctData  = await API.get('/api/contracts/agent');
    
    // ── Payment agent ──
    const payDetails = document.getElementById('pay-agent-details');
    if (payDetails) payDetails.innerHTML = `
      <div class="flex justify-between text-sm py-1 border-b border-gray-700/30">
        <span class="text-gray-400">Status</span>
        <span class="${getAgentStatusTextClass(payData.agent.status)} font-medium capitalize">${payData.agent.status}</span>
      </div>
      <div class="flex justify-between text-sm py-1 border-b border-gray-700/30">
        <span class="text-gray-400">Approved</span>
        <span class="text-green-400">${payData.stats.approved}</span>
      </div>
      <div class="flex justify-between text-sm py-1 border-b border-gray-700/30">
        <span class="text-gray-400">Rejected</span>
        <span class="text-red-400">${payData.stats.rejected}</span>
      </div>
      <div class="flex justify-between text-sm py-1 border-b border-gray-700/30">
        <span class="text-gray-400">Pending</span>
        <span class="text-yellow-400">${payData.stats.pending}</span>
      </div>
      <div class="flex justify-between text-sm py-1 border-b border-gray-700/30">
        <span class="text-gray-400">Daat Authorization</span>
        <span class="${localStorage.getItem('arc-pay-approved')==='1' ? 'text-green-400' : 'text-gray-500'}">
          ${localStorage.getItem('arc-pay-approved')==='1' ? '✅ Active' : '⚠️ Not authorized'}
        </span>
      </div>
      <div class="flex justify-between text-sm py-1">
        <span class="text-gray-400">Volume processed</span>
        <span class="text-white font-medium">$${(payData.stats.totalValueProcessed / 1e6).toFixed(2)} USDC</span>
      </div>
    `;
    
    // ── Contract agent — fetch real on-chain count ──
    let onChainCount = '—';
    try {
      const res  = await fetch('https://rpc.testnet.arc.network', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'eth_call', params:[{ to:'0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A', data:'0xdae90d8d' },'latest'] }),
      });
      const json  = await res.json();
      if (json.result && json.result !== '0x') onChainCount = Number(BigInt(json.result)).toString();
    } catch { }

    const ctDetails = document.getElementById('contract-agent-details');
    if (ctDetails) ctDetails.innerHTML = `
      <div class="flex justify-between text-sm py-1 border-b border-gray-700/30">
        <span class="text-gray-400">Status</span>
        <span class="${getAgentStatusTextClass(ctData.agent.status)} font-medium capitalize">${ctData.agent.status}</span>
      </div>
      <div class="flex justify-between text-sm py-1 border-b border-gray-700/30">
        <span class="text-gray-400">On-chain contracts</span>
        <span class="text-cyan-400 font-mono">${onChainCount}</span>
      </div>
      <div class="flex justify-between text-sm py-1 border-b border-gray-700/30">
        <span class="text-gray-400">Active (local)</span>
        <span class="text-green-400">${ctData.stats.activeContracts}</span>
      </div>
      <div class="flex justify-between text-sm py-1 border-b border-gray-700/30">
        <span class="text-gray-400">Completed</span>
        <span class="text-blue-400">${ctData.stats.completedContracts}</span>
      </div>
      <div class="flex justify-between text-sm py-1 border-b border-gray-700/30">
        <span class="text-gray-400">Platform Fee</span>
        <span class="text-yellow-400">0.2%</span>
      </div>
      <div class="flex justify-between text-sm py-1">
        <span class="text-gray-400">Factory</span>
        <a href="https://testnet.arcscan.app/address/0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A" target="_blank"
          class="text-cyan-400 text-xs font-mono hover:text-cyan-300">0xbbC9…aF2A ↗</a>
      </div>
    `;
    
  } catch (err) {
    console.error('Agents load error:', err);
  }
}

// ============================================================
// HELPERS
// ============================================================
function getAgentStatusClass(status) {
  const map = {
    idle: 'bg-green-900/40 text-green-400 border border-green-700/40',
    thinking: 'bg-purple-900/40 text-purple-400 border border-purple-700/40',
    executing: 'bg-blue-900/40 text-blue-400 border border-blue-700/40',
    waiting: 'bg-yellow-900/40 text-yellow-400 border border-yellow-700/40',
    error: 'bg-red-900/40 text-red-400 border border-red-700/40',
  };
  return map[status] || map.idle;
}

function getAgentStatusTextClass(status) {
  const map = {
    idle: 'text-green-400',
    thinking: 'text-purple-400',
    executing: 'text-blue-400',
    error: 'text-red-400',
  };
  return map[status] || 'text-gray-400';
}

function getPaymentStatusClass(status) {
  const map = {
    pending: 'pay-pending',
    analyzing: 'pay-analyzing',
    executed: 'pay-executed',
    rejected: 'pay-rejected',
    failed: 'bg-red-900/30 text-red-400 border border-red-700/40',
    approved: 'pay-executed',
  };
  return map[status] || 'bg-gray-700/40 text-gray-400';
}

function getRiskClass(score) {
  if (score < 30) return 'text-green-400';
  if (score < 60) return 'text-yellow-400';
  if (score < 80) return 'text-orange-400';
  return 'text-red-400';
}

function getMilestoneIcon(status) {
  const icons = {
    Completed: 'check-circle',
    InProgress: 'spinner fa-spin',
    Pending: 'circle',
    Failed: 'times-circle',
  };
  return icons[status] || 'circle';
}

function getMilestoneColor(status) {
  const colors = {
    Completed: 'text-green-400',
    InProgress: 'text-blue-400',
    Pending: 'text-gray-500',
    Failed: 'text-red-400',
  };
  return colors[status] || 'text-gray-500';
}

// ============================================================
// LANDING / APP SHELL NAVIGATION
// ============================================================
function enterApp() {
  const landing  = document.getElementById('landing-page');
  const appShell = document.getElementById('app-shell');
  if (landing)  landing.classList.add('hidden');
  if (appShell) appShell.classList.remove('hidden');
  // Offset header & footer for sidebar layout
  document.body.classList.add('sidebar-active');
  applySidebarOffsets();
  // Load payments tab by default
  switchTab('payments');
}

// openAboutPage — redirects to dashboard/info tab (About Us removed)
function openAboutPage() {
  const landing  = document.getElementById('landing-page');
  const appShell = document.getElementById('app-shell');
  if (landing)  landing.classList.add('hidden');
  if (appShell) appShell.classList.remove('hidden');
  document.body.classList.add('sidebar-active');
  applySidebarOffsets();
  switchTab('payments');
}
window.openAboutPage = openAboutPage;

function showLanding() {
  const landing  = document.getElementById('landing-page');
  const appShell = document.getElementById('app-shell');
  if (appShell) appShell.classList.add('hidden');
  if (landing)  landing.classList.remove('hidden');
  // Remove sidebar offset from header & footer
  document.body.classList.remove('sidebar-active');
  removeSidebarOffsets();
}

// Apply margin-left to header & footer so they align beside sidebar
function applySidebarOffsets() {
  const w = getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w').trim() || '240px';
  const anchor = document.getElementById('sticky-topbar-anchor');
  const footer = document.querySelector('#app-shell > footer');
  if (anchor) {
    anchor.style.marginLeft = w;
    anchor.style.width = 'calc(100% - ' + w + ')';
    anchor.style.boxSizing = 'border-box';
  }
  if (footer) {
    footer.style.marginLeft = w;
    footer.style.width = 'calc(100% - ' + w + ')';
    footer.style.boxSizing = 'border-box';
  }
}

// Remove inline offsets when returning to landing page
function removeSidebarOffsets() {
  const anchor = document.getElementById('sticky-topbar-anchor');
  const footer = document.querySelector('#app-shell > footer');
  if (anchor) { anchor.style.marginLeft = ''; anchor.style.width = ''; anchor.style.boxSizing = ''; }
  if (footer)  { footer.style.marginLeft = ''; footer.style.width = ''; footer.style.boxSizing = ''; }
}

// Auto-enter app if wallet is already connected (e.g. page refresh with persisted wallet)
function checkAutoEnter() {
  if (window.walletState?.connected) enterApp();
}

// Open account creation modal
function openCreateAccount() {
  if (window.openAuthModal) {
    window.openAuthModal('signup');
  } else {
    // fallback: go to app
    enterApp();
  }
}

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  // Don't auto-load dashboard — wait until user enters the app
  // Auto-refresh a cada 30 segundos
  setInterval(() => {
    if (currentTab === 'dashboard') loadDashboard();
    if (currentTab === 'agents') loadAgentsDetails();
    if (currentTab === 'history' && window.historyRefresh) window.historyRefresh();
  }, 30000);
  
  addLog('[SYSTEM] ExecDaat interface loaded', 'system');
  addLog('[NETWORK] Arc Testnet - Chain ID: 5042002 - USDC Gas', 'info');

  // ============================================================
  // INTEGRAÇÃO COM WALLET
  // ============================================================

  // Ouvir evento de wallet conectada
  window.addEventListener('walletConnected', (e) => {
    const { address, shortAddress, onArcNetwork, usdcBalance } = e.detail;

    // Só chamar enterApp() se o app-shell ainda está oculto (primeira conexão)
    // Se já está visível (troca de conta/wallet), permanecer na aba atual
    const appShell = document.getElementById('app-shell');
    const isFirstConnect = !appShell || appShell.classList.contains('hidden');
    if (isFirstConnect) {
      enterApp();
    }

    // Atualizar avatar no header
    const avatar = document.getElementById('wallet-avatar');
    if (avatar) avatar.textContent = address.slice(2, 4).toUpperCase();

    // Mostrar wallet info, esconder botão conectar
    const connectBtn = document.getElementById('wallet-connect-btn');
    const walletInfo = document.getElementById('wallet-info');
    if (connectBtn) connectBtn.classList.add('hidden');
    if (walletInfo) walletInfo.classList.remove('hidden');

    // Atualizar botão de conectar na aba agentes
    const agentConnectBtn = document.getElementById('wallet-connect-agents-btn');
    if (agentConnectBtn) agentConnectBtn.classList.add('hidden');

    // Atualizar status na aba agentes
    updateWalletAgentsStatus(e.detail);

    // Atualizar dashboard
    if (currentTab === 'dashboard') loadDashboard();
    // Atualizar fila de pagamentos se estiver na aba payments
    if (currentTab === 'payments') loadPayments();

    // Atualizar wallet gate de contratos
    const cfGate = document.getElementById('cf-wallet-gate');
    if (cfGate) cfGate.style.display = 'none';
    if (currentTab === 'contracts') cfLoadContracts();

    // Atualizar wallet gate de multisend
    const msGate = document.getElementById('ms-wallet-gate');
    if (msGate) msGate.classList.add('hidden');

    // Atualizar recipient no bridge
    const bridgeRecip = document.getElementById('bridge-recipient-addr');
    if (bridgeRecip) bridgeRecip.textContent = address;
    if (window.bridgeUpdateBtn) window.bridgeUpdateBtn();

    addLog(`[WALLET] ✅ ${shortAddress} conectada${onArcNetwork ? ' na Arc Testnet' : ' (rede incorreta)'}`, 'success');
  });

  // Ouvir evento de wallet desconectada
  window.addEventListener('walletDisconnected', () => {
    const connectBtn = document.getElementById('wallet-connect-btn');
    const walletInfo = document.getElementById('wallet-info');
    if (connectBtn) connectBtn.classList.remove('hidden');
    if (walletInfo) walletInfo.classList.add('hidden');

    // Mostrar botão de conectar na aba agentes
    const agentConnectBtn = document.getElementById('wallet-connect-agents-btn');
    if (agentConnectBtn) agentConnectBtn.classList.remove('hidden');

    // Resetar status na aba agentes
    const agentsStatus = document.getElementById('wallet-agents-status');
    if (agentsStatus) {
      agentsStatus.innerHTML = `<span>${t('no_wallet_connected')}</span>`;
      agentsStatus.className = 'text-gray-500 text-sm';
    }

    // Limpar campos autopreenchidos
    const payFrom = document.getElementById('pay-from');
    if (payFrom && payFrom.dataset.autoFilled === 'true') {
      payFrom.value = '';
      payFrom.dataset.autoFilled = 'false';
      payFrom.classList.remove('border-purple-500/60');
    }
    // cf-contractor field auto-fill reset
    const cfContractor = document.getElementById('cf-contractor');
    if (cfContractor && cfContractor.dataset.autoFilled === 'true') {
      cfContractor.value = '';
      cfContractor.dataset.autoFilled = 'false';
      cfContractor.classList.remove('border-green-500/60');
    }

    // Atualizar wallet gate de contratos
    const cfGate2 = document.getElementById('cf-wallet-gate');
    if (cfGate2) cfGate2.style.display = '';

    // Mostrar wallet gate de multisend
    const msGate2 = document.getElementById('ms-wallet-gate');
    if (msGate2) msGate2.classList.remove('hidden');

    // ── Reset stat cards no dashboard ──────────────────────────────────
    const setEl = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
    setEl('stat-payments',  '--');
    setEl('stat-volume',    '--');
    setEl('stat-contracts', '--');
    setEl('stat-pending',   '--');

    // Reset wallet panel para estado desconectado
    const walletPanel = document.getElementById('wallet-panel');
    if (walletPanel) {
      walletPanel.innerHTML = `
        <div class="flex flex-col items-center justify-center py-4 gap-3">
          <div class="w-12 h-12 rounded-full bg-gray-800 border-2 border-dashed border-gray-600 flex items-center justify-center">
            <i class="fas fa-wallet text-gray-500 text-lg"></i>
          </div>
          <p class="text-gray-400 text-xs text-center">Connect your EVM wallet to interact with Arc Testnet</p>
          <button onclick="openWalletModal()" class="wallet-connect-pulse bg-purple-600 hover:bg-purple-700 text-white rounded-xl px-4 py-2 text-sm font-semibold transition-all flex items-center gap-2">
            <i class="fas fa-plug"></i><span>Connect Wallet</span>
          </button>
        </div>`;
    }

    // Chamar reset completo do dashboard se disponível
    if (typeof window.dbResetDashboard === 'function') {
      window.dbResetDashboard();
    }

    // Limpar balanço da aba payments
    const payBalance = document.getElementById('pay-balance');
    if (payBalance) payBalance.textContent = '';
    const payBalanceHint = document.getElementById('pay-hint-amount');
    if (payBalanceHint) payBalanceHint.textContent = '';
    const payFromDisplay = document.getElementById('pay-from-display');
    if (payFromDisplay) payFromDisplay.textContent = '—';

    // Limpar recipient e amount na aba payments
    const payRecipient = document.getElementById('pay-recipient');
    if (payRecipient) payRecipient.value = '';
    const payAmount = document.getElementById('pay-amount');
    if (payAmount) payAmount.value = '';
    const payNote = document.getElementById('pay-note');
    if (payNote) payNote.value = '';

    addLog('[WALLET] Wallet disconnected — UI resetado', 'warning');
  });
});

// ============================================================
// ATUALIZAR STATUS DA WALLET NA ABA AGENTES
// ============================================================
function updateWalletAgentsStatus(walletData) {
  const el = document.getElementById('wallet-agents-status');
  if (!el) return;

  const { address, shortAddress, onArcNetwork, usdcBalance, chainId } = walletData;

  if (!address) {
    el.innerHTML = `<span>${t('no_wallet_connected')}</span>`;
    el.className = 'text-gray-500 text-sm';
    return;
  }

  el.className = '';
  el.innerHTML = `
    <div class="flex flex-wrap gap-3 items-center">
      <!-- Endereço -->
      <div class="flex items-center gap-2 bg-gray-800/60 rounded-lg px-3 py-2">
        <div class="w-6 h-6 rounded-full bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center text-white text-xs font-bold">
          ${address.slice(2, 4).toUpperCase()}
        </div>
        <div>
          <div class="text-xs text-gray-400">${t('address_label')}</div>
          <div class="text-sm text-white font-mono font-medium">${shortAddress}</div>
        </div>
        <button onclick="copyAddress()" class="text-gray-500 hover:text-white ml-1 transition-colors">
          <i class="fas fa-copy text-xs"></i>
        </button>
      </div>

      <!-- Saldo USDC -->
      <div class="flex items-center gap-2 bg-blue-900/30 border border-blue-700/30 rounded-lg px-3 py-2">
        <i class="fas fa-coins text-blue-400 text-sm"></i>
        <div>
          <div class="text-xs text-gray-400">${t('balance_label')}</div>
          <div class="text-sm text-white font-semibold">${usdcBalance !== null ? '$' + usdcBalance : '...'} <span class="text-blue-400 text-xs">USDC</span></div>
        </div>
        <button onclick="refreshBalance()" class="text-blue-500 hover:text-blue-300 ml-1 transition-colors">
          <i class="fas fa-sync-alt text-xs"></i>
        </button>
      </div>

      <!-- Rede -->
      <div class="flex items-center gap-2 bg-gray-800/60 rounded-lg px-3 py-2">
        <div class="w-2 h-2 rounded-full ${onArcNetwork ? 'bg-green-400' : 'bg-yellow-400 animate-pulse'}"></div>
        <div>
          <div class="text-xs text-gray-400">${t('network_label')}</div>
          <div class="text-sm ${onArcNetwork ? 'text-green-400' : 'text-yellow-400'} font-medium">
            ${onArcNetwork ? t('arc_testnet') : t('wrong_network') + ' - Chain ' + chainId}
          </div>
        </div>
        ${!onArcNetwork ? `
          <button onclick="switchNetworkFromUI()" class="text-xs bg-yellow-600 hover:bg-yellow-700 text-white rounded px-2 py-1 transition-colors ml-1">
            ${t('switch_network')}
          </button>
        ` : ''}
      </div>

      <!-- Explorer link -->
      <a href="https://testnet.arcscan.app/address/${address}" target="_blank"
         class="flex items-center gap-1.5 bg-gray-800/60 hover:bg-gray-700/60 rounded-lg px-3 py-2 text-xs text-gray-400 hover:text-purple-400 transition-colors">
        <i class="fas fa-external-link-alt"></i>${t('view_explorer')}
      </a>
    </div>
  `;
}


// ============================================================
// LIGHT / DARK MODE
// ============================================================
function setThemeMode(mode) {
  if (mode === 'light') {
    document.body.classList.add('light-mode');
    localStorage.setItem('arc_theme', 'light');
  } else {
    document.body.classList.remove('light-mode');
    localStorage.setItem('arc_theme', 'dark');
  }
  // Update toggle buttons in settings
  const darkBtn  = document.getElementById('theme-dark-btn');
  const lightBtn = document.getElementById('theme-light-btn');
  const label    = document.getElementById('theme-mode-label');
  if (darkBtn && lightBtn) {
    if (mode === 'light') {
      darkBtn.className  = 'flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl cursor-pointer border-2 border-gray-600 bg-gray-800/40 text-gray-400 font-semibold text-sm transition-all hover:border-purple-500/50 hover:text-purple-400';
      lightBtn.className = 'flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl cursor-pointer border-2 border-yellow-500 bg-yellow-900/20 text-yellow-400 font-semibold text-sm transition-all';
    } else {
      darkBtn.className  = 'flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl cursor-pointer border-2 border-purple-600 bg-purple-900/30 text-purple-300 font-semibold text-sm transition-all';
      lightBtn.className = 'flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl cursor-pointer border-2 border-gray-600 bg-gray-800/40 text-gray-400 font-semibold text-sm transition-all hover:border-yellow-500/50 hover:text-yellow-400';
    }
  }
  if (label) label.textContent = mode === 'light' ? 'Light Mode' : 'Dark Mode';
}

function applyStoredTheme() {
  const stored = localStorage.getItem('arc_theme');
  if (stored === 'light') setThemeMode('light');
}

// Apply on page load
document.addEventListener('DOMContentLoaded', applyStoredTheme);
// Also try immediately
applyStoredTheme();

// ============================================================
// CREATE ACCOUNT MODAL
// ============================================================
function openCreateAccount() {
  // Reuse the profile modal for account creation
  if (typeof openProfileModal === 'function') {
    enterApp();
    setTimeout(() => { if (typeof openProfileModal === 'function') openProfileModal(); }, 300);
  } else {
    enterApp();
  }
}
window.openCreateAccount = openCreateAccount;
window.setThemeMode      = setThemeMode;

console.log('[APP] Theme system loaded');

// ============================================================
// ARC LOCAL DISMISS SYSTEM
// Shared utility for per-item ✕ buttons across all tabs.
// Pure client-side — no RPC calls, no on-chain writes.
// Dismissed state is per-tab Set; cleared on Refresh.
// ============================================================

/**
 * Animates an element out, then calls dismissFn after the transition.
 * @param {string} elementId  - DOM id of the row/card to animate
 * @param {function} dismissFn - callback that removes the item from state
 */
window.arcAnimatedDismiss = function(elementId, dismissFn) {
  const el = document.getElementById(elementId);
  if (el) {
    el.classList.add('dismissing');
    setTimeout(dismissFn, 420);
  } else {
    dismissFn();
  }
};

/**
 * Creates an isolated dismiss-state controller for one tab.
 * Returns { dismissed:Set, dismiss(id), isVisible(id), reset() }
 */
window.arcMakeDismissState = function() {
  const dismissed = new Set();
  return {
    dismissed,
    dismiss:   (id) => dismissed.add(id),
    isVisible: (id) => !dismissed.has(id),
    reset:     ()   => dismissed.clear(),
  };
};

/**
 * Returns the HTML string for a ✕ dismiss button.
 * onClickJs should be a JS expression string (safe for inline onclick).
 */
window.arcDismissBtnHtml = function(onClickJs, title) {
  const t = title || 'Remove from local view';
  return `<button class="arc-dismiss-btn" onclick="event.stopPropagation();${onClickJs}" title="${t}">✕</button>`;
};

console.log('[APP] Local Dismiss system loaded');

// ─── Agent Executor Intent Panel ─────────────────────────────────────────────
// Functions to manage and display the agent intent history panel in the
// Agents tab. Integrates with AgentExecutor (agent-executor.js).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render an array of intent objects into the #ae-intents-list panel.
 */
window.aeRenderIntents = function(intents) {
  const list    = document.getElementById('ae-intents-list');
  const empty   = document.getElementById('ae-intents-empty');
  const badge   = document.getElementById('ae-pending-badge');
  const total   = document.getElementById('ae-stat-total');
  const pending = document.getElementById('ae-stat-pending');
  const compl   = document.getElementById('ae-stat-completed');
  const failed  = document.getElementById('ae-stat-failed');
  if (!list) return;

  if (!intents || intents.length === 0) {
    if (empty) empty.classList.remove('hidden');
    if (total)   total.textContent   = '0';
    if (pending) pending.textContent = '0';
    if (compl)   compl.textContent   = '0';
    if (failed)  failed.textContent  = '0';
    if (badge)   badge.classList.add('hidden');
    return;
  }

  if (empty) empty.classList.add('hidden');

  // Stats
  const nPending   = intents.filter(i => ['pending','processing','signing','broadcast'].includes(i.status)).length;
  const nCompleted = intents.filter(i => i.status === 'completed').length;
  const nFailed    = intents.filter(i => i.status === 'failed').length;
  if (total)   total.textContent   = intents.length;
  if (pending) pending.textContent = nPending;
  if (compl)   compl.textContent   = nCompleted;
  if (failed)  failed.textContent  = nFailed;
  if (badge) {
    if (nPending > 0) { badge.textContent = nPending; badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
  }

  const statusMap = {
    pending:    { color: 'text-yellow-400',  bg: 'bg-yellow-900/20 border-yellow-800/30', icon: 'fa-clock',         label: 'Accepted'   },
    processing: { color: 'text-blue-400',    bg: 'bg-blue-900/20 border-blue-800/30',     icon: 'fa-cog fa-spin',   label: 'Executing…' },
    signing:    { color: 'text-purple-400',  bg: 'bg-purple-900/20 border-purple-800/30', icon: 'fa-pen-nib',       label: 'Signing…'   },
    broadcast:  { color: 'text-cyan-400',    bg: 'bg-cyan-900/20 border-cyan-800/30',     icon: 'fa-paper-plane',   label: 'Sent'       },
    completed:  { color: 'text-green-400',   bg: 'bg-green-900/20 border-green-800/30',   icon: 'fa-check-circle',  label: 'Completed'  },
    failed:     { color: 'text-red-400',     bg: 'bg-red-900/20 border-red-800/30',       icon: 'fa-times-circle',  label: 'Failed'     },
    cancelled:  { color: 'text-gray-500',    bg: 'bg-gray-800/30 border-gray-700/30',     icon: 'fa-ban',           label: 'Cancelled'  },
  };

  const explorer = 'https://testnet.arcscan.app';

  const rows = intents.slice(0, 50).map(intent => {
    const s = statusMap[intent.status] || statusMap.pending;
    const time = new Date(intent.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const recipientShort = intent.to
      ? intent.to.slice(0, 8) + '…' + intent.to.slice(-6)
      : intent.receivers ? `${intent.receivers.length} recipients` : '—';
    const txLink = intent.txHash
      ? `<a href="${explorer}/tx/${intent.txHash}" target="_blank" class="underline font-mono text-[10px] text-cyan-400 truncate">${intent.txHash.slice(0,14)}…</a>`
      : '';
    const errorHtml = intent.error
      ? `<div class="text-[10px] text-red-400 mt-0.5 truncate" title="${intent.error.replace(/"/g,'&quot;')}">${intent.error.slice(0,80)}</div>`
      : '';

    return `
      <div class="flex items-start gap-3 p-3 bg-gray-800/40 border ${s.bg} rounded-lg"
           data-intent-id="${intent.id}">
        <div class="flex-shrink-0 mt-0.5">
          <i class="fas ${s.icon} ${s.color} text-sm"></i>
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-white text-xs font-semibold capitalize">${intent.type}</span>
            ${intent.amount ? `<span class="text-${s.color.split('-')[1]}-300 text-xs font-mono">${intent.amount} ${intent.token}</span>` : ''}
            <span class="text-gray-500 text-[10px]">→ ${recipientShort}</span>
            <span class="${s.color} text-[10px] font-semibold ml-auto flex-shrink-0">${s.label}</span>
          </div>
          <div class="flex items-center gap-3 mt-0.5 flex-wrap">
            ${txLink}
            ${intent.blockNumber ? `<span class="text-gray-600 text-[10px]">Block #${intent.blockNumber}</span>` : ''}
            <span class="text-gray-700 text-[10px] ml-auto">${time}</span>
          </div>
          ${errorHtml}
          ${intent.retries > 0 ? `<div class="text-[10px] text-orange-400 mt-0.5">Retry ${intent.retries}/${3}</div>` : ''}
        </div>
        ${['pending','failed','cancelled'].includes(intent.status) ? `
          <button onclick="aeCancelIntent('${intent.id}')"
            class="flex-shrink-0 text-[10px] text-gray-600 hover:text-red-400 transition-colors mt-0.5" title="Cancel intent">
            <i class="fas fa-times"></i>
          </button>` : ''}
      </div>`;
  }).join('');

  // Replace everything except the empty placeholder
  list.innerHTML = rows + (empty ? empty.outerHTML : '');
};

/**
 * Update the Permit2 spending permissions status bar in the intents panel.
 */
function aeUpdatePermitStatusBar() {
  const bar     = document.getElementById('ae-permit-status-bar');
  const txt     = document.getElementById('ae-permit-status-text');
  const btn     = document.getElementById('ae-permit-create-btn');
  const emptyMsg = document.getElementById('ae-empty-msg');
  if (!bar || !txt) return;

  const wallet = window.walletState?.address;

  // No wallet connected
  if (!wallet) {
    bar.className = 'mb-4 p-3 rounded-lg border text-sm flex items-center justify-between gap-3 bg-gray-800/50 border-gray-700/40 text-gray-400';
    txt.innerHTML = '<i class="fas fa-wallet text-gray-500 text-xs mr-2"></i>Connect your wallet to see spending permissions';
    if (btn) btn.classList.add('hidden');
    return;
  }

  // Check session
  let session = null;
  try {
    const raw = localStorage.getItem('arc-pay-session-v3');
    if (raw) {
      const s = JSON.parse(raw);
      if (s?.authorized && s?.wallet && s?.expiry && Date.now() < s.expiry) session = s;
    }
  } catch {}

  if (!session) {
    bar.className = 'mb-4 p-3 rounded-lg border text-sm flex items-center justify-between gap-3 bg-red-900/10 border-red-800/30 text-red-400';
    txt.innerHTML = '<i class="fas fa-lock text-red-500 text-xs mr-2"></i><strong>Daat Agent not authorized</strong> — click <em>"Authorize Daat Agent"</em> in the chat first';
    if (btn) btn.classList.add('hidden');
    if (emptyMsg) emptyMsg.textContent = 'Authorize the Daat Agent in the chat panel to get started.';
    return;
  }

  // Check permit2 spending permissions
  const permitStore = localStorage.getItem('arc_permit2_allowances_v1');
  let activePermits = [];
  try {
    const all = permitStore ? JSON.parse(permitStore) : [];
    const now = Date.now();
    activePermits = all.filter(p =>
      p.wallet && p.wallet.toLowerCase() === wallet.toLowerCase() &&
      p.expiry > now &&
      (p.amount - (p.amountUsed || 0)) > 0
    );
  } catch {}

  if (activePermits.length === 0) {
    // Session OK but no permit
    bar.className = 'mb-4 p-3 rounded-lg border text-sm flex items-center justify-between gap-3 bg-yellow-900/10 border-yellow-700/30 text-yellow-400';
    txt.innerHTML = '<i class="fas fa-exclamation-triangle text-yellow-500 text-xs mr-2"></i><strong>No spending permit active</strong> — create one for fully autonomous execution (no wallet popup per tx)';
    if (btn) btn.classList.remove('hidden');
    if (emptyMsg) emptyMsg.textContent = 'Create a Permit2 spending permission for autonomous execution, then ask the chat to send a payment.';
  } else {
    // Has permits — show summary
    const total = activePermits.length;
    const lines = activePermits.slice(0, 2).map(p => {
      const rem = (p.amount - (p.amountUsed || 0)).toFixed(2);
      const exp = Math.round((p.expiry - Date.now()) / 60000);
      return `${rem} ${p.token} (${exp}m left)`;
    }).join(' · ');
    bar.className = 'mb-4 p-3 rounded-lg border text-sm flex items-center justify-between gap-3 bg-green-900/10 border-green-700/30 text-green-400';
    txt.innerHTML = `<i class="fas fa-check-circle text-green-500 text-xs mr-2"></i><strong>${total} permit${total>1?'s':''} active</strong> — ${lines} · Agent will execute autonomously`;
    if (btn) btn.classList.add('hidden');
    if (emptyMsg) emptyMsg.textContent = 'Permit active. Ask the chat to send a payment — agent will execute automatically.';
  }
}

/**
 * Refresh the intent panel by fetching from AgentExecutor API.
 */
window.aeRefreshPanel = async function() {
  const btn = document.getElementById('ae-refresh-btn');
  if (btn) { btn.innerHTML = '<i class="fas fa-sync fa-spin mr-1"></i> Refreshing…'; }

  // Always update permit status bar
  aeUpdatePermitStatusBar();

  try {
    if (typeof AgentExecutor !== 'undefined') {
      const intents = await AgentExecutor.getIntents();
      aeRenderIntents(intents);
    } else {
      // Fallback: direct API call
      const wallet = window.walletState?.address;
      if (!wallet) { aeRenderIntents([]); return; }
      const r = await fetch(`/api/agent/intents?wallet=${encodeURIComponent(wallet)}&limit=50`);
      const d = await r.json();
      aeRenderIntents(d.success ? d.intents : []);
    }
  } catch(e) {
    console.warn('[AE-PANEL] refresh error:', e);
  } finally {
    if (btn) btn.innerHTML = '<i class="fas fa-sync mr-1"></i> Refresh';
  }
};

/**
 * Cancel an intent from the panel.
 */
window.aeCancelIntent = async function(intentId) {
  if (typeof AgentExecutor !== 'undefined') {
    await AgentExecutor.cancelIntent(intentId);
  } else {
    await fetch(`/api/agent/intents/${intentId}`, { method: 'DELETE' });
  }
  await aeRefreshPanel();
};

/**
 * Clear completed/failed/cancelled intents from the panel (local view only).
 */
window.aeClearCompleted = function() {
  document.querySelectorAll('#ae-intents-list [data-intent-id]').forEach(el => {
    const statusEl = el.querySelector('.text-green-400, .text-red-400, .text-gray-500');
    if (statusEl) el.remove();
  });
  // Recount
  const remaining = document.querySelectorAll('#ae-intents-list [data-intent-id]').length;
  const total = document.getElementById('ae-stat-total');
  if (total) total.textContent = remaining;
  if (remaining === 0) {
    const empty = document.getElementById('ae-intents-empty');
    if (empty) empty.classList.remove('hidden');
  }
};

// Auto-refresh panel when agentExecutor:update fires
window.addEventListener('agentExecutor:update', function() {
  // Debounce: only refresh if panel is visible
  if (document.getElementById('ae-intents-panel')?.offsetParent !== null) {
    clearTimeout(window._aePanelDebounce);
    window._aePanelDebounce = setTimeout(aeRefreshPanel, 500);
  }
});

console.log('[APP] Agent Executor panel functions loaded');

// ============================================================
// SIDEBAR — Mobile & Desktop navigation
// ============================================================
function sidebarOpen() {
  const sidebar = document.getElementById('left-sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (sidebar) sidebar.classList.add('open');
  if (overlay) overlay.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function sidebarClose() {
  const sidebar = document.getElementById('left-sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (sidebar) sidebar.classList.remove('open');
  if (overlay) overlay.classList.remove('active');
  document.body.style.overflow = '';
}
