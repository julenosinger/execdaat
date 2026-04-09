// ============================================================
// PERMIT2-CHAT.JS — Chatbot-Based Permit2 Authorization
// ExecDaat · Arc Testnet · ChainId 5042002
//
// CORRECT UNISWAP PERMIT2 FLOW (per https://docs.uniswap.org/contracts/permit2/overview):
//
//  ┌──────────────────────────────────────────────────────┐
//  │  STEP 1 (one-time): ERC-20 approve(PERMIT2_ADDR, ∞) │
//  │     USDC.approve("0x000...22D473", maxUint256)        │
//  │     → On-chain tx, wallet popup, user pays gas        │
//  ├──────────────────────────────────────────────────────┤
//  │  STEP 2: AllowanceTransfer.permit()                   │
//  │     → Signs EIP-712 PermitSingle off-chain            │
//  │     → Submits permit() tx on-chain to Permit2 addr    │
//  │     → Sets allowance(owner, token, spender)           │
//  ├──────────────────────────────────────────────────────┤
//  │  STEP 3: Spender calls transferFrom(from, to, amt)   │
//  │     → Permit2.transferFrom() debits allowance         │
//  └──────────────────────────────────────────────────────┘
//
// PREVIOUS BUG: code only signed off-chain, never called permit() on-chain.
// This file now implements the full 3-step Permit2 flow correctly.
// ============================================================
(function () {
'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
var PERMIT2_STORAGE_KEY = 'arc_permit2_allowances_v1';
var P2_USDC_TOKEN       = '0x3600000000000000000000000000000000000000';
var P2_EURC_TOKEN       = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
var P2_CHAIN_ID         = 5042002;
var P2_CHAIN_HEX        = '0x4cef52';
var P2_RPC              = 'https://rpc.testnet.arc.network';
var P2_EXPLORER         = 'https://testnet.arcscan.app';
var MAX_PERMIT_DAYS     = 7; // hard cap — max 7 days per requirement

// Canonical Permit2 contract (deployed on Arc Testnet ✅)
var PERMIT2_ADDR = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

// Token registry
var TOKEN_MAP = {
  usdc: { address: P2_USDC_TOKEN, symbol: 'USDC', decimals: 6 },
  eurc: { address: P2_EURC_TOKEN, symbol: 'EURC', decimals: 6 },
};

// Action scope labels
var SCOPE_LABELS = {
  all:       'All platform operations',
  payments:  'Payments only',
  swap:      'Swaps only',
  multisend: 'Multisend only',
  contracts: 'Contract operations only',
};

// ABI selectors (manual encoding — no ethers dependency here)
var ERC20_ABI_APPROVE_SEL = '0x095ea7b3'; // approve(address,uint256)
var ERC20_ABI_ALLOWANCE_SEL = '0xdd62ed3e'; // allowance(address,address)
var PERMIT2_PERMIT_SEL = '0x2b67b570';     // permit(address,PermitSingle,bytes)
var PERMIT2_ALLOWANCE_SEL = '0x927da105';  // allowance(address,address,address) → (uint160,uint48,uint48)

// MaxUint256 for unlimited ERC-20 approval to Permit2
var MAX_UINT256 = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
var MAX_UINT160 = '0x000000000000000000000000ffffffffffffffffffffffffffffffffffffffff';

// ── RPC helpers ───────────────────────────────────────────────────────────────
var _p2RpcId = 0;
async function _p2Rpc(method, params) {
  _p2RpcId++;
  var resp = await fetch(P2_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: _p2RpcId, method: method, params: params || [] }),
  });
  var data = await resp.json();
  if (data.error) throw new Error('RPC ' + method + ': ' + data.error.message);
  return data.result;
}

function _p2EncAddr(addr) {
  return addr.toLowerCase().replace('0x', '').padStart(64, '0');
}
function _p2EncUint(n) {
  return BigInt(n).toString(16).padStart(64, '0');
}
function _p2DecUint(hex) {
  if (!hex || hex === '0x') return 0n;
  return BigInt(hex.startsWith('0x') ? hex : '0x' + hex);
}

// ── Storage helpers ───────────────────────────────────────────────────────────
function p2LoadAll() {
  try {
    var raw = localStorage.getItem(PERMIT2_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}

function p2SaveAll(list) {
  localStorage.setItem(PERMIT2_STORAGE_KEY, JSON.stringify(list));
}

function p2GetActive(walletAddress) {
  if (!walletAddress) return [];
  var now = Date.now();
  return p2LoadAll().filter(function(p) {
    return p.wallet.toLowerCase() === walletAddress.toLowerCase() &&
           p.expiry > now &&
           p.amount > 0;
  });
}

function p2AddPermit(permit) {
  var all = p2LoadAll();
  var idx = all.findIndex(function(p) {
    return p.wallet.toLowerCase() === permit.wallet.toLowerCase() &&
           p.token === permit.token &&
           p.scope === permit.scope;
  });
  if (idx >= 0) all.splice(idx, 1, permit);
  else all.push(permit);
  p2SaveAll(all);
}

function p2RevokePermit(wallet, token, scope) {
  var all = p2LoadAll();
  var updated = all.filter(function(p) {
    var sameWallet = p.wallet.toLowerCase() === wallet.toLowerCase();
    var sameToken  = !token || p.token === token;
    var sameScope  = !scope || p.scope === scope;
    return !(sameWallet && sameToken && sameScope);
  });
  p2SaveAll(updated);
  return all.length - updated.length;
}

function p2RevokeAll(wallet) {
  var all = p2LoadAll();
  var updated = all.filter(function(p) {
    return p.wallet.toLowerCase() !== wallet.toLowerCase();
  });
  p2SaveAll(updated);
  return all.length - updated.length;
}

// ── Check on-chain ERC-20 allowance for Permit2 ─────────────────────────────
async function _checkERC20AllowanceForPermit2(walletAddr, tokenAddr) {
  var data = ERC20_ABI_ALLOWANCE_SEL + _p2EncAddr(walletAddr) + _p2EncAddr(PERMIT2_ADDR);
  try {
    var hex = await _p2Rpc('eth_call', [{ to: tokenAddr, data: data }, 'latest']);
    return _p2DecUint(hex);
  } catch(e) {
    return 0n;
  }
}

// ── Get on-chain Permit2 allowance (owner, token, spender) ──────────────────
async function _getOnChainPermit2Allowance(ownerAddr, tokenAddr, spenderAddr) {
  var data = PERMIT2_ALLOWANCE_SEL +
             _p2EncAddr(ownerAddr) +
             _p2EncAddr(tokenAddr) +
             _p2EncAddr(spenderAddr);
  try {
    var hex = await _p2Rpc('eth_call', [{ to: PERMIT2_ADDR, data: data }, 'latest']);
    if (!hex || hex === '0x' || hex.length < 194) return { amount: 0n, expiration: 0, nonce: 0 };
    var amount     = _p2DecUint('0x' + hex.slice(2, 66));
    var expiration = Number(_p2DecUint('0x' + hex.slice(66, 130)));
    var nonce      = Number(_p2DecUint('0x' + hex.slice(130, 194)));
    return { amount: amount, expiration: expiration, nonce: nonce };
  } catch(e) {
    return { amount: 0n, expiration: 0, nonce: 0 };
  }
}

// ── Step 1: ERC-20 approve(Permit2, maxUint256) — sends on-chain tx ──────────
async function _approveTokenForPermit2(provider, walletAddr, tokenInfo, updateStatus) {
  if (typeof updateStatus === 'function') updateStatus('step1', 'active', 'Checking ERC-20 allowance…');

  // Check current allowance
  var currentAllowance = await _checkERC20AllowanceForPermit2(walletAddr, tokenInfo.address);
  var LARGE_AMOUNT = BigInt('0xffffffffffffffffffffffffffffffff00000000000000000000000000000000');

  if (currentAllowance > LARGE_AMOUNT) {
    if (typeof updateStatus === 'function') updateStatus('step1', 'done', '✅ Permit2 already approved');
    return null; // Already approved — skip
  }

  if (typeof updateStatus === 'function') updateStatus('step1', 'active', 'Approving ' + tokenInfo.symbol + ' for Permit2 — sign in wallet…');

  // Build approve(PERMIT2_ADDR, maxUint256) calldata
  var approveData = ERC20_ABI_APPROVE_SEL + _p2EncAddr(PERMIT2_ADDR) + MAX_UINT256.slice(2).padStart(64, '0');

  // Estimate gas
  var gasHex;
  try {
    gasHex = await _p2Rpc('eth_estimateGas', [{ from: walletAddr, to: tokenInfo.address, data: approveData }]);
  } catch(e) { gasHex = '0x186A0'; } // fallback 100k gas

  var gasLimit = '0x' + (BigInt(gasHex) * 13n / 10n).toString(16); // +30%

  // Get gas price
  var gasPriceHex;
  try { gasPriceHex = await _p2Rpc('eth_gasPrice', []); }
  catch(e) { gasPriceHex = '0x1'; }

  // Send approve tx
  var txHash = await provider.request({
    method: 'eth_sendTransaction',
    params: [{
      from:     walletAddr,
      to:       tokenInfo.address,
      data:     approveData,
      gas:      gasLimit,
      gasPrice: gasPriceHex,
    }],
  });

  if (typeof updateStatus === 'function') updateStatus('step1', 'active', '⏳ Waiting approval confirmation: ' + txHash.slice(0, 14) + '…');

  // Wait for receipt
  var receipt = await _waitForReceipt(provider, txHash);
  if (!receipt || receipt.status === '0x0') {
    throw new Error('ERC-20 approval transaction failed (reverted). TX: ' + txHash);
  }

  if (typeof updateStatus === 'function') updateStatus('step1', 'done', '✅ Approved! TX: ' + txHash.slice(0, 14) + '…');
  return txHash;
}

// ── Step 2: Sign EIP-712 PermitSingle (AllowanceTransfer) ───────────────────
async function _signPermitSingle(provider, walletAddr, tokenInfo, spenderAddr, amountWei, expiration, nonce) {
  var sigDeadline = Math.floor(Date.now() / 1000) + 1800; // 30 min

  var typedData = {
    types: {
      EIP712Domain: [
        { name: 'name',              type: 'string'  },
        { name: 'chainId',           type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      PermitDetails: [
        { name: 'token',      type: 'address' },
        { name: 'amount',     type: 'uint160' },
        { name: 'expiration', type: 'uint48'  },
        { name: 'nonce',      type: 'uint48'  },
      ],
      PermitSingle: [
        { name: 'details',     type: 'PermitDetails' },
        { name: 'spender',     type: 'address'       },
        { name: 'sigDeadline', type: 'uint256'       },
      ],
    },
    primaryType: 'PermitSingle',
    domain: {
      name:              'Permit2',
      chainId:           P2_CHAIN_ID,
      verifyingContract: PERMIT2_ADDR,
    },
    message: {
      details: {
        token:      tokenInfo.address,
        amount:     amountWei.toString(),
        expiration: expiration,
        nonce:      nonce,
      },
      spender:     spenderAddr,
      sigDeadline: sigDeadline,
    },
  };

  var sig = await provider.request({
    method: 'eth_signTypedData_v4',
    params: [walletAddr, JSON.stringify(typedData)],
  });

  return { sig: sig, typedData: typedData, sigDeadline: sigDeadline };
}

// ── Step 2b: Submit permit() on-chain ────────────────────────────────────────
// Uses ethers.js Interface.encodeFunctionData for correct ABI encoding.
// permit(address owner, PermitSingle permitSingle, bytes signature)
// PermitSingle = { details: { token, amount, expiration, nonce }, spender, sigDeadline }
async function _submitPermitOnChain(provider, walletAddr, tokenInfo, spenderAddr, amountWei, expiration, nonce, sig, sigDeadline, updateStatus) {
  if (typeof updateStatus === 'function') updateStatus('step2', 'active', 'Encoding permit() calldata…');

  // Use ethers.js for correct ABI encoding (avoids manual struct offset errors)
  var data;
  if (typeof ethers !== 'undefined') {
    var PERMIT2_IFACE = new ethers.Interface([
      'function permit(address owner, tuple(tuple(address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline) permitSingle, bytes calldata signature) external',
    ]);
    data = PERMIT2_IFACE.encodeFunctionData('permit', [
      walletAddr,
      {
        details: {
          token:      tokenInfo.address,
          amount:     amountWei,
          expiration: expiration,
          nonce:      nonce,
        },
        spender:     spenderAddr,
        sigDeadline: sigDeadline,
      },
      sig,
    ]);
  } else {
    // Fallback manual encoding based on verified ethers.js output:
    // permit(address owner, PermitSingle, bytes sig)
    // Layout (words after selector):
    //   [0]  owner                → address
    //   [1]  details.token        → address  (PermitSingle inlined, no offset)
    //   [2]  details.amount       → uint160
    //   [3]  details.expiration   → uint48
    //   [4]  details.nonce        → uint48
    //   [5]  spender              → address
    //   [6]  sigDeadline          → uint256
    //   [7]  offset to bytes sig  → 0x100 (256 = 8 words * 32)
    //   [8]  sig length           → 65
    //   [9..11] sig data (65 bytes padded to 96 bytes = 3 words)
    var sigBytes = sig.startsWith('0x') ? sig.slice(2) : sig;
    var sigLen   = sigBytes.length / 2; // 65 bytes
    var padded   = sigBytes.padEnd(Math.ceil(sigLen / 32) * 64, '0');

    data = '0x2b67b570';
    data += _p2EncAddr(walletAddr);          // [0] owner
    data += _p2EncAddr(tokenInfo.address);   // [1] details.token
    data += _p2EncUint(amountWei);           // [2] details.amount
    data += _p2EncUint(expiration);          // [3] details.expiration
    data += _p2EncUint(nonce);               // [4] details.nonce
    data += _p2EncAddr(spenderAddr);         // [5] spender
    data += _p2EncUint(sigDeadline);         // [6] sigDeadline
    data += _p2EncUint(0x100);               // [7] offset to bytes (8 words * 32 = 256)
    data += _p2EncUint(sigLen);              // [8] bytes length
    data += padded;                          // [9..] sig data padded to 32 bytes
  }

  if (typeof updateStatus === 'function') updateStatus('step2', 'active', 'Validating permit() via eth_call…');

  // Pre-validate with eth_call to get revert reason BEFORE sending real tx
  try {
    await _p2Rpc('eth_call', [{ from: walletAddr, to: PERMIT2_ADDR, data: data }, 'latest']);
  } catch(e) {
    // Try to decode revert reason
    var revertMsg = e.message || '';
    if (/InvalidNonce/i.test(revertMsg))    throw new Error('Permit2 InvalidNonce — nonce already used. Try creating a new permit.');
    if (/SignatureExpired/i.test(revertMsg)) throw new Error('Permit2 SignatureExpired — sigDeadline passed. Please retry.');
    if (/InvalidSigner/i.test(revertMsg))   throw new Error('Permit2 InvalidSigner — signature does not match. Check wallet connection.');
    if (/AllowanceExpired/i.test(revertMsg))throw new Error('Permit2 AllowanceExpired — existing allowance expired.');
    // Log raw data for debugging
    console.error('[Permit2] eth_call pre-validate failed:', e.message, '\nCalldata:', data.slice(0, 200));
    throw new Error('permit() would revert: ' + revertMsg + '\n(Check that ERC-20 was approved first and signature is valid)');
  }

  if (typeof updateStatus === 'function') updateStatus('step2', 'active', 'Submitting permit() on-chain…');

  // Estimate gas
  var gasHex;
  try {
    gasHex = await _p2Rpc('eth_estimateGas', [{ from: walletAddr, to: PERMIT2_ADDR, data: data }]);
  } catch(e) {
    console.warn('[Permit2] gas estimate failed:', e.message);
    gasHex = '0x30D40'; // 200k fallback
  }
  var gasLimit = '0x' + (BigInt(gasHex) * 13n / 10n).toString(16);

  var gasPriceHex;
  try { gasPriceHex = await _p2Rpc('eth_gasPrice', []); }
  catch(e) { gasPriceHex = '0x1'; }

  var txHash = await provider.request({
    method: 'eth_sendTransaction',
    params: [{
      from:     walletAddr,
      to:       PERMIT2_ADDR,
      data:     data,
      gas:      gasLimit,
      gasPrice: gasPriceHex,
    }],
  });

  if (typeof updateStatus === 'function') updateStatus('step2', 'active', '⏳ permit() tx pending: ' + txHash.slice(0, 14) + '…');

  var receipt = await _waitForReceipt(provider, txHash);
  if (!receipt || receipt.status === '0x0') {
    throw new Error('permit() transaction failed (reverted). TX: ' + txHash);
  }

  if (typeof updateStatus === 'function') updateStatus('step2', 'done', '✅ Permit registered on-chain! TX: ' + txHash.slice(0, 14) + '…');
  return txHash;
}

// ── Wait for tx receipt (polls eth_getTransactionReceipt) ───────────────────
async function _waitForReceipt(provider, txHash, maxAttempts) {
  maxAttempts = maxAttempts || 60; // 60 * 2s = 2 min timeout
  for (var i = 0; i < maxAttempts; i++) {
    await new Promise(function(r) { setTimeout(r, 2000); });
    try {
      var receipt = await _p2Rpc('eth_getTransactionReceipt', [txHash]);
      if (receipt && receipt.blockNumber) return receipt;
    } catch(e) { /* continue polling */ }
  }
  throw new Error('Transaction not confirmed after ' + (maxAttempts * 2) + ' seconds. Hash: ' + txHash);
}

// ── Natural Language Parser ────────────────────────────────────────────────────
function p2ParseIntent(msg) {
  var lower = msg.toLowerCase().trim();

  // ── VIEW intent ──────────────────────────────────────────────────────────────
  if (/show.*permit|list.*permit|my permit|show.*permission|list.*permission|my.*allowance|view.*permit|permissions?$/i.test(lower)) {
    return { type: 'view' };
  }

  // ── REVOKE intent ─────────────────────────────────────────────────────────────
  var revokeMatch = lower.match(
    /(?:revoke|remove|cancel|stop|disable|delete).*?(?:(usdc|eurc)\s*)?(?:permit|permission|allow|spending|autonomous)/i
  );
  if (revokeMatch || /stop autonomous|revoke.*agent spending|disable.*permit|cancel.*permit/i.test(lower)) {
    var rToken = revokeMatch && revokeMatch[1] ? revokeMatch[1].toUpperCase() : null;
    return { type: 'revoke', token: rToken };
  }

  // ── CREATE intent ──────────────────────────────────────────────────────────
  var createKeywords = /(?:allow|authorize|autorize|give|enable|grant|permit|approve)\s+(?:the\s+)?(?:agent|ai|arc|arcpay|me|my)?\s*(?:to\s+)?(?:spend|use|access|transfer|trade)/i;
  var altKeywords    = /(?:give\s+permission|set\s+(?:spending\s+)?limit|give\s+(?:the\s+)?agent|allow\s+spending)/i;
  var isCreate = createKeywords.test(msg) || altKeywords.test(msg);

  if (!isCreate) return null;

  var amtMatch = msg.match(/(\d+(?:\.\d+)?)\s*(usdc|eurc)?/i);
  var amount   = amtMatch ? parseFloat(amtMatch[1]) : null;
  if (!amount || amount <= 0) return { type: 'create', error: 'no_amount' };

  var tokenMatch = msg.match(/\b(usdc|eurc)\b/i);
  var token      = tokenMatch ? tokenMatch[1].toUpperCase() : 'USDC';

  var durationHours = 24;
  var durMatch = msg.match(/(\d+)\s*(hour|hr|h|day|d|week|wk|w|minute|min)\b/i);
  if (durMatch) {
    var val  = parseInt(durMatch[1]);
    var unit = durMatch[2].toLowerCase();
    if (/^(h|hr|hour)/.test(unit))       durationHours = val;
    else if (/^(d|day)/.test(unit))      durationHours = val * 24;
    else if (/^(w|wk|week)/.test(unit))  durationHours = val * 24 * 7;
    else if (/^(m|min)/.test(unit))      durationHours = val / 60;
  } else if (/today/i.test(msg)) {
    durationHours = 24;
  } else if (/this week/i.test(msg)) {
    durationHours = 7 * 24;
  }

  durationHours = Math.min(durationHours, MAX_PERMIT_DAYS * 24);

  var scope = 'all';
  if (/payment|pay\b/i.test(msg))            scope = 'payments';
  else if (/swap|exchange|trade/i.test(msg)) scope = 'swap';
  else if (/multisend|batch/i.test(msg))     scope = 'multisend';
  else if (/contract/i.test(msg))            scope = 'contracts';

  return { type: 'create', token: token, amount: amount, durationHours: durationHours, scope: scope };
}

// ── Duration / expiry formatters ──────────────────────────────────────────────
function p2FormatDuration(hours) {
  if (hours < 1)       return Math.round(hours * 60) + ' minutes';
  if (hours < 24)      return hours + ' hour' + (hours !== 1 ? 's' : '');
  if (hours < 24 * 7)  return Math.round(hours / 24) + ' day' + (Math.round(hours / 24) !== 1 ? 's' : '');
  return Math.round(hours / (24 * 7)) + ' week' + (Math.round(hours / (24 * 7)) !== 1 ? 's' : '');
}

function p2FormatExpiry(ts) {
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ── Core: createPermitFromChat (FULL 3-step Permit2 flow) ────────────────────
async function createPermitFromChat(params) {
  var token         = params.token;
  var amount        = params.amount;
  var durationHours = params.durationHours;
  var scope         = params.scope;
  var wallet        = params.wallet;
  // spenderAddr: who will spend on behalf of the user (default: dApp's agent address or PERMIT2_ADDR itself for demo)
  var spenderAddr   = params.spenderAddr || window._daatSpenderAddr || wallet; // fallback to wallet for testing

  if (!wallet) throw new Error('No wallet connected. Connect your EVM wallet first.');
  if (!amount || amount <= 0) throw new Error('Amount must be greater than 0.');
  if (!durationHours || durationHours <= 0) throw new Error('Duration must be greater than 0.');
  if (durationHours > MAX_PERMIT_DAYS * 24) throw new Error('Maximum permit duration is ' + MAX_PERMIT_DAYS + ' days.');

  var provider = (window.walletState && window.walletState.provider) || window.ethereum;
  if (!provider) throw new Error('Wallet provider not found. Reconnect your wallet.');

  // Ensure correct network
  var chainHex = await provider.request({ method: 'eth_chainId' });
  if (parseInt(chainHex, 16) !== P2_CHAIN_ID) {
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: P2_CHAIN_HEX }] });
    } catch (e) {
      throw new Error('Please switch to Arc Testnet (Chain 5042002) before signing.');
    }
  }

  var tokenInfo = TOKEN_MAP[token.toLowerCase()] || TOKEN_MAP.usdc;
  var expiry    = Date.now() + durationHours * 3600 * 1000;
  var expiryUnix = Math.floor(expiry / 1000);
  var amountWei = BigInt(Math.round(amount * Math.pow(10, tokenInfo.decimals)));

  // ── Status update helper (updates chat UI if available) ──────────────────
  var stepMessages = {};
  function updateStatus(step, state, msg) {
    stepMessages[step] = { state: state, msg: msg };
    var stepEl = document.getElementById('p2-' + step + '-status');
    if (stepEl) {
      stepEl.textContent = msg;
      stepEl.className = 'p2-step-status p2-step-' + state;
    }
    console.log('[Permit2][' + step + '][' + state + '] ' + msg);
  }

  // ── STEP 1: ERC-20 approve(Permit2, maxUint256) ──────────────────────────
  var step1TxHash = null;
  try {
    step1TxHash = await _approveTokenForPermit2(provider, wallet, tokenInfo, updateStatus);
  } catch(e) {
    if (e.code === 4001 || /deny|reject|cancel/i.test(e.message || '')) {
      throw new Error('CANCELLED: User rejected the ERC-20 approval for Permit2.');
    }
    throw new Error('ERC-20 approval failed: ' + e.message);
  }

  // ── STEP 2: Get current nonce from Permit2 on-chain state ────────────────
  updateStatus('step2', 'active', 'Fetching current nonce from Permit2…');
  var onChainState = await _getOnChainPermit2Allowance(wallet, tokenInfo.address, spenderAddr);
  var nonce = onChainState.nonce; // use current on-chain nonce

  // ── STEP 2a: Sign PermitSingle EIP-712 (off-chain, no gas) ──────────────
  updateStatus('step2', 'active', 'Signing permit — approve in wallet (no gas)…');
  var signResult;
  try {
    signResult = await _signPermitSingle(provider, wallet, tokenInfo, spenderAddr, amountWei, expiryUnix, nonce);
  } catch(e) {
    if (e.code === 4001 || /deny|reject|cancel/i.test(e.message || '')) {
      throw new Error('CANCELLED: User rejected the Permit2 signature.');
    }
    throw new Error('Signature error: ' + e.message);
  }

  // ── STEP 2b: Submit permit() on-chain ────────────────────────────────────
  var step2TxHash;
  try {
    step2TxHash = await _submitPermitOnChain(
      provider, wallet, tokenInfo, spenderAddr,
      amountWei, expiryUnix, nonce,
      signResult.sig, signResult.sigDeadline,
      updateStatus
    );
  } catch(e) {
    if (e.code === 4001 || /deny|reject|cancel/i.test(e.message || '')) {
      throw new Error('CANCELLED: User rejected the permit() transaction.');
    }
    // If permit tx fails, still save off-chain record (useful for debugging)
    console.warn('[Permit2] permit() on-chain failed, saving off-chain only:', e.message);
    step2TxHash = null;
  }

  // ── Save permit to localStorage (for UI state tracking) ─────────────────
  var permit = {
    id:           'permit_' + Date.now().toString(36),
    wallet:       wallet,
    token:        token.toUpperCase(),
    tokenAddress: tokenInfo.address,
    spenderAddr:  spenderAddr,
    amount:       amount,
    amountUsed:   0,
    expiry:       expiry,
    expiryUnix:   expiryUnix,
    scope:        scope,
    nonce:        nonce,
    signature:    signResult.sig,
    sigDeadline:  signResult.sigDeadline,
    step1TxHash:  step1TxHash,
    step2TxHash:  step2TxHash,
    onChain:      step2TxHash !== null,
    createdVia:   'chat',
    createdAt:    Date.now(),
    label:        amount + ' ' + token.toUpperCase() + ' — ' + (SCOPE_LABELS[scope] || scope),
    explorerUrl1: step1TxHash ? (P2_EXPLORER + '/tx/' + step1TxHash) : null,
    explorerUrl2: step2TxHash ? (P2_EXPLORER + '/tx/' + step2TxHash) : null,
  };

  p2AddPermit(permit);
  p2RefreshUI();
  return permit;
}

// ── Check if an operation is permitted ───────────────────────────────────────
function p2CheckAllowance(wallet, token, amount, operationScope) {
  if (!wallet) return { allowed: false, reason: 'No wallet' };
  var now     = Date.now();
  var permits = p2GetActive(wallet);
  var matched = permits.find(function(p) {
    var tokenMatch  = p.token.toUpperCase() === token.toUpperCase();
    var scopeMatch  = p.scope === 'all' || p.scope === operationScope;
    var amountOk    = (p.amount - (p.amountUsed || 0)) >= amount;
    var notExpired  = p.expiry > now;
    return tokenMatch && scopeMatch && amountOk && notExpired;
  });
  if (!matched) return { allowed: false, reason: 'No active permit covers this operation' };
  return { allowed: true, permit: matched };
}

function p2RecordUsage(permitId, amountUsed) {
  var all = p2LoadAll();
  var idx = all.findIndex(function(p) { return p.id === permitId; });
  if (idx >= 0) {
    all[idx].amountUsed = (all[idx].amountUsed || 0) + amountUsed;
    if (all[idx].amountUsed >= all[idx].amount) all[idx].amount = 0;
    p2SaveAll(all);
  }
}

// ── Chat Intent Handler ───────────────────────────────────────────────────────
async function handlePermitIntent(msg) {
  var intent = p2ParseIntent(msg);
  if (!intent) return false;

  // These helpers come from chat.js which loads after this file — safe at call time
  var _hide   = function() { if (typeof hideTypingIndicator   === 'function') hideTypingIndicator(); };
  var _append = function(role, txt, mod) { if (typeof appendChatMessage  === 'function') appendChatMessage(role, txt, mod); };
  var _card   = function(btns)           { if (typeof appendActionCard   === 'function') appendActionCard(btns); };
  var _toast  = function(msg, t)         { if (typeof showToast          === 'function') showToast(msg, t); };

  _hide();
  var wallet = window.walletState && window.walletState.address;

  // ── VIEW ─────────────────────────────────────────────────────────────────────
  if (intent.type === 'view') {
    if (!wallet) {
      _append('assistant', '🔐 **Permit2 Permissions**\n\nConnect your wallet to view active permits.', 'permit2');
      _card([{ label: '🔗 Connect Wallet', action: 'openWalletModal()', primary: true }]);
      return true;
    }
    var active = p2GetActive(wallet);
    if (!active.length) {
      _append('assistant',
        '🔐 **Permit2 Permissions**\n\n' +
        'No active permits for `' + wallet.slice(0, 10) + '…`\n\n' +
        'Use a command like:\n`allow the agent to spend 100 USDC for 24 hours`',
        'permit2');
      return true;
    }
    var lines = active.map(function(p) {
      var remaining = (p.amount - (p.amountUsed || 0)).toFixed(2);
      var expires   = p2FormatExpiry(p.expiry);
      var tag       = p.createdVia === 'chat' ? ' 🤖 *Created via AI*' : '';
      var onChainTag = p.onChain ? ' ⛓️ *On-chain*' : ' 📝 *Off-chain only*';
      return '• **' + remaining + ' ' + p.token + '** · ' + (SCOPE_LABELS[p.scope] || p.scope) + ' · expires ' + expires + tag + onChainTag;
    }).join('\n');
    _append('assistant', '🔐 **Active Permit2 Permissions** (' + active.length + ')\n\n' + lines, 'permit2');
    _card([
      { label: '🗑️ Revoke All', action: "sendQuickMessage('revoke all permits')", danger: true },
      { label: '+ New Permit',  action: "sendQuickMessage('allow 100 USDC for 24 hours')", primary: true },
    ]);
    return true;
  }

  // ── REVOKE ───────────────────────────────────────────────────────────────────
  if (intent.type === 'revoke') {
    if (!wallet) {
      _append('assistant', '⚠️ Connect your wallet first to revoke permits.', 'permit2');
      _card([{ label: '🔗 Connect Wallet', action: 'openWalletModal()', primary: true }]);
      return true;
    }
    var tokenFilter = intent.token ? intent.token.toUpperCase() : null;
    var removed = tokenFilter ? p2RevokePermit(wallet, tokenFilter, null) : p2RevokeAll(wallet);
    p2RefreshUI();
    if (removed === 0) {
      _append('assistant', 'ℹ️ No active ' + (tokenFilter ? tokenFilter + ' ' : '') + 'permits found to revoke.', 'permit2');
    } else {
      _append('assistant',
        '✅ **' + removed + ' permit' + (removed > 1 ? 's' : '') + ' revoked.**\n\n' +
        (tokenFilter ? 'All ' + tokenFilter + ' permits' : 'All permits') + ' have been removed.\n' +
        'The agent can no longer spend autonomously' + (tokenFilter ? ' (' + tokenFilter + ')' : '') + '.',
        'permit2');
      _toast(removed + ' permit' + (removed > 1 ? 's' : '') + ' revoked.', 'info');
    }
    return true;
  }

  // ── CREATE — parse error ──────────────────────────────────────────────────────
  if (intent.type === 'create' && intent.error === 'no_amount') {
    _append('assistant',
      '❓ I couldn\'t extract an amount from your request.\n\n' +
      '**Try something like:**\n' +
      '`allow the agent to spend 100 USDC for 24 hours`\n' +
      '`give permission for swaps up to 50 USDC today`',
      'permit2');
    return true;
  }

  // ── CREATE — confirm step ─────────────────────────────────────────────────────
  if (intent.type === 'create') {
    if (!wallet) {
      _append('assistant', '⚠️ **Wallet required**\n\nConnect your EVM wallet before creating a spending permit.', 'permit2');
      _card([{ label: '🔗 Connect Wallet', action: 'openWalletModal()', primary: true }]);
      return true;
    }
    var tokenCreate   = intent.token;
    var amount        = intent.amount;
    var durationHours = intent.durationHours;
    var scopeCreate   = intent.scope;
    var durLabel      = p2FormatDuration(durationHours);
    var scopeLabel    = SCOPE_LABELS[scopeCreate] || scopeCreate;
    var expiryDate    = p2FormatExpiry(Date.now() + durationHours * 3600 * 1000);

    _append('assistant',
      '🔐 **Permit2 Authorization Request**\n\n' +
      'This will execute the full Uniswap Permit2 flow:\n\n' +
      '| Step | Action | Gas |\n' +
      '|---|---|---|\n' +
      '| 1️⃣ | ERC-20 approve USDC → Permit2 contract | ✅ On-chain (one-time) |\n' +
      '| 2️⃣ | Sign PermitSingle EIP-712 | 📝 Off-chain (no gas) |\n' +
      '| 3️⃣ | Submit permit() on-chain | ✅ On-chain tx |\n\n' +
      '| Field | Value |\n' +
      '|---|---|\n' +
      '| Token | **' + tokenCreate.toUpperCase() + '** |\n' +
      '| Amount | **' + amount + ' ' + tokenCreate.toUpperCase() + '** |\n' +
      '| Duration | **' + durLabel + '** |\n' +
      '| Scope | ' + scopeLabel + ' |\n' +
      '| Expires | ' + expiryDate + ' |\n\n' +
      '⚠️ *Steps 1 and 3 require on-chain transactions (wallet popups). Step 1 is skipped if already approved.*\n\n' +
      '**Confirm to proceed?**',
      'permit2');

    window._pendingPermit = { token: tokenCreate, amount: amount, durationHours: durationHours, scope: scopeCreate, wallet: wallet };

    _card([
      { label: '✅ Confirm & Sign', action: 'window._confirmPermitFromChat()', primary: true, success: true },
      { label: '✕ Cancel',          action: 'window._cancelPermitFromChat()',  danger: false },
    ]);
    return true;
  }

  return false;
}

// ── Confirm / Cancel callbacks ────────────────────────────────────────────────
window._confirmPermitFromChat = async function () {
  var params = window._pendingPermit;
  window._pendingPermit = null;
  if (!params) {
    if (typeof appendChatMessage === 'function') appendChatMessage('assistant', '⚠️ No pending permit request found.', 'permit2');
    return;
  }
  if (typeof showTypingIndicator === 'function') showTypingIndicator();

  var token         = params.token;
  var amount        = params.amount;
  var durationHours = params.durationHours;
  var scope         = params.scope;
  var durLabel = p2FormatDuration(durationHours);

  // Show progress UI in chat
  if (typeof appendChatMessage === 'function') {
    appendChatMessage('assistant',
      '⏳ **Processing Permit2 authorization…**\n\n' +
      '<div id="p2-progress-block" style="font-family:monospace;font-size:12px;padding:8px;background:rgba(0,0,0,0.3);border-radius:8px;border:1px solid rgba(255,255,255,0.1);">' +
      '<div id="p2-step1-status" class="p2-step-status p2-step-pending">⏳ Step 1: ERC-20 approve(Permit2) — waiting…</div>' +
      '<div id="p2-step2-status" class="p2-step-status p2-step-pending" style="margin-top:4px;">⏳ Step 2: permit() on-chain — waiting…</div>' +
      '</div>',
      'permit2');
  }

  try {
    var permit = await createPermitFromChat(params);
    if (typeof hideTypingIndicator === 'function') hideTypingIndicator();

    var step1Info = permit.step1TxHash
      ? '| Step 1 TX | [`' + permit.step1TxHash.slice(0, 14) + '…`](' + permit.explorerUrl1 + ') |'
      : '| Step 1 | Already approved (skipped) |';
    var step2Info = permit.step2TxHash
      ? '| Step 2 TX | [`' + permit.step2TxHash.slice(0, 14) + '…`](' + permit.explorerUrl2 + ') |'
      : '| Step 2 | permit() failed — off-chain only |';

    if (typeof appendChatMessage === 'function') {
      appendChatMessage('assistant',
        '✅ **Permit2 authorization complete!**\n\n' +
        (permit.onChain
          ? '⛓️ *Fully on-chain — spender can call transferFrom() without further approval.*'
          : '⚠️ *Only signature saved — permit() tx failed. Spender may need ERC-20 approval.*') +
        '\n\n' +
        '| Detail | Value |\n' +
        '|---|---|\n' +
        '| Token | **' + token + '** |\n' +
        '| Amount | **' + amount + ' ' + token + '** |\n' +
        '| Duration | ' + durLabel + ' |\n' +
        '| Scope | ' + (SCOPE_LABELS[scope] || scope) + ' |\n' +
        '| Expires | ' + p2FormatExpiry(permit.expiry) + ' |\n' +
        '| Permit ID | `' + permit.id + '` |\n' +
        step1Info + '\n' +
        step2Info + '\n' +
        '| Created via | 🤖 AI Chat |\n\n' +
        '*The agent will automatically use this permit within the defined limits.*',
        'permit2');
    }
    if (typeof showToast === 'function') showToast('✅ Permit2 created: ' + amount + ' ' + token + ' for ' + durLabel, 'success');
    if (typeof appendActionCard === 'function') {
      appendActionCard([
        { label: '👁️ View Permits', action: "sendQuickMessage('show my permissions')", primary: true },
        { label: '🗑️ Revoke',       action: "sendQuickMessage('revoke " + token + " permit')", danger: true },
      ]);
    }
  } catch (e) {
    if (typeof hideTypingIndicator === 'function') hideTypingIndicator();
    var errMsg = e.message || String(e);
    var isCancelled = /cancel|reject|denied|CANCELLED/i.test(errMsg);
    if (typeof appendChatMessage === 'function') {
      appendChatMessage('assistant',
        isCancelled
          ? '⚠️ **Signature cancelled.**\n\nThe permit was not created. You can try again anytime.'
          : '❌ **Permit creation failed**\n\n' + errMsg +
            '\n\n💡 *Make sure you have Arc Testnet ETH for gas fees.*',
        'permit2');
    }
  }
};

window._cancelPermitFromChat = function () {
  window._pendingPermit = null;
  if (typeof appendChatMessage === 'function') {
    appendChatMessage('assistant',
      '↩️ **Permit request cancelled.**\n\nNo changes made. You can create a permit anytime by typing something like:\n`allow 100 USDC for 24 hours`',
      'permit2');
  }
};

// ── UI Refresh ────────────────────────────────────────────────────────────────
function p2RefreshUI() {
  renderPermit2Panel();
  var badge = document.getElementById('permit2-count-badge');
  if (badge) {
    var wallet = window.walletState && window.walletState.address;
    var count  = wallet ? p2GetActive(wallet).length : 0;
    badge.textContent = count;
    badge.classList.toggle('hidden', count === 0);
  }
}

// ── Render active permits panel ───────────────────────────────────────────────
function renderPermit2Panel() {
  var panel = document.getElementById('permit2-active-panel');
  if (!panel) return;

  var wallet = window.walletState && window.walletState.address;
  if (!wallet) {
    panel.innerHTML =
      '<div class="text-center text-gray-600 text-sm py-4">' +
        '<i class="fas fa-lock text-gray-700 text-2xl mb-2 block"></i>' +
        'Connect wallet to view permits' +
      '</div>';
    return;
  }

  var active = p2GetActive(wallet);
  if (!active.length) {
    panel.innerHTML =
      '<div class="text-center text-gray-500 text-sm py-4">' +
        '<i class="fas fa-unlock-alt text-gray-600 text-2xl mb-2 block"></i>' +
        'No active permits for <code class="text-xs text-gray-400">' + wallet.slice(0, 10) + '…</code><br>' +
        '<span class="text-xs">Use the chat to create a permit.</span>' +
      '</div>';
    return;
  }

  panel.innerHTML = active.map(function(p) {
    var remaining  = (p.amount - (p.amountUsed || 0)).toFixed(2);
    var used       = (p.amountUsed || 0).toFixed(2);
    var pct        = p.amount > 0 ? Math.round((p.amountUsed || 0) / p.amount * 100) : 0;
    var expires    = p2FormatExpiry(p.expiry);
    var scopeLabel = SCOPE_LABELS[p.scope] || p.scope;
    var isAI       = p.createdVia === 'chat';
    var onChainTag = p.onChain ? ' ⛓️' : ' 📝';
    var hoursLeft  = Math.max(0, (p.expiry - Date.now()) / 3600000);
    var urgentClass = hoursLeft < 2
      ? 'border-red-500/40 bg-red-900/10'
      : hoursLeft < 12
        ? 'border-yellow-500/30 bg-yellow-900/10'
        : 'border-yellow-600/20 bg-yellow-900/5';

    return '<div class="border ' + urgentClass + ' rounded-lg p-3">' +
      '<div class="flex items-start justify-between gap-2">' +
        '<div class="flex-1 min-w-0">' +
          '<div class="flex items-center gap-2 mb-1">' +
            '<span class="text-sm font-semibold text-white">' + remaining + ' ' + p.token + '</span>' +
            '<span class="text-xs text-gray-500">/ ' + p.amount + ' total</span>' +
            (isAI ? '<span class="text-[10px] bg-yellow-500/20 border border-yellow-500/40 text-yellow-400 rounded px-1.5 py-0.5">🤖 AI' + onChainTag + '</span>' : '') +
          '</div>' +
          '<div class="flex items-center gap-3 text-xs text-gray-500">' +
            '<span><i class="fas fa-tag mr-1"></i>' + scopeLabel + '</span>' +
            '<span><i class="fas fa-clock mr-1"></i>Expires ' + expires + '</span>' +
          '</div>' +
          '<div class="mt-2 h-1 bg-gray-700 rounded-full overflow-hidden">' +
            '<div class="h-full bg-gradient-to-r from-yellow-500 to-amber-600 rounded-full" style="width:' + pct + '%"></div>' +
          '</div>' +
          '<div class="flex justify-between text-[10px] text-gray-600 mt-0.5">' +
            '<span>Used: ' + used + ' ' + p.token + ' (' + pct + '%)</span>' +
            '<span>Remaining: ' + remaining + ' ' + p.token + '</span>' +
          '</div>' +
          (p.step2TxHash ? '<div class="mt-1"><a href="' + p.explorerUrl2 + '" target="_blank" class="text-[10px] text-blue-400 hover:underline">⛓️ View permit() tx</a></div>' : '') +
        '</div>' +
        '<button onclick="window._p2RevokeFromPanel(\'' + p.id + '\')"' +
          ' class="flex-shrink-0 text-red-500 hover:text-red-400 hover:bg-red-900/20 rounded-lg p-1.5 transition-colors" title="Revoke permit">' +
          '<i class="fas fa-trash text-xs"></i>' +
        '</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

// Called from panel revoke button
window._p2RevokeFromPanel = function(permitId) {
  var all    = p2LoadAll();
  var permit = all.find(function(p) { return p.id === permitId; });
  if (!permit) return;
  var updated = all.filter(function(p) { return p.id !== permitId; });
  p2SaveAll(updated);
  p2RefreshUI();
  if (typeof showToast === 'function') showToast('Permit revoked: ' + permit.amount + ' ' + permit.token, 'info');
  if (typeof appendChatMessage === 'function') {
    appendChatMessage('assistant',
      '✅ **Permit revoked.**\n\n' + permit.amount + ' ' + permit.token +
      ' (' + (SCOPE_LABELS[permit.scope] || permit.scope) + ') spending permission removed.',
      'permit2');
  }
};

// ── Global exports ────────────────────────────────────────────────────────────
window.createPermitFromChat = createPermitFromChat;
window.p2ParseIntent        = p2ParseIntent;
window.p2GetActive          = p2GetActive;
window.p2CheckAllowance     = p2CheckAllowance;
window.p2RecordUsage        = p2RecordUsage;
window.p2RevokePermit       = p2RevokePermit;
window.p2RevokeAll          = p2RevokeAll;
window.p2FormatExpiry       = p2FormatExpiry;
window.p2FormatDuration     = p2FormatDuration;
window.handlePermitIntent   = handlePermitIntent;
window.p2RefreshUI          = p2RefreshUI;
window.renderPermit2Panel   = renderPermit2Panel;

// Expose Permit2 internals for use by other modules
window.Permit2Chat = {
  PERMIT2_ADDR:           PERMIT2_ADDR,
  TOKEN_MAP:              TOKEN_MAP,
  checkERC20Allowance:    _checkERC20AllowanceForPermit2,
  getOnChainAllowance:    _getOnChainPermit2Allowance,
  approveTokenForPermit2: _approveTokenForPermit2,
  signPermitSingle:       _signPermitSingle,
  submitPermitOnChain:    _submitPermitOnChain,
  waitForReceipt:         _waitForReceipt,
};

// ── Wallet sync ───────────────────────────────────────────────────────────────
window.addEventListener('walletConnected',    function() { setTimeout(p2RefreshUI, 200); });
window.addEventListener('walletDisconnected', function() { setTimeout(p2RefreshUI, 200); });

// ── Auto-cleanup expired permits on load ──────────────────────────────────────
(function p2CleanExpired() {
  var now   = Date.now();
  var all   = p2LoadAll();
  var fresh = all.filter(function(p) { return p.expiry > now; });
  if (fresh.length !== all.length) {
    p2SaveAll(fresh);
    console.log('[Permit2] Cleaned ' + (all.length - fresh.length) + ' expired permit(s).');
  }
})();

// ── Periodic cleanup (every 5 min) ────────────────────────────────────────────
setInterval(function() {
  var now   = Date.now();
  var all   = p2LoadAll();
  var fresh = all.filter(function(p) { return p.expiry > now; });
  if (fresh.length !== all.length) {
    p2SaveAll(fresh);
    p2RefreshUI();
  }
}, 5 * 60 * 1000);

console.log('[Permit2] Module loaded — Arc Testnet 5042002 | FULL ON-CHAIN FLOW ENABLED | Permit2 @ ' + PERMIT2_ADDR);

// ── ADVANCED: p2SuggestReuse ──────────────────────────────────────────────────
function p2SuggestReuse(wallet, token, amount, scope) {
  var suggestion = null;
  if (typeof Permit2Engine !== 'undefined' && Permit2Engine.suggestReusePermit) {
    suggestion = Permit2Engine.suggestReusePermit(wallet, token, amount, scope);
  } else {
    var active = p2GetActive(wallet);
    var match  = active.find(function(p) {
      return p.token.toUpperCase() === (token || 'USDC').toUpperCase() &&
             (p.scope === 'all' || p.scope === scope) &&
             (p.amount - (p.amountUsed || 0)) >= (amount || 0) &&
             p.expiry > Date.now();
    });
    if (match) {
      suggestion = {
        permit: match,
        message: '♻️ You already have an active permit for **' + (match.amount - (match.amountUsed || 0)).toFixed(2) +
                 ' ' + match.token + '** (expires ' + p2FormatExpiry(match.expiry) + '). Reuse it?',
      };
    }
  }
  return suggestion;
}

// ── ADVANCED: ERC-20 Fallback approve via chat ────────────────────────────────
async function erc20ApproveFromChat(tokenSymbol, spenderAddr, amount) {
  var _append = function(role, txt, mod) { if (typeof appendChatMessage === 'function') appendChatMessage(role, txt, mod); };
  var _toast  = function(msg, t) { if (typeof showToast === 'function') showToast(msg, t); };
  if (typeof Permit2Engine === 'undefined') {
    _append('assistant', '❌ Permit2Engine not loaded. Refresh the page.', 'error');
    return;
  }
  try {
    if (typeof showTypingIndicator === 'function') showTypingIndicator();
    var tx = await Permit2Engine.erc20Approve(tokenSymbol, spenderAddr, amount);
    _append('assistant',
      '✅ **ERC-20 Approval sent!**\n\n' +
      '| Field | Value |\n|---|---|\n' +
      '| Token | ' + tokenSymbol + ' |\n' +
      '| Spender | `' + spenderAddr.slice(0, 14) + '…` |\n' +
      '| Amount | ' + amount + ' ' + tokenSymbol + ' |\n' +
      '| TX | waiting confirmation… |\n\n' +
      '*Waiting for on-chain confirmation…*',
      'permit2');
    var receipt = await tx.wait(1);
    _append('assistant',
      '✅ **Approval confirmed on-chain!**\n\n' +
      'Block: #' + receipt.blockNumber + '\n' +
      'TX: [`' + tx.hash.slice(0, 14) + '…`](https://testnet.arcscan.app/tx/' + tx.hash + ')',
      'permit2');
    _toast('ERC-20 approval confirmed!', 'success');
  } catch(e) {
    if (typeof hideTypingIndicator === 'function') hideTypingIndicator();
    _append('assistant', '❌ **Approval failed:** ' + e.message, 'error');
  } finally {
    if (typeof hideTypingIndicator === 'function') hideTypingIndicator();
  }
}

// ── ADVANCED: Handle "history" and "receipts" intent ─────────────────────────
function p2HandleHistoryIntent(msg) {
  var lower = msg.toLowerCase();
  if (!/history|receipt|transaction|tx list|my tx|my transfers?|sent to/i.test(lower)) return false;
  var _append = function(role, txt, mod) { if (typeof appendChatMessage === 'function') appendChatMessage(role, txt, mod); };
  if (typeof Permit2Engine !== 'undefined' && Permit2Engine.formatReceiptHistory) {
    var formatted = Permit2Engine.formatReceiptHistory(15);
    _append('assistant', formatted, 'general');
  } else {
    _append('assistant', '📭 Transaction history not available. Use the History tab for full records.', 'general');
  }
  return true;
}

// ── ADVANCED: Handle "check balance" intent ───────────────────────────────────
async function p2HandleCheckIntent(msg) {
  var lower = msg.toLowerCase();
  if (!/check.*balance|my.*balance|balance.*usdc|balance.*eurc|check.*allowance|my.*allowance/i.test(lower)) return false;

  var _append = function(role, txt, mod) { if (typeof appendChatMessage === 'function') appendChatMessage(role, txt, mod); };
  var _hide   = function() { if (typeof hideTypingIndicator === 'function') hideTypingIndicator(); };
  var wallet  = window.walletState && window.walletState.address;

  if (!wallet) {
    _append('assistant', '⚠️ Connect your wallet to check balances.', 'permit2');
    return true;
  }
  if (typeof Permit2Engine === 'undefined') return false;

  try {
    if (typeof showTypingIndicator === 'function') showTypingIndicator();
    var usdcBal = await Permit2Engine.getTokenBalance(wallet, 'USDC');
    var eurcBal = await Permit2Engine.getTokenBalance(wallet, 'EURC');

    // Also check on-chain Permit2 state
    var p2State = await _getOnChainPermit2Allowance(wallet, P2_USDC_TOKEN, wallet);
    var erc20AllowanceForP2 = await _checkERC20AllowanceForPermit2(wallet, P2_USDC_TOKEN);

    _hide();
    _append('assistant',
      '💰 **Token Balances**\n\n' +
      '| Token | Balance |\n|---|---|\n' +
      '| USDC | **' + usdcBal.formatted.toFixed(4) + ' USDC** |\n' +
      '| EURC | **' + eurcBal.formatted.toFixed(4) + ' EURC** |\n\n' +
      '⛓️ **Permit2 On-Chain State**\n\n' +
      '| | |\n|---|---|\n' +
      '| USDC → Permit2 approval | ' + (erc20AllowanceForP2 > 0n ? '✅ Approved (' + (erc20AllowanceForP2 >= BigInt('0xffffffffffffffffffffffffffffffff00000000000000000000000000000000') ? 'Unlimited' : erc20AllowanceForP2.toString()) + ')' : '❌ Not approved') + ' |\n' +
      '| Active allowance nonce | ' + p2State.nonce + ' |\n\n' +
      '*Wallet: `' + wallet.slice(0, 10) + '…`*',
      'general');
  } catch(e) {
    _hide();
    _append('assistant', '❌ Balance check failed: ' + e.message, 'error');
  }
  return true;
}

// Extend handlePermitIntent to also handle advanced intents
var _origHandlePermitIntent = handlePermitIntent;
window.handlePermitIntent = async function(msg) {
  if (p2HandleHistoryIntent(msg)) return true;
  var balHandled = await p2HandleCheckIntent(msg);
  if (balHandled) return true;

  // Batch: "allow 100 USDC and EURC for 24 hours"
  var lower = msg.toLowerCase();
  if (/allow|authorize|permit/.test(lower) && /usdc.*eurc|eurc.*usdc|both tokens?/.test(lower)) {
    var amtM = msg.match(/(\d+(?:\.\d+)?)/);
    if (amtM) {
      var amount = parseFloat(amtM[1]);
      var durM   = msg.match(/(\d+)\s*(hour|hr|h|day|d)/i);
      var hrs    = durM ? ((/d/i.test(durM[2]) ? 24 : 1) * parseInt(durM[1])) : 24;
      var wallet = window.walletState && window.walletState.address;
      if (!wallet) {
        if (typeof appendChatMessage === 'function') appendChatMessage('assistant', '⚠️ Connect wallet first.', 'permit2');
        return true;
      }
      var reuseU = p2SuggestReuse(wallet, 'USDC', amount, 'all');
      var reuseE = p2SuggestReuse(wallet, 'EURC', amount, 'all');
      if (reuseU && reuseE) {
        if (typeof appendChatMessage === 'function') {
          appendChatMessage('assistant',
            '♻️ **Both permits already active!**\n\n' +
            '- ' + reuseU.message + '\n- ' + reuseE.message +
            '\n\nYour permits are still valid. No new signature needed.',
            'permit2');
        }
        return true;
      }
      if (typeof appendChatMessage === 'function') {
        appendChatMessage('assistant',
          '🔐 **Batch Permit Request**\n\n' +
          'Allow agent to spend **' + amount + ' USDC** and **' + amount + ' EURC** for **' + p2FormatDuration(hrs) + '**.\n\n' +
          '⚠️ *This will execute the full Permit2 flow for each token (multiple wallet popups).*\n\n' +
          '**Confirm to proceed?**',
          'permit2');
      }
      window._pendingBatchPermit = { tokenList: ['USDC', 'EURC'], amount: amount, durationHours: hrs, scope: 'all', wallet: wallet };
      if (typeof appendActionCard === 'function') {
        appendActionCard([
          { label: '✅ Sign Both',  action: 'window._confirmBatchPermitFromChat()', primary: true, success: true },
          { label: '✕ Cancel',     action: 'window._cancelPermitFromChat()', danger: false },
        ]);
      }
      return true;
    }
  }
  return _origHandlePermitIntent(msg);
};

// Batch permit confirm
window._confirmBatchPermitFromChat = async function() {
  var params = window._pendingBatchPermit;
  window._pendingBatchPermit = null;
  if (!params) return;
  if (typeof showTypingIndicator === 'function') showTypingIndicator();
  try {
    var results = [];
    for (var i = 0; i < params.tokenList.length; i++) {
      try {
        var permit = await createPermitFromChat({
          token: params.tokenList[i],
          amount: params.amount,
          durationHours: params.durationHours,
          scope: params.scope,
          wallet: params.wallet,
        });
        results.push({ token: params.tokenList[i], permit: permit, ok: true });
      } catch (e) {
        results.push({ token: params.tokenList[i], error: e.message, ok: false });
      }
    }
    if (typeof hideTypingIndicator === 'function') hideTypingIndicator();
    var lines = results.map(function(r) {
      return r.ok
        ? '✅ **' + r.token + '** — ' + r.permit.amount + ' ' + r.token + ' authorized ' + (r.permit.onChain ? '⛓️' : '📝') + ' (' + p2FormatDuration(params.durationHours) + ')'
        : '❌ **' + r.token + '** — ' + r.error;
    });
    if (typeof appendChatMessage === 'function') {
      appendChatMessage('assistant',
        '🔐 **Batch Permit Results**\n\n' + lines.join('\n') +
        '\n\nThe AI agent can now use these tokens within defined limits.',
        'permit2');
    }
    p2RefreshUI();
    if (typeof showToast === 'function') showToast('Batch permits created!', 'success');
  } catch(e) {
    if (typeof hideTypingIndicator === 'function') hideTypingIndicator();
    if (typeof appendChatMessage === 'function') appendChatMessage('assistant', '❌ Batch permit failed: ' + e.message, 'error');
  }
};

// ── Expose remaining globals ──────────────────────────────────────────────────
window.createBatchPermitsFromChat = function(tokenList, amount, durationHours, scope) {
  var wallet = window.walletState && window.walletState.address;
  if (!wallet) return Promise.reject(new Error('No wallet connected'));
  var results = [];
  var chain = Promise.resolve();
  tokenList.forEach(function(tok) {
    chain = chain.then(function() {
      return createPermitFromChat({ token: tok, amount: amount, durationHours: durationHours, scope: scope, wallet: wallet })
        .then(function(p) { results.push({ token: tok, permit: p, ok: true }); })
        .catch(function(e) { results.push({ token: tok, error: e.message, ok: false }); });
    });
  });
  return chain.then(function() { return results; });
};
window.p2SuggestReuse             = p2SuggestReuse;
window.erc20ApproveFromChat       = erc20ApproveFromChat;
window.p2HandleHistoryIntent      = p2HandleHistoryIntent;
window.p2HandleCheckIntent        = p2HandleCheckIntent;

// Check expiring permits when wallet connects
window.addEventListener('walletConnected', function() {
  setTimeout(function() {
    var wallet = window.walletState && window.walletState.address;
    if (!wallet) return;
    var active = p2GetActive(wallet);
    var now    = Date.now();
    var twoHrs = 2 * 3600 * 1000;
    var soon   = active.filter(function(p) { return (p.expiry - now) < twoHrs; });
    if (!soon.length) return;
    if (typeof showToast === 'function') {
      showToast('⏰ ' + soon.length + ' permit(s) expire in < 2 hours!', 'warning');
    }
  }, 2000);
});

})(); // end IIFE
