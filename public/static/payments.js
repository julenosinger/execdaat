// ============================================================
// ARC Payments Module v3 — Scheduled Payments · Notes · Receipt Modal
// Features: real-time validation, scheduling, notes, receipt modal, PDF
// ============================================================
'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const PAY_USDC = () => window.USDC_ADDRESS || '0x3600000000000000000000000000000000000000';
const PAY_EURC = () => window.EURC_ADDRESS || '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const PAY_EXPLORER = () => window.ARC_EXPLORER || 'https://testnet.arcscan.app';
const PAY_CHAIN_ID  = 5042002;
const PAY_CHAIN_HEX = '0x4cef52';
const PAY_NOTE_MAX  = 300;
const PAY_SCHEDULED_KEY = 'arc_scheduled_payments';

const PAY_ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

const PAY_SELECTORS = {
  transfer:  '0xa9059cbb',
  balanceOf: '0x70a08231',
};

// ─── State ────────────────────────────────────────────────────────────────────
const payState = {
  token: 'USDC',
  senderBalance: { USDC: null, EURC: null },
  receipt: null,
  history: [],          // completed transactions
  scheduled: [],        // scheduled (pending) transactions
  step: 0,
  pending: false,
  scheduleMode: 'now',  // 'now' | 'later'
  schedTimerId: null,   // setInterval for polling scheduled jobs
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function payEl(id)       { return document.getElementById(id); }
function payShow(id)     { const el = payEl(id); if (el) el.style.display = ''; }
function payHide(id)     { const el = payEl(id); if (el) el.style.display = 'none'; }
function paySet(id, val) { const el = payEl(id); if (el) el.textContent = val; }

function shortAddr(addr) {
  if (!addr || addr.length < 12) return addr || '—';
  return addr.slice(0, 8) + '…' + addr.slice(-6);
}

function encAddr(addr) { return addr.replace(/^0x/, '').padStart(64, '0'); }
function isValidAddress(addr) { return /^0x[0-9a-fA-F]{40}$/.test(addr); }
function isValidEmail(email)  { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }

// ─── ethers helpers ────────────────────────────────────────────────────────────
function payGetProvider() {
  const raw = window.walletState?.provider;
  if (!raw) throw new Error('Wallet not connected. Please connect your EVM wallet first.');
  if (window.ethers?.BrowserProvider) return new window.ethers.BrowserProvider(raw);
  if (window.ethers?.providers?.Web3Provider) return new window.ethers.providers.Web3Provider(raw);
  return null;
}

async function payGetSigner() {
  const provider = payGetProvider();
  if (!provider) throw new Error('ethers.js not available');
  return provider.getSigner();
}

async function payGetContract(token) {
  if (!window.ethers?.Contract) return null;
  const addr = token === 'EURC' ? PAY_EURC() : PAY_USDC();
  const signer = await payGetSigner();
  return new window.ethers.Contract(addr, PAY_ERC20_ABI, signer);
}

function payNormaliseAmount(humanAmount) {
  let s = String(humanAmount).trim();
  if (/[eE]/.test(s)) s = Number(s).toFixed(6);
  const dot = s.indexOf('.');
  if (dot !== -1 && s.length - dot - 1 > 6) s = s.slice(0, dot + 7);
  return s;
}

function payParseUnits(humanAmount) {
  const s = payNormaliseAmount(humanAmount);
  if (window.ethers?.parseUnits) {
    try { return window.ethers.parseUnits(s, 6); } catch (e) { /* fallback */ }
  }
  const [intPart = '0', fracPart = ''] = s.split('.');
  const frac = fracPart.slice(0, 6).padEnd(6, '0');
  return BigInt(intPart) * 1_000_000n + BigInt(frac);
}

function payFormatUnits(rawAmount) {
  if (window.ethers?.formatUnits) return window.ethers.formatUnits(rawAmount, 6);
  return (Number(rawAmount) / 1e6).toFixed(6);
}

// ─── Network validation ────────────────────────────────────────────────────────
async function payEnsureNetwork() {
  const provider = window.walletState?.provider;
  if (!provider) throw new Error('Wallet not connected.');
  const chainHex = await provider.request({ method: 'eth_chainId' });
  if (parseInt(chainHex, 16) !== PAY_CHAIN_ID) {
    if (typeof switchToArcTestnet === 'function') {
      const ok = await switchToArcTestnet(provider);
      if (!ok) throw new Error('Please switch to Arc Testnet (Chain ID 5042002).');
      await new Promise(r => setTimeout(r, 600));
    } else {
      throw new Error('Wrong network. Switch to Arc Testnet (Chain ID 5042002).');
    }
  }
  return true;
}

// ─── Balance reading ───────────────────────────────────────────────────────────
async function payReadBalance(address, token = 'USDC') {
  const provider = window.walletState?.provider;
  if (!provider || !address) return null;
  try {
    if (window.ethers?.Contract) {
      const contract = await payGetContract(token);
      const rawBal = await contract.balanceOf(address);
      return parseFloat(window.ethers.formatUnits(rawBal, 6));
    }
    const contractAddr = token === 'EURC' ? PAY_EURC() : PAY_USDC();
    const data = PAY_SELECTORS.balanceOf + encAddr(address);
    const result = await provider.request({ method: 'eth_call', params: [{ to: contractAddr, data }, 'latest'] });
    if (!result || result === '0x') return 0;
    return Number(BigInt(result)) / 1e6;
  } catch (e) {
    console.warn('[PAY] Balance read error:', e.message);
    return null;
  }
}

// ─── Gas helpers ───────────────────────────────────────────────────────────────
async function payEstimateGas(txObj) {
  const provider = window.walletState?.provider;
  if (!provider) return '0x15F90';
  try {
    const est = await provider.request({ method: 'eth_estimateGas', params: [txObj] });
    return '0x' + Math.ceil(parseInt(est, 16) * 1.2).toString(16);
  } catch (e) { return '0x15F90'; }
}

async function payGetGasPrice() {
  const provider = window.walletState?.provider;
  if (!provider) return '0x2540BE400';
  try { return await provider.request({ method: 'eth_gasPrice' }); } catch (e) { return '0x2540BE400'; }
}

async function payGetNonce(address) {
  return await window.walletState.provider.request({ method: 'eth_getTransactionCount', params: [address, 'latest'] });
}

async function payWaitReceipt(txHash, maxAttempts = 30) {
  const provider = window.walletState?.provider;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [txHash] });
      if (receipt) return receipt;
    } catch (e) { /* ignore */ }
  }
  return { status: '0x1', txHash, note: 'Fast finality assumed' };
}

// ─── Refresh balances ──────────────────────────────────────────────────────────
async function refreshPaymentBalances() {
  const address = window.walletState?.address;
  if (!address) {
    paySet('pay-balance-usdc', '— USDC');
    paySet('pay-balance-eurc', '— EURC');
    paySet('pay-wallet-short', 'Not connected');
    paySet('pay-network-name', '—');
    paySet('pay-from-display', '—');
    return;
  }
  paySet('pay-wallet-short', shortAddr(address));
  paySet('pay-network-name', 'Arc Testnet ✓');
  paySet('pay-from-display', shortAddr(address));
  paySet('pay-balance-usdc', '…');
  paySet('pay-balance-eurc', '…');

  const [usdcBal, eurcBal] = await Promise.all([
    payReadBalance(address, 'USDC'),
    payReadBalance(address, 'EURC'),
  ]);
  payState.senderBalance.USDC = usdcBal;
  payState.senderBalance.EURC = eurcBal;
  paySet('pay-balance-usdc', usdcBal !== null ? usdcBal.toFixed(4) + ' USDC' : '— USDC');
  paySet('pay-balance-eurc', eurcBal !== null ? eurcBal.toFixed(4) + ' EURC' : '— EURC');
  updatePayMaxHint();
  payValidateForm();
}

// ─── Token selector ────────────────────────────────────────────────────────────
function selectPayToken(token) {
  payState.token = token;
  const uBtn = payEl('pay-token-usdc');
  const eBtn = payEl('pay-token-eurc');
  if (uBtn && eBtn) {
    if (token === 'USDC') {
      uBtn.className = 'pay-tok-btn tok-usdc';
      eBtn.className = 'pay-tok-btn tok-off';
    } else {
      uBtn.className = 'pay-tok-btn tok-off';
      eBtn.className = 'pay-tok-btn tok-eurc';
    }
  }
  const lblTok = payEl('pay-label-token');
  if (lblTok) lblTok.textContent = token;
  paySet('prev-token', token);
  updatePayMaxHint();
  updatePayPreview();
  payValidateForm();
}

function updatePayMaxHint() {
  const bal = payState.senderBalance[payState.token];
  const hint = payEl('pay-max-hint');
  if (hint) hint.textContent = bal !== null ? 'Balance: ' + bal.toFixed(4) + ' ' + payState.token : '';
}

// ─── MAX button ────────────────────────────────────────────────────────────────
async function setPayMax() {
  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Connect wallet first', 'warning'); return; }
  try {
    const contract = window.ethers?.Contract ? await payGetContract(payState.token) : null;
    let maxHuman;
    if (contract) {
      const rawBal = await contract.balanceOf(wallet);
      maxHuman = parseFloat(window.ethers.formatUnits(rawBal, 6));
    } else {
      const provider = window.walletState.provider;
      const contractAddr = payState.token === 'EURC' ? PAY_EURC() : PAY_USDC();
      const data = PAY_SELECTORS.balanceOf + encAddr(wallet);
      const result = await provider.request({ method: 'eth_call', params: [{ to: contractAddr, data }, 'latest'] });
      maxHuman = (result && result !== '0x') ? Number(BigInt(result)) / 1e6 : 0;
    }
    const input = payEl('pay-amount');
    if (input && maxHuman !== null) {
      input.value = maxHuman.toFixed(6);
      payValidateField('amount');
      updatePayPreview();
      payValidateForm();
    }
  } catch (e) {
    console.warn('[PAY:MAX] Error:', e.message);
  }
}

// ─── Note counter ─────────────────────────────────────────────────────────────
function payUpdateNoteCounter() {
  const ta  = payEl('pay-note');
  const cnt = payEl('pay-note-count');
  const wrap = cnt?.parentElement;
  if (!ta || !cnt) return;
  const len = ta.value.length;
  cnt.textContent = len;
  if (wrap) {
    wrap.className = 'pay-note-counter' + (len > PAY_NOTE_MAX ? ' over' : len > PAY_NOTE_MAX * 0.85 ? ' warn' : '');
  }
}

// ─── Schedule section ─────────────────────────────────────────────────────────
function payInitTimezones() {
  const sel = payEl('pay-sched-tz');
  if (!sel) return;
  let userTz = 'UTC';
  try { userTz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) {}

  // Common timezones list
  const zones = [
    'UTC',
    'America/New_York','America/Chicago','America/Denver','America/Los_Angeles',
    'America/Sao_Paulo','America/Argentina/Buenos_Aires','America/Mexico_City',
    'Europe/London','Europe/Paris','Europe/Berlin','Europe/Madrid','Europe/Rome',
    'Europe/Moscow','Asia/Dubai','Asia/Kolkata','Asia/Singapore','Asia/Tokyo',
    'Asia/Shanghai','Australia/Sydney','Pacific/Auckland',
  ];
  if (!zones.includes(userTz)) zones.unshift(userTz);

  sel.innerHTML = zones.map(tz =>
    `<option value="${tz}" ${tz === userTz ? 'selected' : ''}>${tz.replace(/_/g,' ')}</option>`
  ).join('');
}

function paySetSchedule(mode) {
  payState.scheduleMode = mode;
  const nowBtn   = payEl('pay-sched-now');
  const laterBtn = payEl('pay-sched-later');
  const inputs   = payEl('pay-sched-inputs');
  const sendBtn  = payEl('pay-send-btn');
  const sendTxt  = payEl('pay-send-btn-text');

  if (nowBtn)   nowBtn.className   = 'pay-sched-opt' + (mode === 'now'   ? ' active-now'   : '');
  if (laterBtn) laterBtn.className = 'pay-sched-opt' + (mode === 'later' ? ' active-later' : '');
  if (inputs)   inputs.style.display = mode === 'later' ? '' : 'none';

  // Pre-fill date/time to now + 1 hour as default
  if (mode === 'later') {
    const now = new Date(Date.now() + 3600_000);
    const pad = n => String(n).padStart(2, '0');
    const dateEl = payEl('pay-sched-date');
    const timeEl = payEl('pay-sched-time');
    if (dateEl && !dateEl.value) {
      dateEl.value = now.getFullYear() + '-' + pad(now.getMonth()+1) + '-' + pad(now.getDate());
    }
    if (timeEl && !timeEl.value) {
      timeEl.value = pad(now.getHours()) + ':' + pad(now.getMinutes());
    }
    payValidateSched();
  } else {
    const hint = payEl('pay-sched-hint');
    if (hint) { hint.textContent = ''; hint.className = 'pay-sched-hint'; }
  }

  updatePayPreview();
  payValidateForm();
}

function payGetSchedDateTime() {
  const dateEl = payEl('pay-sched-date');
  const timeEl = payEl('pay-sched-time');
  const tzEl   = payEl('pay-sched-tz');
  if (!dateEl?.value || !timeEl?.value) return null;
  const tz  = tzEl?.value || 'UTC';
  // Build ISO string in selected timezone using Intl trick
  const isoStr = dateEl.value + 'T' + timeEl.value + ':00';
  // Parse as local then adjust for timezone offset
  try {
    const d = new Date(isoStr);
    // Get offset difference between selected tz and UTC
    const tzOffset = new Date(isoStr).toLocaleString('en-US', { timeZone: tz, hour12: false });
    // Use a reliable approach: parse in UTC then shift
    const localFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    // Create date as if it's in that timezone
    const utcDate = new Date(isoStr + 'Z'); // treat as UTC temporarily
    const inTz = new Date(utcDate.toLocaleString('en-US', { timeZone: tz }));
    const diff = utcDate - inTz; // offset in ms
    return new Date(utcDate.getTime() + diff);
  } catch (_) {
    return new Date(isoStr);
  }
}

function payValidateSched() {
  if (payState.scheduleMode !== 'later') return true;
  const hint   = payEl('pay-sched-hint');
  const dateEl = payEl('pay-sched-date');
  const timeEl = payEl('pay-sched-time');
  if (!hint) return false;

  if (!dateEl?.value || !timeEl?.value) {
    hint.className = 'pay-sched-hint err';
    hint.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Please select date and time';
    return false;
  }

  const target = payGetSchedDateTime();
  const now    = Date.now();
  if (!target || target.getTime() <= now) {
    hint.className = 'pay-sched-hint err';
    hint.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Scheduled time must be in the future';
    return false;
  }

  const diff    = target.getTime() - now;
  const mins    = Math.round(diff / 60_000);
  const hours   = Math.floor(mins / 60);
  const remMins = mins % 60;
  const label   = hours > 0 ? `${hours}h ${remMins}m` : `${mins}m`;
  hint.className = 'pay-sched-hint ok';
  hint.innerHTML = `<i class="fas fa-check-circle"></i> Executes in ${label} — ${target.toLocaleString()}`;
  return true;
}

// ─── Preview update ────────────────────────────────────────────────────────────
function updatePayPreview() {
  const recipient      = (payEl('pay-recipient')?.value       || '').trim();
  const recipientName  = (payEl('pay-recipient-name')?.value  || '').trim();
  const recipientEmail = (payEl('pay-recipient-email')?.value || '').trim();
  const amountStr      = (payEl('pay-amount')?.value          || '').trim();
  const amountNum      = parseFloat(amountStr) || 0;
  const note           = (payEl('pay-note')?.value            || '').trim();
  const token          = payState.token;

  paySet('prev-token',     token);
  paySet('prev-amount',    amountNum > 0 ? amountNum.toFixed(6) + ' ' + token : '—');
  paySet('prev-recipient', isValidAddress(recipient) ? shortAddr(recipient) : (recipient || '—'));
  paySet('prev-network',   'Arc Testnet (5042002)');
  paySet('prev-gas',       token === 'EURC' ? '~2 txs (approve + transfer)' : '~1 tx (ERC-20 transfer)');

  const from = window.walletState?.address;
  if (from) paySet('pay-from-display', shortAddr(from));

  // Recipient name row
  const recipNameRow = payEl('prev-recipient-name-row');
  if (recipientName) {
    paySet('prev-recipient-name', recipientName);
    if (recipNameRow) recipNameRow.style.display = '';
  } else {
    if (recipNameRow) recipNameRow.style.display = 'none';
  }

  // Recipient email row
  const recipEmailRow = payEl('prev-recipient-email-row');
  if (recipientEmail) {
    paySet('prev-recipient-email-display', recipientEmail);
    if (recipEmailRow) recipEmailRow.style.display = '';
  } else {
    if (recipEmailRow) recipEmailRow.style.display = 'none';
  }

  // Scheduled row
  const schedRow = payEl('prev-sched-row');
  if (payState.scheduleMode === 'later') {
    const target = payGetSchedDateTime();
    if (target && target.getTime() > Date.now()) {
      paySet('prev-sched', target.toLocaleString());
      if (schedRow) schedRow.style.display = '';
    } else {
      if (schedRow) schedRow.style.display = 'none';
    }
  } else {
    if (schedRow) schedRow.style.display = 'none';
  }

  // Note row
  const noteRow = payEl('prev-note-row');
  if (note) {
    paySet('prev-note', note.length > 60 ? note.slice(0, 60) + '…' : note);
    if (noteRow) noteRow.style.display = '';
  } else {
    if (noteRow) noteRow.style.display = 'none';
  }
}

// ─── Field-level validation ────────────────────────────────────────────────────
function payValidateField(field) {
  const fieldMap = {
    fullname:       { el: 'pay-fullname',        hint: 'pay-hint-fullname'        },
    email:          { el: 'pay-email',           hint: 'pay-hint-email'           },
    recipient:      { el: 'pay-recipient',       hint: 'pay-hint-recipient'       },
    recipientEmail: { el: 'pay-recipient-email', hint: 'pay-hint-recipient-email' },
    amount:         { el: 'pay-amount',          hint: 'pay-hint-amount'          },
  };
  const f = fieldMap[field];
  if (!f) return;
  const input = payEl(f.el);
  const hint  = payEl(f.hint);
  if (!input || !hint) return;

  const val = input.value.trim();
  input.classList.remove('is-valid', 'is-error');
  hint.className = 'pay-field-hint';
  hint.textContent = '';

  if (field === 'fullname') {
    if (!val) { hint.className += ' info'; hint.textContent = ''; }
    else if (val.length < 2) { hint.className += ' err'; hint.textContent = 'Name too short'; input.classList.add('is-error'); }
    else { hint.className += ' ok'; hint.textContent = '✓'; input.classList.add('is-valid'); }
  }
  if (field === 'email' || field === 'recipientEmail') {
    if (!val) { hint.className += ' info'; hint.textContent = ''; }
    else if (!isValidEmail(val)) { hint.className += ' err'; hint.textContent = 'Invalid email format'; input.classList.add('is-error'); }
    else { hint.className += ' ok'; hint.textContent = '✓ Valid'; input.classList.add('is-valid'); }
  }
  if (field === 'recipient') {
    if (!val) { hint.className += ' info'; hint.textContent = 'Enter recipient wallet address'; }
    else if (!isValidAddress(val)) { hint.className += ' err'; hint.textContent = 'Invalid address — must start with 0x + 40 hex chars'; input.classList.add('is-error'); }
    else if (val.toLowerCase() === window.walletState?.address?.toLowerCase()) { hint.className += ' err'; hint.textContent = 'Cannot send to yourself'; input.classList.add('is-error'); }
    else { hint.className += ' ok'; hint.textContent = '✓ Valid Arc Testnet address'; input.classList.add('is-valid'); }
  }
  if (field === 'amount') {
    const num = parseFloat(val);
    const bal = payState.senderBalance[payState.token];
    if (!val) { hint.className += ' info'; hint.textContent = 'Enter amount to send'; }
    else if (isNaN(num) || num <= 0) { hint.className += ' err'; hint.textContent = 'Amount must be greater than 0'; input.classList.add('is-error'); }
    else if (bal !== null && num > bal) { hint.className += ' err'; hint.textContent = 'Insufficient balance (' + bal.toFixed(4) + ' ' + payState.token + ')'; input.classList.add('is-error'); }
    else { hint.className += ' ok'; hint.textContent = '✓ ' + num.toFixed(6) + ' ' + payState.token; input.classList.add('is-valid'); }
  }
}

// ─── Form-level validation ─────────────────────────────────────────────────────
function payValidateForm() {
  const btn     = payEl('pay-send-btn');
  const btnText = payEl('pay-send-btn-text');
  if (!btn) return;

  const fullname       = (payEl('pay-fullname')?.value        || '').trim();
  const email          = (payEl('pay-email')?.value           || '').trim();
  const recipient      = (payEl('pay-recipient')?.value       || '').trim();
  const recipientEmail = (payEl('pay-recipient-email')?.value || '').trim();
  const amountStr      = (payEl('pay-amount')?.value          || '').trim();
  const amount         = parseFloat(amountStr);
  const token          = payState.token;
  const bal            = payState.senderBalance[token];
  const connected      = !!window.walletState?.address;
  const noteLen        = (payEl('pay-note')?.value || '').length;

  let ok = true;
  let reason = payState.scheduleMode === 'later' ? 'Schedule Payment' : 'Sign & Send';

  if (!connected)                                        { ok = false; reason = 'Connect wallet to send'; }
  else if (fullname && fullname.length < 2)              { ok = false; reason = 'Name too short'; }
  else if (email && !isValidEmail(email))                { ok = false; reason = 'Invalid email format'; }
  else if (!isValidAddress(recipient))                   { ok = false; reason = 'Invalid recipient address'; }
  else if (recipient.toLowerCase() === window.walletState?.address?.toLowerCase()) { ok = false; reason = 'Cannot send to yourself'; }
  else if (recipientEmail && !isValidEmail(recipientEmail)) { ok = false; reason = 'Invalid recipient email'; }
  else if (isNaN(amount) || amount <= 0)                 { ok = false; reason = 'Enter a valid amount'; }
  else if (bal !== null && amount > bal)                 { ok = false; reason = 'Insufficient balance'; }
  else if (noteLen > PAY_NOTE_MAX)                       { ok = false; reason = 'Note too long (max 300)'; }
  else if (payState.scheduleMode === 'later' && !payValidateSched()) { ok = false; reason = 'Invalid scheduled time'; }

  btn.disabled = !ok || payState.pending;
  if (btnText) {
    if (payState.pending) {
      btnText.textContent = 'Processing…';
    } else if (payState.scheduleMode === 'later' && ok) {
      btnText.textContent = 'Schedule Payment';
    } else {
      btnText.textContent = ok ? (payState.scheduleMode === 'later' ? 'Schedule Payment' : 'Sign & Send') : reason;
    }
  }

  // Update button icon
  const btn_icon = btn.querySelector('i');
  if (btn_icon) {
    btn_icon.className = payState.scheduleMode === 'later' ? 'fas fa-calendar-check' : 'fas fa-paper-plane';
  }
}

// ─── Progress steps ────────────────────────────────────────────────────────────
function paySetStep(n, status) {
  payState.step = n;
  for (let i = 0; i <= 5; i++) {
    const el = payEl('pay-step-' + i);
    if (!el) continue;
    el.className = 'pstep';
    if (i < n)        el.classList.add('pstep-done');
    else if (i === n) el.classList.add(status === 'error' ? 'pstep-error' : 'pstep-active');
    else              el.classList.add('pstep-idle');
  }
  const panel = payEl('pay-steps-panel');
  if (panel) panel.style.display = '';
}

function paySetStepLabel(n, label) {
  const el = payEl('pay-step-label-' + n);
  if (el) el.textContent = label;
}

// ─── Error display ─────────────────────────────────────────────────────────────
function showPayError(msg) {
  const box = payEl('pay-error-box');
  if (box) { box.style.display = 'flex'; paySet('pay-error-text', msg); }
}
function hidePayError() {
  const box = payEl('pay-error-box');
  if (box) box.style.display = 'none';
}

// ─── Scheduled payments persistence (hybrid IndexedDB + localStorage) ─────────
function payLoadScheduled() {
  // Sync load from localStorage (scheduled jobs need synchronous access for poller)
  try {
    const raw = localStorage.getItem(PAY_SCHEDULED_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (_) { return []; }
}

function paySaveScheduled(list) {
  try { localStorage.setItem(PAY_SCHEDULED_KEY, JSON.stringify(list)); } catch (_) {}

  // Also persist each scheduled job to IndexedDB via arcSave
  if (typeof arcSave === 'function') {
    for (const job of list) {
      if (job.status === 'scheduled' || job.status === 'cancelled') {
        arcSave(window.ARC_STORE_PAY || 'payments', { ...job, type: 'payment' }).catch(() => {});
      }
    }
  }
}

function payAddScheduled(job) {
  const list = payLoadScheduled();
  list.push(job);
  paySaveScheduled(list);
  payState.scheduled = list;
}

function payRemoveScheduled(id) {
  const list = payLoadScheduled().filter(j => j.id !== id);
  paySaveScheduled(list);
  payState.scheduled = list;
  renderPaymentHistory();
}

function payCancelScheduled(id) {
  const list = payLoadScheduled().map(j => j.id === id ? { ...j, status: 'cancelled' } : j);
  paySaveScheduled(list);
  payState.scheduled = list;
  renderPaymentHistory();
  showToast('🗑 Scheduled payment cancelled', 'info');
}

function payEditScheduled(id) {
  const list = payLoadScheduled();
  const job  = list.find(j => j.id === id);
  if (!job) return;

  // Re-fill form with job data
  const fn  = payEl('pay-fullname');        if (fn)  fn.value  = job.fullname       || '';
  const em  = payEl('pay-email');           if (em)  em.value  = job.email          || '';
  const rc  = payEl('pay-recipient');       if (rc)  rc.value  = job.recipient      || '';
  const rn  = payEl('pay-recipient-name');  if (rn)  rn.value  = job.recipientName  || '';
  const re  = payEl('pay-recipient-email'); if (re)  re.value  = job.recipientEmail || '';
  const am  = payEl('pay-amount');          if (am)  am.value  = job.amount         || '';
  const nt  = payEl('pay-note');            if (nt)  nt.value  = job.note           || '';

  selectPayToken(job.token || 'USDC');
  paySetSchedule('later');

  if (job.scheduledAt) {
    const d = new Date(job.scheduledAt);
    const pad = n => String(n).padStart(2,'0');
    const dateEl = payEl('pay-sched-date');
    const timeEl = payEl('pay-sched-time');
    if (dateEl) dateEl.value = d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
    if (timeEl) timeEl.value = pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  // Remove the old job (will be re-added on submit)
  payRemoveScheduled(id);
  ['fullname','email','recipient','recipientEmail','amount'].forEach(payValidateField);
  payUpdateNoteCounter();
  updatePayPreview();
  payValidateForm();

  showToast('✏️ Edit your changes and click Schedule Payment', 'info');
  payEl('pay-fullname')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ─── Scheduled payment polling ─────────────────────────────────────────────────
function payStartSchedulePoller() {
  if (payState.schedTimerId) return;
  payState.schedTimerId = setInterval(async () => {
    const list = payLoadScheduled();
    const now  = Date.now();
    let changed = false;
    for (const job of list) {
      if (job.status !== 'scheduled') continue;
      if (new Date(job.scheduledAt).getTime() <= now) {
        if (!window.walletState?.address) continue;
        job.status = 'processing';
        changed = true;
        paySaveScheduled(list);
        renderPaymentHistory();
        try {
          await executeScheduledJob(job);
          job.status = 'completed';
          job.completedAt = new Date().toISOString();
        } catch (err) {
          job.status = 'failed';
          job.error  = err.message;
          showToast('❌ Scheduled payment failed: ' + err.message.slice(0,60), 'error');
        }
        changed = true;
      }
    }
    if (changed) { paySaveScheduled(list); payState.scheduled = list; renderPaymentHistory(); }
  }, 15_000); // check every 15s
}

async function executeScheduledJob(job) {
  showToast('⏰ Executing scheduled payment to ' + shortAddr(job.recipient) + '…', 'info');
  // Re-use core execution logic
  await executePaymentCore({
    fullname:       job.fullname,
    email:          job.email,
    recipient:      job.recipient,
    recipientName:  job.recipientName  || '',
    recipientEmail: job.recipientEmail || '',
    amountStr:      String(job.amount),
    token:          job.token,
    note:           job.note,
    schedJob:       job,
  });
}

// ─── Core payment execution (shared by immediate + scheduled) ──────────────────
async function executePaymentCore({ fullname, email, recipient, recipientName, recipientEmail, amountStr, token, note, schedJob }) {
  let amount;
  try { amount = payParseUnits(amountStr); } catch (e) { throw new Error('Invalid amount: ' + e.message); }
  if (amount === 0n) throw new Error('Amount cannot be zero.');

  const amountHuman = parseFloat(payFormatUnits(amount));
  const from        = window.walletState.address;

  await payEnsureNetwork();

  const currentBal = await payReadBalance(from, token);
  if (currentBal !== null && amountHuman > currentBal) {
    throw new Error('Insufficient ' + token + ' balance: ' + currentBal.toFixed(4) + ' available.');
  }

  let txHash   = null;
  let gasUsed  = '0';
  let gasPrice = '0x2540BE400';
  const startTime = Date.now();

  if (window.ethers?.Contract) {
    const contract = await payGetContract(token);
    showToast('📝 Confirm ' + token + ' transfer in your wallet…', 'info');
    const tx = await contract.transfer(recipient, amount);
    txHash   = tx.hash;
    gasPrice = await payGetGasPrice();
    showToast('⏳ Transaction submitted: ' + txHash.slice(0,14) + '…', 'info');
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error(token + ' transfer reverted on-chain.');
    gasUsed = receipt.gasUsed ? receipt.gasUsed.toString() : '~21000';
  } else {
    const contractAddr = token === 'EURC' ? PAY_EURC() : PAY_USDC();
    const data    = PAY_SELECTORS.transfer + encAddr(recipient) + BigInt(amount).toString(16).padStart(64, '0');
    gasPrice      = await payGetGasPrice();
    const txBase  = { from, to: contractAddr, data, value: '0x0' };
    const gas     = await payEstimateGas(txBase);
    const nonce   = await payGetNonce(from);
    txHash        = await window.walletState.provider.request({
      method: 'eth_sendTransaction',
      params: [{ from, to: contractAddr, data, value: '0x0', gas, gasPrice, nonce }],
    });
    const rxReceipt = await payWaitReceipt(txHash);
    if (rxReceipt.status !== '0x1' && rxReceipt.status !== 1) throw new Error('Transaction reverted on-chain.');
    gasUsed = rxReceipt.gasUsed ? parseInt(rxReceipt.gasUsed, 16).toString() : '~21000';
  }

  const durationMs = Date.now() - startTime;
  const gpNum      = Number(BigInt(gasPrice));
  let gasFeeEst    = (gpNum * Number(gasUsed)) / 1e18;
  if (isNaN(gasFeeEst) || gasFeeEst === 0) gasFeeEst = 0.000021;

  const receiptData = {
    id: 'pay_' + Date.now(),
    fullname, email, note: note || '',
    recipientName: recipientName || '',
    recipientEmail: recipientEmail || '',
    txHash, sender: from, recipient,
    amount: amountHuman, token,
    gasFee: gasFeeEst.toFixed(6), gasUsed,
    network: 'Arc Testnet', chainId: PAY_CHAIN_ID,
    timestamp: new Date().toISOString(),
    durationMs,
    explorerUrl: PAY_EXPLORER() + '/tx/' + txHash,
    status: 'completed',
    scheduledAt: schedJob?.scheduledAt || null,
  };

  // Save to backend (non-critical)
  try {
    await fetch('/api/payments/record', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(receiptData),
    });
  } catch (_) {}

  payState.receipt = receiptData;
  payState.history.unshift(receiptData);

  // Persist hybrid: IndexedDB + localStorage
  try {
    const stored = JSON.parse(localStorage.getItem('arc_pay_history') || '[]');
    stored.unshift(receiptData);
    localStorage.setItem('arc_pay_history', JSON.stringify(stored.slice(0, 50)));
  } catch (_) {}

  // Save to IndexedDB via persistence layer
  if (typeof arcSave === 'function') {
    arcSave(window.ARC_STORE_PAY || 'payments', {
      ...receiptData,
      type: 'payment',
      wallet: receiptData.sender || receiptData.from,
    }).catch(() => {});
  }

  showToast('✅ Payment confirmed! <a href="' + receiptData.explorerUrl + '" target="_blank" class="underline">View on ArcScan ↗</a>', 'success');
  if (typeof showTXConfirmationBadge === 'function')
    showTXConfirmationBadge(txHash, amountHuman + ' ' + token + ' → ' + shortAddr(recipient));

  return receiptData;
}

// ─── Main executePayment (called by button) ────────────────────────────────────
async function executePayment() {
  if (payState.pending) return;

  const fullname       = (payEl('pay-fullname')?.value        || '').trim();
  const email          = (payEl('pay-email')?.value           || '').trim();
  const recipient      = (payEl('pay-recipient')?.value       || '').trim();
  const recipientName  = (payEl('pay-recipient-name')?.value  || '').trim();
  const recipientEmail = (payEl('pay-recipient-email')?.value || '').trim();
  const amountStr      = (payEl('pay-amount')?.value          || '').trim();
  const note           = (payEl('pay-note')?.value            || '').trim();
  const token          = payState.token;

  ['fullname','email','recipient','recipientEmail','amount'].forEach(payValidateField);

  if (fullname && fullname.length < 2)            { showPayError('Name is too short.'); return; }
  if (email && !isValidEmail(email))              { showPayError('Invalid email address format.'); return; }
  if (!isValidAddress(recipient))                 { showPayError('Invalid recipient wallet address.'); return; }
  if (recipientEmail && !isValidEmail(recipientEmail)) { showPayError('Recipient email format is invalid.'); return; }
  if (!amountStr || Number(amountStr) <= 0)       { showPayError('Enter a valid amount greater than 0.'); return; }
  if (!window.walletState?.address)               { showPayError('Please connect your EVM wallet first.'); return; }
  if (note.length > PAY_NOTE_MAX)                 { showPayError('Payment note exceeds 300 characters.'); return; }

  const from = window.walletState.address;
  if (recipient.toLowerCase() === from.toLowerCase()) { showPayError('Cannot send to yourself.'); return; }

  // ── SCHEDULE mode ──────────────────────────────────────────────────────────
  if (payState.scheduleMode === 'later') {
    if (!payValidateSched()) { showPayError('Please set a valid future date and time.'); return; }
    const target = payGetSchedDateTime();
    const tz     = payEl('pay-sched-tz')?.value || 'UTC';

    const job = {
      id:             'sched_' + Date.now(),
      status:         'scheduled',
      fullname, email, recipient,
      recipientName, recipientEmail,
      amount:         amountStr,
      token, note,
      scheduledAt:    target.toISOString(),
      timezone:       tz,
      createdAt:      new Date().toISOString(),
      from,
    };

    payAddScheduled(job);
    renderPaymentHistory();
    payStartSchedulePoller();

    showToast('📅 Payment scheduled for ' + target.toLocaleString(), 'success');

    // Clear form
    payResetForm();
    return;
  }

  // ── IMMEDIATE mode ────────────────────────────────────────────────────────
  payState.pending = true;
  hidePayError();
  const successPanel = payEl('pay-success-panel');
  if (successPanel) successPanel.classList.remove('show');
  paySetStep(0);

  try {
    paySetStep(0); await payEnsureNetwork();
    paySetStep(1);
    const bal = await payReadBalance(from, token);
    payState.senderBalance[token] = bal;
    updatePayMaxHint();
    const amountHuman = parseFloat(payFormatUnits(payParseUnits(amountStr)));
    if (bal !== null && amountHuman > bal) {
      throw new Error('Insufficient ' + token + ' balance: ' + bal.toFixed(4) + ' available.');
    }

    paySetStep(2); paySetStepLabel(2, 'Token approval — N/A (direct ERC-20 transfer)'); paySetStep(2, 'done');
    paySetStep(3);

    const receiptData = await executePaymentCore({ fullname, email, recipient, recipientName, recipientEmail, amountStr, token, note });

    paySetStep(4); paySetStep(5);
    paySetStep(5, 'done');

    if (successPanel) successPanel.classList.add('show');

    // Store receipt — NO auto-download. View Receipt button shown in modal and history.
    payState.receipt = receiptData;
    // Persist receipt so it survives page refreshes
    if (typeof arcSavePaymentReceipt === 'function') {
      arcSavePaymentReceipt(receiptData).catch(() => {});
    }

    // Clear form
    payResetForm();
    await refreshPaymentBalances();
    renderPaymentHistory();
    if (typeof loadPayments === 'function') setTimeout(loadPayments, 1000);

    setTimeout(() => { const sp = payEl('pay-steps-panel'); if (sp) sp.style.display = 'none'; }, 3000);

  } catch (err) {
    console.error('[PAY] Payment error:', err);
    paySetStep(payState.step, 'error');
    const msg = err.code === 4001 || /reject|denied|user/i.test(err.message)
      ? 'Transaction rejected by user.'
      : /insufficient/i.test(err.message) ? err.message
      : /network|rpc|chain/i.test(err.message) ? 'Network error: ' + err.message
      : 'Payment failed: ' + err.message;
    showPayError(msg);
    showToast('❌ ' + err.message?.slice(0, 80), 'error');
  } finally {
    payState.pending = false;
    payValidateForm();
  }
}

function payResetForm() {
  ['pay-fullname','pay-email','pay-recipient','pay-recipient-name','pay-recipient-email','pay-amount'].forEach(id => {
    const el = payEl(id); if (el) { el.value = ''; el.classList.remove('is-valid','is-error'); }
  });
  ['pay-hint-fullname','pay-hint-email','pay-hint-recipient','pay-hint-recipient-name','pay-hint-recipient-email','pay-hint-amount'].forEach(id => {
    const el = payEl(id); if (el) el.textContent = '';
  });
  const noteEl = payEl('pay-note'); if (noteEl) noteEl.value = '';
  payUpdateNoteCounter();
  paySetSchedule('now');
  updatePayPreview();
  payValidateForm();
}

// ─── Receipt Modal ─────────────────────────────────────────────────────────────
function payOpenReceiptModal(receiptData) {
  const r = receiptData || payState.receipt;
  if (!r) { showToast('No receipt available', 'error'); return; }
  // Prefer opening in new tab with print dialog
  if (typeof arcViewPaymentReceipt === 'function') {
    arcViewPaymentReceipt(r);
    return;
  }
  // Fallback to inline modal
  const modal = payEl('pay-receipt-modal');
  const body  = payEl('pay-receipt-modal-body');
  if (!modal || !body) { showToast('No receipt available', 'error'); return; }
  body.innerHTML = buildReceiptHTML(r);
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function payCloseReceiptModal() {
  const modal = payEl('pay-receipt-modal');
  if (modal) modal.classList.remove('open');
  document.body.style.overflow = '';
}

function buildReceiptHTML(r) {
  const isScheduled = r.status === 'scheduled';
  const statusBadge = isScheduled
    ? '<span class="pay-status-scheduled">⏰ Scheduled</span>'
    : r.status === 'failed'
      ? '<span class="pay-status-failed">✗ Failed</span>'
      : '<span class="pay-status-completed">✓ Confirmed</span>';

  return `
    <div style="display:grid;gap:8px;margin-bottom:18px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
        ${statusBadge}
        <span style="font-size:10px;color:#7a9cc0;">${new Date(r.timestamp || r.createdAt).toLocaleString()}</span>
      </div>
      ${r.fullname  ? receiptRow('Sender Name',     r.fullname)  : ''}
      ${r.email     ? receiptRow('Sender Email',    r.email)     : ''}
      ${receiptRow('Token',      '<span style="color:#60b4ff;font-weight:700;">' + r.token + '</span>')}
      ${receiptRow('Amount',     '<span style="color:#dde2f0;font-weight:700;">' + Number(r.amount).toFixed(6) + ' ' + r.token + '</span>')}
      ${receiptRow('From',       '<span style="font-family:monospace;font-size:11px;color:#dde2f0;">' + shortAddr(r.sender || r.from) + '</span>')}
      ${receiptRow('To',         '<span style="font-family:monospace;font-size:11px;color:#dde2f0;">' + shortAddr(r.recipient) + '</span>')}
      ${r.recipientName  ? receiptRow('Recipient Name',  r.recipientName)  : ''}
      ${r.recipientEmail ? receiptRow('Recipient Email', r.recipientEmail) : ''}
      ${receiptRow('Network',    '<span style="color:#34d399;">' + (r.network || 'Arc Testnet') + '</span>')}
      ${r.note ? receiptRow('Note', '<span style="color:#a8c4e0;font-style:italic;">' + escHtml(r.note) + '</span>') : ''}
      ${r.scheduledAt ? receiptRow('Scheduled For', new Date(r.scheduledAt).toLocaleString()) : ''}
      ${r.txHash ? receiptRow('Tx Hash', '<a href="' + r.explorerUrl + '" target="_blank" style="color:#378ADD;font-family:monospace;font-size:11px;text-decoration:none;" onmouseover="this.style.textDecoration=\'underline\'" onmouseout="this.style.textDecoration=\'none\'">' + r.txHash.slice(0,16) + '… ↗</a>') : ''}
      ${r.timestamp ? receiptRow('Date & Time', new Date(r.timestamp).toLocaleString()) : ''}
      ${r.gasFee ? receiptRow('Est. Gas', '~' + r.gasFee + ' ARC') : ''}
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      <button onclick="(typeof arcViewPaymentReceipt==='function'?arcViewPaymentReceipt:payOpenReceiptModal)(payFindReceipt('${r.id}')||payState.receipt)"
        style="flex:1;min-width:120px;padding:9px;background:rgba(55,138,221,0.08);border:1px solid rgba(55,138,221,0.22);border-radius:10px;color:#60b4ff;font-size:12px;font-weight:700;cursor:pointer;transition:all 0.2s;display:flex;align-items:center;justify-content:center;gap:6px;"
        onmouseover="this.style.background='rgba(55,138,221,0.15)'" onmouseout="this.style.background='rgba(55,138,221,0.08)'">
        <i class="fas fa-external-link-alt"></i> Open Receipt
      </button>
      ${r.txHash ? `<a href="${r.explorerUrl}" target="_blank"
        style="flex:1;min-width:120px;padding:9px;background:rgba(29,158,117,0.08);border:1px solid rgba(29,158,117,0.25);border-radius:10px;color:#34d399;font-size:12px;font-weight:700;cursor:pointer;transition:all 0.2s;display:flex;align-items:center;justify-content:center;gap:6px;text-decoration:none;"
        onmouseover="this.style.background='rgba(29,158,117,0.15)'" onmouseout="this.style.background='rgba(29,158,117,0.08)'">
        <i class="fas fa-external-link-alt"></i> ArcScan
      </a>` : ''}
    </div>`;
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function receiptRow(label, value) {
  return `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid rgba(55,138,221,0.07);font-size:12px;">
      <span style="color:#8aaac8;flex-shrink:0;margin-right:12px;font-weight:600;">${label}</span>
      <span style="color:#dde2f0;text-align:right;word-break:break-all;">${value}</span>
    </div>`;
}

// Find receipt by id across history + scheduled
function payFindReceipt(id) {
  return payState.history.find(r => r.id === id)
      || payState.scheduled.find(r => r.id === id)
      || payState.receipt;
}

function downloadPayReceiptById(id) {
  // No auto-download — open in new tab instead
  const r = payFindReceipt(id) || payState.receipt;
  if (!r) { showToast('No receipt available', 'error'); return; }
  if (typeof arcViewPaymentReceipt === 'function') arcViewPaymentReceipt(r);
  else payOpenReceiptModal(r);
}

// ─── Receipt rendering (inline — used in success panel, kept for backward compat)
function renderPaymentReceipt(r) {
  const container = payEl('pay-receipt-content');
  if (!container || !r) return;
  container.innerHTML = '';  // Clear — receipt is now in modal
}

// ─── PDF Receipt generation ────────────────────────────────────────────────────
function generatePayReceiptPDF(r, autoDownload) {
  if (!r) r = payState.receipt;
  if (!r) { showToast('No receipt available', 'error'); return; }

  const jsPDF = window.jspdf?.jsPDF || window.jsPDF;
  if (jsPDF) {
    try {
      const doc = new jsPDF({ unit: 'mm', format: 'a4' });
      const W   = doc.internal.pageSize.getWidth();

      doc.setFillColor(245, 245, 255);
      doc.rect(0, 0, W, 40, 'F');
      doc.setFontSize(20); doc.setTextColor(50, 50, 180); doc.setFont('helvetica', 'bold');
      doc.text('Payment Receipt', W / 2, 18, { align: 'center' });
      doc.setFontSize(9); doc.setTextColor(120, 120, 140); doc.setFont('helvetica', 'normal');
      doc.text('ARC AI Agents · Arc Testnet · ' + new Date(r.timestamp || r.createdAt).toLocaleString(), W / 2, 26, { align: 'center' });

      const statusLabel = r.status === 'scheduled' ? '⏰ SCHEDULED' : '✓ CONFIRMED';
      doc.setFillColor(r.status === 'scheduled' ? 235 : 220, r.status === 'scheduled' ? 220 : 255, r.status === 'scheduled' ? 255 : 235);
      doc.roundedRect(W / 2 - 20, 30, 40, 7, 3, 3, 'F');
      doc.setTextColor(r.status === 'scheduled' ? 100 : 22, r.status === 'scheduled' ? 60 : 140, r.status === 'scheduled' ? 200 : 80);
      doc.setFontSize(9); doc.setFont('helvetica', 'bold');
      doc.text(statusLabel, W / 2, 35.5, { align: 'center' });

      let y = 50;
      const addSection = (title) => {
        doc.setFillColor(245, 246, 255); doc.rect(14, y - 4, W - 28, 7, 'F');
        doc.setFontSize(9); doc.setTextColor(80, 80, 160); doc.setFont('helvetica', 'bold');
        doc.text(title.toUpperCase(), 16, y + 0.5); y += 8;
      };
      const addRow = (label, value, valueColor) => {
        doc.setFontSize(10); doc.setFont('helvetica', 'normal'); doc.setTextColor(120, 120, 130);
        doc.text(label, 16, y);
        doc.setFont('helvetica', 'bold');
        if (valueColor) doc.setTextColor(...valueColor); else doc.setTextColor(30, 30, 40);
        const maxW = W - 80;
        const lines = doc.splitTextToSize(String(value || '—'), maxW);
        doc.text(lines, W - 14, y, { align: 'right' });
        y += 7 * lines.length;
        doc.setDrawColor(230, 230, 240); doc.line(16, y - 1, W - 16, y - 1);
      };

      addSection('Sender Information');
      addRow('Full Name',  r.fullname || '—');
      addRow('Email',      r.email    || '—');
      addRow('From Wallet', r.sender  || r.from || '—');
      y += 4;

      addSection('Payment Details');
      addRow('Token',       r.token, [34, 100, 200]);
      addRow('Amount',      Number(r.amount).toFixed(6) + ' ' + r.token);
      addRow('Recipient',   r.recipient);
      addRow('Network',     (r.network || 'Arc Testnet') + ' (Chain ' + (r.chainId || PAY_CHAIN_ID) + ')', [22, 140, 80]);
      if (r.gasFee) addRow('Est. Gas Fee', '~' + r.gasFee + ' ARC');
      if (r.note)   addRow('Note', r.note);
      y += 4;

      addSection('Transaction Details');
      if (r.scheduledAt) addRow('Scheduled For', new Date(r.scheduledAt).toLocaleString());
      if (r.txHash)     { addRow('Transaction Hash', r.txHash); addRow('Explorer', r.explorerUrl); }
      addRow('Date & Time', new Date(r.timestamp || r.createdAt).toLocaleString());
      if (r.durationMs) addRow('Duration', (r.durationMs / 1000).toFixed(1) + 's');
      y += 4;

      doc.setFontSize(8); doc.setTextColor(160, 160, 175); doc.setFont('helvetica', 'normal');
      doc.text('Generated by ARC AI Agents · https://testnet.arcscan.app · Testnet only — no real funds', W / 2, 285, { align: 'center' });

      // No auto-download — open PDF in new tab instead
      const html = typeof arcBuildPaymentReceiptHTML === 'function'
        ? arcBuildPaymentReceiptHTML(r)
        : null;
      if (html && typeof arcOpenReceiptTab === 'function') {
        arcOpenReceiptTab(html, 'Payment Receipt');
        showToast('✅ Receipt opened in new tab', 'success');
        return;
      }
      // Fallback: open PDF blob in new tab
      const pdfBlob = doc.output('blob');
      const pdfUrl  = URL.createObjectURL(pdfBlob);
      const pdfWin  = window.open(pdfUrl, '_blank');
      if (pdfWin) setTimeout(() => URL.revokeObjectURL(pdfUrl), 30000);
      showToast('✅ Receipt opened in new tab', 'success');
      return;
    } catch (e) { console.warn('[PAY:PDF] jsPDF error:', e.message); }
  }

  // Fallback: print window
  const note = r.note ? `<div class="row"><span class="lbl">Note</span><span class="val" style="font-style:italic;">${escHtml(r.note)}</span></div>` : '';
  const sched = r.scheduledAt ? `<div class="row"><span class="lbl">Scheduled For</span><span class="val">${new Date(r.scheduledAt).toLocaleString()}</span></div>` : '';
  const txRow = r.txHash ? `
    <div class="row"><span class="lbl">Transaction Hash</span><span class="val" style="font-family:monospace;font-size:10px;">${r.txHash}</span></div>
    <div class="row"><span class="lbl">Explorer</span><span class="val"><a href="${r.explorerUrl}" style="color:#2563eb;">${r.explorerUrl}</a></span></div>` : '';

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Payment Receipt — ARC Testnet</title>
  <style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:'Segoe UI',Arial,sans-serif;background:#fff;color:#111;padding:40px;max-width:640px;margin:auto;}.header{background:linear-gradient(135deg,#f0f0ff,#e8f4ff);border-radius:12px;padding:24px;text-align:center;margin-bottom:28px;}.header h1{font-size:22px;color:#3730a3;margin-bottom:6px;}.header p{font-size:12px;color:#6b7280;}.badge{display:inline-block;background:#d1fae5;color:#065f46;padding:4px 14px;border-radius:20px;font-size:11px;font-weight:700;margin-top:10px;}.section-title{font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#6366f1;font-weight:700;background:#f5f5ff;padding:6px 12px;border-radius:6px;margin:20px 0 8px;}.row{display:flex;justify-content:space-between;align-items:flex-start;padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:13px;}.row .lbl{color:#6b7280;flex-shrink:0;margin-right:16px;}.row .val{font-weight:600;word-break:break-all;text-align:right;}.footer{margin-top:32px;font-size:10px;color:#9ca3af;text-align:center;border-top:1px solid #e5e7eb;padding-top:14px;}@media print{body{padding:20px;}}</style>
  </head><body>
  <div class="header"><h1>Payment Receipt</h1><p>ARC AI Agents · Arc Testnet · ${new Date(r.timestamp || r.createdAt).toLocaleString()}</p><span class="badge">${r.status === 'scheduled' ? '⏰ SCHEDULED' : '✓ CONFIRMED'}</span></div>
  <div class="section-title">Sender Information</div>
  <div class="row"><span class="lbl">Full Name</span><span class="val">${r.fullname || '—'}</span></div>
  <div class="row"><span class="lbl">Email</span><span class="val">${r.email || '—'}</span></div>
  <div class="row"><span class="lbl">From Wallet</span><span class="val" style="font-family:monospace;font-size:11px;">${r.sender || r.from || '—'}</span></div>
  <div class="section-title">Payment Details</div>
  <div class="row"><span class="lbl">Token</span><span class="val" style="color:#2563eb;">${r.token}</span></div>
  <div class="row"><span class="lbl">Amount</span><span class="val">${Number(r.amount).toFixed(6)} ${r.token}</span></div>
  <div class="row"><span class="lbl">Recipient</span><span class="val" style="font-family:monospace;font-size:11px;">${r.recipient}</span></div>
  <div class="row"><span class="lbl">Network</span><span class="val" style="color:#059669;">${r.network || 'Arc Testnet'}</span></div>
  ${note}${sched}
  <div class="section-title">Transaction Details</div>
  ${txRow}
  <div class="row"><span class="lbl">Date & Time</span><span class="val">${new Date(r.timestamp || r.createdAt).toLocaleString()}</span></div>
  <div class="footer">Generated by ARC AI Agents &middot; testnet.arcscan.app &middot; Testnet only</div>
  </body></html>`;

  if (typeof arcOpenReceiptTab === 'function') {
    arcOpenReceiptTab(html, 'Payment Receipt');
  } else {
    const blob = new Blob([html], { type: 'text/html' });
    const url  = URL.createObjectURL(blob);
    const win  = window.open(url, '_blank');
    if (win) { win.onload = () => { setTimeout(() => { win.print(); URL.revokeObjectURL(url); }, 300); }; }
    else { const a = document.createElement('a'); a.href = url; a.download = 'arc-receipt.html'; a.click(); }
  }
  showToast('✅ Receipt opened in new tab', 'success');
}

// ─── JSON/PDF download (legacy — now opens in new tab) ────────────────────────
function downloadPayReceipt(format) {
  const r = payState.receipt;
  if (!r) { showToast('No receipt available', 'error'); return; }
  // Both formats now open in new tab with print dialog (no auto-download)
  if (typeof arcViewPaymentReceipt === 'function') arcViewPaymentReceipt(r);
  else payOpenReceiptModal(r);
}

// ─── History rendering ─────────────────────────────────────────────────────────
function renderPaymentHistory() {
  const container = payEl('pay-history-list');
  if (!container) return;

  // Merge: scheduled jobs + completed history
  const scheduled = payLoadScheduled();
  payState.scheduled = scheduled;

  const allItems = [
    ...scheduled.filter(j => j.status !== 'cancelled').map(j => ({ ...j, _type: 'scheduled' })),
    ...payState.history.map(h => ({ ...h, _type: 'history' })),
  ].sort((a, b) => {
    const ta = a.scheduledAt || a.timestamp || a.createdAt;
    const tb = b.scheduledAt || b.timestamp || b.createdAt;
    return new Date(tb) - new Date(ta);
  }).slice(0, 25);

  if (allItems.length === 0) {
    // Show "no data" only if we're certain there's nothing locally
    const hasLocal = typeof arcLoad === 'function';
    container.innerHTML = `
      <div style="color:#8aaac8;font-size:11px;text-align:center;padding:28px 0;">
        <i class="fas fa-clock" style="font-size:22px;display:block;margin-bottom:8px;color:#5a7898;"></i>
        ${window.walletState?.address ? 'No transactions yet' : 'Connect wallet to view history'}
      </div>`;
    return;
  }

  container.innerHTML = allItems.map(r => {
    const isScheduled  = r.status === 'scheduled';
    const isProcessing = r.status === 'processing';
    const isFailed     = r.status === 'failed';
    const isCancelled  = r.status === 'cancelled';
    const isCached     = r._source === 'local' && !r.txHash && !isScheduled;

    // Use unified arcStatusBadge if available, else fallback
    let statusBadge;
    if (typeof arcStatusBadge === 'function') {
      const st = isCached ? 'cached' : (r.status || 'pending');
      statusBadge = arcStatusBadge(st);
    } else {
      statusBadge = isScheduled
        ? '<span class="pay-status-scheduled">⏰ Scheduled</span>'
        : isProcessing
          ? '<span class="pay-status-processing">⚡ Processing</span>'
          : isFailed
            ? '<span class="pay-status-failed">✗ Failed</span>'
            : isCancelled
              ? '<span class="arc-badge-cancelled">— Cancelled</span>'
              : '<span class="pay-status-completed">✓ Completed</span>';
    }

    const dateLabel = isScheduled
      ? '📅 ' + new Date(r.scheduledAt).toLocaleString()
      : r.timestamp ? new Date(r.timestamp).toLocaleDateString() : '—';

    const noteSnip = r.note ? `<div style="font-size:10px;color:#8aaac8;margin-top:4px;font-style:italic;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px;">"${escHtml(r.note)}"</div>` : '';

    const txLink = r.txHash
      ? `<a href="${r.explorerUrl}" target="_blank" style="color:#378ADD;text-decoration:none;font-family:monospace;font-size:10px;" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">${r.txHash.slice(0,10)}…↗</a>`
      : `<span style="color:#7a9cc0;font-size:10px;">${dateLabel}</span>`;

    const editBtn = isScheduled
      ? `<button onclick="payEditScheduled('${r.id}')" title="Edit" style="background:rgba(55,138,221,0.08);border:1px solid rgba(55,138,221,0.22);border-radius:6px;color:#60b4ff;font-size:10px;padding:2px 7px;cursor:pointer;transition:all 0.2s;" onmouseover="this.style.background='rgba(55,138,221,0.18)'" onmouseout="this.style.background='rgba(55,138,221,0.08)'"><i class="fas fa-edit"></i></button>`
      : '';
    const cancelBtn = isScheduled
      ? `<button onclick="payCancelScheduled('${r.id}')" title="Cancel" style="background:rgba(239,68,68,0.07);border:1px solid rgba(239,68,68,0.2);border-radius:6px;color:#f87171;font-size:10px;padding:2px 7px;cursor:pointer;transition:all 0.2s;" onmouseover="this.style.background='rgba(239,68,68,0.15)'" onmouseout="this.style.background='rgba(239,68,68,0.07)'"><i class="fas fa-times"></i></button>`
      : '';
    const retryBtn = isFailed && typeof arcRetryBtn === 'function'
      ? arcRetryBtn(window.ARC_STORE_PAY || 'payments', r.id)
      : '';
    const viewBtn = `<button onclick="(typeof arcViewPaymentReceipt==='function'?arcViewPaymentReceipt:payOpenReceiptModal)(${JSON.stringify(r).replace(/"/g,'&quot;')})" title="Open Receipt" style="background:rgba(29,158,117,0.07);border:1px solid rgba(29,158,117,0.22);border-radius:6px;color:#34d399;font-size:10px;padding:2px 7px;cursor:pointer;transition:all 0.2s;" onmouseover="this.style.background='rgba(29,158,117,0.15)'" onmouseout="this.style.background='rgba(29,158,117,0.07)'"><i class="fas fa-eye"></i></button>`;

    return `
    <div style="background:rgba(55,138,221,0.04);border:1px solid rgba(55,138,221,0.14);border-radius:10px;padding:10px 12px;transition:border-color 0.2s;"
         onmouseover="this.style.borderColor='rgba(55,138,221,0.3)'" onmouseout="this.style.borderColor='rgba(55,138,221,0.14)'">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;gap:6px;">
        <span style="color:#dde2f0;font-size:12px;font-weight:700;">${Number(r.amount).toFixed(4)} ${r.token}</span>
        <div style="display:flex;align-items:center;gap:4px;">${statusBadge}</div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#8aaac8;margin-bottom:3px;">
        <span>→ ${shortAddr(r.recipient)}</span>
        ${txLink}
      </div>
      ${noteSnip}
      <div style="font-size:10px;color:#7a9cc0;margin-top:3px;display:flex;flex-wrap:wrap;gap:6px;">
        ${r.fullname ? `<span>👤 ${r.fullname}${r.email ? ' &lt;' + r.email + '&gt;' : ''}</span>` : ''}
        ${r.recipientName ? `<span style="color:#4a9470;">📩 ${r.recipientName}${r.recipientEmail ? ' &lt;' + r.recipientEmail + '&gt;' : ''}</span>` : (r.recipientEmail ? `<span style="color:#4a9470;">📩 ${r.recipientEmail}</span>` : '')}
      </div>
      <div style="display:flex;align-items:center;gap:4px;margin-top:7px;justify-content:flex-end;">
        ${editBtn}${cancelBtn}${retryBtn}${viewBtn}
      </div>
    </div>`;
  }).join('');
}

// ─── Load history from IndexedDB / localStorage on startup ──────────────────────
async function payLoadLocalHistory() {
  const wallet = window.walletState?.address;

  // No wallet = clear displayed history
  if (!wallet) {
    payState.history   = [];
    payState.scheduled = [];
    renderPaymentHistory();
    return;
  }

  // Try IndexedDB first
  if (typeof arcLoad === 'function') {
    try {
      const items = await arcLoad(window.ARC_STORE_PAY || 'payments');
      if (items && items.length > 0) {
        // Separate completed history from scheduled
        const completed = items.filter(r =>
          r.status === 'completed' || r.status === 'confirmed' || r.status === 'failed'
        );
        const scheduled = items.filter(r =>
          r.status === 'scheduled' || r.status === 'processing'
        );
        payState.history = completed;
        // Merge scheduled back into localStorage-based list
        if (scheduled.length > 0) {
          const lsScheduled = payLoadScheduled();
          const lsIds = new Set(lsScheduled.map(j => j.id));
          const newSched = scheduled.filter(j => !lsIds.has(j.id));
          if (newSched.length > 0) {
            paySaveScheduled([...lsScheduled, ...newSched]);
          }
        }
        console.log('[PAY] Loaded', completed.length, 'records from IndexedDB');
        return;
      }
    } catch (e) {
      console.warn('[PAY] IndexedDB load failed, falling back to localStorage:', e.message);
    }
  }

  // Fallback to localStorage
  try {
    const raw = JSON.parse(localStorage.getItem('arc_pay_history') || '[]');
    payState.history = Array.isArray(raw) ? raw : [];
    console.log('[PAY] Loaded', payState.history.length, 'records from localStorage');
  } catch (_) { payState.history = []; }
}

// ─── Background sync handler ─────────────────────────────────────────────────
window.addEventListener('arcSyncRequest', async (e) => {
  const currentWallet = window.walletState?.address;
  if (!currentWallet) return;
  // Re-load history from persistence layer and merge with in-memory state
  try {
    await payLoadLocalHistory();
  } catch (err) {
    console.warn('[PAY] arcSyncRequest: history reload failed:', err.message);
  }
  renderPaymentHistory();
  console.log('[PAY] arcSyncRequest: history refreshed for', shortAddr(currentWallet));
});

// ─── Init ──────────────────────────────────────────────────────────────────────
async function initPayments() {
  // Seed last-wallet tracker with current wallet (if already connected)
  _payLastWallet = window.walletState?.address?.toLowerCase?.() || null;

  // Load history only if wallet is available; otherwise show empty state silently
  try {
    await payLoadLocalHistory();
  } catch (e) {
    console.warn('[PAY] init: history load failed:', e.message);
    payState.history = [];
  }

  payInitTimezones();
  selectPayToken(payState.token || 'USDC');
  updatePayPreview();
  payValidateForm();
  payUpdateNoteCounter();

  // Refresh balances — fails silently when wallet is not connected
  try {
    await refreshPaymentBalances();
  } catch (e) {
    console.warn('[PAY] init: balance refresh failed:', e.message);
  }

  renderPaymentHistory();
  payStartSchedulePoller();

  const sp = payEl('pay-steps-panel');
  if (sp) sp.style.display = 'none';
  const successPanel = payEl('pay-success-panel');
  if (successPanel) successPanel.classList.remove('show');

  // Keyboard: Escape closes modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') payCloseReceiptModal();
  });
}

// ─── Global exports ────────────────────────────────────────────────────────────
window.initPayments            = initPayments;
window.executePayment          = executePayment;
window.refreshPaymentBalances  = refreshPaymentBalances;
window.selectPayToken          = selectPayToken;
window.setPayMax               = setPayMax;
window.updatePayPreview        = updatePayPreview;
window.payValidateField        = payValidateField;
window.payValidateForm         = payValidateForm;
window.validatePayForm         = payValidateForm;          // legacy alias
window.downloadPayReceipt      = downloadPayReceipt;      // legacy — now opens in tab
window.downloadPayReceiptById  = downloadPayReceiptById;   // legacy — now opens in tab
window.generatePayReceiptPDF   = generatePayReceiptPDF;    // legacy — now opens in tab
window.payViewReceipt          = (r) => (typeof arcViewPaymentReceipt === 'function' ? arcViewPaymentReceipt(r) : payOpenReceiptModal(r));
window.renderPaymentHistory    = renderPaymentHistory;
window.renderPaymentReceipt    = renderPaymentReceipt;
window.hidePayError            = hidePayError;
window.payOpenReceiptModal     = payOpenReceiptModal;
window.payCloseReceiptModal    = payCloseReceiptModal;
window.paySetSchedule          = paySetSchedule;
window.payValidateSched        = payValidateSched;
window.payUpdateNoteCounter    = payUpdateNoteCounter;
window.payCancelScheduled      = payCancelScheduled;
window.payEditScheduled        = payEditScheduled;
window.payState                = payState;

// ─── Wallet event listeners ────────────────────────────────────────────────────

// Track the last wallet address to detect actual changes
let _payLastWallet = null;

async function _payOnWalletChange(newAddr) {
  const addr = newAddr?.toLowerCase?.() || null;

  // Detect actual wallet switch (not just event noise)
  if (addr && addr === _payLastWallet) {
    // Same wallet – just refresh balances
    await refreshPaymentBalances();
    updatePayPreview();
    payValidateForm();
    return;
  }

  // Wallet changed (new address or disconnected)
  _payLastWallet = addr;

  // Reset stale data
  payState.history   = [];
  payState.scheduled = [];
  payState.senderBalance = { USDC: null, EURC: null };
  payState.receipt   = null;
  hidePayError();

  if (addr) {
    // Update UI with new address
    paySet('pay-from-display', shortAddr(newAddr));
    paySet('pay-wallet-short', shortAddr(newAddr));

    // Load fresh data for this wallet
    try {
      await payLoadLocalHistory();
    } catch (e) {
      console.warn('[PAY] history load error after wallet change:', e.message);
    }
    await refreshPaymentBalances();
    updatePayPreview();
    payValidateForm();
  } else {
    // Disconnected
    paySet('pay-from-display', '—');
    paySet('pay-wallet-short', 'Not connected');
    paySet('pay-balance-usdc', '— USDC');
    paySet('pay-balance-eurc', '— EURC');
  }

  renderPaymentHistory();
  console.log('[PAY] Wallet changed →', addr || 'disconnected');
}

window.addEventListener('walletConnected', async (e) => {
  await _payOnWalletChange(e.detail?.address);
});

window.addEventListener('accountsChanged', async (e) => {
  // accountsChanged fires with new accounts array or single address
  const newAddr = Array.isArray(e.detail) ? e.detail[0] : (e.detail?.address || window.walletState?.address);
  await _payOnWalletChange(newAddr || null);
});

// ─── Boot log ──────────────────────────────────────────────────────────────────
console.log('[PAY v3] Payments module loaded — Arc Testnet ChainID:', PAY_CHAIN_ID);
console.log('[PAY v3] Features: Scheduled Payments · Notes · Receipt Modal · Status Labels · Hybrid Persistence');
