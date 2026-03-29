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

const OTC_VERSION    = '20260329a';
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
};

const OTC_STATUS_LABEL = {
  PENDING_SCHEDULE: { label: 'Pending Schedule', color: 'text-yellow-400', bg: 'bg-yellow-900/30 border-yellow-700/40', icon: 'fa-clock' },
  SCHEDULED:        { label: 'Scheduled',        color: 'text-blue-400',   bg: 'bg-blue-900/30 border-blue-700/40',   icon: 'fa-calendar-check' },
  SIGNED:           { label: 'Signed',           color: 'text-purple-400', bg: 'bg-purple-900/30 border-purple-700/40', icon: 'fa-signature' },
  LOCKED:           { label: 'Locked',           color: 'text-orange-400', bg: 'bg-orange-900/30 border-orange-700/40', icon: 'fa-lock' },
  EXECUTABLE:       { label: 'Executable',       color: 'text-green-400',  bg: 'bg-green-900/30 border-green-700/40',  icon: 'fa-play-circle' },
  AWAITING_PAYMENT: { label: 'Awaiting Payment', color: 'text-cyan-400',   bg: 'bg-cyan-900/30 border-cyan-700/40',   icon: 'fa-hourglass-half' },
  VERIFYING:        { label: 'Verifying',        color: 'text-indigo-400', bg: 'bg-indigo-900/30 border-indigo-700/40', icon: 'fa-search' },
  COMPLETED:        { label: 'Completed',        color: 'text-emerald-400',bg: 'bg-emerald-900/30 border-emerald-700/40','icon': 'fa-check-double' },
  CANCELLED:        { label: 'Cancelled',        color: 'text-red-400',    bg: 'bg-red-900/30 border-red-700/40',    icon: 'fa-times-circle' },
  DISPUTED:         { label: 'Disputed',         color: 'text-rose-400',   bg: 'bg-rose-900/30 border-rose-700/40',   icon: 'fa-exclamation-triangle' },
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
  const tgeDate    = _otcVal('otc-tge-date');
  const tgeTime    = _otcVal('otc-tge-time');
  const tgeTz      = _otcVal('otc-tge-tz') || Intl.DateTimeFormat().resolvedOptions().timeZone;
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
    const contractId = _otcId();
    const tgeDatetime = `${tgeDate}T${tgeTime}:00`;

    const contractData = { contractId, buyer, seller, asset, amount, tgeDate, tgeTime, tgeTz, tgeDatetime, description };
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
    };

    _otcContracts.unshift(contract);
    otcSave();

    // Push to global history
    _otcPushHistory(contract, 'Created');

    _otcToast(`✅ OTC Contract created! ID: ${contractId}`, 'success');
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
      `TGE: ${contract.tgeDate} ${contract.tgeTime} (${contract.tgeTz})`,
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

  if (date !== contract.tgeDate || time !== contract.tgeTime) {
    _otcToast('❌ Schedule mismatch between parties. Both must agree on same date and time.', 'error');
    const errEl = _otcEl(`otc-sched-err-${contractId}`);
    if (errEl) { errEl.textContent = 'Mismatch: buyer set ' + contract.tgeDate + ' ' + contract.tgeTime + ', you entered ' + date + ' ' + time; errEl.classList.remove('hidden'); }
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

// ─── Status updater ───────────────────────────────────────────────────────────
function _otcUpdateStatus(contract) {
  const hasBuyerSig    = !!contract.buyerSig;
  const hasSellerSig   = !!contract.sellerSig;
  const scheduleMatch  = contract.sellerScheduleConfirmed;
  const bothSigned     = hasBuyerSig && hasSellerSig;

  if (contract.status === OTC_STATUS.COMPLETED || contract.status === OTC_STATUS.CANCELLED) return;

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
    const tgeMs = new Date(contract.tgeDatetime).getTime();
    if (Date.now() >= tgeMs) {
      contract.status = OTC_STATUS.AWAITING_PAYMENT;
    }
  }
}

// ─── Cancel Contract ──────────────────────────────────────────────────────────
function otcCancelContract(contractId) {
  const contract = _otcContracts.find(c => c.contractId === contractId);
  if (!contract) return;
  if ([OTC_STATUS.SIGNED, OTC_STATUS.EXECUTABLE, OTC_STATUS.COMPLETED].includes(contract.status)) {
    return _otcToast('Cannot cancel a signed or completed contract', 'warning');
  }
  if (!confirm(`Cancel contract ${contractId}? This cannot be undone.`)) return;
  contract.status = OTC_STATUS.CANCELLED;
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
    tge:         `${contract.tgeDate} ${contract.tgeTime} (${contract.tgeTz})`,
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
    add('Created At:',    receipt.createdAt);
    add('Completed At:',  receipt.completedAt);
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

  const listing = {
    id:          'LST-' + Date.now().toString(36).toUpperCase(),
    seller:      wallet,
    description,
    token,
    amount,
    price,
    tgeDate,
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
    if (dateEl)   dateEl.value   = listing.tgeDate;
    if (descEl)   descEl.value   = `OTC Deal from marketplace listing ${listingId}: ${listing.description}`;

    listing.status = 'NEGOTIATING';
    listing.interestedBuyers.push({ buyer, at: _otcNow() });
    otcSave();
    otcRenderMarketplace();

    _otcToast('Deal form pre-filled from listing. Review and create contract.', 'info');
  }, 200);
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
  const st       = OTC_STATUS_LABEL[c.status] || OTC_STATUS_LABEL.PENDING_SCHEDULE;
  const isBuyer  = wallet && c.buyer.toLowerCase() === wallet;
  const isSeller = wallet && c.seller.toLowerCase() === wallet;
  const canSign  = (isBuyer && !c.buyerSig) || (isSeller && !c.sellerSig);
  const canCancel= [OTC_STATUS.PENDING_SCHEDULE, OTC_STATUS.SCHEDULED].includes(c.status);
  const canProof = isBuyer && c.status === OTC_STATUS.AWAITING_PAYMENT;
  const tgeTs    = new Date(c.tgeDatetime).getTime();
  const tgeIn    = tgeTs - Date.now();
  const tgeLabel = tgeIn > 0
    ? `in ${_otcFormatDuration(tgeIn)}`
    : `${_otcFormatDuration(-tgeIn)} ago`;

  // Timeline steps
  const steps = [
    { label: 'Created',   done: true,                          active: false },
    { label: 'Scheduled', done: c.sellerScheduleConfirmed,     active: !c.sellerScheduleConfirmed },
    { label: 'Signed',    done: !!c.buyerSig && !!c.sellerSig, active: (!!c.buyerSig || !!c.sellerSig) && !(!!c.buyerSig && !!c.sellerSig) },
    { label: 'Paid',      done: !!c.verifiedAt,                active: c.status === OTC_STATUS.AWAITING_PAYMENT },
    { label: 'Done',      done: c.status === OTC_STATUS.COMPLETED, active: c.status === OTC_STATUS.VERIFYING },
  ];

  return `
  <div class="bg-gray-900/70 border border-gray-700/50 rounded-2xl overflow-hidden hover:border-indigo-700/40 transition-all mb-4">
    <!-- Header -->
    <div class="flex items-center justify-between px-5 py-4 border-b border-gray-800/60">
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-xl bg-indigo-900/40 border border-indigo-700/30 flex items-center justify-center">
          <i class="fas fa-handshake text-indigo-400 text-sm"></i>
        </div>
        <div>
          <div class="text-white font-bold text-sm font-mono">${c.contractId}</div>
          <div class="text-gray-500 text-xs">${new Date(c.createdAt).toLocaleDateString()} · ${c.asset} · $${_otcFmt(c.amount)}</div>
        </div>
      </div>
      <span class="inline-flex items-center gap-1.5 text-xs px-3 py-1 rounded-full border ${st.bg} ${st.color} font-semibold">
        <i class="fas ${st.icon} text-[10px]"></i>${st.label}
      </span>
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
        ['TGE',    c.tgeDate + ' ' + c.tgeTime],
        ['TGE In', tgeLabel],
      ].map(([lbl,val]) => `
        <div class="px-4 py-3 border-r border-gray-800/40 last:border-0">
          <div class="text-gray-600 text-[10px]">${lbl}</div>
          <div class="text-gray-300 font-mono mt-0.5">${val}</div>
        </div>
      `).join('')}
    </div>

    <!-- Signature status -->
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
    </div>

    <!-- Seller schedule confirm (if not confirmed) -->
    ${isSeller && !c.sellerScheduleConfirmed && c.status !== OTC_STATUS.CANCELLED ? `
    <div class="px-5 py-3 bg-yellow-950/20 border-b border-yellow-800/20">
      <p class="text-yellow-400 text-xs font-semibold mb-2"><i class="fas fa-exclamation-triangle mr-1"></i>Confirm schedule to match buyer</p>
      <p class="text-gray-500 text-xs mb-2">Buyer set: <span class="text-white font-mono">${c.tgeDate} ${c.tgeTime} (${c.tgeTz})</span></p>
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

    <!-- TX Proof (buyer) -->
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

    <!-- TX Proof verified -->
    ${c.txProof && c.status === OTC_STATUS.COMPLETED ? `
    <div class="px-5 py-2 bg-emerald-950/20 border-b border-emerald-800/20 flex items-center gap-2 text-xs">
      <i class="fas fa-check-double text-emerald-400"></i>
      <span class="text-emerald-400 font-semibold">Payment verified on-chain</span>
      <a href="${OTC_EXPLORER}/tx/${c.txProof.txHash}" target="_blank"
        class="text-emerald-300 font-mono underline ml-2">${_otcShort(c.txProof.txHash)}</a>
    </div>` : ''}

    <!-- Actions -->
    <div class="flex items-center gap-2 px-5 py-3 flex-wrap">
      ${canSign ? `
      <button onclick="otcSignContract('${c.contractId}')"
        class="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-semibold transition">
        <i class="fas fa-signature"></i>Sign Contract
      </button>` : ''}
      <button onclick="otcDownloadReceipt('${c.contractId}')"
        class="flex items-center gap-1.5 px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-400 hover:text-white rounded-xl text-xs transition">
        <i class="fas fa-download"></i>Receipt
      </button>
      ${canCancel ? `
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

  const open = _otcListings.filter(l => l.status !== 'CLOSED');

  if (!open.length) {
    container.innerHTML = `
      <div class="flex flex-col items-center gap-3 py-12 text-center text-gray-600">
        <i class="fas fa-store text-3xl"></i>
        <p class="text-gray-500 text-sm">No active listings yet.</p>
        <p class="text-gray-600 text-xs">Be the first to list a deal!</p>
      </div>`;
    return;
  }

  container.innerHTML = open.map(l => {
    const wallet = window.walletState?.address?.toLowerCase();
    const isOwn  = wallet && l.seller.toLowerCase() === wallet;
    const statusColors = { OPEN: 'text-green-400 bg-green-900/30 border-green-700/40', NEGOTIATING: 'text-yellow-400 bg-yellow-900/30 border-yellow-700/40', CLOSED: 'text-gray-500 bg-gray-800/40 border-gray-700/40' };
    return `
    <div class="bg-gray-900/70 border border-gray-700/50 rounded-2xl p-5 hover:border-indigo-700/40 transition-all">
      <div class="flex items-start justify-between gap-3 mb-3">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-700/30 to-purple-700/30 border border-indigo-700/30 flex items-center justify-center flex-shrink-0">
            <i class="fas fa-tags text-indigo-400 text-base"></i>
          </div>
          <div>
            <div class="text-white font-semibold text-sm">${l.description}</div>
            <div class="text-gray-500 text-xs font-mono">${_otcShort(l.seller)}${isOwn ? ' <span class="text-indigo-400">(you)</span>' : ''}</div>
          </div>
        </div>
        <span class="inline-flex items-center gap-1 text-[10px] px-2.5 py-1 rounded-full border font-semibold ${statusColors[l.status]}">${l.status}</span>
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
          <div class="text-white font-bold">${l.tgeDate}</div>
        </div>
      </div>
      <div class="flex items-center gap-2">
        ${!isOwn && l.status === 'OPEN' ? `
        <button onclick="otcEnterDeal('${l.id}')"
          class="flex items-center gap-2 px-5 py-2 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white rounded-xl text-sm font-bold transition shadow-md">
          <i class="fas fa-handshake"></i>Enter Deal
        </button>` : ''}
        ${isOwn ? `<span class="text-xs text-gray-500 italic">${l.interestedBuyers.length} interested buyer(s)</span>` : ''}
        <span class="text-xs text-gray-600 ml-auto">${new Date(l.createdAt).toLocaleDateString()}</span>
      </div>
    </div>`;
  }).join('');
}

// ─── Form helpers ─────────────────────────────────────────────────────────────
function _otcShowFormError(msg) {
  const el = _otcEl('otc-form-error');
  if (el) { el.textContent = msg; el.classList.remove('hidden'); }
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
  if (tzEl && !tzEl.value) {
    tzEl.value = Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

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
  window.otcRenderMyContracts = otcRenderMyContracts;
  window.otcRenderMarketplace = otcRenderMarketplace;

  _otcLog(`Loaded | v${OTC_VERSION} | Chain ${OTC_CHAIN_ID}`);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _otcInit);
} else {
  _otcInit();
}
