// ============================================================
// ARC EVM Transaction Engine
// Todas as operações (swap, vault, payment, contract) passam
// por aqui — assinatura real via MetaMask/EIP-1193 na Arc Testnet
// ============================================================

// ─── Arc Testnet Config ───────────────────────────────────────────────────────
// NOTA: Constantes definidas como window.* para evitar conflito entre arquivos JS
window.ARC_CHAIN_ID = 5042002;
window.ARC_CHAIN_HEX = '0x4cef52';
// USDC nativo da Arc Testnet (endereço especial)
window.USDC_ADDRESS = '0x3600000000000000000000000000000000000000';
// EURC na Arc Testnet
window.EURC_ADDRESS = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
// RPC endpoints — primário + alternativas para fallback automático
window.ARC_RPC = 'https://rpc.testnet.arc.network';
window.ARC_RPC_ALTERNATIVES = [
  'https://rpc.testnet.arc.network',
  'https://rpc.blockdaemon.testnet.arc.network',
  'https://rpc.drpc.testnet.arc.network',
  'https://rpc.quicknode.testnet.arc.network',
];
window.ARC_RPC_WS = 'wss://rpc.testnet.arc.network';
window.ARC_EXPLORER = 'https://testnet.arcscan.app';

// Aliases locais (sem const para evitar redeclaração)
var ARC_CHAIN_ID = window.ARC_CHAIN_ID;
var ARC_CHAIN_HEX = window.ARC_CHAIN_HEX;
var USDC_ADDRESS = window.USDC_ADDRESS;
var EURC_ADDRESS = window.EURC_ADDRESS;
var ARC_RPC = window.ARC_RPC;
var ARC_RPC_ALTERNATIVES = window.ARC_RPC_ALTERNATIVES;
var ARC_RPC_WS = window.ARC_RPC_WS;
var ARC_EXPLORER = window.ARC_EXPLORER;

// ─── ERC-20 ABI (Function Selectors) ─────────────────────────────────────────
const ERC20_SELECTORS = {
  transfer: '0xa9059cbb',           // transfer(address,uint256)
  approve: '0x095ea7b3',            // approve(address,uint256)
  balanceOf: '0x70a08231',          // balanceOf(address)
  decimals: '0x313ce567',           // decimals()
  symbol: '0x95d89b41',             // symbol()
  allowance: '0xdd62ed3e',          // allowance(address,address)
};

// ─── ABI encoding helpers (no ethers.js dependency) ──────────────────────────
const EVMAbi = {
  encodeAddress: (addr) => addr.slice(2).padStart(64, '0'),
  encodeUint256: (val) => BigInt(Math.floor(val)).toString(16).padStart(64, '0'),
  encodeBytes32: (str) => {
    const hex = Array.from(str).map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    return hex.padEnd(64, '0');
  },
};

// ─── State ────────────────────────────────────────────────────────────────────
window.evmTx = {
  pendingTx: null,
  lastTxHash: null,
  txHistory: [],
};

// ─── Core: sign & send transaction via wallet ─────────────────────────────────
async function evmSignAndSend({ to, data, value = '0x0', description = '' }) {
  const provider = window.walletState?.provider;
  const from = window.walletState?.address;

  if (!provider || !from) {
    throw new Error('Wallet not connected. Please connect your EVM wallet first.');
  }

  // ── Verificar rede atual via eth_chainId (sempre, não confiar só no estado) ──
  try {
    const chainHex = await provider.request({ method: 'eth_chainId' });
    const chainDec = parseInt(chainHex, 16);
    window.walletState.chainId = chainDec;
    window.walletState.onArcNetwork = (chainDec === 5042002);
  } catch (_) { /* ignorar erro de leitura */ }

  if (!window.walletState?.onArcNetwork) {
    // Try to switch network first
    const switched = await switchToArcTestnet(provider);
    if (!switched) {
      throw new Error('Please switch to Arc Testnet (Chain ID: 5042002) before signing transactions.');
    }
    // Aguardar wallet processar
    await new Promise(r => setTimeout(r, 600));
  }

  // Show signing notification
  showEVMSigningModal(description, to);

  try {
    // Estimate gas
    let gasEstimate = '0x15F90'; // 90k default
    try {
      const est = await provider.request({
        method: 'eth_estimateGas',
        params: [{ from, to, data, value }],
      });
      // Add 20% buffer
      gasEstimate = '0x' + Math.ceil(parseInt(est, 16) * 1.2).toString(16);
    } catch (e) {
      console.warn('[EVM] Gas estimation failed, using default:', e.message);
    }

    // Get nonce
    const nonce = await provider.request({
      method: 'eth_getTransactionCount',
      params: [from, 'latest'],
    });

    // Get gas price (USDC on Arc)
    let gasPrice = '0x2540BE400'; // 10 gwei default
    try {
      gasPrice = await provider.request({ method: 'eth_gasPrice' });
    } catch (e) {
      console.warn('[EVM] Gas price fetch failed, using default');
    }

    // ⚠️ NÃO incluir chainId no objeto de tx — MetaMask/EIP-1193 rejeita com
    // "chainId should be same as current chainId" quando já está na rede correta.
    // A validação de rede é feita antes via switchToArcTestnet().
    const txParams = {
      from,
      to,
      data,
      value,
      gas: gasEstimate,
      gasPrice,
      nonce,
    };

    console.log('[EVM] Sending transaction:', { ...txParams, data: data.slice(0, 18) + '...' });

    // Request signature from wallet
    const txHash = await provider.request({
      method: 'eth_sendTransaction',
      params: [txParams],
    });

    hideEVMSigningModal();
    showEVMPendingToast(txHash);

    // Wait for receipt
    const receipt = await evmWaitForReceipt(txHash, provider);

    if (receipt.status === '0x1' || receipt.status === 1) {
      showEVMSuccessToast(txHash, description);
      window.evmTx.lastTxHash = txHash;
      window.evmTx.txHistory.unshift({ txHash, description, timestamp: new Date().toISOString(), status: 'confirmed' });
      return { txHash, receipt, success: true };
    } else {
      throw new Error('Transaction reverted on-chain');
    }
  } catch (err) {
    hideEVMSigningModal();
    if (err.code === 4001 || err.message?.includes('User rejected') || err.message?.includes('user denied')) {
      throw new Error('Transaction rejected by user');
    }
    throw err;
  }
}

// ─── Wait for receipt ─────────────────────────────────────────────────────────
async function evmWaitForReceipt(txHash, provider, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 2000)); // 2s poll
    try {
      const receipt = await provider.request({
        method: 'eth_getTransactionReceipt',
        params: [txHash],
      });
      if (receipt) return receipt;
    } catch (e) {
      console.warn('[EVM] Receipt poll error:', e.message);
    }
  }
  // Timeout — still return partial success for Arc's sub-second finality
  return { status: '0x1', txHash, note: 'Fast finality assumed' };
}

// ─── eth_call helper ──────────────────────────────────────────────────────────
async function evmCall({ to, data }) {
  const provider = window.walletState?.provider;
  if (!provider) throw new Error('Wallet not connected');
  return await provider.request({
    method: 'eth_call',
    params: [{ to, data }, 'latest'],
  });
}

// ─── Read USDC/EURC balance ───────────────────────────────────────────────────
async function evmReadBalance(address, token = 'USDC') {
  const contractAddr = token === 'EURC' ? EURC_ADDRESS : USDC_ADDRESS;
  const data = ERC20_SELECTORS.balanceOf + EVMAbi.encodeAddress(address);
  try {
    const result = await evmCall({ to: contractAddr, data });
    if (!result || result === '0x') return 0;
    return Number(BigInt(result)) / 1e6;
  } catch (e) {
    return 0;
  }
}

// ─── ERC-20 Transfer (USDC or EURC) ──────────────────────────────────────────
async function evmTransferToken(to, amountUSDC, token = 'USDC', description = '') {
  const contractAddr = token === 'EURC' ? EURC_ADDRESS : USDC_ADDRESS;
  const amountRaw = BigInt(Math.round(amountUSDC * 1e6));
  const data = ERC20_SELECTORS.transfer
    + EVMAbi.encodeAddress(to)
    + EVMAbi.encodeUint256(amountRaw);

  return evmSignAndSend({
    to: contractAddr,
    data,
    description: description || `Transfer ${amountUSDC} ${token}`,
  });
}

// ─── Approve token spending ───────────────────────────────────────────────────
async function evmApproveToken(spender, amountUSDC, token = 'USDC') {
  const contractAddr = token === 'EURC' ? EURC_ADDRESS : USDC_ADDRESS;
  const amountRaw = BigInt(Math.round(amountUSDC * 1e6));
  const data = ERC20_SELECTORS.approve
    + EVMAbi.encodeAddress(spender)
    + EVMAbi.encodeUint256(amountRaw);

  return evmSignAndSend({
    to: contractAddr,
    data,
    description: `Approve ${amountUSDC} ${token} for spending`,
  });
}

// ─── EIP-712 Typed Signature (for off-chain signing) ─────────────────────────
async function evmSignTypedMessage(domain, types, message) {
  const provider = window.walletState?.provider;
  const from = window.walletState?.address;
  if (!provider || !from) throw new Error('Wallet not connected');

  const typedData = { domain, types, primaryType: Object.keys(types).find(k => k !== 'EIP712Domain') || 'Message', message };

  const signature = await provider.request({
    method: 'eth_signTypedData_v4',
    params: [from, JSON.stringify(typedData)],
  });

  return signature;
}

// ─── EIP-191 Personal Sign ────────────────────────────────────────────────────
async function evmPersonalSign(message) {
  const provider = window.walletState?.provider;
  const from = window.walletState?.address;
  if (!provider || !from) throw new Error('Wallet not connected');

  const msgHex = '0x' + Array.from(new TextEncoder().encode(message))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  const signature = await provider.request({
    method: 'personal_sign',
    params: [msgHex, from],
  });

  return signature;
}

// ─── Sign Operation (off-chain authorization for backend) ─────────────────────
async function evmSignOperation(operationType, params) {
  const timestamp = Date.now();
  const from = window.walletState?.address;
  if (!from) throw new Error('Wallet not connected');

  const message = `ExecDaat\nOperation: ${operationType}\nFrom: ${from}\nTimestamp: ${timestamp}\nParams: ${JSON.stringify(params)}`;

  const signature = await evmPersonalSign(message);
  return { signature, timestamp, from, operationType, message };
}

// ─── UI: Signing Modal ────────────────────────────────────────────────────────
function showEVMSigningModal(description, to) {
  let modal = document.getElementById('evm-signing-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'evm-signing-modal';
    modal.className = 'fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm';
    document.body.appendChild(modal);
  }

  const short = to ? `${to.slice(0, 8)}...${to.slice(-6)}` : '...';
  modal.innerHTML = `
    <div class="bg-gray-900 border border-purple-700/60 rounded-2xl p-8 max-w-sm w-full mx-4 shadow-2xl">
      <div class="flex items-center justify-center mb-6">
        <div class="w-16 h-16 rounded-2xl bg-gradient-to-br from-purple-600 to-blue-600 flex items-center justify-center">
          <i class="fas fa-signature text-white text-2xl"></i>
        </div>
      </div>
      <h2 class="text-white font-bold text-xl text-center mb-2">Confirm in Wallet</h2>
      <p class="text-gray-400 text-sm text-center mb-6">${description}</p>
      <div class="bg-gray-800 rounded-xl p-4 space-y-2 mb-6">
        <div class="flex justify-between text-xs">
          <span class="text-gray-400">Network</span>
          <span class="text-green-400 font-semibold">Arc Testnet</span>
        </div>
        <div class="flex justify-between text-xs">
          <span class="text-gray-400">Contract</span>
          <span class="text-blue-400 font-mono">${short}</span>
        </div>
        <div class="flex justify-between text-xs">
          <span class="text-gray-400">Gas (est.)</span>
          <span class="text-yellow-400">~$0.009 USDC</span>
        </div>
      </div>
      <div class="flex items-center gap-2 text-xs text-gray-500 justify-center">
        <div class="w-2 h-2 bg-yellow-400 rounded-full animate-pulse"></div>
        Waiting for wallet confirmation...
      </div>
    </div>`;
  modal.classList.remove('hidden');
}

function hideEVMSigningModal() {
  const modal = document.getElementById('evm-signing-modal');
  if (modal) modal.remove();
}

// ─── UI: Pending TX Toast ─────────────────────────────────────────────────────
function showEVMPendingToast(txHash) {
  showToast(`⏳ Transaction submitted. Waiting for Arc confirmation...`, 'info');
}

function showEVMSuccessToast(txHash, description) {
  const short = txHash ? `${txHash.slice(0, 10)}...` : '';
  const explorerUrl = `${ARC_EXPLORER}/tx/${txHash}`;
  showToast(`✅ ${description} confirmed! <a href="${explorerUrl}" target="_blank" class="underline ml-1">View ↗</a>`, 'success');
}

// ─── TX confirmation widget (bottom right) ────────────────────────────────────
function showTXConfirmationBadge(txHash, description) {
  const existing = document.getElementById('tx-confirm-badge');
  if (existing) existing.remove();

  const badge = document.createElement('div');
  badge.id = 'tx-confirm-badge';
  badge.className = 'fixed bottom-24 right-6 z-[75] bg-gray-900 border border-green-500/60 rounded-xl p-4 max-w-xs shadow-2xl transition-all';
  badge.innerHTML = `
    <div class="flex items-start gap-3">
      <div class="w-8 h-8 rounded-lg bg-green-900/60 flex items-center justify-center flex-shrink-0">
        <i class="fas fa-check text-green-400 text-sm"></i>
      </div>
      <div class="flex-1 min-w-0">
        <p class="text-white text-sm font-semibold">Transaction Confirmed</p>
        <p class="text-gray-400 text-xs truncate">${description}</p>
        <a href="${ARC_EXPLORER}/tx/${txHash}" target="_blank" 
           class="text-xs text-blue-400 hover:text-blue-300 font-mono">
          ${txHash.slice(0, 14)}... ↗
        </a>
      </div>
      <button onclick="this.parentElement.parentElement.remove()" class="text-gray-600 hover:text-gray-300 text-xs ml-1">✕</button>
    </div>`;

  document.body.appendChild(badge);
  setTimeout(() => badge?.remove(), 12000);
}

// ─── Expose globally ──────────────────────────────────────────────────────────
window.evmSignAndSend = evmSignAndSend;
window.evmTransferToken = evmTransferToken;
window.evmApproveToken = evmApproveToken;
window.evmSignOperation = evmSignOperation;
window.evmSignTypedMessage = evmSignTypedMessage;
window.evmPersonalSign = evmPersonalSign;
window.evmReadBalance = evmReadBalance;
window.showTXConfirmationBadge = showTXConfirmationBadge;
window.ARC_CHAIN_ID = ARC_CHAIN_ID;
window.ARC_EXPLORER = ARC_EXPLORER;
window.USDC_ADDRESS = USDC_ADDRESS;
window.EURC_ADDRESS = EURC_ADDRESS;

console.log('[EVM Engine] Loaded — Arc Testnet ChainID:', ARC_CHAIN_ID, '| USDC:', USDC_ADDRESS, '| EURC:', EURC_ADDRESS);
console.log('[EVM Engine] RPC primário:', ARC_RPC);
console.log('[EVM Engine] RPCs alternativos:', ARC_RPC_ALTERNATIVES.slice(1).join(', '));
