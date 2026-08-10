// ============================================================
// EXECDAAT AGENT CONTEXT — Canonical read-only bridge
// Connects AgentWallet, AgentIntents, execution, and audit
// into a single context consumed by the Autonomous chat.
//
// NO mock data. NO fake wallets. NO duplicated state.
// Everything comes from real sources.
// ============================================================
;(function() {
  'use strict';
  var D = window.ExecDaat = window.ExecDaat || {};

  var _ctx = {
    wallet: null,        // { address, walletId, label, createdAt, agentId }
    balances: null,      // { USDC: {raw,human}, EURC: {raw,human} }
    intents: [],         // Intent[] from D.AgentIntents (if available)
    pendingCount: 0,
    todayOpsCount: 0,
    recentOps: [],       // latest operations from audit/execution
    agentId: null,
    isAuthorized: false,
    lastRefresh: null,
  };

  var _listeners = [];

  function _notify() {
    _ctx.lastRefresh = new Date().toISOString();
    _listeners.forEach(function(fn) { try { fn(_ctx); } catch(e) {} });
    window.dispatchEvent(new CustomEvent('agentContext:updated', { detail: _ctx }));
  }

  function _normalizeAddr(a) { return (a || '').toLowerCase(); }

  // ── Refresh wallet ─────────────────────────────────────────────────────────
  async function refreshWallet() {
    var AW = D.AgentWallet;
    if (!AW) return;
    var s = AW.state;
    if (s.agentAddress) {
      _ctx.wallet = {
        address: s.agentAddress,
        walletId: s.agentWalletId,
        label: s.agentLabel || 'Agent Wallet',
        createdAt: null,
        agentId: s.agentId,
      };
      _ctx.agentId = s.agentId;
      _ctx.isAuthorized = s.isRegistered || false;
    } else {
      _ctx.wallet = null;
      _ctx.agentId = null;
      _ctx.isAuthorized = false;
    }
  }

  // ── Refresh balances ───────────────────────────────────────────────────────
  async function refreshBalances() {
    var AW = D.AgentWallet;
    if (!AW || !_ctx.wallet) { _ctx.balances = null; return; }
    try {
      var info = await AW.getWalletInfo(_ctx.wallet.address);
      if (info.success && info.wallet && info.wallet.balances) {
        _ctx.balances = info.wallet.balances;
      }
    } catch(e) { /* network error — keep previous balances */ }
  }

  // ── Refresh intents ────────────────────────────────────────────────────────
  function refreshIntents() {
    try {
      if (D.AgentIntents && typeof D.AgentIntents.getIntents === 'function') {
        _ctx.intents = D.AgentIntents.getIntents() || [];
      } else if (D.AgentIntents && Array.isArray(D.AgentIntents.state && D.AgentIntents.state.intents)) {
        _ctx.intents = D.AgentIntents.state.intents || [];
      } else if (window.AgentExecutor && typeof window.AgentExecutor.getIntents === 'function') {
        _ctx.intents = window.AgentExecutor.getIntents() || [];
      } else {
        _ctx.intents = [];
      }
    } catch(e) { _ctx.intents = []; }

    _ctx.pendingCount = _ctx.intents.filter(function(i) {
      return i.status === 'pending' || i.status === 'approved' || i.status === 'executing';
    }).length;
  }

  // ── Refresh recent operations from audit/execution ─────────────────────────
  function refreshRecentOps() {
    _ctx.recentOps = [];
    var today = new Date().toISOString().slice(0, 10);
    _ctx.todayOpsCount = 0;

    // Try audit system first
    if (D.AgentAudit && typeof D.AgentAudit.getRecentActivity === 'function') {
      var entries = D.AgentAudit.getRecentActivity(20) || [];
      _ctx.recentOps = entries.slice(0, 5);
      _ctx.todayOpsCount = entries.filter(function(e) {
        return (e.timestamp || '').slice(0, 10) === today;
      }).length;
      return;
    }

    // Fallback: execution history
    if (D.AgentExecution && typeof D.AgentExecution.getHistory === 'function') {
      var hist = D.AgentExecution.getHistory({}, 20) || [];
      _ctx.recentOps = hist.slice(0, 5);
      _ctx.todayOpsCount = hist.filter(function(e) {
        return (e.createdAt || '').slice(0, 10) === today;
      }).length;
      return;
    }

    // Fallback: intent history
    if (D.AgentIntents && typeof D.AgentIntents.getIntentHistory === 'function') {
      var intentHist = D.AgentIntents.getIntentHistory(20) || [];
      _ctx.recentOps = intentHist.slice(0, 5);
      _ctx.todayOpsCount = intentHist.filter(function(e) {
        return (e.createdAt || '').slice(0, 10) === today;
      }).length;
      return;
    }
  }

  // ── Full refresh ───────────────────────────────────────────────────────────
  async function refreshAll() {
    await refreshWallet();
    await refreshBalances();
    refreshIntents();
    refreshRecentOps();
    _notify();
  }

  // ── Subscribe / onChange ───────────────────────────────────────────────────
  function onChange(fn) { _listeners.push(fn); }

  // ── Get current snapshot ───────────────────────────────────────────────────
  function getContext() { return Object.assign({}, _ctx); }

  // ── Initialize event listeners ─────────────────────────────────────────────
  function init() {
    // Listen for wallet events
    window.addEventListener('agentWallet:initialized', function() { refreshAll(); });
    window.addEventListener('agentWallet:walletCreated', function() { refreshAll(); });
    window.addEventListener('agentWallet:treasuryRefreshed', function() { refreshBalances().then(_notify); });
    window.addEventListener('agentWallet:registered', function() { refreshWallet().then(_notify); });

    // Listen for intent events
    var intentEvents = ['agentIntent:created','agentIntent:submitted','agentIntent:approved',
      'agentIntent:cancelled','agentIntent:rejected','agentIntent:completed','agentIntent:failed',
      'agentIntent:expired','agentIntent:updated'];
    intentEvents.forEach(function(evt) {
      window.addEventListener(evt, function() { refreshIntents(); refreshRecentOps(); _notify(); });
    });

    // Listen for execution events
    var execEvents = ['agentExecution:completed','agentExecution:failed','agentExecution:enqueued',
      'agentExecution:started','agentExecutor:update'];
    execEvents.forEach(function(evt) {
      window.addEventListener(evt, function() { refreshIntents(); refreshRecentOps(); _notify(); });
    });

    // Listen for wallet connection — initiate wallet init, context refreshes via events
    window.addEventListener('walletConnected', function() {
      if (D.AgentWallet && typeof D.AgentWallet.init === 'function') {
        D.AgentWallet.init().then(function() {
          refreshAll();
        });
      }
    });

    // If AgentWallet is already initialized, refresh immediately
    if (D.AgentWallet && D.AgentWallet.state && D.AgentWallet.state.initialized && D.AgentWallet.state.agentAddress) {
      refreshAll();
    } else if (D.AgentWallet && D.AgentWallet.state && D.AgentWallet.state.initialized) {
      refreshAll();
    }
  }

  // ── Wallet card HTML ───────────────────────────────────────────────────────
  function renderWalletCard() {
    var w = _ctx.wallet;
    var b = _ctx.balances;
    if (!w) return '<div class="agctx-card"><p style="color:#6b7280;text-align:center;padding:16px;">No agent wallet. Type <b>create agent wallet</b> to get started.</p></div>';

    var shortAddr = w.address.slice(0, 6) + '...' + w.address.slice(-4);
    var usdc = (b && b.USDC) ? b.USDC.human : '—';
    var eurc = (b && b.EURC) ? b.EURC.human : '—';
    var statusDot = _ctx.isAuthorized ? '#22c55e' : '#f59e0b';
    var statusText = _ctx.isAuthorized ? 'Authorized' : 'Not authorized';

    return '<div class="agctx-card agctx-wallet-card">' +
      '<div class="agctx-card-header">' +
        '<span style="font-size:18px;">🤖</span>' +
        '<span style="font-weight:700;color:#e5e7eb;">Agent Wallet</span>' +
        '<span style="margin-left:auto;display:inline-flex;align-items:center;gap:4px;font-size:10px;padding:2px 8px;border-radius:999px;background:' + statusDot + '1a;color:' + statusDot + ';border:1px solid ' + statusDot + '33;">' +
          '<span style="width:5px;height:5px;border-radius:50%;background:' + statusDot + ';"></span>' + statusText +
        '</span>' +
      '</div>' +
      '<div class="agctx-wallet-addr" title="' + w.address + '" onclick="navigator.clipboard.writeText(\'' + w.address + '\')" style="cursor:pointer;">' +
        '<code style="color:#a78bfa;font-size:14px;">' + shortAddr + '</code>' +
        '<span style="color:#6b7280;font-size:10px;margin-left:6px;">📋</span>' +
      '</div>' +
      '<div style="display:flex;gap:16px;margin-top:12px;">' +
        '<div style="flex:1;background:rgba(37,99,235,0.06);border:1px solid rgba(37,99,235,0.15);border-radius:10px;padding:10px 12px;">' +
          '<div style="font-size:10px;color:#6b7280;">USDC</div>' +
          '<div style="font-size:16px;font-weight:700;color:#60a5fa;">' + usdc + '</div>' +
        '</div>' +
        '<div style="flex:1;background:rgba(16,185,129,0.06);border:1px solid rgba(16,185,129,0.15);border-radius:10px;padding:10px 12px;">' +
          '<div style="font-size:10px;color:#6b7280;">EURC</div>' +
          '<div style="font-size:16px;font-weight:700;color:#34d399;">' + eurc + '</div>' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;gap:16px;margin-top:10px;font-size:11px;color:#9ca3af;">' +
        '<span>📊 ' + _ctx.todayOpsCount + ' ops today</span>' +
        '<span>⏳ ' + _ctx.pendingCount + ' pending</span>' +
      '</div>' +
    '</div>';
  }

  // ── Intent card HTML ───────────────────────────────────────────────────────
  function renderIntentCard(intent) {
    if (!intent) return '';
    var statusColors = {
      draft:     { color: '#6b7280', icon: '◌', label: 'Draft' },
      pending:   { color: '#f59e0b', icon: '◐', label: 'Pending' },
      approved:  { color: '#3b82f6', icon: '◑', label: 'Approved' },
      executing: { color: '#8b5cf6', icon: '↻', label: 'Executing' },
      completed: { color: '#22c55e', icon: '✓', label: 'Completed' },
      failed:    { color: '#ef4444', icon: '✕', label: 'Failed' },
      cancelled: { color: '#6b7280', icon: '✕', label: 'Cancelled' },
      expired:   { color: '#6b7280', icon: '⏰', label: 'Expired' },
    };
    var s = statusColors[intent.status] || statusColors.draft;
    var amt = (intent.params && intent.params.amount) ? intent.params.amount : '—';
    var tok = (intent.params && intent.params.token) || '';
    var to = (intent.params && intent.params.to) || '';
    var toShort = to.length > 12 ? to.slice(0, 6) + '...' + to.slice(-4) : to;
    var txLink = '';
    if (intent.execution && intent.execution.txHash) {
      txLink = '<a href="https://testnet.arcscan.app/tx/' + intent.execution.txHash + '" target="_blank" style="color:#a78bfa;font-size:10px;">View TX ↗</a>';
    }
    var errorMsg = '';
    if (intent.execution && intent.execution.error) {
      errorMsg = '<div style="color:#f87171;font-size:10px;margin-top:6px;padding:6px 8px;background:rgba(239,68,68,0.08);border-radius:6px;">' + String(intent.execution.error).slice(0, 120) + '</div>';
    }

    return '<div class="agctx-card agctx-intent-card">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">' +
        '<span style="color:' + s.color + ';font-size:16px;">' + s.icon + '</span>' +
        '<span style="text-transform:uppercase;font-size:11px;font-weight:700;color:#9ca3af;">' + (intent.type || 'intent') + '</span>' +
        '<span style="margin-left:auto;font-size:10px;padding:2px 8px;border-radius:999px;background:' + s.color + '1a;color:' + s.color + ';border:1px solid ' + s.color + '33;">' + s.label + '</span>' +
      '</div>' +
      '<div style="font-size:14px;font-weight:600;color:#e5e7eb;">' + amt + ' ' + tok + '</div>' +
      (to ? '<div style="font-size:11px;color:#6b7280;margin-top:2px;">To: <code style="color:#9ca3af;">' + toShort + '</code></div>' : '') +
      errorMsg +
      '<div style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:10px;color:#6b7280;">' +
        '<span>' + (intent.createdAt ? new Date(intent.createdAt).toLocaleTimeString() : '') + '</span>' +
        txLink +
      '</div>' +
    '</div>';
  }

  // ── Operations summary HTML ────────────────────────────────────────────────
  function renderRecentActivity() {
    var ops = _ctx.recentOps;
    if (!ops || ops.length === 0) {
      return '<div class="agctx-card"><p style="color:#6b7280;text-align:center;padding:12px;font-size:12px;">No recent agent activity.</p></div>';
    }

    var html = '<div style="font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Recent Activity</div>';
    ops.forEach(function(op) {
      var action = op.action || op.type || 'operation';
      var status = op.status || 'completed';
      var amt = op.amount || (op.params && op.params.amount) || '';
      var tok = op.token || (op.params && op.params.token) || '';
      var time = op.timestamp || op.createdAt || '';
      var txHash = op.txHash || (op.execution && op.execution.txHash) || (op.result && op.result.txHash) || '';
      var sc = status === 'completed' || status === 'success' ? '#22c55e' :
                status === 'failed' || status === 'error' ? '#ef4444' :
                status === 'pending' || status === 'warning' ? '#f59e0b' : '#6b7280';
      var si = status === 'completed' || status === 'success' ? '✓' :
                status === 'failed' || status === 'error' ? '✕' :
                status === 'pending' || status === 'warning' ? '◐' : '—';

      html += '<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid rgba(55,65,81,0.3);">' +
        '<span style="color:' + sc + ';font-size:12px;width:16px;">' + si + '</span>' +
        '<span style="font-size:11px;color:#e5e7eb;">' + action + '</span>' +
        (amt ? '<span style="font-size:11px;color:#9ca3af;">' + amt + ' ' + tok + '</span>' : '') +
        '<span style="margin-left:auto;font-size:10px;color:#6b7280;">' + (time ? new Date(time).toLocaleTimeString() : '') + '</span>' +
        (txHash ? '<a href="https://testnet.arcscan.app/tx/' + txHash + '" target="_blank" style="color:#a78bfa;font-size:9px;">TX</a>' : '') +
      '</div>';
    });
    return '<div class="agctx-card">' + html + '</div>';
  }

  // ── Compact context header ─────────────────────────────────────────────────
  function renderCompactHeader() {
    var w = _ctx.wallet;
    var b = _ctx.balances;
    if (!w) return '';

    var shortAddr = w.address.slice(0, 6) + '...' + w.address.slice(-4);
    var usdc = (b && b.USDC) ? parseFloat(b.USDC.human).toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2}) : '—';
    var eurc = (b && b.EURC) ? parseFloat(b.EURC.human).toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2}) : '—';
    var statusDot = _ctx.isAuthorized ? '#22c55e' : '#f59e0b';

    return '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;">' +
      '<span style="color:#9ca3af;">Agent Wallet</span>' +
      '<code style="color:#a78bfa;font-size:11px;" title="' + w.address + '">' + shortAddr + '</code>' +
      '<span style="width:5px;height:5px;border-radius:50%;background:' + statusDot + ';"></span>' +
      '<span style="color:#9ca3af;">USDC</span><span style="color:#e5e7eb;font-weight:600;">$' + usdc + '</span>' +
      '<span style="color:#9ca3af;">EURC</span><span style="color:#e5e7eb;font-weight:600;">€' + eurc + '</span>' +
      '<span style="color:#9ca3af;">Pending</span><span style="color:#f59e0b;font-weight:600;">' + _ctx.pendingCount + '</span>' +
      '<span style="color:#9ca3af;">Today</span><span style="color:#22c55e;font-weight:600;">' + _ctx.todayOpsCount + '</span>' +
    '</div>';
  }

  // ── Expose ─────────────────────────────────────────────────────────────────
  D.AgentContext = {
    get context() { return _ctx; },
    getContext: getContext,
    refresh: refreshAll,
    refreshWallet: refreshWallet,
    refreshBalances: refreshBalances,
    refreshIntents: refreshIntents,
    refreshRecentOps: refreshRecentOps,
    onChange: onChange,
    init: init,
    renderWalletCard: renderWalletCard,
    renderIntentCard: renderIntentCard,
    renderRecentActivity: renderRecentActivity,
    renderCompactHeader: renderCompactHeader,
  };

  // Auto-init after modules load
  if (D.AgentWallet && D.AgentWallet.state) {
    init();
  } else {
    // If AgentWallet hasn't loaded yet, init on first event
    var _ctxInitCheck = setInterval(function() {
      if (D.AgentWallet && D.AgentWallet.state) {
        clearInterval(_ctxInitCheck);
        init();
      }
    }, 100);
    setTimeout(function() { clearInterval(_ctxInitCheck); }, 5000);
  }

  console.log('[AgentContext] Bridge loaded — consuming AgentWallet + AgentIntents');
})();
