// ============================================================
// ARC Receipt Viewer v1 — Centralised receipt open/print/export
// No auto-downloads. User controls: view → print → optional save.
// Supports: Payment · Contract · Multisend receipts
// ============================================================
'use strict';

// ─── Receipt store (in-memory + IndexedDB/localStorage via arcSave) ───────────
const arcReceiptStore = {
  _items: {},   // id → receipt data

  set(id, data) {
    this._items[id] = { ...data, _storedAt: Date.now() };
    // Persist via arcSave if available
    if (typeof arcSave === 'function') {
      arcSave('receipts_meta', {
        id,
        type: data._type || 'payment',
        wallet: (window.walletState?.address || '').toLowerCase(),
        timestamp: data.timestamp || data.createdAt || new Date().toISOString(),
        _data: data,
      }).catch(() => {});
    }
    // Always mirror to localStorage
    try {
      const all = JSON.parse(localStorage.getItem('arc_receipts') || '{}');
      all[id] = { ...data, _storedAt: Date.now() };
      // Keep latest 50
      const keys = Object.keys(all).sort((a, b) => (all[b]._storedAt || 0) - (all[a]._storedAt || 0));
      if (keys.length > 50) keys.slice(50).forEach(k => delete all[k]);
      localStorage.setItem('arc_receipts', JSON.stringify(all));
    } catch (_) {}
  },

  get(id) {
    if (this._items[id]) return this._items[id];
    // Fallback localStorage
    try {
      const all = JSON.parse(localStorage.getItem('arc_receipts') || '{}');
      if (all[id]) { this._items[id] = all[id]; return all[id]; }
    } catch (_) {}
    return null;
  },

  loadFromStorage() {
    try {
      const all = JSON.parse(localStorage.getItem('arc_receipts') || '{}');
      Object.assign(this._items, all);
    } catch (_) {}
  },
};

// Load persisted receipts on module start
arcReceiptStore.loadFromStorage();

// ─── HTML template builders ───────────────────────────────────────────────────

function _arcReceiptCSS() {
  return `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', Arial, sans-serif;
      background: #f8faff;
      color: #111827;
      padding: 40px 24px;
      max-width: 720px;
      margin: 0 auto;
    }
    .arc-rcpt-header {
      background: linear-gradient(135deg, #1e3a5f 0%, #0f2341 100%);
      color: #fff;
      border-radius: 14px;
      padding: 28px 32px;
      text-align: center;
      margin-bottom: 28px;
      position: relative;
    }
    .arc-rcpt-header h1 { font-size: 22px; font-weight: 800; letter-spacing: 0.02em; margin-bottom: 4px; }
    .arc-rcpt-header p  { font-size: 12px; color: rgba(255,255,255,0.65); }
    .arc-rcpt-badge {
      display: inline-block;
      padding: 5px 18px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      margin-top: 12px;
      letter-spacing: 0.06em;
    }
    .badge-confirmed { background: rgba(52,211,153,0.18); color: #34d399; border: 1px solid rgba(52,211,153,0.3); }
    .badge-scheduled { background: rgba(167,139,250,0.18); color: #c4b5fd; border: 1px solid rgba(167,139,250,0.3); }
    .badge-partial   { background: rgba(245,158,11,0.18);  color: #fbbf24; border: 1px solid rgba(245,158,11,0.3); }
    .badge-failed    { background: rgba(239,68,68,0.15);   color: #f87171; border: 1px solid rgba(239,68,68,0.3); }
    .arc-rcpt-section { margin-bottom: 24px; }
    .arc-rcpt-section h2 {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: #2563eb;
      background: #eff6ff;
      padding: 6px 14px;
      border-radius: 8px;
      margin-bottom: 10px;
    }
    .arc-rcpt-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      padding: 8px 0;
      border-bottom: 1px solid #f1f5f9;
      font-size: 13px;
      gap: 12px;
    }
    .arc-rcpt-row:last-child { border-bottom: none; }
    .arc-rcpt-label { color: #64748b; flex-shrink: 0; min-width: 130px; }
    .arc-rcpt-value { font-weight: 600; color: #111827; text-align: right; word-break: break-all; }
    .arc-rcpt-mono  { font-family: 'Courier New', monospace; font-size: 11px; }
    .arc-rcpt-green { color: #059669; }
    .arc-rcpt-blue  { color: #2563eb; }
    .arc-rcpt-red   { color: #dc2626; }
    .arc-rcpt-fee-box {
      background: #fffbeb;
      border: 1px solid #fde68a;
      border-radius: 10px;
      padding: 14px 18px;
    }
    .arc-rcpt-fee-box .total-row {
      display: flex;
      justify-content: space-between;
      padding: 5px 0;
      font-size: 13px;
    }
    .arc-rcpt-fee-box .total-row.final {
      border-top: 1px solid #fde68a;
      margin-top: 6px;
      padding-top: 10px;
      font-size: 15px;
      font-weight: 800;
    }
    .arc-rcpt-recipients {
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      overflow: hidden;
    }
    .arc-rcpt-recipients table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    .arc-rcpt-recipients thead { background: #1e3a5f; color: #fff; }
    .arc-rcpt-recipients thead th { padding: 8px 12px; text-align: left; font-weight: 600; }
    .arc-rcpt-recipients tbody tr { border-bottom: 1px solid #f1f5f9; }
    .arc-rcpt-recipients tbody tr:nth-child(even) { background: #f8faff; }
    .arc-rcpt-recipients tbody td { padding: 7px 12px; }
    .arc-rcpt-footer {
      text-align: center;
      margin-top: 36px;
      padding-top: 18px;
      border-top: 2px solid #e2e8f0;
      font-size: 10px;
      color: #9ca3af;
      line-height: 1.8;
    }
    .arc-rcpt-disclaimer {
      background: #fff7ed;
      border: 1px solid #fed7aa;
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 11px;
      color: #9a3412;
      margin-top: 20px;
    }
    .arc-rcpt-print-btn {
      display: block;
      width: 100%;
      padding: 13px;
      background: linear-gradient(135deg, #2563eb, #1e40af);
      color: #fff;
      border: none;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      margin-bottom: 12px;
      letter-spacing: 0.03em;
    }
    .arc-rcpt-print-btn:hover { background: linear-gradient(135deg, #1d4ed8, #1e3a8a); }
    .arc-rcpt-action-row {
      display: flex;
      gap: 10px;
      margin-bottom: 28px;
    }
    .arc-rcpt-action-row button, .arc-rcpt-action-row a {
      flex: 1;
      padding: 10px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      text-align: center;
      text-decoration: none;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      border: 1px solid transparent;
      transition: opacity 0.15s;
    }
    .arc-rcpt-action-row button:hover, .arc-rcpt-action-row a:hover { opacity: 0.85; }
    .btn-print   { background: #1e3a5f; color: #fff; }
    .btn-json    { background: #f0fdf4; color: #166534; border-color: #bbf7d0; }
    .btn-explore { background: #eff6ff; color: #1d4ed8; border-color: #bfdbfe; }
    @media print {
      body { padding: 20px 16px; background: #fff; }
      .arc-rcpt-no-print { display: none !important; }
      .arc-rcpt-header { background: #1e3a5f !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .arc-rcpt-section h2 { background: #eff6ff !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .arc-rcpt-recipients thead { background: #1e3a5f !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
    @media (max-width: 520px) {
      body { padding: 16px 10px; }
      .arc-rcpt-header { padding: 20px 16px; }
      .arc-rcpt-header h1 { font-size: 17px; }
      .arc-rcpt-label { min-width: 100px; }
      .arc-rcpt-action-row { flex-direction: column; }
    }
  `;
}

function _arcRcptRow(label, value, extraClass = '') {
  return `<div class="arc-rcpt-row"><span class="arc-rcpt-label">${label}</span><span class="arc-rcpt-value ${extraClass}">${value}</span></div>`;
}

function _arcEsc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _arcBadge(status) {
  const s = (status || 'confirmed').toLowerCase();
  if (s === 'confirmed' || s === 'completed') return `<span class="arc-rcpt-badge badge-confirmed">✓ CONFIRMED</span>`;
  if (s === 'scheduled') return `<span class="arc-rcpt-badge badge-scheduled">⏰ SCHEDULED</span>`;
  if (s === 'partial')   return `<span class="arc-rcpt-badge badge-partial">⚠ PARTIAL</span>`;
  if (s === 'failed')    return `<span class="arc-rcpt-badge badge-failed">✗ FAILED</span>`;
  return `<span class="arc-rcpt-badge badge-confirmed">✓ CONFIRMED</span>`;
}

// ─── Payment receipt HTML builder ─────────────────────────────────────────────
function _arcBuildPaymentReceiptHTML(r, jsonDataStr) {
  const explorerUrl = r.explorerUrl || ('https://testnet.arcscan.app/tx/' + (r.txHash || ''));
  const dateStr = new Date(r.timestamp || r.createdAt || Date.now()).toLocaleString();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment Receipt — ARC Testnet</title>
  <style>${_arcReceiptCSS()}</style>
</head>
<body>
  <div class="arc-rcpt-no-print arc-rcpt-action-row">
    <button class="btn-print" onclick="window.print()">🖨 Print / Save as PDF</button>
    ${r.txHash ? `<a class="btn-explore" href="${_arcEsc(explorerUrl)}" target="_blank">🔗 ArcScan Explorer</a>` : ''}
    <button class="btn-json" onclick="arcDownloadJSON()">⬇ Export JSON</button>
  </div>

  <div class="arc-rcpt-header">
    <h1>💸 Payment Receipt</h1>
    <p>ExecDaat · Arc Testnet · ${_arcEsc(dateStr)}</p>
    ${_arcBadge(r.status)}
  </div>

  <div class="arc-rcpt-section">
    <h2>Sender Information</h2>
    ${_arcRcptRow('Full Name',   _arcEsc(r.fullname || '—'))}
    ${_arcRcptRow('Email',       _arcEsc(r.email    || '—'))}
    ${_arcRcptRow('From Wallet', `<span class="arc-rcpt-mono">${_arcEsc(r.sender || r.from || '—')}</span>`)}
  </div>

  <div class="arc-rcpt-section">
    <h2>Payment Details</h2>
    ${_arcRcptRow('Token',   `<span class="arc-rcpt-blue">${_arcEsc(r.token || 'USDC')}</span>`)}
    ${_arcRcptRow('Amount',  `<strong style="font-size:15px;">${_arcEsc(Number(r.amount).toFixed(6))} ${_arcEsc(r.token || 'USDC')}</strong>`)}
    ${_arcRcptRow('To Wallet', `<span class="arc-rcpt-mono">${_arcEsc(r.recipient || r.to || '—')}</span>`)}
    ${_arcRcptRow('Network',   `<span class="arc-rcpt-green">${_arcEsc(r.network || 'Arc Testnet')}</span>`)}
    ${r.gasFee ? _arcRcptRow('Est. Gas Fee', `~${_arcEsc(r.gasFee)} ARC`) : ''}
    ${r.note   ? _arcRcptRow('Payment Note', `<em>${_arcEsc(r.note)}</em>`) : ''}
  </div>

  ${r.scheduledAt ? `<div class="arc-rcpt-section">
    <h2>Schedule</h2>
    ${_arcRcptRow('Scheduled For', _arcEsc(new Date(r.scheduledAt).toLocaleString()))}
    ${r.timezone ? _arcRcptRow('Timezone', _arcEsc(r.timezone)) : ''}
  </div>` : ''}

  <div class="arc-rcpt-section">
    <h2>Transaction Details</h2>
    ${r.txHash ? _arcRcptRow('Transaction Hash', `<a class="arc-rcpt-mono arc-rcpt-blue" href="${_arcEsc(explorerUrl)}" target="_blank">${_arcEsc(r.txHash)}</a>`) : ''}
    ${_arcRcptRow('Date &amp; Time', _arcEsc(dateStr))}
    ${r.chainId ? _arcRcptRow('Chain ID', _arcEsc(String(r.chainId))) : ''}
    ${r.durationMs ? _arcRcptRow('Duration', `${(r.durationMs / 1000).toFixed(1)}s`) : ''}
  </div>

  <div class="arc-rcpt-disclaimer">
    ⚠ This transaction was executed on Arc Testnet. No real funds were transferred.
    Testnet only — not a financial document.
  </div>

  <div class="arc-rcpt-footer">
    Generated by ExecDaat &middot; testnet.arcscan.app &middot; Testnet only<br>
    Receipt ID: ${_arcEsc(r.id || '—')}
  </div>

  <script>
    function arcDownloadJSON() {
      const data = ${jsonDataStr};
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = Object.assign(document.createElement('a'), {
        href: url,
        download: 'arc-receipt-' + (data.txHash || data.id || Date.now()).toString().slice(0,10) + '.json'
      });
      a.click(); URL.revokeObjectURL(url);
    }
  <\/script>
</body>
</html>`;
}

// ─── Contract receipt HTML builder ────────────────────────────────────────────
function _arcBuildContractReceiptHTML(contractId, c, meta, jsonDataStr) {
  const r     = meta.receiptData || {};
  const total = c ? _cfFmtUsdcSafe(c.totalValue) : r.totalValue || '?';
  const fee   = c ? _cfFmtUsdcSafe(_cfCalcFeeSafe(c.totalValue)) : r.feeValue || '?';
  const net   = c ? _cfFmtUsdcSafe(_cfNetAmountSafe(c.totalValue)) : r.netValue || '?';
  const title = c?.title || r.title || 'Contract';
  const proofs = meta.proofs || [];
  const now   = new Date().toLocaleString();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Contract Receipt #${contractId} — ARC Testnet</title>
  <style>${_arcReceiptCSS()}</style>
</head>
<body>
  <div class="arc-rcpt-no-print arc-rcpt-action-row">
    <button class="btn-print" onclick="window.print()">🖨 Print / Save as PDF</button>
    <a class="btn-explore" href="https://testnet.arcscan.app/address/${_arcEsc(c?.contractor || '')}" target="_blank">🔗 ArcScan</a>
    <button class="btn-json" onclick="arcDownloadJSON()">⬇ Export JSON</button>
  </div>

  <div class="arc-rcpt-header">
    <h1>⛓ Contract Receipt</h1>
    <p>ExecDaat · Arc Testnet · Trustless Escrow</p>
    <span class="arc-rcpt-badge badge-confirmed">✅ COMPLETED</span>
  </div>

  <div class="arc-rcpt-section">
    <h2>Contract Details</h2>
    ${_arcRcptRow('Contract ID', `<strong>#${_arcEsc(String(contractId))}</strong>`)}
    ${_arcRcptRow('Title', _arcEsc(title))}
    ${_arcRcptRow('Network', `<span class="arc-rcpt-green">Arc Testnet (Chain ${_arcEsc(String(window.CF_CHAIN_ID || 5042002))})</span>`)}
    ${_arcRcptRow('Factory', `<span class="arc-rcpt-mono" style="font-size:10px;">${_arcEsc(window.CF_FACTORY_ADDR || '0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A')}</span>`)}
    ${_arcRcptRow('Completed At', _arcEsc(r.completedAt || now))}
    ${_arcRcptRow('Generated At', _arcEsc(now))}
  </div>

  <div class="arc-rcpt-section">
    <h2>Parties</h2>
    ${_arcRcptRow('Client Wallet', `<span class="arc-rcpt-mono">${_arcEsc(c?.client || r.client || '—')}</span>`)}
    ${(meta.clientEmail || r.clientEmail) ? _arcRcptRow('Client Email', _arcEsc(meta.clientEmail || r.clientEmail)) : ''}
    ${_arcRcptRow('Contractor Wallet', `<span class="arc-rcpt-mono">${_arcEsc(c?.contractor || r.contractor || '—')}</span>`)}
    ${(meta.contractorEmail || r.contractorEmail) ? _arcRcptRow('Contractor Email', _arcEsc(meta.contractorEmail || r.contractorEmail)) : ''}
  </div>

  <div class="arc-rcpt-section">
    <h2>Financial Summary</h2>
    <div class="arc-rcpt-fee-box">
      <div class="total-row"><span>Total Contract Value</span><strong class="arc-rcpt-blue" style="font-size:16px;">$${_arcEsc(total)} USDC</strong></div>
      <div class="total-row"><span>Platform Fee (0.2%)</span><span class="arc-rcpt-red">−$${_arcEsc(fee)} USDC</span></div>
      <div class="total-row final"><span>Net to Contractor</span><strong class="arc-rcpt-green">$${_arcEsc(net)} USDC</strong></div>
    </div>
  </div>

  ${meta.otcPoints ? `<div class="arc-rcpt-section">
    <h2>OTC Negotiation</h2>
    ${_arcRcptRow('Points / Tokens', _arcEsc(meta.otcPoints))}
    ${meta.otcTerms ? _arcRcptRow('Terms', _arcEsc(meta.otcTerms)) : ''}
  </div>` : ''}

  <div class="arc-rcpt-section">
    <h2>Proof of Work (${proofs.length} file${proofs.length !== 1 ? 's' : ''})</h2>
    ${proofs.length
      ? proofs.map((p, i) => `<div class="arc-rcpt-row"><span class="arc-rcpt-label">${i+1}. ${_arcEsc(p.name)}</span><span class="arc-rcpt-value" style="font-size:11px;">${p.cid ? 'IPFS: ' + _arcEsc(p.cid) : '(local)'} · ${_arcEsc(new Date(p.uploadedAt).toLocaleString())}</span></div>`).join('')
      : '<p style="color:#9ca3af;font-size:12px;padding:8px 0;">No proof files uploaded.</p>'
    }
  </div>

  <div class="arc-rcpt-disclaimer">
    ⚠ This receipt was generated on Arc Testnet. All on-chain data is verifiable at
    <strong>testnet.arcscan.app</strong>. Not a financial document.
  </div>

  <div class="arc-rcpt-footer">
    Generated by ARC Contracts Module v5 &middot; Arc Testnet<br>
    Contract #${_arcEsc(String(contractId))} · ${_arcEsc(window.CF_FACTORY_ADDR || '')}
  </div>

  <script>
    function arcDownloadJSON() {
      const data = ${jsonDataStr};
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = Object.assign(document.createElement('a'), {
        href: url,
        download: 'arc-contract-' + ${contractId} + '-receipt.json'
      });
      a.click(); URL.revokeObjectURL(url);
    }
  <\/script>
</body>
</html>`;
}

// ─── Multisend receipt HTML builder ───────────────────────────────────────────
function _arcBuildMultisendReceiptHTML(r, jsonDataStr) {
  const explorerUrl = r.explorerUrl || ('https://testnet.arcscan.app/tx/' + (r.txHash || ''));
  const dateStr = new Date(r.timestamp || Date.now()).toLocaleString();
  const isConfirmed = r.status === 'confirmed';

  const recipientRows = (r.recipients || []).map((p, i) => `
    <tr>
      <td>${i + 1}</td>
      <td class="arc-rcpt-mono" style="font-size:10px;">${_arcEsc(p.address || '—')}</td>
      <td><strong>$${_arcEsc(String(p.amount || '0'))}</strong></td>
      <td style="color:${p.status === 'confirmed' ? '#059669' : p.status === 'failed' ? '#dc2626' : '#d97706'};">${_arcEsc(p.status || '—')}</td>
      <td style="font-size:11px;color:#64748b;">${_arcEsc(p.note || '')}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MultiSend Receipt — ARC Testnet</title>
  <style>${_arcReceiptCSS()}</style>
</head>
<body>
  <div class="arc-rcpt-no-print arc-rcpt-action-row">
    <button class="btn-print" onclick="window.print()">🖨 Print / Save as PDF</button>
    ${r.txHash ? `<a class="btn-explore" href="${_arcEsc(explorerUrl)}" target="_blank">🔗 ArcScan Explorer</a>` : ''}
    <button class="btn-json" onclick="arcDownloadJSON()">⬇ Export JSON</button>
  </div>

  <div class="arc-rcpt-header">
    <h1>⚡ MultiSend Receipt</h1>
    <p>ExecDaat · Arc Testnet · ${_arcEsc(dateStr)}</p>
    ${_arcBadge(r.status)}
  </div>

  <div class="arc-rcpt-section">
    <h2>Batch Information</h2>
    ${_arcRcptRow('Batch ID',   `<span class="arc-rcpt-mono">${_arcEsc(r.batchId || r.id)}</span>`)}
    ${_arcRcptRow('Sender',     `<span class="arc-rcpt-mono">${_arcEsc(r.from || '—')}</span>`)}
    ${_arcRcptRow('Network',    `<span class="arc-rcpt-green">Arc Testnet (Chain ID 5042002)</span>`)}
    ${_arcRcptRow('Method',     _arcEsc(r.executionMethod === 'multicall3' ? 'Multicall3 — Atomic Batch' : 'Sequential'))}
    ${_arcRcptRow('Date / Time', _arcEsc(dateStr))}
  </div>

  <div class="arc-rcpt-section">
    <h2>Financial Summary</h2>
    <div class="arc-rcpt-fee-box">
      <div class="total-row"><span>Total USDC Sent</span><strong class="arc-rcpt-green" style="font-size:16px;">$${_arcEsc(String(r.totalAmount || '0'))} USDC</strong></div>
      <div class="total-row"><span>Platform Fee Paid</span><span class="arc-rcpt-red">$${_arcEsc(String(r.fee || '0'))} USDC</span></div>
      <div class="total-row"><span>Recipients</span><span>${_arcEsc(String(r.count || (r.recipients || []).length))} addresses</span></div>
      <div class="total-row final"><span>Grand Total Paid</span><strong>$${_arcEsc(String(r.grandTotal || r.totalAmount || '0'))} USDC</strong></div>
    </div>
  </div>

  <div class="arc-rcpt-section">
    <h2>Transaction Hashes</h2>
    ${r.txHash        ? _arcRcptRow('Batch Tx (Multicall3)', `<a class="arc-rcpt-mono arc-rcpt-blue" href="${_arcEsc(explorerUrl)}" target="_blank" style="font-size:10px;">${_arcEsc(r.txHash)}</a>`) : ''}
    ${r.feeTxHash     ? _arcRcptRow('Platform Fee Tx',       `<span class="arc-rcpt-mono" style="font-size:10px;">${_arcEsc(r.feeTxHash)}</span>`) : ''}
    ${r.approvalTxHash ? _arcRcptRow('USDC Approval Tx',     `<span class="arc-rcpt-mono" style="font-size:10px;">${_arcEsc(r.approvalTxHash)}</span>`) : ''}
  </div>

  <div class="arc-rcpt-section">
    <h2>Recipients (${(r.recipients || []).length})</h2>
    <div class="arc-rcpt-recipients">
      <table>
        <thead>
          <tr>
            <th>#</th><th>Address</th><th>Amount (USDC)</th><th>Status</th><th>Note</th>
          </tr>
        </thead>
        <tbody>${recipientRows}</tbody>
      </table>
    </div>
  </div>

  <div class="arc-rcpt-disclaimer">
    ⚠ This transaction was executed on Arc Testnet. No real funds were transferred.
    Testnet only — not a financial document.
  </div>

  <div class="arc-rcpt-footer">
    Generated by ARC MultiSend Module &middot; Arc Testnet<br>
    Batch ID: ${_arcEsc(r.batchId || r.id || '—')} · Receipt: ${_arcEsc(r.id || '—')}
  </div>

  <script>
    function arcDownloadJSON() {
      const data = ${jsonDataStr};
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = Object.assign(document.createElement('a'), {
        href: url,
        download: 'arc-multisend-' + (data.batchId || data.id || Date.now()) + '.json'
      });
      a.click(); URL.revokeObjectURL(url);
    }
  <\/script>
</body>
</html>`;
}

// ─── Helper: safe USDC formatting (works without cfFmtUsdc) ──────────────────
function _cfFmtUsdcSafe(raw) {
  if (typeof cfFmtUsdc === 'function') return cfFmtUsdc(raw);
  try { return (Number(BigInt(raw)) / 1e6).toFixed(2); } catch { return '?'; }
}
function _cfCalcFeeSafe(totalValue) {
  if (typeof cfCalcFee === 'function') return cfCalcFee(BigInt(totalValue || 0));
  try { return BigInt(Math.floor(Number(BigInt(totalValue || 0)) * 0.002)); } catch { return 0n; }
}
function _cfNetAmountSafe(totalValue) {
  if (typeof cfNetAmount === 'function') return cfNetAmount(BigInt(totalValue || 0));
  try {
    const t = BigInt(totalValue || 0);
    return t - BigInt(Math.floor(Number(t) * 0.002));
  } catch { return 0n; }
}

// ─── Open a receipt in a new tab (no auto-download) ──────────────────────────
function arcOpenReceipt(receiptData, type) {
  if (!receiptData) { if (typeof showToast === 'function') showToast('No receipt available', 'error'); return; }

  const r       = receiptData;
  const rType   = type || r._type || 'payment';
  const jsonStr = JSON.stringify({ ...r, _type: rType }, null, 2)
    .replace(/<\/script>/gi, '<\\/script>');  // prevent script injection

  let html;
  if (rType === 'contract') {
    const c    = r._contractData || (typeof cfState !== 'undefined' ? cfState.contracts?.find(x => x.id === r.contractId) : null);
    const meta = r._meta || (typeof cfGetMeta === 'function' ? cfGetMeta(r.contractId) : {});
    html = _arcBuildContractReceiptHTML(r.contractId || r.id, c, { ...meta, receiptData: r }, jsonStr);
  } else if (rType === 'multisend') {
    html = _arcBuildMultisendReceiptHTML(r, jsonStr);
  } else {
    html = _arcBuildPaymentReceiptHTML(r, jsonStr);
  }

  // Store receipt before opening
  if (r.id) {
    arcReceiptStore.set(r.id, { ...r, _type: rType });
  }

  // Open in new tab
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const tab  = window.open(url, '_blank');

  if (tab) {
    // Revoke after a delay so the new tab can load
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } else {
    // Pop-up blocked fallback: write to a data URI
    const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
    const link = document.createElement('a');
    link.href   = dataUrl;
    link.target = '_blank';
    link.rel    = 'noopener';
    link.click();
    if (typeof showToast === 'function') {
      showToast('⚠ Pop-ups blocked? Receipt opened via fallback link.', 'warning');
    }
  }
}

// ─── Open by stored ID ────────────────────────────────────────────────────────
function arcOpenReceiptById(id) {
  const r = arcReceiptStore.get(id);
  if (!r) {
    if (typeof showToast === 'function') showToast('Receipt not found. It may have expired.', 'error');
    return;
  }
  arcOpenReceipt(r, r._type);
}

// ─── "View Receipt" button HTML helper ───────────────────────────────────────
function arcViewReceiptBtn(id, label, extraStyle) {
  const lbl  = label || 'View Receipt';
  const base = 'display:inline-flex;align-items:center;gap:5px;padding:6px 12px;background:rgba(29,158,117,0.07);border:1px solid rgba(29,158,117,0.22);border-radius:8px;color:#34d399;font-size:11px;font-weight:700;cursor:pointer;transition:all 0.2s;';
  return `<button onclick="arcOpenReceiptById('${_arcEsc(id)}')" style="${base}${extraStyle || ''}"
    onmouseover="this.style.background='rgba(29,158,117,0.16)'" onmouseout="this.style.background='rgba(29,158,117,0.07)'">
    <i class="fas fa-eye"></i> ${_arcEsc(lbl)}
  </button>`;
}

// ─── Persist receipt and return "View Receipt" button ─────────────────────────
function arcStoreAndGetBtn(receiptData, type, btnLabel) {
  const rType = type || 'payment';
  const r     = { ...receiptData, _type: rType };
  if (r.id) arcReceiptStore.set(r.id, r);
  return arcViewReceiptBtn(r.id || Date.now(), btnLabel || 'View Receipt');
}

// ─── Global exports ────────────────────────────────────────────────────────────
window.arcOpenReceipt      = arcOpenReceipt;
window.arcOpenReceiptById  = arcOpenReceiptById;
window.arcViewReceiptBtn   = arcViewReceiptBtn;
window.arcStoreAndGetBtn   = arcStoreAndGetBtn;
window.arcReceiptStore     = arcReceiptStore;

console.log('[RECEIPT VIEWER v1] Loaded — no auto-downloads, user-controlled print/save');
