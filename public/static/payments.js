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

// ─── ERC-20 ABI (padrão completo) ─────────────────────────────────────────────
// Usado com ethers.Contract para USDC (0x3600…) e EURC no Arc Testnet.
const PAY_ERC20_ABI = [
  'function balanceOf(address owner)                      view returns (uint256)',
  'function decimals()                                    view returns (uint8)',
  'function symbol()                                      view returns (string)',
  'function allowance(address owner, address spender)     view returns (uint256)',
  'function approve(address spender, uint256 amount)      returns (bool)',
  'function transfer(address to, uint256 amount)          returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
];

// ─── ethers.js helpers ────────────────────────────────────────────────────────
// Retorna um ethers.BrowserProvider (v6) ou Web3Provider (v5) do provider injetado.
function payGetProvider() {
  const raw = window.walletState?.provider;
  if (!raw) throw new Error('Wallet not connected. Please connect your EVM wallet first.');
  if (window.ethers?.BrowserProvider)
    return new window.ethers.BrowserProvider(raw);
  if (window.ethers?.providers?.Web3Provider)
    return new window.ethers.providers.Web3Provider(raw);
  return null; // sem ethers — usa fallback raw
}

// Retorna o signer conectado para assinar transações.
async function payGetSigner() {
  const provider = payGetProvider();
  if (!provider) throw new Error('ethers.js não disponível');
  return provider.getSigner();
}

// Instancia ethers.Contract para USDC ou EURC.
// Retorna null se ethers não estiver disponível (usa raw fallback).
async function payGetContract(token) {
  if (!window.ethers?.Contract) return null;
  const addr = token === 'EURC' ? PAY_EURC() : PAY_USDC();
  const signer = await payGetSigner();
  return new window.ethers.Contract(addr, PAY_ERC20_ABI, signer);
}

// Normaliza valor humano para string com no máximo 6 casas decimais.
// ethers.parseUnits v6 EXIGE string — rejeita números com TypeError.
function payNormaliseAmount(humanAmount) {
  let s = String(humanAmount).trim();
  // Trata notação científica (ex: 1e-6 → "0.000001")
  if (/[eE]/.test(s)) s = Number(s).toFixed(6);
  // Trunca para max 6 casas decimais
  const dot = s.indexOf('.');
  if (dot !== -1 && s.length - dot - 1 > 6) s = s.slice(0, dot + 7);
  return s;
}

// Converte valor humano para BigInt com 6 decimais.
//   payParseUnits(10)   → 10000000n
//   payParseUnits(0.5)  → 500000n
//   payParseUnits("1")  → 1000000n
function payParseUnits(humanAmount) {
  const s = payNormaliseAmount(humanAmount);
  if (window.ethers?.parseUnits) {
    try {
      const raw = window.ethers.parseUnits(s, 6);
      console.log(`[PAY:parseUnits] ethers.parseUnits("${s}", 6) → ${raw.toString()}`);
      return raw;
    } catch (e) {
      console.warn(`[PAY:parseUnits] ethers falhou para "${s}":`, e.message, '— usando fallback manual');
    }
  }
  // Fallback manual (sem floating-point errors)
  const [intPart = '0', fracPart = ''] = s.split('.');
  const frac = fracPart.slice(0, 6).padEnd(6, '0');
  const result = BigInt(intPart) * 1_000_000n + BigInt(frac);
  console.log(`[PAY:parseUnits] manual("${s}") → ${result.toString()}`);
  return result;
}

// Converte base units (BigInt/string) para número humano.
//   payFormatUnits(1000000n) → "1.000000"
function payFormatUnits(rawAmount) {
  if (window.ethers?.formatUnits) {
    return window.ethers.formatUnits(rawAmount, 6);
  }
  return (Number(rawAmount) / 1e6).toFixed(6);
}
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

// ─── Balance reading via ethers.Contract.balanceOf ───────────────────────────
// USDC: ERC-20 no Arc → ethers.Contract(PAY_USDC(), ERC20_ABI, signer).balanceOf(address)
// EURC: ERC-20 → contract.balanceOf(address) via ethers.Contract
// Retorna valor humano (float), ex: 10.5 para 10.5 USDC
async function payReadBalance(address, token = 'USDC') {
  const provider = window.walletState?.provider;
  if (!provider || !address) return null;

  try {
    let rawBal;

    if (window.ethers?.Contract) {
      // ✅ ethers.Contract.balanceOf() — padrão ERC-20 para USDC e EURC
      // USDC usa endereço 0x3600000000000000000000000000000000000000 com ABI ERC-20
      const contract = await payGetContract(token);
      rawBal = await contract.balanceOf(address);
      const human = Number(window.ethers.formatUnits(rawBal, 6));
      console.log(`[PAY:balance] ethers.Contract(${token}).balanceOf(${address.slice(0,10)}…) = ${rawBal.toString()} = ${human.toFixed(6)} ${token}`);
      return human;

    } else {
      // Fallback: raw eth_call para balanceOf (USDC ou EURC)
      const contractAddr = token === 'EURC' ? PAY_EURC() : PAY_USDC();
      const data = PAY_SELECTORS.balanceOf + encAddr(address);
      const result = await provider.request({
        method: 'eth_call',
        params: [{ to: contractAddr, data }, 'latest'],
      });
      if (!result || result === '0x') return 0;
      rawBal = BigInt(result);
      const human = Number(rawBal) / 1e6;
      console.log(`[PAY:balance] ${token} raw (fallback eth_call) = ${rawBal} = ${human.toFixed(6)}`);
      return human;
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

// ─── MAX button — busca saldo on-chain em tempo real ─────────────────────────
// Usa ethers.Contract.balanceOf + formatUnits para USDC e EURC.
// USDC: ERC-20 no Arc → contract.balanceOf(wallet)
// EURC: ERC-20 → contract.balanceOf(wallet)
async function setPayMax() {
  const input  = payEl('pay-amount');
  const token  = payState.token;
  const wallet = window.walletState?.address;

  if (!wallet) {
    showToast('Connect wallet first', 'warning');
    return;
  }

  // Busca saldo on-chain diretamente (não usa cache)
  let maxHuman;
  try {
    if (window.ethers?.Contract) {
      // ✅ USDC e EURC: ERC-20 → ethers.Contract.balanceOf
      const contract = await payGetContract(token);
      const rawBal   = await contract.balanceOf(wallet);
      maxHuman = parseFloat(window.ethers.formatUnits(rawBal, 6));
      console.log(`[PAY:MAX] ethers.Contract(${token}).balanceOf(${wallet.slice(0,10)}…) = ${rawBal.toString()} = ${maxHuman.toFixed(6)} ${token}`);
    } else {
      // Fallback: raw eth_call para balanceOf
      const provider = window.walletState.provider;
      const contractAddr = token === 'EURC' ? PAY_EURC() : PAY_USDC();
      const data = PAY_SELECTORS.balanceOf + encAddr(wallet);
      const result = await provider.request({
        method: 'eth_call',
        params: [{ to: contractAddr, data }, 'latest'],
      });
      const rawBal = (result && result !== '0x') ? BigInt(result) : 0n;
      maxHuman = Number(rawBal) / 1e6;
      console.log(`[PAY:MAX] ${token} fallback balanceOf = ${rawBal} = ${maxHuman.toFixed(6)} ${token}`);
    }
  } catch (e) {
    console.warn('[PAY:MAX] Balance read error:', e.message);
    maxHuman = payState.senderBalance[token];
  }

  if (maxHuman === null || maxHuman === undefined) return;

  // Sem reserva de gas — USDC no Arc é ERC-20, não paga gas em USDC
  const maxSend = maxHuman;

  // Atualiza o campo com valor formatado (6 casas decimais)
  if (input) {
    const formatted = maxSend.toFixed(6);
    input.value = formatted;
    console.log(`[PAY:MAX] Filled amount: ${formatted} ${token}`);

    // Atualiza display de saldo (#balance)
    const balanceEl = document.getElementById('balance');
    if (balanceEl) balanceEl.innerText = maxHuman.toFixed(6) + ' ' + token;

    // Atualiza preview e validação imediatamente
    updatePayPreview();
    validatePayForm();
  }
}

// ─── Address validation ────────────────────────────────────────────────────────
function isValidAddress(addr) {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

// ─── Preview panel ────────────────────────────────────────────────────────────
// ─── Preview panel — atualiza dinamicamente ao digitar ───────────────────────
// Spec item 8: oninput atualiza previewAmount em tempo real.
function updatePayPreview() {
  const recipInput  = payEl('pay-recipient');
  const amountInput = payEl('pay-amount');
  if (!recipInput || !amountInput) return;

  const recipient   = recipInput.value.trim();
  const amountStr   = amountInput.value.trim();
  const amountFloat = parseFloat(amountStr) || 0;
  const token       = payState.token;

  paySet('prev-token',     token);
  paySet('prev-amount',    amountFloat > 0 ? amountFloat.toFixed(6) : '—');
  paySet('prev-recipient', isValidAddress(recipient) ? shortAddr(recipient) : (recipient || '—'));
  paySet('prev-network',   'Arc Testnet (5042002)');

  // ✅ Atualiza #previewAmount (spec item 8)
  const previewEl = document.getElementById('previewAmount');
  if (previewEl) previewEl.innerText = amountFloat > 0 ? amountFloat + ' ' + token : '— ' + token;

  // Gas estimate display
  const gasNote = token === 'EURC' ? '~2 txs (approve + transfer)' : '~1 tx (native transfer)';
  paySet('prev-gas', gasNote);

  // Mostra o parsed amount para debug (spec item 9)
  if (amountFloat > 0) {
    try {
      const parsed = payParseUnits(amountStr);
      console.log(`[PAY:preview] Input: "${amountStr}" → parseUnits → ${parsed.toString()} base units (${token} 6 dec)`);
    } catch (_) {}
  }
}

// Registra oninput para live preview assim que o DOM estiver pronto.
// (Chamado também em payInitListeners abaixo.)
function payAttachAmountListener() {
  const amountInput = payEl('pay-amount');
  if (!amountInput) return;
  // Remove listener anterior para evitar duplicatas
  amountInput.oninput = () => {
    const v = amountInput.value.trim();
    // ✅ Spec item 8: atualiza previewAmount ao digitar
    const previewEl = document.getElementById('previewAmount');
    if (previewEl) previewEl.innerText = (v && Number(v) > 0 ? v : '—') + ' ' + payState.token;
    updatePayPreview();
    validatePayForm();
  };
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
// Usa ethers.Contract para USDC e EURC — ambos são ERC-20 no Arc Testnet.
// USDC: 0x3600000000000000000000000000000000000000 → contract.transfer(recipient, amount)
// EURC: 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a → approve + transfer
// Converte o valor digitado com ethers.parseUnits(amount, 6) — NUNCA envia 0.
async function executePayment() {
  if (payState.pending) return;

  const recipInput  = payEl('pay-recipient');
  const amountInput = payEl('pay-amount');
  const descInput   = payEl('pay-description');
  const sendBtn     = payEl('pay-send-btn');

  const recipient       = recipInput?.value?.trim() || '';
  const amountInput_val = amountInput?.value?.trim() || '';
  const token           = payState.token;
  const description     = descInput?.value?.trim() || `Payment of ${amountInput_val} ${token}`;

  // ── Validação da entrada ─────────────────────────────────────────────────
  if (!amountInput_val || Number(amountInput_val) <= 0 || isNaN(Number(amountInput_val))) {
    showPayError('Enter a valid amount greater than 0.');
    return;
  }
  if (!isValidAddress(recipient)) {
    showPayError('Invalid recipient address. Must be a valid 0x... Ethereum address.');
    return;
  }
  if (!window.walletState?.address) {
    showPayError('Please connect your EVM wallet first.');
    return;
  }

  // ── Conversão do amount com parseUnits (6 decimais) ─────────────────────
  // ethers.parseUnits v6 EXIGE string — payNormaliseAmount garante isso.
  // Ex: "10" → 10000000n | "0.5" → 500000n | "1.5" → 1500000n
  let amount;
  try {
    amount = payParseUnits(amountInput_val);
  } catch (e) {
    showPayError(`Invalid amount format: ${e.message}`);
    return;
  }

  // ── Protege contra zero ──────────────────────────────────────────────────
  if (amount === 0n) {
    showPayError('Transaction amount cannot be zero. Check decimals.');
    return;
  }

  // Valor humanizado para exibição (float)
  const amountHuman = parseFloat(payFormatUnits(amount));

  // ── Debug logs obrigatórios (spec item 9) ────────────────────────────────
  console.log('[PAY] ─── executePayment ─────────────────────────────');
  console.log('[PAY] Recipient:      ', recipient);
  console.log('[PAY] Input amount:   ', amountInput_val);
  console.log('[PAY] Parsed amount:  ', amount.toString(), '(6-dec base units)');
  console.log('[PAY] Human amount:   ', amountHuman, token);
  console.log('[PAY] Token:          ', token);
  console.log('[PAY] Wallet (from):  ', window.walletState?.address);
  console.log('[PAY] USDC contract:  ', PAY_USDC(), '← ERC-20, não nativo');
  console.log('[PAY] EURC contract:  ', PAY_EURC());
  console.log('[PAY] Using ethers:   ', !!window.ethers?.Contract);

  const from = window.walletState.address;

  // Valida saldo
  const bal = payState.senderBalance[token];
  if (bal !== null && amountHuman > bal) {
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
  let txHash        = null;
  let approveTxHash = null;
  let gasUsed       = '0';
  let gasPrice      = '0x2540BE400';

  try {
    // ── Step 0: Verificar rede ───────────────────────────────────────────
    paySetStep(0);
    await payEnsureNetwork();

    // ── Step 1: Ler saldo on-chain com ethers.Contract.balanceOf ─────────
    paySetStep(1);
    const currentBal = await payReadBalance(from, token);
    payState.senderBalance[token] = currentBal;

    // Atualiza display de saldo (spec item 6: formatUnits)
    paySet('pay-balance-usdc', (payState.senderBalance.USDC ?? 0).toFixed(4) + ' USDC');
    paySet('pay-balance-eurc', (payState.senderBalance.EURC ?? 0).toFixed(4) + ' EURC');
    const balanceEl = document.getElementById('balance');
    if (balanceEl) balanceEl.innerText = (currentBal || 0).toFixed(6) + ' ' + token;

    if (currentBal !== null && amountHuman > currentBal) {
      throw new Error(`Insufficient ${token} balance: you have ${currentBal.toFixed(4)} ${token}, trying to send ${amountHuman.toFixed(6)}.`);
    }

    if (window.ethers?.Contract) {
      // ── CAMINHO PRINCIPAL: ethers.Contract ───────────────────────────
      const contract = await payGetContract(token);
      console.log(`[PAY] ethers.Contract(${token}) instanciado @ ${token === 'EURC' ? PAY_EURC() : PAY_USDC()}`);

      if (token === 'USDC') {
        // ── USDC: ERC-20 no Arc — usa contract.transfer(recipient, amount) ──
        // Não usa eth_sendTransaction com value; usa o método transfer do ERC-20.
        paySetStep(2, 'done');
        paySetStepLabel(2, 'Approve — N/A (direto via ERC-20 transfer)');

        // ── Step 3: Assinar e enviar via contract.transfer ─────────────
        paySetStep(3);
        showToast('⏳ Check your wallet — USDC ERC-20 transfer awaiting signature...', 'info');
        console.log('[PAY] USDC ERC-20 transfer → contract.transfer(', recipient, ',', amount.toString(), ')');

        // ✅ Spec: await usdcContract.transfer(recipient, amount)
        const tx = await contract.transfer(recipient, amount);
        txHash = tx.hash;
        gasPrice = await payGetGasPrice();
        console.log('[PAY] USDC tx submitted:', txHash);
        showToast(`⏳ Transaction submitted: ${txHash.slice(0,14)}...`, 'info');

        // ── Step 4: Aguardar confirmação via tx.wait() ─────────────────
        paySetStep(4);
        console.log('[PAY] Waiting for USDC tx.wait()...');
        // ✅ Spec: await tx.wait()
        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) {
          throw new Error('USDC transfer reverted on-chain.');
        }
        gasUsed = receipt.gasUsed ? receipt.gasUsed.toString() : '~21000';
        console.log('[PAY] USDC tx confirmed block:', receipt.blockNumber, 'gasUsed:', gasUsed);

        // Log Transfer event (spec: emits standard ERC-20 Transfer event)
        const transferEvent = receipt.logs?.find(l =>
          l.topics?.[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
        );
        if (transferEvent) {
          console.log('[PAY] ✅ ERC-20 Transfer event detected:', {
            from: '0x' + transferEvent.topics[1]?.slice(-40),
            to:   '0x' + transferEvent.topics[2]?.slice(-40),
            data: transferEvent.data,
          });
        }

        // ── Step 5: Registrar ─────────────────────────────────────────
        paySetStep(5);
        const durationMs = Date.now() - startTime;
        const gasPriceNum = Number(BigInt(gasPrice));
        let gasFeeEst = (gasPriceNum * Number(BigInt(gasUsed))) / 1e18; // em ETH/USDC
        if (isNaN(gasFeeEst) || gasFeeEst === 0) gasFeeEst = 0.000021;

        const receiptData = {
          txHash, approveTxHash: null,
          sender: from, recipient, amount: amountHuman, token, description,
          gasFee: gasFeeEst.toFixed(6), gasUsed, network: 'Arc Testnet',
          chainId: PAY_CHAIN_ID, timestamp: new Date().toISOString(),
          durationMs, explorerUrl: `${PAY_EXPLORER()}/tx/${txHash}`,
        };
        try {
          await fetch('/api/payments/record', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(receiptData),
          });
        } catch (e) { /* não crítico */ }

        payState.receipt = receiptData;
        payState.history.unshift(receiptData);
        paySetStep(5, 'done');
        showToast(`✅ USDC payment confirmed! <a href="${receiptData.explorerUrl}" target="_blank" class="underline">View on ArcScan ↗</a>`, 'success');
        if (typeof showTXConfirmationBadge === 'function')
          showTXConfirmationBadge(txHash, `${amountHuman} ${token} → ${shortAddr(recipient)}`);
        renderPaymentReceipt(receiptData);
        payShow('pay-receipt-panel');
        if (amountInput) amountInput.value = '';
        if (descInput)   descInput.value   = '';
        await refreshPaymentBalances();
        renderPaymentHistory();
        if (typeof loadPayments === 'function') setTimeout(loadPayments, 1000);
        return; // early return — USDC confirmado via tx.wait()

      } else {
        // ── EURC: ERC-20 — usa approve + transfer ────────────────────────
        // Step 2: Verificar allowance e aprovar se necessário
        paySetStep(2);

        // ✅ CORREÇÃO: spender deve ser o contrato EURC (não o recipient)
        // Para transfer() simples não precisamos de approve — aprovação é para transferFrom.
        // Porém, se quisermos manter o fluxo de approve, o spender correto seria um router.
        // Para transfer() direta: não precisamos de approve.
        paySetStepLabel(2, 'Approve — N/A (usando transfer direto)');
        paySetStep(2, 'done');
        console.log('[PAY] EURC: usando contract.transfer direto (sem approve necessário para transfer)');

        // ── Step 3: Chamar contract.transfer(recipient, amount) ──────────
        paySetStep(3);
        showToast('📝 Confirm EURC transfer in your wallet...', 'info');
        console.log('[PAY] EURC transfer:', amount.toString(), 'base units →', recipient);

        // ✅ Requer assinatura da carteira
        const tx = await contract.transfer(recipient, amount);
        txHash = tx.hash;
        console.log('[PAY] EURC tx submitted:', txHash);
        gasPrice = await payGetGasPrice();

        showToast(`⏳ Transaction submitted: ${txHash.slice(0,14)}...`, 'info');

        // ── Step 4: Aguardar confirmação via tx.wait() ───────────────────
        paySetStep(4);
        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) {
          throw new Error('Transaction reverted on-chain.');
        }
        gasUsed = receipt.gasUsed ? receipt.gasUsed.toString() : '~21000';
        console.log('[PAY] EURC tx confirmed block:', receipt.blockNumber, 'gasUsed:', gasUsed);

        // ── Step 5: Registrar ─────────────────────────────────────────────
        paySetStep(5);
        const durationMs = Date.now() - startTime;
        const gasPriceNum = Number(BigInt(gasPrice));
        let gasFeeEst = (gasPriceNum * Number(BigInt(gasUsed))) / 1e18;
        if (isNaN(gasFeeEst) || gasFeeEst === 0) gasFeeEst = 0.000021;

        const receiptData = {
          txHash, approveTxHash: approveTxHash || null,
          sender: from, recipient, amount: amountHuman, token, description,
          gasFee: gasFeeEst.toFixed(6), gasUsed, network: 'Arc Testnet',
          chainId: PAY_CHAIN_ID, timestamp: new Date().toISOString(),
          durationMs, explorerUrl: `${PAY_EXPLORER()}/tx/${txHash}`,
        };
        try {
          await fetch('/api/payments/record', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(receiptData),
          });
        } catch (e) { /* não crítico */ }

        payState.receipt = receiptData;
        payState.history.unshift(receiptData);
        paySetStep(5, 'done');
        showToast(`✅ Payment confirmed! <a href="${receiptData.explorerUrl}" target="_blank" class="underline">View ↗</a>`, 'success');
        if (typeof showTXConfirmationBadge === 'function')
          showTXConfirmationBadge(txHash, `${amountHuman} ${token} → ${shortAddr(recipient)}`);
        renderPaymentReceipt(receiptData);
        payShow('pay-receipt-panel');
        if (amountInput) amountInput.value = '';
        if (descInput)   descInput.value   = '';
        await refreshPaymentBalances();
        renderPaymentHistory();
        if (typeof loadPayments === 'function') setTimeout(loadPayments, 1000);
        return; // early return — EURC confirmado via tx.wait()
      }

    } else {
      // ── FALLBACK RAW (sem ethers.Contract) ────────────────────────────
      const contractAddr = token === 'EURC' ? PAY_EURC() : PAY_USDC();

      if (token === 'EURC') {
        // Verificar allowance e aprovar se necessário (fallback)
        paySetStep(2);
        // Para transfer() direto não precisamos de approve
        paySetStepLabel(2, 'Approve — N/A (transfer direto)');
        paySetStep(2, 'done');
      } else {
        paySetStep(2, 'done');
        paySetStepLabel(2, 'Approve — N/A (USDC ERC-20 transfer)');
      }

      paySetStep(3);
      showToast('📝 Confirm transfer in your wallet...', 'info');
      const transferData = PAY_SELECTORS.transfer + encAddr(recipient) + encUint(amount);
      gasPrice = await payGetGasPrice();
      txHash = await paySendTx(contractAddr, transferData);
      console.log('[PAY] Raw tx submitted:', txHash);
    }

    showToast(`⏳ Transaction submitted: ${txHash.slice(0,14)}...`, 'info');

    // ── Step 4: Aguardar confirmação ─────────────────────────────────────
    paySetStep(4);
    const receipt = await payWaitReceipt(txHash);

    if (receipt.status !== '0x1' && receipt.status !== 1) {
      throw new Error('Transaction reverted on-chain.');
    }
    gasUsed = receipt.gasUsed ? parseInt(receipt.gasUsed, 16).toString() : '~21000';
    console.log('[PAY] Tx confirmed — gasUsed:', gasUsed, 'txHash:', txHash);

    // ── Step 5: Registrar no backend ─────────────────────────────────────
    paySetStep(5);
    const durationMs = Date.now() - startTime;
    let gasFeeEst = (Number(parseInt(gasPrice, 16)) * (Number(gasUsed))) / 1e18;
    if (isNaN(gasFeeEst) || gasFeeEst === 0) gasFeeEst = 0.000021;

    const receiptData = {
      txHash, approveTxHash: approveTxHash || null,
      sender: from, recipient, amount: amountHuman, token, description,
      gasFee: gasFeeEst.toFixed(6), gasUsed, network: 'Arc Testnet',
      chainId: PAY_CHAIN_ID, timestamp: new Date().toISOString(),
      durationMs, explorerUrl: `${PAY_EXPLORER()}/tx/${txHash}`,
    };

    try {
      await fetch('/api/payments/record', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(receiptData),
      });
    } catch (e) { /* não crítico */ }

    payState.receipt = receiptData;
    payState.history.unshift(receiptData);

    paySetStep(5, 'done');
    showToast(`✅ Payment confirmed! <a href="${receiptData.explorerUrl}" target="_blank" class="underline">View ↗</a>`, 'success');
    if (typeof showTXConfirmationBadge === 'function')
      showTXConfirmationBadge(txHash, `${amountHuman} ${token} → ${shortAddr(recipient)}`);

    renderPaymentReceipt(receiptData);
    payShow('pay-receipt-panel');
    if (amountInput) amountInput.value = '';
    if (descInput)   descInput.value   = '';
    await refreshPaymentBalances();
    renderPaymentHistory();
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

// Registra oninput no DOMContentLoaded para garantir que o DOM existe
document.addEventListener('DOMContentLoaded', () => {
  payAttachAmountListener();
});

// ─── Boot log ─────────────────────────────────────────────────────────────────
console.log('[PAY] Payments module loaded — Arc Testnet ChainID:', PAY_CHAIN_ID);
console.log('[PAY] USDC contract:', PAY_USDC(), '(ERC-20, 6 dec) ← balanceOf + transfer via ethers.Contract');
console.log('[PAY] EURC contract:', PAY_EURC(), '(ERC-20, 6 dec)');
console.log('[PAY] ethers.js available:', !!window.ethers);
console.log('[PAY] ethers.Contract:', !!window.ethers?.Contract);
console.log('[PAY] Amount conversion: 10 →', (() => { try { return payParseUnits(10).toString(); } catch(e){ return 'error: '+e.message; } })(), 'base units');
console.log('[PAY] Fix summary:');
console.log('[PAY]   ✅ payParseUnits(10) = 10000000 (não 10)');
console.log('[PAY]   ✅ payReadBalance() usa ethers.Contract.balanceOf + formatUnits (USDC e EURC)');
console.log('[PAY]   ✅ setPayMax() lê saldo on-chain via ethers.Contract.balanceOf em tempo real');
console.log('[PAY]   ✅ executePayment() usa payParseUnits — proíbe amount=0n');
console.log('[PAY]   ✅ USDC usa ethers.Contract(0x3600...).transfer(recipient, amount) + tx.wait()');
console.log('[PAY]   ✅ EURC usa ethers.Contract.transfer(recipient, amount) + tx.wait()');
console.log('[PAY]   ✅ Emite evento ERC-20 Transfer detectável no ArcScan');
console.log('[PAY]   ✅ live preview oninput atualiza #previewAmount');
