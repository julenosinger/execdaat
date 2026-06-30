// build:v2-20260627-151358
// ============================================================
// ARC Persistence Layer v1 — Hybrid IndexedDB + localStorage
// Scoped per wallet · Cross-session · Background sync
// Supports: Payments · Contracts · History
// ============================================================
'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const ARC_DB_NAME       = 'arc_agents_db';
const ARC_DB_VERSION    = 4; // v4: added otc_deals store
const ARC_STORE_PAY     = 'payments';
const ARC_STORE_CF      = 'contracts';
const ARC_STORE_HIST    = 'history';
const ARC_STORE_META    = 'meta';
const ARC_STORE_OTC     = 'otc_deals';   // OTC escrow contracts
const ARC_MAX_RECORDS   = 50;
const ARC_SYNC_INTERVAL = 30000; // 30s background sync

// ─── State ────────────────────────────────────────────────────────────────────
const arcPersist = {
  db:           null,
  ready:        false,
  wallet:       null,
  online:       navigator.onLine,
  syncTimer:    null,
  offlineBar:   null,
};

// ─── IndexedDB Init ───────────────────────────────────────────────────────────
function arcDBOpen() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) { resolve(null); return; }

    const req = indexedDB.open(ARC_DB_NAME, ARC_DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      // Payments store
      if (!db.objectStoreNames.contains(ARC_STORE_PAY)) {
        const s = db.createObjectStore(ARC_STORE_PAY, { keyPath: 'id' });
        s.createIndex('wallet',    'wallet',    { unique: false });
        s.createIndex('status',    'status',    { unique: false });
        s.createIndex('timestamp', 'timestamp', { unique: false });
      }

      // Contracts store
      if (!db.objectStoreNames.contains(ARC_STORE_CF)) {
        const s = db.createObjectStore(ARC_STORE_CF, { keyPath: 'id' });
        s.createIndex('wallet',    'wallet',    { unique: false });
        s.createIndex('status',    'status',    { unique: false });
        s.createIndex('timestamp', 'timestamp', { unique: false });
      }

      // History store
      if (!db.objectStoreNames.contains(ARC_STORE_HIST)) {
        const s = db.createObjectStore(ARC_STORE_HIST, { keyPath: 'id' });
        s.createIndex('wallet',    'wallet',    { unique: false });
        s.createIndex('txHash',    'txHash',    { unique: false });
        s.createIndex('timestamp', 'timestamp', { unique: false });
      }

      // Meta store (app-level KV)
      if (!db.objectStoreNames.contains(ARC_STORE_META)) {
        db.createObjectStore(ARC_STORE_META, { keyPath: 'key' });
      }

      // OTC Deals store
      if (!db.objectStoreNames.contains(ARC_STORE_OTC)) {
        const s = db.createObjectStore(ARC_STORE_OTC, { keyPath: 'contractId' });
        s.createIndex('buyer',     'buyer',     { unique: false });
        s.createIndex('seller',    'seller',    { unique: false });
        s.createIndex('status',    'status',    { unique: false });
        s.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };

    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => { console.warn('[PERSIST] IndexedDB error:', e.target.error); resolve(null); };
  });
}

// ─── Generic IDB operations ────────────────────────────────────────────────────
function arcDBPut(store, record) {
  return new Promise((resolve) => {
    if (!arcPersist.db) { resolve(false); return; }
    try {
      const tx  = arcPersist.db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).put(record);
      req.onsuccess = () => resolve(true);
      req.onerror   = () => resolve(false);
    } catch (_) { resolve(false); }
  });
}

function arcDBGet(store, key) {
  return new Promise((resolve) => {
    if (!arcPersist.db) { resolve(null); return; }
    try {
      const tx  = arcPersist.db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = (e) => resolve(e.target.result || null);
      req.onerror   = () => resolve(null);
    } catch (_) { resolve(null); }
  });
}

function arcDBGetAll(store) {
  return new Promise((resolve) => {
    if (!arcPersist.db) { resolve([]); return; }
    try {
      const tx  = arcPersist.db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = (e) => resolve(e.target.result || []);
      req.onerror   = () => resolve([]);
    } catch (_) { resolve([]); }
  });
}

function arcDBGetByIndex(store, indexName, value) {
  return new Promise((resolve) => {
    if (!arcPersist.db) { resolve([]); return; }
    try {
      const tx    = arcPersist.db.transaction(store, 'readonly');
      const idx   = tx.objectStore(store).index(indexName);
      const req   = idx.getAll(value);
      req.onsuccess = (e) => resolve(e.target.result || []);
      req.onerror   = () => resolve([]);
    } catch (_) { resolve([]); }
  });
}

function arcDBDelete(store, key) {
  return new Promise((resolve) => {
    if (!arcPersist.db) { resolve(false); return; }
    try {
      const tx  = arcPersist.db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).delete(key);
      req.onsuccess = () => resolve(true);
      req.onerror   = () => resolve(false);
    } catch (_) { resolve(false); }
  });
}

function arcDBClear(store) {
  return new Promise((resolve) => {
    if (!arcPersist.db) { resolve(false); return; }
    try {
      const tx  = arcPersist.db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).clear();
      req.onsuccess = () => resolve(true);
      req.onerror   = () => resolve(false);
    } catch (_) { resolve(false); }
  });
}

// ─── localStorage fallback helpers ────────────────────────────────────────────
function arcLS_get(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; }
}

function arcLS_set(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch (_) { return false; }
}

function arcLS_key(store, wallet) {
  return `arc_${store}_${wallet ? wallet.toLowerCase().slice(0,10) : 'global'}`;
}

// ─── Wallet-scoped key ─────────────────────────────────────────────────────────
function arcWalletKey() {
  return (window.walletState?.address || '').toLowerCase();
}

// ─── Save a record (IndexedDB + localStorage fallback) ───────────────────────
async function arcSave(store, record) {
  const wallet = arcWalletKey();
  const enriched = {
    ...record,
    wallet: wallet || record.wallet || 'anonymous',
    _savedAt: new Date().toISOString(),
    _source: 'local',
  };

  // Try IndexedDB first
  let ok = false;
  if (arcPersist.db) {
    ok = await arcDBPut(store, enriched);
  }

  // Always mirror to localStorage as backup
  try {
    const lsKey = arcLS_key(store, enriched.wallet);
    const existing = arcLS_get(lsKey) || [];
    const filtered = existing.filter(r => r.id !== enriched.id);
    filtered.unshift(enriched);
    arcLS_set(lsKey, filtered.slice(0, ARC_MAX_RECORDS));
  } catch (_) {}

  return ok;
}

// ─── Load all records for current wallet ────────────────────────────────────
async function arcLoad(store) {
  const wallet = arcWalletKey();
  if (!wallet) return [];

  // Try IndexedDB first
  if (arcPersist.db) {
    try {
      const items = await arcDBGetByIndex(store, 'wallet', wallet);
      if (items && items.length > 0) {
        return items.sort((a, b) => {
          const ta = a.timestamp || a.createdAt || a._savedAt || 0;
          const tb = b.timestamp || b.createdAt || b._savedAt || 0;
          return new Date(tb) - new Date(ta);
        });
      }
    } catch (_) {}
  }

  // Fallback to localStorage
  const lsKey = arcLS_key(store, wallet);
  return arcLS_get(lsKey) || [];
}

// ─── Update record status (merge, not overwrite) ────────────────────────────
async function arcUpdateStatus(store, id, newStatus, extra = {}) {
  if (!id) return;
  const wallet = arcWalletKey();

  // Update in IndexedDB
  if (arcPersist.db) {
    try {
      const existing = await arcDBGet(store, id);
      if (existing) {
        const updated = { ...existing, status: newStatus, ...extra, _updatedAt: new Date().toISOString() };
        await arcDBPut(store, updated);
      }
    } catch (_) {}
  }

  // Update in localStorage
  try {
    const lsKey = arcLS_key(store, wallet);
    const list  = arcLS_get(lsKey) || [];
    const idx   = list.findIndex(r => r.id === id);
    if (idx >= 0) {
      list[idx] = { ...list[idx], status: newStatus, ...extra, _updatedAt: new Date().toISOString() };
      arcLS_set(lsKey, list);
    }
  } catch (_) {}
}

// ─── Merge on-chain item with local record ───────────────────────────────────
async function arcMergeOnChain(store, onChainItems) {
  if (!onChainItems || !onChainItems.length) return;
  const wallet = arcWalletKey();

  for (const item of onChainItems) {
    if (!item.txHash && !item.id) continue;

    // Check if we already have this by txHash
    const existingId = item.id || ('onchain_' + item.txHash);
    const existing   = arcPersist.db ? await arcDBGet(store, existingId) : null;

    if (existing) {
      // Update status from on-chain truth
      const newStatus = item.status || 'confirmed';
      if (existing.status !== newStatus) {
        await arcUpdateStatus(store, existingId, newStatus, { _source: 'onchain' });
      }
    } else {
      // New on-chain item not in local store → save it
      await arcSave(store, {
        ...item,
        id: existingId,
        wallet: wallet,
        _source: 'onchain',
        status: item.status || 'confirmed',
      });
    }
  }
}

// ─── Clear local data (manual, per store or all) ─────────────────────────────
async function arcClearLocal(store) {
  const wallet = arcWalletKey();
  if (!wallet) return;

  if (store) {
    // Clear specific store
    if (arcPersist.db) {
      // Delete only records for this wallet
      try {
        const items = await arcDBGetByIndex(store, 'wallet', wallet);
        const tx    = arcPersist.db.transaction(store, 'readwrite');
        const os    = tx.objectStore(store);
        for (const item of items) os.delete(item.id);
      } catch (_) {}
    }
    const lsKey = arcLS_key(store, wallet);
    localStorage.removeItem(lsKey);
  } else {
    // Clear all stores
    for (const s of [ARC_STORE_PAY, ARC_STORE_CF, ARC_STORE_HIST]) {
      if (arcPersist.db) {
        try {
          const items = await arcDBGetByIndex(s, 'wallet', wallet);
          const tx    = arcPersist.db.transaction(s, 'readwrite');
          const os    = tx.objectStore(s);
          for (const item of items) os.delete(item.id);
        } catch (_) {}
      }
      localStorage.removeItem(arcLS_key(s, wallet));
    }
  }

  if (typeof showToast === 'function') showToast('🗑 Local data cleared', 'info');
  console.log('[PERSIST] Local data cleared for wallet:', wallet);
}

// ─── Offline indicator ────────────────────────────────────────────────────────
function arcUpdateOfflineBar() {
  let bar = document.getElementById('arc-offline-bar');

  if (!arcPersist.online) {
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'arc-offline-bar';
      bar.className = 'arc-offline-bar';
      bar.innerHTML = `
        <i class="fas fa-wifi-slash"></i>
        <span>Offline Mode — Showing Cached Data. Will sync automatically when back online.</span>
        <button onclick="arcRetryOnline()" class="arc-offline-retry">Retry</button>
      `;
      // Insert after header or at top of body
      const header = document.querySelector('.app-header, header, #app-header');
      if (header && header.parentNode) {
        header.parentNode.insertBefore(bar, header.nextSibling);
      } else {
        document.body.insertBefore(bar, document.body.firstChild);
      }
      arcPersist.offlineBar = bar;
    }
    bar.style.display = 'flex';
  } else {
    if (bar) bar.style.display = 'none';
  }
}

function arcRetryOnline() {
  arcPersist.online = navigator.onLine;
  arcUpdateOfflineBar();
  if (arcPersist.online) {
    arcTriggerSync();
  }
}

// ─── Background sync ─────────────────────────────────────────────────────────
function arcTriggerSync() {
  if (!arcPersist.online) return;
  // Dispatch custom event so individual modules can listen and sync
  window.dispatchEvent(new CustomEvent('arcSyncRequest', {
    detail: { wallet: arcWalletKey(), timestamp: Date.now() }
  }));
}

function arcStartSync() {
  if (arcPersist.syncTimer) clearInterval(arcPersist.syncTimer);
  arcPersist.syncTimer = setInterval(() => {
    if (arcPersist.online && arcWalletKey()) {
      arcTriggerSync();
    }
  }, ARC_SYNC_INTERVAL);
}

// ─── Status badge renderer (unified across modules) ──────────────────────────
function arcStatusBadge(status) {
  const map = {
    pending:    { cls: 'arc-badge-pending',    icon: '⏳', label: 'Pending'    },
    scheduled:  { cls: 'arc-badge-scheduled',  icon: '⏰', label: 'Scheduled'  },
    processing: { cls: 'arc-badge-processing', icon: '⚡', label: 'Processing' },
    completed:  { cls: 'arc-badge-completed',  icon: '✓',  label: 'Completed'  },
    confirmed:  { cls: 'arc-badge-completed',  icon: '✓',  label: 'Confirmed'  },
    failed:     { cls: 'arc-badge-failed',     icon: '✗',  label: 'Failed'     },
    cancelled:  { cls: 'arc-badge-cancelled',  icon: '—',  label: 'Cancelled'  },
    cached:     { cls: 'arc-badge-cached',     icon: '📦', label: 'Cached'     },
    synced:     { cls: 'arc-badge-synced',     icon: '✓',  label: 'Synced'     },
    partial:    { cls: 'arc-badge-partial',    icon: '~',  label: 'Partial'    },
    draft:      { cls: 'arc-badge-pending',    icon: '📝', label: 'Draft'      },
    active:     { cls: 'arc-badge-processing', icon: '⚡', label: 'Active'     },
  };
  const s = (status || 'pending').toLowerCase();
  const m = map[s] || { cls: 'arc-badge-pending', icon: '—', label: status || '—' };
  return `<span class="${m.cls}">${m.icon} ${m.label}</span>`;
}

// ─── Retry button for failed items ───────────────────────────────────────────
function arcRetryBtn(store, id) {
  return `<button class="arc-retry-btn" onclick="arcRetryItem('${store}','${id}')" title="Retry">
    <i class="fas fa-redo"></i> Retry
  </button>`;
}

async function arcRetryItem(store, id) {
  if (store === ARC_STORE_PAY) {
    // Find the local record and re-execute
    const items = await arcLoad(ARC_STORE_PAY);
    const item  = items.find(r => r.id === id);
    if (!item) { showToast('Record not found', 'error'); return; }

    // Re-fill the payment form
    const fields = {
      'pay-fullname':  item.fullname  || item.senderName || '',
      'pay-email':     item.email     || '',
      'pay-recipient': item.recipient || item.to || '',
      'pay-amount':    item.amount    ? String(item.amount) : '',
    };
    for (const [id2, val] of Object.entries(fields)) {
      const el = document.getElementById(id2);
      if (el) el.value = val;
    }
    const noteEl = document.getElementById('pay-note');
    if (noteEl) noteEl.value = item.note || '';

    if (typeof selectPayToken === 'function') selectPayToken(item.token || 'USDC');
    if (typeof updatePayPreview === 'function') updatePayPreview();
    if (typeof payValidateForm === 'function') payValidateForm();

    showToast('✏️ Payment form pre-filled. Review and submit.', 'info');
    document.getElementById('pay-fullname')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// ─── Init ──────────────────────────────────────────────────────────────────────
async function arcPersistInit() {
  try {
    arcPersist.db = await arcDBOpen();
    arcPersist.ready = true;
    arcPersist.wallet = arcWalletKey();

    console.log('[PERSIST] IndexedDB ready:', !!arcPersist.db, '| Wallet:', arcPersist.wallet || '(none)');
  } catch (e) {
    console.warn('[PERSIST] Init error:', e.message, '— falling back to localStorage');
    arcPersist.db    = null;
    arcPersist.ready = true;
  }

  // Network listeners
  window.addEventListener('online',  () => {
    arcPersist.online = true;
    arcUpdateOfflineBar();
    arcTriggerSync();
    if (typeof showToast === 'function') showToast('🌐 Back online — syncing…', 'info');
  });
  window.addEventListener('offline', () => {
    arcPersist.online = false;
    arcUpdateOfflineBar();
    if (typeof showToast === 'function') showToast('📶 Offline — using cached data', 'warning');
  });

  // Update offline bar state
  arcUpdateOfflineBar();

  // Start background sync
  arcStartSync();

  // Re-scope when wallet changes
  window.addEventListener('walletConnected', (e) => {
    arcPersist.wallet = (e.detail?.address || window.walletState?.address || '').toLowerCase();
    console.log('[PERSIST] Wallet scoped to:', arcPersist.wallet);
    arcTriggerSync();
  });
  window.addEventListener('walletDisconnected', () => {
    arcPersist.wallet = null;
  });
}

// ─── Statistics (for settings/debug) ─────────────────────────────────────────
async function arcPersistStats() {
  const wallet = arcWalletKey();
  const [pays, cfs, hists] = await Promise.all([
    arcLoad(ARC_STORE_PAY),
    arcLoad(ARC_STORE_CF),
    arcLoad(ARC_STORE_HIST),
  ]);
  return {
    wallet,
    payments:  pays.length,
    contracts: cfs.length,
    history:   hists.length,
    db:        !!arcPersist.db,
    online:    arcPersist.online,
    ready:     arcPersist.ready,
  };
}

// ─── UI Stats display (for settings panel) ───────────────────────────────────
async function arcShowPersistStats() {
  const stats = await arcPersistStats();
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('ps-payments',  stats.payments  + ' records');
  set('ps-contracts', stats.contracts + ' records');
  set('ps-history',   stats.history   + ' records');
  set('ps-db',        stats.db ? 'IndexedDB ✓' : 'localStorage fallback');
  set('ps-online',    stats.online ? '🌐 Online' : '📶 Offline');
}

window.arcShowPersistStats = arcShowPersistStats;

// Auto-refresh stats when settings panel is opened
window.addEventListener('settingsOpened', arcShowPersistStats);

// ─── OTC-specific persistence helpers ─────────────────────────────────────────
// arcSaveOTC(contracts): writes the full array to IndexedDB + localStorage
// arcLoadOTC():          reads from IndexedDB first, falls back to localStorage

const OTC_IDB_BULK_KEY = 'execDaat_otc_contracts_idb'; // key used for LS fallback

async function arcSaveOTC(contracts) {
  if (!Array.isArray(contracts)) return;

  // 1. Always write to localStorage first (synchronous, most reliable)
  try {
    localStorage.setItem('execDaat_otc_contracts', JSON.stringify(contracts));
    localStorage.setItem('execDaat_otc_contracts_bk', JSON.stringify({
      ts:   Date.now(),
      data: contracts,
    }));
  } catch(e) { console.warn('[PERSIST] OTC localStorage write failed:', e.message); }

  // 2. Write each record to IndexedDB
  if (!arcPersist.db) return;
  try {
    const tx = arcPersist.db.transaction(ARC_STORE_OTC, 'readwrite');
    const os = tx.objectStore(ARC_STORE_OTC);
    for (const c of contracts) {
      if (c && c.contractId) os.put(c);
    }
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
    });
  } catch(e) { console.warn('[PERSIST] OTC IndexedDB write failed:', e.message); }
}

async function arcLoadOTC() {
  // 1. Try IndexedDB first
  if (arcPersist.db) {
    try {
      const items = await arcDBGetAll(ARC_STORE_OTC);
      if (items && items.length > 0) {
        const sorted = items.sort((a, b) =>
          new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
        return sorted;
      }
    } catch(e) { console.warn('[PERSIST] OTC IndexedDB read failed:', e.message); }
  }

  // 2. Fall back to localStorage primary key
  try {
    const raw = localStorage.getItem('execDaat_otc_contracts');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch(_) {}

  // 3. Fall back to backup key
  try {
    const bk = localStorage.getItem('execDaat_otc_contracts_bk');
    if (bk) {
      const parsed = JSON.parse(bk);
      if (parsed && Array.isArray(parsed.data) && parsed.data.length > 0) {
        console.log('[PERSIST] OTC restored from backup key:', parsed.data.length, 'contracts');
        return parsed.data;
      }
    }
  } catch(_) {}

  return [];
}

// ─── Global exports ────────────────────────────────────────────────────────────
window.arcPersist       = arcPersist;
window.arcSave          = arcSave;
window.arcLoad          = arcLoad;
window.arcUpdateStatus  = arcUpdateStatus;
window.arcMergeOnChain  = arcMergeOnChain;
window.arcClearLocal    = arcClearLocal;
window.arcStatusBadge   = arcStatusBadge;
window.arcRetryBtn      = arcRetryBtn;
window.arcRetryItem     = arcRetryItem;
window.arcPersistInit   = arcPersistInit;
window.arcPersistStats  = arcPersistStats;
window.arcTriggerSync   = arcTriggerSync;
window.arcRetryOnline   = arcRetryOnline;
window.ARC_STORE_PAY    = ARC_STORE_PAY;
window.ARC_STORE_CF     = ARC_STORE_CF;
window.ARC_STORE_HIST   = ARC_STORE_HIST;
window.ARC_STORE_OTC    = ARC_STORE_OTC;
window.arcSaveOTC       = arcSaveOTC;
window.arcLoadOTC       = arcLoadOTC;

// Auto-init on DOMContentLoaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', arcPersistInit);
} else {
  arcPersistInit();
}

console.log('[PERSIST v1] Module loaded — IndexedDB + localStorage hybrid | Wallet-scoped | Offline support');
