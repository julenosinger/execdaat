// ============================================================
// ExecDaat Address Helpers
// ============================================================
;(function() {
  'use strict';
  var D = window.ExecDaat = window.ExecDaat || {};

  // ─── Validate EVM address (0x + 40 hex chars) ────────────────────────
  D.isAddress = function(addr) {
    return typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr);
  };

  D.isValidAddress = D.isAddress;   // alias
  D.isValidEthAddress = D.isAddress; // alias

  // ─── Normalize address to lowercase ────────────────────────────────────
  D.normalizeAddress = function(addr) {
    if (!addr || typeof addr !== 'string') return '';
    return addr.toLowerCase().trim();
  };

  // ─── Compare two addresses (case-insensitive) ──────────────────────────
  D.sameAddress = function(a, b) {
    return D.normalizeAddress(a) === D.normalizeAddress(b);
  };

  // ─── Shorten address for display ───────────────────────────────────────
  // (delegates to the formatting module if loaded; self-contained otherwise)
  D.shortAddress = function(addr) {
    if (!addr || typeof addr !== 'string') return '?';
    return addr.slice(0, 6) + '...' + addr.slice(-4);
  };

  // ─── Encode address with padding (for ABI encoding) ────────────────────
  D.encodeAddress = function(addr) {
    if (!addr || !addr.startsWith('0x')) return '';
    return addr.slice(2).toLowerCase().padStart(64, '0');
  };

  D.padAddr = D.encodeAddress;
  D.encAddr = D.encodeAddress;

  // ─── Checksum address (EIP-55) ─────────────────────────────────────────
  D.checksumAddress = function(addr) {
    if (!D.isAddress(addr)) return addr;
    addr = addr.toLowerCase().replace('0x', '');
    var hash = '';
    try {
      var keccak = window.ethers && window.ethers.keccak256
        ? window.ethers.keccak256('0x' + addr)
        : null;
      if (keccak) hash = keccak;
    } catch (e) { /* fallthrough */ }
    var out = '0x';
    for (var i = 0; i < addr.length; i++) {
      if (hash && parseInt(hash[i + 2], 16) >= 8) {
        out += addr[i].toUpperCase();
      } else {
        out += addr[i];
      }
    }
    return out;
  };
})();
