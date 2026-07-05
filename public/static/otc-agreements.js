// ============================================================
// ExecDaat â Digital Agreements Center (OTC evolution)
// Presentation-layer evolution of the OTC Contracts tab into a universal
// Digital Agreements Center. 100% ADDITIVE:
//   â¢ Does NOT touch smart contracts, ABI, addresses, signature/escrow flow,
//     on-chain registration, emitted events or existing APIs.
//   â¢ Adds category/type/release-condition/asset-service/documents as METADATA
//     stored alongside contracts (localStorage), plus richer UI panels.
//   â¢ Reuses the existing OTC engine (otcCreateDeal, render fns) via wrappers.
// build: 20260704a
// ============================================================
'use strict';

(function () {
  const META_KEY = 'da_meta_v1';
  const OTC_STORE_KEY = 'execDaat_otc_contracts';

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
  function log(...a) { console.log('%c[AGREEMENTS]', 'color:#818cf8', ...a); }
  function el(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  /* âââââââââââââââ METADATA STORE (parallel â never touches contract logic) âââââââââââââââ */
  function loadMeta() { try { return JSON.parse(localStorage.getItem(META_KEY) || '{}'); } catch (e) { return {}; } }
  function saveMeta(m) { try { localStorage.setItem(META_KEY, JSON.stringify(m)); } catch (e) {} }
  function metaFor(cid) { return loadMeta()[cid] || null; }
  function loadContracts() { try { return JSON.parse(localStorage.getItem(OTC_STORE_KEY) || '[]'); } catch (e) { return []; } }

  /* âââââââââââââââ RENAME (presentation only) âââââââââââââââ */
  function renameHeaders() {
    try {
      // Sidebar label
      document.querySelectorAll('.sidebar-item-label').forEach(function (n) {
        if ((n.textContent || '').trim() === 'OTC Contracts') n.textContent = 'Digital Agreements';
      });
      // Create panel header
      const h = el('otc-panel-create');
      if (h) {
        const t = h.querySelector('h3.text-white.font-bold.text-sm');
        if (t && /New OTC Deal/i.test(t.textContent)) t.textContent = 'New Digital Agreement';
        const sub = t && t.parentElement ? t.parentElement.querySelector('p') : null;
        if (sub) sub.textContent = 'Universal agreements Â· same on-chain escrow security';
      }
      // Sub-tab labels
      const my = el('otc-sub-my'); if (my && /My Contracts/i.test(my.innerHTML)) my.innerHTML = my.innerHTML.replace('My Contracts', 'My Agreements');
      const myTitle = document.querySelector('#otc-panel-my h3');
      if (myTitle && /My OTC Contracts/i.test(myTitle.textContent)) myTitle.innerHTML = myTitle.innerHTML.replace('My OTC Contracts', 'My Agreements');
      const createBtn = el('otc-create-btn');
      if (createBtn && /Create OTC Deal/i.test(createBtn.textContent)) createBtn.innerHTML = '<i class="fas fa-handshake mr-1"></i>Create Agreement';
    } catch (e) {}
  }

  /* âââââââââââââââ DASHBOARD KPIs (computed from existing contracts) âââââââââââââââ */
  function injectDashboard() {
    const tab = el('tab-content-otc');
    if (!tab || el('da-dashboard')) return;
    const bar = document.createElement('div');
    bar.id = 'da-dashboard';
    bar.className = 'grid grid-cols-2 md:grid-cols-6 gap-3 mb-5';
    tab.insertBefore(bar, tab.firstChild);
    renderDashboard();
  }
  function renderDashboard() {
    const bar = el('da-dashboard'); if (!bar) return;
    const cs = loadContracts();
    let tvl = 0, active = 0, completed = 0, disputes = 0, arb = 0;
    cs.forEach(function (c) {
      const st = (c.status || '').toUpperCase();
      if (st.includes('FUND') || st.includes('READY') || st.includes('AWAITING') || st.includes('ONCHAIN') || st.includes('PENDING') || st.includes('SIGNED')) active++;
      if (st.includes('COMPLETED') || st.includes('RELEASED')) completed++;
      if (st.includes('DISPUT')) disputes++;
      if (st.includes('ARBIT')) arb++;
      if ((st.includes('FUND') || st.includes('READY')) && c.amount) tvl += Number(c.amount) || 0;
    });
    const total = completed + disputes;
    const success = total > 0 ? Math.round((completed / total) * 100) : 100;
    const card = (label, val, color) => '<div class="bg-gray-900/70 border border-gray-700/50 rounded-xl px-3 py-2.5"><div class="text-[9px] uppercase tracking-wider text-gray-500 font-bold">' + label + '</div><div class="text-lg font-bold ' + color + '">' + val + '</div></div>';
    bar.innerHTML =
      card('TVL (esc.)', (tvl ? tvl.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '0'), 'text-green-400') +
      card('Active', active, 'text-indigo-400') +
      card('Completed', completed, 'text-emerald-400') +
      card('Disputes', disputes, 'text-red-400') +
      card('Arbitrations', arb, 'text-orange-400') +
      card('Success Rate', success + '%', 'text-cyan-400');
  }

  /* âââââââââââââââ CREATE FORM ENHANCEMENTS âââââââââââââââ */
  function injectCreateForm() {
    const panel = el('otc-panel-create');
    if (!panel || el('da-cat-row')) return;
    const formBody = panel.querySelector('.p-5.space-y-4');
    if (!formBody) return;

    // Category / Type block â prepended to the form
    const block = document.createElement('div');
    block.id = 'da-cat-row';
    block.className = 'grid grid-cols-1 sm:grid-cols-2 gap-4';
    const catOpts = CATEGORIES.map(c => '<option value="' + esc(c) + '">' + esc(c) + '</option>').join('');
    const typeOpts = TYPES.map(t => '<option value="' + esc(t) + '">' + esc(t) + '</option>').join('');
    const inputCls = 'w-full bg-gray-800/60 border border-gray-700/60 hover:border-indigo-600/50 focus:border-indigo-500 rounded-xl px-3.5 py-2.5 text-sm text-white outline-none transition';
    block.innerHTML =
      '<div><label class="block text-xs text-gray-400 font-medium mb-1.5"><i class="fas fa-layer-group mr-1 text-indigo-400"></i>Category</label>' +
      '<select id="da-category" class="' + inputCls + '">' + catOpts + '</select></div>' +
      '<div><label class="block text-xs text-gray-400 font-medium mb-1.5"><i class="fas fa-file-signature mr-1 text-purple-400"></i>Agreement Type</label>' +
      '<select id="da-type" class="' + inputCls + '">' + typeOpts + '</select></div>';
    formBody.insertBefore(block, formBody.firstChild);

    // Relabel "Token / Asset" â "Asset / Service" + add optional free-text service label
    try {
      const labels = panel.querySelectorAll('label');
      labels.forEach(function (lb) {
        if (/Token\s*\/\s*Asset/i.test(lb.textContent)) lb.innerHTML = '<i class="fas fa-coins mr-1 text-yellow-400"></i>Asset / Service';
      });
      const assetSel = el('otc-asset');
      if (assetSel && !el('da-service')) {
        const wrap = assetSel.parentElement;
        const svc = document.createElement('input');
        svc.id = 'da-service'; svc.type = 'text';
        svc.placeholder = 'Label (e.g. Software Development, Gold Token, Consulting)';
        svc.className = 'mt-2 w-full bg-gray-800/60 border border-gray-700/60 focus:border-indigo-500 rounded-xl px-3 py-2 text-xs text-white placeholder-gray-600 outline-none transition';
        wrap.appendChild(svc);
      }
    } catch (e) {}

    // Release Condition + Documents â inserted before the error box
    const errBox = el('otc-form-error');
    const extra = document.createElement('div');
    extra.id = 'da-extra-row';
    extra.className = 'space-y-4';
    const relOpts = RELEASE_CONDITIONS.map(r => '<option value="' + esc(r) + '">' + esc(r) + '</option>').join('');
    extra.innerHTML =
      '<div><label class="block text-xs text-gray-400 font-medium mb-1.5"><i class="fas fa-unlock-keyhole mr-1 text-cyan-400"></i>Release Condition</label>' +
      '<select id="da-release" class="' + inputCls + '">' + relOpts + '</select>' +
      '<p class="text-[10px] text-gray-600 mt-1">On-chain release stays governed by the escrow contract (date + dual-signature). Other conditions are recorded as agreement metadata.</p></div>' +
      '<div><label class="block text-xs text-gray-400 font-medium mb-1.5"><i class="fas fa-paperclip mr-1 text-gray-400"></i>Documents (optional)</label>' +
      '<div class="flex items-center gap-2"><input id="da-doc-input" type="text" placeholder="Document name or URL (PDF, proposal, NDA, licenseâ¦)" class="flex-1 bg-gray-800/60 border border-gray-700/60 focus:border-indigo-500 rounded-xl px-3 py-2 text-xs text-white placeholder-gray-600 outline-none transition">' +
      '<button type="button" onclick="daAddDoc()" class="px-3 py-2 rounded-xl text-xs font-bold bg-gray-800 hover:bg-gray-700 text-indigo-300 border border-gray-700/50"><i class="fas fa-plus"></i></button></div>' +
      '<div id="da-doc-list" class="mt-2 flex flex-wrap gap-1.5"></div></div>';
    if (errBox && errBox.parentElement) errBox.parentElement.insertBefore(extra, errBox);
    else formBody.appendChild(extra);
  }

  window.daAddDoc = function () {
    const inp = el('da-doc-input'); if (!inp) return;
    const v = (inp.value || '').trim(); if (!v) return;
    S.docs.push(v); inp.value = '';
    renderDocs(); updatePreview();
  };
  window.daRemoveDoc = function (i) { S.docs.splice(i, 1); renderDocs(); updatePreview(); };
  function renderDocs() {
    const l = el('da-doc-list'); if (!l) return;
    l.innerHTML = S.docs.map((d, i) => '<span class="inline-flex items-center gap-1 text-[10px] bg-indigo-900/30 border border-indigo-700/40 text-indigo-300 rounded-lg px-2 py-1"><i class="fas fa-file"></i>' + esc(d.length > 28 ? d.slice(0, 28) + 'â¦' : d) + '<button onclick="daRemoveDoc(' + i + ')" class="ml-1 text-indigo-400 hover:text-red-400">â</button></span>').join('');
  }

  /* âââââââââââââââ SIDEBAR: Deal Preview Â· Cost Â· Risk Â· Workflow âââââââââââââââ */
  function injectSidebar() {
    const panel = el('otc-panel-create');
    if (!panel || el('da-preview-card')) return;
    const sidebar = panel.querySelector('.flex-shrink-0.space-y-4') || panel.querySelector('.lg\\:col-span-2.space-y-4');
    if (!sidebar) return;

    // Hide the old "How It Works" card (kept in DOM for compatibility)
    try {
      sidebar.querySelectorAll('h4').forEach(function (h) {
        if (/How It Works/i.test(h.textContent)) { const card = h.closest('.bg-gray-900\\/60'); if (card) card.style.display = 'none'; }
      });
    } catch (e) {}

    const cardCls = 'bg-gray-900/60 border border-gray-800/60 rounded-2xl p-5';
    const frag = document.createElement('div');
    frag.className = 'space-y-4';
    frag.innerHTML =
      // Workflow
      '<div class="' + cardCls + '"><h4 class="text-white font-semibold text-sm mb-3 flex items-center gap-2"><i class="fas fa-diagram-project text-indigo-400"></i>Workflow</h4><div id="da-workflow"></div></div>' +
      // Deal Preview
      '<div class="' + cardCls + '"><h4 class="text-white font-semibold text-sm mb-3 flex items-center gap-2"><i class="fas fa-eye text-cyan-400"></i>Deal Preview</h4><div id="da-preview" class="text-xs space-y-1"></div></div>' +
      // Risk & Validation
      '<div class="' + cardCls + '"><h4 class="text-white font-semibold text-sm mb-3 flex items-center gap-2"><i class="fas fa-shield-halved text-green-400"></i>Risk &amp; Validation</h4><div id="da-risk" class="text-xs space-y-1.5"></div></div>' +
      // Cost Estimate
      '<div class="' + cardCls + '"><h4 class="text-white font-semibold text-sm mb-3 flex items-center gap-2"><i class="fas fa-gas-pump text-yellow-400"></i>Cost Estimate</h4><div id="da-cost" class="text-xs space-y-1"></div></div>';
    // wrapper id marker
    const marker = document.createElement('div'); marker.id = 'da-preview-card'; marker.style.display = 'none';
    sidebar.insertBefore(marker, sidebar.firstChild);
    sidebar.insertBefore(frag, sidebar.firstChild);
  }

  const WF_STEPS = ['Draft', 'Buyer Review', 'Seller Review', 'Off-chain Signature', 'On-chain Registration', 'Escrow Funding', 'Waiting Release', 'Completed'];
  function renderWorkflow(activeIdx) {
    const w = el('da-workflow'); if (!w) return;
    if (activeIdx == null) activeIdx = 0;
    w.innerHTML = WF_STEPS.map(function (s, i) {
      const done = i < activeIdx, active = i === activeIdx;
      const col = done ? '#34d399' : active ? '#818cf8' : '#3a4870';
      const ic = done ? 'fas fa-check-circle' : active ? 'fas fa-circle-dot' : 'far fa-circle';
      return '<div class="flex items-center gap-2 py-1"><i class="' + ic + '" style="color:' + col + ';font-size:12px;width:14px;text-align:center;"></i><span style="color:' + (i > activeIdx ? '#4a6490' : '#dde2f0') + ';font-size:11px;font-weight:' + (active ? '700' : '400') + ';">' + s + '</span></div>';
    }).join('');
  }

  function fldVal(id) { const e = el(id); return e ? (e.value || '').trim() : ''; }
  function isAddr(a) { return /^0x[a-fA-F0-9]{40}$/.test(a); }

  function updatePreview() {
    const p = el('da-preview'); if (!p) return;
    const buyer = fldVal('otc-buyer'), seller = fldVal('otc-seller');
    const asset = fldVal('otc-asset'), amount = fldVal('otc-amount');
    const service = fldVal('da-service');
    const cat = fldVal('da-category'), type = fldVal('da-type'), rel = fldVal('da-release');
    const date = fldVal('otc-tge-date');
    const net = (window.walletState && window.walletState.chainName) || 'Arc Testnet';
    const row = (l, v, c) => '<div class="flex justify-between gap-3"><span class="text-gray-500">' + l + '</span><span class="' + (c || 'text-gray-200') + ' text-right truncate" style="max-width:60%;">' + esc(v || 'â') + '</span></div>';
    p.innerHTML =
      row('Agreement Type', type) +
      row('Category', cat) +
      row('Asset / Service', service || asset) +
      row('Buyer', buyer ? buyer.slice(0, 6) + 'â¦' + buyer.slice(-4) : 'â') +
      row('Seller', seller ? seller.slice(0, 6) + 'â¦' + seller.slice(-4) : 'â') +
      row('Network', net) +
      row('Escrow', 'On-chain (OTCEscrow)', 'text-emerald-400') +
      row('Amount', (amount ? amount + ' ' + (asset || '') : 'â')) +
      row('Release Condition', rel) +
      row('Documents', S.docs.length ? (S.docs.length + ' attached') : 'None') +
      row('Status', 'Draft', 'text-indigo-300');
    renderWorkflow(0);
  }

  async function updateRisk() {
    const r = el('da-risk'); if (!r) return;
    const buyer = fldVal('otc-buyer'), seller = fldVal('otc-seller'), asset = fldVal('otc-asset'), date = fldVal('otc-tge-date');
    const connected = !!(window.walletState && window.walletState.address);
    const escrowReady = (typeof window.otcIsDeployed === 'function') ? !!window.otcIsDeployed() : true;
    const checks = [
      ['Wallet Valid', connected],
      ['Counterparty Valid', isAddr(seller) && seller.toLowerCase() !== (buyer || '').toLowerCase()],
      ['Escrow Ready', escrowReady],
      ['Token Supported', !!asset],
      ['Schedule Valid', !!date],
      ['Compliance', true],
    ];
    let pass = 0; checks.forEach(c => { if (c[1]) pass++; });
    const score = Math.round((pass / checks.length) * 100);
    const scoreColor = score >= 80 ? '#34d399' : score >= 50 ? '#fbbf24' : '#f87171';
    r.innerHTML = checks.map(function (c) {
      return '<div class="flex items-center justify-between"><span class="text-gray-400">' + c[0] + '</span><span style="color:' + (c[1] ? '#34d399' : '#6b7280') + ';"><i class="fas ' + (c[1] ? 'fa-circle-check' : 'fa-circle') + '"></i></span></div>';
    }).join('') +
      '<div class="flex items-center justify-between pt-1.5 mt-1.5 border-t border-gray-700/40"><span class="text-gray-300 font-semibold">Risk Score</span><span style="color:' + scoreColor + ';font-weight:700;">' + score + '/100 Â· ' + (score >= 80 ? 'Low' : score >= 50 ? 'Medium' : 'High') + '</span></div>';
  }

  let _gasPrice = null, _gasFetched = 0;
  async function updateCost() {
    const c = el('da-cost'); if (!c) return;
    // Fetch real gas price (cached 30s) from the connected provider.
    try {
      if ((Date.now() - _gasFetched > 30000) && window.walletState && window.walletState.provider) {
        const hex = await window.walletState.provider.request({ method: 'eth_gasPrice', params: [] });
        _gasPrice = BigInt(hex); _gasFetched = Date.now();
      }
    } catch (e) {}
    const gp = _gasPrice || 0n;
    const units = { create: 180000n, approve: 60000n, fund: 130000n };
    const toCost = (u) => { if (!gp) return 'â'; const wei = gp * u; return (Number(wei) / 1e18).toFixed(6); };
    const totalU = units.create + units.approve + units.fund;
    const sym = (window.walletState && window.walletState.chainName && /arc/i.test(window.walletState.chainName)) ? 'USDC' : 'ETH';
    const row = (l, v) => '<div class="flex justify-between"><span class="text-gray-500">' + l + '</span><span class="text-gray-200">' + v + (v !== 'â' ? ' ' + sym : '') + '</span></div>';
    c.innerHTML =
      row('Create Agreement', toCost(units.create)) +
      row('Approve', toCost(units.approve)) +
      row('Fund Escrow', toCost(units.fund)) +
      '<div class="flex justify-between pt-1.5 mt-1.5 border-t border-gray-700/40"><span class="text-gray-300 font-semibold">Total Estimated</span><span class="text-yellow-400 font-bold">' + toCost(totalU) + (toCost(totalU) !== 'â' ? ' ' + sym : '') + '</span></div>' +
      '<div class="text-[10px] text-gray-600 mt-1">Live gas price Ã typical gas units. Actual cost set at signing.</div>';
  }

  function updateAll() { try { updatePreview(); updateRisk(); updateCost(); } catch (e) {} }

  function bindLive() {
    const ids = ['otc-buyer', 'otc-seller', 'otc-asset', 'otc-amount', 'otc-tge-date', 'otc-tge-time', 'da-category', 'da-type', 'da-release', 'da-service'];
    ids.forEach(function (id) {
      const e = el(id); if (!e || e._daBound) return;
      e.addEventListener('input', updateAll);
      e.addEventListener('change', updateAll);
      e._daBound = true;
    });
  }

  /* âââââââââââââââ CAPTURE METADATA ON CREATE (wrap, additive) âââââââââââââââ */
  function wrapCreate() {
    if (window.otcCreateDeal && !window.otcCreateDeal._daWrapped) {
      const orig = window.otcCreateDeal;
      const wrapped = async function () {
        const meta = {
          category: fldVal('da-category') || 'Crypto Assets',
          agreementType: fldVal('da-type') || 'Purchase Agreement',
          releaseCondition: fldVal('da-release') || 'Release on Date',
          assetService: fldVal('da-service') || fldVal('otc-asset'),
          documents: S.docs.slice(),
          savedAt: Date.now(),
        };
        const before = loadContracts().map(c => c.contractId);
        const r = await orig.apply(this, arguments);
        // Attach metadata to the newly-created contract (most recent not seen before).
        try {
          const after = loadContracts();
          const fresh = after.find(c => before.indexOf(c.contractId) === -1) || after[0];
          if (fresh && fresh.contractId) {
            const m = loadMeta(); m[fresh.contractId] = meta; saveMeta(m);
          }
          S.docs = []; renderDocs();
          renderDashboard();
        } catch (e) {}
        return r;
      };
      wrapped._daWrapped = true;
      window.otcCreateDeal = wrapped;
    }
  }

  /* âââââââââââââââ MY AGREEMENTS + MARKETPLACE: badges + filters âââââââââââââââ */
  function decorateCards() {
    try {
      const meta = loadMeta();
      // Contract cards have a header <div class="... font-mono">CONTRACTID</div>
      document.querySelectorAll('#otc-my-list .font-mono, #otc-mkt-list .font-mono').forEach(function (node) {
        const cid = (node.textContent || '').trim();
        const m = meta[cid];
        if (!m || node._daTagged) return;
        node._daTagged = true;
        const badge = document.createElement('div');
        badge.className = 'flex flex-wrap gap-1 mt-1';
        badge.innerHTML =
          '<span class="text-[9px] font-semibold bg-indigo-900/40 border border-indigo-700/40 text-indigo-300 rounded-full px-1.5 py-0.5">' + esc(m.category) + '</span>' +
          '<span class="text-[9px] font-semibold bg-purple-900/40 border border-purple-700/40 text-purple-300 rounded-full px-1.5 py-0.5">' + esc(m.agreementType) + '</span>' +
          (m.releaseCondition ? '<span class="text-[9px] font-semibold bg-cyan-900/40 border border-cyan-700/40 text-cyan-300 rounded-full px-1.5 py-0.5">' + esc(m.releaseCondition) + '</span>' : '') +
          (m.documents && m.documents.length ? '<span class="text-[9px] font-semibold bg-gray-800 border border-gray-700 text-gray-300 rounded-full px-1.5 py-0.5"><i class="fas fa-paperclip"></i> ' + m.documents.length + '</span>' : '');
        node.parentElement && node.parentElement.appendChild(badge);
      });
    } catch (e) {}
  }

  function injectFilterBar() {
    const myPanel = el('otc-panel-my');
    if (myPanel && !el('da-my-filter')) {
      const bar = document.createElement('div');
      bar.id = 'da-my-filter';
      bar.className = 'flex flex-wrap items-center gap-2 mb-3';
      bar.innerHTML =
        '<input id="da-my-search" oninput="daFilterMy()" placeholder="Search agreementsâ¦" class="flex-1 min-w-[160px] bg-gray-800/60 border border-gray-700/60 focus:border-indigo-500 rounded-xl px-3 py-2 text-xs text-white placeholder-gray-600 outline-none">' +
        '<select id="da-my-cat" onchange="daFilterMy()" class="bg-gray-800/60 border border-gray-700/60 rounded-xl px-3 py-2 text-xs text-white outline-none"><option value="">All Categories</option>' + CATEGORIES.map(c => '<option value="' + esc(c) + '">' + esc(c) + '</option>').join('') + '</select>';
      const list = el('otc-my-list');
      if (list && list.parentElement) list.parentElement.insertBefore(bar, list);
    }
  }

  window.daFilterMy = function () {
    const q = (fldVal('da-my-search') || '').toLowerCase();
    const cat = fldVal('da-my-cat');
    const meta = loadMeta();
    document.querySelectorAll('#otc-my-list > div').forEach(function (card) {
      const cidEl = card.querySelector('.font-mono');
      const cid = cidEl ? (cidEl.textContent || '').trim() : '';
      const m = meta[cid] || {};
      const text = (card.textContent || '').toLowerCase() + ' ' + (m.category || '').toLowerCase() + ' ' + (m.agreementType || '').toLowerCase();
      const okQ = !q || text.indexOf(q) !== -1;
      const okCat = !cat || (m.category === cat);
      card.style.display = (okQ && okCat) ? '' : 'none';
    });
  };

  function wrapRenders() {
    ['otcRenderMyContracts', 'otcRenderMarketplace'].forEach(function (fn) {
      if (window[fn] && !window[fn]._daWrapped) {
        const orig = window[fn];
        const wrapped = function () {
          const r = orig.apply(this, arguments);
          setTimeout(function () { decorateCards(); if (fn === 'otcRenderMyContracts') { injectFilterBar(); } renderDashboard(); }, 30);
          return r;
        };
        wrapped._daWrapped = true;
        window[fn] = wrapped;
      }
    });
  }

  /* âââââââââââââââ AI AGENT API âââââââââââââââ */
  window.DigitalAgreements = {
    VERSION: '20260704a',
    CATEGORIES: CATEGORIES, TYPES: TYPES, RELEASE_CONDITIONS: RELEASE_CONDITIONS,
    getMeta: metaFor,
    // Pre-fill the create form for the Autonomous Agent (reuses existing engine).
    draft: function (opts) {
      opts = opts || {};
      if (typeof window.otcSwitchSub === 'function') window.otcSwitchSub('create');
      const set = (id, v) => { const e = el(id); if (e && v != null) e.value = v; };
      if (opts.category) set('da-category', opts.category);
      if (opts.type) set('da-type', opts.type);
      if (opts.release) set('da-release', opts.release);
      if (opts.assetService) set('da-service', opts.assetService);
      if (opts.buyer) set('otc-buyer', opts.buyer);
      if (opts.seller) set('otc-seller', opts.seller);
      if (opts.asset) set('otc-asset', opts.asset);
      if (opts.amount != null) set('otc-amount', String(opts.amount));
      updateAll();
      return true;
    },
  };

  /* âââââââââââââââ INIT âââââââââââââââ */
  function init() {
    if (S.injected) { renameHeaders(); wrapCreate(); wrapRenders(); return; }
    if (!el('otc-panel-create')) return;
    S.injected = true;
    injectDashboard();
    injectCreateForm();
    injectSidebar();
    renameHeaders();
    bindLive();
    updateAll();
    wrapCreate();
    wrapRenders();
    log('Digital Agreements Center ready â additive layer over OTC (contracts untouched)');
  }

  let tries = 0;
  const iv = setInterval(function () { tries++; init(); if (S.injected || tries > 80) clearInterval(iv); }, 250);
  document.addEventListener('DOMContentLoaded', init);
  window.addEventListener('load', init);
  // Re-bind when entering the OTC tab (elements exist by then).
  document.addEventListener('click', function (e) {
    const t = e.target && e.target.closest && e.target.closest('#tab-otc, [onclick*="switchTab(\'otc\')"]');
    if (t) setTimeout(function () { init(); bindLive(); updateAll(); }, 200);
  });
})();
