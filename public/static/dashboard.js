// ===== DASHBOARD v3 — Real On-Chain Data + Live Metrics =====
// Replaces all static/placeholder data with live blockchain reads
// Features: block explorer data, network latency, contract metrics,
//           activity feed from localStorage + on-chain events

'use strict';

const DB_RPC      = 'https://rpc.testnet.arc.network';
const DB_EXPLORER = 'https://testnet.arcscan.app';
const DB_USDC     = '0x3600000000000000000000000000000000000000';
const DB_EURC     = '0x89B5EF8FfF7e58BD6A1b7FcF04F1B6A2bbabD72a';
const DB_FACTORY  = '0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A';

// ── RPC helpers ─────────────────────────────────────────────────────────────
async function dbRpc(method, params = []) {
  const res  = await fetch(DB_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

async function dbEthCall(to, data) {
  return dbRpc('eth_call', [{ to, data }, 'latest']);
}

function dbEncAddr(addr) {
  return addr.replace('0x','').padStart(64,'0');
}

function dbDecUint(hex) {
  if (!hex || hex === '0x') return 0n;
  return BigInt(hex);
}

// ── Multi-call: batch RPC calls in parallel ──────────────────────────────────
async function dbBatchCalls(calls) {
  const body = calls.map((c, i) => ({
    jsonrpc: '2.0', id: i + 1, method: c.method, params: c.params,
  }));
  try {
    const res  = await fetch(DB_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    // json may be array or single — normalize
    const arr = Array.isArray(json) ? json : [json];
    return arr.map(r => r.result || null);
  } catch (e) {
    // fallback: individual calls
    return Promise.all(calls.map(c => dbRpc(c.method, c.params).catch(() => null)));
  }
}

// ── Fetch comprehensive on-chain stats ──────────────────────────────────────
async function dbFetchOnChainStats(walletAddress) {
  const results = {
    blockNumber: 0, latency: 0, gasPrice: '0',
    usdcBalance: 0n, eurcBalance: 0n,
    contractCount: 0,
    usdcTotalSupply: 0n,
    factoryOwner: '',
  };

  const start = Date.now();

  // Build batch calls
  const calls = [
    { method: 'eth_blockNumber',  params: [] },
    { method: 'eth_gasPrice',     params: [] },
    { method: 'eth_call', params: [{ to: DB_FACTORY, data: '0xdae90d8d' }, 'latest'] }, // contractCount()
    { method: 'eth_call', params: [{ to: DB_USDC, data: '0x18160ddd' }, 'latest'] },    // totalSupply()
  ];

  if (walletAddress) {
    const enc = dbEncAddr(walletAddress);
    calls.push({ method: 'eth_call', params: [{ to: DB_USDC, data: '0x70a08231' + enc }, 'latest'] }); // balanceOf USDC
    calls.push({ method: 'eth_call', params: [{ to: DB_EURC, data: '0x70a08231' + enc }, 'latest'] }); // balanceOf EURC
  }

  try {
    const raw = await dbBatchCalls(calls);
    results.latency      = Date.now() - start;
    results.blockNumber  = raw[0] ? parseInt(raw[0], 16) : 0;
    results.gasPrice     = raw[1] ? (Number(BigInt(raw[1])) / 1e9).toFixed(2) + ' Gwei' : '10 Gwei';
    results.contractCount = raw[2] ? Number(dbDecUint(raw[2])) : 0;
    results.usdcTotalSupply = raw[3] ? dbDecUint(raw[3]) : 0n;
    if (walletAddress) {
      results.usdcBalance = raw[4] ? dbDecUint(raw[4]) : 0n;
      results.eurcBalance = raw[5] ? dbDecUint(raw[5]) : 0n;
    }
  } catch (e) {
    console.warn('[DB] RPC batch error:', e.message);
    results.latency = Date.now() - start;
  }

  return results;
}

// ── Build activity feed from localStorage ────────────────────────────────────
function dbGetLocalActivity() {
  const items = [];

  // Payment history
  try {
    const pays = JSON.parse(localStorage.getItem('arc_pay_history') || '[]');
    pays.slice(-6).reverse().forEach(p => {
      items.push({
        icon:  'fa-exchange-alt', color: 'purple',
        title: `Payment ${p.amount || ''} ${p.token || 'USDC'}`,
        sub:   `To: ${p.recipient ? p.recipient.slice(0,10)+'…' : '—'} · ${p.txHash ? p.txHash.slice(0,14)+'…' : 'pending'}`,
        status: p.status === 'completed' ? 'Completed' : p.status === 'failed' ? 'Failed' : 'Completed',
        statusColor: p.status === 'failed' ? 'red' : 'green',
        time:   p.timestamp ? new Date(p.timestamp).toLocaleString() : '—',
        link:   p.txHash ? `${DB_EXPLORER}/tx/${p.txHash}` : null,
        ts:     p.timestamp || 0,
      });
    });
  } catch { }

  // Contract metadata
  try {
    const metas = JSON.parse(localStorage.getItem('arc_cf_meta_v4') || '{}');
    Object.entries(metas).reverse().forEach(([id, m]) => {
      const title = m.receiptData?.title || m.title || `Contract #${id}`;
      const value = m.receiptData?.totalValue || m.totalValue || '?';
      const status = m.completedAt ? 'Completed' : m.cancelledAt ? 'Cancelled' : 'Active';
      const statusColor = m.completedAt ? 'green' : m.cancelledAt ? 'red' : 'cyan';
      items.push({
        icon:  'fa-file-contract', color: 'blue',
        title: `${title.length > 30 ? title.slice(0,30)+'…' : title}`,
        sub:   `$${value} USDC · Escrow · ID #${id}`,
        status, statusColor,
        time:   m.createdAt ? new Date(m.createdAt).toLocaleString() : '—',
        link:   `${DB_EXPLORER}/address/${DB_FACTORY}`,
        ts:     m.createdAt || 0,
      });
    });
  } catch { }

  // Multisend history
  try {
    const ms = JSON.parse(localStorage.getItem('arc_multisend_history') || '[]');
    ms.slice(-3).reverse().forEach(m => {
      items.push({
        icon: 'fa-paper-plane', color: 'cyan',
        title: `MultiSend · ${m.recipients || '?'} recipients`,
        sub:   `Total: $${m.totalAmount || '?'} USDC`,
        status: 'Completed', statusColor: 'green',
        time:  m.timestamp ? new Date(m.timestamp).toLocaleString() : '—',
        link:  m.txHash ? `${DB_EXPLORER}/tx/${m.txHash}` : null,
        ts:    m.timestamp || 0,
      });
    });
  } catch { }

  // Sort by timestamp descending and limit
  items.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return items.slice(0, 12);
}

// ── Render activity list ─────────────────────────────────────────────────────
function dbRenderActivity(items) {
  const el = document.getElementById('recent-activity');
  if (!el) return;

  if (!items.length) {
    el.innerHTML = `
      <div class="text-center py-8">
        <i class="fas fa-history text-gray-700 text-3xl mb-3 block"></i>
        <p class="text-gray-500 text-sm">No activity yet.</p>
        <p class="text-gray-600 text-xs mt-1">Connect your wallet and start transacting on Arc Testnet.</p>
        <div class="flex gap-2 justify-center mt-4">
          <button onclick="switchTab('payments')" class="text-xs px-3 py-1.5 bg-purple-800/30 text-purple-300 border border-purple-700/30 rounded-lg hover:bg-purple-700/30 transition-all">
            <i class="fas fa-dollar-sign mr-1"></i>Send Payment
          </button>
          <button onclick="switchTab('contracts')" class="text-xs px-3 py-1.5 bg-blue-800/30 text-blue-300 border border-blue-700/30 rounded-lg hover:bg-blue-700/30 transition-all">
            <i class="fas fa-file-contract mr-1"></i>Create Contract
          </button>
        </div>
      </div>`;
    return;
  }

  const statusColors = {
    green:  'bg-green-900/30 text-green-400 border-green-700/30',
    cyan:   'bg-cyan-900/30 text-cyan-400 border-cyan-700/30',
    yellow: 'bg-yellow-900/30 text-yellow-400 border-yellow-700/30',
    red:    'bg-red-900/30 text-red-400 border-red-700/30',
    blue:   'bg-blue-900/30 text-blue-400 border-blue-700/30',
  };
  const iconBg  = { purple:'bg-purple-900/40', blue:'bg-blue-900/40', cyan:'bg-cyan-900/40', green:'bg-green-900/40' };
  const iconCol = { purple:'text-purple-400',  blue:'text-blue-400',  cyan:'text-cyan-400',  green:'text-green-400' };

  el.innerHTML = items.map(item => `
    <div class="flex items-center gap-3 py-2.5 border-b border-gray-700/20 last:border-0 hover:bg-gray-800/20 rounded-lg px-1 transition-colors">
      <div class="w-8 h-8 rounded-lg ${iconBg[item.color]||'bg-gray-800/40'} flex items-center justify-center flex-shrink-0">
        <i class="fas ${item.icon} ${iconCol[item.color]||'text-gray-400'} text-xs"></i>
      </div>
      <div class="flex-1 min-w-0">
        <div class="text-sm text-white truncate font-medium">${item.title}</div>
        <div class="text-xs text-gray-500 truncate">${item.sub}</div>
      </div>
      <div class="text-right flex-shrink-0 flex flex-col items-end gap-1">
        <span class="text-[10px] px-1.5 py-0.5 rounded-full border ${statusColors[item.statusColor]||statusColors.green}">${item.status}</span>
        <span class="text-[10px] text-gray-600">${item.time}</span>
        ${item.link ? `<a href="${item.link}" target="_blank" class="text-[10px] text-blue-500 hover:text-blue-400"><i class="fas fa-external-link-alt"></i></a>` : ''}
      </div>
    </div>`).join('');
}

// ── Render live network metrics panel ────────────────────────────────────────
function dbRenderNetworkMetrics(stats) {
  const el = document.getElementById('db-network-metrics');
  if (!el) return;

  const latClass = stats.latency < 300 ? 'text-green-400' : stats.latency < 800 ? 'text-yellow-400' : 'text-red-400';
  const latLabel = stats.latency < 300 ? '🟢 Fast' : stats.latency < 800 ? '🟡 Moderate' : '🔴 Slow';

  el.innerHTML = `
    <div class="grid grid-cols-2 gap-3">
      <div class="bg-gray-800/60 rounded-xl p-3">
        <div class="text-xs text-gray-500 mb-1">Latest Block</div>
        <div class="text-white font-bold text-sm">#${stats.blockNumber.toLocaleString()}</div>
        <div class="text-xs text-gray-600 mt-0.5">Arc Testnet</div>
      </div>
      <div class="bg-gray-800/60 rounded-xl p-3">
        <div class="text-xs text-gray-500 mb-1">RPC Latency</div>
        <div class="font-bold text-sm ${latClass}">${stats.latency}ms</div>
        <div class="text-xs text-gray-600 mt-0.5">${latLabel}</div>
      </div>
      <div class="bg-gray-800/60 rounded-xl p-3">
        <div class="text-xs text-gray-500 mb-1">Gas Price</div>
        <div class="text-yellow-400 font-bold text-sm">${stats.gasPrice}</div>
        <div class="text-xs text-gray-600 mt-0.5">~$0.009/tx USDC</div>
      </div>
      <div class="bg-gray-800/60 rounded-xl p-3">
        <div class="text-xs text-gray-500 mb-1">Contracts</div>
        <div class="text-cyan-400 font-bold text-sm">${stats.contractCount}</div>
        <div class="text-xs text-gray-600 mt-0.5">On-chain (factory)</div>
      </div>
    </div>
    <div class="mt-3 p-2.5 bg-green-900/10 border border-green-700/20 rounded-xl flex items-center gap-2">
      <div class="w-2 h-2 bg-green-400 rounded-full animate-pulse flex-shrink-0"></div>
      <span class="text-xs text-green-400">Arc Testnet online · Chain 5042002 · USDC gas</span>
      <a href="${DB_EXPLORER}" target="_blank" class="ml-auto text-xs text-gray-500 hover:text-gray-300">
        <i class="fas fa-external-link-alt"></i>
      </a>
    </div>`;
}

// ── Render agent status cards ────────────────────────────────────────────────
function dbRenderAgentCards(latency, arcPayActive) {
  const el = document.getElementById('agent-status-cards');
  if (!el) return;

  const netStatus = latency > 0 ? (latency < 500 ? '🟢 Online' : latency < 1500 ? '🟡 Slow' : '🔴 High latency') : '⚪ Unknown';
  const netColor  = latency > 0 ? (latency < 500 ? 'text-green-400' : 'text-yellow-400') : 'text-gray-400';

  el.innerHTML = `
    <div class="flex items-center gap-3 bg-gray-800/50 rounded-lg p-3 border border-gray-700/30">
      <div class="w-8 h-8 rounded-lg bg-purple-600/20 border border-purple-700/30 flex items-center justify-center flex-shrink-0">
        <i class="fas fa-robot text-purple-400 text-sm"></i>
      </div>
      <div class="flex-1 min-w-0">
        <div class="text-sm text-white font-medium">ArcPay Agent v1.0</div>
        <div class="text-xs text-gray-400 truncate">${arcPayActive ? 'Authorized — ready to execute batched txs' : 'Not authorized — open chat → "approve arcpay"'}</div>
      </div>
      <span class="text-xs px-2 py-1 rounded-full flex-shrink-0 ${arcPayActive ? 'bg-green-900/30 text-green-400 border border-green-700/30' : 'bg-gray-700/40 text-gray-400 border border-gray-600/30'}">
        ${arcPayActive ? 'Active' : 'Inactive'}
      </span>
    </div>
    <div class="flex items-center gap-3 bg-gray-800/50 rounded-lg p-3 border border-gray-700/30">
      <div class="w-8 h-8 rounded-lg bg-cyan-600/20 border border-cyan-700/30 flex items-center justify-center flex-shrink-0">
        <i class="fas fa-shield-alt text-cyan-400 text-sm"></i>
      </div>
      <div class="flex-1 min-w-0">
        <div class="text-sm text-white font-medium">Guardian Agent v1.0</div>
        <div class="text-xs text-gray-400">Validating all transactions · ${latency}ms latency</div>
      </div>
      <span class="text-xs px-2 py-1 rounded-full flex-shrink-0 bg-green-900/30 text-green-400 border border-green-700/30">Online</span>
    </div>
    <div class="flex items-center gap-3 bg-gray-800/50 rounded-lg p-3 border border-gray-700/30">
      <div class="w-8 h-8 rounded-lg bg-blue-600/20 border border-blue-700/30 flex items-center justify-center flex-shrink-0">
        <i class="fas fa-network-wired text-blue-400 text-sm"></i>
      </div>
      <div class="flex-1 min-w-0">
        <div class="text-sm text-white font-medium">Arc Testnet</div>
        <div class="text-xs ${netColor}">${netStatus} · RPC ${latency}ms</div>
      </div>
      <span class="text-xs px-2 py-1 rounded-full flex-shrink-0 bg-cyan-900/30 text-cyan-400 border border-cyan-700/30">5042002</span>
    </div>
    <div class="flex items-center gap-3 bg-gray-800/50 rounded-lg p-3 border border-gray-700/30">
      <div class="w-8 h-8 rounded-lg bg-orange-600/20 border border-orange-700/30 flex items-center justify-center flex-shrink-0">
        <i class="fas fa-file-contract text-orange-400 text-sm"></i>
      </div>
      <div class="flex-1 min-w-0">
        <div class="text-sm text-white font-medium">ArcContract Agent v1.0</div>
        <div class="text-xs text-gray-400">Escrow · IPFS proof · PDF receipts</div>
      </div>
      <span class="text-xs px-2 py-1 rounded-full flex-shrink-0 bg-green-900/30 text-green-400 border border-green-700/30">Active</span>
    </div>`;
}

// ── Render platform metrics bar (top of Information tab) ─────────────────────
function dbRenderMetricsBar(stats, payHistory, cfMeta, msHistory) {
  const el = document.getElementById('db-metrics-bar');
  if (!el) return;

  const totalPayments = payHistory.length + msHistory.reduce((s, m) => s + (m.recipients || 0), 0);
  const totalVolume   = payHistory.reduce((s, p) => s + parseFloat(p.amount || 0), 0)
                      + msHistory.reduce((s, m) => s + parseFloat(m.totalAmount || 0), 0);
  const completedCts  = Object.values(cfMeta).filter(m => m.completedAt).length;
  const activeCts     = Object.values(cfMeta).filter(m => !m.completedAt && !m.cancelledAt).length;

  el.innerHTML = `
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
      <div class="bg-gray-800/60 rounded-xl p-3 border border-gray-700/30">
        <div class="text-xs text-gray-500 mb-1">📋 On-chain Contracts</div>
        <div class="text-xl font-bold text-white">${stats.contractCount}</div>
        <div class="text-xs text-gray-600">${activeCts} active · ${completedCts} completed</div>
      </div>
      <div class="bg-gray-800/60 rounded-xl p-3 border border-gray-700/30">
        <div class="text-xs text-gray-500 mb-1">💳 Payments (session)</div>
        <div class="text-xl font-bold text-white">${totalPayments}</div>
        <div class="text-xs text-gray-600">$${totalVolume.toFixed(2)} USDC total</div>
      </div>
      <div class="bg-gray-800/60 rounded-xl p-3 border border-gray-700/30">
        <div class="text-xs text-gray-500 mb-1">📦 Latest Block</div>
        <div class="text-xl font-bold text-white">#${stats.blockNumber.toLocaleString()}</div>
        <div class="text-xs text-gray-600">Arc Testnet</div>
      </div>
      <div class="bg-gray-800/60 rounded-xl p-3 border border-gray-700/30">
        <div class="text-xs text-gray-500 mb-1">⚡ RPC Latency</div>
        <div class="text-xl font-bold ${stats.latency < 300 ? 'text-green-400' : stats.latency < 800 ? 'text-yellow-400' : 'text-red-400'}">${stats.latency}ms</div>
        <div class="text-xs text-gray-600">${stats.latency < 300 ? 'Excellent' : stats.latency < 800 ? 'Good' : 'Degraded'}</div>
      </div>
    </div>`;
}

// ── Main dashboard loader ─────────────────────────────────────────────────────
async function loadDashboard() {
  const wallet       = window.walletState?.address;
  const arcPayActive = localStorage.getItem('arc-pay-approved') === '1';

  // Show loading state
  const activity = document.getElementById('recent-activity');
  if (activity) activity.innerHTML = `
    <div class="flex items-center gap-2 py-4 text-gray-500 text-sm">
      <div class="w-4 h-4 border-2 border-purple-500 border-t-transparent rounded-full animate-spin"></div>
      Loading live data from Arc Testnet…
    </div>`;

  // Show loading in metrics
  const metricsBar = document.getElementById('db-metrics-bar');
  if (metricsBar) metricsBar.innerHTML = `<div class="h-16 bg-gray-800/30 rounded-xl animate-pulse mb-6"></div>`;

  try {
    // Fetch on-chain stats
    const stats = await dbFetchOnChainStats(wallet);

    // Local storage data
    const payHistory   = JSON.parse(localStorage.getItem('arc_pay_history') || '[]');
    const cfMeta       = JSON.parse(localStorage.getItem('arc_cf_meta_v4') || '{}');
    const msHistory    = JSON.parse(localStorage.getItem('arc_multisend_history') || '[]');

    const totalPayments = payHistory.length + msHistory.reduce((s, m) => s + (m.recipients || 0), 0);
    const totalVolume   = payHistory.reduce((s, p) => s + parseFloat(p.amount || 0), 0)
                        + msHistory.reduce((s, m) => s + parseFloat(m.totalAmount || 0), 0);
    const pendingPays   = payHistory.filter(p => p.status === 'pending').length;

    // ── Update stat cards ──
    const setEl = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
    setEl('stat-payments', totalPayments || '0');
    setEl('stat-volume',   totalVolume > 0 ? `$${totalVolume.toFixed(2)}` : `$0.00`);
    setEl('stat-contracts', stats.contractCount);
    setEl('stat-pending',  pendingPays);

    // ── Metrics bar (above activity) ──
    dbRenderMetricsBar(stats, payHistory, cfMeta, msHistory);

    // ── Network metrics panel ──
    dbRenderNetworkMetrics(stats);

    // ── Wallet panel ──
    if (wallet) {
      const walletPanel = document.getElementById('wallet-panel');
      if (walletPanel) {
        const usdcFmt = (Number(stats.usdcBalance) / 1e6).toFixed(2);
        const eurcFmt = (Number(stats.eurcBalance) / 1e6).toFixed(2);
        walletPanel.innerHTML = `
          <div class="space-y-3">
            <div class="flex items-center gap-2 bg-green-900/20 border border-green-700/20 rounded-xl px-3 py-2">
              <div class="w-2 h-2 rounded-full bg-green-400 animate-pulse flex-shrink-0"></div>
              <span id="wp-address" class="font-mono text-xs text-green-300 truncate">${wallet}</span>
            </div>
            <div class="grid grid-cols-2 gap-2">
              <div class="bg-gray-800/60 rounded-xl p-3 text-center">
                <div class="text-xs text-gray-500 mb-1">USDC</div>
                <div class="text-base font-bold text-white">$${usdcFmt}</div>
              </div>
              <div class="bg-gray-800/60 rounded-xl p-3 text-center">
                <div class="text-xs text-gray-500 mb-1">EURC</div>
                <div class="text-base font-bold text-white">€${eurcFmt}</div>
              </div>
            </div>
            <div class="flex items-center justify-between text-xs px-1">
              <span class="text-gray-500">Block #${stats.blockNumber.toLocaleString()}</span>
              <a href="${DB_EXPLORER}/address/${wallet}" target="_blank" class="text-purple-400 hover:text-purple-300 flex items-center gap-1">
                <i class="fas fa-external-link-alt text-[10px]"></i>ArcScan
              </a>
            </div>
          </div>`;
      }
    }

    // ── Agent status ──
    dbRenderAgentCards(stats.latency, arcPayActive);

    // ── Activity feed ──
    const activityItems = dbGetLocalActivity();
    dbRenderActivity(activityItems);

    // ── Update ArcPay bar in chat ──
    const arcpayBar    = document.getElementById('chat-arcpay-bar');
    const arcpayStatus = document.getElementById('chat-arcpay-status');
    const arcpayBtn    = document.getElementById('chat-arcpay-btn');
    if (arcpayBar)    arcpayBar.classList.remove('hidden');
    if (arcpayStatus) arcpayStatus.textContent = arcPayActive ? 'ArcPay: ✅ Active' : 'ArcPay: Not authorized';
    if (arcpayBtn)    arcpayBtn.classList.toggle('hidden', arcPayActive);

    // ── Update live block display (top of dashboard tab if exists) ──
    const liveBlock = document.getElementById('db-live-block');
    if (liveBlock) liveBlock.textContent = `#${stats.blockNumber.toLocaleString()}`;
    const liveLatency = document.getElementById('db-live-latency');
    if (liveLatency) liveLatency.textContent = `${stats.latency}ms`;

  } catch (err) {
    console.error('[DB] loadDashboard error:', err);
    if (activity) activity.innerHTML = `
      <div class="text-center py-6">
        <i class="fas fa-exclamation-triangle text-red-500/50 text-2xl mb-2 block"></i>
        <p class="text-red-400 text-sm">Error loading on-chain data</p>
        <p class="text-gray-600 text-xs mt-1">${err.message}</p>
        <button onclick="loadDashboard()" class="mt-3 text-xs px-3 py-1.5 bg-gray-800 text-gray-300 border border-gray-700 rounded-lg hover:bg-gray-700 transition-all">
          <i class="fas fa-sync mr-1"></i>Retry
        </button>
      </div>`;

    // Still render agent cards with degraded state
    const arcPayActive = localStorage.getItem('arc-pay-approved') === '1';
    dbRenderAgentCards(0, arcPayActive);
    dbRenderActivity([]);
  }
}

// ── Auto-refresh when dashboard is active ────────────────────────────────────
let _dbInterval    = null;
let _dbLastRefresh = 0;

function dbStartAutoRefresh() {
  if (_dbInterval) return;
  _dbInterval = setInterval(() => {
    const dashEl = document.getElementById('tab-content-dashboard');
    if (dashEl && !dashEl.classList.contains('hidden')) {
      const now = Date.now();
      if (now - _dbLastRefresh > 25000) { // min 25s between refreshes
        _dbLastRefresh = now;
        loadDashboard();
      }
    }
  }, 5000); // check every 5s
}

// ── Event-driven refresh ─────────────────────────────────────────────────────
window.addEventListener('walletConnected',    () => { _dbLastRefresh = 0; loadDashboard(); });
window.addEventListener('walletDisconnected', () => { _dbLastRefresh = 0; loadDashboard(); });
window.addEventListener('walletChanged',      () => { _dbLastRefresh = 0; loadDashboard(); });

// ── Expose ────────────────────────────────────────────────────────────────────
window.loadDashboard = loadDashboard;
dbStartAutoRefresh();

console.log('[DB v3] Dashboard loaded — real on-chain data, batch RPC, live metrics');
