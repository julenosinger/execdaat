// ============================================================
// WALLET PROVIDER ABSTRACTION — ExecDaat
// Build: 20260407b
//
// Camada de abstração que garante o uso da carteira interna
// (non-custodial) como provider principal. Quando a carteira
// interna está desbloqueada, NENHUM popup de MetaMask/external
// é disparado — tudo é assinado internamente.
//
// Hierarquia de prioridade:
//   1. Carteira interna (wallet-create.js) — se desbloqueada
//   2. Carteira externa (window.ethereum / walletState.provider)
//
// API pública (window.*):
//   getActiveProvider()  → EIP-1193 provider (interno ou externo)
//   getActiveSigner()    → ethers.Signer (interno ou externo)
//   getActiveAddress()   → string hex endereço
//   getActiveWallet()    → { address, provider, signer, isInternal }
//   isInternalWalletActive() → boolean
// ============================================================

(function (global) {
  'use strict';

  const WP_VERSION = '20260407b';
  const WP_TAG     = '[WalletProvider]';

  function _log(...a)  { console.log(`%c${WP_TAG}`, 'color:#34d399;font-weight:bold', ...a); }
  function _warn(...a) { console.warn(WP_TAG, ...a); }
  function _err(...a)  { console.error(WP_TAG, ...a); }

  // ─── Verificar se carteira interna está ativa ─────────────────────────────────
  function isInternalWalletActive() {
    try {
      // wcIsUnlocked é exposto por wallet-create.js quando a carteira está desbloqueada
      if (typeof global.wcIsUnlocked === 'function') {
        return global.wcIsUnlocked();
      }
      // Fallback: checar sessionStorage
      const sess = sessionStorage.getItem('execdaat_wallet_session');
      if (sess) {
        const parsed = JSON.parse(sess);
        return !!(parsed && parsed.privateKey && parsed.address);
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  // ─── Obter provider EIP-1193 da carteira interna ─────────────────────────────
  function _getInternalProvider() {
    // O shim EIP-1193 é exposto por wallet-create.js como window._wcInternalProvider
    if (global._wcInternalProvider) return global._wcInternalProvider;

    // Alternativa: construir provider a partir do ethers.Wallet em sessão
    try {
      const sess = sessionStorage.getItem('execdaat_wallet_session');
      if (!sess) return null;
      const parsed = JSON.parse(sess);
      if (!parsed?.privateKey) return null;

      const ethers = global.ethers;
      if (!ethers) return null;

      const rpcProvider = new ethers.JsonRpcProvider(
        global.ARC_RPC || 'https://rpc.testnet.arc.network'
      );
      const wallet = new ethers.Wallet(parsed.privateKey, rpcProvider);

      // Construir shim EIP-1193 mínimo a partir do ethers.Wallet
      const shim = _buildEIP1193Shim(wallet, parsed.address);
      global._wcInternalProvider = shim;
      return shim;
    } catch (e) {
      _warn('Falha ao criar provider interno a partir de sessão:', e.message);
      return null;
    }
  }

  // ─── Construir shim EIP-1193 mínimo para ethers.Wallet ───────────────────────
  function _buildEIP1193Shim(wallet, address) {
    const rpcUrl = global.ARC_RPC || 'https://rpc.testnet.arc.network';

    return {
      _isInternalWallet: true,
      _address: address,
      _wallet: wallet,

      request: async function({ method, params = [] }) {
        _log(`[shim] ${method}`, params.length ? params[0] : '');

        switch (method) {

          case 'eth_accounts':
          case 'eth_requestAccounts':
            return [address];

          case 'eth_chainId':
            return global.ARC_CHAIN_HEX || '0x4cef52';

          case 'personal_sign': {
            const [msgHex, _from] = params;
            // personal_sign recebe hex da mensagem
            const msgBytes = ethers.getBytes ? ethers.getBytes(msgHex)
              : ethers.utils?.arrayify(msgHex);
            const sig = await wallet.signMessage(msgBytes);
            _log('[shim] personal_sign →', sig.slice(0, 20) + '…');
            return sig;
          }

          case 'eth_sign': {
            const [_from, msgHex] = params;
            const msgBytes = ethers.getBytes ? ethers.getBytes(msgHex)
              : ethers.utils?.arrayify(msgHex);
            return await wallet.signMessage(msgBytes);
          }

          case 'eth_signTypedData_v4': {
            const [_from, typedDataJson] = params;
            const td = typeof typedDataJson === 'string'
              ? JSON.parse(typedDataJson) : typedDataJson;
            // Remover EIP712Domain dos types (ethers v6 não aceita)
            const types = { ...td.types };
            delete types.EIP712Domain;
            const sig = await wallet.signTypedData(td.domain, types, td.message);
            _log('[shim] eth_signTypedData_v4 →', sig.slice(0, 20) + '…');
            return sig;
          }

          case 'eth_sendTransaction': {
            const [txParams] = params;
            _log('[shim] eth_sendTransaction →', txParams.to);
            const tx = await wallet.sendTransaction(txParams);
            _log('[shim] TX sent →', tx.hash);
            return tx.hash;
          }

          case 'eth_estimateGas': {
            const [txParams] = params;
            const gasEst = await wallet.provider.estimateGas(txParams);
            return '0x' + gasEst.toString(16);
          }

          case 'eth_getTransactionCount': {
            const [addr, tag] = params;
            const count = await wallet.provider.getTransactionCount(addr, tag || 'latest');
            return '0x' + count.toString(16);
          }

          case 'eth_gasPrice': {
            const feeData = await wallet.provider.getFeeData();
            const gp = feeData.gasPrice || 10000000000n;
            return '0x' + gp.toString(16);
          }

          case 'eth_getTransactionReceipt': {
            const [hash] = params;
            const receipt = await wallet.provider.getTransactionReceipt(hash);
            if (!receipt) return null;
            return {
              status: receipt.status === 1 ? '0x1' : '0x0',
              blockNumber: receipt.blockNumber,
              transactionHash: receipt.hash || hash,
              ...receipt,
            };
          }

          case 'eth_call': {
            const [callParams, block] = params;
            return await wallet.provider.call(callParams);
          }

          case 'wallet_switchEthereumChain': {
            // Carteira interna só suporta Arc Testnet
            const [{ chainId }] = params;
            const targetChain = parseInt(chainId, 16);
            const arcChain = global.ARC_CHAIN_ID || 5042002;
            if (targetChain !== arcChain) {
              _warn('[shim] Carteira interna só suporta Arc Testnet (', arcChain, ')');
              // Retornar null = sucesso (sem erro) para não quebrar o fluxo
              return null;
            }
            return null;
          }

          case 'wallet_addEthereumChain':
            // Ignorar silenciosamente — carteira interna já está na Arc Testnet
            return null;

          default: {
            // Delegar chamadas de leitura diretamente ao RPC
            const resp = await fetch(rpcUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0', id: 1, method, params
              }),
            });
            const data = await resp.json();
            if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
            return data.result;
          }
        }
      },

      // Compatibilidade com listeners (sem-op para carteira interna)
      on: function(event, handler) {
        _log('[shim] on(', event, ') registrado');
      },
      removeListener: function(event, handler) {},
      isMetaMask: false,
      _isWalletConnect: false,
    };
  }

  // ─── getActiveProvider ────────────────────────────────────────────────────────
  function getActiveProvider() {
    if (isInternalWalletActive()) {
      const internalProv = _getInternalProvider();
      if (internalProv) {
        _log('Usando carteira interna como provider ✓');
        return internalProv;
      }
    }

    // Fallback: provider externo do walletState
    const extProvider = global.walletState?.provider;
    if (extProvider) return extProvider;

    // Último fallback: window.ethereum
    if (global.ethereum) return global.ethereum;

    return null;
  }

  // ─── getActiveAddress ─────────────────────────────────────────────────────────
  function getActiveAddress() {
    if (isInternalWalletActive()) {
      // Tentar via shim primeiro
      const prov = _getInternalProvider();
      if (prov?._address) return prov._address;

      // Tentar via sessão
      try {
        const sess = sessionStorage.getItem('execdaat_wallet_session');
        if (sess) {
          const p = JSON.parse(sess);
          if (p?.address) return p.address;
        }
      } catch (_) {}
    }

    // Fallback externo
    return global.walletState?.address || null;
  }

  // ─── getActiveSigner ──────────────────────────────────────────────────────────
  async function getActiveSigner() {
    const ethers = global.ethers;
    if (!ethers) throw new Error('ethers.js não carregado');

    if (isInternalWalletActive()) {
      try {
        const sess = sessionStorage.getItem('execdaat_wallet_session');
        if (sess) {
          const p = JSON.parse(sess);
          if (p?.privateKey) {
            const rpcProvider = new ethers.JsonRpcProvider(
              global.ARC_RPC || 'https://rpc.testnet.arc.network'
            );
            const wallet = new ethers.Wallet(p.privateKey, rpcProvider);
            const addr = await wallet.getAddress();
            _log('Signer interno ativo:', addr);
            return wallet;
          }
        }
      } catch (e) {
        _warn('Falha ao criar signer interno:', e.message);
      }
    }

    // Fallback: BrowserProvider com provider externo
    const provider = getActiveProvider();
    if (!provider) throw new Error('Nenhum provider disponível — conecte uma carteira');
    const browserProvider = new ethers.BrowserProvider(provider, 'any');
    return await browserProvider.getSigner();
  }

  // ─── getActiveWallet ──────────────────────────────────────────────────────────
  async function getActiveWallet() {
    const address    = getActiveAddress();
    const isInternal = isInternalWalletActive();
    const provider   = getActiveProvider();
    let signer       = null;

    try {
      signer = await getActiveSigner();
    } catch (e) {
      _warn('getActiveWallet: falha ao obter signer:', e.message);
    }

    return { address, provider, signer, isInternal };
  }

  // ─── patchWalletState ─────────────────────────────────────────────────────────
  // Mantém window.walletState sincronizado quando carteira interna está ativa
  function _patchWalletState() {
    if (!isInternalWalletActive()) return;

    const addr = getActiveAddress();
    if (!addr) return;

    const prov = getActiveProvider();
    if (!prov) return;

    // Sincronizar walletState para que módulos que leem walletState.provider
    // recebam o provider interno automaticamente
    if (!global.walletState) global.walletState = {};

    const prev = global.walletState.provider;
    if (prev !== prov) {
      _log('Sincronizando walletState.provider com carteira interna');
      global.walletState.provider  = prov;
      global.walletState.address   = addr;
      global.walletState.connected = true;
      global.walletState.chainId   = global.ARC_CHAIN_ID || 5042002;
      global.walletState.onArcNetwork = true;
      const short = addr.slice(0, 8) + '…' + addr.slice(-6);
      global.walletState.shortAddress = short;
    }
  }

  // ─── Interceptar window.ethereum para bloquear popups externos ───────────────
  // Quando a carteira interna está ativa, não queremos que módulos chamem
  // window.ethereum.request para eth_requestAccounts nem eth_sendTransaction.
  // Fazemos isso sobrescrevendo window.ethereum com um proxy.
  function _installEthereumProxy() {
    if (global._wpProxyInstalled) return;

    const originalEthereum = global.ethereum;

    // Somente instalar proxy se há um ethereum externo detectado
    if (!originalEthereum) return;

    const proxy = new Proxy(originalEthereum, {
      get(target, prop) {
        if (prop === '_isInternalProxy') return true;
        if (prop === '_original') return target;

        if (prop === 'request') {
          return function({ method, params = [] }) {
            if (isInternalWalletActive()) {
              // Redirecionar para shim interno
              const intProv = _getInternalProvider();
              if (intProv) {
                _log(`[proxy] Redirecionando ${method} → carteira interna`);
                return intProv.request({ method, params });
              }
            }
            // Fallback para ethereum externo original
            return target.request.call(target, { method, params });
          };
        }

        const val = target[prop];
        return typeof val === 'function' ? val.bind(target) : val;
      },
    });

    try {
      // Sobrescrever window.ethereum com o proxy
      Object.defineProperty(global, 'ethereum', {
        get() { return proxy; },
        set(v) {
          // Permitir que carteiras externas atualizem, mas manter proxy se interna ativa
          if (!isInternalWalletActive()) {
            Object.defineProperty(global, 'ethereum', {
              value: v, writable: true, configurable: true,
            });
          }
        },
        configurable: true,
      });
      global._wpProxyInstalled = true;
      _log('Proxy ethereum instalado — carteira interna tem prioridade ✓');
    } catch (e) {
      _warn('Não foi possível instalar proxy ethereum:', e.message);
    }
  }

  // ─── Listener: walletUnlocked (carteira interna desbloqueada) ────────────────
  global.addEventListener('walletUnlocked', function (e) {
    const { address } = e.detail || {};
    _log('Evento walletUnlocked recebido:', address);
    _installEthereumProxy();
    _patchWalletState();
    _log('Carteira interna agora é o provider primário ✓');
    _log('Endereço ativo:', getActiveAddress());
  });

  // ─── Listener: walletConnected (externo) ──────────────────────────────────────
  global.addEventListener('walletConnected', function (e) {
    // Se carteira interna já está ativa, ignorar conexão externa
    if (isInternalWalletActive()) {
      _log('Carteira interna ativa — ignorando conexão de carteira externa');
      return;
    }
    _log('Carteira externa conectada:', e.detail?.address);
  });

  // ─── Init ─────────────────────────────────────────────────────────────────────
  function _init() {
    _log(`v${WP_VERSION} carregado`);

    // Se carteira interna já está ativa (sessão restaurada), configurar tudo
    if (isInternalWalletActive()) {
      _log('Sessão de carteira interna detectada no carregamento');
      _installEthereumProxy();
      _patchWalletState();
    }

    // Polling leve para sincronizar walletState quando sessão é restaurada
    // (wallet-create.js pode restaurar após este script carregar)
    let _syncAttempts = 0;
    const _syncInterval = setInterval(() => {
      _syncAttempts++;
      if (isInternalWalletActive()) {
        _patchWalletState();
        if (_syncAttempts > 2) clearInterval(_syncInterval); // após 3 syncs, parar
      }
      if (_syncAttempts > 30) clearInterval(_syncInterval); // timeout 15s
    }, 500);
  }

  // ─── Expor API pública ────────────────────────────────────────────────────────
  global.getActiveProvider        = getActiveProvider;
  global.getActiveSigner          = getActiveSigner;
  global.getActiveAddress         = getActiveAddress;
  global.getActiveWallet          = getActiveWallet;
  global.isInternalWalletActive   = isInternalWalletActive;
  global._wpPatchWalletState      = _patchWalletState;
  global._wpInstallProxy          = _installEthereumProxy;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }

})(window);
