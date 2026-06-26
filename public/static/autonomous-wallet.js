// ============================================================
// ARC Autonomous Wallet — Frontend Module v1.0
// Arc Testnet · ChainId 5042002 · Real On-Chain Only
//
// Responsibilities:
//  • Manage internal wallet session (generate / load / display)
//  • Show real balances via /api/wallet/balances/:address
//  • Show real tx history via /api/wallet/history/both/:address
//  • AI agent chat → /api/wallet/agent/execute → sign → /api/wallet/agent/confirm
//  • Pay Agent direct form → simulate → sign → log
//  • Swap Agent form → quote → approve → sign
//  • Guardian Agent result display
//  • Live network status via /api/wallet/gas
//  • Agent logs via /api/wallet/logs
// ============================================================

(function () {
  'use strict';

  // ── Constants ──────────────────────────────────────────────
  const AW_SESSION_KEY  = 'aw_session_id';
  const AW_ADDRESS_KEY  = 'aw_address';
  const AW_LABEL_KEY    = 'aw_label';
  const EXPLORER        = 'https://testnet.arcscan.app';
  const CHAIN_ID        = 5042002;
  const CHAIN_HEX       = '0x4cef52';
  const AMM_ADDRESS     = '0x3148E2807F172D1cC354F35fB4fC4104e8b6b561';
  const USDC_ADDRESS    = '0x3600000000000000000000000000000000000000';
  const EURC_ADDRESS    = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';

  // ── State ─────────────────────────────────────────────────
  const awState = {
    sessionId:       null,
    internalAddress: null,
    internalLabel:   null,
    activeAddress:   null,   // external (MetaMask) or internal
    walletSource:    null,   // 'external' | 'internal'
    balances:        {},
    pendingTx:       null,   // unsigned tx waiting for sign
    pendingLogId:    null,
    initialized:     false,
    networkRefreshTimer: null,
  };

  // ── DOM helpers ───────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  function setText(id, val) { const el = $(id); if (el) el.textContent = val; }
  function show(id) { const el = $(id); if (el) el.classList.remove('hidden'); }
  function hide(id) { const el = $(id); if (el) el.classList.add('hidden'); }
  function html(id, val) { const el = $(id); if (el) el.innerHTML = val; }

  // ── Toast ─────────────────────────────────────────────────
  function awToast(msg, type = 'info') {
    const colors = {
      success: 'background:rgba(6,78,59,0.97);border:1px solid rgba(16,185,129,0.5);color:#a7f3d0;',
      error:   'background:rgba(69,10,10,0.97);border:1px solid rgba(239,68,68,0.5);color:#fca5a5;',
      warning: 'background:rgba(78,53,0,0.97);border:1px solid rgba(251,191,36,0.5);color:#fde68a;',
      info:    'background:rgba(7,24,50,0.97);border:1px solid rgba(74,222,128,0.4);color:#d1fae5;',
    };
    const t = document.createElement('div');
    t.style.cssText = `position:fixed;bottom:80px;left:50%;transform:translateX(-50%);z-index:99999;
      padding:10px 18px;border-radius:12px;font-size:12px;font-weight:600;
      max-width:90vw;text-align:center;animation:fadeInUp 0.3s ease;
      ${colors[type] || colors.info}`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }

  // ── Short address ─────────────────────────────────────────
  function shortAddr(addr) {
    if (!addr) return '';
    return addr.slice(0, 6) + '…' + addr.slice(-4);
  }

  // ── Determine active address ───────────────────────────────
  function getActiveAddress() {
    const ext = window.walletState?.address;
    if (ext) return ext;
    return awState.internalAddress;
  }

  function getActiveSource() {
    if (window.walletState?.address) return 'external';
    if (awState.internalAddress) return 'internal';
    return null;
  }

  // ── Ensure Arc Testnet ─────────────────────────────────────
  async function ensureArcNetwork() {
    const provider = window.walletState?.provider;
    if (!provider) return false;
    try {
      const chainHex = await provider.request({ method: 'eth_chainId' });
      if (parseInt(chainHex, 16) === CHAIN_ID) return true;
      // Try switching
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_HEX }] }).catch(async (e) => {
        if (e.code === 4902 || e.code === -32603) {
          await provider.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: CHAIN_HEX,
              chainName: 'Arc Testnet',
              nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
              rpcUrls: ['https://rpc.testnet.arc.network'],
              blockExplorerUrls: [EXPLORER],
            }],
          });
        }
      });
      return true;
    } catch { return false; }
  }

  // ═══════════════════════════════════════════════════════════
  //  WALLET CREATION / LOADING
  // ═══════════════════════════════════════════════════════════

  async function awCreateInternalWallet() {
    try {
      const btn = $('aw-no-wallet-prompt');
      if (btn) btn.style.opacity = '0.5';

      awToast('Generating encrypted wallet…', 'info');
      const res  = await fetch('/api/wallet/create', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ label: 'Autonomous Wallet', sessionId: crypto.randomUUID() }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Creation failed');

      // Store session locally
      localStorage.setItem(AW_SESSION_KEY, data.sessionId);
      localStorage.setItem(AW_ADDRESS_KEY, data.address);
      localStorage.setItem(AW_LABEL_KEY,   data.label);

      awState.sessionId       = data.sessionId;
      awState.internalAddress = data.address;
      awState.internalLabel   = data.label;

      console.log('[AW] Wallet created:', data.address, 'session:', data.sessionId);
      awToast('✅ Wallet gerada! Endereço: ' + shortAddr(data.address), 'success');

      awRenderIdentity();
      awRefreshBalances();
      awLoadNetworkStatus();
      awStartNetworkPoller();

      // Show faucet hint
      awAddChatMessage('system', `Internal wallet created: ${data.address}`);
      awAddChatMessage('agent', `✅ Wallet gerada com sucesso!\n\nEndereço: ${data.address}\n\nPrecisa de testnet USDC/EURC? Visite o faucet: https://faucet.circle.com\n\nEsta wallet usa AES-GCM encryption e opera exclusivamente na Arc Testnet.`);
    } catch (err) {
      awToast('❌ ' + err.message, 'error');
      const btn = $('aw-no-wallet-prompt');
      if (btn) btn.style.opacity = '1';
    }
  }

  function awLoadInternalWallet() {
    const sid  = localStorage.getItem(AW_SESSION_KEY);
    const addr = localStorage.getItem(AW_ADDRESS_KEY);
    const lbl  = localStorage.getItem(AW_LABEL_KEY);

    if (!sid || !addr) {
      awToast('Nenhuma sessão salva encontrada', 'warning');
      return;
    }
    awState.sessionId       = sid;
    awState.internalAddress = addr;
    awState.internalLabel   = lbl || 'Autonomous Wallet';

    awRenderIdentity();
    awRefreshBalances();
    awLoadHistory();
    awLoadNetworkStatus();
    awStartNetworkPoller();
    awToast('✅ Sessão carregada: ' + shortAddr(addr), 'success');
  }

  // ─── Render identity section ────────────────────────────────
  function awRenderIdentity() {
    const extAddr = window.walletState?.address;
    const intAddr = awState.internalAddress;

    if (extAddr) {
      // External wallet connected via MetaMask
      hide('aw-internal-wallet');
      show('aw-external-wallet');
      const el = $('aw-ext-address');
      if (el) el.textContent = extAddr;
      awState.activeAddress  = extAddr;
      awState.walletSource   = 'external';

      // Show external in internal slot too for info
      const displayDiv = $('aw-wallet-display');
      const promptDiv  = $('aw-no-wallet-prompt');
      if (displayDiv && promptDiv) {
        show('aw-wallet-display');
        hide('aw-no-wallet-prompt');
        setText('aw-int-address', extAddr);
        setText('aw-int-label',   'Connected via MetaMask/EIP-1193');
        const av = $('aw-avatar');
        if (av) av.textContent = extAddr.slice(2, 4).toUpperCase();
        const expLink = $('aw-explorer-link');
        if (expLink) expLink.href = `${EXPLORER}/address/${extAddr}`;
      }
    } else if (intAddr) {
      // Internal generated wallet
      show('aw-internal-wallet');
      hide('aw-external-wallet');

      const displayDiv = $('aw-wallet-display');
      const promptDiv  = $('aw-no-wallet-prompt');
      if (displayDiv && promptDiv) {
        show('aw-wallet-display');
        hide('aw-no-wallet-prompt');
      }

      setText('aw-int-address', intAddr);
      setText('aw-int-label',   awState.internalLabel || 'Internal Wallet');

      const av = $('aw-avatar');
      if (av) av.textContent = intAddr.slice(2, 4).toUpperCase();

      const badge = $('aw-session-badge');
      if (badge && awState.sessionId) {
        badge.textContent = 'Session: ' + awState.sessionId.slice(0, 8) + '…';
      }

      const expLink = $('aw-explorer-link');
      if (expLink) expLink.href = `${EXPLORER}/address/${intAddr}`;

      awState.activeAddress = intAddr;
      awState.walletSource  = 'internal';
    } else {
      // No wallet at all
      show('aw-internal-wallet');
      hide('aw-external-wallet');
      show('aw-no-wallet-prompt');
      hide('aw-wallet-display');
      awState.activeAddress = null;
      awState.walletSource  = null;
    }
  }

  // ── Copy address ───────────────────────────────────────────
  window.awCopyAddress = function (source) {
    const addr = source === 'internal' ? awState.internalAddress
                                       : (window.walletState?.address || awState.internalAddress);
    if (!addr) return;
    navigator.clipboard.writeText(addr).then(() => awToast('Endereço copiado!', 'success'))
      .catch(() => awToast(addr, 'info'));
  };

  // ═══════════════════════════════════════════════════════════
  //  REAL-TIME BALANCES
  // ═══════════════════════════════════════════════════════════

  window.awRefreshBalances = async function () {
    const addr = getActiveAddress();
    if (!addr) {
      html('aw-balance-error', '');
      hide('aw-balance-error');
      return;
    }

    const icon = $('aw-refresh-icon');
    if (icon) icon.classList.add('fa-spin');

    try {
      const res  = await fetch(`/api/wallet/balances/${addr}`);
      const data = await res.json();

      if (!data.success) throw new Error(data.error || 'Balance fetch failed');

      awState.balances = data.balances;

      setText('aw-bal-usdc',  parseFloat(data.balances.USDC?.human || '0').toFixed(4));
      setText('aw-bal-eurc',  parseFloat(data.balances.EURC?.human || '0').toFixed(4));
      setText('aw-bal-lp',    parseFloat(data.balances.LP?.human   || '0').toFixed(4));
      setText('aw-bal-total', '$' + (parseFloat(data.portfolio?.totalUSD || '0')).toFixed(2));

      // Update pool display
      if (data.ammPool) {
        setText('aw-pool-ra', parseFloat(data.ammPool.reserveA).toFixed(2));
        setText('aw-pool-rb', parseFloat(data.ammPool.reserveB).toFixed(2));
      }

      hide('aw-balance-error');
      console.log('[AW:balances] OK', addr, data.balances);
    } catch (err) {
      console.error('[AW:balances]', err);
      html('aw-balance-error', '<i class="fas fa-exclamation-triangle mr-1"></i>' + err.message);
      show('aw-balance-error');
    } finally {
      if (icon) {
        setTimeout(() => icon.classList.remove('fa-spin'), 600);
      }
    }
  };

  // ═══════════════════════════════════════════════════════════
  //  TRANSACTION HISTORY (real from eth_getLogs)
  // ═══════════════════════════════════════════════════════════

  window.awLoadHistory = async function () {
    const addr  = getActiveAddress();
    const token = $('aw-hist-token')?.value || 'USDC';
    const container = $('aw-history-list');

    if (!addr) {
      if (container) container.innerHTML = `
        <div style="text-align:center;color:#4b5563;padding:28px 0;font-size:12px;">
          <i class="fas fa-chain" style="font-size:22px;display:block;margin-bottom:8px;color:#374151;"></i>
          Conecte ou gere uma wallet para ver o histórico on-chain
        </div>`;
      return;
    }

    if (container) container.innerHTML = `
      <div style="text-align:center;color:#4ade80;padding:20px 0;font-size:11px;">
        <i class="fas fa-spinner fa-spin" style="margin-right:6px;"></i>Buscando transações on-chain…
      </div>`;

    try {
      // Use /both for all tokens, or specific for filter
      const url = token === 'ALL'
        ? `/api/wallet/history/both/${addr}`
        : `/api/wallet/history/${addr}?token=${token}`;

      const res  = await fetch(url);
      const data = await res.json();

      if (!data.success) throw new Error(data.error || 'History fetch failed');

      const txs = data.transactions || [];
      console.log(`[AW:history] ${txs.length} txs for ${addr}`);

      if (!txs.length) {
        if (container) container.innerHTML = `
          <div style="text-align:center;color:#4b5563;padding:24px 0;font-size:12px;">
            <i class="fas fa-inbox" style="font-size:22px;display:block;margin-bottom:8px;color:#374151;"></i>
            Nenhuma transação ${token} encontrada para este endereço
          </div>`;
        return;
      }

      const rows = txs.map(tx => {
        const dirIcon  = tx.direction === 'out'
          ? `<i class="fas fa-arrow-up" style="color:#f87171;font-size:10px;"></i>`
          : `<i class="fas fa-arrow-down" style="color:#34d399;font-size:10px;"></i>`;
        const sign     = tx.direction === 'out' ? '-' : '+';
        const signClr  = tx.direction === 'out' ? '#f87171' : '#34d399';
        const peer     = tx.direction === 'out' ? tx.to : tx.from;
        return `
          <div class="aw-tx-card" style="display:flex;align-items:center;gap:10px;">
            <div style="width:28px;height:28px;border-radius:50%;background:rgba(74,222,128,0.08);border:1px solid rgba(74,222,128,0.18);
              display:flex;align-items:center;justify-content:center;flex-shrink:0;">${dirIcon}</div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:11px;color:#d1fae5;font-weight:600;">${sign} ${parseFloat(tx.amount).toFixed(4)} ${tx.token}</div>
              <div style="font-size:9px;color:#6b9e80;font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                ${tx.direction === 'out' ? 'To' : 'From'}: ${shortAddr(peer)}
              </div>
            </div>
            <div style="text-align:right;flex-shrink:0;">
              <div style="font-size:9px;color:#4b5563;">Bloco ${tx.block || '—'}</div>
              <a href="${tx.explorerUrl}" target="_blank" style="font-size:9px;color:#4ade80;text-decoration:none;">
                <i class="fas fa-external-link-alt"></i> ${shortAddr(tx.txHash)}
              </a>
            </div>
          </div>`;
      }).join('');

      if (container) container.innerHTML = rows;
    } catch (err) {
      console.error('[AW:history]', err);
      if (container) container.innerHTML = `
        <div style="text-align:center;color:#f87171;padding:20px 0;font-size:11px;">
          <i class="fas fa-exclamation-triangle"></i> ${err.message}
        </div>`;
    }
  };

  // ═══════════════════════════════════════════════════════════
  //  NETWORK STATUS
  // ═══════════════════════════════════════════════════════════

  async function awLoadNetworkStatus() {
    try {
      const res  = await fetch('/api/wallet/gas');
      const data = await res.json();
      if (!data.success) return;

      setText('aw-block-num', data.blockNumber ? data.blockNumber.toLocaleString() : '—');
      setText('aw-gas-price', data.gasPriceGwei + ' gwei');
      setText('aw-tx-cost',   data.estimatedTxCost?.transfer || '—');
    } catch (err) {
      console.warn('[AW:network]', err.message);
    }
  }

  function awStartNetworkPoller() {
    if (awState.networkRefreshTimer) return; // already running
    awLoadNetworkStatus();
    awState.networkRefreshTimer = setInterval(awLoadNetworkStatus, 15000);
  }

  // ═══════════════════════════════════════════════════════════
  //  AGENT LOGS
  // ═══════════════════════════════════════════════════════════

  window.awLoadAgentLogs = async function () {
    const container = $('aw-agent-logs');
    if (!container) return;

    try {
      const sid = awState.sessionId;
      const url = sid ? `/api/wallet/logs/${sid}` : '/api/wallet/logs?limit=30';
      const res  = await fetch(url);
      const data = await res.json();

      if (!data.success || !data.logs?.length) {
        container.innerHTML = `<div style="text-align:center;color:#4b5563;padding:20px 0;font-size:11px;">Nenhuma ação de agente ainda</div>`;
        return;
      }

      const badges = {
        confirmed: 'aw-badge-confirmed', pending: 'aw-badge-pending',
        failed: 'aw-badge-failed', blocked: 'aw-badge-blocked',
        simulated: 'aw-badge-simulated',
      };
      const rows = data.logs.map(log => {
        const badge = badges[log.status] || 'aw-badge-simulated';
        const ts    = new Date(log.timestamp).toLocaleTimeString();
        const txLink = log.txHash
          ? `<a href="${EXPLORER}/tx/${log.txHash}" target="_blank" style="font-size:9px;color:#4ade80;">${shortAddr(log.txHash)}</a>`
          : '<span style="font-size:9px;color:#4b5563;">—</span>';
        return `
          <div style="border-bottom:1px solid rgba(74,222,128,0.07);padding:8px 0;display:flex;align-items:flex-start;gap:8px;">
            <div style="flex:1;min-width:0;">
              <div style="font-size:10px;color:#d1fae5;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${log.action}</div>
              <div style="font-size:9px;color:#6b9e80;margin-top:1px;">${log.agentType} · ${ts} · ${txLink}</div>
            </div>
            <span class="${badge}" style="flex-shrink:0;">${log.status}</span>
          </div>`;
      }).join('');

      container.innerHTML = rows;
    } catch (err) {
      container.innerHTML = `<div style="color:#f87171;font-size:10px;padding:8px;">${err.message}</div>`;
    }
  };

  // ═══════════════════════════════════════════════════════════
  //  AI AGENT CHAT
  // ═══════════════════════════════════════════════════════════

  function awAddChatMessage(role, text) {
    const container = $('aw-chat-messages');
    if (!container) return;
    const cls = role === 'user'   ? 'aw-msg-user'
              : role === 'agent'  ? 'aw-msg-agent'
              : 'aw-msg-system';
    const div = document.createElement('div');
    div.className = cls;
    // Handle newlines and code
    div.innerHTML = text.replace(/\n/g, '<br>').replace(/`([^`]+)`/g, '<code style="color:#4ade80;font-family:monospace;">$1</code>');
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  window.awQuickCmd = function (cmd) {
    const inp = $('aw-chat-input');
    if (inp) inp.value = cmd;
    awAgentSend();
  };

  window.awAgentSend = async function () {
    const inp    = $('aw-chat-input');
    const prompt = inp?.value?.trim();
    if (!prompt) return;
    inp.value = '';

    const addr = getActiveAddress();
    if (!addr) {
      awAddChatMessage('system', '⚠️ Nenhuma wallet conectada. Conecte sua wallet ou gere uma interna primeiro.');
      return;
    }

    awAddChatMessage('user', prompt);

    const btn = $('aw-chat-send-btn');
    if (btn) btn.disabled = true;

    try {
      awAddChatMessage('system', '⌛ Analisando intent…');

      const res  = await fetch('/api/wallet/agent/execute', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ prompt, walletAddress: addr, sessionId: awState.sessionId || 'ext' }),
      });
      const data = await res.json();

      // Remove the loading indicator
      const msgs = $('aw-chat-messages');
      if (msgs) {
        const sys = msgs.querySelectorAll('.aw-msg-system');
        sys.forEach(s => { if (s.textContent.includes('⌛')) s.remove(); });
      }

      if (!data.success) {
        awAddChatMessage('agent', `❌ ${data.error || 'Falha no agente'}\n${data.hint || ''}`);
        return;
      }

      // ── Balance result ─────────────────────────────────────
      if (data.intent === 'balance') {
        awAddChatMessage('agent', `💰 **Saldo atual:**\n• USDC: ${parseFloat(data.result.USDC).toFixed(4)}\n• EURC: ${parseFloat(data.result.EURC).toFixed(4)}\n\nEndereço: ${shortAddr(data.result.address)}`);
        awRefreshBalances();
        return;
      }

      // ── History result ─────────────────────────────────────
      if (data.intent === 'history') {
        const txs = data.result || [];
        if (!txs.length) {
          awAddChatMessage('agent', '📋 Nenhuma transação encontrada para este endereço.');
          return;
        }
        const lines = txs.slice(0, 5).map(tx =>
          `${tx.direction === 'out' ? '↑' : '↓'} ${parseFloat(tx.amount).toFixed(4)} ${tx.token} · Bloco ${tx.block}`
        ).join('\n');
        awAddChatMessage('agent', `📋 Últimas transações (${txs.length} total):\n${lines}`);
        awLoadHistory();
        return;
      }

      // ── Blocked by Guardian ────────────────────────────────
      if (data.blocked) {
        awAddChatMessage('agent', `🛡️ **Guardian bloqueou a transação!**\nMotivo: ${data.reason}\n\nA transação não é segura para executar.`);
        awUpdateGuardian(false, data.reason);
        return;
      }

      // ── Permit2 allowance check (advisory) ────────────────
      if (data.unsignedTx && (data.intent === 'send' || data.intent === 'swap')) {
        const p2 = window.p2CheckAllowance;
        if (typeof p2 === 'function' && data.humanParams) {
          const { token, amount, to } = data.humanParams;
          const opScope  = data.intent === 'swap' ? 'swap' : 'payments';
          const p2result = p2(addr, token || 'USDC', parseFloat(amount) || 0, opScope);
          if (p2result.allowed) {
            awAddChatMessage('system',
              `🔐 Permit2 ✅ — Active spending permit covers this operation (${p2result.permit.amount} ${token}, scope: ${opScope}).`
            );
          }
        }
      }

      // ── Send / Swap — needs signing ────────────────────────
      if (data.unsignedTx && (data.intent === 'send' || data.intent === 'swap')) {
        const sim = data.simulation || data.quote;
        let preview = '';

        if (data.intent === 'send') {
          const p = data.humanParams;
          preview = `Tipo: Transferência ${p?.token || 'USDC'}\nPara: ${shortAddr(p?.to || '')}\nValor: ${p?.amount} ${p?.token}\nGas est.: ${p?.gasEstimate || '65000'} unidades\n\nSimulação: ✅ ${sim?.reason || 'Safe'}`;
          awUpdateGuardian(true, sim?.reason || 'Transaction safe');
        } else if (data.intent === 'swap') {
          const q = data.quote;
          preview = `Tipo: Swap ${q?.fromToken} → ${q?.toToken}\nEntrada: ${q?.amountIn} ${q?.fromToken}\nSaída min.: ${q?.minOut} ${q?.toToken}\nPreço impacto: ${q?.priceImpact}\nAMM: ${shortAddr(q?.ammAddress)}`;
          awUpdateGuardian(true, 'Swap via SimpleAMM — safe');
        }

        awAddChatMessage('agent', `🔍 **Transação pronta para assinar!**\n\n${preview}\n\n${data.message || ''}`);

        // Show sign panel
        awState.pendingTx    = data;
        awState.pendingLogId = data.logId;
        showSignPanel(preview, data.intent);
        return;
      }

      // ── Generic success ────────────────────────────────────
      awAddChatMessage('agent', data.message || JSON.stringify(data.result || data));
    } catch (err) {
      awAddChatMessage('agent', `❌ Erro: ${err.message}`);
    } finally {
      const btn2 = $('aw-chat-send-btn');
      if (btn2) btn2.disabled = false;
    }
  };

  // ── Sign panel management ──────────────────────────────────
  function showSignPanel(preview, intent) {
    const panel = $('aw-sign-panel');
    const det   = $('aw-sign-details');
    if (det) det.innerHTML = preview.replace(/\n/g, '<br>');
    if (panel) panel.classList.remove('hidden');
  }

  window.awCancelSign = function () {
    awState.pendingTx    = null;
    awState.pendingLogId = null;
    hide('aw-sign-panel');
    awAddChatMessage('system', '✋ Transação cancelada pelo usuário.');
  };

  window.awSignAndSend = async function () {
    const pending = awState.pendingTx;
    if (!pending) { awToast('Nenhuma transação pendente', 'warning'); return; }

    const provider = window.walletState?.provider;
    if (!provider) {
      awToast('Conecte sua wallet MetaMask para assinar', 'error');
      awAddChatMessage('system', '⚠️ MetaMask necessário para assinar esta transação.');
      return;
    }

    const addr = window.walletState.address;
    if (!addr) { awToast('Endereço não disponível', 'error'); return; }

    const btn = $('aw-sign-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Assinando…'; }

    try {
      // Ensure correct network
      const onArc = await ensureArcNetwork();
      if (!onArc) throw new Error('Por favor, troque para Arc Testnet no MetaMask');

      let txHash = null;

      // ── SWAP: need approval first ──────────────────────────
      if (pending.intent === 'swap' && pending.approveFirst) {
        awAddChatMessage('system', '⌛ Aprovando token para AMM…');
        awToast('Aguardando aprovação…', 'info');

        const approveTx = {
          from: addr,
          to:   pending.approveFirst.to,
          data: pending.approveFirst.data,
        };
        const approveHash = await provider.request({ method: 'eth_sendTransaction', params: [approveTx] });
        awAddChatMessage('system', `✅ Aprovação enviada: ${shortAddr(approveHash)}`);
        awToast('Aguardando confirmação da aprovação…', 'info');

        // Poll for approve receipt (up to 60s)
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 3000));
          const rcp = await fetch('/api/wallet/gas').then(r => r.json()).catch(() => null);
          // Simple delay — proceed after 3 polls
          if (i >= 2) break;
        }
      }

      // ── Build and send main tx ─────────────────────────────
      const unsignedTx = pending.unsignedTx;
      const txParams = {
        from: addr,
        to:   unsignedTx.to,
        data: unsignedTx.data,
        value: unsignedTx.value || '0x0',
      };
      if (unsignedTx.gas)      txParams.gas      = unsignedTx.gas;
      if (unsignedTx.gasPrice) txParams.gasPrice  = unsignedTx.gasPrice;

      awToast('Aguardando assinatura no MetaMask…', 'info');
      txHash = await provider.request({ method: 'eth_sendTransaction', params: [txParams] });

      awAddChatMessage('agent', `🚀 **Transação enviada!**\nHash: ${txHash}\n\n<a href="${EXPLORER}/tx/${txHash}" target="_blank" style="color:#4ade80;">Ver no ArcScan ↗</a>`);
      awToast('✅ Transação enviada! Aguardando confirmação…', 'success');
      hide('aw-sign-panel');

      // ── Log to backend ─────────────────────────────────────
      await fetch('/api/wallet/agent/confirm', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ logId: awState.pendingLogId, txHash, sessionId: awState.sessionId || 'ext' }),
      }).catch(() => {});

      awState.pendingTx    = null;
      awState.pendingLogId = null;

      // Refresh after a short delay
      setTimeout(() => {
        awRefreshBalances();
        awLoadHistory();
        awLoadAgentLogs();
      }, 5000);
    } catch (err) {
      const msg = err.message || String(err);
      awAddChatMessage('agent', `❌ Erro ao assinar: ${msg.includes('rejected') || msg.includes('denied') ? 'Transação rejeitada pelo usuário.' : msg}`);
      awToast('❌ ' + (msg.includes('rejected') ? 'Rejeitado pelo usuário' : msg.slice(0, 60)), 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-signature mr-1"></i>Sign & Send'; }
    }
  };

  // ── Guardian display ───────────────────────────────────────
  function awUpdateGuardian(safe, reason) {
    const el = $('aw-guardian-result');
    if (!el) return;
    if (safe) {
      el.innerHTML = `<i class="fas fa-shield-alt" style="color:#34d399;margin-right:4px;"></i>
        <span style="color:#34d399;font-weight:600;">Transação SEGURA</span>
        <div style="color:#6b9e80;margin-top:2px;">${reason}</div>`;
    } else {
      el.innerHTML = `<i class="fas fa-ban" style="color:#f87171;margin-right:4px;"></i>
        <span style="color:#f87171;font-weight:600;">Transação BLOQUEADA</span>
        <div style="color:#f87171;margin-top:2px;">${reason}</div>`;
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  PAY AGENT (direct form)
  // ═══════════════════════════════════════════════════════════

  window.awPayAgent = async function () {
    const to     = $('aw-pay-to')?.value?.trim();
    const amount = parseFloat($('aw-pay-amount')?.value || '0');
    const token  = $('aw-pay-token')?.value || 'USDC';
    const addr   = getActiveAddress();

    if (!addr) { awToast('Conecte ou gere uma wallet primeiro', 'warning'); return; }
    if (!to || !/^0x[0-9a-fA-F]{40}$/.test(to)) { awToast('Endereço inválido', 'error'); return; }
    if (!amount || amount <= 0) { awToast('Valor inválido', 'error'); return; }

    const btn = $('aw-pay-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Simulando…'; }

    try {
      // Simulate first
      const simRes  = await fetch('/api/wallet/simulate', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ from: addr, to, amount, token }),
      });
      const simData = await simRes.json();

      if (!simData.success) throw new Error(simData.error || 'Simulation failed');

      const sim = simData.simulation;
      if (!sim.safe) {
        awUpdateGuardian(false, sim.reason);
        awToast('🛡️ Guardian bloqueou: ' + sim.reason, 'error');
        return;
      }

      awUpdateGuardian(true, sim.reason);

      // Check MetaMask available
      if (!window.walletState?.provider) {
        awToast('Conecte o MetaMask para assinar', 'error');
        return;
      }

      const onArc = await ensureArcNetwork();
      if (!onArc) throw new Error('Troque para Arc Testnet');

      const unsig = sim.unsignedTx;
      if (!unsig) throw new Error('No unsigned tx returned');

      awToast(`Simulação OK · Gas: ${sim.gasEstimate} · Aguardando assinatura…`, 'info');

      const txParams = {
        from:     addr,
        to:       unsig.to,
        data:     unsig.data,
        value:    '0x0',
        gas:      unsig.gas,
        gasPrice: unsig.gasPrice,
      };

      const txHash = await window.walletState.provider.request({ method: 'eth_sendTransaction', params: [txParams] });
      awToast(`✅ Enviado! Hash: ${shortAddr(txHash)}`, 'success');

      // Log
      await fetch('/api/wallet/send', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ from: addr, to, amount, token, txHash, sessionId: awState.sessionId || 'ext' }),
      }).catch(() => {});

      // Add to chat
      awAddChatMessage('agent', `✅ Pay Agent executou:\n${amount} ${token} → ${shortAddr(to)}\nHash: <a href="${EXPLORER}/tx/${txHash}" target="_blank" style="color:#4ade80;">${shortAddr(txHash)}</a>`);

      // Reset form
      if ($('aw-pay-to'))     $('aw-pay-to').value = '';
      if ($('aw-pay-amount')) $('aw-pay-amount').value = '';

      // Refresh after confirm
      setTimeout(() => { awRefreshBalances(); awLoadHistory(); awLoadAgentLogs(); }, 5000);
    } catch (err) {
      const msg = err.message || '';
      awToast('❌ ' + (msg.includes('rejected') ? 'Rejeitado pelo usuário' : msg.slice(0, 80)), 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane mr-1"></i>Simulate & Send'; }
    }
  };

  // ═══════════════════════════════════════════════════════════
  //  SWAP AGENT (direct form)
  // ═══════════════════════════════════════════════════════════

  // Update swap-to label when from changes
  function awUpdateSwapToLabel() {
    const from = $('aw-swap-from')?.value || 'EURC';
    setText('aw-swap-to-label', from === 'EURC' ? 'USDC' : 'EURC');
  }

  window.awSwapAgent = async function () {
    const amount   = parseFloat($('aw-swap-amt')?.value || '0');
    const fromTok  = $('aw-swap-from')?.value || 'EURC';
    const addr     = getActiveAddress();

    if (!addr)  { awToast('Conecte ou gere uma wallet primeiro', 'warning'); return; }
    if (!amount || amount <= 0) { awToast('Valor inválido', 'error'); return; }

    const btn = $('aw-swap-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Buscando cotação…'; }

    try {
      // Get quote
      const res  = await fetch(`/api/dex/amm/quote?fromToken=${fromTok}&toToken=${fromTok==='EURC'?'USDC':'EURC'}&amountIn=${amount}`);
      const data = await res.json();

      if (!data.success) throw new Error(data.error || 'Quote failed');

      const quote = data.quote || data;
      const preview = $('aw-swap-quote-preview');
      if (preview) {
        preview.innerHTML = `Cotação: ${parseFloat(data.amountOutHuman || '0').toFixed(4)} ${fromTok==='EURC'?'USDC':'EURC'} · Impacto: ${data.priceImpact || '—'}`;
      }

      // Route to agent execute for full simulation + signing
      const agentRes  = await fetch('/api/wallet/agent/execute', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ prompt: `swap ${amount} ${fromTok} to ${fromTok==='EURC'?'USDC':'EURC'}`, walletAddress: addr, sessionId: awState.sessionId || 'ext' }),
      });
      const agentData = await agentRes.json();

      if (!agentData.success) throw new Error(agentData.error || 'Agent exec failed');

      // Show in chat
      const q = agentData.quote;
      awAddChatMessage('agent', `🔄 **Swap pronto!**\n${q?.amountIn} ${q?.fromToken} → ${q?.minOut} ${q?.toToken} (min.)\nImpacto: ${q?.priceImpact}\n\nPrecisa assinar. Use o chat ou o botão Sign & Send.`);

      awState.pendingTx    = agentData;
      awState.pendingLogId = agentData.logId;

      const details = `Swap ${q?.amountIn} ${q?.fromToken} → ${q?.minOut} ${q?.toToken}\nImpacto: ${q?.priceImpact}`;
      showSignPanel(details, 'swap');
      awToast('Cotação obtida — assine para executar', 'info');
    } catch (err) {
      awToast('❌ ' + err.message.slice(0, 80), 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-exchange-alt mr-1"></i>Get Quote & Swap'; }
    }
  };

  // ═══════════════════════════════════════════════════════════
  //  INTEGRATION: sync with external wallet changes
  // ═══════════════════════════════════════════════════════════

  function awSyncExternalWallet() {
    const ext = window.walletState?.address;
    if (ext !== awState._lastExtAddr) {
      awState._lastExtAddr = ext;
      awRenderIdentity();
      if (ext) {
        awRefreshBalances();
        awLoadHistory();
        awLoadNetworkStatus();
        awStartNetworkPoller();
        awAddChatMessage('system', `Wallet externa conectada: ${ext}`);
      }
    }
  }

  window.addEventListener('walletConnected', (e) => {
    awSyncExternalWallet();
  });

  window.addEventListener('accountsChanged', (e) => {
    setTimeout(awSyncExternalWallet, 200);
  });

  window.addEventListener('walletDisconnected', () => {
    awState._lastExtAddr = null;
    awRenderIdentity();
    if (!awState.internalAddress) {
      setText('aw-bal-usdc', '—');
      setText('aw-bal-eurc', '—');
      setText('aw-bal-lp', '—');
      setText('aw-bal-total', '$—');
    } else {
      awRefreshBalances();
    }
  });

  // ═══════════════════════════════════════════════════════════
  //  INIT — runs when tab becomes visible
  // ═══════════════════════════════════════════════════════════

  function awInit() {
    if (awState.initialized) {
      // Tab revisited — just refresh data
      awRenderIdentity();
      const addr = getActiveAddress();
      if (addr) {
        awRefreshBalances();
        awLoadHistory();
        awLoadAgentLogs();
      }
      awLoadNetworkStatus();
      return;
    }
    awState.initialized = true;
    console.log('[AW] Initializing Autonomous Wallet v1.0');

    // Attach swap from listener
    const swapFrom = $('aw-swap-from');
    if (swapFrom) swapFrom.addEventListener('change', awUpdateSwapToLabel);

    // Try to restore session from localStorage
    const savedSid  = localStorage.getItem(AW_SESSION_KEY);
    const savedAddr = localStorage.getItem(AW_ADDRESS_KEY);
    const savedLbl  = localStorage.getItem(AW_LABEL_KEY);
    if (savedSid && savedAddr) {
      awState.sessionId       = savedSid;
      awState.internalAddress = savedAddr;
      awState.internalLabel   = savedLbl || 'Autonomous Wallet';
      console.log('[AW] Session restored:', savedAddr);
    }

    // Sync with external wallet
    awSyncExternalWallet();

    // If no external wallet, show internal state
    if (!window.walletState?.address) {
      awRenderIdentity();
    }

    // Load network status always
    awLoadNetworkStatus();
    awStartNetworkPoller();

    // If any wallet, load data
    const addr = getActiveAddress();
    if (addr) {
      awRefreshBalances();
      awLoadHistory();
      awLoadAgentLogs();
    }
  }

  // ── Expose globally for onclick handlers and tab switch ────
  window.awInit                = awInit;
  window.awCreateInternalWallet = awCreateInternalWallet;
  window.awLoadInternalWallet  = awLoadInternalWallet;
  window.awRefreshBalances     = window.awRefreshBalances;  // already set
  window.awLoadHistory         = window.awLoadHistory;
  window.awAgentSend           = window.awAgentSend;
  window.awSignAndSend         = window.awSignAndSend;
  window.awCancelSign          = window.awCancelSign;
  window.awQuickCmd            = window.awQuickCmd;
  window.awPayAgent            = window.awPayAgent;
  window.awSwapAgent           = window.awSwapAgent;
  window.awLoadAgentLogs       = window.awLoadAgentLogs;
  window.awCopyAddress         = window.awCopyAddress;

  // ── Add fadeInUp animation ─────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    @keyframes fadeInUp {
      from { opacity:0; transform:translateX(-50%) translateY(10px); }
      to   { opacity:1; transform:translateX(-50%) translateY(0); }
    }
  `;
  document.head.appendChild(style);

  console.log('[AW] Module loaded — Arc Testnet Autonomous Wallet v1.0');
})();
