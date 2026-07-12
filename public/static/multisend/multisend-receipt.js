// ─── Hybrid Multisend History (On-chain + Local) ────────────────────────────────
// Storage key for persisted receipts
const MS_HISTORY_KEY = 'arc_ms_history_v2';

// Load receipts from localStorage on startup
function msLoadPersistedReceipts() {
  // NOTE: persistent hide — items stay hidden across reloads (user can unhide via 'Show Hidden')
  try {
    const stored = JSON.parse(localStorage.getItem(MS_HISTORY_KEY) || '[]');
    if (!Array.isArray(stored)) return;
    // Merge into msReceipts, dedup by id
    const existing = new Set(msReceipts.map(r => r.id));
    for (const r of stored) {
      if (!existing.has(r.id)) {
        msReceipts.push(r);
        existing.add(r.id);
      }
    }
    msReceipts.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  } catch (_) {}
}

// Persist current receipts to localStorage
function msPersistReceipts() {
  try {
    // Keep only last 100 receipts to avoid storage overflow
    const toSave = msReceipts.slice(0, 100).map(r => ({
      ...r,
      // Don't persist full recipient data (can be large) — keep reference only
      recipients: (r.recipients || []).map(p => ({
        address: p.address, amount: p.amount, note: p.note,
        status: p.status, txHash: p.txHash,
      })),
    }));
    localStorage.setItem(MS_HISTORY_KEY, JSON.stringify(toSave));
  } catch (_) {}
}

// Sync a single receipt's status with on-chain data
async function msSyncReceiptOnChain(receiptId) {
  const r = msReceipts.find(x => x.id === receiptId);
  if (!r || !r.txHash) return r;

  try {
    const resp = await fetch(MS_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'eth_getTransactionReceipt',
        params: [r.txHash],
      }),
    });
    const data = await resp.json();
    const receipt = data.result;

    if (receipt) {
      r._onChainSynced   = true;
      r._syncedAt        = Date.now();
      r._onChainBlock    = parseInt(receipt.blockNumber, 16);
      r._onChainStatus   = receipt.status === '0x1' ? 'confirmed' : 'failed';
      r._onChainGasUsed  = parseInt(receipt.gasUsed, 16);
      if (r._onChainStatus === 'confirmed' && r.status !== 'confirmed') {
        r.status = 'confirmed';
      } else if (r._onChainStatus === 'failed') {
        r.status = 'failed';
      }
    } else {
      // No receipt — tx might still be pending or was dropped
      r._onChainSynced  = false;
      r._syncedAt       = Date.now();
    }

    msPersistReceipts();
    return r;
  } catch (_) {
    return r;
  }
}

// Sync all unsynced receipts in background
async function msSyncAllOnChain() {
  const unsynced = msReceipts.filter(r => r.txHash && !r._onChainSynced);
  if (!unsynced.length) return;

  for (const r of unsynced.slice(0, 10)) {
    await msSyncReceiptOnChain(r.id).catch(() => {});
    await new Promise(res => setTimeout(res, 300)); // rate-limit RPC calls
  }
  msRenderReceipts();
}

// ─── Global: Open hybrid history panel ────────────────────────────────────────
window.msOpenHybridHistory = async function() {
  // Remove any existing modal
  document.getElementById('ms-hybrid-history-modal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'ms-hybrid-history-modal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.88);backdrop-filter:blur(6px);display:flex;align-items:flex-start;justify-content:center;padding:16px;overflow-y:auto;animation:fadeIn 0.2s ease;';

  modal.innerHTML = `
    <style>
      @keyframes fadeIn { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:none; } }
      @keyframes slideOut { from { opacity:1; transform:none; } to { opacity:0; transform:translateY(10px); } }
    </style>
    <div style="background:#0a0c18;border:1px solid rgba(0,200,210,0.25);border-radius:20px;width:100%;max-width:720px;margin:auto;overflow:hidden;box-shadow:0 0 60px rgba(0,200,210,0.08);">
      <!-- Header -->
      <div style="display:flex;align-items:center;gap:10px;padding:16px 20px;background:rgba(0,200,210,0.05);border-bottom:1px solid rgba(0,200,210,0.15);">
        <div style="width:36px;height:36px;border-radius:10px;background:rgba(0,200,210,0.12);border:1px solid rgba(0,200,210,0.25);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
          <i class="fas fa-history" style="color:#22d3ee;font-size:14px;"></i>
        </div>
        <div style="flex:1;">
          <div style="font-size:14px;font-weight:800;color:#dde2f0;">Multisend History</div>
          <div style="font-size:11px;color:#4a6490;">Hybrid — Local cache + On-Chain verification · ARC Testnet</div>
        </div>
        <button id="ms-history-sync-btn" onclick="msHistorySync()"
          style="padding:6px 14px;background:rgba(0,200,210,0.1);border:1px solid rgba(0,200,210,0.25);color:#22d3ee;border-radius:8px;font-size:10px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:5px;">
          <i class="fas fa-sync-alt" style="font-size:9px;"></i>Sync
        </button>
        <button onclick="msCloseHybridHistory()"
          style="width:32px;height:32px;border-radius:8px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.25);color:#f87171;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
          <i class="fas fa-times"></i>
        </button>
      </div>
      <!-- Body -->
      <div id="ms-hh-body" style="padding:16px 20px;max-height:80vh;overflow-y:auto;"></div>
    </div>`;

  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) msCloseHybridHistory(); });

  msRenderHybridHistory();

  // Start background sync
  setTimeout(msSyncAllOnChain, 500);
};

window.msCloseHybridHistory = function() {
  const modal = document.getElementById('ms-hybrid-history-modal');
  if (!modal) return;
  modal.style.animation = 'slideOut 0.2s ease forwards';
  setTimeout(() => modal.remove(), 200);
};

window.msHistorySync = async function() {
  const btn = document.getElementById('ms-history-sync-btn');
  if (btn) { btn.innerHTML = '<i class="fas fa-spinner fa-spin" style="font-size:9px;"></i> Syncing…'; btn.disabled = true; }
  await msSyncAllOnChain();
  msRenderHybridHistory();
  if (btn) { btn.innerHTML = '<i class="fas fa-check" style="font-size:9px;"></i> Synced'; btn.disabled = false; setTimeout(() => { if (btn) btn.innerHTML = '<i class="fas fa-sync-alt" style="font-size:9px;"></i>Sync'; }, 2000); }
};

function msRenderHybridHistory() {
  const body = document.getElementById('ms-hh-body');
  if (!body) return;

  const all = [...msReceipts].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  if (!all.length) {
    body.innerHTML = `<div style="text-align:center;padding:40px;color:#4a6490;">
      <i class="fas fa-inbox" style="font-size:32px;display:block;margin-bottom:12px;"></i>
      <div style="font-size:13px;font-weight:600;color:#6b7280;margin-bottom:4px;">No batch history yet</div>
      <div style="font-size:11px;">Send a batch to see history here.</div>
    </div>`;
    return;
  }

  const syncedCount  = all.filter(r => r._onChainSynced).length;
  const pendingCount = all.filter(r => r.txHash && !r._onChainSynced).length;

  body.innerHTML = `
    <!-- Summary bar -->
    <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:rgba(0,200,210,0.04);border:1px solid rgba(0,200,210,0.12);border-radius:10px;margin-bottom:12px;font-size:10px;flex-wrap:wrap;gap:8px;">
      <span style="color:#dde2f0;font-weight:700;">${all.length} batch${all.length!==1?'es':''}</span>
      <span style="color:#4a6490;">·</span>
      <span style="display:inline-flex;align-items:center;gap:4px;color:#34d399;">
        <i class="fas fa-check-circle" style="font-size:9px;"></i>${syncedCount} on-chain synced
      </span>
      ${pendingCount > 0 ? `<span style="display:inline-flex;align-items:center;gap:4px;color:#fbbf24;">
        <i class="fas fa-clock" style="font-size:9px;"></i>${pendingCount} pending sync
      </span>` : ''}
      <span style="color:#4a6490;margin-left:auto;font-size:9px;">Last updated: ${new Date().toLocaleTimeString()}</span>
    </div>

    <!-- Receipts -->
    ${all.map(r => {
      const synced   = !!r._onChainSynced;
      const hasTx    = !!r.txHash;
      const localOnly = !hasTx || !synced;
      const onChainStatus = r._onChainStatus;
      const statusColor = r.status === 'confirmed' ? '#34d399' : r.status === 'failed' ? '#f87171' : '#fbbf24';
      const statusBg    = r.status === 'confirmed' ? '52,211,153' : r.status === 'failed' ? '239,68,68' : '251,191,36';

      return `<div style="background:rgba(14,18,30,0.8);border:1px solid rgba(${synced?'52,211,153':'0,200,210'},0.15);border-radius:14px;padding:14px;margin-bottom:10px;">
        <!-- Top row -->
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:10px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <div style="width:32px;height:32px;border-radius:9px;background:rgba(${statusBg},0.1);border:1px solid rgba(${statusBg},0.25);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
              <i class="fas ${r.status==='confirmed'?'fa-check':'r.status==="failed"?"fa-times":"fa-clock'} text-xs" style="color:${statusColor};font-size:12px;"></i>
            </div>
            <div>
              <div style="font-size:12px;font-weight:700;color:#dde2f0;">${r.batchId || r.id}</div>
              <div style="font-size:10px;color:#4a6490;">${new Date(r.timestamp).toLocaleString()} · <span style="color:#22d3ee;">${r.executionMethod || 'batch'}</span></div>
            </div>
          </div>
          <div style="text-align:right;flex-shrink:0;">
            <div style="font-size:13px;font-weight:800;color:#34d399;">$${r.totalAmount} USDC</div>
            <div style="font-size:10px;color:#4a6490;">${r.count} recipient${r.count!==1?'s':''}</div>
          </div>
        </div>

        <!-- Sync indicator badge -->
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap;">
          ${synced
            ? `<span style="display:inline-flex;align-items:center;gap:4px;font-size:9px;font-weight:700;background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.25);color:#34d399;padding:2px 8px;border-radius:999px;">
                <i class="fas fa-check-circle" style="font-size:8px;"></i>On-Chain Synced
              </span>
              ${onChainStatus ? `<span style="display:inline-flex;align-items:center;gap:4px;font-size:9px;font-weight:700;background:rgba(${onChainStatus==='confirmed'?'52,211,153':'239,68,68'},0.1);border:1px solid rgba(${onChainStatus==='confirmed'?'52,211,153':'239,68,68'},0.25);color:${onChainStatus==='confirmed'?'#34d399':'#f87171'};padding:2px 8px;border-radius:999px;">
                ${onChainStatus==='confirmed'?'✓':'✗'} ${onChainStatus}
              </span>` : ''}
              ${r._onChainBlock ? `<span style="font-size:9px;color:#4a6490;">Block #${r._onChainBlock.toLocaleString()}</span>` : ''}`
            : hasTx
              ? `<span style="display:inline-flex;align-items:center;gap:4px;font-size:9px;font-weight:700;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.2);color:#fbbf24;padding:2px 8px;border-radius:999px;">
                  <i class="fas fa-clock" style="font-size:8px;"></i>Local Only — Pending Sync
                </span>`
              : `<span style="display:inline-flex;align-items:center;gap:4px;font-size:9px;font-weight:700;background:rgba(74,85,104,0.1);border:1px solid rgba(74,85,104,0.2);color:#6b7280;padding:2px 8px;border-radius:999px;">
                  <i class="fas fa-database" style="font-size:8px;"></i>Local Only — No TX Hash
                </span>`
          }
          <span style="font-size:9px;background:rgba(${statusBg},0.08);border:1px solid rgba(${statusBg},0.18);color:${statusColor};padding:2px 8px;border-radius:999px;font-weight:700;">${r.status || 'unknown'}</span>
        </div>

        <!-- TX Hashes -->
        ${r.txHash ? `<div style="font-size:10px;font-family:monospace;background:rgba(10,12,24,0.8);border:1px solid rgba(0,200,210,0.1);border-radius:8px;padding:7px 10px;margin-bottom:7px;">
          <span style="color:#4a6490;">Batch TX:</span>
          <span style="color:#22d3ee;">${r.txHash.slice(0,28)}…</span>
          <button onclick="navigator.clipboard?.writeText('${r.txHash}').then(()=>showToast('Copied!','success'))" style="margin-left:4px;width:18px;height:18px;border-radius:4px;background:rgba(0,200,210,0.08);border:1px solid rgba(0,200,210,0.15);color:#22d3ee;cursor:pointer;font-size:8px;display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;"><i class="fas fa-copy"></i></button>
          <a href="${MS_EXPLORER}/tx/${r.txHash}" target="_blank" rel="noopener" style="margin-left:4px;color:#22d3ee;font-size:9px;text-decoration:none;background:rgba(0,200,210,0.07);border:1px solid rgba(0,200,210,0.15);padding:1px 6px;border-radius:4px;vertical-align:middle;">↗ ArcScan</a>
        </div>` : ''}
        ${r.feeTxHash ? `<div style="font-size:9px;font-family:monospace;color:#4a6490;margin-bottom:4px;">Fee TX: <a href="${MS_EXPLORER}/tx/${r.feeTxHash}" target="_blank" style="color:#fbbf24;">${r.feeTxHash.slice(0,28)}… ↗</a></div>` : ''}

        <!-- Stats row -->
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:6px;margin-bottom:10px;">
          <div style="background:rgba(10,12,24,0.6);border-radius:7px;padding:6px 8px;text-align:center;">
            <div style="font-size:8px;color:#4a6490;text-transform:uppercase;font-weight:700;margin-bottom:2px;">From</div>
            <div style="font-size:9px;font-family:monospace;color:#22d3ee;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${(r.from||'—').slice(0,10)}…</div>
          </div>
          <div style="background:rgba(10,12,24,0.6);border-radius:7px;padding:6px 8px;text-align:center;">
            <div style="font-size:8px;color:#4a6490;text-transform:uppercase;font-weight:700;margin-bottom:2px;">Fee</div>
            <div style="font-size:9px;color:#fbbf24;font-weight:700;">$${r.fee||'0.00'}</div>
          </div>
          <div style="background:rgba(10,12,24,0.6);border-radius:7px;padding:6px 8px;text-align:center;">
            <div style="font-size:8px;color:#4a6490;text-transform:uppercase;font-weight:700;margin-bottom:2px;">Gas</div>
            <div style="font-size:9px;color:#6b7280;">${r._onChainGasUsed?.toLocaleString() || r.totalGasUsed || '—'}</div>
          </div>
          <div style="background:rgba(10,12,24,0.6);border-radius:7px;padding:6px 8px;text-align:center;">
            <div style="font-size:8px;color:#4a6490;text-transform:uppercase;font-weight:700;margin-bottom:2px;">Network</div>
            <div style="font-size:9px;color:#34d399;">Arc Testnet</div>
          </div>
        </div>

        <!-- Actions -->
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button onclick="typeof arcViewMultisendReceipt === 'function' ? arcViewMultisendReceipt('${r.id}') : msPdfReceipt('${r.id}')"
            style="display:inline-flex;align-items:center;gap:5px;padding:6px 12px;background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.25);color:#34d399;border-radius:8px;font-size:10px;font-weight:700;cursor:pointer;">
            <i class="fas fa-eye" style="font-size:9px;"></i>View Receipt
          </button>
          ${hasTx && !synced ? `<button onclick="msSyncReceiptOnChain('${r.id}').then(()=>{msRenderReceipts();msRenderHybridHistory();showToast('Synced!','success')})"
            style="display:inline-flex;align-items:center;gap:5px;padding:6px 12px;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.2);color:#fbbf24;border-radius:8px;font-size:10px;font-weight:700;cursor:pointer;">
            <i class="fas fa-sync-alt" style="font-size:9px;"></i>Sync Now
          </button>` : ''}
          ${r.txHash ? `<a href="${MS_EXPLORER}/tx/${r.txHash}" target="_blank" rel="noopener"
            style="display:inline-flex;align-items:center;gap:5px;padding:6px 12px;background:rgba(0,200,210,0.06);border:1px solid rgba(0,200,210,0.15);color:#22d3ee;border-radius:8px;font-size:10px;cursor:pointer;text-decoration:none;">
            <i class="fas fa-external-link-alt" style="font-size:9px;"></i>ArcScan
          </a>` : ''}
        </div>
      </div>`;
    }).join('')}
  `;
}

// ─── Receipt rendering (enhanced with sync indicators) ─────────────────────────
function msRenderReceipts() {
  const container = msEl('ms-receipts-list');
  const countEl   = msEl('ms-receipts-count');
  if (!container) return;

  // Apply local dismiss filter
  const visible = msReceipts.filter(r => _msDismiss.isVisible(r.id));

  if (countEl) countEl.textContent = visible.length + ' receipt' + (visible.length !== 1 ? 's' : '');

  if (!visible.length) {
    container.innerHTML = `
      <div class="flex flex-col items-center gap-3 py-10 text-center text-gray-600">
        <i class="fas fa-inbox text-2xl"></i>
        <p class="text-sm">No batch receipts. Send a batch to generate a receipt.</p>
      </div>`;
    return;
  }

  container.innerHTML = visible.map(r => {
    const synced = !!r._onChainSynced;
    const hasTx  = !!r.txHash;
    const syncBadge = synced
      ? `<span class="inline-flex items-center gap-1 text-[9px] font-bold bg-green-900/20 border border-green-700/25 text-green-400 px-2 py-0.5 rounded-full ml-1"><i class="fas fa-check-circle" style="font-size:7px"></i>Synced</span>`
      : hasTx
        ? `<span class="inline-flex items-center gap-1 text-[9px] font-bold bg-yellow-900/15 border border-yellow-700/20 text-yellow-400 px-2 py-0.5 rounded-full ml-1"><i class="fas fa-clock" style="font-size:7px"></i>Local only</span>`
        : `<span class="inline-flex items-center gap-1 text-[9px] bg-gray-800/50 border border-gray-700/20 text-gray-600 px-2 py-0.5 rounded-full ml-1"><i class="fas fa-database" style="font-size:7px"></i>Local</span>`;

    return `
    <div id="ms-receipt-${r.id}" class="bg-gray-800/40 border ${synced ? 'border-green-800/30' : hasTx ? 'border-yellow-800/20' : 'border-gray-700/40'} rounded-2xl p-4 mb-3" style="max-height:600px;">
      <div class="flex items-start justify-between mb-3">
        <div class="flex items-center gap-2">
          <div class="w-7 h-7 rounded-lg ${r.status === 'confirmed' ? 'bg-green-900/30 border-green-700/30' : 'bg-yellow-900/30 border-yellow-700/30'} border flex items-center justify-center">
            <i class="fas ${r.status === 'confirmed' ? 'fa-check text-green-400' : 'fa-exclamation text-yellow-400'} text-xs"></i>
          </div>
          <div>
            <div class="text-white font-semibold text-sm">${r.batchId}${syncBadge}</div>
            <div class="text-gray-500 text-xs">${new Date(r.timestamp).toLocaleString()} · <span class="text-cyan-600">${r.executionMethod || 'batch'}</span></div>
          </div>
        </div>
        <div class="flex items-start gap-2">
          <div class="text-right">
            <div class="text-green-400 font-bold text-sm">$${r.totalAmount} USDC</div>
            <div class="text-gray-600 text-xs">${r.count} recipient${r.count !== 1 ? 's' : ''}</div>
          </div>
          <!-- ✕ Persistent hide — survives page reload, data is NOT deleted -->
          <button class="arc-dismiss-btn"
            onclick="event.stopPropagation();arcAnimatedDismiss('ms-receipt-${r.id}',function(){if(typeof arcHideMs==='function')arcHideMs('${r.id}');msRenderReceipts();})"
            title="Remove receipt from local view">✕</button>
        </div>
      </div>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs mb-3">
        <div class="bg-gray-900/40 rounded-lg px-3 py-2"><div class="text-gray-600 text-[10px] mb-0.5 uppercase">From</div><div class="font-mono text-cyan-400 truncate">${msShort(r.from)}</div></div>
        <div class="bg-gray-900/40 rounded-lg px-3 py-2"><div class="text-gray-600 text-[10px] mb-0.5 uppercase">Network</div><div class="text-green-400">Arc Testnet</div></div>
        <div class="bg-gray-900/40 rounded-lg px-3 py-2"><div class="text-gray-600 text-[10px] mb-0.5 uppercase">Platform Fee</div><div class="text-yellow-400">$${r.fee || '0.00'}</div></div>
        <div class="bg-gray-900/40 rounded-lg px-3 py-2"><div class="text-gray-600 text-[10px] mb-0.5 uppercase">Gas Used</div><div class="text-gray-400">${r._onChainGasUsed?.toLocaleString() || r.totalGasUsed || '—'}</div></div>
      </div>
      ${r.txHash ? `
      <div class="text-xs text-gray-500 mb-1.5 font-mono bg-gray-900/30 rounded-lg px-2.5 py-1.5 flex items-center justify-between">
        <span class="text-gray-600 flex-shrink-0">Batch Tx</span>
        <a href="${r.explorerUrl}" target="_blank" rel="noopener" class="text-blue-400 hover:underline ml-2 truncate">${r.txHash.slice(0,26)}… <i class="fas fa-external-link-alt text-[10px]"></i></a>
      </div>` : ''}
      ${r.feeTxHash ? `
      <div class="text-xs text-gray-500 mb-1.5 font-mono bg-gray-900/30 rounded-lg px-2.5 py-1.5 flex items-center justify-between">
        <span class="text-gray-600 flex-shrink-0">Fee Tx</span>
        <a href="${MS_EXPLORER}/tx/${r.feeTxHash}" target="_blank" rel="noopener" class="text-yellow-400 hover:underline ml-2 truncate">${r.feeTxHash.slice(0,26)}… <i class="fas fa-external-link-alt text-[10px]"></i></a>
      </div>` : ''}
      ${r.approvalTxHash ? `
      <div class="text-xs text-gray-500 mb-1.5 font-mono bg-gray-900/30 rounded-lg px-2.5 py-1.5 flex items-center justify-between">
        <span class="text-gray-600 flex-shrink-0">Approval Tx</span>
        <a href="${MS_EXPLORER}/tx/${r.approvalTxHash}" target="_blank" rel="noopener" class="text-cyan-400/70 hover:underline ml-2 truncate">${r.approvalTxHash.slice(0,26)}… <i class="fas fa-external-link-alt text-[10px]"></i></a>
      </div>` : ''}
      <details class="mb-2 mt-1">
        <summary class="text-xs text-gray-500 hover:text-gray-400 cursor-pointer select-none flex items-center gap-1.5 py-1">
          <i class="fas fa-users text-[10px]"></i>Recipients (${r.recipients?.length || 0})
          <i class="fas fa-chevron-down text-[9px] ml-auto"></i>
        </summary>
        <div class="mt-2 space-y-1 max-h-48 overflow-y-auto">
          ${(r.recipients || []).map(p => `
            <div class="flex items-center gap-1.5 text-[11px] py-1.5 border-b border-gray-700/20 last:border-0">
              <span class="font-mono text-gray-400 flex-1 truncate">${msShort(p.address)}</span>
              <span class="text-cyan-400 flex-shrink-0">$${msFmt2(p.amount)}</span>
              <span class="flex-shrink-0 ${p.status === 'confirmed' ? 'text-green-400' : p.status === 'failed' ? 'text-red-400' : 'text-yellow-400'}">${p.status || '—'}</span>
              ${p.txHash ? `<a href="${MS_EXPLORER}/tx/${p.txHash}" target="_blank" class="text-blue-400 text-[10px] flex-shrink-0"><i class="fas fa-external-link-alt"></i></a>` : ''}
              ${p.note ? `<span class="text-gray-600 max-w-[60px] truncate">${p.note}</span>` : ''}
            </div>`).join('')}
        </div>
      </details>
      <div class="flex gap-2 mt-2 flex-wrap">
        <button onclick="typeof arcViewMultisendReceipt === 'function' ? arcViewMultisendReceipt('${r.id}') : msPdfReceipt('${r.id}')"
          class="flex items-center gap-1.5 px-3 py-1.5 bg-green-700/30 hover:bg-green-700/50 border border-green-600/40 text-green-300 hover:text-white text-xs rounded-xl transition font-medium">
          <i class="fas fa-eye text-xs"></i>Open Receipt
        </button>
        ${hasTx && !synced ? `<button onclick="msSyncReceiptOnChain('${r.id}').then(()=>msRenderReceipts())"
          class="flex items-center gap-1.5 px-3 py-1.5 bg-yellow-900/20 border border-yellow-700/30 text-yellow-400 text-xs rounded-xl transition">
          <i class="fas fa-sync-alt text-xs"></i>Sync
        </button>` : ''}
        ${r.txHash ? `<a href="${r.explorerUrl}" target="_blank" rel="noopener" class="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800/40 border border-gray-700/30 text-gray-500 text-xs rounded-xl transition ml-auto"><i class="fas fa-external-link-alt text-xs"></i>ArcScan</a>` : ''}
      </div>
    </div>`;
  }).join('');
}

// Persist receipts when new ones are added (patch msExecute flow)
const _msOrigPersist = window.arcSaveMultisendReceipt;
window.arcSaveMultisendReceiptHybrid = function(receiptObj) {
  // Call original if available
  if (typeof _msOrigPersist === 'function') _msOrigPersist(receiptObj).catch(() => {});
  // Also persist to our hybrid store
  msPersistReceipts();
};

// ─── Build receipt object ──────────────────────────────────────────────────────
function msBuildReceipt({ batchId, from, decs, fee, feeTxHash, feeGasUsed, results, hashes, txHash, totalAmount, totalGasUsed, blockTimestamp, approvalTxHash, multicallAddr, method, status }) {
  return {
    id:              `ms-${Date.now()}`,
    batchId,
    timestamp:       new Date().toISOString(),
    blockTimestamp,
    from,
    network:         'Arc Testnet',
    chainId:         MS_CHAIN_ID,
    rpc:             MS_RPC,
    token:           'USDC',
    tokenAddress:    MS_USDC_ADDR,
    tokenDecimals:   decs,
    count:           results.filter(r => r.status === 'confirmed').length,
    totalAmount:     msFmt2(totalAmount),
    fee:             msFmt2(fee),
    feeTxHash,
    approvalTxHash,
    feeGasUsed,
    grandTotal:      msFmt2(Number(totalAmount) + fee),
    governmentFee:   '',
    totalGasUsed,
    multicallAddress: multicallAddr,
    executionMethod:  method,
    recipients:      results,
    txHash,
    explorerUrl:     txHash ? `${MS_EXPLORER}/tx/${txHash}` : MS_EXPLORER,
    status,
    allHashes:       hashes,
    pdfGenerated:    false,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PDF RECEIPT GENERATION
// ═══════════════════════════════════════════════════════════════════════════════
function msPdfReceipt(receiptId) {
  const r = msReceipts.find(x => x.id === receiptId);
  if (!r) { showToast('Receipt not found.', 'error'); return; }

  const jsPDFCtor = window.jspdf?.jsPDF || window.jsPDF;
  if (!jsPDFCtor) {
    // If receipt-viewer is available, open HTML receipt directly instead of waiting for jsPDF
    if (typeof arcViewMultisendReceipt === 'function') {
      arcViewMultisendReceipt(receiptId);
      return;
    }
    showToast('PDF library loading… please try again in a moment.', 'warning');
    setTimeout(() => msPdfReceipt(receiptId), 1500);
    return;
  }

  try {
    const doc    = new jsPDFCtor({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pW     = doc.internal.pageSize.getWidth();
    const pH     = doc.internal.pageSize.getHeight();
    const margin = 16;
    const col2   = 90;
    let   y      = 0;

    const C = {
      bg: [8, 10, 18], bgCard: [14, 18, 30], bgCardAlt: [10, 14, 24],
      cyan: [0, 210, 210], cyanDim: [0, 150, 160], blue: [80, 160, 255],
      green: [80, 220, 120], yellow: [220, 185, 50], red: [220, 80, 80],
      white: [240, 240, 250], gray1: [180, 185, 200], gray2: [120, 125, 145],
      gray3: [70, 75, 95], gray4: [35, 40, 58], header: [12, 80, 110], headerDk: [8, 55, 80],
    };

    const setFont  = (sz, style = 'normal', col = C.white) => {
      doc.setFontSize(sz); doc.setFont('helvetica', style); doc.setTextColor(...col);
    };
    const text     = (t, x, yy, opts = {}) => doc.text(String(t), x, yy, opts);
    const hline    = (yy, col = C.gray4, w = 0.3) => {
      doc.setDrawColor(...col); doc.setLineWidth(w);
      doc.line(margin, yy, pW - margin, yy);
    };
    const rect     = (x, yy, w, h, fill, rx = 0) => {
      doc.setFillColor(...fill);
      if (rx > 0) doc.roundedRect(x, yy, w, h, rx, rx, 'F');
      else        doc.rect(x, yy, w, h, 'F');
    };
    const checkPage = (need = 10) => {
      if (y + need > pH - 15) {
        doc.addPage();
        rect(0, 0, pW, pH, C.bg);
        y = margin;
        return true;
      }
      return false;
    };

    rect(0, 0, pW, pH, C.bg);
    rect(0, 0, pW, 28, C.header);
    rect(0, 26, pW, 2, C.cyan);
    setFont(15, 'bold', C.white); text('⚡ ExecDaat', margin, 12);
    setFont(8, 'normal', [180, 240, 255]); text('arc-ai-agents-618-3v1.pages.dev', margin, 18);
    setFont(10, 'bold', [220, 255, 255]); text('Testnet Transaction Receipt', pW - margin, 12, { align: 'right' });
    setFont(7, 'normal', [140, 200, 230]); text('Arc Testnet · Chain ID 5042002', pW - margin, 18, { align: 'right' });
    y = 38;

    setFont(22, 'bold', C.cyan); text('MULTISEND RECEIPT', margin, y); y += 7;
    hline(y, C.cyanDim, 0.5); y += 5;
    setFont(7.5, 'normal', C.gray2); text('Receipt ID:', margin, y);
    setFont(7.5, 'bold', C.blue); text(r.id, margin + 22, y);
    setFont(7.5, 'normal', C.gray2); text('Batch ID:', col2 + 2, y);
    setFont(7.5, 'bold', C.yellow); text(r.batchId, col2 + 22, y);
    y += 8;

    rect(margin, y, pW - margin * 2, 58, C.bgCard, 3); y += 6;
    const lbl = (label, value, xx = margin + 4, vx = col2 - 10, colV = C.white) => {
      setFont(8, 'normal', C.gray2); text(label, xx, y);
      setFont(8, 'bold', colV); text(value, vx, y);
      y += 5.5;
    };
    const statusColor = r.status === 'confirmed' ? C.green : C.yellow;
    lbl('Status:', r.status === 'confirmed' ? '✓  Confirmed' : '⚠  Partial', margin + 4, margin + 28, statusColor);
    lbl('Date/Time:', new Date(r.timestamp).toLocaleString(), margin + 4, margin + 28, C.gray1);
    lbl('Block Timestamp:', new Date(r.blockTimestamp || r.timestamp).toLocaleString(), margin + 4, margin + 28, C.gray1);
    lbl('Network:', 'Arc Testnet (Chain ID 5042002)', margin + 4, margin + 28, C.cyan);
    lbl('Execution:', r.executionMethod === 'multicall3' ? 'Multicall3 aggregate3 — Atomic Batch (transferFrom)' : 'Sequential (direct transfer)', margin + 4, margin + 28, C.gray1);
    lbl('Token:', `USDC · 6 decimals · ${(r.tokenAddress || '').slice(0,18)}…`, margin + 4, margin + 28, C.gray1);
    lbl('Sender:', r.from || '—', margin + 4, margin + 28, C.blue);
    lbl('Batch Contract:', (r.multicallAddress || '').slice(0, 42), margin + 4, margin + 28, C.gray2);
    y += 2;

    checkPage(44);
    rect(margin, y, pW - margin * 2, 44, [5, 28, 50], 3); y += 6;
    setFont(10, 'bold', C.cyan); text('FINANCIAL SUMMARY', margin + 4, y); y += 6;
    hline(y, C.gray4, 0.2); y += 4;
    const fin = [
      { lbl: 'Total USDC Sent:',    val: `$${r.totalAmount} USDC`,   col: C.green  },
      { lbl: 'Platform Fee Paid:',  val: `$${r.fee} USDC`,           col: C.yellow },
      { lbl: 'Grand Total Paid:',   val: `$${r.grandTotal} USDC`,    col: C.white  },
      { lbl: 'Gas Used:',           val: r.totalGasUsed || 'N/A',    col: C.gray2  },
      { lbl: 'Recipients Count:',   val: `${r.count}`,               col: C.cyan   },
    ];
    fin.forEach(f => {
      setFont(8.5, 'normal', C.gray2); text(f.lbl, margin + 4, y);
      setFont(8.5, 'bold', f.col); text(f.val, pW - margin - 4, y, { align: 'right' });
      y += 5.5;
    });
    y += 4;

    // Transaction hashes
    const hashRows = [
      r.txHash     && { label: 'Batch Tx (Multicall3):', hash: r.txHash,          col: C.blue   },
      r.feeTxHash  && { label: 'Platform Fee Tx:',       hash: r.feeTxHash,       col: C.yellow },
      r.approvalTxHash && { label: 'USDC Approval Tx:',  hash: r.approvalTxHash, col: C.cyan   },
    ].filter(Boolean);

    if (hashRows.length) {
      checkPage(10 + hashRows.length * 5);
      const boxH = 12 + hashRows.length * 5;
      rect(margin, y, pW - margin * 2, boxH, C.bgCardAlt, 3); y += 5;
      setFont(8.5, 'bold', C.blue); text('TRANSACTION HASHES', margin + 4, y); y += 5;
      hline(y, C.gray4, 0.2); y += 4;
      hashRows.forEach(hr => {
        setFont(7, 'normal', C.gray2); text(hr.label, margin + 4, y);
        setFont(6.8, 'normal', hr.col);
        doc.textWithLink((hr.hash || '').slice(0, 60), margin + 42, y, { url: `${MS_EXPLORER}/tx/${hr.hash}` });
        y += 4.5;
      });
      y += 4;
    }

    checkPage(22);
    setFont(10, 'bold', C.cyan);
    text(`RECIPIENTS  (${r.recipients?.length || 0} total · ${r.count} confirmed)`, margin, y); y += 6;
    rect(margin, y - 4.5, pW - margin * 2, 6.5, C.headerDk, 2);
    setFont(7.5, 'bold', [180, 240, 255]);
    text('#', margin + 2, y); text('Address', margin + 9, y);
    text('Amount', margin + 98, y); text('Status', margin + 118, y); text('Note', margin + 138, y);
    y += 2; hline(y, C.cyanDim, 0.3); y += 3;

    (r.recipients || []).forEach((p, i) => {
      checkPage(7);
      const rowFill = i % 2 === 0 ? C.bgCard : C.bgCardAlt;
      rect(margin, y - 4, pW - margin * 2, 5.8, rowFill);
      const sc = p.status === 'confirmed' ? C.green : p.status === 'failed' ? C.red : [200, 180, 60];
      setFont(6.8, 'normal', C.gray3); text(String(i + 1), margin + 2, y);
      setFont(6.8, 'normal', C.blue);  text((p.address || '').slice(0, 24) + '…', margin + 9, y);
      setFont(6.8, 'bold',   C.cyan);  text('$' + msFmt2(p.amount), margin + 98, y);
      setFont(6.8, 'bold',   sc);      text(p.status || '—', margin + 118, y);
      setFont(6.5, 'normal', C.gray3); text((p.note || '').slice(0, 20), margin + 138, y);
      y += 5.8;
    });
    y += 6;

    if (r.txHash) {
      checkPage(14);
      rect(margin, y, pW - margin * 2, 12, [8, 22, 40], 3); y += 5;
      setFont(8, 'bold', C.blue); text('View on ArcScan Explorer:', margin + 4, y);
      setFont(7, 'normal', C.blue);
      doc.textWithLink(r.explorerUrl.slice(0, 75), margin + 4, y + 4.5, { url: r.explorerUrl }); y += 10;
    }

    checkPage(16);
    rect(margin, y, pW - margin * 2, 14, [20, 10, 10], 3); y += 5;
    setFont(7.5, 'bold', [220, 120, 80]); text('⚠  TESTNET DISCLAIMER', margin + 4, y); y += 4.5;
    setFont(6.5, 'normal', C.gray2);
    text('This transaction was executed on Arc Testnet. No real funds were transferred. This receipt is for testing purposes only.', margin + 4, y);
    y += 8;

    const totalPages = doc.internal.getNumberOfPages();
    for (let pg = 1; pg <= totalPages; pg++) {
      doc.setPage(pg);
      rect(0, pH - 10, pW, 10, C.header);
      rect(0, pH - 11, pW, 1, C.cyan);
      setFont(6.5, 'normal', [180, 220, 240]);
      text('ExecDaat · Testnet Receipt · Not a financial document', margin, pH - 5);
      setFont(6.5, 'normal', C.gray2);
      text(`Page ${pg} of ${totalPages}  ·  Generated ${new Date().toLocaleString()}`, pW - margin, pH - 5, { align: 'right' });
    }

    // No auto-download — open in new tab with print dialog
    const idx = msReceipts.findIndex(x => x.id === receiptId);
    if (idx >= 0) { msReceipts[idx].pdfGenerated = true; }
    // Persist receipt for future access
    if (typeof arcSaveMultisendReceipt === 'function') arcSaveMultisendReceipt(r).catch(() => {});
    // Open HTML receipt in new tab (better cross-browser support)
    if (typeof arcBuildMultisendReceiptHTML === 'function' && typeof arcOpenReceiptTab === 'function') {
      arcOpenReceiptTab(arcBuildMultisendReceiptHTML(r), 'Multisend Receipt');
      showToast('✅ Receipt opened in new tab.', 'success');
      if (idx >= 0) msRenderReceipts();
      return;
    }
    // Fallback: open PDF blob in new tab
    const pdfBlob = doc.output('blob');
    const pdfUrl  = URL.createObjectURL(pdfBlob);
    const pdfWin  = window.open(pdfUrl, '_blank');
    if (pdfWin) setTimeout(() => URL.revokeObjectURL(pdfUrl), 30000);
    showToast('✅ Receipt opened in new tab.', 'success');
    if (idx >= 0) msRenderReceipts();

  } catch (err) {
    console.error('[MULTISEND v7] PDF error:', err);
    showToast('PDF generation error: ' + err.message, 'error');
  }
}

// ─── JSON download ─────────────────────────────────────────────────────────────
function msDownloadReceipt(receiptId) {
  // No auto-download — open receipt in new tab with print dialog
  const r = msReceipts.find(x => x.id === receiptId);
  if (!r) { showToast('Receipt not found.', 'error'); return; }
  if (typeof arcViewMultisendReceipt === 'function') {
    arcViewMultisendReceipt(r);
  } else {
    msPdfReceipt(receiptId);
  }
}

// Legacy JSON export (kept for external calls only — not triggered by UI)
function msExportReceiptJSON(receiptId) {
  const r = msReceipts.find(x => x.id === receiptId);
  if (!r) return;
  const doc = {
    receiptType: 'ARC_MULTISEND_BATCH_RECEIPT', version: '7.0',
    generatedAt: new Date().toISOString(),
    batchId: r.batchId, timestamp: r.timestamp, blockTimestamp: r.blockTimestamp,
    network: { name: r.network, chainId: r.chainId, explorer: MS_EXPLORER, rpc: MS_RPC, gasToken: 'USDC' },
    sender: r.from, token: r.token, tokenAddress: r.tokenAddress, tokenDecimals: r.tokenDecimals,
    totalAmountSent: r.totalAmount, platformFee: r.fee, governmentFee: r.governmentFee || '',
    grandTotal: r.grandTotal, gasUsed: r.totalGasUsed,
    multicallContract: r.multicallAddress, executionMethod: r.executionMethod,
    recipientCount: r.count, txHash: r.txHash, feeTxHash: r.feeTxHash,
    approvalTxHash: r.approvalTxHash,
    allTxHashes: r.allHashes, explorerUrl: r.explorerUrl, status: r.status,
    recipients: (r.recipients || []).map(p => ({
      address: p.address, amount: msFmt2(p.amount), note: p.note || '',
      txHash: p.txHash || null, status: p.status || 'unknown', gasUsed: p.gasUsed || null,
    })),
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }));
  const a   = Object.assign(document.createElement('a'), { href: url, download: `arc_receipt_${r.batchId}.json` });
  a.click(); URL.revokeObjectURL(url);
  showToast('JSON receipt exported.', 'success');
}

// ─── Global exports ────────────────────────────────────────────────────────────
window.msInit             = msInit;
window.msAddRow           = msAddRow;
window.msSubmit           = msExecute;
window.msHandleCSV        = msHandleCSV;
window.msEditAll          = msEditAll;
window.msDownloadTemplate = msDownloadTemplate;
window.msDownloadReceipt  = msDownloadReceipt;
window.msPdfReceipt       = msPdfReceipt;
window.msUpdateStats      = msUpdateStats;
window.msValidateAddr     = msValidateAddr;
window.msProceedToReview  = msProceedToReview;
window.msProceedToSend    = msProceedToSend;
window.msExecute          = msExecute;
window.msGoBack           = msGoBack;
window.msReceipts         = msReceipts;

// Legacy compat
window.addMultisendRow      = (a, b, c) => msAddRow(a, b, c);
window.updateMultisendTotal = msUpdateStats;
window.submitMultisend      = () => { if (typeof msProceedToReview === 'function') msProceedToReview(); };

// ─── Debug helpers ────────────────────────────────────────────────────────────
window.msDebug = {
  checkMulticall3: async () => {
    const code = await fetch(MS_RPC, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({jsonrpc:'2.0',method:'eth_getCode',params:[MS_MULTICALL3_ADDR,'latest'],id:1})
    }).then(r=>r.json());
    const deployed = code.result && code.result !== '0x';
    msLog('Multicall3 deployed:', deployed, '| address:', MS_MULTICALL3_ADDR);
    return deployed;
  },
  checkAllowance: async (owner, spender = MS_MULTICALL3_ADDR) => {
    if (!window.ethers) { msError('ethers.js not loaded'); return; }
    const provider = new window.ethers.JsonRpcProvider(MS_RPC);
    const usdc = new window.ethers.Contract(MS_USDC_ADDR, MS_ERC20_ABI, provider);
    const allowance = await usdc.allowance(owner, spender);
    const balance   = await usdc.balanceOf(owner);
    msLog(`Allowance: ${window.ethers.formatUnits(allowance, 6)} USDC | Balance: ${window.ethers.formatUnits(balance, 6)} USDC`);
    return { allowance, balance };
  },
  getState: () => ({ msExecuting, msValidatedRows, msReceipts, msCurrentStep }),
};

console.log('%c[MULTISEND v7]', 'color:#22d3ee;font-weight:bold',
  'Loaded | Arc Testnet', MS_CHAIN_ID,
  '| USDC', MS_USDC_ADDR,
  '| Multicall3 (confirmed deployed):', MS_MULTICALL3_ADDR,
  '| Flow: approve MC3 → pay fee → aggregate3(transferFrom) | Single tx batch'
);
