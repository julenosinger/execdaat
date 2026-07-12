// ============================================================
// ExecDaat UI Helpers — centralized toast, loading, clipboard
// ============================================================
;(function() {
  'use strict';
  var D = window.ExecDaat = window.ExecDaat || {};

  // ─── Toast notification (safe — uses escaped content) ──────────────────
  D.showToast = function(message, type) {
    type = type || 'info';
    // Use existing showToast if available (app.js)
    if (typeof window.showToast === 'function' && window.showToast !== D.showToast) {
      return window.showToast(message, type);
    }
    var toast = document.getElementById('toast');
    var content = document.getElementById('toast-content');
    if (!toast || !content) return;
    var colors = { success: 'text-green-400', error: 'text-red-400', warning: 'text-yellow-400', info: 'text-blue-400' };
    var escaped = typeof arcEscapeHtml === 'function'
      ? arcEscapeHtml(String(message))
      : String(message).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    content.innerHTML = '<span class="' + (colors[type] || colors.info) + '">' + escaped + '</span>';
    toast.classList.remove('hidden');
    setTimeout(function() { toast.classList.add('hidden'); }, D.CONFIG ? D.CONFIG.TIMEOUTS.TOAST_DURATION : 4000);
  };

  // ─── Loading spinner ───────────────────────────────────────────────────
  D.showLoading = function(message) {
    var existing = document.getElementById('execdaat-loading');
    if (existing) existing.remove();
    var el = document.createElement('div');
    el.id = 'execdaat-loading';
    el.className = 'fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm';
    el.innerHTML = '<div class="bg-gray-900 border border-gray-700 rounded-2xl p-6 text-center"><i class="fas fa-spinner fa-spin text-purple-400 text-2xl mb-2"></i><p class="text-gray-300 text-sm">' + (message || 'Loading...') + '</p></div>';
    document.body.appendChild(el);
    return function() { el.style.opacity = '0'; setTimeout(function() { el.remove(); }, 300); };
  };

  // ─── Copy to clipboard ─────────────────────────────────────────────────
  D.copyToClipboard = function(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function() {
        D.showToast('Copied!', 'success');
      }).catch(function() {
        D.fallbackCopy(text);
      });
    }
    D.fallbackCopy(text);
  };

  D.fallbackCopy = function(text) {
    var el = document.createElement('textarea');
    el.value = text;
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    try { document.execCommand('copy'); D.showToast('Copied!', 'success'); } catch (e) { D.showToast('Copy failed', 'error'); }
    document.body.removeChild(el);
  };

  // ─── Status badge ──────────────────────────────────────────────────────
  D.renderStatusBadge = function(status) {
    var statusColors = {
      active:   'bg-green-900/40 text-green-400 border-green-700/30',
      pending:  'bg-yellow-900/40 text-yellow-400 border-yellow-700/30',
      completed:'bg-blue-900/40 text-blue-400 border-blue-700/30',
      failed:   'bg-red-900/40 text-red-400 border-red-700/30',
      cancelled:'bg-gray-700/40 text-gray-400 border-gray-600/30',
    };
    var cls = statusColors[(status || '').toLowerCase()] || statusColors.pending;
    return '<span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ' + cls + '">' + (status || 'Pending') + '</span>';
  };
})();
