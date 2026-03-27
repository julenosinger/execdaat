// ============================================================
// PERMIT2-CHAT.JS — Chatbot-Based Permit2 Authorization
// ExecDaat · Arc Testnet · ChainId 5042002
//
// Responsibilities:
//  • Parse natural language permit intents from chatbot
//  • Build EIP-712 Permit2 payloads
//  • Request wallet signature (no auto-sign)
//  • Store/revoke permits in localStorage
//  • Expose createPermitFromChat(params) global function
//  • Feed active permits to AI agent spending checks
//
// NOTE: All locals are scoped in IIFE to avoid const re-declaration
//       conflicts with chat.js (ARC_CHAIN_ID, ARC_CHAIN_HEX, etc.)
// ============================================================
(function () {
'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
var PERMIT2_STORAGE_KEY = 'arc_permit2_allowances_v1';
var P2_USDC_TOKEN       = '0x3600000000000000000000000000000000000000';
var P2_EURC_TOKEN       = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
var P2_CHAIN_ID         = 5042002;
var P2_CHAIN_HEX        = '0x4cef52';
var MAX_PERMIT_DAYS     = 7; // hard cap — max 7 days per requirement

// Token registry
var TOKEN_MAP = {
  usdc: { address: P2_USDC_TOKEN, symbol: 'USDC', decimals: 6 },
  eurc: { address: P2_EURC_TOKEN, symbol: 'EURC', decimals: 6 },
};

// Action scope labels
var SCOPE_LABELS = {
  all:       'All platform operations',
  payments:  'Payments only',
  swap:      'Swaps only',
  multisend: 'Multisend only',
  contracts: 'Contract operations only',
};

// ── Storage helpers ───────────────────────────────────────────────────────────
function p2LoadAll() {
  try {
    var raw = localStorage.getItem(PERMIT2_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}

function p2SaveAll(list) {
  localStorage.setItem(PERMIT2_STORAGE_KEY, JSON.stringify(list));
}

function p2GetActive(walletAddress) {
  if (!walletAddress) return [];
  var now = Date.now();
  return p2LoadAll().filter(function(p) {
    return p.wallet.toLowerCase() === walletAddress.toLowerCase() &&
           p.expiry > now &&
           p.amount > 0;
  });
}

function p2AddPermit(permit) {
  var all = p2LoadAll();
  var idx = all.findIndex(function(p) {
    return p.wallet.toLowerCase() === permit.wallet.toLowerCase() &&
           p.token === permit.token &&
           p.scope === permit.scope;
  });
  if (idx >= 0) all.splice(idx, 1, permit);
  else all.push(permit);
  p2SaveAll(all);
}

function p2RevokePermit(wallet, token, scope) {
  var all = p2LoadAll();
  var updated = all.filter(function(p) {
    var sameWallet = p.wallet.toLowerCase() === wallet.toLowerCase();
    var sameToken  = !token || p.token === token;
    var sameScope  = !scope || p.scope === scope;
    return !(sameWallet && sameToken && sameScope);
  });
  p2SaveAll(updated);
  return all.length - updated.length;
}

function p2RevokeAll(wallet) {
  var all = p2LoadAll();
  var updated = all.filter(function(p) {
    return p.wallet.toLowerCase() !== wallet.toLowerCase();
  });
  p2SaveAll(updated);
  return all.length - updated.length;
}

// ── Natural Language Parser ────────────────────────────────────────────────────
function p2ParseIntent(msg) {
  var lower = msg.toLowerCase().trim();

  // ── VIEW intent ──────────────────────────────────────────────────────────────
  if (/show.*permit|list.*permit|my permit|show.*permission|list.*permission|my.*allowance|view.*permit|permissions?$/i.test(lower)) {
    return { type: 'view' };
  }

  // ── REVOKE intent ─────────────────────────────────────────────────────────────
  var revokeMatch = lower.match(
    /(?:revoke|remove|cancel|stop|disable|delete).*?(?:(usdc|eurc)\s*)?(?:permit|permission|allow|spending|autonomous)/i
  );
  if (revokeMatch || /stop autonomous|revoke.*agent spending|disable.*permit|cancel.*permit/i.test(lower)) {
    var rToken = revokeMatch && revokeMatch[1] ? revokeMatch[1].toUpperCase() : null;
    return { type: 'revoke', token: rToken };
  }

  // ── CREATE intent ──────────────────────────────────────────────────────────
  var createKeywords = /(?:allow|authorize|autorize|give|enable|grant|permit|approve)\s+(?:the\s+)?(?:agent|ai|arc|arcpay|me|my)?\s*(?:to\s+)?(?:spend|use|access|transfer|trade)/i;
  var altKeywords    = /(?:give\s+permission|set\s+(?:spending\s+)?limit|give\s+(?:the\s+)?agent|allow\s+spending)/i;
  var isCreate = createKeywords.test(msg) || altKeywords.test(msg);

  if (!isCreate) return null;

  var amtMatch = msg.match(/(\d+(?:\.\d+)?)\s*(usdc|eurc)?/i);
  var amount   = amtMatch ? parseFloat(amtMatch[1]) : null;
  if (!amount || amount <= 0) return { type: 'create', error: 'no_amount' };

  var tokenMatch = msg.match(/\b(usdc|eurc)\b/i);
  var token      = tokenMatch ? tokenMatch[1].toUpperCase() : 'USDC';

  var durationHours = 24;
  var durMatch = msg.match(/(\d+)\s*(hour|hr|h|day|d|week|wk|w|minute|min)\b/i);
  if (durMatch) {
    var val  = parseInt(durMatch[1]);
    var unit = durMatch[2].toLowerCase();
    if (/^(h|hr|hour)/.test(unit))       durationHours = val;
    else if (/^(d|day)/.test(unit))      durationHours = val * 24;
    else if (/^(w|wk|week)/.test(unit))  durationHours = val * 24 * 7;
    else if (/^(m|min)/.test(unit))      durationHours = val / 60;
  } else if (/today/i.test(msg)) {
    durationHours = 24;
  } else if (/this week/i.test(msg)) {
    durationHours = 7 * 24;
  }

  durationHours = Math.min(durationHours, MAX_PERMIT_DAYS * 24);

  var scope = 'all';
  if (/payment|pay\b/i.test(msg))            scope = 'payments';
  else if (/swap|exchange|trade/i.test(msg)) scope = 'swap';
  else if (/multisend|batch/i.test(msg))     scope = 'multisend';
  else if (/contract/i.test(msg))            scope = 'contracts';

  return { type: 'create', token: token, amount: amount, durationHours: durationHours, scope: scope };
}

// ── EIP-712 Permit2 payload builder ──────────────────────────────────────────
function p2BuildTypedData(params) {
  var wallet    = params.wallet;
  var token     = params.token;
  var amount    = params.amount;
  var expiry    = params.expiry;
  var scope     = params.scope;
  var nonce     = params.nonce;
  var tokenInfo = TOKEN_MAP[token.toLowerCase()];
  var amountWei = BigInt(Math.round(amount * Math.pow(10, tokenInfo ? tokenInfo.decimals : 6))).toString();

  return {
    types: {
      EIP712Domain: [
        { name: 'name',    type: 'string'  },
        { name: 'version', type: 'string'  },
        { name: 'chainId', type: 'uint256' },
      ],
      PermitAuthorization: [
        { name: 'owner',  type: 'address' },
        { name: 'token',  type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'expiry', type: 'uint256' },
        { name: 'scope',  type: 'string'  },
        { name: 'nonce',  type: 'uint256' },
      ],
    },
    primaryType: 'PermitAuthorization',
    domain: {
      name:    'ARC Permit2 Authorization',
      version: '1',
      chainId: P2_CHAIN_ID,
    },
    message: {
      owner:  wallet,
      token:  tokenInfo ? tokenInfo.address : P2_USDC_TOKEN,
      amount: amountWei,
      expiry: Math.floor(expiry / 1000),
      scope:  scope,
      nonce:  nonce,
    },
  };
}

// ── Core: createPermitFromChat ────────────────────────────────────────────────
async function createPermitFromChat(params) {
  var token         = params.token;
  var amount        = params.amount;
  var durationHours = params.durationHours;
  var scope         = params.scope;
  var wallet        = params.wallet;

  if (!wallet) {
    throw new Error('No wallet connected. Connect your EVM wallet first.');
  }
  if (!amount || amount <= 0) {
    throw new Error('Amount must be greater than 0.');
  }
  if (!durationHours || durationHours <= 0) {
    throw new Error('Duration must be greater than 0.');
  }
  if (durationHours > MAX_PERMIT_DAYS * 24) {
    throw new Error('Maximum permit duration is ' + MAX_PERMIT_DAYS + ' days (' + (MAX_PERMIT_DAYS * 24) + ' hours).');
  }

  var provider = (window.walletState && window.walletState.provider) || window.ethereum;
  if (!provider) throw new Error('Wallet provider not found. Reconnect your wallet.');

  var chainHex = await provider.request({ method: 'eth_chainId' });
  if (parseInt(chainHex, 16) !== P2_CHAIN_ID) {
    try {
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: P2_CHAIN_HEX }],
      });
    } catch (e) {
      throw new Error('Please switch to Arc Testnet (Chain 5042002) before signing.');
    }
  }

  var expiry    = Date.now() + durationHours * 3600 * 1000;
  var nonce     = Date.now();
  var typedData = p2BuildTypedData({ wallet: wallet, token: token, amount: amount, expiry: expiry, scope: scope, nonce: nonce });

  var signature;
  try {
    signature = await provider.request({
      method: 'eth_signTypedData_v4',
      params: [wallet, JSON.stringify(typedData)],
    });
  } catch (e) {
    if (e.code === 4001 || /denied|rejected|cancelled/i.test(e.message || '')) {
      throw new Error('Signature cancelled by user.');
    }
    throw new Error('Signature error: ' + (e.message || e));
  }

  var tokenInfo = TOKEN_MAP[token.toLowerCase()] || TOKEN_MAP.usdc;
  var permit = {
    id:           'permit_' + Date.now().toString(36),
    wallet:       wallet,
    token:        token.toUpperCase(),
    tokenAddress: tokenInfo.address,
    amount:       amount,
    amountUsed:   0,
    expiry:       expiry,
    scope:        scope,
    nonce:        nonce,
    signature:    signature,
    createdVia:   'chat',
    createdAt:    Date.now(),
    label:        amount + ' ' + token.toUpperCase() + ' — ' + (SCOPE_LABELS[scope] || scope),
  };

  p2AddPermit(permit);
  p2RefreshUI();
  return permit;
}

// ── Check if an operation is permitted ───────────────────────────────────────
function p2CheckAllowance(wallet, token, amount, operationScope) {
  if (!wallet) return { allowed: false, reason: 'No wallet' };
  var now     = Date.now();
  var permits = p2GetActive(wallet);
  var matched = permits.find(function(p) {
    var tokenMatch  = p.token.toUpperCase() === token.toUpperCase();
    var scopeMatch  = p.scope === 'all' || p.scope === operationScope;
    var amountOk    = (p.amount - (p.amountUsed || 0)) >= amount;
    var notExpired  = p.expiry > now;
    return tokenMatch && scopeMatch && amountOk && notExpired;
  });
  if (!matched) return { allowed: false, reason: 'No active permit covers this operation' };
  return { allowed: true, permit: matched };
}

function p2RecordUsage(permitId, amountUsed) {
  var all = p2LoadAll();
  var idx = all.findIndex(function(p) { return p.id === permitId; });
  if (idx >= 0) {
    all[idx].amountUsed = (all[idx].amountUsed || 0) + amountUsed;
    if (all[idx].amountUsed >= all[idx].amount) all[idx].amount = 0;
    p2SaveAll(all);
  }
}

// ── Duration / expiry formatters ──────────────────────────────────────────────
function p2FormatDuration(hours) {
  if (hours < 1)       return Math.round(hours * 60) + ' minutes';
  if (hours < 24)      return hours + ' hour' + (hours !== 1 ? 's' : '');
  if (hours < 24 * 7)  return Math.round(hours / 24) + ' day' + (Math.round(hours / 24) !== 1 ? 's' : '');
  return Math.round(hours / (24 * 7)) + ' week' + (Math.round(hours / (24 * 7)) !== 1 ? 's' : '');
}

function p2FormatExpiry(ts) {
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ── Chat Intent Handler ───────────────────────────────────────────────────────
async function handlePermitIntent(msg) {
  var intent = p2ParseIntent(msg);
  if (!intent) return false;

  // These helpers come from chat.js which loads after this file — safe at call time
  var _hide   = function() { if (typeof hideTypingIndicator   === 'function') hideTypingIndicator(); };
  var _append = function(role, txt, mod) { if (typeof appendChatMessage  === 'function') appendChatMessage(role, txt, mod); };
  var _card   = function(btns)           { if (typeof appendActionCard   === 'function') appendActionCard(btns); };
  var _toast  = function(msg, t)         { if (typeof showToast          === 'function') showToast(msg, t); };

  _hide();
  var wallet = window.walletState && window.walletState.address;

  // ── VIEW ─────────────────────────────────────────────────────────────────────
  if (intent.type === 'view') {
    if (!wallet) {
      _append('assistant', '🔐 **Permit2 Permissions**\n\nConnect your wallet to view active permits.', 'permit2');
      _card([{ label: '🔗 Connect Wallet', action: 'openWalletModal()', primary: true }]);
      return true;
    }
    var active = p2GetActive(wallet);
    if (!active.length) {
      _append('assistant',
        '🔐 **Permit2 Permissions**\n\n' +
        'No active permits for `' + wallet.slice(0, 10) + '…`\n\n' +
        'Use a command like:\n`allow the agent to spend 100 USDC for 24 hours`',
        'permit2');
      return true;
    }
    var lines = active.map(function(p) {
      var remaining = (p.amount - (p.amountUsed || 0)).toFixed(2);
      var expires   = p2FormatExpiry(p.expiry);
      var tag       = p.createdVia === 'chat' ? ' 🤖 *Created via AI*' : '';
      return '• **' + remaining + ' ' + p.token + '** · ' + (SCOPE_LABELS[p.scope] || p.scope) + ' · expires ' + expires + tag;
    }).join('\n');
    _append('assistant', '🔐 **Active Permit2 Permissions** (' + active.length + ')\n\n' + lines, 'permit2');
    _card([
      { label: '🗑️ Revoke All', action: "sendQuickMessage('revoke all permits')", danger: true },
      { label: '+ New Permit',  action: "sendQuickMessage('allow 100 USDC for 24 hours')", primary: true },
    ]);
    return true;
  }

  // ── REVOKE ───────────────────────────────────────────────────────────────────
  if (intent.type === 'revoke') {
    if (!wallet) {
      _append('assistant', '⚠️ Connect your wallet first to revoke permits.', 'permit2');
      _card([{ label: '🔗 Connect Wallet', action: 'openWalletModal()', primary: true }]);
      return true;
    }
    var tokenFilter = intent.token ? intent.token.toUpperCase() : null;
    var removed = tokenFilter ? p2RevokePermit(wallet, tokenFilter, null) : p2RevokeAll(wallet);
    p2RefreshUI();
    if (removed === 0) {
      _append('assistant', 'ℹ️ No active ' + (tokenFilter ? tokenFilter + ' ' : '') + 'permits found to revoke.', 'permit2');
    } else {
      _append('assistant',
        '✅ **' + removed + ' permit' + (removed > 1 ? 's' : '') + ' revoked.**\n\n' +
        (tokenFilter ? 'All ' + tokenFilter + ' permits' : 'All permits') + ' have been removed.\n' +
        'The agent can no longer spend autonomously' + (tokenFilter ? ' (' + tokenFilter + ')' : '') + '.',
        'permit2');
      _toast(removed + ' permit' + (removed > 1 ? 's' : '') + ' revoked.', 'info');
    }
    return true;
  }

  // ── CREATE — parse error ──────────────────────────────────────────────────────
  if (intent.type === 'create' && intent.error === 'no_amount') {
    _append('assistant',
      '❓ I couldn\'t extract an amount from your request.\n\n' +
      '**Try something like:**\n' +
      '`allow the agent to spend 100 USDC for 24 hours`\n' +
      '`give permission for swaps up to 50 USDC today`',
      'permit2');
    return true;
  }

  // ── CREATE — confirm step ─────────────────────────────────────────────────────
  if (intent.type === 'create') {
    if (!wallet) {
      _append('assistant', '⚠️ **Wallet required**\n\nConnect your EVM wallet before creating a spending permit.', 'permit2');
      _card([{ label: '🔗 Connect Wallet', action: 'openWalletModal()', primary: true }]);
      return true;
    }
    var token         = intent.token;
    var amount        = intent.amount;
    var durationHours = intent.durationHours;
    var scope         = intent.scope;
    var durLabel      = p2FormatDuration(durationHours);
    var scopeLabel    = SCOPE_LABELS[scope] || scope;
    var expiryDate    = p2FormatExpiry(Date.now() + durationHours * 3600 * 1000);

    _append('assistant',
      '🔐 **Permit2 Authorization Request**\n\n' +
      'You\'re about to allow the agent to spend:\n\n' +
      '| Field | Value |\n' +
      '|---|---|\n' +
      '| Token | **' + token.toUpperCase() + '** |\n' +
      '| Amount | **' + amount + ' ' + token.toUpperCase() + '** |\n' +
      '| Duration | **' + durLabel + '** |\n' +
      '| Scope | ' + scopeLabel + ' |\n' +
      '| Expires | ' + expiryDate + ' |\n\n' +
      '⚠️ *Signature required from your wallet. This is off-chain only — no gas cost.*\n\n' +
      '**Confirm to proceed?**',
      'permit2');

    window._pendingPermit = { token: token, amount: amount, durationHours: durationHours, scope: scope, wallet: wallet };

    _card([
      { label: '✅ Confirm & Sign', action: 'window._confirmPermitFromChat()', primary: true, success: true },
      { label: '✕ Cancel',          action: 'window._cancelPermitFromChat()',  danger: false },
    ]);
    return true;
  }

  return false;
}

// ── Confirm / Cancel callbacks ────────────────────────────────────────────────
window._confirmPermitFromChat = async function () {
  var params = window._pendingPermit;
  window._pendingPermit = null;
  if (!params) {
    if (typeof appendChatMessage === 'function') appendChatMessage('assistant', '⚠️ No pending permit request found.', 'permit2');
    return;
  }
  if (typeof showTypingIndicator === 'function') showTypingIndicator();
  var token         = params.token;
  var amount        = params.amount;
  var durationHours = params.durationHours;
  var scope         = params.scope;
  var durLabel = p2FormatDuration(durationHours);

  try {
    var permit = await createPermitFromChat(params);
    if (typeof hideTypingIndicator === 'function') hideTypingIndicator();
    if (typeof appendChatMessage === 'function') {
      appendChatMessage('assistant',
        '✅ **Autonomous spending enabled!**\n\n' +
        'Your agent can now use up to **' + amount + ' ' + token + '** for **' + durLabel + '**.\n\n' +
        '| Detail | Value |\n' +
        '|---|---|\n' +
        '| Scope | ' + (SCOPE_LABELS[scope] || scope) + ' |\n' +
        '| Expires | ' + p2FormatExpiry(permit.expiry) + ' |\n' +
        '| Permit ID | `' + permit.id + '` |\n' +
        '| Created via | 🤖 AI Chat |\n\n' +
        '*The agent will automatically use this permit within the defined limits.*',
        'permit2');
    }
    if (typeof showToast === 'function') showToast('✅ Permit created: ' + amount + ' ' + token + ' for ' + durLabel, 'success');
    if (typeof appendActionCard === 'function') {
      appendActionCard([
        { label: '👁️ View Permits', action: "sendQuickMessage('show my permissions')", primary: true },
        { label: '🗑️ Revoke',       action: "sendQuickMessage('revoke " + token + " permit')", danger: true },
      ]);
    }
  } catch (e) {
    if (typeof hideTypingIndicator === 'function') hideTypingIndicator();
    var msg = e.message || String(e);
    var isCancelled = /cancel|reject|denied/i.test(msg);
    if (typeof appendChatMessage === 'function') {
      appendChatMessage('assistant',
        isCancelled
          ? '⚠️ **Signature cancelled.**\n\nThe permit was not created. You can try again anytime.'
          : '❌ **Permit creation failed**\n\n' + msg,
        'permit2');
    }
  }
};

window._cancelPermitFromChat = function () {
  window._pendingPermit = null;
  if (typeof appendChatMessage === 'function') {
    appendChatMessage('assistant',
      '↩️ **Permit request cancelled.**\n\nNo changes made. You can create a permit anytime by typing something like:\n`allow 100 USDC for 24 hours`',
      'permit2');
  }
};

// ── UI Refresh ────────────────────────────────────────────────────────────────
function p2RefreshUI() {
  renderPermit2Panel();
  var badge = document.getElementById('permit2-count-badge');
  if (badge) {
    var wallet = window.walletState && window.walletState.address;
    var count  = wallet ? p2GetActive(wallet).length : 0;
    badge.textContent = count;
    badge.classList.toggle('hidden', count === 0);
  }
}

// ── Render active permits panel ───────────────────────────────────────────────
function renderPermit2Panel() {
  var panel = document.getElementById('permit2-active-panel');
  if (!panel) return;

  var wallet = window.walletState && window.walletState.address;
  if (!wallet) {
    panel.innerHTML =
      '<div class="text-center text-gray-600 text-sm py-4">' +
        '<i class="fas fa-lock text-gray-700 text-2xl mb-2 block"></i>' +
        'Connect wallet to view permits' +
      '</div>';
    return;
  }

  var active = p2GetActive(wallet);
  if (!active.length) {
    panel.innerHTML =
      '<div class="text-center text-gray-500 text-sm py-4">' +
        '<i class="fas fa-unlock-alt text-gray-600 text-2xl mb-2 block"></i>' +
        'No active permits for <code class="text-xs text-gray-400">' + wallet.slice(0, 10) + '…</code><br>' +
        '<span class="text-xs">Use the chat to create a permit.</span>' +
      '</div>';
    return;
  }

  panel.innerHTML = active.map(function(p) {
    var remaining  = (p.amount - (p.amountUsed || 0)).toFixed(2);
    var used       = (p.amountUsed || 0).toFixed(2);
    var pct        = p.amount > 0 ? Math.round((p.amountUsed || 0) / p.amount * 100) : 0;
    var expires    = p2FormatExpiry(p.expiry);
    var scopeLabel = SCOPE_LABELS[p.scope] || p.scope;
    var isAI       = p.createdVia === 'chat';
    var hoursLeft  = Math.max(0, (p.expiry - Date.now()) / 3600000);
    var urgentClass = hoursLeft < 2
      ? 'border-red-500/40 bg-red-900/10'
      : hoursLeft < 12
        ? 'border-yellow-500/30 bg-yellow-900/10'
        : 'border-yellow-600/20 bg-yellow-900/5';

    return '<div class="border ' + urgentClass + ' rounded-lg p-3">' +
      '<div class="flex items-start justify-between gap-2">' +
        '<div class="flex-1 min-w-0">' +
          '<div class="flex items-center gap-2 mb-1">' +
            '<span class="text-sm font-semibold text-white">' + remaining + ' ' + p.token + '</span>' +
            '<span class="text-xs text-gray-500">/ ' + p.amount + ' total</span>' +
            (isAI ? '<span class="text-[10px] bg-yellow-500/20 border border-yellow-500/40 text-yellow-400 rounded px-1.5 py-0.5">🤖 Created via AI</span>' : '') +
          '</div>' +
          '<div class="flex items-center gap-3 text-xs text-gray-500">' +
            '<span><i class="fas fa-tag mr-1"></i>' + scopeLabel + '</span>' +
            '<span><i class="fas fa-clock mr-1"></i>Expires ' + expires + '</span>' +
          '</div>' +
          '<div class="mt-2 h-1 bg-gray-700 rounded-full overflow-hidden">' +
            '<div class="h-full bg-gradient-to-r from-yellow-500 to-amber-600 rounded-full" style="width:' + pct + '%"></div>' +
          '</div>' +
          '<div class="flex justify-between text-[10px] text-gray-600 mt-0.5">' +
            '<span>Used: ' + used + ' ' + p.token + ' (' + pct + '%)</span>' +
            '<span>Remaining: ' + remaining + ' ' + p.token + '</span>' +
          '</div>' +
        '</div>' +
        '<button onclick="window._p2RevokeFromPanel(\'' + p.id + '\')"' +
          ' class="flex-shrink-0 text-red-500 hover:text-red-400 hover:bg-red-900/20 rounded-lg p-1.5 transition-colors" title="Revoke permit">' +
          '<i class="fas fa-trash text-xs"></i>' +
        '</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

// Called from panel revoke button
window._p2RevokeFromPanel = function(permitId) {
  var all    = p2LoadAll();
  var permit = all.find(function(p) { return p.id === permitId; });
  if (!permit) return;
  var updated = all.filter(function(p) { return p.id !== permitId; });
  p2SaveAll(updated);
  p2RefreshUI();
  if (typeof showToast === 'function') showToast('Permit revoked: ' + permit.amount + ' ' + permit.token, 'info');
  if (typeof appendChatMessage === 'function') {
    appendChatMessage('assistant',
      '✅ **Permit revoked.**\n\n' + permit.amount + ' ' + permit.token +
      ' (' + (SCOPE_LABELS[permit.scope] || permit.scope) + ') spending permission removed.',
      'permit2');
  }
};

// ── Global exports ────────────────────────────────────────────────────────────
window.createPermitFromChat = createPermitFromChat;
window.p2ParseIntent        = p2ParseIntent;
window.p2GetActive          = p2GetActive;
window.p2CheckAllowance     = p2CheckAllowance;
window.p2RecordUsage        = p2RecordUsage;
window.p2RevokePermit       = p2RevokePermit;
window.p2RevokeAll          = p2RevokeAll;
window.p2FormatExpiry       = p2FormatExpiry;
window.p2FormatDuration     = p2FormatDuration;
window.handlePermitIntent   = handlePermitIntent;
window.p2RefreshUI          = p2RefreshUI;
window.renderPermit2Panel   = renderPermit2Panel;

// ── Wallet sync ───────────────────────────────────────────────────────────────
window.addEventListener('walletConnected',    function() { setTimeout(p2RefreshUI, 200); });
window.addEventListener('walletDisconnected', function() { setTimeout(p2RefreshUI, 200); });

// ── Auto-cleanup expired permits on load ──────────────────────────────────────
(function p2CleanExpired() {
  var now   = Date.now();
  var all   = p2LoadAll();
  var fresh = all.filter(function(p) { return p.expiry > now; });
  if (fresh.length !== all.length) {
    p2SaveAll(fresh);
    console.log('[Permit2] Cleaned ' + (all.length - fresh.length) + ' expired permit(s).');
  }
})();

// ── Periodic cleanup (every 5 min) ────────────────────────────────────────────
setInterval(function() {
  var now   = Date.now();
  var all   = p2LoadAll();
  var fresh = all.filter(function(p) { return p.expiry > now; });
  if (fresh.length !== all.length) {
    p2SaveAll(fresh);
    p2RefreshUI();
  }
}, 5 * 60 * 1000);

console.log('[Permit2] Module loaded — Arc Testnet 5042002 | Max ' + MAX_PERMIT_DAYS + ' days | EIP-712 off-chain');

})(); // end IIFE
