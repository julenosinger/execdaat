// ============================================================
// ExecDaat — Arc Transaction Memo UI (reusable toggle + input)
// ------------------------------------------------------------
// Renders the optional "Attach Transaction Memo" block into any
// element marked with data-memo-mount="<prefix>", or on demand via
// MemoUI.ensureMount(prefix, parentEl). Completely additive:
//   • Disabled (unchecked) by default — zero impact on existing flows.
//   • Auto-hides when MemoEngine reports the network/contract as
//     unsupported (never shows errors for unsupported chains).
//   • Consumers read the value with MemoUI.getActiveMemo(prefix):
//     returns '' unless the toggle is ON and the text is valid.
// Matches the existing ExecDaat dark design language (pay-note style).
// ============================================================
;(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.MemoUI) return; // idempotent

  var STYLE_ID = 'memo-ui-style';

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = [
      '.memo-block{margin-top:12px;}',
      '.memo-toggle{display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#8aaac8;}',
      '.memo-toggle input{accent-color:#a78bfa;width:14px;height:14px;cursor:pointer;}',
      '.memo-toggle .memo-opt{font-weight:500;text-transform:none;letter-spacing:0;color:#6b7280;}',
      '.memo-body{margin-top:8px;}',
      '.memo-body.hidden{display:none;}',
      '.memo-input{width:100%;background:rgba(17,24,39,0.7);border:1px solid rgba(255,255,255,0.09);border-radius:10px;color:#e5e7eb;font-size:13px;padding:8px 12px;outline:none;transition:border-color .15s;}',
      '.memo-input:focus{border-color:rgba(167,139,250,0.55);}',
      '.memo-input::placeholder{color:#4b5563;}',
      '.memo-meta{display:flex;justify-content:space-between;align-items:center;margin-top:4px;font-size:10.5px;color:#6b7280;}',
      '.memo-warn{color:#fbbf24;}',
      '.memo-hint{margin-top:4px;font-size:10.5px;color:#5f7ba0;line-height:1.45;}',
      '@media (max-width:520px){.memo-toggle{font-size:10.5px;}.memo-input{font-size:12px;}}',
    ].join('\n');
    document.head.appendChild(st);
  }

  function q(id) { return document.getElementById(id); }
  function engine() { return window.MemoEngine || null; }
  function limit() { var e = engine(); return e ? e.maxChars() : 200; }

  function blockId(p)  { return 'memo-block-' + p; }
  function checkId(p)  { return 'memo-enabled-' + p; }
  function bodyId(p)   { return 'memo-body-' + p; }
  function textId(p)   { return 'memo-text-' + p; }
  function countId(p)  { return 'memo-count-' + p; }
  function warnId(p)   { return 'memo-warn-' + p; }

  function html(prefix) {
    var max = limit();
    return '' +
      '<div class="memo-block" id="' + blockId(prefix) + '">' +
        '<label class="memo-toggle" for="' + checkId(prefix) + '">' +
          '<input type="checkbox" id="' + checkId(prefix) + '" onchange="MemoUI._onToggle(\'' + prefix + '\')">' +
          '<span><i class="fas fa-file-signature" style="color:#a78bfa;margin-right:5px;"></i>Attach Transaction Memo ' +
          '<span class="memo-opt">(optional · recorded on-chain)</span></span>' +
        '</label>' +
        '<div class="memo-body hidden" id="' + bodyId(prefix) + '">' +
          '<input class="memo-input" id="' + textId(prefix) + '" type="text" maxlength="' + max + '" ' +
            'placeholder="Transaction purpose — e.g. Invoice #123, Payroll July…" ' +
            'oninput="MemoUI._onInput(\'' + prefix + '\')" autocomplete="off" spellcheck="false">' +
          '<div class="memo-meta"><span id="' + countId(prefix) + '">0 / ' + max + '</span><span class="memo-warn" id="' + warnId(prefix) + '"></span></div>' +
          '<div class="memo-hint"><i class="fas fa-shield-halved" style="color:#5f7ba0;"></i> Emitted as a public Memo event on Arc via the official Memo contract. Your wallet remains the sender. If the memo cannot be attached, the transaction proceeds normally without it.</div>' +
        '</div>' +
      '</div>';
  }

  // ─── Mounting ─────────────────────────────────────────────────────────────
  var _mounted = {}; // prefix → true

  function mount(prefix, el) {
    if (!prefix || !el || q(blockId(prefix))) return;
    injectStyle();
    var wrap = document.createElement('div');
    wrap.innerHTML = html(prefix);
    el.appendChild(wrap.firstChild);
    _mounted[prefix] = true;
    updateVisibility(prefix);
  }

  function autoMount() {
    try {
      var nodes = document.querySelectorAll('[data-memo-mount]');
      for (var i = 0; i < nodes.length; i++) {
        var p = nodes[i].getAttribute('data-memo-mount');
        if (p) mount(p, nodes[i]);
      }
    } catch (_) {}
  }

  // Idempotent mount into a dynamic container (e.g. dialogs/panels built at runtime).
  function ensureMount(prefix, parentEl) {
    try {
      if (q(blockId(prefix))) { updateVisibility(prefix); return; }
      if (parentEl) mount(prefix, parentEl);
    } catch (_) {}
  }

  // ─── Support-based visibility (auto-hide, never error) ───────────────────
  function updateVisibility(prefix) {
    var el = q(blockId(prefix)); if (!el) return;
    var e = engine();
    if (!e) { el.style.display = 'none'; return; }
    try {
      e.isSupported().then(function (ok) {
        var node = q(blockId(prefix));
        if (node) node.style.display = ok ? '' : 'none';
      }).catch(function () {
        var node = q(blockId(prefix));
        if (node) node.style.display = 'none';
      });
    } catch (_) { el.style.display = 'none'; }
  }

  function refreshAll() { for (var p in _mounted) updateVisibility(p); }

  // ─── Event handlers ───────────────────────────────────────────────────────
  function _onToggle(prefix) {
    var body = q(bodyId(prefix)); var cb = q(checkId(prefix));
    if (!body || !cb) return;
    body.classList.toggle('hidden', !cb.checked);
    if (cb.checked) { var inp = q(textId(prefix)); if (inp) inp.focus(); }
  }

  function _onInput(prefix) {
    var inp = q(textId(prefix)); var cnt = q(countId(prefix)); var warn = q(warnId(prefix));
    if (!inp) return;
    var val = inp.value || '';
    if (cnt) cnt.textContent = val.length + ' / ' + limit();
    if (warn) {
      var e = engine();
      if (!val.trim() || !e) { warn.textContent = ''; return; }
      var v = e.validate(val);
      warn.textContent = v.ok ? '' : (v.reason === 'too_many_bytes' ? 'Memo exceeds ' + e.MAX_MEMO_BYTES + ' bytes' : v.reason === 'too_long' ? 'Memo too long' : '');
    }
  }

  // ─── Consumer API ─────────────────────────────────────────────────────────
  // Returns the memo text ONLY when: block mounted + toggle ON + text valid.
  // Everything else → '' (callers then run their original flow untouched).
  function getActiveMemo(prefix) {
    try {
      var cb = q(checkId(prefix)); var inp = q(textId(prefix)); var block = q(blockId(prefix));
      if (!cb || !inp || !block || !cb.checked) return '';
      if (block.style.display === 'none') return '';
      var text = (inp.value || '').trim();
      if (!text) return '';
      var e = engine();
      if (!e || !e.validate(text).ok) return '';
      return text;
    } catch (_) { return ''; }
  }

  function isEnabled(prefix) { var cb = q(checkId(prefix)); return !!(cb && cb.checked); }

  function reset(prefix) {
    try {
      var cb = q(checkId(prefix)); var inp = q(textId(prefix)); var body = q(bodyId(prefix)); var cnt = q(countId(prefix)); var warn = q(warnId(prefix));
      if (cb) cb.checked = false;
      if (inp) inp.value = '';
      if (body) body.classList.add('hidden');
      if (cnt) cnt.textContent = '0 / ' + limit();
      if (warn) warn.textContent = '';
    } catch (_) {}
  }

  window.MemoUI = {
    mount: mount,
    autoMount: autoMount,
    ensureMount: ensureMount,
    updateVisibility: updateVisibility,
    refreshAll: refreshAll,
    getActiveMemo: getActiveMemo,
    isEnabled: isEnabled,
    reset: reset,
    _onToggle: _onToggle,
    _onInput: _onInput,
  };

  // Auto-mount declarative placeholders + re-check on wallet/network changes.
  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(autoMount, 0);
  else document.addEventListener('DOMContentLoaded', autoMount);
  try { window.addEventListener('walletConnected', refreshAll); } catch (_) {}
  try {
    if (window.ethereum && typeof window.ethereum.on === 'function') {
      window.ethereum.on('chainChanged', function () { try { window.MemoEngine && window.MemoEngine._resetSupportCache(); } catch (_) {} refreshAll(); });
    }
  } catch (_) {}
})();
