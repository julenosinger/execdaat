// ============================================================
// ExecDaat Shared Token Helpers
// ============================================================
;(function() {
  'use strict';
  var D = window.ExecDaat = window.ExecDaat || {};

  // ─── Parse amount to base units (micro-units for 6-decimal tokens) ─────
  D.parseUnits = function(amount, decimals) {
    decimals = (decimals !== undefined) ? decimals : 6;
    var n = Number(amount);
    if (!isFinite(n) || n <= 0) return 0n;
    try {
      var factor = BigInt(Math.pow(10, decimals));
      // Multiply then round: Math.round(n * 10^decimals)
      var scaled = BigInt(Math.round(n * Math.pow(10, decimals)));
      return scaled;
    } catch (e) {
      // BigInt fallback for large numbers
      return BigInt(Math.round(n * 1000000));
    }
  };

  D.toMicro = D.parseUnits;     // alias
  D.parseUsdcUnits = D.parseUnits; // alias
  D.msToMicro = D.parseUnits;   // alias (multisend compat)

  // ─── Format units to human-readable ────────────────────────────────────
  D.formatUnits = function(amount, decimals) {
    decimals = (decimals !== undefined) ? decimals : 6;
    var n = Number(amount);
    if (!isFinite(n)) return '0';
    return (n / Math.pow(10, decimals)).toFixed(decimals);
  };

  // ─── Get token decimals ────────────────────────────────────────────────
  D.tokenDecimals = function(symbolOrAddress) {
    var t = D.tokenBySymbol ? D.tokenBySymbol(symbolOrAddress) : null;
    if (!t) t = D.tokenByAddress ? D.tokenByAddress(symbolOrAddress) : null;
    return t ? t.decimals : 6;
  };

  // ─── Check if a token is native on Arc (USDC) ──────────────────────────
  D.isNativeToken = function(symbolOrAddress) {
    var t = D.tokenBySymbol ? D.tokenBySymbol(symbolOrAddress) : null;
    if (!t) t = D.tokenByAddress ? D.tokenByAddress(symbolOrAddress) : null;
    return t ? t.isNative : false;
  };

  // ─── Normalize amount string (remove commas, trim) ─────────────────────
  D.normalizeAmount = function(raw) {
    if (raw === undefined || raw === null) return '0';
    return String(raw).replace(/,/g, '.').trim();
  };

  // ─── Convert string to float amount ────────────────────────────────────
  D.parseAmount = function(raw) {
    var n = parseFloat(D.normalizeAmount(raw));
    return isNaN(n) ? 0 : n;
  };
})();
