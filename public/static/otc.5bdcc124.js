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

// ─── Guard: ensure otc-escrow-abi.js loaded correctly ────────────────────────
// otc-escrow-abi.js (loaded BEFORE this script) must export:
//   window.OTC_ESCROW_ADDRESS  — the deployed contract address (string)
//   window.otcIsDeployed       — function(): boolean
//   window.otcRequireDeployed  — function(): void (throws if not configured)
//
// If those exports are absent (stale browser cache, CDN error, wrong load
// order) we inject safe no-op fallbacks so the page never hard-crashes.
// On-chain features will be disabled; the user will see UI warnings instead
// of uncaught ReferenceErrors.
(function _otcEnsureGlobals() {
  var ZERO = '0x0000000000000000000000000000000000000000';
  var ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

  // ── OTC_ESCROW_ADDRESS ────────────────────────────────────────────────────
  if (typeof window.OTC_ESCROW_ADDRESS !== 'string' || !ADDR_RE.test(window.OTC_ESCROW_ADDRESS)) {
    window.OTC_ESCROW_ADDRESS = ZERO;
    console.error(
      '[OTC] otc-escrow-abi.js did not export a valid OTC_ESCROW_ADDRESS. ' +
      'Check script load order and browser cache. On-chain features disabled.'
    );
  }

  // ── otcIsDeployed ─────────────────────────────────────────────────────────
  // This MUST be a function — never a cached boolean — so it always reads the
  // current address value rather than a stale snapshot.
  if (typeof window.otcIsDeployed !== 'function') {
    window.otcIsDeployed = function() {
      var a = window.OTC_ESCROW_ADDRESS;
      return typeof a === 'string' && ADDR_RE.test(a) && a.toLowerCase() !== ZERO;
    };
    console.warn('[OTC] otcIsDeployed fallback injected (otc-escrow-abi.js may not have loaded).');
  }

  // ── otcRequireDeployed ────────────────────────────────────────────────────
  if (typeof window.otcRequireDeployed !== 'function') {
    window.otcRequireDeployed = function() {
      if (!window.otcIsDeployed()) {
        throw new Error('OTC Escrow: contract address not configured or is zero address.');
      }
    };
    console.warn('[OTC] otcRequireDeployed fallback injected (otc-escrow-abi.js may not have loaded).');
  }
}());
// ─────────────────────────────────────────────────────────────────────────────

const OTC_VERSION    = '20260410e';

// ─── Startup check ───────────────────────────────────────────────────────────
(function _otcStartupCheck() {
  // Verify we have the correct address-based API available
  if (typeof window.otcIsDeployed !== 'function') {
    console.error(
      '[OTC] otcIsDeployed() is not defined. ' +
      'otc-escrow-abi.js may not have loaded. ' +
      'Check script load order and browser cache.'
    );
  }
})();

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
  // On-chain escrow statuses (v3)
  ONCHAIN_CREATED:  { label: 'On-Chain (Signing)', color: 'text-violet-400', bg: 'bg-violet-900/30 border-violet-700/40',  icon: 'fa-link' },
  ONCHAIN_SIGNED:   { label: 'On-Chain Signed',   color: 'text-violet-300',  bg: 'bg-violet-900/30 border-violet-600/40',  icon: 'fa-file-signature' },
  FUNDED:           { label: 'Funded (Escrow)',    color: 'text-teal-400',    bg: 'bg-teal-900/30 border-teal-700/40',       icon: 'fa-vault' },
  RELEASED:         { label: 'Released',          color: 'text-emerald-300', bg: 'bg-emerald-900/30 border-emerald-600/40', icon: 'fa-paper-plane' },
  CANCEL_REQUESTED: { label: 'Cancel Requested',  color: 'text-amber-400',   bg: 'bg-amber-900/30 border-amber-700/40',     icon: 'fa-undo' },
  // v4 Status enum labels
  IN_DISPUTE:             { label: 'In Dispute',            color: 'text-rose-400',    bg: 'bg-rose-900/30 border-rose-700/40',       icon: 'fa-gavel' },
  AWAITING_BUYER_DEPOSIT: { label: 'Awaiting Buyer Deposit',color: 'text-cyan-400',    bg: 'bg-cyan-900/30 border-cyan-700/40',       icon: 'fa-coins' },
  AWAITING_SELLER_DEPOSIT:{ label: 'Awaiting Seller Deposit',color: 'text-orange-400', bg: 'bg-orange-900/30 border-orange-700/40',   icon: 'fa-hand-holding-usd' },
  AWAITING_PROOF:         { label: 'Awaiting Proof',        color: 'text-teal-400',    bg: 'bg-teal-900/30 border-teal-700/40',       icon: 'fa-vault' },
  READY_TO_SETTLE:        { label: 'Ready to Settle',       color: 'text-emerald-400', bg: 'bg-emerald-900/30 border-emerald-700/40', icon: 'fa-check-circle' },
};

// ─── State ─────────────────────────────────────────────────────────────────────
let _otcContracts       = [];
let _otcListings        = [];
let _otcSubTab          = 'create'; // 'create' | 'my' | 'market'
let _otcSyncInProgress  = false;    // guard: only one chain-sync at a time

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _otcLog(...a)  { console.log('%c[OTC v4]', 'color:#818cf8;font-weight:bold', ...a); }
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

// ─── On-chain event feed ──────────────────────────────────────────────────────
// In-memory ring buffer for on-chain events emitted during this session.
// Persisted to localStorage (max 50 entries) for the event feed panel.
const OTC_EVENTS_KEY = 'execDaat_otc_events';
let _otcEvents = [];

function _otcLoadEvents() {
  try { _otcEvents = JSON.parse(localStorage.getItem(OTC_EVENTS_KEY) || '[]'); } catch(e) { _otcEvents = []; }
}

/**
 * Record an on-chain event to the local event feed.
 * @param {string} name    - Event name (e.g. 'DealFunded', 'DealReleased')
 * @param {Object} payload - Event details (contractId, txHash, etc.)
 */
function _otcEmitOnChainEvent(name, payload = {}) {
  _otcLoadEvents();
  _otcEvents.unshift({
    name,
    ...payload,
    ts: _otcNow(),
  });
  try {
    localStorage.setItem(OTC_EVENTS_KEY, JSON.stringify(_otcEvents.slice(0, 50)));
  } catch(e) {}
  // Re-render event feed if visible
  _otcRenderEventFeed();
}

/**
 * Render the on-chain event feed into #otc-event-feed element (if present).
 */
function _otcRenderEventFeed() {
  const el = _otcEl('otc-event-feed');
  if (!el) return;
  _otcLoadEvents();

  // Show panel when there are events
  const panel = _otcEl('otc-events-panel');
  if (panel && _otcEvents.length) panel.classList.remove('hidden');

  if (!_otcEvents.length) {
    el.innerHTML = `<p class="text-gray-600 text-xs text-center py-4">No on-chain events yet for this session.</p>`;
    return;
  }

  const icons = {
    DealCreated:   { icon: 'fa-plus-circle',   color: 'text-indigo-400' },
    DealSigned:    { icon: 'fa-pen',            color: 'text-violet-400' },
    DealFunded:    { icon: 'fa-vault',          color: 'text-teal-400'   },
    DealReleased:  { icon: 'fa-paper-plane',    color: 'text-emerald-400'},
    DealCancelled: { icon: 'fa-times-circle',   color: 'text-red-400'    },
    CancelRequested: { icon: 'fa-ban',          color: 'text-orange-400' },
    DisputeOpened:   { icon: 'fa-gavel',        color: 'text-rose-400'   },
    DisputeRaised:   { icon: 'fa-gavel',        color: 'text-orange-400' },
    DisputeResolved: { icon: 'fa-balance-scale',color: 'text-yellow-400' },
    ProofSubmitted:  { icon: 'fa-file-check',   color: 'text-blue-400'   },
    SellerDeposited: { icon: 'fa-hand-holding-usd', color: 'text-orange-300'},
  };

  el.innerHTML = _otcEvents.slice(0, 20).map(ev => {
    const ic = icons[ev.name] || { icon: 'fa-circle', color: 'text-gray-400' };
    const link = ev.txHash
      ? `<a href="${OTC_EXPLORER}/tx/${ev.txHash}" target="_blank" class="text-indigo-400 hover:text-indigo-300 underline text-[10px]">View TX ↗</a>`
      : '';
    return `
    <div class="flex items-start gap-2.5 py-2 border-b border-gray-800/60 last:border-0">
      <i class="fas ${ic.icon} ${ic.color} text-xs mt-0.5 w-3 flex-shrink-0"></i>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-white text-xs font-semibold">${ev.name}</span>
          ${link}
        </div>
        ${ev.contractId ? `<div class="text-gray-600 text-[10px] font-mono truncate">${ev.contractId}</div>` : ''}
        ${ev.amount ? `<div class="text-gray-500 text-[10px]">${ev.amount} ${ev.asset || ''}</div>` : ''}
      </div>
      <span class="text-gray-700 text-[10px] flex-shrink-0">${new Date(ev.ts).toLocaleTimeString()}</span>
    </div>`;
  }).join('');
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

// ─── Storage (dual-write: primary + backup key) ───────────────────────────────
const OTC_BACKUP_KEY = 'execDaat_otc_contracts_bk'; // secondary backup key

function otcSave() {
  try {
    const data    = JSON.stringify(_otcContracts);
    const mktData = JSON.stringify(_otcListings);
    // Primary write (synchronous — never skip)
    localStorage.setItem(OTC_STORE_KEY,  data);
    localStorage.setItem(OTC_MKT_KEY,    mktData);
    // Backup write with timestamp (guards against partial writes / data loss)
    localStorage.setItem(OTC_BACKUP_KEY, JSON.stringify({
      ts:   Date.now(),
      data: _otcContracts,
    }));
    // Also write to IndexedDB (async, non-blocking) if PERSIST module is ready
    if (typeof window.arcSaveOTC === 'function') {
      window.arcSaveOTC(_otcContracts).catch(e =>
        console.warn('[OTC] arcSaveOTC failed (non-critical):', e.message)
      );
    }
  } catch(e) {
    console.error('[OTC SAVE ERROR]', e.stack || e.message);
    _otcLog('Save error', e);
  }
}

function otcLoad() {
  try {
    const raw = localStorage.getItem(OTC_STORE_KEY);
    const mkt = localStorage.getItem(OTC_MKT_KEY);

    let contracts = null;
    try { contracts = raw ? JSON.parse(raw) : null; } catch(_) {}

    // If primary is empty/corrupt, try backup
    if (!contracts || !Array.isArray(contracts) || contracts.length === 0) {
      try {
        const bkRaw = localStorage.getItem(OTC_BACKUP_KEY);
        if (bkRaw) {
          const bk = JSON.parse(bkRaw);
          if (bk && Array.isArray(bk.data) && bk.data.length > 0) {
            contracts = bk.data;
            _otcLog('[LOAD] Restored', contracts.length, 'contracts from backup key');
            // Restore primary from backup
            localStorage.setItem(OTC_STORE_KEY, JSON.stringify(contracts));
          }
        }
      } catch(_) {}
    }

    _otcContracts = Array.isArray(contracts) ? contracts : [];
    _otcListings  = mkt ? (JSON.parse(mkt) || []) : [];
    _otcLog('[LOAD]', _otcContracts.length, 'contracts,', _otcListings.length, 'listings');

    // Async: also try to merge from IndexedDB (may have more recent data)
    if (typeof window.arcLoadOTC === 'function' && window.arcPersist?.db) {
      window.arcLoadOTC().then(idbContracts => {
        if (!idbContracts || !idbContracts.length) return;
        // Merge: IndexedDB records override localStorage if they are more recent
        let changed = false;
        for (const idbC of idbContracts) {
          const idx = _otcContracts.findIndex(c => c.contractId === idbC.contractId);
          if (idx < 0) {
            // New record not in localStorage — add it
            _otcContracts.push(idbC);
            changed = true;
          } else {
            // Compare updatedAt — keep the newer copy
            const lsTs  = new Date(_otcContracts[idx].updatedAt || 0).getTime();
            const idbTs = new Date(idbC.updatedAt || 0).getTime();
            if (idbTs > lsTs) {
              _otcContracts[idx] = idbC;
              changed = true;
            }
          }
        }
        if (changed) {
          // Re-sort by createdAt descending
          _otcContracts.sort((a, b) =>
            new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
          // Sync back to localStorage
          localStorage.setItem(OTC_STORE_KEY, JSON.stringify(_otcContracts));
          localStorage.setItem(OTC_BACKUP_KEY, JSON.stringify({ ts: Date.now(), data: _otcContracts }));
          _otcLog('[LOAD] Merged', idbContracts.length, 'IDB records; total now:', _otcContracts.length);
          otcRenderMyContracts();
        }
      }).catch(e => console.warn('[OTC] arcLoadOTC merge failed:', e.message));
    }
  } catch(e) {
    console.error('[OTC LOAD ERROR]', e.stack || e.message);
    // NEVER reset to [] — preserve whatever is in memory
    if (!Array.isArray(_otcContracts)) _otcContracts = [];
    if (!Array.isArray(_otcListings))  _otcListings  = [];
  }
}

// ─── Create OTC Deal ──────────────────────────────────────────────────────────
async function otcCreateDeal() {
  _otcLog('[TRACE] Entering otcCreateDeal()');
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
    otcSave(); // ← PERSIST IMMEDIATELY before any async operation

    // Push to global history
    _otcPushHistory(contract, 'Created');

    // ── Try on-chain createDeal if escrow is configured & wallet connected ───────
    if (otcIsDeployed() && window.walletState?.connected) {
      _otcToast('⏳ Registering deal on-chain — confirm in wallet…', 'info');
      try {
        // BLOCKING: await full tx.wait() before switching tabs.
        // Eliminates "On-chain registration failed. Deal saved locally." warning.
        await _otcCreateDealOnChain(contractId);
        // Success toast + render already called inside _otcCreateDealOnChain
      } catch(e) {
        console.error('[OTC ERROR LOCATION] _otcCreateDealOnChain threw:', e.stack || e.message);
        _otcLog('On-chain createDeal failed (deal is saved locally):', e.message);
        const saved = _otcContracts.find(c => c.contractId === contractId);
        if (saved) { saved.onChain = false; saved.updatedAt = _otcNow(); otcSave(); }
        if (e.code === 4001 || e.message?.includes('rejected')) {
          _otcToast('⚠️ Transaction rejected. Deal saved locally only.', 'warning');
        } else {
          _otcToast(`⚠️ On-chain registration failed: ${e.message}. Deal saved locally.`, 'warning');
        }
      }
    } else {
      const chainNote = !otcIsDeployed()
        ? ' (Escrow contract not configured — local mode only)'
        : ' (Connect wallet to register on-chain)';
      _otcToast(`✅ OTC Contract created! ID: ${contractId}${chainNote}`, 'success');
    }

    _otcLog('Contract created:', contract);

    // Reset form
    _otcResetForm();

    // Switch to My Contracts tab — skip sync since we just finished the on-chain tx
    _otcSubTab = 'my';
    ['create','my','market'].forEach(s => {
      const btn = _otcEl(`otc-sub-${s}`);
      const panel = _otcEl(`otc-panel-${s}`);
      if (btn) btn.className = s === 'my'
        ? 'otc-sub-btn px-5 py-2.5 rounded-xl text-sm font-semibold transition-all bg-indigo-600 text-white shadow-md'
        : 'otc-sub-btn px-5 py-2.5 rounded-xl text-sm font-medium transition-all text-gray-400 hover:text-white hover:bg-gray-800/60';
      if (panel) panel.classList.toggle('hidden', s !== 'my');
    });
    otcRenderMyContracts();

  } catch(e) {
    console.error('[OTC ERROR LOCATION] otcCreateDeal threw:', e.stack || e.message);
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
    console.error('[OTC ERROR LOCATION] otcSubmitTxProof threw:', e.stack || e.message);
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
  _otcLog('[TRACE] Entering otcRegisterOnChain()', contractId);
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

  if (!otcIsDeployed()) {
    return _otcToast('Escrow contract not configured. Set OTC_ESCROW_ADDRESS in otc-escrow-abi.js', 'warning');
  }

  try {
    // Pass contractId so _otcCreateDealOnChain fetches the canonical copy
    await _otcCreateDealOnChain(contractId);
  } catch(e) {
    console.error('[OTC ERROR LOCATION] otcRegisterOnChain threw:', e.stack || e.message);
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

  // ── Network validation: enforce ARC Testnet ──────────────────────────────
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  if (chainId !== OTC_CHAIN_ID) {
    throw new Error(
      `Wrong network: connected to chain ${chainId}, but OTC requires ARC Testnet (chain ${OTC_CHAIN_ID}). ` +
      `Please switch your wallet to ARC Testnet.`
    );
  }
  // ─────────────────────────────────────────────────────────────────────────

  return provider.getSigner();
}

// ─── 1. Register deal on-chain (createDeal) ────────────────────────────────
// Accepts contractId (string) — always looks up the canonical copy from
// _otcContracts so there is never a stale reference issue.
async function _otcCreateDealOnChain(contractId) {
  _otcLog('[TRACE] Entering _otcCreateDealOnChain()', contractId);

  // Always work with the canonical copy from the in-memory list
  const contract = _otcContracts.find(c => c.contractId === contractId);
  if (!contract) throw new Error(`Contract not found in local store: ${contractId}`);

  const signer = await _otcGetSigner();

  // Use strict variant — throws if address is missing/invalid
  const escrow = getOTCEscrowContract(signer);

  const tokenAddr = otcResolveToken(contract.asset);
  if (!tokenAddr) throw new Error(`Cannot resolve token address for: ${contract.asset}`);

  const provider  = signer.provider;
  const amountRaw = await otcParseTokenAmount(contract.amount, tokenAddr, provider);
  const tgeTs     = Math.floor(new Date(contract.timestamp_utc).getTime() / 1000);
  const hashBytes = contract.contractHash.padEnd(66, '0').slice(0, 66); // bytes32

  _otcLog(`createDeal on-chain: seller=${contract.seller} token=${tokenAddr} amount=${amountRaw} tge=${tgeTs}`);

  _otcToast('⏳ Confirm createDeal in wallet…', 'info');
  const tx = await escrow.createDeal(
    contract.seller,
    tokenAddr,
    amountRaw,
    tgeTs,
    hashBytes
  );

  _otcToast('⏳ createDeal tx sent — waiting for confirmation…', 'info');
  _otcLog('createDeal tx hash:', tx.hash);

  // Persist tx hash immediately so a page refresh won't lose the pending tx
  contract.escrowTxHash = tx.hash;
  contract.updatedAt    = _otcNow();
  otcSave();

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

  // Update canonical copy in _otcContracts (re-fetch in case list was mutated)
  const saved = _otcContracts.find(c => c.contractId === contractId);
  if (!saved) throw new Error(`Contract disappeared from store after tx: ${contractId}`);

  saved.onChain      = true;
  saved.escrowDealId = dealId;
  saved.escrowTxHash = receipt.hash;
  saved.status       = OTC_STATUS.ONCHAIN_CREATED;
  saved.updatedAt    = _otcNow();
  otcSave(); // ← persist on-chain state
  _otcPushHistory(saved, `On-chain deal created (dealId: ${dealId.slice(0,10)}…)`);

  const explorerUrl = `${OTC_EXPLORER}/tx/${receipt.hash}`;
  _otcToast(`✅ Deal registered on-chain! <a href="${explorerUrl}" target="_blank" class="underline">View TX ↗</a>`, 'success');
  otcRenderMyContracts();
  return dealId;
}

// ─── 2. Sign deal on-chain (signDeal) ─────────────────────────────────────
async function otcSignDealOnChain(contractId) {
  _otcLog('[TRACE] Entering otcSignDealOnChain()', contractId);
  if (!window.ethereum || !window.walletState?.connected) {
    _otcToast('Connect your wallet to sign on-chain', 'warning');
    if (typeof openWalletModal === 'function') openWalletModal();
    return;
  }
  try { otcRequireDeployed(); } catch(e) { return _otcToast(e.message, 'warning'); }

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
    console.error('[OTC ERROR LOCATION] otcSignDealOnChain threw:', e.stack || e.message);
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
// error to a human-readable description. Works for v1, v2 and v3 contracts.
const _OTC_CUSTOM_ERRORS = {
  // selector: keccak256("ErrorName()").slice(0,10)  — verified on ARC Testnet
  // ── v1 / v2 / v3 shared ────────────────────────────────────────────────────
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
  // ── v3 new errors ─────────────────────────────────────────────────────────
  '0x5ec82351': 'NotSeller — only the seller (or authorized address) can release funds',
  '0xea8e4eb5': 'NotAuthorized — only the seller or an authorized address can release',
  '0x667f86ef': 'NotArbitrator — only the arbitrator can resolve disputes',
  '0x912a47b7': 'DealDisputed — this deal is under active dispute; wait for arbitration',
  '0x93754748': 'NoDispute — no active dispute found for this deal',
  '0x1a15a3cc': 'PermitExpired — the EIP-2612 permit signature has expired',
  '0xa4654144': 'InvalidPermitSignature — the permit signature is invalid',
  '0x756688fe': 'InvalidNonce — invalid nonce for permit; please re-sign',
  '0xbaf3f0f7': 'InvalidState — deal is in an unexpected state for this action',
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
  _otcLog('[TRACE] Entering otcFundDeal()', contractId);
  if (!window.ethereum || !window.walletState?.connected) {
    _otcToast('Connect your wallet to fund', 'warning');
    if (typeof openWalletModal === 'function') openWalletModal();
    return;
  }
  try { otcRequireDeployed(); } catch(e) { return _otcToast(e.message, 'warning'); }

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
    _otcEmitOnChainEvent('DealFunded', { contractId, txHash: receipt.hash, amount: contract.amount, asset: contract.asset });

    const explorerUrl = `${OTC_EXPLORER}/tx/${receipt.hash}`;
    _otcToast(
      `✅ Escrow funded! ${contract.amount} ${contract.asset} locked. ` +
      `<a href="${explorerUrl}" target="_blank" class="underline">View TX ↗</a>`,
      'success'
    );
    otcRenderMyContracts();

  } catch(e) {
    console.error('[OTC ERROR LOCATION] otcFundDeal threw:', e.stack || e.message);
    const decoded = _otcDecodeError(e);
    _otcToast(
      decoded.userRejected ? 'Transaction rejected' : `❌ Fund error: ${decoded.msg}`,
      decoded.userRejected ? 'warning' : 'error'
    );
    _otcLog('fundDeal error:', e);
  }
}

// ─── 4. Release funds on-chain (release) ──────────────────────────────────
// v3: RESTRICTED to seller or authorized address only.
// The buyer will get NotAuthorized if they try to call release().
async function otcReleaseDeal(contractId) {
  _otcLog('[TRACE] Entering otcReleaseDeal()', contractId);
  if (!window.ethereum || !window.walletState?.connected) {
    _otcToast('Connect your wallet to release', 'warning');
    if (typeof openWalletModal === 'function') openWalletModal();
    return;
  }
  try { otcRequireDeployed(); } catch(e) { return _otcToast(e.message, 'warning'); }

  const contract = _otcContracts.find(c => c.contractId === contractId);
  if (!contract) return _otcToast('Contract not found', 'error');

  if (contract.status !== OTC_STATUS.FUNDED) {
    return _otcToast('Deal must be funded before release', 'warning');
  }

  // ── Seller-only enforcement (v3 contract requirement) ────────────────────
  const walletAddr = window.walletState.address?.toLowerCase();
  if (contract.seller.toLowerCase() !== walletAddr) {
    return _otcToast(
      '🔒 Only the seller can release funds (v3 contract restriction). ' +
      'If you are an authorized relayer, use the contract directly.',
      'error'
    );
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

  if (!confirm(`Release ${contract.amount} ${contract.asset} to your wallet as seller?\n\nContract: ${contractId}`)) return;

  try {
    const signer  = await _otcGetSigner();
    const escrow  = otcGetEscrowContract(signer);
    if (!escrow) throw new Error('Escrow not available');

    _otcToast('Confirm release in wallet…', 'info');
    const tx = await escrow.release(contract.escrowDealId);
    _otcToast('⏳ Release tx sent — waiting for confirmation…', 'info');
    const receipt = await tx.wait();

    contract.released      = true;
    contract.releaseTxHash = receipt.hash;
    contract.status        = OTC_STATUS.RELEASED;
    contract.updatedAt     = _otcNow();
    otcSave();
    _otcPushHistory(contract, `Released: ${contract.amount} ${contract.asset} to seller`);

    // Dispatch event so on-chain feed updates
    _otcEmitOnChainEvent('DealReleased', { contractId, txHash: receipt.hash, amount: contract.amount, asset: contract.asset });

    const explorerUrl = `${OTC_EXPLORER}/tx/${receipt.hash}`;
    _otcToast(`✅ Funds released! <a href="${explorerUrl}" target="_blank" class="underline">View TX ↗</a>`, 'success');
    otcRenderMyContracts();

  } catch(e) {
    console.error('[OTC ERROR LOCATION] otcReleaseDeal threw:', e.stack || e.message);
    const decoded = _otcDecodeError(e);
    if (decoded.userRejected) {
      _otcToast('Transaction rejected', 'warning');
    } else {
      _otcToast(`❌ Release error: ${decoded.msg}`, 'error');
    }
    _otcLog('release error:', e);
  }
}

// ─── 4b. Submit Proof (Seller only, on-chain + local) ─────────────────────
/**
 * Seller submits delivery proof (tx hash, URL, or text).
 * - Hashes the proofData with keccak256 via ethers.id() and calls submitProof(dealId, proofHash).
 * - Stores the original proofData string locally so the buyer can see it.
 * - After on-chain confirmation: status → READY_TO_SETTLE.
 * - For off-chain deals (no escrowDealId): stores proof locally only and sets READY_TO_SETTLE.
 */
async function otcSubmitProof(contractId) {
  _otcLog('[TRACE] Entering otcSubmitProof()', contractId);

  const contract = _otcContracts.find(c => c.contractId === contractId);
  if (!contract) return _otcToast('Contract not found', 'error');

  // Gate: only seller
  const wallet = window.walletState?.address?.toLowerCase();
  if (!wallet || contract.seller.toLowerCase() !== wallet) {
    return _otcToast('Only the seller can submit proof', 'error');
  }

  // Read input
  const rawInput = (_otcEl(`otc-proof-input-${contractId}`)?.value || '').trim();
  if (!rawInput) return _otcToast('Enter a transaction hash, URL, or description', 'warning');

  const btn = _otcEl(`otc-proof-submit-btn-${contractId}`);
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Submitting…'; }

  try {
    // ── On-chain path ──────────────────────────────────────────────────────
    if (contract.onChain && contract.escrowDealId && otcIsDeployed()) {
      if (!window.ethereum || !window.walletState?.connected) {
        _otcToast('Connect wallet to submit proof on-chain', 'warning');
        if (typeof openWalletModal === 'function') openWalletModal();
        return;
      }

      const signer  = await _otcGetSigner();
      const escrow  = getOTCEscrowContract(signer);
      const ethers  = window.ethers;
      if (!ethers) throw new Error('ethers.js not loaded');

      // keccak256 hash of the raw proof string → bytes32
      const proofBytes32 = ethers.id(rawInput); // ethers.id() = keccak256(utf8(str))

      // ── Try on-chain submitProof; fall back silently if contract is v1
      // (v1 does not have submitProof — CALL_EXCEPTION / estimateGas failure)
      let onChainSuccess = false;
      try {
        _otcToast('⏳ Confirm submitProof in wallet…', 'info');
        const tx = await escrow.submitProof(contract.escrowDealId, proofBytes32);

        _otcToast('⏳ submitProof tx sent — waiting for confirmation…', 'info');
        _otcLog('submitProof tx hash:', tx.hash);

        const receipt = await tx.wait();
        _otcLog('submitProof confirmed:', receipt.hash);

        contract.proofTxHash = receipt.hash;
        onChainSuccess = true;

        const explorerUrl = `${OTC_EXPLORER}/tx/${receipt.hash}`;
        _otcToast(`✅ Proof submitted on-chain! <a href="${explorerUrl}" target="_blank" class="underline">View TX ↗</a>`, 'success');

      } catch (onChainErr) {
        // Graceful fallback: contract may be v1 (no submitProof function)
        // or user rejected — handle each case
        const isReject = onChainErr.code === 4001
          || onChainErr.action === 'sendTransaction'
          || String(onChainErr.message).includes('rejected')
          || String(onChainErr.message).includes('denied');

        if (isReject) {
          // User explicitly rejected — re-throw so outer catch handles it
          throw onChainErr;
        }

        // CALL_EXCEPTION / estimateGas failure — submitProof not available on
        // this contract version; store proof locally only
        _otcLog('[OTC] submitProof not available on deployed contract (v1 fallback):', onChainErr.message);
        _otcToast('ℹ️ Proof saved locally (escrow contract does not support on-chain proof submission)', 'info');
        contract.proofTxHash   = null;
        contract.proofOnChainSkipped = true; // flag for UI
      }

      // Persist locally regardless of on-chain outcome
      contract.proofData        = rawInput;
      contract.proofSubmittedAt = _otcNow();
      contract.status           = 'READY_TO_SETTLE';
      contract.updatedAt        = _otcNow();
      otcSave();
      _otcPushHistory(contract, onChainSuccess
        ? `Proof submitted on-chain (tx: ${_otcShort(contract.proofTxHash)})`
        : `Proof submitted locally (contract v1 fallback)`);

      if (!onChainSuccess) {
        _otcToast('✅ Proof saved! Status → Ready to Settle.', 'success');
      }

    } else {
      // ── Off-chain / local-only path (no escrowDealId) ───────────────────
      contract.proofData        = rawInput;
      contract.proofTxHash      = null;
      contract.proofSubmittedAt = _otcNow();
      contract.status           = 'READY_TO_SETTLE';
      contract.updatedAt        = _otcNow();
      otcSave();
      _otcPushHistory(contract, `Proof submitted locally`);
      _otcToast('✅ Proof submitted! Status → Ready to Settle.', 'success');
    }

    otcRenderMyContracts();

  } catch(e) {
    console.error('[OTC ERROR LOCATION] otcSubmitProof threw:', e.stack || e.message);
    const rej = e.code === 4001 || e.message?.includes('rejected') || e.message?.includes('denied');
    _otcToast(rej ? '⚠️ Transaction rejected.' : `❌ Proof submission failed: ${e.message}`, rej ? 'warning' : 'error');
    _otcLog('submitProof error:', e);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-upload mr-1"></i>Submit Proof'; }
  }
}

// ─── 4a-1b. Buyer attestation (confirm delivery) ──────────────────────────
/**
 * Buyer attests that the seller has fulfilled their obligation.
 * - Signs an EIP-191 message locally (no gas).
 * - Stores attestation in the contract object for auditing.
 * - Updates buyerAttestedAt + buyerAttestationSig fields.
 */
async function otcAttestDelivery(contractId) {
  _otcLog('[TRACE] Entering otcAttestDelivery()', contractId);

  const contract = _otcContracts.find(c => c.contractId === contractId);
  if (!contract) return _otcToast('Contract not found', 'error');

  const wallet = window.walletState?.address?.toLowerCase();
  if (!wallet || contract.buyer.toLowerCase() !== wallet) {
    return _otcToast('Only the buyer can attest delivery', 'error');
  }

  if (!contract.proofData) {
    return _otcToast('No proof to attest — seller has not submitted proof yet', 'warning');
  }

  if (contract.buyerAttestedAt) {
    return _otcToast('You have already attested delivery for this contract', 'info');
  }

  const btn = _otcEl(`otc-attest-btn-${contractId}`);
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Signing…'; }

  try {
    if (!window.ethereum || !window.walletState?.connected) {
      _otcToast('Connect your wallet to attest', 'warning');
      if (typeof openWalletModal === 'function') openWalletModal();
      return;
    }

    const signer = await _otcGetSigner();

    // Construct deterministic attestation message
    const msg = [
      'OTC Delivery Attestation',
      `Contract: ${contractId}`,
      `Proof: ${contract.proofData}`,
      `Attested at: ${new Date().toISOString()}`,
      `Buyer: ${wallet}`,
    ].join('\n');

    _otcToast('⏳ Sign the attestation message in your wallet…', 'info');
    const sig = await signer.signMessage(msg);
    _otcLog('Attestation signed:', sig.slice(0, 20) + '…');

    contract.buyerAttestedAt      = _otcNow();
    contract.buyerAttestationSig  = sig;
    contract.buyerAttestationMsg  = msg;
    contract.updatedAt            = _otcNow();
    otcSave();
    _otcPushHistory(contract, `Buyer attested delivery (sig: ${sig.slice(0, 14)}…)`);

    _otcToast('✅ Delivery attested! Your signature has been recorded.', 'success');
    otcRenderMyContracts();

  } catch(e) {
    console.error('[OTC] otcAttestDelivery error:', e.stack || e.message);
    const rej = e.code === 4001 || e.message?.includes('rejected') || e.message?.includes('denied');
    _otcToast(rej ? '⚠️ Attestation rejected.' : `❌ Attestation failed: ${e.message}`, rej ? 'warning' : 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-stamp mr-1"></i>Attest Delivery'; }
  }
}

// ─── 4a-2. Deposit Seller (TRUSTLESS mode, v4) ────────────────────────────
/**
 * Seller deposits their collateral in TRUSTLESS mode.
 * Only callable when status == AWAITING_SELLER_DEPOSIT.
 */
async function otcDepositSeller(contractId) {
  _otcLog('[TRACE] Entering otcDepositSeller()', contractId);
  try { otcRequireDeployed(); } catch(e) { return _otcToast(e.message, 'warning'); }
  if (!window.ethereum || !window.walletState?.connected) {
    _otcToast('Connect wallet to deposit', 'warning');
    if (typeof openWalletModal === 'function') openWalletModal();
    return;
  }

  const contract = _otcContracts.find(c => c.contractId === contractId);
  if (!contract) return _otcToast('Contract not found', 'error');

  const walletAddr = window.walletState.address?.toLowerCase();
  if (contract.seller.toLowerCase() !== walletAddr) {
    return _otcToast('Only the seller can deposit in TRUSTLESS mode', 'error');
  }
  if (contract.status !== 'AWAITING_SELLER_DEPOSIT') {
    return _otcToast('Seller deposit only valid when status is AWAITING_SELLER_DEPOSIT', 'warning');
  }

  const amountStr = prompt(
    `Enter seller deposit amount (${contract.asset}):\n(This is your collateral for the TRUSTLESS trade)`,
    String(contract.amount)
  );
  if (!amountStr || isNaN(Number(amountStr)) || Number(amountStr) <= 0) return;

  try {
    const signer   = await _otcGetSigner();
    const provider = signer.provider;
    const escrow   = otcGetEscrowContract(signer);
    if (!escrow) throw new Error('Escrow not available on this network');

    const tokenAddr = otcResolveToken(contract.asset);
    if (!tokenAddr) throw new Error(`Unknown token: ${contract.asset}`);

    const amountRaw  = await otcParseTokenAmount(Number(amountStr), tokenAddr, provider);
    const erc20      = otcGetERC20Contract(tokenAddr, signer);
    const allowance  = await erc20.allowance(walletAddr, OTC_ESCROW_ADDRESS);

    if (allowance < amountRaw) {
      _otcToast('Approving token spend…', 'info');
      const approveTx = await erc20.approve(OTC_ESCROW_ADDRESS, amountRaw);
      await approveTx.wait();
      _otcToast('Approval confirmed. Now depositing…', 'info');
    }

    _otcToast('Confirm seller deposit in wallet…', 'info');
    const tx      = await escrow.depositSeller(contract.escrowDealId, amountRaw);
    _otcToast('⏳ Deposit tx sent — waiting for confirmation…', 'info');
    const receipt = await tx.wait();

    contract.status         = 'AWAITING_PROOF';
    contract.sellerAmount   = Number(amountStr);
    contract.sellerDepositTx= receipt.hash;
    contract.updatedAt      = _otcNow();
    otcSave();

    _otcEmitOnChainEvent('SellerDeposited', {
      contractId,
      txHash: receipt.hash,
      amount: amountStr,
      asset:  contract.asset,
    });

    const explorerUrl = `${OTC_EXPLORER}/tx/${receipt.hash}`;
    _otcToast(
      `✅ Seller deposit confirmed! ${amountStr} ${contract.asset} locked. ` +
      `<a href="${explorerUrl}" target="_blank" class="underline">View TX ↗</a>`,
      'success'
    );
    otcRenderMyContracts();

  } catch(e) {
    console.error('[OTC ERROR LOCATION] otcDepositSeller threw:', e.stack || e.message);
    const decoded = _otcDecodeError(e);
    if (decoded.userRejected) {
      _otcToast('Transaction rejected', 'warning');
    } else {
      _otcToast(`❌ Seller deposit error: ${decoded.msg}`, 'error');
    }
    _otcLog('depositSeller error:', e);
  }
}

// ─── 4b. Open Dispute Dialog (v4) ─────────────────────────────────────────
/**
 * Shows a prompt for dispute reason, then calls openDispute(tradeId, reason).
 * Falls back to raiseDispute() if openDispute is not available (v3 contract).
 */
async function otcOpenDisputeDialog(contractId) {
  const reason = prompt(
    `Open Dispute for deal ${contractId}\n\n` +
    `Please provide a brief reason for the dispute (optional):\n` +
    `(Will be stored on-chain as part of the dispute record)`,
    ''
  );
  if (reason === null) return; // user cancelled

  await otcRaiseDispute(contractId, reason.trim());
}

// ─── 4b-2. Raise/Open Dispute on-chain (v4 openDispute + v3 raiseDispute fallback) ───
async function otcRaiseDispute(contractId, disputeReason) {
  _otcLog('[TRACE] Entering otcRaiseDispute()', contractId);
  try { otcRequireDeployed(); } catch(e) { return _otcToast(e.message, 'warning'); }
  if (!window.ethereum || !window.walletState?.connected) {
    _otcToast('Connect wallet to open a dispute', 'warning');
    if (typeof openWalletModal === 'function') openWalletModal();
    return;
  }

  const contract = _otcContracts.find(c => c.contractId === contractId);
  if (!contract) return _otcToast('Contract not found', 'error');

  const walletAddr = window.walletState.address?.toLowerCase();
  const isBuyer    = contract.buyer.toLowerCase()  === walletAddr;
  const isSeller   = contract.seller.toLowerCase() === walletAddr;
  if (!isBuyer && !isSeller) return _otcToast('Only the buyer or seller can open a dispute', 'error');

  // v4: accept AWAITING_PROOF, AWAITING_SELLER_DEPOSIT, READY_TO_SETTLE, FUNDED (v3 compat)
  const disputableStatuses = [OTC_STATUS.FUNDED, 'AWAITING_PROOF', 'AWAITING_SELLER_DEPOSIT', 'READY_TO_SETTLE'];
  if (!disputableStatuses.some(s => s === contract.status)) {
    return _otcToast('Disputes can only be opened on funded deals', 'warning');
  }

  const confirmed = confirm(
    `Open a dispute for deal ${contractId}?\n\n` +
    `An arbiter will review the case and decide whether to:\n` +
    `  • Release funds to the seller, or\n` +
    `  • Refund tokens to the buyer.\n\n` +
    `Settlement is FROZEN while the dispute is open.\n` +
    `This action is irreversible. Continue?`
  );
  if (!confirmed) return;

  try {
    const signer  = await _otcGetSigner();
    const escrow  = otcGetEscrowContract(signer);
    if (!escrow) throw new Error('Escrow not available on this network');

    _otcToast('Confirm dispute in wallet…', 'info');

    // v4: try openDispute(tradeId, reason) first, fallback to raiseDispute()
    let tx;
    const reason = disputeReason || '';
    try {
      tx = await escrow.openDispute(contract.escrowDealId, reason);
      _otcLog('openDispute (v4) sent');
    } catch(e2) {
      // Might be a v3 contract — fallback to raiseDispute()
      _otcLog('openDispute failed, trying raiseDispute (v3 fallback):', e2.message);
      tx = await escrow.raiseDispute(contract.escrowDealId);
    }

    _otcToast('⏳ Dispute tx sent — waiting for confirmation…', 'info');
    const receipt = await tx.wait();

    // Update local state — v4 IN_DISPUTE
    contract.status        = 'IN_DISPUTE';
    contract.onChainState  = 5; // Status.IN_DISPUTE=5 in v4
    contract.disputeTxHash = receipt.hash;
    contract.disputeReason = reason;
    contract.updatedAt     = _otcNow();
    otcSave();
    _otcPushHistory(contract, `Dispute opened by ${isBuyer ? 'buyer' : 'seller'}${reason ? `: ${reason}` : ''}`);

    _otcEmitOnChainEvent('DisputeOpened', { contractId, txHash: receipt.hash, openedBy: walletAddr, reason });

    const explorerUrl = `${OTC_EXPLORER}/tx/${receipt.hash}`;
    _otcToast(
      `⚖️ Dispute opened. Settlement frozen. An arbiter will review the case. ` +
      `<a href="${explorerUrl}" target="_blank" class="underline">View TX ↗</a>`,
      'warning'
    );
    otcRenderMyContracts();

  } catch(e) {
    console.error('[OTC ERROR LOCATION] otcRaiseDispute threw:', e.stack || e.message);
    const decoded = _otcDecodeError(e);
    if (decoded.userRejected) {
      _otcToast('Transaction rejected', 'warning');
    } else if (decoded.msg.includes('DisputeAlreadyResolved')) {
      _otcToast('❌ This dispute has already been resolved', 'error');
    } else if (decoded.msg.includes('InvalidState') || decoded.msg.includes('NotFunded')) {
      _otcToast('❌ Deal must be funded before opening a dispute', 'error');
    } else {
      _otcToast(`❌ Dispute error: ${decoded.msg}`, 'error');
    }
    _otcLog('openDispute error:', e);
  }
}

// ─── 4c. Resolve Dispute on-chain (arbiter only — v4) ────────────────────
// This function is called by the arbiter wallet directly from the UI.
// Non-arbiters will see a NotArbiter error on the contract — we surface that clearly.
async function otcResolveDispute(contractId, releaseToSeller) {
  _otcLog('[TRACE] Entering otcResolveDispute()', contractId, 'releaseToSeller:', releaseToSeller);
  try { otcRequireDeployed(); } catch(e) { return _otcToast(e.message, 'warning'); }
  if (!window.ethereum || !window.walletState?.connected) {
    _otcToast('Connect your wallet to resolve the dispute', 'warning');
    if (typeof openWalletModal === 'function') openWalletModal();
    return;
  }

  const contract = _otcContracts.find(c => c.contractId === contractId);
  if (!contract) return _otcToast('Contract not found', 'error');

  // Accept both v4 IN_DISPUTE and v3 DISPUTED local statuses
  const isDisputed = contract.status === 'IN_DISPUTE' || contract.status === 'DISPUTED'
    || contract.onChainState === 5 || contract.onChainState === 4;
  if (!isDisputed) {
    return _otcToast('This deal is not under active dispute', 'warning');
  }

  const outcome = releaseToSeller ? 'release funds to the seller' : 'refund tokens to the buyer';
  const confirmed = confirm(
    `Resolve dispute for deal ${contractId}?\n\n` +
    `You are about to: ${outcome.toUpperCase()}\n\n` +
    `⚠️  This action is IRREVERSIBLE and requires arbitrator authority.\n` +
    `Proceed?`
  );
  if (!confirmed) return;

  try {
    const signer  = await _otcGetSigner();
    const escrow  = otcGetEscrowContract(signer);
    if (!escrow) throw new Error('Escrow contract not available on this network');

    _otcToast('Confirm resolution in wallet…', 'info');
    const tx = await escrow.resolveDispute(contract.escrowDealId, releaseToSeller);
    _otcToast('⏳ Resolution tx sent — waiting for confirmation…', 'info');
    const receipt = await tx.wait();

    // Update local state — v4: COMPLETED=6, CANCELLED=7
    contract.status        = releaseToSeller ? OTC_STATUS.RELEASED : OTC_STATUS.CANCELLED;
    contract.onChainState  = releaseToSeller ? 6 : 7; // v4: COMPLETED=6, CANCELLED=7
    contract.resolveTxHash = receipt.hash;
    contract.updatedAt     = _otcNow();
    otcSave();

    const outcomeLabel = releaseToSeller
      ? `Funds released to seller (${_otcShort(contract.seller)})`
      : `Tokens refunded to buyer (${_otcShort(contract.buyer)})`;

    _otcPushHistory(contract, `Dispute resolved: ${outcomeLabel}`);
    _otcEmitOnChainEvent('DisputeResolved', {
      contractId,
      txHash:  receipt.hash,
      releaseToSeller,
      amount:  contract.amount,
      asset:   contract.asset,
    });

    const explorerUrl = `${OTC_EXPLORER}/tx/${receipt.hash}`;
    _otcToast(
      `⚖️ Dispute resolved! ${outcomeLabel}. ` +
      `<a href="${explorerUrl}" target="_blank" class="underline">View TX ↗</a>`,
      'success'
    );
    otcRenderMyContracts();

  } catch(e) {
    console.error('[OTC ERROR LOCATION] otcResolveDispute threw:', e.stack || e.message);
    const decoded = _otcDecodeError(e);
    if (decoded.userRejected) {
      _otcToast('Transaction rejected', 'warning');
    } else if (decoded.msg.includes('NotArbiter') || decoded.msg.includes('NotArbitrator')) {
      _otcToast('❌ Only the arbiter can resolve disputes. Your wallet is not the designated arbiter.', 'error');
    } else if (decoded.msg.includes('DisputeAlreadyResolved')) {
      _otcToast('❌ This dispute has already been resolved.', 'error');
    } else if (decoded.msg.includes('NoDispute')) {
      _otcToast('❌ No active dispute found for this deal. Sync status and try again.', 'error');
    } else {
      _otcToast(`❌ Resolve dispute error: ${decoded.msg}`, 'error');
    }
    _otcLog('resolveDispute error:', e);
  }
}

// ─── 5. Request cancel on-chain (cancel dual-consent for funded deals) ─────
async function otcRequestCancelOnChain(contractId) {
  _otcLog('[TRACE] Entering otcRequestCancelOnChain()', contractId);
  try { otcRequireDeployed(); } catch(e) { return _otcToast(e.message, 'warning'); }
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
    console.error('[OTC ERROR LOCATION] otcRequestCancelOnChain threw:', e.stack || e.message);
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

// ─── 6a. Full on-chain sync: rebuild local state from blockchain ───────────
// Fetches all dealIds for walletAddress via getDealsByParty(), then calls
// getDeal() for each one in parallel. Merges results into _otcContracts and
// otcSave(). Called on wallet connect and on tab switch to "my".
async function otcSyncFromChain(walletAddress) {
  if (!walletAddress || !otcIsDeployed()) return;
  if (_otcSyncInProgress) {
    _otcLog('[SYNC] Already in progress — skipping duplicate call');
    return;
  }
  _otcSyncInProgress = true;

  // ── Show loading indicator ────────────────────────────────────────────────
  const container = _otcEl('otc-my-list');
  if (container) {
    container.innerHTML = `
      <div class="flex flex-col items-center gap-3 py-12 text-center text-gray-500" id="otc-sync-loading">
        <i class="fas fa-spinner fa-spin text-2xl text-indigo-400"></i>
        <p class="text-sm">Syncing trades from blockchain…</p>
        <p class="text-xs text-gray-600">Querying Arc Testnet (chain ${OTC_CHAIN_ID})</p>
      </div>`;
  }

  try {
    const ethers   = window.ethers;
    if (!ethers) throw new Error('ethers.js not loaded');

    const provider = new ethers.JsonRpcProvider(OTC_RPC);
    const escrow   = otcGetEscrowContract(provider);
    if (!escrow) throw new Error('Cannot instantiate escrow contract (address missing)');

    _otcLog('[SYNC] Fetching dealIds for', walletAddress);

    // getDealsByParty returns bytes32[] of dealIds for this address
    let dealIds = [];
    try {
      dealIds = await escrow.getDealsByParty(walletAddress);
    } catch(e) {
      _otcLog('[SYNC] getDealsByParty failed:', e.message);
      // Graceful: keep whatever is in localStorage
      _otcSyncInProgress = false;
      otcRenderMyContracts();
      return;
    }

    _otcLog('[SYNC] Found', dealIds.length, 'on-chain deals');
    if (!dealIds.length) {
      _otcSyncInProgress = false;
      otcRenderMyContracts();
      return;
    }

    // ── On-chain status → local status map (v4 State enum) ──────────────────
    const stateMap = {
      0: OTC_STATUS.ONCHAIN_CREATED,    // CREATED
      1: 'AWAITING_BUYER_DEPOSIT',       // AWAITING_BUYER_DEPOSIT
      2: 'AWAITING_SELLER_DEPOSIT',      // AWAITING_SELLER_DEPOSIT
      3: 'AWAITING_PROOF',               // AWAITING_PROOF
      4: 'READY_TO_SETTLE',              // READY_TO_SETTLE (EXECUTABLE)
      5: 'IN_DISPUTE',                   // IN_DISPUTE
      6: OTC_STATUS.RELEASED,            // COMPLETED / RELEASED
      7: OTC_STATUS.CANCELLED,           // CANCELLED
    };

    // ── Fetch all deals in parallel ──────────────────────────────────────────
    const dealFetches = dealIds.map(async (dealId) => {
      try {
        const d = await escrow.getDeal(dealId);
        // getDeal returns tuple: buyer, seller, token, amount, tgeTimestamp,
        // buyerSigned, sellerSigned, state, buyerCancelRequested,
        // sellerCancelRequested, disputeRaisedBy, contractHash, createdAt
        return { dealId, deal: d, ok: true };
      } catch(e) {
        _otcLog('[SYNC] getDeal failed for', dealId, ':', e.message);
        return { dealId, ok: false };
      }
    });

    const results = await Promise.all(dealFetches);

    // ── Merge each on-chain deal into local _otcContracts ───────────────────
    let changed = false;
    for (const { dealId, deal, ok } of results) {
      if (!ok || !deal) continue;

      const dealIdHex   = dealId.toString();
      const buyer       = deal[0]?.toLowerCase?.() || deal.buyer?.toLowerCase?.() || '';
      const seller      = deal[1]?.toLowerCase?.() || deal.seller?.toLowerCase?.() || '';
      const token       = deal[2] || deal.token;
      const amountRaw   = deal[3] || deal.amount;
      const tgeTs       = Number(deal[4] ?? deal.tgeTimestamp ?? 0);
      const buyerSigned = deal[5] ?? deal.buyerSigned ?? false;
      const sellerSigned= deal[6] ?? deal.sellerSigned ?? false;
      const stateNum    = Number(deal[7] ?? deal.state ?? 0);
      const contractHash= deal[11] || deal.contractHash || '';
      const createdAtTs = Number(deal[12] ?? deal.createdAt ?? 0);

      const onChainStatus = stateMap[stateNum] || OTC_STATUS.ONCHAIN_CREATED;
      const tgeISO        = tgeTs ? new Date(tgeTs * 1000).toISOString() : null;
      const createdISO    = createdAtTs ? new Date(createdAtTs * 1000).toISOString() : _otcNow();

      // Find existing local record by escrowDealId or contractHash
      let existing = _otcContracts.find(c => c.escrowDealId === dealIdHex);
      if (!existing && contractHash && contractHash !== '0x' + '0'.repeat(64)) {
        existing = _otcContracts.find(c => c.contractHash === contractHash);
      }

      if (existing) {
        // Update the existing local record with fresh on-chain data
        const wasStatus = existing.status;

        // ── Status merge rule ────────────────────────────────────────────
        // Never regress local status if the user has already progressed it
        // beyond what the chain knows (e.g. proof stored locally on v1 contract
        // that has no submitProof function → chain stays AWAITING_PROOF but
        // local should stay READY_TO_SETTLE so buttons remain visible).
        //
        // Precedence ladder (higher index = more advanced):
        const _statusOrder = [
          OTC_STATUS.ONCHAIN_CREATED,    // 0
          OTC_STATUS.ONCHAIN_SIGNED,     // 1
          'AWAITING_BUYER_DEPOSIT',      // 2
          'AWAITING_SELLER_DEPOSIT',     // 3
          OTC_STATUS.FUNDED,             // 4
          'AWAITING_PROOF',              // 5
          'READY_TO_SETTLE',             // 6
          'IN_DISPUTE',                  // special — never overwrite with this from chain unless chain says so
          OTC_STATUS.RELEASED,           // 7
          OTC_STATUS.COMPLETED,          // 8
          OTC_STATUS.CANCELLED,          // 9
        ];
        const localRank  = _statusOrder.indexOf(existing.status);
        const chainRank  = _statusOrder.indexOf(onChainStatus);

        // Only overwrite local status when:
        //   (a) chain advances past local (chain rank > local rank), OR
        //   (b) chain reports terminal state (RELEASED/CANCELLED/COMPLETED), OR
        //   (c) chain reports IN_DISPUTE, OR
        //   (d) local has no proofData (nothing worth preserving beyond chain state)
        const chainIsTerminal  = [OTC_STATUS.RELEASED, OTC_STATUS.CANCELLED, OTC_STATUS.COMPLETED].includes(onChainStatus);
        const chainIsDisputed  = onChainStatus === 'IN_DISPUTE';
        const localHasProof    = !!existing.proofData;
        const shouldUpdate = chainIsTerminal || chainIsDisputed
          || chainRank > localRank
          || (!localHasProof && chainRank !== localRank);

        if (shouldUpdate) {
          existing.status = onChainStatus;
        }
        // ─────────────────────────────────────────────────────────────────

        existing.onChain       = true;
        existing.escrowDealId  = dealIdHex;
        existing.updatedAt     = _otcNow();
        // Sync on-chain signature flags (bytes32 sig means signed on-chain)
        if (buyerSigned  && !existing.buyerSig)  existing.buyerSig  = '0x' + '0'.repeat(62) + '01';
        if (sellerSigned && !existing.sellerSig) existing.sellerSig = '0x' + '0'.repeat(62) + '01';
        if (wasStatus !== existing.status) {
          _otcLog('[SYNC] Updated', existing.contractId, wasStatus, '→', existing.status);
          changed = true;
        }
      } else {
        // Reconstruct a minimal local record from on-chain data
        // (covers case where localStorage was cleared)
        const assetSym = _otcReverseToken(token);
        const newLocal = {
          contractId:   'OTC-CHAIN-' + dealIdHex.slice(2, 12).toUpperCase(),
          buyer,
          seller,
          asset:        assetSym || token,
          amount:       0,           // raw amount — display as raw until parsed
          tgeDate:      tgeISO ? tgeISO.slice(0, 10) : '',
          tgeTime:      tgeISO ? tgeISO.slice(11, 16) : '',
          tgeTz:        'UTC',
          tgeDatetime:  tgeISO,
          timestamp_utc: tgeISO,
          description:  'Recovered from chain (dealId: ' + dealIdHex.slice(0, 14) + '…)',
          contractHash,
          status:       onChainStatus,
          createdAt:    createdISO,
          updatedAt:    _otcNow(),
          buyerSig:     buyerSigned  ? '0x' + '0'.repeat(62) + '01' : null,
          sellerSig:    sellerSigned ? '0x' + '0'.repeat(62) + '01' : null,
          buyerSigAt:   buyerSigned  ? createdISO : null,
          sellerSigAt:  sellerSigned ? createdISO : null,
          txProof:      null,
          verifiedAt:   null,
          receipt:      null,
          notes:        [],
          sellerScheduleConfirmed: sellerSigned,
          sellerTgeDate: null,
          sellerTgeTime: null,
          escrowDealId:  dealIdHex,
          escrowTxHash:  null,
          fundTxHash:    null,
          releaseTxHash: null,
          cancelTxHash:  null,
          onChain:       true,
          _recoveredFromChain: true,
        };
        _otcContracts.unshift(newLocal);
        _otcLog('[SYNC] Recovered deal from chain:', newLocal.contractId, onChainStatus);
        changed = true;
      }
    }

    if (changed) {
      // Sort: most-recently-updated first
      _otcContracts.sort((a, b) =>
        new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0)
      );
      otcSave();
    }

    _otcLog('[SYNC] Complete — total local contracts:', _otcContracts.length);

  } catch(e) {
    console.error('[OTC ERROR LOCATION] otcSyncFromChain threw:', e.stack || e.message);
    _otcLog('[SYNC] Error (local data preserved):', e.message);
  } finally {
    _otcSyncInProgress = false;
    otcRenderMyContracts();
  }
}

// ─── Helper: reverse-lookup token symbol from address ─────────────────────
function _otcReverseToken(addr) {
  if (!addr) return null;
  const lower = addr.toLowerCase();
  // OTC_KNOWN_TOKENS is defined in otc-escrow-abi.js (symbol → address)
  if (typeof OTC_KNOWN_TOKENS === 'object') {
    for (const [sym, a] of Object.entries(OTC_KNOWN_TOKENS)) {
      if (a.toLowerCase() === lower) return sym;
    }
  }
  return null;
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

    // Map on-chain string → local UI status (v4 + v3 compat)
    const statusMap = {
      // v4 Status strings
      'CREATED':                  OTC_STATUS.ONCHAIN_CREATED,
      'AWAITING_BUYER_DEPOSIT':   'AWAITING_BUYER_DEPOSIT',
      'AWAITING_SELLER_DEPOSIT':  'AWAITING_SELLER_DEPOSIT',
      'AWAITING_PROOF':           'AWAITING_PROOF',
      'READY_TO_SETTLE':          'READY_TO_SETTLE',
      'IN_DISPUTE':               'IN_DISPUTE',
      'COMPLETED':                OTC_STATUS.RELEASED,
      'CANCELLED':                OTC_STATUS.CANCELLED,
      // v4 EXECUTABLE (READY_TO_SETTLE + TGE past)
      'EXECUTABLE':               'READY_TO_SETTLE',
      // v3 legacy string names (for old deployed contract compatibility)
      'PARTIALLY_SIGNED':         OTC_STATUS.ONCHAIN_CREATED,
      'BOTH_SIGNED':              OTC_STATUS.ONCHAIN_SIGNED,
      'FUNDED':                   OTC_STATUS.FUNDED,
      'DISPUTED':                 'IN_DISPUTE',
      'RELEASED':                 OTC_STATUS.RELEASED,
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

  if (sub === 'my') {
    // Trigger chain sync when switching to "My Contracts" tab (if wallet connected)
    const wallet = window.walletState?.address?.toLowerCase();
    if (wallet && otcIsDeployed() && !_otcSyncInProgress) {
      otcSyncFromChain(wallet); // async — renders when done
    } else {
      otcRenderMyContracts();
    }
  }
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
    && !isOnChain && !isTerminal && otcIsDeployed();

  // Sign on-chain
  const onChainBuyerSigned  = isOnChain && !!c.buyerSig  && (c.buyerSig.startsWith('0x') && c.buyerSig.length === 66);
  const onChainSellerSigned = isOnChain && !!c.sellerSig && (c.sellerSig.startsWith('0x') && c.sellerSig.length === 66);
  const canSignOnChain = isOnChain && !isTerminal && (
    (isBuyer  && !onChainBuyerSigned)  ||
    (isSeller && !onChainSellerSigned)
  ) && [OTC_STATUS.ONCHAIN_CREATED, OTC_STATUS.ONCHAIN_SIGNED].includes(c.status);

  // Fund: buyer, both signed on-chain (either ONCHAIN_SIGNED status or ONCHAIN_CREATED
  // with both local sigs present — handles out-of-sync local state), escrow not yet funded
  // v4 also accepts AWAITING_BUYER_DEPOSIT status
  const canFund = isOnChain && isBuyer && !isTerminal
    && (c.status === OTC_STATUS.ONCHAIN_SIGNED
        || c.status === 'AWAITING_BUYER_DEPOSIT'
        || (c.status === OTC_STATUS.ONCHAIN_CREATED && onChainBuyerSigned && onChainSellerSigned));

  // Release: SELLER-ONLY (v4 contract) or authorized address.
  // Buyer can NO longer call release — contract will revert with NotAuthorized.
  // We hide the button for non-sellers to prevent confusion.
  // Accepts FUNDED (v3 compat), AWAITING_PROOF, or READY_TO_SETTLE
  const tgeTs   = new Date(c.timestamp_utc || _otcToUTCIso(c.tgeDate, c.tgeTime)).getTime();
  const tgeIn   = tgeTs - Date.now();
  const tgePast = tgeIn <= 0;

  // Raise dispute: funded deal, buyer or seller, not already disputed/terminal
  // In v4: disputable statuses are AWAITING_PROOF, AWAITING_SELLER_DEPOSIT, READY_TO_SETTLE
  const isDisputed  = c.status === 'DISPUTED' || c.status === 'IN_DISPUTE'
    || c.onChainState === 5; // IN_DISPUTE=5 in v4 Status enum

  const canRelease = isOnChain && isSeller && !isTerminal && !isDisputed
    && [OTC_STATUS.FUNDED, 'AWAITING_PROOF', 'READY_TO_SETTLE'].some(s => c.status === s)
    && tgePast
    && !!c.proofData; // ← Release BLOCKED until proof is submitted
  const canDispute  = isOnChain && isParty && !isTerminal && !isDisputed
    && [OTC_STATUS.FUNDED, 'AWAITING_PROOF', 'AWAITING_SELLER_DEPOSIT', 'READY_TO_SETTLE'].some(s => c.status === s);

  // Resolve dispute: arbitrator only — show note if address matches arbitrator field
  // (We don't know arbitrator address from localStorage — show a neutral panel for disputed deals)

  // Cancel on-chain: party + not released + not already cancelled + not disputed
  // Disputed deals block cancel — must go through resolveDispute (arbiter only)
  const canCancelOnChain = isOnChain && isParty && !isTerminal && !isDisputed
    && [OTC_STATUS.ONCHAIN_CREATED, OTC_STATUS.ONCHAIN_SIGNED, OTC_STATUS.FUNDED,
        OTC_STATUS.CANCEL_REQUESTED, 'AWAITING_PROOF', 'AWAITING_SELLER_DEPOSIT',
        'READY_TO_SETTLE'].includes(c.status);

  // Off-chain cancel: not on-chain, not terminal
  const canCancelOffChain = !isOnChain && !isTerminal
    && [OTC_STATUS.PENDING_SCHEDULE, OTC_STATUS.SCHEDULED, OTC_STATUS.SIGNED, OTC_STATUS.LOCKED, OTC_STATUS.EXECUTABLE, OTC_STATUS.AWAITING_PAYMENT].includes(c.status);

  // Legacy TX proof (off-chain flow)
  const canProof = !isOnChain && isBuyer && c.status === OTC_STATUS.AWAITING_PAYMENT;

  // v4: TRUSTLESS mode — seller deposit button
  const isTrustless = c.tradeMode === 'TRUSTLESS' || c.onChainTradeMode === 0;
  const canDepositSeller = isOnChain && isSeller && !isTerminal && !isDisputed
    && c.status === 'AWAITING_SELLER_DEPOSIT';

  // Local check for authorized (can't know on-chain from localStorage alone)
  const isAuthorizedLocal = false; // No local authorized check

  // v4: Submit proof (seller or authorized) — AWAITING_PROOF OR FUNDED (proof not yet submitted)
  // Also allow proof on READY_TO_SETTLE so seller can update/re-submit
  const hasProof      = !!c.proofData;
  const canSubmitProof = isSeller && !isTerminal && !isDisputed && !hasProof
    && ['AWAITING_PROOF', OTC_STATUS.FUNDED, 'READY_TO_SETTLE'].some(s => c.status === s);

  const tgeLabel = tgeIn > 0
    ? `in ${_otcFormatDuration(tgeIn)}`
    : `${_otcFormatDuration(-tgeIn)} ago`;

  // ── Timeline steps — adapts to on-chain vs off-chain mode ────────────────
  const fundedStatuses   = [OTC_STATUS.FUNDED, OTC_STATUS.RELEASED,
    'AWAITING_PROOF', 'AWAITING_SELLER_DEPOSIT', 'READY_TO_SETTLE', 'IN_DISPUTE', 'COMPLETED'];
  const proofStatuses    = ['READY_TO_SETTLE', 'IN_DISPUTE', 'COMPLETED'];
  const settledStatuses  = [OTC_STATUS.RELEASED, 'COMPLETED'];
  let steps;
  if (isOnChain) {
    if (isTrustless) {
      steps = [
        { label: 'Created',   done: true },
        { label: 'Registered',done: isOnChain },
        { label: 'Signed',    done: [OTC_STATUS.ONCHAIN_SIGNED, ...fundedStatuses].some(s => c.status === s) },
        { label: 'Buyer ↓',   done: fundedStatuses.some(s => c.status === s) },
        { label: 'Seller ↓',  done: ['AWAITING_PROOF', 'READY_TO_SETTLE', 'COMPLETED', 'IN_DISPUTE'].some(s => c.status === s) },
        { label: 'Settled',   done: settledStatuses.some(s => c.status === s) },
      ];
    } else {
      steps = [
        { label: 'Created',   done: true },
        { label: 'Registered',done: isOnChain },
        { label: 'Signed',    done: [OTC_STATUS.ONCHAIN_SIGNED, ...fundedStatuses].some(s => c.status === s) },
        { label: 'Funded',    done: fundedStatuses.some(s => c.status === s) },
        { label: 'Proof',     done: proofStatuses.some(s => c.status === s) },
        { label: 'Released',  done: settledStatuses.some(s => c.status === s) },
      ];
    }
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
            ${isTrustless ? '<span class="ml-1 text-[9px] text-orange-400 font-semibold bg-orange-900/30 px-1.5 py-0.5 rounded-full border border-orange-700/40" title="Both buyer and seller deposit tokens">TRUSTLESS</span>' : (isOnChain ? '<span class="ml-1 text-[9px] text-teal-400 font-semibold bg-teal-900/30 px-1.5 py-0.5 rounded-full border border-teal-700/40" title="Buyer deposits; seller provides proof">FLEXIBLE</span>' : '')}
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

    <!-- Funded info / AWAITING_PROOF info -->
    ${isOnChain && (c.status === OTC_STATUS.FUNDED || c.status === 'AWAITING_PROOF' || c.status === 'READY_TO_SETTLE') ? `
    <div class="px-5 py-3 bg-teal-950/20 border-b border-teal-800/20">
      <p class="text-teal-400 text-xs font-semibold"><i class="fas fa-vault mr-1"></i>Tokens locked in escrow</p>
      <p class="text-gray-500 text-xs mt-1">
        <strong class="text-white">${_otcFmt(c.amount)} ${c.asset}</strong> locked until TGE.
        ${tgePast ? '<span class="text-emerald-400 font-semibold ml-2">TGE reached — release available!</span>' : `Releases ${tgeLabel}.`}
        ${hasProof ? '<span class="text-emerald-300 font-semibold ml-2">✓ Proof submitted</span>' : '<span class="text-amber-400 font-semibold ml-2">⚠ Proof required before release</span>'}
      </p>
    </div>` : ''}

    <!-- ═══ PROOF PANEL — Seller: Add Proof / Buyer: View Proof ══════════════ -->
    ${(() => {
      // Show proof panel when deal is funded on-chain OR status requires proof
      const showPanel = (c.status === OTC_STATUS.FUNDED || c.status === 'AWAITING_PROOF'
        || c.status === 'READY_TO_SETTLE' || c.status === OTC_STATUS.RELEASED || c.status === OTC_STATUS.COMPLETED)
        && (isParty || hasProof);
      if (!showPanel) return '';

      // Helper: render the stored proof value as a clickable link or plain text
      function _renderProofValue(val) {
        if (!val) return '<span class="text-gray-600 italic">No proof submitted yet</span>';
        const trimmed = val.trim();
        // Full tx hash: 0x + 64 hex chars
        if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
          const url = OTC_EXPLORER + '/tx/' + trimmed;
          return `<a href="${url}" target="_blank" rel="noopener"
            class="inline-flex items-center gap-1 text-indigo-300 hover:text-indigo-200 underline font-mono break-all">
            <i class="fas fa-external-link-alt text-[10px]"></i>${trimmed.slice(0,12)}…${trimmed.slice(-8)}
          </a><span class="text-gray-600 text-[10px] ml-1">(tx hash)</span>`;
        }
        // URL
        if (/^https?:\/\//i.test(trimmed) || /^www\./i.test(trimmed)) {
          return `<a href="${trimmed.startsWith('http') ? trimmed : 'https://' + trimmed}"
            target="_blank" rel="noopener"
            class="inline-flex items-center gap-1 text-indigo-300 hover:text-indigo-200 underline break-all">
            <i class="fas fa-external-link-alt text-[10px]"></i>${trimmed}
          </a>`;
        }
        // Short 0x hash (address-length or other)
        if (/^0x[0-9a-fA-F]+$/.test(trimmed)) {
          const url = OTC_EXPLORER + '/tx/' + trimmed;
          return `<a href="${url}" target="_blank" rel="noopener"
            class="inline-flex items-center gap-1 text-indigo-300 hover:text-indigo-200 underline font-mono break-all">
            <i class="fas fa-external-link-alt text-[10px]"></i>${trimmed}
          </a>`;
        }
        // Plain text
        return `<span class="text-gray-200 break-all">${trimmed}</span>`;
      }

      // Buyer attestation state
      const hasAttestation = !!c.buyerAttestedAt;
      const canAttest      = isBuyer && hasProof && !hasAttestation;

      if (hasProof) {
        // ── Proof already submitted: show to BOTH parties ─────────────────
        return `
        <div class="px-5 py-3 bg-emerald-950/20 border-b border-emerald-800/30">
          <div class="flex items-center gap-2 mb-2">
            <i class="fas fa-shield-check text-emerald-400 text-xs"></i>
            <span class="text-emerald-400 text-xs font-semibold">Delivery Proof</span>
            ${c.proofSubmittedAt ? `<span class="text-gray-600 text-[10px] ml-auto">${new Date(c.proofSubmittedAt).toLocaleString()}</span>` : ''}
          </div>
          <div class="bg-gray-900/60 border border-emerald-800/30 rounded-xl px-4 py-3 text-xs leading-relaxed">
            ${_renderProofValue(c.proofData)}
          </div>
          ${c.proofTxHash ? `
          <div class="mt-2 flex items-center gap-1.5 text-[10px] text-gray-500">
            <i class="fas fa-link text-[9px]"></i>submitProof on-chain:
            <a href="${OTC_EXPLORER}/tx/${c.proofTxHash}" target="_blank"
              class="text-indigo-400 hover:text-indigo-300 underline font-mono">${_otcShort(c.proofTxHash)}</a>
          </div>` : (c.proofOnChainSkipped ? `
          <div class="mt-1.5 flex items-center gap-1.5 text-[10px] text-gray-600">
            <i class="fas fa-info-circle text-[9px]"></i>Stored locally (contract v1 — no on-chain proof registry)
          </div>` : '')}
          ${isSeller ? `
          <button onclick="window._otcClearProofInput('${c.contractId}')"
            class="mt-2 text-[10px] text-gray-600 hover:text-gray-400 transition underline">
            Update proof
          </button>` : ''}

          <!-- ── Buyer Attestation row ──────────────────────────────────── -->
          ${hasAttestation ? `
          <div class="mt-3 pt-3 border-t border-emerald-800/30 flex items-start gap-2">
            <i class="fas fa-stamp text-emerald-400 text-xs mt-0.5"></i>
            <div class="flex-1">
              <div class="flex items-center gap-2">
                <span class="text-emerald-400 text-xs font-semibold">Buyer Attested</span>
                <span class="text-gray-600 text-[10px]">${new Date(c.buyerAttestedAt).toLocaleString()}</span>
              </div>
              <div class="text-[10px] text-gray-500 font-mono mt-0.5 break-all">
                Sig: ${c.buyerAttestationSig ? c.buyerAttestationSig.slice(0, 20) + '…' : '—'}
              </div>
            </div>
          </div>` : (canAttest ? `
          <div class="mt-3 pt-3 border-t border-emerald-800/30">
            <div class="flex items-center gap-2 mb-1.5">
              <i class="fas fa-stamp text-sky-400 text-xs"></i>
              <span class="text-sky-400 text-xs font-semibold">Confirm Delivery</span>
              <span class="text-[10px] text-gray-600 ml-auto">Optional — attests seller fulfilled obligation</span>
            </div>
            <p class="text-[10px] text-gray-500 mb-2">
              By attesting, you sign a message confirming the seller delivered as agreed. Your signature is stored locally for dispute evidence.
            </p>
            <button id="otc-attest-btn-${c.contractId}"
              onclick="otcAttestDelivery('${c.contractId}')"
              class="flex items-center gap-1.5 px-4 py-1.5 bg-sky-700 hover:bg-sky-600 active:bg-sky-800 text-white rounded-xl text-xs font-semibold transition shadow-md shadow-sky-900/30">
              <i class="fas fa-stamp mr-1"></i>Attest Delivery
            </button>
          </div>` : (isSeller && !hasAttestation ? `
          <div class="mt-3 pt-3 border-t border-emerald-800/20 flex items-center gap-1.5 text-[10px] text-gray-600">
            <i class="fas fa-hourglass-half text-[9px]"></i>
            Awaiting buyer attestation…
          </div>` : ''))}
        </div>`;
      } else if (canSubmitProof) {
        // ── No proof yet: show input to SELLER only ────────────────────────
        return `
        <div class="px-5 py-3 bg-amber-950/20 border-b border-amber-800/30" id="otc-proof-panel-${c.contractId}">
          <div class="flex items-center gap-2 mb-2">
            <i class="fas fa-upload text-amber-400 text-xs"></i>
            <span class="text-amber-400 text-xs font-semibold">Add Delivery Proof</span>
            <span class="text-[10px] text-gray-600 ml-auto">Required before releasing funds</span>
          </div>
          <div class="flex flex-col gap-2">
            <input type="text" id="otc-proof-input-${c.contractId}"
              placeholder="Tx hash (0x…), explorer URL, or description"
              class="w-full bg-gray-900 border border-amber-700/40 focus:border-amber-500/70 rounded-xl px-3 py-2.5 text-xs text-white font-mono placeholder-gray-600 outline-none transition"
              oninput="window._otcProofPreview('${c.contractId}')">
            <div id="otc-proof-preview-${c.contractId}" class="text-[10px] text-gray-500 min-h-[16px] px-1"></div>
            <div class="flex items-center gap-2">
              <button id="otc-proof-submit-btn-${c.contractId}"
                onclick="otcSubmitProof('${c.contractId}')"
                class="flex items-center gap-1.5 px-4 py-2 bg-amber-600 hover:bg-amber-500 active:bg-amber-700 text-white rounded-xl text-xs font-semibold transition shadow-md shadow-amber-900/30">
                <i class="fas fa-upload"></i>Submit Proof
              </button>
              <span class="text-[10px] text-gray-600">Buyer will see this immediately after submission</span>
            </div>
          </div>
        </div>`;
      } else if (isBuyer && !hasProof) {
        // ── Buyer waiting for seller proof ─────────────────────────────────
        return `
        <div class="px-5 py-3 bg-amber-950/10 border-b border-amber-800/20">
          <div class="flex items-center gap-2 text-xs text-amber-400">
            <i class="fas fa-hourglass-half text-xs"></i>
            <span class="font-semibold">Awaiting delivery proof from seller</span>
            <span class="text-[10px] text-gray-600 ml-auto">Release is blocked until proof is submitted</span>
          </div>
        </div>`;
      }
      return '';
    })()}
    <!-- ═══ END PROOF PANEL ════════════════════════════════════════════════ -->

    <!-- AWAITING_SELLER_DEPOSIT (TRUSTLESS) info -->
    ${isOnChain && c.status === 'AWAITING_SELLER_DEPOSIT' ? `
    <div class="px-5 py-3 bg-orange-950/20 border-b border-orange-800/20">
      <p class="text-orange-400 text-xs font-semibold"><i class="fas fa-hand-holding-usd mr-1"></i>TRUSTLESS — awaiting seller deposit</p>
      <p class="text-gray-500 text-xs mt-1">Buyer deposited <strong class="text-white">${_otcFmt(c.amount)} ${c.asset}</strong>. Seller must also deposit their collateral to continue.</p>
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

      <!-- Fund escrow (approve + fundDeal) — DISABLED when IN_DISPUTE -->
      ${canFund && !isDisputed ? `
      <button onclick="otcFundDeal('${c.contractId}')"
        class="flex items-center gap-1.5 px-4 py-2 bg-teal-600 hover:bg-teal-500 text-white rounded-xl text-xs font-semibold transition shadow-md shadow-teal-900/30">
        <i class="fas fa-vault"></i>Fund Escrow
      </button>` : ''}

      <!-- TRUSTLESS: Seller deposit button — DISABLED when IN_DISPUTE -->
      ${canDepositSeller && !isDisputed ? `
      <button onclick="otcDepositSeller('${c.contractId}')"
        title="Deposit your collateral (TRUSTLESS mode) — buyer has already deposited"
        class="flex items-center gap-1.5 px-4 py-2 bg-orange-600 hover:bg-orange-500 text-white rounded-xl text-xs font-semibold transition shadow-md shadow-orange-900/30">
        <i class="fas fa-hand-holding-usd"></i>Deposit (Seller)
      </button>` : ''}

      <!-- Release funds (release) — SELLER ONLY in v4, BLOCKED by IN_DISPUTE and missing proof -->
      <!-- Always show for seller in funded states — disabled when proof missing OR TGE not reached -->
      ${isSeller && !isDisputed && !isTerminal && [OTC_STATUS.FUNDED, 'AWAITING_PROOF', 'READY_TO_SETTLE'].some(s => c.status === s) ? `
        ${canRelease ? `
        <button onclick="otcReleaseDeal('${c.contractId}')"
          title="Only the seller can release funds (v4 contract requirement)"
          class="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-semibold transition shadow-md shadow-emerald-900/30">
          <i class="fas fa-paper-plane"></i>Release Funds
        </button>` : (!hasProof ? `
        <span title="Submit delivery proof above before releasing funds"
          class="flex items-center gap-1.5 px-4 py-2 bg-gray-800/60 border border-gray-700/40 text-gray-500 rounded-xl text-xs font-semibold cursor-not-allowed select-none">
          <i class="fas fa-lock text-[10px]"></i>Release Funds
          <span class="text-[10px] text-amber-500/80 font-normal">(proof required)</span>
        </span>` : `
        <span title="TGE date not yet reached — release will be available after TGE"
          class="flex items-center gap-1.5 px-4 py-2 bg-gray-800/60 border border-gray-700/40 text-gray-500 rounded-xl text-xs font-semibold cursor-not-allowed select-none">
          <i class="fas fa-hourglass-half text-[10px]"></i>Release Funds
          <span class="text-[10px] text-teal-500/80 font-normal">(TGE in ${tgeLabel})</span>
        </span>`)}
      ` : ''}

      <!-- Buyer sees info badge when TGE reached but can't release (seller must) -->
      ${isOnChain && isBuyer && !isSeller && ['FUNDED','AWAITING_PROOF','READY_TO_SETTLE'].some(s => c.status === s) && tgePast && !isDisputed ? `
      <span class="flex items-center gap-1.5 px-3 py-2 bg-emerald-900/20 border border-emerald-700/30 text-emerald-400 rounded-xl text-xs">
        <i class="fas fa-clock text-[10px]"></i>TGE reached — awaiting seller release
      </span>` : ''}

      <!-- Open Dispute button (v4: uses openDispute with reason input) -->
      ${canDispute ? `
      <button onclick="otcOpenDisputeDialog('${c.contractId}')"
        title="Open a dispute — arbiter will review and resolve. Settlement is frozen while disputed."
        class="flex items-center gap-1.5 px-4 py-2 bg-rose-900/30 hover:bg-rose-900/50 border border-rose-700/40 text-rose-400 hover:text-rose-300 rounded-xl text-xs transition">
        <i class="fas fa-gavel"></i>Open Dispute
      </button>` : ''}

      <!-- IN_DISPUTE status banner (settlement frozen) -->
      ${isOnChain && isDisputed && !isTerminal ? `
      <div class="flex items-center gap-2 flex-wrap w-full">
        <span class="flex items-center gap-1.5 px-3 py-2 bg-rose-900/20 border border-rose-700/30 text-rose-300 rounded-xl text-xs font-semibold">
          <i class="fas fa-gavel text-[10px]"></i>IN DISPUTE — Settlement frozen. Arbiter must resolve.
        </span>
        <button onclick="otcResolveDispute('${c.contractId}', true)"
          title="Arbiter only: release escrowed tokens to seller"
          class="flex items-center gap-1.5 px-3 py-2 bg-emerald-900/30 hover:bg-emerald-900/50 border border-emerald-700/40 text-emerald-400 hover:text-emerald-300 rounded-xl text-xs transition">
          <i class="fas fa-arrow-right text-[10px]"></i>Resolve → Seller
        </button>
        <button onclick="otcResolveDispute('${c.contractId}', false)"
          title="Arbiter only: refund escrowed tokens to buyer"
          class="flex items-center gap-1.5 px-3 py-2 bg-blue-900/30 hover:bg-blue-900/50 border border-blue-700/40 text-blue-400 hover:text-blue-300 rounded-xl text-xs transition">
          <i class="fas fa-undo text-[10px]"></i>Resolve → Buyer
        </button>
      </div>` : ''}

      <!-- Fund TGE countdown (funded but not yet releasable) -->
      ${isOnChain && ['FUNDED','AWAITING_PROOF','READY_TO_SETTLE'].some(s => c.status === s) && !tgePast && !isDisputed ? `
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
      const tradeModeLabel = l.tradeMode === 'TRUSTLESS'
        ? '<span class="text-[9px] px-1.5 py-0.5 rounded-full bg-orange-900/30 border border-orange-700/40 text-orange-400 font-semibold" title="Both parties deposit tokens (atomic swap)">TRUSTLESS</span>'
        : l.tradeMode === 'FLEXIBLE'
        ? '<span class="text-[9px] px-1.5 py-0.5 rounded-full bg-teal-900/30 border border-teal-700/40 text-teal-400 font-semibold" title="Buyer deposits; seller provides proof">FLEXIBLE</span>'
        : '';
      return `
      <div class="bg-gray-900/70 border border-gray-700/50 rounded-2xl p-5 hover:border-indigo-700/40 transition-all" id="listing-card-${l.id}">
        <div class="flex items-start justify-between gap-3 mb-3">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-700/30 to-purple-700/30 border border-indigo-700/30 flex items-center justify-center flex-shrink-0">
              <i class="fas fa-tags text-indigo-400 text-base"></i>
            </div>
            <div>
              <div class="flex items-center gap-1.5 flex-wrap">
                <span class="text-white font-semibold text-sm">${l.description}</span>
                ${tradeModeLabel}
              </div>
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

  // ── UI Warning: show banner if escrow contract is not configured ───────────
  // This prevents silent failures and informs users that on-chain features
  // require a valid contract address on ARC Testnet (chain 5042002).
  (function _otcInjectWarningBanner() {
    if (otcIsDeployed()) return; // Address is valid — no warning needed
    const containerId = 'otc-escrow-warning-banner';
    if (document.getElementById(containerId)) return; // Already injected
    // Find the OTC tab container (try multiple selectors)
    const container = document.getElementById('tab-otc')
      || document.querySelector('[data-tab="otc"]')
      || document.querySelector('.otc-container');
    if (!container) return;
    const banner = document.createElement('div');
    banner.id = containerId;
    banner.style.cssText = [
      'background:#7f1d1d','color:#fca5a5','border:1px solid #ef4444',
      'border-radius:8px','padding:12px 16px','margin:12px 0',
      'font-size:0.875rem','display:flex','align-items:center','gap:8px'
    ].join(';');
    banner.innerHTML =
      '<span style="font-size:1.25rem">⚠️</span>' +
      '<div>' +
        '<strong>OTC Escrow not configured</strong> — ' +
        'On-chain actions (register, fund, settle, dispute) are disabled. ' +
        'Set a valid <code>OTC_ESCROW_ADDRESS</code> in ' +
        '<code>otc-escrow-abi.js</code> and redeploy.' +
      '</div>';
    container.insertBefore(banner, container.firstChild);
  }());
  // ─────────────────────────────────────────────────────────────────────────

  // Auto-fill timezone
  const tzEl = _otcEl('otc-tge-tz');
  if (tzEl) tzEl.value = 'UTC';

  // Watch wallet for auto-fill AND trigger chain sync on connect
  let lastWallet = null;
  setInterval(() => {
    const w = window.walletState?.address;
    if (w !== lastWallet) {
      lastWallet = w;
      if (_otcSubTab === 'create') _otcAutoFillWallet();
      _otcCheckAlerts();
      // Sync from chain whenever wallet connects or changes
      if (w && otcIsDeployed()) {
        _otcLog('[INIT] Wallet changed →', w, '— triggering chain sync');
        otcSyncFromChain(w.toLowerCase());
      }
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
  window.otcRaiseDispute       = otcRaiseDispute;
  window.otcOpenDisputeDialog  = otcOpenDisputeDialog;  // v4: opens reason prompt
  window.otcResolveDispute     = otcResolveDispute;
  window.otcDepositSeller      = otcDepositSeller;       // v4: TRUSTLESS mode
  window.otcRequestCancelOnChain = otcRequestCancelOnChain;
  window.otcSyncDealStatus     = otcSyncDealStatus;
  window.otcSyncFromChain      = otcSyncFromChain;
  window.otcSubmitProof        = otcSubmitProof;
  window.otcAttestDelivery     = otcAttestDelivery;

  // ── Proof UI helpers (called inline from card HTML) ─────────────────────
  // Live preview: shows what type of proof is detected as user types
  window._otcProofPreview = function(contractId) {
    const input   = _otcEl(`otc-proof-input-${contractId}`);
    const preview = _otcEl(`otc-proof-preview-${contractId}`);
    if (!input || !preview) return;
    const val = input.value.trim();
    if (!val) { preview.textContent = ''; return; }
    if (/^0x[0-9a-fA-F]{64}$/.test(val)) {
      preview.innerHTML = '<i class="fas fa-link text-indigo-400 mr-1"></i><span class="text-indigo-400">Transaction hash detected — will link to block explorer</span>';
    } else if (/^https?:\/\//i.test(val) || /^www\./i.test(val)) {
      preview.innerHTML = '<i class="fas fa-external-link-alt text-blue-400 mr-1"></i><span class="text-blue-400">URL detected — will render as clickable link</span>';
    } else if (/^0x[0-9a-fA-F]+$/.test(val)) {
      preview.innerHTML = '<i class="fas fa-link text-indigo-400 mr-1"></i><span class="text-indigo-400">Hex value detected — will link to block explorer</span>';
    } else {
      preview.innerHTML = '<i class="fas fa-align-left text-gray-400 mr-1"></i><span class="text-gray-400">Plain text — will be displayed as-is</span>';
    }
  };

  // "Update proof" link resets proofData so seller can resubmit
  window._otcClearProofInput = function(contractId) {
    const contract = _otcContracts.find(c => c.contractId === contractId);
    if (!contract) return;
    if (!confirm('Clear the existing proof and submit a new one?')) return;
    delete contract.proofData;
    delete contract.proofTxHash;
    delete contract.proofSubmittedAt;
    contract.status    = contract.onChain ? 'AWAITING_PROOF' : OTC_STATUS.FUNDED;
    contract.updatedAt = _otcNow();
    otcSave();
    otcRenderMyContracts();
  };

  _otcLog(`Loaded | v${OTC_VERSION} | Chain ${OTC_CHAIN_ID} | Contract v4 (TradeMode, openDispute, arbiter)`);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _otcInit);
} else {
  _otcInit();
}

// ─── OTC module loaded ───────────────────────────────────────────────────────
console.log('[OTC v4] Module ready | v' + OTC_VERSION);
