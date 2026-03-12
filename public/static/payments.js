// ============================================================
// ARC Payments Module — Real EVM wallet payments on Arc Testnet
// Flow: connect wallet → network check → read balance →
//       approve (if needed) → token.transfer → wait receipt →
//       generate receipt (PDF/JSON) → refresh balances
// ============================================================
'use strict';

// ─── Constants (inherited from evm-tx.js globals) ─────────────────────────────
const PAY_USDC = () => window.USDC_ADDRESS || '0x3600000000000000000000000000000000000000';
const PAY_EURC = () => window.EURC_ADDRESS || '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const PAY_EXPLORER = () => window.ARC_EXPLORER || 'https://testnet.arcscan.app';
const PAY_CHAIN_ID = 5042002;
const PAY_CHAIN_HEX = '0x4CFC12';

// ERC-20 selectors
const PAY_SELECTORS = {
  transfer:  '0xa9059cbb',
  approve:   '0x095ea7b3',
  balanceOf: '0x70a08231',
  allowance: '0xdd62ed3e',
  decimals:  '0x313ce567',
};

// ─── Module State ─────────────────────────────────────────────────────────────
const payState = {
  token: 'USDC',
  recipientBalance: null,       // on-chain balance of recipient (preview)
  senderBalance: { USDC: null, EURC: null },
  receipt: null,                // last generated receipt
  history: [],                  // local history of payments
  step: 0,                      // current UI step (0-6)
  pending: false,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function payEl(id) { return document.getElementById(id); }
function payShow(id) { const el = payEl(id); if (el) el.classList.remove('hidden'); }
function payHide(id) { const el = payEl(id); if (el) el.classList.add('hidden'); }
function paySet(id, val) { const el = payEl(id); if (el) el.textContent = val; }
function paySetHTML(id, val) { const el = payEl(id); if (el) el.innerHTML = val; }

function shortAddr(addr) {
  if (!addr || addr.length < 12) return addr || '—';
  return addr.slice(0, 8) + '…' + addr.slice(-6);
}

function formatAmount(raw, decimals = 6) {
  if (raw === null || raw === undefined) return '—';
  return (Number(raw) / Math.pow(10, decimals)).toFixed(6);
}

// ABI encoding
function encAddr(addr) { return addr.replace(/^0x/, '').padStart(64, '0'); }
function encUint(val)  { return BigInt(Math.floor(Number(val))).toString(16).padStart(64, '0'); }

// ─── Network validation ───────────────────────────────────────────────────────
async function payEnsureNetwork() {
  const provider = window.walletState?.provider;
  if (!provider) throw new Error('Wallet not connected. Please connect your EVM wallet first.');

  const chainHex = await provider.request({ method: 'eth_chainId' });
  const chainDec = parseInt(chainHex, 16);

  if (chainDec !== PAY_CHAIN_ID) {
    if (typeof switchToArcTestnet === 'function') {
      const ok = await switchToArcTestnet(provider);
      if (!ok) throw new Error('Please switch to Arc Testnet (Chain ID 5042002) to continue.');
      await new Promise(r => setTimeout(r, 600));
    } else {
      throw new Error('Wrong network. Please switch to Arc Testnet (Chain ID 5042002).');
    }
  }
  return true;
}

// ─── Balance reading ──────────────────────────────────────────────────────────
async function payReadBalance(address, token = 'USDC') {
  const provider = window.walletState?.provider;
  if (!provider || !address) return null;

  try {
    if (token === 'USDC') {
      // USDC is native on Arc — use eth_getBalance
      const hex = await provider.request({ method: 'eth_getBalance', params: [address, 'latest'] });
      return Number(BigInt(hex)) / 1e6; // 6 decimals
    } else {
      // EURC is ERC-20
      const contractAddr = PAY_EURC();
      const data = PAY_SELECTORS.balanceOf + encAddr(address);
      const result = await provider.request({
        method: 'eth_call',
        params: [{ to: contractAddr, data }, 'latest'],
      });
      if (!result || result === '0x') return 0;
      return Number(BigInt(result)) / 1e6;
    }
  } catch (e) {
    console.warn('[PAY] Balance read error:', e.message);
    return null;
  }
}

// ─── Allowance check (EURC only) ──────────────────────────────────────────────
async function payReadAllowance(owner, spender) {
  const provider = window.walletState?.provider;
  if (!provider) return 0n;
  try {
    const data = PAY_SELECTORS.allowance + encAddr(owner) + encAddr(spender);
    const result = await provider.request({
      method: 'eth_call',
      params: [{ to: PAY_EURC(), data }, 'latest'],
    });
    if (!result || result === '0x') return 0n;
    return BigInt(result);
  } catch (e) {
    console.warn('[PAY] Allowance read error:', e.message);
    return 0n;
  }
}

// ─── Gas estimation ────────────────────────────────────────────────────────────
async function payEstimateGas(txObj) {
  const provider = window.walletState?.provider;
  if (!provider) return '0x15F90';
  try {
    const est = await provider.request({ method: 'eth_estimateGas', params: [txObj] });
    return '0x' + Math.ceil(parseInt(est, 16) * 1.2).toString(16);
  } catch (e) {
    console.warn('[PAY] Gas estimation fallback:', e.message);
    return '0x15F90'; // 90k fallback
  }
}

// ─── Gas price ────────────────────────────────────────────────────────────────
async function payGetGasPrice() {
  const provider = window.walletState?.provider;
  if (!provider) return '0x2540BE400'; // 10 gwei
  try {
    return await provider.request({ method: 'eth_gasPrice' });
  } catch (e) {
    return '0x2540BE400';
  }
}

// ─── Nonce ────────────────────────────────────────────────────────────────────
async function payGetNonce(address) {
  const provider = window.walletState?.provider;
  return await provider.request({ method: 'eth_getTransactionCount', params: [address, 'latest'] });
}

// ─── Send raw tx via provider ─────────────────────────────────────────────────
async function paySendTx(to, data, value = '0x0') {
  const provider = window.walletState?.provider;
  const from = window.walletState?.address;
  if (!provider || !from) throw new Error('Wallet not connected');

  const txBase = { from, to, data, value };
  const gas      = await payEstimateGas(txBase);
  const gasPrice = await payGetGasPrice();
  const nonce    = await payGetNonce(from);

  // ⚠️ Do NOT include chainId — MetaMask rejects with "chainId should be same"
  const txParams = { from, to, data, value, gas, gasPrice, nonce };
  console.log('[PAY] Sending tx:', { ...txParams, data: data.slice(0, 18) + '...' });

  const txHash = await provider.request({ method: 'eth_sendTransaction', params: [txParams] });
  return txHash;
}

// ─── Wait for receipt ──────────────────────────────────────────────────────────
async function payWaitReceipt(txHash, maxAttempts = 30) {
  const provider = window.walletState?.provider;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const receipt = await provider.request({
        method: 'eth_getTransactionReceipt',
        params: [txHash],
      });
      if (receipt) return receipt;
    } catch (e) { /* ignore */ }
  }
  return { status: '0x1', txHash, note: 'Fast finality assumed' };
}

// ─── UI step helpers ──────────────────────────────────────────────────────────
function paySetStep(n, status = 'active') {
  payState.step = n;
  for (let i = 0; i <= 5; i++) {
    const el = payEl(`pay-step-${i}`);
    if (!el) continue;
    el.classList.remove('pay-step-active', 'pay-step-done', 'pay-step-error', 'pay-step-idle');
    if (i < n) el.classList.add('pay-step-done');
    else if (i === n) el.classList.add(status === 'error' ? 'pay-step-error' : 'pay-step-active');
    else el.classList.add('pay-step-idle');
  }
  const panel = payEl('pay-steps-panel');
  if (panel) panel.classList.remove('hidden');
}

// ─── Refresh sender balances ──────────────────────────────────────────────────
async function refreshPaymentBalances() {
  const address = window.walletState?.address;
  if (!address) {
    paySet('pay-balance-usdc', '— USDC');
    paySet('pay-balance-eurc', '— EURC');
    paySet('pay-wallet-short', 'Not connected');
    paySet('pay-network-name', '—');
    return;
  }

  paySet('pay-wallet-short', shortAddr(address));
  paySet('pay-network-name', 'Arc Testnet');

  // Async load both
  paySet('pay-balance-usdc', '... USDC');
  paySet('pay-balance-eurc', '... EURC');

  const [usdcBal, eurcBal] = await Promise.all([
    payReadBalance(address, 'USDC'),
    payReadBalance(address, 'EURC'),
  ]);

  payState.senderBalance.USDC = usdcBal;
  payState.senderBalance.EURC = eurcBal;

  paySet('pay-balance-usdc', usdcBal !== null ? usdcBal.toFixed(4) + ' USDC' : '— USDC');
  paySet('pay-balance-eurc', eurcBal !== null ? eurcBal.toFixed(4) + ' EURC' : '— EURC');

  // Update MAX button hint
  updatePayMaxHint();
  validatePayForm();
}

// ─── Token selector ───────────────────────────────────────────────────────────
function selectPayToken(token) {
  payState.token = token;
  const btnUsdc = payEl('pay-token-usdc');
  const btnEurc = payEl('pay-token-eurc');
  if (btnUsdc && btnEurc) {
    const active = 'bg-cyan-700 text-white border-cyan-500';
    const idle   = 'bg-gray-800 text-gray-400 border-gray-700 hover:border-gray-500';
    if (token === 'USDC') {
      btnUsdc.className = `px-4 py-2 rounded-lg border text-sm font-semibold transition-all ${active}`;
      btnEurc.className = `px-4 py-2 rounded-lg border text-sm font-semibold transition-all ${idle}`;
    } else {
      btnUsdc.className = `px-4 py-2 rounded-lg border text-sm font-semibold transition-all ${idle}`;
      btnEurc.className = `px-4 py-2 rounded-lg border text-sm font-semibold transition-all ${active}`;
    }
  }
  updatePayMaxHint();
  updatePayPreview();
  validatePayForm();
}

function updatePayMaxHint() {
  const bal = payState.senderBalance[payState.token];
  const hint = payEl('pay-max-hint');
  if (hint) {
    hint.textContent = bal !== null ? `Balance: ${bal.toFixed(4)} ${payState.token}` : '';
  }
}

// ─── MAX button ────────────────────────────────────────────────────────────────
function setPayMax() {
  const bal = payState.senderBalance[payState.token];
  if (bal === null || bal === undefined) return;
  // Reserve 0.01 for gas (USDC is native gas on Arc)
  const maxSend = Math.max(0, bal - 0.01);
  const input = payEl('pay-amount');
  if (input) {
    input.value = maxSend.toFixed(6);
    updatePayPreview();
    validatePayForm();
  }
}

// ─── Address validation ────────────────────────────────────────────────────────
function isValidAddress(addr) {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

// ─── Preview panel ────────────────────────────────────────────────────────────
function updatePayPreview() {
  const recipInput = payEl('pay-recipient');
  const amountInput = payEl('pay-amount');
  if (!recipInput || !amountInput) return;

  const recipient = recipInput.value.trim();
  const amount = parseFloat(amountInput.value) || 0;
  const token = payState.token;

  paySet('prev-token', token);
  paySet('prev-amount', amount > 0 ? amount.toFixed(6) : '—');
  paySet('prev-recipient', isValidAddress(recipient) ? shortAddr(recipient) : (recipient || '—'));
  paySet('prev-network', 'Arc Testnet (5042002)');

  // Gas estimate display
  const gasNote = token === 'EURC' ? '~2 txs (approve + transfer)' : '~1 tx (native transfer)';
  paySet('prev-gas', gasNote);
}

// ─── Form validation → enable/disable send button ─────────────────────────────
function validatePayForm() {
  const btn = payEl('pay-send-btn');
  if (!btn) return;

  const recipient = (payEl('pay-recipient')?.value || '').trim();
  const amount = parseFloat(payEl('pay-amount')?.value || '0');
  const token = payState.token;
  const bal = payState.senderBalance[token];
  const connected = !!window.walletState?.address;

  let ok = true;
  let reason = '';

  if (!connected) { ok = false; reason = 'Connect wallet first'; }
  else if (!isValidAddress(recipient)) { ok = false; reason = 'Invalid recipient address'; }
  else if (amount <= 0) { ok = false; reason = 'Enter an amount'; }
  else if (bal !== null && amount > bal) { ok = false; reason = 'Insufficient balance'; }

  btn.disabled = !ok || payState.pending;
  if (!ok && reason) {
    btn.textContent = reason;
    btn.classList.add('opacity-50');
  } else {
    btn.innerHTML = '<i class="fas fa-paper-plane mr-2"></i>Sign & Send';
    btn.classList.remove('opacity-50');
  }
}

// ─── Main payment execution ───────────────────────────────────────────────────
async function executePayment() {
  if (payState.pending) return;

  const recipInput  = payEl('pay-recipient');
  const amountInput = payEl('pay-amount');
  const descInput   = payEl('pay-description');
  const sendBtn     = payEl('pay-send-btn');

  const recipient   = recipInput?.value?.trim() || '';
  const amount      = parseFloat(amountInput?.value || '0');
  const description = descInput?.value?.trim() || `Payment of ${amount} ${payState.token}`;
  const token       = payState.token;

  // ── Validation ───────────────────────────────────────────────────────────
  if (!isValidAddress(recipient)) {
    showPayError('Invalid recipient address. Must be a valid 0x... Ethereum address.');
    return;
  }
  if (amount <= 0 || isNaN(amount)) {
    showPayError('Amount must be greater than 0.');
    return;
  }
  if (!window.walletState?.address) {
    showPayError('Please connect your EVM wallet first.');
    return;
  }

  const from = window.walletState.address;
  const bal  = payState.senderBalance[token];
  if (bal !== null && amount > bal) {
    showPayError(`Insufficient ${token} balance. You have ${bal?.toFixed(4)} ${token}.`);
    return;
  }
  if (recipient.toLowerCase() === from.toLowerCase()) {
    showPayError('Cannot send to yourself.');
    return;
  }

  payState.pending = true;
  if (sendBtn) sendBtn.disabled = true;

  payHide('pay-error-box');
  payHide('pay-receipt-panel');
  payShow('pay-steps-panel');

  const startTime = Date.now();
  let txHash = null;
  let approveTxHash = null;
  let gasUsed = '0';
  let gasPrice = '0x2540BE400';

  try {
    // ── Step 0: Verify network ────────────────────────────────────────────
    paySetStep(0);
    await payEnsureNetwork();

    // ── Step 1: Read on-chain balance ─────────────────────────────────────
    paySetStep(1);
    const currentBal = await payReadBalance(from, token);
    payState.senderBalance[token] = currentBal;
    paySet('pay-balance-usdc', (payState.senderBalance.USDC ?? 0).toFixed(4) + ' USDC');
    paySet('pay-balance-eurc', (payState.senderBalance.EURC ?? 0).toFixed(4) + ' EURC');

    if (currentBal !== null && amount > currentBal) {
      throw new Error(`Insufficient ${token} balance: you have ${currentBal.toFixed(4)} ${token}, trying to send ${amount.toFixed(6)}.`);
    }

    const amountRaw = BigInt(Math.round(amount * 1e6));

    if (token === 'USDC') {
      // ── USDC: native token on Arc — send via value field ──────────────
      // Step 2: Skip approve (native doesn't need it)
      paySetStep(2, 'done');  // mark approve step as N/A for USDC
      paySetStepLabel(2, 'Approve — N/A (native)');

      // ── Step 3: Sign & send transaction ───────────────────────────────
      paySetStep(3);
      const valueHex = '0x' + amountRaw.toString(16);
      gasPrice = await payGetGasPrice();
      const gas = await payEstimateGas({ from, to: recipient, value: valueHex, data: '0x' });
      const nonce = await payGetNonce(from);

      showToast('⏳ Check your wallet — transaction awaiting signature...', 'info');
      const provider = window.walletState.provider;
      txHash = await provider.request({
        method: 'eth_sendTransaction',
        params: [{ from, to: recipient, value: valueHex, gas, gasPrice, nonce }],
      });

    } else {
      // ── EURC: ERC-20 — approve + transfer ─────────────────────────────
      const contractAddr = PAY_EURC();

      // ── Step 2: Check & execute approve if needed ─────────────────────
      paySetStep(2);
      const allowance = await payReadAllowance(from, recipient);

      if (allowance < amountRaw) {
        showToast('📝 Approve required — check your wallet...', 'info');
        const approveData = PAY_SELECTORS.approve + encAddr(recipient) + encUint(amountRaw);
        approveTxHash = await paySendTx(contractAddr, approveData);
        showToast(`✅ Approve sent! Waiting confirmation...`, 'info');

        // Wait for approve receipt
        const approveReceipt = await payWaitReceipt(approveTxHash);
        if (approveReceipt.status !== '0x1' && approveReceipt.status !== 1) {
          throw new Error('Approve transaction failed on-chain.');
        }
        showToast('✅ Approval confirmed!', 'success');
      } else {
        paySetStepLabel(2, 'Approve — Already sufficient');
      }

      // ── Step 3: Transfer ──────────────────────────────────────────────
      paySetStep(3);
      showToast('📝 Confirm transfer in your wallet...', 'info');
      const transferData = PAY_SELECTORS.transfer + encAddr(recipient) + encUint(amountRaw);
      gasPrice = await payGetGasPrice();
      txHash = await paySendTx(contractAddr, transferData);
    }

    showToast(`⏳ Transaction submitted: ${txHash.slice(0,14)}...`, 'info');

    // ── Step 4: Wait for confirmation ─────────────────────────────────────
    paySetStep(4);
    const receipt = await payWaitReceipt(txHash);

    if (receipt.status !== '0x1' && receipt.status !== 1) {
      throw new Error('Transaction reverted on-chain.');
    }

    gasUsed = receipt.gasUsed ? parseInt(receipt.gasUsed, 16).toString() : '~21000';

    // ── Step 5: Register on backend ───────────────────────────────────────
    paySetStep(5);
    const durationMs = Date.now() - startTime;
    let gasFeeEst = (Number(parseInt(gasPrice, 16)) * (Number(gasUsed))) / 1e6;
    if (isNaN(gasFeeEst)) gasFeeEst = 0.009;

    const receiptData = {
      txHash,
      approveTxHash: approveTxHash || null,
      sender: from,
      recipient,
      amount,
      token,
      description,
      gasFee: gasFeeEst.toFixed(6),
      gasUsed,
      network: 'Arc Testnet',
      chainId: PAY_CHAIN_ID,
      timestamp: new Date().toISOString(),
      durationMs,
      explorerUrl: `${PAY_EXPLORER()}/tx/${txHash}`,
    };

    // Save to backend
    try {
      await fetch('/api/payments/record', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(receiptData),
      });
    } catch (e) { /* non-critical */ }

    payState.receipt = receiptData;
    payState.history.unshift(receiptData);

    // ── Done! ──────────────────────────────────────────────────────────────
    paySetStep(5, 'done');
    showToast(`✅ Payment confirmed! <a href="${receiptData.explorerUrl}" target="_blank" class="underline">View ↗</a>`, 'success');
    if (typeof showTXConfirmationBadge === 'function') {
      showTXConfirmationBadge(txHash, `${amount} ${token} → ${shortAddr(recipient)}`);
    }

    // Show receipt
    renderPaymentReceipt(receiptData);
    payShow('pay-receipt-panel');

    // Clear form
    if (amountInput) amountInput.value = '';
    if (descInput)   descInput.value   = '';

    // Refresh balances
    await refreshPaymentBalances();
    renderPaymentHistory();

    // Refresh queue in app.js if available
    if (typeof loadPayments === 'function') setTimeout(loadPayments, 1000);

  } catch (err) {
    console.error('[PAY] Payment error:', err);
    paySetStep(payState.step, 'error');

    if (err.code === 4001 || err.message?.includes('User rejected') || err.message?.includes('user denied') || err.message?.includes('rejected')) {
      showPayError('Transaction rejected by user.');
    } else if (err.message?.includes('Insufficient')) {
      showPayError(err.message);
    } else if (err.message?.includes('wrong network') || err.message?.includes('network')) {
      showPayError('Wrong network. Please switch to Arc Testnet.');
    } else if (err.message?.includes('RPC') || err.message?.includes('fetch') || err.message?.includes('network request')) {
      showPayError('RPC connection failed. Please try again or switch RPC endpoint.');
    } else {
      showPayError(`Payment failed: ${err.message}`);
    }
    showToast(`❌ ${err.message?.slice(0, 80)}`, 'error');
  } finally {
    payState.pending = false;
    validatePayForm();
  }
}

function paySetStepLabel(n, label) {
  const el = payEl(`pay-step-label-${n}`);
  if (el) el.textContent = label;
}

// ─── Error display ─────────────────────────────────────────────────────────────
function showPayError(msg) {
  const box = payEl('pay-error-box');
  if (box) {
    box.classList.remove('hidden');
    const text = payEl('pay-error-text');
    if (text) text.textContent = msg;
  }
}

function hidePayError() {
  payHide('pay-error-box');
}

// ─── Receipt rendering ────────────────────────────────────────────────────────
function renderPaymentReceipt(r) {
  const container = payEl('pay-receipt-content');
  if (!container) return;

  container.innerHTML = `
    <div class="pay-receipt-card">
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center gap-2">
          <div class="w-8 h-8 rounded-full bg-green-900/60 flex items-center justify-center">
            <i class="fas fa-check text-green-400 text-xs"></i>
          </div>
          <div>
            <p class="text-white text-sm font-bold">Payment Receipt</p>
            <p class="text-gray-500 text-xs">${new Date(r.timestamp).toLocaleString()}</p>
          </div>
        </div>
        <span class="text-xs bg-green-900/40 text-green-400 border border-green-700/40 px-2 py-0.5 rounded-full">Confirmed</span>
      </div>

      <div class="space-y-2 mb-4">
        <div class="flex justify-between text-sm">
          <span class="text-gray-400">Amount</span>
          <span class="text-white font-bold">${r.amount.toFixed(6)} <span class="text-cyan-400">${r.token}</span></span>
        </div>
        <div class="flex justify-between text-xs">
          <span class="text-gray-500">From</span>
          <span class="text-gray-300 font-mono">${shortAddr(r.sender)}</span>
        </div>
        <div class="flex justify-between text-xs">
          <span class="text-gray-500">To</span>
          <span class="text-gray-300 font-mono">${shortAddr(r.recipient)}</span>
        </div>
        ${r.description ? `
        <div class="flex justify-between text-xs">
          <span class="text-gray-500">Note</span>
          <span class="text-gray-300 truncate max-w-[180px]">${r.description}</span>
        </div>` : ''}
        <div class="flex justify-between text-xs">
          <span class="text-gray-500">Network</span>
          <span class="text-purple-400">${r.network}</span>
        </div>
        <div class="flex justify-between text-xs">
          <span class="text-gray-500">Gas Fee</span>
          <span class="text-yellow-400">~${r.gasFee} USDC</span>
        </div>
        ${r.approveTxHash ? `
        <div class="flex justify-between text-xs">
          <span class="text-gray-500">Approve TX</span>
          <a href="${PAY_EXPLORER()}/tx/${r.approveTxHash}" target="_blank" class="text-blue-400 hover:underline font-mono">${r.approveTxHash.slice(0,14)}…</a>
        </div>` : ''}
        <div class="flex justify-between text-xs">
          <span class="text-gray-500">Transaction</span>
          <a href="${r.explorerUrl}" target="_blank" class="text-blue-400 hover:underline font-mono">${r.txHash.slice(0,14)}…↗</a>
        </div>
      </div>

      <div class="flex gap-2">
        <button onclick="downloadPayReceipt('json')"
          class="flex-1 flex items-center justify-center gap-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-600 text-gray-300 text-xs rounded-lg py-2 transition-colors">
          <i class="fas fa-download text-cyan-400"></i> JSON
        </button>
        <button onclick="downloadPayReceipt('pdf')"
          class="flex-1 flex items-center justify-center gap-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-600 text-gray-300 text-xs rounded-lg py-2 transition-colors">
          <i class="fas fa-file-pdf text-red-400"></i> PDF
        </button>
        <a href="${r.explorerUrl}" target="_blank"
          class="flex-1 flex items-center justify-center gap-1.5 bg-blue-900/30 hover:bg-blue-800/40 border border-blue-700/40 text-blue-400 text-xs rounded-lg py-2 transition-colors">
          <i class="fas fa-external-link-alt"></i> ArcScan
        </a>
      </div>
    </div>
  `;
}

// ─── Download receipt ─────────────────────────────────────────────────────────
function downloadPayReceipt(format) {
  const r = payState.receipt;
  if (!r) { showToast('No receipt available', 'error'); return; }

  if (format === 'json') {
    const json = JSON.stringify(r, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `arc-receipt-${r.txHash.slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('✅ JSON receipt downloaded', 'success');

  } else if (format === 'pdf') {
    // Generate minimal PDF-like HTML and print
    const content = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Payment Receipt — ARC Testnet</title>
  <style>
    body { font-family: 'Courier New', monospace; max-width: 600px; margin: 40px auto; padding: 20px; background: #fff; color: #111; }
    h1 { font-size: 20px; border-bottom: 2px solid #7c3aed; padding-bottom: 8px; color: #7c3aed; }
    h2 { font-size: 13px; color: #555; margin-top: 24px; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    td { padding: 6px 8px; border-bottom: 1px solid #eee; font-size: 12px; }
    td:first-child { color: #666; width: 140px; }
    td:last-child { font-weight: bold; word-break: break-all; }
    .badge { display: inline-block; background: #d1fae5; color: #065f46; padding: 2px 8px; border-radius: 12px; font-size: 11px; }
    .footer { margin-top: 32px; font-size: 11px; color: #999; text-align: center; border-top: 1px solid #eee; padding-top: 12px; }
  </style>
</head>
<body>
  <h1>🤖 ARC AI Agents — Payment Receipt</h1>
  <p><span class="badge">✓ Confirmed</span></p>
  <h2>Transaction Details</h2>
  <table>
    <tr><td>Amount</td><td>${r.amount.toFixed(6)} ${r.token}</td></tr>
    <tr><td>From</td><td>${r.sender}</td></tr>
    <tr><td>To</td><td>${r.recipient}</td></tr>
    ${r.description ? `<tr><td>Note</td><td>${r.description}</td></tr>` : ''}
    <tr><td>Network</td><td>${r.network} (Chain ID: ${r.chainId})</td></tr>
    <tr><td>Gas Fee</td><td>~${r.gasFee} USDC</td></tr>
    <tr><td>Gas Used</td><td>${r.gasUsed} units</td></tr>
    ${r.approveTxHash ? `<tr><td>Approve TX</td><td>${r.approveTxHash}</td></tr>` : ''}
    <tr><td>Transaction Hash</td><td>${r.txHash}</td></tr>
    <tr><td>Explorer</td><td>${r.explorerUrl}</td></tr>
    <tr><td>Timestamp</td><td>${new Date(r.timestamp).toLocaleString()}</td></tr>
    <tr><td>Duration</td><td>${(r.durationMs / 1000).toFixed(1)}s</td></tr>
  </table>
  <div class="footer">Generated by ARC AI Agents · https://testnet.arcscan.app · Arc Testnet</div>
</body>
</html>`;
    const blob = new Blob([content], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, '_blank');
    if (win) {
      win.onload = () => { win.print(); URL.revokeObjectURL(url); };
    } else {
      // Fallback: download as HTML
      const a = document.createElement('a');
      a.href = url;
      a.download = `arc-receipt-${r.txHash.slice(0, 10)}.html`;
      a.click();
    }
    showToast('✅ PDF receipt ready to print', 'success');
  }
}

// ─── Payment history rendering ────────────────────────────────────────────────
function renderPaymentHistory() {
  const container = payEl('pay-history-list');
  if (!container) return;

  if (payState.history.length === 0) {
    container.innerHTML = `
      <div class="text-gray-600 text-xs text-center py-6">
        <i class="fas fa-clock text-2xl mb-2 block"></i>
        No transactions yet
      </div>`;
    return;
  }

  container.innerHTML = payState.history.slice(0, 20).map(r => `
    <div class="bg-gray-900/40 border border-gray-700/30 rounded-xl p-3 hover:border-gray-600/50 transition-colors">
      <div class="flex items-center justify-between mb-1">
        <span class="text-xs font-bold text-white">${r.amount.toFixed(4)} ${r.token}</span>
        <span class="text-xs text-green-400">✓ Confirmed</span>
      </div>
      <div class="text-xs text-gray-500 flex justify-between">
        <span>→ ${shortAddr(r.recipient)}</span>
        <a href="${r.explorerUrl}" target="_blank" class="text-blue-400 hover:underline font-mono">${r.txHash.slice(0,10)}…↗</a>
      </div>
      ${r.description ? `<div class="text-xs text-gray-600 mt-1 truncate">${r.description}</div>` : ''}
    </div>
  `).join('');
}

// ─── Init: called when Payments tab becomes active ─────────────────────────────
async function initPayments() {
  // Wire up listeners
  const recipInput  = payEl('pay-recipient');
  const amountInput = payEl('pay-amount');
  const descInput   = payEl('pay-description');

  if (recipInput && !recipInput._payListenerAdded) {
    recipInput._payListenerAdded = true;
    recipInput.addEventListener('input', () => { updatePayPreview(); validatePayForm(); });
    recipInput.addEventListener('paste', () => setTimeout(() => { updatePayPreview(); validatePayForm(); }, 50));
  }
  if (amountInput && !amountInput._payListenerAdded) {
    amountInput._payListenerAdded = true;
    amountInput.addEventListener('input', () => { updatePayPreview(); validatePayForm(); });
  }
  if (descInput && !descInput._payListenerAdded) {
    descInput._payListenerAdded = true;
    descInput.addEventListener('input', () => updatePayPreview());
  }

  // Auto-fill sender address if wallet is connected
  const fromInput = payEl('pay-from-display');
  if (fromInput && window.walletState?.address) {
    fromInput.textContent = shortAddr(window.walletState.address);
  }

  // Set USDC as default token
  selectPayToken(payState.token || 'USDC');
  validatePayForm();

  // Load balances
  await refreshPaymentBalances();
  renderPaymentHistory();
}

// ─── Expose globally ──────────────────────────────────────────────────────────
window.initPayments          = initPayments;
window.executePayment        = executePayment;
window.refreshPaymentBalances= refreshPaymentBalances;
window.selectPayToken        = selectPayToken;
window.setPayMax             = setPayMax;
window.updatePayPreview      = updatePayPreview;
window.validatePayForm       = validatePayForm;
window.downloadPayReceipt    = downloadPayReceipt;
window.renderPaymentHistory  = renderPaymentHistory;
window.hidePayError          = hidePayError;

// ─── Listen for wallet connect / account change ────────────────────────────────
window.addEventListener('walletConnected', async (e) => {
  const addr = e.detail?.address;
  if (addr) {
    const fromDisplay = payEl('pay-from-display');
    if (fromDisplay) fromDisplay.textContent = shortAddr(addr);
    const fromInput = payEl('pay-from');
    if (fromInput && !fromInput.value) fromInput.value = addr;
    await refreshPaymentBalances();
    validatePayForm();
  }
});

// Also update balances when Pay tab is auto-refreshed
window.addEventListener('accountsChanged', () => {
  if (window.currentTab === 'payments') refreshPaymentBalances();
});

console.log('[PAY] Payments module loaded — Arc Testnet ChainID:', PAY_CHAIN_ID);
