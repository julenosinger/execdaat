// ============================================================
// ARC Receipt Viewer v1
// Persistent receipt storage (IndexedDB/localStorage)
// Opens receipt in new tab with print dialog
// No auto-download – store & view on demand
// ============================================================
'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────
const ARC_RECEIPTS_STORE = 'arc_receipts_v1';
const ARC_RECEIPTS_IDB   = 'receipts';   // IndexedDB store name inside arc_agents_db

// ─── Internal receipt cache (session) ────────────────────────────────────────
const arcReceiptCache = new Map();

// ─── Storage helpers ──────────────────────────────────────────────────────────
function arcReceiptLS_save(id, data) {
  try {
    const all = arcReceiptLS_all();
    all[id] = data;
    localStorage.setItem(ARC_RECEIPTS_STORE, JSON.stringify(all));
  } catch(e) { /* storage full – ignore */ }
}
function arcReceiptLS_get(id) {
  try {
    const all = arcReceiptLS_all();
    return all[id] || null;
  } catch { return null; }
}
function arcReceiptLS_all() {
  try { return JSON.parse(localStorage.getItem(ARC_RECEIPTS_STORE) || '{}'); } catch { return {}; }
}

// Save receipt via IndexedDB (preferred) or localStorage fallback
async function arcReceiptSave(receipt) {
  if (!receipt || !receipt.id) return;
  arcReceiptCache.set(receipt.id, receipt);

  // Try IndexedDB first (uses shared ARC db from persistence.js if available)
  if (typeof arcDBOpen === 'function') {
    try {
      const db = await arcDBOpen();
      if (db) {
        await new Promise((res, rej) => {
          // Use existing DB if open, or open fresh
          const tx  = db.transaction(ARC_RECEIPTS_IDB, 'readwrite');
          const st  = tx.objectStore(ARC_RECEIPTS_IDB);
          const req = st.put(receipt);
          req.onsuccess = () => res();
          req.onerror   = () => rej(req.error);
        });
        return;
      }
    } catch(e) { /* fall through to localStorage */ }
  }

  arcReceiptLS_save(receipt.id, receipt);
}

// Load receipt by id from IndexedDB or localStorage
async function arcReceiptLoad(id) {
  // Check session cache first
  if (arcReceiptCache.has(id)) return arcReceiptCache.get(id);

  // Try IndexedDB
  if (typeof arcDBOpen === 'function') {
    try {
      const db = await arcDBOpen();
      if (db) {
        const r = await new Promise((res, rej) => {
          const tx  = db.transaction(ARC_RECEIPTS_IDB, 'readonly');
          const req = tx.objectStore(ARC_RECEIPTS_IDB).get(id);
          req.onsuccess = () => res(req.result || null);
          req.onerror   = () => rej(req.error);
        });
        if (r) { arcReceiptCache.set(id, r); return r; }
      }
    } catch { /* fall through */ }
  }

  // Fallback to localStorage
  const r = arcReceiptLS_get(id);
  if (r) arcReceiptCache.set(id, r);
  return r;
}

// ─── HTML receipt builders ────────────────────────────────────────────────────
function arcBuildPaymentReceiptHTML(r) {
  const ts = new Date(r.timestamp || r.createdAt || Date.now()).toLocaleString();
  const statusLabel = r.status === 'scheduled' ? '⏰ SCHEDULED'
    : r.status === 'failed' ? '✗ FAILED' : '✓ CONFIRMED';
  const statusColor = r.status === 'scheduled' ? '#7c3aed'
    : r.status === 'failed' ? '#dc2626' : '#059669';

  const row = (lbl, val) => `<div class="row"><span class="lbl">${lbl}</span><span class="val">${val}</span></div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payment Receipt — ARC Testnet</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',Arial,sans-serif;background:#fff;color:#111;padding:40px;max-width:660px;margin:auto}
.header{background:linear-gradient(135deg,#f0f0ff,#e8f4ff);border-radius:12px;padding:24px;text-align:center;margin-bottom:28px}
.header h1{font-size:22px;color:#3730a3;margin-bottom:6px}
.header .sub{font-size:12px;color:#6b7280;margin-bottom:10px}
.badge{display:inline-block;padding:5px 16px;border-radius:20px;font-size:12px;font-weight:700;background:${statusColor}22;color:${statusColor};border:1px solid ${statusColor}55}
.sec{font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#6366f1;font-weight:700;background:#f5f5ff;padding:6px 12px;border-radius:6px;margin:20px 0 8px}
.row{display:flex;justify-content:space-between;align-items:flex-start;padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:13px}
.lbl{color:#6b7280;flex-shrink:0;margin-right:16px}
.val{font-weight:600;word-break:break-all;text-align:right}
.mono{font-family:monospace;font-size:11px}
.footer{margin-top:32px;font-size:10px;color:#9ca3af;text-align:center;border-top:1px solid #e5e7eb;padding-top:14px}
.print-btn{display:block;margin:24px auto 0;padding:10px 28px;background:#3730a3;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;letter-spacing:.03em}
.print-btn:hover{background:#4338ca}
@media print{.print-btn{display:none}body{padding:20px}}
</style>
</head>
<body>
<div class="header">
  <h1>💳 Payment Receipt</h1>
  <div class="sub">ARC AI Agents · Arc Testnet · ${ts}</div>
  <span class="badge">${statusLabel}</span>
</div>

<div class="sec">Sender Information</div>
${row('Full Name', r.fullname || '—')}
${row('Email', r.email || '—')}
${row('From Wallet', `<span class="mono">${r.sender || r.from || '—'}</span>`)}

<div class="sec">Payment Details</div>
${row('Token', `<span style="color:#2563eb;font-weight:700">${r.token}</span>`)}
${row('Amount', `<strong>${Number(r.amount).toFixed(6)} ${r.token}</strong>`)}
${row('Recipient', `<span class="mono">${r.recipient || '—'}</span>`)}
${row('Network', `<span style="color:#059669">${r.network || 'Arc Testnet'}</span>`)}
${r.note ? row('Note', `<em>${r.note}</em>`) : ''}
${r.scheduledAt ? row('Scheduled For', new Date(r.scheduledAt).toLocaleString()) : ''}

<div class="sec">Transaction Details</div>
${r.txHash ? row('Transaction Hash', `<span class="mono">${r.txHash}</span>`) : ''}
${r.txHash ? row('Explorer', `<a href="${r.explorerUrl}" style="color:#2563eb">${r.explorerUrl}</a>`) : ''}
${row('Date & Time', ts)}
${r.gasFee ? row('Est. Gas', `~${r.gasFee} ARC`) : ''}

<div class="footer">Generated by ARC AI Agents &middot; testnet.arcscan.app &middot; Testnet only — no real funds</div>
<button class="print-btn" onclick="window.print()">🖨️ Print / Save as PDF</button>
</body>
</html>`;
}

function arcBuildContractReceiptHTML(r) {
  const now = new Date().toLocaleString();
  const row = (lbl, val) => `<div class="row"><span class="label">${lbl}</span><span class="value">${val}</span></div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Contract Receipt #${r.contractId || r.id} — ARC</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Courier New',monospace;background:#fff;color:#111;padding:40px;max-width:700px;margin:auto}
.header{text-align:center;border-bottom:3px solid #1565c0;padding-bottom:20px;margin-bottom:28px}
.header h1{font-size:24px;color:#1565c0;margin:0 0 4px}
.header p{color:#666;font-size:12px;margin:0}
.badge{display:inline-block;background:#d4edda;color:#155724;border:1px solid #c3e6cb;border-radius:4px;padding:4px 14px;font-size:13px;font-weight:bold;margin-top:10px}
.section{margin-bottom:24px}
.section h2{font-size:13px;text-transform:uppercase;letter-spacing:.1em;color:#1565c0;border-bottom:1px solid #e0e0e0;padding-bottom:6px;margin-bottom:12px}
.row{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #f5f5f5;font-size:12px}
.label{color:#666}
.value{font-weight:bold;color:#111;text-align:right;max-width:60%;word-break:break-all}
.fee-box{background:#fff8e1;border:1px solid #ffe082;border-radius:6px;padding:12px 16px;margin-top:8px}
.fee-box .total{font-size:18px;font-weight:bold;color:#1565c0}
.proof-item{padding:6px 0;border-bottom:1px solid #f5f5f5;font-size:11px;color:#333}
.footer{text-align:center;margin-top:40px;padding-top:16px;border-top:2px solid #1565c0;font-size:10px;color:#999}
.print-btn{display:block;margin:24px auto 0;padding:10px 28px;background:#1565c0;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}
.print-btn:hover{background:#1976d2}
@media print{.print-btn{display:none}body{padding:20px}}
</style>
</head>
<body>
<div class="header">
  <h1>⛓ ARC CONTRACT RECEIPT</h1>
  <p>Arc Network Testnet · Trustless Escrow · On-Chain Verified</p>
  <div class="badge">✅ COMPLETED</div>
</div>

<div class="section">
  <h2>Contract Details</h2>
  ${row('Contract ID', `#${r.contractId || r.id}`)}
  ${row('Title', r.title || '—')}
  ${row('Network', `${r.network || 'Arc Testnet'} (Chain ${r.chainId || '5042002'})`)}
  ${r.factory ? row('Factory', r.factory) : ''}
  ${row('Completed At', r.completedAt || now)}
  ${row('Generated At', now)}
</div>

<div class="section">
  <h2>Parties</h2>
  ${row('Client Wallet', `<span style="font-family:monospace;font-size:10px">${r.client || '—'}</span>`)}
  ${r.clientEmail ? row('Client Email', r.clientEmail) : ''}
  ${row('Contractor Wallet', `<span style="font-family:monospace;font-size:10px">${r.contractor || '—'}</span>`)}
  ${r.contractorEmail ? row('Contractor Email', r.contractorEmail) : ''}
</div>

<div class="section">
  <h2>Financial Summary</h2>
  <div class="fee-box">
    <div class="row" style="border:none;padding:4px 0">${row('Total Contract Value', `<span class="total">$${r.totalValue || '—'} USDC</span>`)}</div>
    <div class="row" style="border:none;padding:4px 0">${row('Platform Fee (0.2%)', `<span style="color:#e65100">−$${r.feeValue || '—'} USDC</span>`)}</div>
    <div class="row" style="border:none;padding:4px 0;border-top:1px solid #ffe082;margin-top:4px">${row('Net to Contractor', `<span style="color:#2e7d32;font-size:16px">$${r.netValue || '—'} USDC</span>`)}</div>
  </div>
</div>

${r.otcPoints ? `<div class="section">
  <h2>OTC Negotiation</h2>
  ${row('Points/Tokens', r.otcPoints)}
  ${r.otcTerms ? row('Terms', r.otcTerms) : ''}
</div>` : ''}

<div class="section">
  <h2>Proof of Work (${(r.proofs || []).length} file${(r.proofs || []).length !== 1 ? 's' : ''})</h2>
  ${(r.proofs || []).length
    ? (r.proofs || []).map((p, i) => `<div class="proof-item">${i+1}. ${p.name}${p.cid ? ` — IPFS: ${p.cid}` : ' (stored locally)'} — ${new Date(p.uploadedAt).toLocaleString()}</div>`).join('')
    : '<p style="color:#999;font-size:12px">No proof files.</p>'}
</div>

<div class="footer">
  <p>This receipt was generated by the ARC Contracts Module.</p>
  <p>All on-chain data is verifiable at <strong>testnet.arcscan.app</strong></p>
  <p style="margin-top:8px;color:#bbb">Contract #${r.contractId || r.id}</p>
</div>
<button class="print-btn" onclick="window.print()">🖨️ Print / Save as PDF</button>
</body>
</html>`;
}

function arcBuildMultisendReceiptHTML(r) {
  const ts = new Date(r.timestamp || Date.now()).toLocaleString();
  const row = (lbl, val) => `<div class="row"><span class="label">${lbl}</span><span class="value">${val}</span></div>`;

  const recipientRows = (r.recipients || []).map((p, i) => `
    <tr>
      <td>${i + 1}</td>
      <td style="font-family:monospace;font-size:10px">${p.address}</td>
      <td style="color:#2563eb;font-weight:700">$${p.amount} USDC</td>
      <td>${p.note || '—'}</td>
      <td style="color:${p.status==='confirmed'?'#059669':p.status==='failed'?'#dc2626':'#d97706'}">${p.status || '—'}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Multisend Receipt — ${r.batchId || r.id} — ARC</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',Arial,sans-serif;background:#fff;color:#111;padding:40px;max-width:760px;margin:auto}
.header{background:linear-gradient(135deg,#0a0a1a,#0c1a2e);color:#fff;border-radius:12px;padding:24px;text-align:center;margin-bottom:28px}
.header h1{font-size:22px;color:#00d2d2;margin-bottom:6px}
.header .sub{font-size:12px;color:#8899bb;margin-bottom:10px}
.badge{display:inline-block;padding:4px 14px;border-radius:20px;font-size:12px;font-weight:700;background:rgba(0,210,210,.15);color:#00d2d2;border:1px solid rgba(0,210,210,.4)}
.section{margin-bottom:24px}
.section h2{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:#0284c7;border-bottom:1px solid #e0e0e0;padding-bottom:6px;margin-bottom:12px}
.row{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #f5f5f5;font-size:13px}
.label{color:#6b7280}
.value{font-weight:600;text-align:right;word-break:break-all}
.totals{background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:14px 18px;margin-top:8px}
table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}
th{background:#f5f5f5;text-align:left;padding:6px 10px;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em}
td{padding:6px 10px;border-bottom:1px solid #f5f5f5}
.footer{margin-top:32px;font-size:10px;color:#9ca3af;text-align:center;border-top:1px solid #e5e7eb;padding-top:14px}
.print-btn{display:block;margin:24px auto 0;padding:10px 28px;background:#0284c7;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}
.print-btn:hover{background:#0369a1}
.disclaimer{background:#fff8e1;border:1px solid #ffe082;border-radius:6px;padding:10px 14px;margin-top:16px;font-size:11px;color:#92400e}
@media print{.print-btn{display:none}.disclaimer{-webkit-print-color-adjust:exact;print-color-adjust:exact}body{padding:20px}}
</style>
</head>
<body>
<div class="header">
  <h1>📦 Multisend Batch Receipt</h1>
  <div class="sub">ARC AI Agents · Arc Testnet · ${ts}</div>
  <span class="badge">${r.status === 'confirmed' ? '✅ CONFIRMED' : r.status === 'partial' ? '⚠️ PARTIAL' : '⏳ PENDING'}</span>
</div>

<div class="section">
  <h2>Batch Information</h2>
  ${row('Batch ID', r.batchId || r.id || '—')}
  ${row('Network', `${r.network || 'Arc Testnet'} (Chain ${r.chainId || '5042002'})`)}
  ${row('Token', r.token || 'USDC')}
  ${row('Execution Method', r.executionMethod || 'batch')}
  ${row('Timestamp', ts)}
</div>

<div class="section">
  <h2>Sender</h2>
  ${row('From Wallet', `<span style="font-family:monospace;font-size:10px">${r.from || '—'}</span>`)}
</div>

<div class="section">
  <h2>Financial Summary</h2>
  <div class="totals">
    ${row('Total Amount Sent', `<strong style="color:#2563eb;font-size:15px">$${r.totalAmount} USDC</strong>`)}
    ${row('Platform Fee', `<span style="color:#d97706">$${r.fee || '0.00'} USDC</span>`)}
    ${row('Recipients', `${r.count || (r.recipients || []).length}`)}
    ${row('Gas Used', r.totalGasUsed || '—')}
  </div>
</div>

${r.txHash ? `<div class="section">
  <h2>Transaction Hashes</h2>
  ${row('Batch Tx', `<span style="font-family:monospace;font-size:10px">${r.txHash}</span>`)}
  ${row('Explorer', `<a href="${r.explorerUrl}" style="color:#2563eb;word-break:break-all">${r.explorerUrl}</a>`)}
  ${r.feeTxHash ? row('Fee Tx', `<span style="font-family:monospace;font-size:10px">${r.feeTxHash}</span>`) : ''}
  ${r.approvalTxHash ? row('Approval Tx', `<span style="font-family:monospace;font-size:10px">${r.approvalTxHash}</span>`) : ''}
</div>` : ''}

<div class="section">
  <h2>Recipients (${(r.recipients || []).length})</h2>
  <table>
    <thead><tr><th>#</th><th>Address</th><th>Amount</th><th>Note</th><th>Status</th></tr></thead>
    <tbody>${recipientRows}</tbody>
  </table>
</div>

<div class="disclaimer">
  ⚠️ <strong>Testnet Disclaimer:</strong> This transaction was executed on Arc Testnet. No real funds were transferred. This receipt is for testing purposes only.
</div>

<div class="footer">Generated by ARC AI Agents &middot; testnet.arcscan.app &middot; Not a financial document</div>
<button class="print-btn" onclick="window.print()">🖨️ Print / Save as PDF</button>
</body>
</html>`;
}

// ─── Open receipt in new tab ───────────────────────────────────────────────────
function arcOpenReceiptTab(html, title) {
  try {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const win  = window.open(url, '_blank', 'noopener');
    if (win) {
      // Revoke blob URL after tab loads to free memory
      const cleanup = () => { setTimeout(() => URL.revokeObjectURL(url), 5000); };
      win.addEventListener('load', cleanup, { once: true });
      // Fallback cleanup if window doesn't fire load
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } else {
      // Pop-up blocked: store in localStorage and redirect
      const key = 'arc_receipt_popup_' + Date.now();
      sessionStorage.setItem(key, html);
      window.open(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`, '_blank');
      if (typeof showToast === 'function') showToast('⚠️ Pop-up bloqueado — verifique as permissões do browser', 'warning');
    }
    return true;
  } catch(e) {
    console.error('[ARC:Receipt] Failed to open receipt tab:', e);
    return false;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Save a payment receipt (call after successful payment)
 */
async function arcSavePaymentReceipt(receipt) {
  const r = { ...receipt, _type: 'payment', _savedAt: Date.now() };
  arcReceiptCache.set(r.id, r);
  await arcReceiptSave(r).catch(() => arcReceiptLS_save(r.id, r));
  return r;
}

/**
 * Save a contract receipt
 */
async function arcSaveContractReceipt(receipt) {
  const r = { ...receipt, _type: 'contract', _savedAt: Date.now() };
  arcReceiptCache.set(r.id, r);
  await arcReceiptSave(r).catch(() => arcReceiptLS_save(r.id, r));
  return r;
}

/**
 * Save a multisend receipt
 */
async function arcSaveMultisendReceipt(receipt) {
  const r = { ...receipt, _type: 'multisend', _savedAt: Date.now() };
  arcReceiptCache.set(r.id, r);
  await arcReceiptSave(r).catch(() => arcReceiptLS_save(r.id, r));
  return r;
}

/**
 * Open a payment receipt in a new browser tab with print dialog
 */
async function arcViewPaymentReceipt(idOrData) {
  let r = typeof idOrData === 'object' ? idOrData : (await arcReceiptLoad(idOrData));
  if (!r) { if (typeof showToast==='function') showToast('Receipt not found', 'error'); return; }
  const html = arcBuildPaymentReceiptHTML(r);
  arcOpenReceiptTab(html, 'Payment Receipt');
}

/**
 * Open a contract receipt in a new browser tab with print dialog
 */
async function arcViewContractReceipt(idOrData) {
  let r = typeof idOrData === 'object' ? idOrData : (await arcReceiptLoad(idOrData));
  if (!r) { if (typeof showToast==='function') showToast('Receipt not found', 'error'); return; }
  const html = arcBuildContractReceiptHTML(r);
  arcOpenReceiptTab(html, 'Contract Receipt');
}

/**
 * Open a multisend receipt in a new browser tab with print dialog
 */
async function arcViewMultisendReceipt(idOrData) {
  let r = typeof idOrData === 'object' ? idOrData : (await arcReceiptLoad(idOrData));
  if (!r) { if (typeof showToast==='function') showToast('Receipt not found', 'error'); return; }
  const html = arcBuildMultisendReceiptHTML(r);
  arcOpenReceiptTab(html, 'Multisend Receipt');
}

/**
 * Generic view by id – auto-detects type
 */
async function arcViewReceipt(id) {
  const r = await arcReceiptLoad(id);
  if (!r) { if (typeof showToast==='function') showToast('Receipt not found', 'error'); return; }
  if (r._type === 'contract') return arcViewContractReceipt(r);
  if (r._type === 'multisend') return arcViewMultisendReceipt(r);
  return arcViewPaymentReceipt(r);
}

/**
 * Get all receipts from localStorage (fallback listing)
 */
function arcGetAllReceipts() {
  const ls = arcReceiptLS_all();
  return Object.values(ls).sort((a, b) => (b._savedAt || 0) - (a._savedAt || 0));
}

// ─── Ensure receipts store exists in IndexedDB if persistence.js is loaded ────
document.addEventListener('DOMContentLoaded', () => {
  // The shared DB from persistence.js may not include the receipts store.
  // We use a separate minimal DB for receipts to avoid coupling.
  const RCPT_DB = 'arc_receipts_db';
  const RCPT_VER = 1;
  try {
    const req = indexedDB.open(RCPT_DB, RCPT_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('receipts')) {
        db.createObjectStore('receipts', { keyPath: 'id' });
      }
    };
    req.onsuccess = e => {
      arcReceiptCache._db = e.target.result;
      // Override arcReceiptSave to use this dedicated DB
      const _db = e.target.result;
      window._arcReceiptsDB = _db;
    };
  } catch { /* ignore */ }
});

// ─── Override arcReceiptSave/arcReceiptLoad to use dedicated DB ───────────────
async function _arcReceiptIDB_save(receipt) {
  const db = window._arcReceiptsDB;
  if (!db) return false;
  return new Promise((res) => {
    try {
      const tx  = db.transaction('receipts', 'readwrite');
      const req = tx.objectStore('receipts').put(receipt);
      req.onsuccess = () => res(true);
      req.onerror   = () => res(false);
    } catch { res(false); }
  });
}

async function _arcReceiptIDB_load(id) {
  const db = window._arcReceiptsDB;
  if (!db) return null;
  return new Promise((res) => {
    try {
      const tx  = db.transaction('receipts', 'readonly');
      const req = tx.objectStore('receipts').get(id);
      req.onsuccess = () => res(req.result || null);
      req.onerror   = () => res(null);
    } catch { res(null); }
  });
}

// Patch arcReceiptSave/arcReceiptLoad to use dedicated DB
const _origSave = arcReceiptSave;
window.arcReceiptSave = async function(receipt) {
  arcReceiptCache.set(receipt.id, receipt);
  const ok = await _arcReceiptIDB_save(receipt);
  if (!ok) arcReceiptLS_save(receipt.id, receipt);
};

const _origLoad = arcReceiptLoad;
window.arcReceiptLoad = async function(id) {
  if (arcReceiptCache.has(id)) return arcReceiptCache.get(id);
  const r = await _arcReceiptIDB_load(id);
  if (r) { arcReceiptCache.set(id, r); return r; }
  const ls = arcReceiptLS_get(id);
  if (ls) { arcReceiptCache.set(id, ls); }
  return ls;
};

// ─── Expose globals ────────────────────────────────────────────────────────────
Object.assign(window, {
  arcSavePaymentReceipt,
  arcSaveContractReceipt,
  arcSaveMultisendReceipt,
  arcViewPaymentReceipt,
  arcViewContractReceipt,
  arcViewMultisendReceipt,
  arcViewReceipt,
  arcGetAllReceipts,
  arcBuildPaymentReceiptHTML,
  arcBuildContractReceiptHTML,
  arcBuildMultisendReceiptHTML,
  arcOpenReceiptTab,
});
