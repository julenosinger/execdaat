// ============================================================
// ARC AI Agents - EVM Wallet Connection
// Suporta MetaMask, Coinbase Wallet, Rabby, e qualquer
// injetor EIP-1193 (window.ethereum)
// ============================================================

const ARC_TESTNET_PARAMS = {
  chainId: '0x4CFC12',          // 5042002 em hex
  chainName: 'Arc Testnet',
  nativeCurrency: {
    name: 'USDC',
    symbol: 'USDC',
    decimals: 6,
  },
  rpcUrls: ['https://rpc.testnet.arc.network'],
  blockExplorerUrls: ['https://testnet.arcscan.app'],
};

const USDC_ADDRESS = '0x3600000000000000000000000000000000000000';

// ABI mínimo ERC-20 para leitura de saldo
const ERC20_ABI = [
  {
    "inputs": [{"name": "owner", "type": "address"}],
    "name": "balanceOf",
    "outputs": [{"name": "", "type": "uint256"}],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "decimals",
    "outputs": [{"name": "", "type": "uint8"}],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "symbol",
    "outputs": [{"name": "", "type": "string"}],
    "stateMutability": "view",
    "type": "function"
  }
];

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
  provider: null,
};

// ============================================================
// DETECTAR PROVEDORES EIP-1193
// ============================================================
function detectProviders() {
  const providers = [];

  if (window.ethereum) {
    // MetaMask
    if (window.ethereum.isMetaMask) {
      providers.push({ name: 'MetaMask', icon: 'fab fa-ethereum', provider: window.ethereum });
    }
    // Coinbase Wallet
    if (window.ethereum.isCoinbaseWallet) {
      providers.push({ name: 'Coinbase Wallet', icon: 'fas fa-wallet', provider: window.ethereum });
    }
    // Rabby / outros
    if (!window.ethereum.isMetaMask && !window.ethereum.isCoinbaseWallet) {
      providers.push({ name: 'Browser Wallet', icon: 'fas fa-wallet', provider: window.ethereum });
    }

    // EIP-6963 múltiplos provedores
    if (window.ethereum.providers && Array.isArray(window.ethereum.providers)) {
      window.ethereum.providers.forEach(p => {
        if (p.isMetaMask) providers.push({ name: 'MetaMask', icon: 'fab fa-ethereum', provider: p });
        else if (p.isCoinbaseWallet) providers.push({ name: 'Coinbase Wallet', icon: 'fas fa-wallet', provider: p });
        else providers.push({ name: 'Wallet', icon: 'fas fa-wallet', provider: p });
      });
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
    // Codificar chamada balanceOf(address)
    const balanceOfSelector = '0x70a08231';
    const paddedAddress = address.slice(2).padStart(64, '0');
    const data = balanceOfSelector + paddedAddress;

    const result = await provider.request({
      method: 'eth_call',
      params: [{ to: USDC_ADDRESS, data }, 'latest'],
    });

    if (result && result !== '0x') {
      const balance = BigInt(result);
      // USDC tem 6 decimais
      const formatted = Number(balance) / 1e6;
      return formatted.toFixed(4);
    }
    return '0.0000';
  } catch (err) {
    console.warn('Erro ao buscar saldo USDC:', err);
    return null;
  }
}

// ============================================================
// ADICIONAR / TROCAR PARA ARC TESTNET
// ============================================================
async function switchToArcTestnet(provider) {
  try {
    // Tentar trocar para a rede Arc
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: ARC_TESTNET_PARAMS.chainId }],
    });
    return true;
  } catch (switchError) {
    // Código 4902 = rede não adicionada ainda
    if (switchError.code === 4902 || switchError.code === -32603) {
      try {
        await provider.request({
          method: 'wallet_addEthereumChain',
          params: [ARC_TESTNET_PARAMS],
        });
        return true;
      } catch (addError) {
        console.error('Erro ao adicionar rede Arc:', addError);
        showWalletToast('Erro ao adicionar Arc Testnet: ' + addError.message, 'error');
        return false;
      }
    }
    console.error('Erro ao trocar rede:', switchError);
    return false;
  }
}

// ============================================================
// ATUALIZAR UI DA WALLET
// ============================================================
function updateWalletUI() {
  const state = window.walletState;

  // Botão de conectar no header
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
    const addrEl = document.getElementById('wallet-address-display');
    if (addrEl) addrEl.textContent = state.shortAddress;

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

  // Preencher endereços nos forms
  autofillWalletAddress(state.address);

  // Atualizar painel lateral
  updateWalletPanel(true);

  // Dispatch evento para outros módulos
  window.dispatchEvent(new CustomEvent('walletConnected', { detail: state }));
}

// ============================================================
// PREENCHER ENDEREÇO DA WALLET NOS FORMULÁRIOS
// ============================================================
function autofillWalletAddress(address) {
  // Form de pagamento - campo "from"
  const payFrom = document.getElementById('pay-from');
  if (payFrom && (!payFrom.value || payFrom.dataset.autoFilled === 'true')) {
    payFrom.value = address;
    payFrom.dataset.autoFilled = 'true';
    payFrom.classList.add('border-purple-500/60');
  }

  // Form de contrato - campo "client"
  const ctClient = document.getElementById('ct-client');
  if (ctClient && (!ctClient.value || ctClient.dataset.autoFilled === 'true')) {
    ctClient.value = address;
    ctClient.dataset.autoFilled = 'true';
    ctClient.classList.add('border-green-500/60');
  }
}

// ============================================================
// PAINEL DA WALLET (aba Agents / Dashboard)
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
          <i class="fas fa-plug"></i>Conectar Wallet
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
          <i class="fas fa-search text-purple-400"></i>Ver no Explorer
        </a>
        <a href="https://faucet.circle.com" target="_blank"
           class="flex items-center justify-center gap-1.5 bg-gray-800/60 hover:bg-gray-700/60 rounded-lg p-2.5 text-xs text-gray-300 transition-colors">
          <i class="fas fa-faucet text-blue-400"></i>Faucet USDC
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
    showWalletToast('✅ Arc Testnet conectada!', 'success');
  }
}

// ============================================================
// MODAL DE SELEÇÃO DE WALLET
// ============================================================
function openWalletModal() {
  const existing = document.getElementById('wallet-modal');
  if (existing) existing.remove();

  const providers = detectProviders();

  const modal = document.createElement('div');
  modal.id = 'wallet-modal';
  modal.className = 'fixed inset-0 z-[100] flex items-center justify-center p-4';
  modal.innerHTML = `
    <div class="absolute inset-0 bg-black/70 backdrop-blur-sm" onclick="closeWalletModal()"></div>
    <div class="relative bg-gray-900 border border-gray-700/60 rounded-2xl p-6 w-full max-w-sm shadow-2xl z-10 animate-modal-in">
      <!-- Header do modal -->
      <div class="flex items-center justify-between mb-5">
        <div>
          <h3 class="text-white font-bold text-lg">Conectar Wallet</h3>
          <p class="text-gray-400 text-xs mt-0.5">Selecione seu provedor EVM</p>
        </div>
        <button onclick="closeWalletModal()" class="text-gray-500 hover:text-white transition-colors w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-800">
          <i class="fas fa-times"></i>
        </button>
      </div>

      <!-- Arc Network Info -->
      <div class="bg-gradient-to-r from-purple-900/40 to-blue-900/40 border border-purple-700/30 rounded-xl p-3 mb-5">
        <div class="flex items-center gap-2 mb-1.5">
          <div class="w-2 h-2 rounded-full bg-purple-400 animate-pulse"></div>
          <span class="text-purple-300 text-xs font-semibold">Arc Testnet</span>
        </div>
        <div class="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <div class="text-gray-500">Chain ID</div><div class="text-gray-300 font-mono">5042002</div>
          <div class="text-gray-500">Gas Token</div><div class="text-green-400 font-semibold">USDC</div>
          <div class="text-gray-500">Gas por TX</div><div class="text-gray-300">~$0.009</div>
        </div>
      </div>

      <!-- Lista de provedores -->
      <div class="space-y-2 mb-4" id="wallet-providers-list">
        ${providers.length > 0 ? providers.map((p, i) => `
          <button onclick="connectWithProvider(${i})" class="wallet-provider-btn w-full flex items-center gap-3 bg-gray-800/60 hover:bg-gray-700/60 border border-gray-700/40 hover:border-purple-600/50 rounded-xl p-3.5 transition-all group">
            <div class="w-10 h-10 rounded-xl bg-gray-700 group-hover:bg-purple-900/50 flex items-center justify-center transition-colors flex-shrink-0">
              <i class="${p.icon} text-xl text-purple-400"></i>
            </div>
            <div class="text-left flex-1">
              <div class="text-white font-medium text-sm">${p.name}</div>
              <div class="text-gray-500 text-xs">Detectado • Pronto para conectar</div>
            </div>
            <i class="fas fa-chevron-right text-gray-600 group-hover:text-purple-400 transition-colors"></i>
          </button>
        `).join('') : `
          <div class="text-center py-6">
            <div class="w-14 h-14 rounded-full bg-gray-800 flex items-center justify-center mx-auto mb-3">
              <i class="fas fa-exclamation-triangle text-yellow-400 text-xl"></i>
            </div>
            <p class="text-gray-300 text-sm font-medium mb-1">Nenhuma wallet detectada</p>
            <p class="text-gray-500 text-xs mb-4">Instale uma extensão de wallet EVM</p>
            <div class="flex flex-col gap-2">
              <a href="https://metamask.io/download/" target="_blank" class="flex items-center justify-center gap-2 bg-orange-600/20 hover:bg-orange-600/30 border border-orange-600/40 text-orange-400 rounded-lg p-3 text-sm transition-colors">
                <i class="fab fa-ethereum"></i>Instalar MetaMask
              </a>
              <a href="https://www.coinbase.com/wallet/downloads" target="_blank" class="flex items-center justify-center gap-2 bg-blue-600/20 hover:bg-blue-600/30 border border-blue-600/40 text-blue-400 rounded-lg p-3 text-sm transition-colors">
                <i class="fas fa-wallet"></i>Instalar Coinbase Wallet
              </a>
            </div>
          </div>
        `}
      </div>

      <!-- WalletConnect placeholder -->
      <button class="w-full flex items-center gap-3 bg-blue-900/20 hover:bg-blue-900/30 border border-blue-700/30 hover:border-blue-600/50 rounded-xl p-3.5 transition-all group opacity-70" 
              onclick="showWalletToast('WalletConnect em breve!', 'info'); closeWalletModal()">
        <div class="w-10 h-10 rounded-xl bg-blue-900/40 flex items-center justify-center flex-shrink-0">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M4.91 7.47C8.82 3.56 15.18 3.56 19.09 7.47L19.57 7.95C19.76 8.14 19.76 8.45 19.57 8.64L17.99 10.22C17.9 10.31 17.74 10.31 17.65 10.22L16.98 9.55C14.24 6.81 9.76 6.81 7.02 9.55L6.3 10.27C6.21 10.36 6.05 10.36 5.96 10.27L4.38 8.69C4.19 8.5 4.19 8.19 4.38 8L4.91 7.47ZM21.92 10.3L23.32 11.7C23.51 11.89 23.51 12.2 23.32 12.39L16.78 18.93C16.59 19.12 16.28 19.12 16.09 18.93L11.5 14.34C11.45 14.29 11.37 14.29 11.32 14.34L6.73 18.93C6.54 19.12 6.23 19.12 6.04 18.93L-0.5 12.4C-0.69 12.21 -0.69 11.9 -0.5 11.71L0.9 10.31C1.09 10.12 1.4 10.12 1.59 10.31L6.18 14.9C6.23 14.95 6.31 14.95 6.36 14.9L10.95 10.31C11.14 10.12 11.45 10.12 11.64 10.31L16.23 14.9C16.28 14.95 16.36 14.95 16.41 14.9L21 10.31C21.19 10.12 21.5 10.12 21.69 10.31L21.92 10.3Z" fill="#3B99FC"/>
          </svg>
        </div>
        <div class="text-left flex-1">
          <div class="text-white font-medium text-sm">WalletConnect</div>
          <div class="text-gray-500 text-xs">Mobile wallets • Em breve</div>
        </div>
        <span class="text-xs bg-blue-900/50 text-blue-400 px-2 py-0.5 rounded-full">Soon</span>
      </button>

      <p class="text-center text-xs text-gray-600 mt-4">
        Ao conectar, você aceita interagir com a Arc Testnet
      </p>
    </div>
  `;

  // Guardar providers para callback
  window._detectedProviders = providers;
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
  if (!selected) return;

  const modalList = document.getElementById('wallet-providers-list');
  if (modalList) {
    modalList.innerHTML = `
      <div class="flex flex-col items-center justify-center py-8 gap-3">
        <div class="w-12 h-12 rounded-full border-4 border-purple-500 border-t-transparent animate-spin"></div>
        <p class="text-gray-300 text-sm">Conectando com ${selected.name}...</p>
        <p class="text-gray-500 text-xs">Aprove a conexão na sua wallet</p>
      </div>
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

    // Atualizar estado
    window.walletState = {
      connected: true,
      address,
      shortAddress: shortenAddress(address),
      chainId,
      onArcNetwork: onArc,
      usdcBalance: null,
      provider,
    };

    // Fechar modal
    closeWalletModal();

    // Se não estiver na rede Arc, perguntar para trocar
    if (!onArc) {
      showWalletToast('Wallet conectada! Trocando para Arc Testnet...', 'info');
      await new Promise(r => setTimeout(r, 500));
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

    // Salvar preferência
    localStorage.setItem('arc_wallet_last', JSON.stringify({ name: selected.name, address }));

    // Ouvir mudanças de conta
    provider.on('accountsChanged', handleAccountsChanged);
    provider.on('chainChanged', handleChainChanged);
    provider.on('disconnect', handleDisconnect);

  } catch (err) {
    closeWalletModal();
    if (err.code === 4001) {
      showWalletToast('Conexão rejeitada pelo usuário', 'warning');
    } else {
      showWalletToast('Erro ao conectar: ' + (err.message || err), 'error');
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
      provider.removeListener('accountsChanged', handleAccountsChanged);
      provider.removeListener('chainChanged', handleChainChanged);
      provider.removeListener('disconnect', handleDisconnect);
    } catch (_) {}
  }

  window.walletState = {
    connected: false,
    address: null,
    shortAddress: null,
    chainId: null,
    onArcNetwork: false,
    usdcBalance: null,
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
  // Reutiliza a função principal de toast se disponível
  if (typeof showToast === 'function') {
    showToast(message, type);
  } else {
    console.log(`[WALLET TOAST ${type}] ${message}`);
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
    // Checar se ainda tem permissão (sem mostrar popup)
    const accounts = await window.ethereum.request({ method: 'eth_accounts' });
    if (accounts && accounts.length > 0) {
      const savedData = JSON.parse(last);
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
          provider: window.ethereum,
        };

        window.ethereum.on('accountsChanged', handleAccountsChanged);
        window.ethereum.on('chainChanged', handleChainChanged);
        window.ethereum.on('disconnect', handleDisconnect);

        updateWalletUI();
        addWalletLog(`[WALLET] Reconectado automaticamente: ${accounts[0]}`, 'success');

        if (window.walletState.onArcNetwork) {
          const balance = await fetchUSDCBalance(accounts[0], window.ethereum);
          window.walletState.usdcBalance = balance;
          updateWalletUI();
        }
      }
    }
  } catch (_) {
    // Silencioso
  }
}

// ============================================================
// INICIALIZAÇÃO
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  // Tentar auto-reconectar
  setTimeout(tryAutoReconnect, 500);
});
