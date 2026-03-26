// ============================================================
// ARC USER PROFILE v2 — Smart Persistence for Payments & Contracts
// Stores: name, email, wallet, tokens, recent addresses, amounts
// Keys: arc_user_profile, arc_user_prefs, arc_recent_addresses,
//       arc_recent_amounts, arc_recent_emails, arc_recent_tokens
// Security: NO private keys · NO seed phrases · Local only
// v2: purge of fake/seed data — only real user transactions kept
// ============================================================
'use strict';

(function () {

  // ─── Storage Keys ────────────────────────────────────────────────────────────
  const KEY_PROFILE     = 'arc_user_profile';
  const KEY_PREFS       = 'arc_user_prefs';
  const KEY_ADDRESSES   = 'arc_recent_addresses';   // [{addr, label, count, last}]
  const KEY_AMOUNTS     = 'arc_recent_amounts';     // [{value, token, count, last}]
  const KEY_EMAILS      = 'arc_recent_emails';      // [{email, label, count, last}]
  const KEY_TOKENS      = 'arc_recent_tokens';      // [{symbol, count, last}]
  const KEY_CF_PARAMS   = 'arc_contract_params';    // last contract form state
  const KEY_PURGE_STAMP = 'arc_profile_purged_v2';  // purge version stamp
  const MAX_ADDR        = 10;
  const MAX_AMOUNTS     = 8;
  const MAX_EMAILS      = 6;

  // ─── Safe localStorage helpers ───────────────────────────────────────────────
  function _get(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; }
  }
  function _set(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch (_) { return false; }
  }
  function _del(key) {
    try { localStorage.removeItem(key); } catch (_) {}
  }

  // ─── ONE-TIME PURGE: remove fake/seed/demo data injected before v2 ──────────
  // Runs once per browser. Clears amounts and addresses that were NOT generated
  // from real on-chain transactions (they lack a valid `last` timestamp anchored
  // to a real dispatch event, or were inserted in testing sessions).
  // After purge, only data captured via capturePaymentData/captureContractData
  // or learnFromPaymentHistory (real tx history) will remain.
  function purgeFakeData() {
    if (localStorage.getItem(KEY_PURGE_STAMP)) return; // already purged

    try {
      // Clear ALL recent amounts and addresses — they may contain test/fake data.
      // Real data will be re-populated from the user's actual transaction history
      // the moment loadPayments() / loadContracts() fires arcPayHistoryLoaded.
      _del(KEY_AMOUNTS);
      _del(KEY_ADDRESSES);
      _del(KEY_EMAILS);
      _del(KEY_CF_PARAMS);

      // Mark as purged so this never runs again
      localStorage.setItem(KEY_PURGE_STAMP, Date.now().toString());
      console.log('[PROFILE v2] One-time purge of fake/seed data completed — recent amounts & addresses cleared');
    } catch (e) {
      console.warn('[PROFILE v2] Purge failed:', e.message);
    }
  }

  // ─── getUserProfile ───────────────────────────────────────────────────────────
  function getUserProfile() {
    return _get(KEY_PROFILE) || { name: '', email: '', wallet: '', createdAt: null, updatedAt: null };
  }

  // ─── saveUserProfile ─────────────────────────────────────────────────────────
  function saveUserProfile(data) {
    if (!data || typeof data !== 'object') return false;
    // SECURITY: Never store private keys or seed phrases
    const safe = {
      name:      (data.name      || '').trim().slice(0, 80),
      email:     (data.email     || '').trim().slice(0, 120),
      wallet:    (data.wallet    || '').trim().toLowerCase().slice(0, 42),
      createdAt: getUserProfile().createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // Auto-add email to recent emails if valid
    if (safe.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(safe.email)) {
      addRecentEmail(safe.email, safe.name || '');
    }
    const ok = _set(KEY_PROFILE, safe);
    window.dispatchEvent(new CustomEvent('arcProfileUpdated', { detail: safe }));
    return ok;
  }

  // ─── getUserPreferences ──────────────────────────────────────────────────────
  function getUserPreferences() {
    return _get(KEY_PREFS) || {
      defaultToken:     'USDC',
      autofill:         true,
      showSuggestions:  true,
      rememberAmounts:  true,
      rememberAddresses:true,
      lang:             'en',
      updatedAt:        null,
    };
  }

  // ─── saveUserPreferences ─────────────────────────────────────────────────────
  function saveUserPreferences(data) {
    if (!data || typeof data !== 'object') return false;
    const current = getUserPreferences();
    const merged = { ...current, ...data, updatedAt: new Date().toISOString() };
    return _set(KEY_PREFS, merged);
  }

  // ─── Recent Addresses ────────────────────────────────────────────────────────
  function getRecentAddresses() {
    return _get(KEY_ADDRESSES) || [];
  }

  function addRecentAddress(addr, label) {
    if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) return;
    const list = getRecentAddresses();
    const idx  = list.findIndex(a => a.addr.toLowerCase() === addr.toLowerCase());
    if (idx >= 0) {
      list[idx].count++;
      list[idx].last  = Date.now();
      list[idx].label = label || list[idx].label || '';
    } else {
      list.unshift({ addr: addr.toLowerCase(), label: label || '', count: 1, last: Date.now() });
    }
    list.sort((a, b) => b.count - a.count);
    _set(KEY_ADDRESSES, list.slice(0, MAX_ADDR));
  }

  function removeRecentAddress(addr) {
    const list = getRecentAddresses().filter(a => a.addr.toLowerCase() !== addr.toLowerCase());
    _set(KEY_ADDRESSES, list);
    window.dispatchEvent(new CustomEvent('arcProfileUpdated'));
  }

  function getLastAddress() {
    const list = getRecentAddresses();
    if (!list.length) return null;
    return list.sort((a, b) => b.last - a.last)[0];
  }

  function getMostUsedAddress() {
    const list = getRecentAddresses();
    if (!list.length) return null;
    return list.sort((a, b) => b.count - a.count)[0];
  }

  // ─── Recent Amounts ──────────────────────────────────────────────────────────
  function getRecentAmounts() {
    return _get(KEY_AMOUNTS) || [];
  }

  function addRecentAmount(value, token) {
    if (!value || isNaN(parseFloat(value))) return;
    const normalized = String(parseFloat(value));
    const tk = (token || 'USDC').toUpperCase();
    const list = getRecentAmounts();
    const idx  = list.findIndex(a => a.value === normalized && a.token === tk);
    if (idx >= 0) {
      list[idx].count++;
      list[idx].last = Date.now();
    } else {
      list.unshift({ value: normalized, token: tk, count: 1, last: Date.now() });
    }
    list.sort((a, b) => b.count - a.count);
    _set(KEY_AMOUNTS, list.slice(0, MAX_AMOUNTS));
  }

  function removeRecentAmount(value, token) {
    const tk   = (token || '').toUpperCase();
    const list = getRecentAmounts().filter(a => !(a.value === String(value) && a.token === tk));
    _set(KEY_AMOUNTS, list);
    window.dispatchEvent(new CustomEvent('arcProfileUpdated'));
  }

  // ─── Recent Emails ───────────────────────────────────────────────────────────
  function getRecentEmails() {
    return _get(KEY_EMAILS) || [];
  }

  function addRecentEmail(email, label) {
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
    const norm = email.toLowerCase().trim();
    const list = getRecentEmails();
    const idx  = list.findIndex(e => e.email === norm);
    if (idx >= 0) {
      list[idx].count++;
      list[idx].last  = Date.now();
      list[idx].label = label || list[idx].label || '';
    } else {
      list.unshift({ email: norm, label: label || '', count: 1, last: Date.now() });
    }
    list.sort((a, b) => b.count - a.count);
    _set(KEY_EMAILS, list.slice(0, MAX_EMAILS));
  }

  function removeRecentEmail(email) {
    const list = getRecentEmails().filter(e => e.email !== email.toLowerCase());
    _set(KEY_EMAILS, list);
    window.dispatchEvent(new CustomEvent('arcProfileUpdated'));
  }

  // ─── Recent Tokens ───────────────────────────────────────────────────────────
  function getRecentTokens() {
    return _get(KEY_TOKENS) || [{ symbol: 'USDC', count: 1, last: Date.now() }];
  }

  function addRecentToken(symbol) {
    if (!symbol) return;
    const sym  = symbol.toUpperCase();
    const list = getRecentTokens();
    const idx  = list.findIndex(t => t.symbol === sym);
    if (idx >= 0) { list[idx].count++; list[idx].last = Date.now(); }
    else { list.unshift({ symbol: sym, count: 1, last: Date.now() }); }
    list.sort((a, b) => b.count - a.count);
    _set(KEY_TOKENS, list.slice(0, 5));
  }

  function getMostUsedToken() {
    const list = getRecentTokens();
    return list.length ? list[0].symbol : 'USDC';
  }

  // ─── Contract Parameters ─────────────────────────────────────────────────────
  function saveContractParams(params) {
    if (!params) return;
    _set(KEY_CF_PARAMS, { ...params, savedAt: Date.now() });
  }

  function getContractParams() {
    return _get(KEY_CF_PARAMS) || {};
  }

  // ─── Auto-capture from existing transaction history ──────────────────────────
  function learnFromPaymentHistory(payments) {
    if (!Array.isArray(payments)) return;
    for (const tx of payments) {
      if (tx.recipient || tx.to) addRecentAddress(tx.recipient || tx.to, tx.recipientName || '');
      if (tx.amount)             addRecentAmount(tx.amount, tx.token || 'USDC');
      if (tx.token)              addRecentToken(tx.token);
      if (tx.recipientEmail)     addRecentEmail(tx.recipientEmail, tx.recipientName || '');
    }
  }

  function learnFromContractHistory(contracts) {
    if (!Array.isArray(contracts)) return;
    for (const c of contracts) {
      if (c.contractor)      addRecentAddress(c.contractor, c.contractorName || '');
      if (c.totalValue || c.value) addRecentAmount(c.totalValue || c.value, 'USDC');
      if (c.contractorEmail) addRecentEmail(c.contractorEmail, '');
      if (c.clientEmail)     addRecentEmail(c.clientEmail, '');
    }
  }

  // ─── Clear all profile data ───────────────────────────────────────────────────
  function clearAllProfileData() {
    [KEY_PROFILE, KEY_PREFS, KEY_ADDRESSES, KEY_AMOUNTS, KEY_EMAILS, KEY_TOKENS, KEY_CF_PARAMS]
      .forEach(_del);
    window.dispatchEvent(new CustomEvent('arcProfileCleared'));
    console.log('[PROFILE] All profile data cleared');
  }

  // ─── Auto-sync wallet address to profile ─────────────────────────────────────
  function syncWalletToProfile() {
    const addr = window.walletState?.address;
    if (!addr) return;
    const profile = getUserProfile();
    if (profile.wallet !== addr.toLowerCase()) {
      saveUserProfile({ ...profile, wallet: addr });
    }
  }

  // ─── Profile completeness score (0-100) ─────────────────────────────────────
  function getProfileScore() {
    const p = getUserProfile();
    let score = 0;
    if (p.name)   score += 25;
    if (p.email)  score += 25;
    if (p.wallet) score += 25;
    if (getRecentAddresses().length > 0) score += 15;
    if (getRecentAmounts().length > 0)   score += 10;
    return score;
  }

  // ─── Expose globals ──────────────────────────────────────────────────────────
  window.getUserProfile         = getUserProfile;
  window.saveUserProfile        = saveUserProfile;
  window.getUserPreferences     = getUserPreferences;
  window.saveUserPreferences    = saveUserPreferences;
  window.getRecentAddresses     = getRecentAddresses;
  window.addRecentAddress       = addRecentAddress;
  window.removeRecentAddress    = removeRecentAddress;
  window.getLastAddress         = getLastAddress;
  window.getMostUsedAddress     = getMostUsedAddress;
  window.getRecentAmounts       = getRecentAmounts;
  window.addRecentAmount        = addRecentAmount;
  window.removeRecentAmount     = removeRecentAmount;
  window.getRecentEmails        = getRecentEmails;
  window.addRecentEmail         = addRecentEmail;
  window.removeRecentEmail      = removeRecentEmail;
  window.getRecentTokens        = getRecentTokens;
  window.addRecentToken         = addRecentToken;
  window.getMostUsedToken       = getMostUsedToken;
  window.saveContractParams     = saveContractParams;
  window.getContractParams      = getContractParams;
  window.learnFromPaymentHistory  = learnFromPaymentHistory;
  window.learnFromContractHistory = learnFromContractHistory;
  window.clearAllProfileData    = clearAllProfileData;
  window.syncWalletToProfile    = syncWalletToProfile;
  window.getProfileScore        = getProfileScore;
  // Expose purge for manual use in console if needed
  window.arcPurgeFakeData       = purgeFakeData;
  window.arcClearRecentData     = function() {
    _del(KEY_AMOUNTS); _del(KEY_ADDRESSES); _del(KEY_EMAILS); _del(KEY_CF_PARAMS);
    // Remove purge stamp so purge can run again next load if desired
    localStorage.removeItem(KEY_PURGE_STAMP);
    window.dispatchEvent(new CustomEvent('arcProfileUpdated'));
    console.log('[PROFILE v2] Recent amounts, addresses and emails cleared manually');
  };

  // ─── Auto-sync on wallet connect ─────────────────────────────────────────────
  window.addEventListener('walletConnected', () => {
    setTimeout(syncWalletToProfile, 300);
  });

  // ─── Run one-time purge on first load ─────────────────────────────────────────
  purgeFakeData();

  console.log('[PROFILE v2] User profile module loaded — localStorage secured, no keys stored');

})();
