// ============================================================
// ExecDaat — Unified Balance
// Visualização unificada de ativos reais da carteira
// Build: 20260630
// ============================================================
'use strict';

/* ── Tokens suportados na Arc Testnet (dados reais do app) ── */
const UB_TOKENS = [
  {
    symbol:   'USDC',
    name:     'USD Coin',
    decimals: 6,
    address:  () => window.USDC_ADDRESS || '0x3600000000000000000000000000000000000000',
    network:  'Arc Testnet',
    chainId:  5042002,
    usdRate:  1.0,
    color:    '#2775CA',
    bgColor:  'rgba(39,117,202,0.12)',
    borderColor: 'rgba(39,117,202,0.28)',
    icon:     'https://assets.coingecko.com/coins/images/6319/small/usdc.png',
    iconFallback: 'fas fa-dollar-sign',
    iconColor: '#2775CA',
  },
  {
    symbol:   'EURC',
    name:     'Euro Coin',
    decimals: 6,
    address:  () => window.EURC_ADDRESS || '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
    network:  'Arc Testnet',
    chainId:  5042002,
    usdRate:  1.08,
    color:    '#a78bfa',
    bgColor:  'rgba(167,139,250,0.12)',
    borderColor: 'rgba(167,139,250,0.28)',
    icon:     'https://assets.coingecko.com/coins/images/26045/small/euro-coin.png',
    iconFallback: 'fas fa-euro-sign',
    iconColor: '#a78bfa',
  },
];

/* ── Estado interno ── */
const _ubState = {
  loading:  false,
  error:    null,
  balances: [],   // [{ token, balance, usdValue }]
  totalUSD: 0,
  lastRefresh: null,
};

/* ── Helpers ── */
function _ubFmt(n, decimals = 4) {
  if (n === null || n === undefined) return '--';
  const num = Number(n);
  if (isNaN(num)) return '--';
  if (num === 0) return '0.00';
  return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: decimals });
}

function _ubFmtUSD(n) {
  if (n === null || n === undefined || isNaN(Number(n))) return '$0.00';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(Number(n));
}

/* ── Buscar saldo ERC-20 via eth_call (igual ao padrão do wallet.js) ── */
async function _ubFetchERC20Balance(tokenAddress, walletAddress, provider) {
  try {
    const sel  = '0x70a08231'; // balanceOf(address)
    const data = sel + walletAddress.slice(2).padStart(64, '0');
    const res  = await provider.request({
      method: 'eth_call',
      params: [{ to: tokenAddress, data }, 'latest'],
    });
    if (!res || res === '0x') return 0;
    return Number(BigInt(res)) / 1e6; // decimals=6 para USDC/EURC
  } catch (e) {
    console.warn('[UB] Erro ao buscar saldo ERC-20:', tokenAddress, e);
    return null;
  }
}

/* ── Função principal: carregar saldos reais ── */
async function ubLoadBalances() {
  const state = window.walletState;

  // Sem carteira conectada — limpar e mostrar empty state
  if (!state || !state.connected || !state.address || !state.provider) {
    _ubState.balances = [];
    _ubState.totalUSD = 0;
    _ubState.error    = null;
    _ubRender();
    return;
  }

  _ubState.loading = true;
  _ubState.error   = null;
  _ubRenderLoading();

  try {
    const addr     = state.address;
    const provider = state.provider;
    const results  = [];

    for (const token of UB_TOKENS) {
      const tokenAddr = token.address();
      const balance   = await _ubFetchERC20Balance(tokenAddr, addr, provider);
      const usdValue  = balance !== null ? balance * token.usdRate : null;
      results.push({
        token,
        balance,
        usdValue,
        address: tokenAddr,
      });
    }

    _ubState.balances    = results;
    _ubState.totalUSD    = results.reduce((acc, r) => acc + (r.usdValue || 0), 0);
    _ubState.lastRefresh = new Date();
    _ubState.loading     = false;
    _ubState.error       = null;

  } catch (err) {
    console.error('[UB] Erro ao carregar saldos:', err);
    _ubState.loading = false;
    _ubState.error   = err.message || 'Erro ao carregar saldos';
  }

  _ubRender();
}

/* ── Loading skeleton ── */
function _ubRenderLoading() {
  const container = document.getElementById('ub-token-table-body');
  if (!container) return;
  container.innerHTML = `
    ${UB_TOKENS.map(() => `
      <div class="ub-token-row ub-skeleton-row">
        <div class="ub-skeleton ub-skeleton-icon"></div>
        <div class="ub-skeleton ub-skeleton-text" style="width:80px;"></div>
        <div class="ub-skeleton ub-skeleton-text" style="width:60px;"></div>
        <div class="ub-skeleton ub-skeleton-text" style="width:90px;"></div>
        <div class="ub-skeleton ub-skeleton-text" style="width:70px;"></div>
      </div>
    `).join('')}
  `;
  const totalEl = document.getElementById('ub-total-value');
  if (totalEl) totalEl.innerHTML = `<span class="ub-skeleton ub-skeleton-text" style="width:120px;height:32px;display:inline-block;vertical-align:middle;"></span>`;
}

/* ── Renderizar estado completo ── */
function _ubRender() {
  _ubRenderHeroStats();
  _ubRenderCards();
  _ubRenderTable();
}

function _ubRenderHeroStats() {
  const state      = window.walletState;
  const connected  = state?.connected;
  const tokenCount = UB_TOKENS.length;
  const netCount   = [...new Set(UB_TOKENS.map(t => t.network))].length;

  // Total
  const totalEl = document.getElementById('ub-total-value');
  if (totalEl) {
    if (!connected) {
      totalEl.textContent = '$0.00';
    } else if (_ubState.loading) {
      totalEl.innerHTML = `<span class="ub-skeleton ub-skeleton-text" style="width:120px;height:32px;display:inline-block;vertical-align:middle;"></span>`;
    } else {
      totalEl.textContent = _ubFmtUSD(_ubState.totalUSD);
    }
  }

  // Token count
  const tokEl = document.getElementById('ub-token-count');
  if (tokEl) tokEl.textContent = tokenCount;

  // Network count
  const netEl = document.getElementById('ub-net-count');
  if (netEl) netEl.textContent = netCount;
}

function _ubRenderCards() {
  // Card: Total Unified Balance
  const cardTotal = document.getElementById('ub-card-total');
  if (cardTotal) {
    const state     = window.walletState;
    const connected = state?.connected;

    let valueHtml;
    if (!connected) {
      valueHtml = `<div class="ub-card-val text-gray-500">Wallet not connected</div>`;
    } else if (_ubState.loading) {
      valueHtml = `<div class="ub-card-val"><span class="ub-skeleton ub-skeleton-text" style="width:140px;height:28px;display:inline-block;"></span></div>`;
    } else if (_ubState.error) {
      valueHtml = `<div class="ub-card-val" style="color:#f87171;font-size:13px;">⚠ ${_ubState.error}</div>`;
    } else {
      valueHtml = `
        <div class="ub-card-val">${_ubFmtUSD(_ubState.totalUSD)}</div>
        <div class="ub-card-sub">Total across ${_ubState.balances.filter(b => b.balance > 0).length} token${_ubState.balances.filter(b => b.balance > 0).length !== 1 ? 's' : ''}</div>
      `;
    }

    cardTotal.innerHTML = `
      <div class="ub-card-header">
        <div class="ub-card-icon" style="background:linear-gradient(135deg,#7c3aed,#3b82f6);">
          <i class="fas fa-wallet"></i>
        </div>
        <span class="ub-card-title">Total Unified Balance</span>
      </div>
      ${valueHtml}
      ${_ubState.lastRefresh ? `<div class="ub-card-refresh">Updated ${_ubState.lastRefresh.toLocaleTimeString()}</div>` : ''}
    `;
  }

  // Card: Supported Tokens
  const cardTokens = document.getElementById('ub-card-tokens');
  if (cardTokens) {
    cardTokens.innerHTML = `
      <div class="ub-card-header">
        <div class="ub-card-icon" style="background:linear-gradient(135deg,#06b6d4,#7c3aed);">
          <i class="fas fa-coins"></i>
        </div>
        <span class="ub-card-title">Supported Tokens</span>
      </div>
      <div class="ub-card-val">${UB_TOKENS.length}</div>
      <div class="ub-card-sub">${[...new Set(UB_TOKENS.map(t => t.network))].join(', ')}</div>
      <div class="ub-token-chips">
        ${UB_TOKENS.map(t => `
          <span class="ub-token-chip" style="border-color:${t.borderColor};background:${t.bgColor};color:${t.color};">
            <i class="${t.iconFallback}" style="font-size:9px;"></i>
            ${t.symbol}
          </span>
        `).join('')}
      </div>
    `;
  }
}

function _ubRenderTable() {
  const tbody = document.getElementById('ub-token-table-body');
  if (!tbody) return;

  const state     = window.walletState;
  const connected = state?.connected;

  // Not connected
  if (!connected) {
    tbody.innerHTML = `
      <div class="ub-empty-state">
        <div class="ub-empty-icon"><i class="fas fa-wallet"></i></div>
        <div class="ub-empty-title">Connect your wallet</div>
        <div class="ub-empty-sub">Connect your wallet to see your real token balances on Arc Testnet.</div>
        <button onclick="openWalletModal()" class="ub-connect-btn">
          <i class="fas fa-plug"></i> Connect Wallet
        </button>
      </div>
    `;
    return;
  }

  // Error state
  if (_ubState.error) {
    tbody.innerHTML = `
      <div class="ub-empty-state">
        <div class="ub-empty-icon" style="color:#f87171;"><i class="fas fa-exclamation-triangle"></i></div>
        <div class="ub-empty-title" style="color:#f87171;">Failed to load balances</div>
        <div class="ub-empty-sub">${_ubState.error}</div>
        <button onclick="ubLoadBalances()" class="ub-connect-btn" style="background:rgba(248,113,113,0.1);border-color:rgba(248,113,113,0.3);color:#f87171;">
          <i class="fas fa-redo"></i> Try Again
        </button>
      </div>
    `;
    return;
  }

  // Loading
  if (_ubState.loading) return; // _ubRenderLoading já foi chamado

  // Empty: carteira conectada mas sem saldo
  const hasAnyBalance = _ubState.balances.some(b => b.balance && b.balance > 0);
  if (_ubState.balances.length === 0 || !hasAnyBalance) {
    tbody.innerHTML = `
      <div class="ub-empty-state">
        <div class="ub-empty-icon"><i class="fas fa-inbox"></i></div>
        <div class="ub-empty-title">No token balances found</div>
        <div class="ub-empty-sub">
          Your wallet has no USDC or EURC balance on Arc Testnet.<br>
          Get testnet tokens from the <a href="https://faucet.circle.com" target="_blank" rel="noopener" style="color:#a78bfa;text-decoration:underline;">Circle Faucet</a>.
        </div>
      </div>
      ${_ubRenderZeroRows()}
    `;
    return;
  }

  // Tabela com saldos reais
  tbody.innerHTML = _ubState.balances.map(row => `
    <div class="ub-token-row" style="border-color:${row.token.borderColor};">
      <div class="ub-token-info">
        <div class="ub-token-icon-wrap" style="background:${row.token.bgColor};border:1px solid ${row.token.borderColor};">
          <img src="${row.token.icon}" alt="${row.token.symbol}" class="ub-token-img"
            onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
          <div class="ub-token-icon-fallback" style="display:none;color:${row.token.iconColor};">
            <i class="${row.token.iconFallback}"></i>
          </div>
        </div>
        <div>
          <div class="ub-token-symbol">${row.token.symbol}</div>
          <div class="ub-token-name">${row.token.name}</div>
        </div>
      </div>
      <div class="ub-token-network">
        <span class="ub-net-pill">
          <span class="ub-net-dot"></span>
          ${row.token.network}
        </span>
      </div>
      <div class="ub-token-balance">
        ${row.balance !== null ? _ubFmt(row.balance) : '<span style="color:#6b7280">--</span>'}
        <span class="ub-token-sym-small">${row.token.symbol}</span>
      </div>
      <div class="ub-token-usd">
        ${row.usdValue !== null ? _ubFmtUSD(row.usdValue) : '<span style="color:#6b7280">--</span>'}
      </div>
      <div class="ub-token-rate">
        <span class="ub-rate-pill">1 ${row.token.symbol} = ${_ubFmtUSD(row.token.usdRate)}</span>
      </div>
    </div>
  `).join('');
}

/* Mostrar linhas zeradas (tokens com saldo zero) */
function _ubRenderZeroRows() {
  return _ubState.balances.map(row => `
    <div class="ub-token-row ub-token-row-zero" style="border-color:${row.token.borderColor};opacity:0.5;">
      <div class="ub-token-info">
        <div class="ub-token-icon-wrap" style="background:${row.token.bgColor};border:1px solid ${row.token.borderColor};">
          <img src="${row.token.icon}" alt="${row.token.symbol}" class="ub-token-img"
            onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
          <div class="ub-token-icon-fallback" style="display:none;color:${row.token.iconColor};">
            <i class="${row.token.iconFallback}"></i>
          </div>
        </div>
        <div>
          <div class="ub-token-symbol">${row.token.symbol}</div>
          <div class="ub-token-name">${row.token.name}</div>
        </div>
      </div>
      <div class="ub-token-network">
        <span class="ub-net-pill">
          <span class="ub-net-dot"></span>
          ${row.token.network}
        </span>
      </div>
      <div class="ub-token-balance">0.00 <span class="ub-token-sym-small">${row.token.symbol}</span></div>
      <div class="ub-token-usd">$0.00</div>
      <div class="ub-token-rate">
        <span class="ub-rate-pill">1 ${row.token.symbol} = ${_ubFmtUSD(row.token.usdRate)}</span>
      </div>
    </div>
  `).join('');
}

/* ── Expor função pública de refresh ── */
window.ubRefresh = function() {
  ubLoadBalances();
};

/* ── Auto-iniciar quando a aba Unified Balance é ativada ── */
window.ubInit = function() {
  // Evitar dupla inicialização
  if (window._ubInitialized) {
    // Já inicializado: só recarrega se a carteira mudou
    const curAddr = window.walletState?.address;
    if (curAddr !== window._ubLastAddr) {
      window._ubLastAddr = curAddr;
      ubLoadBalances();
    } else {
      _ubRender();
    }
    return;
  }
  window._ubInitialized = true;
  window._ubLastAddr    = window.walletState?.address || null;

  // Ouvir eventos de conexão/desconexão de carteira
  document.addEventListener('walletConnected', function() {
    const newAddr = window.walletState?.address;
    if (newAddr !== window._ubLastAddr) {
      window._ubLastAddr = newAddr;
      // Só recarrega se a aba estiver visível
      const tab = document.getElementById('tab-content-unified');
      if (tab && !tab.classList.contains('hidden')) {
        ubLoadBalances();
      }
    }
  });
  document.addEventListener('walletDisconnected', function() {
    window._ubLastAddr = null;
    _ubState.balances  = [];
    _ubState.totalUSD  = 0;
    const tab = document.getElementById('tab-content-unified');
    if (tab && !tab.classList.contains('hidden')) {
      _ubRender();
    }
  });

  ubLoadBalances();
};

/* ── Inicialização quando o DOM estiver pronto ── */
document.addEventListener('DOMContentLoaded', function() {
  // Não auto-inicializa — apenas quando a aba é aberta via switchTab('unified')
  // Isso evita chamadas RPC desnecessárias se o usuário não acessar a página
  console.log('[UB] Unified Balance module loaded');
});
