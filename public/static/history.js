// ============================================================
// HISTORY MODULE — ARC AI Agents
// Real on-chain transaction history via ethers.js + RPC
// Arc Testnet (chainId 5042002)
// ============================================================
'use strict';

const HIST_EXPLORER  = 'https://testnet.arcscan.app';
const HIST_RPC       = 'https://rpc.testnet.arc.network';
const HIST_CHAIN_ID  = 5042002;
const HIST_USDC_ADDR = '0x3600000000000000000000000000000000000000';
const HIST_EURC_ADDR = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const HIST_CF_ADDR   = '0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A';
const HIST_AMM_ADDR  = '0x3148E2807F172D1cC354F35fB4fC4104e8b6b561';

// Transfer event topic (ERC-20 Transfer)
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// Swap event topic (AMM)
const SWAP_TOPIC     = ethers?.id ? ethers.id('Swap(address,bool,uint256,uint256,uint256,uint256)') : null;

let histState = {
  items: [],       // all fetched items
  filter: 'all',   // current filter
  page:   1,
  perPage: 30,
  loading: false,
  wallet: null,
};

// ─── Helpers ────────────────────────────────────────────────────────────────
function histEl(id) { return document.getElementById(id); }
function histShort(h) { return h ? h.slice(0,10) + '…' + h.slice(-6) : '—'; }
function histFmt(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
function histFmtUsdc(n, decimals = 6) {
  try {
    const v = Number(ethers.formatUnits(BigInt(n), decimals));
    return v.toFixed(v >= 1000 ? 0 : v >= 1 ? 2 : 4);
  } catch { return '?'; }
}

// ─── Type metadata ───────────────────────────────────────────────────────────
function histTypeMeta(type) {
  const map = {
    payment:   { icon: 'fa-dollar-sign',    color: 'text-purple-400', bg: 'bg-purple-900/30', border: 'border-purple-700/30', label: 'Payment'   },
    multisend: { icon: 'fa-paper-plane',    color: 'text-cyan-400',   bg: 'bg-cyan-900/30',   border: 'border-cyan-700/30',   label: 'MultiSend' },
    swap:      { icon: 'fa-exchange-alt',   color: 'text-green-400',  bg: 'bg-green-900/30',  border: 'border-green-700/30',  label: 'Swap'      },
    contract:  { icon: 'fa-file-contract',  color: 'text-yellow-400', bg: 'bg-yellow-900/30', border: 'border-yellow-700/30', label: 'Contract'  },
    receive:   { icon: 'fa-arrow-down',     color: 'text-blue-400',   bg: 'bg-blue-900/30',   border: 'border-blue-700/30',   label: 'Received'  },
    send:      { icon: 'fa-arrow-up',       color: 'text-orange-400', bg: 'bg-orange-900/30', border: 'border-orange-700/30', label: 'Sent'      },
  };
  return map[type] || map.send;
}

function histStatusBadge(status) {
  if (status === 'confirmed') return '<span class="text-xs px-2 py-0.5 rounded-full bg-green-900/30 border border-green-700/40 text-green-400">✓ Confirmed</span>';
  if (status === 'failed')    return '<span class="text-xs px-2 py-0.5 rounded-full bg-red-900/30 border border-red-700/40 text-red-400">✗ Failed</span>';
  if (status === 'pending')   return '<span class="text-xs px-2 py-0.5 rounded-full bg-yellow-900/30 border border-yellow-700/40 text-yellow-400">⏳ Pending</span>';
  return '<span class="text-xs px-2 py-0.5 rounded-full bg-gray-700/40 border border-gray-600/40 text-gray-400">—</span>';
}

// ─── Fetch on-chain transfers for wallet ────────────────────────────────────
async function histFetchTransfers(wallet, provider) {
  const items = [];
  const usdcContract = new ethers.Contract(
    HIST_USDC_ADDR,
    ['event Transfer(address indexed from, address indexed to, uint256 value)'],
    provider
  );
  const eurcContract = new ethers.Contract(
    HIST_EURC_ADDR,
    ['event Transfer(address indexed from, address indexed to, uint256 value)'],
    provider
  );

  try {
    const latestBlock = await provider.getBlockNumber();
    const fromBlock   = Math.max(0, latestBlock - 50000); // ~last 50k blocks

    // USDC sent by wallet
    const usdcSent = await usdcContract.queryFilter(
      usdcContract.filters.Transfer(wallet, null),
      fromBlock, latestBlock
    );
    // USDC received
    const usdcRcvd = await usdcContract.queryFilter(
      usdcContract.filters.Transfer(null, wallet),
      fromBlock, latestBlock
    );
    // EURC sent
    const eurcSent = await eurcContract.queryFilter(
      eurcContract.filters.Transfer(wallet, null),
      fromBlock, latestBlock
    );
    // EURC received
    const eurcRcvd = await eurcContract.queryFilter(
      eurcContract.filters.Transfer(null, wallet),
      fromBlock, latestBlock
    );

    const allTx = [...usdcSent, ...usdcRcvd, ...eurcSent, ...eurcRcvd];

    // Fetch block timestamps in batches
    const blockNums = [...new Set(allTx.map(e => e.blockNumber))];
    const blockTs   = {};
    for (let i = 0; i < blockNums.length; i += 20) {
      const batch = blockNums.slice(i, i + 20);
      await Promise.all(batch.map(async bn => {
        try {
          const blk = await provider.getBlock(bn);
          if (blk) blockTs[bn] = blk.timestamp;
        } catch {}
      }));
    }

    // Build items
    allTx.forEach(ev => {
      const isUSDC = ev.address.toLowerCase() === HIST_USDC_ADDR.toLowerCase();
      const token  = isUSDC ? 'USDC' : 'EURC';
      const decs   = 6;
      const from   = ev.args[0].toLowerCase();
      const to     = ev.args[1].toLowerCase();
      const value  = ev.args[2];
      const isSend = from === wallet.toLowerCase();
      const amtHuman = histFmtUsdc(value, decs);

      // Classify type
      let type = isSend ? 'send' : 'receive';
      if (to.toLowerCase() === HIST_CF_ADDR.toLowerCase())  type = 'contract';
      if (to.toLowerCase() === HIST_AMM_ADDR.toLowerCase()) type = 'swap';
      if (from.toLowerCase() === HIST_AMM_ADDR.toLowerCase()) type = 'swap';

      items.push({
        id:        ev.transactionHash + '_' + ev.index,
        txHash:    ev.transactionHash,
        blockNum:  ev.blockNumber,
        ts:        blockTs[ev.blockNumber] || 0,
        type,
        token,
        amount:    amtHuman,
        from:      ev.args[0],
        to:        ev.args[1],
        status:    'confirmed',
        raw:       ev,
      });
    });

  } catch (err) {
    console.warn('[HISTORY] queryFilter error:', err.message);
  }

  return items;
}

// ─── Fetch AMM swap events ─────────────────────────────────────────────────
async function histFetchSwaps(wallet, provider) {
  const items = [];
  try {
    const ammContract = new ethers.Contract(
      HIST_AMM_ADDR,
      ['event Swap(address indexed user, bool usdcToEurc, uint256 amountIn, uint256 amountOut, uint256 fee, uint256 timestamp)'],
      provider
    );
    const latestBlock = await provider.getBlockNumber();
    const fromBlock   = Math.max(0, latestBlock - 50000);

    const swaps = await ammContract.queryFilter(
      ammContract.filters.Swap(wallet),
      fromBlock, latestBlock
    );

    for (const ev of swaps) {
      const dir      = ev.args[1]; // usdcToEurc
      const amtIn    = histFmtUsdc(ev.args[2], 6);
      const amtOut   = histFmtUsdc(ev.args[3], 6);
      const blk      = await provider.getBlock(ev.blockNumber).catch(() => null);
      items.push({
        id:        ev.transactionHash + '_swap_' + ev.index,
        txHash:    ev.transactionHash,
        blockNum:  ev.blockNumber,
        ts:        blk?.timestamp || 0,
        type:      'swap',
        token:     dir ? 'USDC→EURC' : 'EURC→USDC',
        amount:    `${amtIn} → ${amtOut}`,
        from:      wallet,
        to:        HIST_AMM_ADDR,
        status:    'confirmed',
      });
    }
  } catch (err) {
    console.warn('[HISTORY] Swap fetch error:', err.message);
  }
  return items;
}

// ─── Merge session receipts (multisend) ─────────────────────────────────────
function histMergeReceipts() {
  const items = [];
  if (!window.msReceipts) return items;
  window.msReceipts.forEach(r => {
    items.push({
      id:       r.id,
      txHash:   r.txHash,
      blockNum: 0,
      ts:       Math.floor(new Date(r.timestamp).getTime() / 1000),
      type:     'multisend',
      token:    r.token || 'USDC',
      amount:   `$${r.totalAmount} (${r.count} recipients)`,
      from:     r.from,
      to:       `${r.count} recipients`,
      status:   r.status === 'confirmed' ? 'confirmed' : 'partial',
    });
  });
  return items;
}

// ─── Load all history ────────────────────────────────────────────────────────
async function historyInit() {
  const wallet = window.walletState?.address;

  const gateEl    = histEl('history-wallet-gate');
  const loadEl    = histEl('history-loading');
  const listEl    = histEl('history-list');
  const emptyEl   = histEl('history-empty');
  const loadMoreEl= histEl('history-load-more');

  if (!wallet) {
    if (gateEl)  gateEl.classList.remove('hidden');
    if (listEl)  listEl.innerHTML = '';
    if (emptyEl) emptyEl.classList.add('hidden');
    return;
  }

  if (gateEl) gateEl.classList.add('hidden');
  if (loadEl) loadEl.classList.remove('hidden');
  if (listEl) listEl.innerHTML = '';
  if (emptyEl) emptyEl.classList.add('hidden');
  if (loadMoreEl) loadMoreEl.classList.add('hidden');

  histState.wallet  = wallet;
  histState.loading = true;
  histState.items   = [];
  histState.page    = 1;

  try {
    const ethersLib = window.ethers;
    if (!ethersLib) throw new Error('ethers.js not loaded');

    const provider = new ethersLib.JsonRpcProvider(HIST_RPC);

    // Fetch in parallel
    const [transfers, swaps, receipts] = await Promise.all([
      histFetchTransfers(wallet, provider),
      histFetchSwaps(wallet, provider),
      Promise.resolve(histMergeReceipts()),
    ]);

    // Merge and deduplicate by txHash+index
    const seen = new Set();
    const all  = [...transfers, ...swaps, ...receipts].filter(item => {
      const key = item.id || item.txHash;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Sort newest first
    all.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    histState.items = all;

  } catch (err) {
    console.error('[HISTORY] Load error:', err);
    showToast('History load error: ' + (err.message || err), 'error');
  }

  histState.loading = false;
  if (loadEl) loadEl.classList.add('hidden');

  histRender();
}

// ─── Filter ───────────────────────────────────────────────────────────────────
function historyFilter(filter) {
  histState.filter = filter;
  histState.page   = 1;

  document.querySelectorAll('.history-filter-btn').forEach(btn => {
    const isActive = btn.dataset.filter === filter;
    btn.classList.toggle('active', isActive);
    if (isActive) {
      btn.classList.add('bg-blue-700/40', 'border-blue-600/40', 'text-blue-300', 'font-semibold');
      btn.classList.remove('bg-gray-800/60', 'border-gray-700/40', 'text-gray-400');
    } else {
      btn.classList.remove('bg-blue-700/40', 'border-blue-600/40', 'text-blue-300', 'font-semibold');
      btn.classList.add('bg-gray-800/60', 'border-gray-700/40', 'text-gray-400');
    }
  });

  histRender();
}

// ─── Load more ────────────────────────────────────────────────────────────────
function historyLoadMore() {
  histState.page++;
  histRender();
}

// ─── Render ───────────────────────────────────────────────────────────────────
function histRender() {
  const listEl    = histEl('history-list');
  const emptyEl   = histEl('history-empty');
  const loadMoreEl= histEl('history-load-more');
  if (!listEl) return;

  const wallet   = histState.wallet?.toLowerCase();
  const allItems = histState.items;
  const filter   = histState.filter;

  // Apply filter
  const filtered = allItems.filter(item => {
    if (filter === 'all')       return true;
    if (filter === 'payment')   return item.type === 'send' || item.type === 'receive' || item.type === 'payment';
    if (filter === 'multisend') return item.type === 'multisend';
    if (filter === 'swap')      return item.type === 'swap';
    if (filter === 'contract')  return item.type === 'contract';
    return true;
  });

  if (filtered.length === 0) {
    if (emptyEl)    emptyEl.classList.remove('hidden');
    if (loadMoreEl) loadMoreEl.classList.add('hidden');
    listEl.innerHTML = '';
    return;
  }

  if (emptyEl) emptyEl.classList.add('hidden');

  const pageSize = histState.perPage * histState.page;
  const visible  = filtered.slice(0, pageSize);
  const hasMore  = filtered.length > pageSize;

  if (loadMoreEl) loadMoreEl.classList.toggle('hidden', !hasMore);

  listEl.innerHTML = visible.map(item => {
    const meta   = histTypeMeta(item.type);
    const isSelf = item.from?.toLowerCase() === wallet;
    const dir    = isSelf ? '→' : '←';

    return `
    <div class="history-tx-row bg-gray-900/60 border border-gray-700/40 rounded-xl px-4 py-3 flex flex-wrap sm:flex-nowrap items-center gap-3">
      <!-- Icon -->
      <div class="w-9 h-9 rounded-xl ${meta.bg} border ${meta.border} flex items-center justify-center flex-shrink-0">
        <i class="fas ${meta.icon} ${meta.color} text-sm"></i>
      </div>
      <!-- Info -->
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-white font-semibold text-sm">${meta.label}</span>
          <span class="text-xs text-gray-500 ${meta.color}">${item.token}</span>
          ${histStatusBadge(item.status)}
        </div>
        <div class="text-xs text-gray-500 mt-0.5 flex items-center gap-2 flex-wrap">
          <span class="font-mono">${histShort(item.from)} ${dir} ${histShort(item.to)}</span>
          ${item.ts ? `<span>· ${histFmt(item.ts)}</span>` : ''}
          ${item.blockNum ? `<span>· Block #${item.blockNum}</span>` : ''}
        </div>
      </div>
      <!-- Amount + Tx link -->
      <div class="text-right flex-shrink-0">
        <div class="text-white font-bold text-sm">${item.amount}</div>
        ${item.txHash ? `
        <a href="${HIST_EXPLORER}/tx/${item.txHash}" target="_blank" rel="noopener"
          class="text-[11px] text-blue-400 hover:text-blue-300 hover:underline font-mono flex items-center gap-1 justify-end mt-0.5">
          ${item.txHash.slice(0,10)}… <i class="fas fa-external-link-alt text-[9px]"></i>
        </a>` : '<div class="text-xs text-gray-600">No tx hash</div>'}
      </div>
    </div>`;
  }).join('');
}

// ─── Wallet events ───────────────────────────────────────────────────────────
window.addEventListener('walletConnected', () => {
  if (document.getElementById('tab-content-history')?.classList.contains('hidden') === false) {
    historyInit();
  }
});
window.addEventListener('walletDisconnected', () => {
  histState.items  = [];
  histState.wallet = null;
  const gateEl = histEl('history-wallet-gate');
  const listEl = histEl('history-list');
  if (gateEl) gateEl.classList.remove('hidden');
  if (listEl) listEl.innerHTML = '';
});

// ─── Expose globals ───────────────────────────────────────────────────────────
window.historyInit     = historyInit;
window.historyFilter   = historyFilter;
window.historyLoadMore = historyLoadMore;

console.log('[HISTORY] Module loaded — Arc Testnet', HIST_CHAIN_ID);
