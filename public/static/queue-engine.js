// build:v2-20260627-151358
// ============================================================
// QUEUE ENGINE v1 — ExecDaat
//
// Real on-chain execution engine for queued payments.
// Connects CSV / chat queue → Permit2 validation → Multicall3 batch.
//
// Flow:
//   1. User uploads CSV (via chat or multisend)
//   2. Queue panel shows recipients + totals
//   3. User clicks "🚀 Execute Queue"
//   4. Engine validates: wallet, balance, permit2
//   5. Loads rows into msValidatedRows
//   6. Calls msExecute() — real on-chain Multicall3
//   7. Per-row status: pending → processing → success/failed
//   8. Summary receipt shown
//
// No axios. No API calls. Direct blockchain only.
// ============================================================
'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const QE_VERSION       = '20260402a';
const QE_STORAGE_KEY   = 'execDaat_queue';
const QE_HISTORY_KEY   = 'execDaat_queueHistory';
const QE_USDC_ADDR     = '0x3600000000000000000000000000000000000000';
const QE_EURC_ADDR     = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const QE_RPC           = 'https://rpc.testnet.arc.network';
const QE_CHAIN_ID      = 5042002;
const QE_EXPLORER      = 'https://testnet.arcscan.app';
const QE_ERC20_ABI     = [
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
];
const QE_MULTICALL3    = '0xcA11bde05977b3631167028862bE2a173976CA11';

// ─── State ────────────────────────────────────────────────────────────────────
let _qeQueue         = [];   // [{ id, address, amount, token, note, status, txHash, error }]
let _qeExecuting     = false;
let _qePermit2Valid  = false;
let _qeRendered      = false;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _qeLog(...a)  { console.log('%c[QUEUE-ENGINE v1]', 'color:#4ade80;font-weight:bold', ...a); }
function _qeWarn(...a) { console.warn('[QUEUE-ENGINE v1]', ...a); }
function _qeErr(...a)  { console.error('[QUEUE-ENGINE v1]', ...a); }
function _qeEl(id)     { return document.getElementById(id); }
function _qeFmt(n)     { return Number(n || 0).toFixed(2); }
function _qeShort(h)   { return h ? h.slice(0,10)+'…'+h.slice(-6) : '—'; }
function _qeIsAddr(a)  { return /^0x[0-9a-fA-F]{40}$/.test(String(a||'').trim()); }
function _qeToast(msg, type='info') {
  if (typeof showToast === 'function') showToast(msg, type);
  else console.log('[QE toast]', type, msg);
}

// ─── Queue Storage ────────────────────────────────────────────────────────────
function qeSaveQueue() {
  try { localStorage.setItem(QE_STORAGE_KEY, JSON.stringify(_qeQueue)); } catch(e) {}
}

function qeLoadQueue() {
  try {
    const raw = localStorage.getItem(QE_STORAGE_KEY);
    if (raw) _qeQueue = JSON.parse(raw);
  } catch(e) { _qeQueue = []; }
}

function qeClearQueue() {
  _qeQueue = [];
  qeSaveQueue();
  qeRenderPanel();
  _qeToast('Queue cleared', 'info');
}

// ─── Load rows from CSV state (chat) or direct array ─────────────────────────
function qeLoadFromCSV(rows, token = 'USDC') {
  if (!Array.isArray(rows) || !rows.length) return 0;
  let added = 0;
  rows.forEach((r, idx) => {
    const addr = String(r.address || r.to || r.wallet || r.recipient || '').trim();
    const amt  = parseFloat(String(r.amount || r.value || 0).replace(',', '.'));
    if (!_qeIsAddr(addr) || isNaN(amt) || amt <= 0) return;
    _qeQueue.push({
      id:      `q-${Date.now()}-${idx}`,
      address: addr,
      amount:  amt,
      token:   (r.token || token || 'USDC').toUpperCase(),
      note:    r.note || r.description || r.memo || '',
      status:  'pending',
      txHash:  null,
      error:   null,
    });
    added++;
  });
  qeSaveQueue();
  qeRenderPanel();
  return added;
}

// ─── Sync from chatCSVState on open ──────────────────────────────────────────
function qeSyncFromChatCSV() {
  const csv = window.chatCSVState;
  if (!csv?.loaded || !csv?.rows?.length) return 0;
  // Only add rows not already in queue (compare by address+amount)
  const existing = new Set(_qeQueue.map(q => `${q.address}:${q.amount}`));
  let added = 0;
  csv.rows.forEach((r, idx) => {
    const addr = String(r.address || r.to || r.wallet || r.recipient || '').trim();
    const amt  = parseFloat(String(r.amount || r.value || 0).replace(',', '.'));
    if (!_qeIsAddr(addr) || isNaN(amt) || amt <= 0) return;
    const key = `${addr}:${amt}`;
    if (existing.has(key)) return;
    _qeQueue.push({
      id:      `qcsv-${Date.now()}-${idx}`,
      address: addr,
      amount:  amt,
      token:   (r.token || csv.token || 'USDC').toUpperCase(),
      note:    r.note || r.description || '',
      status:  'pending',
      txHash:  null,
      error:   null,
    });
    existing.add(key);
    added++;
  });
  if (added > 0) { qeSaveQueue(); qeRenderPanel(); }
  return added;
}

// ─── Update single row status ─────────────────────────────────────────────────
function qeUpdateStatus(id, status, txHashOrError) {
  const row = _qeQueue.find(r => r.id === id);
  if (!row) return;
  row.status = status;
  if (status === 'success') row.txHash = txHashOrError || null;
  if (status === 'failed')  row.error  = txHashOrError || 'Unknown error';
  qeSaveQueue();
  _qeRenderRow(id);
  _qeUpdateSummary();
}

function _qeRenderRow(id) {
  const row = _qeQueue.find(r => r.id === id);
  if (!row) return;
  const el = _qeEl(`qe-row-${id}`);
  if (!el) { qeRenderPanel(); return; }
  const badge = _qeStatusBadge(row.status);
  const txLink = row.txHash
    ? `<a href="${QE_EXPLORER}/tx/${row.txHash}" target="_blank"
         class="text-green-400 font-mono text-[10px] underline">${_qeShort(row.txHash)}</a>`
    : (row.error ? `<span class="text-red-400 text-[10px]">${row.error.slice(0,40)}</span>` : '');
  const statusEl = el.querySelector('.qe-row-status');
  if (statusEl) statusEl.innerHTML = badge + ' ' + txLink;
}

function _qeStatusBadge(status) {
  const map = {
    pending:    '<span class="inline-flex items-center gap-1 text-[10px] px-2.5 py-0.5 rounded-full bg-gray-800/40 border border-gray-700/40 text-gray-400"><i class="fas fa-clock text-[9px]"></i>Pending</span>',
    processing: '<span class="inline-flex items-center gap-1 text-[10px] px-2.5 py-0.5 rounded-full bg-yellow-950/40 border border-yellow-700/30 text-yellow-300 animate-pulse"><i class="fas fa-spinner fa-spin text-[9px]"></i>Processing</span>',
    success:    '<span class="inline-flex items-center gap-1 text-[10px] px-2.5 py-0.5 rounded-full bg-green-950/40 border border-green-700/30 text-green-400"><i class="fas fa-circle-check text-[9px]"></i>Success</span>',
    failed:     '<span class="inline-flex items-center gap-1 text-[10px] px-2.5 py-0.5 rounded-full bg-red-950/40 border border-red-700/30 text-red-400"><i class="fas fa-circle-xmark text-[9px]"></i>Failed</span>',
  };
  return map[status] || map.pending;
}

function _qeUpdateSummary() {
  const total      = _qeQueue.length;
  const success    = _qeQueue.filter(r => r.status === 'success').length;
  const failed     = _qeQueue.filter(r => r.status === 'failed').length;
  const processing = _qeQueue.filter(r => r.status === 'processing').length;
  const pending    = _qeQueue.filter(r => r.status === 'pending').length;

  const s = (id, v) => { const e = _qeEl(id); if (e) e.textContent = v; };
  s('qe-stat-total',   total);
  s('qe-stat-pending', pending);
  s('qe-stat-ok',      success);
  s('qe-stat-fail',    failed);

  const progEl = _qeEl('qe-progress-bar');
  if (progEl && total > 0) {
    const pct = Math.round(((success + failed) / total) * 100);
    progEl.style.width = pct + '%';
    progEl.className = failed > 0
      ? 'h-full rounded-full transition-all bg-gradient-to-r from-green-500 to-red-500'
      : 'h-full rounded-full transition-all bg-gradient-to-r from-green-500 to-emerald-400';
  }

  _qeUpdateExecBtn();
}

function _qeUpdateExecBtn() {
  const btn     = _qeEl('qe-exec-btn');
  const chunkBtn = _qeEl('qe-chunk-btn');
  if (!btn) return;

  const walletOk  = !!window.walletState?.connected;
  const hasRows   = _qeQueue.filter(r => r.status === 'pending').length > 0;
  const disabled  = _qeExecuting || !walletOk || !hasRows;

  btn.disabled = disabled;
  btn.className = disabled
    ? 'flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold transition-all bg-gray-700 text-gray-500 cursor-not-allowed opacity-60'
    : 'flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold transition-all bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-400 hover:to-emerald-400 text-white shadow-lg shadow-green-900/40 hover:shadow-green-900/60 hover:scale-[1.02] active:scale-[0.98]';

  if (!_qeExecuting) {
    btn.innerHTML = '<i class="fas fa-rocket mr-1"></i>🚀 Execute Queue';
  }

  if (chunkBtn) {
    chunkBtn.disabled = disabled;
    chunkBtn.className = disabled
      ? 'flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all bg-gray-700 text-gray-500 cursor-not-allowed opacity-60'
      : 'flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all bg-gray-800 hover:bg-gray-700 border border-gray-600 hover:border-green-600/50 text-gray-300 hover:text-green-400';
  }

  // Tooltip reasons
  if (!walletOk) btn.title = 'Connect your wallet first';
  else if (!hasRows) btn.title = 'No pending payments in queue';
  else btn.title = 'Execute all pending payments on-chain';
}

// ─── Render full panel ────────────────────────────────────────────────────────
function qeRenderPanel() {
  const container = _qeEl('qe-rows-container');
  if (!container) return;

  const pending = _qeQueue.filter(r => r.status === 'pending');
  const done    = _qeQueue.filter(r => r.status !== 'pending');

  if (!_qeQueue.length) {
    container.innerHTML = `
      <div class="flex flex-col items-center gap-4 py-12 text-center">
        <div class="w-14 h-14 rounded-2xl bg-gradient-to-br from-gray-800/60 to-gray-800/30 border border-gray-700/40 flex items-center justify-center">
          <i class="fas fa-inbox text-gray-500 text-xl"></i>
        </div>
        <div>
          <p class="text-white font-semibold text-sm">No payments in queue</p>
          <p class="text-gray-500 text-xs mt-1">Your automated payments will appear here</p>
        </div>
        <button onclick="qeSyncFromChatCSV(); qeRenderPanel();"
          class="mt-1 flex items-center gap-2 text-xs px-4 py-2.5 bg-gradient-to-r from-rose-900/30 to-rose-800/20 hover:from-rose-800/40 hover:to-rose-700/30 border border-rose-700/30 text-rose-300 hover:text-rose-200 rounded-xl transition-all duration-200">
          <i class="fas fa-sync text-[10px]"></i>Import from Chat CSV
        </button>
      </div>`;
    _qeUpdateSummary();
    return;
  }

  container.innerHTML = _qeQueue.map(row => `
    <div class="flex items-center gap-3 p-3.5 bg-gradient-to-r from-gray-900/50 to-gray-800/30 border border-gray-700/30 rounded-xl hover:border-gray-600/60 hover:shadow-lg hover:shadow-black/10 transition-all duration-200 group"
         id="qe-row-${row.id}">
      <!-- Status icon -->
      <div class="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
        row.status === 'success' ? 'bg-green-950/40 border border-green-700/30 text-green-400' :
        row.status === 'failed'  ? 'bg-red-950/40 border border-red-700/30 text-red-400' :
        row.status === 'processing' ? 'bg-yellow-950/40 border border-yellow-700/30 text-yellow-300' :
        'bg-gray-800/40 border border-gray-700/30 text-gray-500'
      }">
        <i class="fas ${
          row.status === 'success'    ? 'fa-circle-check' :
          row.status === 'failed'     ? 'fa-circle-xmark' :
          row.status === 'processing' ? 'fa-spinner fa-spin' :
          'fa-clock'
        } text-sm"></i>
      </div>
      <!-- Address + note -->
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <span class="font-mono text-xs text-gray-300 font-medium">${row.address.slice(0,8)}&hellip;${row.address.slice(-6)}</span>
          ${row.note ? `<span class="text-[10px] text-gray-600 truncate max-w-[100px] bg-gray-800/40 px-1.5 py-0.5 rounded-full">${row.note}</span>` : ''}
        </div>
        <div class="qe-row-status mt-1 flex items-center gap-1.5 flex-wrap">
          ${_qeStatusBadge(row.status)}
          ${row.txHash ? `<a href="${QE_EXPLORER}/tx/${row.txHash}" target="_blank" class="text-violet-400 hover:text-violet-300 font-mono text-[10px] underline flex items-center gap-1"><i class="fas fa-external-link-alt text-[8px]"></i>${_qeShort(row.txHash)}</a>` : ''}
          ${row.error  ? `<span class="text-red-400 text-[10px] bg-red-950/40 px-1.5 py-0.5 rounded-full">${row.error.slice(0,40)}</span>` : ''}
        </div>
      </div>
      <!-- Amount -->
      <div class="text-right flex-shrink-0">
        <div class="text-sm font-bold text-white tracking-tight">${_qeFmt(row.amount)}</div>
        <div class="text-[10px] text-gray-500 font-medium">${row.token}</div>
      </div>
      <!-- Remove btn (only for pending) -->
      ${row.status === 'pending' ? `
      <button onclick="qeRemoveRow('${row.id}')"
        class="opacity-0 group-hover:opacity-100 w-7 h-7 flex items-center justify-center text-gray-600 hover:text-red-400 rounded-lg hover:bg-red-950/30 border border-transparent hover:border-red-800/30 transition-all duration-200 text-xs"
        title="Remove">
        <i class="fas fa-trash"></i>
      </button>` : '<div class="w-7"></div>'}
    </div>
  `).join('');

  _qeUpdateSummary();
}

function qeRemoveRow(id) {
  _qeQueue = _qeQueue.filter(r => r.id !== id);
  qeSaveQueue();
  qeRenderPanel();
}

// ─── Pre-flight check ─────────────────────────────────────────────────────────
async function _qePreFlight() {
  if (!window.ethers)              throw new Error('ethers.js not loaded. Refresh the page.');
  if (!window.ethereum)            throw new Error('No wallet detected. Install MetaMask.');
  if (!window.walletState?.connected) throw new Error('Wallet not connected. Connect first.');

  const chainHex = await window.ethereum.request({ method: 'eth_chainId' });
  const chainId  = parseInt(chainHex, 16);
  if (chainId !== QE_CHAIN_ID) throw new Error(`Wrong network. Switch to Arc Testnet (chainId ${QE_CHAIN_ID}).`);

  const pendingRows = _qeQueue.filter(r => r.status === 'pending');
  if (!pendingRows.length) throw new Error('No pending payments in queue.');

  // Balance check
  const ethers   = window.ethers;
  const provider = new ethers.BrowserProvider(window.ethereum);
  const signer   = await provider.getSigner();
  const sender   = await signer.getAddress();

  const tokenAddr = pendingRows[0].token === 'EURC' ? QE_EURC_ADDR : QE_USDC_ADDR;
  const usdc      = new ethers.Contract(tokenAddr, QE_ERC20_ABI, provider);
  const balance   = await usdc.balanceOf(sender);
  const decimals  = await usdc.decimals();
  const balNum    = parseFloat(ethers.formatUnits(balance, decimals));

  const usdcRows = pendingRows.filter(r => (r.token||'USDC').toUpperCase() === (pendingRows[0].token||'USDC').toUpperCase());
  const totalAmt = usdcRows.reduce((s, r) => s + r.amount, 0);
  const feeRate  = typeof msCalcFeeRate === 'function' ? msCalcFeeRate(usdcRows.length) : 0.01;
  const fee      = +(Math.round(totalAmt * feeRate * 1_000_000) / 1_000_000);
  const grand    = totalAmt + fee;

  if (balNum < grand) {
    throw new Error(`Insufficient balance. Need $${_qeFmt(grand)} ${pendingRows[0].token}, have $${_qeFmt(balNum)}.`);
  }

  return { sender, pendingRows, totalAmt, fee, grand, signer, provider };
}

// ─── Main Execute Engine ──────────────────────────────────────────────────────
async function executeQueue(chunkSize) {
  if (_qeExecuting) {
    _qeToast('Execution already in progress. Please wait.', 'warning');
    return;
  }

  const btn      = _qeEl('qe-exec-btn');
  const chunkBtn = _qeEl('qe-chunk-btn');
  const statusEl = _qeEl('qe-exec-status');

  _qeExecuting = true;
  if (btn)      { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Processing…'; btn.className = 'flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold bg-yellow-900/40 text-yellow-300 cursor-not-allowed'; }
  if (chunkBtn) { chunkBtn.disabled = true; }
  if (statusEl) { statusEl.classList.remove('hidden'); statusEl.innerHTML = '<i class="fas fa-spinner fa-spin mr-2 text-yellow-400"></i><span class="text-yellow-300">Validating…</span>'; }

  try {
    _qeLog('=== EXECUTE QUEUE START ===');

    // ── Pre-flight ────────────────────────────────────────────────────────────
    const { sender, pendingRows, totalAmt, fee, grand } = await _qePreFlight();
    _qeLog(`Sender: ${sender} | Pending: ${pendingRows.length} | Total: $${_qeFmt(totalAmt)} | Fee: $${_qeFmt(fee)} | Grand: $${_qeFmt(grand)}`);

    if (statusEl) statusEl.innerHTML = `<i class="fas fa-check-circle mr-2 text-green-400"></i><span class="text-green-300">Pre-flight OK — loading ${pendingRows.length} recipients into Multisend…</span>`;

    // ── Load rows into msValidatedRows ────────────────────────────────────────
    // This bridges the Queue Engine into the existing msExecute() which uses
    // msValidatedRows directly. We set it up then call msExecute().
    if (typeof msValidatedRows !== 'undefined') {
      // Clear and reload from queue
      msValidatedRows.length = 0;
      pendingRows.forEach(r => {
        msValidatedRows.push({ address: r.address, amount: r.amount, note: r.note || '' });
      });
      _qeLog(`Loaded ${msValidatedRows.length} rows into msValidatedRows`);
    }

    // ── Mark all pending as processing ────────────────────────────────────────
    pendingRows.forEach(r => qeUpdateStatus(r.id, 'processing', null));

    if (statusEl) statusEl.innerHTML = `<i class="fas fa-spinner fa-spin mr-2 text-yellow-400"></i><span class="text-yellow-300">Executing on-chain via Multicall3… confirm in wallet.</span>`;

    // ── Execute via msExecute() or direct batch if chunking ───────────────────
    if (chunkSize && chunkSize > 0 && pendingRows.length > chunkSize) {
      await _qeExecuteChunked(pendingRows, chunkSize, statusEl);
    } else {
      await _qeExecuteDirect(pendingRows, statusEl);
    }

  } catch (err) {
    _qeErr('Execute queue error:', err);
    _qeToast('❌ ' + (err.message || 'Execution failed'), 'error');
    if (statusEl) statusEl.innerHTML = `<i class="fas fa-times-circle mr-2 text-red-400"></i><span class="text-red-300">${err.message}</span>`;
    // Revert processing → pending on error
    _qeQueue.filter(r => r.status === 'processing').forEach(r => { r.status = 'pending'; });
    qeSaveQueue();
    qeRenderPanel();
  } finally {
    _qeExecuting = false;
    _qeUpdateExecBtn();
  }
}

// ─── Direct execute — delegate to msExecute() + intercept result ─────────────
async function _qeExecuteDirect(pendingRows, statusEl) {
  // Patch: intercept msExecute final result to update row statuses
  const origMsExecute = window.msExecute;

  // We call msExecute() which internally uses msValidatedRows (already set above)
  // and executes the Multicall3 batch. We monitor the ms-final-result element
  // to determine success/failure.

  // Ensure we're on step 3 in multisend
  if (typeof msSetStep === 'function') {
    if (typeof msProceedToReview === 'function' && typeof msValidatedRows !== 'undefined' && msValidatedRows.length > 0) {
      // Trigger review step silently
      try { msProceedToReview(); } catch(e) {}
      await new Promise(r => setTimeout(r, 100));
      try { if (typeof msProceedToSend === 'function') msProceedToSend(); } catch(e) {}
      await new Promise(r => setTimeout(r, 100));
    }
  }

  // Execute the real transaction
  if (typeof msExecute !== 'function') throw new Error('msExecute() not found. Multisend module not loaded.');

  // Watch for completion via polling ms-final-result
  const execPromise = msExecute();
  const resultPromise = new Promise((resolve) => {
    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      const finEl = document.getElementById('ms-final-result');
      if (finEl && !finEl.classList.contains('hidden') && finEl.innerHTML.trim()) {
        clearInterval(poll);
        const text = finEl.innerText || finEl.textContent || '';
        resolve(text.toLowerCase().includes('success') || text.toLowerCase().includes('confirmed') || text.includes('✅'));
      }
      if (attempts > 300) { clearInterval(poll); resolve(null); } // 5min timeout
    }, 1000);
  });

  const [, succeeded] = await Promise.all([execPromise, resultPromise]);

  if (succeeded === true) {
    // Mark all as success — txHash from ms-final-result if available
    const finEl = document.getElementById('ms-final-result');
    let txHash = null;
    if (finEl) {
      const match = finEl.innerHTML.match(/0x[0-9a-fA-F]{60,}/);
      if (match) txHash = match[0];
    }
    pendingRows.forEach(r => qeUpdateStatus(r.id, 'success', txHash));
    _qeToast(`✅ Queue executed! ${pendingRows.length} payments confirmed.`, 'success');
    if (statusEl) statusEl.innerHTML = `<i class="fas fa-check-circle mr-2 text-green-400"></i><span class="text-green-300">✅ ${pendingRows.length} payments confirmed on-chain!</span>`;
    _qeSaveHistory(pendingRows, txHash);
  } else if (succeeded === false) {
    pendingRows.forEach(r => qeUpdateStatus(r.id, 'failed', 'Transaction failed or rejected'));
    if (statusEl) statusEl.innerHTML = `<i class="fas fa-times-circle mr-2 text-red-400"></i><span class="text-red-300">Transaction failed. Check wallet and try again.</span>`;
  } else {
    // Timeout — mark as unknown, user can retry
    pendingRows.forEach(r => { if (r.status === 'processing') qeUpdateStatus(r.id, 'pending', null); });
    if (statusEl) statusEl.innerHTML = `<i class="fas fa-question-circle mr-2 text-yellow-400"></i><span class="text-yellow-300">Status unknown. Check wallet for transaction result.</span>`;
  }
}

// ─── Chunked execute — split large queues ─────────────────────────────────────
async function _qeExecuteChunked(pendingRows, chunkSize, statusEl) {
  _qeLog(`Chunked execution: ${pendingRows.length} rows in chunks of ${chunkSize}`);
  const chunks = [];
  for (let i = 0; i < pendingRows.length; i += chunkSize) {
    chunks.push(pendingRows.slice(i, i + chunkSize));
  }

  let totalSuccess = 0;
  let totalFailed  = 0;

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    if (statusEl) statusEl.innerHTML = `<i class="fas fa-spinner fa-spin mr-2 text-yellow-400"></i><span class="text-yellow-300">Chunk ${ci+1}/${chunks.length} — ${chunk.length} recipients…</span>`;
    _qeLog(`Executing chunk ${ci+1}/${chunks.length}: ${chunk.length} rows`);

    // Load chunk into msValidatedRows
    if (typeof msValidatedRows !== 'undefined') {
      msValidatedRows.length = 0;
      chunk.forEach(r => msValidatedRows.push({ address: r.address, amount: r.amount, note: r.note || '' }));
    }

    chunk.forEach(r => qeUpdateStatus(r.id, 'processing', null));

    try {
      if (typeof msProceedToReview === 'function') { try { msProceedToReview(); } catch(e) {} }
      await new Promise(r => setTimeout(r, 100));
      if (typeof msProceedToSend === 'function') { try { msProceedToSend(); } catch(e) {} }
      await new Promise(r => setTimeout(r, 100));

      await _qeExecuteDirect(chunk, null);
      const success = chunk.filter(r => r.status === 'success').length;
      totalSuccess += success;
      totalFailed  += (chunk.length - success);
    } catch(e) {
      _qeErr(`Chunk ${ci+1} error:`, e);
      chunk.forEach(r => qeUpdateStatus(r.id, 'failed', e.message || 'Chunk failed'));
      totalFailed += chunk.length;
    }

    // Brief pause between chunks
    if (ci < chunks.length - 1) await new Promise(r => setTimeout(r, 2000));
  }

  if (statusEl) statusEl.innerHTML = `<i class="fas fa-check-circle mr-2 text-green-400"></i><span class="text-green-300">Chunks complete — ✅ ${totalSuccess} success, ❌ ${totalFailed} failed</span>`;
  _qeToast(`Batch done: ${totalSuccess} success, ${totalFailed} failed`, totalFailed > 0 ? 'warning' : 'success');
}

// ─── History ──────────────────────────────────────────────────────────────────
function _qeSaveHistory(rows, txHash) {
  try {
    const hist = JSON.parse(localStorage.getItem(QE_HISTORY_KEY) || '[]');
    hist.unshift({
      timestamp: new Date().toISOString(),
      count:     rows.length,
      total:     rows.reduce((s, r) => s + r.amount, 0),
      token:     rows[0]?.token || 'USDC',
      txHash,
      rows: rows.map(r => ({ address: r.address, amount: r.amount, status: r.status, txHash: r.txHash })),
    });
    localStorage.setItem(QE_HISTORY_KEY, JSON.stringify(hist.slice(0, 50)));
  } catch(e) {}
}

// ─── Render Queue Panel HTML (injected into multisend tab) ───────────────────
function qeInjectPanel() {
  if (_qeRendered) return;
  const anchor = document.getElementById('ms-receipts-list');
  if (!anchor) return;

  const panel = document.createElement('div');
  panel.id = 'qe-panel';
  panel.className = 'mt-6 mb-4';
  panel.innerHTML = `
    <!-- Queue Engine Panel -->
    <div class="bg-gray-900/80 border border-green-700/30 rounded-2xl overflow-hidden shadow-lg">
      <!-- Header -->
      <div class="flex items-center justify-between px-5 py-4 border-b border-gray-800/60">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-xl bg-gradient-to-br from-green-600/30 to-emerald-700/30 border border-green-600/30 flex items-center justify-center">
            <i class="fas fa-list-check text-green-400 text-base"></i>
          </div>
          <div>
            <h3 class="text-white font-bold text-sm flex items-center gap-2">
              Payment Queue
              <span class="text-[10px] bg-green-900/40 text-green-400 border border-green-700/40 px-2 py-0.5 rounded-full">v${QE_VERSION}</span>
            </h3>
            <p class="text-gray-500 text-xs">Upload CSV → sign Permit2 → click Execute</p>
          </div>
        </div>
        <!-- Action buttons top-right -->
        <div class="flex items-center gap-2">
          <button onclick="qeSyncFromChatCSV()"
            class="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-gray-800/60 hover:bg-gray-700/60 border border-gray-700/40 hover:border-cyan-600/40 text-gray-400 hover:text-cyan-400 rounded-xl transition"
            title="Import rows from Chat CSV">
            <i class="fas fa-file-csv text-[10px]"></i>Import CSV
          </button>
          <button onclick="qeClearQueue()"
            class="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-gray-800/60 hover:bg-red-900/30 border border-gray-700/40 hover:border-red-600/40 text-gray-400 hover:text-red-400 rounded-xl transition"
            title="Clear all pending rows">
            <i class="fas fa-trash text-[10px]"></i>Clear
          </button>
        </div>
      </div>

      <!-- Stats bar -->
      <div class="grid grid-cols-4 gap-0 border-b border-gray-800/60">
        <div class="px-4 py-3 text-center border-r border-gray-800/40">
          <div class="text-lg font-bold text-white" id="qe-stat-total">0</div>
          <div class="text-[10px] text-gray-500 mt-0.5">Total</div>
        </div>
        <div class="px-4 py-3 text-center border-r border-gray-800/40">
          <div class="text-lg font-bold text-gray-400" id="qe-stat-pending">0</div>
          <div class="text-[10px] text-gray-500 mt-0.5">Pending</div>
        </div>
        <div class="px-4 py-3 text-center border-r border-gray-800/40">
          <div class="text-lg font-bold text-green-400" id="qe-stat-ok">0</div>
          <div class="text-[10px] text-gray-500 mt-0.5">Success</div>
        </div>
        <div class="px-4 py-3 text-center">
          <div class="text-lg font-bold text-red-400" id="qe-stat-fail">0</div>
          <div class="text-[10px] text-gray-500 mt-0.5">Failed</div>
        </div>
      </div>

      <!-- Progress bar -->
      <div class="px-5 pt-3 pb-1">
        <div class="h-1.5 bg-gray-800 rounded-full overflow-hidden">
          <div id="qe-progress-bar" class="h-full rounded-full transition-all bg-gradient-to-r from-green-500 to-emerald-400" style="width:0%"></div>
        </div>
      </div>

      <!-- Rows list -->
      <div id="qe-rows-container" class="px-4 py-3 space-y-2 max-h-72 overflow-y-auto custom-scrollbar">
        <div class="flex flex-col items-center gap-4 py-10 text-center">
          <div class="w-14 h-14 rounded-2xl bg-gradient-to-br from-gray-800/60 to-gray-800/30 border border-gray-700/40 flex items-center justify-center">
            <i class="fas fa-inbox text-gray-500 text-xl"></i>
          </div>
          <div>
            <p class="text-white font-semibold text-sm">No payments in queue</p>
            <p class="text-gray-500 text-xs mt-1">Your automated payments will appear here</p>
          </div>
          <button onclick="qeSyncFromChatCSV()"
            class="mt-1 flex items-center gap-2 text-xs px-4 py-2.5 bg-gradient-to-r from-rose-900/30 to-rose-800/20 hover:from-rose-800/40 hover:to-rose-700/30 border border-rose-700/30 text-rose-300 hover:text-rose-200 rounded-xl transition-all duration-200">
            <i class="fas fa-sync text-[10px]"></i>Import from Chat CSV
          </button>
        </div>
      </div>

      <!-- Status message -->
      <div id="qe-exec-status" class="hidden px-5 py-3 border-t border-gray-800/60 text-sm flex items-center gap-2"></div>

      <!-- Execute buttons row -->
      <div class="flex items-center gap-3 px-5 py-4 border-t border-gray-800/60 bg-gray-950/40">
        <!-- Primary: Execute Queue -->
        <button id="qe-exec-btn"
          onclick="executeQueue()"
          disabled
          title="Connect wallet and add rows to enable"
          class="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold transition-all bg-gray-700 text-gray-500 cursor-not-allowed opacity-60">
          <i class="fas fa-rocket mr-1"></i>🚀 Execute Queue
        </button>

        <!-- Secondary: Execute in Chunks -->
        <button id="qe-chunk-btn"
          onclick="executeQueue(50)"
          disabled
          title="Split execution into chunks of 50 recipients"
          class="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all bg-gray-700 text-gray-500 cursor-not-allowed opacity-60">
          <i class="fas fa-layer-group mr-1"></i>Execute in Chunks
        </button>

        <div class="flex-1"></div>

        <!-- Wallet status indicator -->
        <div id="qe-wallet-indicator" class="flex items-center gap-1.5 text-xs">
          <div class="w-2 h-2 rounded-full bg-gray-600" id="qe-wallet-dot"></div>
          <span class="text-gray-600" id="qe-wallet-label">No wallet</span>
        </div>
      </div>
    </div>
  `;

  // Insert BEFORE the receipts list
  anchor.parentElement.insertBefore(panel, anchor);
  _qeRendered = true;

  // Initial render
  qeLoadQueue();
  qeRenderPanel();
  _qeUpdateExecBtn();

  // Auto-import if chat CSV is loaded
  if (window.chatCSVState?.loaded && window.chatCSVState?.rows?.length > 0) {
    const imported = qeSyncFromChatCSV();
    if (imported > 0) _qeToast(`📋 ${imported} rows imported from Chat CSV`, 'info');
  }

  _qeLog('Queue panel injected');
}

// ─── Wallet state watcher ─────────────────────────────────────────────────────
function _qeWatchWallet() {
  let lastState = null;
  setInterval(() => {
    const connected = !!window.walletState?.connected;
    const addr      = window.walletState?.address || '';
    const stateKey  = `${connected}:${addr}`;
    if (stateKey === lastState) return;
    lastState = stateKey;

    // Update wallet indicator
    const dot   = _qeEl('qe-wallet-dot');
    const label = _qeEl('qe-wallet-label');
    if (dot && label) {
      if (connected) {
        dot.className   = 'w-2 h-2 rounded-full bg-green-400 shadow-sm shadow-green-400/50';
        label.className = 'text-green-400 font-mono text-[10px]';
        label.textContent = addr ? addr.slice(0,6)+'…'+addr.slice(-4) : 'Connected';
      } else {
        dot.className   = 'w-2 h-2 rounded-full bg-gray-600';
        label.className = 'text-gray-600';
        label.textContent = 'No wallet';
      }
    }
    _qeUpdateExecBtn();
  }, 1500);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
function _qeInit() {
  qeLoadQueue();

  // Inject panel when multisend tab is activated
  const origSwitchTab = window.switchTab;
  if (typeof origSwitchTab === 'function') {
    window.switchTab = function(tab) {
      origSwitchTab(tab);
      if (tab === 'multisend') {
        setTimeout(() => {
          qeInjectPanel();
          qeSyncFromChatCSV();
          _qeUpdateExecBtn();
        }, 50);
      }
    };
  }

  // Also inject if already on multisend tab
  setTimeout(() => {
    const msPanel = document.getElementById('tab-content-multisend');
    if (msPanel && !msPanel.classList.contains('hidden')) {
      qeInjectPanel();
    }
  }, 800);

  _qeWatchWallet();

  // Expose globals
  window.executeQueue         = executeQueue;
  window.qeLoadFromCSV        = qeLoadFromCSV;
  window.qeSyncFromChatCSV    = qeSyncFromChatCSV;
  window.qeClearQueue         = qeClearQueue;
  window.qeRenderPanel        = qeRenderPanel;
  window.qeRemoveRow          = qeRemoveRow;
  window.qeUpdateStatus       = qeUpdateStatus;
  window.qeInjectPanel        = qeInjectPanel;

  // Hook: when chatCSVState is updated, offer to import
  const origChatCSVSet = Object.getOwnPropertyDescriptor(window, 'chatCSVState');
  // Poll chatCSVState for changes
  let lastCSVFileName = null;
  setInterval(() => {
    const csv = window.chatCSVState;
    if (csv?.loaded && csv?.fileName && csv.fileName !== lastCSVFileName) {
      lastCSVFileName = csv.fileName;
      const imported = qeSyncFromChatCSV();
      if (imported > 0) {
        _qeToast(`📋 ${imported} rows from "${csv.fileName}" added to Queue`, 'success');
        // Re-render if panel is visible
        const panel = document.getElementById('qe-panel');
        if (panel) qeRenderPanel();
      }
    }
  }, 2000);

  _qeLog(`Loaded | v${QE_VERSION} | Chain ${QE_CHAIN_ID}`);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _qeInit);
} else {
  _qeInit();
}

// ══════════════════════════════════════════════════════════════════════════════
// CHAT → EXECUTION BRIDGE
// Escuta eventos disparados pelo chatbot (Brain) e adiciona itens à fila.
// A wallet NUNCA é aberta aqui — apenas a fila é atualizada e o botão
// "Execute Payments" é exibido no chat para que o usuário clique.
// ══════════════════════════════════════════════════════════════════════════════

// ─── Evento: transfer único adicionado pelo chatbot ───────────────────────────
window.addEventListener('arcPayQueue:add', function(e) {
  const d = e.detail;
  if (!d || !d.recipient || !d.amount) return;

  const entry = {
    id:      `q-chat-${Date.now()}`,
    address: d.recipient,
    amount:  parseFloat(d.amount),
    token:   (d.token || 'USDC').toUpperCase(),
    note:    'Via chatbot',
    status:  'pending',
    txHash:  null,
    error:   null,
  };

  _qeQueue.push(entry);
  qeSaveQueue();

  // Re-renderiza painel se estiver aberto
  const panel = document.getElementById('qe-panel');
  if (panel) { qeRenderPanel(); _qeUpdateExecBtn(); }

  // Mostra botão flutuante "Execute Payments" no chat
  _qeShowChatExecuteButton();

  _qeLog(`Chat → fila: ${entry.amount} ${entry.token} → ${entry.address.slice(0,10)}…`);
});

// ─── Evento: lote adicionado pelo chatbot ─────────────────────────────────────
window.addEventListener('arcPayQueue:addBatch', function(e) {
  const d = e.detail;
  if (!d || !Array.isArray(d.recipients) || !d.recipients.length) return;

  const token = (d.token || 'USDC').toUpperCase();
  let added = 0;

  d.recipients.forEach((r, idx) => {
    const addr = String(r.address || r.to || r.wallet || '').trim();
    const amt  = parseFloat(r.amount || 0);
    if (!_qeIsAddr(addr) || isNaN(amt) || amt <= 0) return;
    _qeQueue.push({
      id:      `q-chat-batch-${Date.now()}-${idx}`,
      address: addr,
      amount:  amt,
      token,
      note:    'Via chatbot (lote)',
      status:  'pending',
      txHash:  null,
      error:   null,
    });
    added++;
  });

  if (added) {
    qeSaveQueue();
    const panel = document.getElementById('qe-panel');
    if (panel) { qeRenderPanel(); _qeUpdateExecBtn(); }
    _qeShowChatExecuteButton();
    _qeLog(`Chat → fila (lote): ${added} entradas, token ${token}`);
  }
});

// ─── Botão flutuante "Execute Payments" no chat ───────────────────────────────
// Aparece dentro da janela do chat quando há itens na fila.
// Single item  → routes to Payments tab (fills form)
// Multiple items → routes to Multisend tab (queue panel)
function _qeShowChatExecuteButton() {
  // Remove existing button so we can refresh the count/label
  const existing = document.getElementById('chat-exec-queue-btn');
  if (existing) existing.remove();

  const msgContainer = document.getElementById('chat-messages');
  if (!msgContainer) return;

  const pending = _qeQueue.filter(r => r.status === 'pending').length;
  if (!pending) return;

  // Context-aware label
  const isSingle   = pending === 1;
  const btnIcon    = isSingle ? 'fa-credit-card' : 'fa-rocket';
  const btnLabel   = isSingle ? '💳 Ir para Payments' : '⚡ Execute Payments';
  const btnTooltip = isSingle
    ? 'Abre o formulário de Payments com dados preenchidos'
    : `Executa ${pending} pagamentos em lote via Multisend`;

  const wrapper = document.createElement('div');
  wrapper.id = 'chat-exec-queue-btn';
  wrapper.className = 'flex justify-center my-3 px-4';
  wrapper.innerHTML = `
    <button
      onclick="_qeHandleChatExecute()"
      title="${btnTooltip}"
      class="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold
             bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500
             text-white shadow-lg shadow-purple-900/40 transition-all active:scale-95">
      <i class="fas ${btnIcon} text-sm"></i>
      ${btnLabel}
      <span class="bg-white/20 rounded-full px-2 py-0.5 text-xs font-semibold">${pending}</span>
    </button>`;

  msgContainer.appendChild(wrapper);

  // Scroll para o botão
  wrapper.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ─── Handler: clique no botão Execute Payments dentro do chat ─────────────────
window._qeHandleChatExecute = function() {
  // Remove o botão do chat (ação única)
  const btn = document.getElementById('chat-exec-queue-btn');
  if (btn) btn.remove();

  // ── Routing logic: 1 item → Payments tab, 2+ → Multisend tab ─────────────
  // Count pending items in the queue
  const pendingItems = _qeQueue.filter(r => r.status === 'pending');
  const isSingle     = pendingItems.length === 1;

  if (typeof toggleChat === 'function') toggleChat();

  if (isSingle) {
    // Single payment → route to Payments tab, pre-fill form
    const item = pendingItems[0];
    if (typeof switchTab === 'function') switchTab('payments');
    setTimeout(() => {
      const addrEl = document.getElementById('pay-recipient');
      const amtEl  = document.getElementById('pay-amount');
      if (addrEl) { addrEl.value = item.address; addrEl.dispatchEvent(new Event('input', { bubbles: true })); }
      if (amtEl)  { amtEl.value  = String(item.amount); amtEl.dispatchEvent(new Event('input', { bubbles: true })); }
      // Select token if function available
      if (typeof selectPayToken === 'function') selectPayToken(item.token || 'USDC');
      if (typeof updatePayPreview === 'function') updatePayPreview();
      if (typeof payValidateForm === 'function') payValidateForm();
      if (typeof _qeToast === 'function') {
        _qeToast('💳 Single payment pre-filled — review and click Sign & Send.', 'info');
      }
    }, 400);
  } else {
    // Multiple payments → route to Multisend tab with queue panel
    if (typeof switchTab === 'function') switchTab('multisend');
    setTimeout(() => {
      if (typeof qeInjectPanel === 'function') qeInjectPanel();
      const panel = document.getElementById('qe-panel');
      if (panel) panel.scrollIntoView({ behavior: 'smooth' });
      if (typeof _qeToast === 'function') {
        _qeToast(`⚡ ${pendingItems.length} pagamentos na fila — clique em "Execute Queue" para enviar.`, 'info');
      }
    }, 400);
  }
};
