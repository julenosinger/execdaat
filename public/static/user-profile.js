// build:v2-20260627-151358
// ============================================================
// ARC USER PROFILE v3 — STATELESS (Privacy-First)
// NO data persistence. All functions return empty/default values.
// Maintained for API compatibility with smart-autofill.js and chat.js
// ============================================================
'use strict';

(function () {

  // ─── NO-OP stubs (no localStorage, no sessionStorage, no IndexedDB) ──────────
  // These functions are called by other modules but intentionally do nothing.
  // The app is fully stateless regarding user inputs.

  function getUserProfile()       { return null; }
  function saveUserProfile()      { return false; }
  function getUserPreferences()   { return {}; }
  function saveUserPreferences()  { return false; }

  function getRecentAddresses()   { return []; }
  function addRecentAddress()     { /* no-op: stateless */ }
  function removeRecentAddress()  { /* no-op: stateless */ }
  function getLastAddress()       { return null; }
  function getMostUsedAddress()   { return null; }

  function getRecentAmounts()     { return []; }
  function addRecentAmount()      { /* no-op: stateless */ }
  function removeRecentAmount()   { /* no-op: stateless */ }

  function getRecentEmails()      { return []; }
  function addRecentEmail()       { /* no-op: stateless */ }
  function removeRecentEmail()    { /* no-op: stateless */ }

  function getRecentTokens()      { return []; }
  function addRecentToken()       { /* no-op: stateless */ }
  function getMostUsedToken()     { return null; }

  function saveContractParams()   { /* no-op: stateless */ }
  function getContractParams()    { return null; }

  function learnFromPaymentHistory()  { /* no-op: stateless */ }
  function learnFromContractHistory() { /* no-op: stateless */ }

  function clearAllProfileData() {
    // Also clear any previously stored data from older versions
    try {
      const keysToRemove = [
        'arc_user_profile', 'arc_user_prefs',
        'arc_recent_addresses', 'arc_recent_amounts',
        'arc_recent_emails', 'arc_recent_tokens',
        'arc_contract_params', 'arc_profile_purged_v2',
      ];
      keysToRemove.forEach(k => localStorage.removeItem(k));
    } catch (_) {}
    window.dispatchEvent(new CustomEvent('arcProfileCleared'));
  }

  function syncWalletToProfile()  { /* no-op: stateless */ }
  function getProfileScore()      { return 0; }

  // ─── One-time cleanup: remove any data stored by older versions ──────────────
  // NOTE: must be a named function declaration (not IIFE with name) so the
  // reference is accessible for window.arcPurgeFakeData assignment below.
  function cleanupLegacyData() {
    try {
      const legacyKeys = [
        'arc_user_profile', 'arc_user_prefs',
        'arc_recent_addresses', 'arc_recent_amounts',
        'arc_recent_emails', 'arc_recent_tokens',
        'arc_contract_params',
      ];
      legacyKeys.forEach(k => localStorage.removeItem(k));
    } catch (_) {}
  }
  cleanupLegacyData(); // run once on load

  // ─── Expose API (all stubs) ───────────────────────────────────────────────────
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

  window.arcPurgeFakeData       = cleanupLegacyData;
  window.cleanupLegacyData      = cleanupLegacyData; // expose globally to avoid ReferenceError
  window.arcClearRecentData     = clearAllProfileData;

})();
