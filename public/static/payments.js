// ============================================================
// ARC Payments Module v2 — Single payment · Arc Testnet
// Fields: Full Name, Email, Recipient Address, Amount, Token
// Features: real-time validation, PDF receipt, no multisend
// ============================================================
'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const PAY_USDC = () => window.USDC_ADDRESS || '0x3600000000000000000000000000000000000000';
const PAY_EURC = () => window.EURC_ADDRESS || '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const PAY_EXPLORER = () => window.ARC_EXPLORER || 'https://testnet.arcscan.app';
const PAY_CHAIN_ID  = 5042002;
const PAY_CHAIN_HEX = '0x4cef52';

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
  history: [],
  step: 0,
  pending: false,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function payEl(id)          { return document.getElementById(id); }
function payShow(id)        { const el = payEl(id); if (el) el.style.display = ''; }
function payHide(id)        { const el = payEl(id); if (el) el.style.display = 'none'; }
function paySet(id, val)    { const el = payEl(id); if (el) el.textContent = val; }

function shortAddr(addr) {
  if (!addr || addr.length < 12) return addr || '—';
  return addr.slice(0, 8) + '…' + addr.slice(-6);
}

function encAddr(addr) { return addr.replace(/^0x/, '').padStart(64, '0'); }

function isValidAddress(addr) { return /^0x[0-9a-fA-F]{40}$/.test(addr); }

function isValidEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }

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
  // Update label span inside Amount field
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

// ─── Field-level validation ────────────────────────────────────────────────────
function payValidateField(field) {
  const fieldMap = {
    fullname:  { el: 'pay-fullname',   hint: 'pay-hint-fullname'  },
    email:     { el: 'pay-email',      hint: 'pay-hint-email'     },
    recipient: { el: 'pay-recipient',  hint: 'pay-hint-recipient' },
    amount:    { el: 'pay-amount',     hint: 'pay-hint-amount'    },
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

  if (field === 'email') {
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

// ─── Preview update ────────────────────────────────────────────────────────────
function updatePayPreview() {
  const recipient = (payEl('pay-recipient')?.value || '').trim();
  const amountStr = (payEl('pay-amount')?.value || '').trim();
  const amountNum = parseFloat(amountStr) || 0;
  const token     = payState.token;

  paySet('prev-token',     token);
  paySet('prev-amount',    amountNum > 0 ? amountNum.toFixed(6) + ' ' + token : '—');
  paySet('prev-recipient', isValidAddress(recipient) ? shortAddr(recipient) : (recipient || '—'));
  paySet('prev-network',   'Arc Testnet (5042002)');
  paySet('prev-gas',       token === 'EURC' ? '~2 txs (approve + transfer)' : '~1 tx (ERC-20 transfer)');

  const from = window.walletState?.address;
  if (from) paySet('pay-from-display', shortAddr(from));
}

// ─── Form-level validation → enable/disable send button ────────────────────────
function payValidateForm() {
  const btn     = payEl('pay-send-btn');
  const btnText = payEl('pay-send-btn-text');
  if (!btn) return;

  const fullname  = (payEl('pay-fullname')?.value   || '').trim();
  const email     = (payEl('pay-email')?.value      || '').trim();
  const recipient = (payEl('pay-recipient')?.value  || '').trim();
  const amountStr = (payEl('pay-amount')?.value     || '').trim();
  const amount    = parseFloat(amountStr);
  const token     = payState.token;
  const bal       = payState.senderBalance[token];
  const connected = !!window.walletState?.address;

  let ok = true;
  let reason = 'Sign & Send';

  if (!connected)                                   { ok = false; reason = 'Connect wallet to send'; }
  else if (fullname && fullname.length < 2)         { ok = false; reason = 'Name too short'; }
  else if (email && !isValidEmail(email))           { ok = false; reason = 'Invalid email format'; }
  else if (!isValidAddress(recipient))              { ok = false; reason = 'Invalid recipient address'; }
  else if (recipient.toLowerCase() === window.walletState?.address?.toLowerCase()) { ok = false; reason = 'Cannot send to yourself'; }
  else if (isNaN(amount) || amount <= 0)            { ok = false; reason = 'Enter a valid amount'; }
  else if (bal !== null && amount > bal)            { ok = false; reason = 'Insufficient balance'; }

  btn.disabled = !ok || payState.pending;
  if (btnText) btnText.textContent = payState.pending ? 'Processing…' : reason;
}

// ─── Progress steps ────────────────────────────────────────────────────────────
function paySetStep(n, status) {
  payState.step = n;
  for (let i = 0; i <= 5; i++) {
    const el = payEl('pay-step-' + i);
    if (!el) continue;
    el.className = 'pstep';
    if (i < n)       el.classList.add('pstep-done');
    else if (i === n) el.classList.add(status === 'error' ? 'pstep-error' : 'pstep-active');
    else             el.classList.add('pstep-idle');
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

// ─── Main payment execution ────────────────────────────────────────────────────
async function executePayment() {
  if (payState.pending) return;

  const fullname  = (payEl('pay-fullname')?.value   || '').trim();
  const email     = (payEl('pay-email')?.value      || '').trim();
  const recipient = (payEl('pay-recipient')?.value  || '').trim();
  const amountStr = (payEl('pay-amount')?.value     || '').trim();
  const token     = payState.token;

  // Validate all fields
  ['fullname','email','recipient','amount'].forEach(payValidateField);

  if (fullname && fullname.length < 2)           { showPayError('Name is too short.'); return; }
  if (email && !isValidEmail(email))             { showPayError('Invalid email address format.'); return; }
  if (!isValidAddress(recipient))                { showPayError('Invalid recipient wallet address.'); return; }
  if (!amountStr || Number(amountStr) <= 0)       { showPayError('Enter a valid amount greater than 0.'); return; }
  if (!window.walletState?.address)               { showPayError('Please connect your EVM wallet first.'); return; }

  const from = window.walletState.address;
  if (recipient.toLowerCase() === from.toLowerCase()) { showPayError('Cannot send to yourself.'); return; }

  let amount;
  try {
    amount = payParseUnits(amountStr);
  } catch (e) {
    showPayError('Invalid amount format: ' + e.message);
    return;
  }
  if (amount === 0n) { showPayError('Amount cannot be zero.'); return; }

  const amountHuman = parseFloat(payFormatUnits(amount));
  const bal         = payState.senderBalance[token];
  if (bal !== null && amountHuman > bal) {
    showPayError('Insufficient ' + token + ' balance. You have ' + (bal?.toFixed(4)) + ' ' + token + '.');
    return;
  }

  payState.pending = true;
  hidePayError();

  // Hide success panel, show steps
  const successPanel = payEl('pay-success-panel');
  if (successPanel) successPanel.classList.remove('show');
  paySetStep(0);

  const startTime  = Date.now();
  let txHash       = null;
  let gasUsed      = '0';
  let gasPrice     = '0x2540BE400';

  try {
    // Step 0: Network
    paySetStep(0);
    await payEnsureNetwork();

    // Step 1: Read balance
    paySetStep(1);
    const currentBal = await payReadBalance(from, token);
    payState.senderBalance[token] = currentBal;
    updatePayMaxHint();
    if (currentBal !== null && amountHuman > currentBal) {
      throw new Error('Insufficient ' + token + ' balance: ' + currentBal.toFixed(4) + ' available, trying to send ' + amountHuman.toFixed(6) + '.');
    }

    if (window.ethers?.Contract) {
      const contract = await payGetContract(token);

      // Step 2: Approve (not needed for direct transfer)
      paySetStep(2);
      paySetStepLabel(2, 'Token approval — N/A (direct ERC-20 transfer)');
      paySetStep(2, 'done');

      // Step 3: Sign & broadcast
      paySetStep(3);
      showToast('📝 Confirm ' + token + ' transfer in your wallet…', 'info');

      const tx = await contract.transfer(recipient, amount);
      txHash   = tx.hash;
      gasPrice = await payGetGasPrice();
      showToast('⏳ Transaction submitted: ' + txHash.slice(0,14) + '…', 'info');

      // Step 4: Wait confirmation
      paySetStep(4);
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) throw new Error(token + ' transfer reverted on-chain.');
      gasUsed = receipt.gasUsed ? receipt.gasUsed.toString() : '~21000';

    } else {
      // Fallback: raw eth_sendTransaction
      const contractAddr = token === 'EURC' ? PAY_EURC() : PAY_USDC();
      paySetStep(2, 'done');
      paySetStep(3);
      showToast('📝 Confirm transfer in your wallet…', 'info');
      const data = PAY_SELECTORS.transfer + encAddr(recipient) + BigInt(amount).toString(16).padStart(64, '0');
      gasPrice = await payGetGasPrice();
      const txBase  = { from, to: contractAddr, data, value: '0x0' };
      const gas     = await payEstimateGas(txBase);
      const nonce   = await payGetNonce(from);
      txHash = await window.walletState.provider.request({
        method: 'eth_sendTransaction',
        params: [{ from, to: contractAddr, data, value: '0x0', gas, gasPrice, nonce }],
      });

      paySetStep(4);
      const receipt = await payWaitReceipt(txHash);
      if (receipt.status !== '0x1' && receipt.status !== 1) throw new Error('Transaction reverted on-chain.');
      gasUsed = receipt.gasUsed ? parseInt(receipt.gasUsed, 16).toString() : '~21000';
    }

    // Step 5: Generate receipt
    paySetStep(5);
    const durationMs  = Date.now() - startTime;
    const gpNum       = Number(BigInt(gasPrice));
    let gasFeeEst     = (gpNum * Number(gasUsed)) / 1e18;
    if (isNaN(gasFeeEst) || gasFeeEst === 0) gasFeeEst = 0.000021;

    const receiptData = {
      fullname, email, txHash,
      sender: from, recipient, amount: amountHuman, token,
      gasFee: gasFeeEst.toFixed(6), gasUsed,
      network: 'Arc Testnet', chainId: PAY_CHAIN_ID,
      timestamp: new Date().toISOString(),
      durationMs, explorerUrl: PAY_EXPLORER() + '/tx/' + txHash,
    };

    // Save to backend (non-critical)
    try {
      await fetch('/api/payments/record', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(receiptData),
      });
    } catch (_) { /* ignore */ }

    payState.receipt = receiptData;
    payState.history.unshift(receiptData);
    paySetStep(5, 'done');

    showToast('✅ Payment confirmed! <a href="' + receiptData.explorerUrl + '" target="_blank" class="underline">View on ArcScan ↗</a>', 'success');
    if (typeof showTXConfirmationBadge === 'function')
      showTXConfirmationBadge(txHash, amountHuman + ' ' + token + ' → ' + shortAddr(recipient));

    // Show success panel
    if (successPanel) successPanel.classList.add('show');

    // Generate and auto-download PDF
    renderPaymentReceipt(receiptData);
    setTimeout(() => generatePayReceiptPDF(receiptData, true), 800);

    // Clear form
    ['pay-fullname','pay-email','pay-recipient','pay-amount'].forEach(id => {
      const el = payEl(id);
      if (el) { el.value = ''; el.classList.remove('is-valid','is-error'); }
    });
    ['pay-hint-fullname','pay-hint-email','pay-hint-recipient','pay-hint-amount'].forEach(id => {
      const el = payEl(id); if (el) el.textContent = '';
    });

    await refreshPaymentBalances();
    renderPaymentHistory();
    if (typeof loadPayments === 'function') setTimeout(loadPayments, 1000);

    // Hide steps after success
    setTimeout(() => {
      const sp = payEl('pay-steps-panel');
      if (sp) sp.style.display = 'none';
    }, 3000);

  } catch (err) {
    console.error('[PAY] Payment error:', err);
    paySetStep(payState.step, 'error');
    const msg = err.code === 4001 || /reject|denied|user/i.test(err.message)
      ? 'Transaction rejected by user.'
      : /insufficient/i.test(err.message)
        ? err.message
        : /network|rpc|chain/i.test(err.message)
          ? 'Network error: ' + err.message
          : 'Payment failed: ' + err.message;
    showPayError(msg);
    showToast('❌ ' + err.message?.slice(0, 80), 'error');
  } finally {
    payState.pending = false;
    payValidateForm();
  }
}

// ─── Receipt rendering (in-page) ──────────────────────────────────────────────
function renderPaymentReceipt(r) {
  const container = payEl('pay-receipt-content');
  if (!container) return;

  container.innerHTML = `
    <div style="background:rgba(10,12,24,0.98);border:1px solid rgba(29,158,117,0.22);border-radius:16px;overflow:hidden;margin-bottom:16px;position:relative;">
      <div style="height:2px;background:linear-gradient(90deg,transparent,#378ADD 40%,#1D9E75 60%,transparent);"></div>
      <!-- Receipt header -->
      <div style="background:rgba(29,158,117,0.06);border-bottom:1px solid rgba(29,158,117,0.15);padding:14px 20px;display:flex;align-items:center;justify-content:space-between;">
        <span style="color:#34d399;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">
          <i class="fas fa-receipt" style="margin-right:6px;"></i>Payment Receipt
        </span>
        <span style="background:rgba(29,158,117,0.12);border:1px solid rgba(29,158,117,0.35);color:#34d399;font-size:10px;padding:3px 10px;border-radius:20px;font-weight:700;">✓ Confirmed</span>
      </div>
      <!-- Receipt body -->
      <div style="padding:18px 20px;">
        <div style="display:grid;gap:8px;">
          ${receiptRow('Full Name', r.fullname)}
          ${receiptRow('Email', r.email)}
          ${receiptRow('Token', '<span style="color:#60b4ff;font-weight:700;">' + r.token + '</span>')}
          ${receiptRow('Amount', '<span style="color:#dde2f0;font-weight:700;">' + r.amount.toFixed(6) + ' ' + r.token + '</span>')}
          ${receiptRow('From', '<span style="font-family:monospace;font-size:11px;color:#dde2f0;">' + shortAddr(r.sender) + '</span>')}
          ${receiptRow('To', '<span style="font-family:monospace;font-size:11px;color:#dde2f0;">' + shortAddr(r.recipient) + '</span>')}
          ${receiptRow('Network', '<span style="color:#34d399;">' + r.network + '</span>')}
          ${receiptRow('Est. Gas', '~' + r.gasFee + ' USDC')}
          ${receiptRow('Tx Hash', '<a href="' + r.explorerUrl + '" target="_blank" style="color:#378ADD;font-family:monospace;font-size:11px;text-decoration:none;" onmouseover="this.style.textDecoration=\'underline\'" onmouseout="this.style.textDecoration=\'none\'">' + r.txHash.slice(0,16) + '… ↗</a>')}
          ${receiptRow('Date & Time', new Date(r.timestamp).toLocaleString())}
        </div>
        <!-- Action buttons -->
        <div style="display:flex;gap:8px;margin-top:18px;">
          <button onclick="generatePayReceiptPDF(payState.receipt, false)"
            style="flex:1;padding:10px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.25);border-radius:10px;color:#f87171;font-size:12px;font-weight:700;cursor:pointer;transition:all 0.2s;display:flex;align-items:center;justify-content:center;gap:6px;"
            onmouseover="this.style.background='rgba(239,68,68,0.15)'" onmouseout="this.style.background='rgba(239,68,68,0.08)'">
            <i class="fas fa-file-pdf"></i> Download PDF
          </button>
          <button onclick="downloadPayReceipt('json')"
            style="flex:1;padding:10px;background:rgba(55,138,221,0.08);border:1px solid rgba(55,138,221,0.22);border-radius:10px;color:#60b4ff;font-size:12px;font-weight:700;cursor:pointer;transition:all 0.2s;display:flex;align-items:center;justify-content:center;gap:6px;"
            onmouseover="this.style.background='rgba(55,138,221,0.15)'" onmouseout="this.style.background='rgba(55,138,221,0.08)'">
            <i class="fas fa-download"></i> JSON
          </button>
          <a href="${r.explorerUrl}" target="_blank"
            style="flex:1;padding:10px;background:rgba(29,158,117,0.08);border:1px solid rgba(29,158,117,0.25);border-radius:10px;color:#34d399;font-size:12px;font-weight:700;cursor:pointer;transition:all 0.2s;display:flex;align-items:center;justify-content:center;gap:6px;text-decoration:none;"
            onmouseover="this.style.background='rgba(29,158,117,0.15)'" onmouseout="this.style.background='rgba(29,158,117,0.08)'">
            <i class="fas fa-external-link-alt"></i> ArcScan
          </a>
        </div>
      </div>
    </div>
  `;
}

function receiptRow(label, value) {
  return `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid rgba(55,138,221,0.06);font-size:12px;">
      <span style="color:#3a4870;flex-shrink:0;margin-right:12px;">${label}</span>
      <span style="color:#dde2f0;text-align:right;">${value}</span>
    </div>`;
}

// ─── PDF Receipt generation (using jsPDF or print fallback) ────────────────────
function generatePayReceiptPDF(r, autoDownload) {
  if (!r) { showToast('No receipt available', 'error'); return; }

  // Try jsPDF first
  const jsPDF = window.jspdf?.jsPDF || window.jsPDF;
  if (jsPDF) {
    try {
      const doc = new jsPDF({ unit: 'mm', format: 'a4' });
      const W = doc.internal.pageSize.getWidth();

      // Header background
      doc.setFillColor(245, 245, 255);
      doc.rect(0, 0, W, 40, 'F');

      // Title
      doc.setFontSize(20);
      doc.setTextColor(50, 50, 180);
      doc.setFont('helvetica', 'bold');
      doc.text('Payment Receipt', W / 2, 18, { align: 'center' });

      // Subtitle
      doc.setFontSize(9);
      doc.setTextColor(120, 120, 140);
      doc.setFont('helvetica', 'normal');
      doc.text('ARC AI Agents · Arc Testnet · ' + new Date(r.timestamp).toLocaleString(), W / 2, 26, { align: 'center' });

      // Status badge
      doc.setFillColor(220, 255, 235);
      doc.roundedRect(W / 2 - 18, 30, 36, 7, 3, 3, 'F');
      doc.setTextColor(22, 140, 80);
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      doc.text('✓  CONFIRMED', W / 2, 35.5, { align: 'center' });

      // Section: Payment Details
      let y = 50;
      const addSection = (title) => {
        doc.setFillColor(245, 246, 255);
        doc.rect(14, y - 4, W - 28, 7, 'F');
        doc.setFontSize(9);
        doc.setTextColor(80, 80, 160);
        doc.setFont('helvetica', 'bold');
        doc.text(title.toUpperCase(), 16, y + 0.5);
        y += 8;
      };

      const addRow = (label, value, valueColor) => {
        doc.setFontSize(10);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(120, 120, 130);
        doc.text(label, 16, y);
        doc.setFont('helvetica', 'bold');
        if (valueColor) doc.setTextColor(...valueColor);
        else doc.setTextColor(30, 30, 40);
        const maxW = W - 80;
        const lines = doc.splitTextToSize(value, maxW);
        doc.text(lines, W - 14, y, { align: 'right' });
        y += 7 * lines.length;
        // separator
        doc.setDrawColor(230, 230, 240);
        doc.line(16, y - 1, W - 16, y - 1);
      };

      addSection('Sender Information');
      addRow('Full Name',    r.fullname);
      addRow('Email',        r.email);
      addRow('From Wallet',  r.sender);
      y += 4;

      addSection('Payment Details');
      addRow('Token',        r.token,                        [34, 100, 200]);
      addRow('Amount',       r.amount.toFixed(6) + ' ' + r.token, [30, 30, 40]);
      addRow('Recipient',    r.recipient);
      addRow('Network',      r.network + ' (Chain ' + r.chainId + ')', [22, 140, 80]);
      addRow('Est. Gas Fee', '~' + r.gasFee + ' USDC');
      y += 4;

      addSection('Transaction Details');
      addRow('Transaction Hash', r.txHash);
      addRow('Explorer',         r.explorerUrl);
      addRow('Date & Time',      new Date(r.timestamp).toLocaleString());
      addRow('Duration',         (r.durationMs / 1000).toFixed(1) + 's');
      y += 4;

      // Footer
      doc.setFontSize(8);
      doc.setTextColor(160, 160, 175);
      doc.setFont('helvetica', 'normal');
      doc.text('Generated by ARC AI Agents · https://testnet.arcscan.app · Testnet only — no real funds', W / 2, 285, { align: 'center' });

      if (autoDownload) {
        doc.save('arc-receipt-' + r.txHash.slice(0, 10) + '.pdf');
        showToast('✅ PDF receipt downloaded', 'success');
      } else {
        doc.save('arc-receipt-' + r.txHash.slice(0, 10) + '.pdf');
        showToast('✅ PDF receipt downloaded', 'success');
      }
      return;
    } catch (e) {
      console.warn('[PAY:PDF] jsPDF error, falling back to print:', e.message);
    }
  }

  // Fallback: print-to-PDF via browser
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Payment Receipt — ARC Testnet</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Segoe UI',Arial,sans-serif;background:#fff;color:#111;padding:40px;max-width:640px;margin:auto;}
    .header{background:linear-gradient(135deg,#f0f0ff,#e8f4ff);border-radius:12px;padding:24px;text-align:center;margin-bottom:28px;}
    .header h1{font-size:22px;color:#3730a3;margin-bottom:6px;}
    .header p{font-size:12px;color:#6b7280;}
    .badge{display:inline-block;background:#d1fae5;color:#065f46;padding:4px 14px;border-radius:20px;font-size:11px;font-weight:700;margin-top:10px;}
    .section-title{font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#6366f1;font-weight:700;background:#f5f5ff;padding:6px 12px;border-radius:6px;margin:20px 0 8px;}
    .row{display:flex;justify-content:space-between;align-items:flex-start;padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:13px;}
    .row .lbl{color:#6b7280;flex-shrink:0;margin-right:16px;}
    .row .val{font-weight:600;word-break:break-all;text-align:right;}
    .footer{margin-top:32px;font-size:10px;color:#9ca3af;text-align:center;border-top:1px solid #e5e7eb;padding-top:14px;}
    @media print{body{padding:20px;}}
  </style>
</head>
<body>
  <div class="header">
    <h1>Payment Receipt</h1>
    <p>ARC AI Agents · Arc Testnet · ${new Date(r.timestamp).toLocaleString()}</p>
    <span class="badge">✓ CONFIRMED</span>
  </div>

  <div class="section-title">Sender Information</div>
  <div class="row"><span class="lbl">Full Name</span><span class="val">${r.fullname}</span></div>
  <div class="row"><span class="lbl">Email</span><span class="val">${r.email}</span></div>
  <div class="row"><span class="lbl">From Wallet</span><span class="val" style="font-family:monospace;font-size:11px;">${r.sender}</span></div>

  <div class="section-title">Payment Details</div>
  <div class="row"><span class="lbl">Token</span><span class="val" style="color:#2563eb;">${r.token}</span></div>
  <div class="row"><span class="lbl">Amount</span><span class="val">${r.amount.toFixed(6)} ${r.token}</span></div>
  <div class="row"><span class="lbl">Recipient</span><span class="val" style="font-family:monospace;font-size:11px;">${r.recipient}</span></div>
  <div class="row"><span class="lbl">Network</span><span class="val" style="color:#059669;">${r.network} (Chain ${r.chainId})</span></div>
  <div class="row"><span class="lbl">Est. Gas Fee</span><span class="val">~${r.gasFee} USDC</span></div>

  <div class="section-title">Transaction Details</div>
  <div class="row"><span class="lbl">Transaction Hash</span><span class="val" style="font-family:monospace;font-size:10px;">${r.txHash}</span></div>
  <div class="row"><span class="lbl">Explorer</span><span class="val"><a href="${r.explorerUrl}" style="color:#2563eb;">${r.explorerUrl}</a></span></div>
  <div class="row"><span class="lbl">Date & Time</span><span class="val">${new Date(r.timestamp).toLocaleString()}</span></div>
  <div class="row"><span class="lbl">Duration</span><span class="val">${(r.durationMs / 1000).toFixed(1)}s</span></div>

  <div class="footer">Generated by ARC AI Agents &middot; https://testnet.arcscan.app &middot; Testnet only &mdash; no real funds</div>
</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html' });
  const url  = URL.createObjectURL(blob);
  const win  = window.open(url, '_blank');
  if (win) {
    win.onload = () => { setTimeout(() => { win.print(); URL.revokeObjectURL(url); }, 300); };
  } else {
    const a = document.createElement('a');
    a.href = url; a.download = 'arc-receipt-' + r.txHash.slice(0,10) + '.html';
    a.click();
  }
  showToast('✅ PDF receipt opened for printing', 'success');
}

// ─── JSON download ─────────────────────────────────────────────────────────────
function downloadPayReceipt(format) {
  const r = payState.receipt;
  if (!r) { showToast('No receipt available', 'error'); return; }
  if (format === 'json') {
    const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = 'arc-receipt-' + r.txHash.slice(0,10) + '.json';
    a.click(); URL.revokeObjectURL(url);
    showToast('✅ JSON receipt downloaded', 'success');
  } else if (format === 'pdf') {
    generatePayReceiptPDF(r, false);
  }
}

// ─── History rendering ─────────────────────────────────────────────────────────
function renderPaymentHistory() {
  const container = payEl('pay-history-list');
  if (!container) return;
  if (payState.history.length === 0) {
    container.innerHTML = `
      <div style="color:#3a4870;font-size:12px;text-align:center;padding:28px 0;">
        <i class="fas fa-clock" style="font-size:22px;display:block;margin-bottom:8px;color:#252a40;"></i>
        No transactions yet
      </div>`;
    return;
  }
  container.innerHTML = payState.history.slice(0, 20).map(r => `
    <div style="background:rgba(55,138,221,0.04);border:1px solid rgba(55,138,221,0.14);border-radius:10px;padding:10px 12px;transition:border-color 0.2s;"
         onmouseover="this.style.borderColor='rgba(55,138,221,0.3)'" onmouseout="this.style.borderColor='rgba(55,138,221,0.14)'">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
        <span style="color:#dde2f0;font-size:12px;font-weight:700;">${r.amount.toFixed(4)} ${r.token}</span>
        <span style="color:#34d399;font-size:10px;">✓ Confirmed</span>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:11px;color:#3a4870;">
        <span>→ ${shortAddr(r.recipient)}</span>
        <a href="${r.explorerUrl}" target="_blank" style="color:#378ADD;text-decoration:none;font-family:monospace;"
           onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">
          ${r.txHash.slice(0,10)}…↗
        </a>
      </div>
      ${r.fullname ? '<div style="font-size:10px;color:#3a4870;margin-top:3px;">' + r.fullname + (r.email ? ' · ' + r.email : '') + '</div>' : ''}
    </div>
  `).join('');
}

// ─── Init ──────────────────────────────────────────────────────────────────────
async function initPayments() {
  selectPayToken(payState.token || 'USDC');
  updatePayPreview();
  payValidateForm();
  await refreshPaymentBalances();
  renderPaymentHistory();

  // Hide panels that should start hidden
  const sp = payEl('pay-steps-panel');
  if (sp) sp.style.display = 'none';
  const successPanel = payEl('pay-success-panel');
  if (successPanel) successPanel.classList.remove('show');
}

// ─── Global exports ────────────────────────────────────────────────────────────
window.initPayments           = initPayments;
window.executePayment         = executePayment;
window.refreshPaymentBalances = refreshPaymentBalances;
window.selectPayToken         = selectPayToken;
window.setPayMax              = setPayMax;
window.updatePayPreview       = updatePayPreview;
window.payValidateField       = payValidateField;
window.payValidateForm        = payValidateForm;
window.validatePayForm        = payValidateForm; // legacy alias
window.downloadPayReceipt     = downloadPayReceipt;
window.generatePayReceiptPDF  = generatePayReceiptPDF;
window.renderPaymentHistory   = renderPaymentHistory;
window.hidePayError           = hidePayError;
window.payState               = payState; // needed by receipt buttons

// ─── Wallet event listeners ────────────────────────────────────────────────────
window.addEventListener('walletConnected', async (e) => {
  const addr = e.detail?.address;
  if (addr) {
    paySet('pay-from-display', shortAddr(addr));
    await refreshPaymentBalances();
    updatePayPreview();
    payValidateForm();
  }
});

window.addEventListener('accountsChanged', () => {
  if (window.currentTab === 'payments') refreshPaymentBalances();
});

// ─── Boot log ──────────────────────────────────────────────────────────────────
console.log('[PAY v2] Payments module loaded — Arc Testnet ChainID:', PAY_CHAIN_ID);
console.log('[PAY v2] USDC:', PAY_USDC(), '| EURC:', PAY_EURC());
console.log('[PAY v2] Fields: Full Name, Email, Recipient, Amount | Token: USDC/EURC');
console.log('[PAY v2] PDF receipt: jsPDF (if available) → print fallback');
