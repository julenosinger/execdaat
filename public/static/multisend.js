// ============================================================
// MULTISEND MODULE — ARC AI Agents  v3 (Real On-Chain)
// Step 1: Build recipient list
// Step 2: Review & confirm
// Step 3: Pay single platform fee → send all transfers
// Arc Testnet (chainId 5042002) | USDC ERC-20 (6 decimals)
// ============================================================
'use strict';

const MS_MAX_ROWS        = 500;
const MS_MAX_AMOUNT_ROW  = 10000;
const MS_USDC_ADDR       = '0x3600000000000000000000000000000000000000';
const MS_EXPLORER        = 'https://testnet.arcscan.app';
const MS_CHAIN_ID        = 5042002;
const MS_CHAIN_HEX       = '0x' + MS_CHAIN_ID.toString(16); // '0x4CE612'

// Platform fee wallet (receives the single fee payment)
const MS_FEE_WALLET      = '0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A';
// Fee tiers: 1% base, -0.1% per 10 recipients beyond 10 (min 0.3%)
const MS_FEE_BASE        = 0.01;    // 1%
const MS_FEE_MIN         = 0.003;   // 0.3%
const MS_FEE_DISCOUNT    = 0.001;   // 0.1% per 10 extra recipients
const MS_USDC_DECIMALS   = 6;

// Minimal ERC-20 ABI needed for Multisend
const MS_ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
];

let msRowCounter    = 0;
let msBatchesSent   = 0;
const msReceipts    = [];
let msCurrentStep   = 1;
let msValidatedRows = [];   // set when proceeding to step 2

// ─── Fee calculator (integer-safe) ────────────────────────────────────────────
function msCalcFee(total, count) {
  if (!count || !total) return 0;
  const discountSteps = Math.floor(Math.max(0, count - 10) / 10);
  const rateRaw = MS_FEE_BASE - discountSteps * MS_FEE_DISCOUNT;
  const rate    = Math.max(MS_FEE_MIN, rateRaw);
  // Use integer math to avoid float precision errors
  const feeRaw  = Math.round(total * rate * 1_000_000) / 1_000_000;
  return +feeRaw.toFixed(6);
}

function msCalcFeeRate(count) {
  const discountSteps = Math.floor(Math.max(0, count - 10) / 10);
  return Math.max(MS_FEE_MIN, MS_FEE_BASE - discountSteps * MS_FEE_DISCOUNT);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function msEl(id)          { return document.getElementById(id); }
function msIsAddr(addr)    { return /^0x[0-9a-fA-F]{40}$/.test(String(addr || '').trim()); }
function msFmt2(n)         { return Number(n || 0).toFixed(2); }
function msFmt6(n)         { return Number(n || 0).toFixed(6); }
function msShort(h)        { return h ? h.slice(0, 12) + '…' + h.slice(-8) : '—'; }
function msNow()           { return new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
function msBigUsdc(n)      { return window.ethers.parseUnits(Number(n).toFixed(MS_USDC_DECIMALS), MS_USDC_DECIMALS); }
function msFmtUsdc(bigint) {
  try { return Number(window.ethers.formatUnits(bigint, MS_USDC_DECIMALS)).toFixed(2); }
  catch { return '?'; }
}

// ─── Step bar UI ──────────────────────────────────────────────────────────────
function msSetStep(step) {
  msCurrentStep = step;
  [1, 2, 3].forEach(s => {
    const panel = msEl(`ms-panel-step${s}`);
    const barEl = msEl(`ms-bar-step${s}`);
    const numEl = barEl?.querySelector('div');
    const lblEl = barEl?.querySelector('span');

    if (panel) panel.classList.toggle('hidden', s !== step);

    if (!numEl) return;
    if (s < step) {
      numEl.className = 'w-9 h-9 rounded-full border-2 border-green-500 bg-green-900/30 flex items-center justify-center font-bold text-green-400 text-sm transition-all';
      numEl.innerHTML = '<i class="fas fa-check text-xs"></i>';
      if (lblEl) lblEl.className = 'text-xs text-green-400 font-medium';
      const line = msEl(`ms-bar-line${s}`);
      if (line) line.className = 'flex-1 h-0.5 bg-green-600 mx-1 transition-all';
    } else if (s === step) {
      numEl.className = 'w-9 h-9 rounded-full border-2 border-cyan-500 bg-cyan-900/30 flex items-center justify-center font-bold text-cyan-400 text-sm transition-all';
      numEl.textContent = s;
      if (lblEl) lblEl.className = 'text-xs text-cyan-400 font-medium';
    } else {
      numEl.className = 'w-9 h-9 rounded-full border-2 border-gray-600 bg-gray-800/40 flex items-center justify-center font-bold text-gray-500 text-sm transition-all';
      numEl.textContent = s;
      if (lblEl) lblEl.className = 'text-xs text-gray-500 font-medium';
      const line = msEl(`ms-bar-line${s - 1}`);
      if (line) line.className = 'flex-1 h-0.5 bg-gray-700 mx-1';
    }
  });
}

// ─── Tx lifecycle step helpers ─────────────────────────────────────────────────
function msTxStep(n, state, detail) {
  const row    = msEl(`ms-txstep-${n}`);
  const icon   = msEl(`ms-txstep-${n}-icon`);
  const status = msEl(`ms-txstep-${n}-status`);
  if (!row) return;

  row.className = 'ms-tx-step flex items-center gap-3 p-3 rounded-xl border ' + (
    state === 'active' ? 'bg-cyan-900/10 border-cyan-700/40' :
    state === 'done'   ? 'bg-green-900/10 border-green-700/40' :
    state === 'error'  ? 'bg-red-900/10 border-red-700/40' :
    'bg-gray-800/40 border-gray-700/30'
  );

  if (icon) {
    icon.className = 'w-7 h-7 rounded-full border-2 flex items-center justify-center flex-shrink-0 text-xs ' + (
      state === 'active' ? 'border-cyan-500 text-cyan-400 animate-pulse' :
      state === 'done'   ? 'border-green-500 text-green-400' :
      state === 'error'  ? 'border-red-500 text-red-400' :
      'border-gray-600 text-gray-500'
    );
    icon.innerHTML = state === 'done'   ? '<i class="fas fa-check text-[10px]"></i>' :
                     state === 'error'  ? '<i class="fas fa-times text-[10px]"></i>' :
                     state === 'active' ? '<i class="fas fa-spinner fa-spin text-[10px]"></i>' : n;
  }

  if (status) {
    status.innerHTML = detail || (state === 'active' ? 'In progress…' : state === 'done' ? 'Done' : state === 'error' ? 'Failed' : 'Waiting…');
    status.className = 'text-xs ms-txstep-status ' + (
      state === 'done'   ? 'text-green-400' :
      state === 'error'  ? 'text-red-400' :
      state === 'active' ? 'text-cyan-400' :
      'text-gray-600'
    );
  }
}

function msTxStepsReset() {
  [1, 2, 3].forEach(n => msTxStep(n, 'wait'));
  const fin = msEl('ms-final-result');
  if (fin) { fin.classList.add('hidden'); fin.innerHTML = ''; }
}

// ─── Update stats / summary ───────────────────────────────────────────────────
function msUpdateStats() {
  const rows  = document.querySelectorAll('.ms-row');
  const valid = [];
  rows.forEach(row => {
    const addr = row.querySelector('.ms-addr')?.value?.trim();
    const amt  = parseFloat(row.querySelector('.ms-amt')?.value || '0');
    if (msIsAddr(addr) && amt > 0) valid.push({ addr, amt });
  });

  // Use integer sum to avoid float issues
  const totalMicro = valid.reduce((s, r) => s + Math.round(r.amt * 1_000_000), 0);
  const total      = totalMicro / 1_000_000;
  const count      = valid.length;
  const rowCount   = rows.length;
  const fee        = msCalcFee(total, count);
  const feePct     = count > 0 ? msCalcFeeRate(count) : MS_FEE_BASE;

  const statR = msEl('ms-stat-recipients'); if (statR) statR.textContent = count;
  const statT = msEl('ms-stat-total');      if (statT) statT.textContent = '$' + msFmt2(total);
  const statF = msEl('ms-stat-fee');        if (statF) statF.textContent = '$' + msFmt2(fee);
  const statB = msEl('ms-stat-batches');    if (statB) statB.textContent = msBatchesSent;
  const rowCt = msEl('ms-row-count');       if (rowCt) rowCt.textContent = rowCount + ' row' + (rowCount !== 1 ? 's' : '');

  const sumC  = msEl('ms-summary-count');  if (sumC) sumC.textContent = count + ' recipient' + (count !== 1 ? 's' : '');
  const sumT  = msEl('ms-summary-total');  if (sumT) sumT.textContent = '$' + msFmt2(total) + ' USDC';
  const sumF  = msEl('ms-summary-fee');    if (sumF) sumF.textContent = '$' + msFmt2(fee) + ' USDC';
  const sumFP = msEl('ms-fee-pct');        if (sumFP) sumFP.textContent = '(' + (feePct * 100).toFixed(1) + '%)';
  const sumG  = msEl('ms-summary-grand');  if (sumG) sumG.textContent = '$' + msFmt2(total + fee) + ' USDC';
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
        placeholder="0.00" step="0.000001" min="0.000001" max="${MS_MAX_AMOUNT_ROW}"
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

// ─── Collect valid rows (with duplicate detection) ────────────────────────────
function msCollectRows() {
  const rows   = document.querySelectorAll('.ms-row');
  const valid  = [];
  const errors = [];
  const seen   = new Set();
  const from   = msEl('ms-from')?.value?.trim();

  rows.forEach((row, i) => {
    const addr = row.querySelector('.ms-addr')?.value?.trim();
    const raw  = row.querySelector('.ms-amt')?.value || '';
    const amt  = parseFloat(raw);
    const note = row.querySelector('.ms-note')?.value?.trim() || '';

    if (!addr && !raw) return; // skip completely empty rows

    const errs = [];
    if (!addr)              errs.push('Address required');
    else if (!msIsAddr(addr)) errs.push('Invalid EVM address');
    else if (seen.has(addr.toLowerCase())) errs.push('Duplicate address');
    if (isNaN(amt) || amt <= 0) errs.push('Amount must be > 0');
    else if (amt > MS_MAX_AMOUNT_ROW)    errs.push(`Amount exceeds max $${MS_MAX_AMOUNT_ROW}`);

    if (errs.length) {
      errors.push(`Row ${i + 1}: ${errs.join(', ')}`);
    } else {
      seen.add(addr.toLowerCase());
      valid.push({ address: addr, amount: amt, note, from });
    }
  });

  return { valid, errors, from };
}

// ─── Step 1 → Step 2 ──────────────────────────────────────────────────────────
function msProceedToReview() {
  const { valid, errors, from } = msCollectRows();

  if (errors.length)              { showToast(errors[0], 'warning'); return; }
  if (!valid.length)              { showToast('Add at least one valid recipient.', 'warning'); return; }
  if (!from || !msIsAddr(from))   { showToast('Sender wallet address not valid.', 'warning'); return; }

  if (!window.walletState?.connected) {
    showToast('Please connect your wallet first.', 'warning');
    if (typeof openWalletModal === 'function') openWalletModal();
    return;
  }

  msValidatedRows = valid;

  // Integer-safe totals
  const totalMicro = valid.reduce((s, r) => s + Math.round(r.amount * 1_000_000), 0);
  const total      = totalMicro / 1_000_000;
  const fee        = msCalcFee(total, valid.length);
  const grand      = total + fee;
  const feePct     = msCalcFeeRate(valid.length);

  // Populate review table
  const tbl = msEl('ms-review-table');
  if (tbl) {
    tbl.innerHTML = valid.map((r, i) => `
      <div class="flex items-center gap-2 py-1.5 border-b border-gray-700/20 last:border-0 text-xs">
        <span class="text-gray-600 w-5 flex-shrink-0">${i + 1}.</span>
        <span class="font-mono text-gray-400 flex-1 truncate">${msShort(r.address)}</span>
        <span class="text-cyan-400 font-medium w-20 text-right">$${msFmt2(r.amount)}</span>
        ${r.note ? `<span class="text-gray-600 text-[10px] max-w-[80px] truncate">${r.note}</span>` : ''}
      </div>`).join('');
  }

  const rC = msEl('ms-review-count'); if (rC) rC.textContent = valid.length;
  const rT = msEl('ms-review-total'); if (rT) rT.textContent = '$' + msFmt2(total) + ' USDC';
  const rF = msEl('ms-review-fee');   if (rF) rF.textContent = '$' + msFmt2(fee) + ' USDC (' + (feePct * 100).toFixed(1) + '%)';
  const rG = msEl('ms-review-grand'); if (rG) rG.textContent = '$' + msFmt2(grand) + ' USDC';

  msSetStep(2);
}

// ─── Step 2 → Step 3 ──────────────────────────────────────────────────────────
function msProceedToSend() {
  msTxStepsReset();
  const label = msEl('ms-txstep-3-label');
  if (label) label.textContent = `Send Transfers (0 / ${msValidatedRows.length})`;

  const backBtn = msEl('ms-step3-back');
  const execBtn = msEl('ms-execute-btn');
  if (backBtn) backBtn.disabled = false;
  if (execBtn) { execBtn.disabled = false; execBtn.innerHTML = '<i class="fas fa-rocket mr-2"></i>Pay Fee &amp; Send All'; }

  msSetStep(3);
}

// ─── Go back to previous step ─────────────────────────────────────────────────
function msGoBack() {
  if (msCurrentStep === 2) msSetStep(1);
  else if (msCurrentStep === 3) msSetStep(2);
}

// ─── CSV parsing ──────────────────────────────────────────────────────────────
function msParseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length < 2) return [];
  const sep = lines[0].includes(';') ? ';' : ',';
  function splitLine(line) {
    const r = []; let c = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (q && line[i + 1] === '"') { c += '"'; i++; } else q = !q; }
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
    const obj   = {};
    headers.forEach((h, idx) => { obj[h] = (cells[idx] || '').trim(); });
    rows.push(obj);
  }
  return rows;
}

function msNormalizeRow(raw) {
  const addrKeys = ['address', 'to', 'to_address', 'wallet', 'recipient', 'destination', 'endereco'];
  const amtKeys  = ['amount', 'value', 'usdc', 'quantidade', 'valor'];
  const noteKeys = ['note', 'description', 'memo', 'notes', 'observacao'];
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
      if (!rawRows.length)              { showToast('CSV has no data rows', 'warning'); return; }
      if (rawRows.length > MS_MAX_ROWS) { showToast(`Too many rows: ${rawRows.length} (max ${MS_MAX_ROWS})`, 'error'); return; }

      const container = msEl('ms-rows');
      if (container) { container.innerHTML = ''; msRowCounter = 0; }

      let validCount = 0, invalidCount = 0;
      rawRows.forEach(raw => {
        const r   = msNormalizeRow(raw);
        const amt = parseFloat(r.amount);
        if (r.address && msIsAddr(r.address) && amt > 0 && amt <= MS_MAX_AMOUNT_ROW) {
          msAddRow(r.address, msFmt2(amt), r.note);
          validCount++;
        } else {
          invalidCount++;
        }
      });

      const wallet = window.walletState?.address;
      const fromEl = msEl('ms-from');
      if (fromEl && !fromEl.value && wallet) fromEl.value = wallet;

      msUpdateStats();
      showToast(`✅ ${validCount} rows loaded${invalidCount ? ` · ${invalidCount} skipped` : ''}`, invalidCount ? 'warning' : 'success');
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

// ─── Network switch helper ────────────────────────────────────────────────────
async function msSwitchToArc() {
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: MS_CHAIN_HEX }],
    });
    return true;
  } catch (switchErr) {
    if (switchErr.code === 4902) {
      // Chain not added — attempt to add it
      try {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: MS_CHAIN_HEX,
            chainName: 'Arc Testnet',
            nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
            rpcUrls: ['https://rpc.testnet.arc.network'],
            blockExplorerUrls: ['https://testnet.arcscan.app'],
          }],
        });
        return true;
      } catch { return false; }
    }
    return false;
  }
}

// ─── Execute: Step 3 — Pay fee then send all transfers ────────────────────────
async function msExecute() {
  const execBtn = msEl('ms-execute-btn');
  const backBtn = msEl('ms-step3-back');
  const finEl   = msEl('ms-final-result');
  const from    = msEl('ms-from')?.value?.trim();

  if (!msValidatedRows.length)       { showToast('No validated recipients.', 'warning'); return; }
  if (!window.ethereum)              { showToast('Wallet not detected. Install MetaMask.', 'error'); return; }
  if (!window.walletState?.connected) {
    showToast('Connect your wallet first.', 'warning');
    if (typeof openWalletModal === 'function') openWalletModal();
    return;
  }

  if (execBtn) { execBtn.disabled = true; execBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Processing…'; }
  if (backBtn) backBtn.disabled = true;
  if (finEl)   { finEl.classList.add('hidden'); finEl.innerHTML = ''; }

  // Integer-safe totals
  const totalMicro = msValidatedRows.reduce((s, r) => s + Math.round(r.amount * 1_000_000), 0);
  const total      = totalMicro / 1_000_000;
  const fee        = msCalcFee(total, msValidatedRows.length);
  const grand      = total + fee;
  const batchId    = `BATCH-${Date.now().toString(36).toUpperCase()}`;

  try {
    const ethers = window.ethers;
    if (!ethers) throw new Error('ethers.js not loaded');

    // ── Step 1: Verify network + USDC balance ─────────────────────────────────
    msTxStep(1, 'active', 'Checking Arc Testnet and USDC balance…');

    const chainHex = await window.ethereum.request({ method: 'eth_chainId' });
    const chainId  = parseInt(chainHex, 16);
    if (chainId !== MS_CHAIN_ID) {
      msTxStep(1, 'active', `Wrong network (chain ${chainId}). Switching to Arc Testnet…`);
      const switched = await msSwitchToArc();
      if (!switched) {
        msTxStep(1, 'error', 'Could not switch to Arc Testnet. Please switch manually.');
        showToast('Please switch to Arc Testnet (chainId 5042002)', 'error');
        if (execBtn) { execBtn.disabled = false; execBtn.innerHTML = '<i class="fas fa-rocket mr-2"></i>Pay Fee &amp; Send All'; }
        if (backBtn) backBtn.disabled = false;
        return;
      }
      // Small delay to let wallet update
      await new Promise(r => setTimeout(r, 800));
    }

    const provider = new ethers.BrowserProvider(window.ethereum);
    const signer   = await provider.getSigner();
    const usdc     = new ethers.Contract(MS_USDC_ADDR, MS_ERC20_ABI, signer);

    // Read on-chain decimals to confirm (sanity check)
    let onChainDecimals = MS_USDC_DECIMALS;
    try {
      onChainDecimals = Number(await usdc.decimals());
    } catch (_) { /* use default 6 */ }

    if (onChainDecimals !== MS_USDC_DECIMALS) {
      msTxStep(1, 'error', `Unexpected USDC decimals: ${onChainDecimals} (expected 6)`);
      showToast(`Unexpected USDC decimals: ${onChainDecimals}`, 'error');
      if (execBtn) { execBtn.disabled = false; execBtn.innerHTML = '<i class="fas fa-rocket mr-2"></i>Pay Fee &amp; Send All'; }
      if (backBtn) backBtn.disabled = false;
      return;
    }

    // Fetch live balance
    const balBig      = await usdc.balanceOf(from);
    const grandBig    = ethers.parseUnits(grand.toFixed(onChainDecimals), onChainDecimals);
    const balHuman    = Number(ethers.formatUnits(balBig, onChainDecimals)).toFixed(2);

    if (balBig < grandBig) {
      msTxStep(1, 'error', `Insufficient USDC · Have $${balHuman} · Need $${msFmt2(grand)}`);
      showToast(`Insufficient USDC. Have $${balHuman}, need $${msFmt2(grand)}.`, 'error');
      if (execBtn) { execBtn.disabled = false; execBtn.innerHTML = '<i class="fas fa-rocket mr-2"></i>Pay Fee &amp; Send All'; }
      if (backBtn) backBtn.disabled = false;
      return;
    }

    msTxStep(1, 'done', `Balance OK · $${balHuman} USDC available`);

    // ── Step 2: Pay single platform fee ──────────────────────────────────────
    let feeTxHash = null;
    if (fee > 0) {
      msTxStep(2, 'active', `Sending platform fee $${msFmt2(fee)} USDC…`);
      const feeAmt = ethers.parseUnits(fee.toFixed(onChainDecimals), onChainDecimals);

      // Estimate gas first
      let gasEstimate;
      try {
        gasEstimate = await usdc.transfer.estimateGas(MS_FEE_WALLET, feeAmt);
      } catch (_) { gasEstimate = BigInt(65000); }

      const feeOptions = { gasLimit: gasEstimate + BigInt(10000) };
      const feeTx      = await usdc.transfer(MS_FEE_WALLET, feeAmt, feeOptions);
      msTxStep(2, 'active', `Confirming fee tx · <span class="font-mono">${feeTx.hash.slice(0, 14)}…</span>`);
      await feeTx.wait(1);
      feeTxHash = feeTx.hash;
      msTxStep(2, 'done', `Fee confirmed · <a href="${MS_EXPLORER}/tx/${feeTx.hash}" target="_blank" class="underline text-blue-400 font-mono">${feeTx.hash.slice(0, 12)}…</a>`);
    } else {
      msTxStep(2, 'done', 'No platform fee for this batch.');
    }

    // ── Step 3: Send individual transfers ──────────────────────────────────
    const label = msEl('ms-txstep-3-label');
    msTxStep(3, 'active', `Sending 0 / ${msValidatedRows.length} transfers…`);
    if (label) label.textContent = `Send Transfers (0 / ${msValidatedRows.length})`;

    const hashes  = [];
    const results = [];
    let   userAborted = false;

    for (let i = 0; i < msValidatedRows.length; i++) {
      if (userAborted) {
        results.push({ ...msValidatedRows[i], txHash: null, status: 'skipped' });
        continue;
      }
      const p = msValidatedRows[i];
      if (label) label.textContent = `Send Transfers (${i + 1} / ${msValidatedRows.length})`;
      msTxStep(3, 'active', `Sending ${i + 1}/${msValidatedRows.length} → <span class="font-mono">${msShort(p.address)}</span> $${msFmt2(p.amount)} USDC`);

      try {
        // Use parseUnits for exact 6-decimal precision
        const amtBig = ethers.parseUnits(Number(p.amount).toFixed(onChainDecimals), onChainDecimals);

        // Estimate gas per transfer
        let gasEst;
        try {
          gasEst = await usdc.transfer.estimateGas(p.address, amtBig);
        } catch (_) { gasEst = BigInt(65000); }

        const txOpts = { gasLimit: gasEst + BigInt(10000) };
        const tx     = await usdc.transfer(p.address, amtBig, txOpts);
        const rcpt   = await tx.wait(1);
        const gasUsed = rcpt.gasUsed ? rcpt.gasUsed.toString() : 'N/A';

        hashes.push(tx.hash);
        results.push({ address: p.address, amount: p.amount, note: p.note || '', txHash: tx.hash, status: 'confirmed', gasUsed });
        if (typeof addLog === 'function') addLog(`[MULTISEND] ✅ ${i + 1}/${msValidatedRows.length} → ${p.address.slice(0, 10)}… $${msFmt2(p.amount)} USDC · ${tx.hash.slice(0, 12)}…`, 'success');
      } catch (e) {
        const errMsg = e.reason || e.message || 'Transaction failed';
        if (e.code === 4001 || errMsg.includes('rejected') || errMsg.includes('denied') || errMsg.includes('user rejected')) {
          userAborted = true;
          showToast(`Transaction ${i + 1} rejected. Remaining skipped.`, 'warning');
          results.push({ address: p.address, amount: p.amount, note: p.note || '', txHash: null, status: 'rejected' });
        } else {
          results.push({ address: p.address, amount: p.amount, note: p.note || '', txHash: null, status: 'failed', error: errMsg });
          if (typeof addLog === 'function') addLog(`[MULTISEND] ❌ ${i + 1}/${msValidatedRows.length} → ${p.address.slice(0, 10)}… failed: ${errMsg}`, 'error');
        }
      }
    }

    const confirmedResults = results.filter(r => r.status === 'confirmed');
    const confirmedCount   = confirmedResults.length;
    const confirmedMicro   = confirmedResults.reduce((s, r) => s + Math.round(r.amount * 1_000_000), 0);
    const confirmedAmount  = confirmedMicro / 1_000_000;
    const allOk            = confirmedCount === msValidatedRows.length;

    if (label) label.textContent = `Send Transfers (${confirmedCount} / ${msValidatedRows.length} confirmed)`;
    msTxStep(3, allOk ? 'done' : 'error',
      `${confirmedCount}/${msValidatedRows.length} confirmed · $${msFmt2(confirmedAmount)} USDC`);

    msBatchesSent++;

    // ── Build receipt ──────────────────────────────────────────────────────────
    const receiptObj = {
      id:            `ms-${Date.now()}`,
      batchId,
      timestamp:     new Date().toISOString(),
      from,
      network:       'Arc Testnet',
      chainId:       MS_CHAIN_ID,
      token:         'USDC',
      count:         confirmedCount,
      totalAmount:   msFmt2(confirmedAmount),
      fee:           msFmt2(fee),
      feeTxHash,
      grandTotal:    msFmt2(confirmedAmount + fee),
      governmentFee: '—',
      recipients:    results,
      txHash:        hashes[0] || null,
      explorerUrl:   hashes[0] ? `${MS_EXPLORER}/tx/${hashes[0]}` : MS_EXPLORER,
      status:        allOk ? 'confirmed' : 'partial',
      allHashes:     hashes,
    };
    msReceipts.unshift(receiptObj);
    msRenderReceipts();

    // ── Final result banner ────────────────────────────────────────────────────
    if (finEl) {
      finEl.classList.remove('hidden');
      finEl.className = `rounded-xl p-4 mb-4 ${allOk ? 'bg-green-900/20 border border-green-700/30' : 'bg-yellow-900/20 border border-yellow-700/30'}`;
      finEl.innerHTML = `
        <div class="flex items-start gap-3">
          <i class="fas ${allOk ? 'fa-check-circle text-green-400' : 'fa-exclamation-triangle text-yellow-400'} text-xl mt-0.5"></i>
          <div class="flex-1">
            <div class="font-semibold ${allOk ? 'text-green-300' : 'text-yellow-300'} mb-2">
              ${allOk ? `✅ Batch complete! ${confirmedCount} transfers confirmed.` : `⚠️ Partial: ${confirmedCount}/${msValidatedRows.length} confirmed.`}
            </div>
            <div class="text-xs text-gray-400 space-y-1">
              <div>Amount sent: <span class="text-white font-medium">$${msFmt2(confirmedAmount)} USDC</span></div>
              <div>Platform fee paid: <span class="text-yellow-300">$${msFmt2(fee)} USDC</span></div>
              <div>Government fee: <span class="text-gray-500">—</span></div>
              ${hashes[0] ? `<div>First tx: <a href="${MS_EXPLORER}/tx/${hashes[0]}" target="_blank" class="text-blue-400 hover:underline font-mono">${hashes[0].slice(0, 20)}…</a></div>` : ''}
              ${feeTxHash ? `<div>Fee tx: <a href="${MS_EXPLORER}/tx/${feeTxHash}" target="_blank" class="text-yellow-400 hover:underline font-mono">${feeTxHash.slice(0, 20)}…</a></div>` : ''}
            </div>
          </div>
        </div>`;
    }

    showToast(
      allOk
        ? `✅ ${confirmedCount} transfers confirmed · $${msFmt2(confirmedAmount)} USDC`
        : `⚠️ ${confirmedCount}/${msValidatedRows.length} confirmed · $${msFmt2(confirmedAmount)} USDC`,
      allOk ? 'success' : 'warning'
    );

    // Reset on full success; on partial keep data so user can retry
    if (allOk) {
      msInitRows();
      msValidatedRows = [];
    }

    const statB = msEl('ms-stat-batches'); if (statB) statB.textContent = msBatchesSent;

    // Trigger history refresh
    if (typeof historyInit === 'function') setTimeout(() => historyInit(), 3000);
    if (typeof loadDashboard === 'function') setTimeout(loadDashboard, 2000);

  } catch (e) {
    const msg = e.reason || e.message || 'Unknown error';
    showToast('Error: ' + msg, 'error');
    if (typeof addLog === 'function') addLog('[MULTISEND] Error: ' + msg, 'error');
    console.error('[MULTISEND]', e);
  } finally {
    if (execBtn) { execBtn.disabled = false; execBtn.innerHTML = '<i class="fas fa-rocket mr-2"></i>Pay Fee &amp; Send All'; }
    if (backBtn) backBtn.disabled = false;
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
        <div class="flex items-center gap-2">
          <div class="w-7 h-7 rounded-lg ${r.status === 'confirmed' ? 'bg-green-900/30 border-green-700/30' : 'bg-yellow-900/30 border-yellow-700/30'} border flex items-center justify-center">
            <i class="fas ${r.status === 'confirmed' ? 'fa-check text-green-400' : 'fa-exclamation text-yellow-400'} text-xs"></i>
          </div>
          <div>
            <div class="text-white font-semibold text-sm">${r.batchId}</div>
            <div class="text-gray-500 text-xs">${new Date(r.timestamp).toLocaleString()}</div>
          </div>
        </div>
        <div class="text-right">
          <div class="text-green-400 font-bold text-sm">$${r.totalAmount} USDC</div>
          <div class="text-gray-600 text-xs">${r.count} recipient${r.count !== 1 ? 's' : ''}</div>
        </div>
      </div>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs mb-3">
        <div class="bg-gray-900/40 rounded-lg px-3 py-2">
          <div class="text-gray-600 text-[10px] mb-0.5 uppercase">From</div>
          <div class="font-mono text-cyan-400">${msShort(r.from)}</div>
        </div>
        <div class="bg-gray-900/40 rounded-lg px-3 py-2">
          <div class="text-gray-600 text-[10px] mb-0.5 uppercase">Network</div>
          <div class="text-green-400">${r.network}</div>
        </div>
        <div class="bg-gray-900/40 rounded-lg px-3 py-2">
          <div class="text-gray-600 text-[10px] mb-0.5 uppercase">Platform Fee</div>
          <div class="text-yellow-400">$${r.fee || '0.00'}</div>
        </div>
        <div class="bg-gray-900/40 rounded-lg px-3 py-2">
          <div class="text-gray-600 text-[10px] mb-0.5 uppercase">Gov. Fee</div>
          <div class="text-gray-500">${r.governmentFee || '—'}</div>
        </div>
      </div>
      ${r.txHash ? `
      <div class="text-xs text-gray-500 mb-1.5 font-mono bg-gray-900/30 rounded-lg px-2.5 py-1.5 flex items-center justify-between">
        <span class="text-gray-600 flex-shrink-0">First Tx</span>
        <a href="${r.explorerUrl}" target="_blank" rel="noopener" class="text-blue-400 hover:underline ml-2 truncate">${r.txHash.slice(0, 20)}… <i class="fas fa-external-link-alt text-[10px]"></i></a>
      </div>` : ''}
      ${r.feeTxHash ? `
      <div class="text-xs text-gray-500 mb-1.5 font-mono bg-gray-900/30 rounded-lg px-2.5 py-1.5 flex items-center justify-between">
        <span class="text-gray-600 flex-shrink-0">Fee Tx</span>
        <a href="${MS_EXPLORER}/tx/${r.feeTxHash}" target="_blank" rel="noopener" class="text-yellow-400 hover:underline ml-2 truncate">${r.feeTxHash.slice(0, 20)}… <i class="fas fa-external-link-alt text-[10px]"></i></a>
      </div>` : ''}
      <details class="mb-2 mt-1">
        <summary class="text-xs text-gray-500 hover:text-gray-400 cursor-pointer select-none flex items-center gap-1.5 py-1">
          <i class="fas fa-users text-[10px]"></i>
          <span>Recipients (${r.recipients?.length || 0}) — click to expand</span>
          <i class="fas fa-chevron-down text-[9px] ml-auto"></i>
        </summary>
        <div class="mt-2 space-y-1 max-h-48 overflow-y-auto">
          ${(r.recipients || []).map(p => `
            <div class="flex items-center gap-1.5 text-[11px] py-1.5 border-b border-gray-700/20 last:border-0">
              <span class="font-mono text-gray-400 flex-1 truncate">${msShort(p.address)}</span>
              <span class="text-cyan-400 flex-shrink-0">$${msFmt2(p.amount)}</span>
              <span class="flex-shrink-0 ${p.status === 'confirmed' ? 'text-green-400' : p.status === 'rejected' ? 'text-yellow-400' : p.status === 'skipped' ? 'text-gray-500' : 'text-red-400'}">${p.status || '—'}</span>
              ${p.txHash ? `<a href="${MS_EXPLORER}/tx/${p.txHash}" target="_blank" class="text-blue-400 hover:underline text-[10px] flex-shrink-0"><i class="fas fa-external-link-alt"></i></a>` : ''}
              ${p.note ? `<span class="text-gray-600 max-w-[60px] truncate">${p.note}</span>` : ''}
            </div>`).join('')}
        </div>
      </details>
      <div class="flex gap-2 mt-2">
        <button onclick="msDownloadReceipt('${r.id}')"
          class="flex items-center gap-1.5 px-3 py-1.5 bg-gray-700/40 hover:bg-gray-700/60 border border-gray-600/40 text-gray-400 hover:text-white text-xs rounded-xl transition">
          <i class="fas fa-download text-xs"></i>JSON Receipt
        </button>
        ${r.txHash ? `
        <a href="${r.explorerUrl}" target="_blank" rel="noopener"
          class="flex items-center gap-1.5 px-3 py-1.5 bg-blue-900/20 border border-blue-700/30 text-blue-400 text-xs rounded-xl transition ml-auto">
          <i class="fas fa-external-link-alt text-xs"></i>ArcScan
        </a>` : ''}
      </div>
    </div>`).join('');
}

// ─── Download receipt ─────────────────────────────────────────────────────────
function msDownloadReceipt(receiptId) {
  const r = msReceipts.find(x => x.id === receiptId);
  if (!r) { showToast('Receipt not found.', 'error'); return; }

  const doc = {
    receiptType:      'ARC_MULTISEND_BATCH_RECEIPT',
    version:          '3.0',
    generatedAt:      new Date().toISOString(),
    batchId:          r.batchId,
    timestamp:        r.timestamp,
    network: {
      name:           r.network,
      chainId:        r.chainId,
      explorer:       MS_EXPLORER,
      rpc:            'https://rpc.testnet.arc.network',
      gasToken:       'USDC',
    },
    sender:           r.from,
    token:            r.token,
    tokenAddress:     MS_USDC_ADDR,
    tokenDecimals:    MS_USDC_DECIMALS,
    totalAmountSent:  r.totalAmount,
    platformFee:      r.fee || '0.00',
    governmentFee:    r.governmentFee || '—',
    grandTotal:       r.grandTotal || r.totalAmount,
    recipientCount:   r.count,
    txHash:           r.txHash || null,
    feeTxHash:        r.feeTxHash || null,
    allTxHashes:      r.allHashes || [],
    explorerUrl:      r.explorerUrl,
    status:           r.status,
    recipients:       r.recipients.map(p => ({
      address:  p.address,
      amount:   msFmt2(p.amount),
      note:     p.note || '',
      txHash:   p.txHash || null,
      status:   p.status || 'unknown',
      gasUsed:  p.gasUsed || null,
    })),
  };

  const json = JSON.stringify(doc, null, 2);
  const url  = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a    = Object.assign(document.createElement('a'), { href: url, download: `arc_multisend_receipt_${r.batchId}.json` });
  a.click();
  URL.revokeObjectURL(url);
  showToast('Receipt downloaded.', 'success');
}

// ─── Init rows ────────────────────────────────────────────────────────────────
function msInitRows() {
  const container = msEl('ms-rows');
  if (!container) return;
  container.innerHTML = '';
  msRowCounter = 0;
  msAddRow(); msAddRow();
  const wallet = window.walletState?.address;
  const fromEl = msEl('ms-from');
  if (fromEl && wallet) { fromEl.value = wallet; fromEl.dataset.autoFilled = 'true'; }
  msUpdateStats();
  msSetStep(1);
}

// ─── Module init ──────────────────────────────────────────────────────────────
function msInit() {
  const gate      = msEl('ms-wallet-gate');
  const connected = window.walletState?.connected;
  if (gate) gate.classList.toggle('hidden', !!connected);

  const rows = document.querySelectorAll('.ms-row');
  if (rows.length === 0) msInitRows();
  else {
    const wallet = window.walletState?.address;
    const fromEl = msEl('ms-from');
    if (fromEl && wallet && !fromEl.value) fromEl.value = wallet;
    msUpdateStats();
  }
  msRenderReceipts();
  msSetStep(msCurrentStep || 1);
}

// ─── Wallet listeners ─────────────────────────────────────────────────────────
window.addEventListener('walletConnected', (e) => {
  const addr   = e.detail?.address;
  const fromEl = msEl('ms-from');
  if (fromEl && addr && !fromEl.value) { fromEl.value = addr; fromEl.dataset.autoFilled = 'true'; }
  const gate = msEl('ms-wallet-gate');
  if (gate) gate.classList.add('hidden');
});
window.addEventListener('walletDisconnected', () => {
  const fromEl = msEl('ms-from');
  if (fromEl && fromEl.dataset.autoFilled === 'true') { fromEl.value = ''; fromEl.dataset.autoFilled = 'false'; }
  const gate = msEl('ms-wallet-gate');
  if (gate) gate.classList.remove('hidden');
});

// ─── Expose globals ─────────────────────────────────────────────────────────
window.msInit             = msInit;
window.msAddRow           = msAddRow;
window.msSubmit           = msExecute;   // legacy alias
window.msHandleCSV        = msHandleCSV;
window.msDownloadTemplate = msDownloadTemplate;
window.msDownloadReceipt  = msDownloadReceipt;
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

console.log('[MULTISEND] Module v3 loaded — Arc Testnet', MS_CHAIN_ID, '| USDC', MS_USDC_ADDR, '| 6 decimals');
