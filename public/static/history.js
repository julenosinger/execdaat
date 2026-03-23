// ============================================================
// HISTORY MODULE — ARC AI Agents  v2 (Real On-Chain)
// Fetches real transaction history from Arc Testnet via RPC
// Arc Testnet (chainId 5042002) | ethers.js v6
// ============================================================
'use strict';

const HIST_EXPLORER   = 'https://testnet.arcscan.app';
const HIST_RPC        = 'https://rpc.testnet.arc.network';
const HIST_CHAIN_ID   = 5042002;
const HIST_USDC_ADDR  = '0x3600000000000000000000000000000000000000';
const HIST_EURC_ADDR  = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const HIST_CF_ADDR    = '0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A';
const HIST_AMM_ADDR   = '0x3148E2807F172D1cC354F35fB4fC4104e8b6b561';

// ERC-20 Transfer topic keccak256
const HIST_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// Block range to scan (keep small to avoid RPC timeouts)
const HIST_BLOCK_RANGE = 10000;   // ~10k blocks per query
const HIST_MAX_BLOCKS  = 50000;   // total lookback window

// Polling interval in ms (0 = no polling)
const HIST_POLL_MS = 30000; // 30 seconds

let histState = {
  items:       [],
  filter:      'all',
  page:        1,
  perPage:     30,
  loading:     false,
  wallet:      null,
  lastBlock:   0,
  pollTimer:   null,
};

// ─── Helpers ────────────────────────────────────────────────────────────────
function histEl(id)  { return document.getElementById(id); }

function histShort(h, front = 8, back = 6) {
  if (!h) return '—';
  if (h.length <= front + back + 1) return h;
  return h.slice(0, front) + '…' + h.slice(-back);
}

function histFmt(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function histFmtUsdc(n, decimals = 6) {
  try {
    const v = Number(window.ethers.formatUnits(BigInt(n.toString()), decimals));
    if (v === 0)       return '0';
    if (v >= 10000)    return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (v >= 1)        return v.toFixed(2);
    return v.toFixed(4);
  } catch { return '?'; }
}

function histAddr(a) { return (a || '').toLowerCase(); }

// ─── Type metadata ─────────────────────────────────────────────────────────
const HIST_TYPE_META = {
  payment:   { icon: 'fa-dollar-sign',   color: 'text-purple-400', bg: 'bg-purple-900/30', border: 'border-purple-700/30', label: 'Payment'   },
  multisend: { icon: 'fa-paper-plane',   color: 'text-cyan-400',   bg: 'bg-cyan-900/30',   border: 'border-cyan-700/30',   label: 'MultiSend' },
  swap:      { icon: 'fa-exchange-alt',  color: 'text-green-400',  bg: 'bg-green-900/30',  border: 'border-green-700/30',  label: 'Swap'      },
  contract:  { icon: 'fa-file-contract', color: 'text-yellow-400', bg: 'bg-yellow-900/30', border: 'border-yellow-700/30', label: 'Contract'  },
  receive:   { icon: 'fa-arrow-down',    color: 'text-blue-400',   bg: 'bg-blue-900/30',   border: 'border-blue-700/30',   label: 'Received'  },
  send:      { icon: 'fa-arrow-up',      color: 'text-orange-400', bg: 'bg-orange-900/30', border: 'border-orange-700/30', label: 'Sent'      },
};

function histTypeMeta(type) {
  return HIST_TYPE_META[type] || HIST_TYPE_META.send;
}

function histStatusBadge(status) {
  const map = {
    confirmed: 'bg-green-900/30 border-green-700/40 text-green-400',
    failed:    'bg-red-900/30 border-red-700/40 text-red-400',
    pending:   'bg-yellow-900/30 border-yellow-700/40 text-yellow-400',
    partial:   'bg-orange-900/30 border-orange-700/40 text-orange-400',
  };
  const icons = { confirmed: '✓', failed: '✗', pending: '⏳', partial: '~' };
  const cls = map[status] || 'bg-gray-700/40 border-gray-600/40 text-gray-400';
  const ico = icons[status] || '—';
  const lbl = status ? status.charAt(0).toUpperCase() + status.slice(1) : '—';
  return `<span class="text-xs px-2 py-0.5 rounded-full border ${cls}">${ico} ${lbl}</span>`;
}

// ─── Classify a transfer event ─────────────────────────────────────────────
function histClassifyTransfer(from, to, wallet) {
  const f = histAddr(from);
  const t = histAddr(to);
  const w = histAddr(wallet);

  if (t === histAddr(HIST_AMM_ADDR) || f === histAddr(HIST_AMM_ADDR)) return 'swap';
  if (t === histAddr(HIST_CF_ADDR))                                    return 'contract';
  if (f === w)                                                          return 'send';
  if (t === w)                                                          return 'receive';
  return 'send';
}

// ─── Fetch ERC-20 Transfer logs in chunks ─────────────────────────────────
async function histFetchLogsChunked(provider, tokenAddr, wallet, latestBlock) {
  const fromBlock = Math.max(0, latestBlock - HIST_MAX_BLOCKS);
  const items     = [];

  // We scan in chunks to avoid RPC range limits
  for (let start = fromBlock; start <= latestBlock; start += HIST_BLOCK_RANGE) {
    const end = Math.min(start + HIST_BLOCK_RANGE - 1, latestBlock);
    const walletTopic = '0x' + wallet.slice(2).toLowerCase().padStart(64, '0');

    // Sent logs
    try {
      const sentLogs = await provider.getLogs({
        address:   tokenAddr,
        topics:    [HIST_TRANSFER_TOPIC, walletTopic, null],
        fromBlock: start,
        toBlock:   end,
      });
      items.push(...sentLogs);
    } catch (e) {
      console.warn(`[HISTORY] getLogs sent chunk ${start}-${end} failed:`, e.message);
    }

    // Received logs
    try {
      const rcvdLogs = await provider.getLogs({
        address:   tokenAddr,
        topics:    [HIST_TRANSFER_TOPIC, null, walletTopic],
        fromBlock: start,
        toBlock:   end,
      });
      items.push(...rcvdLogs);
    } catch (e) {
      console.warn(`[HISTORY] getLogs rcvd chunk ${start}-${end} failed:`, e.message);
    }
  }

  return items;
}

// ─── Decode a Transfer log ─────────────────────────────────────────────────
function histDecodeTransferLog(log, token, wallet) {
  try {
    const from  = '0x' + log.topics[1].slice(26);
    const to    = '0x' + log.topics[2].slice(26);
    const value = BigInt(log.data);
    const amt   = histFmtUsdc(value, 6);
    const type  = histClassifyTransfer(from, to, wallet);

    return {
      id:       log.transactionHash + '_' + log.logIndex,
      txHash:   log.transactionHash,
      blockNum: typeof log.blockNumber === 'number' ? log.blockNumber : parseInt(log.blockNumber, 16),
      ts:       0,  // filled later from block
      type,
      token,
      tokenAddr: log.address,
      amount:   amt,
      amountRaw: value.toString(),
      from,
      to,
      status:   'confirmed',
    };
  } catch (e) {
    console.warn('[HISTORY] Decode error:', e.message, log);
    return null;
  }
}

// ─── Fetch block timestamps in batches ─────────────────────────────────────
async function histFetchBlockTimestamps(provider, blockNums) {
  const ts = {};
  const unique = [...new Set(blockNums)].filter(Boolean);

  // Batch in groups of 10
  for (let i = 0; i < unique.length; i += 10) {
    const batch = unique.slice(i, i + 10);
    await Promise.all(batch.map(async bn => {
      try {
        const blk = await provider.getBlock(bn);
        if (blk) ts[bn] = blk.timestamp;
      } catch (_) {}
    }));
  }
  return ts;
}

// ─── Fetch Transfer events for wallet (USDC + EURC) ───────────────────────
async function histFetchTransfers(wallet, provider, latestBlock) {
  const items = [];
  const tokens = [
    { addr: HIST_USDC_ADDR, symbol: 'USDC' },
    { addr: HIST_EURC_ADDR, symbol: 'EURC' },
  ];

  for (const tok of tokens) {
    const logs = await histFetchLogsChunked(provider, tok.addr, wallet, latestBlock);
    for (const log of logs) {
      const item = histDecodeTransferLog(log, tok.symbol, wallet);
      if (item) items.push(item);
    }
  }

  // Fill timestamps
  const blockNums = [...new Set(items.map(i => i.blockNum))];
  const ts        = await histFetchBlockTimestamps(provider, blockNums);
  items.forEach(item => { if (ts[item.blockNum]) item.ts = ts[item.blockNum]; });

  return items;
}

// ─── Fetch AMM Swap events ─────────────────────────────────────────────────
async function histFetchSwaps(wallet, provider, latestBlock) {
  const items     = [];
  const fromBlock = Math.max(0, latestBlock - HIST_MAX_BLOCKS);

  // Try event-based first
  try {
    const ammInterface = new window.ethers.Interface([
      'event Swap(address indexed user, bool usdcToEurc, uint256 amountIn, uint256 amountOut, uint256 fee, uint256 timestamp)',
    ]);
    const walletTopic  = '0x' + wallet.slice(2).toLowerCase().padStart(64, '0');

    for (let start = fromBlock; start <= latestBlock; start += HIST_BLOCK_RANGE) {
      const end = Math.min(start + HIST_BLOCK_RANGE - 1, latestBlock);
      try {
        const logs = await provider.getLogs({
          address:   HIST_AMM_ADDR,
          topics:    [window.ethers.id('Swap(address,bool,uint256,uint256,uint256,uint256)'), walletTopic],
          fromBlock: start,
          toBlock:   end,
        });

        for (const log of logs) {
          try {
            const decoded = ammInterface.parseLog(log);
            if (!decoded) continue;
            const dir    = decoded.args[1]; // usdcToEurc
            const amtIn  = histFmtUsdc(decoded.args[2], 6);
            const amtOut = histFmtUsdc(decoded.args[3], 6);
            const blk    = typeof log.blockNumber === 'number' ? log.blockNumber : parseInt(log.blockNumber, 16);

            items.push({
              id:       log.transactionHash + '_swap_' + log.logIndex,
              txHash:   log.transactionHash,
              blockNum: blk,
              ts:       0,
              type:     'swap',
              token:    dir ? 'USDC→EURC' : 'EURC→USDC',
              amount:   `${amtIn} → ${amtOut}`,
              amountIn,
              amountOut,
              from:     wallet,
              to:       HIST_AMM_ADDR,
              status:   'confirmed',
            });
          } catch (_) {}
        }
      } catch (e) {
        console.warn('[HISTORY] AMM logs chunk error:', e.message);
      }
    }

    // Fill timestamps
    const blockNums = [...new Set(items.map(i => i.blockNum))];
    const ts        = await histFetchBlockTimestamps(provider, blockNums);
    items.forEach(item => { if (ts[item.blockNum]) item.ts = ts[item.blockNum]; });
  } catch (err) {
    console.warn('[HISTORY] Swap fetch error:', err.message);
  }

  return items;
}

// ─── Merge in-memory multisend receipts ───────────────────────────────────
function histMergeReceipts() {
  if (!window.msReceipts || !window.msReceipts.length) return [];
  return window.msReceipts.map(r => ({
    id:           r.id + '_ms',
    txHash:       r.txHash,
    blockNum:     0,
    ts:           Math.floor(new Date(r.timestamp).getTime() / 1000),
    type:         'multisend',
    token:        r.token || 'USDC',
    amount:       `$${r.totalAmount} (${r.count} recipients)`,
    from:         r.from,
    to:           `${r.count} recipients`,
    status:       r.status === 'confirmed' ? 'confirmed' : 'partial',
    batchDetails: r,       // carry full receipt for expansion
    receiptId:    r.id,    // for PDF re-download
  }));
}

// ─── Group consecutive sends to same batch (multisend detection) ───────────
function histGroupMultisend(items) {
  // Look for wallet transfers where >2 outgoing sends happen within ~30s
  // and the fee wallet (MS_FEE_WALLET) received a transfer in the same ~30s window
  const sends = items.filter(i => i.type === 'send' && i.token === 'USDC');
  if (sends.length < 3) return items;

  // Sort by ts
  const sorted = [...sends].sort((a, b) => (a.ts || 0) - (b.ts || 0));

  // Sliding window: group sends within 60s of each other
  const groups = [];
  let group    = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const diff = Math.abs((curr.ts || 0) - (prev.ts || 0));
    if (diff <= 60) {
      group.push(curr);
    } else {
      if (group.length > 0) groups.push(group);
      group = [curr];
    }
  }
  if (group.length > 0) groups.push(group);

  // For groups of 3+ sends with a fee-wallet send, mark as multisend
  const multisendIds = new Set();
  for (const grp of groups) {
    if (grp.length >= 3) {
      const minTs = Math.min(...grp.map(i => i.ts || Infinity));
      const maxTs = Math.max(...grp.map(i => i.ts || 0));
      // Check if there's a fee-wallet transfer in this window
      const hasFee = items.some(it =>
        it.type === 'send' &&
        histAddr(it.to) === histAddr(HIST_CF_ADDR) &&
        (it.ts || 0) >= minTs - 10 &&
        (it.ts || 0) <= maxTs + 10
      );
      if (hasFee) {
        grp.forEach(i => multisendIds.add(i.id));
        // Add a synthetic multisend summary
        const totalRaw = grp.reduce((s, i) => {
          const v = parseFloat(i.amount) || 0;
          return s + v;
        }, 0);
        items.push({
          id:       'ms-grp-' + grp[0].txHash,
          txHash:   grp[0].txHash,
          blockNum: grp[0].blockNum,
          ts:       grp[0].ts,
          type:     'multisend',
          token:    'USDC',
          amount:   `$${totalRaw.toFixed(2)} (${grp.length} recipients)`,
          from:     grp[0].from,
          to:       `${grp.length} recipients`,
          status:   'confirmed',
          children: grp,
        });
      }
    }
  }

  // Filter out individual sends that are part of a multisend group
  // but only if we found actual multisend groups
  if (multisendIds.size > 0) {
    return items.filter(i => !multisendIds.has(i.id));
  }
  return items;
}

// ─── Main load ───────────────────────────────────────────────────────────────
async function historyInit() {
  const wallet = window.walletState?.address;

  const gateEl    = histEl('history-wallet-gate');
  const loadEl    = histEl('history-loading');
  const listEl    = histEl('history-list');
  const emptyEl   = histEl('history-empty');
  const loadMoreEl= histEl('history-load-more');

  if (!wallet) {
    if (gateEl)  gateEl.classList.remove('hidden');
    if (loadEl)  loadEl.classList.add('hidden');
    if (listEl)  listEl.innerHTML = '';
    if (emptyEl) emptyEl.classList.add('hidden');
    return;
  }

  if (histState.loading) return;  // prevent concurrent loads

  if (gateEl)     gateEl.classList.add('hidden');
  if (emptyEl)    emptyEl.classList.add('hidden');
  if (loadMoreEl) loadMoreEl.classList.add('hidden');

  histState.wallet  = wallet;
  histState.page    = 1;

  // — Phase 1: Show cached data immediately (instant feedback) —
  await histLoadCached(wallet, listEl, loadEl);

  // — Phase 2: Fetch on-chain data in background —
  if (histState.loading) return;
  histState.loading = true;
  if (loadEl) loadEl.classList.remove('hidden');

  try {
    const ethersLib = window.ethers;
    if (!ethersLib) throw new Error('ethers.js not loaded');

    const provider   = new ethersLib.JsonRpcProvider(HIST_RPC);
    const latestBlock = await provider.getBlockNumber();
    histState.lastBlock = latestBlock;

    // Fetch transfers and swaps in parallel
    const [transfers, swaps] = await Promise.all([
      histFetchTransfers(wallet, provider, latestBlock),
      histFetchSwaps(wallet, provider, latestBlock),
    ]);

    // In-memory receipts from session
    const receipts = histMergeReceipts();

    // Also load from persistence layer
    const localItems = await histLoadFromPersistence(wallet);

    // Merge, deduplicate
    const seen = new Set();
    let all    = [...transfers, ...swaps, ...receipts, ...localItems].filter(item => {
      const key = item.id || (item.txHash + '_' + item.type);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Try to detect multisend groups from on-chain sends
    all = histGroupMultisend(all);

    // Sort newest first
    all.sort((a, b) => (b.ts || b._savedAtMs || 0) - (a.ts || a._savedAtMs || 0));
    histState.items = all;

    // Save new on-chain items to persistence
    if (typeof arcSave === 'function') {
      const onChainItems = [...transfers, ...swaps];
      for (const item of onChainItems.slice(0, 50)) {
        arcSave(window.ARC_STORE_HIST || 'history', {
          ...item,
          wallet: wallet.toLowerCase(),
          _source: 'onchain',
          _savedAtMs: Date.now(),
        }).catch(() => {});
      }
    }

  } catch (err) {
    console.error('[HISTORY] Load error:', err);
    const msg = err.message || String(err);
    // If we already have cached data shown, just warn
    if (histState.items.length > 0) {
      const listEl2 = histEl('history-list');
      if (listEl2 && !listEl2.querySelector('.hist-offline-bar')) {
        const bar = document.createElement('div');
        bar.className = 'hist-offline-bar';
        bar.style.cssText = 'background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.18);border-radius:8px;padding:7px 12px;margin-bottom:8px;font-size:11px;color:#fbbf24;display:flex;align-items:center;gap:6px;';
        bar.innerHTML = '<i class="fas fa-database"></i> Exibindo dados em cache — sincronização on-chain falhou. <button onclick="historyInit()" style="margin-left:auto;background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.3);color:#fbbf24;padding:2px 10px;border-radius:6px;cursor:pointer;font-size:10px;">Tentar novamente</button>';
        listEl2.insertBefore(bar, listEl2.firstChild);
      }
    } else {
      showToast('History load error: ' + msg, 'error');
    }
  } finally {
    histState.loading = false;
    if (loadEl) loadEl.classList.add('hidden');
    histRender();
    histStartPolling();
  }
}

// ─── Load cached data from persistence layer ──────────────────────────────────
async function histLoadCached(wallet, listEl, loadEl) {
  if (typeof arcLoad !== 'function') return;

  try {
    const [histItems, payItems, cfItems] = await Promise.all([
      arcLoad(window.ARC_STORE_HIST || 'history'),
      arcLoad(window.ARC_STORE_PAY  || 'payments'),
      arcLoad(window.ARC_STORE_CF   || 'contracts'),
    ]);

    // Convert payment records to history-compatible format
    const payAsHist = payItems
      .filter(p => p.status === 'completed' || p.status === 'confirmed')
      .map(p => ({
        id:       p.id,
        txHash:   p.txHash || null,
        blockNum: 0,
        ts:       p.timestamp ? Math.floor(new Date(p.timestamp).getTime() / 1000) : 0,
        _savedAtMs: p.timestamp ? new Date(p.timestamp).getTime() : 0,
        type:     'payment',
        token:    p.token || 'USDC',
        amount:   p.amount ? Number(p.amount).toFixed(4) : '0',
        from:     p.sender || p.from || wallet,
        to:       p.recipient || '—',
        status:   p.status || 'confirmed',
        _source:  p._source || 'local',
        _payData: p,
      }));

    // Convert contract TX records to history-compatible format
    const cfAsHist = cfItems
      .filter(c => c.txHash && c.type === 'contract')
      .map(c => ({
        id:       c.id,
        txHash:   c.txHash,
        blockNum: 0,
        ts:       c.timestamp ? Math.floor(new Date(c.timestamp).getTime() / 1000) : 0,
        _savedAtMs: c.timestamp ? new Date(c.timestamp).getTime() : 0,
        type:     'contract',
        token:    'USDC',
        amount:   c.amount || '—',
        from:     c.wallet || wallet,
        to:       c.contractId ? 'Contract #' + c.contractId : '—',
        status:   c.status || 'confirmed',
        _source:  'local',
      }));

    const allCached = [...histItems, ...payAsHist, ...cfAsHist];
    if (allCached.length === 0) return;

    // Deduplicate
    const seen = new Set();
    const deduped = allCached.filter(item => {
      const key = item.id || (item.txHash + '_' + item.type);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    deduped.sort((a, b) => (b.ts || b._savedAtMs || 0) - (a.ts || a._savedAtMs || 0));
    histState.items = deduped;

    // Show immediately with "Cached" indicator
    if (loadEl) loadEl.classList.add('hidden');
    histRender();

    // Add cache indicator to list
    if (listEl && deduped.length > 0) {
      const existing = listEl.querySelector('.hist-cache-bar');
      if (!existing) {
        const bar = document.createElement('div');
        bar.className = 'hist-cache-bar';
        bar.style.cssText = 'background:rgba(55,138,221,0.04);border:1px solid rgba(55,138,221,0.12);border-radius:8px;padding:6px 12px;margin-bottom:8px;font-size:10px;color:#8aaac8;display:flex;align-items:center;gap:6px;';
        bar.innerHTML = '<i class="fas fa-database" style="color:#60b4ff;"></i> Carregando dados em cache... Sincronizando blockchain em segundo plano.';
        listEl.insertBefore(bar, listEl.firstChild);
        // Remove after full sync completes
        setTimeout(() => { if (bar.parentNode) bar.remove(); }, 10000);
      }
    }

    console.log('[HISTORY] Cached data shown immediately:', deduped.length, 'items');
  } catch (e) {
    console.warn('[HISTORY] Cache load error:', e.message);
  }
}

// ─── Load items from persistence for merging ──────────────────────────────────
async function histLoadFromPersistence(wallet) {
  if (typeof arcLoad !== 'function') return [];
  try {
    const stored = await arcLoad(window.ARC_STORE_HIST || 'history');
    // Filter to only items with txHash that we haven't seen on-chain
    return stored.filter(s => s.txHash).map(s => ({
      ...s,
      _source: s._source || 'local',
    }));
  } catch (_) { return []; }
}

// ─── Incremental refresh (new blocks only) ────────────────────────────────
async function histRefreshNew() {
  const wallet = histState.wallet;
  if (!wallet || histState.loading) return;

  try {
    const ethersLib = window.ethers;
    if (!ethersLib) return;

    const provider    = new ethersLib.JsonRpcProvider(HIST_RPC);
    const latestBlock = await provider.getBlockNumber();

    if (latestBlock <= histState.lastBlock) return; // no new blocks

    const fromBlock = histState.lastBlock + 1;
    histState.lastBlock = latestBlock;

    // Only fetch new range
    const tokens = [
      { addr: HIST_USDC_ADDR, symbol: 'USDC' },
      { addr: HIST_EURC_ADDR, symbol: 'EURC' },
    ];
    const newItems = [];

    for (const tok of tokens) {
      try {
        const walletTopic = '0x' + wallet.slice(2).toLowerCase().padStart(64, '0');
        const [sentLogs, rcvdLogs] = await Promise.all([
          provider.getLogs({ address: tok.addr, topics: [HIST_TRANSFER_TOPIC, walletTopic, null], fromBlock, toBlock: latestBlock }),
          provider.getLogs({ address: tok.addr, topics: [HIST_TRANSFER_TOPIC, null, walletTopic], fromBlock, toBlock: latestBlock }),
        ]);
        for (const log of [...sentLogs, ...rcvdLogs]) {
          const item = histDecodeTransferLog(log, tok.symbol, wallet);
          if (item) newItems.push(item);
        }
      } catch (_) {}
    }

    if (!newItems.length) return;

    // Fill timestamps
    const blockNums = [...new Set(newItems.map(i => i.blockNum))];
    const ts        = await histFetchBlockTimestamps(provider, blockNums);
    newItems.forEach(item => { if (ts[item.blockNum]) item.ts = ts[item.blockNum]; });

    // Deduplicate and prepend
    const existingIds = new Set(histState.items.map(i => i.id));
    const fresh = newItems.filter(i => !existingIds.has(i.id));
    if (!fresh.length) return;

    histState.items = [...fresh, ...histState.items];
    histState.items.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    histRender();
    showToast(`${fresh.length} new transaction${fresh.length > 1 ? 's' : ''} found.`, 'info');
  } catch (e) {
    console.warn('[HISTORY] Refresh error:', e.message);
  }
}

// ─── Polling ─────────────────────────────────────────────────────────────────
function histStartPolling() {
  histStopPolling();
  if (HIST_POLL_MS <= 0) return;
  const badge = document.getElementById('history-poll-badge');
  if (badge) badge.classList.remove('hidden');
  histState.pollTimer = setInterval(() => {
    if (document.getElementById('tab-content-history')?.classList.contains('hidden') === false) {
      histRefreshNew();
    }
  }, HIST_POLL_MS);
}

function histStopPolling() {
  if (histState.pollTimer) {
    clearInterval(histState.pollTimer);
    histState.pollTimer = null;
  }
  const badge = document.getElementById('history-poll-badge');
  if (badge) badge.classList.add('hidden');
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

// ─── Render row for a single transaction ─────────────────────────────────────
function histRenderRow(item, wallet) {
  const meta   = histTypeMeta(item.type);
  const isSelf = histAddr(item.from) === histAddr(wallet || '');
  const dir    = isSelf ? '↑' : '↓';
  const dirCls = isSelf ? 'text-orange-400' : 'text-blue-400';

  // Children (multisend group) expandable
  const childrenHtml = item.children?.length ? `
    <details class="mt-2 col-span-full">
      <summary class="text-xs text-gray-600 hover:text-gray-400 cursor-pointer select-none flex items-center gap-1">
        <i class="fas fa-users text-[10px]"></i>
        ${item.children.length} individual transfers — expand
        <i class="fas fa-chevron-down text-[9px] ml-1"></i>
      </summary>
      <div class="mt-1.5 space-y-1 max-h-48 overflow-y-auto pl-2">
        ${item.children.map(c => `
          <div class="flex items-center gap-2 text-[11px] py-1 border-b border-gray-700/20 last:border-0">
            <span class="font-mono text-gray-500">${histShort(c.to)}</span>
            <span class="text-cyan-400 ml-auto">$${c.amount}</span>
            ${c.txHash ? `<a href="${HIST_EXPLORER}/tx/${c.txHash}" target="_blank" class="text-blue-400 hover:underline text-[10px]"><i class="fas fa-external-link-alt"></i></a>` : ''}
          </div>`).join('')}
      </div>
    </details>` : '';

  // Batch details (in-memory multisend receipt)
  const bd = item.batchDetails;
  const batchHtml = bd ? `
    <div class="mt-2">
      <div class="flex items-center gap-2 mb-1.5">
        <span class="text-xs text-gray-500">Batch: <span class="text-yellow-400 font-mono">${bd.batchId}</span></span>
        <span class="text-xs text-gray-600">·</span>
        <span class="text-xs text-gray-500">Fee: <span class="text-yellow-300">$${bd.fee} USDC</span></span>
        ${bd.feeTxHash ? `<a href="${HIST_EXPLORER}/tx/${bd.feeTxHash}" target="_blank" class="text-yellow-400 text-[10px] hover:underline"><i class="fas fa-external-link-alt"></i> fee tx</a>` : ''}
        <button onclick="if(typeof msPdfReceipt==='function') msPdfReceipt('${bd.id}')"
          class="ml-auto flex items-center gap-1 px-2 py-0.5 bg-blue-800/40 hover:bg-blue-700/50 border border-blue-700/40 text-blue-300 text-[10px] rounded-lg transition">
          <i class="fas fa-file-pdf text-[9px]"></i>${bd.pdfGenerated ? 'Re-download PDF' : 'Download PDF'}
        </button>
      </div>
      <details>
        <summary class="text-xs text-gray-600 hover:text-gray-400 cursor-pointer select-none flex items-center gap-1 py-0.5">
          <i class="fas fa-list-ul text-[10px]"></i>
          ${bd.count} recipients — expand
          <i class="fas fa-chevron-down text-[9px] ml-1"></i>
        </summary>
        <div class="mt-1.5 space-y-0.5 max-h-48 overflow-y-auto pl-2">
          ${(bd.recipients || []).map(p => `
            <div class="flex items-center gap-2 text-[11px] py-1 border-b border-gray-700/20 last:border-0">
              <span class="font-mono text-gray-500 flex-1 truncate">${histShort(p.address)}</span>
              <span class="text-cyan-400">$${p.amount}</span>
              <span class="${p.status === 'confirmed' ? 'text-green-400' : p.status === 'failed' ? 'text-red-400' : 'text-yellow-400'} text-[10px]">${p.status}</span>
              ${p.txHash ? `<a href="${HIST_EXPLORER}/tx/${p.txHash}" target="_blank" class="text-blue-400 hover:underline text-[10px] ml-auto"><i class="fas fa-external-link-alt"></i></a>` : ''}
            </div>`).join('')}
        </div>
      </details>
    </div>` : '';

  return `
  <div class="history-tx-row bg-gray-900/60 border border-gray-700/40 rounded-xl px-4 py-3 hover:bg-gray-900/80 transition-colors">
    <div class="flex flex-wrap sm:flex-nowrap items-start gap-3">
      <!-- Icon -->
      <div class="w-9 h-9 rounded-xl ${meta.bg} border ${meta.border} flex items-center justify-center flex-shrink-0 mt-0.5">
        <i class="fas ${meta.icon} ${meta.color} text-sm"></i>
      </div>

      <!-- Info -->
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 flex-wrap mb-0.5">
          <span class="text-white font-semibold text-sm">${meta.label}</span>
          <span class="text-xs font-mono ${meta.color}">${item.token}</span>
          ${histStatusBadge(item.status)}
        </div>
        <div class="text-xs text-gray-500 flex items-center gap-1.5 flex-wrap">
          <span class="${dirCls}">${dir}</span>
          <span class="font-mono">${histShort(item.from)}</span>
          <span class="text-gray-700">→</span>
          <span class="font-mono">${histShort(item.to)}</span>
          ${item.ts ? `<span class="text-gray-600">· ${histFmt(item.ts)}</span>` : ''}
          ${item.blockNum ? `<span class="text-gray-700">· #${item.blockNum}</span>` : ''}
        </div>
        ${childrenHtml}
        ${batchHtml}
      </div>

      <!-- Amount + Tx -->
      <div class="text-right flex-shrink-0 min-w-[80px]">
        <div class="text-white font-bold text-sm mb-0.5">${item.amount}</div>
        ${item.txHash ? `
        <a href="${HIST_EXPLORER}/tx/${item.txHash}" target="_blank" rel="noopener"
          class="text-[11px] text-blue-400 hover:text-blue-300 hover:underline font-mono flex items-center gap-1 justify-end">
          ${item.txHash.slice(0, 10)}… <i class="fas fa-external-link-alt text-[9px]"></i>
        </a>` : '<div class="text-xs text-gray-600">—</div>'}
      </div>
    </div>
  </div>`;
}

// ─── Render all ──────────────────────────────────────────────────────────────
function histRender() {
  const listEl     = histEl('history-list');
  const emptyEl    = histEl('history-empty');
  const loadMoreEl = histEl('history-load-more');
  const countEl    = histEl('history-count');
  if (!listEl) return;

  const wallet   = histState.wallet;
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

  if (countEl) countEl.textContent = filtered.length + ' transaction' + (filtered.length !== 1 ? 's' : '');

  if (!filtered.length) {
    if (emptyEl) {
      // Only show empty state if we have no cached data either
      if (!histState.items.length) {
        emptyEl.classList.remove('hidden');
        listEl.innerHTML = '';
      }
    }
    if (loadMoreEl) loadMoreEl.classList.add('hidden');
    return;
  }

  if (emptyEl) emptyEl.classList.add('hidden');

  const pageSize = histState.perPage * histState.page;
  const visible  = filtered.slice(0, pageSize);
  const hasMore  = filtered.length > pageSize;

  if (loadMoreEl) loadMoreEl.classList.toggle('hidden', !hasMore);

  listEl.innerHTML = visible.map(item => histRenderRow(item, wallet)).join('');
}

// ─── Background sync handler ─────────────────────────────────────────────────
window.addEventListener('arcSyncRequest', () => {
  if (!histState.wallet) return;
  const tabEl = document.getElementById('tab-content-history');
  if (tabEl && !tabEl.classList.contains('hidden')) {
    histRefreshNew();
  }
});

// ─── Wallet events ───────────────────────────────────────────────────────────
window.addEventListener('walletConnected', () => {
  // Only refresh if the history tab is currently visible
  if (histEl('tab-content-history')?.classList.contains('hidden') === false) {
    historyInit();
  }
});

window.addEventListener('walletDisconnected', () => {
  histStopPolling();
  histState.items  = [];
  histState.wallet = null;
  histState.page   = 1;

  const gateEl = histEl('history-wallet-gate');
  const listEl = histEl('history-list');
  const emptyEl= histEl('history-empty');
  if (gateEl)  gateEl.classList.remove('hidden');
  if (listEl)  listEl.innerHTML = '';
  if (emptyEl) emptyEl.classList.add('hidden');
});

// ─── Expose globals ───────────────────────────────────────────────────────────
window.historyInit       = historyInit;
window.historyFilter     = historyFilter;
window.historyLoadMore   = historyLoadMore;
window.histRefreshNew    = histRefreshNew;
window.histLoadCached    = histLoadCached;
window.histLoadFromPersistence = histLoadFromPersistence;

console.log('[HISTORY] Module v2 loaded — Arc Testnet', HIST_CHAIN_ID, '| RPC:', HIST_RPC, '| Hybrid Persistence: IndexedDB + localStorage');
