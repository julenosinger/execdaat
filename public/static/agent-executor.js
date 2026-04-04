// ============================================================
// AGENT EXECUTOR v4 — ExecDaat — Meta-Transaction System
// Build: 20260404f
//
// ┌─────────────────────────────────────────────────────────┐
// │           GASLESS META-TRANSACTION ARCHITECTURE          │
// │                                                          │
// │  User → signTypedData(EIP-712) → Backend Relayer        │
// │       → AgentExecutor.execute(request, sig)             │
// │       → NO wallet popup after initial setup             │
// └─────────────────────────────────────────────────────────┘
//
// Flow (gasless path):
//   1. User opens Autonoma tab, Daat Agent is authorized
//   2. User types "send 10 USDC to 0x…"
//   3. Executor checks if AgentExecutor contract is approved as spender
//      a. If NOT approved → show ONE wallet popup for approve (one-time setup)
//      b. If approved     → proceed directly
//   4. Get current nonce from /api/agent/relay/nonce/:wallet
//   5. Build EIP-712 typed data (TransferIntent or BatchIntent)
//   6. Call signer.signTypedData() → ONE wallet popup (just sign, no gas!)
//   7. POST /api/agent/relay with { type, from, token, to, amountRaw, nonce, deadline, signature }
//   8. UI shows: "✍️ Signature received" → "🤖 Executing via agent" → "📤 TX sent" → "✅ Completed"
//   9. Poll /api/agent/relay/:jobId every 2s for status
//  10. No wallet popup after signing — relayer pays all gas
//
// Execution priority:
//   1. AgentExecutor meta-tx path (gasless — relayer pays gas)       ← PRIMARY
//   2. Permit2 SignatureTransfer (user signs per-tx, user pays gas)   ← fallback
//   3. Direct ERC-20 transfer (user signs + pays gas)                ← last resort
//
// Security:
//   • Per-user nonce prevents replay attacks
//   • Deadline (1 hour) prevents stale signatures
//   • Server validates signature before broadcasting
//   • Contract re-validates signature on-chain (double verification)
//   • Replay guard in sessionStorage
//   • Wallet ownership verified before signing
//
// UX Messages (in Autonoma chat):
//   "✍️ Signature received — submitting to agent relayer…"
//   "🤖 Executing via agent — TX sent to network…"
//   "📤 Transaction broadcast — waiting for confirmation…"
//   "✅ Completed! [View on Explorer ↗]"
// ============================================================
'use strict';

(function (global) {

// ─── Constants ────────────────────────────────────────────────────────────────
const AE_VERSION         = '20260404f';
const AE_API_BASE        = '/api/agent';
const AE_POLL_MS         = 3000;
const AE_MAX_RETRIES     = 3;
const AE_CONFIRM_THRESH  = 50;
const AE_STORAGE_KEY     = 'ae_executed';
const AE_PERMIT_STORE    = 'arc_permit2_allowances_v1';
const AE_SESSION_KEY     = 'arc-pay-session-v3';
const AE_RELAY_NONCE_KEY = 'ae_relay_nonce_';    // sessionStorage key prefix

const AE_RPC        = 'https://rpc.testnet.arc.network';
const AE_CHAIN_ID   = 5042002;
const AE_CHAIN_HEX  = '0x4cef52';
const AE_EXPLORER   = 'https://testnet.arcscan.app';
const AE_USDC_ADDR  = '0x3600000000000000000000000000000000000000';
const AE_EURC_ADDR  = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';

// Permit2 (for fallback path)
const AE_PERMIT2_ADDR = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const AE_MULTICALL3   = '0xcA11bde05977b3631167028862bE2a173976CA11';

// AgentExecutor contract on Arc Testnet
// Update this address after deploying AgentExecutor.sol
// Current: placeholder — set after deployment via Remix/Hardhat
const AE_CONTRACT_ADDR = (function() {
  try {
    // Allow override via localStorage for testing
    return localStorage.getItem('ae_contract_addr') ||
      '0x0000000000000000000000000000000000000000';
  } catch { return '0x0000000000000000000000000000000000000000'; }
})();

// EIP-712 Domain for AgentExecutor (must match deployed contract)
const AE_EIP712_DOMAIN = {
  name:              'AgentExecutor',
  version:           '1',
  chainId:           AE_CHAIN_ID,
  verifyingContract: AE_CONTRACT_ADDR,
};

// EIP-712 Types
const AE_TRANSFER_TYPES = {
  TransferIntent: [
    { name: 'from',     type: 'address' },
    { name: 'token',    type: 'address' },
    { name: 'to',       type: 'address' },
    { name: 'amount',   type: 'uint256' },
    { name: 'nonce',    type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

const AE_BATCH_TYPES = {
  BatchIntent: [
    { name: 'from',       type: 'address'   },
    { name: 'token',      type: 'address'   },
    { name: 'recipients', type: 'address[]' },
    { name: 'amounts',    type: 'uint256[]' },
    { name: 'nonce',      type: 'uint256'   },
    { name: 'deadline',   type: 'uint256'   },
  ],
};

// Permit2 EIP-712 (for fallback)
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

// ─── ABIs ─────────────────────────────────────────────────────────────────────
const AE_ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
  'function transferFrom(address,address,uint256) returns (bool)',
];
const AE_PERMIT2_ABI = [
  'function permitTransferFrom(tuple(tuple(address token,uint256 amount) permitted,uint256 nonce,uint256 deadline) permit,tuple(address to,uint256 requestedAmount) transferDetails,address owner,bytes signature)',
  'function nonceBitmap(address,uint256) view returns (uint256)',
];
const AE_MULTICALL3_ABI = [
  'function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns (tuple(bool success,bytes returnData)[] returnData)',
];

// ─── State ────────────────────────────────────────────────────────────────────
let _aeRunning   = false;
let _aePollTimer = null;
let _aeLastPoll  = null;

// ─── Logging ──────────────────────────────────────────────────────────────────
function _log(...a)  { console.log('%c[AGENT-EXEC v4]', 'color:#a78bfa;font-weight:bold', ...a); }
function _warn(...a) { console.warn('[AGENT-EXEC v4]', ...a); }
function _err(...a)  { console.error('[AGENT-EXEC v4]', ...a); }

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

// ─── Meta-tx notification (for Autonoma chat specific messages) ───────────────
function _notifyMetaTx(msg, type = 'info') {
  window.dispatchEvent(new CustomEvent('agentMetaTx:message', {
    detail: { msg, type }
  }));
}

// ─── Session ──────────────────────────────────────────────────────────────────
function _getSession() {
  try {
    const raw = localStorage.getItem(AE_SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s?.authorized || !s?.wallet || !s?.expiry) return null;
    if (Date.now() > s.expiry) return null;
    return s;
  } catch { return null; }
}

// ─── Permit2 Spending Permissions ─────────────────────────────────────────────
function _getActivePermits(wallet) {
  try {
    const raw = localStorage.getItem(AE_PERMIT_STORE);
    if (!raw) return [];
    const now = Date.now();
    return JSON.parse(raw).filter(p =>
      p.wallet && p.wallet.toLowerCase() === wallet.toLowerCase() &&
      p.expiry > now && (p.amount - (p.amountUsed || 0)) > 0
    );
  } catch { return []; }
}

function _findPermit(wallet, token, amount) {
  const permits = _getActivePermits(wallet);
  const tokenUpper = (token || 'USDC').toUpperCase();
  return permits.find(p => {
    const tokenMatch = p.token.toUpperCase() === tokenUpper;
    const scopeOk   = p.scope === 'all' || p.scope === 'payments';
    const remaining = (p.amount || 0) - (p.amountUsed || 0);
    const amountOk  = remaining >= Number(amount);
    return tokenMatch && scopeOk && amountOk;
  }) || null;
}

function _recordPermitUsage(permitId, amountUsed) {
  try {
    const raw = localStorage.getItem(AE_PERMIT_STORE);
    if (!raw) return;
    const all = JSON.parse(raw);
    const idx = all.findIndex(p => p.id === permitId);
    if (idx >= 0) {
      all[idx].amountUsed = (all[idx].amountUsed || 0) + Number(amountUsed);
      localStorage.setItem(AE_PERMIT_STORE, JSON.stringify(all));
    }
  } catch (e) { _warn('permit usage record failed:', e.message); }
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

// ─── AgentExecutor contract availability check ────────────────────────────────
async function _agentContractAvailable() {
  try {
    if (AE_CONTRACT_ADDR === '0x0000000000000000000000000000000000000000') return false;
    const r = await fetch(AE_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc:'2.0', method:'eth_getCode', params:[AE_CONTRACT_ADDR,'latest'], id:1 }),
    });
    const d = await r.json();
    return d.result && d.result.length > 4;
  } catch { return false; }
}

// ─── Get on-chain nonce from relay API ────────────────────────────────────────
async function _getRelayNonce(wallet) {
  try {
    const r = await fetch(`${AE_API_BASE}/relay/nonce/${wallet}`);
    const d = await r.json();
    if (d.success) return BigInt(d.nonce);
    return 0n;
  } catch {
    // Fall back to 0 if relay endpoint not available
    return 0n;
  }
}

// ─── Check & ensure AgentExecutor approval (ONE-TIME setup) ──────────────────
// This is the only wallet popup in the gasless flow (one-time, per token)
async function _ensureAgentContractApproval(signer, signerAddr, tokenAddr, amountRaw, ethers, intentId) {
  const token = new ethers.Contract(tokenAddr, AE_ERC20_ABI, signer);
  const allowance = BigInt(await token.allowance(signerAddr, AE_CONTRACT_ADDR));

  if (allowance >= amountRaw) return; // Already approved ✓

  _log('AgentExecutor not approved — requesting one-time setup approval…');
  if (intentId) {
    await _patch(intentId, { status: 'signing' });
    _notify(intentId, 'signing', { step: 'approve_agent_contract' });
  }
  _toast('⚙️ One-time setup: Approve AgentExecutor contract — wallet popup (this is the last popup!)…', 'info');
  _notifyMetaTx('⚙️ **One-time setup required** — approving AgentExecutor as spender…\n\n*This is the only wallet popup you will see. All future transactions will be gasless.*', 'info');

  const maxUint256 = 2n ** 256n - 1n;
  const approveTx  = await token.approve(AE_CONTRACT_ADDR, maxUint256);
  const approveRcpt = await approveTx.wait(1);
  if (approveRcpt.status !== 1) throw new Error('AgentExecutor approval reverted');
  _log('AgentExecutor approved (max allowance) — all future transfers will be gasless!');
  _toast('✅ Agent contract approved! Future transfers will be gasless.', 'success');
  _notifyMetaTx('✅ **Agent contract approved!** All future transfers will be gasless — no more wallet popups.', 'success');
}

// ─── GASLESS META-TX: Sign + Submit intent ────────────────────────────────────
// This is the PRIMARY execution path.
// User signs ONE EIP-712 message — relayer pays all gas.
async function _executeViaMetaTx(signer, signerAddr, intent, tokenAddr, amountRaw, ethers) {
  if (!AE_CONTRACT_ADDR || AE_CONTRACT_ADDR === '0x0000000000000000000000000000000000000000') {
    throw new Error('AgentExecutor contract not deployed. Using fallback path.');
  }

  await _ensureNetwork();
  await _ensureAgentContractApproval(signer, signerAddr, tokenAddr, amountRaw, ethers, intent.id);

  // Get on-chain nonce for this wallet
  const nonce    = await _getRelayNonce(signerAddr);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour

  // Build EIP-712 typed data
  let typedData, relayBody;
  if (intent.type === 'transfer') {
    typedData = {
      domain: AE_EIP712_DOMAIN,
      types:  AE_TRANSFER_TYPES,
      message: {
        from:     signerAddr,
        token:    tokenAddr,
        to:       intent.to,
        amount:   amountRaw,
        nonce:    nonce,
        deadline: deadline,
      },
    };
    relayBody = {
      type:      'transfer',
      from:      signerAddr,
      token:     tokenAddr,
      to:        intent.to,
      amount:    intent.amount,
      amountRaw: amountRaw.toString(),
      nonce:     nonce.toString(),
      deadline:  deadline.toString(),
      intentId:  intent.id,
    };
  } else if (intent.type === 'multisend') {
    if (!intent.receivers || intent.receivers.length === 0) throw new Error('No receivers');
    const recipients = intent.receivers.map(r => r.address);
    const amounts    = intent.receivers.map(r => BigInt(Math.round(Number(r.amount) * 1_000_000)));
    typedData = {
      domain: AE_EIP712_DOMAIN,
      types:  AE_BATCH_TYPES,
      message: {
        from:       signerAddr,
        token:      tokenAddr,
        recipients: recipients,
        amounts:    amounts,
        nonce:      nonce,
        deadline:   deadline,
      },
    };
    relayBody = {
      type:       'batch',
      from:       signerAddr,
      token:      tokenAddr,
      recipients: intent.receivers.map((r, i) => ({
        address:   r.address,
        amount:    r.amount,
        amountRaw: amounts[i].toString(),
      })),
      nonce:      nonce.toString(),
      deadline:   deadline.toString(),
      intentId:   intent.id,
    };
  } else {
    throw new Error(`Meta-tx not supported for type "${intent.type}"`);
  }

  // Sign EIP-712 typed data (ONE wallet popup — signing only, no gas!)
  await _patch(intent.id, { status: 'signing' });
  _notify(intent.id, 'signing', { intent, step: 'sign_meta_tx' });
  _toast('✍️ Sign intent (no gas needed) — wallet popup…', 'info');
  _notifyMetaTx('✍️ **Signing intent** — please confirm the signature in your wallet (no gas required)…', 'info');

  const signature = await signer.signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message
  );

  _log('EIP-712 signature obtained:', signature.slice(0, 20) + '…');
  _notifyMetaTx('✅ **Signature received** — submitting to agent relayer…', 'success');
  _toast('✍️ Signature received — submitting to relayer…', 'info');

  // Submit to relay API
  const r = await fetch(`${AE_API_BASE}/relay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...relayBody, signature }),
  });
  const relayResult = await r.json();

  if (!relayResult.success) {
    throw new Error(relayResult.error || 'Relay submission failed');
  }

  const jobId = relayResult.jobId;
  _log('Relay job created:', jobId);
  _notifyMetaTx(`🤖 **Executing via agent** — Relay job \`${jobId}\`\n\n*Relayer is broadcasting your transaction (you pay no gas)…*`, 'agents');
  _toast('🤖 Agent executing via relayer — no wallet popup!', 'info');

  await _patch(intent.id, { status: 'processing' });
  _notify(intent.id, 'processing', { intent, relayJobId: jobId });

  // Poll relay job status
  await _pollRelayJob(intent, jobId);
}

// ─── Poll relay job until completion ─────────────────────────────────────────
async function _pollRelayJob(intent, jobId) {
  const MAX_POLLS = 60; // 2 minutes at 2s interval
  let polls = 0;

  while (polls < MAX_POLLS) {
    await new Promise(r => setTimeout(r, 2000));
    polls++;

    try {
      const r = await fetch(`${AE_API_BASE}/relay/${jobId}`);
      const d = await r.json();
      if (!d.success) continue;

      const job = d.job;
      _log(`Relay poll ${polls}: status=${job.status}`);

      if (job.status === 'broadcast') {
        await _patch(intent.id, { status: 'broadcast', txHash: job.txHash });
        _notify(intent.id, 'broadcast', { intent, txHash: job.txHash });
        _notifyMetaTx(
          `📤 **Transaction broadcast!** Waiting for block confirmation…\n\n` +
          `[Track TX ↗](${AE_EXPLORER}/tx/${job.txHash})`,
          'info'
        );
        _toast(`📤 TX sent (gasless!): ${job.txHash?.slice(0,14)}…`, 'info');
        continue;
      }

      if (job.status === 'completed') {
        await _patch(intent.id, {
          status: 'completed', txHash: job.txHash, blockNumber: job.blockNumber
        });
        _notify(intent.id, 'completed', {
          intent, txHash: job.txHash, blockNumber: job.blockNumber
        });
        _notifyMetaTx(
          `✅ **Completed!** Transaction confirmed on-chain.\n\n` +
          `[View on Explorer ↗](${AE_EXPLORER}/tx/${job.txHash})\n` +
          `Block #${job.blockNumber}`,
          'success'
        );
        _toast(`✅ Gasless transfer complete! Block #${job.blockNumber}`, 'success');
        return;
      }

      if (job.status === 'failed') {
        const errMsg = job.error || 'Relay execution failed';
        await _patch(intent.id, { status: 'failed', error: errMsg });
        _notify(intent.id, 'failed', { intent, error: errMsg });
        _notifyMetaTx(`❌ **Agent failed:** ${errMsg}`, 'error');
        throw new Error(errMsg);
      }

      if (job.status === 'rejected') {
        const errMsg = job.error || 'Relay rejected the intent';
        await _patch(intent.id, { status: 'failed', error: errMsg });
        _notify(intent.id, 'failed', { intent, error: errMsg });
        _notifyMetaTx(`❌ **Relay rejected:** ${errMsg}`, 'error');
        throw new Error(errMsg);
      }

    } catch (e) {
      if (e.message.includes('failed') || e.message.includes('rejected')) throw e;
      _warn('Relay poll error:', e.message);
    }
  }

  // Timeout — leave as broadcast (will be confirmed eventually)
  _notifyMetaTx('⏳ **Transaction broadcast** — awaiting confirmation (may take a few minutes)…', 'info');
  _warn('Relay poll timeout — TX likely pending:', jobId);
}

// ─── Create Intent ────────────────────────────────────────────────────────────
async function aeCreateIntent(params) {
  const session = _getSession();
  const wallet  = window.walletState?.address;
  if (!wallet)  throw new Error('Wallet not connected');
  if (!session) throw new Error('Daat Agent not authorized. Click "Authorize Daat Agent" first.');

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
    signature:   session.signature,
  };

  const result = await _post('/intents', payload);
  if (!result.success) throw new Error(result.error || 'Failed to create intent');

  _log('Intent created:', result.intent.id, payload.type, payload.amount, payload.token);
  _notify(result.intent.id, 'pending', { intent: result.intent });

  if (!_aePollTimer) aeStartPolling();
  return result.intent;
}

// ─── Polling ──────────────────────────────────────────────────────────────────
function aeStartPolling() {
  if (_aePollTimer) return;
  _aeRunning = true;
  _aePollTimer = setInterval(_poll, AE_POLL_MS);
  setTimeout(_poll, 100);
}
function aeStopPolling() {
  if (_aePollTimer) { clearInterval(_aePollTimer); _aePollTimer = null; }
  _aeRunning = false;
}

async function _poll() {
  const wallet  = window.walletState?.address;
  const session = _getSession();
  if (!wallet || !session) {
    if (_aePollTimer) { aeStopPolling(); }
    return;
  }
  try {
    const since = _aeLastPoll ? `&since=${encodeURIComponent(_aeLastPoll)}` : '';
    const data  = await _get(`/poll?wallet=${encodeURIComponent(wallet)}${since}`);
    if (!data.success) return;
    _aeLastPoll = data.timestamp;
    if (!data.intents || data.intents.length === 0) return;
    for (const intent of data.intents) await _handleIntent(intent);
  } catch (e) {
    _warn('Poll error:', e.message);
  }
}

async function _handleIntent(intent) {
  _notify(intent.id, intent.status, { intent });
  if (intent.status !== 'pending') return;
  if (_wasExecuted(intent.id)) return;
  const wallet = window.walletState?.address;
  if (!wallet || wallet.toLowerCase() !== intent.wallet.toLowerCase()) return;
  _markExecuted(intent.id);
  try {
    await _executeIntent(intent);
  } catch (e) {
    _err('executeIntent error:', e);
  }
}

// ─── Execute Intent (dispatcher) ─────────────────────────────────────────────
async function _executeIntent(intent) {
  _log('Executing:', intent.id, intent.type, intent.amount, intent.token);
  await _patch(intent.id, { status: 'processing' });
  _notify(intent.id, 'processing', { intent });
  _toast(`🤖 Agent: processing ${intent.type}…`, 'info');

  // Confirmation for high-value transfers
  if (intent.type === 'transfer' && Number(intent.amount) >= AE_CONFIRM_THRESH) {
    const ok = confirm(`Agent wants to send ${intent.amount} ${intent.token} to:\n${intent.to}\n\nConfirm?`);
    if (!ok) {
      await _patch(intent.id, { status: 'cancelled' });
      _notify(intent.id, 'cancelled', { intent });
      return;
    }
  }

  try {
    if (intent.type === 'transfer' || intent.type === 'multisend') {
      await _executeTransfer(intent);
    } else {
      await _patch(intent.id, { status: 'failed', error: `Type "${intent.type}" requires manual execution.` });
      _notify(intent.id, 'failed', { intent, error: `Manual execution required for: ${intent.type}` });
    }
  } catch (err) {
    const msg      = err?.message || String(err);
    const retries  = (intent.retries || 0) + 1;
    const isCancel = msg.includes('ACTION_REJECTED') || msg.includes('4001') || msg.includes('rejected');

    if (!isCancel && retries < AE_MAX_RETRIES) {
      _unmarkExecuted(intent.id);
      await _patch(intent.id, { status: 'pending', retries, error: msg });
      _notify(intent.id, 'pending', { intent, retry: retries });
    } else {
      const finalMsg = isCancel ? 'Rejected by user in wallet.' : msg;
      await _patch(intent.id, { status: 'failed', error: finalMsg });
      _notify(intent.id, 'failed', { intent, error: finalMsg });
      _toast(`❌ Agent failed: ${finalMsg.slice(0, 80)}`, 'error');
    }
  }
}

// ─── Execute: Transfer (with execution priority) ──────────────────────────────
//
// Priority:
//   1. AgentExecutor meta-tx (gasless)     ← if contract deployed + approved
//   2. Permit2 SignatureTransfer (user pays gas, but no approve popup)
//   3. Direct ERC-20 transfer (user pays gas + signs tx)
//
async function _executeTransfer(intent) {
  const ethers = window.ethers;
  if (!ethers) throw new Error('ethers.js not loaded');

  const amount = Number(intent.amount);
  if (!amount || amount <= 0) throw new Error('Amount must be > 0');

  const provider   = new ethers.BrowserProvider(window.ethereum, 'any');
  const signer     = await provider.getSigner();
  const signerAddr = await signer.getAddress();

  if (signerAddr.toLowerCase() !== intent.wallet.toLowerCase()) {
    throw new Error('Connected wallet does not match intent wallet.');
  }

  await _ensureNetwork();

  const tokenAddr = intent.token === 'EURC' ? AE_EURC_ADDR : AE_USDC_ADDR;
  const token     = new ethers.Contract(tokenAddr, AE_ERC20_ABI, signer);
  const amountRaw = BigInt(Math.round(amount * 1_000_000));
  if (amountRaw === 0n) throw new Error('Computed amount is zero');

  const balance = BigInt(await token.balanceOf(signerAddr));
  if (balance < amountRaw) {
    throw new Error(`Insufficient ${intent.token}: have ${Number(balance)/1e6} need ${amount}`);
  }

  // ── PATH 1: AgentExecutor Meta-Tx (GASLESS) ────────────────────────────────
  const contractReady = await _agentContractAvailable();
  if (contractReady) {
    _log('Using AgentExecutor meta-tx path (gasless)');
    _notifyMetaTx('🤖 **Gasless execution** — using Agent Executor meta-transaction system…', 'agents');
    try {
      await _executeViaMetaTx(signer, signerAddr, intent, tokenAddr, amountRaw, ethers);
      return;
    } catch (metaTxErr) {
      const msg = metaTxErr?.message || String(metaTxErr);
      if (msg.includes('not deployed') || msg.includes('not supported')) {
        _log('Meta-tx not available, trying Permit2 path:', msg);
      } else {
        _warn('Meta-tx failed, trying Permit2 fallback:', msg);
        _notifyMetaTx(`⚠️ Meta-tx failed: ${msg}\n\nFalling back to Permit2…`, 'error');
      }
    }
  }

  // ── PATH 2: Permit2 SignatureTransfer ──────────────────────────────────────
  const spendingPermit = _findPermit(signerAddr, intent.token, amount);
  const permit2Available = await _permit2Available();

  if (spendingPermit && permit2Available) {
    _log('Using Permit2 path (spending permit found)');
    try {
      await _executeViaPermit2Single(signer, signerAddr, intent, tokenAddr, amountRaw, ethers, spendingPermit);
      return;
    } catch (p2err) {
      _warn('Permit2 path failed, falling back to direct ERC-20:', p2err.message);
    }
  }

  // ── PATH 3: Direct ERC-20 transfer (fallback) ──────────────────────────────
  _log('Using direct ERC-20 transfer (fallback)');
  if (!spendingPermit) {
    _toast('ℹ️ No spending permit — signing direct transfer…', 'info');
  }

  await _patch(intent.id, { status: 'signing' });
  _notify(intent.id, 'signing', { intent, method: 'erc20_transfer' });
  _toast(`⏳ Sign transfer: ${amount} ${intent.token} → wallet popup…`, 'info');

  let gasLimit = 80_000n;
  try {
    const est = await token.transfer.estimateGas(intent.to, amountRaw);
    gasLimit = BigInt(Math.ceil(Number(est) * 1.3));
  } catch (_) {}

  const tx = await token.transfer(intent.to, amountRaw, { gasLimit });
  await _patch(intent.id, { status: 'broadcast', txHash: tx.hash });
  _notify(intent.id, 'broadcast', { intent, txHash: tx.hash });
  _toast(`📤 TX sent: ${tx.hash.slice(0,14)}…`, 'info');

  const receipt = await tx.wait(1);
  if (receipt.status !== 1) throw new Error(`Transaction reverted at block #${receipt.blockNumber}`);

  await _patch(intent.id, { status: 'completed', txHash: tx.hash, blockNumber: receipt.blockNumber });
  _notify(intent.id, 'completed', { intent, txHash: tx.hash, blockNumber: receipt.blockNumber });
  _toast(`✅ Sent ${amount} ${intent.token}! Block #${receipt.blockNumber}`, 'success');
}

// ─── Permit2 availability ─────────────────────────────────────────────────────
async function _permit2Available() {
  try {
    const r = await fetch(AE_RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc:'2.0', method:'eth_getCode', params:[AE_PERMIT2_ADDR,'latest'], id:1 }),
    });
    const d = await r.json();
    return d.result && d.result.length > 4;
  } catch { return false; }
}

// ─── Permit2 Single Transfer (fallback path) ──────────────────────────────────
async function _executeViaPermit2Single(signer, signerAddr, intent, tokenAddr, amountRaw, ethers, spendingPermit) {
  const token   = new ethers.Contract(tokenAddr, AE_ERC20_ABI, signer);
  const permit2 = new ethers.Contract(AE_PERMIT2_ADDR, AE_PERMIT2_ABI, signer);

  const currentAllowance = BigInt(await token.allowance(signerAddr, AE_PERMIT2_ADDR));
  if (currentAllowance < amountRaw) {
    await _patch(intent.id, { status: 'signing' });
    _notify(intent.id, 'signing', { intent, step: 'approve_permit2' });
    _toast('⏳ Approve Permit2 contract — wallet popup…', 'info');
    const approveTx  = await token.approve(AE_PERMIT2_ADDR, 2n ** 256n - 1n);
    const approveRcpt = await approveTx.wait(1);
    if (approveRcpt.status !== 1) throw new Error('Permit2 approval reverted');
  }

  function _randomNonce() {
    const arr = new Uint8Array(31);
    crypto.getRandomValues(arr);
    return BigInt('0x' + Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join(''));
  }

  const nonce    = _randomNonce();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const permitMessage = {
    permitted: { token: tokenAddr, amount: amountRaw },
    spender:   AE_PERMIT2_ADDR,
    nonce:     nonce,
    deadline:  deadline,
  };

  await _patch(intent.id, { status: 'signing' });
  _notify(intent.id, 'signing', { intent, step: 'sign_permit2' });
  _toast('⏳ Sign Permit2 transfer — wallet popup…', 'info');

  const signature = await signer.signTypedData(AE_PERMIT2_DOMAIN, AE_PERMIT_TRANSFER_TYPES, permitMessage);
  const transferDetails = { to: intent.to, requestedAmount: amountRaw };

  let gasLimit = 150_000n;
  try {
    const est = await permit2['permitTransferFrom(tuple(tuple(address,uint256),uint256,uint256),tuple(address,uint256),address,bytes)']
      .estimateGas([{ token: tokenAddr, amount: amountRaw }, nonce, deadline], transferDetails, signerAddr, signature);
    gasLimit = BigInt(Math.ceil(Number(est) * 1.3));
  } catch (_) {}

  const tx = await permit2['permitTransferFrom(tuple(tuple(address,uint256),uint256,uint256),tuple(address,uint256),address,bytes)'](
    [{ token: tokenAddr, amount: amountRaw }, nonce, deadline],
    transferDetails, signerAddr, signature, { gasLimit }
  );

  await _patch(intent.id, { status: 'broadcast', txHash: tx.hash });
  _notify(intent.id, 'broadcast', { intent, txHash: tx.hash });
  _toast(`📤 TX sent (Permit2): ${tx.hash.slice(0,14)}…`, 'info');

  const receipt = await tx.wait(1);
  if (receipt.status !== 1) throw new Error(`Permit2 tx reverted at block #${receipt.blockNumber}`);

  if (spendingPermit) _recordPermitUsage(spendingPermit.id, intent.amount);

  await _patch(intent.id, { status: 'completed', txHash: tx.hash, blockNumber: receipt.blockNumber });
  _notify(intent.id, 'completed', { intent, txHash: tx.hash, blockNumber: receipt.blockNumber });
  _toast(`✅ Permit2 transfer done! Block #${receipt.blockNumber}`, 'success');
}

// ─── Execute Multisend ────────────────────────────────────────────────────────
// (Handled by _executeTransfer which delegates to _executeViaMetaTx for batch)

// ─── Status Badge ─────────────────────────────────────────────────────────────
const AE_STATUS_CFG = {
  pending:    { icon: 'fa-clock',         color: 'text-yellow-400', bg: 'bg-yellow-900/20', label: 'Queued'     },
  processing: { icon: 'fa-cog fa-spin',   color: 'text-blue-400',   bg: 'bg-blue-900/20',   label: 'Executing…' },
  signing:    { icon: 'fa-pen-nib',       color: 'text-purple-400', bg: 'bg-purple-900/20', label: 'Signing…'   },
  broadcast:  { icon: 'fa-paper-plane',   color: 'text-cyan-400',   bg: 'bg-cyan-900/20',   label: 'Sent'       },
  completed:  { icon: 'fa-check-circle',  color: 'text-green-400',  bg: 'bg-green-900/20',  label: 'Completed'  },
  failed:     { icon: 'fa-times-circle',  color: 'text-red-400',    bg: 'bg-red-900/20',    label: 'Failed'     },
  cancelled:  { icon: 'fa-ban',           color: 'text-gray-400',   bg: 'bg-gray-800/30',   label: 'Cancelled'  },
};

function _renderBadge(intentId, status, data = {}) {
  const cfg    = AE_STATUS_CFG[status] || AE_STATUS_CFG.pending;
  const txLink = data.txHash
    ? ` · <a href="${AE_EXPLORER}/tx/${data.txHash}" target="_blank" class="underline font-mono text-[10px] text-cyan-400">${data.txHash.slice(0,14)}…</a>`
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

  document.querySelectorAll(`[data-intent-id="${intentId}"] .ae-status-badge`).forEach(el => {
    el.outerHTML = _renderBadge(intentId, status, { txHash, blockNumber });
  });

  if (['completed', 'failed', 'broadcast'].includes(status)) {
    const notifyFn = window.autonomaActive && typeof autonomaAppendMessage === 'function'
      ? autonomaAppendMessage
      : (typeof appendChatMessage === 'function' ? appendChatMessage : null);

    if (!notifyFn) return;
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

    if (msg) notifyFn('assistant', msg, status === 'failed' ? 'error' : 'payments');
  }

  if (typeof aeRefreshPanel === 'function') setTimeout(aeRefreshPanel, 300);
});

// ─── Meta-tx messages → Autonoma chat ────────────────────────────────────────
window.addEventListener('agentMetaTx:message', function (e) {
  const { msg, type } = e.detail || {};
  if (!msg) return;

  const notifyFn = window.autonomaActive && typeof window.autonomaAppendMessage === 'function'
    ? window.autonomaAppendMessage
    : (typeof appendChatMessage === 'function' ? appendChatMessage : null);

  if (notifyFn) {
    const module = type === 'success' ? 'agents' : type === 'error' ? 'error' : 'agents';
    notifyFn('assistant', msg, module);
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
  const qs   = statusFilter ? `&status=${statusFilter}` : '';
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
function aeGetPermitStatus(token) {
  const wallet = window.walletState?.address;
  if (!wallet) return { hasPermit: false, reason: 'wallet_not_connected' };
  const permit = _findPermit(wallet, token || 'USDC', 0.01);
  if (!permit) return { hasPermit: false, reason: 'no_permit' };
  const remaining = permit.amount - (permit.amountUsed || 0);
  const expiresIn = Math.round((permit.expiry - Date.now()) / 60000);
  return { hasPermit: true, permit, remaining, expiresIn,
    label: `${remaining} ${permit.token} · expires in ${expiresIn}m` };
}

// ─── Meta-tx status helper ────────────────────────────────────────────────────
function aeGetMetaTxStatus() {
  const contractDeployed = AE_CONTRACT_ADDR !== '0x0000000000000000000000000000000000000000';
  return {
    contractDeployed,
    contractAddr:  AE_CONTRACT_ADDR,
    domain:        AE_EIP712_DOMAIN,
    capabilities:  contractDeployed
      ? ['gasless_transfer', 'gasless_batch', 'eip712_signing']
      : ['permit2_transfer', 'direct_transfer'],
    message: contractDeployed
      ? '✅ Gasless meta-transactions enabled — relayer pays all gas'
      : '⚠️ AgentExecutor not deployed — using Permit2/direct fallback',
  };
}

// ─── Init ─────────────────────────────────────────────────────────────────────
function _init() {
  _log(`Agent Executor v${AE_VERSION} loaded`);
  _log('Meta-tx status:', aeGetMetaTxStatus().message);

  setInterval(() => {
    const session = _getSession();
    const wallet  = window.walletState?.address;
    const should  = !!(session && wallet);
    if (should && !_aePollTimer)  aeStartPolling();
    if (!should && _aePollTimer)  aeStopPolling();
  }, 5000);

  if (_getSession() && window.walletState?.address) aeStartPolling();
}

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
  getPermitStatus: aeGetPermitStatus,
  getMetaTxStatus: aeGetMetaTxStatus,
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _init);
} else {
  _init();
}

})(window);
