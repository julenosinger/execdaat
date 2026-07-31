// ============================================================
// ExecDaat — Contracts Agreements Center (additive layer)
// Presentation-layer evolution of the Contracts tab into a
// rich Agreements Center matching the Digital Agreements structure.
// 100% ADDITIVE:
//   • Does NOT touch smart contracts, ABI, addresses, on-chain logic,
//     existing create/sign/deposit/completion flows.
//   • Adds category/type/release-condition/documents as METADATA
//     stored alongside contracts (localStorage), plus richer UI panels.
//   • Wraps existing Contracts engine functions — never replaces them.
// build: 20260730a
// ============================================================
'use strict';

(function () {
  const META_KEY = 'ca_meta_v1';
  const DEFAULT_NETWORK = 'Arc Testnet';

  const CATEGORIES = [
    'Crypto Assets', 'Tokenized RWAs', 'Commodities', 'Real Estate', 'Services',
    'Freelance', 'Consulting', 'Software Development', 'SaaS Licensing', 'AI Services',
    'Intellectual Property', 'Equity', 'Venture Capital', 'Startup Investment',
    'Carbon Credits', 'Energy Credits', 'Domain Names', 'Digital Products', 'NFTs',
    'Gaming Assets', 'Marketplace Deals', 'Import / Export', 'Supply Chain', 'Custom Agreement',
  ];
  const TYPES = [
    'Purchase Agreement', 'Escrow Agreement', 'Service Agreement', 'Licensing Agreement',
    'Investment Agreement', 'Asset Sale', 'Private Deal', 'Milestone Agreement',
    'Token Sale', 'Custom',
  ];
  const RELEASE_CONDITIONS = [
    'Release on Date', 'Release after Buyer Approval', 'Release after Both Parties Approval',
    'Milestone Based', 'Manual Release', 'Hybrid',
  ];

  const S = { injected: false, docs: [] };
  function log(...a) { console.log('%c[CA]', 'color:#60b4ff', ...a); }
  function el(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  /* ══════════════════════════ METADATA STORE ══════════════════════════ */
  function loadMeta() { try { return JSON.parse(localStorage.getItem(META_KEY) || '{}'); } catch (e) { return {}; } }
  function saveMeta(m) { try { localStorage.setItem(META_KEY, JSON.stringify(m)); } catch (e) {} }
  function metaFor(cid) { return loadMeta()[String(cid)] || null; }

  /* ══════════════════════════ DASHBOARD KPIs ══════════════════════════ */
  function injectDashboard() {
    const tab = el('tab-content-contracts');
    if (!tab || el('ca-dashboard')) return;
    const bar = document.createElement('div');
    bar.id = 'ca-dashboard';
    bar.className = 'grid grid-cols-2 md:grid-cols-6 gap-3 mb-5';
    // Insert after the network banner, before the summary
    const banner = el('cf-network-banner');
    if (banner && banner.nextSibling) {
      banner.parentNode.insertBefore(bar, banner.nextSibling);
    } else {
      tab.insertBefore(bar, tab.firstChild);
    }
    renderDashboard();
  }
  function renderDashboard() {
    const bar = el('ca-dashboard'); if (!bar) return;
    // Use cfState if available, otherwise empty
    const cs = (typeof cfState !== 'undefined' && cfState._allContracts) ? cfState._allContracts : [];
    let tvl = 0, active = 0, completed = 0, disputes = 0, cancelled = 0;
    cs.forEach(function (c) {
      try { tvl += Number(c.depositedValue || c.totalValue || 0); } catch (e) {}
      const st = (c.status || '').toUpperCase();
      if (st === 'DRAFT' || st === 'PENDING' || st === 'FUNDED' || st === 'ACTIVE' || st === 'SIGNED') active++;
      if (st === 'COMPLETED') completed++;
      if (st === 'CANCELLED') cancelled++;
      if (typeof cfGetDisputeStatus === 'function' && cfGetDisputeStatus(c.id) === 'open') disputes++;
    });
    const total = completed + cancelled + disputes;
    const success = total > 0 ? Math.round((completed / total) * 100) : 100;
    const card = function(label, val, color) {
      return '<div class="bg-gray-900/70 border border-gray-700/50 rounded-xl px-3 py-2.5"><div class="text-[9px] uppercase tracking-wider text-gray-500 font-bold">' + label + '</div><div class="text-lg font-bold ' + color + '">' + val + '</div></div>';
    };
    const fmtUsdc = function(v) { return (v / 1e6).toLocaleString('en-US', { maximumFractionDigits: 0 }); };
    bar.innerHTML =
      card('TVL (escrowed)', (tvl ? '$' + fmtUsdc(tvl) : '$0'), 'text-green-400') +
      card('Active', active, 'text-indigo-400') +
      card('Completed', completed, 'text-emerald-400') +
      card('Disputes', disputes, 'text-red-400') +
      card('Cancelled', cancelled, 'text-orange-400') +
      card('Success Rate', success + '%', 'text-cyan-400');
  }

  /* ══════════════════════════ CREATE FORM ENHANCEMENTS ══════════════════════════ */
  function injectCreateForm() {
    const panel = el('cf-create-col');
    if (!panel || el('ca-cat-row')) return;
    // Find the form body (.space-y-3 inside .p-5 inside .cf-panel)
    var formBody = panel.querySelector('.cf-panel .space-y-3');
    if (!formBody) return;

    var inputCls = 'w-full bg-gray-800/60 border border-gray-700/60 hover:border-indigo-600/50 focus:border-indigo-500 rounded-xl px-3.5 py-2.5 text-sm text-white outline-none transition';

    // Category / Type block — prepended to the form, ABOVE the title
    var catBlock = document.createElement('div');
    catBlock.id = 'ca-cat-row';
    catBlock.className = 'grid grid-cols-1 sm:grid-cols-2 gap-4';
    var catOpts = CATEGORIES.map(function(c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('');
    var typeOpts = TYPES.map(function(t) { return '<option value="' + esc(t) + '">' + esc(t) + '</option>'; }).join('');
    catBlock.innerHTML =
      '<div><label class="block text-xs text-gray-400 font-medium mb-1.5"><i class="fas fa-layer-group mr-1 text-indigo-400"></i>Category</label>' +
      '<select id="ca-category" class="' + inputCls + '">' + catOpts + '</select></div>' +
      '<div><label class="block text-xs text-gray-400 font-medium mb-1.5"><i class="fas fa-file-signature mr-1 text-purple-400"></i>Agreement Type</label>' +
      '<select id="ca-type" class="' + inputCls + '">' + typeOpts + '</select></div>';
    formBody.insertBefore(catBlock, formBody.firstChild);

    // Relabel "CONTRACT TITLE" → more descriptive
    try {
      var lbls = formBody.querySelectorAll('.cf-label');
      lbls.forEach(function(lb) {
        if (/CONTRACT TITLE/i.test(lb.textContent)) lb.innerHTML = '<i class="fas fa-heading" style="color:#378ADD;"></i>AGREEMENT TITLE';
        if (/CONTRACTOR WALLET/i.test(lb.textContent)) lb.innerHTML = '<i class="fas fa-hard-hat" style="color:#1D9E75;"></i>COUNTERPARTY WALLET (0x…)';
        if (/TOTAL USDC/i.test(lb.textContent)) lb.innerHTML = '<i class="fas fa-coins" style="color:#1D9E75;"></i>TOTAL VALUE (USDC)';
      });
    } catch (e) {}

    // Release Condition + Documents — inserted before milestones or notes
    var extra = document.createElement('div');
    extra.id = 'ca-extra-row';
    extra.className = 'space-y-4';
    var relOpts = RELEASE_CONDITIONS.map(function(r) { return '<option value="' + esc(r) + '">' + esc(r) + '</option>'; }).join('');
    extra.innerHTML =
      '<div><label class="block text-xs text-gray-400 font-medium mb-1.5"><i class="fas fa-unlock-keyhole mr-1 text-cyan-400"></i>Release Condition</label>' +
      '<select id="ca-release" class="' + inputCls + '">' + relOpts + '</select>' +
      '<p class="text-[10px] text-gray-600 mt-1">On-chain release stays governed by contract milestones. Other conditions are recorded as agreement metadata.</p></div>' +
      '<div><label class="block text-xs text-gray-400 font-medium mb-1.5"><i class="fas fa-paperclip mr-1 text-gray-400"></i>Documents (optional)</label>' +
      '<div class="flex items-center gap-2"><input id="ca-doc-input" type="text" placeholder="Document name or URL (SOW, NDA, proposal…)" class="flex-1 bg-gray-800/60 border border-gray-700/60 focus:border-indigo-500 rounded-xl px-3 py-2 text-xs text-white placeholder-gray-600 outline-none transition">' +
      '<button type="button" onclick="caAddDoc()" class="px-3 py-2 rounded-xl text-xs font-bold bg-gray-800 hover:bg-gray-700 text-indigo-300 border border-gray-700/50"><i class="fas fa-plus"></i></button></div>' +
      '<div id="ca-doc-list" class="mt-2 flex flex-wrap gap-1.5"></div></div>';

    // Insert before the milestones section
    var msContainer = el('cf-milestones-container');
    if (msContainer && msContainer.parentElement) {
      msContainer.parentElement.insertBefore(extra, msContainer.parentElement.querySelector('.cf-label').closest('div') || msContainer);
    } else {
      // Insert before submit button
      var submitBtn = el('cf-submit-btn');
      if (submitBtn && submitBtn.parentElement) {
        submitBtn.parentElement.insertBefore(extra, submitBtn);
      } else {
        formBody.appendChild(extra);
      }
    }
  }

  window.caAddDoc = function () {
    var inp = el('ca-doc-input'); if (!inp) return;
    var v = (inp.value || '').trim(); if (!v) return;
    S.docs.push(v); inp.value = '';
    renderDocs(); updatePreview();
  };
  window.caRemoveDoc = function (i) { S.docs.splice(i, 1); renderDocs(); updatePreview(); };
  function renderDocs() {
    var l = el('ca-doc-list'); if (!l) return;
    l.innerHTML = S.docs.map(function(d, i) {
      return '<span class="inline-flex items-center gap-1 text-[10px] bg-indigo-900/30 border border-indigo-700/40 text-indigo-300 rounded-lg px-2 py-1"><i class="fas fa-file"></i>' + esc(d.length > 28 ? d.slice(0, 28) + '…' : d) + '<button onclick="caRemoveDoc(' + i + ')" class="ml-1 text-indigo-400 hover:text-red-400">✕</button></span>';
    }).join('');
  }

  /* ══════════════════════════ SIDEBAR ══════════════════════════ */
  function injectSidebar() {
    var createCol = el('cf-create-col');
    if (!createCol || el('ca-preview-card')) return;

    var cardCls = 'bg-gray-900/60 border border-gray-800/60 rounded-2xl p-5';
    var sidebarPanel = document.createElement('div');
    sidebarPanel.id = 'ca-preview-card';
    sidebarPanel.className = 'mt-4 space-y-4';
    sidebarPanel.innerHTML =
      // Workflow
      '<div class="' + cardCls + '"><h4 class="text-white font-semibold text-sm mb-3 flex items-center gap-2"><i class="fas fa-diagram-project text-indigo-400"></i>Workflow</h4><div id="ca-workflow"></div></div>' +
      // Agreement Preview
      '<div class="' + cardCls + '"><h4 class="text-white font-semibold text-sm mb-3 flex items-center gap-2"><i class="fas fa-eye text-cyan-400"></i>Agreement Preview</h4><div id="ca-preview" class="text-xs space-y-1"></div></div>' +
      // Risk & Validation
      '<div class="' + cardCls + '"><h4 class="text-white font-semibold text-sm mb-3 flex items-center gap-2"><i class="fas fa-shield-halved text-green-400"></i>Risk &amp; Validation</h4><div id="ca-risk" class="text-xs space-y-1.5"></div></div>' +
      // Cost Estimate
      '<div class="' + cardCls + '"><h4 class="text-white font-semibold text-sm mb-3 flex items-center gap-2"><i class="fas fa-gas-pump text-yellow-400"></i>Cost Estimate</h4><div id="ca-cost" class="text-xs space-y-1"></div></div>';

    // Append after the create panel
    var createPanel = createCol.querySelector('.cf-panel');
    if (createPanel) {
      createPanel.parentNode.insertBefore(sidebarPanel, createPanel.nextSibling);
    }
  }

  var WF_STEPS = ['Draft', 'Counterparty Review', 'On-chain Signature', 'Escrow Funding', 'Work in Progress', 'Proof Submitted', 'Completed'];
  function renderWorkflow(activeIdx) {
    var w = el('ca-workflow'); if (!w) return;
    if (activeIdx == null) activeIdx = 0;
    w.innerHTML = WF_STEPS.map(function (s, i) {
      var done = i < activeIdx, active = i === activeIdx;
      var col = done ? '#34d399' : active ? '#818cf8' : '#3a4870';
      var ic = done ? 'fas fa-check-circle' : active ? 'fas fa-circle-dot' : 'far fa-circle';
      return '<div class="flex items-center gap-2 py-1"><i class="' + ic + '" style="color:' + col + ';font-size:12px;width:14px;text-align:center;"></i><span style="color:' + (i > activeIdx ? '#4a6490' : '#dde2f0') + ';font-size:11px;font-weight:' + (active ? '700' : '400') + ';">' + s + '</span></div>';
    }).join('');
  }

  function fldVal(id) { var e = el(id); return e ? (e.value || '').trim() : ''; }
  function isAddr(a) { return /^0x[a-fA-F0-9]{40}$/.test(a); }
  function getCreateMode() { return (typeof cfGetSelectedMode === 'function') ? cfGetSelectedMode() : 'onchain'; }

  function updatePreview() {
    var p = el('ca-preview'); if (!p) return;
    var title = fldVal('cf-title');
    var contractor = fldVal('cf-contractor');
    var value = fldVal('cf-value');
    var cat = fldVal('ca-category'), type = fldVal('ca-type'), rel = fldVal('ca-release');
    var mode = getCreateMode();
    var modeLabels = { onchain: 'On-Chain Escrow', offchain: 'Off-Chain Payment', custodial: 'Custodial Escrow' };
    var net = (window.walletState && window.walletState.chainName) || DEFAULT_NETWORK;
    var row = function(l, v, c) {
      return '<div class="flex justify-between gap-3"><span class="text-gray-500">' + l + '</span><span class="' + (c || 'text-gray-200') + ' text-right truncate" style="max-width:60%;">' + esc(v || '—') + '</span></div>';
    };
    p.innerHTML =
      row('Agreement Type', type) +
      row('Category', cat) +
      row('Title', title || '—') +
      row('Counterparty', contractor ? contractor.slice(0, 6) + '…' + contractor.slice(-4) : '—') +
      row('Network', net) +
      row('Escrow Mode', modeLabels[mode] || mode, 'text-emerald-400') +
      row('Value', (value ? '$' + Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—') + ' USDC') +
      row('Release Condition', rel) +
      row('Documents', S.docs.length ? (S.docs.length + ' attached') : 'None') +
      row('Status', 'Draft', 'text-indigo-300');
    renderWorkflow(0);
  }

  function updateRisk() {
    var r = el('ca-risk'); if (!r) return;
    var contractor = fldVal('cf-contractor'), value = fldVal('cf-value'), mode = getCreateMode();
    var connected = !!(window.walletState && window.walletState.address);
    var checks = [
      ['Wallet Valid', connected],
      ['Counterparty Valid', isAddr(contractor)],
      ['Escrow Mode Set', !!mode],
      ['Value > 0', !!(Number(value) > 0)],
      ['Milestones Defined', false],
      ['Compliance', true],
    ];
    // Check milestones
    try {
      var msDescs = document.querySelectorAll('#cf-milestones-container .cf-ms-desc');
      msDescs.forEach(function(d) { if ((d.value || '').trim()) checks[4][1] = true; });
    } catch (e) {}
    var pass = 0; checks.forEach(function(c) { if (c[1]) pass++; });
    var score = Math.round((pass / checks.length) * 100);
    var scoreColor = score >= 80 ? '#34d399' : score >= 50 ? '#fbbf24' : '#f87171';
    r.innerHTML = checks.map(function (c) {
      return '<div class="flex items-center justify-between"><span class="text-gray-400">' + c[0] + '</span><span style="color:' + (c[1] ? '#34d399' : '#6b7280') + ';"><i class="fas ' + (c[1] ? 'fa-circle-check' : 'fa-circle') + '"></i></span></div>';
    }).join('') +
      '<div class="flex items-center justify-between pt-1.5 mt-1.5 border-t border-gray-700/40"><span class="text-gray-300 font-semibold">Risk Score</span><span style="color:' + scoreColor + ';font-weight:700;">' + score + '/100 · ' + (score >= 80 ? 'Low' : score >= 50 ? 'Medium' : 'High') + '</span></div>';
  }

  var _gasPrice = null, _gasFetched = 0;
  async function updateCost() {
    var c = el('ca-cost'); if (!c) return;
    try {
      if ((Date.now() - _gasFetched > 30000) && window.walletState && window.walletState.provider) {
        var hex = await window.walletState.provider.request({ method: 'eth_gasPrice', params: [] });
        _gasPrice = BigInt(hex); _gasFetched = Date.now();
      }
    } catch (e) {}
    var gp = _gasPrice || 0n;
    var units = { create: 180000n, approve: 60000n, fund: 130000n };
    function toCost(u) { if (!gp) return '—'; var wei = gp * u; return (Number(wei) / 1e18).toFixed(6); }
    var totalU = units.create + units.approve + units.fund;
    var sym = (window.walletState && window.walletState.chainName && /arc/i.test(window.walletState.chainName)) ? 'USDC' : 'ETH';
    var row = function(l, v) { return '<div class="flex justify-between"><span class="text-gray-500">' + l + '</span><span class="text-gray-200">' + v + (v !== '—' ? ' ' + sym : '') + '</span></div>'; };
    c.innerHTML =
      row('Create Contract', toCost(units.create)) +
      row('USDC Approve', toCost(units.approve)) +
      row('Fund Escrow', toCost(units.fund)) +
      '<div class="flex justify-between pt-1.5 mt-1.5 border-t border-gray-700/40"><span class="text-gray-300 font-semibold">Total Estimated</span><span class="text-yellow-400 font-bold">' + toCost(totalU) + (toCost(totalU) !== '—' ? ' ' + sym : '') + '</span></div>' +
      '<div class="text-[10px] text-gray-600 mt-1">Live gas price × typical gas units. Actual cost set at signing.</div>';
  }

  function updateAll() { try { updatePreview(); updateRisk(); updateCost(); } catch (e) {} }

  function bindLive() {
    var ids = ['cf-title', 'cf-contractor', 'cf-value', 'ca-category', 'ca-type', 'ca-release'];
    ids.forEach(function (id) {
      var e = el(id); if (!e || e._caBound) return;
      e.addEventListener('input', updateAll);
      e.addEventListener('change', updateAll);
      e._caBound = true;
    });
  }

  /* ══════════════════════════ CAPTURE METADATA ON CREATE (wrap, additive) ══════════════════════════ */
  function wrapCreate() {
    if (window.cfCreateContract && !window.cfCreateContract._caWrapped) {
      var orig = window.cfCreateContract;
      var wrapped = async function () {
        var meta = {
          category: fldVal('ca-category') || 'Services',
          agreementType: fldVal('ca-type') || 'Service Agreement',
          releaseCondition: fldVal('ca-release') || 'Milestone Based',
          assetService: fldVal('cf-title') || '',
          documents: S.docs.slice(),
          savedAt: Date.now(),
        };
        var r = await orig.apply(window, arguments);
        // Try to attach metadata to the freshly created contract
        try {
          setTimeout(function () {
            // Find the most recently created contract ID
            var allMeta = loadMeta();
            // Search contracts list for new entries
            if (typeof cfState !== 'undefined' && cfState.contracts && cfState.contracts.length) {
              var latest = cfState.contracts.reduce(function(a, b) {
                return (Number(a.id) > Number(b.id)) ? a : b;
              });
              if (latest && latest.id && !allMeta[String(latest.id)]) {
                allMeta[String(latest.id)] = meta;
                saveMeta(allMeta);
                log('Metadata captured for contract #' + latest.id);
              }
            }
            S.docs = []; renderDocs();
            renderDashboard();
          }, 2000);
        } catch (e) {}
        return r;
      };
      wrapped._caWrapped = true;
      window.cfCreateContract = wrapped;
    }
  }

  /* ══════════════════════════ CONTRACTS LIST: badges + filters ══════════════════════════ */
  function decorateCards() {
    try {
      var meta = loadMeta();
      // Contract cards show the title in .cf-hdr-title
      document.querySelectorAll('#cf-contracts-list .cf-card2').forEach(function (card) {
        if (card._caTagged) return;
        card._caTagged = true;
        // Extract contract ID from the card
        var chipEl = card.querySelector('.cf-chip.cf-mono');
        var cid = chipEl ? (chipEl.textContent || '').replace('#', '').trim() : '';
        var m = meta[cid];
        if (!m) return;
        // Add badges to the header badges area (near status badge)
        var badgeArea = card.querySelector('.cf-hdr > div:first-child');
        if (!badgeArea) return;
        var badgeWrap = document.createElement('div');
        badgeWrap.className = 'flex flex-wrap gap-1';
        badgeWrap.style.marginTop = '4px';
        badgeWrap.innerHTML =
          '<span class="text-[9px] font-semibold bg-indigo-900/40 border border-indigo-700/40 text-indigo-300 rounded-full px-1.5 py-0.5">' + esc(m.category || '') + '</span>' +
          '<span class="text-[9px] font-semibold bg-purple-900/40 border border-purple-700/40 text-purple-300 rounded-full px-1.5 py-0.5">' + esc(m.agreementType || '') + '</span>' +
          (m.releaseCondition ? '<span class="text-[9px] font-semibold bg-cyan-900/40 border border-cyan-700/40 text-cyan-300 rounded-full px-1.5 py-0.5">' + esc(m.releaseCondition) + '</span>' : '') +
          (m.documents && m.documents.length ? '<span class="text-[9px] font-semibold bg-gray-800 border border-gray-700 text-gray-300 rounded-full px-1.5 py-0.5"><i class="fas fa-paperclip"></i> ' + m.documents.length + '</span>' : '');
        badgeArea.appendChild(badgeWrap);
      });
    } catch (e) {}
  }

  function injectFilterBar() {
    var listCol = el('cf-list-col');
    if (!listCol || el('ca-filter-bar')) return;
    var bar = document.createElement('div');
    bar.id = 'ca-filter-bar';
    bar.className = 'flex flex-wrap items-center gap-2 mb-3';
    bar.innerHTML =
      '<input id="ca-search" oninput="caFilterContracts()" placeholder="Search agreements…" class="flex-1 min-w-[160px] bg-gray-800/60 border border-gray-700/60 focus:border-indigo-500 rounded-xl px-3 py-2 text-xs text-white placeholder-gray-600 outline-none">' +
      '<select id="ca-filter-cat" onchange="caFilterContracts()" class="bg-gray-800/60 border border-gray-700/60 rounded-xl px-3 py-2 text-xs text-white outline-none"><option value="">All Categories</option>' + CATEGORIES.map(function(c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('') + '</select>' +
      '<select id="ca-filter-type" onchange="caFilterContracts()" class="bg-gray-800/60 border border-gray-700/60 rounded-xl px-3 py-2 text-xs text-white outline-none"><option value="">All Types</option>' + TYPES.map(function(t) { return '<option value="' + esc(t) + '">' + esc(t) + '</option>'; }).join('') + '</select>';
    var list = el('cf-contracts-list');
    if (list && list.parentElement) {
      list.parentElement.insertBefore(bar, list);
    }
  }

  window.caFilterContracts = function () {
    var q = (fldVal('ca-search') || '').toLowerCase();
    var cat = fldVal('ca-filter-cat');
    var type = fldVal('ca-filter-type');
    var meta = loadMeta();
    document.querySelectorAll('#cf-contracts-list .cf-card2').forEach(function (card) {
      var chipEl = card.querySelector('.cf-chip.cf-mono');
      var cid = chipEl ? (chipEl.textContent || '').replace('#', '').trim() : '';
      var m = meta[cid] || {};
      var text = (card.textContent || '').toLowerCase() + ' ' + (m.category || '').toLowerCase() + ' ' + (m.agreementType || '').toLowerCase();
      var okQ = !q || text.indexOf(q) !== -1;
      var okCat = !cat || (m.category === cat);
      var okType = !type || (m.agreementType === type);
      card.style.display = (okQ && okCat && okType) ? '' : 'none';
    });
  };

  function wrapRenders() {
    if (window.cfRenderContracts && !window.cfRenderContracts._caWrapped) {
      var orig = window.cfRenderContracts;
      var wrapped = function () {
        var r = orig.apply(window, arguments);
        setTimeout(function () {
          decorateCards();
          injectFilterBar();
          renderDashboard();
        }, 50);
        return r;
      };
      wrapped._caWrapped = true;
      window.cfRenderContracts = wrapped;
    }
    // Also wrap the mode-aware renderer
    if (window.cfRenderContractsByMode && !window.cfRenderContractsByMode._caWrapped) {
      var orig2 = window.cfRenderContractsByMode;
      var wrapped2 = function () {
        var r = orig2.apply(window, arguments);
        setTimeout(function () {
          decorateCards();
          injectFilterBar();
          renderDashboard();
        }, 50);
        return r;
      };
      wrapped2._caWrapped = true;
      window.cfRenderContractsByMode = wrapped2;
    }
  }

  /* ══════════════════════════ AI AGENT API ══════════════════════════ */
  window.ContractsAgreements = {
    VERSION: '20260730a',
    CATEGORIES: CATEGORIES, TYPES: TYPES, RELEASE_CONDITIONS: RELEASE_CONDITIONS,
    getMeta: metaFor,
    draft: function (opts) {
      opts = opts || {};
      if (opts.mode) {
        var modeSel = el('cf-contract-mode');
        if (modeSel) { modeSel.value = opts.mode; }
        if (typeof cfUpdateModeUI === 'function') cfUpdateModeUI(opts.mode);
        setTimeout(updateAll, 100);
      }
      var set = function(id, v) { var e = el(id); if (e && v != null) e.value = v; };
      if (opts.category) set('ca-category', opts.category);
      if (opts.type) set('ca-type', opts.type);
      if (opts.release) set('ca-release', opts.release);
      if (opts.title) set('cf-title', opts.title);
      if (opts.contractor) set('cf-contractor', opts.contractor);
      if (opts.value != null) set('cf-value', String(opts.value));
      updateAll();
      return true;
    },
  };

  /* ══════════════════════════ INIT ══════════════════════════ */
  function init() {
    if (S.injected) { wrapCreate(); wrapRenders(); return; }
    if (!el('cf-create-col')) return;
    S.injected = true;
    injectDashboard();
    injectCreateForm();
    injectSidebar();
    injectFilterBar();
    bindLive();
    updateAll();
    wrapCreate();
    wrapRenders();
    log('Contracts Agreements Center ready — additive layer over Contracts module (untouched)');
  }

  var tries = 0;
  var iv = setInterval(function () { tries++; init(); if (S.injected || tries > 80) clearInterval(iv); }, 250);
  document.addEventListener('DOMContentLoaded', init);
  window.addEventListener('load', init);
  // Re-bind when entering the Contracts tab
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest && e.target.closest('#tab-contracts, [onclick*="switchTab(\'contracts\')"]');
    if (t) setTimeout(function () { init(); bindLive(); updateAll(); }, 200);
  });
})();
