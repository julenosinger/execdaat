// ============================================================
// ARC AI Agents - EVM Wallet Connection
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
  const seen = new Set();

  // 1. Provedores EIP-6963 (descoberta moderna)
  window._eip6963Providers.forEach(({ info, provider }) => {
    const key = info.rdns || info.uuid;
    if (!seen.has(key)) {
      seen.add(key);
      let icon = 'fas fa-wallet';
      if (info.rdns === 'io.metamask') icon = 'fab fa-ethereum';
      else if (info.rdns === 'com.coinbase.wallet') icon = 'fas fa-wallet';
      else if (info.rdns === 'io.rabby') icon = 'fas fa-shield-alt';
      else if (info.rdns === 'com.brave.wallet') icon = 'fas fa-shield-alt';
      providers.push({ name: info.name, icon, provider, rdns: info.rdns });
    }
  });

  // 2. Fallback: window.ethereum (EIP-1193 clássico)
  if (window.ethereum) {
    // Múltiplos provedores via window.ethereum.providers
    if (window.ethereum.providers && Array.isArray(window.ethereum.providers)) {
      window.ethereum.providers.forEach(p => {
        let name = 'Browser Wallet';
        let icon = 'fas fa-wallet';
        if (p.isMetaMask) { name = 'MetaMask'; icon = 'fab fa-ethereum'; }
        else if (p.isCoinbaseWallet) { name = 'Coinbase Wallet'; icon = 'fas fa-wallet'; }
        else if (p.isRabby) { name = 'Rabby'; icon = 'fas fa-shield-alt'; }
        else if (p.isBraveWallet) { name = 'Brave Wallet'; icon = 'fas fa-shield-alt'; }
        // Usar rdns como chave única se disponível
        const key = p.isMetaMask ? 'metamask' : (p.isCoinbaseWallet ? 'coinbase' : name.toLowerCase().replace(/\s/g,''));
        if (!seen.has(key)) {
          seen.add(key);
          providers.push({ name, icon, provider: p });
        }
      });
    } else {
      // Provedor único window.ethereum
      let name = 'Browser Wallet';
      let icon = 'fas fa-wallet';
      if (window.ethereum.isMetaMask) { name = 'MetaMask'; icon = 'fab fa-ethereum'; }
      else if (window.ethereum.isCoinbaseWallet) { name = 'Coinbase Wallet'; icon = 'fas fa-wallet'; }
      else if (window.ethereum.isRabby) { name = 'Rabby'; icon = 'fas fa-shield-alt'; }
      else if (window.ethereum.isBraveWallet) { name = 'Brave Wallet'; icon = 'fas fa-shield-alt'; }
      const key = name.toLowerCase().replace(/\s/g,'');
      if (!seen.has(key)) {
        seen.add(key);
        providers.push({ name, icon, provider: window.ethereum });
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
        showWalletToast('Erro ao adicionar Arc Testnet: ' + (addError.message || addError), 'error');
        return false;
      }
    }

    // ── 4. Usuário rejeitou ───────────────────────────────────────────────────
    if (switchError.code === 4001 ||
        switchError.message?.includes('User rejected') ||
        switchError.message?.includes('user denied')) {
      showWalletToast('Troca de rede cancelada pelo usuário', 'warning');
      return false;
    }

    console.error('[WALLET] Erro ao trocar rede:', switchError);
    showWalletToast('Erro ao trocar rede: ' + (switchError.message || switchError), 'error');
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
        <p class="text-gray-400 text-sm text-center">Conecte sua wallet EVM para interagir com a rede Arc Testnet</p>
        <button onclick="openWalletModal()" class="wallet-connect-pulse bg-purple-600 hover:bg-purple-700 text-white rounded-xl px-5 py-2.5 text-sm font-semibold transition-all flex items-center gap-2">
          <i class="fas fa-plug mr-1"></i>Conectar Wallet
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
        <button onclick="copyAddress()" title="Copiar endereço" class="text-gray-400 hover:text-white transition-colors flex-shrink-0">
          <i class="fas fa-copy text-sm"></i>
        </button>
      </div>

      <!-- Saldo USDC -->
      <div class="bg-gradient-to-r from-blue-900/40 to-purple-900/40 border border-blue-700/30 rounded-xl p-4">
        <div class="flex items-center justify-between mb-1">
          <span class="text-xs text-gray-400">Saldo USDC</span>
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
      showWalletToast('Endereço copiado!', 'success');
    }).catch(() => {
      // Fallback para browsers sem clipboard API
      const el = document.createElement('textarea');
      el.value = window.walletState.address;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      showWalletToast('Endereço copiado!', 'success');
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

function _renderWalletModal() {
  const providers = detectProviders();

  const modal = document.createElement('div');
  modal.id = 'wallet-modal';
  modal.className = 'fixed inset-0 z-[9999] flex items-center justify-center p-4';
  modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';
  modal.innerHTML = `
    <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" onclick="closeWalletModal()"></div>
    <div class="relative bg-gray-900 border border-gray-700/60 rounded-2xl p-6 w-full max-w-sm shadow-2xl z-10" style="position:relative;z-index:10;background:#111827;border:1px solid rgba(55,65,81,0.6);border-radius:1rem;padding:1.5rem;width:100%;max-width:400px;box-shadow:0 25px 50px rgba(0,0,0,0.8);">
      <!-- Header -->
      <div class="flex items-center justify-between mb-5">
        <div>
          <h3 class="text-white font-bold text-lg" style="color:white;font-weight:700;font-size:1.125rem;">Conectar Wallet</h3>
          <p class="text-gray-400 text-xs mt-0.5" style="color:#9ca3af;font-size:0.75rem;">Selecione seu provedor EVM</p>
        </div>
        <button onclick="closeWalletModal()" style="background:none;border:none;cursor:pointer;color:#9ca3af;padding:4px;" class="text-gray-500 hover:text-white transition-colors w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-800">
          <i class="fas fa-times"></i>
        </button>
      </div>

      <!-- Arc Network Info -->
      <div style="background:linear-gradient(to right,rgba(88,28,135,0.4),rgba(30,58,138,0.4));border:1px solid rgba(126,34,206,0.3);border-radius:0.75rem;padding:0.75rem;margin-bottom:1.25rem;">
        <div class="flex items-center gap-2 mb-2">
          <div style="width:8px;height:8px;border-radius:50%;background:#a855f7;animation:pulse 2s infinite;"></div>
          <span style="color:#d8b4fe;font-size:0.75rem;font-weight:600;">Arc Testnet</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 16px;font-size:0.75rem;">
          <span style="color:#6b7280;">Chain ID</span><span style="color:#d1d5db;font-family:monospace;">5042002</span>
          <span style="color:#6b7280;">RPC</span><span style="color:#d1d5db;font-family:monospace;font-size:10px;">rpc.testnet.arc.network</span>
          <span style="color:#6b7280;">WebSocket</span><span style="color:#d1d5db;font-family:monospace;font-size:10px;">wss://rpc.testnet.arc.network</span>
          <span style="color:#6b7280;">Gas Token</span><span style="color:#34d399;font-weight:600;">USDC</span>
          <span style="color:#6b7280;">Gas/TX</span><span style="color:#d1d5db;">~$0.009</span>
        </div>
      </div>

      <!-- Lista de provedores -->
      <div id="wallet-providers-list" style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px;">
        ${providers.length > 0 ? providers.map((p, i) => `
          <button onclick="connectWithProvider(${i})" 
            style="display:flex;align-items:center;gap:12px;background:rgba(31,41,55,0.6);border:1px solid rgba(55,65,81,0.4);border-radius:0.75rem;padding:14px;cursor:pointer;width:100%;text-align:left;transition:all 0.2s;"
            onmouseover="this.style.borderColor='rgba(147,51,234,0.5)';this.style.background='rgba(31,41,55,0.9)'"
            onmouseout="this.style.borderColor='rgba(55,65,81,0.4)';this.style.background='rgba(31,41,55,0.6)'">
            <div style="width:40px;height:40px;border-radius:10px;background:rgba(55,65,81,0.8);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
              <i class="${p.icon}" style="font-size:1.25rem;color:#a855f7;"></i>
            </div>
            <div style="flex:1;text-align:left;">
              <div style="color:white;font-weight:600;font-size:0.875rem;">${p.name}</div>
              <div style="color:#6b7280;font-size:0.75rem;">Detectado • Clique para conectar</div>
            </div>
            <i class="fas fa-chevron-right" style="color:#4b5563;"></i>
          </button>
        `).join('') : `
          <div style="text-align:center;padding:24px 0;">
            <div style="width:56px;height:56px;border-radius:50%;background:rgba(31,41,55,0.8);display:flex;align-items:center;justify-content:center;margin:0 auto 12px;">
              <i class="fas fa-exclamation-triangle" style="color:#fbbf24;font-size:1.25rem;"></i>
            </div>
            <p style="color:#d1d5db;font-size:0.875rem;font-weight:500;margin-bottom:4px;">Nenhuma wallet detectada</p>
            <p style="color:#6b7280;font-size:0.75rem;margin-bottom:16px;">Instale uma extensão de wallet EVM para continuar</p>
            <div style="display:flex;flex-direction:column;gap:8px;">
              <a href="https://metamask.io/download/" target="_blank" 
                style="display:flex;align-items:center;justify-content:center;gap:8px;background:rgba(234,88,12,0.2);border:1px solid rgba(234,88,12,0.4);color:#fb923c;border-radius:8px;padding:12px;font-size:0.875rem;text-decoration:none;transition:all 0.2s;">
                <i class="fab fa-ethereum"></i>Instalar MetaMask
              </a>
              <a href="https://www.coinbase.com/wallet/downloads" target="_blank"
                style="display:flex;align-items:center;justify-content:center;gap:8px;background:rgba(37,99,235,0.2);border:1px solid rgba(37,99,235,0.4);color:#60a5fa;border-radius:8px;padding:12px;font-size:0.875rem;text-decoration:none;transition:all 0.2s;">
                <i class="fas fa-wallet"></i>Instalar Coinbase Wallet
              </a>
              <a href="https://rabby.io" target="_blank"
                style="display:flex;align-items:center;justify-content:center;gap:8px;background:rgba(5,150,105,0.2);border:1px solid rgba(5,150,105,0.4);color:#34d399;border-radius:8px;padding:12px;font-size:0.875rem;text-decoration:none;transition:all 0.2s;">
                <i class="fas fa-shield-alt"></i>Instalar Rabby
              </a>
            </div>
          </div>
        `}
      </div>

      <p style="text-align:center;font-size:0.75rem;color:#4b5563;margin-top:8px;">
        Ao conectar você aceita interagir com a Arc Testnet (Chain 5042002)
      </p>
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
  const modal = document.createElement('div');
  modal.id = 'wallet-modal';
  modal.className = 'fixed inset-0 z-[9999] flex items-center justify-center p-4';
  modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';
  modal.innerHTML = `
    <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" onclick="closeWalletModal()"></div>
    <div style="position:relative;z-index:10;background:#111827;border:1px solid rgba(55,65,81,0.6);border-radius:1rem;padding:1.5rem;width:100%;max-width:360px;box-shadow:0 25px 50px rgba(0,0,0,0.8);">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h3 style="color:white;font-weight:700;">Wallet Conectada</h3>
        <button onclick="closeWalletModal()" style="background:none;border:none;cursor:pointer;color:#9ca3af;">
          <i class="fas fa-times"></i>
        </button>
      </div>
      <div style="background:rgba(31,41,55,0.6);border-radius:12px;padding:16px;margin-bottom:12px;">
        <div style="color:white;font-family:monospace;font-size:0.875rem;word-break:break-all;">${state.address}</div>
        <div style="color:${state.onArcNetwork ? '#34d399' : '#fbbf24'};font-size:0.75rem;margin-top:4px;">
          ${state.onArcNetwork ? '✅ Arc Testnet (5042002)' : '⚠️ Rede incorreta'}
        </div>
      </div>
      ${!state.onArcNetwork ? `
      <button onclick="switchNetworkFromUI();closeWalletModal();" 
        style="width:100%;background:rgba(217,119,6,0.8);border:none;border-radius:8px;padding:10px;color:white;cursor:pointer;margin-bottom:8px;font-weight:600;">
        <i class="fas fa-exchange-alt mr-1"></i>Trocar para Arc Testnet
      </button>
      ` : ''}
      <a href="https://testnet.arcscan.app/address/${state.address}" target="_blank"
        style="display:flex;align-items:center;justify-content:center;gap:8px;background:rgba(31,41,55,0.8);border:1px solid rgba(55,65,81,0.4);border-radius:8px;padding:10px;color:#d1d5db;font-size:0.875rem;text-decoration:none;margin-bottom:8px;">
        <i class="fas fa-external-link-alt" style="color:#a855f7;"></i>Ver no Explorer
      </a>
      <button onclick="disconnectWallet();closeWalletModal();" 
        style="width:100%;background:none;border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:10px;color:#f87171;cursor:pointer;font-size:0.875rem;">
        <i class="fas fa-sign-out-alt mr-1"></i>Desconectar
      </button>
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
        <p style="color:#d1d5db;font-size:0.875rem;">Conectando com ${selected.name}...</p>
        <p style="color:#6b7280;font-size:0.75rem;">Aprove a conexão na sua wallet</p>
      </div>
      <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
    `;
  }

  try {
    const provider = selected.provider;

    // Solicitar contas
    const accounts = await provider.request({ method: 'eth_requestAccounts' });

    if (!accounts || accounts.length === 0) {
      throw new Error('Nenhuma conta autorizada');
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

    // Salvar preferência no localStorage
    localStorage.setItem('arc_wallet_last', JSON.stringify({ name: selected.name, address }));

    // Ouvir mudanças de conta/rede
    provider.on('accountsChanged', handleAccountsChanged);
    provider.on('chainChanged', handleChainChanged);
    provider.on('disconnect', handleDisconnect);

  } catch (err) {
    closeWalletModal();
    console.error('[WALLET] Erro ao conectar:', err);
    if (err.code === 4001) {
      showWalletToast('❌ Conexão recusada pelo usuário', 'warning');
    } else if (err.code === -32002) {
      showWalletToast('⏳ Requisição já pendente na wallet. Verifique sua extensão.', 'warning');
    } else {
      showWalletToast('Erro ao conectar: ' + (err.message || String(err)), 'error');
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
  showWalletToast(`Conta trocada: ${shortenAddress(newAddress)}`, 'info');
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
    showWalletToast('✅ Conectado à Arc Testnet!', 'success');
    addWalletLog('[WALLET] Rede trocada para Arc Testnet (5042002)', 'success');
    fetchUSDCBalance(window.walletState.address, window.walletState.provider).then(bal => {
      window.walletState.usdcBalance = bal;
      updateWalletUI();
    });
  } else {
    showWalletToast(`⚠️ Rede trocada para Chain ${chainId}. Use Arc Testnet.`, 'warning');
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
