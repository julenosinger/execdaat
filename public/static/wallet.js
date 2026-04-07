// ============================================================
// ExecDaat - EVM Wallet Connection
// Suporta MetaMask, Coinbase Wallet, Rabby, Brave Wallet,
// e qualquer injetor EIP-1193 (window.ethereum)
// Compatível com EIP-6963 (múltiplos provedores)
// ============================================================

// Configuração da Arc Testnet
const ARC_TESTNET_PARAMS = {
  chainId: '0x4cef52',          // 5042002 em hex
  chainName: 'Arc Testnet',
  nativeCurrency: {
    // MetaMask exige decimals=18 para o campo nativeCurrency em wallet_addEthereumChain
    // mesmo que o token nativo (USDC) use 6 casas — este campo é obrigatório ser 18
    name: 'USDC',
    symbol: 'USDC',
    decimals: 18,
  },
  // RPC primário + alternativos (a wallet usa o primeiro da lista)
  rpcUrls: [
    'https://rpc.testnet.arc.network',
    'https://rpc.blockdaemon.testnet.arc.network',
    'https://rpc.drpc.testnet.arc.network',
    'https://rpc.quicknode.testnet.arc.network',
  ],
  blockExplorerUrls: ['https://testnet.arcscan.app'],
};

// Endereços dos contratos — definidos no window para compartilhar entre módulos
// evm-tx.js e outros módulos usam window.USDC_ADDRESS / window.EURC_ADDRESS
if (typeof window.USDC_ADDRESS === 'undefined') {
  window.USDC_ADDRESS = '0x3600000000000000000000000000000000000000';
}
if (typeof window.EURC_ADDRESS === 'undefined') {
  window.EURC_ADDRESS = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
}
// Aliases para uso local neste arquivo
var USDC_ADDRESS = window.USDC_ADDRESS;
var EURC_ADDRESS = window.EURC_ADDRESS;

// ============================================================
// ESTADO GLOBAL DA WALLET
// ============================================================
window.walletState = {
  connected: false,
  address: null,
  shortAddress: null,
  chainId: null,
  onArcNetwork: false,
  usdcBalance: null,
  eurcBalance: null,
  provider: null,
};

// Armazena provedores EIP-6963 descobertos
window._eip6963Providers = [];
window._detectedProviders = [];

// ============================================================
// EIP-6963: Escutar anúncios de provedores
// ============================================================
window.addEventListener('eip6963:announceProvider', (event) => {
  const { info, provider } = event.detail;
  // Evitar duplicatas pelo rdns
  const exists = window._eip6963Providers.find(p => p.info.rdns === info.rdns);
  if (!exists) {
    window._eip6963Providers.push({ info, provider });
    console.log('[WALLET] EIP-6963 provider announced:', info.name);
  }
});

// Solicitar anúncios de provedores EIP-6963
window.dispatchEvent(new Event('eip6963:requestProvider'));

// ============================================================
// DETECTAR PROVEDORES EIP-1193 + EIP-6963
// ============================================================
function detectProviders() {
  const providers = [];
  const seen = new Set(); // tracks normalized logo-keys to prevent duplicates

  // ── Helper: get a stable dedup key from a provider ────────────────────────
  function _dedupKey(p) {
    const rdns = (p.rdns || '').toLowerCase();
    const name = (p.name || '').toLowerCase();
    if (rdns.includes('metamask')  || p.isMetaMask)       return 'metamask';
    if (rdns.includes('coinbase')  || p.isCoinbaseWallet)  return 'coinbase';
    if (rdns.includes('rabby')     || p.isRabby)           return 'rabby';
    if (rdns.includes('brave')     || p.isBraveWallet)     return 'brave';
    if (rdns.includes('phantom')   || name.includes('phantom'))  return 'phantom';
    if (rdns.includes('backpack')  || name.includes('backpack')) return 'backpack';
    if (rdns.includes('okx')       || name.includes('okx'))      return 'okx';
    if (rdns.includes('keplr')     || name.includes('keplr'))    return 'keplr';
    if (rdns.includes('starkey')   || name.includes('starkey'))  return 'starkey';
    // Fallback: use rdns or lowercased name
    return rdns || name.replace(/\s/g, '') || 'unknown';
  }

  // 1. Provedores EIP-6963 (modern wallet discovery — preferred)
  window._eip6963Providers.forEach(({ info, provider }) => {
    const key = _dedupKey({ rdns: info.rdns, name: info.name });
    if (!seen.has(key)) {
      seen.add(key);
      providers.push({ name: info.name, icon: 'fas fa-wallet', provider, rdns: info.rdns });
    }
  });

  // 2. Fallback: window.ethereum (EIP-1193 legacy)
  if (window.ethereum) {
    // Multiple providers via window.ethereum.providers array
    if (window.ethereum.providers && Array.isArray(window.ethereum.providers)) {
      window.ethereum.providers.forEach(p => {
        let name = 'Browser Wallet';
        if (p.isMetaMask && !p.isBraveWallet) name = 'MetaMask';
        else if (p.isCoinbaseWallet) name = 'Coinbase Wallet';
        else if (p.isRabby) name = 'Rabby';
        else if (p.isBraveWallet) name = 'Brave Wallet';
        else if (p.isPhantom) name = 'Phantom';
        const key = _dedupKey({ ...p, name });
        if (!seen.has(key)) {
          seen.add(key);
          providers.push({ name, icon: 'fas fa-wallet', provider: p });
        }
      });
    } else {
      // Single window.ethereum provider
      let name = 'Browser Wallet';
      // Note: Brave injects both isBraveWallet AND isMetaMask — check Brave first
      if (window.ethereum.isBraveWallet)      name = 'Brave Wallet';
      else if (window.ethereum.isMetaMask)    name = 'MetaMask';
      else if (window.ethereum.isCoinbaseWallet) name = 'Coinbase Wallet';
      else if (window.ethereum.isRabby)       name = 'Rabby';
      else if (window.ethereum.isPhantom)     name = 'Phantom';
      const key = _dedupKey({ ...window.ethereum, name });
      if (!seen.has(key)) {
        seen.add(key);
        providers.push({ name, icon: 'fas fa-wallet', provider: window.ethereum });
      }
    }
  }

  return providers;
}

// ============================================================
// FORMATAR ENDEREÇO
// ============================================================
function shortenAddress(address) {
  if (!address) return '';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// ============================================================
// CONVERTER chainId para decimal
// ============================================================
function hexToDecimal(hex) {
  return parseInt(hex, 16);
}

// ============================================================
// BUSCAR SALDO USDC via eth_call (sem ethers.js)
// ============================================================
async function fetchUSDCBalance(address, provider) {
  try {
    const balanceOfSelector = '0x70a08231';
    const paddedAddress = address.slice(2).padStart(64, '0');
    const data = balanceOfSelector + paddedAddress;

    const result = await provider.request({
      method: 'eth_call',
      params: [{ to: window.USDC_ADDRESS, data }, 'latest'],
    });

    if (result && result !== '0x') {
      const balance = BigInt(result);
      const formatted = Number(balance) / 1e6;
      return formatted.toFixed(4);
    }
    return '0.0000';
  } catch (err) {
    console.warn('[WALLET] Erro ao buscar saldo USDC:', err);
    return null;
  }
}

// ============================================================
// ADICIONAR / TROCAR PARA ARC TESTNET
// ============================================================
async function switchToArcTestnet(provider) {
  try {
    // ── 1. Verificar se já está na rede correta ──────────────────────────────
    try {
      const currentChainHex = await provider.request({ method: 'eth_chainId' });
      const currentChain = parseInt(currentChainHex, 16);
      if (currentChain === 5042002) {
        // Já está na Arc Testnet — atualizar estado e retornar
        if (window.walletState) {
          window.walletState.chainId = 5042002;
          window.walletState.onArcNetwork = true;
        }
        console.log('[WALLET] Já está na Arc Testnet (5042002)');
        return true;
      }
    } catch (_) { /* ignorar erro na leitura do chainId */ }

    // ── 2. Tentar trocar para Arc Testnet ────────────────────────────────────
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: ARC_TESTNET_PARAMS.chainId }],  // '0x4cef52'
    });

    // Atualizar estado após troca bem-sucedida
    if (window.walletState) {
      window.walletState.chainId = 5042002;
      window.walletState.onArcNetwork = true;
    }
    console.log('[WALLET] Trocou para Arc Testnet com sucesso');
    return true;

  } catch (switchError) {
    // ── 3. Rede não conhecida — adicionar Arc Testnet ────────────────────────
    // Códigos: 4902 (EIP-1193 padrão), -32603 (alguns providers)
    if (switchError.code === 4902 || switchError.code === -32603 ||
        (switchError.data?.originalError?.code === 4902) ||
        switchError.message?.includes('Unrecognized chain ID') ||
        switchError.message?.includes('wallet_addEthereumChain')) {
      try {
        await provider.request({
          method: 'wallet_addEthereumChain',
          params: [ARC_TESTNET_PARAMS],
        });
        // Após adicionar, tentar trocar novamente
        await provider.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: ARC_TESTNET_PARAMS.chainId }],
        });
        if (window.walletState) {
          window.walletState.chainId = 5042002;
          window.walletState.onArcNetwork = true;
        }
        console.log('[WALLET] Arc Testnet adicionada e ativada');
        return true;
      } catch (addError) {
        console.error('[WALLET] Erro ao adicionar rede Arc:', addError);
        showWalletToast(t('wallet_network_add_error', addError.message || addError), 'error');
        return false;
      }
    }

    // ── 4. Usuário rejeitou ───────────────────────────────────────────────────
    if (switchError.code === 4001 ||
        switchError.message?.includes('User rejected') ||
        switchError.message?.includes('user denied')) {
      showWalletToast(t('wallet_network_switch_cancelled'), 'warning');
      return false;
    }

    console.error('[WALLET] Erro ao trocar rede:', switchError);
    showWalletToast(t('wallet_network_switch_error', switchError.message || switchError), 'error');
    return false;
  }
}

// ============================================================
// ATUALIZAR UI DA WALLET
// ============================================================
function updateWalletUI() {
  const state = window.walletState;

  const connectBtn = document.getElementById('wallet-connect-btn');
  const walletInfo = document.getElementById('wallet-info');
  const walletBadge = document.getElementById('wallet-badge');

  if (!state.connected) {
    if (connectBtn) connectBtn.classList.remove('hidden');
    if (walletInfo) walletInfo.classList.add('hidden');
    if (walletBadge) walletBadge.classList.add('hidden');
    updateWalletPanel(false);
    return;
  }

  // Conectado
  if (connectBtn) connectBtn.classList.add('hidden');
  if (walletInfo) {
    walletInfo.classList.remove('hidden');
    walletInfo.style.display = 'flex';

    const addrEl = document.getElementById('wallet-address-display');
    if (addrEl) addrEl.textContent = state.shortAddress;

    const avatarEl = document.getElementById('wallet-avatar');
    if (avatarEl && state.address) {
      avatarEl.textContent = state.address.slice(2, 4).toUpperCase();
    }

    const balEl = document.getElementById('wallet-balance-display');
    if (balEl) {
      if (state.usdcBalance !== null) {
        balEl.textContent = `$${state.usdcBalance} USDC`;
        balEl.classList.remove('hidden');
      }
    }

    const netEl = document.getElementById('wallet-network-display');
    if (netEl) {
      if (state.onArcNetwork) {
        netEl.innerHTML = '<span class="w-2 h-2 rounded-full bg-green-400 inline-block mr-1"></span>Arc Testnet';
        netEl.className = 'text-xs text-green-400';
      } else {
        netEl.innerHTML = '<span class="w-2 h-2 rounded-full bg-yellow-400 inline-block mr-1 animate-pulse"></span>Rede errada';
        netEl.className = 'text-xs text-yellow-400 cursor-pointer hover:text-yellow-300';
        netEl.onclick = () => switchNetworkFromUI();
      }
    }
  }

  if (walletBadge) walletBadge.classList.remove('hidden');

  autofillWalletAddress(state.address);
  updateWalletPanel(true);

  // Dispatch evento para outros módulos
  window.dispatchEvent(new CustomEvent('walletConnected', { detail: state }));
}

// ============================================================
// PREENCHER ENDEREÇO DA WALLET NOS FORMULÁRIOS
// ============================================================
function autofillWalletAddress(address) {
  const payFrom = document.getElementById('pay-from');
  if (payFrom && (!payFrom.value || payFrom.dataset.autoFilled === 'true')) {
    payFrom.value = address;
    payFrom.dataset.autoFilled = 'true';
    payFrom.classList.add('border-purple-500/60');
  }

  const ctClient = document.getElementById('ct-client');
  if (ctClient && (!ctClient.value || ctClient.dataset.autoFilled === 'true')) {
    ctClient.value = address;
    ctClient.dataset.autoFilled = 'true';
    ctClient.classList.add('border-green-500/60');
  }
}

// ============================================================
// PAINEL DA WALLET
// ============================================================
function updateWalletPanel(connected) {
  const panel = document.getElementById('wallet-panel');
  if (!panel) return;

  const state = window.walletState;

  if (!connected) {
    panel.innerHTML = `
      <div class="flex flex-col items-center justify-center py-6 gap-3">
        <div class="w-14 h-14 rounded-full bg-gray-800 border-2 border-dashed border-gray-600 flex items-center justify-center">
          <i class="fas fa-wallet text-gray-500 text-xl"></i>
        </div>
        <p class="text-gray-400 text-sm text-center">${t('wallet_connect_prompt_evm')}</p>
        <button onclick="openWalletModal()" class="wallet-connect-pulse bg-purple-600 hover:bg-purple-700 text-white rounded-xl px-5 py-2.5 text-sm font-semibold transition-all flex items-center gap-2">
          <i class="fas fa-plug mr-1"></i>${t('btn_connect_wallet')}
        </button>
        <p class="text-xs text-gray-600">MetaMask, Coinbase, Rabby e outros</p>
      </div>
    `;
    return;
  }

  panel.innerHTML = `
    <div class="space-y-3">
      <!-- Endereço -->
      <div class="flex items-center gap-3 bg-gray-800/60 rounded-xl p-3">
        <div class="w-9 h-9 rounded-full bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center flex-shrink-0 text-white font-bold text-sm">
          ${state.address ? state.address.slice(2, 4).toUpperCase() : '??'}
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-white font-medium text-sm font-mono truncate">${state.shortAddress}</div>
          <div class="text-xs text-gray-500 truncate">${state.address}</div>
        </div>
        <button onclick="copyAddress()" title="${t('wallet_copy_address_title')}" class="text-gray-400 hover:text-white transition-colors flex-shrink-0">
          <i class="fas fa-copy text-sm"></i>
        </button>
      </div>

      <!-- USDC Balance -->
      <div class="bg-gradient-to-r from-blue-900/40 to-purple-900/40 border border-blue-700/30 rounded-xl p-4">
        <div class="flex items-center justify-between mb-1">
          <span class="text-xs text-gray-400">${t('wallet_usdc_balance')}</span>
          <button onclick="refreshBalance()" class="text-xs text-blue-400 hover:text-blue-300">
            <i class="fas fa-sync-alt"></i>
          </button>
        </div>
        <div class="flex items-end gap-2">
          <span id="panel-balance" class="text-2xl font-bold text-white">${state.usdcBalance ?? '...'}</span>
          <span class="text-blue-400 text-sm mb-0.5">USDC</span>
        </div>
        <div class="text-xs text-gray-500 mt-1">~$${state.usdcBalance ?? '0'} USD</div>
      </div>

      <!-- Rede -->
      <div class="flex items-center justify-between bg-gray-800/60 rounded-xl p-3">
        <div class="flex items-center gap-2">
          <div class="w-2 h-2 rounded-full ${state.onArcNetwork ? 'bg-green-400' : 'bg-yellow-400 animate-pulse'}"></div>
          <span class="text-sm ${state.onArcNetwork ? 'text-green-400' : 'text-yellow-400'}">
            ${state.onArcNetwork ? 'Arc Testnet' : 'Rede incorreta'}
          </span>
        </div>
        ${!state.onArcNetwork ? `
          <button onclick="switchNetworkFromUI()" class="text-xs bg-yellow-600 hover:bg-yellow-700 text-white rounded-lg px-3 py-1.5 transition-colors font-medium">
            <i class="fas fa-exchange-alt mr-1"></i>Trocar rede
          </button>
        ` : `
          <span class="text-xs text-gray-500">Chain 5042002</span>
        `}
      </div>

      <!-- Links rápidos -->
      <div class="grid grid-cols-2 gap-2">
        <a href="https://testnet.arcscan.app/address/${state.address}" target="_blank"
           class="flex items-center justify-center gap-1.5 bg-gray-800/60 hover:bg-gray-700/60 rounded-lg p-2.5 text-xs text-gray-300 transition-colors">
          <i class="fas fa-search text-purple-400"></i>Explorer
        </a>
        <a href="https://faucet.circle.com" target="_blank"
           class="flex items-center justify-center gap-1.5 bg-gray-800/60 hover:bg-gray-700/60 rounded-lg p-2.5 text-xs text-gray-300 transition-colors">
          <i class="fas fa-faucet text-blue-400"></i>Faucet
        </a>
      </div>

      <!-- Desconectar -->
      <button onclick="disconnectWallet()" class="w-full text-xs text-gray-500 hover:text-red-400 transition-colors py-1.5 flex items-center justify-center gap-1">
        <i class="fas fa-sign-out-alt"></i>Desconectar
      </button>
    </div>
  `;
}

// ============================================================
// COPIAR ENDEREÇO
// ============================================================
function copyAddress() {
  if (window.walletState.address) {
    navigator.clipboard.writeText(window.walletState.address).then(() => {
      showWalletToast(t('wallet_address_copied'), 'success');
    }).catch(() => {
      // Fallback para browsers sem clipboard API
      const el = document.createElement('textarea');
      el.value = window.walletState.address;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      showWalletToast(t('wallet_address_copied'), 'success');
    });
  }
}

// ============================================================
// ATUALIZAR SALDO
// ============================================================
async function refreshBalance() {
  const state = window.walletState;
  if (!state.connected || !state.provider || !state.onArcNetwork) return;

  const balance = await fetchUSDCBalance(state.address, state.provider);
  state.usdcBalance = balance;

  const panelBal = document.getElementById('panel-balance');
  if (panelBal) panelBal.textContent = balance ?? '0.0000';

  const headerBal = document.getElementById('wallet-balance-display');
  if (headerBal && balance !== null) {
    headerBal.textContent = `$${balance} USDC`;
  }
}

// ============================================================
// TROCAR PARA ARC TESTNET (via UI)
// ============================================================
async function switchNetworkFromUI() {
  const state = window.walletState;
  if (!state.provider) return;

  showWalletToast('Trocando para Arc Testnet...', 'info');
  const ok = await switchToArcTestnet(state.provider);
  if (ok) {
    state.chainId = 5042002;
    state.onArcNetwork = true;
    showWalletToast('✅ Arc Testnet conectada!', 'success');
    updateWalletUI();
    // Buscar saldo após trocar rede
    const bal = await fetchUSDCBalance(state.address, state.provider);
    state.usdcBalance = bal;
    updateWalletUI();
  }
}

// ============================================================
// MODAL DE SELEÇÃO DE WALLET
// ============================================================
function openWalletModal() {
  // Remover modal existente se houver
  const existing = document.getElementById('wallet-modal');
  if (existing) existing.remove();

  // Se já conectado, mostrar painel de gerenciamento
  if (window.walletState.connected) {
    openConnectedWalletModal();
    return;
  }

  // Redesolicitar providers EIP-6963 para garantir lista atualizada
  window.dispatchEvent(new Event('eip6963:requestProvider'));

  // Pequeno delay para aguardar EIP-6963
  setTimeout(() => {
    _renderWalletModal();
  }, 100);
}

// Global helper to get logo key from provider or wallet name
function _getWalletLogoKey(p) {
  const rdns = (p && p.rdns ? p.rdns : '').toLowerCase();
  const name = (p && p.name ? p.name : '').toLowerCase();
  if (rdns.includes('metamask')  || name.includes('metamask'))  return 'metamask';
  if (rdns.includes('rabby')     || name.includes('rabby'))     return 'rabby';
  if (rdns.includes('phantom')   || name.includes('phantom'))   return 'phantom';
  if (rdns.includes('coinbase')  || name.includes('coinbase'))  return 'coinbase';
  if (rdns.includes('okx')       || name.includes('okx'))       return 'okx';
  if (rdns.includes('brave')     || name.includes('brave'))     return 'brave';
  if (rdns.includes('backpack')  || name.includes('backpack'))  return 'backpack';
  if (rdns.includes('keplr')     || name.includes('keplr'))     return 'keplr';
  if (rdns.includes('starkey')   || name.includes('starkey'))   return 'starkey';
  return 'default';
}

function _renderWalletModal() {
  const providers = detectProviders();

  // ── Official wallet icons — inline SVG (zero external deps, CSP-safe) ──────
  // All icons are high-fidelity inline SVGs from official brand kits.
  // No img tags, no CDN, no CORS issues, no CSP violations.
  const WS = 'width:38px;height:38px;display:block;flex-shrink:0;';
  const WALLET_LOGOS = {

    // MetaMask — official fox, exact brand colors
    'metamask': `<svg viewBox="0 0 318 318" xmlns="http://www.w3.org/2000/svg" style="width:38px;height:38px;display:block;border-radius:9px;background:#1a1a1a;padding:2px;">
      <polygon fill="#E17726" stroke="#E17726" stroke-width="1" points="274.1,35.5 174.6,109.4 193,65.8"/>
      <polygon fill="#E27625" stroke="#E27625" stroke-width="1" points="44.4,35.5 143.1,110.1 125.6,65.8"/>
      <polygon fill="#E27625" stroke="#E27625" stroke-width="1" points="238.3,206.8 211.8,247.4 268.5,263 284.8,207.7"/>
      <polygon fill="#E27625" stroke="#E27625" stroke-width="1" points="33.9,207.7 50.1,263 106.8,247.4 80.3,206.8"/>
      <polygon fill="#E27625" stroke="#E27625" stroke-width="1" points="103.6,138.2 87.8,162.1 144.1,164.6 142.1,104.1"/>
      <polygon fill="#E27625" stroke="#E27625" stroke-width="1" points="214.9,138.2 175.9,103.4 174.6,164.6 230.9,162.1"/>
      <polygon fill="#E27625" stroke="#E27625" stroke-width="1" points="106.8,247.4 140.6,230.9 111.4,208.1"/>
      <polygon fill="#E27625" stroke="#E27625" stroke-width="1" points="177.9,230.9 211.8,247.4 207.1,208.1"/>
      <polygon fill="#D5BFB2" stroke="#D5BFB2" stroke-width="1" points="211.8,247.4 177.9,230.9 180.7,253.5 180.4,262.3"/>
      <polygon fill="#D5BFB2" stroke="#D5BFB2" stroke-width="1" points="106.8,247.4 138.2,262.3 137.9,253.5 140.6,230.9"/>
      <polygon fill="#233447" stroke="#233447" stroke-width="1" points="138.8,193.5 110.6,185.2 130.5,176.1"/>
      <polygon fill="#233447" stroke="#233447" stroke-width="1" points="179.7,193.5 188,176.1 207.9,185.2"/>
      <polygon fill="#CC6228" stroke="#CC6228" stroke-width="1" points="106.8,247.4 111.6,206.8 80.3,207.7"/>
      <polygon fill="#CC6228" stroke="#CC6228" stroke-width="1" points="206.9,206.8 211.8,247.4 238.3,207.7"/>
      <polygon fill="#CC6228" stroke="#CC6228" stroke-width="1" points="230.9,162.1 174.6,164.6 179.7,193.5 188,176.1 207.9,185.2"/>
      <polygon fill="#CC6228" stroke="#CC6228" stroke-width="1" points="110.6,185.2 130.5,176.1 138.8,193.5 144.1,164.6 87.8,162.1"/>
      <polygon fill="#E27525" stroke="#E27525" stroke-width="1" points="87.8,162.1 138.8,193.5 111.4,208.1"/>
      <polygon fill="#E27525" stroke="#E27525" stroke-width="1" points="207.9,185.2 180.4,208.1 230.9,162.1"/>
      <polygon fill="#E27525" stroke="#E27525" stroke-width="1" points="144.1,164.6 138.8,193.5 146.3,232.6 148,180.4"/>
      <polygon fill="#E27525" stroke="#E27525" stroke-width="1" points="174.6,164.6 170.7,180.3 172.2,232.6 179.7,193.5"/>
      <polygon fill="#F5841F" stroke="#F5841F" stroke-width="1" points="179.7,193.5 172.2,232.6 177.9,230.9 207.9,185.2"/>
      <polygon fill="#F5841F" stroke="#F5841F" stroke-width="1" points="110.6,185.2 111.4,208.1 140.6,230.9 144.1,164.6"/>
      <polygon fill="#C0AC9D" stroke="#C0AC9D" stroke-width="1" points="180.4,262.3 180.7,253.5 178.1,251.2 140.4,251.2 137.9,253.5 138.2,262.3 106.8,247.4 117.8,256.4 140.1,271.9 178.4,271.9 200.8,256.4 211.8,247.4"/>
      <polygon fill="#161616" stroke="#161616" stroke-width="1" points="177.9,230.9 172.2,232.6 146.3,232.6 140.6,230.9 137.9,253.5 140.4,251.2 178.1,251.2 180.7,253.5"/>
      <polygon fill="#763E1A" stroke="#763E1A" stroke-width="1" points="274.1,35.5 193,65.8 206.9,111.4 230.9,118.1 238.3,139.3 230.9,162.1 174.6,164.6 148,180.4 148,193.5 179.7,193.5 207.9,185.2 230.9,162.1 250.1,207.7 238.3,206.8 211.8,247.4 180.4,262.3 180.4,271.9 211.6,268.3 277.8,132.8"/>
      <polygon fill="#763E1A" stroke="#763E1A" stroke-width="1" points="44.4,35.5 40.7,132.8 106.8,268.3 138.2,271.9 138.2,262.3 106.8,247.4 80.3,206.8 68.3,207.7 87.8,162.1 80.3,139.3 87.8,118.1 111.4,111.4 125.6,65.8"/>
    </svg>`,

    // Phantom — official purple ghost
    'phantom': `<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg" style="width:38px;height:38px;display:block;border-radius:9px;">
      <defs>
        <linearGradient id="ph-bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#534BB1"/>
          <stop offset="100%" stop-color="#551BF9"/>
        </linearGradient>
      </defs>
      <rect width="128" height="128" rx="22" fill="url(#ph-bg)"/>
      <path d="M114 60.5c0-27.9-22.6-50.5-50.5-50.5C36.6 10 14 32.6 14 60.5c0 8.7 2.3 16.9 6.4 24 1.5 2.6 4.2 4.1 7.1 4.1H101c2.5 0 4.9-1.1 6.5-3C111.6 80.7 114 71 114 60.5z" fill="white"/>
      <ellipse cx="49" cy="61" rx="8" ry="11" fill="#534BB1"/>
      <ellipse cx="79" cy="61" rx="8" ry="11" fill="#534BB1"/>
      <circle cx="52" cy="58" r="3.5" fill="white"/>
      <circle cx="82" cy="58" r="3.5" fill="white"/>
      <path d="M58 80c2.5 3 9.5 3 12 0" stroke="#534BB1" stroke-width="3" stroke-linecap="round" fill="none"/>
      <path d="M27.5 95c0 4.2 3.4 7.5 7.5 7.5s7.5-3.3 7.5-7.5v-8h-15v8z" fill="white"/>
      <path d="M42.5 95c0 4.2 3.4 7.5 7.5 7.5s7.5-3.3 7.5-7.5v-8h-15v8z" fill="#ddd"/>
    </svg>`,

    // Rabby Wallet — official rabbit icon, purple theme
    'rabby': `<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg" style="width:38px;height:38px;display:block;border-radius:9px;">
      <defs>
        <linearGradient id="rb-bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#7084FF"/>
          <stop offset="100%" stop-color="#5C6EFF"/>
        </linearGradient>
      </defs>
      <rect width="128" height="128" rx="22" fill="#1A1A2E"/>
      <!-- ears -->
      <ellipse cx="46" cy="34" rx="10" ry="20" fill="#7084FF"/>
      <ellipse cx="82" cy="34" rx="10" ry="20" fill="#7084FF"/>
      <ellipse cx="46" cy="35" rx="6" ry="14" fill="#FFB3C6" opacity="0.75"/>
      <ellipse cx="82" cy="35" rx="6" ry="14" fill="#FFB3C6" opacity="0.75"/>
      <!-- head/body -->
      <ellipse cx="64" cy="82" rx="32" ry="30" fill="#7084FF"/>
      <!-- eyes -->
      <circle cx="52" cy="74" r="7" fill="white"/>
      <circle cx="76" cy="74" r="7" fill="white"/>
      <circle cx="53.5" cy="73" r="3.5" fill="#1A1A2E"/>
      <circle cx="77.5" cy="73" r="3.5" fill="#1A1A2E"/>
      <circle cx="54.5" cy="72" r="1.2" fill="white"/>
      <circle cx="78.5" cy="72" r="1.2" fill="white"/>
      <!-- nose + mouth -->
      <ellipse cx="64" cy="88" rx="9" ry="5.5" fill="#FFB3C6" opacity="0.85"/>
      <circle cx="64" cy="86" r="3" fill="#FF6B9D"/>
      <path d="M58 92 Q64 97 70 92" stroke="#CC5580" stroke-width="1.5" fill="none" stroke-linecap="round"/>
    </svg>`,

    // Coinbase Wallet — official blue C
    'coinbase': `<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg" style="width:38px;height:38px;display:block;border-radius:9px;">
      <rect width="128" height="128" rx="22" fill="#0052FF"/>
      <circle cx="64" cy="64" r="44" fill="white"/>
      <path d="M64 28C44.1 28 28 44.1 28 64s16.1 36 36 36c13.7 0 25.7-7.7 31.8-19H79.6c-3.7 5.1-9.6 8.4-15.6 8.4C50.3 89.4 38.6 78 38.6 64S50.3 38.6 64 38.6c6 0 11.9 3.3 15.6 8.4h12.2C86.7 35.7 74.7 28 64 28z" fill="#0052FF"/>
    </svg>`,

    // OKX Wallet — official black square-grid logo
    'okx': `<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg" style="width:38px;height:38px;display:block;border-radius:9px;">
      <rect width="128" height="128" rx="22" fill="#000000"/>
      <rect x="26" y="26" width="30" height="30" rx="4" fill="white"/>
      <rect x="72" y="26" width="30" height="30" rx="4" fill="white"/>
      <rect x="26" y="72" width="30" height="30" rx="4" fill="white"/>
      <rect x="72" y="72" width="30" height="30" rx="4" fill="white"/>
    </svg>`,

    // Keplr — official K gradient logo
    'keplr': `<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg" style="width:38px;height:38px;display:block;border-radius:9px;">
      <defs>
        <linearGradient id="kp-bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#1C1C2E"/>
          <stop offset="100%" stop-color="#2A2A45"/>
        </linearGradient>
        <linearGradient id="kp-k" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#6B7BF7"/>
          <stop offset="100%" stop-color="#A855F7"/>
        </linearGradient>
      </defs>
      <rect width="128" height="128" rx="22" fill="url(#kp-bg)"/>
      <path d="M32 24h22v32l28-32h26L72 64l36 40H82L54 72v32H32V24z" fill="url(#kp-k)"/>
    </svg>`,

    // Backpack — official red backpack
    'backpack': `<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg" style="width:38px;height:38px;display:block;border-radius:9px;">
      <rect width="128" height="128" rx="22" fill="#E33E3F"/>
      <path d="M64 16c-14 0-25 11-25 25v4H26a8 8 0 00-8 8v44a8 8 0 008 8h76a8 8 0 008-8V53a8 8 0 00-8-8H89v-4c0-14-11-25-25-25zm0 12c7.2 0 13 5.8 13 13v4H51v-4c0-7.2 5.8-13 13-13zm0 38a8 8 0 100 16 8 8 0 000-16z" fill="white"/>
    </svg>`,

    // Brave Wallet — official lion
    'brave': `<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg" style="width:38px;height:38px;display:block;border-radius:9px;">
      <defs>
        <linearGradient id="bv-bg" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="#FF7654"/>
          <stop offset="100%" stop-color="#FF3000"/>
        </linearGradient>
      </defs>
      <rect width="128" height="128" rx="22" fill="url(#bv-bg)"/>
      <path d="M64 12L100 28l-6 56-30 28-30-28-6-56L64 12z" fill="#FB5422"/>
      <path d="M64 18L95 32l-5 50-26 24-26-24-5-50L64 18z" fill="#F26422" opacity="0.6"/>
      <circle cx="50" cy="54" r="6" fill="white"/>
      <circle cx="78" cy="54" r="6" fill="white"/>
      <path d="M50 70 Q64 80 78 70" stroke="white" stroke-width="4" fill="none" stroke-linecap="round"/>
      <path d="M44 46l6 8m34-8l-6 8" stroke="rgba(255,255,255,0.5)" stroke-width="3" stroke-linecap="round"/>
    </svg>`,

    // StarKey
    'starkey': `<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg" style="width:38px;height:38px;display:block;border-radius:9px;">
      <defs>
        <linearGradient id="sk-bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#0A0A1A"/>
          <stop offset="100%" stop-color="#1a1040"/>
        </linearGradient>
        <linearGradient id="sk-s" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#00E5FF"/>
          <stop offset="50%" stop-color="#7B2FFF"/>
          <stop offset="100%" stop-color="#00E5FF"/>
        </linearGradient>
      </defs>
      <rect width="128" height="128" rx="22" fill="url(#sk-bg)"/>
      <path d="M64 18l9 18 20 3-14.5 14 3.5 20-18-9.5-18 9.5 3.5-20L35 39l20-3L64 18z" fill="url(#sk-s)"/>
      <rect x="52" y="84" width="24" height="14" rx="5" fill="url(#sk-s)" opacity="0.9"/>
      <circle cx="64" cy="110" r="6" fill="none" stroke="url(#sk-s)" stroke-width="3"/>
    </svg>`,

    // Default fallback
    'default': `<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg" style="width:38px;height:38px;display:block;border-radius:9px;">
      <rect width="128" height="128" rx="22" fill="#1e2d3d"/>
      <path d="M24 50a10 10 0 0110-10h60a10 10 0 0110 10v38a10 10 0 01-10 10H34a10 10 0 01-10-10V50zm70 0H34v38h60V50zm-12 19a6 6 0 110 12 6 6 0 010-12z" fill="#7b9cc0"/>
      <path d="M24 60h80" stroke="#7b9cc0" stroke-width="5"/>
    </svg>`,
  };


  // ── Map rdns/name → logo key ─────────────────────────────────────────────────
  const WALLET_INSTALL_URLS = {
    metamask:  'https://metamask.io/download/',
    rabby:     'https://rabby.io/',
    phantom:   'https://phantom.app/',
    coinbase:  'https://www.coinbase.com/wallet/downloads',
    okx:       'https://www.okx.com/web3',
    brave:     'https://brave.com/wallet/',
    backpack:  'https://www.backpack.app/',
    keplr:     'https://www.keplr.app/',
    starkey:   'https://starkeywallet.io/',
  };

  const WALLET_INSTALL_LIST = [
    { key: 'metamask',  name: 'MetaMask',       desc: 'Most popular EVM wallet',   color: '#E27625' },
    { key: 'rabby',     name: 'Rabby Wallet',    desc: 'Security-focused wallet',   color: '#7084FF' },
    { key: 'coinbase',  name: 'Coinbase Wallet', desc: 'Easy crypto wallet',        color: '#0052FF' },
    { key: 'phantom',   name: 'Phantom',         desc: 'Multi-chain wallet',        color: '#AB9FF2' },
    { key: 'brave',     name: 'Brave Wallet',    desc: 'Built-in browser wallet',   color: '#FF5500' },
    { key: 'backpack',  name: 'Backpack',        desc: 'Web3 gaming wallet',        color: '#E33E3F' },
    { key: 'okx',       name: 'OKX Wallet',      desc: 'Multi-chain DEX wallet',    color: '#FFFFFF' },
    { key: 'keplr',     name: 'Keplr',           desc: 'Cosmos ecosystem wallet',   color: '#6B7BF7' },
    { key: 'starkey',   name: 'StarKey',         desc: 'Next-gen Web3 wallet',      color: '#00E5FF' },
  ];

  function getLogoKey(p) {
    const rdns = (p.rdns || '').toLowerCase();
    const name = (p.name || '').toLowerCase();
    if (rdns.includes('metamask')  || name.includes('metamask'))  return 'metamask';
    if (rdns.includes('rabby')     || name.includes('rabby'))     return 'rabby';
    if (rdns.includes('phantom')   || name.includes('phantom'))   return 'phantom';
    if (rdns.includes('coinbase')  || name.includes('coinbase'))  return 'coinbase';
    if (rdns.includes('okx')       || name.includes('okx'))       return 'okx';
    if (rdns.includes('brave')     || name.includes('brave'))     return 'brave';
    if (rdns.includes('backpack')  || name.includes('backpack'))  return 'backpack';
    if (rdns.includes('keplr')     || name.includes('keplr'))     return 'keplr';
    if (rdns.includes('starkey')   || name.includes('starkey'))   return 'starkey';
    return 'default';
  }

  // ── CSS injected once ────────────────────────────────────────────────────────
  if (!document.getElementById('wm-styles')) {
    const s = document.createElement('style');
    s.id = 'wm-styles';
    s.textContent = `
      @keyframes wmSlideUp { from{opacity:0;transform:translateY(24px) scale(.97)} to{opacity:1;transform:translateY(0) scale(1)} }
      @keyframes wmFadeIn  { from{opacity:0} to{opacity:1} }
      @keyframes wmSpin    { to{transform:rotate(360deg)} }
      @keyframes wmPulse   { 0%,100%{opacity:1} 50%{opacity:.4} }
      .wm-overlay { animation: wmFadeIn .2s ease; }
      .wm-panel   { animation: wmSlideUp .28s cubic-bezier(.22,.68,0,1.2); }
      .wm-card {
        display:flex;align-items:center;gap:14px;
        padding:13px 16px;border-radius:14px;cursor:pointer;width:100%;
        background:rgba(255,255,255,0.04);
        border:1px solid rgba(255,255,255,0.07);
        transition:all .18s ease;position:relative;overflow:hidden;
      }
      .wm-card:hover {
        background:rgba(103,76,255,0.12);
        border-color:rgba(139,92,246,.45);
        transform:scale(1.018);
        box-shadow:0 0 0 1px rgba(139,92,246,.15), 0 8px 24px rgba(103,76,255,.2);
      }
      .wm-card:active { transform:scale(.98); }
      .wm-card.detected { border-color:rgba(52,211,153,.18); }
      .wm-card.detected:hover { border-color:rgba(52,211,153,.5); box-shadow:0 0 0 1px rgba(52,211,153,.12),0 8px 24px rgba(52,211,153,.12); background:rgba(52,211,153,.07); }
      .wm-install-card {
        display:flex;align-items:center;gap:12px;padding:11px 14px;border-radius:12px;
        background:rgba(255,255,255,0.025);border:1px solid rgba(255,255,255,0.06);
        cursor:pointer;width:100%;transition:all .16s;text-decoration:none;
      }
      .wm-install-card:hover { background:rgba(255,255,255,.06); border-color:rgba(255,255,255,.14); transform:scale(1.015); }
      .wm-badge { display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:700;letter-spacing:.04em; }
      .wm-badge-detected { background:rgba(52,211,153,.14);color:#34d399;border:1px solid rgba(52,211,153,.25); }
      .wm-badge-install  { background:rgba(255,255,255,.06);color:#6b7280;border:1px solid rgba(255,255,255,.08); }
      .wm-scroll { overflow-y:auto;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.08) transparent; }
      .wm-scroll::-webkit-scrollbar{width:4px} .wm-scroll::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:4px}
      .wm-divider { display:flex;align-items:center;gap:10px;margin:14px 0 10px; }
      .wm-divider::before,.wm-divider::after { content:'';flex:1;height:1px;background:rgba(255,255,255,.07); }
      .wm-divider span { font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#4b5563; }
      .wm-shimmer { position:absolute;inset:0;background:linear-gradient(105deg,transparent 40%,rgba(255,255,255,.04) 50%,transparent 60%);background-size:200% 100%;animation:wmSpin 0s;pointer-events:none; }
    `;
    document.head.appendChild(s);
  }

  // ── Helper: render a detected-provider card ───────────────────────────────────
  function _providerCard(p, idx) {
    const key = getLogoKey(p);
    const logo = WALLET_LOGOS[key] || WALLET_LOGOS.default;
    return `
      <button class="wm-card detected" onclick="connectWithProvider(${idx})"
        onmouseenter="this.querySelector('.wm-shimmer').style.animation='none'"
        onmouseleave="this.querySelector('.wm-shimmer').style.animation='none'">
        <div class="wm-shimmer"></div>
        <div style="flex-shrink:0;position:relative;">${logo}</div>
        <div style="flex:1;text-align:left;min-width:0;">
          <div style="color:#f1f5f9;font-weight:700;font-size:14px;line-height:1.2;">${p.name}</div>
          <div style="color:#6b7280;font-size:11px;margin-top:1px;">${t('wallet_detected_click')}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
          <span class="wm-badge wm-badge-detected">Detected</span>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="color:#4b5563"><path d="M5 10l4-3-4-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
      </button>`;
  }

  // ── Helper: install card ──────────────────────────────────────────────────────
  function _installCard(w) {
    const logo = WALLET_LOGOS[w.key] || WALLET_LOGOS.default;
    return `
      <a class="wm-install-card" href="${WALLET_INSTALL_URLS[w.key]}" target="_blank" rel="noopener">
        <div style="flex-shrink:0;">${logo}</div>
        <div style="flex:1;text-align:left;min-width:0;">
          <div style="color:#d1d5db;font-weight:600;font-size:13px;">${w.name}</div>
          <div style="color:#4b5563;font-size:10px;">${w.desc}</div>
        </div>
        <span class="wm-badge wm-badge-install">Install</span>
      </a>`;
  }

  // ── Filter "install" wallets — hide ones already detected ─────────────────────
  const detectedKeys = new Set(providers.map(p => getLogoKey(p)));
  const installWallets = WALLET_INSTALL_LIST.filter(w => !detectedKeys.has(w.key));

  // ── Build modal HTML ──────────────────────────────────────────────────────────
  const modal = document.createElement('div');
  modal.id = 'wallet-modal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';

  modal.innerHTML = `
    <!-- Overlay -->
    <div class="wm-overlay" style="position:absolute;inset:0;background:rgba(0,0,0,.75);backdrop-filter:blur(12px);" onclick="closeWalletModal()"></div>

    <!-- Panel -->
    <div class="wm-panel" style="
      position:relative;z-index:10;
      background:linear-gradient(160deg,#0d1a2a 0%,#0a1220 100%);
      border:1px solid rgba(255,255,255,.08);
      border-radius:22px;padding:0;
      width:100%;max-width:440px;
      box-shadow:0 32px 80px rgba(0,0,0,.85),0 0 0 1px rgba(103,76,255,.08);
      overflow:hidden;
    ">

      <!-- Top gradient bar -->
      <div style="height:3px;background:linear-gradient(90deg,#7c3aed,#2563eb,#059669);"></div>

      <!-- Header -->
      <div style="padding:22px 24px 0;display:flex;align-items:flex-start;justify-content:space-between;">
        <div style="display:flex;align-items:center;gap:12px;">
          <div style="width:42px;height:42px;border-radius:12px;
            background:linear-gradient(135deg,rgba(124,58,237,.25),rgba(37,99,235,.2));
            border:1px solid rgba(124,58,237,.3);
            display:flex;align-items:center;justify-content:center;flex-shrink:0;">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M2 7a2 2 0 012-2h12a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V7zm14 0H4v8h12V7zm-3 4a1 1 0 110 2 1 1 0 010-2z" fill="#a78bfa"/>
              <path d="M2 9h16" stroke="#a78bfa" stroke-width="1.3"/>
            </svg>
          </div>
          <div>
            <h2 style="color:#f1f5f9;font-size:18px;font-weight:800;letter-spacing:-.02em;margin:0;line-height:1.2;">Connect Your Wallet</h2>
            <p style="color:#4b5563;font-size:12px;margin:3px 0 0;line-height:1.3;">Choose a wallet to connect securely to ARC Network</p>
          </div>
        </div>
        <button onclick="closeWalletModal()" style="
          width:32px;height:32px;border-radius:8px;
          background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.06);
          color:#6b7280;cursor:pointer;display:flex;align-items:center;justify-content:center;
          transition:all .15s;flex-shrink:0;margin-top:2px;
          " onmouseover="this.style.background='rgba(255,255,255,.1)';this.style.color='#f1f5f9'"
          onmouseout="this.style.background='rgba(255,255,255,.05)';this.style.color='#6b7280'">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M10.5 3.5l-7 7M3.5 3.5l7 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </div>

      <!-- Network pill -->
      <div style="padding:12px 24px 0;">
        <div style="
          display:inline-flex;align-items:center;gap:8px;
          background:linear-gradient(90deg,rgba(88,28,135,.2),rgba(30,58,138,.15));
          border:1px solid rgba(124,58,237,.2);border-radius:999px;
          padding:5px 12px 5px 8px;">
          <span style="width:8px;height:8px;border-radius:50%;background:#a855f7;animation:wmPulse 2s infinite;display:inline-block;"></span>
          <span style="color:#c4b5fd;font-size:11px;font-weight:600;">Arc Testnet</span>
          <span style="color:#4b5563;font-size:10px;">·</span>
          <span style="color:#6b7280;font-size:10px;font-family:monospace;">Chain 5042002</span>
          <span style="color:#4b5563;font-size:10px;">·</span>
          <span style="color:#34d399;font-size:10px;font-weight:600;">~$0.009/tx</span>
        </div>
      </div>

      <!-- Scrollable content -->
      <div class="wm-scroll" id="wallet-providers-list" style="padding:16px 24px;max-height:460px;">

        ${providers.length > 0 ? `
          <!-- Detected section -->
          <div style="margin-bottom:6px;">
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#374151;margin-bottom:8px;display:flex;align-items:center;gap:6px;">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><circle cx="5" cy="5" r="4" stroke="#34d399" stroke-width="1.2"/><path d="M3 5l1.5 1.5L7 3.5" stroke="#34d399" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              Detected Wallets
            </div>
            <div style="display:flex;flex-direction:column;gap:7px;">
              ${providers.map((p, i) => _providerCard(p, i)).join('')}
            </div>
          </div>

          ${installWallets.length > 0 ? `
            <div class="wm-divider"><span>Other Wallets</span></div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
              ${installWallets.slice(0,6).map(w => _installCard(w)).join('')}
            </div>
          ` : ''}

        ` : `
          <!-- No wallet detected -->
          <div style="text-align:center;padding:8px 0 16px;">
            <div style="width:64px;height:64px;border-radius:50%;
              background:linear-gradient(135deg,rgba(124,58,237,.15),rgba(37,99,235,.1));
              border:1px solid rgba(124,58,237,.2);
              display:flex;align-items:center;justify-content:center;margin:0 auto 16px;">
              <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
                <path d="M4 11a2 2 0 012-2h16a2 2 0 012 2v10a2 2 0 01-2 2H6a2 2 0 01-2-2V11zm18 0H6v10h16V11zm-4 5a1 1 0 110 2 1 1 0 010-2z" fill="#a78bfa"/>
                <path d="M4 13h20" stroke="#a78bfa" stroke-width="1.3"/>
              </svg>
            </div>
            <p style="color:#e2e8f0;font-size:14px;font-weight:600;margin-bottom:4px;">No wallet detected</p>
            <p style="color:#4b5563;font-size:12px;margin-bottom:20px;">Install a wallet extension to get started</p>
          </div>

          <div style="display:flex;flex-direction:column;gap:6px;">
            ${WALLET_INSTALL_LIST.map(w => _installCard(w)).join('')}
          </div>
        `}
      </div>

      <!-- Create Wallet divider -->
      <div style="padding:0 24px 14px;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
          <div style="flex:1;height:1px;background:rgba(255,255,255,.07);"></div>
          <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#374151;">Don&apos;t have a wallet?</span>
          <div style="flex:1;height:1px;background:rgba(255,255,255,.07);"></div>
        </div>
        <button onclick="if(typeof openCreateWalletModal==='function'){openCreateWalletModal();}else{alert('Loading wallet creator…');}"
          style="
            display:flex;align-items:center;justify-content:center;gap:10px;
            width:100%;padding:12px 18px;border-radius:14px;
            background:linear-gradient(135deg,rgba(124,58,237,.15),rgba(79,70,229,.1));
            border:1px solid rgba(124,58,237,.3);
            color:#c4b5fd;font-size:14px;font-weight:700;cursor:pointer;
            transition:all .18s;letter-spacing:.01em;"
          onmouseover="this.style.background='linear-gradient(135deg,rgba(124,58,237,.3),rgba(79,70,229,.2))';this.style.borderColor='rgba(124,58,237,.6)'"
          onmouseout="this.style.background='linear-gradient(135deg,rgba(124,58,237,.15),rgba(79,70,229,.1))';this.style.borderColor='rgba(124,58,237,.3)'">
          <svg width="17" height="17" viewBox="0 0 17 17" fill="none">
            <rect x="1.5" y="4.5" width="14" height="10" rx="2" stroke="#a78bfa" stroke-width="1.4"/>
            <path d="M1.5 8h14" stroke="#a78bfa" stroke-width="1.4"/>
            <circle cx="12.5" cy="11.5" r="1.5" fill="#a78bfa"/>
            <path d="M5.5 2.5l3-1 3 1" stroke="#a78bfa" stroke-width="1.2" stroke-linecap="round"/>
          </svg>
          Create New Wallet
          <span style="font-size:10px;font-weight:600;background:rgba(124,58,237,.25);color:#a78bfa;border:1px solid rgba(124,58,237,.3);border-radius:6px;padding:2px 7px;">Non-custodial</span>
        </button>
      </div>

      <!-- Footer -->
      <div style="
        padding:14px 24px;
        border-top:1px solid rgba(255,255,255,.05);
        background:rgba(0,0,0,.2);
        display:flex;align-items:center;justify-content:center;gap:6px;">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="flex-shrink:0"><path d="M6 1a3 3 0 013 3v1h.5A1.5 1.5 0 0111 6.5v4A1.5 1.5 0 019.5 12h-7A1.5 1.5 0 011 10.5v-4A1.5 1.5 0 012.5 5H3V4a3 3 0 013-3zm0 1.5A1.5 1.5 0 004.5 4v1h3V4A1.5 1.5 0 006 2.5z" fill="#374151"/></svg>
        <span style="color:#374151;font-size:11px;">By connecting, you agree to the <a href="#" style="color:#4b5563;text-decoration:underline;" onclick="event.preventDefault()">Terms of Service</a></span>
      </div>
    </div>
  `;

  // Guardar providers para callback
  window._detectedProviders = providers;
  document.body.appendChild(modal);
}

// ============================================================
// MODAL QUANDO WALLET JÁ ESTÁ CONECTADA
// ============================================================
function openConnectedWalletModal() {
  const state = window.walletState;
  const addr  = state.address || '';
  const short = addr ? (addr.slice(0,8) + '…' + addr.slice(-6)) : '—';
  const onArc = !!state.onArcNetwork;
  const chainId = state.chainId || '—';
  const usdcBal = state.usdcBalance != null ? Number(state.usdcBalance).toFixed(4) : '—';

  // Detect wallet name/logo from last-used provider
  let lastKey = 'default';
  try {
    const _saved = JSON.parse(localStorage.getItem('arc_wallet_last') || '{}');
    if (_saved.logoKey) lastKey = _saved.logoKey;
  } catch(e) {}

  const WALLET_LOGOS_CONN = {
    metamask: `<svg viewBox="0 0 318 318" xmlns="http://www.w3.org/2000/svg" style="width:40px;height:40px;display:block;border-radius:10px;background:#1a1a1a;padding:2px;flex-shrink:0;">
      <polygon fill="#E17726" stroke="#E17726" stroke-width="1" points="274.1,35.5 174.6,109.4 193,65.8"/>
      <polygon fill="#E27625" stroke="#E27625" stroke-width="1" points="44.4,35.5 143.1,110.1 125.6,65.8"/>
      <polygon fill="#E27625" stroke="#E27625" stroke-width="1" points="238.3,206.8 211.8,247.4 268.5,263 284.8,207.7"/>
      <polygon fill="#E27625" stroke="#E27625" stroke-width="1" points="33.9,207.7 50.1,263 106.8,247.4 80.3,206.8"/>
      <polygon fill="#E27625" stroke="#E27625" stroke-width="1" points="103.6,138.2 87.8,162.1 144.1,164.6 142.1,104.1"/>
      <polygon fill="#E27625" stroke="#E27625" stroke-width="1" points="214.9,138.2 175.9,103.4 174.6,164.6 230.9,162.1"/>
      <polygon fill="#E27625" stroke="#E27625" stroke-width="1" points="106.8,247.4 140.6,230.9 111.4,208.1"/>
      <polygon fill="#E27625" stroke="#E27625" stroke-width="1" points="177.9,230.9 211.8,247.4 207.1,208.1"/>
      <polygon fill="#D5BFB2" stroke="#D5BFB2" stroke-width="1" points="211.8,247.4 177.9,230.9 180.7,253.5 180.4,262.3"/>
      <polygon fill="#D5BFB2" stroke="#D5BFB2" stroke-width="1" points="106.8,247.4 138.2,262.3 137.9,253.5 140.6,230.9"/>
      <polygon fill="#233447" stroke="#233447" stroke-width="1" points="138.8,193.5 110.6,185.2 130.5,176.1"/>
      <polygon fill="#233447" stroke="#233447" stroke-width="1" points="179.7,193.5 188,176.1 207.9,185.2"/>
      <polygon fill="#CC6228" stroke="#CC6228" stroke-width="1" points="106.8,247.4 111.6,206.8 80.3,207.7"/>
      <polygon fill="#CC6228" stroke="#CC6228" stroke-width="1" points="206.9,206.8 211.8,247.4 238.3,207.7"/>
      <polygon fill="#CC6228" stroke="#CC6228" stroke-width="1" points="230.9,162.1 174.6,164.6 179.7,193.5 188,176.1 207.9,185.2"/>
      <polygon fill="#CC6228" stroke="#CC6228" stroke-width="1" points="110.6,185.2 130.5,176.1 138.8,193.5 144.1,164.6 87.8,162.1"/>
      <polygon fill="#E27525" stroke="#E27525" stroke-width="1" points="87.8,162.1 138.8,193.5 111.4,208.1"/>
      <polygon fill="#E27525" stroke="#E27525" stroke-width="1" points="207.9,185.2 180.4,208.1 230.9,162.1"/>
      <polygon fill="#F5841F" stroke="#F5841F" stroke-width="1" points="179.7,193.5 172.2,232.6 177.9,230.9 207.9,185.2"/>
      <polygon fill="#F5841F" stroke="#F5841F" stroke-width="1" points="110.6,185.2 111.4,208.1 140.6,230.9 144.1,164.6"/>
      <polygon fill="#C0AC9D" stroke="#C0AC9D" stroke-width="1" points="180.4,262.3 180.7,253.5 178.1,251.2 140.4,251.2 137.9,253.5 138.2,262.3 106.8,247.4 117.8,256.4 140.1,271.9 178.4,271.9 200.8,256.4 211.8,247.4"/>
      <polygon fill="#763E1A" stroke="#763E1A" stroke-width="1" points="274.1,35.5 193,65.8 206.9,111.4 230.9,118.1 238.3,139.3 230.9,162.1 174.6,164.6 148,180.4 148,193.5 179.7,193.5 207.9,185.2 211.8,247.4 180.4,262.3 180.4,271.9 211.6,268.3 277.8,132.8"/>
      <polygon fill="#763E1A" stroke="#763E1A" stroke-width="1" points="44.4,35.5 40.7,132.8 106.8,268.3 138.2,271.9 138.2,262.3 106.8,247.4 80.3,206.8 87.8,162.1 80.3,139.3 87.8,118.1 111.4,111.4 125.6,65.8"/>
    </svg>`,
    rabby: `<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg" style="width:40px;height:40px;display:block;border-radius:10px;flex-shrink:0;">
      <rect width="128" height="128" rx="22" fill="#1A1A2E"/>
      <ellipse cx="46" cy="34" rx="10" ry="20" fill="#7084FF"/>
      <ellipse cx="82" cy="34" rx="10" ry="20" fill="#7084FF"/>
      <ellipse cx="46" cy="35" rx="6" ry="14" fill="#FFB3C6" opacity="0.75"/>
      <ellipse cx="82" cy="35" rx="6" ry="14" fill="#FFB3C6" opacity="0.75"/>
      <ellipse cx="64" cy="82" rx="32" ry="30" fill="#7084FF"/>
      <circle cx="52" cy="74" r="7" fill="white"/>
      <circle cx="76" cy="74" r="7" fill="white"/>
      <circle cx="53.5" cy="73" r="3.5" fill="#1A1A2E"/>
      <circle cx="77.5" cy="73" r="3.5" fill="#1A1A2E"/>
      <ellipse cx="64" cy="88" rx="9" ry="5.5" fill="#FFB3C6" opacity="0.85"/>
      <circle cx="64" cy="86" r="3" fill="#FF6B9D"/>
    </svg>`,
    phantom: `<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg" style="width:40px;height:40px;display:block;border-radius:10px;flex-shrink:0;">
      <defs><linearGradient id="ph2-bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#534BB1"/><stop offset="100%" stop-color="#551BF9"/></linearGradient></defs>
      <rect width="128" height="128" rx="22" fill="url(#ph2-bg)"/>
      <path d="M114 60.5c0-27.9-22.6-50.5-50.5-50.5C36.6 10 14 32.6 14 60.5c0 8.7 2.3 16.9 6.4 24 1.5 2.6 4.2 4.1 7.1 4.1H101c2.5 0 4.9-1.1 6.5-3C111.6 80.7 114 71 114 60.5z" fill="white"/>
      <ellipse cx="49" cy="61" rx="8" ry="11" fill="#534BB1"/>
      <ellipse cx="79" cy="61" rx="8" ry="11" fill="#534BB1"/>
      <circle cx="52" cy="58" r="3.5" fill="white"/>
      <circle cx="82" cy="58" r="3.5" fill="white"/>
      <path d="M27.5 95c0 4.2 3.4 7.5 7.5 7.5s7.5-3.3 7.5-7.5v-8h-15v8z" fill="white"/>
    </svg>`,
    coinbase: `<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg" style="width:40px;height:40px;display:block;border-radius:10px;flex-shrink:0;">
      <rect width="128" height="128" rx="22" fill="#0052FF"/>
      <circle cx="64" cy="64" r="44" fill="white"/>
      <path d="M64 28C44.1 28 28 44.1 28 64s16.1 36 36 36c13.7 0 25.7-7.7 31.8-19H79.6c-3.7 5.1-9.6 8.4-15.6 8.4C50.3 89.4 38.6 78 38.6 64S50.3 38.6 64 38.6c6 0 11.9 3.3 15.6 8.4h12.2C86.7 35.7 74.7 28 64 28z" fill="#0052FF"/>
    </svg>`,
    okx: `<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg" style="width:40px;height:40px;display:block;border-radius:10px;flex-shrink:0;">
      <rect width="128" height="128" rx="22" fill="#000"/>
      <rect x="26" y="26" width="30" height="30" rx="4" fill="white"/>
      <rect x="72" y="26" width="30" height="30" rx="4" fill="white"/>
      <rect x="26" y="72" width="30" height="30" rx="4" fill="white"/>
      <rect x="72" y="72" width="30" height="30" rx="4" fill="white"/>
    </svg>`,
    keplr: `<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg" style="width:40px;height:40px;display:block;border-radius:10px;flex-shrink:0;">
      <defs><linearGradient id="kp2-bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#1C1C2E"/><stop offset="100%" stop-color="#2A2A45"/></linearGradient><linearGradient id="kp2-k" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#6B7BF7"/><stop offset="100%" stop-color="#A855F7"/></linearGradient></defs>
      <rect width="128" height="128" rx="22" fill="url(#kp2-bg)"/>
      <path d="M32 24h22v32l28-32h26L72 64l36 40H82L54 72v32H32V24z" fill="url(#kp2-k)"/>
    </svg>`,
    brave: `<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg" style="width:40px;height:40px;display:block;border-radius:10px;flex-shrink:0;">
      <defs><linearGradient id="bv2" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#FF7654"/><stop offset="100%" stop-color="#FF3000"/></linearGradient></defs>
      <rect width="128" height="128" rx="22" fill="url(#bv2)"/>
      <path d="M64 12L100 28l-6 56-30 28-30-28-6-56L64 12z" fill="#FB5422"/>
      <circle cx="50" cy="54" r="6" fill="white"/>
      <circle cx="78" cy="54" r="6" fill="white"/>
      <path d="M50 70 Q64 80 78 70" stroke="white" stroke-width="4" fill="none" stroke-linecap="round"/>
    </svg>`,
    backpack: `<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg" style="width:40px;height:40px;display:block;border-radius:10px;flex-shrink:0;">
      <rect width="128" height="128" rx="22" fill="#E33E3F"/>
      <path d="M64 16c-14 0-25 11-25 25v4H26a8 8 0 00-8 8v44a8 8 0 008 8h76a8 8 0 008-8V53a8 8 0 00-8-8H89v-4c0-14-11-25-25-25zm0 12c7.2 0 13 5.8 13 13v4H51v-4c0-7.2 5.8-13 13-13zm0 38a8 8 0 100 16 8 8 0 000-16z" fill="white"/>
    </svg>`,
    default: `<svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:40px;height:40px;flex-shrink:0;">
      <rect width="40" height="40" rx="10" fill="#1e2d3d"/>
      <path d="M10 16a2 2 0 012-2h16a2 2 0 012 2v10a2 2 0 01-2 2H12a2 2 0 01-2-2V16zm18 0H12v10h16V16zm-3 5a1 1 0 110 2 1 1 0 010-2z" fill="#7b9cc0"/>
      <path d="M10 18h20" stroke="#7b9cc0" stroke-width="1.5"/>
    </svg>`,
  };

  const walletLogo = WALLET_LOGOS_CONN[lastKey] || WALLET_LOGOS_CONN.default;

  // Inject connected-modal styles once
  if (!document.getElementById('wm-conn-styles')) {
    const s = document.createElement('style');
    s.id = 'wm-conn-styles';
    s.textContent = `
      @keyframes wmcSlide { from{opacity:0;transform:translateY(20px) scale(.96)} to{opacity:1;transform:translateY(0) scale(1)} }
      @keyframes wmcFade  { from{opacity:0} to{opacity:1} }
      @keyframes wmcPulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.6;transform:scale(.95)} }
      .wmc-overlay { animation: wmcFade .2s ease; }
      .wmc-panel   { animation: wmcSlide .28s cubic-bezier(.22,.68,0,1.2); }
      .wmc-action {
        display:flex;align-items:center;gap:10px;
        padding:11px 14px;border-radius:12px;cursor:pointer;width:100%;
        background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.07);
        color:#d1d5db;font-size:13px;font-weight:500;text-decoration:none;
        transition:all .16s ease;
      }
      .wmc-action:hover { background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.14);transform:translateX(2px); }
      .wmc-action:active { transform:scale(.98); }
      .wmc-disconnect {
        display:flex;align-items:center;justify-content:center;gap:8px;
        padding:11px 14px;border-radius:12px;cursor:pointer;width:100%;
        background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.2);
        color:#f87171;font-size:13px;font-weight:600;
        transition:all .16s ease;
      }
      .wmc-disconnect:hover { background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.4); }
      .wmc-switch {
        display:flex;align-items:center;justify-content:center;gap:8px;
        padding:11px 14px;border-radius:12px;cursor:pointer;width:100%;
        background:linear-gradient(90deg,rgba(245,158,11,.15),rgba(217,119,6,.1));
        border:1px solid rgba(245,158,11,.25);
        color:#fbbf24;font-size:13px;font-weight:600;
        transition:all .16s ease;
      }
      .wmc-switch:hover { background:linear-gradient(90deg,rgba(245,158,11,.25),rgba(217,119,6,.18));border-color:rgba(245,158,11,.45); }
    `;
    document.head.appendChild(s);
  }

  const modal = document.createElement('div');
  modal.id = 'wallet-modal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';

  modal.innerHTML = `
    <!-- Overlay -->
    <div class="wmc-overlay" style="position:absolute;inset:0;background:rgba(0,0,0,.8);backdrop-filter:blur(14px);" onclick="closeWalletModal()"></div>

    <!-- Panel -->
    <div class="wmc-panel" style="
      position:relative;z-index:10;
      background:linear-gradient(160deg,#0d1a2a 0%,#080f1a 100%);
      border:1px solid rgba(255,255,255,.08);border-radius:22px;
      width:100%;max-width:380px;overflow:hidden;
      box-shadow:0 40px 100px rgba(0,0,0,.9),0 0 0 1px rgba(103,76,255,.06);
    ">
      <!-- Top accent bar -->
      <div style="height:3px;background:linear-gradient(90deg,#7c3aed,#2563eb,#059669);"></div>

      <!-- Header -->
      <div style="padding:20px 20px 0;display:flex;align-items:center;justify-content:space-between;">
        <div style="display:flex;align-items:center;gap:10px;">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M2 6a1.5 1.5 0 011.5-1.5h9A1.5 1.5 0 0114 6v6a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12V6zm12 0h-12v6h12V6zm-2.5 3a1 1 0 110 2 1 1 0 010-2z" fill="#a78bfa"/>
            <path d="M2 7.5h12" stroke="#a78bfa" stroke-width="1.2"/>
          </svg>
          <span style="color:#e2e8f0;font-size:15px;font-weight:700;letter-spacing:-.01em;">Wallet Connected</span>
        </div>
        <button onclick="closeWalletModal()" style="
          width:28px;height:28px;border-radius:8px;
          background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.06);
          color:#6b7280;cursor:pointer;display:flex;align-items:center;justify-content:center;
          transition:all .15s;
        " onmouseover="this.style.background='rgba(255,255,255,.1)';this.style.color='#f1f5f9'"
          onmouseout="this.style.background='rgba(255,255,255,.05)';this.style.color='#6b7280'">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M9 3L3 9M3 3l6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </div>

      <!-- Wallet identity card -->
      <div style="padding:16px 20px;">
        <div style="
          background:linear-gradient(135deg,rgba(124,58,237,.1),rgba(37,99,235,.08));
          border:1px solid rgba(124,58,237,.18);border-radius:16px;
          padding:16px;display:flex;align-items:center;gap:14px;
        ">
          <!-- Logo -->
          <div style="position:relative;flex-shrink:0;">
            ${walletLogo}
            <!-- Online dot -->
            <span style="
              position:absolute;bottom:2px;right:2px;
              width:10px;height:10px;border-radius:50%;
              background:#34d399;border:2px solid #080f1a;
              animation:wmcPulse 2.5s infinite;
            "></span>
          </div>
          <!-- Address info -->
          <div style="flex:1;min-width:0;">
            <div style="color:#94a3b8;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;margin-bottom:4px;">Connected Address</div>
            <div style="color:#f1f5f9;font-family:'Courier New',monospace;font-size:13px;font-weight:700;letter-spacing:.02em;">${short}</div>
            <div style="color:#4b5563;font-size:10px;font-family:monospace;margin-top:2px;word-break:break-all;line-height:1.4;">${addr}</div>
          </div>
          <!-- Copy button -->
          <button onclick="navigator.clipboard.writeText('${addr}').then(()=>{ this.innerHTML='<svg width=\\'14\\' height=\\'14\\' viewBox=\\'0 0 14 14\\' fill=\\'none\\'><path d=\\'M3 7l3 3 5-5\\' stroke=\\'#34d399\\' stroke-width=\\'1.8\\' stroke-linecap=\\'round\\' stroke-linejoin=\\'round\\'/></svg>'; setTimeout(()=>this.innerHTML='<svg width=\\'14\\' height=\\'14\\' viewBox=\\'0 0 14 14\\' fill=\\'none\\'><path d=\\'M2 4h8v8H2z\\' stroke=\\'#6b7280\\' stroke-width=\\'1.3\\' stroke-linejoin=\\'round\\'/><path d=\\'M4 4V2h8v8h-2\\' stroke=\\'#6b7280\\' stroke-width=\\'1.3\\' stroke-linejoin=\\'round\\'/></svg>',1500) })"
            style="width:28px;height:28px;border-radius:8px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.07);color:#6b7280;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .15s;"
            title="Copy address"
            onmouseover="this.style.background='rgba(255,255,255,.1)'" onmouseout="this.style.background='rgba(255,255,255,.05)'">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 4h8v8H2z" stroke="#6b7280" stroke-width="1.3" stroke-linejoin="round"/><path d="M4 4V2h8v8h-2" stroke="#6b7280" stroke-width="1.3" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </div>

      <!-- Stats row -->
      <div style="padding:0 20px 14px;display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <!-- Network status -->
        <div style="
          background:${onArc ? 'rgba(52,211,153,.07)' : 'rgba(251,191,36,.07)'};
          border:1px solid ${onArc ? 'rgba(52,211,153,.2)' : 'rgba(251,191,36,.2)'};
          border-radius:12px;padding:10px 12px;
        ">
          <div style="color:#6b7280;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;margin-bottom:4px;">Network</div>
          <div style="display:flex;align-items:center;gap:5px;">
            <span style="width:6px;height:6px;border-radius:50%;background:${onArc ? '#34d399' : '#fbbf24'};flex-shrink:0;"></span>
            <span style="color:${onArc ? '#34d399' : '#fbbf24'};font-size:11px;font-weight:700;">${onArc ? 'Arc Testnet' : 'Wrong Network'}</span>
          </div>
          <div style="color:#4b5563;font-size:9px;font-family:monospace;margin-top:2px;">Chain ${chainId}</div>
        </div>
        <!-- USDC Balance -->
        <div style="
          background:rgba(37,99,235,.07);border:1px solid rgba(37,99,235,.2);
          border-radius:12px;padding:10px 12px;
        ">
          <div style="color:#6b7280;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;margin-bottom:4px;">USDC Balance</div>
          <div style="color:#93c5fd;font-size:14px;font-weight:800;letter-spacing:-.02em;">${usdcBal}</div>
          <div style="color:#4b5563;font-size:9px;margin-top:2px;">on ARC Testnet</div>
        </div>
      </div>

      <!-- Actions -->
      <div style="padding:0 20px 16px;display:flex;flex-direction:column;gap:7px;">
        ${!onArc ? `
        <button class="wmc-switch" onclick="switchNetworkFromUI();closeWalletModal();">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 7h10M9 4l3 3-3 3M5 10L2 7l3-3" stroke="#fbbf24" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Switch to Arc Testnet
        </button>
        ` : ''}

        <a class="wmc-action" href="https://testnet.arcscan.app/address/${addr}" target="_blank" rel="noopener">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="color:#a78bfa"><path d="M5.5 2H2.5A.5.5 0 002 2.5v9a.5.5 0 00.5.5h9a.5.5 0 00.5-.5V8.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M8 2h4v4M12 2L6.5 7.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span style="flex:1;">View on ARC Explorer</span>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3 7l4-4M4 3h3v3" stroke="#4b5563" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </a>

        <button class="wmc-disconnect" onclick="disconnectWallet();closeWalletModal();">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5 7h6M9 5l2 2-2 2" stroke="#f87171" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 3V2.5A.5.5 0 007.5 2h-5a.5.5 0 00-.5.5v9a.5.5 0 00.5.5h5a.5.5 0 00.5-.5V11" stroke="#f87171" stroke-width="1.4" stroke-linecap="round"/></svg>
          Disconnect Wallet
        </button>
      </div>

      <!-- Privacy note -->
      <div style="
        padding:10px 20px 14px;
        border-top:1px solid rgba(255,255,255,.05);
        display:flex;align-items:center;justify-content:center;gap:5px;
      ">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style="flex-shrink:0"><path d="M5 1L1.5 2.5V5c0 2 1.6 3.6 3.5 4 1.9-.4 3.5-2 3.5-4V2.5L5 1z" fill="none" stroke="#374151" stroke-width="1.1" stroke-linejoin="round"/></svg>
        <span style="color:#374151;font-size:10px;">Secured by your wallet — no private keys stored</span>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
}

function closeWalletModal() {
  const modal = document.getElementById('wallet-modal');
  if (modal) modal.remove();
}

// ============================================================
// CONECTAR COM PROVEDOR ESPECÍFICO
// ============================================================
async function connectWithProvider(index) {
  const providers = window._detectedProviders || [];
  const selected = providers[index];
  if (!selected) {
    console.error('[WALLET] Provider não encontrado no índice:', index);
    return;
  }

  // Mostrar spinner no modal
  const modalList = document.getElementById('wallet-providers-list');
  if (modalList) {
    modalList.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 0;gap:12px;">
        <div style="width:48px;height:48px;border-radius:50%;border:4px solid #7c3aed;border-top-color:transparent;animation:spin 1s linear infinite;"></div>
        <p style="color:#d1d5db;font-size:0.875rem;">${t('wallet_connecting_with', selected.name)}</p>
        <p style="color:#6b7280;font-size:0.75rem;">${t('wallet_approve_connection')}</p>
      </div>
      <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
    `;
  }

  try {
    const provider = selected.provider;

    // Solicitar contas
    const accounts = await provider.request({ method: 'eth_requestAccounts' });

    if (!accounts || accounts.length === 0) {
      throw new Error(t('wallet_no_account'));
    }

    const address = accounts[0];

    // Obter chainId atual
    const chainIdHex = await provider.request({ method: 'eth_chainId' });
    const chainId = hexToDecimal(chainIdHex);
    const onArc = chainId === 5042002;

    // Atualizar estado global
    window.walletState = {
      connected: true,
      address,
      shortAddress: shortenAddress(address),
      chainId,
      onArcNetwork: onArc,
      usdcBalance: null,
      eurcBalance: null,
      provider,
    };

    // Fechar modal
    closeWalletModal();

    // Se não estiver na rede Arc, pedir para trocar
    if (!onArc) {
      showWalletToast('Wallet conectada! Adicionando Arc Testnet...', 'info');
      await new Promise(r => setTimeout(r, 800));
      const switched = await switchToArcTestnet(provider);
      if (switched) {
        window.walletState.chainId = 5042002;
        window.walletState.onArcNetwork = true;
      }
    }

    // Buscar saldo USDC se estiver na rede Arc
    if (window.walletState.onArcNetwork) {
      const balance = await fetchUSDCBalance(address, provider);
      window.walletState.usdcBalance = balance;
    }

    // Atualizar UI
    updateWalletUI();
    showWalletToast(`✅ ${selected.name} conectada! ${shortenAddress(address)}`, 'success');
    addWalletLog(`[WALLET] ${selected.name} conectada: ${address}`, 'success');

    // Salvar preferência no localStorage (com logoKey para o modal conectado)
    const _lk = _getWalletLogoKey ? _getWalletLogoKey(selected) : 'default';
    localStorage.setItem('arc_wallet_last', JSON.stringify({ name: selected.name, address, logoKey: _lk }));

    // Ouvir mudanças de conta/rede
    provider.on('accountsChanged', handleAccountsChanged);
    provider.on('chainChanged', handleChainChanged);
    provider.on('disconnect', handleDisconnect);

  } catch (err) {
    closeWalletModal();
    console.error('[WALLET] Erro ao conectar:', err);
    if (err.code === 4001) {
      showWalletToast(t('wallet_connection_refused'), 'warning');
    } else if (err.code === -32002) {
      showWalletToast(t('wallet_pending_request'), 'warning');
    } else {
      showWalletToast(t('wallet_connect_error', err.message || String(err)), 'error');
    }
    addWalletLog(`[WALLET] Erro ao conectar: ${err.message}`, 'error');
  }
}

// ============================================================
// HANDLERS DE EVENTOS DA WALLET
// ============================================================
function handleAccountsChanged(accounts) {
  if (!accounts || accounts.length === 0) {
    disconnectWallet();
    return;
  }
  const newAddress = accounts[0];
  window.walletState.address = newAddress;
  window.walletState.shortAddress = shortenAddress(newAddress);
  window.walletState.usdcBalance = null;

  updateWalletUI();
  showWalletToast(t('wallet_account_changed', shortenAddress(newAddress)), 'info');
  addWalletLog(`[WALLET] Conta trocada: ${newAddress}`, 'info');

  if (window.walletState.onArcNetwork) {
    fetchUSDCBalance(newAddress, window.walletState.provider).then(bal => {
      window.walletState.usdcBalance = bal;
      updateWalletUI();
    });
  }
}

function handleChainChanged(chainIdHex) {
  const chainId = hexToDecimal(chainIdHex);
  window.walletState.chainId = chainId;
  window.walletState.onArcNetwork = chainId === 5042002;

  updateWalletUI();

  if (window.walletState.onArcNetwork) {
    showWalletToast(t('wallet_connected_arc'), 'success');
    addWalletLog('[WALLET] Rede trocada para Arc Testnet (5042002)', 'success');
    fetchUSDCBalance(window.walletState.address, window.walletState.provider).then(bal => {
      window.walletState.usdcBalance = bal;
      updateWalletUI();
    });
  } else {
    showWalletToast(t('wallet_wrong_chain', chainId), 'warning');
    addWalletLog(`[WALLET] Rede incorreta: Chain ${chainId}`, 'warning');
  }
}

function handleDisconnect() {
  disconnectWallet();
}

// ============================================================
// DESCONECTAR WALLET
// ============================================================
function disconnectWallet() {
  const provider = window.walletState.provider;
  if (provider) {
    try {
      if (typeof provider.removeListener === 'function') {
        provider.removeListener('accountsChanged', handleAccountsChanged);
        provider.removeListener('chainChanged', handleChainChanged);
        provider.removeListener('disconnect', handleDisconnect);
      }
    } catch (_) {}
  }

  window.walletState = {
    connected: false,
    address: null,
    shortAddress: null,
    chainId: null,
    onArcNetwork: false,
    usdcBalance: null,
    eurcBalance: null,
    provider: null,
  };

  localStorage.removeItem('arc_wallet_last');
  updateWalletUI();
  showWalletToast('Wallet desconectada', 'info');
  addWalletLog('[WALLET] Desconectado', 'info');

  window.dispatchEvent(new CustomEvent('walletDisconnected'));
}

// ============================================================
// TOAST ESPECÍFICO DA WALLET
// ============================================================
function showWalletToast(message, type = 'info') {
  if (typeof showToast === 'function') {
    showToast(message, type);
  } else {
    // Fallback nativo
    console.log(`[WALLET ${type.toUpperCase()}] ${message}`);
    // Criar toast simples se showToast não estiver disponível ainda
    const existing = document.getElementById('wallet-toast-fallback');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.id = 'wallet-toast-fallback';
    const colors = { success: '#059669', error: '#dc2626', warning: '#d97706', info: '#2563eb' };
    toast.style.cssText = `position:fixed;top:80px;right:20px;z-index:99999;background:${colors[type] || colors.info};color:white;padding:12px 20px;border-radius:10px;font-size:14px;max-width:320px;box-shadow:0 4px 20px rgba(0,0,0,0.4);`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }
}

function addWalletLog(message, type = 'info') {
  if (typeof addLog === 'function') {
    addLog(message, type);
  }
}

// ============================================================
// AUTO-RECONECTAR SE TINHA SESSÃO ANTERIOR
// ============================================================
async function tryAutoReconnect() {
  const last = localStorage.getItem('arc_wallet_last');
  if (!last) return;
  if (!window.ethereum) return;

  try {
    const accounts = await window.ethereum.request({ method: 'eth_accounts' });
    if (accounts && accounts.length > 0) {
      let savedData;
      try { savedData = JSON.parse(last); } catch (_) { return; }

      if (accounts[0].toLowerCase() === savedData.address.toLowerCase()) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        const chainId = hexToDecimal(chainIdHex);

        window.walletState = {
          connected: true,
          address: accounts[0],
          shortAddress: shortenAddress(accounts[0]),
          chainId,
          onArcNetwork: chainId === 5042002,
          usdcBalance: null,
          eurcBalance: null,
          provider: window.ethereum,
        };

        if (typeof window.ethereum.on === 'function') {
          window.ethereum.on('accountsChanged', handleAccountsChanged);
          window.ethereum.on('chainChanged', handleChainChanged);
          window.ethereum.on('disconnect', handleDisconnect);
        }

        updateWalletUI();
        addWalletLog(`[WALLET] Reconectado automaticamente: ${accounts[0]}`, 'success');

        if (window.walletState.onArcNetwork) {
          const balance = await fetchUSDCBalance(accounts[0], window.ethereum);
          window.walletState.usdcBalance = balance;
          updateWalletUI();
        }
      }
    }
  } catch (e) {
    // Silencioso — auto-reconexão não é crítica
    console.warn('[WALLET] Auto-reconnect failed:', e.message);
  }
}

// ============================================================
// AUTO-REFRESH DE SALDO (polling)
// ============================================================
let _walletBalanceTimer = null;
const WALLET_BALANCE_INTERVAL = 30_000; // 30 segundos

function walletStartBalancePolling() {
  walletStopBalancePolling();
  _walletBalanceTimer = setInterval(async () => {
    const state = window.walletState;
    if (!state.connected || !state.provider || !state.onArcNetwork) return;
    try {
      const prev = state.usdcBalance;
      const bal  = await fetchUSDCBalance(state.address, state.provider);
      if (bal !== null) {
        state.usdcBalance = bal;
        // Atualizar indicadores de saldo sem rebuildar toda a UI
        const panelBal = document.getElementById('panel-balance');
        if (panelBal) panelBal.textContent = bal;
        const headerBal = document.getElementById('wallet-balance-display');
        if (headerBal) headerBal.textContent = `$${bal} USDC`;
        // Flash visual se saldo mudou
        if (prev !== null && prev !== bal) {
          [panelBal, headerBal].forEach(el => {
            if (!el) return;
            el.classList.add('text-green-400');
            setTimeout(() => el.classList.remove('text-green-400'), 1500);
          });
          addWalletLog(`[WALLET] Saldo atualizado: $${bal} USDC`, 'success');
        }
      }
    } catch (_) {}
  }, WALLET_BALANCE_INTERVAL);
}

function walletStopBalancePolling() {
  if (_walletBalanceTimer) { clearInterval(_walletBalanceTimer); _walletBalanceTimer = null; }
}

// Iniciar polling ao conectar, parar ao desconectar
window.addEventListener('walletConnected', () => walletStartBalancePolling());
window.addEventListener('walletDisconnected', () => walletStopBalancePolling());

// ============================================================
// INICIALIZAÇÃO
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  console.log('[WALLET] Módulo de wallet inicializado');
  console.log('[WALLET] USDC:', window.USDC_ADDRESS);
  console.log('[WALLET] EURC:', window.EURC_ADDRESS);
  console.log('[WALLET] Arc Testnet Chain ID: 5042002');

  // Tentar auto-reconectar após carregamento
  setTimeout(tryAutoReconnect, 800);

  // Expor funções globais
  window.openWalletModal          = openWalletModal;
  window.closeWalletModal         = closeWalletModal;
  window.connectWithProvider      = connectWithProvider;
  window.disconnectWallet         = disconnectWallet;
  window.switchNetworkFromUI      = switchNetworkFromUI;
  window.refreshBalance           = refreshBalance;
  window.copyAddress              = copyAddress;
  window.updateWalletUI           = updateWalletUI;
  window.switchToArcTestnet       = switchToArcTestnet;
  window.fetchUSDCBalance         = fetchUSDCBalance;
  window.walletStartBalancePolling = walletStartBalancePolling;
  window.walletStopBalancePolling  = walletStopBalancePolling;
});
