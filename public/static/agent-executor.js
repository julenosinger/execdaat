// ============================================================
// AGENT EXECUTOR v1 — ExecDaat
// Build: 20260403a
//
// Architecture:
//   • Creates intents via POST /api/agent/intents
//   • Polls GET /api/agent/poll every POLL_MS
//   • For each "pending" intent picked up → asks wallet to sign
//   • Executes ERC-20 transfer or Multicall3 batch on-chain
//   • Updates intent status via PATCH /api/agent/intents/:id
//   • Notifies chat UI via custom events
//
// Security:
//   • Validates session (arcPaySession.authorized)
//   • Amount > 0 guard on every tx
//   • User confirmation popup for intents > CONFIRM_THRESHOLD USDC
//   • Replay prevention: intent id stored in sessionStorage after broadcast
//
// NO backend wallet / private key involved.
// The user's MetaMask (or injected wallet) signs every tx.
// ============================================================
'use strict';

(function (global) {

// ─── Constants ────────────────────────────────────────────────────────────────
const AE_VERSION        = '20260403a';
const AE_API_BASE       = '/api/agent';
const AE_POLL_MS        = 2500;          // poll interval
const AE_MAX_RETRIES    = 3;
const AE_CONFIRM_THRESH = 100;           // USDC: ask confirmation if amount >= this
const AE_STORAGE_KEY    = 'ae_executed'; // sessionStorage: executed intent ids

const AE_RPC         = 'https://rpc.testnet.arc.network';
const AE_CHAIN_ID    = 5042002;
const AE_EXPLORER    = 'https://testnet.arcscan.app';
const AE_USDC_ADDR   = '0x3600000000000000000000000000000000000000';
const AE_EURC_ADDR   = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const AE_MULTICALL3  = '0xcA11bde05977b3631167028862bE2a173976CA11';

const AE_ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

const AE_MULTICALL3_ABI = [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)',
];

// ─── State ────────────────────────────────────────────────────────────────────
let _aeRunning    = false;
let _aePollTimer  = null;
let _aeLastPoll   = null;   // ISO timestamp of last poll
let _aeActive     = false;  // true when agent session is valid

// ─── Logging ──────────────────────────────────────────────────────────────────
function _aeLog(...a)  { console.log('%c[AGENT-EXEC v1]', 'color:#a78bfa;font-weight:bold', ...a); }
function _aeWarn(...a) { console.warn('[AGENT-EXEC v1]', ...a); }
function _aeErr(...a)  { console.error('[AGENT-EXEC v1]', ...a); }

// ─── Toast helper ─────────────────────────────────────────────────────────────
function _aeToast(msg, type = 'info') {
  if (typeof showToast === 'function') showToast(msg, type);
}

// ─── Chat notification ────────────────────────────────────────────────────────
function _aeNotifyChat(intentId, status, data = {}) {
  window.dispatchEvent(new CustomEvent('agentExecutor:update', {
    detail: { intentId, status, ...data }
  }));
}

// ─── Session check ────────────────────────────────────────────────────────────
function _aeGetSession() {
  const key = 'arc-pay-session-v3';
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s?.authorized || !s?.wallet || !s?.expiry) return null;
    if (Date.now() > s.expiry) return null;
    return s;
  } catch { return null; }
}

// ─── Executed guard ───────────────────────────────────────────────────────────
function _aeMarkExecuted(intentId) {
  try {
    const raw = sessionStorage.getItem(AE_STORAGE_KEY) || '[]';
    const ids = JSON.parse(raw);
    if (!ids.includes(intentId)) { ids.push(intentId); sessionStorage.setItem(AE_STORAGE_KEY, JSON.stringify(ids)); }
  } catch {}
}
function _aeWasExecuted(intentId) {
  try {
    const raw = sessionStorage.getItem(AE_STORAGE_KEY) || '[]';
    return JSON.parse(raw).includes(intentId);
  } catch { return false; }
}

// ─── API helpers ──────────────────────────────────────────────────────────────
async function _aePost(path, body) {
  const r = await fetch(AE_API_BASE + path, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  return r.json();
}

async function _aeGet(path) {
  const r = await fetch(AE_API_BASE + path);
  return r.json();
}

async function _aePatch(intentId, body) {
  const r = await fetch(`${AE_API_BASE}/intents/${intentId}`, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  return r.json();
}

// ─── Create Intent ────────────────────────────────────────────────────────────
async function aeCreateIntent(params) {
  const session = _aeGetSession();
  const wallet  = window.walletState?.address;
  if (!wallet) throw new Error('Wallet not connected');
  if (!session) throw new Error('Agent session expired. Please re-authorize.');

  const payload = {
    type:        params.type || 'transfer',
    wallet:      wallet,
    token:       (params.token || 'USDC').toUpperCase(),
    amount:      params.amount != null ? String(params.amount) : undefined,
    to:          params.to,
    receivers:   params.receivers,
    memo:        params.memo,
    sessionHash: session.sessionHash,
    signature:   session.signature,
  };

  // Safety: never create zero-amount transfer
  if (payload.type === 'transfer') {
    if (!payload.amount || Number(payload.amount) <= 0) {
      throw new Error('Intent amount must be greater than 0');
    }
  }

  const result = await _aePost('/intents', payload);
  if (!result.success) throw new Error(result.error || 'Failed to create intent');

  _aeLog('Intent created:', result.intent.id, payload.type);
  _aeNotifyChat(result.intent.id, 'pending', { intent: result.intent });

  // Start polling if not already running
  aeStartPolling();

  return result.intent;
}

// ─── Poll Loop ────────────────────────────────────────────────────────────────
function aeStartPolling() {
  if (_aePollTimer) return; // already running
  _aeLog('Starting poll loop (every', AE_POLL_MS, 'ms)');
  _aePollTimer = setInterval(_aePoll, AE_POLL_MS);
  // Run immediately
  setTimeout(_aePoll, 100);
}

function aeStopPolling() {
  if (_aePollTimer) { clearInterval(_aePollTimer); _aePollTimer = null; }
  _aeLog('Poll loop stopped');
}

async function _aePoll() {
  const wallet = window.walletState?.address;
  if (!wallet) return;

  const session = _aeGetSession();
  if (!session) {
    // Session expired — stop polling, notify user
    if (_aePollTimer) {
      aeStopPolling();
      _aeLog('Poll stopped: session expired');
    }
    return;
  }

  try {
    const since = _aeLastPoll ? `&since=${encodeURIComponent(_aeLastPoll)}` : '';
    const data  = await _aeGet(`/poll?wallet=${encodeURIComponent(wallet)}${since}`);
    if (!data.success) return;

    _aeLastPoll = data.timestamp;

    if (!data.intents || data.intents.length === 0) return;

    _aeLog(`Poll: ${data.intents.length} updated intent(s)`);

    for (const intent of data.intents) {
      await _aeHandleIntent(intent);
    }
  } catch (e) {
    _aeWarn('Poll error:', e.message);
  }
}

// ─── Handle a single intent ───────────────────────────────────────────────────
async function _aeHandleIntent(intent) {
  // Already executed in this session → skip (replay protection)
  if (_aeWasExecuted(intent.id)) {
    return;
  }

  // Notify chat of any status update (completed/failed from another tab, etc.)
  _aeNotifyChat(intent.id, intent.status, { intent });

  // Only process pending intents
  if (intent.status !== 'pending') return;

  // Wallet must be the intent owner
  const wallet = window.walletState?.address;
  if (!wallet || wallet.toLowerCase() !== intent.wallet.toLowerCase()) return;

  // Mark as executed to avoid re-processing in next poll cycle
  _aeMarkExecuted(intent.id);

  // Execute
  try {
    await _aeExecuteIntent(intent);
  } catch (e) {
    _aeErr('executeIntent error for', intent.id, e);
  }
}

// ─── Execute Intent ───────────────────────────────────────────────────────────
async function _aeExecuteIntent(intent) {
  _aeLog('Executing intent:', intent.id, intent.type);

  // Update status → processing
  await _aePatch(intent.id, { status: 'processing' });
  _aeNotifyChat(intent.id, 'processing', { intent });
  _aeToast(`🤖 Daat Agent: executing ${intent.type}…`, 'info');

  // For high-value, ask confirmation
  if (intent.type === 'transfer' && Number(intent.amount) >= AE_CONFIRM_THRESH) {
    const ok = confirm(
      `Agent wants to send ${intent.amount} ${intent.token} to ${intent.to}.\n\nConfirm?`
    );
    if (!ok) {
      await _aePatch(intent.id, { status: 'cancelled' });
      _aeNotifyChat(intent.id, 'cancelled', { intent });
      _aeToast('Transaction cancelled by user.', 'warning');
      return;
    }
  }

  try {
    if (intent.type === 'transfer') {
      await _aeExecuteTransfer(intent);
    } else if (intent.type === 'multisend') {
      await _aeExecuteMultisend(intent);
    } else {
      // Unsupported type for direct execution — mark for manual action
      await _aePatch(intent.id, {
        status: 'failed',
        error: `Type "${intent.type}" requires manual wallet interaction. Use the dedicated tab.`,
      });
      _aeNotifyChat(intent.id, 'failed', {
        intent,
        error: `Type "${intent.type}" requires manual wallet interaction.`,
      });
    }
  } catch (err) {
    const errMsg = err?.message || String(err);
    const retries = (intent.retries || 0) + 1;

    if (retries < AE_MAX_RETRIES && !errMsg.includes('ACTION_REJECTED') && !errMsg.includes('4001')) {
      // Retry: reset to pending
      await _aePatch(intent.id, { status: 'pending', retries, error: errMsg });
      _aeMarkExecuted(intent.id); // will be re-evaluated after next poll marks unexecuted? No:
      // Remove from executed set so it can be retried
      _aeRemoveFromExecuted(intent.id);
      _aeLog(`Retrying intent ${intent.id} (attempt ${retries}/${AE_MAX_RETRIES})`);
      _aeNotifyChat(intent.id, 'pending', { intent, retry: retries });
    } else {
      await _aePatch(intent.id, { status: 'failed', error: errMsg });
      _aeNotifyChat(intent.id, 'failed', { intent, error: errMsg });
      _aeToast(`❌ Agent failed: ${errMsg.slice(0, 80)}`, 'error');
    }
  }
}

function _aeRemoveFromExecuted(intentId) {
  try {
    const raw = sessionStorage.getItem(AE_STORAGE_KEY) || '[]';
    const ids = JSON.parse(raw).filter(id => id !== intentId);
    sessionStorage.setItem(AE_STORAGE_KEY, JSON.stringify(ids));
  } catch {}
}

// ─── Execute: ERC-20 Transfer ─────────────────────────────────────────────────
async function _aeExecuteTransfer(intent) {
  const ethers  = window.ethers;
  if (!ethers) throw new Error('ethers.js not loaded');

  // Safety guard
  const amount = Number(intent.amount);
  if (!amount || amount <= 0) throw new Error('Intent amount must be > 0');

  const provider = new ethers.BrowserProvider(window.ethereum, 'any');
  const signer   = await provider.getSigner();
  const signerAddr = await signer.getAddress();

  // Verify wallet matches
  if (signerAddr.toLowerCase() !== intent.wallet.toLowerCase()) {
    throw new Error('Connected wallet does not match intent wallet. Switch wallet and retry.');
  }

  // Ensure correct network
  const chainHex = await window.ethereum.request({ method: 'eth_chainId' });
  if (parseInt(chainHex, 16) !== AE_CHAIN_ID) {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x4cef52' }],
    });
    await new Promise(r => setTimeout(r, 800));
  }

  // Token contract
  const tokenAddr = intent.token === 'EURC' ? AE_EURC_ADDR : AE_USDC_ADDR;
  const token     = new ethers.Contract(tokenAddr, AE_ERC20_ABI, signer);

  // Amount in smallest unit (6 decimals for USDC/EURC)
  const amountRaw = BigInt(Math.round(amount * 1_000_000));
  if (amountRaw === 0n) throw new Error('Computed amount is zero — check decimals');

  // Balance check
  const balance = await token.balanceOf(signerAddr);
  if (BigInt(balance) < amountRaw) {
    throw new Error(`Insufficient ${intent.token}: have ${Number(balance) / 1e6} need ${amount}`);
  }

  // Update status → signing
  await _aePatch(intent.id, { status: 'signing' });
  _aeNotifyChat(intent.id, 'signing', { intent });
  _aeToast(`⏳ Waiting for wallet signature… (send ${amount} ${intent.token})`, 'info');

  // Gas estimate
  let gasLimit = 80_000n;
  try {
    const est = await token.transfer.estimateGas(intent.to, amountRaw);
    gasLimit = BigInt(Math.ceil(Number(est) * 1.3));
  } catch (_) {}

  // Send tx
  const tx = await token.transfer(intent.to, amountRaw, { gasLimit });

  // Update status → broadcast
  await _aePatch(intent.id, { status: 'broadcast', txHash: tx.hash });
  _aeNotifyChat(intent.id, 'broadcast', { intent, txHash: tx.hash });
  _aeToast(
    `📤 Tx sent: <a href="${AE_EXPLORER}/tx/${tx.hash}" target="_blank" class="underline">${tx.hash.slice(0,14)}…</a>`,
    'info'
  );

  // Wait for confirmation
  const receipt = await tx.wait(1);
  if (receipt.status !== 1) throw new Error(`Transaction reverted at block #${receipt.blockNumber}`);

  // Update status → completed
  await _aePatch(intent.id, { status: 'completed', txHash: tx.hash, blockNumber: receipt.blockNumber });
  _aeNotifyChat(intent.id, 'completed', { intent, txHash: tx.hash, blockNumber: receipt.blockNumber });
  _aeToast(
    `✅ Agent sent ${amount} ${intent.token}! Block #${receipt.blockNumber}`,
    'success'
  );

  _aeLog('Transfer completed:', tx.hash, 'block', receipt.blockNumber);
}

// ─── Execute: Multicall3 Multisend ───────────────────────────────────────────
async function _aeExecuteMultisend(intent) {
  const ethers  = window.ethers;
  if (!ethers) throw new Error('ethers.js not loaded');

  if (!intent.receivers || intent.receivers.length === 0) {
    throw new Error('Multisend: no receivers defined');
  }

  const provider = new ethers.BrowserProvider(window.ethereum, 'any');
  const signer   = await provider.getSigner();
  const signerAddr = await signer.getAddress();

  if (signerAddr.toLowerCase() !== intent.wallet.toLowerCase()) {
    throw new Error('Wallet mismatch');
  }

  // Ensure correct network
  const chainHex = await window.ethereum.request({ method: 'eth_chainId' });
  if (parseInt(chainHex, 16) !== AE_CHAIN_ID) {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x4cef52' }],
    });
    await new Promise(r => setTimeout(r, 800));
  }

  const tokenAddr = intent.token === 'EURC' ? AE_EURC_ADDR : AE_USDC_ADDR;
  const token     = new ethers.Contract(tokenAddr, AE_ERC20_ABI, signer);
  const mc3       = new ethers.Contract(AE_MULTICALL3, AE_MULTICALL3_ABI, signer);

  // Compute totals and validate
  let totalRaw = 0n;
  const calls = [];
  const tokenIface = new ethers.Interface(AE_ERC20_ABI);

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

  // Balance check
  const balance = await token.balanceOf(signerAddr);
  if (BigInt(balance) < totalRaw) {
    throw new Error(`Insufficient balance: have ${Number(balance)/1e6} need ${Number(totalRaw)/1e6} ${intent.token}`);
  }

  // Allowance check for Multicall3
  const allowance = await token.allowance(signerAddr, AE_MULTICALL3);
  if (BigInt(allowance) < totalRaw) {
    await _aePatch(intent.id, { status: 'signing' });
    _aeNotifyChat(intent.id, 'signing', { intent, step: 'approve' });
    _aeToast(`⏳ Approve Multicall3 to spend ${Number(totalRaw)/1e6} ${intent.token}…`, 'info');

    const approveTx = await token.approve(AE_MULTICALL3, totalRaw);
    const approveReceipt = await approveTx.wait(1);
    if (approveReceipt.status !== 1) throw new Error('Approval reverted');
  }

  // Update → signing
  await _aePatch(intent.id, { status: 'signing' });
  _aeNotifyChat(intent.id, 'signing', { intent, step: 'batch' });
  _aeToast(`⏳ Sign batch transaction (${intent.receivers.length} recipients)…`, 'info');

  let gasLimit = 300_000n;
  try {
    const est = await mc3.aggregate3.estimateGas(calls);
    gasLimit = BigInt(Math.ceil(Number(est) * 1.3));
  } catch (_) {}

  const tx = await mc3.aggregate3(calls, { gasLimit });

  await _aePatch(intent.id, { status: 'broadcast', txHash: tx.hash });
  _aeNotifyChat(intent.id, 'broadcast', { intent, txHash: tx.hash });
  _aeToast(`📤 Batch sent: ${tx.hash.slice(0,14)}…`, 'info');

  const receipt = await tx.wait(1);
  if (receipt.status !== 1) throw new Error(`Batch reverted at block #${receipt.blockNumber}`);

  await _aePatch(intent.id, { status: 'completed', txHash: tx.hash, blockNumber: receipt.blockNumber });
  _aeNotifyChat(intent.id, 'completed', { intent, txHash: tx.hash, blockNumber: receipt.blockNumber });
  _aeToast(`✅ Batch of ${intent.receivers.length} sent! Block #${receipt.blockNumber}`, 'success');
  _aeLog('Multisend completed:', tx.hash);
}

// ─── Intent Status Panel (injects into chat widget) ──────────────────────────
function _aeRenderStatusBadge(intentId, status, data = {}) {
  const statusConfig = {
    pending:    { icon: 'fa-clock',        color: 'text-yellow-400', bg: 'bg-yellow-900/20', label: 'Queued'      },
    processing: { icon: 'fa-cog fa-spin',  color: 'text-blue-400',   bg: 'bg-blue-900/20',   label: 'Processing…' },
    signing:    { icon: 'fa-pen',          color: 'text-purple-400', bg: 'bg-purple-900/20', label: 'Signing…'    },
    broadcast:  { icon: 'fa-paper-plane',  color: 'text-cyan-400',   bg: 'bg-cyan-900/20',   label: 'Sent'        },
    completed:  { icon: 'fa-check-circle', color: 'text-green-400',  bg: 'bg-green-900/20',  label: 'Completed'   },
    failed:     { icon: 'fa-times-circle', color: 'text-red-400',    bg: 'bg-red-900/20',    label: 'Failed'      },
    cancelled:  { icon: 'fa-ban',          color: 'text-gray-400',   bg: 'bg-gray-800/40',   label: 'Cancelled'   },
  };

  const cfg = statusConfig[status] || statusConfig.pending;
  const txLink = data.txHash
    ? `<a href="${AE_EXPLORER}/tx/${data.txHash}" target="_blank" class="underline font-mono text-[10px] text-cyan-400">${data.txHash.slice(0,14)}…</a>`
    : '';
  const blockInfo = data.blockNumber ? `Block #${data.blockNumber}` : '';

  return `<span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg ${cfg.bg} border border-white/5 text-[11px] ${cfg.color}">
    <i class="fas ${cfg.icon} text-[10px]"></i>${cfg.label}
    ${txLink ? ' · ' + txLink : ''}
    ${blockInfo ? '<span class="text-gray-500 text-[10px]">' + blockInfo + '</span>' : ''}
  </span>`;
}

// ─── Chat Integration: Listen for agentExecutor:update events ────────────────
window.addEventListener('agentExecutor:update', function (e) {
  const { intentId, status, intent, txHash, blockNumber, error } = e.detail || {};
  if (!intentId) return;

  // Find and update any chat message referencing this intent
  document.querySelectorAll(`[data-intent-id="${intentId}"]`).forEach(el => {
    const badge = el.querySelector('.ae-status-badge');
    if (badge) {
      badge.outerHTML = _aeRenderStatusBadge(intentId, status, { txHash, blockNumber });
    }
  });

  // Also append a chat update for significant transitions
  if (['completed', 'failed', 'broadcast'].includes(status)) {
    if (typeof appendChatMessage === 'function') {
      let msg = '';
      if (status === 'completed') {
        msg = `✅ **Agent executed!**\n\nTransaction confirmed on-chain.\n${txHash ? `[View on Explorer](${AE_EXPLORER}/tx/${txHash})` : ''}\nBlock #${blockNumber}`;
      } else if (status === 'broadcast') {
        msg = `📤 **Transaction sent!**\n\nAwaiting block confirmation…\n${txHash ? `[Track tx](${AE_EXPLORER}/tx/${txHash})` : ''}`;
      } else if (status === 'failed') {
        msg = `❌ **Agent failed**\n\n${error || 'Transaction failed. Check your balance and try again.'}`;
      }
      if (msg) appendChatMessage('assistant', msg, status === 'failed' ? 'error' : 'payments');
    }
  }
});

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a transfer intent and start the executor.
 * Called by chat.js instead of _chatQueueTransfer for authorized sessions.
 *
 * @param {string} amount  - human-readable amount ("10.5")
 * @param {string} token   - "USDC" | "EURC"
 * @param {string} to      - recipient 0x address
 * @param {string} memo    - optional memo
 * @returns {Promise<object>} created intent
 */
async function aeQueueTransfer(amount, token, to, memo) {
  return aeCreateIntent({ type: 'transfer', amount, token, to, memo });
}

/**
 * Create a multisend intent.
 *
 * @param {Array<{address, amount}>} receivers
 * @param {string} token
 * @param {string} memo
 */
async function aeQueueMultisend(receivers, token, memo) {
  return aeCreateIntent({ type: 'multisend', receivers, token, memo });
}

/**
 * Get intent list for current wallet.
 */
async function aeGetIntents(statusFilter) {
  const wallet = window.walletState?.address;
  if (!wallet) return [];
  const qs = statusFilter ? `&status=${statusFilter}` : '';
  const data = await _aeGet(`/intents?wallet=${encodeURIComponent(wallet)}${qs}`);
  return data.success ? data.intents : [];
}

/**
 * Cancel a pending intent.
 */
async function aeCancelIntent(intentId) {
  const r = await fetch(`${AE_API_BASE}/intents/${intentId}`, { method: 'DELETE' });
  const data = await r.json();
  if (data.success) {
    _aeNotifyChat(intentId, 'cancelled', {});
    _aeToast('Intent cancelled.', 'info');
  }
  return data;
}

/**
 * Render status badge HTML (for use in chat messages).
 */
function aeStatusBadge(intentId, status, data) {
  return `<span data-intent-id="${intentId}" class="ae-intent-ref">` +
    _aeRenderStatusBadge(intentId, status, data || {}) +
    `</span>`;
}

// ─── Init ─────────────────────────────────────────────────────────────────────
function _aeInit() {
  _aeLog(`Agent Executor v${AE_VERSION} loaded`);

  // Watch session changes — start/stop polling accordingly
  setInterval(() => {
    const session = _aeGetSession();
    const wallet  = window.walletState?.address;
    const shouldRun = !!(session && wallet);

    if (shouldRun && !_aePollTimer) {
      _aeLog('Session active — starting poll');
      aeStartPolling();
    } else if (!shouldRun && _aePollTimer) {
      _aeLog('Session inactive — stopping poll');
      aeStopPolling();
    }
  }, 3000);

  // If session already active, start polling immediately
  if (_aeGetSession() && window.walletState?.address) {
    aeStartPolling();
  }
}

// ─── Expose globals ───────────────────────────────────────────────────────────
global.AgentExecutor = {
  version:         AE_VERSION,
  createIntent:    aeCreateIntent,
  queueTransfer:   aeQueueTransfer,
  queueMultisend:  aeQueueMultisend,
  getIntents:      aeGetIntents,
  cancelIntent:    aeCancelIntent,
  statusBadge:     aeStatusBadge,
  startPolling:    aeStartPolling,
  stopPolling:     aeStopPolling,
};

// Start
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _aeInit);
} else {
  _aeInit();
}

})(window);
