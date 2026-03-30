// ============================================================
// OTC CONTRACTS MODULE v1 — ExecDaat
//
// Over-The-Counter contract system for token/asset deals.
// Fully local (localStorage) + on-chain signature verification.
//
// Flow:
//   1. Create Deal → generates Contract ID + pre-hash
//   2. Both parties agree on same TGE schedule
//   3. Both sign via EIP-191 (signMessage)
//   4. After TGE: buyer submits TX proof
//   5. On-chain verification → COMPLETED + receipt
//
// Storage: localStorage keys
//   execDaat_otc_contracts   → array of OTC contracts
//   execDaat_otc_listings    → marketplace listings
//
// No axios. No API. Direct EVM + localStorage only.
// ============================================================
'use strict';

const OTC_VERSION    = '20260402b';

// ─── Date/Time UTC helpers ────────────────────────────────────────────────────
// Convert HTML date input (YYYY-MM-DD) + time input (HH:MM) → ISO 8601 UTC string
function _otcToUTCIso(dateYMD, timeHHMM) {
  // Inputs from <input type="date"> and <input type="time"> are already in the
  // format YYYY-MM-DD and HH:MM — treating them as UTC directly.
  return dateYMD + 'T' + timeHHMM + ':00Z';
}
// Parse ISO UTC string → { dateYMD: 'YYYY-MM-DD', timeHHMM: 'HH:MM' } (always UTC)
function _otcFromUTCIso(isoStr) {
  const d = new Date(isoStr);
  if (isNaN(d)) return { dateYMD: '', timeHHMM: '' };
  const pad = n => String(n).padStart(2, '0');
  return {
    dateYMD:  d.getUTCFullYear() + '-' + pad(d.getUTCMonth()+1) + '-' + pad(d.getUTCDate()),
    timeHHMM: pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()),
  };
}
// Format ISO UTC string → MM/DD/YYYY HH:MM UTC (display only)
function _otcDisplayDT(isoStr) {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  if (isNaN(d)) return isoStr;
  const pad = n => String(n).padStart(2, '0');
  return pad(d.getUTCMonth()+1) + '/' + pad(d.getUTCDate()) + '/' + d.getUTCFullYear()
    + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' UTC';
}
// Format ISO UTC string → MM/DD/YYYY (date only, for marketplace)
function _otcDisplayDate(isoStr) {
  if (!isoStr) return '—';
  // Accept both ISO strings and plain YYYY-MM-DD
  const d = isoStr.includes('T') ? new Date(isoStr) : new Date(isoStr + 'T00:00:00Z');
  if (isNaN(d)) return isoStr;
  const pad = n => String(n).padStart(2, '0');
  return pad(d.getUTCMonth()+1) + '/' + pad(d.getUTCDate()) + '/' + d.getUTCFullYear();
}
// Format createdAt ISO string → MM/DD/YYYY (for card headers)
function _otcDisplayCreated(isoStr) {
  return _otcDisplayDate(isoStr);
}
const OTC_RPC        = 'https://rpc.testnet.arc.network';
const OTC_CHAIN_ID   = 5042002;
const OTC_EXPLORER   = 'https://testnet.arcscan.app';
const OTC_STORE_KEY  = 'execDaat_otc_contracts';
const OTC_MKT_KEY    = 'execDaat_otc_listings';

// ERC-20 minimal ABI for on-chain TX verification
const OTC_ERC20_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

// ─── Contract status machine ──────────────────────────────────────────────────
const OTC_STATUS = {
  PENDING_SCHEDULE: 'PENDING_SCHEDULE',
  SCHEDULED:        'SCHEDULED',
  SIGNED:           'SIGNED',
  LOCKED:           'LOCKED',
  EXECUTABLE:       'EXECUTABLE',
  AWAITING_PAYMENT: 'AWAITING_PAYMENT',
  VERIFYING:        'VERIFYING',
  COMPLETED:        'COMPLETED',
  CANCELLED:        'CANCELLED',
  DISPUTED:         'DISPUTED',
  // On-chain escrow states
  ONCHAIN_CREATED:  'ONCHAIN_CREATED',   // createDeal() called, both must signDeal()
  ONCHAIN_SIGNED:   'ONCHAIN_SIGNED',    // both signed on-chain, ready to fund
  FUNDED:           'FUNDED',            // fundDeal() called — tokens locked in escrow
  RELEASED:         'RELEASED',          // release() called — tokens sent to seller
  CANCEL_REQUESTED: 'CANCEL_REQUESTED',  // one party requested cancel (funded deal)
};

const OTC_STATUS_LABEL = {
  PENDING_SCHEDULE: { label: 'Pending Schedule',  color: 'text-yellow-400',  bg: 'bg-yellow-900/30 border-yellow-700/40',   icon: 'fa-clock' },
  SCHEDULED:        { label: 'Scheduled',         color: 'text-blue-400',    bg: 'bg-blue-900/30 border-blue-700/40',       icon: 'fa-calendar-check' },
  SIGNED:           { label: 'Signed (Off-Chain)', color: 'text-purple-400',  bg: 'bg-purple-900/30 border-purple-700/40',   icon: 'fa-signature' },
  LOCKED:           { label: 'Locked',            color: 'text-orange-400',  bg: 'bg-orange-900/30 border-orange-700/40',   icon: 'fa-lock' },
  EXECUTABLE:       { label: 'Executable',        color: 'text-green-400',   bg: 'bg-green-900/30 border-green-700/40',     icon: 'fa-play-circle' },
  AWAITING_PAYMENT: { label: 'Awaiting Payment',  color: 'text-cyan-400',    bg: 'bg-cyan-900/30 border-cyan-700/40',       icon: 'fa-hourglass-half' },
  VERIFYING:        { label: 'Verifying',         color: 'text-indigo-400',  bg: 'bg-indigo-900/30 border-indigo-700/40',   icon: 'fa-search' },
  COMPLETED:        { label: 'Completed',         color: 'text-emerald-400', bg: 'bg-emerald-900/30 border-emerald-700/40', icon: 'fa-check-double' },
  CANCELLED:        { label: 'Cancelled',         color: 'text-red-400',     bg: 'bg-red-900/30 border-red-700/40',         icon: 'fa-times-circle' },
  DISPUTED:         { label: 'Disputed',          color: 'text-rose-400',    bg: 'bg-rose-900/30 border-rose-700/40',       icon: 'fa-exclamation-triangle' },
  // On-chain escrow statuses
  ONCHAIN_CREATED:  { label: 'On-Chain (Signing)', color: 'text-violet-400', bg: 'bg-violet-900/30 border-violet-700/40',  icon: 'fa-link' },
  ONCHAIN_SIGNED:   { label: 'On-Chain Signed',   color: 'text-violet-300',  bg: 'bg-violet-900/30 border-violet-600/40',  icon: 'fa-file-signature' },
  FUNDED:           { label: 'Funded (Escrow)',    color: 'text-teal-400',    bg: 'bg-teal-900/30 border-teal-700/40',       icon: 'fa-vault' },
  RELEASED:         { label: 'Released',          color: 'text-emerald-300', bg: 'bg-emerald-900/30 border-emerald-600/40', icon: 'fa-paper-plane' },
  CANCEL_REQUESTED: { label: 'Cancel Requested',  color: 'text-amber-400',   bg: 'bg-amber-900/30 border-amber-700/40',     icon: 'fa-undo' },
};

// ─── State ─────────────────────────────────────────────────────────────────────
let _otcContracts = [];
let _otcListings  = [];
let _otcSubTab    = 'create'; // 'create' | 'my' | 'market'

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _otcLog(...a)  { console.log('%c[OTC v1]', 'color:#818cf8;font-weight:bold', ...a); }
function _otcEl(id)     { return document.getElementById(id); }
function _otcVal(id)    { const e = _otcEl(id); return e ? e.value.trim() : ''; }
function _otcIsAddr(a)  { return /^0x[0-9a-fA-F]{40}$/.test(String(a||'').trim()); }
function _otcShort(h)   { return h ? h.slice(0,8)+'…'+h.slice(-6) : '—'; }
function _otcNow()      { return new Date().toISOString(); }
function _otcFmt(n)     { return Number(n||0).toFixed(2); }
function _otcToast(msg, type='info') {
  if (typeof showToast === 'function') showToast(msg, type);
  else console.log('[OTC]', type, msg);
}

// ─── Hash generator ───────────────────────────────────────────────────────────
async function _otcHash(data) {
  const str  = JSON.stringify(data);
  const enc  = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', enc);
  return '0x' + Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2,'0')).join('');
}

function _otcId() {
  return 'OTC-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2,6).toUpperCase();
}

// ─── Storage ──────────────────────────────────────────────────────────────────
function otcSave() {
  try {
    localStorage.setItem(OTC_STORE_KEY, JSON.stringify(_otcContracts));
    localStorage.setItem(OTC_MKT_KEY,   JSON.stringify(_otcListings));
  } catch(e) { _otcLog('Save error', e); }
}

function otcLoad() {
  try {
    const c = localStorage.getItem(OTC_STORE_KEY);
    const m = localStorage.getItem(OTC_MKT_KEY);
    _otcContracts = c ? JSON.parse(c) : [];
    _otcListings  = m ? JSON.parse(m) : [];
  } catch(e) { _otcContracts = []; _otcListings = []; }
}

// ─── Create OTC Deal ──────────────────────────────────────────────────────────
async function otcCreateDeal() {
  const buyer      = _otcVal('otc-buyer');
  const seller     = _otcVal('otc-seller');
  const asset      = _otcVal('otc-asset');
  const amount     = parseFloat(_otcVal('otc-amount'));
  // Inputs are YYYY-MM-DD and HH:MM — treated as UTC directly
  const tgeDate    = _otcVal('otc-tge-date');  // YYYY-MM-DD (from <input type="date">)
  const tgeTime    = _otcVal('otc-tge-time');  // HH:MM      (from <input type="time">)
  const tgeTz      = 'UTC';
  const description= _otcVal('otc-description');

  // ── Validation ──────────────────────────────────────────────────────────────
  const errors = [];
  if (!_otcIsAddr(buyer))   errors.push('Invalid buyer wallet address');
  if (!_otcIsAddr(seller))  errors.push('Invalid seller wallet address');
  if (buyer.toLowerCase() === seller.toLowerCase()) errors.push('Buyer and seller cannot be the same address');
  if (!asset)               errors.push('Select a token/asset');
  if (!amount || isNaN(amount) || amount <= 0) errors.push('Enter a valid amount');
  if (!tgeDate)             errors.push('TGE date is required');
  if (!tgeTime)             errors.push('TGE time is required');

  if (errors.length) {
    _otcShowFormError(errors.join(' · '));
    return;
  }

  _otcHideFormError();

  const createBtn = _otcEl('otc-create-btn');
  if (createBtn) { createBtn.disabled = true; createBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Creating…'; }

  try {
    const contractId    = _otcId();
    // Store as ISO 8601 UTC (e.g. 2026-03-25T18:00:00Z)
    const timestamp_utc = _otcToUTCIso(tgeDate, tgeTime);
    const tgeDatetime   = timestamp_utc; // alias for existing status checks

    const contractData = { contractId, buyer, seller, asset, amount, tgeDate, tgeTime, tgeTz, tgeDatetime, timestamp_utc, description };
    const contractHash = await _otcHash(contractData);

    const contract = {
      ...contractData,
      contractHash,
      status: OTC_STATUS.PENDING_SCHEDULE,
      createdAt: _otcNow(),
      updatedAt: _otcNow(),
      buyerSig: null,
      sellerSig: null,
      buyerSigAt: null,
      sellerSigAt: null,
      txProof: null,
      verifiedAt: null,
      receipt: null,
      notes: [],
      // Seller schedule confirmation (must match)
      sellerScheduleConfirmed: false,
      sellerTgeDate: null,
      sellerTgeTime: null,
      // On-chain escrow fields (populated after on-chain createDeal tx)
      escrowDealId:  null,   // bytes32 dealId from OTCEscrow contract
      escrowTxHash:  null,   // tx hash of createDeal
      fundTxHash:    null,   // tx hash of fundDeal
      releaseTxHash: null,   // tx hash of release
      cancelTxHash:  null,   // tx hash of cancel
      onChain:       false,  // true once createDeal() executed on-chain
    };

    _otcContracts.unshift(contract);
    otcSave();

    // Push to global history
    _otcPushHistory(contract, 'Created');

    // ── Try on-chain createDeal if escrow is deployed & wallet connected ───────
    if (OTC_ESCROW_DEPLOYED && window.walletState?.connected) {
      _otcToast('✅ OTC Deal created locally! Registering on-chain…', 'info');
      // Non-blocking: try to push to chain in background
      _otcCreateDealOnChain(contract).catch(e => {
        _otcLog('On-chain createDeal failed (fallback to local):', e.message);
        _otcToast('⚠️ On-chain registration failed. Deal saved locally.', 'warning');
      });
    } else {
      const chainNote = !OTC_ESCROW_DEPLOYED
        ? ' (Escrow contract not deployed yet — local mode)'
        : ' (Connect wallet to register on-chain)';
      _otcToast(`✅ OTC Contract created! ID: ${contractId}${chainNote}`, 'success');
    }

    _otcLog('Contract created:', contract);

    // Reset form
    _otcResetForm();

    // Switch to My Contracts tab and show the new contract
    otcSwitchSub('my');
    setTimeout(() => otcRenderMyContracts(), 100);

  } catch(e) {
    _otcLog('Create error:', e);
    _otcToast('❌ Failed to create contract: ' + e.message, 'error');
  } finally {
    if (createBtn) { createBtn.disabled = false; createBtn.innerHTML = '<i class="fas fa-handshake mr-2"></i>Create OTC Deal'; }
  }
}

// ─── Sign Contract ─────────────────────────────────────────────────────────────
async function otcSignContract(contractId) {
  if (!window.ethereum || !window.walletState?.connected) {
    _otcToast('Connect your wallet to sign', 'warning');
    if (typeof openWalletModal === 'function') openWalletModal();
    return;
  }

  const contract = _otcContracts.find(c => c.contractId === contractId);
  if (!contract) return _otcToast('Contract not found', 'error');
  if (contract.status === OTC_STATUS.COMPLETED || contract.status === OTC_STATUS.CANCELLED) {
    return _otcToast('Cannot sign a completed or cancelled contract', 'warning');
  }

  const signerAddr = window.walletState.address?.toLowerCase();
  const isBuyer    = contract.buyer.toLowerCase() === signerAddr;
  const isSeller   = contract.seller.toLowerCase() === signerAddr;

  if (!isBuyer && !isSeller) {
    return _otcToast('Your wallet is not a party to this contract', 'error');
  }

  const role = isBuyer ? 'Buyer' : 'Seller';
  const sigKey = isBuyer ? 'buyerSig' : 'sellerSig';
  const sigAtKey = isBuyer ? 'buyerSigAt' : 'sellerSigAt';

  if (contract[sigKey]) {
    return _otcToast(`${role} has already signed this contract`, 'info');
  }

  try {
    const ethers = window.ethers;
    if (!ethers) throw new Error('ethers.js not loaded');

    const provider = new ethers.BrowserProvider(window.ethereum);
    const signer   = await provider.getSigner();

    // EIP-191 message
    const message = [
      `ExecDaat OTC Contract`,
      `Contract ID: ${contract.contractId}`,
      `Hash: ${contract.contractHash}`,
      `Role: ${role}`,
      `Asset: ${contract.amount} ${contract.asset}`,
      `Buyer: ${contract.buyer}`,
      `Seller: ${contract.seller}`,
      `TGE: ${_otcDisplayDT(contract.timestamp_utc || _otcToUTCIso(contract.tgeDate, contract.tgeTime))}`,
      `Stored UTC: ${contract.timestamp_utc || _otcToUTCIso(contract.tgeDate, contract.tgeTime)}`,
      `I agree to the terms of this OTC contract and authorize execution upon completion of all conditions.`,
    ].join('\n');

    _otcToast('Confirm signature in wallet…', 'info');
    const sig = await signer.signMessage(message);

    contract[sigKey]   = sig;
    contract[sigAtKey] = _otcNow();
    contract.updatedAt = _otcNow();

    // Update status
    _otcUpdateStatus(contract);
    otcSave();
    _otcPushHistory(contract, `${role} signed`);

    _otcToast(`✅ ${role} signature recorded!`, 'success');
    _otcLog(`Signed by ${role}:`, sig);
    otcRenderMyContracts();

  } catch(e) {
    if (e.code === 4001 || e.message?.includes('rejected')) {
      _otcToast('Signature rejected by user', 'warning');
    } else {
      _otcToast('Sign error: ' + e.message, 'error');
      _otcLog('Sign error:', e);
    }
  }
}

// ─── Confirm schedule (seller side) ──────────────────────────────────────────
function otcConfirmSchedule(contractId) {
  const contract = _otcContracts.find(c => c.contractId === contractId);
  if (!contract) return;

  const date = _otcVal(`otc-seller-date-${contractId}`);
  const time = _otcVal(`otc-seller-time-${contractId}`);

  if (!date || !time) return _otcToast('Enter TGE date and time', 'warning');

  // Compare normalized UTC ISO strings
  const buyerUTC  = contract.timestamp_utc || _otcToUTCIso(contract.tgeDate, contract.tgeTime);
  const sellerUTC = _otcToUTCIso(date, time);
  if (buyerUTC !== sellerUTC) {
    _otcToast('❌ Schedule mismatch between parties. Both must agree on same date and time (UTC).', 'error');
    const errEl = _otcEl(`otc-sched-err-${contractId}`);
    if (errEl) {
      errEl.textContent = 'Mismatch: buyer set ' + _otcDisplayDT(buyerUTC) + ', you entered ' + _otcDisplayDT(sellerUTC);
      errEl.classList.remove('hidden');
    }
    return;
  }

  contract.sellerTgeDate = date;
  contract.sellerTgeTime = time;
  contract.sellerScheduleConfirmed = true;
  contract.updatedAt = _otcNow();
  _otcUpdateStatus(contract);
  otcSave();
  _otcToast('✅ Schedule confirmed — both parties match!', 'success');
  otcRenderMyContracts();
}

// ─── Submit TX Proof (Buyer) ──────────────────────────────────────────────────
async function otcSubmitTxProof(contractId) {
  const contract = _otcContracts.find(c => c.contractId === contractId);
  if (!contract) return _otcToast('Contract not found', 'error');

  const txHash   = _otcVal(`otc-tx-proof-${contractId}`);
  const txAmount = parseFloat(_otcVal(`otc-tx-amount-${contractId}`) || contract.amount);
  const txToken  = _otcVal(`otc-tx-token-${contractId}`) || contract.asset;

  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return _otcToast('Enter a valid transaction hash (0x…)', 'warning');
  }

  const proofBtn = _otcEl(`otc-proof-btn-${contractId}`);
  if (proofBtn) { proofBtn.disabled = true; proofBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Verifying…'; }

  contract.status = OTC_STATUS.VERIFYING;
  contract.txProof = { txHash, txAmount, txToken, submittedAt: _otcNow() };
  contract.updatedAt = _otcNow();
  otcSave();
  otcRenderMyContracts();

  try {
    const verified = await _otcVerifyTx(contract, txHash, txAmount, txToken);

    if (verified.ok) {
      contract.status = OTC_STATUS.COMPLETED;
      contract.verifiedAt = _otcNow();
      contract.receipt = {
        contractId: contract.contractId,
        buyer:      contract.buyer,
        seller:     contract.seller,
        token:      txToken,
        amount:     txAmount,
        txHash,
        timestamp:  _otcNow(),
        status:     'COMPLETED',
      };
      otcSave();
      _otcPushHistory(contract, 'Completed');
      _otcToast('🎉 Payment verified! Contract COMPLETED.', 'success');
    } else {
      contract.status = OTC_STATUS.DISPUTED;
      contract.txProof.verifyError = verified.reason;
      otcSave();
      _otcToast('⚠️ Verification failed: ' + verified.reason, 'error');
    }

    otcRenderMyContracts();
  } catch(e) {
    contract.status = OTC_STATUS.AWAITING_PAYMENT;
    otcSave();
    _otcToast('Verify error: ' + e.message, 'error');
    _otcLog('Verify error:', e);
  } finally {
    if (proofBtn) { proofBtn.disabled = false; proofBtn.innerHTML = '<i class="fas fa-check-circle mr-2"></i>Submit & Verify'; }
  }
}

// ─── On-chain TX verification ─────────────────────────────────────────────────
async function _otcVerifyTx(contract, txHash, expectedAmount, token) {
  try {
    _otcLog('Verifying TX:', txHash);

    // Get transaction receipt via RPC
    const rcptRes = await fetch(OTC_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getTransactionReceipt', params: [txHash], id: 1 }),
    });
    const rcptData = await rcptRes.json();
    const rcpt = rcptData.result;

    if (!rcpt) return { ok: false, reason: 'Transaction not found on-chain. May be pending.' };
    if (rcpt.status !== '0x1') return { ok: false, reason: 'Transaction failed on-chain (status=0).' };

    // Get transaction details
    const txRes = await fetch(OTC_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getTransaction', params: [txHash], id: 2 }),
    });
    const txData = await txRes.json();
    const tx = txData.result;
    if (!tx) return { ok: false, reason: 'Could not fetch transaction details.' };

    const seller = contract.seller.toLowerCase();

    // Check if it's a native transfer TO seller
    if (tx.to?.toLowerCase() === seller && BigInt(tx.value || '0x0') > 0n) {
      const ethers = window.ethers;
      if (ethers) {
        const sentAmount = parseFloat(ethers.formatEther(tx.value));
        _otcLog(`Native transfer: ${sentAmount} ETH to seller`);
        return { ok: true, amount: sentAmount, type: 'native' };
      }
      return { ok: true, type: 'native' };
    }

    // Check ERC-20 Transfer event logs
    // Transfer(address indexed from, address indexed to, uint256 value)
    const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    for (const log of (rcpt.logs || [])) {
      if (log.topics[0] !== TRANSFER_TOPIC) continue;
      if (log.topics.length < 3) continue;
      const to = '0x' + log.topics[2].slice(26);
      if (to.toLowerCase() !== seller) continue;

      // Matched a Transfer to seller — parse amount
      try {
        const ethers = window.ethers;
        let decimals = 6; // USDC default
        if (ethers) {
          try {
            const provider = new ethers.JsonRpcProvider(OTC_RPC);
            const erc = new ethers.Contract(log.address, ['function decimals() view returns (uint8)'], provider);
            decimals = await erc.decimals();
          } catch(e) {}
        }
        const rawVal = BigInt(log.data);
        const divisor = 10n ** BigInt(decimals);
        const sentAmount = Number(rawVal * 100n / divisor) / 100;
        _otcLog(`ERC-20 Transfer: ${sentAmount} tokens to seller from ${log.address}`);

        if (Math.abs(sentAmount - expectedAmount) > expectedAmount * 0.01) {
          return { ok: false, reason: `Amount mismatch: expected ${expectedAmount}, got ${sentAmount}` };
        }
        return { ok: true, amount: sentAmount, type: 'erc20', tokenContract: log.address };
      } catch(e) {
        return { ok: true, type: 'erc20_unverified' };
      }
    }

    return { ok: false, reason: 'No transfer to seller found in this transaction.' };

  } catch(e) {
    _otcLog('RPC verify error:', e);
    return { ok: false, reason: 'RPC error: ' + e.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ON-CHAIN ESCROW FUNCTIONS (OTCEscrow.sol integration)
// All functions are isolated to the OTC Contracts tab.
// ═══════════════════════════════════════════════════════════════════════════

// ─── Public wrapper: Register deal on-chain ─────────────────────────────────
async function otcRegisterOnChain(contractId) {
  if (!window.ethereum || !window.walletState?.connected) {
    _otcToast('Connect your wallet to register on-chain', 'warning');
    if (typeof openWalletModal === 'function') openWalletModal();
    return;
  }
  const contract = _otcContracts.find(c => c.contractId === contractId);
  if (!contract) return _otcToast('Contract not found', 'error');
  if (contract.onChain) return _otcToast('Already registered on-chain', 'info');

  // Validate wallet is buyer
  const walletAddr = window.walletState.address?.toLowerCase();
  if (contract.buyer.toLowerCase() !== walletAddr) {
    return _otcToast('Only the buyer can register the deal on-chain', 'error');
  }

  if (!OTC_ESCROW_DEPLOYED) {
    return _otcToast('Escrow contract not deployed yet. Set OTC_ESCROW_ADDRESS in otc-escrow-abi.js', 'warning');
  }

  try {
    await _otcCreateDealOnChain(contract);
  } catch(e) {
    const rej = e.code === 4001 || e.message?.includes('rejected');
    _otcToast(rej ? 'Transaction rejected' : `Register error: ${e.message}`, rej ? 'warning' : 'error');
    _otcLog('Register on-chain error:', e);
  }
}

// ─── Helper: get ethers signer ─────────────────────────────────────────────
async function _otcGetSigner() {
  const ethers = window.ethers;
  if (!ethers) throw new Error('ethers.js not loaded');
  if (!window.ethereum) throw new Error('No wallet detected');
  const provider = new ethers.BrowserProvider(window.ethereum);
  return provider.getSigner();
}

// ─── 1. Register deal on-chain (createDeal) ────────────────────────────────
async function _otcCreateDealOnChain(contract) {
  const signer  = await _otcGetSigner();
  const escrow  = otcGetEscrowContract(signer);
  if (!escrow) throw new Error('Escrow contract not available');

  const tokenAddr = otcResolveToken(contract.asset);
  if (!tokenAddr) throw new Error(`Cannot resolve token address for: ${contract.asset}`);

  const provider  = signer.provider;
  const amountRaw = await otcParseTokenAmount(contract.amount, tokenAddr, provider);
  const tgeTs     = Math.floor(new Date(contract.timestamp_utc).getTime() / 1000);
  const hashBytes = contract.contractHash.padEnd(66, '0').slice(0, 66); // bytes32

  _otcLog(`createDeal on-chain: seller=${contract.seller} token=${tokenAddr} amount=${amountRaw} tge=${tgeTs}`);

  const tx = await escrow.createDeal(
    contract.seller,
    tokenAddr,
    amountRaw,
    tgeTs,
    hashBytes
  );

  _otcToast('⏳ createDeal tx sent — waiting for confirmation…', 'info');
  const receipt = await tx.wait();
  _otcLog('createDeal confirmed:', receipt.hash);

  // Extract dealId from DealCreated event
  const escrowIface = new (window.ethers.Interface)(OTC_ESCROW_ABI);
  let dealId = null;
  for (const log of receipt.logs) {
    try {
      const parsed = escrowIface.parseLog(log);
      if (parsed?.name === 'DealCreated') {
        dealId = parsed.args.dealId;
        break;
      }
    } catch(e) {}
  }

  if (!dealId) throw new Error('Could not extract dealId from tx logs');

  // Update local contract state
  contract.onChain      = true;
  contract.escrowDealId = dealId;
  contract.escrowTxHash = receipt.hash;
  contract.status       = OTC_STATUS.ONCHAIN_CREATED;
  contract.updatedAt    = _otcNow();
  otcSave();
  _otcPushHistory(contract, `On-chain deal created (dealId: ${dealId.slice(0,10)}…)`);

  const explorerUrl = `${OTC_EXPLORER}/tx/${receipt.hash}`;
  _otcToast(`✅ Deal registered on-chain! <a href="${explorerUrl}" target="_blank" class="underline">View TX ↗</a>`, 'success');
  otcRenderMyContracts();
  return dealId;
}

// ─── 2. Sign deal on-chain (signDeal) ─────────────────────────────────────
async function otcSignDealOnChain(contractId) {
  if (!window.ethereum || !window.walletState?.connected) {
    _otcToast('Connect your wallet to sign on-chain', 'warning');
    if (typeof openWalletModal === 'function') openWalletModal();
    return;
  }

  const contract  = _otcContracts.find(c => c.contractId === contractId);
  if (!contract) return _otcToast('Contract not found', 'error');
  if (!contract.onChain || !contract.escrowDealId) {
    return _otcToast('Deal not registered on-chain yet', 'warning');
  }

  const walletAddr = window.walletState.address?.toLowerCase();
  const isBuyer    = contract.buyer.toLowerCase()  === walletAddr;
  const isSeller   = contract.seller.toLowerCase() === walletAddr;
  if (!isBuyer && !isSeller) return _otcToast('Your wallet is not a party to this deal', 'error');

  const role = isBuyer ? 'Buyer' : 'Seller';

  try {
    const signer  = await _otcGetSigner();
    const escrow  = otcGetEscrowContract(signer);
    if (!escrow) throw new Error('Escrow not available');

    _otcToast(`Confirm signDeal (${role}) in wallet…`, 'info');
    const tx = await escrow.signDeal(contract.escrowDealId);
    _otcToast('⏳ Signing tx sent — waiting…', 'info');
    const receipt = await tx.wait();

    // Update local state
    if (isBuyer) {
      contract.buyerSig   = receipt.hash;
      contract.buyerSigAt = _otcNow();
    } else {
      contract.sellerSig   = receipt.hash;
      contract.sellerSigAt = _otcNow();
    }

    // Check if both now signed on-chain
    const bothSigned = contract.buyerSig && contract.sellerSig;
    contract.status  = bothSigned ? OTC_STATUS.ONCHAIN_SIGNED : OTC_STATUS.ONCHAIN_CREATED;
    contract.updatedAt = _otcNow();
    otcSave();
    _otcPushHistory(contract, `${role} signed on-chain`);

    const explorerUrl = `${OTC_EXPLORER}/tx/${receipt.hash}`;
    _otcToast(`✅ ${role} signed on-chain! <a href="${explorerUrl}" target="_blank" class="underline">View TX ↗</a>`, 'success');
    otcRenderMyContracts();

  } catch(e) {
    const decoded = _otcDecodeError(e);
    _otcToast(
      decoded.userRejected ? 'Signature rejected' : `❌ Sign error: ${decoded.msg}`,
      decoded.userRejected ? 'warning' : 'error'
    );
    _otcLog('signDeal error:', e);
  }
}

// ─── Custom-error decoder ─────────────────────────────────────────────────
// Maps the 4-byte selector (keccak256 first 4 bytes) of every known custom
// error to a human-readable description. Works for both v1 and v2 contracts.
const _OTC_CUSTOM_ERRORS = {
  // selector: keccak256("ErrorName()").slice(0,10)  — verified on ARC Testnet
  '0xc8ee2d1d': 'NotParty — your wallet is not buyer or seller of this deal',
  '0x472e017e': 'NotBuyer — only the buyer can fund this deal',
  '0xa72952d8': 'NotSigned — both buyer and seller must sign on-chain before funding',
  '0x7dd2022e': 'NotBothSigned — both buyer and seller must sign on-chain before funding',
  '0x5adf6387': 'AlreadyFunded — this deal has already been funded',
  '0xd5ef09ba': 'NotFunded — deal has not been funded yet',
  '0x63b4904e': 'AlreadyReleased — tokens have already been released to the seller',
  '0x54e37625': 'AlreadyCancelled — this deal is already cancelled',
  '0x2ebd3179': 'TGENotReached — TGE timestamp has not been reached yet',
  '0x88f691cc': 'DealNotFound — deal ID not found on-chain; check escrowDealId',
  '0xe6c4247b': 'InvalidAddress — zero address provided',
  '0x2c5211c6': 'InvalidAmount — amount must be greater than zero',
  '0xb7d09497': 'InvalidTimestamp — TGE timestamp must be non-zero',
  '0x367558c3': 'SameAddress — buyer and seller cannot be the same address',
  '0x7c704211': 'AlreadyCancelRequested — you already submitted a cancel request',
  '0x13be252b': 'InsufficientAllowance — ERC20 allowance too low; approve escrow first',
  '0x90b8ec18': 'TransferFailed — ERC20 transferFrom returned false',
  '0xb0bd6aca': 'AlreadySigned — you have already signed this deal on-chain',
};

/**
 * Decode a custom-error revert into a human-readable string.
 * Handles ethers v6 style errors (error.data, error.code === 'CALL_EXCEPTION').
 */
function _otcDecodeError(e) {
  // User rejected
  if (e.code === 4001 || e.code === 'ACTION_REJECTED' ||
      e.message?.includes('rejected') || e.message?.includes('denied')) {
    return { userRejected: true, msg: 'Transaction rejected by user' };
  }

  // Try to extract 4-byte selector from error data
  let data = e.data ?? e.error?.data ?? e.info?.error?.data ?? null;
  if (typeof data === 'string' && data.startsWith('0x') && data.length >= 10) {
    const selector = data.slice(0, 10).toLowerCase();
    const known = _OTC_CUSTOM_ERRORS[selector];
    if (known) return { userRejected: false, msg: known };
    return { userRejected: false, msg: `Contract error (${selector})` };
  }

  // Fallback to message
  const msg = e.reason ?? e.shortMessage ?? e.message ?? 'Unknown error';
  return { userRejected: false, msg };
}

// ─── 3. Fund deal on-chain (approve ERC20 + fundDeal) ─────────────────────
async function otcFundDeal(contractId) {
  if (!window.ethereum || !window.walletState?.connected) {
    _otcToast('Connect your wallet to fund', 'warning');
    if (typeof openWalletModal === 'function') openWalletModal();
    return;
  }

  const contract = _otcContracts.find(c => c.contractId === contractId);
  if (!contract) return _otcToast('Contract not found', 'error');

  if (!contract.onChain || !contract.escrowDealId) {
    return _otcToast('Deal must be registered on-chain before funding', 'warning');
  }

  // ── Wallet matches buyer ──────────────────────────────────────────────────
  const walletAddr = window.walletState.address?.toLowerCase();
  if (contract.buyer.toLowerCase() !== walletAddr) {
    return _otcToast('Only the buyer can fund the escrow', 'error');
  }

  try {
    const signer    = await _otcGetSigner();
    const provider  = signer.provider;
    const tokenAddr = otcResolveToken(contract.asset);
    if (!tokenAddr) throw new Error(`Cannot resolve token: ${contract.asset}`);

    const amountRaw = await otcParseTokenAmount(contract.amount, tokenAddr, provider);
    const erc20     = otcGetERC20Contract(tokenAddr, signer);
    if (!erc20) throw new Error('Could not connect to ERC20 contract');

    // ── Pre-flight: verify on-chain signatures via getDealStatus / getDeal ─
    _otcToast('🔍 Checking on-chain deal status…', 'info');
    let buyerSigned = false, sellerSigned = false, alreadyFunded = false;
    const escrowView = otcGetEscrowContract(provider);
    if (escrowView) {
      try {
        // Try v2 getDealStatus first
        const escrowV2Abi = [...OTC_ESCROW_ABI, OTC_ESCROW_ABI_GETDEALSTATUS];
        const ethers = window.ethers;
        const escrowV2 = new ethers.Contract(OTC_ESCROW_ADDRESS, escrowV2Abi, provider);
        const ds = await escrowV2.getDealStatus(contract.escrowDealId);
        buyerSigned  = ds.buyerSigned  ?? ds[0];
        sellerSigned = ds.sellerSigned ?? ds[1];
        alreadyFunded = ds.funded      ?? ds[2];
        _otcLog('getDealStatus:', { buyerSigned, sellerSigned, alreadyFunded });
      } catch(_) {
        // Fallback: v1 getDeal
        try {
          const deal = await escrowView.getDeal(contract.escrowDealId);
          buyerSigned   = deal.buyerSigned;
          sellerSigned  = deal.sellerSigned;
          alreadyFunded = deal.funded;
          _otcLog('getDeal fallback:', { buyerSigned, sellerSigned, alreadyFunded });
        } catch(e2) {
          _otcLog('pre-flight getDeal failed:', e2.message);
        }
      }
    }

    if (alreadyFunded) {
      return _otcToast('Deal is already funded on-chain', 'warning');
    }
    if (!buyerSigned || !sellerSigned) {
      const who = !buyerSigned && !sellerSigned ? 'both parties'
                : !buyerSigned ? 'the buyer' : 'the seller';
      return _otcToast(
        `Cannot fund: ${who} must sign on-chain first. Use "Sign On-Chain" to complete signatures.`,
        'warning'
      );
    }

    // ── Check balance ─────────────────────────────────────────────────────
    const balance = await erc20.balanceOf(walletAddr);
    if (balance < amountRaw) {
      const humanBal = await otcFormatTokenAmount(balance, tokenAddr, provider);
      return _otcToast(
        `Insufficient balance: you have ${humanBal} ${contract.asset}, need ${contract.amount} ${contract.asset}`,
        'error'
      );
    }

    // ── Check existing allowance — skip approve if already sufficient ─────
    const currentAllowance = await erc20.allowance(walletAddr, OTC_ESCROW_ADDRESS);
    _otcLog(`Allowance: ${currentAllowance}, need: ${amountRaw}`);

    if (currentAllowance < amountRaw) {
      // ── Step 1: Approve ERC20 ───────────────────────────────────────────
      _otcToast(
        `Step 1/2: Approve ${contract.amount} ${contract.asset} for escrow in your wallet…`,
        'info'
      );
      let approveTx;
      try {
        approveTx = await erc20.approve(OTC_ESCROW_ADDRESS, amountRaw);
      } catch(approveErr) {
        const decoded = _otcDecodeError(approveErr);
        _otcToast(
          decoded.userRejected
            ? '⚠️ Approval rejected — please approve to fund the escrow'
            : `❌ Approve failed: ${decoded.msg}`,
          decoded.userRejected ? 'warning' : 'error'
        );
        _otcLog('approve error:', approveErr);
        return;
      }

      _otcToast('⏳ Approval tx sent — waiting for confirmation…', 'info');
      await approveTx.wait();
      _otcLog(`ERC20 approved: ${contract.amount} ${contract.asset} → escrow ${OTC_ESCROW_ADDRESS}`);
    } else {
      _otcLog('Sufficient allowance already present — skipping approve');
      _otcToast('✅ Allowance already sufficient — skipping approve step', 'info');
    }

    // ── Verify allowance was set (guard against silent approve failure) ───
    const postAllowance = await erc20.allowance(walletAddr, OTC_ESCROW_ADDRESS);
    if (postAllowance < amountRaw) {
      return _otcToast(
        `❌ Allowance still insufficient after approve (${postAllowance} < ${amountRaw}). ` +
        'Please try the approve step again.',
        'error'
      );
    }

    // ── Step 2 (or 1 if allowance skipped): Fund escrow ──────────────────
    _otcToast('Step 2/2: Fund escrow — confirm in your wallet…', 'info');
    const escrow = otcGetEscrowContract(signer);
    if (!escrow) throw new Error('Escrow contract not available');

    let fundTx;
    try {
      fundTx = await escrow.fundDeal(contract.escrowDealId);
    } catch(fundErr) {
      const decoded = _otcDecodeError(fundErr);
      _otcToast(
        decoded.userRejected
          ? '⚠️ Fund transaction rejected'
          : `❌ Fund escrow failed: ${decoded.msg}`,
        decoded.userRejected ? 'warning' : 'error'
      );
      _otcLog('fundDeal error:', fundErr);
      return;
    }

    _otcToast('⏳ Fund tx sent — waiting for confirmation…', 'info');
    const receipt = await fundTx.wait();

    contract.funded     = true;
    contract.fundTxHash = receipt.hash;
    contract.status     = OTC_STATUS.FUNDED;
    contract.updatedAt  = _otcNow();
    otcSave();
    _otcPushHistory(contract, `Funded: ${contract.amount} ${contract.asset} locked in escrow`);

    const explorerUrl = `${OTC_EXPLORER}/tx/${receipt.hash}`;
    _otcToast(
      `✅ Escrow funded! ${contract.amount} ${contract.asset} locked. ` +
      `<a href="${explorerUrl}" target="_blank" class="underline">View TX ↗</a>`,
      'success'
    );
    otcRenderMyContracts();

  } catch(e) {
    const decoded = _otcDecodeError(e);
    _otcToast(
      decoded.userRejected ? 'Transaction rejected' : `❌ Fund error: ${decoded.msg}`,
      decoded.userRejected ? 'warning' : 'error'
    );
    _otcLog('fundDeal error:', e);
  }
}

// ─── 4. Release funds on-chain (release) ──────────────────────────────────
async function otcReleaseDeal(contractId) {
  if (!window.ethereum || !window.walletState?.connected) {
    _otcToast('Connect your wallet to release', 'warning');
    if (typeof openWalletModal === 'function') openWalletModal();
    return;
  }

  const contract = _otcContracts.find(c => c.contractId === contractId);
  if (!contract) return _otcToast('Contract not found', 'error');

  if (contract.status !== OTC_STATUS.FUNDED) {
    return _otcToast('Deal must be funded before release', 'warning');
  }

  // Check TGE
  const tgeMs = new Date(contract.timestamp_utc).getTime();
  const now   = Date.now();
  if (now < tgeMs) {
    const diff  = tgeMs - now;
    const h     = Math.floor(diff / 3600000);
    const m     = Math.floor((diff % 3600000) / 60000);
    return _otcToast(`TGE not reached yet. Releases in ${h}h ${m}m.`, 'warning');
  }

  if (!confirm(`Release ${contract.amount} ${contract.asset} to seller ${_otcShort(contract.seller)}?`)) return;

  try {
    const signer  = await _otcGetSigner();
    const escrow  = otcGetEscrowContract(signer);
    if (!escrow) throw new Error('Escrow not available');

    _otcToast('Confirm release in wallet…', 'info');
    const tx = await escrow.release(contract.escrowDealId);
    _otcToast('⏳ Release tx sent — waiting…', 'info');
    const receipt = await tx.wait();

    contract.released      = true;
    contract.releaseTxHash = receipt.hash;
    contract.status        = OTC_STATUS.RELEASED;
    contract.updatedAt     = _otcNow();
    otcSave();
    _otcPushHistory(contract, `Released: ${contract.amount} ${contract.asset} to seller`);

    const explorerUrl = `${OTC_EXPLORER}/tx/${receipt.hash}`;
    _otcToast(`✅ Funds released to seller! <a href="${explorerUrl}" target="_blank" class="underline">View TX ↗</a>`, 'success');
    otcRenderMyContracts();

  } catch(e) {
    const decoded = _otcDecodeError(e);
    _otcToast(
      decoded.userRejected ? 'Transaction rejected' : `❌ Release error: ${decoded.msg}`,
      decoded.userRejected ? 'warning' : 'error'
    );
    _otcLog('release error:', e);
  }
}

// ─── 5. Request cancel on-chain (cancel dual-consent for funded deals) ─────
async function otcRequestCancelOnChain(contractId) {
  if (!window.ethereum || !window.walletState?.connected) {
    _otcToast('Connect wallet to request cancel', 'warning');
    return;
  }

  const contract = _otcContracts.find(c => c.contractId === contractId);
  if (!contract) return _otcToast('Contract not found', 'error');

  const walletAddr = window.walletState.address?.toLowerCase();
  const isBuyer    = contract.buyer.toLowerCase()  === walletAddr;
  const isSeller   = contract.seller.toLowerCase() === walletAddr;
  if (!isBuyer && !isSeller) return _otcToast('Not a party to this deal', 'error');

  if (!confirm(`Request cancel for deal ${contractId}?\nIf both parties consent, funds will be returned to buyer.`)) return;

  try {
    const signer  = await _otcGetSigner();
    const escrow  = otcGetEscrowContract(signer);
    if (!escrow) throw new Error('Escrow not available');

    _otcToast('Confirm cancel request in wallet…', 'info');
    const tx = await escrow.cancel(contract.escrowDealId);
    _otcToast('⏳ Cancel request tx sent — waiting…', 'info');
    const receipt = await tx.wait();

    // Check if fully cancelled (DealCancelled event)
    const iface   = new (window.ethers.Interface)(OTC_ESCROW_ABI);
    let cancelled = false;
    let refunded  = false;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed?.name === 'DealCancelled') { cancelled = true; refunded = parsed.args.refunded; break; }
      } catch(e) {}
    }

    if (cancelled) {
      contract.cancelled    = true;
      contract.cancelTxHash = receipt.hash;
      contract.status       = OTC_STATUS.CANCELLED;
      const refundMsg = refunded ? ` Funds refunded to buyer.` : '';
      _otcToast(`✅ Deal cancelled.${refundMsg}`, 'success');
    } else {
      // Only one party requested
      contract.status    = OTC_STATUS.CANCEL_REQUESTED;
      const role = isBuyer ? 'Buyer' : 'Seller';
      _otcToast(`⏳ Cancel requested by ${role}. Waiting for other party to confirm.`, 'info');
    }

    contract.cancelTxHash = receipt.hash;
    contract.updatedAt    = _otcNow();
    otcSave();
    _otcPushHistory(contract, `Cancel requested (${isBuyer ? 'Buyer' : 'Seller'})`);

    const explorerUrl = `${OTC_EXPLORER}/tx/${receipt.hash}`;
    _otcToast(`<a href="${explorerUrl}" target="_blank" class="underline">View TX ↗</a>`, 'info');
    otcRenderMyContracts();

  } catch(e) {
    const decoded = _otcDecodeError(e);
    _otcToast(
      decoded.userRejected ? 'Transaction rejected' : `❌ Cancel error: ${decoded.msg}`,
      decoded.userRejected ? 'warning' : 'error'
    );
    _otcLog('cancel error:', e);
  }
}

// ─── Internal cancel on-chain for unfunded deals ───────────────────────────
async function _otcCancelOnChain(contract) {
  try {
    const signer  = await _otcGetSigner();
    const escrow  = otcGetEscrowContract(signer);
    if (!escrow) return true; // no escrow, just local cancel

    _otcToast('Confirm cancel in wallet…', 'info');
    const tx = await escrow.cancel(contract.escrowDealId);
    await tx.wait();
    contract.cancelTxHash = tx.hash;
    return true;
  } catch(e) {
    const rej = e.code === 4001 || e.message?.includes('rejected');
    _otcToast(rej ? 'Cancel rejected' : `Cancel error: ${e.message}`, rej ? 'warning' : 'error');
    return false;
  }
}

// ─── 6. Sync deal status from on-chain ────────────────────────────────────
async function otcSyncDealStatus(contractId) {
  const contract = _otcContracts.find(c => c.contractId === contractId);
  if (!contract || !contract.escrowDealId) return;

  try {
    const ethers   = window.ethers;
    if (!ethers) return;
    const provider = new ethers.JsonRpcProvider(OTC_RPC);
    const escrow   = otcGetEscrowContract(provider);
    if (!escrow) return;

    const onChainStatus = await escrow.dealStatus(contract.escrowDealId);
    _otcLog(`On-chain status for ${contractId}: ${onChainStatus}`);

    const statusMap = {
      'CREATED':          OTC_STATUS.ONCHAIN_CREATED,
      'PARTIALLY_SIGNED': OTC_STATUS.ONCHAIN_CREATED,
      'BOTH_SIGNED':      OTC_STATUS.ONCHAIN_SIGNED,
      'FUNDED':           OTC_STATUS.FUNDED,
      'EXECUTABLE':       OTC_STATUS.FUNDED,  // FUNDED + TGE passed
      'RELEASED':         OTC_STATUS.RELEASED,
      'CANCELLED':        OTC_STATUS.CANCELLED,
    };

    const newStatus = statusMap[onChainStatus];
    if (newStatus && newStatus !== contract.status) {
      contract.status    = newStatus;
      contract.updatedAt = _otcNow();
      otcSave();
      otcRenderMyContracts();
    }

    // Also check if TGE passed for funded deal
    if (contract.status === OTC_STATUS.FUNDED) {
      const tgeMs = new Date(contract.timestamp_utc).getTime();
      if (Date.now() >= tgeMs) {
        // Still FUNDED but TGE passed — keep as FUNDED (release button becomes active)
        otcRenderMyContracts();
      }
    }

  } catch(e) {
    _otcLog('syncDealStatus error:', e);
  }
}

// ─── Status updater ───────────────────────────────────────────────────────────
function _otcUpdateStatus(contract) {
  const hasBuyerSig    = !!contract.buyerSig;
  const hasSellerSig   = !!contract.sellerSig;
  const scheduleMatch  = contract.sellerScheduleConfirmed;
  const bothSigned     = hasBuyerSig && hasSellerSig;

  // Don't override terminal/on-chain states
  const terminalStates = [
    OTC_STATUS.COMPLETED, OTC_STATUS.CANCELLED, OTC_STATUS.RELEASED,
    OTC_STATUS.FUNDED, OTC_STATUS.ONCHAIN_CREATED, OTC_STATUS.ONCHAIN_SIGNED,
    OTC_STATUS.CANCEL_REQUESTED,
  ];
  if (terminalStates.includes(contract.status)) return;

  if (bothSigned && scheduleMatch) {
    contract.status = OTC_STATUS.EXECUTABLE;
  } else if (bothSigned) {
    contract.status = OTC_STATUS.SIGNED;
  } else if (scheduleMatch) {
    contract.status = OTC_STATUS.SCHEDULED;
  } else if (hasBuyerSig || hasSellerSig) {
    contract.status = OTC_STATUS.LOCKED;
  } else {
    contract.status = OTC_STATUS.PENDING_SCHEDULE;
  }

  // If executable and TGE has passed → AWAITING_PAYMENT
  if (contract.status === OTC_STATUS.EXECUTABLE) {
    const tgeMs = new Date(contract.tgeDatetime || contract.timestamp_utc).getTime();
    if (Date.now() >= tgeMs) {
      contract.status = OTC_STATUS.AWAITING_PAYMENT;
    }
  }
}

// ─── Cancel Contract ──────────────────────────────────────────────────────────
async function otcCancelContract(contractId) {
  const contract = _otcContracts.find(c => c.contractId === contractId);
  if (!contract) return;
  if ([OTC_STATUS.COMPLETED, OTC_STATUS.RELEASED, OTC_STATUS.CANCELLED].includes(contract.status)) {
    return _otcToast('Cannot cancel a completed or already cancelled contract', 'warning');
  }

  // For funded on-chain deals, we need both parties via cancel()
  if (contract.onChain && contract.escrowDealId &&
      [OTC_STATUS.FUNDED, OTC_STATUS.CANCEL_REQUESTED].includes(contract.status)) {
    return otcRequestCancelOnChain(contractId);
  }

  if (!confirm(`Cancel contract ${contractId}? This cannot be undone.`)) return;

  // Try on-chain cancel if contract is registered on-chain
  if (contract.onChain && contract.escrowDealId &&
      [OTC_STATUS.ONCHAIN_CREATED, OTC_STATUS.ONCHAIN_SIGNED].includes(contract.status)) {
    const ok = await _otcCancelOnChain(contract);
    if (!ok) return; // error already toasted
  }

  contract.status    = OTC_STATUS.CANCELLED;
  contract.updatedAt = _otcNow();
  otcSave();
  _otcPushHistory(contract, 'Cancelled');
  _otcToast('Contract cancelled', 'info');
  otcRenderMyContracts();
}

// ─── Download Receipt ─────────────────────────────────────────────────────────
function otcDownloadReceipt(contractId) {
  const contract = _otcContracts.find(c => c.contractId === contractId);
  if (!contract) return _otcToast('Contract not found', 'error');

  const receipt = contract.receipt || {
    contractId:  contract.contractId,
    status:      contract.status,
    buyer:       contract.buyer,
    seller:      contract.seller,
    asset:       contract.asset,
    amount:      contract.amount,
    tge:         _otcDisplayDT(contract.timestamp_utc || _otcToUTCIso(contract.tgeDate, contract.tgeTime)),
    timestamp_utc: contract.timestamp_utc || _otcToUTCIso(contract.tgeDate, contract.tgeTime),
    createdAt:   contract.createdAt,
    completedAt: contract.verifiedAt || '—',
    txHash:      contract.txProof?.txHash || '—',
    contractHash: contract.contractHash,
    buyerSig:    contract.buyerSig || 'not signed',
    sellerSig:   contract.sellerSig || 'not signed',
  };

  // Try jsPDF if available, fallback to JSON download
  if (typeof window.jspdf !== 'undefined' || typeof window.jsPDF !== 'undefined') {
    const jsPDF = window.jsPDF || window.jspdf?.jsPDF;
    const doc   = new jsPDF();
    doc.setFontSize(16);
    doc.text('ExecDaat — OTC Contract Receipt', 14, 20);
    doc.setFontSize(10);
    let y = 35;
    const add = (label, val) => {
      doc.setTextColor(120,130,150);
      doc.text(label, 14, y);
      doc.setTextColor(30,30,30);
      doc.text(String(val||'—').slice(0,80), 70, y);
      y += 8;
    };
    add('Contract ID:',   receipt.contractId);
    add('Status:',        receipt.status);
    add('Buyer:',         receipt.buyer);
    add('Seller:',        receipt.seller);
    add('Asset:',         receipt.asset);
    add('Amount:',        receipt.amount + ' ' + receipt.asset);
    add('TGE:',           receipt.tge);
    add('TX Hash:',       receipt.txHash);
    add('Contract Hash:', receipt.contractHash);
    add('Created At:',    _otcDisplayDT(receipt.createdAt));
    add('Completed At:',  receipt.completedAt !== '—' ? _otcDisplayDT(receipt.completedAt) : '—');
    add('TGE (UTC):',     receipt.tge || _otcDisplayDT(receipt.timestamp_utc));
    doc.save(`OTC-${contractId}.pdf`);
  } else {
    const blob = new Blob([JSON.stringify(receipt, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `OTC-${contractId}.json`; a.click();
    URL.revokeObjectURL(url);
  }

  _otcToast('Receipt downloaded', 'success');
}

// ─── Marketplace: Create Listing ──────────────────────────────────────────────
function otcCreateListing() {
  const wallet = window.walletState?.address;
  if (!wallet) return _otcToast('Connect wallet to create a listing', 'warning');

  const description = _otcVal('mkt-description');
  const token       = _otcVal('mkt-token');
  const amount      = parseFloat(_otcVal('mkt-amount'));
  const price       = parseFloat(_otcVal('mkt-price'));
  const tgeDate     = _otcVal('mkt-tge-date');

  if (!description) return _otcToast('Description required', 'warning');
  if (!token)       return _otcToast('Select a token', 'warning');
  if (!amount || isNaN(amount) || amount <= 0) return _otcToast('Enter valid amount', 'warning');
  if (!price  || isNaN(price)  || price  <= 0) return _otcToast('Enter asking price', 'warning');
  if (!tgeDate) return _otcToast('TGE date required', 'warning');

  // Convert tgeDate (YYYY-MM-DD from <input type="date">) to ISO UTC (midnight UTC)
  const tgeDateUTC = tgeDate ? tgeDate + 'T00:00:00Z' : '';

  const listing = {
    id:          'LST-' + Date.now().toString(36).toUpperCase(),
    seller:      wallet,
    description,
    token,
    amount,
    price,
    tgeDate:     tgeDateUTC,   // stored as ISO 8601 UTC
    status:      'OPEN', // OPEN | NEGOTIATING | CLOSED
    createdAt:   _otcNow(),
    updatedAt:   _otcNow(),
    interestedBuyers: [],
  };

  _otcListings.unshift(listing);
  otcSave();
  _otcToast('✅ Listing created!', 'success');
  _otcLog('Listing created:', listing);
  _otcResetMktForm();
  otcRenderMarketplace();
}

// ─── Marketplace: Enter Deal ──────────────────────────────────────────────────
function otcEnterDeal(listingId) {
  const listing = _otcListings.find(l => l.id === listingId);
  if (!listing) return _otcToast('Listing not found', 'error');
  if (listing.status !== 'OPEN') return _otcToast('This listing is no longer open', 'warning');

  const buyer = window.walletState?.address;
  if (!buyer) return _otcToast('Connect wallet to enter a deal', 'warning');
  if (buyer.toLowerCase() === listing.seller.toLowerCase()) {
    return _otcToast('You cannot buy your own listing', 'warning');
  }

  // Pre-fill create deal form and switch to create sub-tab
  otcSwitchSub('create');
  setTimeout(() => {
    const buyerEl  = _otcEl('otc-buyer');
    const sellerEl = _otcEl('otc-seller');
    const assetEl  = _otcEl('otc-asset');
    const amountEl = _otcEl('otc-amount');
    const dateEl   = _otcEl('otc-tge-date');
    const descEl   = _otcEl('otc-description');

    if (buyerEl)  buyerEl.value  = buyer;
    if (sellerEl) sellerEl.value = listing.seller;
    if (assetEl)  assetEl.value  = listing.token;
    if (amountEl) amountEl.value = listing.amount;
    if (dateEl) {
      // listing.tgeDate is stored as ISO UTC; extract YYYY-MM-DD for the date input
      const { dateYMD } = listing.tgeDate ? _otcFromUTCIso(listing.tgeDate) : { dateYMD: '' };
      dateEl.value = dateYMD || listing.tgeDate;
    }
    if (descEl)   descEl.value   = `OTC Deal from marketplace listing ${listingId}: ${listing.description}`;

    listing.status = 'NEGOTIATING';
    listing.interestedBuyers.push({ buyer, at: _otcNow() });
    otcSave();
    otcRenderMarketplace();

    _otcToast('Deal form pre-filled from listing. Review and create contract.', 'info');
  }, 200);
}

// ─── Marketplace: Cancel Listing ─────────────────────────────────────────────
/**
 * Cancels a marketplace listing created by the connected wallet.
 *
 * Guards:
 *   - Wallet must be connected and match listing.seller
 *   - Status must be OPEN or NEGOTIATING (not CLOSED or already CANCELLED)
 *   - If NEGOTIATING, block cancellation — a deal is already in progress
 * Flow:
 *   1. Verify ownership
 *   2. Show confirm dialog
 *   3. Mark as CANCELLED + timestamp
 *   4. Persist to localStorage
 *   5. Push to global history
 *   6. Re-render marketplace with instant visual feedback
 */
function otcCancelListing(listingId) {
  const wallet = window.walletState?.address;
  if (!wallet) {
    _otcToast('Connect your wallet to cancel a listing', 'warning');
    return;
  }

  const listing = _otcListings.find(l => l.id === listingId);
  if (!listing) return _otcToast('Listing not found', 'error');

  // ── Ownership check ──────────────────────────────────────────────────────
  if (listing.seller.toLowerCase() !== wallet.toLowerCase()) {
    return _otcToast('Only the creator of this listing can cancel it', 'error');
  }

  // ── Status guards ────────────────────────────────────────────────────────
  if (listing.status === 'CANCELLED') {
    return _otcToast('This listing is already cancelled', 'warning');
  }
  if (listing.status === 'CLOSED') {
    return _otcToast('This listing is closed and cannot be cancelled', 'warning');
  }
  if (listing.status === 'NEGOTIATING') {
    return _otcToast(
      '❌ Cannot cancel active or in-progress deal — a buyer is already negotiating. ' +
      'Wait for the deal to conclude or contact the counterparty.',
      'error'
    );
  }

  // ── Confirmation step ────────────────────────────────────────────────────
  const confirmed = confirm(
    `Are you sure you want to cancel this listing?\n\n` +
    `"${listing.description}"\n` +
    `${listing.amount} ${listing.token} — $${_otcFmt(listing.price)}\n\n` +
    `This action cannot be undone.`
  );
  if (!confirmed) return;

  // ── Apply cancellation ───────────────────────────────────────────────────
  listing.status      = 'CANCELLED';
  listing.cancelledAt = _otcNow();
  listing.cancelledBy = wallet;
  listing.updatedAt   = _otcNow();

  otcSave();

  // Push to global transaction history
  try {
    const hist = JSON.parse(localStorage.getItem('execDaat_history') || '[]');
    hist.unshift({
      type:        'otc_listing',
      event:       'Listing Cancelled',
      listingId:   listing.id,
      seller:      listing.seller,
      token:       listing.token,
      amount:      listing.amount,
      price:       listing.price,
      description: listing.description,
      status:      'CANCELLED',
      timestamp:   _otcNow(),
    });
    localStorage.setItem('execDaat_history', JSON.stringify(hist.slice(0, 200)));
  } catch(e) {}

  _otcLog('Listing cancelled:', listingId);
  _otcToast('✅ Listing cancelled successfully.', 'success');
  otcRenderMarketplace();
}

// ─── History bridge ───────────────────────────────────────────────────────────
function _otcPushHistory(contract, event) {
  try {
    const hist = JSON.parse(localStorage.getItem('execDaat_history') || '[]');
    hist.unshift({
      type:       'otc',
      event,
      contractId: contract.contractId,
      buyer:      contract.buyer,
      seller:     contract.seller,
      asset:      contract.asset,
      amount:     contract.amount,
      status:     contract.status,
      timestamp:  _otcNow(),
    });
    localStorage.setItem('execDaat_history', JSON.stringify(hist.slice(0, 200)));
  } catch(e) {}
}

// ─── Render: Sub-tab switcher ─────────────────────────────────────────────────
function otcSwitchSub(sub) {
  _otcSubTab = sub;
  ['create','my','market'].forEach(s => {
    const btn     = _otcEl(`otc-sub-${s}`);
    const content = _otcEl(`otc-panel-${s}`);
    if (btn) {
      btn.className = s === sub
        ? 'otc-sub-btn px-5 py-2.5 rounded-xl text-sm font-semibold transition-all bg-indigo-600 text-white shadow-md'
        : 'otc-sub-btn px-5 py-2.5 rounded-xl text-sm font-medium transition-all text-gray-400 hover:text-white hover:bg-gray-800/60';
    }
    if (content) content.classList.toggle('hidden', s !== sub);
  });

  if (sub === 'my')     otcRenderMyContracts();
  if (sub === 'market') otcRenderMarketplace();
  if (sub === 'create') _otcAutoFillWallet();
}

// ─── Auto-fill wallet into buyer field ───────────────────────────────────────
function _otcAutoFillWallet() {
  const buyer = window.walletState?.address;
  if (!buyer) return;
  const buyerEl = _otcEl('otc-buyer');
  if (buyerEl && !buyerEl.value) buyerEl.value = buyer;
}

// ─── Render: My Contracts ─────────────────────────────────────────────────────
function otcRenderMyContracts() {
  const container = _otcEl('otc-my-list');
  if (!container) return;

  const wallet = window.walletState?.address?.toLowerCase();

  // Check statuses (TGE may have passed)
  _otcContracts.forEach(c => {
    if (![OTC_STATUS.COMPLETED, OTC_STATUS.CANCELLED, OTC_STATUS.DISPUTED, OTC_STATUS.AWAITING_PAYMENT].includes(c.status)) {
      _otcUpdateStatus(c);
    }
  });

  const myContracts = wallet
    ? _otcContracts.filter(c => c.buyer.toLowerCase() === wallet || c.seller.toLowerCase() === wallet)
    : _otcContracts;

  if (!myContracts.length) {
    container.innerHTML = `
      <div class="flex flex-col items-center gap-3 py-16 text-center text-gray-600">
        <i class="fas fa-handshake text-3xl"></i>
        <p class="text-gray-500 text-sm">No OTC contracts yet.</p>
        <button onclick="otcSwitchSub('create')"
          class="mt-2 flex items-center gap-2 text-sm px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl transition font-semibold">
          <i class="fas fa-plus"></i>Create First Deal
        </button>
      </div>`;
    return;
  }

  container.innerHTML = myContracts.map(c => _otcContractCard(c, wallet)).join('');
}

function _otcContractCard(c, wallet) {
  const st        = OTC_STATUS_LABEL[c.status] || OTC_STATUS_LABEL.PENDING_SCHEDULE;
  const isBuyer   = wallet && c.buyer.toLowerCase() === wallet;
  const isSeller  = wallet && c.seller.toLowerCase() === wallet;
  const isParty   = isBuyer || isSeller;

  // ── Derived state flags ────────────────────────────────────────────────────
  const isTerminal = [OTC_STATUS.COMPLETED, OTC_STATUS.CANCELLED, OTC_STATUS.RELEASED].includes(c.status);
  const isOnChain  = !!c.onChain && !!c.escrowDealId;

  // Off-chain sign (EIP-191) — only while NOT yet on-chain
  const canOffSign = !isOnChain && !isTerminal && (
    (isBuyer && !c.buyerSig) || (isSeller && !c.sellerSig)
  );

  // Register on-chain: buyer, both off-chain signed, schedule confirmed, escrow deployed, not yet on-chain
  const bothOffSigned = !!c.buyerSig && !!c.sellerSig;
  const canRegister   = isBuyer && bothOffSigned && c.sellerScheduleConfirmed
    && !isOnChain && !isTerminal && OTC_ESCROW_DEPLOYED;

  // Sign on-chain
  const onChainBuyerSigned  = isOnChain && !!c.buyerSig  && (c.buyerSig.startsWith('0x') && c.buyerSig.length === 66);
  const onChainSellerSigned = isOnChain && !!c.sellerSig && (c.sellerSig.startsWith('0x') && c.sellerSig.length === 66);
  const canSignOnChain = isOnChain && !isTerminal && (
    (isBuyer  && !onChainBuyerSigned)  ||
    (isSeller && !onChainSellerSigned)
  ) && [OTC_STATUS.ONCHAIN_CREATED, OTC_STATUS.ONCHAIN_SIGNED].includes(c.status);

  // Fund: buyer, both signed on-chain (either ONCHAIN_SIGNED status or ONCHAIN_CREATED
  // with both local sigs present — handles out-of-sync local state), escrow not yet funded
  const canFund = isOnChain && isBuyer && !isTerminal
    && (c.status === OTC_STATUS.ONCHAIN_SIGNED
        || (c.status === OTC_STATUS.ONCHAIN_CREATED && onChainBuyerSigned && onChainSellerSigned));

  // Release: any party (buyer typically initiates), funded + TGE reached
  const tgeTs   = new Date(c.timestamp_utc || _otcToUTCIso(c.tgeDate, c.tgeTime)).getTime();
  const tgeIn   = tgeTs - Date.now();
  const tgePast = tgeIn <= 0;
  const canRelease = isOnChain && isParty && !isTerminal
    && c.status === OTC_STATUS.FUNDED && tgePast;

  // Cancel on-chain: party + not released + not already cancelled
  const canCancelOnChain = isOnChain && isParty && !isTerminal
    && [OTC_STATUS.ONCHAIN_CREATED, OTC_STATUS.ONCHAIN_SIGNED, OTC_STATUS.FUNDED, OTC_STATUS.CANCEL_REQUESTED].includes(c.status);

  // Off-chain cancel: not on-chain, not terminal
  const canCancelOffChain = !isOnChain && !isTerminal
    && [OTC_STATUS.PENDING_SCHEDULE, OTC_STATUS.SCHEDULED, OTC_STATUS.SIGNED, OTC_STATUS.LOCKED, OTC_STATUS.EXECUTABLE, OTC_STATUS.AWAITING_PAYMENT].includes(c.status);

  // Legacy TX proof (off-chain flow)
  const canProof = !isOnChain && isBuyer && c.status === OTC_STATUS.AWAITING_PAYMENT;

  const tgeLabel = tgeIn > 0
    ? `in ${_otcFormatDuration(tgeIn)}`
    : `${_otcFormatDuration(-tgeIn)} ago`;

  // ── Timeline steps — adapts to on-chain vs off-chain mode ────────────────
  let steps;
  if (isOnChain) {
    steps = [
      { label: 'Created',   done: true },
      { label: 'Registered',done: isOnChain },
      { label: 'Signed',    done: c.status === OTC_STATUS.ONCHAIN_SIGNED || c.status === OTC_STATUS.FUNDED || c.status === OTC_STATUS.RELEASED },
      { label: 'Funded',    done: c.status === OTC_STATUS.FUNDED || c.status === OTC_STATUS.RELEASED },
      { label: 'Released',  done: c.status === OTC_STATUS.RELEASED },
    ];
  } else {
    steps = [
      { label: 'Created',   done: true },
      { label: 'Scheduled', done: c.sellerScheduleConfirmed },
      { label: 'Signed',    done: bothOffSigned },
      { label: 'Paid',      done: !!c.verifiedAt },
      { label: 'Done',      done: c.status === OTC_STATUS.COMPLETED },
    ];
  }
  // Mark active (the first undone step)
  let foundActive = false;
  steps = steps.map(s => {
    if (!s.done && !foundActive && !isTerminal) { foundActive = true; return {...s, active: true}; }
    return {...s, active: false};
  });

  return `
  <div class="bg-gray-900/70 border border-gray-700/50 rounded-2xl overflow-hidden hover:border-indigo-700/40 transition-all mb-4">
    <!-- Header -->
    <div class="flex items-center justify-between px-5 py-4 border-b border-gray-800/60">
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-xl bg-indigo-900/40 border border-indigo-700/30 flex items-center justify-center">
          <i class="fas ${isOnChain ? 'fa-link' : 'fa-handshake'} text-${isOnChain ? 'violet' : 'indigo'}-400 text-sm"></i>
        </div>
        <div>
          <div class="text-white font-bold text-sm font-mono">${c.contractId}</div>
          <div class="text-gray-500 text-xs">${_otcDisplayCreated(c.createdAt)} · ${c.asset} · ${_otcFmt(c.amount)} ${c.asset}
            ${isOnChain ? '<span class="ml-1 text-[9px] text-violet-400 font-semibold bg-violet-900/30 px-1.5 py-0.5 rounded-full border border-violet-700/40">ON-CHAIN</span>' : ''}
          </div>
        </div>
      </div>
      <div class="flex items-center gap-2">
        ${isOnChain ? `
        <button onclick="otcSyncDealStatus('${c.contractId}')" title="Sync status from blockchain"
          class="text-gray-600 hover:text-violet-400 transition p-1.5 rounded-lg hover:bg-gray-800">
          <i class="fas fa-sync text-[10px]"></i>
        </button>` : ''}
        <span class="inline-flex items-center gap-1.5 text-xs px-3 py-1 rounded-full border ${st.bg} ${st.color} font-semibold">
          <i class="fas ${st.icon} text-[10px]"></i>${st.label}
        </span>
      </div>
    </div>

    <!-- Timeline -->
    <div class="flex items-center px-5 py-3 gap-0 border-b border-gray-800/60 overflow-x-auto">
      ${steps.map((s, i) => `
        <div class="flex items-center flex-shrink-0">
          <div class="flex flex-col items-center">
            <div class="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${s.done ? 'bg-emerald-600 text-white' : s.active ? 'bg-indigo-600 text-white ring-2 ring-indigo-400/50 ring-offset-1 ring-offset-gray-900' : 'bg-gray-800 text-gray-600 border border-gray-700'}">
              ${s.done ? '<i class="fas fa-check text-[8px]"></i>' : i+1}
            </div>
            <span class="text-[9px] mt-1 ${s.done ? 'text-emerald-400' : s.active ? 'text-indigo-400' : 'text-gray-600'} whitespace-nowrap">${s.label}</span>
          </div>
          ${i < steps.length-1 ? `<div class="w-8 sm:w-12 h-0.5 mx-1 mt-[-12px] ${s.done ? 'bg-emerald-600' : 'bg-gray-700'}"></div>` : ''}
        </div>
      `).join('')}
    </div>

    <!-- Details -->
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-0 text-xs border-b border-gray-800/60">
      ${[
        ['Buyer',  _otcShort(c.buyer)  + (isBuyer  ? ' <span class="text-indigo-400">(you)</span>' : '')],
        ['Seller', _otcShort(c.seller) + (isSeller ? ' <span class="text-indigo-400">(you)</span>' : '')],
        ['TGE (UTC)', _otcDisplayDT(c.timestamp_utc || _otcToUTCIso(c.tgeDate, c.tgeTime))],
        ['TGE', tgeLabel],
      ].map(([lbl,val]) => `
        <div class="px-4 py-3 border-r border-gray-800/40 last:border-0">
          <div class="text-gray-600 text-[10px]">${lbl}</div>
          <div class="text-gray-300 font-mono mt-0.5">${val}</div>
        </div>
      `).join('')}
    </div>

    <!-- On-chain escrow info (if registered) -->
    ${isOnChain ? `
    <div class="px-5 py-3 bg-violet-950/20 border-b border-violet-800/20 text-xs flex flex-wrap items-center gap-x-4 gap-y-1">
      <span class="text-violet-400 font-semibold"><i class="fas fa-link mr-1"></i>Escrow Contract Active</span>
      <span class="text-gray-500 font-mono">Deal ID: ${_otcShort(c.escrowDealId)}</span>
      ${c.escrowTxHash ? `<a href="${OTC_EXPLORER}/tx/${c.escrowTxHash}" target="_blank" class="text-violet-300 underline">Create TX ↗</a>` : ''}
      ${c.fundTxHash   ? `<a href="${OTC_EXPLORER}/tx/${c.fundTxHash}"   target="_blank" class="text-teal-300 underline">Fund TX ↗</a>` : ''}
      ${c.releaseTxHash? `<a href="${OTC_EXPLORER}/tx/${c.releaseTxHash}" target="_blank" class="text-emerald-300 underline">Release TX ↗</a>` : ''}
      ${c.cancelTxHash ? `<a href="${OTC_EXPLORER}/tx/${c.cancelTxHash}" target="_blank" class="text-red-300 underline">Cancel TX ↗</a>` : ''}
    </div>` : ''}

    <!-- Signature status (off-chain) -->
    ${!isOnChain ? `
    <div class="flex items-center gap-4 px-5 py-3 border-b border-gray-800/60 text-xs">
      <div class="flex items-center gap-1.5 ${c.buyerSig ? 'text-emerald-400' : 'text-gray-600'}">
        <i class="fas ${c.buyerSig ? 'fa-check-circle' : 'fa-circle'} text-[10px]"></i>
        Buyer sig ${c.buyerSig ? '✓' : 'pending'}
      </div>
      <div class="flex items-center gap-1.5 ${c.sellerSig ? 'text-emerald-400' : 'text-gray-600'}">
        <i class="fas ${c.sellerSig ? 'fa-check-circle' : 'fa-circle'} text-[10px]"></i>
        Seller sig ${c.sellerSig ? '✓' : 'pending'}
      </div>
      <div class="flex items-center gap-1.5 ${c.sellerScheduleConfirmed ? 'text-emerald-400' : 'text-yellow-600'}">
        <i class="fas ${c.sellerScheduleConfirmed ? 'fa-check-circle' : 'fa-clock'} text-[10px]"></i>
        Schedule ${c.sellerScheduleConfirmed ? 'matched' : 'unconfirmed'}
      </div>
    </div>` : ''}

    <!-- Seller schedule confirm (if not confirmed, off-chain flow) -->
    ${!isOnChain && isSeller && !c.sellerScheduleConfirmed && !isTerminal ? `
    <div class="px-5 py-3 bg-yellow-950/20 border-b border-yellow-800/20">
      <p class="text-yellow-400 text-xs font-semibold mb-2"><i class="fas fa-exclamation-triangle mr-1"></i>Confirm schedule to match buyer</p>
      <p class="text-gray-500 text-xs mb-2">Buyer set: <span class="text-white font-mono">${_otcDisplayDT(c.timestamp_utc || _otcToUTCIso(c.tgeDate, c.tgeTime))}</span></p>
      <div class="flex items-center gap-2 flex-wrap">
        <input type="date" id="otc-seller-date-${c.contractId}" value="${c.tgeDate}"
          class="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white">
        <input type="time" id="otc-seller-time-${c.contractId}" value="${c.tgeTime}"
          class="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white">
        <button onclick="otcConfirmSchedule('${c.contractId}')"
          class="flex items-center gap-1.5 px-3 py-1.5 bg-yellow-600 hover:bg-yellow-500 text-white rounded-lg text-xs font-semibold transition">
          <i class="fas fa-check"></i>Confirm
        </button>
      </div>
      <p id="otc-sched-err-${c.contractId}" class="hidden text-red-400 text-[10px] mt-1"></p>
    </div>` : ''}

    <!-- On-chain Sign prompt (ONCHAIN_CREATED state) -->
    ${isOnChain && canSignOnChain ? `
    <div class="px-5 py-3 bg-violet-950/20 border-b border-violet-800/20">
      <p class="text-violet-400 text-xs font-semibold mb-1.5"><i class="fas fa-file-signature mr-1"></i>Sign escrow on-chain</p>
      <p class="text-gray-500 text-xs mb-2">
        Buyer sign: <span class="${onChainBuyerSigned ? 'text-emerald-400' : 'text-yellow-400'}">${onChainBuyerSigned ? '✓ Signed' : 'Pending'}</span>
        &nbsp;·&nbsp;
        Seller sign: <span class="${onChainSellerSigned ? 'text-emerald-400' : 'text-yellow-400'}">${onChainSellerSigned ? '✓ Signed' : 'Pending'}</span>
      </p>
    </div>` : ''}

    <!-- On-chain Fund prompt (ONCHAIN_SIGNED state) -->
    ${isOnChain && c.status === OTC_STATUS.ONCHAIN_SIGNED && isBuyer ? `
    <div class="px-5 py-3 bg-teal-950/20 border-b border-teal-800/20">
      <p class="text-teal-400 text-xs font-semibold mb-1"><i class="fas fa-vault mr-1"></i>Ready to fund escrow</p>
      <p class="text-gray-500 text-xs">Both parties signed on-chain. Approve ERC-20 and lock <strong class="text-white">${_otcFmt(c.amount)} ${c.asset}</strong> in escrow.</p>
    </div>` : ''}

    <!-- Funded info -->
    ${isOnChain && c.status === OTC_STATUS.FUNDED ? `
    <div class="px-5 py-3 bg-teal-950/20 border-b border-teal-800/20">
      <p class="text-teal-400 text-xs font-semibold"><i class="fas fa-vault mr-1"></i>Tokens locked in escrow</p>
      <p class="text-gray-500 text-xs mt-1">
        <strong class="text-white">${_otcFmt(c.amount)} ${c.asset}</strong> locked until TGE.
        ${tgePast ? '<span class="text-emerald-400 font-semibold ml-2">TGE reached — release available!</span>' : `Releases ${tgeLabel}.`}
      </p>
    </div>` : ''}

    <!-- Cancel requested info -->
    ${c.status === OTC_STATUS.CANCEL_REQUESTED ? `
    <div class="px-5 py-3 bg-amber-950/20 border-b border-amber-800/20">
      <p class="text-amber-400 text-xs font-semibold"><i class="fas fa-undo mr-1"></i>Cancel Requested</p>
      <p class="text-gray-500 text-xs mt-1">Waiting for the other party to also call cancel. Both must consent to refund locked tokens.</p>
    </div>` : ''}

    <!-- Released / Completed -->
    ${(c.status === OTC_STATUS.RELEASED || c.status === OTC_STATUS.COMPLETED) ? `
    <div class="px-5 py-2 bg-emerald-950/20 border-b border-emerald-800/20 flex items-center gap-2 text-xs">
      <i class="fas fa-check-double text-emerald-400"></i>
      <span class="text-emerald-400 font-semibold">${c.status === OTC_STATUS.RELEASED ? 'Tokens released to seller' : 'Payment verified on-chain'}</span>
      ${c.releaseTxHash ? `<a href="${OTC_EXPLORER}/tx/${c.releaseTxHash}" target="_blank" class="text-emerald-300 font-mono underline ml-2">${_otcShort(c.releaseTxHash)}</a>` : ''}
      ${c.txProof?.txHash && !c.releaseTxHash ? `<a href="${OTC_EXPLORER}/tx/${c.txProof.txHash}" target="_blank" class="text-emerald-300 font-mono underline ml-2">${_otcShort(c.txProof.txHash)}</a>` : ''}
    </div>` : ''}

    <!-- TX Proof (legacy off-chain flow) -->
    ${canProof ? `
    <div class="px-5 py-3 bg-cyan-950/20 border-b border-cyan-800/20">
      <p class="text-cyan-400 text-xs font-semibold mb-2"><i class="fas fa-file-invoice-dollar mr-1"></i>Submit Payment Proof</p>
      <div class="flex items-center gap-2 flex-wrap">
        <input type="text" id="otc-tx-proof-${c.contractId}" placeholder="0x… (TX hash)"
          class="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white font-mono placeholder-gray-600">
        <input type="number" id="otc-tx-amount-${c.contractId}" placeholder="${c.amount}" value="${c.amount}" step="any"
          class="w-24 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white">
        <input type="text" id="otc-tx-token-${c.contractId}" placeholder="${c.asset}" value="${c.asset}"
          class="w-20 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white">
        <button id="otc-proof-btn-${c.contractId}" onclick="otcSubmitTxProof('${c.contractId}')"
          class="flex items-center gap-1.5 px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-xs font-semibold transition">
          <i class="fas fa-check-circle"></i>Submit & Verify
        </button>
      </div>
    </div>` : ''}

    <!-- Actions bar -->
    <div class="flex items-center gap-2 px-5 py-3 flex-wrap">

      <!-- Off-chain EIP-191 sign -->
      ${canOffSign ? `
      <button onclick="otcSignContract('${c.contractId}')"
        class="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-semibold transition">
        <i class="fas fa-signature"></i>Sign (EIP-191)
      </button>` : ''}

      <!-- Register on-chain (createDeal) -->
      ${canRegister ? `
      <button onclick="otcRegisterOnChain('${c.contractId}')"
        class="flex items-center gap-1.5 px-4 py-2 bg-violet-600 hover:bg-violet-500 text-white rounded-xl text-xs font-semibold transition shadow-md shadow-violet-900/30">
        <i class="fas fa-link"></i>Register On-Chain
      </button>` : ''}

      <!-- Sign on-chain (signDeal) -->
      ${canSignOnChain ? `
      <button onclick="otcSignDealOnChain('${c.contractId}')"
        class="flex items-center gap-1.5 px-4 py-2 bg-violet-700 hover:bg-violet-600 text-white rounded-xl text-xs font-semibold transition">
        <i class="fas fa-file-signature"></i>Sign On-Chain
      </button>` : ''}

      <!-- Fund escrow (approve + fundDeal) -->
      ${canFund ? `
      <button onclick="otcFundDeal('${c.contractId}')"
        class="flex items-center gap-1.5 px-4 py-2 bg-teal-600 hover:bg-teal-500 text-white rounded-xl text-xs font-semibold transition shadow-md shadow-teal-900/30">
        <i class="fas fa-vault"></i>Fund Escrow
      </button>` : ''}

      <!-- Release funds (release) -->
      ${canRelease ? `
      <button onclick="otcReleaseDeal('${c.contractId}')"
        class="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-semibold transition shadow-md shadow-emerald-900/30">
        <i class="fas fa-paper-plane"></i>Release Funds
      </button>` : ''}

      <!-- Fund TGE countdown (funded but not yet releasable) -->
      ${isOnChain && c.status === OTC_STATUS.FUNDED && !tgePast ? `
      <span class="flex items-center gap-1.5 px-4 py-2 bg-gray-800 border border-teal-700/30 text-teal-400 rounded-xl text-xs">
        <i class="fas fa-hourglass-half"></i>Release in ${tgeLabel}
      </span>` : ''}

      <!-- Receipt -->
      <button onclick="otcDownloadReceipt('${c.contractId}')"
        class="flex items-center gap-1.5 px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-400 hover:text-white rounded-xl text-xs transition">
        <i class="fas fa-download"></i>Receipt
      </button>

      <!-- Cancel on-chain -->
      ${canCancelOnChain ? `
      <button onclick="otcRequestCancelOnChain('${c.contractId}')"
        class="flex items-center gap-1.5 px-4 py-2 bg-red-900/30 hover:bg-red-900/50 border border-red-800/40 text-red-400 hover:text-red-300 rounded-xl text-xs transition">
        <i class="fas fa-times"></i>${c.status === OTC_STATUS.FUNDED || c.status === OTC_STATUS.CANCEL_REQUESTED ? 'Request Cancel' : 'Cancel Escrow'}
      </button>` : ''}

      <!-- Cancel off-chain -->
      ${canCancelOffChain ? `
      <button onclick="otcCancelContract('${c.contractId}')"
        class="flex items-center gap-1.5 px-4 py-2 bg-red-900/30 hover:bg-red-900/50 border border-red-800/40 text-red-400 hover:text-red-300 rounded-xl text-xs transition">
        <i class="fas fa-times"></i>Cancel
      </button>` : ''}

    </div>
  </div>`;
}

// ─── Render: Marketplace ──────────────────────────────────────────────────────
function otcRenderMarketplace() {
  const container = _otcEl('otc-mkt-list');
  if (!container) return;

  const wallet = window.walletState?.address?.toLowerCase();

  // Active listings: OPEN or NEGOTIATING (not CLOSED, not CANCELLED)
  const active    = _otcListings.filter(l => l.status !== 'CLOSED' && l.status !== 'CANCELLED');
  // Cancelled listings owned by current wallet (shown as history at bottom)
  const cancelled = _otcListings.filter(l => l.status === 'CANCELLED' && wallet && l.seller.toLowerCase() === wallet);

  const statusColors = {
    OPEN:        'text-green-400 bg-green-900/30 border-green-700/40',
    NEGOTIATING: 'text-yellow-400 bg-yellow-900/30 border-yellow-700/40',
    CLOSED:      'text-gray-500 bg-gray-800/40 border-gray-700/40',
    CANCELLED:   'text-red-400 bg-red-900/30 border-red-700/40',
  };

  let html = '';

  if (!active.length) {
    html += `
      <div class="flex flex-col items-center gap-3 py-12 text-center text-gray-600">
        <i class="fas fa-store text-3xl"></i>
        <p class="text-gray-500 text-sm">No active listings yet.</p>
        <p class="text-gray-600 text-xs">Be the first to list a deal!</p>
      </div>`;
  } else {
    html += active.map(l => {
      const isOwn      = wallet && l.seller.toLowerCase() === wallet;
      const canCancel  = isOwn && l.status === 'OPEN';   // only OPEN can be cancelled
      const isBlocked  = isOwn && l.status === 'NEGOTIATING'; // in-progress — show warning badge
      return `
      <div class="bg-gray-900/70 border border-gray-700/50 rounded-2xl p-5 hover:border-indigo-700/40 transition-all" id="listing-card-${l.id}">
        <div class="flex items-start justify-between gap-3 mb-3">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-700/30 to-purple-700/30 border border-indigo-700/30 flex items-center justify-center flex-shrink-0">
              <i class="fas fa-tags text-indigo-400 text-base"></i>
            </div>
            <div>
              <div class="text-white font-semibold text-sm">${l.description}</div>
              <div class="text-gray-500 text-xs font-mono">${_otcShort(l.seller)}${isOwn ? ' <span class="text-indigo-400 font-semibold">(you)</span>' : ''}</div>
            </div>
          </div>
          <span class="inline-flex items-center gap-1 text-[10px] px-2.5 py-1 rounded-full border font-semibold ${statusColors[l.status] || statusColors.OPEN}">${l.status}</span>
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4 text-xs">
          <div class="bg-gray-800/40 rounded-xl p-2.5 text-center">
            <div class="text-gray-600 text-[10px]">Token</div>
            <div class="text-white font-bold">${l.token}</div>
          </div>
          <div class="bg-gray-800/40 rounded-xl p-2.5 text-center">
            <div class="text-gray-600 text-[10px]">Amount</div>
            <div class="text-white font-bold">${l.amount}</div>
          </div>
          <div class="bg-gray-800/40 rounded-xl p-2.5 text-center">
            <div class="text-gray-600 text-[10px]">Asking Price</div>
            <div class="text-emerald-400 font-bold">$${_otcFmt(l.price)}</div>
          </div>
          <div class="bg-gray-800/40 rounded-xl p-2.5 text-center">
            <div class="text-gray-600 text-[10px]">TGE Date</div>
            <div class="text-white font-bold">${_otcDisplayDate(l.tgeDate)}</div>
          </div>
        </div>
        <div class="flex items-center gap-2 flex-wrap">
          ${!isOwn && l.status === 'OPEN' ? `
          <button onclick="otcEnterDeal('${l.id}')"
            class="flex items-center gap-2 px-5 py-2 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white rounded-xl text-sm font-bold transition shadow-md">
            <i class="fas fa-handshake"></i>Enter Deal
          </button>` : ''}
          ${canCancel ? `
          <button onclick="otcCancelListing('${l.id}')"
            title="Cancel this listing — only available to you as the creator"
            class="flex items-center gap-1.5 px-4 py-2 bg-red-900/30 hover:bg-red-800/50 active:bg-red-900/60 border border-red-700/50 hover:border-red-600/70 text-red-400 hover:text-red-300 rounded-xl text-xs font-semibold transition-all">
            <i class="fas fa-trash-alt text-[11px]"></i>Cancel Listing
          </button>` : ''}
          ${isBlocked ? `
          <span class="inline-flex items-center gap-1.5 px-3 py-2 bg-yellow-900/20 border border-yellow-700/30 text-yellow-500 rounded-xl text-xs">
            <i class="fas fa-lock text-[10px]"></i>In-progress — cannot cancel
          </span>` : ''}
          ${isOwn ? `<span class="text-xs text-gray-500 italic">${l.interestedBuyers.length} interested buyer(s)</span>` : ''}
          <span class="text-xs text-gray-600 ml-auto">${_otcDisplayCreated(l.createdAt)}</span>
        </div>
      </div>`;
    }).join('');
  }

  // ── Cancelled listings (shown as history, owner-only) ──────────────────────
  if (cancelled.length) {
    html += `
      <div class="mt-6">
        <div class="flex items-center gap-2 mb-3">
          <i class="fas fa-history text-gray-600 text-xs"></i>
          <span class="text-xs text-gray-600 font-semibold uppercase tracking-wide">Your Cancelled Listings</span>
        </div>
        <div class="flex flex-col gap-2">
          ${cancelled.map(l => `
          <div class="bg-gray-900/40 border border-red-900/20 rounded-xl p-4 opacity-60 hover:opacity-80 transition-opacity">
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2 min-w-0">
                <i class="fas fa-times-circle text-red-500 text-xs flex-shrink-0"></i>
                <span class="text-gray-400 text-xs truncate">${l.description}</span>
              </div>
              <div class="flex items-center gap-2 flex-shrink-0">
                <span class="text-[10px] text-gray-600">${l.amount} ${l.token} · $${_otcFmt(l.price)}</span>
                <span class="text-[10px] px-2 py-0.5 rounded-full bg-red-900/30 border border-red-700/30 text-red-400 font-semibold">CANCELLED</span>
                <span class="text-[10px] text-gray-700">${_otcDisplayCreated(l.cancelledAt || l.updatedAt)}</span>
              </div>
            </div>
          </div>`).join('')}
        </div>
      </div>`;
  }

  container.innerHTML = html;
}

// ─── Form helpers ─────────────────────────────────────────────────────────────
function _otcShowFormError(msg) {
  const el = _otcEl('otc-form-error');
  if (!el) return;
  const span = el.querySelector('span');
  if (span) span.textContent = msg; else el.textContent = msg;
  el.classList.remove('hidden');
}
function _otcHideFormError() {
  const el = _otcEl('otc-form-error');
  if (el) el.classList.add('hidden');
}
function _otcResetForm() {
  ['otc-buyer','otc-seller','otc-amount','otc-tge-date','otc-tge-time','otc-description'].forEach(id => {
    const e = _otcEl(id); if (e) e.value = '';
  });
  _otcHideFormError();
}
function _otcResetMktForm() {
  ['mkt-description','mkt-amount','mkt-price','mkt-tge-date'].forEach(id => {
    const e = _otcEl(id); if (e) e.value = '';
  });
}

// ─── Duration formatter ───────────────────────────────────────────────────────
function _otcFormatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return d + 'd ' + (h % 24) + 'h';
  if (h > 0) return h + 'h ' + (m % 60) + 'm';
  if (m > 0) return m + 'm';
  return s + 's';
}

// ─── Alerts for pending actions ───────────────────────────────────────────────
function _otcCheckAlerts() {
  const wallet = window.walletState?.address?.toLowerCase();
  if (!wallet) return;
  let alerts = 0;
  _otcContracts.forEach(c => {
    if (c.status === OTC_STATUS.CANCELLED || c.status === OTC_STATUS.COMPLETED) return;
    const isBuyer  = c.buyer.toLowerCase() === wallet;
    const isSeller = c.seller.toLowerCase() === wallet;
    if (!isBuyer && !isSeller) return;
    if ((isBuyer && !c.buyerSig) || (isSeller && !c.sellerSig)) alerts++;
    if (c.status === OTC_STATUS.AWAITING_PAYMENT && isBuyer) alerts++;
  });
  // Update badge
  const badge = _otcEl('otc-alert-badge');
  if (badge) {
    if (alerts > 0) { badge.textContent = alerts; badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
function _otcInit() {
  otcLoad();

  // Auto-fill timezone
  const tzEl = _otcEl('otc-tge-tz');
  if (tzEl) tzEl.value = 'UTC';

  // Watch wallet for auto-fill
  let lastWallet = null;
  setInterval(() => {
    const w = window.walletState?.address;
    if (w !== lastWallet) {
      lastWallet = w;
      if (_otcSubTab === 'create') _otcAutoFillWallet();
      _otcCheckAlerts();
    }
  }, 2000);

  // Periodic alert check
  setInterval(_otcCheckAlerts, 10000);
  _otcCheckAlerts();

  // Expose globals
  window.otcSwitchSub      = otcSwitchSub;
  window.otcCreateDeal     = otcCreateDeal;
  window.otcSignContract   = otcSignContract;
  window.otcConfirmSchedule= otcConfirmSchedule;
  window.otcSubmitTxProof  = otcSubmitTxProof;
  window.otcCancelContract = otcCancelContract;
  window.otcDownloadReceipt= otcDownloadReceipt;
  window.otcCreateListing  = otcCreateListing;
  window.otcEnterDeal      = otcEnterDeal;
  window.otcCancelListing  = otcCancelListing;
  window.otcRenderMyContracts = otcRenderMyContracts;
  window.otcRenderMarketplace = otcRenderMarketplace;
  // On-chain escrow actions
  window.otcRegisterOnChain    = otcRegisterOnChain;
  window.otcSignDealOnChain    = otcSignDealOnChain;
  window.otcFundDeal           = otcFundDeal;
  window.otcReleaseDeal        = otcReleaseDeal;
  window.otcRequestCancelOnChain = otcRequestCancelOnChain;
  window.otcSyncDealStatus     = otcSyncDealStatus;

  _otcLog(`Loaded | v${OTC_VERSION} | Chain ${OTC_CHAIN_ID}`);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _otcInit);
} else {
  _otcInit();
}
