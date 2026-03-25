// ============================================================
// MULTISEND MODULE v7 — ARC AI Agents
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
          rpcUrls:['https://rpc.testnet.arc.network'],
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
  const currentAllowance = await usdc.allowance(senderAddr, spenderAddr);
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

// ─── Execute Multicall3 batch ─────────────────────────────────────────────────
// CRITICAL: Uses transferFrom(senderAddr, recipient, amount)
// User must have approved Multicall3 for at least totalAmount BEFORE calling this.
// The approval happens in Step 1 of msExecute(), BEFORE the fee payment.
async function msExecuteMulticall3(ethers, signer, provider, senderAddr, recipients, amounts, gasPrice, onStatus) {
  const iface = new ethers.Interface(MS_ERC20_ABI);
  const mc3   = new ethers.Contract(MS_MULTICALL3_ADDR, MS_MULTICALL3_ABI, signer);

  // Build calls array: USDC.transferFrom(sender, recipient, amount)
  const calls = recipients.map((to, i) => ({
    target:       MS_USDC_ADDR,
    allowFailure: false, // if any single transfer fails, revert entire batch = atomic
    callData:     iface.encodeFunctionData('transferFrom', [senderAddr, to, amounts[i]]),
  }));

  // Log all calls for debugging
  msLog(`Building ${calls.length} transferFrom calls:`);
  calls.forEach((call, i) => {
    msLog(`  Call[${i}]: to=${recipients[i]} amount=${ethers.formatUnits(amounts[i], 6)} USDC (${amounts[i].toString()} raw)`);
  });

  // Pre-simulate with from=senderAddr
  onStatus('Simulating batch transaction (pre-flight check)…');
  const sim = await msSimulateAggregate3(provider, senderAddr, calls);

  if (!sim.ok) {
    msWarn('Simulation failed, diagnosing individual calls…');
    // Try to identify which specific call is failing
    for (let i = 0; i < recipients.length; i++) {
      const s = await msSimulateOneTransferFrom(provider, senderAddr, recipients[i], amounts[i]);
      if (!s.ok) {
        const errMsg = `Transfer [${i+1}] to ${msShort(recipients[i])} $${msFmt2(Number(ethers.formatUnits(amounts[i], 6)))} would fail: ${s.error || 'simulation reverted'}`;
        msWarn(errMsg);
        throw new Error(errMsg);
      }
    }
    throw new Error(`Multicall3 simulation failed: ${sim.error || 'execution reverted. Check total allowance vs total amount.'}`);
  }

  msLog('Pre-flight simulation passed ✓');

  // Estimate gas with from override
  onStatus('Estimating gas for batch…');
  let gasLimit;
  try {
    const estimated = await mc3.aggregate3.estimateGas(calls, { from: senderAddr });
    gasLimit = BigInt(Math.ceil(Number(estimated) * MS_GAS_MARGIN));
    msLog(`Gas estimated: ${estimated} → with ${MS_GAS_MARGIN}x margin: ${gasLimit}`);
  } catch (e) {
    msWarn('Gas estimation failed, using fallback:', e.message);
    gasLimit = MS_GAS_PER_XFER * BigInt(recipients.length) + 250_000n;
    msLog(`Gas fallback: ${gasLimit} (${recipients.length} recipients × ${MS_GAS_PER_XFER} + 250k overhead)`);
  }

  onStatus(`Confirm batch in wallet — ${recipients.length} transfers in 1 transaction…`);
  msLog(`Sending mc3.aggregate3 gasLimit=${gasLimit}`, { gasPrice });

  let batchTx;
  try {
    batchTx = await mc3.aggregate3(calls, { gasLimit, ...gasPrice });
  } catch (e) {
    const decoded = msDecodeRevert(e);
    if (decoded.userRejected) throw new Error('Batch transaction rejected by user.');
    // Log full error for debugging
    msError('aggregate3 send error:', e);
    throw new Error(decoded.msg || 'Multicall3 transaction submission failed.');
  }

  msLog('Multicall3 tx submitted:', batchTx.hash);
  onStatus(`Confirming batch… <a href="${MS_EXPLORER}/tx/${batchTx.hash}" target="_blank" class="underline text-blue-400 font-mono text-[10px]">${batchTx.hash.slice(0,14)}…</a>`);

  const receipt = await batchTx.wait(1);
  msLog(`Multicall3 confirmed! Block: ${receipt.blockNumber}, GasUsed: ${receipt.gasUsed}`);

  if (receipt.status !== 1) {
    throw new Error(`Multicall3 transaction reverted on-chain at block #${receipt.blockNumber}. All transfers rolled back.`);
  }

  return { txHash: batchTx.hash, gasUsed: receipt.gasUsed?.toString(), blockNumber: receipt.blockNumber, receipt };
}

// ─── Sequential fallback (direct USDC.transfer, no Multicall3) ───────────────
// Used only if Multicall3 simulation consistently fails or user prefers it
async function msSequentialFallback(ethers, usdc, signer, provider, rows, decs, gasPrice, onStatus) {
  msLog('Using sequential direct USDC.transfer for', rows.length, 'transfers');
  const results = [];

  // Estimate gas from first transfer
  let perGas = BigInt(Math.ceil(Number(MS_GAS_PER_XFER) * MS_GAS_MARGIN));
  try {
    const sampleAmt = ethers.parseUnits(Number(rows[0].amount).toFixed(decs), decs);
    const est = await usdc.transfer.estimateGas(rows[0].address, sampleAmt);
    perGas = BigInt(Math.ceil(Number(est) * MS_GAS_MARGIN));
    msLog(`Sequential gas per transfer estimated: ${perGas}`);
  } catch (_) {
    msLog(`Sequential gas fallback: ${perGas}`);
  }

  const signerAddr = await signer.getAddress();
  let   nonce      = await provider.getTransactionCount(signerAddr, 'pending');

  const pending = [];
  for (let i = 0; i < rows.length; i++) {
    const p = rows[i];
    onStatus(`Sending ${i+1}/${rows.length} → ${msShort(p.address)} $${msFmt2(p.amount)}`);
    try {
      const amtBig = ethers.parseUnits(Number(p.amount).toFixed(decs), decs);
      if (amtBig <= 0n) throw new Error('Zero amount');
      const tx = await usdc.transfer(p.address, amtBig, { gasLimit: perGas, nonce: nonce++, ...gasPrice });
      pending.push({ tx, row: p, index: i });
      msLog(`Tx[${i}] submitted: ${tx.hash} nonce=${nonce-1}`);
    } catch (e) {
      const decoded = msDecodeRevert(e);
      if (decoded.userRejected) {
        results.push({ address: p.address, amount: p.amount, note: p.note || '', txHash: null, status: 'rejected', error: 'User rejected' });
        break; // stop on rejection
      }
      results.push({ address: p.address, amount: p.amount, note: p.note || '', txHash: null, status: 'failed', error: decoded.msg });
    }
  }

  for (const { tx, row } of pending) {
    try {
      const rcpt = await tx.wait(1);
      results.push({ address: row.address, amount: row.amount, note: row.note || '', txHash: tx.hash, status: rcpt.status === 1 ? 'confirmed' : 'failed', gasUsed: rcpt.gasUsed?.toString() });
    } catch (e) {
      results.push({ address: row.address, amount: row.amount, note: row.note || '', txHash: tx.hash, status: 'failed', error: e.message });
    }
  }

  // Fill in skipped rows
  rows.forEach(p => {
    if (!results.find(r => r.address?.toLowerCase() === p.address?.toLowerCase())) {
      results.push({ address: p.address, amount: p.amount, note: p.note || '', txHash: null, status: 'skipped' });
    }
  });

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN EXECUTE — Step 3
//
// FIXED EXECUTION ORDER:
//   1. Validate inputs, check network, get provider/signer
//   2. Check USDC balance >= (total_transfers + fee)
//   3. APPROVE Multicall3 for total_transfers amount (with buffer)
//      → This MUST happen BEFORE fee payment to guarantee allowance is valid
//      → Buffer = 10% extra to handle rounding
//   4. Pay platform fee (USDC.transfer to fee wallet)
//   5. Execute Multicall3.aggregate3 with all transferFrom calls (single tx)
//   6. Build receipt + PDF
//
// SINGLE EXECUTION GUARD: msExecuting flag prevents duplicate sends
// ═══════════════════════════════════════════════════════════════════════════════
async function msExecute() {
  // ── Duplicate prevention ────────────────────────────────────────────────────
  if (msExecuting) {
    showToast('Transaction already in progress. Please wait.', 'warning');
    return;
  }

  const execBtn = msEl('ms-execute-btn');
  const backBtn = msEl('ms-step3-back');
  const finEl   = msEl('ms-final-result');

  if (!msValidatedRows.length)        { showToast('No validated recipients.','warning'); return; }
  if (!window.ethereum)               { showToast('Wallet not detected. Install MetaMask.','error'); return; }
  if (!window.walletState?.connected) {
    showToast('Connect your wallet first.','warning');
    if (typeof openWalletModal === 'function') openWalletModal();
    return;
  }

  // Set executing flag and disable UI
  msExecuting = true;
  if (execBtn) { execBtn.disabled = true; execBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Processing…'; }
  if (backBtn) backBtn.disabled = true;
  if (finEl)   { finEl.classList.add('hidden'); finEl.innerHTML = ''; }
  msTxStepsReset();

  // Calculate totals using integer micro-USDC math to avoid floating point issues
  const totalMicro = msValidatedRows.reduce((s, r) => s + msToMicro(r.amount), 0);
  const total      = msMicroToUsdc(totalMicro);
  const fee        = msCalcFee(total, msValidatedRows.length);
  const grand      = total + fee;
  const batchId    = `BATCH-${Date.now().toString(36).toUpperCase()}`;

  msLog(`=== MULTISEND v7 EXECUTE ===`);
  msLog(`Recipients: ${msValidatedRows.length}`);
  msLog(`Total transfers: $${msFmt6(total)} USDC (${totalMicro} micro-USDC)`);
  msLog(`Platform fee: $${msFmt6(fee)} USDC`);
  msLog(`Grand total needed: $${msFmt6(grand)} USDC`);
  msLog(`Batch ID: ${batchId}`);
  msLog(`Multicall3: ${MS_MULTICALL3_ADDR}`);
  msLog(`USDC: ${MS_USDC_ADDR}`);

  let approvalTxHash = null;
  let feeTxHash      = null;
  let feeGasUsed     = '0';

  try {
    const ethers = window.ethers;
    if (!ethers) throw new Error('ethers.js not loaded. Refresh the page.');

    // ── Step 1: Network validation + provider + balance check ─────────────────
    msTxStep(1, 'active', 'Checking network and USDC balance…');

    // Network check
    const chainHex        = await window.ethereum.request({ method:'eth_chainId' });
    const currentChainId  = parseInt(chainHex, 16);
    msLog(`Current chain: ${currentChainId} | Required: ${MS_CHAIN_ID}`);

    if (currentChainId !== MS_CHAIN_ID) {
      msTxStep(1, 'active', 'Wrong network — switching to Arc Testnet (chainId 5042002)…');
      const ok = await msSwitchToArc();
      if (!ok) {
        msTxStep(1, 'error', `Wrong network (chain ${currentChainId}). Switch to Arc Testnet manually.`);
        showToast(`Switch to Arc Testnet (chain ID 5042002)`, 'error');
        throw new Error(`Network switch failed. Connected to chainId ${currentChainId}, need ${MS_CHAIN_ID}.`);
      }
      msLog('Network switched to Arc Testnet');
      await new Promise(r => setTimeout(r, 1200)); // let provider settle
    }

    // Init provider + signer
    const provider   = new ethers.BrowserProvider(window.ethereum, 'any');
    const signer     = await provider.getSigner();
    const senderAddr = await signer.getAddress();
    const usdc       = new ethers.Contract(MS_USDC_ADDR, MS_ERC20_ABI, signer);

    msLog(`Sender: ${senderAddr}`);

    // Confirm USDC decimals
    let decs = MS_USDC_DECIMALS;
    try { decs = Number(await usdc.decimals()); } catch (_) {}
    msLog(`USDC decimals: ${decs}`);
    if (decs !== MS_USDC_DECIMALS) msWarn(`⚠ USDC decimals = ${decs}, expected 6. Proceeding with ${decs}.`);

    // Parse exact BigInt amounts for all recipients (avoids float drift)
    const recipients  = [];
    const amounts     = [];
    let   totalBig    = 0n;

    for (const p of msValidatedRows) {
      if (!msIsAddr(p.address)) throw new Error(`Invalid address: "${p.address}"`);
      // Parse using exact 6-decimal string to avoid floating point drift
      const amtStr = (msToMicro(p.amount) / 1_000_000).toFixed(decs);
      const amtBig = ethers.parseUnits(amtStr, decs);
      if (amtBig <= 0n) throw new Error(`Zero amount for ${p.address}`);
      recipients.push(p.address);
      amounts.push(amtBig);
      totalBig += amtBig;
    }

    const feeBig    = ethers.parseUnits(fee.toFixed(decs), decs);
    const grandBig  = totalBig + feeBig;

    msLog(`totalBig=${totalBig} (${ethers.formatUnits(totalBig, decs)} USDC)`);
    msLog(`feeBig=${feeBig} (${ethers.formatUnits(feeBig, decs)} USDC)`);
    msLog(`grandBig=${grandBig} (${ethers.formatUnits(grandBig, decs)} USDC)`);

    // Balance check
    const balBig   = await usdc.balanceOf(senderAddr);
    const balHuman = Number(ethers.formatUnits(balBig, decs)).toFixed(2);
    msLog(`Balance: $${balHuman} USDC | Need: $${ethers.formatUnits(grandBig, decs)} USDC`);

    if (balBig < grandBig) {
      const need = Number(ethers.formatUnits(grandBig, decs)).toFixed(2);
      msTxStep(1, 'error', `Insufficient USDC: have $${balHuman}, need $${need}`);
      showToast(`Insufficient USDC balance: you have $${balHuman}, need $${need}`, 'error');
      throw new Error(`Insufficient USDC: have $${balHuman}, need $${need}`);
    }

    msTxStep(1, 'done', `✓ Network: Arc Testnet · Balance: $${balHuman} USDC · ${recipients.length} recipients validated`);

    // Fetch gas price
    const gasPrice = await msFetchGasPrice(provider);
    msLog('Gas price:', gasPrice);

    // ── Step 2: Approve Multicall3 FIRST, then pay fee ────────────────────────
    msTxStep(2, 'active', `Approving Multicall3 for batch ($${msFmt2(total)} USDC)…`);

    // Approval amount = totalBig + 10% buffer (NOT including fee, which goes directly to fee wallet)
    // Buffer formula: totalBig * 110 / 100
    const approveAmtBig = (totalBig * 110n) / 100n;
    msLog(`Approval amount: ${ethers.formatUnits(approveAmtBig, decs)} USDC (total + 10% buffer)`);

    try {
      const approvalResult = await msEnsureAllowance(
        usdc, senderAddr, MS_MULTICALL3_ADDR, approveAmtBig,
        (msg) => msTxStep(2, 'active', msg)
      );
      approvalTxHash = approvalResult.txHash || null;
      msLog('Approval complete:', approvalResult.alreadyApproved ? 'already sufficient' : `new approval tx: ${approvalTxHash}`);
    } catch (e) {
      msTxStep(2, 'error', e.message.slice(0, 150));
      showToast(e.message, 'error');
      throw e;
    }

    // Pay platform fee AFTER approval
    if (fee > 0 && feeBig > 0n) {
      msTxStep(2, 'active', `Paying platform fee $${msFmt2(fee)} USDC to fee wallet…`);
      msLog(`Fee tx: usdc.transfer(${MS_FEE_WALLET}, ${feeBig})`);

      let feeGasLimit = 80_000n;
      try {
        const est = await usdc.transfer.estimateGas(MS_FEE_WALLET, feeBig);
        feeGasLimit = BigInt(Math.ceil(Number(est) * MS_GAS_MARGIN));
      } catch (_) {}

      let feeTx;
      try {
        feeTx = await usdc.transfer(MS_FEE_WALLET, feeBig, { gasLimit: feeGasLimit, ...gasPrice });
      } catch (e) {
        const decoded = msDecodeRevert(e);
        const msg = decoded.userRejected ? 'Fee payment rejected by user.' : `Fee payment failed: ${decoded.msg}`;
        msTxStep(2, 'error', msg);
        showToast(msg, 'error');
        throw new Error(msg);
      }

      msLog('Fee tx submitted:', feeTx.hash);
      msTxStep(2, 'active', `Confirming fee tx… <a href="${MS_EXPLORER}/tx/${feeTx.hash}" target="_blank" class="underline text-yellow-400 font-mono text-[10px]">${feeTx.hash.slice(0,14)}…</a>`);

      const feeRcpt = await feeTx.wait(1);
      if (feeRcpt.status !== 1) throw new Error('Fee transaction was mined but reverted on-chain.');

      feeTxHash  = feeTx.hash;
      feeGasUsed = feeRcpt.gasUsed?.toString() || '0';
      msLog(`Fee confirmed! Block: ${feeRcpt.blockNumber}, hash: ${feeTx.hash}`);
      msTxStep(2, 'done',
        `✓ Fee $${msFmt2(fee)} USDC confirmed · Block #${feeRcpt.blockNumber} · ` +
        `<a href="${MS_EXPLORER}/tx/${feeTx.hash}" target="_blank" class="underline text-yellow-400 font-mono text-[10px]">${feeTx.hash.slice(0,14)}…</a>`
      );
    } else {
      msTxStep(2, 'done', '✓ No platform fee required for this batch.');
    }

    // ── Step 3: Multicall3 aggregate3 batch (single tx) ───────────────────────
    const label = msEl('ms-txstep-3-label');
    if (label) label.textContent = `Multicall3 Batch (${recipients.length} transfers)`;

    let batchTxHash    = null;
    let batchGasUsed   = 'N/A';
    let usedMethod     = 'multicall3';
    let batchResults   = [];
    let blockTimestamp = new Date().toISOString();

    msTxStep(3, 'active', `Executing Multicall3 batch — ${recipients.length} transferFrom calls in 1 tx…`);
    msLog('=== MULTICALL3 AGGREGATE3 ===');

    try {
      const batchResult = await msExecuteMulticall3(
        ethers, signer, provider, senderAddr,
        recipients, amounts, gasPrice,
        (msg) => msTxStep(3, 'active', msg)
      );

      batchTxHash  = batchResult.txHash;
      batchGasUsed = batchResult.gasUsed;
      msLog(`Multicall3 success! tx=${batchTxHash} block=${batchResult.blockNumber} gasUsed=${batchGasUsed}`);

      // Fetch block timestamp
      try {
        const blk = await provider.getBlock(batchResult.blockNumber);
        if (blk?.timestamp) blockTimestamp = new Date(blk.timestamp * 1000).toISOString();
      } catch (_) {}

      batchResults = msValidatedRows.map(p => ({
        address: p.address, amount: p.amount, note: p.note || '',
        txHash: batchTxHash, status: 'confirmed', gasUsed: null,
      }));

      if (label) label.textContent = `Multicall3 confirmed — ${recipients.length} recipients`;
      msTxStep(3, 'done',
        `✅ All ${recipients.length} transfers confirmed · $${msFmt2(total)} USDC · ` +
        `<a href="${MS_EXPLORER}/tx/${batchTxHash}" target="_blank" class="underline text-green-400 font-mono text-[10px]">${batchTxHash.slice(0,14)}…</a>`
      );

    } catch (e) {
      // Multicall3 failed — attempt sequential fallback
      msWarn('Multicall3 failed, attempting sequential fallback:', e.message);
      msTxStep(3, 'active', `Multicall3 failed — falling back to sequential transfers… (${e.message.slice(0,80)})`);
      usedMethod = 'sequential';

      try {
        batchResults = await msSequentialFallback(
          ethers, usdc, signer, provider, msValidatedRows, decs, gasPrice,
          (msg) => {
            if (label) label.textContent = msg;
            msTxStep(3, 'active', msg);
          }
        );

        const confirmed  = batchResults.filter(r => r.status === 'confirmed');
        const allOk      = confirmed.length === msValidatedRows.length;
        const confMicro  = confirmed.reduce((s, r) => s + msToMicro(r.amount), 0);
        const confAmount = msMicroToUsdc(confMicro);
        batchTxHash      = confirmed[0]?.txHash || null;
        batchGasUsed     = batchResults.filter(r => r.gasUsed).reduce((s, r) => s + Number(r.gasUsed || 0), 0).toString();

        if (batchTxHash) {
          try {
            const rcptData = await provider.getTransactionReceipt(batchTxHash);
            if (rcptData?.blockNumber) {
              const blk = await provider.getBlock(rcptData.blockNumber);
              if (blk?.timestamp) blockTimestamp = new Date(blk.timestamp * 1000).toISOString();
            }
          } catch (_) {}
        }

        if (label) label.textContent = `${confirmed.length}/${msValidatedRows.length} confirmed (sequential)`;
        msTxStep(3, allOk ? 'done' : 'error',
          `${confirmed.length}/${msValidatedRows.length} transfers confirmed · $${msFmt2(confAmount)} USDC`);

      } catch (seqErr) {
        msTxStep(3, 'error', `Sequential fallback also failed: ${seqErr.message.slice(0, 100)}`);
        throw seqErr;
      }
    }

    // ── Build receipt & render ─────────────────────────────────────────────────
    const confirmed  = batchResults.filter(r => r.status === 'confirmed');
    const confMicro  = confirmed.reduce((s, r) => s + msToMicro(r.amount), 0);
    const confAmount = msMicroToUsdc(confMicro);
    const allOk      = confirmed.length === msValidatedRows.length;
    msBatchesSent++;

    const receiptObj = msBuildReceipt({
      batchId,
      from:          senderAddr,
      decs,
      fee,
      feeTxHash,
      feeGasUsed,
      results:       batchResults,
      hashes:        confirmed.map(r => r.txHash).filter(Boolean),
      txHash:        batchTxHash,
      totalAmount:   confAmount,
      totalGasUsed:  batchGasUsed,
      blockTimestamp,
      approvalTxHash,
      multicallAddr: usedMethod === 'multicall3' ? MS_MULTICALL3_ADDR : 'N/A (sequential fallback)',
      method:        usedMethod,
      status:        allOk ? 'confirmed' : 'partial',
    });

    msReceipts.unshift(receiptObj);
    msRenderReceipts();
    msShowFinalResult(finEl, receiptObj, allOk);

    // Persist receipt after batch completes — do NOT auto-open
    setTimeout(() => {
      if (typeof arcSaveMultisendReceipt === 'function') arcSaveMultisendReceipt(receiptObj).catch(() => {});
    }, 200);

    showToast(
      allOk
        ? `✅ Batch confirmed · $${msFmt2(confAmount)} USDC · ${confirmed.length} recipients`
        : `⚠️ Partial: ${confirmed.length}/${msValidatedRows.length} confirmed`,
      allOk ? 'success' : 'warning'
    );

    if (allOk) { msInitRows(); msValidatedRows = []; }
    const batchEl = msEl('ms-stat-batches');
    if (batchEl) batchEl.textContent = msBatchesSent;
    if (typeof historyInit    === 'function') setTimeout(() => historyInit(), 3000);
    if (typeof loadDashboard  === 'function') setTimeout(loadDashboard, 2000);

    msLog('=== EXECUTE COMPLETE ===');

  } catch (e) {
    const decoded = msDecodeRevert(e);
    const msg     = decoded.msg || e.message || 'Unknown error';

    msError('Execute error:', e);
    msLog('Error decoded:', decoded);

    if (!decoded.userRejected) {
      showToast('Error: ' + msg, 'error');
    } else {
      showToast('Transaction cancelled.', 'warning');
    }

    if (typeof addLog === 'function') addLog('[MULTISEND v7] Error: ' + msg, 'error');

    // Mark the currently active step as error
    [1, 2, 3].forEach(n => {
      const el = msEl(`ms-txstep-${n}`);
      if (el && (el.className.includes('cyan') || el.className.includes('bg-cyan'))) {
        msTxStep(n, 'error', msg.slice(0, 120));
      }
    });

  } finally {
    // Always re-enable UI
    msExecuting = false;
    if (execBtn) { execBtn.disabled = false; execBtn.innerHTML = '<i class="fas fa-rocket mr-2"></i>Pay Fee &amp; Send All'; }
    if (backBtn) backBtn.disabled = false;
  }
}

// ─── Hybrid Multisend History (On-chain + Local) ────────────────────────────────
// Storage key for persisted receipts
const MS_HISTORY_KEY = 'arc_ms_history_v2';

// Load receipts from localStorage on startup
function msLoadPersistedReceipts() {
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
  if (countEl) countEl.textContent = msReceipts.length + ' receipt' + (msReceipts.length !== 1 ? 's' : '');

  if (!msReceipts.length) {
    container.innerHTML = `
      <div class="flex flex-col items-center gap-3 py-10 text-center text-gray-600">
        <i class="fas fa-inbox text-2xl"></i>
        <p class="text-sm">No batch receipts yet. Send a batch to generate a receipt.</p>
      </div>`;
    return;
  }

  container.innerHTML = msReceipts.map(r => {
    const synced = !!r._onChainSynced;
    const hasTx  = !!r.txHash;
    const syncBadge = synced
      ? `<span class="inline-flex items-center gap-1 text-[9px] font-bold bg-green-900/20 border border-green-700/25 text-green-400 px-2 py-0.5 rounded-full ml-1"><i class="fas fa-check-circle" style="font-size:7px"></i>Synced</span>`
      : hasTx
        ? `<span class="inline-flex items-center gap-1 text-[9px] font-bold bg-yellow-900/15 border border-yellow-700/20 text-yellow-400 px-2 py-0.5 rounded-full ml-1"><i class="fas fa-clock" style="font-size:7px"></i>Local only</span>`
        : `<span class="inline-flex items-center gap-1 text-[9px] bg-gray-800/50 border border-gray-700/20 text-gray-600 px-2 py-0.5 rounded-full ml-1"><i class="fas fa-database" style="font-size:7px"></i>Local</span>`;

    return `
    <div class="bg-gray-800/40 border ${synced ? 'border-green-800/30' : hasTx ? 'border-yellow-800/20' : 'border-gray-700/40'} rounded-2xl p-4 mb-3">
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
        <div class="text-right">
          <div class="text-green-400 font-bold text-sm">$${r.totalAmount} USDC</div>
          <div class="text-gray-600 text-xs">${r.count} recipient${r.count !== 1 ? 's' : ''}</div>
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

// Load persisted receipts on startup
setTimeout(msLoadPersistedReceipts, 100);

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

// ─── Final result banner ───────────────────────────────────────────────────────
function msShowFinalResult(finEl, r, allOk) {
  if (!finEl) return;
  finEl.classList.remove('hidden');
  finEl.className = `rounded-xl p-4 mb-4 ${allOk ? 'bg-green-900/20 border border-green-700/30' : 'bg-yellow-900/20 border border-yellow-700/30'}`;
  const totalRecipients = msValidatedRows.length || r.recipients?.length || r.count;
  finEl.innerHTML = `
    <div class="flex items-start gap-3">
      <i class="fas ${allOk ? 'fa-check-circle text-green-400' : 'fa-exclamation-triangle text-yellow-400'} text-xl mt-0.5"></i>
      <div class="flex-1">
        <div class="font-semibold ${allOk ? 'text-green-300' : 'text-yellow-300'} mb-2">
          ${allOk ? `✅ Batch complete — ${r.count} recipients confirmed.` : `⚠️ Partial: ${r.count}/${totalRecipients} confirmed.`}
        </div>
        <div class="text-xs text-gray-400 space-y-1">
          <div>Amount sent: <span class="text-white font-medium">$${r.totalAmount} USDC</span></div>
          <div>Platform fee: <span class="text-yellow-300">$${r.fee} USDC</span></div>
          <div>Gas used: <span class="text-gray-400">${r.totalGasUsed || 'N/A'}</span></div>
          <div>Method: <span class="text-cyan-400">${r.executionMethod}</span></div>
          ${r.executionMethod === 'multicall3' ? `<div class="text-[11px] text-green-400/80">✓ Atomic batch — all ${r.count} transfers in a single transaction</div>` : ''}
          ${r.txHash ? `<div>Batch tx: <a href="${r.explorerUrl}" target="_blank" class="text-blue-400 hover:underline font-mono">${r.txHash.slice(0,24)}…</a></div>` : ''}
          ${r.feeTxHash ? `<div>Fee tx: <a href="${MS_EXPLORER}/tx/${r.feeTxHash}" target="_blank" class="text-yellow-400 hover:underline font-mono">${r.feeTxHash.slice(0,24)}…</a></div>` : ''}
          ${r.approvalTxHash ? `<div>Approval tx: <a href="${MS_EXPLORER}/tx/${r.approvalTxHash}" target="_blank" class="text-cyan-400/70 hover:underline font-mono">${r.approvalTxHash.slice(0,24)}…</a></div>` : ''}
        </div>
        <div class="flex gap-2 mt-3 flex-wrap">
          <button onclick="arcViewMultisendReceipt ? arcViewMultisendReceipt('${r.id}') : msPdfReceipt('${r.id}')"
            class="flex items-center gap-1.5 px-3 py-1.5 bg-green-700/40 hover:bg-green-700/60 border border-green-600/40 text-green-300 hover:text-white text-xs rounded-xl transition font-semibold">
            <i class="fas fa-eye text-xs"></i>View Receipt
          </button>
          ${r.txHash ? `<a href="${r.explorerUrl}" target="_blank" rel="noopener" class="flex items-center gap-1.5 px-3 py-1.5 bg-gray-700/40 border border-gray-600/40 text-gray-400 text-xs rounded-xl transition"><i class="fas fa-external-link-alt text-xs"></i>ArcScan</a>` : ''}
        </div>
      </div>
    </div>`;
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
    setFont(15, 'bold', C.white); text('⚡ ARC AI Agents', margin, 12);
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
      text('ARC AI Agents · Testnet Receipt · Not a financial document', margin, pH - 5);
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

// ─── Init ──────────────────────────────────────────────────────────────────────
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

// ─── Global exports ────────────────────────────────────────────────────────────
window.msInit             = msInit;
window.msAddRow           = msAddRow;
window.msSubmit           = msExecute;
window.msHandleCSV        = msHandleCSV;
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
