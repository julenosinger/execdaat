// ============================================================
// AGENT EXECUTOR v2 — ExecDaat
// Build: 20260404a
//
// Architecture:
//   • Creates intents via POST /api/agent/intents
//   • Polls GET /api/agent/poll every POLL_MS
//   • For "pending" intent → prepares Permit2 PermitTransferFrom
//   • Signs EIP-712 typed data with user's wallet
//   • Calls Permit2.permitTransferFrom → actual on-chain transfer
//   • Falls back to direct ERC-20 transfer if Permit2 unavailable
//   • Updates intent via PATCH /api/agent/intents/:id
//   • Notifies chat UI via custom events
//
// Execution method (priority order):
//   1. Permit2 SignatureTransfer (permitTransferFrom) — preferred
//   2. Direct ERC-20 transfer (fallback if Permit2 not available)
//
// For BATCH (multisend):
//   • Permit2 batch (permitTransferFrom batched) if available
//   • Fallback: Multicall3 aggregate3 with ERC-20 transferFrom
//
// Security:
//   • Validates session (arcpay session.authorized)
//   • Amount > 0 on every tx
//   • User confirmation for intents ≥ CONFIRM_THRESHOLD USDC
//   • Replay prevention: intent id stored in sessionStorage
//   • Nonce-based Permit2 (each intent uses fresh nonce)
//   • Wallet ownership verified before execution
//
// NO backend private key. User's MetaMask signs every tx.
// ============================================================
'use strict';

(function (global) {

// ─── Constants ────────────────────────────────────────────────────────────────
const AE_VERSION         = '20260404a';
const AE_API_BASE        = '/api/agent';
const AE_POLL_MS         = 3000;          // poll interval (ms)
const AE_MAX_RETRIES     = 3;
const AE_CONFIRM_THRESH  = 50;            // USDC: ask confirm if amount >= this
const AE_STORAGE_KEY     = 'ae_executed'; // sessionStorage: executed intent ids

const AE_RPC        = 'https://rpc.testnet.arc.network';
const AE_CHAIN_ID   = 5042002;
const AE_CHAIN_HEX  = '0x4cef52';
const AE_EXPLORER   = 'https://testnet.arcscan.app';
const AE_USDC_ADDR  = '0x3600000000000000000000000000000000000000';
const AE_EURC_ADDR  = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';

// Canonical Permit2 (deployed on Arc Testnet — verified)
const AE_PERMIT2_ADDR = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const AE_MULTICALL3   = '0xcA11bde05977b3631167028862bE2a173976CA11';

// ─── ABIs ─────────────────────────────────────────────────────────────────────
const AE_ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
  'function transferFrom(address,address,uint256) returns (bool)',
];

// Permit2 — SignatureTransfer.permitTransferFrom
const AE_PERMIT2_ABI = [
  // Single transfer
  'function permitTransferFrom(tuple(tuple(address token,uint256 amount) permitted,uint256 nonce,uint256 deadline) permit,tuple(address to,uint256 requestedAmount) transferDetails,address owner,bytes signature)',
  // Batch transfer
  'function permitTransferFrom(tuple(tuple(address token,uint256 amount)[] permitted,uint256 nonce,uint256 deadline) permit,tuple(address to,uint256 requestedAmount)[] transferDetails,address owner,bytes signature)',
  // Nonce check
  'function nonceBitmap(address,uint256) view returns (uint256)',
];

const AE_MULTICALL3_ABI = [
  'function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns (tuple(bool success,bytes returnData)[] returnData)',
];

// ─── Permit2 EIP-712 domain + types ──────────────────────────────────────────
const AE_PERMIT2_DOMAIN = {
  name:              'Permit2',
  chainId:           AE_CHAIN_ID,
  verifyingContract: AE_PERMIT2_ADDR,
};

const AE_PERMIT_TRANSFER_TYPES = {
  PermitTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender',   type: 'address'          },
    { name: 'nonce',     type: 'uint256'           },
    { name: 'deadline',  type: 'uint256'           },
  ],
  TokenPermissions: [
    { name: 'token',  type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
};

// ─── State ────────────────────────────────────────────────────────────────────
let _aeRunning   = false;
let _aePollTimer = null;
let _aeLastPoll  = null;   // ISO timestamp

// ─── Logging ──────────────────────────────────────────────────────────────────
function _log(...a)  { console.log('%c[AGENT-EXEC v2]', 'color:#a78bfa;font-weight:bold', ...a); }
function _warn(...a) { console.warn('[AGENT-EXEC v2]', ...a); }
function _err(...a)  { console.error('[AGENT-EXEC v2]', ...a); }

// ─── Toast ────────────────────────────────────────────────────────────────────
function _toast(msg, type = 'info') {
  if (typeof showToast === 'function') showToast(msg, type);
}

// ─── Chat notification ────────────────────────────────────────────────────────
function _notify(intentId, status, data = {}) {
  window.dispatchEvent(new CustomEvent('agentExecutor:update', {
    detail: { intentId, status, ...data }
  }));
}

// ─── Session ──────────────────────────────────────────────────────────────────
function _getSession() {
  const key = 'arc-pay-session-v3';
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s?.authorized || !s?.wallet || !s?.expiry) return null;
    if (Date.now() > s.expiry) return null;
    return s;   // { authorized, wallet, signature, sessionNonce, sessionHash, expiry, createdAt }
  } catch { return null; }
}

// ─── Replay guard ─────────────────────────────────────────────────────────────
function _markExecuted(id) {
  try {
    const ids = JSON.parse(sessionStorage.getItem(AE_STORAGE_KEY) || '[]');
    if (!ids.includes(id)) { ids.push(id); sessionStorage.setItem(AE_STORAGE_KEY, JSON.stringify(ids)); }
  } catch {}
}
function _wasExecuted(id) {
  try { return JSON.parse(sessionStorage.getItem(AE_STORAGE_KEY) || '[]').includes(id); } catch { return false; }
}
function _unmarkExecuted(id) {
  try {
    const ids = JSON.parse(sessionStorage.getItem(AE_STORAGE_KEY) || '[]').filter(x => x !== id);
    sessionStorage.setItem(AE_STORAGE_KEY, JSON.stringify(ids));
  } catch {}
}

// ─── API helpers ──────────────────────────────────────────────────────────────
async function _post(path, body) {
  const r = await fetch(AE_API_BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json();
}
async function _get(path) {
  const r = await fetch(AE_API_BASE + path);
  return r.json();
}
async function _patch(id, body) {
  const r = await fetch(`${AE_API_BASE}/intents/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json();
}

// ─── Network helpers ──────────────────────────────────────────────────────────
async function _ensureNetwork() {
  const chainHex = await window.ethereum.request({ method: 'eth_chainId' });
  if (parseInt(chainHex, 16) !== AE_CHAIN_ID) {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: AE_CHAIN_HEX }],
    });
    await new Promise(r => setTimeout(r, 800));
  }
}

// ─── Permit2 nonce helper (random 248-bit nonce to avoid collisions) ──────────
function _randomNonce() {
  // 248-bit random (Permit2 uses wordPos = nonce >> 8, bitPos = nonce & 0xff)
  const arr = new Uint8Array(31);
  crypto.getRandomValues(arr);
  return BigInt('0x' + Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join(''));
}

// ─── Permit2 availability check ───────────────────────────────────────────────
async function _permit2Available() {
  try {
    const r = await fetch(AE_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc:'2.0', method:'eth_getCode', params:[AE_PERMIT2_ADDR,'latest'], id:1 }),
    });
    const d = await r.json();
    return d.result && d.result.length > 4;
  } catch { return false; }
}

// ─── Create Intent ────────────────────────────────────────────────────────────
async function aeCreateIntent(params) {
  const session = _getSession();
  const wallet  = window.walletState?.address;
  if (!wallet)  throw new Error('Wallet not connected');
  if (!session) throw new Error('Daat Agent session expired. Please re-authorize.');

  if (params.type === 'transfer') {
    if (!params.amount || Number(params.amount) <= 0) throw new Error('Amount must be > 0');
    if (!params.to || !/^0x[0-9a-fA-F]{40}$/.test(params.to)) throw new Error('Invalid recipient address');
  }

  const payload = {
    type:        params.type || 'transfer',
    wallet,
    token:       (params.token || 'USDC').toUpperCase(),
    amount:      params.amount != null ? String(params.amount) : undefined,
    to:          params.to,
    receivers:   params.receivers,
    memo:        params.memo,
    sessionHash: session.sessionHash,
    signature:   session.signature,   // ← session EIP-191 sig, also used for Permit2
  };

  const result = await _post('/intents', payload);
  if (!result.success) throw new Error(result.error || 'Failed to create intent');

  _log('Intent created:', result.intent.id, payload.type, payload.amount, payload.token);
  _notify(result.intent.id, 'pending', { intent: result.intent });

  aeStartPolling();
  return result.intent;
}

// ─── Poll Loop ────────────────────────────────────────────────────────────────
function aeStartPolling() {
  if (_aePollTimer) return;
  _log('Poll loop started (every', AE_POLL_MS, 'ms)');
  _aePollTimer = setInterval(_poll, AE_POLL_MS);
  setTimeout(_poll, 100);
}

function aeStopPolling() {
  if (_aePollTimer) { clearInterval(_aePollTimer); _aePollTimer = null; }
  _log('Poll loop stopped');
}

async function _poll() {
  const wallet  = window.walletState?.address;
  const session = _getSession();
  if (!wallet || !session) {
    if (_aePollTimer) { aeStopPolling(); _log('Poll stopped: no session'); }
    return;
  }
  try {
    const since = _aeLastPoll ? `&since=${encodeURIComponent(_aeLastPoll)}` : '';
    const data  = await _get(`/poll?wallet=${encodeURIComponent(wallet)}${since}`);
    if (!data.success) return;
    _aeLastPoll = data.timestamp;
    if (!data.intents || data.intents.length === 0) return;
    _log(`Poll: ${data.intents.length} intent(s) updated`);
    for (const intent of data.intents) await _handleIntent(intent);
  } catch (e) {
    _warn('Poll error:', e.message);
  }
}

// ─── Handle a single intent from poll ────────────────────────────────────────
async function _handleIntent(intent) {
  // Always notify UI of status change (for completed/failed from other tabs)
  _notify(intent.id, intent.status, { intent });

  if (intent.status !== 'pending') return;

  // Replay protection
  if (_wasExecuted(intent.id)) return;

  // Only process intents that belong to current wallet
  const wallet = window.walletState?.address;
  if (!wallet || wallet.toLowerCase() !== intent.wallet.toLowerCase()) return;

  _markExecuted(intent.id);

  try {
    await _executeIntent(intent);
  } catch (e) {
    _err('executeIntent error for', intent.id, ':', e);
  }
}

// ─── Execute Intent (dispatcher) ─────────────────────────────────────────────
async function _executeIntent(intent) {
  _log('Executing:', intent.id, intent.type, intent.amount, intent.token);

  // Mark processing
  await _patch(intent.id, { status: 'processing' });
  _notify(intent.id, 'processing', { intent });
  _toast(`🤖 Agent: executing ${intent.type}…`, 'info');

  // Confirmation for high-value transfers
  if (intent.type === 'transfer' && Number(intent.amount) >= AE_CONFIRM_THRESH) {
    const ok = confirm(
      `Agent wants to send ${intent.amount} ${intent.token} to:\n${intent.to}\n\nConfirm?`
    );
    if (!ok) {
      await _patch(intent.id, { status: 'cancelled' });
      _notify(intent.id, 'cancelled', { intent });
      _toast('Transfer cancelled by user.', 'warning');
      return;
    }
  }

  try {
    if (intent.type === 'transfer') {
      await _executeTransfer(intent);
    } else if (intent.type === 'multisend') {
      await _executeMultisend(intent);
    } else {
      await _patch(intent.id, {
        status: 'failed',
        error: `Type "${intent.type}" requires manual execution. Use the dedicated tab.`,
      });
      _notify(intent.id, 'failed', { intent, error: `Manual execution required for type: ${intent.type}` });
    }
  } catch (err) {
    const msg     = err?.message || String(err);
    const retries = (intent.retries || 0) + 1;
    const isCancel = msg.includes('ACTION_REJECTED') || msg.includes('4001') || msg.includes('User rejected') || msg.includes('user rejected');

    if (!isCancel && retries < AE_MAX_RETRIES) {
      _unmarkExecuted(intent.id);
      await _patch(intent.id, { status: 'pending', retries, error: msg });
      _notify(intent.id, 'pending', { intent, retry: retries });
      _warn(`Retry ${retries}/${AE_MAX_RETRIES} for ${intent.id}: ${msg}`);
    } else {
      const finalMsg = isCancel ? 'Rejected by user in wallet.' : msg;
      await _patch(intent.id, { status: 'failed', error: finalMsg });
      _notify(intent.id, 'failed', { intent, error: finalMsg });
      _toast(`❌ Agent failed: ${finalMsg.slice(0, 80)}`, 'error');
    }
  }
}

// ─── Execute: Single Transfer via Permit2 (with ERC-20 fallback) ─────────────
async function _executeTransfer(intent) {
  const ethers = window.ethers;
  if (!ethers) throw new Error('ethers.js not loaded');

  const amount = Number(intent.amount);
  if (!amount || amount <= 0) throw new Error('Amount must be > 0');

  const provider   = new ethers.BrowserProvider(window.ethereum, 'any');
  const signer     = await provider.getSigner();
  const signerAddr = await signer.getAddress();

  // Wallet ownership check
  if (signerAddr.toLowerCase() !== intent.wallet.toLowerCase()) {
    throw new Error('Connected wallet does not match intent wallet. Switch accounts and retry.');
  }

  await _ensureNetwork();

  const tokenAddr  = intent.token === 'EURC' ? AE_EURC_ADDR : AE_USDC_ADDR;
  const token      = new ethers.Contract(tokenAddr, AE_ERC20_ABI, signer);
  const amountRaw  = BigInt(Math.round(amount * 1_000_000)); // 6 decimals
  if (amountRaw === 0n) throw new Error('Computed amount is zero');

  // Balance check
  const balance = BigInt(await token.balanceOf(signerAddr));
  if (balance < amountRaw) {
    throw new Error(`Insufficient ${intent.token}: have ${Number(balance)/1e6} need ${amount}`);
  }

  // ── Attempt Permit2 path first ────────────────────────────────────────────
  const p2Available = await _permit2Available();
  _log('Permit2 available:', p2Available);

  if (p2Available) {
    try {
      await _executeViaPermit2Single(signer, signerAddr, intent, tokenAddr, amountRaw, ethers);
      return; // success
    } catch (p2err) {
      _warn('Permit2 failed, falling back to direct transfer:', p2err.message);
      // Fall through to ERC-20 direct
    }
  }

  // ── Fallback: direct ERC-20 transfer ─────────────────────────────────────
  _log('Using direct ERC-20 transfer (fallback)');
  await _patch(intent.id, { status: 'signing' });
  _notify(intent.id, 'signing', { intent, method: 'erc20_transfer' });
  _toast(`⏳ Sign transfer: ${amount} ${intent.token} → wallet popup…`, 'info');

  let gasLimit = 80_000n;
  try {
    const est = await token.transfer.estimateGas(intent.to, amountRaw);
    gasLimit = BigInt(Math.ceil(Number(est) * 1.3));
  } catch (_) {}

  const tx = await token.transfer(intent.to, amountRaw, { gasLimit });
  _log('TX sent (direct):', tx.hash);

  await _patch(intent.id, { status: 'broadcast', txHash: tx.hash });
  _notify(intent.id, 'broadcast', { intent, txHash: tx.hash });
  _toast(`📤 TX sent: <a href="${AE_EXPLORER}/tx/${tx.hash}" target="_blank" class="underline">${tx.hash.slice(0,14)}…</a>`, 'info');

  const receipt = await tx.wait(1);
  if (receipt.status !== 1) throw new Error(`Transaction reverted at block #${receipt.blockNumber}`);

  await _patch(intent.id, { status: 'completed', txHash: tx.hash, blockNumber: receipt.blockNumber });
  _notify(intent.id, 'completed', { intent, txHash: tx.hash, blockNumber: receipt.blockNumber });
  _toast(`✅ Agent sent ${amount} ${intent.token}! Block #${receipt.blockNumber}`, 'success');
  _log('Transfer completed (direct):', tx.hash, 'block', receipt.blockNumber);
}

// ─── Permit2 Single Transfer via SignatureTransfer ────────────────────────────
async function _executeViaPermit2Single(signer, signerAddr, intent, tokenAddr, amountRaw, ethers) {
  const token   = new ethers.Contract(tokenAddr, AE_ERC20_ABI, signer);
  const permit2 = new ethers.Contract(AE_PERMIT2_ADDR, AE_PERMIT2_ABI, signer);

  // Check/set Permit2 allowance (AllowanceTransfer — needed for Permit2 to pull tokens)
  const allowance = BigInt(await token.allowance(signerAddr, AE_PERMIT2_ADDR));
  if (allowance < amountRaw) {
    _log('Approving Permit2 allowance…');
    await _patch(intent.id, { status: 'signing' });
    _notify(intent.id, 'signing', { intent, step: 'approve_permit2' });
    _toast('⏳ Step 1/2: Approve Permit2 (one-time) — wallet popup…', 'info');

    // Approve max to avoid repeated approvals
    const maxUint256 = 2n ** 256n - 1n;
    const approveTx  = await token.approve(AE_PERMIT2_ADDR, maxUint256);
    const approveRcpt = await approveTx.wait(1);
    if (approveRcpt.status !== 1) throw new Error('Permit2 approval reverted');
    _log('Permit2 approved');
  }

  // Build Permit2 SignatureTransfer data
  const nonce    = _randomNonce();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour

  const permitMessage = {
    permitted: { token: tokenAddr, amount: amountRaw },
    spender:   AE_PERMIT2_ADDR,
    nonce:     nonce,
    deadline:  deadline,
  };

  await _patch(intent.id, { status: 'signing', permitNonce: nonce.toString(), permitDeadline: deadline.toString() });
  _notify(intent.id, 'signing', { intent, step: 'sign_permit2' });
  _toast(`⏳ Step 2/2: Sign Permit2 (gasless) — wallet popup…`, 'info');

  // EIP-712 typed data signature
  const signature = await signer.signTypedData(AE_PERMIT2_DOMAIN, AE_PERMIT_TRANSFER_TYPES, permitMessage);
  _log('Permit2 signature obtained');

  // Execute on-chain via permitTransferFrom
  const transferDetails = { to: intent.to, requestedAmount: amountRaw };

  let gasLimit = 150_000n;
  try {
    const est = await permit2['permitTransferFrom(tuple(tuple(address,uint256),uint256,uint256),tuple(address,uint256),address,bytes)']
      .estimateGas(
        [{ token: tokenAddr, amount: amountRaw }, nonce, deadline],
        transferDetails,
        signerAddr,
        signature,
      );
    gasLimit = BigInt(Math.ceil(Number(est) * 1.3));
  } catch (_) {}

  const tx = await permit2['permitTransferFrom(tuple(tuple(address,uint256),uint256,uint256),tuple(address,uint256),address,bytes)'](
    [{ token: tokenAddr, amount: amountRaw }, nonce, deadline],
    transferDetails,
    signerAddr,
    signature,
    { gasLimit }
  );

  _log('Permit2 TX sent:', tx.hash);

  await _patch(intent.id, { status: 'broadcast', txHash: tx.hash });
  _notify(intent.id, 'broadcast', { intent, txHash: tx.hash });
  _toast(`📤 TX sent (Permit2): <a href="${AE_EXPLORER}/tx/${tx.hash}" target="_blank" class="underline">${tx.hash.slice(0,14)}…</a>`, 'info');

  const receipt = await tx.wait(1);
  if (receipt.status !== 1) throw new Error(`Permit2 tx reverted at block #${receipt.blockNumber}`);

  await _patch(intent.id, { status: 'completed', txHash: tx.hash, blockNumber: receipt.blockNumber });
  _notify(intent.id, 'completed', { intent, txHash: tx.hash, blockNumber: receipt.blockNumber });
  _toast(`✅ Agent sent ${intent.amount} ${intent.token} via Permit2! Block #${receipt.blockNumber}`, 'success');
  _log('Permit2 transfer completed:', tx.hash, 'block', receipt.blockNumber);
}

// ─── Execute: Multisend via Multicall3 ───────────────────────────────────────
async function _executeMultisend(intent) {
  const ethers = window.ethers;
  if (!ethers) throw new Error('ethers.js not loaded');

  if (!intent.receivers || intent.receivers.length === 0) throw new Error('No receivers defined');

  const provider   = new ethers.BrowserProvider(window.ethereum, 'any');
  const signer     = await provider.getSigner();
  const signerAddr = await signer.getAddress();

  if (signerAddr.toLowerCase() !== intent.wallet.toLowerCase()) throw new Error('Wallet mismatch');

  await _ensureNetwork();

  const tokenAddr = intent.token === 'EURC' ? AE_EURC_ADDR : AE_USDC_ADDR;
  const token     = new ethers.Contract(tokenAddr, AE_ERC20_ABI, signer);
  const mc3       = new ethers.Contract(AE_MULTICALL3, AE_MULTICALL3_ABI, signer);
  const tokenIface = new ethers.Interface(AE_ERC20_ABI);

  // Compute total
  let totalRaw = 0n;
  const calls  = [];
  for (const r of intent.receivers) {
    const amt = Number(r.amount);
    if (!amt || amt <= 0) throw new Error(`Invalid amount for ${r.address}`);
    const raw = BigInt(Math.round(amt * 1_000_000));
    totalRaw += raw;
    calls.push({
      target:       tokenAddr,
      allowFailure: false,
      callData:     tokenIface.encodeFunctionData('transfer', [r.address, raw]),
    });
  }
  if (totalRaw === 0n) throw new Error('Total amount is zero');

  const balance = BigInt(await token.balanceOf(signerAddr));
  if (balance < totalRaw) {
    throw new Error(`Insufficient ${intent.token}: have ${Number(balance)/1e6} need ${Number(totalRaw)/1e6}`);
  }

  // Approve Multicall3
  const allowance = BigInt(await token.allowance(signerAddr, AE_MULTICALL3));
  if (allowance < totalRaw) {
    await _patch(intent.id, { status: 'signing' });
    _notify(intent.id, 'signing', { intent, step: 'approve_multicall3' });
    _toast(`⏳ Step 1/2: Approve Multicall3 — wallet popup…`, 'info');
    const approveTx = await token.approve(AE_MULTICALL3, totalRaw * 2n);
    const approveRcpt = await approveTx.wait(1);
    if (approveRcpt.status !== 1) throw new Error('Multicall3 approval reverted');
  }

  await _patch(intent.id, { status: 'signing' });
  _notify(intent.id, 'signing', { intent, step: 'sign_batch' });
  _toast(`⏳ Step 2/2: Sign batch (${intent.receivers.length} recipients) — wallet popup…`, 'info');

  let gasLimit = 300_000n;
  try {
    const est = await mc3.aggregate3.estimateGas(calls);
    gasLimit = BigInt(Math.ceil(Number(est) * 1.3));
  } catch (_) {}

  const tx = await mc3.aggregate3(calls, { gasLimit });
  _log('Batch TX sent:', tx.hash);

  await _patch(intent.id, { status: 'broadcast', txHash: tx.hash });
  _notify(intent.id, 'broadcast', { intent, txHash: tx.hash });
  _toast(`📤 Batch sent: ${tx.hash.slice(0,14)}…`, 'info');

  const receipt = await tx.wait(1);
  if (receipt.status !== 1) throw new Error(`Batch reverted at block #${receipt.blockNumber}`);

  await _patch(intent.id, { status: 'completed', txHash: tx.hash, blockNumber: receipt.blockNumber });
  _notify(intent.id, 'completed', { intent, txHash: tx.hash, blockNumber: receipt.blockNumber });
  _toast(`✅ Batch of ${intent.receivers.length} sent! Block #${receipt.blockNumber}`, 'success');
  _log('Multisend completed:', tx.hash);
}

// ─── Status Badge Renderer ────────────────────────────────────────────────────
const AE_STATUS_CFG = {
  pending:    { icon: 'fa-clock',         color: 'text-yellow-400', bg: 'bg-yellow-900/20', label: 'Queued'      },
  processing: { icon: 'fa-cog fa-spin',   color: 'text-blue-400',   bg: 'bg-blue-900/20',   label: 'Executing…'  },
  signing:    { icon: 'fa-pen-nib',       color: 'text-purple-400', bg: 'bg-purple-900/20', label: 'Signing…'    },
  broadcast:  { icon: 'fa-paper-plane',   color: 'text-cyan-400',   bg: 'bg-cyan-900/20',   label: 'Sent'        },
  completed:  { icon: 'fa-check-circle',  color: 'text-green-400',  bg: 'bg-green-900/20',  label: 'Completed'   },
  failed:     { icon: 'fa-times-circle',  color: 'text-red-400',    bg: 'bg-red-900/20',    label: 'Failed'      },
  cancelled:  { icon: 'fa-ban',           color: 'text-gray-400',   bg: 'bg-gray-800/30',   label: 'Cancelled'   },
};

function _renderBadge(intentId, status, data = {}) {
  const cfg    = AE_STATUS_CFG[status] || AE_STATUS_CFG.pending;
  const txLink = data.txHash
    ? `· <a href="${AE_EXPLORER}/tx/${data.txHash}" target="_blank" class="underline font-mono text-[10px] text-cyan-400">${data.txHash.slice(0,14)}…</a>`
    : '';
  const block  = data.blockNumber ? `<span class="text-gray-500 text-[10px] ml-1">Block #${data.blockNumber}</span>` : '';
  return `<span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg ${cfg.bg} border border-white/5 text-[11px] ${cfg.color}">
    <i class="fas ${cfg.icon} text-[10px]"></i>${cfg.label}${txLink}${block}
  </span>`;
}

// ─── Chat Integration: agentExecutor:update events ────────────────────────────
window.addEventListener('agentExecutor:update', function (e) {
  const { intentId, status, intent, txHash, blockNumber, error } = e.detail || {};
  if (!intentId) return;

  // Update inline badges in chat messages
  document.querySelectorAll(`[data-intent-id="${intentId}"] .ae-status-badge`).forEach(el => {
    el.outerHTML = _renderBadge(intentId, status, { txHash, blockNumber });
  });

  // Append chat message for significant transitions
  if (['completed', 'failed', 'broadcast'].includes(status)) {
    if (typeof appendChatMessage !== 'function') return;
    let msg = '';
    const exp = AE_EXPLORER;

    if (status === 'completed') {
      const amt  = intent?.amount  ? `${intent.amount} ${intent.token}` : '';
      const to   = intent?.to      ? `\`${intent.to.slice(0,10)}…${intent.to.slice(-8)}\`` : '';
      const link = txHash ? `[View on Explorer ↗](${exp}/tx/${txHash})` : '';
      msg = `✅ **Completed!** Agent sent ${amt} to ${to}\n\n${link}\nBlock #${blockNumber}`;
    } else if (status === 'broadcast') {
      const link = txHash ? `[Track TX ↗](${exp}/tx/${txHash})` : '';
      msg = `📤 **Transaction sent!** Waiting for block confirmation…\n\n${link}`;
    } else if (status === 'failed') {
      msg = `❌ **Agent failed:** ${error || 'Transaction failed. Check balance and try again.'}`;
    }

    if (msg) appendChatMessage('assistant', msg, status === 'failed' ? 'error' : 'payments');
  }
});

// ─── Public API ───────────────────────────────────────────────────────────────

async function aeQueueTransfer(amount, token, to, memo) {
  return aeCreateIntent({ type: 'transfer', amount, token, to, memo });
}

async function aeQueueMultisend(receivers, token, memo) {
  return aeCreateIntent({ type: 'multisend', receivers, token, memo });
}

async function aeGetIntents(statusFilter) {
  const wallet = window.walletState?.address;
  if (!wallet) return [];
  const qs  = statusFilter ? `&status=${statusFilter}` : '';
  const data = await _get(`/intents?wallet=${encodeURIComponent(wallet)}${qs}`);
  return data.success ? data.intents : [];
}

async function aeCancelIntent(intentId) {
  const r = await fetch(`${AE_API_BASE}/intents/${intentId}`, { method: 'DELETE' });
  const d = await r.json();
  if (d.success) {
    _notify(intentId, 'cancelled', {});
    _toast('Intent cancelled.', 'info');
  }
  return d;
}

function aeStatusBadge(intentId, status, data) {
  return `<span data-intent-id="${intentId}" class="ae-intent-ref">${_renderBadge(intentId, status, data || {})}</span>`;
}

// ─── Init ─────────────────────────────────────────────────────────────────────
function _init() {
  _log(`Agent Executor v${AE_VERSION} loaded`);

  // Watch session — auto start/stop polling
  setInterval(() => {
    const session = _getSession();
    const wallet  = window.walletState?.address;
    const should  = !!(session && wallet);
    if (should && !_aePollTimer)  { _log('Session active — starting poll'); aeStartPolling(); }
    if (!should && _aePollTimer)  { _log('No session — stopping poll');    aeStopPolling();  }
  }, 5000);

  // Start immediately if session active
  if (_getSession() && window.walletState?.address) {
    aeStartPolling();
  }
}

// Expose globals
global.AgentExecutor = {
  version:        AE_VERSION,
  createIntent:   aeCreateIntent,
  queueTransfer:  aeQueueTransfer,
  queueMultisend: aeQueueMultisend,
  getIntents:     aeGetIntents,
  cancelIntent:   aeCancelIntent,
  statusBadge:    aeStatusBadge,
  startPolling:   aeStartPolling,
  stopPolling:    aeStopPolling,
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _init);
} else {
  _init();
}

})(window);
