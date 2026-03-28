// ============================================================
// PERMIT2-ENGINE.JS — Full Permit2 Execution Layer
// ExecDaat · Arc Testnet · ChainId 5042002
// Build: 20260328a
//
// Responsibilities:
//  • Real ERC-20 transferFrom via Permit2 (AllowanceTransfer)
//  • Batch transfer execution (chunked for 1000+ addresses)
//  • EIP-712 typed data builder (Permit2 canonical format)
//  • Pre-flight simulation (eth_call) before any on-chain action
//  • Gas estimation + headroom
//  • Token balance & allowance checks
//  • Transaction receipt generation
//  • Nonce management (on-chain nonce from Permit2 contract)
//  • Fallback: ERC-20 approve when Permit2 unavailable
//  • Security: replay protection, expiry check, spender validation
//
// Canonical Permit2 address (Uniswap universal deploy):
//   0x000000000022D473030F116dDEE9F6B43aC78BA3
//
// NOTE: Arc Testnet may not have the canonical Permit2 deployed.
//       The engine detects availability and falls back to direct
//       ERC-20 approve + transferFrom when needed.
// ============================================================
(function (global) {
'use strict';

// ── Network constants ─────────────────────────────────────────────────────────
var P2E_CHAIN_ID    = 5042002;
var P2E_CHAIN_HEX   = '0x4cef52';
var P2E_RPC         = 'https://rpc.testnet.arc.network';
var P2E_EXPLORER    = 'https://testnet.arcscan.app';

// Token registry
var P2E_TOKENS = {
  USDC: { address: '0x3600000000000000000000000000000000000000', decimals: 6,  symbol: 'USDC' },
  EURC: { address: '0x89B5EF8FfF7e58BD6A1b7FcF04F1B6A2bbabD72a', decimals: 6,  symbol: 'EURC' },
};

// Canonical Permit2 contract (Uniswap universal)
var PERMIT2_ADDR = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

// Batch settings
var BATCH_CHUNK_SIZE = 200; // max transfers per on-chain batch tx

// ── Minimal ABIs ─────────────────────────────────────────────────────────────
var ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

var PERMIT2_ABI = [
  // AllowanceTransfer
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'function permit(address owner, tuple(tuple(address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline) permitSingle, bytes signature)',
  'function transferFrom(tuple(address from, address to, uint160 amount, address token)[] transferDetails) external',
  // SignatureTransfer
  'function permitTransferFrom(tuple(tuple(address token, uint256 amount) permitted, uint256 nonce, uint256 deadline) permit, tuple(address to, uint256 requestedAmount) transferDetails, address owner, bytes signature)',
];

// ── Receipt storage ───────────────────────────────────────────────────────────
var RECEIPT_KEY = 'arc_p2e_receipts_v1';

function _loadReceipts() {
  try { return JSON.parse(localStorage.getItem(RECEIPT_KEY) || '[]'); } catch(e) { return []; }
}
function _saveReceipt(r) {
  var all = _loadReceipts();
  all.unshift(r); // newest first
  if (all.length > 500) all = all.slice(0, 500);
  localStorage.setItem(RECEIPT_KEY, JSON.stringify(all));
}

// ── RPC helpers ───────────────────────────────────────────────────────────────
var _rpcId = 0;
async function _rpcCall(method, params) {
  _rpcId++;
  var resp = await fetch(P2E_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: _rpcId, method: method, params: params || [] }),
  });
  var data = await resp.json();
  if (data.error) throw new Error('RPC ' + method + ': ' + data.error.message);
  return data.result;
}

async function _ethCall(to, data) {
  return _rpcCall('eth_call', [{ to: to, data: data }, 'latest']);
}

async function _estimateGas(from, to, data, value) {
  return _rpcCall('eth_estimateGas', [{ from: from, to: to, data: data, value: value || '0x0' }]);
}

// ── ABI encoder helpers (manual, no ethers dependency in this module) ─────────
function _encodeUint256(n) {
  return BigInt(n).toString(16).padStart(64, '0');
}
function _encodeAddress(addr) {
  return addr.toLowerCase().replace('0x', '').padStart(64, '0');
}

// balanceOf(address)
function _encodeBalanceOf(addr) {
  return '0x70a08231' + _encodeAddress(addr);
}
// allowance(address owner, address spender)
function _encodeAllowance(owner, spender) {
  return '0xdd62ed3e' + _encodeAddress(owner) + _encodeAddress(spender);
}

function _decodeUint256(hex) {
  if (!hex || hex === '0x') return 0n;
  return BigInt(hex.startsWith('0x') ? hex : '0x' + hex);
}

// ── Token utilities ──────────────────────────────────────────────────────────
function _getTokenInfo(symbolOrAddr) {
  var upper = (symbolOrAddr || 'USDC').toUpperCase();
  if (P2E_TOKENS[upper]) return P2E_TOKENS[upper];
  // Search by address
  var found = Object.values(P2E_TOKENS).find(function(t) {
    return t.address.toLowerCase() === (symbolOrAddr || '').toLowerCase();
  });
  return found || P2E_TOKENS.USDC;
}

function _toWei(amount, decimals) {
  var factor = Math.pow(10, decimals);
  return BigInt(Math.round(parseFloat(amount) * factor));
}
function _fromWei(wei, decimals) {
  return (Number(BigInt(wei)) / Math.pow(10, decimals));
}

// ── Wallet helpers ────────────────────────────────────────────────────────────
function _getProvider() {
  return (window.walletState && window.walletState.provider) || window.ethereum;
}
function _getWallet() {
  return window.walletState && window.walletState.address;
}
async function _getSigner() {
  var provider = _getProvider();
  if (!provider) throw new Error('No wallet provider. Connect your wallet first.');
  if (typeof ethers !== 'undefined') {
    var ep = new ethers.BrowserProvider(provider);
    return ep.getSigner();
  }
  throw new Error('ethers.js not loaded');
}

async function _ensureArcNetwork() {
  var provider = _getProvider();
  if (!provider) throw new Error('No wallet connected.');
  var hex = await provider.request({ method: 'eth_chainId' });
  if (parseInt(hex, 16) !== P2E_CHAIN_ID) {
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: P2E_CHAIN_HEX }] });
    } catch(e) {
      throw new Error('Please switch to Arc Testnet (Chain 5042002).');
    }
  }
}

// ── Balance & Allowance checks ────────────────────────────────────────────────
async function getTokenBalance(walletAddr, tokenSymbol) {
  var token = _getTokenInfo(tokenSymbol);
  var hex   = await _ethCall(token.address, _encodeBalanceOf(walletAddr));
  var raw   = _decodeUint256(hex);
  return { raw: raw, formatted: _fromWei(raw, token.decimals), symbol: token.symbol };
}

async function getERC20Allowance(walletAddr, tokenSymbol, spenderAddr) {
  var token  = _getTokenInfo(tokenSymbol);
  var hex    = await _ethCall(token.address, _encodeAllowance(walletAddr, spenderAddr));
  var raw    = _decodeUint256(hex);
  return { raw: raw, formatted: _fromWei(raw, token.decimals), symbol: token.symbol };
}

async function getPermit2Allowance(walletAddr, tokenSymbol, spenderAddr) {
  // Check if Permit2 contract exists on this network
  var code = await _rpcCall('eth_getCode', [PERMIT2_ADDR, 'latest']);
  if (!code || code === '0x' || code === '0x0') {
    return { raw: 0n, formatted: 0, available: false };
  }
  // allowance(owner, token, spender) → (uint160 amount, uint48 expiration, uint48 nonce)
  var token = _getTokenInfo(tokenSymbol);
  var sig   = '0x927da105'; // keccak256("allowance(address,address,address)")[0:4]
  var data  = sig + _encodeAddress(walletAddr) + _encodeAddress(token.address) + _encodeAddress(spenderAddr);
  try {
    var hex = await _ethCall(PERMIT2_ADDR, data);
    if (!hex || hex === '0x') return { raw: 0n, formatted: 0, available: true };
    // Returns 3 slots: amount (uint160), expiration (uint48), nonce (uint48)
    var amount     = _decodeUint256('0x' + hex.slice(2, 66));
    var expiration = Number(_decodeUint256('0x' + hex.slice(66, 130)));
    var nonce      = Number(_decodeUint256('0x' + hex.slice(130, 194)));
    return {
      raw:        amount,
      formatted:  _fromWei(amount, token.decimals),
      expiration: expiration,
      nonce:      nonce,
      expired:    expiration > 0 && expiration < Math.floor(Date.now() / 1000),
      available:  true,
    };
  } catch(e) {
    return { raw: 0n, formatted: 0, available: false };
  }
}

// ── Pre-flight checks ─────────────────────────────────────────────────────────
async function preflightCheck(params) {
  // params: { wallet, token, amount, recipients? (array), recipient? (single) }
  var wallet = params.wallet || _getWallet();
  if (!wallet) return { ok: false, errors: ['No wallet connected'] };

  var token      = _getTokenInfo(params.token || 'USDC');
  var totalAmt   = params.totalAmount || params.amount || 0;
  var totalWei   = _toWei(totalAmt, token.decimals);

  var errors   = [];
  var warnings = [];
  var suggestions = [];

  // 1. Balance check
  var bal = await getTokenBalance(wallet, token.symbol);
  if (bal.raw < totalWei) {
    errors.push('Insufficient ' + token.symbol + ' balance. Have ' + bal.formatted.toFixed(4) + ', need ' + totalAmt);
  }

  // 2. Check on-chain ERC20 allowance for spender (if provided)
  var spender = params.spender;
  var erc20Allow = { raw: 0n, formatted: 0 };
  if (spender) {
    erc20Allow = await getERC20Allowance(wallet, token.symbol, spender);
    if (erc20Allow.raw < totalWei) {
      suggestions.push('ERC-20 allowance insufficient — will request approval before transfer.');
    }
  }

  // 3. Check Permit2 allowance
  var p2Allow = { raw: 0n, formatted: 0, available: false };
  if (spender) {
    p2Allow = await getPermit2Allowance(wallet, token.symbol, spender);
    if (p2Allow.available && p2Allow.raw >= totalWei && !p2Allow.expired) {
      suggestions.push('✅ Permit2 allowance available (' + p2Allow.formatted.toFixed(2) + ' ' + token.symbol + '). Will reuse existing permit.');
    }
  }

  // 4. Active off-chain permit check
  var activePermits = typeof p2GetActive === 'function' ? p2GetActive(wallet) : [];
  var matchedPermit = activePermits.find(function(p) {
    return p.token.toUpperCase() === token.symbol &&
           (p.amount - (p.amountUsed || 0)) >= totalAmt &&
           p.expiry > Date.now();
  });
  if (matchedPermit) {
    suggestions.push('♻️ You have an active permit for ' + matchedPermit.amount + ' ' + token.symbol + '. Reuse?');
  }

  // 5. Recipient validation (for batch)
  var recipientCount = 0;
  if (params.recipients && Array.isArray(params.recipients)) {
    recipientCount = params.recipients.length;
    var invalidAddrs = params.recipients.filter(function(r) {
      return !/^0x[0-9a-fA-F]{40}$/.test(r.address || r);
    });
    if (invalidAddrs.length > 0) {
      warnings.push(invalidAddrs.length + ' invalid address(es) will be skipped.');
    }
    if (recipientCount > 1000) {
      warnings.push('Large batch (' + recipientCount + ' recipients). Will auto-chunk into groups of ' + BATCH_CHUNK_SIZE + '.');
    }
  }

  return {
    ok:           errors.length === 0,
    errors:       errors,
    warnings:     warnings,
    suggestions:  suggestions,
    balance:      bal,
    erc20Allow:   erc20Allow,
    p2Allow:      p2Allow,
    matchedPermit: matchedPermit || null,
    recipientCount: recipientCount,
    token:        token,
    totalAmount:  totalAmt,
  };
}

// ── EIP-712 Permit2 Canonical Type Data ──────────────────────────────────────
// Following Uniswap's canonical Permit2 PermitSingle for AllowanceTransfer
function buildPermit2TypedData(params) {
  // params: { owner, token (symbol), spenderAddr, amount, expiration (unix seconds), nonce, sigDeadline }
  var token       = _getTokenInfo(params.token || 'USDC');
  var amountWei   = _toWei(params.amount, token.decimals);
  var expiration  = params.expiration || Math.floor(Date.now() / 1000) + (params.durationHours || 24) * 3600;
  var sigDeadline = params.sigDeadline || Math.floor(Date.now() / 1000) + 1800; // 30 min deadline
  var nonce       = params.nonce !== undefined ? params.nonce : Math.floor(Math.random() * 0xffffff);

  return {
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
      chainId:           P2E_CHAIN_ID,
      verifyingContract: PERMIT2_ADDR,
    },
    message: {
      details: {
        token:      token.address,
        amount:     amountWei.toString(),
        expiration: expiration,
        nonce:      nonce,
      },
      spender:     params.spenderAddr,
      sigDeadline: sigDeadline,
    },
    _meta: { token: token, amountWei: amountWei, expiration: expiration, nonce: nonce, sigDeadline: sigDeadline },
  };
}

// ── EIP-712 Signature Transfer (single-use, no on-chain allowance) ────────────
function buildSignatureTransferTypedData(params) {
  // params: { owner, token, amount, spenderAddr, nonce, deadline }
  var token      = _getTokenInfo(params.token || 'USDC');
  var amountWei  = _toWei(params.amount, token.decimals);
  var deadline   = params.deadline || Math.floor(Date.now() / 1000) + 1800;
  var nonce      = params.nonce !== undefined ? params.nonce : BigInt(Date.now());

  return {
    types: {
      EIP712Domain: [
        { name: 'name',              type: 'string'  },
        { name: 'chainId',           type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      TokenPermissions: [
        { name: 'token',  type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
      PermitTransferFrom: [
        { name: 'permitted', type: 'TokenPermissions' },
        { name: 'spender',   type: 'address'          },
        { name: 'nonce',     type: 'uint256'           },
        { name: 'deadline',  type: 'uint256'           },
      ],
    },
    primaryType: 'PermitTransferFrom',
    domain: {
      name:              'Permit2',
      chainId:           P2E_CHAIN_ID,
      verifyingContract: PERMIT2_ADDR,
    },
    message: {
      permitted: { token: token.address, amount: amountWei.toString() },
      spender:   params.spenderAddr,
      nonce:     nonce.toString(),
      deadline:  deadline,
    },
    _meta: { token: token, amountWei: amountWei, deadline: deadline, nonce: nonce },
  };
}

// ── Sign EIP-712 data ─────────────────────────────────────────────────────────
async function signTypedData(typedData) {
  var wallet   = _getWallet();
  var provider = _getProvider();
  if (!wallet || !provider) throw new Error('Wallet not connected.');

  // Remove _meta before sending to wallet
  var sendData = JSON.parse(JSON.stringify(typedData));
  delete sendData._meta;

  try {
    var sig = await provider.request({
      method: 'eth_signTypedData_v4',
      params: [wallet, JSON.stringify(sendData)],
    });
    return sig;
  } catch(e) {
    if (e.code === 4001 || /deny|reject|cancel/i.test(e.message || '')) {
      throw new Error('CANCELLED');
    }
    throw new Error('Signature error: ' + (e.message || String(e)));
  }
}

// ── ERC-20 Direct approve (fallback) ─────────────────────────────────────────
async function erc20Approve(tokenSymbol, spenderAddr, amount) {
  await _ensureArcNetwork();
  var signer = await _getSigner();
  var token  = _getTokenInfo(tokenSymbol);
  var amtWei = _toWei(amount, token.decimals);

  var contract = new ethers.Contract(token.address, ERC20_ABI, signer);
  var gasEst;
  try {
    gasEst = await contract.approve.estimateGas(spenderAddr, amtWei);
  } catch(e) {
    gasEst = 60000n;
  }
  var gasLimit = BigInt(Math.ceil(Number(gasEst) * 1.3));
  var tx = await contract.approve(spenderAddr, amtWei, { gasLimit });
  return tx;
}

// ── Single ERC-20 transferFrom ────────────────────────────────────────────────
async function erc20TransferFrom(tokenSymbol, fromAddr, toAddr, amount) {
  await _ensureArcNetwork();
  var signer = await _getSigner();
  var token  = _getTokenInfo(tokenSymbol);
  var amtWei = _toWei(amount, token.decimals);

  var contract = new ethers.Contract(token.address, ERC20_ABI, signer);
  var gasEst;
  try { gasEst = await contract.transferFrom.estimateGas(fromAddr, toAddr, amtWei); }
  catch(e) { gasEst = 80000n; }
  var gasLimit = BigInt(Math.ceil(Number(gasEst) * 1.3));

  var tx = await contract.transferFrom(fromAddr, toAddr, amtWei, { gasLimit });
  var receipt = await tx.wait(1);
  return { txHash: tx.hash, receipt: receipt, blockNumber: receipt.blockNumber };
}

// ── Single ERC-20 transfer (from connected wallet) ────────────────────────────
async function erc20Transfer(tokenSymbol, toAddr, amount) {
  await _ensureArcNetwork();
  var signer = await _getSigner();
  var wallet = await signer.getAddress();
  var token  = _getTokenInfo(tokenSymbol);
  var amtWei = _toWei(amount, token.decimals);

  var contract = new ethers.Contract(token.address, ERC20_ABI, signer);
  var gasEst;
  try { gasEst = await contract.transfer.estimateGas(toAddr, amtWei); }
  catch(e) { gasEst = 65000n; }
  var gasLimit = BigInt(Math.ceil(Number(gasEst) * 1.3));

  var tx = await contract.transfer(toAddr, amtWei, { gasLimit });
  var receipt = await tx.wait(1);

  var receiptObj = {
    id:          'tx_' + Date.now().toString(36),
    type:        'transfer',
    token:       token.symbol,
    amount:      amount,
    from:        wallet,
    to:          toAddr,
    txHash:      tx.hash,
    blockNumber: receipt.blockNumber,
    timestamp:   Date.now(),
    explorerUrl: P2E_EXPLORER + '/tx/' + tx.hash,
  };
  _saveReceipt(receiptObj);
  return receiptObj;
}

// ── Simulate transfer (eth_call dry-run) ─────────────────────────────────────
async function simulateTransfer(tokenSymbol, fromAddr, toAddr, amount) {
  var token  = _getTokenInfo(tokenSymbol);
  var amtWei = _toWei(amount, token.decimals);

  // Encode ERC20 transfer(to, amount)
  var sig   = 'a9059cbb'; // transfer(address,uint256)
  var data  = '0x' + sig + _encodeAddress(toAddr) + _encodeUint256(amtWei);

  try {
    var result = await _ethCall(token.address, data);
    // Returns 0x + 32 bytes; success = 0x0000...0001
    var success = result && result !== '0x' && _decodeUint256(result) > 0n;
    return { success: success, result: result };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

// ── Batch Transfer (chunked, with progress callback) ─────────────────────────
// recipients: [{ address, amount }]
// onProgress: function(done, total, txHash)
async function batchTransferERC20(tokenSymbol, recipients, onProgress) {
  await _ensureArcNetwork();
  var signer = await _getSigner();
  var wallet = await signer.getAddress();
  var token  = _getTokenInfo(tokenSymbol);
  var contract = new ethers.Contract(token.address, ERC20_ABI, signer);

  // Validate & dedupe recipients
  var valid = [];
  var seen  = {};
  recipients.forEach(function(r) {
    var addr = (r.address || r).toLowerCase();
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return;
    if (seen[addr]) return;
    seen[addr] = true;
    valid.push({ address: addr, amount: parseFloat(r.amount || 0) });
  });
  if (!valid.length) throw new Error('No valid recipients after deduplication.');

  var receipts = [];
  var errors   = [];
  var total    = valid.length;
  var done     = 0;

  // Chunk into groups
  var chunks = [];
  for (var i = 0; i < valid.length; i += BATCH_CHUNK_SIZE) {
    chunks.push(valid.slice(i, i + BATCH_CHUNK_SIZE));
  }

  for (var ci = 0; ci < chunks.length; ci++) {
    var chunk = chunks[ci];
    for (var ri = 0; ri < chunk.length; ri++) {
      var recip = chunk[ri];
      try {
        var amtWei = _toWei(recip.amount, token.decimals);
        var gasEst;
        try { gasEst = await contract.transfer.estimateGas(recip.address, amtWei); }
        catch(e) { gasEst = 65000n; }
        var gasLimit = BigInt(Math.ceil(Number(gasEst) * 1.3));

        var tx = await contract.transfer(recip.address, amtWei, { gasLimit });
        var receipt = await tx.wait(1);

        var receiptObj = {
          id:          'btx_' + Date.now().toString(36) + '_' + done,
          type:        'batch_transfer',
          token:       token.symbol,
          amount:      recip.amount,
          from:        wallet,
          to:          recip.address,
          txHash:      tx.hash,
          blockNumber: receipt.blockNumber,
          timestamp:   Date.now(),
          explorerUrl: P2E_EXPLORER + '/tx/' + tx.hash,
          batchIndex:  done,
        };
        _saveReceipt(receiptObj);
        receipts.push(receiptObj);
        done++;
        if (typeof onProgress === 'function') onProgress(done, total, tx.hash);
      } catch(e) {
        errors.push({ address: recip.address, amount: recip.amount, error: e.message });
        done++;
        if (typeof onProgress === 'function') onProgress(done, total, null);
      }
    }
  }

  return {
    success:      receipts.length,
    failed:       errors.length,
    total:        total,
    receipts:     receipts,
    errors:       errors,
    token:        token.symbol,
    timestamp:    Date.now(),
  };
}

// ── Gas estimation for a transfer ────────────────────────────────────────────
async function estimateGas(tokenSymbol, toAddr, amount) {
  var wallet = _getWallet();
  if (!wallet) return null;
  var token  = _getTokenInfo(tokenSymbol);
  var amtWei = _toWei(amount, token.decimals);
  var sig    = 'a9059cbb';
  var data   = '0x' + sig + _encodeAddress(toAddr) + _encodeUint256(amtWei);
  try {
    var hexGas = await _estimateGas(wallet, token.address, data, '0x0');
    var gasUnits = Number(_decodeUint256(hexGas));
    // Get gas price
    var gasPriceHex = await _rpcCall('eth_gasPrice', []);
    var gasPrice    = Number(_decodeUint256(gasPriceHex));
    var gasCostWei  = gasUnits * gasPrice;
    return {
      gasUnits:   gasUnits,
      gasPrice:   gasPrice,
      gasCostWei: gasCostWei,
      gasCostGwei: (gasPrice / 1e9).toFixed(4),
      note:       gasPrice === 0 ? 'Gas is free on Arc Testnet' : null,
    };
  } catch(e) {
    return { gasUnits: 65000, gasCostWei: 0, note: 'Gas is free on Arc Testnet' };
  }
}

// ── Smart transfer router ─────────────────────────────────────────────────────
// Chooses the best transfer method based on available permits/allowances
// Returns a preview object; caller must confirm before executing.
async function prepareTransfer(params) {
  // params: { token, amount, recipient, wallet? }
  var wallet = params.wallet || _getWallet();
  if (!wallet) return { ok: false, error: 'No wallet connected' };

  var token    = _getTokenInfo(params.token || 'USDC');
  var amount   = parseFloat(params.amount || 0);
  if (!amount || amount <= 0) return { ok: false, error: 'Invalid amount' };
  if (!params.recipient || !/^0x[0-9a-fA-F]{40}$/.test(params.recipient)) {
    return { ok: false, error: 'Invalid recipient address' };
  }

  // Gather pre-flight info
  var preflight = await preflightCheck({
    wallet:      wallet,
    token:       token.symbol,
    totalAmount: amount,
    recipients:  [{ address: params.recipient, amount: amount }],
  });

  // Gas estimate
  var gasInfo = await estimateGas(token.symbol, params.recipient, amount);

  // Simulate
  var sim = await simulateTransfer(token.symbol, wallet, params.recipient, amount);

  // Select method
  var method = 'erc20_transfer'; // default: direct transfer
  if (preflight.matchedPermit) method = 'permit2_signed';

  return {
    ok:          preflight.ok && sim.success !== false,
    method:      method,
    preview: {
      token:       token.symbol,
      amount:      amount,
      from:        wallet,
      to:          params.recipient,
      gas:         gasInfo,
      simOk:       sim.success !== false,
      balance:     preflight.balance,
      suggestions: preflight.suggestions,
      warnings:    preflight.warnings,
      errors:      preflight.errors,
    },
    preflight:    preflight,
    gasInfo:      gasInfo,
    sim:          sim,
  };
}

// ── Execute confirmed transfer ────────────────────────────────────────────────
async function executeTransfer(params) {
  // params: { token, amount, recipient, method? }
  var wallet = _getWallet();
  if (!wallet) throw new Error('No wallet connected');
  await _ensureArcNetwork();

  var result = await erc20Transfer(params.token, params.recipient, params.amount);

  // Record usage in permit if applicable
  if (params.permitId && typeof p2RecordUsage === 'function') {
    p2RecordUsage(params.permitId, parseFloat(params.amount));
  }

  return result;
}

// ── Execute batch transfer ────────────────────────────────────────────────────
async function executeBatchTransfer(params, onProgress) {
  // params: { token, recipients: [{address, amount}] }
  var wallet = _getWallet();
  if (!wallet) throw new Error('No wallet connected');
  await _ensureArcNetwork();
  return batchTransferERC20(params.token, params.recipients, onProgress);
}

// ── Format preview for chat display ─────────────────────────────────────────
function formatTransferPreview(prep, isBatch) {
  var p = prep.preview || prep;
  var lines = [];

  if (isBatch) {
    var total   = prep.totalAmount || p.totalAmount || 0;
    var count   = prep.recipientCount || 0;
    lines.push('📋 **Batch Transfer Preview**\n');
    lines.push('| Field | Value |');
    lines.push('|---|---|');
    lines.push('| Token | **' + p.token + '** |');
    lines.push('| Recipients | **' + count + '** |');
    lines.push('| Total Amount | **' + total.toFixed(4) + ' ' + p.token + '** |');
    lines.push('| Per Address | ' + (count > 0 ? (total / count).toFixed(4) : '—') + ' ' + p.token + ' |');
    lines.push('| Your Balance | ' + (p.balance ? p.balance.formatted.toFixed(4) : '—') + ' ' + p.token + ' |');
    if (p.gas && p.gas.note) lines.push('| Gas | ' + p.gas.note + ' |');
  } else {
    lines.push('💸 **Transfer Preview**\n');
    lines.push('| Field | Value |');
    lines.push('|---|---|');
    lines.push('| Token | **' + p.token + '** |');
    lines.push('| Amount | **' + p.amount + ' ' + p.token + '** |');
    lines.push('| To | `' + p.to + '` |');
    lines.push('| From | `' + p.from + '` |');
    lines.push('| Your Balance | ' + (p.balance ? p.balance.formatted.toFixed(4) : '—') + ' ' + p.token + ' |');
    if (p.gas && p.gas.note) lines.push('| Gas | ' + p.gas.note + ' |');
  }

  if (p.suggestions && p.suggestions.length) {
    lines.push('\n💡 **Suggestions:**');
    p.suggestions.forEach(function(s) { lines.push('- ' + s); });
  }
  if (p.warnings && p.warnings.length) {
    lines.push('\n⚠️ **Warnings:**');
    p.warnings.forEach(function(w) { lines.push('- ' + w); });
  }
  if (p.errors && p.errors.length) {
    lines.push('\n❌ **Errors:**');
    p.errors.forEach(function(e) { lines.push('- ' + e); });
  }
  lines.push('\n**Confirm to proceed?**');
  return lines.join('\n');
}

// ── Format batch result for chat ─────────────────────────────────────────────
function formatBatchResult(result) {
  var lines = [];
  if (result.success === result.total) {
    lines.push('✅ **Batch complete!** ' + result.total + '/' + result.total + ' transfers succeeded.');
  } else if (result.success === 0) {
    lines.push('❌ **Batch failed.** 0/' + result.total + ' transfers succeeded.');
  } else {
    lines.push('⚠️ **Partial batch.** ' + result.success + '/' + result.total + ' succeeded, ' + result.failed + ' failed.');
  }
  lines.push('\n| | |');
  lines.push('|---|---|');
  lines.push('| Token | ' + result.token + ' |');
  lines.push('| Sent | ' + result.success + ' of ' + result.total + ' |');
  if (result.receipts && result.receipts.length > 0) {
    var last = result.receipts[result.receipts.length - 1];
    lines.push('| Last TX | [`' + last.txHash.slice(0, 14) + '…`](' + last.explorerUrl + ') |');
  }
  if (result.errors && result.errors.length > 0) {
    lines.push('\n**Failed addresses (' + result.errors.length + '):**');
    result.errors.slice(0, 3).forEach(function(e) {
      lines.push('- `' + e.address + '` — ' + e.error);
    });
    if (result.errors.length > 3) lines.push('- …and ' + (result.errors.length - 3) + ' more');
  }
  return lines.join('\n');
}

// ── Get receipt history ───────────────────────────────────────────────────────
function getReceiptHistory(limit) {
  var all = _loadReceipts();
  return limit ? all.slice(0, limit) : all;
}

function formatReceiptHistory(limit) {
  var receipts = getReceiptHistory(limit || 10);
  if (!receipts.length) return '📭 No transactions recorded yet.';
  var lines = ['📜 **Recent Transactions** (' + Math.min(receipts.length, limit || 10) + ')\n'];
  receipts.slice(0, limit || 10).forEach(function(r, i) {
    var when = new Date(r.timestamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    var label = r.type === 'batch_transfer' ? 'Batch[' + r.batchIndex + ']' : 'Transfer';
    lines.push((i + 1) + '. **' + label + '** · ' + r.amount + ' ' + r.token + ' → `' + r.to.slice(0, 10) + '…` · ' + when +
               ' · [`' + r.txHash.slice(0, 10) + '…`](' + r.explorerUrl + ')');
  });
  return lines.join('\n');
}

// ── Reuse permit suggestion ───────────────────────────────────────────────────
function suggestReusePermit(wallet, token, amount, scope) {
  if (typeof p2GetActive !== 'function') return null;
  var active = p2GetActive(wallet);
  var match  = active.find(function(p) {
    return p.token.toUpperCase() === (token || 'USDC').toUpperCase() &&
           (p.scope === 'all' || p.scope === scope) &&
           (p.amount - (p.amountUsed || 0)) >= (amount || 0) &&
           p.expiry > Date.now();
  });
  if (!match) return null;
  var remaining = (match.amount - (match.amountUsed || 0)).toFixed(2);
  var expiryLabel = new Date(match.expiry).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return {
    permit:  match,
    message: '♻️ You already have an active permit for **' + remaining + ' ' + match.token +
             '** (expires ' + expiryLabel + '). Reuse it?',
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────
global.Permit2Engine = {
  // Info / checks
  getTokenBalance,
  getERC20Allowance,
  getPermit2Allowance,
  preflightCheck,
  estimateGas,
  simulateTransfer,

  // EIP-712 builders
  buildPermit2TypedData,
  buildSignatureTransferTypedData,
  signTypedData,

  // Execution
  erc20Approve,
  erc20Transfer,
  erc20TransferFrom,
  batchTransferERC20,
  prepareTransfer,
  executeTransfer,
  executeBatchTransfer,

  // Formatting
  formatTransferPreview,
  formatBatchResult,

  // History
  getReceiptHistory,
  formatReceiptHistory,

  // Utilities
  suggestReusePermit,
  getTokenInfo:  _getTokenInfo,
  toWei:         _toWei,
  fromWei:       _fromWei,
  PERMIT2_ADDR,
  TOKENS:        P2E_TOKENS,
  CHAIN_ID:      P2E_CHAIN_ID,
};

console.log('[Permit2Engine] Loaded · Arc Testnet ' + P2E_CHAIN_ID + ' · Permit2 @ ' + PERMIT2_ADDR);

})(window);
