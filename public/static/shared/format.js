// ============================================================
// ExecDaat Shared Formatters
// ============================================================
;(function() {
  'use strict';
  var D = window.ExecDaat = window.ExecDaat || {};

  // ─── Address formatting ────────────────────────────────────────────────
  D.shortAddress = function(addr) {
    if (!addr || typeof addr !== 'string') return '?';
    return addr.slice(0, 6) + '...' + addr.slice(-4);
  };

  D.shortAddr = D.shortAddress;  // alias

  D.fmtAddr = function(addr) {
    return D.shortAddress(addr);
  };

  // ─── USDC / 6-decimal formatting ───────────────────────────────────────
  D.formatUSDC = function(amount, decimals) {
    var d = (decimals !== undefined) ? decimals : 6;
    var n = Number(amount);
    if (!isFinite(n)) return '0.00';
    return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: d });
  };

  D.fmtUsdc = D.formatUSDC;  // alias

  // ─── Token amount formatting ───────────────────────────────────────────
  D.formatToken = function(amount, symbol, decimals) {
    return D.formatUSDC(amount, decimals) + ' ' + (symbol || '');
  };

  // ─── Date/time formatting ──────────────────────────────────────────────
  D.formatDate = function(ts) {
    var d = ts ? new Date(ts) : new Date();
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  };

  D.formatTime = function(ts) {
    var d = ts ? new Date(ts) : new Date();
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  };

  D.formatDateTime = function(ts) {
    return D.formatDate(ts) + ' ' + D.formatTime(ts);
  };

  // ─── Hash formatting ───────────────────────────────────────────────────
  D.formatHash = function(hash) {
    if (!hash || typeof hash !== 'string') return '—';
    return hash.slice(0, 10) + '...' + hash.slice(-6);
  };

  // ─── Percent formatting ────────────────────────────────────────────────
  D.formatPercent = function(val) {
    var n = Number(val);
    if (!isFinite(n)) return '0%';
    return n.toFixed(2) + '%';
  };

  // ─── Gas formatting ────────────────────────────────────────────────────
  D.formatGas = function(gas) {
    return D.formatUSDC(gas, 6) + ' USDC';
  };
})();
