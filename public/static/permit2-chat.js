// ============================================================
// PERMIT2-CHAT.JS — Chatbot-Based Permit2 Authorization
// ARC AI Agents · Arc Testnet · ChainId 5042002
//
// Responsibilities:
//  • Parse natural language permit intents from chatbot
//  • Build EIP-712 Permit2 payloads
//  • Request wallet signature (no auto-sign)
//  • Store/revoke permits in localStorage
//  • Expose createPermitFromChat(params) global function
//  • Feed active permits to AI agent spending checks
// ============================================================
'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const PERMIT2_STORAGE_KEY = 'arc_permit2_allowances_v1';
const PERMIT2_ADDRESS     = '0x000000000022D473030F116dDEE9F6B43aC78BA3'; // canonical Permit2
const USDC_TOKEN          = '0x3600000000000000000000000000000000000000';
const EURC_TOKEN          = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const ARC_CHAIN_ID        = 5042002;
const ARC_CHAIN_HEX       = '0x4cef52';
const MAX_PERMIT_DAYS     = 7; // hard cap — max 7 days per requirement

// Token registry
const TOKEN_MAP = {
  usdc: { address: USDC_TOKEN, symbol: 'USDC', decimals: 6 },
  eurc: { address: EURC_TOKEN, symbol: 'EURC', decimals: 6 },
};

// Action scope labels
const SCOPE_LABELS = {
  all:       'All platform operations',
  payments:  'Payments only',
  swap:      'Swaps only',
  multisend: 'Multisend only',
  contracts: 'Contract operations only',
};

// ── Storage helpers ───────────────────────────────────────────────────────────
function p2LoadAll() {
  try {
    const raw = localStorage.getItem(PERMIT2_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function p2SaveAll(list) {
  localStorage.setItem(PERMIT2_STORAGE_KEY, JSON.stringify(list));
}

function p2GetActive(walletAddress) {
  if (!walletAddress) return [];
  const now = Date.now();
  return p2LoadAll().filter(p =>
    p.wallet.toLowerCase() === walletAddress.toLowerCase() &&
    p.expiry > now &&
    p.amount > 0
  );
}

function p2AddPermit(permit) {
  const all = p2LoadAll();
  // Replace if same wallet + token + scope
  const idx = all.findIndex(p =>
    p.wallet.toLowerCase() === permit.wallet.toLowerCase() &&
    p.token === permit.token &&
    p.scope === permit.scope
  );
  if (idx >= 0) all.splice(idx, 1, permit);
  else all.push(permit);
  p2SaveAll(all);
}

function p2RevokePermit(wallet, token, scope) {
  const all = p2LoadAll();
  const updated = all.filter(p => {
    const sameWallet = p.wallet.toLowerCase() === wallet.toLowerCase();
    const sameToken  = !token  || p.token  === token;
    const sameScope  = !scope  || p.scope  === scope;
    return !(sameWallet && sameToken && sameScope);
  });
  p2SaveAll(updated);
  return all.length - updated.length; // number removed
}

function p2RevokeAll(wallet) {
  const all = p2LoadAll();
  const updated = all.filter(p => p.wallet.toLowerCase() !== wallet.toLowerCase());
  p2SaveAll(updated);
  return all.length - updated.length;
}

// ── Natural Language Parser ────────────────────────────────────────────────────
//
// Handles patterns like:
//   "allow/authorize/give/enable the agent to spend 100 USDC for 24 hours"
//   "give permission for swaps up to 50 USDC today"
//   "authorize payments of 200 USDC for the next 7 days"
//   "revoke my USDC permission / stop autonomous spending"
//   "show my permissions / list permits"

function p2ParseIntent(msg) {
  const lower = msg.toLowerCase().trim();

  // ── VIEW intent ─────────────────────────────────────────────────────────────
  if (/show.*permit|list.*permit|my permit|show.*permission|list.*permission|my.*allowance|view.*permit|permissions?$/i.test(lower)) {
    return { type: 'view' };
  }

  // ── REVOKE intent ────────────────────────────────────────────────────────────
  const revokeMatch = lower.match(
    /(?:revoke|remove|cancel|stop|disable|delete).*?(?:(usdc|eurc)\s*)?(?:permit|permission|allow|spending|autonomous)/i
  );
  if (revokeMatch || /stop autonomous|revoke.*agent spending|disable.*permit|cancel.*permit/i.test(lower)) {
    const token = revokeMatch?.[1]?.toUpperCase() || null;
    return { type: 'revoke', token };
  }

  // ── CREATE intent ─────────────────────────────────────────────────────────
  // Keyword triggers
  const createKeywords = /(?:allow|authorize|autorize|give|enable|grant|permit|approve)\s+(?:the\s+)?(?:agent|ai|arc|arcpay|me|my)?\s*(?:to\s+)?(?:spend|use|access|transfer|trade)/i;
  const altKeywords    = /(?:give\s+permission|set\s+(?:spending\s+)?limit|give\s+(?:the\s+)?agent|allow\s+spending)/i;
  const isCreate = createKeywords.test(msg) || altKeywords.test(msg);

  if (!isCreate) return null; // not a permit intent

  // Extract amount — look for number optionally followed by token
  const amtMatch = msg.match(/(\d+(?:\.\d+)?)\s*(usdc|eurc)?/i);
  const amount   = amtMatch ? parseFloat(amtMatch[1]) : null;
  if (!amount || amount <= 0) return { type: 'create', error: 'no_amount' };

  // Extract token
  const tokenMatch = msg.match(/\b(usdc|eurc)\b/i);
  const token      = tokenMatch ? tokenMatch[1].toUpperCase() : 'USDC';

  // Extract duration
  let durationHours = 24; // default
  const durMatch = msg.match(/(\d+)\s*(hour|hr|h|day|d|week|wk|w|minute|min)\b/i);
  if (durMatch) {
    const val  = parseInt(durMatch[1]);
    const unit = durMatch[2].toLowerCase();
    if (/^(h|hr|hour)/.test(unit))    durationHours = val;
    else if (/^(d|day)/.test(unit))   durationHours = val * 24;
    else if (/^(w|wk|week)/.test(unit)) durationHours = val * 24 * 7;
    else if (/^(m|min)/.test(unit))   durationHours = val / 60;
  } else if (/today/i.test(msg)) {
    durationHours = 24;
  } else if (/this week/i.test(msg)) {
    durationHours = 7 * 24;
  }

  // Cap duration
  durationHours = Math.min(durationHours, MAX_PERMIT_DAYS * 24);

  // Extract action scope
  let scope = 'all';
  if (/payment|pay\b/i.test(msg))   scope = 'payments';
  else if (/swap|exchange|trade/i.test(msg)) scope = 'swap';
  else if (/multisend|batch/i.test(msg)) scope = 'multisend';
  else if (/contract/i.test(msg))   scope = 'contracts';

  return { type: 'create', token, amount, durationHours, scope };
}

// ── EIP-712 Permit2 payload builder ──────────────────────────────────────────
//
// We use a simplified off-chain permit structure (not full Permit2 on-chain)
// since Arc Testnet may not have the canonical Permit2 contract.
// The signature proves intent; the backend/agent validates it.

function p2BuildTypedData(params) {
  const { wallet, token, amount, expiry, scope, nonce } = params;
  const tokenInfo   = TOKEN_MAP[token.toLowerCase()];
  const amountWei   = BigInt(Math.round(amount * Math.pow(10, tokenInfo?.decimals || 6))).toString();

  return {
    types: {
      EIP712Domain: [
        { name: 'name',    type: 'string'  },
        { name: 'version', type: 'string'  },
        { name: 'chainId', type: 'uint256' },
      ],
      PermitAuthorization: [
        { name: 'owner',    type: 'address' },
        { name: 'token',    type: 'address' },
        { name: 'amount',   type: 'uint256' },
        { name: 'expiry',   type: 'uint256' },
        { name: 'scope',    type: 'string'  },
        { name: 'nonce',    type: 'uint256' },
      ],
    },
    primaryType: 'PermitAuthorization',
    domain: {
      name:    'ARC Permit2 Authorization',
      version: '1',
      chainId: ARC_CHAIN_ID,
    },
    message: {
      owner:  wallet,
      token:  tokenInfo?.address || USDC_TOKEN,
      amount: amountWei,
      expiry: Math.floor(expiry / 1000), // Unix timestamp seconds
      scope,
      nonce,
    },
  };
}

// ── Core: createPermitFromChat ────────────────────────────────────────────────
async function createPermitFromChat(params) {
  const { token, amount, durationHours, scope, wallet } = params;

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
    throw new Error(`Maximum permit duration is ${MAX_PERMIT_DAYS} days (${MAX_PERMIT_DAYS * 24} hours).`);
  }

  // Ensure correct network
  const provider  = window.walletState?.provider || window.ethereum;
  if (!provider)  throw new Error('Wallet provider not found. Reconnect your wallet.');

  const chainHex = await provider.request({ method: 'eth_chainId' });
  if (parseInt(chainHex, 16) !== ARC_CHAIN_ID) {
    try {
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: ARC_CHAIN_HEX }],
      });
    } catch (e) {
      throw new Error('Please switch to Arc Testnet (Chain 5042002) before signing.');
    }
  }

  const expiry   = Date.now() + durationHours * 3600 * 1000;
  const nonce    = Date.now(); // simple nonce

  const typedData = p2BuildTypedData({ wallet, token, amount, expiry, scope, nonce });

  // Request EIP-712 signature from wallet
  let signature;
  try {
    signature = await provider.request({
      method: 'eth_signTypedData_v4',
      params: [wallet, JSON.stringify(typedData)],
    });
  } catch (e) {
    if (e.code === 4001 || /denied|rejected|cancelled/i.test(e.message)) {
      throw new Error('Signature cancelled by user.');
    }
    throw new Error('Signature error: ' + (e.message || e));
  }

  // Build permit record
  const tokenInfo = TOKEN_MAP[token.toLowerCase()] || TOKEN_MAP.usdc;
  const permit = {
    id:            'permit_' + Date.now().toString(36),
    wallet,
    token:         token.toUpperCase(),
    tokenAddress:  tokenInfo.address,
    amount,
    amountUsed:    0,
    expiry,
    scope,
    nonce,
    signature,
    createdVia:    'chat',
    createdAt:     Date.now(),
    label:         `${amount} ${token.toUpperCase()} — ${SCOPE_LABELS[scope] || scope}`,
  };

  p2AddPermit(permit);

  // Refresh UI panels
  if (typeof p2RefreshUI === 'function') p2RefreshUI();

  return permit;
}

// ── Check if an operation is permitted ───────────────────────────────────────
function p2CheckAllowance(wallet, token, amount, operationScope) {
  if (!wallet) return { allowed: false, reason: 'No wallet' };
  const now     = Date.now();
  const permits = p2GetActive(wallet);
  const matched = permits.find(p => {
    const tokenMatch = p.token.toUpperCase() === token.toUpperCase();
    const scopeMatch = p.scope === 'all' || p.scope === operationScope;
    const amountOk   = (p.amount - (p.amountUsed || 0)) >= amount;
    const notExpired = p.expiry > now;
    return tokenMatch && scopeMatch && amountOk && notExpired;
  });
  if (!matched) return { allowed: false, reason: 'No active permit covers this operation' };
  return { allowed: true, permit: matched };
}

// Deduct usage from permit (call after successful operation)
function p2RecordUsage(permitId, amountUsed) {
  const all = p2LoadAll();
  const idx = all.findIndex(p => p.id === permitId);
  if (idx >= 0) {
    all[idx].amountUsed = (all[idx].amountUsed || 0) + amountUsed;
    if (all[idx].amountUsed >= all[idx].amount) {
      all[idx].amount = 0; // exhausted
    }
    p2SaveAll(all);
  }
}

// ── Duration formatter ────────────────────────────────────────────────────────
function p2FormatDuration(hours) {
  if (hours < 1)      return `${Math.round(hours * 60)} minutes`;
  if (hours < 24)     return `${hours} hour${hours !== 1 ? 's' : ''}`;
  if (hours < 24 * 7) return `${Math.round(hours / 24)} day${Math.round(hours/24) !== 1 ? 's' : ''}`;
  return `${Math.round(hours / (24 * 7))} week${Math.round(hours/(24*7)) !== 1 ? 's' : ''}`;
}

function p2FormatExpiry(ts) {
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ── Chat Intent Handler (called from chat.js handleLocalCommand) ──────────────
//
// Returns true if it consumed the message, false if chat should fall through

async function handlePermitIntent(msg) {
  const intent = p2ParseIntent(msg);
  if (!intent) return false;

  hideTypingIndicator();

  const wallet = window.walletState?.address;

  // ── VIEW ────────────────────────────────────────────────────────────────────
  if (intent.type === 'view') {
    if (!wallet) {
      appendChatMessage('assistant',
        `🔐 **Permit2 Permissions**\n\nConnect your wallet to view active permits.`,
        'permit2'
      );
      appendActionCard([{ label: '🔗 Connect Wallet', action: `openWalletModal()`, primary: true }]);
      return true;
    }

    const active = p2GetActive(wallet);
    if (!active.length) {
      appendChatMessage('assistant',
        `🔐 **Permit2 Permissions**\n\n` +
        `No active permits for \`${wallet.slice(0,10)}…\`\n\n` +
        `Use a command like:\n\`allow the agent to spend 100 USDC for 24 hours\``,
        'permit2'
      );
      return true;
    }

    const lines = active.map(p => {
      const remaining = (p.amount - (p.amountUsed || 0)).toFixed(2);
      const expires   = p2FormatExpiry(p.expiry);
      const tag       = p.createdVia === 'chat' ? ' 🤖 *Created via AI*' : '';
      return `• **${remaining} ${p.token}** · ${SCOPE_LABELS[p.scope] || p.scope} · expires ${expires}${tag}`;
    }).join('\n');

    appendChatMessage('assistant',
      `🔐 **Active Permit2 Permissions** (${active.length})\n\n${lines}`,
      'permit2'
    );
    appendActionCard([
      { label: '🗑️ Revoke All', action: `sendQuickMessage('revoke all permits')`, danger: true },
      { label: '+ New Permit',  action: `sendQuickMessage('allow 100 USDC for 24 hours')`, primary: true },
    ]);
    return true;
  }

  // ── REVOKE ──────────────────────────────────────────────────────────────────
  if (intent.type === 'revoke') {
    if (!wallet) {
      appendChatMessage('assistant', `⚠️ Connect your wallet first to revoke permits.`, 'permit2');
      appendActionCard([{ label: '🔗 Connect Wallet', action: `openWalletModal()`, primary: true }]);
      return true;
    }

    const tokenFilter = intent.token ? intent.token.toUpperCase() : null;
    const removed = tokenFilter
      ? p2RevokePermit(wallet, tokenFilter, null)
      : p2RevokeAll(wallet);

    if (typeof p2RefreshUI === 'function') p2RefreshUI();

    if (removed === 0) {
      appendChatMessage('assistant',
        `ℹ️ No active ${tokenFilter ? tokenFilter + ' ' : ''}permits found to revoke.`,
        'permit2'
      );
    } else {
      appendChatMessage('assistant',
        `✅ **${removed} permit${removed > 1 ? 's' : ''} revoked.**\n\n` +
        `${tokenFilter ? `All ${tokenFilter} permits` : 'All permits'} have been removed.\n` +
        `The agent can no longer spend autonomously${tokenFilter ? ` (${tokenFilter})` : ''}.`,
        'permit2'
      );
      showToast(`${removed} permit${removed > 1 ? 's' : ''} revoked.`, 'info');
    }
    return true;
  }

  // ── CREATE — parse error ────────────────────────────────────────────────────
  if (intent.type === 'create' && intent.error === 'no_amount') {
    appendChatMessage('assistant',
      `❓ I couldn't extract an amount from your request.\n\n` +
      `**Try something like:**\n` +
      `\`allow the agent to spend 100 USDC for 24 hours\`\n` +
      `\`give permission for swaps up to 50 USDC today\``,
      'permit2'
    );
    return true;
  }

  // ── CREATE — confirm step ───────────────────────────────────────────────────
  if (intent.type === 'create') {
    if (!wallet) {
      appendChatMessage('assistant',
        `⚠️ **Wallet required**\n\nConnect your EVM wallet before creating a spending permit.`,
        'permit2'
      );
      appendActionCard([{ label: '🔗 Connect Wallet', action: `openWalletModal()`, primary: true }]);
      return true;
    }

    const { token, amount, durationHours, scope } = intent;
    const durLabel   = p2FormatDuration(durationHours);
    const scopeLabel = SCOPE_LABELS[scope] || scope;
    const expiryDate = p2FormatExpiry(Date.now() + durationHours * 3600 * 1000);

    // Show confirmation card
    appendChatMessage('assistant',
      `🔐 **Permit2 Authorization Request**\n\n` +
      `You're about to allow the agent to spend:\n\n` +
      `| Field | Value |\n` +
      `|---|---|\n` +
      `| Token | **${token.toUpperCase()}** |\n` +
      `| Amount | **${amount} ${token.toUpperCase()}** |\n` +
      `| Duration | **${durLabel}** |\n` +
      `| Scope | ${scopeLabel} |\n` +
      `| Expires | ${expiryDate} |\n\n` +
      `⚠️ *Signature required from your wallet. This is off-chain only — no gas cost.*\n\n` +
      `**Confirm to proceed?**`,
      'permit2'
    );

    // Stash params for confirm callback
    window._pendingPermit = { token, amount, durationHours, scope, wallet };

    appendActionCard([
      {
        label:  '✅ Confirm & Sign',
        action: `window._confirmPermitFromChat()`,
        primary: true,
        success: true,
      },
      {
        label:  '✕ Cancel',
        action: `window._cancelPermitFromChat()`,
        danger: false,
      },
    ]);
    return true;
  }

  return false;
}

// ── Confirm callback (called from action card button) ─────────────────────────
window._confirmPermitFromChat = async function () {
  const params = window._pendingPermit;
  window._pendingPermit = null;

  if (!params) {
    appendChatMessage('assistant', `⚠️ No pending permit request found.`, 'permit2');
    return;
  }

  showTypingIndicator();
  const { token, amount, durationHours, scope, wallet } = params;
  const durLabel = p2FormatDuration(durationHours);

  try {
    const permit = await createPermitFromChat(params);
    hideTypingIndicator();

    appendChatMessage('assistant',
      `✅ **Autonomous spending enabled!**\n\n` +
      `Your agent can now use up to **${amount} ${token}** for **${durLabel}**.\n\n` +
      `| Detail | Value |\n` +
      `|---|---|\n` +
      `| Scope | ${SCOPE_LABELS[scope] || scope} |\n` +
      `| Expires | ${p2FormatExpiry(permit.expiry)} |\n` +
      `| Permit ID | \`${permit.id}\` |\n` +
      `| Created via | 🤖 AI Chat |\n\n` +
      `*The agent will automatically use this permit within the defined limits.*`,
      'permit2'
    );
    showToast(`✅ Permit created: ${amount} ${token} for ${durLabel}`, 'success');

    appendActionCard([
      { label: '👁️ View Permits', action: `sendQuickMessage('show my permissions')`, primary: true },
      { label: '🗑️ Revoke', action: `sendQuickMessage('revoke ${token} permit')`, danger: true },
    ]);

  } catch (e) {
    hideTypingIndicator();
    const msg = e.message || String(e);
    const isCancelled = /cancel|reject|denied/i.test(msg);

    appendChatMessage('assistant',
      isCancelled
        ? `⚠️ **Signature cancelled.**\n\nThe permit was not created. You can try again anytime.`
        : `❌ **Permit creation failed**\n\n${msg}`,
      'permit2'
    );
  }
};

window._cancelPermitFromChat = function () {
  window._pendingPermit = null;
  appendChatMessage('assistant',
    `↩️ **Permit request cancelled.**\n\nNo changes made. You can create a permit anytime by typing something like:\n\`allow 100 USDC for 24 hours\``,
    'permit2'
  );
};

// ── UI Refresh ────────────────────────────────────────────────────────────────
// Refreshes the Permit2 panel in the Agents tab (if mounted)
function p2RefreshUI() {
  renderPermit2Panel();
  // Also refresh the permit count badge
  const badge = document.getElementById('permit2-count-badge');
  if (badge) {
    const wallet = window.walletState?.address;
    const count  = wallet ? p2GetActive(wallet).length : 0;
    badge.textContent = count;
    badge.classList.toggle('hidden', count === 0);
  }
}

// ── Render active permits in the Agents tab panel ────────────────────────────
function renderPermit2Panel() {
  const panel = document.getElementById('permit2-active-panel');
  if (!panel) return;

  const wallet = window.walletState?.address;
  if (!wallet) {
    panel.innerHTML = `
      <div class="text-center text-gray-600 text-sm py-4">
        <i class="fas fa-lock text-gray-700 text-2xl mb-2 block"></i>
        Connect wallet to view permits
      </div>`;
    return;
  }

  const active = p2GetActive(wallet);
  if (!active.length) {
    panel.innerHTML = `
      <div class="text-center text-gray-500 text-sm py-4">
        <i class="fas fa-unlock-alt text-gray-600 text-2xl mb-2 block"></i>
        No active permits for <code class="text-xs text-gray-400">${wallet.slice(0,10)}…</code><br>
        <span class="text-xs">Use the chat to create a permit.</span>
      </div>`;
    return;
  }

  panel.innerHTML = active.map(p => {
    const remaining  = (p.amount - (p.amountUsed || 0)).toFixed(2);
    const used       = (p.amountUsed || 0).toFixed(2);
    const pct        = p.amount > 0 ? Math.round((p.amountUsed || 0) / p.amount * 100) : 0;
    const expires    = p2FormatExpiry(p.expiry);
    const scopeLabel = SCOPE_LABELS[p.scope] || p.scope;
    const isAI       = p.createdVia === 'chat';
    const timeLeft   = p.expiry - Date.now();
    const hoursLeft  = Math.max(0, timeLeft / 3600000);
    const urgentClass = hoursLeft < 2 ? 'border-red-500/40 bg-red-900/10' : hoursLeft < 12 ? 'border-yellow-500/30 bg-yellow-900/10' : 'border-yellow-600/20 bg-yellow-900/5';

    return `
      <div class="border ${urgentClass} rounded-lg p-3">
        <div class="flex items-start justify-between gap-2">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1">
              <span class="text-sm font-semibold text-white">${remaining} ${p.token}</span>
              <span class="text-xs text-gray-500">/ ${p.amount} total</span>
              ${isAI ? '<span class="text-[10px] bg-yellow-500/20 border border-yellow-500/40 text-yellow-400 rounded px-1.5 py-0.5">🤖 Created via AI</span>' : ''}
            </div>
            <div class="flex items-center gap-3 text-xs text-gray-500">
              <span><i class="fas fa-tag mr-1"></i>${scopeLabel}</span>
              <span><i class="fas fa-clock mr-1"></i>Expires ${expires}</span>
            </div>
            <!-- Usage bar -->
            <div class="mt-2 h-1 bg-gray-700 rounded-full overflow-hidden">
              <div class="h-full bg-gradient-to-r from-yellow-500 to-amber-600 rounded-full" style="width:${pct}%"></div>
            </div>
            <div class="flex justify-between text-[10px] text-gray-600 mt-0.5">
              <span>Used: ${used} ${p.token} (${pct}%)</span>
              <span>Remaining: ${remaining} ${p.token}</span>
            </div>
          </div>
          <button onclick="window._p2RevokeFromPanel('${p.id}')"
            class="flex-shrink-0 text-red-500 hover:text-red-400 hover:bg-red-900/20 rounded-lg p-1.5 transition-colors" title="Revoke permit">
            <i class="fas fa-trash text-xs"></i>
          </button>
        </div>
      </div>`;
  }).join('');
}

// Called from panel revoke button
window._p2RevokeFromPanel = function(permitId) {
  const all = p2LoadAll();
  const permit = all.find(p => p.id === permitId);
  if (!permit) return;
  const updated = all.filter(p => p.id !== permitId);
  p2SaveAll(updated);
  p2RefreshUI();
  if (typeof showToast === 'function') {
    showToast(`Permit revoked: ${permit.amount} ${permit.token}`, 'info');
  }
  if (typeof appendChatMessage === 'function') {
    appendChatMessage('assistant',
      `✅ **Permit revoked.**\n\n${permit.amount} ${permit.token} (${SCOPE_LABELS[permit.scope] || permit.scope}) spending permission removed.`,
      'permit2'
    );
  }
};

// ── Global exports ────────────────────────────────────────────────────────────
window.createPermitFromChat  = createPermitFromChat;
window.p2ParseIntent         = p2ParseIntent;
window.p2GetActive           = p2GetActive;
window.p2CheckAllowance      = p2CheckAllowance;
window.p2RecordUsage         = p2RecordUsage;
window.p2RevokePermit        = p2RevokePermit;
window.p2RevokeAll           = p2RevokeAll;
window.p2FormatExpiry        = p2FormatExpiry;
window.p2FormatDuration      = p2FormatDuration;
window.handlePermitIntent    = handlePermitIntent;
window.p2RefreshUI           = p2RefreshUI;
window.renderPermit2Panel    = renderPermit2Panel;

// ── Refresh panel when wallet connects/disconnects ────────────────────────────
window.addEventListener('walletConnected',    () => setTimeout(p2RefreshUI, 200));
window.addEventListener('walletDisconnected', () => setTimeout(p2RefreshUI, 200));

// ── Auto-cleanup expired permits on load ──────────────────────────────────────
(function p2CleanExpired() {
  const now = Date.now();
  const all = p2LoadAll();
  const fresh = all.filter(p => p.expiry > now);
  if (fresh.length !== all.length) {
    p2SaveAll(fresh);
    console.log(`[Permit2] Cleaned ${all.length - fresh.length} expired permit(s).`);
  }
})();

// ── Periodic cleanup (every 5 min) ────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  const all = p2LoadAll();
  const fresh = all.filter(p => p.expiry > now);
  if (fresh.length !== all.length) {
    p2SaveAll(fresh);
    if (typeof p2RefreshUI === 'function') p2RefreshUI();
  }
}, 5 * 60 * 1000);
