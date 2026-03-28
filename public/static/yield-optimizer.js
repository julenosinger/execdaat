// ===== YIELD OPTIMIZER MODULE =====
// UI para o Yield Optimizer Agent — pools, posições, rebalanceamento

let yieldState = {
  pools: [],
  positions: [],
  selectedStrategy: 'balanced',
  selectedPool: null,
};

// ─── Load all yield data ──────────────────────────────────────────────────────
async function loadYieldData() {
  await Promise.all([loadYieldPools(), loadYieldPositions(), loadYieldStats()]);
}

// ─── Load Pools ───────────────────────────────────────────────────────────────
async function loadYieldPools() {
  try {
    const res = await (async function() {
   console.log('[fetch] GET', '/api/yield/pools');
   try {
     var _r = await fetch('/api/yield/pools', {method:'GET',headers:{'Content-Type':'application/json'}});
     if (!_r.ok) { var _e = new Error('GET failed: '+_r.status); _e.response={data:await _r.json().catch(function(){return null;}),status:_r.status}; throw _e; }
     var _d = await _r.json().catch(function(){return null;});
     console.log('[fetch] GET OK', '/api/yield/pools', _r.status);
     return {data:_d, status:_r.status};
   } catch(_ex) { console.error('[fetch] GET ERR', '/api/yield/pools', _ex.message); throw _ex; }
 }());
    if (!res.data.success) return;
    yieldState.pools = res.data.pools;
    renderYieldPools(res.data.pools, res.data.bestUsdc, res.data.bestEurc);
  } catch (e) { console.error('Yield pools error:', e); }
}

function renderYieldPools(pools, bestUsdc, bestEurc) {
  const container = document.getElementById('yield-pools-list');
  if (!container) return;

  const usdcPools = pools.filter(p => p.token === 'USDC');
  const eurcPools = pools.filter(p => p.token === 'EURC');

  const renderPool = (p) => {
    const isBest = (p.id === bestUsdc?.id && p.token === 'USDC') || (p.id === bestEurc?.id && p.token === 'EURC');
    const riskColor = { low: 'text-green-400 bg-green-900/30', medium: 'text-yellow-400 bg-yellow-900/30', high: 'text-red-400 bg-red-900/30' }[p.risk];
    const trendIcon = p.trend === 'up' ? '↑' : p.trend === 'down' ? '↓' : '→';
    const trendColor = p.trend === 'up' ? 'text-green-400' : p.trend === 'down' ? 'text-red-400' : 'text-gray-400';
    const tokenIcon = p.token === 'USDC' ? '💵' : '💶';

    return `
      <div class="bg-gray-800/40 border ${isBest ? 'border-purple-500/60 ring-1 ring-purple-500/30' : 'border-gray-700/40'} rounded-xl p-4 cursor-pointer hover:border-gray-600/60 transition-all"
           onclick="selectYieldPool('${p.id}')">
        ${isBest ? '<div class="text-xs text-purple-400 font-semibold mb-2 flex items-center gap-1"><i class="fas fa-star text-yellow-400"></i> BEST YIELD</div>' : ''}
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2">
            <span class="text-lg">${tokenIcon}</span>
            <div>
              <p class="text-white font-semibold text-sm">${p.name}</p>
              <p class="text-xs text-gray-500">${p.protocol}</p>
            </div>
          </div>
          <div class="text-right">
            <div class="text-xl font-bold text-green-400">${p.apy}%</div>
            <div class="text-xs ${trendColor}">${trendIcon} ${Math.abs(p.trendPct)}%</div>
          </div>
        </div>
        <div class="grid grid-cols-3 gap-2 text-xs">
          <div class="bg-black/20 rounded-lg p-2 text-center">
            <p class="text-gray-400">TVL</p>
            <p class="text-white font-mono">${(p.tvl/1000).toFixed(0)}k</p>
          </div>
          <div class="bg-black/20 rounded-lg p-2 text-center">
            <p class="text-gray-400">Utilization</p>
            <p class="text-blue-400 font-mono">${p.utilization.toFixed(0)}%</p>
          </div>
          <div class="bg-black/20 rounded-lg p-2 text-center">
            <p class="text-gray-400">Risk</p>
            <p class="text-xs ${riskColor} font-semibold px-1 py-0.5 rounded">${p.risk.toUpperCase()}</p>
          </div>
        </div>
        ${p.apyRewards > 0 ? `<div class="mt-2 text-xs text-gray-500">Base: ${p.apyBase}% + Rewards: <span class="text-yellow-400">${p.apyRewards}%</span></div>` : ''}
      </div>`;
  };

  container.innerHTML = `
    <div class="mb-4">
      <h4 class="text-sm font-semibold text-blue-400 mb-3 flex items-center gap-2"><span>💵</span> USDC Pools</h4>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">${usdcPools.map(renderPool).join('')}</div>
    </div>
    <div>
      <h4 class="text-sm font-semibold text-yellow-400 mb-3 flex items-center gap-2"><span>💶</span> EURC Pools</h4>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">${eurcPools.map(renderPool).join('')}</div>
    </div>`;
}

function selectYieldPool(poolId) {
  yieldState.selectedPool = poolId;
  document.querySelectorAll('#yield-pools-list [onclick]').forEach(el => {
    el.classList.remove('ring-2', 'ring-blue-400/60');
  });
  const pool = yieldState.pools.find(p => p.id === poolId);
  if (pool) {
    // Show deposit form
    const form = document.getElementById('yield-deposit-form');
    if (form) {
      form.classList.remove('hidden');
      const poolName = document.getElementById('yield-selected-pool-name');
      const poolApy = document.getElementById('yield-selected-pool-apy');
      const poolToken = document.getElementById('yield-deposit-token-label');
      if (poolName) poolName.textContent = pool.name;
      if (poolApy) poolApy.textContent = `${pool.apy}% APY`;
      if (poolToken) poolToken.textContent = pool.token;
    }
  }
}

// ─── Load Positions ───────────────────────────────────────────────────────────
async function loadYieldPositions() {
  const wallet = window.walletState?.address;
  try {
    const url = wallet ? `/api/yield/positions?wallet=${wallet}` : '/api/yield/positions';
    const _yR1 = await fetch(url);
    if (!_yR1.ok) { console.error('Positions error HTTP:', _yR1.status); return; }
    const res = { data: await _yR1.json().catch(() => ({})) };
    if (!res.data.success) return;
    yieldState.positions = res.data.positions;
    renderYieldPositions(res.data.positions);
  } catch (e) { console.error('Positions error:', e); }
}

function renderYieldPositions(positions) {
  const container = document.getElementById('yield-positions-list');
  if (!container) return;

  const active = positions.filter(p => p.status === 'active');
  if (!active.length) {
    container.innerHTML = '<div class="text-center py-6 text-gray-600 text-sm"><i class="fas fa-seedling mr-2"></i>No active positions. Select a pool above to start earning yield.</div>';
    return;
  }

  container.innerHTML = active.map(pos => {
    const tokenIcon = pos.token === 'USDC' ? '💵' : '💶';
    const pnl = pos.currentValue - pos.deposited;
    const pnlColor = pnl >= 0 ? 'text-green-400' : 'text-red-400';
    const stratColors = { conservative: 'bg-blue-900/40 text-blue-300', balanced: 'bg-purple-900/40 text-purple-300', aggressive: 'bg-red-900/40 text-red-300', custom: 'bg-gray-800 text-gray-300' };

    return `
      <div class="bg-gray-800/40 border border-gray-700/40 rounded-xl p-4 hover:border-gray-600/40 transition-all">
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2">
            <span class="text-lg">${tokenIcon}</span>
            <div>
              <p class="text-white font-semibold text-sm">${pos.poolId.replace(/-/g, ' ').toUpperCase()}</p>
              <span class="text-xs px-2 py-0.5 rounded-full ${stratColors[pos.strategy]}">${pos.strategy}</span>
            </div>
          </div>
          <div class="text-right">
            <div class="text-green-400 font-bold">${pos.currentApy}% APY</div>
            <div class="text-xs text-gray-500">${pos.status}</div>
          </div>
        </div>
        <div class="grid grid-cols-3 gap-2 text-xs mb-3">
          <div class="bg-black/20 rounded-lg p-2">
            <p class="text-gray-400">Deposited</p>
            <p class="text-white font-mono">${(pos.deposited/1e6).toFixed(2)} ${pos.token}</p>
          </div>
          <div class="bg-black/20 rounded-lg p-2">
            <p class="text-gray-400">Current Value</p>
            <p class="text-blue-400 font-mono">${(pos.currentValue/1e6).toFixed(4)}</p>
          </div>
          <div class="bg-black/20 rounded-lg p-2">
            <p class="text-gray-400">Yield Earned</p>
            <p class="${pnlColor} font-mono">+${(pos.yieldEarned/1e6).toFixed(6)}</p>
          </div>
        </div>
        <div class="flex gap-2">
          <button onclick="rebalancePosition('${pos.id}')"
            class="flex-1 text-xs bg-purple-900/40 hover:bg-purple-900/60 text-purple-300 border border-purple-700/40 rounded-lg py-1.5 transition-all">
            <i class="fas fa-sync-alt mr-1"></i>Rebalance
          </button>
          <button onclick="closeYieldPosition('${pos.id}')"
            class="flex-1 text-xs bg-gray-800 hover:bg-gray-700 text-gray-400 border border-gray-700 rounded-lg py-1.5 transition-all">
            <i class="fas fa-times mr-1"></i>Close
          </button>
        </div>
      </div>`;
  }).join('');
}

// ─── Load Stats ───────────────────────────────────────────────────────────────
async function loadYieldStats() {
  try {
    const res = await (async function() {
   console.log('[fetch] GET', '/api/yield/status');
   try {
     var _r = await fetch('/api/yield/status', {method:'GET',headers:{'Content-Type':'application/json'}});
     if (!_r.ok) { var _e = new Error('GET failed: '+_r.status); _e.response={data:await _r.json().catch(function(){return null;}),status:_r.status}; throw _e; }
     var _d = await _r.json().catch(function(){return null;});
     console.log('[fetch] GET OK', '/api/yield/status', _r.status);
     return {data:_d, status:_r.status};
   } catch(_ex) { console.error('[fetch] GET ERR', '/api/yield/status', _ex.message); throw _ex; }
 }());
    if (!res.data.success) return;
    const s = res.data.stats;
    setYieldEl('yield-total-positions', s.activePositions);
    setYieldEl('yield-total-deposited', `$${(s.totalDeposited / 1e6).toFixed(2)}`);
    setYieldEl('yield-total-earned', `$${(s.totalYieldEarned / 1e6).toFixed(6)}`);
    setYieldEl('yield-avg-apy', `${s.averageApy}%`);
    setYieldEl('yield-best-apy', `${s.bestApy}%`);
    setYieldEl('yield-rebalances', s.rebalances);
    setYieldEl('yield-agent-status', s.agentStatus.toUpperCase());
  } catch (e) { console.error('Yield stats error:', e); }
}

// ─── Open Position (requires EVM tx) ─────────────────────────────────────────
async function openYieldPosition() {
  if (!window.walletState?.connected) {
    showToast('Connect your wallet to open a yield position', 'error'); return;
  }
  if (!yieldState.selectedPool) {
    showToast('Select a pool first', 'error'); return;
  }

  const amount = parseFloat(document.getElementById('yield-deposit-amount')?.value || '0');
  if (!amount || amount <= 0) { showToast('Enter deposit amount', 'error'); return; }

  const pool = yieldState.pools.find(p => p.id === yieldState.selectedPool);
  if (!pool) { showToast('Pool not found', 'error'); return; }

  const btn = document.getElementById('yield-open-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Signing...'; }

  try {
    // 1. Guardian compliance check
    showToast('🛡️ Running Guardian compliance check...', 'info');
    const gcRes = await (async function() {
   console.log('[fetch] POST', '/api/guardian/check');
   try {
     var _r = await fetch('/api/guardian/check', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      txType: 'vault_deposit', fromAddress: window.walletState.address,
      amount, token: pool.token,
    })});
     if (!_r.ok) { var _e = new Error('POST failed: '+_r.status); _e.response={data:await _r.json().catch(function(){return null;}),status:_r.status}; throw _e; }
     var _d = await _r.json().catch(function(){return null;});
     console.log('[fetch] POST OK', '/api/guardian/check', _r.status);
     return {data:_d, status:_r.status};
   } catch(_ex) { console.error('[fetch] POST ERR', '/api/guardian/check', _ex.message); throw _ex; }
 }());
    if (!gcRes.data.approved) {
      showToast(`🚫 Guardian blocked: ${gcRes.data.check.result.reasons[0]}`, 'error');
      return;
    }

    // 2. EVM transfer token to vault contract
    showToast('📝 Sign the transaction in your wallet...', 'info');
    const result = await evmTransferToken(
      pool.contractAddress,
      amount,
      pool.token,
      `Deposit ${amount} ${pool.token} → ${pool.name}`
    );

    // 3. Register position in optimizer
    const posRes = await (async function() {
   console.log('[fetch] POST', '/api/yield/positions/open');
   try {
     var _r = await fetch('/api/yield/positions/open', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      walletAddress: window.walletState.address,
      poolId: yieldState.selectedPool,
      amount,
      strategy: yieldState.selectedStrategy,
      txHash: result.txHash,
    })});
     if (!_r.ok) { var _e = new Error('POST failed: '+_r.status); _e.response={data:await _r.json().catch(function(){return null;}),status:_r.status}; throw _e; }
     var _d = await _r.json().catch(function(){return null;});
     console.log('[fetch] POST OK', '/api/yield/positions/open', _r.status);
     return {data:_d, status:_r.status};
   } catch(_ex) { console.error('[fetch] POST ERR', '/api/yield/positions/open', _ex.message); throw _ex; }
 }());

    if (posRes.data.success) {
      showTXConfirmationBadge(result.txHash, `Opened yield position: ${amount} ${pool.token} at ${pool.apy}% APY`);
      showToast(`✅ Position opened! Earning ${posRes.data.position.entryApy}% APY`, 'success');
      document.getElementById('yield-deposit-amount').value = '';
      document.getElementById('yield-deposit-form')?.classList.add('hidden');
      await loadYieldData();
    }
  } catch (e) {
    const msg = e.message || 'Failed to open position';
    if (!msg.includes('rejected')) showToast(msg, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-seedling mr-2"></i>Open Position'; }
  }
}

// ─── Rebalance Position ───────────────────────────────────────────────────────
async function rebalancePosition(posId) {
  try {
    showToast('🔄 Analyzing rebalance opportunity...', 'info');
    const _yrR = await fetch(`/api/yield/positions/${posId}/rebalance`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    if (!_yrR.ok) { const _e = new Error('POST failed: ' + _yrR.status); _e.response = { data: await _yrR.json().catch(() => ({})), status: _yrR.status }; throw _e; }
    const res = { data: await _yrR.json().catch(() => ({})) };
    if (res.data.success) {
      const reb = res.data.rebalance;
      if (reb.status === 'executed') {
        showToast(`✅ Rebalanced to ${reb.toPool} (+${reb.expectedGain}% APY)`, 'success');
      } else {
        showToast(`ℹ️ ${reb.reason}`, 'info');
      }
      await loadYieldData();
    }
  } catch (e) {
    showToast(e.response?.data?.error || 'Rebalance failed', 'error');
  }
}

// ─── Close Position (requires EVM tx) ────────────────────────────────────────
async function closeYieldPosition(posId) {
  if (!window.walletState?.connected) {
    showToast('Connect wallet to close position', 'error'); return;
  }

  const pos = yieldState.positions.find(p => p.id === posId);
  if (!pos) return;

  try {
    const result = await evmTransferToken(
      window.walletState.address,
      pos.currentValue / 1e6,
      pos.token,
      `Withdraw from ${pos.poolId}`
    );

    const res = await (async function() {
   console.log('[fetch] POST', `/api/yield/positions/${posId}/close`);
   try {
     var _r = await fetch(`/api/yield/positions/${posId}/close`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ txHash: result.txHash })});
     if (!_r.ok) { var _e = new Error('POST failed: '+_r.status); _e.response={data:await _r.json().catch(function(){return null;}),status:_r.status}; throw _e; }
     var _d = await _r.json().catch(function(){return null;});
     console.log('[fetch] POST OK', `/api/yield/positions/${posId}/close`, _r.status);
     return {data:_d, status:_r.status};
   } catch(_ex) { console.error('[fetch] POST ERR', `/api/yield/positions/${posId}/close`, _ex.message); throw _ex; }
 }());
    if (res.data.success) {
      showTXConfirmationBadge(result.txHash, `Closed position — received ${res.data.totalReceived} ${pos.token}`);
      showToast(`✅ Position closed. Yield earned: ${res.data.yieldEarned} ${pos.token}`, 'success');
      await loadYieldData();
    }
  } catch (e) {
    if (!e.message?.includes('rejected')) showToast(e.message || 'Close failed', 'error');
  }
}

// ─── Load Projections ─────────────────────────────────────────────────────────
async function loadYieldProjection() {
  const amount = parseFloat(document.getElementById('yield-proj-amount')?.value || '1000');
  const token = document.getElementById('yield-proj-token')?.value || 'USDC';
  const strategy = yieldState.selectedStrategy;

  try {
    const res = await (async function() {
   console.log('[fetch] GET', `/api/yield/project?amount=${amount}&token=${token}&strategy=${strategy}`);
   try {
     var _r = await fetch(`/api/yield/project?amount=${amount}&token=${token}&strategy=${strategy}`, {method:'GET',headers:{'Content-Type':'application/json'}});
     if (!_r.ok) { var _e = new Error('GET failed: '+_r.status); _e.response={data:await _r.json().catch(function(){return null;}),status:_r.status}; throw _e; }
     var _d = await _r.json().catch(function(){return null;});
     console.log('[fetch] GET OK', `/api/yield/project?amount=${amount}&token=${token}&strategy=${strategy}`, _r.status);
     return {data:_d, status:_r.status};
   } catch(_ex) { console.error('[fetch] GET ERR', `/api/yield/project?amount=${amount}&token=${token}&strategy=${strategy}`, _ex.message); throw _ex; }
 }());
    if (!res.data.success) return;

    const container = document.getElementById('yield-projections');
    if (!container) return;

    const p = res.data.projections;
    const pool = res.data.bestPool;

    container.innerHTML = `
      <div class="mb-3">
        <p class="text-xs text-gray-400 mb-1">Best pool: <span class="text-purple-400">${pool?.name || '—'}</span> at <span class="text-green-400 font-bold">${res.data.apy}% APY</span></p>
      </div>
      <div class="grid grid-cols-3 gap-2 text-xs">
        ${[['7d', p['7d']], ['30d', p['30d']], ['90d', p['90d']], ['180d', p['180d']], ['365d', p['365d']]].map(([period, v]) => `
          <div class="bg-gray-800/60 rounded-xl p-3 text-center">
            <p class="text-gray-400">${period}</p>
            <p class="text-white font-mono text-sm">${v.value.toFixed(2)}</p>
            <p class="text-green-400 text-xs">+${v.yield.toFixed(4)}</p>
          </div>`).join('')}
      </div>`;
  } catch (e) { console.error('Projection error:', e); }
}

function setYieldEl(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// ─── Window hook ──────────────────────────────────────────────────────────────
window.loadYieldOptimizerData = loadYieldData;

// ─── Wrapper functions para os novos IDs no HTML (aba AI Agents) ──────────────

// Chamada quando entra na aba Agents — carrega pools e atualiza stats
window.loadYieldData = loadYieldData;

// Load Yield Stats for the agent card
async function loadYieldStats() {
  try {
    const res = await (async function() {
   console.log('[fetch] GET', '/api/yield/status');
   try {
     var _r = await fetch('/api/yield/status', {method:'GET',headers:{'Content-Type':'application/json'}});
     if (!_r.ok) { var _e = new Error('GET failed: '+_r.status); _e.response={data:await _r.json().catch(function(){return null;}),status:_r.status}; throw _e; }
     var _d = await _r.json().catch(function(){return null;});
     console.log('[fetch] GET OK', '/api/yield/status', _r.status);
     return {data:_d, status:_r.status};
   } catch(_ex) { console.error('[fetch] GET ERR', '/api/yield/status', _ex.message); throw _ex; }
 }());
    if (!res.data.success) return;
    const stats = res.data.stats;
    setYieldEl('yield-best-apy', `${stats.bestApy ?? '--'}%`);
    setYieldEl('yield-total-pools', stats.totalPools ?? '--');
    setYieldEl('yield-positions', stats.activePositions ?? 0);
    setYieldEl('yield-rebalances', stats.totalRebalances ?? 0);
  } catch (e) { console.error('Yield stats error:', e); }
}

// Calculate & display yield projection in the agent card
window.calcYieldProjection = async function() {
  const amount = parseFloat(document.getElementById('yield-proj-amount')?.value || '1000');
  const token = document.getElementById('yield-proj-token')?.value || 'USDC';
  const resultDiv = document.getElementById('yield-projection-result');
  if (!resultDiv || !amount) return;

  resultDiv.textContent = 'Calculating...';
  try {
    const res = await (async function() {
   console.log('[fetch] GET', `/api/yield/project?amount=${amount}&token=${token}&strategy=balanced`);
   try {
     var _r = await fetch(`/api/yield/project?amount=${amount}&token=${token}&strategy=balanced`, {method:'GET',headers:{'Content-Type':'application/json'}});
     if (!_r.ok) { var _e = new Error('GET failed: '+_r.status); _e.response={data:await _r.json().catch(function(){return null;}),status:_r.status}; throw _e; }
     var _d = await _r.json().catch(function(){return null;});
     console.log('[fetch] GET OK', `/api/yield/project?amount=${amount}&token=${token}&strategy=balanced`, _r.status);
     return {data:_d, status:_r.status};
   } catch(_ex) { console.error('[fetch] GET ERR', `/api/yield/project?amount=${amount}&token=${token}&strategy=balanced`, _ex.message); throw _ex; }
 }());
    if (res.data.success) {
      const p = res.data.projections;
      const apy = res.data.apy;
      resultDiv.innerHTML = `
        <div class="bg-gray-700/40 rounded-xl p-3">
          <p class="text-green-400 font-semibold text-sm mb-2">${amount.toLocaleString()} ${token} @ ${apy}% APY</p>
          <div class="grid grid-cols-3 gap-1 text-xs">
            <div class="text-center"><p class="text-gray-400">30d</p><p class="text-white font-mono">${p['30d'].value.toFixed(2)}</p><p class="text-green-400">+${p['30d'].yield.toFixed(2)}</p></div>
            <div class="text-center"><p class="text-gray-400">90d</p><p class="text-white font-mono">${p['90d'].value.toFixed(2)}</p><p class="text-green-400">+${p['90d'].yield.toFixed(2)}</p></div>
            <div class="text-center"><p class="text-gray-400">365d</p><p class="text-white font-mono">${p['365d'].value.toFixed(2)}</p><p class="text-green-400">+${p['365d'].yield.toFixed(2)}</p></div>
          </div>
        </div>`;
    }
  } catch (e) { resultDiv.textContent = 'Projection failed'; }
};

// Populate the pool selector and load stats for agent card
async function populateYieldPoolSelector() {
  try {
    const res = await (async function() {
   console.log('[fetch] GET', '/api/yield/pools');
   try {
     var _r = await fetch('/api/yield/pools', {method:'GET',headers:{'Content-Type':'application/json'}});
     if (!_r.ok) { var _e = new Error('GET failed: '+_r.status); _e.response={data:await _r.json().catch(function(){return null;}),status:_r.status}; throw _e; }
     var _d = await _r.json().catch(function(){return null;});
     console.log('[fetch] GET OK', '/api/yield/pools', _r.status);
     return {data:_d, status:_r.status};
   } catch(_ex) { console.error('[fetch] GET ERR', '/api/yield/pools', _ex.message); throw _ex; }
 }());
    if (!res.data.success) return;
    const sel = document.getElementById('yield-open-pool');
    if (sel && res.data.pools) {
      sel.innerHTML = '<option value="">Select pool...</option>' +
        res.data.pools.map(p => `<option value="${p.id}">${p.name} — ${p.apy}% APY (${p.token})</option>`).join('');
    }
  } catch (e) {}
}

// Open yield position — called from the agent card
window.openYieldPosition = async function() {
  const poolId = document.getElementById('yield-open-pool')?.value;
  const amountStr = document.getElementById('yield-open-amount')?.value;
  const resultDiv = document.getElementById('yield-open-result');

  if (!poolId) { if (window.showToast) showToast('Select a pool', 'error'); return; }
  const amount = parseFloat(amountStr || '0');
  if (!amount || amount <= 0) { if (window.showToast) showToast('Enter valid amount', 'error'); return; }

  if (resultDiv) {
    resultDiv.classList.remove('hidden');
    resultDiv.innerHTML = '<div class="text-center py-3 text-green-400 text-sm"><i class="fas fa-spinner fa-spin mr-2"></i>Processing...</div>';
  }

  try {
    // Guardian compliance check first
    let guardianOk = true;
    if (window.walletState?.address) {
      try {
        const gcRes = await (async function() {
   console.log('[fetch] POST', '/api/guardian/check');
   try {
     var _r = await fetch('/api/guardian/check', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
          txType: 'vault_deposit',
          fromAddress: window.walletState.address,
          amount, token: 'USDC',
        })});
     if (!_r.ok) { var _e = new Error('POST failed: '+_r.status); _e.response={data:await _r.json().catch(function(){return null;}),status:_r.status}; throw _e; }
     var _d = await _r.json().catch(function(){return null;});
     console.log('[fetch] POST OK', '/api/guardian/check', _r.status);
     return {data:_d, status:_r.status};
   } catch(_ex) { console.error('[fetch] POST ERR', '/api/guardian/check', _ex.message); throw _ex; }
 }());
        guardianOk = gcRes.data.approved;
        if (!guardianOk && resultDiv) {
          resultDiv.innerHTML = `<div class="bg-red-900/20 border border-red-700/40 rounded-xl p-3 text-xs text-red-400">🚫 Guardian blocked: ${gcRes.data.check?.result?.reasons[0] || 'Compliance check failed'}</div>`;
          return;
        }
      } catch(e) { /* non-critical */ }
    }

    // EVM signature if wallet connected
    let txHash = `0xdemo_${Date.now().toString(16)}`;
    if (window.walletState?.connected && window.evmTransferToken) {
      try {
        if (resultDiv) resultDiv.innerHTML = '<div class="text-center py-3 text-yellow-400 text-sm"><i class="fas fa-pen-fancy mr-2"></i>Sign transaction in wallet...</div>';
        // Get pool token
        const poolsRes = await (async function() {
   console.log('[fetch] GET', '/api/yield/pools');
   try {
     var _r = await fetch('/api/yield/pools', {method:'GET',headers:{'Content-Type':'application/json'}});
     if (!_r.ok) { var _e = new Error('GET failed: '+_r.status); _e.response={data:await _r.json().catch(function(){return null;}),status:_r.status}; throw _e; }
     var _d = await _r.json().catch(function(){return null;});
     console.log('[fetch] GET OK', '/api/yield/pools', _r.status);
     return {data:_d, status:_r.status};
   } catch(_ex) { console.error('[fetch] GET ERR', '/api/yield/pools', _ex.message); throw _ex; }
 }());
        const pool = poolsRes.data.pools?.find(p => p.id === poolId);
        const token = pool?.token || 'USDC';
        const result = await evmTransferToken(pool?.contractAddress || USDC_ADDRESS, amount, token, `Deposit ${amount} ${token} → yield pool`);
        txHash = result.txHash;
      } catch (e) {
        if (e.message?.includes('rejected')) {
          if (resultDiv) resultDiv.innerHTML = '<div class="bg-yellow-900/20 border border-yellow-700/40 rounded-xl p-3 text-xs text-yellow-400">⚠️ Transaction rejected by user</div>';
          return;
        }
      }
    }

    // Register position
    const posRes = await (async function() {
   console.log('[fetch] POST', '/api/yield/positions/open');
   try {
     var _r = await fetch('/api/yield/positions/open', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      walletAddress: window.walletState?.address || '0x0000000000000000000000000000000000000000',
      poolId, amount, strategy: 'balanced', txHash,
    })});
     if (!_r.ok) { var _e = new Error('POST failed: '+_r.status); _e.response={data:await _r.json().catch(function(){return null;}),status:_r.status}; throw _e; }
     var _d = await _r.json().catch(function(){return null;});
     console.log('[fetch] POST OK', '/api/yield/positions/open', _r.status);
     return {data:_d, status:_r.status};
   } catch(_ex) { console.error('[fetch] POST ERR', '/api/yield/positions/open', _ex.message); throw _ex; }
 }());

    if (posRes.data.success && resultDiv) {
      const pos = posRes.data.position;
      resultDiv.innerHTML = `
        <div class="bg-green-900/20 border border-green-700/40 rounded-xl p-3">
          <p class="text-green-400 text-sm font-semibold"><i class="fas fa-check-circle mr-2"></i>Position Opened!</p>
          <p class="text-xs text-gray-300 mt-1">Amount: <strong>${amount}</strong> | APY: <strong class="text-green-400">${pos.entryApy}%</strong></p>
          <a href="https://testnet.arcscan.app/tx/${txHash}" target="_blank" class="text-xs text-purple-400 hover:text-purple-300 mt-1 block">
            <i class="fas fa-external-link-alt mr-1"></i>View on Explorer
          </a>
        </div>`;
      if (window.showToast) showToast(`✅ Position opened at ${pos.entryApy}% APY`, 'success');
      // Refresh
      loadYieldStats();
      loadYieldPositionsForCard();
    }
  } catch (e) {
    if (resultDiv) resultDiv.innerHTML = `<div class="text-red-400 text-xs p-3 bg-red-900/20 rounded-xl">Error: ${e.response?.data?.error || e.message}</div>`;
  }
};

// Load positions for the agent card
window.loadYieldPositions = async function() {
  await loadYieldPositionsForCard();
};

async function loadYieldPositionsForCard() {
  const container = document.getElementById('yield-positions-list');
  if (!container) return;
  try {
    const wallet = window.walletState?.address;
    const url = wallet ? `/api/yield/positions?wallet=${wallet}` : '/api/yield/positions';
    const _ypR = await fetch(url);
    if (!_ypR.ok) { container.innerHTML = '<div class="text-center text-gray-600 text-xs py-3">Failed to load positions.</div>'; return; }
    const res = { data: await _ypR.json().catch(() => ({})) };
    if (!res.data.positions?.length) {
      container.innerHTML = '<div class="text-center text-gray-600 text-xs py-3">No open positions. Open one above.</div>';
      setYieldEl('yield-positions', '0');
      return;
    }
    setYieldEl('yield-positions', res.data.positions.length);
    container.innerHTML = res.data.positions.map(p => {
      const pnlColor = p.yieldEarned >= 0 ? 'text-green-400' : 'text-red-400';
      const pnl = (p.yieldEarned / 1e6).toFixed(4);
      return `
        <div class="bg-gray-800/40 border border-gray-700/30 rounded-xl p-3 flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-green-900/40 flex items-center justify-center flex-shrink-0">
            <span class="text-xs">${p.token === 'USDC' ? '💵' : '💶'}</span>
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-white text-xs font-semibold truncate">${p.poolId}</p>
            <p class="text-gray-400 text-xs">${(p.deposited/1e6).toFixed(2)} ${p.token} @ ${p.entryApy}% APY</p>
          </div>
          <div class="text-right flex-shrink-0">
            <p class="${pnlColor} text-xs font-mono">+${pnl}</p>
            <button onclick="rebalancePosition('${p.id}')" class="text-xs text-blue-400 hover:text-blue-300">Rebalance</button>
          </div>
        </div>`;
    }).join('');
  } catch (e) { console.error('Positions card error:', e); }
}

// Override window.loadYieldData to also update the agent card
const _origLoadYieldData = window.loadYieldOptimizerData || loadYieldData;
window.loadYieldData = async function() {
  await loadYieldStats();
  await populateYieldPoolSelector();
  await loadYieldPositionsForCard();
};

// Init on wallet connect
window.addEventListener('walletConnected', (e) => {
  loadYieldStats();
  loadYieldPositionsForCard();
  const amtEl = document.getElementById('yield-open-amount');
  // Prefill amount if empty
});
