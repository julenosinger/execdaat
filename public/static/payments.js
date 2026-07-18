// ============================================================
// ARC Payments Module v4 — Fee Transparency · Gas Oracle · Multi-Token
// Multi-Network · Gov Tax · ENS · KYC · TX Pipeline · Receipts++
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

// ─── Multi-Token & Multi-Network Registry ────────────────────────────────────
const PAY_TOKENS = {
  USDC: { address: () => PAY_USDC(), decimals: 6, symbol: 'USDC', usdRate: 1.0,   color: '#60b4ff', network: 'arc' },
  EURC: { address: () => PAY_EURC(), decimals: 6, symbol: 'EURC', usdRate: 1.08,  color: '#a78bfa', network: 'arc' },
};

// ─── Gas Speed Tiers ─────────────────────────────────────────────────────────
const PAY_GAS_TIERS = {
  slow:     { label: 'Slow',     multiplier: 0.85, confirmTime: '~120s', color: '#6b7280' },
  standard: { label: 'Standard', multiplier: 1.00, confirmTime: '~30s',  color: '#fbbf24' },
  fast:     { label: 'Fast',     multiplier: 1.30, confirmTime: '~10s',  color: '#34d399' },
};

// ─── Platform Fee ─────────────────────────────────────────────────────────────
const PAY_PLATFORM_FEE_PCT = 0.002; // 0.2%

// ─── State ────────────────────────────────────────────────────────────────────
// (extended below with new fields)

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
  // New v4 state
  gasTier: 'standard',  // 'slow' | 'standard' | 'fast'
  gasUSD: 0,            // last estimated gas cost in USD
  gasGwei: 0,           // last gas price in gwei
  platformFeeUSD: 0,    // 0.2% of amount in USD
  govTaxUSD: 0,         // gov tax in USD
  govTaxMode: 'pct',    // 'pct' | 'fixed'
  govTaxValue: 0,       // user-entered tax value
  totalCostUSD: 0,      // sum of gas+platform+tax in USD
  arcUSD: 0.0001,       // ARC token price in USD (fetched live)
  kycStatus: null,      // 'verified' | 'unverified' | null
  ensResolved: null,    // ENS→address resolved
};

// ─── Persistent Hide State (Payments) ──────────────────────────────────────────
// Uses localStorage key 'hiddenPayments' — survives page reload.
// Falls back gracefully if hide-history.js not yet loaded.
const _payDismiss = {
  isVisible: (id) => typeof arcIsVisiblePay === 'function' ? arcIsVisiblePay(id) : true,
  dismiss:   (id) => typeof arcHidePay      === 'function' ? arcHidePay(id)      : undefined,
  reset:     ()   => { /* no-op: persistent hide does NOT reset on reload */ },
};
// Legacy compat (no-op reset)
window._payDismissReset = () => { /* persistent — no reset */ };

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

// ─── Gas Oracle & Fee Calculation ────────────────────────────────────────────
async function payFetchARCPrice() {
  // Try to fetch live ARC/USD price from CoinGecko or public oracle
  // Since ARC testnet has no live price, use a reasonable default with fallback
  try {
    // Try coingecko free API for reference price (using ARC equivalent)
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const json = await res.json();
      // ARC testnet: estimate price relative to ETH (testnet ratio)
      // Using ETH price / 10000 as placeholder since ARC is a testnet
      const ethPrice = json.ethereum?.usd || 3000;
      payState.arcUSD = ethPrice / 100000; // ~$0.03 per ARC as testnet estimate
    }
  } catch (_) {
    // Fallback: use $0.0001 per ARC (testnet)
    payState.arcUSD = 0.0001;
  }
  return payState.arcUSD;
}

async function payGetGasPriceGwei() {
  const provider = window.walletState?.provider;
  if (!provider) return 10; // default 10 gwei
  try {
    const hex = await provider.request({ method: 'eth_gasPrice' });
    return Number(BigInt(hex)) / 1e9;
  } catch (_) { return 10; }
}

// Get gas price with tier multiplier
async function payGetTieredGasPrice() {
  const baseGwei = await payGetGasPriceGwei();
  const tier = PAY_GAS_TIERS[payState.gasTier] || PAY_GAS_TIERS.standard;
  const tieredGwei = baseGwei * tier.multiplier;
  payState.gasGwei = tieredGwei;
  return '0x' + Math.round(tieredGwei * 1e9).toString(16);
}

// Estimate total fee in USD for current form state
async function payUpdateGasEstimate() {
  const amountStr = (payEl('pay-amount')?.value || '').trim();
  const amountNum = parseFloat(amountStr) || 0;
  const token = payState.token;
  const tokenMeta = PAY_TOKENS[token];

  // Platform fee (0.2% of amount)
  const amountUSD = amountNum * (tokenMeta?.usdRate || 1.0);
  payState.platformFeeUSD = amountUSD * PAY_PLATFORM_FEE_PCT;

  // Gas estimate
  try {
    const arcPrice = await payFetchARCPrice();
    const gasPriceGwei = await payGetGasPriceGwei();
    const tier = PAY_GAS_TIERS[payState.gasTier] || PAY_GAS_TIERS.standard;
    const tieredGwei = gasPriceGwei * tier.multiplier;
    const gasUnits = 65000; // typical ERC-20 transfer
    const gasFeeARC = (tieredGwei * 1e9 * gasUnits) / 1e18;
    payState.gasUSD = gasFeeARC * arcPrice;
    payState.gasGwei = tieredGwei;
  } catch (_) {
    payState.gasUSD = 0.000001; // negligible testnet
  }

  // Gov tax
  const rawTax = parseFloat((payEl('pay-gov-tax')?.value || '').trim()) || 0;
  const taxMode = (payEl('pay-tax-mode')?.value || 'pct');
  payState.govTaxMode = taxMode;
  payState.govTaxValue = rawTax;
  if (taxMode === 'pct') {
    payState.govTaxUSD = amountUSD * (rawTax / 100);
  } else {
    payState.govTaxUSD = rawTax;
  }

  // Total cost
  payState.totalCostUSD = payState.gasUSD + payState.platformFeeUSD + payState.govTaxUSD;

  // Update UI panels
  _payUpdateFeeUI();
  _payUpdateGasSpeedUI();
}

function _payUpdateFeeUI() {
  const fmt = (n) => n < 0.0001 ? '<$0.0001' : '$' + n.toFixed(4);
  paySet('pay-fee-gas',      fmt(payState.gasUSD));
  paySet('pay-fee-platform', fmt(payState.platformFeeUSD));
  paySet('pay-fee-tax',      fmt(payState.govTaxUSD));
  paySet('pay-fee-total',    fmt(payState.totalCostUSD));
  paySet('prev-total-cost',  fmt(payState.totalCostUSD));

  // Tooltip breakdown
  const tt = payEl('pay-fee-tooltip');
  if (tt) {
    const amountNum = parseFloat((payEl('pay-amount')?.value || '').trim()) || 0;
    const amountUSD = amountNum * (PAY_TOKENS[payState.token]?.usdRate || 1.0);
    const tier = PAY_GAS_TIERS[payState.gasTier] || PAY_GAS_TIERS.standard;
    tt.innerHTML = `
      <div style="min-width:220px;font-size:11px;line-height:1.7;">
        <div style="font-weight:700;color:#dde2f0;margin-bottom:4px;">Fee Breakdown</div>
        <div style="display:flex;justify-content:space-between;gap:8px;">
          <span style="color:#8aaac8;">Network Gas (${tier.label}, ~${payState.gasGwei.toFixed(1)} gwei)</span>
          <span style="color:#fbbf24;">${fmt(payState.gasUSD)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;gap:8px;">
          <span style="color:#8aaac8;">Platform Fee (0.2%)</span>
          <span style="color:#60b4ff;">${fmt(payState.platformFeeUSD)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;gap:8px;">
          <span style="color:#8aaac8;">Government Tax (${payState.govTaxMode === 'pct' ? payState.govTaxValue + '%' : '$' + payState.govTaxValue + ' fixed'})</span>
          <span style="color:#a78bfa;">${fmt(payState.govTaxUSD)}</span>
        </div>
        <div style="border-top:1px solid rgba(55,138,221,0.2);margin-top:4px;padding-top:4px;display:flex;justify-content:space-between;gap:8px;">
          <span style="color:#dde2f0;font-weight:700;">Total Cost</span>
          <span style="color:#34d399;font-weight:700;">${fmt(payState.totalCostUSD)}</span>
        </div>
        <div style="margin-top:4px;color:#5a8090;font-size:10px;">
          Amount value: ${fmt(amountUSD)} · Gas: ${tier.confirmTime}
        </div>
        ${payState.scheduleMode === 'later' ? '<div style="margin-top:3px;color:#fbbf24;font-size:10px;">⚠️ Estimated future cost — gas prices may change</div>' : ''}
      </div>`;
  }
}

function _payUpdateGasSpeedUI() {
  // Update gas tier buttons
  Object.keys(PAY_GAS_TIERS).forEach(tier => {
    const btn = payEl('pay-gas-' + tier);
    if (!btn) return;
    const tierData = PAY_GAS_TIERS[tier];
    const isActive = tier === payState.gasTier;
    btn.style.background = isActive ? `rgba(55,138,221,0.18)` : 'rgba(55,138,221,0.06)';
    btn.style.borderColor = isActive ? 'rgba(55,138,221,0.5)' : 'rgba(55,138,221,0.15)';
    btn.style.color = isActive ? '#60b4ff' : '#7a9ab8';
    const fmtGas = payState.gasUSD < 0.0001 ? '<$0.0001' : '$' + (payState.gasUSD * (tierData.multiplier / (PAY_GAS_TIERS[payState.gasTier]?.multiplier || 1))).toFixed(5);
    const costEl = btn.querySelector('.gas-cost');
    const timeEl = btn.querySelector('.gas-time');
    if (costEl) costEl.textContent = fmtGas;
    if (timeEl) timeEl.textContent = tierData.confirmTime;
  });
}

function paySelectGasTier(tier) {
  if (!PAY_GAS_TIERS[tier]) return;
  payState.gasTier = tier;
  payUpdateGasEstimate();
}

// ─── ENS Resolver ─────────────────────────────────────────────────────────────
async function payResolveENS() {
  const input = payEl('pay-recipient');
  if (!input) return;
  const val = input.value.trim();
  if (!val.includes('.')) {
    showToast('Enter an ENS name (e.g. vitalik.eth)', 'warning');
    return;
  }
  const btn = payEl('pay-ens-btn');
  if (btn) { btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; btn.disabled = true; }
  try {
    // Use public ENS resolution via ethers if available
    if (window.ethers?.providers?.JsonRpcProvider || window.ethers?.JsonRpcProvider) {
      const ProvClass = window.ethers.JsonRpcProvider || window.ethers.providers.JsonRpcProvider;
      const mainnetProvider = new ProvClass('https://cloudflare-eth.com');
      const resolved = await mainnetProvider.resolveName(val);
      if (resolved) {
        input.value = resolved;
        payState.ensResolved = { ens: val, address: resolved };
        showToast(`✅ ENS resolved: ${val} → ${resolved.slice(0,10)}…${resolved.slice(-8)}`, 'success');
        payValidateField('recipient'); updatePayPreview(); payValidateForm();
      } else {
        showToast('ENS name not found or not registered', 'error');
      }
    } else {
      // Fallback: ENS API
      const res = await fetch(`https://api.ensideas.com/ens/resolve/${encodeURIComponent(val)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.address) {
          input.value = data.address;
          payState.ensResolved = { ens: val, address: data.address };
          showToast(`✅ ENS resolved: ${val} → ${data.address.slice(0,10)}…`, 'success');
          payValidateField('recipient'); updatePayPreview(); payValidateForm();
        } else {
          showToast('ENS name not resolved', 'error');
        }
      }
    }
  } catch (e) {
    showToast('ENS resolution failed: ' + e.message, 'error');
  } finally {
    if (btn) { btn.innerHTML = '<i class="fas fa-search"></i> ENS'; btn.disabled = false; }
  }
}

// ─── KYC Status ───────────────────────────────────────────────────────────────
async function payCheckKYC(address) {
  if (!address) return;
  try {
    // Check against local KYC records first
    const res = await fetch(`/api/kyc/status?address=${encodeURIComponent(address)}`).catch(() => null);
    if (res && res.ok) {
      const data = await res.json();
      payState.kycStatus = data.status || 'unverified';
      payState.kycLimit  = data.limit  || 0;
    } else {
      payState.kycStatus = 'unverified';
      payState.kycLimit  = 0;
    }
  } catch (_) {
    payState.kycStatus = null;
  }
  _payUpdateKYCUI();
}

function _payUpdateKYCUI() {
  const el = payEl('pay-kyc-status');
  if (!el) return;
  if (!payState.kycStatus) { el.style.display = 'none'; return; }
  el.style.display = '';
  if (payState.kycStatus === 'verified') {
    el.innerHTML = `<i class="fas fa-shield-check" style="color:#34d399;"></i><span style="color:#34d399;">KYC Verified${payState.kycLimit ? ' — Limit $' + Number(payState.kycLimit).toLocaleString() : ''}</span>`;
  } else {
    el.innerHTML = `<i class="fas fa-exclamation-triangle" style="color:#fbbf24;"></i><span style="color:#fbbf24;">KYC Not Verified</span>`;
  }
}

// ─── Transaction Status Pipeline ──────────────────────────────────────────────
const PAY_STEPS = [
  { icon: 'fa-network-wired',   label: 'Verify network'             },
  { icon: 'fa-coins',           label: 'Read token balance'         },
  { icon: 'fa-check-double',    label: 'Token approval (if needed)' },
  { icon: 'fa-signature',       label: 'Sign & broadcast'           },
  { icon: 'fa-hourglass-half',  label: 'Awaiting confirmation'      },
  { icon: 'fa-receipt',         label: 'Generating receipt'         },
];

function paySetStepEx(step, state, detail) {
  paySetStep(step, state);
  if (detail) paySetStepLabel(step, PAY_STEPS[step]?.label + ' — ' + detail);
}

function payResetSteps() {
  PAY_STEPS.forEach((_, i) => {
    paySetStep(i, 'idle');
    paySetStepLabel(i, PAY_STEPS[i].label);
  });
}

// ─── Error decoder with retry ─────────────────────────────────────────────────
function payDecodeError(err) {
  if (err.code === 4001 || /reject|denied|user/i.test(err.message))
    return { msg: 'Transaction rejected by user.', canRetry: true };
  if (/insufficient.*gas/i.test(err.message))
    return { msg: 'Insufficient gas — increase gas tier or add funds.', canRetry: true };
  if (/insufficient.*balance/i.test(err.message))
    return { msg: err.message, canRetry: false };
  if (/nonce/i.test(err.message))
    return { msg: 'Nonce error — please retry.', canRetry: true };
  if (/network|rpc|chain/i.test(err.message))
    return { msg: 'Network error: ' + err.message, canRetry: true };
  if (/revert/i.test(err.message))
    return { msg: 'Transaction reverted by contract: ' + err.message.slice(0, 100), canRetry: false };
  return { msg: 'Payment failed: ' + (err.message || String(err)).slice(0, 120), canRetry: true };
}

function payShowRetryBtn(show) {
  let btn = payEl('pay-retry-btn');
  if (!btn) return;
  btn.style.display = show ? '' : 'none';
}

// ─── Scheduled payment: future cost warning ────────────────────────────────────
function payShowFutureCostWarning() {
  const el = payEl('pay-future-cost-warn');
  if (!el) return;
  if (payState.scheduleMode === 'later') {
    el.style.display = '';
    el.innerHTML = `<i class="fas fa-exclamation-triangle" style="color:#fbbf24;margin-right:6px;"></i>
      <span style="color:#fbbf24;font-size:11px;">Estimated future cost shown — gas prices may change at execution time.</span>`;
  } else {
    el.style.display = 'none';
  }
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
  if (!PAY_TOKENS[token]) return;
  payState.token = token;
  // Update all token buttons
  Object.keys(PAY_TOKENS).forEach(t => {
    const btn = payEl('pay-token-' + t.toLowerCase());
    if (btn) btn.className = t === token ? 'pay-tok-btn tok-' + t.toLowerCase() : 'pay-tok-btn tok-off';
  });
  const lblTok = payEl('pay-label-token');
  if (lblTok) lblTok.textContent = token;
  paySet('prev-token', token);
  updatePayMaxHint();
  updatePayPreview();
  payValidateForm();
  // Re-estimate gas with new token
  payUpdateGasEstimate();
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
  const recipient  = (payEl('pay-recipient')?.value || '').trim();
  const amountStr  = (payEl('pay-amount')?.value    || '').trim();
  const amountNum  = parseFloat(amountStr) || 0;
  const note       = (payEl('pay-note')?.value      || '').trim();
  const token      = payState.token;
  const tokenMeta  = PAY_TOKENS[token] || { usdRate: 1.0 };
  const amountUSD  = amountNum * tokenMeta.usdRate;

  paySet('prev-token',      token);
  paySet('prev-amount',     amountNum > 0 ? amountNum.toFixed(6) + ' ' + token : '—');
  paySet('prev-amount-usd', amountNum > 0 ? '≈ $' + amountUSD.toFixed(2) : '');
  paySet('prev-recipient',  isValidAddress(recipient) ? shortAddr(recipient) : (recipient || '—'));
  paySet('prev-network',    'Arc Testnet (5042002)');
  paySet('prev-gas',        token === 'EURC' ? '~2 txs (approve + transfer)' : '~1 tx (ERC-20 transfer)');

  const from = window.walletState?.address;
  if (from) paySet('pay-from-display', shortAddr(from));

  // Hide name/email rows (removed from UI)
  const recipNameRow  = payEl('prev-recipient-name-row');
  const recipEmailRow = payEl('prev-recipient-email-row');
  if (recipNameRow)  recipNameRow.style.display  = 'none';
  if (recipEmailRow) recipEmailRow.style.display = 'none';

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
    payShowFutureCostWarning();
  } else {
    if (schedRow) schedRow.style.display = 'none';
    payShowFutureCostWarning();
  }

  // Note row
  const noteRow = payEl('prev-note-row');
  if (note) {
    paySet('prev-note', note.length > 60 ? note.slice(0, 60) + '…' : note);
    if (noteRow) noteRow.style.display = '';
  } else {
    if (noteRow) noteRow.style.display = 'none';
  }

  // Update Payment Summary info card (right column)
  const sumToken = document.getElementById('pay-info-token');
  const sumAmount = document.getElementById('pay-info-amount');
  const sumRecipient = document.getElementById('pay-info-recipient');
  const sumFee = document.getElementById('pay-info-fee');
  if (sumToken) sumToken.textContent = token;
  if (sumAmount) sumAmount.textContent = amountNum > 0 ? amountNum.toFixed(6) + ' ' + token : '—';
  if (sumRecipient) sumRecipient.textContent = isValidAddress(recipient) ? shortAddr(recipient) : (recipient || '—');
  if (sumFee) sumFee.textContent = token === 'EURC' ? '~0.002 USDC' : '~0.001 USDC';

  // Trigger fee recalculation
  if (amountNum > 0 || payState.totalCostUSD > 0) {
    clearTimeout(payState._feeTimer);
    payState._feeTimer = setTimeout(payUpdateGasEstimate, 400);
  }
}

// ─── Field-level validation ────────────────────────────────────────────────────
function payValidateField(field) {
  const fieldMap = {
    recipient: { el: 'pay-recipient', hint: 'pay-hint-recipient' },
    amount:    { el: 'pay-amount',    hint: 'pay-hint-amount'    },
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

  const recipient  = (payEl('pay-recipient')?.value || '').trim();
  const amountStr  = (payEl('pay-amount')?.value    || '').trim();
  const amount     = parseFloat(amountStr);
  const token      = payState.token;
  const bal        = payState.senderBalance[token];
  const connected  = !!window.walletState?.address;
  const noteLen    = (payEl('pay-note')?.value || '').length;

  let ok = true;
  let reason = payState.scheduleMode === 'later' ? 'Schedule Payment' : 'Sign & Send';

  if (!connected)                                        { ok = false; reason = 'Connect wallet to send'; }
  else if (!isValidAddress(recipient))                   { ok = false; reason = 'Invalid recipient address'; }
  else if (recipient.toLowerCase() === window.walletState?.address?.toLowerCase()) { ok = false; reason = 'Cannot send to yourself'; }
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
  }, 30_000); // request-optimization: check every 15s → 30s (localStorage scan; RPC only when a job is due)
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

  // Use tiered gas price
  const tieredGasPrice = await payGetTieredGasPrice();

  // ── Optional Arc transaction memo (additive plug-in — never blocks the transfer) ──
  // Built ONLY when the user explicitly enabled the memo toggle. Any failure
  // (unsupported network, invalid text, encoding error) falls back to the
  // original, unmodified transfer below.
  let memoTx = null;
  try {
    const memoText = (window.MemoUI && typeof window.MemoUI.getActiveMemo === 'function') ? window.MemoUI.getActiveMemo('pay') : '';
    if (memoText && window.MemoEngine) {
      const memoTokenAddr = token === 'EURC' ? PAY_EURC() : PAY_USDC();
      const memoInner     = PAY_SELECTORS.transfer + encAddr(recipient) + BigInt(amount).toString(16).padStart(64, '0');
      memoTx = await window.MemoEngine.buildTx({ target: memoTokenAddr, data: memoInner, memoText });
      if (!memoTx) showToast('Memo could not be attached. Transaction will continue normally.', 'warning');
    }
  } catch (_) { memoTx = null; }

  if (window.ethers?.Contract) {
    const contract = await payGetContract(token);
    showToast('📝 Confirm ' + token + ' transfer in your wallet…', 'info');
    let tx = null;
    if (memoTx) {
      try {
        const memoSigner = await payGetSigner();
        tx = await memoSigner.sendTransaction({ to: memoTx.to, data: memoTx.data });
      } catch (memoErr) {
        const mm = String((memoErr && (memoErr.message || memoErr.code)) || '');
        if (/reject|denied|ACTION_REJECTED|4001/i.test(mm)) throw memoErr; // user declined the tx itself — do not resend
        showToast('Memo could not be attached. Transaction will continue normally.', 'warning');
        tx = null;
      }
    }
    if (!tx) tx = await contract.transfer(recipient, amount);
    txHash   = tx.hash;
    gasPrice = tieredGasPrice;
    showToast('⏳ Transaction submitted: ' + txHash.slice(0,14) + '…', 'info');
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error(token + ' transfer reverted on-chain.');
    gasUsed = receipt.gasUsed ? receipt.gasUsed.toString() : '~65000';
  } else {
    const contractAddr = token === 'EURC' ? PAY_EURC() : PAY_USDC();
    const data    = PAY_SELECTORS.transfer + encAddr(recipient) + BigInt(amount).toString(16).padStart(64, '0');
    gasPrice      = tieredGasPrice;
    let txTo = contractAddr, txData = data;
    if (memoTx) { txTo = memoTx.to; txData = memoTx.data; }
    let txBase = { from, to: txTo, data: txData, value: '0x0' };
    let gas;
    try {
      gas = await payEstimateGas(txBase);
    } catch (ge) {
      if (!memoTx) throw ge;
      // Memo wrap not estimable — fall back to the plain transfer untouched.
      showToast('Memo could not be attached. Transaction will continue normally.', 'warning');
      txTo = contractAddr; txData = data;
      txBase = { from, to: txTo, data: txData, value: '0x0' };
      gas = await payEstimateGas(txBase);
    }
    const nonce   = await payGetNonce(from);
    txHash        = await window.walletState.provider.request({
      method: 'eth_sendTransaction',
      params: [{ from, to: txTo, data: txData, value: '0x0', gas, gasPrice: tieredGasPrice, nonce }],
    });
    const rxReceipt = await payWaitReceipt(txHash);
    if (rxReceipt.status !== '0x1' && rxReceipt.status !== 1) throw new Error('Transaction reverted on-chain.');
    gasUsed = rxReceipt.gasUsed ? parseInt(rxReceipt.gasUsed, 16).toString() : '~65000';
  }

  try { if (window.MemoUI && typeof window.MemoUI.reset === 'function') window.MemoUI.reset('pay'); } catch (_) {}

  const durationMs = Date.now() - startTime;
  const gpNum      = Number(BigInt(gasPrice));
  let gasFeeEst    = (gpNum * Number(gasUsed)) / 1e18;
  if (isNaN(gasFeeEst) || gasFeeEst === 0) gasFeeEst = 0.000021;

  // Build complete fee breakdown
  const tokenMeta     = PAY_TOKENS[token] || { usdRate: 1.0 };
  const amountUSD     = amountHuman * tokenMeta.usdRate;
  const gasUSD        = payState.gasUSD > 0 ? payState.gasUSD : gasFeeEst * payState.arcUSD;
  const platformFeeUSD = amountUSD * PAY_PLATFORM_FEE_PCT;
  const govTaxUSD     = payState.govTaxUSD || 0;
  const totalCostUSD  = gasUSD + platformFeeUSD + govTaxUSD;

  const receiptData = {
    id: 'pay_' + Date.now(),
    fullname, email, note: note || '',
    recipientName: recipientName || '',
    recipientEmail: recipientEmail || '',
    txHash, sender: from, recipient,
    amount: amountHuman, token,
    amountUSD: amountUSD.toFixed(4),
    gasFee: gasFeeEst.toFixed(6), gasUsed,
    gasUSD: gasUSD.toFixed(6),
    gasTier: payState.gasTier,
    gasGwei: payState.gasGwei.toFixed(2),
    platformFeeUSD: platformFeeUSD.toFixed(6),
    govTaxUSD: govTaxUSD.toFixed(6),
    govTaxMode: payState.govTaxMode,
    govTaxValue: payState.govTaxValue,
    totalCostUSD: totalCostUSD.toFixed(6),
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

  // Persist hybrid: IndexedDB + localStorage (wallet-scoped)
  try {
    const walletAddr = (receiptData.sender || receiptData.from || window.walletState?.address || '').toLowerCase();
    // Save to wallet-specific key for clean per-wallet loading
    if (walletAddr) {
      const walletKey = `arc_pay_history_${walletAddr}`;
      const walletStored = JSON.parse(localStorage.getItem(walletKey) || '[]');
      walletStored.unshift(receiptData);
      localStorage.setItem(walletKey, JSON.stringify(walletStored.slice(0, 50)));
    }
    // Also save to global key (backward compat for migration)
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

    // ── Capture data for smart autofill ───────────────────────────────────────
    if (typeof arcCapturePayData === 'function') arcCapturePayData();

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

    // ── Capture data for smart autofill ───────────────────────────────────────
    if (typeof arcCapturePayData === 'function') arcCapturePayData();

    // Clear form
    payResetForm();
    await refreshPaymentBalances();
    renderPaymentHistory();
    if (typeof loadPayments === 'function') setTimeout(loadPayments, 1000);

    setTimeout(() => { const sp = payEl('pay-steps-panel'); if (sp) sp.style.display = 'none'; }, 3000);

  } catch (err) {
    console.error('[PAY] Payment error:', err);
    paySetStep(payState.step, 'error');
    const { msg, canRetry } = payDecodeError(err);
    showPayError(msg);
    payShowRetryBtn(canRetry);
    showToast('❌ ' + (err.message?.slice(0, 80) || String(err)), 'error');
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
      ${receiptRow('Amount',     '<span style="color:#dde2f0;font-weight:700;">' + Number(r.amount).toFixed(6) + ' ' + r.token + (r.amountUSD ? ' <span style="color:#8aaac8;font-size:10px;">(≈$' + r.amountUSD + ')</span>' : '') + '</span>')}
      ${receiptRow('From',       '<span style="font-family:monospace;font-size:11px;color:#dde2f0;">' + shortAddr(r.sender || r.from) + '</span>')}
      ${receiptRow('To',         '<span style="font-family:monospace;font-size:11px;color:#dde2f0;">' + shortAddr(r.recipient) + '</span>')}
      ${r.recipientName  ? receiptRow('Recipient Name',  r.recipientName)  : ''}
      ${r.recipientEmail ? receiptRow('Recipient Email', r.recipientEmail) : ''}
      ${receiptRow('Network',    '<span style="color:#34d399;">' + (r.network || 'Arc Testnet') + '</span>')}
      ${r.note ? receiptRow('Note', '<span style="color:#a8c4e0;font-style:italic;">' + escHtml(r.note) + '</span>') : ''}
      ${r.scheduledAt ? receiptRow('Scheduled For', new Date(r.scheduledAt).toLocaleString()) : ''}
      ${r.txHash ? receiptRow('Tx Hash', '<a href="' + r.explorerUrl + '" target="_blank" style="color:#378ADD;font-family:monospace;font-size:11px;text-decoration:none;" onmouseover="this.style.textDecoration=\'underline\'" onmouseout="this.style.textDecoration=\'none\'">' + r.txHash.slice(0,16) + '… ↗</a>') : ''}
      ${r.timestamp ? receiptRow('Date & Time', new Date(r.timestamp).toLocaleString()) : ''}
      ${r.gasFee ? receiptRow('Gas Fee (ARC)', '~' + r.gasFee + ' ARC' + (r.gasGwei ? ' @ ' + r.gasGwei + ' gwei' : '') + (r.gasTier ? ' [' + r.gasTier + ']' : '')) : ''}
      ${r.gasUSD ? receiptRow('Gas Cost (USD)', '≈ $' + Number(r.gasUSD).toFixed(6)) : ''}
      ${r.platformFeeUSD ? receiptRow('Platform Fee (0.2%)', '≈ $' + Number(r.platformFeeUSD).toFixed(6)) : ''}
      ${r.govTaxUSD && Number(r.govTaxUSD) > 0 ? receiptRow('Gov. Tax', '≈ $' + Number(r.govTaxUSD).toFixed(6) + (r.govTaxMode === 'pct' ? ' (' + r.govTaxValue + '%)' : ' (fixed)')) : ''}
      ${r.totalCostUSD ? receiptRow('<strong>Total Cost (USD)</strong>', '<strong style="color:#34d399;">≈ $' + Number(r.totalCostUSD).toFixed(6) + '</strong>') : ''}
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
      doc.text('ExecDaat · Arc Testnet · ' + new Date(r.timestamp || r.createdAt).toLocaleString(), W / 2, 26, { align: 'center' });

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
      addRow('Amount',      Number(r.amount).toFixed(6) + ' ' + r.token + (r.amountUSD ? ' (≈$' + r.amountUSD + ')' : ''));
      addRow('Recipient',   r.recipient);
      addRow('Network',     (r.network || 'Arc Testnet') + ' (Chain ' + (r.chainId || PAY_CHAIN_ID) + ')', [22, 140, 80]);
      if (r.gasFee)          addRow('Gas Fee (ARC)', '~' + r.gasFee + ' ARC' + (r.gasTier ? ' [' + r.gasTier + ']' : ''));
      if (r.gasUSD)          addRow('Gas Cost (USD)', '≈ $' + Number(r.gasUSD).toFixed(6));
      if (r.platformFeeUSD)  addRow('Platform Fee (0.2%)', '≈ $' + Number(r.platformFeeUSD).toFixed(6));
      if (r.govTaxUSD && Number(r.govTaxUSD) > 0) addRow('Gov. Tax', '≈ $' + Number(r.govTaxUSD).toFixed(6) + (r.govTaxMode === 'pct' ? ' (' + r.govTaxValue + '%)' : ' (fixed)'));
      if (r.totalCostUSD)    addRow('Total Cost (USD)', '≈ $' + Number(r.totalCostUSD).toFixed(6), [22, 140, 80]);
      if (r.note)            addRow('Note', r.note);
      y += 4;

      addSection('Transaction Details');
      if (r.scheduledAt) addRow('Scheduled For', new Date(r.scheduledAt).toLocaleString());
      if (r.txHash)     { addRow('Transaction Hash', r.txHash); addRow('Explorer', r.explorerUrl); }
      addRow('Date & Time', new Date(r.timestamp || r.createdAt).toLocaleString());
      if (r.durationMs) addRow('Duration', (r.durationMs / 1000).toFixed(1) + 's');
      y += 4;

      doc.setFontSize(8); doc.setTextColor(160, 160, 175); doc.setFont('helvetica', 'normal');
      doc.text('Generated by ExecDaat · https://testnet.arcscan.app · Testnet only — no real funds', W / 2, 285, { align: 'center' });

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
  <div class="header"><h1>Payment Receipt</h1><p>ExecDaat · Arc Testnet · ${new Date(r.timestamp || r.createdAt).toLocaleString()}</p><span class="badge">${r.status === 'scheduled' ? '⏰ SCHEDULED' : '✓ CONFIRMED'}</span></div>
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
  <div class="footer">Generated by ExecDaat &middot; testnet.arcscan.app &middot; Testnet only</div>
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

// Active filter state for history (survives re-renders within session)
if (!window._payHistoryFilters) {
  window._payHistoryFilters = { status: 'all', token: 'all', date: 'all' };
}

function _payHistoryStatusColor(status) {
  const map = {
    completed:  { bg: 'rgba(52,211,153,0.12)',  border: 'rgba(52,211,153,0.35)',  color: '#34d399',  dot: '#34d399'  },
    confirmed:  { bg: 'rgba(52,211,153,0.12)',  border: 'rgba(52,211,153,0.35)',  color: '#34d399',  dot: '#34d399'  },
    scheduled:  { bg: 'rgba(251,191,36,0.10)',  border: 'rgba(251,191,36,0.32)',  color: '#fbbf24',  dot: '#fbbf24'  },
    processing: { bg: 'rgba(96,165,250,0.10)',  border: 'rgba(96,165,250,0.32)',  color: '#60a5fa',  dot: '#60a5fa'  },
    failed:     { bg: 'rgba(239,68,68,0.10)',   border: 'rgba(239,68,68,0.32)',   color: '#f87171',  dot: '#f87171'  },
    cancelled:  { bg: 'rgba(107,114,128,0.10)', border: 'rgba(107,114,128,0.28)', color: '#9ca3af',  dot: '#6b7280'  },
    cached:     { bg: 'rgba(167,139,250,0.09)', border: 'rgba(167,139,250,0.28)', color: '#c4b5fd',  dot: '#a78bfa'  },
  };
  return map[status] || map.cached;
}

function _payHistoryStatusLabel(status, isCached) {
  if (isCached) return { icon: 'fa-clock', label: 'Cached' };
  const map = {
    completed:  { icon: 'fa-check-circle',  label: 'Completed'  },
    confirmed:  { icon: 'fa-check-circle',  label: 'Confirmed'  },
    scheduled:  { icon: 'fa-calendar-alt',  label: 'Scheduled'  },
    processing: { icon: 'fa-spinner fa-spin', label: 'Processing' },
    failed:     { icon: 'fa-times-circle',  label: 'Failed'     },
    cancelled:  { icon: 'fa-ban',           label: 'Cancelled'  },
  };
  return map[status] || { icon: 'fa-circle', label: status || 'Pending' };
}

function _payFmtDateTime(ts) {
  if (!ts) return { date: '—', time: '' };
  try {
    const d = new Date(ts);
    if (isNaN(d)) return { date: String(ts), time: '' };
    return {
      date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      time: d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
    };
  } catch { return { date: '—', time: '' }; }
}

function _payHistoryApplyFilters(items) {
  const f = window._payHistoryFilters;
  return items.filter(r => {
    // Status filter
    if (f.status !== 'all') {
      const isCached = r._source === 'local' && !r.txHash && r.status !== 'scheduled';
      const st = isCached ? 'cached' : (r.status || 'pending');
      if (st !== f.status) return false;
    }
    // Token filter
    if (f.token !== 'all') {
      const tok = (r.token || '').toUpperCase();
      if (tok !== f.token.toUpperCase()) return false;
    }
    // Date filter
    if (f.date !== 'all') {
      const ts = r.scheduledAt || r.timestamp || r.createdAt;
      if (!ts) return false;
      const d = new Date(ts);
      const now = new Date();
      if (f.date === '24h' && (now - d) > 86400000) return false;
      if (f.date === '7d'  && (now - d) > 7*86400000) return false;
      if (f.date === '30d' && (now - d) > 30*86400000) return false;
    }
    return true;
  });
}

function _payHistoryRenderFilters(allItems) {
  const f = window._payHistoryFilters;

  const statusOpts = [
    { v:'all', label:'All' },
    { v:'completed', label:'Completed' },
    { v:'processing', label:'Pending' },
    { v:'failed', label:'Failed' },
    { v:'scheduled', label:'Scheduled' },
    { v:'cancelled', label:'Cancelled' },
  ];

  const statusBtns = statusOpts.map(o =>
    `<button onclick="window._payHistoryFilters.status='${o.v}';renderPaymentHistory();"
      class="text-xs px-3 py-1.5 rounded-lg transition font-semibold ${f.status===o.v ? 'bg-blue-700/40 border border-blue-600/40 text-blue-300' : 'bg-gray-800/60 border border-gray-700/40 text-gray-400 hover:text-gray-300 hover:border-gray-600/40'}">${o.label}</button>`
  ).join('');

  return `
  <div style="padding:12px 14px 0;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
    <span style="font-size:9px;text-transform:uppercase;letter-spacing:0.08em;color:#4a6490;font-weight:700;">Status</span>
    <div style="display:flex;gap:4px;flex-wrap:wrap;">${statusBtns}</div>
  </div>
  <div style="height:1px;margin:8px 0 0;background:linear-gradient(90deg,transparent,rgba(55,138,221,0.2),transparent);"></div>`;
}

function _payHistoryCardHtml(r) {
  const isScheduled  = r.status === 'scheduled';
  const isProcessing = r.status === 'processing';
  const isFailed     = r.status === 'failed';
  const isCancelled  = r.status === 'cancelled';
  const isCached     = r._source === 'local' && !r.txHash && !isScheduled;
  const uid          = r.txHash || r.id || '';
  const safeid       = uid.replace(/[^a-zA-Z0-9_-]/g, '_');

  const stKey   = isCached ? 'cached' : (r.status || 'pending');
  const stTheme = _payHistoryStatusColor(stKey);
  const stInfo  = _payHistoryStatusLabel(stKey, isCached);

  const ts       = r.scheduledAt || r.timestamp || r.createdAt;
  const dtParts  = _payFmtDateTime(ts);
  const amtStr   = r.amount != null ? Number(r.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 }) : '—';
  const tokenStr = r.token || '';

  // Explorer link for tx hash
  const explorerBase = r.explorerUrl
    ? r.explorerUrl.replace(/\/tx\/0x.+$/, '')
    : 'https://testnet.arcscan.app';
  const txHashFull = r.txHash || '';
  const txHashShort = txHashFull ? txHashFull.slice(0,10) + '…' + txHashFull.slice(-6) : '';

  // Addresses
  const senderFull    = r.sender || r.from || '';
  const recipientFull = r.recipient || r.to || '';
  const senderShort   = senderFull ? shortAddr(senderFull) : '—';
  const recipientShort = recipientFull ? shortAddr(recipientFull) : '—';

  // Inline copy helper
  const copyBtn = (val, label) => val
    ? `<button onclick="navigator.clipboard.writeText('${val.replace(/'/g,"\\'")}').then(()=>showToast('Copied!','success'))" title="Copy ${label}" style="background:none;border:none;color:#4a6490;cursor:pointer;padding:1px 4px;font-size:10px;border-radius:4px;transition:color 0.15s;" onmouseover="this.style.color='#60b4ff'" onmouseout="this.style.color='#4a6490'"><i class='fas fa-copy'></i></button>`
    : '';

  // Payment type/network inference
  const payType = r.payType || r.type || (isScheduled ? 'Scheduled' : 'Direct');
  const network = r.network || r.chainName || 'Arc Testnet';
  const gasFee  = r.gasFee != null ? `$${Number(r.gasFee).toFixed(6)} ${r.gasCurrency || 'USDC'}` : null;

  // Action buttons
  const editBtn = isScheduled
    ? `<button onclick="payEditScheduled('${r.id}')" title="Edit scheduled payment" style="display:inline-flex;align-items:center;gap:4px;background:rgba(55,138,221,0.08);border:1px solid rgba(55,138,221,0.25);border-radius:7px;color:#60b4ff;font-size:10px;padding:4px 10px;cursor:pointer;transition:all 0.2s;font-weight:600;" onmouseover="this.style.background='rgba(55,138,221,0.18)'" onmouseout="this.style.background='rgba(55,138,221,0.08)'"><i class='fas fa-edit'></i>Edit</button>`
    : '';
  const cancelBtn = isScheduled
    ? `<button onclick="payCancelScheduled('${r.id}')" title="Cancel scheduled payment" style="display:inline-flex;align-items:center;gap:4px;background:rgba(239,68,68,0.07);border:1px solid rgba(239,68,68,0.22);border-radius:7px;color:#f87171;font-size:10px;padding:4px 10px;cursor:pointer;transition:all 0.2s;font-weight:600;" onmouseover="this.style.background='rgba(239,68,68,0.15)'" onmouseout="this.style.background='rgba(239,68,68,0.07)'"><i class='fas fa-times'></i>Cancel</button>`
    : '';
  const retryBtn = isFailed && typeof arcRetryBtn === 'function'
    ? arcRetryBtn(window.ARC_STORE_PAY || 'payments', r.id)
    : '';
  const receiptBtn = `<button onclick="(typeof arcViewPaymentReceipt==='function'?arcViewPaymentReceipt:payOpenReceiptModal)(${JSON.stringify(r).replace(/"/g,'&quot;')})" title="View receipt" style="display:inline-flex;align-items:center;gap:4px;background:rgba(29,158,117,0.08);border:1px solid rgba(29,158,117,0.25);border-radius:7px;color:#34d399;font-size:10px;padding:4px 10px;cursor:pointer;transition:all 0.2s;font-weight:600;" onmouseover="this.style.background='rgba(29,158,117,0.18)'" onmouseout="this.style.background='rgba(29,158,117,0.08)'"><i class='fas fa-receipt'></i>Receipt</button>`;

  const dismissBtn = uid
    ? `<button class="arc-dismiss-btn" onclick="event.stopPropagation();arcAnimatedDismiss('pay-tx-${safeid}',function(){if(typeof arcHidePay==='function')arcHidePay('${uid}');renderPaymentHistory();})" title="Hide from view" style="flex-shrink:0;">✕</button>`
    : '';

  // Accordion toggle ID
  const detailId = `pay-tx-detail-${safeid}`;
  const chevronId = `pay-tx-chev-${safeid}`;

  // Left accent color based on status
  const accentColor = stTheme.color;

  // Icon per payment type
  const typeIcon = isScheduled ? 'fa-calendar' : 'fa-paper-plane';
  const typeBg   = isScheduled ? 'bg-purple-900/30 border-purple-700/30' : (isFailed ? 'bg-red-900/30 border-red-700/30' : 'bg-blue-900/30 border-blue-700/30');
  const typeColor= isScheduled ? 'text-purple-400' : (isFailed ? 'text-red-400' : 'text-blue-400');
  const typeLabel= isScheduled ? 'Scheduled' : 'Payment';

  return `
  <div id="pay-tx-${safeid}" class="bg-gray-900/60 border border-gray-700/40 rounded-xl px-4 py-3 hover:bg-gray-900/80 transition-colors" style="border-left:3px solid ${accentColor};">
    <div class="flex flex-wrap sm:flex-nowrap items-start gap-3">
      <div class="w-9 h-9 rounded-xl ${typeBg} border flex items-center justify-center flex-shrink-0 mt-0.5">
        <i class="fas ${typeIcon} ${typeColor} text-sm"></i>
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 flex-wrap mb-0.5">
          <span class="text-white font-semibold text-sm">${typeLabel}</span>
          ${tokenStr ? `<span class="text-xs font-mono text-blue-400">${tokenStr}</span>` : ''}
          <span class="text-xs px-2 py-0.5 rounded-full border" style="background:${stTheme.bg};border-color:${stTheme.border};color:${stTheme.color};">
            ${stInfo.label}
          </span>
        </div>
        <div class="text-xs text-gray-500 flex items-center gap-1.5 flex-wrap">
          <span class="font-mono">${recipientShort}</span>
          ${ts ? `<span class="text-gray-600">&middot; ${dtParts.date}${dtParts.time ? ' ' + dtParts.time : ''}</span>` : ''}
        </div>
      </div>
      <div class="text-right flex-shrink-0 min-w-[80px]">
        <div class="text-white font-bold text-sm mb-0.5">${amtStr} ${tokenStr}</div>
        ${txHashFull ? `
        <a href="${explorerBase}/tx/${txHashFull}" target="_blank" rel="noopener"
          class="text-[11px] text-blue-400 hover:text-blue-300 hover:underline font-mono flex items-center gap-1 justify-end">
          ${txHashShort || txHashFull.slice(0,10)+'&hellip;'}
          <i class="fas fa-external-link-alt text-[9px]"></i>
        </a>` : '<div class="text-xs text-gray-600">&mdash;</div>'}
      </div>
    </div>
  </div>`;
}

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
  }).slice(0, 50);

  // Apply local dismiss filter
  const notHidden = allItems.filter(r => {
    const uid = r.txHash || r.id || '';
    return uid ? _payDismiss.isVisible(uid) : true;
  });

  // Apply user-selected filters
  const visibleItems = _payHistoryApplyFilters(notHidden);

  if (notHidden.length === 0) {
    container.innerHTML = `
      <div style="color:#8aaac8;font-size:12px;text-align:center;padding:32px 16px;">
        <i class="fas fa-clock" style="font-size:28px;display:block;margin-bottom:10px;color:#2a3650;"></i>
        ${window.walletState?.address ? 'No transactions yet' : 'Connect your wallet to view transaction history'}
      </div>`;
    return;
  }

  const countLabel = visibleItems.length < notHidden.length
    ? `<div style="font-size:10px;color:#4a6490;padding:6px 14px 0;text-align:right;">${visibleItems.length} of ${notHidden.length} transactions</div>`
    : `<div style="font-size:10px;color:#4a6490;padding:6px 14px 0;text-align:right;">${notHidden.length} transaction${notHidden.length !== 1 ? 's' : ''}</div>`;

  const emptyFilter = visibleItems.length === 0
    ? `<div style="color:#4a6490;font-size:11px;text-align:center;padding:20px 16px;">
        <i class="fas fa-filter" style="margin-bottom:6px;display:block;font-size:18px;"></i>
        No transactions match the selected filters
       </div>`
    : '';

  container.innerHTML =
    countLabel +
    (emptyFilter || _payHistoryTableHtml(visibleItems));
}

// ─── Render history as a table (matching Bridge style) ────────────────────────
function _payHistoryTableHtml(items) {
  return `
  <table class="br-history-table" style="width:100%;">
    <thead><tr>
      <th>Status</th>
      <th>Recipient</th>
      <th>Amount</th>
      <th>Transaction</th>
      <th>Date</th>
      <th></th>
    </tr></thead>
    <tbody>
      ${items.map(r => {
        const isScheduled  = r.status === 'scheduled';
        const isProcessing = r.status === 'processing';
        const isFailed     = r.status === 'failed';
        const isCancelled  = r.status === 'cancelled';
        const isCached     = r._source === 'local' && !r.txHash && !isScheduled;
        const uid          = r.txHash || r.id || '';
        const safeid       = uid.replace(/[^a-zA-Z0-9_-]/g, '_');

        const stKey   = isCached ? 'cached' : (r.status || 'pending');
        const stTheme = _payHistoryStatusColor(stKey);
        const stInfo  = _payHistoryStatusLabel(stKey, isCached);

        const ts = r.scheduledAt || r.timestamp || r.createdAt;
        const date = ts ? new Date(ts).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '—';
        const amtStr = r.amount != null ? Number(r.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 }) : '—';
        const tokenStr = r.token || '';

        const explorerBase = 'https://testnet.arcscan.app';
        const txHashFull = r.txHash || '';
        const txHashShort = txHashFull ? txHashFull.slice(0,10) + '…' + txHashFull.slice(-6) : '';
        const recipientFull = r.recipient || r.to || '';
        const recipientShort = recipientFull ? shortAddr(recipientFull) : '—';

        // ── Cross-chain enrichment (additive — local rows are unaffected) ──
        const isXChain  = !!r.crossChain;
        const xcBurn    = r.bridgeTxHash || r.burnTxHash || r.txHash || '';
        const xcMint    = r.destinationTxHash || r.mintTxHash || r.finalTxHash || '';
        const xcSrcExp  = r.srcExplorer || 'https://testnet.arcscan.app';
        const xcDestExp = r.destExplorer || '';
        const xcToChain = r.toNetwork || '';
        const xcBridge  = r.bridgeUsed || (r.bridgeType ? (r.bridgeType + ' Bridge') : '');
        const _sh = (h) => h ? (h.slice(0, 8) + '…' + h.slice(-4)) : '';

        const dismissBtn = uid
          ? `<button onclick="event.stopPropagation();arcAnimatedDismiss('pay-tx-${safeid}',function(){if(typeof arcHidePay==='function')arcHidePay('${uid}');renderPaymentHistory();})" style="color:#4a6490;background:none;border:none;cursor:pointer;font-size:11px;padding:0;" onmouseover="this.style.color='#f87171'" onmouseout="this.style.color='#4a6490'" title="Hide">✕</button>`
          : '';

        // Recipient cell (+ destination chain & bridge badges for cross-chain)
        const recvCell = isXChain
          ? `<span style="font-family:monospace;font-size:11px;color:#8aaac8;" title="${recipientFull}">${recipientShort}</span>${xcToChain ? ` <span style="display:inline-block;margin-left:4px;font-size:8px;font-weight:700;padding:1px 5px;border-radius:5px;background:rgba(96,165,250,0.12);color:#60a5fa;border:1px solid rgba(96,165,250,0.25);"><i class="fas fa-arrow-right" style="font-size:7px;"></i> ${xcToChain}</span>` : ''}${xcBridge ? ` <span style="display:inline-block;font-size:8px;font-weight:700;padding:1px 5px;border-radius:5px;background:${r.bridgeType === 'Turbo' ? 'rgba(245,158,11,0.14)' : 'rgba(52,211,153,0.12)'};color:${r.bridgeType === 'Turbo' ? '#f59e0b' : '#34d399'};">${r.bridgeType === 'Turbo' ? '⚡ ' : ''}${xcBridge}</span>` : ''}`
          : `<span style="font-family:monospace;font-size:11px;color:#8aaac8;" title="${recipientFull}">${recipientShort}</span>`;

        // Transaction cell (Bridge tx on origin + Final delivery tx on destination)
        const txCell = isXChain
          ? `<div style="display:flex;flex-direction:column;gap:3px;">
               ${xcBurn ? `<a href="${xcSrcExp}/tx/${xcBurn}" target="_blank" title="Bridge transaction (origin: ${xcSrcExp})" style="color:#60a5fa;font-size:10px;text-decoration:none;font-family:monospace;" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'"><i class="fas fa-water" style="font-size:9px;"></i> Bridge: ${_sh(xcBurn)}</a>` : ''}
               ${xcMint ? `<a href="${xcDestExp}/tx/${xcMint}" target="_blank" title="Final delivery transaction (destination: ${xcDestExp})" style="color:#34d399;font-size:10px;text-decoration:none;font-family:monospace;" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'"><i class="fas fa-bullseye" style="font-size:9px;"></i> Final: ${_sh(xcMint)}</a>` : `<span style="color:#c99a3b;font-size:10px;"><i class="fas fa-clock" style="font-size:9px;"></i> Final: pending</span>`}
             </div>`
          : (txHashFull ? `<a href="${explorerBase}/tx/${txHashFull}" target="_blank" style="color:#60b4ff;font-size:10px;text-decoration:none;font-family:monospace;" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'" title="${txHashFull}">${txHashShort}</a>` : '—');

        // Explorer icon (destination for cross-chain, origin otherwise)
        const lastLink = isXChain
          ? ((xcMint && xcDestExp) ? `<a href="${xcDestExp}/tx/${xcMint}" target="_blank" title="Open destination explorer" style="color:#4a6490;margin-left:4px;" onmouseover="this.style.color='#34d399'" onmouseout="this.style.color='#4a6490'"><i class="fas fa-external-link-alt" style="font-size:10px;"></i></a>`
              : (xcBurn ? `<a href="${xcSrcExp}/tx/${xcBurn}" target="_blank" style="color:#4a6490;margin-left:4px;" onmouseover="this.style.color='#22d3ee'" onmouseout="this.style.color='#4a6490'"><i class="fas fa-external-link-alt" style="font-size:10px;"></i></a>` : ''))
          : (txHashFull ? `<a href="${explorerBase}/tx/${txHashFull}" target="_blank" style="color:#4a6490;margin-left:4px;" onmouseover="this.style.color='#22d3ee'" onmouseout="this.style.color='#4a6490'"><i class="fas fa-external-link-alt" style="font-size:10px;"></i></a>` : '');

        return `
        <tr>
          <td><span style="display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:999px;font-size:10px;font-weight:700;background:${stTheme.bg};border:1px solid ${stTheme.border};color:${stTheme.color};"><i class="fas ${stInfo.icon}" style="font-size:9px;"></i>${stInfo.label}</span></td>
          <td>${recvCell}</td>
          <td><span style="font-weight:700;color:#e8edf8;">${amtStr}</span> <span style="color:#60b4ff;font-size:10px;">${tokenStr}</span></td>
          <td>${txCell}</td>
          <td style="color:#6a85aa;font-size:11px;">${date}</td>
          <td style="text-align:center;">${dismissBtn}${lastLink}</td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>`;
}

// ─── Load history from IndexedDB / localStorage on startup ──────────────────────
// Always captures the wallet AT CALL TIME to prevent stale-closure issues.
// Returns the wallet used so callers can detect if it changed during async load.
async function payLoadLocalHistory() {
  // Capture wallet AT THIS MOMENT — prevents stale closures
  const wallet = window.walletState?.address;
  const walletKey = wallet ? wallet.toLowerCase() : null;

  // NOTE: persistent hide — items stay hidden across reloads (user can unhide via 'Show Hidden')

  console.log('[PAY:history] Loading history for wallet:', walletKey || 'NONE');

  // No wallet = clear everything and show connect prompt
  if (!walletKey) {
    payState.history   = [];
    payState.scheduled = [];
    console.log('[PAY:history] No wallet connected — cleared history');
    renderPaymentHistory();
    return walletKey;
  }

  // Try IndexedDB first (wallet-scoped via stored sender field)
  if (typeof arcLoad === 'function') {
    try {
      console.log('[PAY:history] Trying IndexedDB store:', window.ARC_STORE_PAY || 'payments');
      const items = await arcLoad(window.ARC_STORE_PAY || 'payments');

      // Guard: verify wallet hasn't changed while we awaited
      const currentWallet = window.walletState?.address?.toLowerCase();
      if (currentWallet !== walletKey) {
        console.warn('[PAY:history] Wallet changed during IndexedDB load — discarding stale result');
        return walletKey;
      }

      if (items && items.length > 0) {
        console.log('[PAY:history] IndexedDB returned', items.length, 'total items');

        // Filter strictly by wallet address — only include records that match this wallet
        // Legacy items (no address field) are NOT shown to avoid cross-wallet data leakage
        const myItems = items.filter(r => {
          if (!r) return false;
          const addr = (r.sender || r.from || r.wallet || '').toLowerCase();
          // Only include if address exactly matches current wallet (never show legacy/unowned records)
          return addr === walletKey;
        });
        console.log('[PAY:history] After wallet filter:', myItems.length, 'records for', walletKey);

        // If we have items in IndexedDB but NONE match this wallet, fall through to localStorage
        if (myItems.length === 0 && items.length > 0) {
          console.log('[PAY:history] No IndexedDB records for this wallet — trying localStorage');
          // Fall through to localStorage section below
        } else {

        const completed = myItems.filter(r =>
          r.status === 'completed' || r.status === 'confirmed' || r.status === 'failed'
        );
        const scheduled = myItems.filter(r =>
          r.status === 'scheduled' || r.status === 'processing'
        );
        payState.history = completed;

        if (scheduled.length > 0) {
          const lsScheduled = payLoadScheduled();
          const lsIds = new Set(lsScheduled.map(j => j.id));
          const newSched = scheduled.filter(j => !lsIds.has(j.id));
          if (newSched.length > 0) paySaveScheduled([...lsScheduled, ...newSched]);
        }
        console.log('[PAY:history] Loaded', completed.length, 'completed records from IndexedDB for', walletKey);
        return walletKey;
        } // end of myItems.length > 0 block
      } else {
        console.log('[PAY:history] IndexedDB empty — falling back to localStorage');
      }
    } catch (e) {
      console.warn('[PAY:history] IndexedDB load failed:', e.message, '— falling back to localStorage');
    }
  }

  // Fallback to localStorage (also wallet-scoped by key)
  try {
    // Try wallet-specific key first
    const walletSpecificKey = `arc_pay_history_${walletKey}`;
    let raw = JSON.parse(localStorage.getItem(walletSpecificKey) || 'null');

    if (!raw) {
      // Fall back to global key, but filter strictly by wallet to avoid cross-wallet leakage
      const globalRaw = JSON.parse(localStorage.getItem('arc_pay_history') || '[]');
      raw = Array.isArray(globalRaw)
        ? globalRaw.filter(r => {
            if (!r) return false;
            const addr = (r.sender || r.from || r.wallet || '').toLowerCase();
            // Strict wallet match — skip legacy unowned records
            return addr === walletKey;
          })
        : [];
      console.log('[PAY:history] Global localStorage returned', raw.length, 'wallet-filtered records');
    }

    // Guard: verify wallet hasn't changed while we awaited
    const currentWallet = window.walletState?.address?.toLowerCase();
    if (currentWallet !== walletKey) {
      console.warn('[PAY:history] Wallet changed during localStorage load — discarding stale result');
      return walletKey;
    }

    payState.history = Array.isArray(raw) ? raw : [];
    console.log('[PAY:history] Loaded', payState.history.length, 'records from localStorage for', walletKey);
  } catch (err) {
    console.error('[PAY:history] localStorage load error:', err.message);
    payState.history = [];
  }

  return walletKey;
}

// ─── Background sync handler ─────────────────────────────────────────────────
window.addEventListener('arcSyncRequest', async (e) => {
  const currentWallet = window.walletState?.address;
  if (!currentWallet) {
    console.log('[PAY:sync] Skipped — no wallet connected');
    return;
  }
  console.log('[PAY:sync] arcSyncRequest received for', shortAddr(currentWallet));
  try {
    await payLoadLocalHistory();
  } catch (err) {
    console.warn('[PAY:sync] history reload failed:', err.message);
  }
  renderPaymentHistory();
  console.log('[PAY:sync] History refreshed for', shortAddr(currentWallet));
});

// ─── Init ──────────────────────────────────────────────────────────────────────
let _payInitialized = false;

async function initPayments() {
  const initWallet = window.walletState?.address;
  console.log('[PAY:init] Initialising Payments module. Wallet:', initWallet || 'not connected');

  // Only do full init once — subsequent calls just refresh
  if (_payInitialized) {
    console.log('[PAY:init] Already initialized — refreshing data only');
    try { await refreshPaymentBalances(); } catch (e) { console.warn('[PAY:init] balance refresh:', e.message); }
    renderPaymentHistory();
    return;
  }
  _payInitialized = true;

  // Seed last-wallet tracker so first walletConnected event is treated as "new wallet"
  // only if address is actually different from what we'll load now
  _payLastWallet = initWallet?.toLowerCase?.() || null;
  _payWalletChangeToken = 0;

  // Load history only if wallet is available; otherwise show empty state silently
  try {
    await payLoadLocalHistory();
    console.log('[PAY:init] History loaded:', payState.history.length, 'records');
    // Dispatch event so smart-autofill can learn from existing history
    window.dispatchEvent(new CustomEvent('arcPayHistoryLoaded', { detail: { items: payState.history } }));
  } catch (e) {
    console.error('[PAY:init] History load error (non-fatal):', e.message);
    payState.history = [];
  }

  // Init smart autofill for Payments tab
  if (typeof arcInitPayAutofill === 'function') setTimeout(arcInitPayAutofill, 300);

  payInitTimezones();
  selectPayToken(payState.token || 'USDC');
  updatePayPreview();
  payValidateForm();
  payUpdateNoteCounter();

  // Refresh balances — fails silently when wallet is not connected
  try {
    await refreshPaymentBalances();
    console.log('[PAY:init] Balances refreshed');
  } catch (e) {
    console.warn('[PAY:init] Balance refresh failed (non-fatal):', e.message);
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

  console.log('[PAY v3] Init complete · Arc Testnet ChainID:', PAY_CHAIN_ID);
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

// ─── Export payments history as CSV ─────────────────────────────────────────────
function _payExportCSV() {
  const scheduled = payLoadScheduled();
  const history   = payState.history || [];
  const all = [...scheduled.map(s => ({ ...s, _source: 'scheduled' })), ...history.map(h => ({ ...h, _source: 'history' }))];
  if (!all.length) { showToast('No transactions to export', 'warning'); return; }

  const headers = ['Status', 'Token', 'Amount', 'Sender', 'Recipient', 'Date', 'TX Hash', 'Network', 'Type', 'Note'];
  const rows = all.map(r => [
    r.status || '',
    r.token || '',
    r.amount != null ? Number(r.amount).toFixed(6) : '',
    r.sender || r.from || '',
    r.recipient || r.to || '',
    r.scheduledAt || r.timestamp || r.createdAt || '',
    r.txHash || '',
    r.network || r.chainName || 'Arc Testnet',
    r.payType || r.type || (r.status === 'scheduled' ? 'Scheduled' : 'Direct'),
    r.note || '',
  ]);
  const csvContent = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href     = url;
  link.download = `execdaat-payments-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
  showToast('Payment history exported as CSV', 'success');
}
window._payExportCSV = _payExportCSV;

// ─── Wallet event listeners ────────────────────────────────────────────────────

// Track the last wallet address to detect actual changes
let _payLastWallet = null;
// Request token to prevent race conditions when wallet changes quickly
let _payWalletChangeToken = 0;

async function _payOnWalletChange(newAddr) {
  const addr = newAddr?.toLowerCase?.() || null;
  const token = ++_payWalletChangeToken; // Unique token for this change event

  console.log('[PAY:wallet] Change detected →', addr || 'disconnected', '| token:', token);

  // Detect actual wallet switch (not just event noise)
  if (addr && addr === _payLastWallet) {
    console.log('[PAY:wallet] Same wallet — refreshing balances only');
    try { await refreshPaymentBalances(); } catch (e) { console.warn('[PAY:wallet] balance refresh err:', e.message); }
    updatePayPreview();
    payValidateForm();
    return;
  }

  // Wallet changed (new address or disconnected)
  _payLastWallet = addr;

  // Reset ALL stale data immediately
  payState.history   = [];
  payState.scheduled = [];
  payState.senderBalance = { USDC: null, EURC: null };
  payState.receipt   = null;
  hidePayError();

  // Update UI to reflect loading state
  if (addr) {
    paySet('pay-from-display', shortAddr(newAddr));
    paySet('pay-wallet-short', shortAddr(newAddr));
    paySet('pay-balance-usdc', '…');
    paySet('pay-balance-eurc', '…');
  } else {
    paySet('pay-from-display', '—');
    paySet('pay-wallet-short', 'Not connected');
    paySet('pay-balance-usdc', '— USDC');
    paySet('pay-balance-eurc', '— EURC');
  }

  // Render empty/loading state immediately (prevents showing stale data)
  renderPaymentHistory();

  if (!addr) {
    console.log('[PAY:wallet] Disconnected — cleared all state');
    payValidateForm();
    return;
  }

  // Load fresh data for this wallet
  try {
    console.log('[PAY:wallet] Loading history for new wallet:', addr);
    await payLoadLocalHistory();

    // RACE CONDITION CHECK: if wallet changed again while we were loading, discard
    if (token !== _payWalletChangeToken) {
      console.warn('[PAY:wallet] Stale result discarded — token', token, '!= current', _payWalletChangeToken);
      return;
    }

    console.log('[PAY:wallet] History loaded:', payState.history.length, 'records');
  } catch (e) {
    if (token !== _payWalletChangeToken) return; // stale
    console.warn('[PAY:wallet] history load error:', e.message);
    payState.history = [];
  }

  // Refresh balances
  try {
    await refreshPaymentBalances();
    if (token !== _payWalletChangeToken) return; // stale
  } catch (e) {
    if (token !== _payWalletChangeToken) return;
    console.warn('[PAY:wallet] balance refresh error:', e.message);
  }

  updatePayPreview();
  payValidateForm();
  renderPaymentHistory();
  console.log('[PAY:wallet] Wallet change complete for', addr);
}

window.addEventListener('walletConnected', async (e) => {
  const addr = e.detail?.address;
  console.log('[PAY] walletConnected event →', addr);
  await _payOnWalletChange(addr);
});

window.addEventListener('accountsChanged', async (e) => {
  // accountsChanged fires with new accounts array or single address
  const newAddr = Array.isArray(e.detail) ? e.detail[0]
    : (e.detail?.address || window.walletState?.address || null);
  console.log('[PAY] accountsChanged event →', newAddr);
  await _payOnWalletChange(newAddr || null);
});

window.addEventListener('walletDisconnected', async () => {
  console.log('[PAY] walletDisconnected event → clearing all state');
  await _payOnWalletChange(null);
});

// ─── Boot log ──────────────────────────────────────────────────────────────────
console.log('[PAY v4] Payments module loaded — Arc Testnet ChainID:', PAY_CHAIN_ID);
console.log('[PAY v4] Features: Fee Transparency · Gas Oracle · Multi-Token · Gov Tax · ENS · KYC · TX Pipeline · Receipts++');

// ─── Expose new functions to window ──────────────────────────────────────────
window.paySelectGasTier    = paySelectGasTier;
window.payResolveENS       = payResolveENS;
window.payUpdateGasEstimate = payUpdateGasEstimate;
window.payDecodeError      = payDecodeError;
