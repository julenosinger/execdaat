// ============================================================
// HIDE-HISTORY.JS — Persistent "Hide from View" System
// ExecDaat · Payments · Contracts · Multisend
//
// Replaces the in-memory arcMakeDismissState with a localStorage-
// backed system so hidden items stay hidden across page reloads.
//
// Keys:
//   hiddenPayments  → array of txHash / id strings
//   hiddenContracts → array of contract id strings
//   hiddenMultisend → array of batch receipt id strings
//
// API (per namespace):
//   hideItem(id)        → add to hidden list
//   unhideItem(id)      → remove from hidden list
//   isHidden(id)        → boolean
//   getHidden()         → string[]
//   clearHidden()       → remove all hidden for this namespace
//
// Global helpers:
//   arcHidePay(id)          arcHideContract(id)      arcHideMs(id)
//   arcUnhidePay(id)        arcUnhideContract(id)    arcUnhideMs(id)
//   arcIsHiddenPay(id)      arcIsHiddenContract(id)  arcIsHiddenMs(id)
//   arcGetHiddenPay()       arcGetHiddenContract()   arcGetHiddenMs()
//   arcClearHiddenPay()     arcClearHiddenContract() arcClearHiddenMs()
//   arcShowAllHiddenPay()   arcShowAllHiddenContract() arcShowAllHiddenMs()
// ============================================================
(function () {
  'use strict';

  // ── Factory ──────────────────────────────────────────────────────────────────
  function makeHideStore(storageKey) {
    function _load() {
      try { return JSON.parse(localStorage.getItem(storageKey) || '[]'); }
      catch (e) { return []; }
    }
    function _save(arr) {
      try { localStorage.setItem(storageKey, JSON.stringify(arr)); }
      catch (e) { /* storage full — fail silently */ }
    }

    return {
      hideItem: function (id) {
        if (!id) return;
        var list = _load();
        if (list.indexOf(String(id)) === -1) {
          list.push(String(id));
          _save(list);
        }
      },
      unhideItem: function (id) {
        if (!id) return;
        var list = _load().filter(function (x) { return x !== String(id); });
        _save(list);
      },
      isHidden: function (id) {
        if (!id) return false;
        return _load().indexOf(String(id)) !== -1;
      },
      isVisible: function (id) {
        if (!id) return true;
        return _load().indexOf(String(id)) === -1;
      },
      getHidden: function () { return _load(); },
      clearHidden: function () { _save([]); },
      count: function () { return _load().length; },
    };
  }

  // ── Three namespaced stores ───────────────────────────────────────────────────
  var payStore      = makeHideStore('hiddenPayments');
  var contractStore = makeHideStore('hiddenContracts');
  var msStore       = makeHideStore('hiddenMultisend');

  // ── Global shortcuts: Payments ────────────────────────────────────────────────
  window.arcHidePay        = function (id) { payStore.hideItem(id); };
  window.arcUnhidePay      = function (id) { payStore.unhideItem(id); };
  window.arcIsHiddenPay    = function (id) { return payStore.isHidden(id); };
  window.arcIsVisiblePay   = function (id) { return payStore.isVisible(id); };
  window.arcGetHiddenPay   = function ()   { return payStore.getHidden(); };
  window.arcClearHiddenPay = function ()   { payStore.clearHidden(); };

  // ── Global shortcuts: Contracts ───────────────────────────────────────────────
  window.arcHideContract        = function (id) { contractStore.hideItem(id); };
  window.arcUnhideContract      = function (id) { contractStore.unhideItem(id); };
  window.arcIsHiddenContract    = function (id) { return contractStore.isHidden(id); };
  window.arcIsVisibleContract   = function (id) { return contractStore.isVisible(id); };
  window.arcGetHiddenContract   = function ()   { return contractStore.getHidden(); };
  window.arcClearHiddenContract = function ()   { contractStore.clearHidden(); };

  // ── Global shortcuts: Multisend ───────────────────────────────────────────────
  window.arcHideMs        = function (id) { msStore.hideItem(id); };
  window.arcUnhideMs      = function (id) { msStore.unhideItem(id); };
  window.arcIsHiddenMs    = function (id) { return msStore.isHidden(id); };
  window.arcIsVisibleMs   = function (id) { return msStore.isVisible(id); };
  window.arcGetHiddenMs   = function ()   { return msStore.getHidden(); };
  window.arcClearHiddenMs = function ()   { msStore.clearHidden(); };

  // ── Show-Hidden modal builder ─────────────────────────────────────────────────
  // Generic modal that lists hidden items and lets user unhide them.
  // Parameters:
  //   store      - one of payStore / contractStore / msStore
  //   labelFn    - function(id) → display label string
  //   unhideCb   - callback after unhiding (re-render fn)
  //   title      - modal title
  window.arcShowHiddenModal = function (store, labelFn, unhideCb, title) {
    var hidden = store.getHidden();

    // Remove existing modal
    var existing = document.getElementById('arc-hidden-modal');
    if (existing) existing.remove();

    var modal = document.createElement('div');
    modal.id = 'arc-hidden-modal';
    modal.style.cssText =
      'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(0,0,0,0.65);backdrop-filter:blur(4px);';

    var rows = hidden.length === 0
      ? '<p class="text-gray-500 text-sm text-center py-6">No hidden items.</p>'
      : hidden.map(function (id) {
          var label = typeof labelFn === 'function' ? labelFn(id) : id;
          return '<div class="flex items-center justify-between gap-3 py-2 border-b border-gray-700/40">' +
            '<span class="text-gray-300 text-xs font-mono truncate max-w-[280px]">' + _escHtml(label) + '</span>' +
            '<button onclick="window._arcUnhideOne(\'' + _escAttr(id) + '\')" ' +
              'class="text-xs bg-blue-600 hover:bg-blue-500 text-white rounded-lg px-3 py-1 transition-colors flex-shrink-0">' +
              '<i class="fas fa-eye mr-1"></i>Show</button>' +
          '</div>';
        }).join('');

    modal.innerHTML =
      '<div class="bg-gray-900 border border-gray-700/60 rounded-2xl w-full max-w-lg mx-4 shadow-2xl">' +
        '<div class="flex items-center justify-between px-5 py-4 border-b border-gray-700/40">' +
          '<h3 class="text-white font-semibold flex items-center gap-2">' +
            '<i class="fas fa-eye-slash text-blue-400"></i>' +
            _escHtml(title || 'Hidden Items') +
            '<span class="text-xs text-gray-500 font-normal ml-1">(' + hidden.length + ')</span>' +
          '</h3>' +
          '<button onclick="document.getElementById(\'arc-hidden-modal\').remove()" ' +
            'class="text-gray-500 hover:text-white transition-colors"><i class="fas fa-times"></i></button>' +
        '</div>' +
        '<div class="px-5 py-3 max-h-80 overflow-y-auto">' + rows + '</div>' +
        (hidden.length > 0
          ? '<div class="px-5 py-3 border-t border-gray-700/40 flex justify-between items-center">' +
              '<span class="text-xs text-gray-600">On-chain transactions cannot be deleted, only hidden.</span>' +
              '<button onclick="window._arcUnhideAll()" ' +
                'class="text-xs text-green-400 hover:text-green-300 bg-green-900/20 border border-green-700/30 rounded-lg px-3 py-1.5 transition-colors">' +
                '<i class="fas fa-eye mr-1"></i>Show All</button>' +
            '</div>'
          : '') +
      '</div>';

    // Store refs for the inline handlers
    window._arcHiddenStore    = store;
    window._arcHiddenUnhideCb = unhideCb;

    window._arcUnhideOne = function (id) {
      store.unhideItem(id);
      if (typeof unhideCb === 'function') unhideCb();
      // Refresh modal
      window.arcShowHiddenModal(store, labelFn, unhideCb, title);
    };
    window._arcUnhideAll = function () {
      store.clearHidden();
      if (typeof unhideCb === 'function') unhideCb();
      document.getElementById('arc-hidden-modal') && document.getElementById('arc-hidden-modal').remove();
    };

    document.body.appendChild(modal);
    // Close on backdrop click
    modal.addEventListener('click', function (e) {
      if (e.target === modal) modal.remove();
    });
  };

  // ── Convenience wrappers for each tab ────────────────────────────────────────
  window.arcShowHiddenPayments = function () {
    window.arcShowHiddenModal(
      payStore,
      function (id) { return id; },
      function () { if (typeof renderPaymentHistory === 'function') renderPaymentHistory(); },
      'Hidden Payments'
    );
  };

  window.arcShowHiddenContracts = function () {
    window.arcShowHiddenModal(
      contractStore,
      function (id) { return 'Contract #' + id; },
      function () {
        if (typeof cfRenderContracts === 'function' && typeof cfState !== 'undefined') {
          cfRenderContracts(cfState.contracts, window.walletState && window.walletState.address);
        }
      },
      'Hidden Contracts'
    );
  };

  window.arcHideAllContracts = function () {
    var contracts = (typeof cfState !== 'undefined' && cfState.contracts) ? cfState.contracts : [];
    contracts.forEach(function (c) {
      var id = c.id || c;
      if (id) contractStore.hideItem(String(id));
    });
    if (typeof cfRenderContracts === 'function' && typeof cfState !== 'undefined') {
      cfRenderContracts(cfState.contracts, window.walletState && window.walletState.address);
    }
  };

  window.arcShowHiddenMultisend = function () {
    window.arcShowHiddenModal(
      msStore,
      function (id) { return 'Batch ' + id; },
      function () { if (typeof msRenderReceipts === 'function') msRenderReceipts(); },
      'Hidden Batches'
    );
  };

  // ── Small HTML helpers (avoid XSS in modal content) ──────────────────────────
  function _escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function _escAttr(s) {
    return String(s).replace(/'/g, "\\'");
  }

  console.log('[HideHistory] Persistent hide system loaded — keys: hiddenPayments / hiddenContracts / hiddenMultisend');
})();
