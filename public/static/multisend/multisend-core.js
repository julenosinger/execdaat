// ============================================================
// MULTISEND MODULE v7 — ExecDaat
//
// ROOT CAUSE ANALYSIS (v6 bugs fixed):
//  1. Approval ordering: MUST approve Multicall3 BEFORE fee tx
//     (fee tx reduces balance; if approved first with exact amount,
//      post-fee balance might be enough but pre-check fails)
//  2. Simulation sender: must simulate aggregate3 with from=senderAddr
//     (not mc3 address) since ethers.provider.call doesn't auto-set sender
//  3. Approval amount: approve total + 10% buffer to avoid edge case
//     rounding issues with formatUnits/parseUnits conversion
//  4. Balance check: check balance >= (total_to_send + fee) BEFORE any tx
//  5. Gas estimation: use explicit overrides.from for estimateGas
//  6. Single execution guard: msExecuting flag + button disable
//
// Architecture:
//   Step 1: Validate → balance check → approve Multicall3 (if needed)
//   Step 2: Pay platform fee (tx #1)
//   Step 3: Multicall3 aggregate3 with transferFrom (tx #2, all transfers)
//   → PDF receipt
//
// Why transferFrom (not transfer):
//   When Multicall3.aggregate3() calls USDC.transfer(to, amount),
//   msg.sender inside USDC is Multicall3 (balance = 0) → REVERT.
//   Solution: user approves Multicall3 for total amount, then each call
//   is USDC.transferFrom(userAddr, recipient, amount) which correctly
//   deducts from the user's USDC balance.
//
// Confirmed on Arc Testnet (chainId 5042002):
//   - Multicall3 IS deployed: 0xcA11bde05977b3631167028862bE2a173976CA11
//   - USDC supports transferFrom: "ERC20: transfer amount exceeds allowance"
//     revert confirms standard ERC-20 transferFrom works
//   - USDC decimals: 6 ✓
// ============================================================
'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const MS_MAX_ROWS        = 500;
const MS_MAX_AMOUNT_ROW  = 10_000;
const MS_USDC_ADDR       = '0x3600000000000000000000000000000000000000';
const MS_EXPLORER        = 'https://testnet.arcscan.app';
const MS_RPC             = 'https://rpc.testnet.arc.network';
const MS_CHAIN_ID        = 5042002;
const MS_CHAIN_HEX       = '0x' + MS_CHAIN_ID.toString(16); // '0x4cef52'
const MS_FEE_WALLET      = '0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A';
const MS_FEE_BASE        = 0.01;   // 1%
const MS_FEE_MIN         = 0.003;  // 0.3%
const MS_FEE_DISCOUNT    = 0.001;  // 0.1% per 10 extra recipients
const MS_USDC_DECIMALS   = 6;
const MS_GAS_MARGIN      = 1.30;   // +30% gas safety margin
const MS_GAS_PER_XFER    = 65_000n;
// Multicall3 canonical address — CONFIRMED DEPLOYED on Arc Testnet
const MS_MULTICALL3_ADDR = '0xcA11bde05977b3631167028862bE2a173976CA11';
// Approval buffer: approve 10% more than exact amount to avoid rounding issues
const MS_APPROVE_BUFFER  = 1.10;

// ─── ABIs ─────────────────────────────────────────────────────────────────────
const MS_ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
];

// Multicall3 aggregate3: each call specifies target + allowFailure + calldata
// The contract executes each call and returns (bool success, bytes returnData)[]
const MS_MULTICALL3_ABI = [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)',
];

// ─── State ────────────────────────────────────────────────────────────────────
let msRowCounter    = 0;
let msBatchesSent   = 0;
const msReceipts    = [];
let msCurrentStep   = 1;
let msValidatedRows = [];
let msExecuting     = false; // guard against duplicate sends

// ─── Persistent Hide State (Multisend Receipts) ───────────────────────────────
// Uses localStorage key 'hiddenMultisend' — survives page reload.
const _msDismiss = {
  isVisible: (id) => typeof arcIsVisibleMs === 'function' ? arcIsVisibleMs(id) : true,
  dismiss:   (id) => typeof arcHideMs      === 'function' ? arcHideMs(id)      : undefined,
  reset:     ()   => { /* no-op: persistent hide does NOT reset on reload */ },
};

// ─── Fee calculator ────────────────────────────────────────────────────────────
function msCalcFee(total, count) {
  if (!count || !total) return 0;
  const steps = Math.floor(Math.max(0, count - 10) / 10);
  const rate  = Math.max(MS_FEE_MIN, MS_FEE_BASE - steps * MS_FEE_DISCOUNT);
  return +(Math.round(total * rate * 1_000_000) / 1_000_000).toFixed(6);
}
function msCalcFeeRate(count) {
  const steps = Math.floor(Math.max(0, count - 10) / 10);
  return Math.max(MS_FEE_MIN, MS_FEE_BASE - steps * MS_FEE_DISCOUNT);
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────
function msEl(id)         { return document.getElementById(id); }
function msIsAddr(addr)   { return /^0x[0-9a-fA-F]{40}$/.test(String(addr || '').trim()); }
function msFmt2(n)        { return Number(n || 0).toFixed(2); }
function msFmt6(n)        { return Number(n || 0).toFixed(6).replace(/\.?0+$/, ''); }
function msShort(h)       { return h ? h.slice(0, 12) + '…' + h.slice(-8) : '—'; }
function msNow()          { return new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
function msToMicro(n)     { return Math.round(Number(n) * 1_000_000); }
function msMicroToUsdc(m) { return m / 1_000_000; }
function msLog(...args)   { console.log('%c[MULTISEND v7]', 'color:#22d3ee;font-weight:bold', ...args); }
function msWarn(...args)  { console.warn('[MULTISEND v7]', ...args); }
function msError(...args) { console.error('[MULTISEND v7]', ...args); }

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

// ─── Tx lifecycle step helpers ────────────────────────────────────────────────
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
      state === 'active' ? 'text-cyan-400' : 'text-gray-600'
    );
  }
}

function msTxStepsReset() {
  [1, 2, 3].forEach(n => msTxStep(n, 'wait'));
  const fin = msEl('ms-final-result');
  if (fin) { fin.classList.add('hidden'); fin.innerHTML = ''; }
}

// ─── Stats ────────────────────────────────────────────────────────────────────
function msUpdateStats() {
  const rows  = document.querySelectorAll('.ms-row');
  const valid = [];
  rows.forEach(row => {
    const addr = row.querySelector('.ms-addr')?.value?.trim();
    const amt  = parseFloat(row.querySelector('.ms-amt')?.value || '0');
    if (msIsAddr(addr) && amt > 0) valid.push({ addr, amt });
  });
  const totalMicro = valid.reduce((s, r) => s + msToMicro(r.amt), 0);
  const total      = msMicroToUsdc(totalMicro);
  const count      = valid.length;
  const rowCount   = rows.length;
  const fee        = msCalcFee(total, count);
  const feePct     = count > 0 ? msCalcFeeRate(count) : MS_FEE_BASE;

  const set = (id, v) => { const el = msEl(id); if (el) el.textContent = v; };
  set('ms-stat-recipients', count);
  set('ms-stat-total',      '$' + msFmt2(total));
  set('ms-stat-fee',        '$' + msFmt2(fee));
  set('ms-stat-batches',    msBatchesSent);
  set('ms-row-count',       rowCount + ' row' + (rowCount !== 1 ? 's' : ''));
  set('ms-summary-count',   count + ' recipient' + (count !== 1 ? 's' : ''));
  set('ms-summary-total',   '$' + msFmt2(total) + ' USDC');
  set('ms-summary-fee',     '$' + msFmt2(fee) + ' USDC');
  set('ms-fee-pct',         '(' + (feePct * 100).toFixed(1) + '%)');
  set('ms-summary-grand',   '$' + msFmt2(total + fee) + ' USDC');
}

// ─── Add row ──────────────────────────────────────────────────────────────────
function msAddRow(address = '', amount = '', note = '') {
  const container = msEl('ms-rows');
  if (!container) return;
  const id  = ++msRowCounter;
  const div = document.createElement('div');
  div.id        = `ms-row-${id}`;
  div.className = 'ms-row grid grid-cols-12 gap-2 px-5 py-2.5 items-center hover:bg-gray-800/20 transition-colors';
  div.innerHTML = `
    <div class="col-span-5">
      <input type="text" class="ms-addr w-full bg-gray-800/80 border border-gray-700 hover:border-gray-600 focus:border-cyan-500 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none font-mono transition-colors"
        placeholder="0x…" value="${address}" oninput="msValidateAddr(this); msUpdateStats()">
    </div>
    <div class="col-span-3">
      <input type="number" class="ms-amt w-full bg-gray-800/80 border border-gray-700 hover:border-gray-600 focus:border-cyan-500 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none transition-colors"
        placeholder="0.00" step="0.000001" min="0.000001" max="${MS_MAX_AMOUNT_ROW}" value="${amount}" oninput="msUpdateStats()">
    </div>
    <div class="col-span-3">
      <input type="text" class="ms-note w-full bg-gray-800/80 border border-gray-700 hover:border-gray-600 focus:border-gray-500 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none transition-colors"
        placeholder="Note (optional)" value="${note}">
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
  input.classList.toggle('border-red-500', !!(val && !msIsAddr(val)));
  input.classList.toggle('border-gray-700', !(val && !msIsAddr(val)));
}

// ─── Collect rows with duplicate detection ────────────────────────────────────
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
    if (!addr && !raw) return;
    const errs = [];
    if (!addr)                               errs.push('Address required');
    else if (!msIsAddr(addr))                errs.push('Invalid EVM address');
    else if (seen.has(addr.toLowerCase()))   errs.push('Duplicate address');
    if (isNaN(amt) || amt <= 0)              errs.push('Amount must be > 0');
    else if (amt > MS_MAX_AMOUNT_ROW)        errs.push(`Max $${MS_MAX_AMOUNT_ROW}/row`);
    if (errs.length) { errors.push(`Row ${i + 1}: ${errs.join(', ')}`); }
    else { seen.add(addr.toLowerCase()); valid.push({ address: addr, amount: amt, note, from }); }
  });
  return { valid, errors, from };
}

// ─── Step 1 → 2 ───────────────────────────────────────────────────────────────
function msProceedToReview() {
  const { valid, errors, from } = msCollectRows();
  if (errors.length)            { showToast(errors[0], 'warning'); return; }
  if (!valid.length)            { showToast('Add at least one valid recipient.', 'warning'); return; }
  if (!from || !msIsAddr(from)) { showToast('Sender wallet address not valid.', 'warning'); return; }
  if (!window.walletState?.connected) {
    showToast('Please connect your wallet first.', 'warning');
    if (typeof openWalletModal === 'function') openWalletModal();
    return;
  }
  msValidatedRows = valid;
  const totalMicro = valid.reduce((s, r) => s + msToMicro(r.amount), 0);
  const total      = msMicroToUsdc(totalMicro);
  const fee        = msCalcFee(total, valid.length);
  const grand      = total + fee;
  const feePct     = msCalcFeeRate(valid.length);

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
  const s = (id, v) => { const e = msEl(id); if (e) e.textContent = v; };
  s('ms-review-count', valid.length);
  s('ms-review-total', '$' + msFmt2(total) + ' USDC');
  s('ms-review-fee',   '$' + msFmt2(fee) + ' USDC (' + (feePct * 100).toFixed(1) + '%)');
  s('ms-review-grand', '$' + msFmt2(grand) + ' USDC');
  msSetStep(2);
}

// ─── Step 2 → 3 ───────────────────────────────────────────────────────────────
function msProceedToSend() {
  msTxStepsReset();
  const label = msEl('ms-txstep-3-label');
  if (label) label.textContent = `Multicall3 Batch (${msValidatedRows.length} recipients)`;
  const backBtn = msEl('ms-step3-back');
  const execBtn = msEl('ms-execute-btn');
  if (backBtn) backBtn.disabled = false;
  if (execBtn) { execBtn.disabled = false; execBtn.innerHTML = '<i class="fas fa-rocket mr-2"></i>Pay Fee &amp; Send All'; }
  msSetStep(3);
}

function msGoBack() {
  if (msCurrentStep === 2) msSetStep(1);
  else if (msCurrentStep === 3) msSetStep(2);
}

// ─── CSV ──────────────────────────────────────────────────────────────────────
function msParseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length < 2) return [];
  const sep = lines[0].includes(';') ? ';' : ',';
  function splitLine(line) {
    const r = []; let c = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (q && line[i+1]==='"') { c+='"'; i++; } else q=!q; }
      else if (ch === sep && !q) { r.push(c.trim()); c = ''; }
      else c += ch;
    }
    r.push(c.trim()); return r;
  }
  const headers = splitLine(lines[0]).map(h => h.toLowerCase().replace(/[^a-z0-9_]/g,''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim(); if (!line) continue;
    const cells = splitLine(line), obj = {};
    headers.forEach((h, idx) => { obj[h] = (cells[idx]||'').trim(); });
    rows.push(obj);
  }
  return rows;
}
function msNormalizeRow(raw) {
  const addrKeys = ['address','to','to_address','wallet','recipient','destination','endereco'];
  const amtKeys  = ['amount','value','usdc','quantidade','valor'];
  const noteKeys = ['note','description','memo','notes','observacao'];
  const find = (keys) => { for (const k of keys) if (raw[k]!==undefined) return raw[k]; return ''; };
  return { address: find(addrKeys), amount: find(amtKeys).replace(',','.'), note: find(noteKeys) };
}
function msHandleCSV(file) {
  if (!file) return;
  if (!file.name.toLowerCase().match(/\.(csv|txt)$/)) { showToast('Use .csv or .txt','error'); return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const rawRows = msParseCSV(e.target.result);
      if (!rawRows.length) { showToast('CSV has no data rows','warning'); return; }
      if (rawRows.length > MS_MAX_ROWS) { showToast(`Too many rows (max ${MS_MAX_ROWS})`,'error'); return; }
      const container = msEl('ms-rows');
      if (container) { container.innerHTML=''; msRowCounter=0; }
      let v=0, inv=0;
      rawRows.forEach(raw => {
        const r=msNormalizeRow(raw), amt=parseFloat(r.amount);
        if (r.address && msIsAddr(r.address) && amt>0 && amt<=MS_MAX_AMOUNT_ROW) { msAddRow(r.address, msFmt2(amt), r.note); v++; }
        else inv++;
      });
      const wallet=window.walletState?.address, fromEl=msEl('ms-from');
      if (fromEl && !fromEl.value && wallet) fromEl.value=wallet;
      msUpdateStats();
      showToast(`✅ ${v} rows loaded${inv?` · ${inv} skipped`:''}`, inv?'warning':'success');
      const inp=msEl('ms-csv-input'); if (inp) inp.value='';
    } catch (err) { showToast('CSV parse error: '+err.message,'error'); }
  };
  reader.readAsText(file,'UTF-8');
}
function msDownloadTemplate() {
  const csv=['address,amount,note','0xB815A0c4bC23930119324d4359dB65e27A846A2d,10.00,Payment for consulting','0x411c60F8e61B5Cbe32F9a873b16D21CA85e9A634,25.50,Software license fee','0xC927B1d3fE6e12B1b72E3E5F3e3c5A7B9d4F2E1A,5.00,Expense reimbursement'].join('\n');
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  const a=Object.assign(document.createElement('a'),{href:url,download:'arc_multisend_template.csv'});
  a.click(); URL.revokeObjectURL(url);
}

// ─── Edit All — bulk edit all rows as CSV text ────────────────────────────
function msEditAll() {
  const rows = document.querySelectorAll('.ms-row');
  const header = 'address,amount,note';
  const lines = [header];
  rows.forEach(function (row) {
    const addr = (row.querySelector('.ms-addr')?.value || '').trim();
    const amt  = (row.querySelector('.ms-amt')?.value  || '').trim();
    const note = (row.querySelector('.ms-note')?.value || '').trim();
    if (!addr && !amt) return;
    lines.push(addr + ',' + amt + ',' + (note ? '"' + note.replace(/"/g,'""') + '"' : ''));
  });
  const text = lines.join('\n');

  // Modal
  document.getElementById('ms-editall-modal')?.remove();
  var modal = document.createElement('div');
  modal.id = 'ms-editall-modal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm';
  modal.innerHTML =
    '<div style="background:#0a0c18;border:1px solid rgba(6,182,212,0.3);border-radius:20px;width:100%;max-width:680px;padding:20px;max-height:90vh;display:flex;flex-direction:column;">' +
    '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">' +
    '<h3 style="color:#dde2f0;font-size:15px;font-weight:800;display:flex;align-items:center;gap:8px;"><i class="fas fa-edit" style="color:#22d3ee;"></i>Edit All Recipients</h3>' +
    '<span style="font-size:10px;color:#3a4870;margin-left:auto;">CSV format — address,amount,note per line</span>' +
    '</div>' +
    '<textarea id="ms-editall-textarea" rows="14" style="flex:1;width:100%;background:rgba(6,182,212,0.04);border:1px solid rgba(6,182,212,0.2);border-radius:12px;padding:12px;color:#dde2f0;font-size:12px;font-family:monospace;resize:none;outline:none;white-space:pre;tab-size:2;" onfocus="this.style.borderColor=\'rgba(6,182,212,0.5)\'" onblur="this.style.borderColor=\'rgba(6,182,212,0.2)\'">' + text + '</textarea>' +
    '<div style="display:flex;gap:10px;margin-top:12px;flex-shrink:0;">' +
    '<button onclick="msApplyEditAll()" id="ms-editall-apply" style="flex:1;padding:12px;border-radius:12px;border:none;font-size:13px;font-weight:700;cursor:pointer;background:linear-gradient(135deg,#0e7490,#0891b2);color:#fff;"><i class="fas fa-check mr-2"></i>Apply</button>' +
    '<button onclick="document.getElementById(\'ms-editall-modal\').remove()" style="padding:12px 18px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);color:#6b7280;border-radius:12px;cursor:pointer;font-size:13px;">Cancel</button>' +
    '</div>' +
    '<p style="font-size:10px;color:#3a4870;margin-top:8px;text-align:center;">First line is the header (address,amount,note) — edit the rows below it.</p>' +
    '</div>';
  modal.addEventListener('click', function (e) { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
  setTimeout(function () { var ta = document.getElementById('ms-editall-textarea'); if (ta) ta.focus(); }, 80);
}

function msApplyEditAll() {
  var ta = document.getElementById('ms-editall-textarea');
  if (!ta) return;
  var text = ta.value || '';
  var parsed = msParseCSV(text);
  if (!parsed || !parsed.length) { showToast('No valid rows found.', 'warning'); return; }

  var container = document.getElementById('ms-rows');
  if (!container) return;
  container.querySelectorAll('.ms-row').forEach(function (r) { r.remove(); });

  var count = 0;
  parsed.forEach(function (row) {
    var r = msNormalizeRow(row);
    var amt = parseFloat(r.amount || '');
    if (!r.address || !msIsAddr(r.address)) return;
    if (isNaN(amt) || amt <= 0 || amt > MS_MAX_AMOUNT_ROW) return;
    msAddRow(r.address, msFmt2(amt), r.note || '');
    count++;
  });
  showToast(count + ' row' + (count !== 1 ? 's' : '') + ' updated.', 'success');
  document.getElementById('ms-editall-modal')?.remove();
  msUpdateStats();
}

// ─── Network switch ───────────────────────────────────────────────────────────
async function msSwitchToArc() {
  try {
    await window.ethereum.request({ method:'wallet_switchEthereumChain', params:[{chainId:MS_CHAIN_HEX}] });
    return true;
  } catch (e) {
    if (e.code === 4902) {
      try {
        await window.ethereum.request({ method:'wallet_addEthereumChain', params:[{
          chainId: MS_CHAIN_HEX, chainName:'Arc Testnet',
          nativeCurrency:{name:'USDC',symbol:'USDC',decimals:6},
          rpcUrls:['https://rpc.testnet.arc.network', 'https://rpc.blockdaemon.testnet.arc.network', 'https://rpc.drpc.testnet.arc.network', 'https://rpc.quicknode.testnet.arc.network'],
          blockExplorerUrls:['https://testnet.arcscan.app'],
        }] });
        return true;
      } catch { return false; }
    }
    if (e.code === 4001) return false; // user rejected
    return false;
  }
}

// ─── Dynamic gas price ────────────────────────────────────────────────────────
async function msFetchGasPrice(provider) {
  try {
    const feeData = await provider.getFeeData();
    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
      const bump = (v, pct) => v + (v * BigInt(pct)) / 100n;
      return {
        maxFeePerGas:         bump(feeData.maxFeePerGas, 20),
        maxPriorityFeePerGas: bump(feeData.maxPriorityFeePerGas, 50),
      };
    }
    if (feeData.gasPrice) {
      return { gasPrice: feeData.gasPrice + (feeData.gasPrice * 25n) / 100n };
    }
  } catch (_) {}
  return {};
}

// ─── Decode revert reason ─────────────────────────────────────────────────────
function msDecodeRevert(error) {
  try {
    const msg = error?.reason || error?.data?.message || error?.error?.message || error?.message || '';
    const low = msg.toLowerCase();
    if (low.includes('rejected') || low.includes('denied') || error?.code === 4001 || error?.code === 'ACTION_REJECTED')
      return { userRejected: true, msg: 'Transaction rejected by user.' };
    if (low.includes('insufficient allowance') || low.includes('exceeds allowance') || low.includes('allowance'))
      return { msg: 'Insufficient USDC allowance. The approval may have failed or was insufficient.' };
    if (low.includes('insufficient balance') || low.includes('exceeds balance') || low.includes('transfer amount exceeds balance'))
      return { msg: 'Insufficient USDC balance.' };
    if (low.includes('invalid address') || low.includes('zero address'))
      return { msg: 'Invalid recipient address detected.' };
    if (low.includes('execution reverted') || low.includes('reverted')) {
      // Try to extract reason string
      const match = msg.match(/reason="([^"]+)"/i) || msg.match(/reverted: (.+?)(?:\n|$)/i);
      if (match) return { msg: `Contract reverted: ${match[1]}` };
      // Check for encoded revert data
      const dataMatch = error?.data;
      if (dataMatch && typeof dataMatch === 'string' && dataMatch.startsWith('0x08c379a0')) {
        try {
          // Decode Error(string)
          const hex = dataMatch.slice(10); // remove selector
          const offset = parseInt(hex.slice(0, 64), 16) * 2;
          const len = parseInt(hex.slice(64, 128), 16) * 2;
          const str = hex.slice(128, 128 + len);
          const reason = Buffer.from ? Buffer.from(str, 'hex').toString('utf8') :
            decodeURIComponent(str.replace(/../g, '%$&'));
          if (reason) return { msg: `Reverted: ${reason}` };
        } catch (_) {}
      }
      return { msg: 'Batch transfer failed (execution reverted). Verify allowance, balance, and addresses.' };
    }
    if (low.includes('nonce')) return { msg: 'Nonce error. Please try again.' };
    if (low.includes('gas')) return { msg: 'Gas estimation failed. Try again with fewer recipients.' };
    if (low.includes('timeout') || low.includes('network')) return { msg: 'Network timeout. Check your connection and try again.' };
    if (msg) return { msg: msg.slice(0, 200) };
    return { msg: 'Unknown error during transaction.' };
  } catch { return { msg: error?.message?.slice(0, 200) || 'Unknown error.' }; }
}

// ─── Simulate multicall3 aggregate3 via eth_call ─────────────────────────────
// IMPORTANT: Must simulate with from=senderAddr so the ERC-20 sees correct msg.sender context
async function msSimulateAggregate3(provider, senderAddr, calls) {
  try {
    const iface = new window.ethers.Interface(MS_MULTICALL3_ABI);
    const calldata = iface.encodeFunctionData('aggregate3', [calls]);
    // Use from=senderAddr so the call context is correct
    const result = await provider.call({
      to:   MS_MULTICALL3_ADDR,
      data: calldata,
      from: senderAddr,
    });
    const decoded = iface.decodeFunctionResult('aggregate3', result);
    const returnData = decoded[0];
    msLog('Multicall3 simulation OK, entries:', returnData.length);
    // Check each sub-call result
    for (let i = 0; i < returnData.length; i++) {
      const [success, data] = returnData[i];
      if (!success) {
        msWarn(`Simulation sub-call[${i}] failed, data:`, data);
        return { ok: false, failIndex: i, error: `Sub-call[${i}] failed` };
      }
    }
    return { ok: true, returnData };
  } catch (e) {
    const decoded = msDecodeRevert(e);
    msWarn('Multicall3 simulation failed:', decoded.msg, e.message);
    return { ok: false, error: decoded.msg || e.message };
  }
}

// ─── Simulate individual transferFrom via eth_call (from=mc3 perspective) ─────
async function msSimulateOneTransferFrom(provider, senderAddr, toAddr, amountBig) {
  try {
    const iface = new window.ethers.Interface(MS_ERC20_ABI);
    // When Multicall3 executes, the USDC.transferFrom is called FROM Multicall3
    // BUT the `from` parameter inside transferFrom IS senderAddr
    // We need to check if MC3 is allowed to call transferFrom(senderAddr, to, amount)
    const calldata = iface.encodeFunctionData('transferFrom', [senderAddr, toAddr, amountBig]);
    const result   = await provider.call({
      to:   MS_USDC_ADDR,
      data: calldata,
      from: MS_MULTICALL3_ADDR, // simulate as if Multicall3 is calling
    });
    const decoded = iface.decodeFunctionResult('transferFrom', result);
    return { ok: decoded[0] === true };
  } catch (e) {
    return { ok: false, error: msDecodeRevert(e).msg || e.message };
  }
}

// ─── USDC approve helper ──────────────────────────────────────────────────────
// FIX: approveAmount includes a 10% buffer to handle rounding edge cases
async function msEnsureAllowance(usdc, senderAddr, spenderAddr, requiredBig, onStatus) {
  onStatus(`Checking USDC allowance…`);
  // Resilient allowance read: wallet RPC → /api/rpc proxy → public RPC.
  // Worst case (all reads fail) assumes 0 and simply re-approves — safe.
  let currentAllowance;
  try { currentAllowance = await usdc.allowance(senderAddr, spenderAddr); }
  catch (readErr) {
    msWarn('Allowance read via wallet RPC failed — using read-RPC fallback:', readErr && readErr.message);
    currentAllowance = null;
    const roUrls = [];
    try { if (typeof window !== 'undefined' && window.location && window.location.origin.indexOf('http') === 0) roUrls.push(window.location.origin + '/api/rpc'); } catch (_) {}
    roUrls.push(MS_RPC);
    for (const u of roUrls) {
      try {
        currentAllowance = await new window.ethers.Contract(MS_USDC_ADDR, MS_ERC20_ABI, new window.ethers.JsonRpcProvider(u)).allowance(senderAddr, spenderAddr);
        break;
      } catch (_) {}
    }
    if (currentAllowance === null) currentAllowance = 0n;
  }
  const humanRequired = msMicroToUsdc(Number(requiredBig));
  msLog(`Allowance check: current=${window.ethers.formatUnits(currentAllowance, 6)} USDC required=${msFmt6(humanRequired)} USDC`);

  if (currentAllowance >= requiredBig) {
    msLog('Allowance sufficient, no approval needed.');
    onStatus(`✓ Allowance OK — ${msFmt2(humanRequired)} USDC already approved`);
    return { alreadyApproved: true };
  }

  msLog(`Requesting approve(${msShort(spenderAddr)}, ${requiredBig.toString()}) for Multicall3…`);
  onStatus(`Approve Multicall3 to spend $${msFmt2(humanRequired)} USDC — confirm in wallet…`);

  let approveTx;
  try {
    // Approve exact required amount (already has buffer from caller)
    approveTx = await usdc.approve(spenderAddr, requiredBig);
  } catch (e) {
    const decoded = msDecodeRevert(e);
    if (decoded.userRejected) throw new Error('Approval rejected by user. Cannot proceed without approval.');
    throw new Error(`Approval failed: ${decoded.msg}`);
  }

  msLog('Approve tx submitted:', approveTx.hash);
  onStatus(`Waiting for approval… <a href="${MS_EXPLORER}/tx/${approveTx.hash}" target="_blank" class="underline text-cyan-400 font-mono text-[10px]">${approveTx.hash.slice(0,14)}…</a>`);

  const approveReceipt = await approveTx.wait(1);
  if (approveReceipt.status !== 1) throw new Error('USDC approval transaction was mined but reverted on-chain.');

  msLog('Approval confirmed at block', approveReceipt.blockNumber);
  onStatus(`✓ USDC approved for Multicall3 — Block #${approveReceipt.blockNumber} · <a href="${MS_EXPLORER}/tx/${approveTx.hash}" target="_blank" class="underline text-cyan-400 font-mono text-[10px]">${approveTx.hash.slice(0,14)}…</a>`);
  return { alreadyApproved: false, txHash: approveTx.hash, block: approveReceipt.blockNumber };
}

// ─── Init rows ─────────────────────────────────────────────────────────────────
function msInitRows() {
  const container = msEl('ms-rows'); if (!container) return;
  container.innerHTML = ''; msRowCounter = 0;
  msAddRow(); msAddRow();
  const wallet = window.walletState?.address, fromEl = msEl('ms-from');
  if (fromEl && wallet) { fromEl.value = wallet; fromEl.dataset.autoFilled = 'true'; }
  msUpdateStats(); msSetStep(1);
}

function msInit() {
  const gate      = msEl('ms-wallet-gate');
  const connected = window.walletState?.connected;
  if (gate) gate.classList.toggle('hidden', !!connected);
  if (!document.querySelectorAll('.ms-row').length) msInitRows();
  else {
    const wallet = window.walletState?.address, fromEl = msEl('ms-from');
    if (fromEl && wallet && !fromEl.value) fromEl.value = wallet;
    msUpdateStats();
  }
  msRenderReceipts();
  msSetStep(msCurrentStep || 1);
}

// ─── Wallet listeners ──────────────────────────────────────────────────────────
window.addEventListener('walletConnected', (e) => {
  const addr = e.detail?.address, fromEl = msEl('ms-from');
  if (fromEl && addr && !fromEl.value) { fromEl.value = addr; fromEl.dataset.autoFilled = 'true'; }
  const gate = msEl('ms-wallet-gate'); if (gate) gate.classList.add('hidden');
});
window.addEventListener('walletDisconnected', () => {
  const fromEl = msEl('ms-from');
  if (fromEl && fromEl.dataset.autoFilled === 'true') { fromEl.value = ''; fromEl.dataset.autoFilled = 'false'; }
  const gate = msEl('ms-wallet-gate'); if (gate) gate.classList.remove('hidden');
});

// Load persisted receipts on startup
setTimeout(msLoadPersistedReceipts, 100);
