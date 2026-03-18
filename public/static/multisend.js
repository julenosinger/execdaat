// ============================================================
// MULTISEND MODULE — ARC AI Agents
// Standalone batch payments with receipt emission
// Arc Testnet (chainId 5042002) | USDC native gas token
// ============================================================
'use strict';

const MS_MAX_ROWS       = 500;
const MS_MAX_AMOUNT_ROW = 10000;
const MS_USDC_ADDR      = '0x3600000000000000000000000000000000000000';
const MS_EXPLORER       = 'https://testnet.arcscan.app';
const MS_CHAIN_ID       = 5042002;

let msRowCounter  = 0;
let msBatchesSent = 0;
const msReceipts  = [];  // local receipt store

// ─── Helpers ──────────────────────────────────────────────────────────────────
function msEl(id)       { return document.getElementById(id); }
function msIsAddr(addr) { return /^0x[0-9a-fA-F]{40}$/.test(String(addr || '').trim()); }
function msFmt4(n)      { return Number(n || 0).toFixed(4); }
function msFmt2(n)      { return Number(n || 0).toFixed(2); }
function msShort(h)     { return h ? h.slice(0, 12) + '…' + h.slice(-8) : '—'; }
function msNow()        { return new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }

// ─── Update stats / summary ───────────────────────────────────────────────────
function msUpdateStats() {
  const rows  = document.querySelectorAll('.ms-row');
  const valid = [];
  rows.forEach(row => {
    const addr = row.querySelector('.ms-addr')?.value?.trim();
    const amt  = parseFloat(row.querySelector('.ms-amt')?.value || '0');
    if (msIsAddr(addr) && amt > 0) valid.push({ addr, amt });
  });

  const total     = valid.reduce((s, r) => s + r.amt, 0);
  const count     = valid.length;
  const rowCount  = rows.length;

  // Stats bar
  const statR = msEl('ms-stat-recipients'); if (statR) statR.textContent = count;
  const statT = msEl('ms-stat-total');      if (statT) statT.textContent = '$' + msFmt2(total);
  const statB = msEl('ms-stat-batches');    if (statB) statB.textContent = msBatchesSent;
  const rowCt = msEl('ms-row-count');       if (rowCt) rowCt.textContent = rowCount + ' row' + (rowCount !== 1 ? 's' : '');

  // Summary panel
  const sumC = msEl('ms-summary-count'); if (sumC) sumC.textContent = count + ' recipient' + (count !== 1 ? 's' : '');
  const sumT = msEl('ms-summary-total'); if (sumT) sumT.textContent = '$' + msFmt2(total) + ' USDC';
}

// ─── Add a row ────────────────────────────────────────────────────────────────
function msAddRow(address = '', amount = '', note = '') {
  const container = msEl('ms-rows');
  if (!container) return;
  const id  = ++msRowCounter;
  const div = document.createElement('div');
  div.id        = `ms-row-${id}`;
  div.className = 'ms-row grid grid-cols-12 gap-2 px-5 py-2.5 items-center hover:bg-gray-800/20 transition-colors';
  div.innerHTML = `
    <div class="col-span-5">
      <input type="text"
        class="ms-addr w-full bg-gray-800/80 border border-gray-700 hover:border-gray-600 focus:border-cyan-500 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none font-mono transition-colors"
        placeholder="0x…"
        value="${address}"
        oninput="msValidateAddr(this); msUpdateStats()">
    </div>
    <div class="col-span-3">
      <input type="number"
        class="ms-amt w-full bg-gray-800/80 border border-gray-700 hover:border-gray-600 focus:border-cyan-500 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none transition-colors"
        placeholder="0.00" step="0.01" min="0" max="${MS_MAX_AMOUNT_ROW}"
        value="${amount}"
        oninput="msUpdateStats()">
    </div>
    <div class="col-span-3">
      <input type="text"
        class="ms-note w-full bg-gray-800/80 border border-gray-700 hover:border-gray-600 focus:border-gray-500 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none transition-colors"
        placeholder="Note (optional)"
        value="${note}">
    </div>
    <div class="col-span-1 flex justify-center">
      <button onclick="document.getElementById('ms-row-${id}').remove(); msUpdateStats()"
        class="w-6 h-6 flex items-center justify-center bg-red-900/20 hover:bg-red-900/40 border border-red-800/30 text-red-500 rounded-lg transition-all text-xs">
        <i class="fas fa-times"></i>
      </button>
    </div>`;
  container.appendChild(div);
  msUpdateStats();
}

function msValidateAddr(input) {
  const val = input.value.trim();
  if (val && !msIsAddr(val)) {
    input.classList.add('border-red-500');
    input.classList.remove('border-gray-700');
  } else {
    input.classList.remove('border-red-500');
    input.classList.add('border-gray-700');
  }
}

// ─── Collect valid rows ────────────────────────────────────────────────────────
function msCollectRows() {
  const rows    = document.querySelectorAll('.ms-row');
  const valid   = [];
  const errors  = [];
  const from    = msEl('ms-from')?.value?.trim();
  const priority = msEl('ms-priority')?.value || 'medium';

  rows.forEach((row, i) => {
    const addr = row.querySelector('.ms-addr')?.value?.trim();
    const amt  = parseFloat(row.querySelector('.ms-amt')?.value || '0');
    const note = row.querySelector('.ms-note')?.value?.trim() || '';

    if (!addr && !amt) return; // skip empty rows
    const errs = [];
    if (!addr)           errs.push('Address required');
    else if (!msIsAddr(addr)) errs.push('Invalid EVM address');
    if (!amt || amt <= 0) errs.push('Amount must be > 0');
    else if (amt > MS_MAX_AMOUNT_ROW) errs.push(`Amount exceeds max $${MS_MAX_AMOUNT_ROW}`);

    if (errs.length) errors.push(`Row ${i + 1}: ${errs.join(', ')}`);
    else valid.push({ address: addr, amount: amt, note, priority, from });
  });

  return { valid, errors, from };
}

// ─── CSV parsing ──────────────────────────────────────────────────────────────
function msParseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length < 2) return [];
  const sep  = lines[0].includes(';') ? ';' : ',';
  function splitLine(line) {
    const r = []; let c = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (q && line[i+1] === '"') { c += '"'; i++; } else q = !q; }
      else if (ch === sep && !q) { r.push(c.trim()); c = ''; }
      else c += ch;
    }
    r.push(c.trim()); return r;
  }
  const headers = splitLine(lines[0]).map(h => h.toLowerCase().replace(/[^a-z0-9_]/g, ''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cells = splitLine(line);
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (cells[idx] || '').trim(); });
    rows.push(obj);
  }
  return rows;
}

function msNormalizeRow(raw) {
  const addrKeys = ['address','to','to_address','wallet','recipient','destination','endereco'];
  const amtKeys  = ['amount','value','usdc','quantidade','valor'];
  const noteKeys = ['note','description','memo','notes','observacao'];
  const find = (keys) => { for (const k of keys) if (raw[k] !== undefined) return raw[k]; return ''; };
  return { address: find(addrKeys), amount: find(amtKeys).replace(',', '.'), note: find(noteKeys) };
}

function msHandleCSV(file) {
  if (!file) return;
  if (!file.name.toLowerCase().match(/\.(csv|txt)$/)) {
    showToast('Invalid file type. Use .csv or .txt', 'error'); return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const rawRows = msParseCSV(e.target.result);
      if (!rawRows.length) { showToast('CSV has no data rows', 'warning'); return; }
      if (rawRows.length > MS_MAX_ROWS) { showToast(`Too many rows: ${rawRows.length} (max ${MS_MAX_ROWS})`, 'error'); return; }

      const container = msEl('ms-rows');
      if (container) { container.innerHTML = ''; msRowCounter = 0; }

      let valid = 0, invalid = 0;
      rawRows.forEach(raw => {
        const r   = msNormalizeRow(raw);
        const amt = parseFloat(r.amount);
        if (r.address && msIsAddr(r.address) && amt > 0 && amt <= MS_MAX_AMOUNT_ROW) {
          msAddRow(r.address, msFmt2(amt), r.note);
          valid++;
        } else {
          invalid++;
        }
      });

      // Auto-fill sender
      const wallet = window.walletState?.address;
      const fromEl = msEl('ms-from');
      if (fromEl && !fromEl.value && wallet) fromEl.value = wallet;

      msUpdateStats();
      showToast(`✅ ${valid} rows loaded${invalid ? ` · ${invalid} skipped` : ''}`, invalid ? 'warning' : 'success');
      const inp = msEl('ms-csv-input');
      if (inp) inp.value = '';
    } catch (err) {
      showToast('CSV parse error: ' + err.message, 'error');
    }
  };
  reader.readAsText(file, 'UTF-8');
}

function msDownloadTemplate() {
  const csv = [
    'address,amount,note',
    '0xB815A0c4bC23930119324d4359dB65e27A846A2d,10.00,Payment for consulting',
    '0x411c60F8e61B5Cbe32F9a873b16D21CA85e9A634,25.50,Software license fee',
    '0xC927B1d3fE6e12B1b72E3E5F3e3c5A7B9d4F2E1A,5.00,Expense reimbursement',
  ].join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a   = Object.assign(document.createElement('a'), { href: url, download: 'arc_multisend_template.csv' });
  a.click(); URL.revokeObjectURL(url);
}

// ─── AI Analysis ──────────────────────────────────────────────────────────────
async function msAnalyze() {
  const { valid, errors, from } = msCollectRows();
  if (!valid.length) { showToast('Add at least one valid recipient.', 'warning'); return; }

  const resultEl  = msEl('ms-analysis-result');
  const contentEl = msEl('ms-analysis-content');
  if (resultEl) resultEl.classList.remove('hidden');
  if (contentEl) contentEl.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Analyzing…';

  try {
    const totalAmount = valid.reduce((s, r) => s + r.amount, 0);
    const res = await axios.post('/api/payments/analyze', {
      payments: valid, totalAmount, from,
    });
    const d   = res.data;
    const riskColors = { low: 'text-green-400', medium: 'text-yellow-400', high: 'text-orange-400', critical: 'text-red-400' };
    const rl = d.decision?.riskLevel || 'unknown';
    if (contentEl) contentEl.innerHTML = `
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-gray-400">Decision</span>
          <span class="font-semibold ${d.decision?.action === 'approve' ? 'text-green-400' : 'text-red-400'}">${d.decision?.action?.toUpperCase() || '—'}</span>
        </div>
        <div class="flex items-center justify-between">
          <span class="text-gray-400">Risk Level</span>
          <span class="${riskColors[rl] || 'text-gray-400'}">${rl}</span>
        </div>
        <div class="flex items-center justify-between">
          <span class="text-gray-400">Confidence</span>
          <span class="text-white">${d.decision?.confidence || 0}%</span>
        </div>
        ${d.decision?.reasoning ? `<p class="text-gray-500 text-[11px] pt-1 border-t border-gray-700/30">${d.decision.reasoning.slice(0, 120)}…</p>` : ''}
      </div>`;
  } catch (e) {
    if (contentEl) contentEl.innerHTML = `<span class="text-red-400">Analysis failed: ${e.message}</span>`;
  }
}

// ─── Submit batch — real on-chain ERC-20 transfers ───────────────────────────
async function msSubmit() {
  const { valid, errors, from } = msCollectRows();

  if (errors.length)        { showToast(errors[0], 'warning'); return; }
  if (!valid.length)        { showToast('Add at least one valid recipient.', 'warning'); return; }
  if (!from || !msIsAddr(from)) { showToast('Sender address not valid.', 'warning'); return; }

  // ── 0. Wallet check ───────────────────────────────────────────────────────
  if (!window.ethereum) {
    showToast('MetaMask or compatible wallet not detected.', 'error'); return;
  }
  if (!window.walletState?.connected) {
    showToast('Please connect your wallet before sending.', 'warning');
    if (typeof openWalletModal === 'function') openWalletModal();
    return;
  }

  // ── 0b. Network check ─────────────────────────────────────────────────────
  const chainHex = await window.ethereum.request({ method: 'eth_chainId' });
  if (parseInt(chainHex, 16) !== MS_CHAIN_ID) {
    showToast('Wrong network. Please switch to Arc Testnet (chainId 5042002).', 'error');
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0x4CE612' }],
      });
    } catch (e) { /* user declined */ }
    return;
  }

  const btn       = msEl('ms-send-btn');
  const origLabel = '<i class="fas fa-paper-plane mr-2"></i>Send All';
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Processing…'; }

  const totalAmount = valid.reduce((s, r) => s + r.amount, 0);
  const hashes      = [];     // collect tx hashes
  const results     = [];     // {address, amount, note, txHash, status}
  const batchId     = `BATCH-${Date.now().toString(36).toUpperCase()}`;

  try {
    const ethers   = window.ethers;
    if (!ethers) throw new Error('ethers.js not loaded');
    const provider = new ethers.BrowserProvider(window.ethereum);
    const signer   = await provider.getSigner();

    // ── ERC-20 ABI ─────────────────────────────────────────────────────────
    const ERC20_ABI = [
      'function balanceOf(address) view returns (uint256)',
      'function allowance(address owner, address spender) view returns (uint256)',
      'function transfer(address to, uint256 amount) returns (bool)',
      'function decimals() view returns (uint8)',
    ];
    const usdc     = new ethers.Contract(MS_USDC_ADDR, ERC20_ABI, signer);
    const decimals = 6;   // USDC always 6

    // ── 1. Balance check ──────────────────────────────────────────────────
    if (btn) btn.innerHTML = '<i class="fas fa-coins fa-spin mr-2"></i>Checking USDC balance…';
    const bal      = await usdc.balanceOf(from);
    const required = ethers.parseUnits(totalAmount.toFixed(decimals), decimals);
    if (bal < required) {
      const have = Number(ethers.formatUnits(bal, decimals)).toFixed(2);
      showToast(`Insufficient USDC. Have $${have}, need $${msFmt2(totalAmount)}.`, 'error');
      if (btn) { btn.disabled = false; btn.innerHTML = origLabel; }
      return;
    }

    // ── 2. Send transfers one-by-one ──────────────────────────────────────
    if (btn) btn.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i>Sending 0 / ${valid.length}…`;

    for (let i = 0; i < valid.length; i++) {
      const p = valid[i];
      if (btn) btn.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i>Sending ${i + 1} / ${valid.length}…`;
      try {
        const amt   = ethers.parseUnits(Number(p.amount).toFixed(decimals), decimals);
        const tx    = await usdc.transfer(p.address, amt);
        if (btn) btn.innerHTML = `<i class="fas fa-clock fa-spin mr-2"></i>Confirming ${i + 1} / ${valid.length}…`;
        const receipt = await tx.wait(1);
        hashes.push(tx.hash);
        results.push({ address: p.address, amount: p.amount, note: p.note || '', txHash: tx.hash, status: 'confirmed' });
        addLog(`[MULTISEND] ✅ ${i + 1}/${valid.length} → ${p.address.slice(0, 10)}… $${msFmt2(p.amount)} USDC · tx ${tx.hash.slice(0, 12)}…`, 'success');
      } catch (e) {
        const errMsg = e.reason || e.message || 'Transaction failed';
        if (e.code === 4001 || errMsg.includes('rejected') || errMsg.includes('denied')) {
          showToast(`Transaction ${i + 1} rejected by user. Stopping batch.`, 'warning');
          results.push({ address: p.address, amount: p.amount, note: p.note || '', txHash: null, status: 'rejected' });
          break;
        }
        results.push({ address: p.address, amount: p.amount, note: p.note || '', txHash: null, status: 'failed', error: errMsg });
        addLog(`[MULTISEND] ❌ ${i + 1}/${valid.length} → ${p.address.slice(0, 10)}… failed: ${errMsg}`, 'error');
      }
    }

    const confirmedCount  = results.filter(r => r.status === 'confirmed').length;
    const confirmedAmount = results.filter(r => r.status === 'confirmed').reduce((s, r) => s + r.amount, 0);

    msBatchesSent++;

    // ── 3. Build receipt ──────────────────────────────────────────────────
    const receipt = {
      id:          `ms-${Date.now()}`,
      batchId,
      timestamp:   new Date().toISOString(),
      from,
      network:     'Arc Testnet',
      chainId:     MS_CHAIN_ID,
      token:       'USDC',
      count:       confirmedCount,
      totalAmount: msFmt2(confirmedAmount),
      recipients:  results,
      // Primary tx hash = first confirmed hash
      txHash:      hashes[0] || null,
      explorerUrl: hashes[0] ? `${MS_EXPLORER}/tx/${hashes[0]}` : MS_EXPLORER,
      status:      confirmedCount === valid.length ? 'confirmed' : 'partial',
      allHashes:   hashes,
    };
    msReceipts.unshift(receipt);
    msRenderReceipts();

    if (confirmedCount === valid.length) {
      showToast(`✅ ${confirmedCount} transfers confirmed · $${msFmt2(confirmedAmount)} USDC`, 'success');
    } else {
      showToast(`⚠️ ${confirmedCount}/${valid.length} transfers confirmed · $${msFmt2(confirmedAmount)} USDC`, 'warning');
    }

    // Reset rows after success
    if (confirmedCount > 0) msInitRows();

    const statB = msEl('ms-stat-batches'); if (statB) statB.textContent = msBatchesSent;
    if (typeof loadDashboard === 'function') setTimeout(loadDashboard, 1500);

  } catch (e) {
    const msg = e.reason || e.message || 'Unknown error';
    showToast('Error: ' + msg, 'error');
    addLog('[MULTISEND] Error: ' + msg, 'error');
    console.error('[MULTISEND]', e);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = origLabel; }
  }
}

// ─── Receipt rendering ────────────────────────────────────────────────────────
function msRenderReceipts() {
  const container = msEl('ms-receipts-list');
  const countEl   = msEl('ms-receipts-count');
  if (!container) return;
  if (countEl) countEl.textContent = msReceipts.length + ' receipt' + (msReceipts.length !== 1 ? 's' : '');

  if (!msReceipts.length) {
    container.innerHTML = `
      <div class="flex flex-col items-center gap-3 py-10 text-center text-gray-600">
        <i class="fas fa-inbox text-2xl"></i>
        <p class="text-sm">No batch receipts yet. Send a batch to generate a receipt.</p>
      </div>`;
    return;
  }

  container.innerHTML = msReceipts.map(r => `
    <div class="bg-gray-800/40 border border-gray-700/40 rounded-2xl p-4 mb-3">
      <div class="flex items-start justify-between mb-3">
        <div>
          <div class="flex items-center gap-2">
            <div class="w-7 h-7 rounded-lg bg-green-900/30 border border-green-700/30 flex items-center justify-center">
              <i class="fas fa-check text-green-400 text-xs"></i>
            </div>
            <div>
              <div class="text-white font-semibold text-sm">${r.batchId}</div>
              <div class="text-gray-500 text-xs">${new Date(r.timestamp).toLocaleString()}</div>
            </div>
          </div>
        </div>
        <div class="text-right">
          <div class="text-green-400 font-bold text-sm">$${r.totalAmount} USDC</div>
          <div class="text-gray-600 text-xs">${r.count} recipient${r.count !== 1 ? 's' : ''}</div>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-2 text-xs mb-3">
        <div class="bg-gray-900/40 rounded-lg px-3 py-2">
          <div class="text-gray-600 text-[10px] mb-0.5 uppercase">From</div>
          <div class="font-mono text-cyan-400">${msShort(r.from)}</div>
        </div>
        <div class="bg-gray-900/40 rounded-lg px-3 py-2">
          <div class="text-gray-600 text-[10px] mb-0.5 uppercase">Network</div>
          <div class="text-green-400">${r.network} · ${r.chainId}</div>
        </div>
      </div>
      ${r.txHash ? `
      <div class="text-xs text-gray-500 mb-2 font-mono bg-gray-900/30 rounded-lg px-2.5 py-1.5 flex items-center justify-between">
        <span class="text-gray-600">Primary Tx</span>
        <a href="${r.explorerUrl}" target="_blank" rel="noopener" class="text-blue-400 hover:underline">${msShort(r.txHash)} <i class="fas fa-external-link-alt text-[10px]"></i></a>
      </div>
      ${(r.allHashes && r.allHashes.length > 1) ? `<div class="text-[10px] text-gray-600 mb-2">${r.allHashes.length} transactions confirmed</div>` : ''}` : ''}
      <!-- Recipients preview -->
      <details class="mb-2">
        <summary class="text-xs text-gray-500 hover:text-gray-400 cursor-pointer select-none flex items-center gap-1">
          <i class="fas fa-users text-[10px]"></i>Recipients (${r.recipients?.length || 0})
          <span class="ml-auto text-[10px]">▼</span>
        </summary>
        <div class="mt-2 space-y-1 max-h-40 overflow-y-auto">
          ${(r.recipients || []).map(p => `
            <div class="flex items-center justify-between text-[11px] py-1.5 border-b border-gray-700/20 last:border-0 gap-1">
              <span class="font-mono text-gray-400">${msShort(p.address)}</span>
              <span class="text-cyan-400">$${msFmt2(p.amount)}</span>
              <span class="${p.status === 'confirmed' ? 'text-green-400' : p.status === 'rejected' ? 'text-yellow-400' : 'text-red-400'} text-[10px]">${p.status || '—'}</span>
              ${p.txHash ? `<a href="${MS_EXPLORER}/tx/${p.txHash}" target="_blank" class="text-blue-400 hover:underline text-[10px]"><i class="fas fa-external-link-alt"></i></a>` : ''}
              ${p.note ? `<span class="text-gray-600">${p.note}</span>` : ''}
            </div>`).join('')}
        </div>
      </details>
      <div class="flex gap-2">
        <button onclick="msDownloadReceipt('${r.id}')"
          class="flex items-center gap-1.5 px-3 py-1.5 bg-gray-700/40 hover:bg-gray-700/60 border border-gray-600/40 text-gray-400 hover:text-white text-xs rounded-xl transition">
          <i class="fas fa-download text-xs"></i>Download Receipt
        </button>
        ${r.txHash ? `
        <a href="${r.explorerUrl}" target="_blank" rel="noopener"
          class="flex items-center gap-1.5 px-3 py-1.5 bg-blue-900/20 border border-blue-700/30 text-blue-400 text-xs rounded-xl transition ml-auto">
          <i class="fas fa-external-link-alt text-xs"></i>ArcScan
        </a>` : ''}
      </div>
    </div>`).join('');
}

// ─── Download receipt as JSON ──────────────────────────────────────────────────
function msDownloadReceipt(receiptId) {
  const r = msReceipts.find(x => x.id === receiptId);
  if (!r) { showToast('Receipt not found.', 'error'); return; }

  const doc = {
    receiptType:  'ARC_MULTISEND_BATCH_RECEIPT',
    version:      '1.0',
    generatedAt:  new Date().toISOString(),
    batchId:      r.batchId,
    timestamp:    r.timestamp,
    network: {
      name:       r.network,
      chainId:    r.chainId,
      explorer:   MS_EXPLORER,
      gasToken:   'USDC',
    },
    sender:       r.from,
    token:        r.token,
    totalAmount:  r.totalAmount,
    recipientCount: r.count,
    txHash:       r.txHash || null,
    allTxHashes:  r.allHashes || [],
    explorerUrl:  r.explorerUrl,
    status:       r.status,
    recipients:   r.recipients.map(p => ({
      address: p.address,
      amount:  msFmt2(p.amount),
      note:    p.note || '',
      txHash:  p.txHash || null,
      status:  p.status || 'unknown',
    })),
  };

  const json    = JSON.stringify(doc, null, 2);
  const url     = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a       = Object.assign(document.createElement('a'), { href: url, download: `arc_multisend_receipt_${r.batchId}.json` });
  a.click();
  URL.revokeObjectURL(url);
  showToast('Receipt downloaded as JSON.', 'success');
}

// ─── Init rows ────────────────────────────────────────────────────────────────
function msInitRows() {
  const container = msEl('ms-rows');
  if (!container) return;
  container.innerHTML = '';
  msRowCounter = 0;
  msAddRow(); msAddRow();
  // Auto-fill sender from wallet
  const wallet = window.walletState?.address;
  const fromEl = msEl('ms-from');
  if (fromEl && wallet) { fromEl.value = wallet; fromEl.dataset.autoFilled = 'true'; }
  msUpdateStats();
}

// ─── Module init ──────────────────────────────────────────────────────────────
function msInit() {
  // Wallet gate
  const gate = msEl('ms-wallet-gate');
  const connected = window.walletState?.connected;
  if (gate) gate.classList.toggle('hidden', !!connected);

  const rows = document.querySelectorAll('.ms-row');
  if (rows.length === 0) msInitRows();
  else {
    // Just sync sender wallet if connected
    const wallet = window.walletState?.address;
    const fromEl = msEl('ms-from');
    if (fromEl && wallet && !fromEl.value) fromEl.value = wallet;
    msUpdateStats();
  }
  msRenderReceipts();
}

// ─── Wallet listeners ─────────────────────────────────────────────────────────
window.addEventListener('walletConnected', (e) => {
  const addr   = e.detail?.address;
  const fromEl = msEl('ms-from');
  if (fromEl && addr && !fromEl.value) {
    fromEl.value = addr;
    fromEl.dataset.autoFilled = 'true';
  }
  // Hide wallet gate
  const gate = msEl('ms-wallet-gate');
  if (gate) gate.classList.add('hidden');
});
window.addEventListener('walletDisconnected', () => {
  const fromEl = msEl('ms-from');
  if (fromEl && fromEl.dataset.autoFilled === 'true') {
    fromEl.value = '';
    fromEl.dataset.autoFilled = 'false';
  }
  // Show wallet gate
  const gate = msEl('ms-wallet-gate');
  if (gate) gate.classList.remove('hidden');
});

// ─── Expose globals ────────────────────────────────────────────────────────────
window.msInit           = msInit;
window.msAddRow         = msAddRow;
window.msSubmit         = msSubmit;
window.msAnalyze        = msAnalyze;
window.msHandleCSV      = msHandleCSV;
window.msDownloadTemplate = msDownloadTemplate;
window.msDownloadReceipt  = msDownloadReceipt;
window.msUpdateStats    = msUpdateStats;
window.msValidateAddr   = msValidateAddr;

// Legacy compat (csv-upload.js still referenced for payments tab)
window.addMultisendRow      = (a, b, c) => msAddRow(a, b, c);
window.updateMultisendTotal = msUpdateStats;
window.submitMultisend      = () => {
  // If on multisend tab, delegate there; otherwise fallback to old submitMultisend in csv-upload.js
  if (typeof msSubmit === 'function') msSubmit();
};

console.log('[MULTISEND] Module loaded — Arc Testnet', MS_CHAIN_ID);
