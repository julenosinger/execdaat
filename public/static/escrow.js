// ─── EscrowWallet Frontend Module ─────────────────────────────────────────────
// Milestone-based USDC Escrow on ARC Testnet (Chain ID 5042002)
// Mirrors EscrowWallet.sol logic

'use strict';

(function () {
  // ── Constants ──────────────────────────────────────────────────────────────
  const CHAIN_ID     = 5042002;
  const EXPLORER     = 'https://testnet.arcscan.app';
  const USDC_ADDR    = '0x3600000000000000000000000000000000000000';
  const API_BASE     = '/api/escrow';

  // ── State ──────────────────────────────────────────────────────────────────
  let escrowState = {
    escrows: [],
    currentEscrow: null,
    currentView: 'list',      // 'list' | 'detail' | 'create'
    walletAddress: null,
    loading: false,
  };

  // ── Helpers ────────────────────────────────────────────────────────────────
  function fmtUsdc(amount) {
    if (amount === null || amount === undefined) return '—';
    return parseFloat(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' USDC';
  }

  function fmtAddr(addr) {
    if (!addr) return '—';
    return addr.slice(0, 8) + '...' + addr.slice(-6);
  }

  function fmtDate(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function fmtTx(hash) {
    if (!hash) return '—';
    return hash.slice(0, 10) + '...' + hash.slice(-8);
  }

  function explorerTxUrl(hash) {
    return `${EXPLORER}/tx/${hash}`;
  }

  function stateColor(state) {
    const map = {
      'Created':   'text-yellow-400 bg-yellow-900/30 border-yellow-700/40',
      'Active':    'text-green-400 bg-green-900/30 border-green-700/40',
      'Disputed':  'text-red-400 bg-red-900/30 border-red-700/40',
      'Completed': 'text-blue-400 bg-blue-900/30 border-blue-700/40',
      'Refunded':  'text-gray-400 bg-gray-800/30 border-gray-700/40',
    };
    return map[state] || 'text-gray-400';
  }

  function milestoneStateColor(state) {
    const map = {
      'Pending':                   'text-gray-400 bg-gray-800/40',
      'RequestedByContractor':     'text-yellow-400 bg-yellow-900/30',
      'Verified':                  'text-green-400 bg-green-900/30',
      'Released':                  'text-blue-400 bg-blue-900/30',
    };
    return map[state] || 'text-gray-400';
  }

  function milestoneStateIcon(state) {
    const map = {
      'Pending':                   'fa-clock',
      'RequestedByContractor':     'fa-paper-plane',
      'Verified':                  'fa-check-circle',
      'Released':                  'fa-coins',
    };
    return map[state] || 'fa-circle';
  }

  async function apiGet(path) {
    const res = await fetch(API_BASE + path);
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

  function showToastEscrow(msg, type = 'info') {
    if (window.showToast) window.showToast(msg, type);
  }

  function getConnectedWallet() {
    return window.walletAddress || null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RENDER MAIN MODULE
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
          <p class="text-gray-400 text-sm mt-0.5">Milestone-based USDC escrow — ARC Testnet · EscrowWallet.sol</p>
        </div>
        <div class="flex items-center gap-2">
          <button onclick="escrowLoadAll()" class="flex items-center gap-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 rounded-xl px-3 py-2 text-sm transition-all">
            <i class="fas fa-sync text-xs"></i> Refresh
          </button>
          <button onclick="escrowShowCreate()" class="flex items-center gap-2 bg-cyan-600 hover:bg-cyan-700 text-white rounded-xl px-4 py-2 text-sm font-semibold transition-all shadow-lg shadow-cyan-900/30">
            <i class="fas fa-plus"></i> New Escrow
          </button>
        </div>
      </div>

      <!-- Stats Bar -->
      <div id="escrow-stats-bar" class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <div class="escrow-stat-card bg-gray-900/60 border border-gray-700/40 rounded-xl p-4">
          <div class="text-gray-400 text-xs mb-1">Total Escrows</div>
          <div id="escrow-stat-total" class="text-2xl font-bold text-white">—</div>
        </div>
        <div class="escrow-stat-card bg-green-900/30 border border-green-700/40 rounded-xl p-4">
          <div class="text-green-400 text-xs mb-1">Active</div>
          <div id="escrow-stat-active" class="text-2xl font-bold text-green-400">—</div>
        </div>
        <div class="escrow-stat-card bg-red-900/30 border border-red-700/40 rounded-xl p-4">
          <div class="text-red-400 text-xs mb-1">Disputed</div>
          <div id="escrow-stat-disputed" class="text-2xl font-bold text-red-400">—</div>
        </div>
        <div class="escrow-stat-card bg-cyan-900/30 border border-cyan-700/40 rounded-xl p-4">
          <div class="text-cyan-400 text-xs mb-1">Total Locked</div>
          <div id="escrow-stat-locked" class="text-lg font-bold text-cyan-400">—</div>
        </div>
      </div>

      <!-- Views -->
      <div id="escrow-view-list"><!-- Escrow list --></div>
      <div id="escrow-view-detail" class="hidden"><!-- Escrow detail --></div>
      <div id="escrow-view-create" class="hidden"><!-- Create form --></div>

      <!-- Events log -->
      <div class="mt-6">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-white font-semibold flex items-center gap-2">
            <i class="fas fa-stream text-purple-400 text-sm"></i> Recent Events
          </h3>
          <button onclick="escrowLoadEvents()" class="text-xs text-purple-400 hover:text-purple-300">
            <i class="fas fa-sync mr-1 text-xs"></i>Refresh
          </button>
        </div>
        <div id="escrow-events-log" class="space-y-1.5 max-h-48 overflow-y-auto"></div>
      </div>
    `;

    escrowLoadAll();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LOAD ALL ESCROWS
  // ══════════════════════════════════════════════════════════════════════════
  window.escrowLoadAll = async function () {
    try {
      const data = await apiGet('/');
      escrowState.escrows = data.escrows || [];

      // Update stats
      const stats = data.stats || {};
      const el = id => document.getElementById(id);
      if (el('escrow-stat-total')) el('escrow-stat-total').textContent = data.total ?? '—';
      if (el('escrow-stat-active')) el('escrow-stat-active').textContent = stats.active ?? '—';
      if (el('escrow-stat-disputed')) el('escrow-stat-disputed').textContent = stats.disputed ?? '—';
      if (el('escrow-stat-locked')) el('escrow-stat-locked').textContent = fmtUsdc(stats.totalLockedUsdc);

      renderEscrowList(escrowState.escrows);
      await escrowLoadEvents();
    } catch (e) {
      console.error('[EscrowWallet] Load error:', e);
    }
  };

  function renderEscrowList(escrows) {
    const view = document.getElementById('escrow-view-list');
    if (!view) return;

    if (!escrows || escrows.length === 0) {
      view.innerHTML = `
        <div class="text-center py-16 text-gray-500">
          <i class="fas fa-shield-alt text-5xl mb-4 block opacity-30"></i>
          <p class="text-lg font-medium text-gray-400">No escrows yet</p>
          <p class="text-sm mt-1">Create your first milestone-based escrow</p>
          <button onclick="escrowShowCreate()" class="mt-4 bg-cyan-600 hover:bg-cyan-700 text-white rounded-xl px-6 py-2 text-sm font-semibold transition-all">
            <i class="fas fa-plus mr-2"></i>Create Escrow
          </button>
        </div>`;
      return;
    }

    view.innerHTML = `
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        ${escrows.map(e => renderEscrowCard(e)).join('')}
      </div>`;
  }

  function renderEscrowCard(e) {
    const progressPct = e.progress || 0;
    const stateClass = stateColor(e.state);

    return `
      <div class="escrow-card bg-gray-900/70 border border-gray-700/40 hover:border-cyan-600/40 rounded-2xl p-5 cursor-pointer transition-all group"
           onclick="escrowShowDetail(${e.id})">
        <!-- Header row -->
        <div class="flex items-start justify-between mb-3">
          <div class="flex items-center gap-2">
            <div class="w-9 h-9 rounded-xl bg-cyan-900/50 border border-cyan-700/40 flex items-center justify-center">
              <i class="fas fa-shield-alt text-cyan-400"></i>
            </div>
            <div>
              <div class="text-white font-semibold text-sm">Escrow #${e.id}</div>
              <div class="text-gray-500 text-xs">${fmtDate(e.createdAt)}</div>
            </div>
          </div>
          <span class="text-xs px-2.5 py-1 rounded-full border font-medium ${stateClass}">${e.state}</span>
        </div>

        <!-- Parties -->
        <div class="grid grid-cols-2 gap-2 mb-3">
          <div class="bg-black/20 rounded-lg p-2.5">
            <p class="text-xs text-gray-500 mb-0.5">Client</p>
            <p class="text-xs font-mono text-blue-400 truncate">${fmtAddr(e.client)}</p>
          </div>
          <div class="bg-black/20 rounded-lg p-2.5">
            <p class="text-xs text-gray-500 mb-0.5">Contractor</p>
            <p class="text-xs font-mono text-purple-400 truncate">${fmtAddr(e.contractor)}</p>
          </div>
        </div>

        <!-- Amount row -->
        <div class="flex justify-between items-center mb-3">
          <div>
            <p class="text-xs text-gray-500">Total Value</p>
            <p class="text-white font-bold">${fmtUsdc(e.totalAmount)}</p>
          </div>
          <div class="text-right">
            <p class="text-xs text-gray-500">Locked</p>
            <p class="text-cyan-400 font-semibold">${fmtUsdc(e.balance)}</p>
          </div>
          <div class="text-right">
            <p class="text-xs text-gray-500">Released</p>
            <p class="text-green-400 font-semibold">${fmtUsdc(e.releasedAmount)}</p>
          </div>
        </div>

        <!-- Progress bar -->
        <div class="mb-3">
          <div class="flex justify-between text-xs text-gray-500 mb-1">
            <span>Progress</span>
            <span>${progressPct}%</span>
          </div>
          <div class="escrow-progress-track">
            <div class="escrow-progress-fill" style="width: ${progressPct}%"></div>
          </div>
        </div>

        <!-- Milestones -->
        <div class="flex items-center justify-between text-xs text-gray-400">
          <span><i class="fas fa-tasks mr-1"></i>${e.completedMilestones}/${e.milestones ? e.milestones.length : 0} milestones verified</span>
          <span class="text-cyan-400 group-hover:text-cyan-300 transition-colors">View <i class="fas fa-chevron-right text-xs ml-1"></i></span>
        </div>
      </div>`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ESCROW DETAIL VIEW
  // ══════════════════════════════════════════════════════════════════════════
  window.escrowShowDetail = async function (escrowId) {
    const listView   = document.getElementById('escrow-view-list');
    const detailView = document.getElementById('escrow-view-detail');
    const createView = document.getElementById('escrow-view-create');
    if (!detailView) return;

    listView && listView.classList.add('hidden');
    createView && createView.classList.add('hidden');
    detailView.classList.remove('hidden');
    detailView.innerHTML = `<div class="text-center py-10 text-gray-500"><i class="fas fa-spinner fa-spin text-2xl"></i></div>`;

    try {
      const data = await apiGet(`/${escrowId}`);
      escrowState.currentEscrow = data;
      renderEscrowDetail(data);
    } catch (e) {
      detailView.innerHTML = `<div class="text-center py-10 text-red-400">Failed to load escrow detail</div>`;
    }
  };

  function renderEscrowDetail(esc) {
    const detailView = document.getElementById('escrow-view-detail');
    if (!detailView) return;

    const progressPct = esc.progress || 0;
    const stateClass = stateColor(esc.state);
    const wallet = getConnectedWallet();
    const isClient = wallet && wallet.toLowerCase() === esc.client.toLowerCase();
    const isContractor = wallet && wallet.toLowerCase() === esc.contractor.toLowerCase();

    detailView.innerHTML = `
      <!-- Back button -->
      <button onclick="escrowShowList()" class="flex items-center gap-2 text-gray-400 hover:text-white text-sm mb-5 transition-colors">
        <i class="fas fa-arrow-left"></i> Back to Escrows
      </button>

      <!-- Escrow Header Card -->
      <div class="bg-gray-900/70 border border-gray-700/40 rounded-2xl p-6 mb-5">
        <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-5">
          <div class="flex items-center gap-3">
            <div class="w-12 h-12 rounded-2xl bg-cyan-900/50 border border-cyan-700/40 flex items-center justify-center">
              <i class="fas fa-shield-alt text-cyan-400 text-xl"></i>
            </div>
            <div>
              <h3 class="text-white font-bold text-xl">Escrow #${esc.id}</h3>
              <p class="text-gray-400 text-sm">${esc.network} · Chain ${esc.chainId}</p>
            </div>
          </div>
          <div class="flex items-center gap-3">
            <span class="text-sm px-3 py-1.5 rounded-full border font-medium ${stateClass}">${esc.state}</span>
            <a href="${esc.explorerUrl}" target="_blank" class="text-xs text-gray-400 hover:text-cyan-400 transition-colors">
              <i class="fas fa-external-link-alt mr-1"></i>${fmtTx(esc.txHash)}
            </a>
          </div>
        </div>

        <!-- Parties -->
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
          <div class="bg-blue-900/20 border border-blue-700/30 rounded-xl p-4">
            <div class="flex items-center gap-2 mb-2">
              <i class="fas fa-user text-blue-400 text-xs"></i>
              <span class="text-blue-400 text-xs font-medium uppercase tracking-wider">Client (Payer)</span>
              ${isClient ? '<span class="text-xs bg-blue-800/50 text-blue-300 px-2 py-0.5 rounded-full ml-auto">You</span>' : ''}
            </div>
            <p class="text-white font-mono text-sm break-all">${esc.client}</p>
          </div>
          <div class="bg-purple-900/20 border border-purple-700/30 rounded-xl p-4">
            <div class="flex items-center gap-2 mb-2">
              <i class="fas fa-hard-hat text-purple-400 text-xs"></i>
              <span class="text-purple-400 text-xs font-medium uppercase tracking-wider">Contractor (Receiver)</span>
              ${isContractor ? '<span class="text-xs bg-purple-800/50 text-purple-300 px-2 py-0.5 rounded-full ml-auto">You</span>' : ''}
            </div>
            <p class="text-white font-mono text-sm break-all">${esc.contractor}</p>
          </div>
        </div>

        <!-- Amount Stats -->
        <div class="grid grid-cols-3 gap-3 mb-5">
          <div class="bg-black/30 rounded-xl p-3 text-center">
            <p class="text-xs text-gray-500 mb-1">Total Value</p>
            <p class="text-white font-bold">${fmtUsdc(esc.totalAmount)}</p>
          </div>
          <div class="bg-cyan-900/20 rounded-xl p-3 text-center">
            <p class="text-xs text-cyan-400 mb-1">Locked in Escrow</p>
            <p class="text-cyan-400 font-bold">${fmtUsdc(esc.balance)}</p>
          </div>
          <div class="bg-green-900/20 rounded-xl p-3 text-center">
            <p class="text-xs text-green-400 mb-1">Released</p>
            <p class="text-green-400 font-bold">${fmtUsdc(esc.releasedAmount)}</p>
          </div>
        </div>

        <!-- Progress bar -->
        <div class="mb-2">
          <div class="flex justify-between text-xs text-gray-400 mb-1.5">
            <span>Escrow Progress</span>
            <span class="font-semibold text-white">${progressPct}% complete</span>
          </div>
          <div class="escrow-progress-track-lg">
            <div class="escrow-progress-fill-lg" style="width: ${progressPct}%"></div>
          </div>
          <div class="flex justify-between text-xs text-gray-500 mt-1">
            <span>Deposited: ${fmtUsdc(esc.depositedAmount)}</span>
            <span>Released: ${esc.milestones ? esc.milestones.filter(m => m.released).length : 0}/${esc.milestones ? esc.milestones.length : 0} milestones</span>
          </div>
        </div>
      </div>

      <!-- Actions Banner (deposit if Created) -->
      ${esc.state === 'Created' ? `
      <div class="bg-yellow-900/20 border border-yellow-700/30 rounded-xl p-4 mb-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div class="flex items-start gap-3">
          <i class="fas fa-exclamation-circle text-yellow-400 mt-0.5"></i>
          <div>
            <p class="text-yellow-300 font-medium text-sm">Awaiting USDC Deposit</p>
            <p class="text-yellow-400/70 text-xs">Deposit ${fmtUsdc(esc.totalAmount - esc.depositedAmount)} to activate escrow</p>
          </div>
        </div>
        <button onclick="escrowOpenDeposit(${esc.id})" class="flex items-center gap-2 bg-yellow-600 hover:bg-yellow-700 text-white rounded-xl px-4 py-2 text-sm font-semibold transition-all whitespace-nowrap">
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
        <button onclick="escrowRefund(${esc.id})" class="flex items-center gap-2 bg-red-600 hover:bg-red-700 text-white rounded-xl px-4 py-2 text-sm font-semibold transition-all whitespace-nowrap">
          <i class="fas fa-undo"></i> Issue Refund
        </button>
      </div>` : ''}

      <!-- Milestones -->
      <div class="bg-gray-900/70 border border-gray-700/40 rounded-2xl p-6 mb-5">
        <h4 class="text-white font-semibold mb-4 flex items-center gap-2">
          <i class="fas fa-tasks text-cyan-400"></i> Milestones
          <span class="text-xs text-gray-500 ml-1">${esc.milestones ? esc.milestones.filter(m => m.released).length : 0}/${esc.milestones ? esc.milestones.length : 0} released</span>
        </h4>
        <div class="space-y-3">
          ${(esc.milestones || []).map(m => renderMilestoneRow(m, esc)).join('')}
        </div>
      </div>

      <!-- Action Buttons -->
      ${esc.state === 'Active' ? `
      <div class="bg-gray-900/60 border border-gray-700/40 rounded-xl p-4 mb-5">
        <h4 class="text-gray-400 text-xs uppercase tracking-wider mb-3">Actions</h4>
        <div class="flex flex-wrap gap-2">
          <button onclick="escrowOpenDeposit(${esc.id})" class="flex items-center gap-1.5 bg-blue-600/20 hover:bg-blue-600/30 border border-blue-600/40 text-blue-400 rounded-xl px-3 py-2 text-sm transition-all">
            <i class="fas fa-arrow-circle-down text-xs"></i> Deposit USDC
          </button>
          <button onclick="escrowRaiseDispute(${esc.id})" class="flex items-center gap-1.5 bg-red-600/20 hover:bg-red-600/30 border border-red-600/40 text-red-400 rounded-xl px-3 py-2 text-sm transition-all">
            <i class="fas fa-gavel text-xs"></i> Raise Dispute
          </button>
        </div>
      </div>` : ''}

      <!-- Event History -->
      <div class="bg-gray-900/60 border border-gray-700/40 rounded-xl p-4">
        <h4 class="text-white font-semibold mb-3 flex items-center gap-2">
          <i class="fas fa-history text-gray-400 text-sm"></i> Event History
        </h4>
        <div class="space-y-2 max-h-64 overflow-y-auto">
          ${(esc.events || []).slice(0, 20).map(ev => `
            <div class="flex items-start gap-3 bg-black/20 rounded-lg p-3">
              <div class="w-7 h-7 rounded-full ${ev.event.includes('Released') ? 'bg-green-900/50' : ev.event.includes('Dispute') || ev.event.includes('Refund') ? 'bg-red-900/50' : 'bg-purple-900/50'} flex items-center justify-center flex-shrink-0 mt-0.5">
                <i class="fas ${ev.event.includes('Released') ? 'fa-coins' : ev.event.includes('Deposit') ? 'fa-arrow-down' : ev.event.includes('Dispute') ? 'fa-gavel' : ev.event.includes('Refund') ? 'fa-undo' : 'fa-check'} text-xs ${ev.event.includes('Released') ? 'text-green-400' : ev.event.includes('Dispute') || ev.event.includes('Refund') ? 'text-red-400' : 'text-purple-400'}"></i>
              </div>
              <div class="flex-1 min-w-0">
                <div class="flex items-center justify-between gap-2">
                  <span class="text-white text-sm font-medium">${ev.event}</span>
                  <a href="${ev.explorerUrl}" target="_blank" class="text-xs text-gray-500 hover:text-cyan-400 font-mono flex-shrink-0">${fmtTx(ev.txHash)}</a>
                </div>
                <p class="text-gray-500 text-xs mt-0.5">${fmtDate(ev.timestamp)}</p>
              </div>
            </div>`).join('') || '<p class="text-gray-500 text-sm text-center py-4">No events yet</p>'}
        </div>
      </div>`;
  }

  function renderMilestoneRow(m, esc) {
    const stateClass = milestoneStateColor(m.state);
    const icon = milestoneStateIcon(m.state);
    const isActive = esc.state === 'Active';

    const canRequest   = isActive && m.state === 'Pending';
    const canVerify    = isActive && m.state === 'RequestedByContractor' && !m.completed;
    const canRelease   = isActive && m.completed && !m.released;

    return `
      <div class="escrow-milestone-row flex items-start gap-3 bg-black/20 border border-gray-700/30 rounded-xl p-4 ${m.released ? 'opacity-75' : ''}">
        <div class="w-8 h-8 rounded-lg ${stateClass} border border-current/30 flex items-center justify-center flex-shrink-0 mt-0.5">
          <i class="fas ${icon} text-xs"></i>
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between gap-2 mb-1">
            <span class="text-white font-medium text-sm truncate">${m.description}</span>
            <span class="text-cyan-400 font-bold text-sm flex-shrink-0">${fmtUsdc(m.amount)}</span>
          </div>
          <div class="flex items-center gap-3 flex-wrap">
            <span class="text-xs px-2 py-0.5 rounded-full ${stateClass}">${m.state}</span>
            ${m.requestedAt ? `<span class="text-xs text-gray-500">Requested: ${fmtDate(m.requestedAt)}</span>` : ''}
            ${m.verifiedAt ? `<span class="text-xs text-green-400">Verified: ${fmtDate(m.verifiedAt)}</span>` : ''}
            ${m.releasedAt ? `<span class="text-xs text-blue-400">Released: ${fmtDate(m.releasedAt)}</span>` : ''}
          </div>
          <!-- Action buttons per milestone -->
          ${canRequest || canVerify || canRelease ? `
          <div class="flex gap-2 mt-2">
            ${canRequest ? `<button onclick="escrowRequestMilestone(${esc.id}, ${m.id})" class="escrow-ms-btn bg-yellow-600/20 hover:bg-yellow-600/30 border border-yellow-600/40 text-yellow-400 text-xs px-3 py-1.5 rounded-lg transition-all"><i class="fas fa-paper-plane mr-1"></i>Request Verification</button>` : ''}
            ${canVerify ? `<button onclick="escrowVerifyMilestone(${esc.id}, ${m.id})" class="escrow-ms-btn bg-green-600/20 hover:bg-green-600/30 border border-green-600/40 text-green-400 text-xs px-3 py-1.5 rounded-lg transition-all"><i class="fas fa-check mr-1"></i>Verify & Approve</button>` : ''}
            ${canRelease ? `<button onclick="escrowReleaseMilestone(${esc.id}, ${m.id})" class="escrow-ms-btn bg-blue-600/20 hover:bg-blue-600/30 border border-blue-600/40 text-blue-400 text-xs px-3 py-1.5 rounded-lg transition-all"><i class="fas fa-coins mr-1"></i>Release Payment</button>` : ''}
          </div>` : ''}
        </div>
      </div>`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CREATE ESCROW FORM
  // ══════════════════════════════════════════════════════════════════════════
  window.escrowShowCreate = function () {
    const listView   = document.getElementById('escrow-view-list');
    const detailView = document.getElementById('escrow-view-detail');
    const createView = document.getElementById('escrow-view-create');

    listView && listView.classList.add('hidden');
    detailView && detailView.classList.add('hidden');
    createView && createView.classList.remove('hidden');

    const wallet = getConnectedWallet() || '';

    createView.innerHTML = `
      <button onclick="escrowShowList()" class="flex items-center gap-2 text-gray-400 hover:text-white text-sm mb-5 transition-colors">
        <i class="fas fa-arrow-left"></i> Back
      </button>

      <div class="bg-gray-900/70 border border-gray-700/40 rounded-2xl p-6">
        <h3 class="text-white font-bold text-xl mb-5 flex items-center gap-2">
          <i class="fas fa-plus-circle text-cyan-400"></i> Create New Escrow
        </h3>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
          <div>
            <label class="text-xs text-gray-400 uppercase tracking-wider mb-1.5 block">Client Address <span class="text-cyan-400">*</span></label>
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
            <button onclick="escrowAddMilestone()" class="text-xs text-cyan-400 hover:text-cyan-300 flex items-center gap-1">
              <i class="fas fa-plus text-xs"></i> Add Milestone
            </button>
          </div>
          <div id="escrow-milestones-list" class="space-y-2">
            ${renderMilestoneInput(0)}
            ${renderMilestoneInput(1)}
            ${renderMilestoneInput(2)}
          </div>
        </div>

        <!-- Total preview -->
        <div class="bg-cyan-900/20 border border-cyan-700/30 rounded-xl p-3 mb-5">
          <div class="flex justify-between items-center">
            <span class="text-cyan-400 text-sm font-medium">Total Escrow Amount</span>
            <span id="escrow-create-total" class="text-white font-bold text-lg">0.00 USDC</span>
          </div>
          <p class="text-xs text-cyan-400/60 mt-1">Sum of all milestone amounts</p>
        </div>

        <div id="escrow-create-msg" class="hidden mb-3 rounded-xl p-3 text-sm"></div>

        <div class="flex gap-3">
          <button onclick="escrowSubmitCreate()"
            class="flex-1 flex items-center justify-center gap-2 bg-cyan-600 hover:bg-cyan-700 text-white rounded-xl py-3 text-sm font-semibold transition-all">
            <i class="fas fa-shield-alt"></i> Create Escrow
          </button>
          <button onclick="escrowShowList()" class="px-4 py-3 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-xl text-sm transition-all">
            Cancel
          </button>
        </div>
      </div>`;

    // Attach input listeners for total calculation
    attachMilestoneListeners();
  };

  let milestoneCount = 3;

  function renderMilestoneInput(idx) {
    return `
      <div class="escrow-milestone-input flex gap-2 items-start" data-idx="${idx}">
        <div class="flex-1 bg-gray-800/60 border border-gray-700/50 rounded-xl p-3 flex gap-2">
          <input type="text" placeholder="Description" data-ms-desc="${idx}"
            class="escrow-input flex-1 bg-transparent text-sm text-white placeholder-gray-600 focus:outline-none min-w-0">
          <div class="flex items-center gap-1 flex-shrink-0">
            <input type="number" placeholder="USDC" min="1" step="0.01" data-ms-amount="${idx}"
              class="escrow-input w-24 bg-gray-700/50 border border-gray-600/50 rounded-lg px-2 py-1 text-sm text-cyan-400 font-bold placeholder-gray-600 focus:outline-none focus:border-cyan-500 text-right"
              oninput="escrowCalcTotal()">
            <span class="text-xs text-gray-500">USDC</span>
          </div>
        </div>
        <button onclick="escrowRemoveMilestone(${idx})" class="w-8 h-8 flex items-center justify-center text-gray-600 hover:text-red-400 rounded-lg hover:bg-red-900/20 transition-all mt-2 flex-shrink-0">
          <i class="fas fa-times text-xs"></i>
        </button>
      </div>`;
  }

  window.escrowAddMilestone = function () {
    const list = document.getElementById('escrow-milestones-list');
    if (!list) return;
    const div = document.createElement('div');
    div.innerHTML = renderMilestoneInput(milestoneCount++);
    list.appendChild(div.firstElementChild);
    attachMilestoneListeners();
  };

  window.escrowRemoveMilestone = function (idx) {
    const el = document.querySelector(`[data-idx="${idx}"]`);
    if (el) el.remove();
    escrowCalcTotal();
  };

  window.escrowCalcTotal = function () {
    const amounts = document.querySelectorAll('[data-ms-amount]');
    let total = 0;
    amounts.forEach(inp => { total += parseFloat(inp.value) || 0; });
    const el = document.getElementById('escrow-create-total');
    if (el) el.textContent = total.toFixed(2) + ' USDC';
  };

  function attachMilestoneListeners() {
    document.querySelectorAll('[data-ms-amount]').forEach(inp => {
      inp.addEventListener('input', escrowCalcTotal);
    });
  }

  window.escrowSubmitCreate = async function () {
    const msg = document.getElementById('escrow-create-msg');
    const clientEl = document.getElementById('escrow-create-client');
    const contractorEl = document.getElementById('escrow-create-contractor');

    const client = clientEl && clientEl.value.trim();
    const contractor = contractorEl && contractorEl.value.trim();

    if (!client || !client.startsWith('0x')) {
      showEscrowMsg(msg, 'Client address is required (0x...)', 'error');
      return;
    }
    if (!contractor || !contractor.startsWith('0x')) {
      showEscrowMsg(msg, 'Contractor address is required (0x...)', 'error');
      return;
    }
    if (client.toLowerCase() === contractor.toLowerCase()) {
      showEscrowMsg(msg, 'Client and contractor must be different addresses', 'error');
      return;
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
      showEscrowMsg(msg, 'Add at least one milestone with amount > 0', 'error');
      return;
    }

    const totalAmount = milestones.reduce((s, m) => s + m.amount, 0);
    showEscrowMsg(msg, 'Creating escrow...', 'loading');

    try {
      const result = await apiPost('/create', { client, contractor, totalAmount, milestones });
      if (result.success) {
        showEscrowMsg(msg, `✅ Escrow #${result.escrowId} created!`, 'success');
        showToastEscrow(`Escrow #${result.escrowId} created — ${fmtUsdc(totalAmount)}`, 'success');
        setTimeout(() => {
          escrowState.escrows = [];
          escrowShowDetail(result.escrowId);
          escrowLoadAll();
        }, 1200);
      } else {
        showEscrowMsg(msg, result.error || 'Failed to create escrow', 'error');
      }
    } catch (e) {
      showEscrowMsg(msg, 'Network error creating escrow', 'error');
    }
  };

  // ══════════════════════════════════════════════════════════════════════════
  // DEPOSIT MODAL
  // ══════════════════════════════════════════════════════════════════════════
  window.escrowOpenDeposit = function (escrowId) {
    const esc = escrowStore(escrowId);
    const remaining = esc ? (esc.totalAmount - esc.depositedAmount) : 0;

    const existing = document.getElementById('escrow-deposit-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'escrow-deposit-modal';
    modal.className = 'fixed inset-0 z-[80] flex items-center justify-center bg-black/70 backdrop-blur-sm';
    modal.innerHTML = `
      <div class="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md mx-4 p-6 shadow-2xl">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-white font-bold flex items-center gap-2">
            <i class="fas fa-arrow-circle-down text-cyan-400"></i> Deposit USDC
          </h3>
          <button onclick="document.getElementById('escrow-deposit-modal').remove()" class="text-gray-500 hover:text-white">
            <i class="fas fa-times"></i>
          </button>
        </div>

        <div class="bg-cyan-900/20 border border-cyan-700/30 rounded-xl p-3 mb-4">
          <p class="text-xs text-cyan-400">Remaining to deposit</p>
          <p class="text-xl font-bold text-cyan-300">${fmtUsdc(remaining)}</p>
        </div>

        <div class="mb-4">
          <label class="text-xs text-gray-400 uppercase tracking-wider mb-1.5 block">Amount (USDC)</label>
          <input id="deposit-amount" type="number" min="1" step="0.01"
            value="${remaining.toFixed(2)}"
            class="escrow-input w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-lg font-bold text-cyan-400 placeholder-gray-600 focus:border-cyan-500 focus:outline-none text-center">
        </div>

        <div class="mb-4 text-xs text-gray-500 bg-gray-800/50 rounded-xl p-3 space-y-1">
          <p><i class="fas fa-info-circle mr-1"></i> USDC is locked until milestones are verified</p>
          <p><i class="fas fa-lock mr-1"></i> Only client can withdraw (via dispute + refund)</p>
          <p><i class="fas fa-coins mr-1"></i> Contract: ${USDC_ADDR.slice(0,10)}...${USDC_ADDR.slice(-6)}</p>
        </div>

        <div id="deposit-msg" class="hidden mb-3 rounded-xl p-3 text-sm"></div>

        <div class="flex gap-3">
          <button onclick="escrowSubmitDeposit(${escrowId})" class="flex-1 bg-cyan-600 hover:bg-cyan-700 text-white rounded-xl py-3 text-sm font-semibold transition-all">
            <i class="fas fa-arrow-circle-down mr-2"></i>Deposit USDC
          </button>
          <button onclick="document.getElementById('escrow-deposit-modal').remove()" class="px-4 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-xl text-sm transition-all">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
  };

  window.escrowSubmitDeposit = async function (escrowId) {
    const amtEl = document.getElementById('deposit-amount');
    const msg   = document.getElementById('deposit-msg');
    const amount = parseFloat(amtEl && amtEl.value);
    if (!amount || amount <= 0) {
      showEscrowMsg(msg, 'Enter a valid amount', 'error');
      return;
    }

    const wallet = getConnectedWallet();
    showEscrowMsg(msg, 'Processing deposit...', 'loading');

    try {
      // Simulate EVM approve + transfer
      let txHash = null;
      if (window.ethereum && wallet) {
        try {
          const amountHex = '0x' + BigInt(Math.round(amount * 1e6)).toString(16);
          const tx = {
            from: wallet,
            to: USDC_ADDR,
            data: '0x095ea7b3' + // approve(address,uint256)
              '000000000000000000000000867650F5eAe8df91445971f14d89fd84F0C9a9f8' +
              amountHex.slice(2).padStart(64, '0'),
          };
          txHash = await window.ethereum.request({ method: 'eth_sendTransaction', params: [tx] });
        } catch (evmErr) {
          console.warn('[EscrowWallet] EVM tx skipped:', evmErr.message);
        }
      }

      const result = await apiPost(`/${escrowId}/deposit`, {
        amount,
        depositor: wallet || '0xDemoClient0000000000000000000000000000',
        txHash,
      });

      if (result.success) {
        showEscrowMsg(msg, `✅ Deposited ${fmtUsdc(amount)}!`, 'success');
        showToastEscrow(`Deposit confirmed — ${fmtUsdc(amount)} locked in escrow`, 'success');
        const modal = document.getElementById('escrow-deposit-modal');
        setTimeout(() => {
          if (modal) modal.remove();
          escrowShowDetail(escrowId);
          escrowLoadAll();
        }, 1200);
      } else {
        showEscrowMsg(msg, result.error || 'Deposit failed', 'error');
      }
    } catch (e) {
      showEscrowMsg(msg, 'Network error during deposit', 'error');
    }
  };

  function escrowStore(id) {
    return escrowState.escrows.find(e => e.id === id) || escrowState.currentEscrow;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MILESTONE ACTIONS
  // ══════════════════════════════════════════════════════════════════════════
  window.escrowRequestMilestone = async function (escrowId, milestoneId) {
    const wallet = getConnectedWallet();
    try {
      const result = await apiPost(`/${escrowId}/request/${milestoneId}`, { caller: wallet });
      if (result.success) {
        showToastEscrow(`Milestone ${milestoneId + 1} verification requested`, 'success');
        escrowShowDetail(escrowId);
        escrowLoadAll();
      } else {
        showToastEscrow(result.error || 'Request failed', 'error');
      }
    } catch (e) {
      showToastEscrow('Network error', 'error');
    }
  };

  window.escrowVerifyMilestone = async function (escrowId, milestoneId) {
    const wallet = getConnectedWallet();
    try {
      const result = await apiPost(`/${escrowId}/verify/${milestoneId}`, { caller: wallet });
      if (result.success) {
        showToastEscrow(`Milestone ${milestoneId + 1} verified! Contractor can now release payment.`, 'success');
        escrowShowDetail(escrowId);
        escrowLoadAll();
      } else {
        showToastEscrow(result.error || 'Verification failed', 'error');
      }
    } catch (e) {
      showToastEscrow('Network error', 'error');
    }
  };

  window.escrowReleaseMilestone = async function (escrowId, milestoneId) {
    const wallet = getConnectedWallet();
    try {
      const result = await apiPost(`/${escrowId}/release/${milestoneId}`, { caller: wallet });
      if (result.success) {
        showToastEscrow(`Payment released! ${fmtUsdc(result.amountReleased)} sent to contractor.`, 'success');
        escrowShowDetail(escrowId);
        escrowLoadAll();
      } else {
        showToastEscrow(result.error || 'Release failed', 'error');
      }
    } catch (e) {
      showToastEscrow('Network error', 'error');
    }
  };

  window.escrowRaiseDispute = async function (escrowId) {
    const wallet = getConnectedWallet();
    const reason = prompt('Reason for dispute (optional):') || '';
    try {
      const result = await apiPost(`/${escrowId}/dispute`, {
        raisedBy: wallet || 'unknown',
        reason,
      });
      if (result.success) {
        showToastEscrow('Dispute raised — escrow frozen', 'warning');
        escrowShowDetail(escrowId);
        escrowLoadAll();
      } else {
        showToastEscrow(result.error || 'Failed to raise dispute', 'error');
      }
    } catch (e) {
      showToastEscrow('Network error', 'error');
    }
  };

  window.escrowRefund = async function (escrowId) {
    if (!confirm('Confirm full refund to client? This will close the escrow.')) return;
    try {
      const result = await apiPost(`/${escrowId}/refund`, {});
      if (result.success) {
        showToastEscrow(`Refund issued — ${fmtUsdc(result.refundAmount)} returned to client`, 'success');
        escrowShowDetail(escrowId);
        escrowLoadAll();
      } else {
        showToastEscrow(result.error || 'Refund failed', 'error');
      }
    } catch (e) {
      showToastEscrow('Network error', 'error');
    }
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
      if (events.length === 0) {
        el.innerHTML = '<p class="text-gray-600 text-xs text-center py-3">No events yet</p>';
        return;
      }
      el.innerHTML = events.slice(0, 10).map(ev => `
        <div class="flex items-center gap-3 bg-black/20 rounded-lg px-3 py-2">
          <div class="w-6 h-6 rounded-full ${ev.event.includes('Released') ? 'bg-green-900/50 text-green-400' : ev.event.includes('Disputed') || ev.event.includes('Refund') ? 'bg-red-900/50 text-red-400' : 'bg-purple-900/50 text-purple-400'} flex items-center justify-center flex-shrink-0">
            <i class="fas ${ev.event.includes('Released') ? 'fa-coins' : ev.event.includes('Deposit') ? 'fa-arrow-down' : ev.event.includes('Dispute') ? 'fa-gavel' : 'fa-check'} text-xs"></i>
          </div>
          <div class="flex-1 min-w-0">
            <span class="text-white text-xs font-medium">Escrow #${ev.escrowId}</span>
            <span class="text-gray-400 text-xs ml-2">${ev.event}</span>
          </div>
          <a href="${ev.explorerUrl}" target="_blank" class="text-xs text-gray-600 hover:text-cyan-400 font-mono flex-shrink-0">${fmtTx(ev.txHash)}</a>
        </div>`).join('');
    } catch (e) {
      el.innerHTML = '<p class="text-gray-600 text-xs text-center py-3">Failed to load events</p>';
    }
  };

  // ══════════════════════════════════════════════════════════════════════════
  // NAVIGATION
  // ══════════════════════════════════════════════════════════════════════════
  window.escrowShowList = function () {
    const listView   = document.getElementById('escrow-view-list');
    const detailView = document.getElementById('escrow-view-detail');
    const createView = document.getElementById('escrow-view-create');
    listView   && listView.classList.remove('hidden');
    detailView && detailView.classList.add('hidden');
    createView && createView.classList.add('hidden');
    escrowLoadAll();
  };

  // ── Helpers ────────────────────────────────────────────────────────────────
  function showEscrowMsg(el, text, type) {
    if (!el) return;
    el.classList.remove('hidden');
    const styles = {
      success: 'bg-green-900/30 border border-green-700/40 text-green-300',
      error:   'bg-red-900/30 border border-red-700/40 text-red-300',
      loading: 'bg-gray-800/60 border border-gray-700/40 text-gray-300',
    };
    el.className = `rounded-xl p-3 text-sm ${styles[type] || styles.loading}`;
    el.innerHTML = type === 'loading' ? `<i class="fas fa-spinner fa-spin mr-2"></i>${text}` : text;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // INIT
  // ══════════════════════════════════════════════════════════════════════════
  window.escrowInit = function () {
    renderEscrowModule();
    console.log('[EscrowWallet] Module loaded — ARC Testnet chain', CHAIN_ID);
  };

  // Auto-init when tab is switched to escrow
  const origSwitchTab = window.switchTab;
  window.switchTab = function (tab) {
    if (origSwitchTab) origSwitchTab(tab);
    if (tab === 'escrow') {
      // Delay to allow DOM render
      setTimeout(() => {
        if (window.escrowInit) window.escrowInit();
      }, 50);
    }
  };

  console.log('[EscrowWallet] Module registered — ARC Testnet');
})();
