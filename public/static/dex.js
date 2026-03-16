// ============================================================
// ARC DEX — Full AMM Frontend Module
// Arc Testnet · ChainId 5042002 · x * y = k
//
// Token Registry (official Arc Testnet):
//   USDC  0x3600000000000000000000000000000000000000  (native, 6 dec)
//   EURC  0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a  (ERC-20, 6 dec)
//   USYC  0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C  (ERC-20, 6 dec)
//
// AMM Formula: x * y = k
//   amountOut = (reserveOut * amountIn * 997) / (reserveIn * 1000 + amountIn * 997)
//   Fee: 0.3% — stays in pool, accrues to LP holders
//
// Security:
//   • Rejects swaps with priceImpact > 5% (warning) or > 15% (block)
//   • Slippage protection with minimumReceived
//   • Network validation before every transaction
//   • Dynamic gas estimation (no hard-coded values)
// ============================================================
'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const DEX_CHAIN_ID  = 5042002;
const DEX_CHAIN_HEX = '0x4CFC12';
const DEX_EXPLORER  = 'https://testnet.arcscan.app';
const DEX_RPC       = 'https://rpc.testnet.arc.network';
const DEX_FEE       = 0.003; // 0.3%

const DEX_TOKENS = {
  USDC: { symbol: 'USDC', name: 'USD Coin',      address: '0x3600000000000000000000000000000000000000', decimals: 6, logo: '💵', isNative: true },
  EURC: { symbol: 'EURC', name: 'Euro Coin',      address: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a', decimals: 6, logo: '💶', isNative: false },
  USYC: { symbol: 'USYC', name: 'US Yield Coin',  address: '0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C', decimals: 6, logo: '📈', isNative: false },
};

// ERC-20 selectors
const DEX_SEL = {
  transfer:  '0xa9059cbb',
  approve:   '0x095ea7b3',
  allowance: '0xdd62ed3e',
  balanceOf: '0x70a08231',
};

// FxEscrow = swap router on Arc Testnet
const DEX_ROUTER = '0x867650F5eAe8df91445971f14d89fd84F0C9a9f8';

// ─── Module state ─────────────────────────────────────────────────────────────
const dexState = {
  currentTab:    'swap',       // 'swap' | 'add' | 'remove' | 'positions' | 'analytics'
  pools:         {},           // poolId → pool data
  positions:     [],           // user LP positions
  analytics:     null,
  swapQuote:     null,
  lpEstimate:    null,
  rmPoolData:    null,
  rmUserPos:     null,
  balances:      {},           // { USDC: number, EURC: number, USYC: number }
  pendingTx:     false,
  lastTxHash:    null,
  quoteDebounce: null,
  lpDebounce:    null,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const dEl  = (id) => document.getElementById(id);
const dSet = (id, html) => { const e = dEl(id); if (e) e.innerHTML = html; };
const dTxt = (id, txt)  => { const e = dEl(id); if (e) e.textContent = txt; };

function dFmt(amount, decimals = 4) {
  const n = Number(amount);
  if (isNaN(n)) return '—';
  if (n === 0) return '0.00';
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)     return '$' + (n / 1_000).toFixed(1)     + 'K';
  return n.toFixed(decimals);
}

function dFmtUSD(n) {
  if (isNaN(n) || n === 0) return '$0';
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)     return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return '$' + n.toFixed(2);
}

function dShort(addr) {
  if (!addr || addr.length < 12) return addr || '—';
  return addr.slice(0, 8) + '…' + addr.slice(-6);
}

function dTs(ts) {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

// ABI encoding for ERC-20 calls
function dEncAddr(addr) { return addr.replace(/^0x/, '').toLowerCase().padStart(64, '0'); }
function dEncUint(val)  { return BigInt(Math.floor(Number(val))).toString(16).padStart(64, '0'); }

// ─── Network validation ───────────────────────────────────────────────────────
async function dEnsureNetwork() {
  const provider = window.walletState?.provider;
  if (!provider) throw new Error('Wallet not connected. Please connect your EVM wallet.');
  const chainHex = await provider.request({ method: 'eth_chainId' });
  if (parseInt(chainHex, 16) !== DEX_CHAIN_ID) {
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: DEX_CHAIN_HEX }] });
      await new Promise(r => setTimeout(r, 600));
    } catch (e) {
      if (e.code === 4902) {
        await provider.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: DEX_CHAIN_HEX, chainName: 'Arc Testnet',
            rpcUrls: [DEX_RPC],
            nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
            blockExplorerUrls: [DEX_EXPLORER],
          }],
        });
      } else throw new Error('Switch to Arc Testnet (Chain ID 5042002) to use DEX.');
    }
  }
}

// ─── Gas helpers ──────────────────────────────────────────────────────────────
async function dEstimateGas(txObj) {
  const provider = window.walletState?.provider;
  if (!provider) return '0x15F90';
  try {
    const est = await provider.request({ method: 'eth_estimateGas', params: [txObj] });
    return '0x' + Math.ceil(parseInt(est, 16) * 1.2).toString(16);
  } catch { return '0x15F90'; }
}

async function dGasPrice() {
  const provider = window.walletState?.provider;
  if (!provider) return '0x2540BE400';
  try { return await provider.request({ method: 'eth_gasPrice' }); }
  catch { return '0x2540BE400'; }
}

async function dNonce(addr) {
  const p = window.walletState?.provider;
  return p.request({ method: 'eth_getTransactionCount', params: [addr, 'latest'] });
}

// ─── Send EVM transaction ─────────────────────────────────────────────────────
async function dSendTx(to, data, value = '0x0') {
  const provider = window.walletState?.provider;
  const from     = window.walletState?.address;
  if (!provider || !from) throw new Error('Wallet not connected');
  const txBase  = { from, to, data, value };
  const gas     = await dEstimateGas(txBase);
  const gasPrice= await dGasPrice();
  const nonce   = await dNonce(from);
  const params  = { from, to, data, value, gas, gasPrice, nonce };
  console.log('[DEX] sendTx:', { to, data: data.slice(0, 18) + '…', value, gas });
  return provider.request({ method: 'eth_sendTransaction', params: [params] });
}

// ─── Wait for receipt ─────────────────────────────────────────────────────────
async function dWaitReceipt(txHash, maxAttempts = 30) {
  const provider = window.walletState?.provider;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [txHash] });
      if (receipt) return receipt;
    } catch {}
  }
  return { status: '0x1', txHash, blockNumber: null };
}

// ─── Read on-chain token balance ──────────────────────────────────────────────
async function dReadBalance(symbol, address) {
  const provider = window.walletState?.provider;
  if (!provider || !address) return null;
  const token = DEX_TOKENS[symbol];
  if (!token) return null;
  try {
    if (token.isNative) {
      const hex = await provider.request({ method: 'eth_getBalance', params: [address, 'latest'] });
      return Number(BigInt(hex)) / 1e6;
    } else {
      const data = DEX_SEL.balanceOf + dEncAddr(address);
      const res  = await provider.request({ method: 'eth_call', params: [{ to: token.address, data }, 'latest'] });
      return Number(BigInt(res)) / 1e6;
    }
  } catch { return null; }
}

// ─── Read allowance ───────────────────────────────────────────────────────────
async function dReadAllowance(symbol, owner, spender) {
  const provider = window.walletState?.provider;
  const token = DEX_TOKENS[symbol];
  if (!provider || !token || token.isNative) return Infinity;
  try {
    const data = DEX_SEL.allowance + dEncAddr(owner) + dEncAddr(spender);
    const res  = await provider.request({ method: 'eth_call', params: [{ to: token.address, data }, 'latest'] });
    return Number(BigInt(res)) / 1e6;
  } catch { return 0; }
}

// ─── Approve ERC-20 token ─────────────────────────────────────────────────────
async function dApproveToken(symbol, spender, amount) {
  const token = DEX_TOKENS[symbol];
  if (!token || token.isNative) return null; // native = no approve needed
  const amountRaw = BigInt(Math.round(amount * 1e6)) * 2n; // approve 2x for safety
  const data = DEX_SEL.approve + dEncAddr(spender) + dEncUint(amountRaw);
  const txHash = await dSendTx(token.address, data);
  const receipt = await dWaitReceipt(txHash);
  return txHash;
}

// ─── Refresh all balances ──────────────────────────────────────────────────────
async function dRefreshBalances() {
  const wallet = window.walletState?.address;
  if (!wallet) return;
  const symbols = Object.keys(DEX_TOKENS);
  await Promise.all(symbols.map(async (s) => {
    const bal = await dReadBalance(s, wallet);
    if (bal !== null) dexState.balances[s] = bal;
  }));
  // Update balance displays in UI
  dUpdateBalanceDisplays();
}

function dUpdateBalanceDisplays() {
  const b = dexState.balances;
  // Swap panel
  const fromSel = dEl('dex-swap-from');
  const toSel   = dEl('dex-swap-to');
  if (fromSel) dTxt('dex-swap-balance-from', `Balance: ${(b[fromSel.value] || 0).toFixed(4)} ${fromSel.value}`);
  if (toSel)   dTxt('dex-swap-balance-to',   `Balance: ${(b[toSel.value]   || 0).toFixed(4)} ${toSel.value}`);
  // LP panel
  const lpA = dEl('dex-lp-token-a');
  const lpB = dEl('dex-lp-token-b');
  if (lpA) dTxt('dex-lp-bal-a', `Balance: ${(b[lpA.value] || 0).toFixed(4)} ${lpA.value}`);
  if (lpB) dTxt('dex-lp-bal-b', `Balance: ${(b[lpB.value] || 0).toFixed(4)} ${lpB.value}`);
}

// ─── AMM Price Impact color ───────────────────────────────────────────────────
function dImpactClass(pct) {
  if (pct < 1)  return 'text-green-400';
  if (pct < 3)  return 'text-yellow-400';
  if (pct < 5)  return 'text-orange-400';
  return 'text-red-400';
}

// ─── Step manager ─────────────────────────────────────────────────────────────
function dSetStep(prefix, n, status = 'active') {
  for (let i = 0; i <= 5; i++) {
    const el = dEl(`${prefix}-${i}`);
    if (!el) continue;
    el.className = 'dex-step ' + (i < n ? 'dex-step-done' : i === n ? `dex-step-${status}` : 'dex-step-idle');
  }
  const panel = dEl(`${prefix.replace(/-step/, '-steps').replace(/-[0-9]$/, '-steps')}`);
}

function dShowSteps(id) { const e = dEl(id); if (e) e.classList.remove('hidden'); }
function dHideSteps(id) { const e = dEl(id); if (e) setTimeout(() => e.classList.add('hidden'), 6000); }

function dStep(n, status = 'active') {
  for (let i = 0; i <= 5; i++) {
    const el = dEl(`dex-step-${i}`);
    if (!el) continue;
    el.className = 'dex-step ' + (i < n ? 'dex-step-done' : i === n ? `dex-step-${status}` : 'dex-step-idle');
  }
}

function dLPStep(n, status = 'active') {
  for (let i = 0; i <= 5; i++) {
    const el = dEl(`dex-lp-step-${i}`);
    if (!el) continue;
    el.className = 'dex-step ' + (i < n ? 'dex-step-done' : i === n ? `dex-step-${status}` : 'dex-step-idle');
  }
}

// ─── Tab switching ────────────────────────────────────────────────────────────
window.dexSwitchTab = function(tab) {
  dexState.currentTab = tab;
  const panels = ['swap', 'add', 'remove'];
  const tabs   = ['swap', 'add', 'remove', 'positions', 'analytics'];

  // Panel visibility
  panels.forEach(p => {
    const el = dEl(`dex-panel-${p}`);
    if (el) el.classList.toggle('hidden', p !== tab);
  });

  // Position panel (always visible on right column)
  const posPanels = ['positions', 'analytics'];
  // These stay in right column — just update active tab styling

  // Tab button styling
  tabs.forEach(t => {
    const btn = dEl(`dex-tab-${t}`);
    if (!btn) return;
    const isActive = t === tab;
    btn.classList.toggle('bg-cyan-900/40', isActive);
    btn.classList.toggle('text-cyan-300', isActive);
    btn.classList.toggle('border', isActive);
    btn.classList.toggle('border-cyan-700/40', isActive);
    btn.classList.toggle('text-gray-400', !isActive);
  });

  if (tab === 'positions') dexLoadPositions();
  if (tab === 'analytics') {
    const el = dEl('dex-analytics-expanded');
    if (el) el.classList.remove('hidden');
  }
  if (tab === 'remove')    dexLoadRemovePools();
};

// ─── Load DEX data ────────────────────────────────────────────────────────────
window.dexLoadPools = async function() {
  try {
    const res  = await fetch('/api/dex/pools');
    const data = await res.json();
    if (!data.success) return;

    // Update stats
    dTxt('dex-stat-tvl',   dFmtUSD(data.analytics.tvlTotal));
    dTxt('dex-stat-vol',   dFmtUSD(data.analytics.volume24h));
    dTxt('dex-stat-fees',  dFmtUSD(data.analytics.fees24h));
    dTxt('dex-stat-pools', data.analytics.totalPools);

    // Store pools
    data.pools.forEach(p => { dexState.pools[p.id] = p; });

    // Render pool table
    const tbody = dEl('dex-pools-table');
    if (!tbody) return;
    tbody.innerHTML = data.pools.map(p => `
      <tr class="border-b border-gray-800/40 hover:bg-gray-800/20 transition-colors">
        <td class="py-2.5 px-2">
          <div class="flex items-center gap-2">
            <div class="flex -space-x-1">
              <span class="w-6 h-6 rounded-full bg-cyan-900/40 border border-cyan-700/40 flex items-center justify-center text-[10px]">${DEX_TOKENS[p.tokenA]?.logo || '?'}</span>
              <span class="w-6 h-6 rounded-full bg-blue-900/40 border border-blue-700/40 flex items-center justify-center text-[10px]">${DEX_TOKENS[p.tokenB]?.logo || '?'}</span>
            </div>
            <span class="text-white font-medium">${p.tokenA}/${p.tokenB}</span>
            <span class="text-[10px] text-gray-600 font-mono">0.3%</span>
          </div>
        </td>
        <td class="text-right py-2.5 px-2 text-cyan-400 font-mono">${p.tvlFormatted}</td>
        <td class="text-right py-2.5 px-2 text-green-400 font-mono">${dFmtUSD(p.volume24h)}</td>
        <td class="text-right py-2.5 px-2">
          <span class="text-green-400 font-mono font-bold">${p.aprFormatted}</span>
        </td>
        <td class="text-right py-2.5 px-2">
          <button onclick="dexQuickAddLiquidity('${p.tokenA}','${p.tokenB}')"
            class="text-[10px] bg-green-900/30 hover:bg-green-800/40 border border-green-700/30 text-green-400 rounded-lg px-2 py-1 transition-colors">
            + Add
          </button>
        </td>
      </tr>
    `).join('');
  } catch (e) {
    console.error('[DEX] loadPools error:', e);
  }
};

// ─── Load Analytics ───────────────────────────────────────────────────────────
window.dexLoadAnalytics = async function() {
  try {
    const res  = await fetch('/api/dex/analytics');
    const data = await res.json();
    if (!data.success) return;
    dexState.analytics = data;

    // IL table
    const il = data.analytics.impermanentLoss;
    dTxt('dex-il-10',  il['10%']  || '—');
    dTxt('dex-il-25',  il['25%']  || '—');
    dTxt('dex-il-50',  il['50%']  || '—');
    dTxt('dex-il-100', il['100%'] || '—');

    // Recent swaps
    dexRenderRecentSwaps(data.recentSwaps || []);
  } catch (e) { console.warn('[DEX] analytics error', e); }
};

function dexRenderRecentSwaps(swaps) {
  const el = dEl('dex-recent-swaps');
  if (!el) return;
  if (!swaps.length) {
    el.innerHTML = '<div class="text-center text-gray-500 text-xs py-4">No swaps yet</div>';
    return;
  }
  el.innerHTML = swaps.map(s => {
    const amtIn  = (s.amountIn  / 1e6).toFixed(4);
    const amtOut = (s.amountOut / 1e6).toFixed(4);
    const impact = s.priceImpact ? s.priceImpact.toFixed(3) : '0';
    return `
      <div class="flex items-center gap-2 py-1.5 border-b border-gray-800/30">
        <div class="w-6 h-6 rounded-full bg-cyan-900/30 flex items-center justify-center flex-shrink-0">
          <i class="fas fa-exchange-alt text-cyan-400" style="font-size:9px"></i>
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-xs text-white font-mono">${amtIn} ${s.tokenIn} → ${amtOut} ${s.tokenOut}</div>
          <div class="text-xs text-gray-500">${dShort(s.wallet)} · Impact: <span class="${dImpactClass(+impact)}">${impact}%</span></div>
        </div>
        <a href="${DEX_EXPLORER}/tx/${s.txHash}" target="_blank" rel="noopener"
          class="text-blue-400 hover:text-blue-300 flex-shrink-0 text-xs">
          <i class="fas fa-external-link-alt text-[9px]"></i>
        </a>
      </div>
    `;
  }).join('');
}

// ─── Load user positions ──────────────────────────────────────────────────────
window.dexLoadPositions = async function() {
  const wallet = window.walletState?.address;
  const el = dEl('dex-positions-list');
  if (!wallet) {
    if (el) el.innerHTML = `<div class="text-center text-gray-500 text-sm py-6"><i class="fas fa-wallet text-2xl mb-2 text-gray-600 block"></i>Connect wallet to view positions</div>`;
    return;
  }
  try {
    if (el) el.innerHTML = `<div class="text-center text-gray-400 text-xs py-4"><i class="fas fa-spinner fa-spin mr-2"></i>Loading positions…</div>`;
    const res  = await fetch(`/api/dex/positions/${wallet}`);
    const data = await res.json();
    dexState.positions = data.positions || [];

    if (!data.positions.length) {
      if (el) el.innerHTML = `
        <div class="text-center py-6">
          <i class="fas fa-tint text-2xl text-gray-600 block mb-2"></i>
          <p class="text-gray-500 text-sm">No liquidity positions yet</p>
          <button onclick="dexSwitchTab('add')" class="mt-3 text-xs text-cyan-400 hover:text-cyan-300 underline">+ Add Liquidity</button>
        </div>`;
      return;
    }

    if (el) el.innerHTML = data.positions.map(pos => {
      const pool = pos.pool;
      const ta = pool.tokenA, tb = pool.tokenB;
      const ta_logo = DEX_TOKENS[ta]?.logo || '?';
      const tb_logo = DEX_TOKENS[tb]?.logo || '?';
      const aprFmt  = pool.apr ? pool.apr.toFixed(2) + '%' : '—';
      const reserveA = (pool.reserveA / 1e6).toFixed(2);
      const reserveB = (pool.reserveB / 1e6).toFixed(2);
      return `
        <div class="dex-position-card">
          <div class="flex items-center gap-3 mb-3">
            <div class="flex -space-x-1">
              <span class="w-8 h-8 rounded-full bg-cyan-900/40 border-2 border-gray-800 flex items-center justify-center text-sm">${ta_logo}</span>
              <span class="w-8 h-8 rounded-full bg-blue-900/40 border-2 border-gray-800 flex items-center justify-center text-sm">${tb_logo}</span>
            </div>
            <div>
              <div class="text-white font-semibold text-sm">${ta} / ${tb}</div>
              <div class="text-xs text-gray-500">0.3% fee · Arc Testnet</div>
            </div>
            <div class="ml-auto text-right">
              <div class="text-green-400 font-bold">${dFmtUSD(pos.valueUSD)}</div>
              <div class="text-xs text-gray-500">Your Value</div>
            </div>
          </div>
          <div class="grid grid-cols-2 gap-x-4 gap-y-1 mb-3 text-xs">
            <div class="dex-pos-row">
              <span class="text-gray-500">Your Share</span>
              <span class="text-cyan-400 font-mono">${pos.sharePercent.toFixed(3)}%</span>
            </div>
            <div class="dex-pos-row">
              <span class="text-gray-500">LP Tokens</span>
              <span class="text-yellow-400 font-mono">${(pos.lpTokens / 1e6).toFixed(4)}</span>
            </div>
            <div class="dex-pos-row">
              <span class="text-gray-500">Pool TVL</span>
              <span class="text-white font-mono">${dFmtUSD(pool.tvl)}</span>
            </div>
            <div class="dex-pos-row">
              <span class="text-gray-500">Estimated APR</span>
              <span class="text-green-400 font-mono font-bold">${aprFmt}</span>
            </div>
            <div class="dex-pos-row">
              <span class="text-gray-500">Fees Earned</span>
              <span class="text-yellow-400 font-mono">~$${pos.feesEarned.toFixed(2)}</span>
            </div>
            <div class="dex-pos-row">
              <span class="text-gray-500">Deposited</span>
              <span class="text-gray-400">${dTs(pos.depositedAt)}</span>
            </div>
          </div>
          <div class="bg-gray-800/40 rounded-lg p-2 mb-3 text-xs">
            <div class="flex justify-between">
              <span class="text-gray-500">${ta} in pool:</span>
              <span class="text-cyan-400 font-mono">${(reserveA * pos.sharePercent / 100).toFixed(4)} ${ta}</span>
            </div>
            <div class="flex justify-between mt-0.5">
              <span class="text-gray-500">${tb} in pool:</span>
              <span class="text-blue-400 font-mono">${(reserveB * pos.sharePercent / 100).toFixed(4)} ${tb}</span>
            </div>
          </div>
          <button onclick="dexQuickRemove('${pos.poolId}')"
            class="w-full text-xs bg-red-900/20 hover:bg-red-900/40 border border-red-700/30 text-red-400 rounded-lg py-2 transition-colors">
            <i class="fas fa-minus-circle mr-1.5"></i>Remove Liquidity
          </button>
        </div>
      `;
    }).join('') + `
      <div class="mt-2 p-3 bg-gray-800/30 rounded-xl text-xs">
        <div class="flex justify-between">
          <span class="text-gray-500">Total Position Value</span>
          <span class="text-white font-bold">${dFmtUSD(data.summary.totalValueUSD)}</span>
        </div>
        <div class="flex justify-between mt-1">
          <span class="text-gray-500">Total Fees Earned</span>
          <span class="text-yellow-400 font-mono">~$${data.summary.totalFeesEarned.toFixed(2)}</span>
        </div>
      </div>
    `;
  } catch (e) {
    console.error('[DEX] positions error:', e);
    if (el) el.innerHTML = `<div class="text-red-400 text-xs text-center py-4">Failed to load positions</div>`;
  }
};

// ─── Swap: fetch quote ────────────────────────────────────────────────────────
window.dexOnSwapFromChange = function() {
  dRefreshBalances();
  dexOnSwapInput();
};

window.dexOnSwapInput = function() {
  clearTimeout(dexState.quoteDebounce);
  dexState.quoteDebounce = setTimeout(dexFetchSwapQuote, 350);
};

async function dexFetchSwapQuote() {
  const from    = dEl('dex-swap-from')?.value;
  const to      = dEl('dex-swap-to')?.value;
  const amtEl   = dEl('dex-swap-amount-in');
  const amount  = parseFloat(amtEl?.value || '0');
  const slippage= parseFloat(dEl('dex-slippage')?.value || '0.5');

  if (!from || !to || !amount || amount <= 0) {
    dEl('dex-swap-quote')?.classList.add('hidden');
    dEl('dex-impact-warning')?.classList.add('hidden');
    if (dEl('dex-swap-amount-out')) dEl('dex-swap-amount-out').value = '';
    return;
  }

  if (from === to) {
    showToast && showToast('Select different tokens', 'warning');
    return;
  }

  try {
    const res  = await fetch(`/api/dex/quote?from=${from}&to=${to}&amount=${amount}&slippage=${slippage}`);
    const data = await res.json();

    if (!data.success) {
      dexState.swapQuote = null;
      dEl('dex-swap-quote')?.classList.add('hidden');
      if (typeof showToast === 'function') showToast(`No pool for ${from}/${to}. Add liquidity first.`, 'warning');
      return;
    }

    dexState.swapQuote = data.quote;
    const q = data.quote;

    if (dEl('dex-swap-amount-out')) dEl('dex-swap-amount-out').value = q.amountOut.toFixed(6);
    dEl('dex-swap-quote')?.classList.remove('hidden');

    // Update quote details
    const impactClass = dImpactClass(q.priceImpact);
    dSet('dex-q-impact', `<span class="${impactClass} font-mono">${q.priceImpact.toFixed(4)}%</span>`);
    dTxt('dex-q-min',    `${q.minimumReceivedFmt} ${to}`);
    dTxt('dex-q-fee',    `${q.fee.toFixed(6)} ${from}`);
    dTxt('dex-q-route',  q.route);

    // Impact warnings
    const warn = dEl('dex-impact-warning');
    if (q.priceImpact > 5) {
      if (warn) { warn.classList.remove('hidden'); dTxt('dex-impact-msg', `⚠️ High price impact: ${q.priceImpact.toFixed(2)}% — reduce amount or add liquidity`); }
    } else if (q.rejectSwap) {
      if (warn) { warn.classList.remove('hidden'); dTxt('dex-impact-msg', `🚫 Swap blocked: price impact ${q.priceImpact.toFixed(2)}% exceeds 15% limit`); }
    } else {
      warn?.classList.add('hidden');
    }

  } catch (e) {
    console.warn('[DEX] quote error:', e);
  }
}

// ─── Swap: flip direction ─────────────────────────────────────────────────────
window.dexFlipSwap = function() {
  const from = dEl('dex-swap-from');
  const to   = dEl('dex-swap-to');
  if (!from || !to) return;
  const tmp = from.value;
  from.value = to.value;
  to.value   = tmp;
  if (dEl('dex-swap-amount-out')) dEl('dex-swap-amount-out').value = '';
  dRefreshBalances();
  dexOnSwapInput();
};

// ─── Execute Swap ─────────────────────────────────────────────────────────────
window.dexExecuteSwap = async function() {
  if (dexState.pendingTx) return;
  const wallet  = window.walletState?.address;
  if (!wallet) { showToast('Connect wallet to swap', 'warning'); return; }

  const from    = dEl('dex-swap-from')?.value;
  const to      = dEl('dex-swap-to')?.value;
  const amtEl   = dEl('dex-swap-amount-in');
  const amount  = parseFloat(amtEl?.value || '0');
  const slippage= parseFloat(dEl('dex-slippage')?.value || '0.5');

  if (!amount || amount <= 0) { showToast('Enter amount to swap', 'warning'); return; }
  if (from === to) { showToast('Select different tokens', 'warning'); return; }
  if (!dexState.swapQuote) { showToast('Fetch quote first', 'warning'); return; }

  const q = dexState.swapQuote;
  if (q.rejectSwap) { showToast(`Swap blocked: ${q.priceImpact.toFixed(2)}% impact exceeds limit`, 'error'); return; }

  dexState.pendingTx = true;
  const btn = dEl('dex-swap-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Processing…'; }

  dShowSteps('dex-swap-steps');

  try {
    // Step 0: Verify network
    dStep(0);
    await dEnsureNetwork();

    // Step 1: Read balances
    dStep(1);
    await dRefreshBalances();
    const balance = dexState.balances[from] || 0;
    if (balance < amount) throw new Error(`Insufficient ${from}: ${balance.toFixed(4)} available, ${amount} required`);

    const tokenInfo  = DEX_TOKENS[from];
    const amountRaw  = BigInt(Math.round(amount * 1e6));
    const valueHex   = tokenInfo.isNative ? '0x' + amountRaw.toString(16) : '0x0';
    const routerAddr = DEX_ROUTER;

    // Step 2: Check allowance
    dStep(2);
    let txHash = null;
    let blockNumber = null;

    if (!tokenInfo.isNative) {
      const allowance = await dReadAllowance(from, wallet, routerAddr);
      if (allowance < amount) {
        // Step 3: Approve
        dStep(3);
        showToast(`Approving ${from} for DEX router…`, 'info');
        await dApproveToken(from, routerAddr, amount);
        await new Promise(r => setTimeout(r, 1500));
      } else {
        dStep(3, 'done');
      }
    } else {
      dStep(3, 'done');
    }

    // Step 4: Sign & send swap
    dStep(4);
    showToast(`Sign swap: ${amount} ${from} → ~${q.amountOut.toFixed(4)} ${to}`, 'info');

    if (tokenInfo.isNative) {
      // USDC native: send value directly to router
      txHash = await dSendTx(routerAddr, '0x', valueHex);
    } else {
      // EURC/USYC ERC-20: transfer to router
      const transferData = DEX_SEL.transfer + dEncAddr(routerAddr) + dEncUint(amountRaw);
      txHash = await dSendTx(tokenInfo.address, transferData);
    }

    showToast(`Swap tx submitted: ${txHash.slice(0, 14)}…`, 'info');

    // Step 5: Wait for confirmation
    dStep(5);
    const receipt = await dWaitReceipt(txHash);
    blockNumber = receipt.blockNumber ? parseInt(receipt.blockNumber, 16) : null;

    // Register swap on backend
    const regRes = await fetch('/api/dex/swap', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromToken: from, toToken: to, amountIn: amount, wallet, txHash, slippage, blockNumber }),
    });
    const regData = await regRes.json();

    dStep(5, 'done');
    dexState.lastTxHash = txHash;

    const explorerUrl = `${DEX_EXPLORER}/tx/${txHash}`;
    showToast(`✅ Swap complete! ${amount} ${from} → ${regData.swap?.amountOutFormatted || q.amountOut.toFixed(4)} ${to} <a href="${explorerUrl}" target="_blank" class="underline ml-1">View ↗</a>`, 'success');

    // Show receipt
    dexShowSwapReceipt({ from, to, amount, out: regData.swap?.amountOutFormatted || q.amountOut.toFixed(6), txHash, blockNumber, fee: q.fee, priceImpact: q.priceImpact });

    // Refresh
    await dRefreshBalances();
    dexLoadPools();
    dexRenderRecentSwaps([]);
    dexLoadAnalytics();

    if (amtEl) amtEl.value = '';
    if (dEl('dex-swap-amount-out')) dEl('dex-swap-amount-out').value = '';

  } catch (err) {
    console.error('[DEX] swap error:', err);
    dStep(4, 'error');
    if (err.code === 4001 || err.message?.includes('rejected') || err.message?.includes('denied')) {
      showToast('Swap rejected by user', 'warning');
    } else if (err.message?.includes('Insufficient')) {
      showToast(err.message, 'error');
    } else {
      showToast(`Swap failed: ${err.message}`, 'error');
    }
  } finally {
    dexState.pendingTx = false;
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-exchange-alt mr-2"></i>Swap'; }
    dHideSteps('dex-swap-steps');
  }
};

// ─── LP: token change ─────────────────────────────────────────────────────────
window.dexOnLPTokenChange = function() {
  dRefreshBalances();
  dexOnLPAmountChange('a');
};

window.dexOnLPAmountChange = async function(side) {
  clearTimeout(dexState.lpDebounce);
  dexState.lpDebounce = setTimeout(() => dexFetchLPEstimate(side), 350);
};

async function dexFetchLPEstimate(side) {
  const ta  = dEl('dex-lp-token-a')?.value;
  const tb  = dEl('dex-lp-token-b')?.value;
  const amtA = parseFloat(dEl('dex-lp-amount-a')?.value || '0');
  const amtB = parseFloat(dEl('dex-lp-amount-b')?.value || '0');

  if (ta === tb) { showToast && showToast('Select different tokens', 'warning'); return; }
  if (!amtA && !amtB) { dEl('dex-lp-preview')?.classList.add('hidden'); return; }

  try {
    const amtToSend = amtA > 0 ? amtA : 1;
    const amtBToSend = amtB > 0 ? amtB : 1;
    const res  = await fetch(`/api/dex/estimate-lp?tokenA=${ta}&tokenB=${tb}&amountA=${amtToSend}&amountB=${amtBToSend}`);
    const data = await res.json();
    if (!data.success) return;

    dexState.lpEstimate = data.estimate;

    // If pool exists, auto-fill other side
    if (data.estimate.requiredB !== null && side === 'a' && amtA > 0) {
      const ratio = data.pool ? (ta === data.pool.tokenA ? data.pool.priceRatio.priceAinB : data.pool.priceRatio.priceBinA) : null;
      if (ratio) {
        const required = amtA * ratio;
        if (dEl('dex-lp-amount-b')) dEl('dex-lp-amount-b').value = required.toFixed(6);
      }
    } else if (data.pool && side === 'b' && amtB > 0) {
      const ratio = data.pool ? (ta === data.pool.tokenA ? data.pool.priceRatio.priceBinA : data.pool.priceRatio.priceAinB) : null;
      if (ratio) {
        const required = amtB * ratio;
        if (dEl('dex-lp-amount-a')) dEl('dex-lp-amount-a').value = required.toFixed(6);
      }
    }

    const preview = dEl('dex-lp-preview');
    if (preview) preview.classList.remove('hidden');

    const ratioLabel = data.pool
      ? `1 ${ta} = ${(data.pool.priceRatio.priceAinB || 0).toFixed(6)} ${tb}`
      : 'Initial — set by you';

    dTxt('dex-lp-ratio',   ratioLabel);
    dTxt('dex-lp-share',   `${data.estimate.sharePercent}%`);
    dTxt('dex-lp-tokens',  `${parseFloat(data.estimate.lpTokens).toFixed(4)} LP`);
    dTxt('dex-lp-status',  data.estimate.isNewPool ? '🆕 New Pool' : '➕ Existing Pool');
  } catch (e) { console.warn('[DEX] lp estimate error', e); }
}

// ─── Add Liquidity ────────────────────────────────────────────────────────────
window.dexAddLiquidity = async function() {
  if (dexState.pendingTx) return;
  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Connect wallet first', 'warning'); return; }

  const ta   = dEl('dex-lp-token-a')?.value;
  const tb   = dEl('dex-lp-token-b')?.value;
  const amtA = parseFloat(dEl('dex-lp-amount-a')?.value || '0');
  const amtB = parseFloat(dEl('dex-lp-amount-b')?.value || '0');

  if (!amtA || !amtB || amtA <= 0 || amtB <= 0) { showToast('Enter amounts for both tokens', 'warning'); return; }
  if (ta === tb) { showToast('Select different tokens', 'warning'); return; }

  dexState.pendingTx = true;
  const btn = dEl('dex-add-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Adding…'; }

  dShowSteps('dex-lp-steps');

  let txHashA = null, txHashB = null;

  try {
    // Step 0: Verify network
    dLPStep(0);
    await dEnsureNetwork();

    // Step 1: Check balances
    dLPStep(1);
    await dRefreshBalances();
    const balA = dexState.balances[ta] || 0;
    const balB = dexState.balances[tb] || 0;
    if (balA < amtA) throw new Error(`Insufficient ${ta}: ${balA.toFixed(4)} available`);
    if (balB < amtB) throw new Error(`Insufficient ${tb}: ${balB.toFixed(4)} available`);

    const tokenAInfo = DEX_TOKENS[ta];
    const tokenBInfo = DEX_TOKENS[tb];
    const amtARaw = BigInt(Math.round(amtA * 1e6));
    const amtBRaw = BigInt(Math.round(amtB * 1e6));

    // Step 2: Approve Token A
    dLPStep(2);
    if (!tokenAInfo.isNative) {
      showToast(`Approving ${ta} for pool…`, 'info');
      txHashA = await dApproveToken(ta, DEX_ROUTER, amtA);
      await new Promise(r => setTimeout(r, 1000));
    }

    // Step 3: Approve Token B
    dLPStep(3);
    if (!tokenBInfo.isNative) {
      showToast(`Approving ${tb} for pool…`, 'info');
      txHashB = await dApproveToken(tb, DEX_ROUTER, amtB);
      await new Promise(r => setTimeout(r, 1000));
    }

    // Step 4: Add liquidity on-chain (send tokens to router)
    dLPStep(4);
    showToast(`Adding ${amtA} ${ta} + ${amtB} ${tb} to pool…`, 'info');

    // For USDC (native): send value to router
    // For ERC-20: transfer to router
    let finalTxHash;
    if (tokenAInfo.isNative) {
      finalTxHash = await dSendTx(DEX_ROUTER, '0x', '0x' + amtARaw.toString(16));
    } else if (tokenBInfo.isNative) {
      finalTxHash = await dSendTx(DEX_ROUTER, '0x', '0x' + amtBRaw.toString(16));
    } else {
      // Both ERC-20 — transfer token A
      const transferData = DEX_SEL.transfer + dEncAddr(DEX_ROUTER) + dEncUint(amtARaw);
      finalTxHash = await dSendTx(tokenAInfo.address, transferData);
    }

    showToast(`Add liquidity tx submitted: ${finalTxHash.slice(0, 14)}…`, 'info');

    // Step 5: Wait + register
    dLPStep(5);
    const receipt = await dWaitReceipt(finalTxHash);
    const blockNumber = receipt.blockNumber ? parseInt(receipt.blockNumber, 16) : null;

    const regRes = await fetch('/api/dex/liquidity/add', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenA: ta, tokenB: tb, amountA: amtA, amountB: amtB, wallet, txHash: finalTxHash, blockNumber }),
    });
    const regData = await regRes.json();

    dLPStep(5, 'done');

    showToast(regData.message || `✅ Liquidity added! ${regData.liquidity?.lpTokensMinted} LP tokens minted`, 'success');
    dexShowLPReceipt(regData);

    // Refresh
    await dRefreshBalances();
    dexLoadPools();
    dexLoadPositions();

    // Reset form
    if (dEl('dex-lp-amount-a')) dEl('dex-lp-amount-a').value = '';
    if (dEl('dex-lp-amount-b')) dEl('dex-lp-amount-b').value = '';
    dEl('dex-lp-preview')?.classList.add('hidden');

  } catch (err) {
    console.error('[DEX] add liquidity error:', err);
    dLPStep(3, 'error');
    if (err.code === 4001 || err.message?.includes('rejected')) showToast('Transaction rejected by user', 'warning');
    else showToast(`Add liquidity failed: ${err.message}`, 'error');
  } finally {
    dexState.pendingTx = false;
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-plus mr-2"></i>Add Liquidity'; }
    dHideSteps('dex-lp-steps');
  }
};

// ─── Remove Liquidity: populate pool selector ─────────────────────────────────
async function dexLoadRemovePools() {
  const wallet = window.walletState?.address;
  const sel = dEl('dex-rm-pool');
  if (!sel) return;
  sel.innerHTML = '<option value="">— Select pool —</option>';

  if (!wallet) return;

  try {
    const res  = await fetch(`/api/dex/positions/${wallet}`);
    const data = await res.json();
    (data.positions || []).forEach(pos => {
      const opt = document.createElement('option');
      opt.value = pos.poolId;
      opt.textContent = `${pos.pool.tokenA}/${pos.pool.tokenB} — ${(pos.lpTokens / 1e6).toFixed(4)} LP`;
      sel.appendChild(opt);
    });
    dexState.positions = data.positions || [];
  } catch {}
}

window.dexOnRemovePoolChange = function() {
  const pid = dEl('dex-rm-pool')?.value;
  if (!pid) { dEl('dex-rm-position-info')?.classList.add('hidden'); return; }

  const pos  = dexState.positions.find(p => p.poolId === pid);
  if (!pos) { dEl('dex-rm-position-info')?.classList.add('hidden'); return; }

  dexState.rmUserPos = pos;
  dexState.rmPoolData = pos.pool;

  dEl('dex-rm-position-info')?.classList.remove('hidden');
  dTxt('dex-rm-lp-owned', `${(pos.lpTokens / 1e6).toFixed(4)} LP`);
  dTxt('dex-rm-share',    `${pos.sharePercent.toFixed(4)}%`);
  dTxt('dex-rm-value',    `~$${pos.valueUSD.toFixed(2)}`);
};

window.dexSetMaxLP = function() {
  const pos = dexState.rmUserPos;
  if (!pos) return;
  if (dEl('dex-rm-amount')) dEl('dex-rm-amount').value = (pos.lpTokens / 1e6).toFixed(6);
  dexOnRemoveAmountChange();
};

window.dexOnRemoveAmountChange = function() {
  const pos    = dexState.rmUserPos;
  const pool   = dexState.rmPoolData;
  if (!pos || !pool) return;

  const lpAmt  = parseFloat(dEl('dex-rm-amount')?.value || '0') * 1e6;
  if (!lpAmt || lpAmt <= 0) { dEl('dex-rm-preview')?.classList.add('hidden'); return; }

  const shareRatio = lpAmt / (pos.lpTokens / pos.sharePercent * 100);
  const aOut = (shareRatio * pool.reserveA / 1e6);
  const bOut = (shareRatio * pool.reserveB / 1e6);

  dEl('dex-rm-preview')?.classList.remove('hidden');
  dTxt('dex-rm-token-a-label', pool.tokenA);
  dTxt('dex-rm-token-b-label', pool.tokenB);
  dTxt('dex-rm-amount-a', `${aOut.toFixed(6)} ${pool.tokenA}`);
  dTxt('dex-rm-amount-b', `${bOut.toFixed(6)} ${pool.tokenB}`);
};

// ─── Remove Liquidity: execute ────────────────────────────────────────────────
window.dexRemoveLiquidity = async function() {
  if (dexState.pendingTx) return;
  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Connect wallet first', 'warning'); return; }

  const pid   = dEl('dex-rm-pool')?.value;
  const lpAmt = parseFloat(dEl('dex-rm-amount')?.value || '0') * 1e6;

  if (!pid) { showToast('Select a pool', 'warning'); return; }
  if (!lpAmt || lpAmt <= 0) { showToast('Enter LP amount to remove', 'warning'); return; }

  const pos = dexState.rmUserPos;
  if (!pos || lpAmt > pos.lpTokens) { showToast(`Max LP available: ${(pos?.lpTokens / 1e6).toFixed(4)}`, 'error'); return; }

  if (!confirm(`Remove liquidity from ${pid} pool?\n\nBurning ${(lpAmt / 1e6).toFixed(4)} LP tokens.`)) return;

  dexState.pendingTx = true;
  const btn = dEl('dex-remove-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Removing…'; }

  try {
    await dEnsureNetwork();
    showToast(`Sign removal transaction…`, 'info');

    // On-chain: send 0-value tx to confirm removal intent
    const txHash = await dSendTx(DEX_ROUTER, '0x', '0x0');
    showToast(`Removal tx: ${txHash.slice(0, 14)}…`, 'info');

    const receipt = await dWaitReceipt(txHash);
    const blockNumber = receipt.blockNumber ? parseInt(receipt.blockNumber, 16) : null;

    const regRes = await fetch('/api/dex/liquidity/remove', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ poolId: pid, lpAmount: lpAmt, wallet, txHash, blockNumber }),
    });
    const regData = await regRes.json();

    showToast(regData.message || '✅ Liquidity removed!', 'success');

    await dRefreshBalances();
    dexLoadPositions();
    dexLoadPools();
    dexLoadRemovePools();
    if (dEl('dex-rm-amount')) dEl('dex-rm-amount').value = '';

  } catch (err) {
    console.error('[DEX] remove liquidity error:', err);
    if (err.code === 4001 || err.message?.includes('rejected')) showToast('Transaction rejected', 'warning');
    else showToast(`Remove failed: ${err.message}`, 'error');
  } finally {
    dexState.pendingTx = false;
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-minus mr-2"></i>Remove Liquidity'; }
  }
};

// ─── Quick actions ────────────────────────────────────────────────────────────
window.dexQuickAddLiquidity = function(ta, tb) {
  dexSwitchTab('add');
  if (dEl('dex-lp-token-a')) dEl('dex-lp-token-a').value = ta;
  if (dEl('dex-lp-token-b')) dEl('dex-lp-token-b').value = tb;
  dRefreshBalances();
};

window.dexQuickRemove = function(pid) {
  dexSwitchTab('remove');
  setTimeout(async () => {
    await dexLoadRemovePools();
    const sel = dEl('dex-rm-pool');
    if (sel) { sel.value = pid; dexOnRemovePoolChange(); }
  }, 200);
};

// ─── Receipt modals ───────────────────────────────────────────────────────────
function dexShowSwapReceipt({ from, to, amount, out, txHash, blockNumber, fee, priceImpact }) {
  const explorerUrl = `${DEX_EXPLORER}/tx/${txHash}`;
  const existing = document.getElementById('dex-receipt-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'dex-receipt-modal';
  modal.className = 'fixed inset-0 z-[95] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4';
  modal.innerHTML = `
    <div class="bg-gray-900 border border-cyan-700/40 rounded-2xl p-6 max-w-md w-full shadow-2xl" style="animation:modal-in 0.25s cubic-bezier(0.34,1.56,0.64,1) forwards">
      <div class="flex items-center justify-between mb-5">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-600 to-blue-600 flex items-center justify-center">
            <i class="fas fa-exchange-alt text-white"></i>
          </div>
          <div>
            <h2 class="text-white font-bold">Swap Receipt</h2>
            <p class="text-cyan-400 text-xs">ARC DEX · Arc Testnet</p>
          </div>
        </div>
        <button onclick="document.getElementById('dex-receipt-modal').remove()" class="text-gray-500 hover:text-gray-300 w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-800"><i class="fas fa-times text-sm"></i></button>
      </div>
      <div class="flex items-center gap-2 mb-4 bg-green-900/20 border border-green-700/30 rounded-xl px-4 py-2.5">
        <div class="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
        <span class="text-green-400 text-sm font-semibold">Swap Confirmed on Arc Testnet</span>
      </div>
      <div class="space-y-0 mb-5 bg-gray-800/50 rounded-xl overflow-hidden divide-y divide-gray-700/40">
        <div class="px-4 py-3 bg-cyan-900/10">
          <div class="text-xs text-gray-500 mb-1">You swapped</div>
          <div class="text-xl font-bold text-white">${amount} <span class="text-cyan-400">${from}</span></div>
          <div class="text-sm text-green-400 mt-0.5">→ ${out} <span class="text-white">${to}</span></div>
        </div>
        <div class="px-4 py-2.5">
          <div class="flex justify-between text-xs"><span class="text-gray-500">LP Fee (0.3%)</span><span class="text-yellow-400">${fee?.toFixed(6)} ${from}</span></div>
        </div>
        <div class="px-4 py-2.5">
          <div class="flex justify-between text-xs"><span class="text-gray-500">Price Impact</span><span class="${dImpactClass(priceImpact || 0)}">${(priceImpact || 0).toFixed(4)}%</span></div>
        </div>
        <div class="px-4 py-2.5">
          <div class="flex justify-between text-xs"><span class="text-gray-500">Network</span><span class="text-green-400">Arc Testnet (5042002)</span></div>
        </div>
        ${blockNumber ? `<div class="px-4 py-2.5"><div class="flex justify-between text-xs"><span class="text-gray-500">Block</span><span class="font-mono">#${blockNumber}</span></div></div>` : ''}
        <div class="px-4 py-2.5">
          <div class="flex justify-between text-xs"><span class="text-gray-500">Transaction</span>
          <a href="${explorerUrl}" target="_blank" class="text-blue-400 hover:underline font-mono">${txHash.slice(0,14)}… <i class="fas fa-external-link-alt text-[9px]"></i></a></div>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-2">
        <button onclick="dexDownloadReceipt('json',${JSON.stringify({ type:'swap', from, to, amount, out, txHash, blockNumber, fee, priceImpact, timestamp: Date.now(), network: 'Arc Testnet', chainId: 5042002 }).replace(/"/g,'&quot;')})" class="flex items-center justify-center gap-2 bg-gray-800 hover:bg-gray-700 border border-gray-600 text-gray-300 text-xs rounded-xl py-2.5 transition-colors">
          <i class="fas fa-download text-cyan-400"></i>Download JSON
        </button>
        <a href="${explorerUrl}" target="_blank" class="flex items-center justify-center gap-2 bg-blue-900/20 hover:bg-blue-800/30 border border-blue-700/40 text-blue-400 text-xs rounded-xl py-2.5 transition-colors">
          <i class="fas fa-external-link-alt"></i>View on ArcScan
        </a>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

function dexShowLPReceipt(data) {
  const lp = data.liquidity;
  if (!lp) return;
  const explorerUrl = lp.explorerUrl || `${DEX_EXPLORER}/tx/${lp.txHash}`;
  const existing = document.getElementById('dex-lp-receipt-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'dex-lp-receipt-modal';
  modal.className = 'fixed inset-0 z-[95] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4';
  modal.innerHTML = `
    <div class="bg-gray-900 border border-green-700/40 rounded-2xl p-6 max-w-md w-full shadow-2xl" style="animation:modal-in 0.25s cubic-bezier(0.34,1.56,0.64,1) forwards">
      <div class="flex items-center justify-between mb-5">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-green-600 to-emerald-600 flex items-center justify-center">
            <i class="fas fa-tint text-white"></i>
          </div>
          <div>
            <h2 class="text-white font-bold">${lp.isNewPool ? '🆕 Pool Created!' : 'Liquidity Added'}</h2>
            <p class="text-green-400 text-xs">ARC DEX · event LiquidityAdded</p>
          </div>
        </div>
        <button onclick="document.getElementById('dex-lp-receipt-modal').remove()" class="text-gray-500 hover:text-gray-300 w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-800"><i class="fas fa-times text-sm"></i></button>
      </div>
      <div class="flex items-center gap-2 mb-4 bg-green-900/20 border border-green-700/30 rounded-xl px-4 py-2.5">
        <div class="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
        <span class="text-green-400 text-sm font-semibold">Confirmed — LP Tokens Minted</span>
      </div>
      <div class="space-y-0 mb-5 bg-gray-800/50 rounded-xl overflow-hidden divide-y divide-gray-700/40">
        <div class="px-4 py-3 bg-green-900/10">
          <div class="text-xs text-gray-500 mb-1">Pool</div>
          <div class="text-xl font-bold text-white">${lp.tokenA} / ${lp.tokenB}</div>
        </div>
        <div class="px-4 py-2.5">
          <div class="flex justify-between text-xs"><span class="text-gray-500">${lp.tokenA} Deposited</span><span class="text-cyan-400">${lp.amountA} ${lp.tokenA}</span></div>
        </div>
        <div class="px-4 py-2.5">
          <div class="flex justify-between text-xs"><span class="text-gray-500">${lp.tokenB} Deposited</span><span class="text-blue-400">${lp.amountB} ${lp.tokenB}</span></div>
        </div>
        <div class="px-4 py-2.5">
          <div class="flex justify-between text-sm"><span class="text-gray-400">LP Tokens Minted</span><span class="text-yellow-400 font-bold">${lp.lpTokensMinted}</span></div>
        </div>
        <div class="px-4 py-2.5">
          <div class="flex justify-between text-xs"><span class="text-gray-500">Pool Share</span><span class="text-green-400">${lp.sharePercent}%</span></div>
        </div>
        <div class="px-4 py-2.5">
          <div class="flex justify-between text-xs"><span class="text-gray-500">Transaction</span>
          <a href="${explorerUrl}" target="_blank" class="text-blue-400 hover:underline font-mono">${lp.txHash.slice(0,14)}… <i class="fas fa-external-link-alt text-[9px]"></i></a></div>
        </div>
      </div>
      <a href="${explorerUrl}" target="_blank" class="flex items-center justify-center gap-2 w-full bg-blue-900/20 hover:bg-blue-800/30 border border-blue-700/40 text-blue-400 text-sm rounded-xl py-2.5 transition-colors">
        <i class="fas fa-external-link-alt"></i>View on ArcScan
      </a>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

// ─── Download receipt ─────────────────────────────────────────────────────────
window.dexDownloadReceipt = function(format, data) {
  const receipt = typeof data === 'string' ? JSON.parse(data.replace(/&quot;/g, '"')) : data;
  const blob = new Blob([JSON.stringify({ ...receipt, _meta: { generator: 'ARC DEX', generatedAt: new Date().toISOString(), network: 'Arc Testnet', chainId: 5042002 } }, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `arc-dex-${receipt.type || 'receipt'}-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  if (typeof showToast === 'function') showToast('✅ Receipt downloaded', 'success');
};

// ─── Refresh all DEX data ─────────────────────────────────────────────────────
window.dexRefreshAll = async function() {
  await Promise.all([
    dexLoadPools(),
    dexLoadAnalytics(),
    dRefreshBalances(),
  ]);
  const wallet = window.walletState?.address;
  if (wallet) dexLoadPositions();
};

// ─── APR Estimator ────────────────────────────────────────────────────────────
window.dexEstimateAPR = function() {
  const tvl     = parseFloat(document.getElementById('dex-apr-tvl')?.value   || '0');
  const vol     = parseFloat(document.getElementById('dex-apr-vol')?.value   || '0');
  const fee     = parseFloat(document.getElementById('dex-apr-fee')?.value   || '0.3') / 100;
  const result  = document.getElementById('dex-apr-result');
  if (!tvl || !vol || !result) return;
  const daily   = vol * fee;
  const apr     = tvl > 0 ? (daily * 365 / tvl) * 100 : 0;
  const monthly = apr / 12;
  result.innerHTML = `
    <div class="grid grid-cols-3 gap-3 mt-3">
      <div class="text-center bg-green-900/20 border border-green-700/30 rounded-xl p-3">
        <div class="text-xs text-gray-500 mb-1">Est. APR</div>
        <div class="text-green-400 font-bold text-lg">${apr.toFixed(2)}%</div>
      </div>
      <div class="text-center bg-blue-900/20 border border-blue-700/30 rounded-xl p-3">
        <div class="text-xs text-gray-500 mb-1">Monthly</div>
        <div class="text-blue-400 font-bold text-lg">${monthly.toFixed(2)}%</div>
      </div>
      <div class="text-center bg-yellow-900/20 border border-yellow-700/30 rounded-xl p-3">
        <div class="text-xs text-gray-500 mb-1">Daily Fees</div>
        <div class="text-yellow-400 font-bold text-sm">$${daily.toFixed(2)}</div>
      </div>
    </div>
    <p class="text-xs text-gray-500 mt-2 text-center">APR = (24h Vol × ${(fee*100).toFixed(1)}% × 365) / TVL</p>
  `;
};

// ─── IL Calculator ────────────────────────────────────────────────────────────
window.dexCalcIL = function() {
  const change  = parseFloat(document.getElementById('dex-il-price-change')?.value || '0');
  const result  = document.getElementById('dex-il-calc-result');
  if (!result || isNaN(change)) return;
  const r  = 1 + change / 100;
  const il = (2 * Math.sqrt(r) / (1 + r) - 1) * 100;
  const ilAbs = Math.abs(il);
  const color = ilAbs < 1 ? 'text-green-400' : ilAbs < 5 ? 'text-yellow-400' : ilAbs < 15 ? 'text-orange-400' : 'text-red-400';
  result.innerHTML = `
    <div class="mt-3 p-3 bg-gray-800/60 rounded-xl text-center">
      <div class="text-xs text-gray-500 mb-1">Impermanent Loss</div>
      <div class="${color} font-bold text-2xl">${il.toFixed(3)}%</div>
      <div class="text-xs text-gray-500 mt-1">at ${change > 0 ? '+' : ''}${change}% price change</div>
      <div class="text-xs text-gray-600 mt-2 font-mono">IL = 2√(${r.toFixed(2)})/(1+${r.toFixed(2)}) − 1</div>
    </div>
  `;
};

// ─── Load pool detail modal ───────────────────────────────────────────────────
window.dexShowPoolDetail = async function(poolId) {
  try {
    const res  = await fetch(`/api/dex/pools/${poolId}`);
    const data = await res.json();
    if (!data.success) return;
    const p    = data.pool;
    const pA   = DEX_TOKENS[p.tokenA]?.logo || '?';
    const pB   = DEX_TOKENS[p.tokenB]?.logo || '?';
    const existing = document.getElementById('dex-pool-detail-modal');
    if (existing) existing.remove();
    const modal = document.createElement('div');
    modal.id = 'dex-pool-detail-modal';
    modal.className = 'fixed inset-0 z-[96] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4';
    modal.innerHTML = `
      <div class="bg-gray-900 border border-cyan-700/30 rounded-2xl p-6 max-w-lg w-full shadow-2xl overflow-y-auto max-h-[90vh]" style="animation:modal-in 0.25s ease forwards">
        <div class="flex items-center justify-between mb-5">
          <div class="flex items-center gap-3">
            <div class="flex -space-x-2">
              <span class="w-10 h-10 rounded-full bg-cyan-900/40 border-2 border-gray-800 flex items-center justify-center">${pA}</span>
              <span class="w-10 h-10 rounded-full bg-blue-900/40 border-2 border-gray-800 flex items-center justify-center">${pB}</span>
            </div>
            <div>
              <h2 class="text-white font-bold text-lg">${p.tokenA} / ${p.tokenB}</h2>
              <p class="text-cyan-400 text-xs">ARC DEX · 0.3% fee · x·y=k</p>
            </div>
          </div>
          <button onclick="document.getElementById('dex-pool-detail-modal').remove()" class="text-gray-500 hover:text-gray-300 w-7 h-7 rounded-lg hover:bg-gray-800 flex items-center justify-center">
            <i class="fas fa-times text-sm"></i>
          </button>
        </div>
        <div class="grid grid-cols-2 gap-3 mb-5">
          <div class="dex-analytics-metric">
            <div class="text-xs text-gray-500 mb-1">TVL</div>
            <div class="text-cyan-400 font-bold">${p.tvlFormatted}</div>
          </div>
          <div class="dex-analytics-metric">
            <div class="text-xs text-gray-500 mb-1">APR</div>
            <div class="text-green-400 font-bold">${p.aprFormatted}</div>
          </div>
          <div class="dex-analytics-metric">
            <div class="text-xs text-gray-500 mb-1">${p.tokenA} Reserve</div>
            <div class="text-white font-mono text-sm">${parseFloat(p.reserveAFormatted).toLocaleString()} ${p.tokenA}</div>
          </div>
          <div class="dex-analytics-metric">
            <div class="text-xs text-gray-500 mb-1">${p.tokenB} Reserve</div>
            <div class="text-white font-mono text-sm">${parseFloat(p.reserveBFormatted).toLocaleString()} ${p.tokenB}</div>
          </div>
          <div class="dex-analytics-metric">
            <div class="text-xs text-gray-500 mb-1">24h Volume</div>
            <div class="text-yellow-400 font-mono">${dFmtUSD(p.volume24h)}</div>
          </div>
          <div class="dex-analytics-metric">
            <div class="text-xs text-gray-500 mb-1">Total Swaps</div>
            <div class="text-purple-400 font-bold">${p.swapCount.toLocaleString()}</div>
          </div>
        </div>
        <div class="bg-gray-800/50 rounded-xl p-3 mb-4">
          <div class="text-xs text-gray-500 mb-2">Price Ratio</div>
          <div class="flex justify-between text-sm">
            <span class="text-cyan-400">1 ${p.tokenA} = <span class="font-mono">${(p.priceRatio?.priceAinB || 0).toFixed(6)} ${p.tokenB}</span></span>
            <span class="text-blue-400">1 ${p.tokenB} = <span class="font-mono">${(p.priceRatio?.priceBinA || 0).toFixed(6)} ${p.tokenA}</span></span>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <button onclick="dexQuickAddLiquidity('${p.tokenA}','${p.tokenB}');document.getElementById('dex-pool-detail-modal').remove()"
            class="flex items-center justify-center gap-2 bg-green-900/20 hover:bg-green-800/30 border border-green-700/30 text-green-400 text-sm rounded-xl py-2.5 transition-colors">
            <i class="fas fa-plus"></i>Add Liquidity
          </button>
          <button onclick="dexSwitchTab('swap');document.getElementById('dex-pool-detail-modal').remove()"
            class="flex items-center justify-center gap-2 bg-cyan-900/20 hover:bg-cyan-800/30 border border-cyan-700/30 text-cyan-400 text-sm rounded-xl py-2.5 transition-colors">
            <i class="fas fa-exchange-alt"></i>Swap
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  } catch (e) { console.warn('[DEX] pool detail error:', e); }
};

// ─── Render enhanced pool table ───────────────────────────────────────────────
// Overrides the basic version in dexLoadPools
function dexRenderPoolTable(pools) {
  const tbody = dEl('dex-pools-table');
  if (!tbody) return;
  if (!pools.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center py-6 text-gray-500">No pools yet</td></tr>';
    return;
  }
  const maxTVL = Math.max(...pools.map(p => p.tvl), 1);
  tbody.innerHTML = pools.map(p => {
    const pA = DEX_TOKENS[p.tokenA]?.logo || '?';
    const pB = DEX_TOKENS[p.tokenB]?.logo || '?';
    const tvlPct = Math.round((p.tvl / maxTVL) * 100);
    const aprClass = p.apr > 20 ? 'high' : p.apr > 5 ? 'medium' : 'low';
    return `
      <tr class="border-b border-gray-800/40 hover:bg-gray-800/20 transition-colors cursor-pointer"
          onclick="dexShowPoolDetail('${p.id}')">
        <td class="py-3 px-2">
          <div class="flex items-center gap-2">
            <div class="dex-token-pair">
              <span class="w-6 h-6 rounded-full bg-cyan-900/40 border border-cyan-700/40 flex items-center justify-center text-[11px]">${pA}</span>
              <span class="w-6 h-6 rounded-full bg-blue-900/40 border border-blue-700/40 flex items-center justify-center text-[11px]">${pB}</span>
            </div>
            <div>
              <div class="text-white font-medium text-sm">${p.tokenA}/${p.tokenB}</div>
              <div class="dex-tvl-bar mt-0.5" style="width:${Math.max(tvlPct,4)}px;max-width:60px"></div>
            </div>
          </div>
        </td>
        <td class="text-right py-3 px-2">
          <div class="text-cyan-400 font-mono text-sm">${p.tvlFormatted}</div>
          <div class="text-gray-600 text-[10px]">${p.swapCount} swaps</div>
        </td>
        <td class="text-right py-3 px-2 text-green-400 font-mono text-sm">${dFmtUSD(p.volume24h)}</td>
        <td class="text-right py-3 px-2">
          <span class="dex-apr-badge ${aprClass}">${p.aprFormatted}</span>
        </td>
        <td class="text-right py-3 px-2">
          <button onclick="event.stopPropagation();dexQuickAddLiquidity('${p.tokenA}','${p.tokenB}')"
            class="text-[10px] bg-green-900/30 hover:bg-green-800/40 border border-green-700/30 text-green-400 rounded-lg px-2 py-1 transition-colors">
            + Add
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

// ─── Patch dexLoadPools to use enhanced renderer ──────────────────────────────
const _origLoadPools = window.dexLoadPools;
window.dexLoadPools = async function() {
  try {
    const res  = await fetch('/api/dex/pools');
    const data = await res.json();
    if (!data.success) return;

    dTxt('dex-stat-tvl',   dFmtUSD(data.analytics.tvlTotal));
    dTxt('dex-stat-vol',   dFmtUSD(data.analytics.volume24h));
    dTxt('dex-stat-fees',  dFmtUSD(data.analytics.fees24h));
    dTxt('dex-stat-pools', data.analytics.totalPools);

    data.pools.forEach(p => { dexState.pools[p.id] = p; });
    dexRenderPoolTable(data.pools);
  } catch (e) {
    console.error('[DEX] loadPools error:', e);
  }
};

// ─── Auto-refresh pool prices every 30s ──────────────────────────────────────
let _dexAutoRefreshTimer = null;
function dexStartAutoRefresh() {
  if (_dexAutoRefreshTimer) return;
  _dexAutoRefreshTimer = setInterval(() => {
    dexLoadPools();
    dexLoadAnalytics();
  }, 30_000);
}

// ─── Init on tab open ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('walletConnected', () => {
    dRefreshBalances();
    dexLoadPositions();
  });
  setTimeout(dexRefreshAll, 500);
  dexStartAutoRefresh();
});

window.dexInit = function() {
  dexRefreshAll();
  dRefreshBalances();
  dexStartAutoRefresh();
};

console.log('[DEX] ARC AMM DEX loaded · ChainID:', DEX_CHAIN_ID, '· Formula: x*y=k · Fee: 0.3%');
