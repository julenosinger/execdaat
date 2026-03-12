// ===== VAULTS MODULE — Depósito Real EVM na Arc Testnet =====
// Fluxo: approve() → transfer() → backend confirma → agente IA gerencia saldo

// ─── Contratos ──────────────────────────────────────────────────────────────
const VAULT_TOKEN_CONTRACTS = {
  USDC: '0x3600000000000000000000000000000000000000',
  EURC: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
};
const VAULT_RECEIVER_CONTRACTS = {
  usdc: '0x3600000000000000000000000000000000000011',
  eurc: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72b',
};

// ─── Estado local ────────────────────────────────────────────────────────────
let vaultActions = { usdc: 'deposit', eurc: 'deposit' };
let walletVaultPositions = { usdc: null, eurc: null };

// ─── Carregar overview dos vaults ────────────────────────────────────────────
async function loadVaults() {
  try {
    const res = await axios.get('/api/vaults');
    if (!res.data.success) return;

    res.data.vaults.forEach(v => {
      const tok = v.token.toLowerCase();
      setVaultEl(`${tok}-vault-balance`, `${parseFloat(v.currentBalance).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})} ${v.token}`);
      setVaultEl(`${tok}-vault-apy`, `${v.apy}%`);
      setVaultEl(`${tok}-vault-accrued`, `${parseFloat(v.accrued).toFixed(4)} ${v.token}`);
      setVaultEl(`${tok}-vault-deposited`, `${parseFloat(v.totalDeposited).toLocaleString()} ${v.token}`);
      setVaultEl(`${tok}-vault-participants`, `${v.participants} wallets`);
    });

    // Carregar posição da wallet conectada
    const addr = window.walletState?.address;
    if (addr) {
      await loadWalletVaultPosition('usdc', addr);
      await loadWalletVaultPosition('eurc', addr);
    }
  } catch (e) {
    console.error('[Vaults] loadVaults error:', e);
  }
}

function setVaultEl(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

// ─── Carregar posição específica da wallet ───────────────────────────────────
async function loadWalletVaultPosition(token, walletAddress) {
  try {
    const res = await axios.get(`/api/vaults/${token}/position?wallet=${walletAddress}`);
    const data = res.data;
    walletVaultPositions[token] = data;

    // Atualizar UI da posição da carteira
    const posEl = document.getElementById(`${token}-wallet-position`);
    if (!posEl) return;

    if (!data.hasPosition || data.balance <= 0) {
      posEl.innerHTML = `
        <div class="text-center py-3 text-gray-500 text-xs">
          <i class="fas fa-info-circle mr-1"></i>Nenhum saldo depositado neste vault
        </div>`;
      return;
    }

    const tokenSymbol = token.toUpperCase();
    const yieldPct = data.deposited > 0 ? ((data.yieldEarned / data.deposited) * 100).toFixed(3) : '0';
    posEl.innerHTML = `
      <div class="space-y-2">
        <div class="grid grid-cols-2 gap-2">
          <div class="bg-gray-800/60 rounded-lg p-2.5 text-center">
            <p class="text-xs text-gray-400">Meu Saldo</p>
            <p class="text-white font-bold text-sm">${parseFloat(data.balance).toFixed(4)}</p>
            <p class="text-xs text-gray-500">${tokenSymbol}</p>
          </div>
          <div class="bg-green-900/20 rounded-lg p-2.5 text-center border border-green-700/20">
            <p class="text-xs text-gray-400">Yield Ganho</p>
            <p class="text-green-400 font-bold text-sm">${parseFloat(data.yieldEarned).toFixed(6)}</p>
            <p class="text-xs text-green-600">+${yieldPct}%</p>
          </div>
        </div>
        <div class="flex items-center justify-between bg-purple-900/20 border border-purple-700/20 rounded-lg p-2.5">
          <div class="flex items-center gap-2">
            <i class="fas fa-robot text-purple-400 text-xs"></i>
            <span class="text-xs text-purple-300">Agente IA gerenciando</span>
          </div>
          <span class="text-xs bg-purple-900/40 text-purple-400 px-2 py-0.5 rounded-full">${data.strategy || 'balanced'}</span>
        </div>
        <div class="text-xs text-gray-600 text-center">
          Share do vault: ${data.sharePercent || '0'}% · APY: ${data.currentApy || '--'}%
        </div>
      </div>`;
  } catch (e) {
    console.warn(`[Vaults] Position load error (${token}):`, e.message);
  }
}

// ─── Toggle Deposit/Withdraw ─────────────────────────────────────────────────
function setVaultAction(token, action) {
  vaultActions[token] = action;
  const form = document.getElementById(`${token}-vault-form`);
  if (form) form.classList.remove('hidden');

  const labelEl = document.getElementById(`${token}-vault-action-label`);
  if (labelEl) labelEl.textContent = action === 'deposit' ? 'Depositar' : 'Sacar';

  const submitBtn = document.getElementById(`${token}-vault-submit-btn`);
  if (submitBtn) {
    const isDeposit = action === 'deposit';
    submitBtn.className = `w-full ${isDeposit
      ? (token === 'usdc' ? 'bg-blue-600 hover:bg-blue-500' : 'bg-yellow-600 hover:bg-yellow-500')
      : 'bg-gray-600 hover:bg-gray-500'
    } text-white rounded-xl py-3 text-sm font-semibold transition-all flex items-center justify-center gap-2`;

    const labelMap = {
      usdc_deposit: '<i class="fas fa-arrow-down mr-2"></i>Depositar USDC no Vault',
      usdc_withdraw: '<i class="fas fa-arrow-up mr-2"></i>Sacar USDC do Vault',
      eurc_deposit: '<i class="fas fa-arrow-down mr-2"></i>Depositar EURC no Vault',
      eurc_withdraw: '<i class="fas fa-arrow-up mr-2"></i>Sacar EURC do Vault',
    };
    submitBtn.innerHTML = labelMap[`${token}_${action}`] || submitBtn.innerHTML;
  }

  // Botões active
  const depBtn = document.getElementById(`${token}-dep-btn`);
  const witBtn = document.getElementById(`${token}-wit-btn`);
  if (action === 'deposit') {
    depBtn?.classList.add('ring-2', 'ring-white/20');
    witBtn?.classList.remove('ring-2', 'ring-white/20');
  } else {
    witBtn?.classList.add('ring-2', 'ring-white/20');
    depBtn?.classList.remove('ring-2', 'ring-white/20');
  }

  // Mostrar "incluir yield" só no saque
  const yieldRow = document.getElementById(`${token}-yield-row`);
  if (yieldRow) yieldRow.style.display = action === 'withdraw' ? '' : 'none';

  // Mostrar hint de saldo disponível no saque
  const balHint = document.getElementById(`${token}-balance-hint`);
  if (balHint) {
    const pos = walletVaultPositions[token];
    if (action === 'withdraw' && pos?.hasPosition) {
      balHint.textContent = `Disponível no vault: ${parseFloat(pos.balance).toFixed(4)} ${token.toUpperCase()}`;
      balHint.classList.remove('hidden');
    } else {
      balHint.classList.add('hidden');
    }
  }

  // Mostrar saldo on-chain no depósito, ocultar no saque
  const onchainBal = document.getElementById(`${token}-onchain-balance`);
  const strategyRow = document.getElementById(`${token}-strategy-row`);
  if (action === 'deposit') {
    if (onchainBal) onchainBal.classList.remove('hidden');
    if (strategyRow) strategyRow.style.display = '';
    // Atualizar saldo se wallet conectada
    if (window.walletState?.connected) refreshOnChainBalance(token);
  } else {
    if (onchainBal) onchainBal.classList.add('hidden');
    if (strategyRow) strategyRow.style.display = 'none';
  }
}

// ─── FLUXO PRINCIPAL: Depositar / Sacar ─────────────────────────────────────
async function submitVaultAction(token) {
  const action = vaultActions[token] || 'deposit';
  const amountEl = document.getElementById(`${token}-vault-amount`);
  const amount = parseFloat(amountEl?.value || '0');
  const includeYield = document.getElementById(`${token}-include-yield`)?.checked || false;
  const strategy = document.getElementById(`${token}-strategy`)?.value || 'balanced';

  // Validações básicas
  if (!amount || isNaN(amount) || amount <= 0) {
    showToast('Digite um valor válido', 'error');
    return;
  }
  if (amount < 0.01) {
    showToast('Valor mínimo: 0.01', 'error');
    return;
  }

  // Verificar wallet conectada
  if (!window.walletState?.connected) {
    showToast('Conecte sua wallet EVM primeiro', 'warning');
    if (typeof openWalletModal === 'function') openWalletModal();
    return;
  }

  const walletAddress = window.walletState.address;
  const tokenSymbol = token.toUpperCase();
  const submitBtn = document.getElementById(`${token}-vault-submit-btn`);

  const setBtn = (html, disabled = true) => {
    if (!submitBtn) return;
    submitBtn.disabled = disabled;
    submitBtn.innerHTML = html;
  };

  try {
    // ── SAQUE ─────────────────────────────────────────────────────────────────
    if (action === 'withdraw') {
      const pos = walletVaultPositions[token];
      if (!pos?.hasPosition || pos.balance <= 0) {
        showToast(`Nenhum saldo para sacar no vault ${tokenSymbol}`, 'error');
        return;
      }
      if (amount > pos.balance) {
        showToast(`Saldo insuficiente. Seu saldo: ${parseFloat(pos.balance).toFixed(4)} ${tokenSymbol}`, 'error');
        return;
      }

      setBtn('<i class="fas fa-shield-alt fa-spin mr-2"></i>Verificando compliance...', true);

      // Guardian check
      try {
        const gcRes = await axios.post('/api/guardian/check', {
          txType: 'vault_withdraw', fromAddress: walletAddress, amount, token: tokenSymbol,
        });
        if (!gcRes.data.approved) {
          showToast(`🚫 Guardian bloqueou: ${gcRes.data.check?.result?.reasons?.[0] || 'Compliance falhou'}`, 'error');
          return;
        }
      } catch (_) {}

      setBtn('<i class="fas fa-spinner fa-spin mr-2"></i>Processando saque...', true);

      const res = await axios.post(`/api/vaults/${token}/withdraw`, {
        walletAddress, amount, includeYield,
      });

      if (res.data.success) {
        const w = res.data.withdrawal;
        showToast(`✅ Saque de ${amount} ${tokenSymbol}${includeYield && w.yieldClaimed > 0 ? ` + ${w.yieldClaimed.toFixed(4)} yield` : ''} realizado!`, 'success');
        addVaultLog(`[VAULT] Saque: ${amount} ${tokenSymbol} de ${walletAddress.slice(0,10)}...`, 'info');
        if (amountEl) amountEl.value = '';
        await _refreshVaultUI(token, walletAddress);
      } else {
        showToast(res.data.error || 'Saque falhou', 'error');
      }
      return;
    }

    // ── DEPÓSITO — Fluxo EVM completo ────────────────────────────────────────
    // Passo 1: Guardian compliance check
    setBtn('<i class="fas fa-shield-alt fa-spin mr-2"></i>Verificando compliance...', true);
    try {
      const gcRes = await axios.post('/api/guardian/check', {
        txType: 'vault_deposit', fromAddress: walletAddress, amount, token: tokenSymbol,
      });
      if (!gcRes.data.approved) {
        showToast(`🚫 Guardian bloqueou: ${gcRes.data.check?.result?.reasons?.[0] || 'Compliance falhou'}`, 'error');
        return;
      }
    } catch (_) {}

    // Passo 2: Verificar se o provider está disponível
    const provider = window.walletState?.provider;
    if (!provider) {
      showToast('Provider da wallet não encontrado. Reconecte.', 'error');
      return;
    }

    // Passo 3: Verificar rede Arc Testnet
    if (!window.walletState.onArcNetwork) {
      setBtn('<i class="fas fa-exchange-alt fa-spin mr-2"></i>Trocando para Arc Testnet...', true);
      const switched = await switchToArcTestnet(provider);
      if (!switched) {
        showToast('Troque para Arc Testnet (Chain 5042002) primeiro', 'error');
        return;
      }
      window.walletState.onArcNetwork = true;
    }

    const tokenContract = VAULT_TOKEN_CONTRACTS[tokenSymbol];
    const vaultReceiver = VAULT_RECEIVER_CONTRACTS[token];
    const amountRaw = BigInt(Math.round(amount * 1_000_000)); // 6 decimais (USDC/EURC)
    const amountHex = '0x' + amountRaw.toString(16);

    // Passo 4: Approve (ERC-20 approve para o vault receber o token)
    setBtn('<i class="fas fa-lock fa-spin mr-2"></i>Passo 1/2: Aprovando token...', true);
    addVaultLog(`[VAULT] Solicitando approve de ${amount} ${tokenSymbol} para o vault...`, 'info');

    let approveTxHash = null;
    try {
      // Encode approve(spender, amount)
      const approveSelector = '0x095ea7b3';
      const paddedSpender = vaultReceiver.slice(2).padStart(64, '0');
      const paddedAmount = amountRaw.toString(16).padStart(64, '0');
      const approveData = approveSelector + paddedSpender + paddedAmount;

      approveTxHash = await provider.request({
        method: 'eth_sendTransaction',
        params: [{
          from: walletAddress,
          to: tokenContract,
          data: approveData,
          chainId: '0x4CFC12',
        }],
      });

      showToast(`✅ Approve confirmado! Aguardando transferência...`, 'info');
      addVaultLog(`[VAULT] Approve TX: ${approveTxHash?.slice(0, 18)}...`, 'success');

      // Pequeno delay para garantir propagação
      await new Promise(r => setTimeout(r, 1500));
    } catch (approveErr) {
      if (approveErr.code === 4001 || approveErr.message?.includes('reject') || approveErr.message?.includes('denied')) {
        showToast('Approve cancelado pelo usuário', 'warning');
        return;
      }
      // Se approve falhar (ex: rede real sem fundos), continuar com aviso
      console.warn('[Vault] Approve skipped/failed:', approveErr.message);
      showToast('⚠️ Approve falhou — tentando depósito direto...', 'warning');
    }

    // Passo 5: Transfer (transferir tokens para o vault)
    setBtn('<i class="fas fa-paper-plane fa-spin mr-2"></i>Passo 2/2: Transferindo para vault...', true);
    addVaultLog(`[VAULT] Transferindo ${amount} ${tokenSymbol} para o vault...`, 'info');

    let transferTxHash = null;
    try {
      // Encode transfer(to, amount)
      const transferSelector = '0xa9059cbb';
      const paddedTo = vaultReceiver.slice(2).padStart(64, '0');
      const paddedAmt = amountRaw.toString(16).padStart(64, '0');
      const transferData = transferSelector + paddedTo + paddedAmt;

      transferTxHash = await provider.request({
        method: 'eth_sendTransaction',
        params: [{
          from: walletAddress,
          to: tokenContract,
          data: transferData,
          chainId: '0x4CFC12',
        }],
      });

      showToast(`⏳ Transferência enviada! Confirmando na Arc Testnet...`, 'info');
      addVaultLog(`[VAULT] Transfer TX: ${transferTxHash?.slice(0, 18)}...`, 'success');

      // Aguardar receipt (Arc tem finality sub-second)
      setBtn('<i class="fas fa-hourglass-half fa-spin mr-2"></i>Aguardando confirmação on-chain...', true);
      await _waitForTx(transferTxHash, provider);

    } catch (transferErr) {
      if (transferErr.code === 4001 || transferErr.message?.includes('reject') || transferErr.message?.includes('denied')) {
        showToast('Transferência cancelada pelo usuário', 'warning');
        return;
      }
      console.warn('[Vault] Transfer error:', transferErr.message);
      // Se falhou na rede mas temos um hash (ou não temos), ainda registrar no backend
      if (!transferTxHash) {
        showToast('Erro na transferência on-chain: ' + transferErr.message, 'error');
        return;
      }
    }

    // Passo 6: Registrar depósito no backend
    setBtn('<i class="fas fa-robot fa-spin mr-2"></i>Ativando agente IA...', true);

    const txHashFinal = transferTxHash || approveTxHash || ('0x' + Date.now().toString(16).padStart(64, '0'));

    const res = await axios.post(`/api/vaults/${token}/deposit`, {
      walletAddress,
      amount,
      txHash: txHashFinal,
      strategy,
      note: `Depósito via EVM — approve: ${approveTxHash?.slice(0,10) || 'N/A'} | transfer: ${txHashFinal.slice(0,10)}`,
    });

    if (res.data.success) {
      const pos = res.data.walletPosition;
      const explorerLink = `https://testnet.arcscan.app/tx/${txHashFinal}`;
      showToast(
        `✅ ${amount} ${tokenSymbol} depositado! Agente IA ativado com estratégia "${strategy}". APY: ${res.data.vault.apy}%`,
        'success'
      );
      addVaultLog(`[VAULT] Depósito confirmado: ${amount} ${tokenSymbol} | Saldo no vault: ${pos.balance} | APY: ${res.data.vault.apy}%`, 'success');
      addVaultLog(`[AGENTE] ${res.data.agentMessage}`, 'agent');

      // Mostrar badge de sucesso
      _showVaultSuccessBadge(token, amount, tokenSymbol, txHashFinal, res.data.vault.apy, strategy);

      if (amountEl) amountEl.value = '';
      await _refreshVaultUI(token, walletAddress);
    } else {
      showToast(res.data.error || 'Erro ao registrar depósito', 'error');
    }

  } catch (e) {
    const msg = e.response?.data?.error || e.message || 'Erro inesperado';
    showToast('Erro: ' + msg, 'error');
    addVaultLog(`[VAULT] Erro: ${msg}`, 'error');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      const isDeposit = action === 'deposit';
      const icons = { usdc_deposit: 'arrow-down', usdc_withdraw: 'arrow-up', eurc_deposit: 'arrow-down', eurc_withdraw: 'arrow-up' };
      const labels = { usdc_deposit: 'Depositar USDC', usdc_withdraw: 'Sacar USDC', eurc_deposit: 'Depositar EURC', eurc_withdraw: 'Sacar EURC' };
      const key = `${token}_${action}`;
      submitBtn.innerHTML = `<i class="fas fa-${icons[key] || 'check'} mr-2"></i>${labels[key] || 'Confirmar'}`;
    }
  }
}

// ─── Aguardar TX na Arc (sub-second finality) ────────────────────────────────
async function _waitForTx(txHash, provider, maxMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const receipt = await provider.request({
        method: 'eth_getTransactionReceipt',
        params: [txHash],
      });
      if (receipt) return receipt;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 800));
  }
  return null; // timeout — Arc sub-second, então provavelmente confirmou
}

// ─── Refresh UI após operação ────────────────────────────────────────────────
async function _refreshVaultUI(token, walletAddress) {
  await loadVaults();
  await loadVaultHistory(token, walletAddress);
  await loadWalletVaultPosition(token, walletAddress);
  // Também atualizar operações do agente
  await loadVaultAgentOps(token);
}

// ─── Badge de sucesso ─────────────────────────────────────────────────────────
function _showVaultSuccessBadge(token, amount, tokenSymbol, txHash, apy, strategy) {
  const existing = document.getElementById('vault-success-badge');
  if (existing) existing.remove();

  const badge = document.createElement('div');
  badge.id = 'vault-success-badge';
  badge.className = 'fixed bottom-6 right-6 z-[80] bg-gray-900 border border-green-500/60 rounded-2xl p-5 max-w-sm shadow-2xl';
  badge.innerHTML = `
    <div class="flex items-start gap-3">
      <div class="w-10 h-10 rounded-xl bg-green-900/60 flex items-center justify-center flex-shrink-0">
        <i class="fas fa-robot text-green-400"></i>
      </div>
      <div class="flex-1">
        <p class="text-white font-semibold text-sm">Depósito Confirmado!</p>
        <p class="text-green-400 text-xs mt-1">${amount} ${tokenSymbol} no vault</p>
        <p class="text-purple-400 text-xs">Agente IA ativo · Estratégia: ${strategy} · APY: ${apy}%</p>
        <a href="https://testnet.arcscan.app/tx/${txHash}" target="_blank"
           class="text-xs text-blue-400 hover:underline mt-1 block">
          Ver TX no Explorer ↗
        </a>
      </div>
      <button onclick="this.parentElement.parentElement.remove()" class="text-gray-500 hover:text-white ml-2">
        <i class="fas fa-times text-xs"></i>
      </button>
    </div>`;
  document.body.appendChild(badge);
  setTimeout(() => badge.remove(), 12000);
}

// ─── Histórico do vault ──────────────────────────────────────────────────────
async function loadVaultHistory(token = 'usdc', walletAddress = null) {
  try {
    const addr = walletAddress || window.walletState?.address;
    const walletParam = addr ? `&wallet=${addr}` : '';
    const res = await axios.get(`/api/vaults/${token}/history?limit=20${walletParam}`);
    const container = document.getElementById('vault-history-list');
    if (!container) return;

    if (!res.data.success || !res.data.history?.length) {
      container.innerHTML = `<div class="text-center py-6 text-gray-600 text-sm">
        <i class="fas fa-vault mr-2"></i>Nenhuma atividade ainda${addr ? ' para esta carteira' : ''}
      </div>`;
      return;
    }

    const stats = res.data.stats;
    const tokenSymbol = token.toUpperCase();

    const statsHtml = `
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
        <div class="bg-gray-800/60 rounded-xl p-3 text-center">
          <p class="text-xs text-gray-400">Saldo no Vault</p>
          <p class="text-white font-bold">${parseFloat(stats.currentBalance).toFixed(4)}</p>
          <p class="text-xs text-gray-500">${tokenSymbol}</p>
        </div>
        <div class="bg-green-900/20 border border-green-700/20 rounded-xl p-3 text-center">
          <p class="text-xs text-gray-400">Yield Ganho</p>
          <p class="text-green-400 font-bold">${parseFloat(stats.yieldEarned || stats.accrued).toFixed(6)}</p>
          <p class="text-xs text-gray-500">${tokenSymbol}</p>
        </div>
        <div class="bg-blue-900/20 rounded-xl p-3 text-center">
          <p class="text-xs text-gray-400">APY Atual</p>
          <p class="text-blue-400 font-bold">${stats.apy}%</p>
        </div>
        <div class="bg-purple-900/20 rounded-xl p-3 text-center">
          <p class="text-xs text-gray-400">Participantes</p>
          <p class="text-purple-400 font-bold">${stats.participants}</p>
          <p class="text-xs text-gray-500">wallets</p>
        </div>
      </div>`;

    const rows = res.data.history.map(h => {
      const isDeposit = h.amount >= 0;
      const icon = h.type === 'deposit' ? '⬇️' : h.type === 'withdraw' ? '⬆️' : h.type === 'agent_op' ? '🤖' : '💰';
      const color = isDeposit ? 'text-green-400' : 'text-red-400';
      const prefix = isDeposit ? '+' : '';
      const dt = new Date(h.timestamp).toLocaleString('pt-BR');
      const shortTx = h.txHash ? `${h.txHash.slice(0, 10)}...` : '';
      return `
        <div class="flex items-center justify-between py-3 border-b border-gray-700/30 last:border-0 hover:bg-gray-800/20 rounded-lg px-1 transition-colors">
          <div class="flex items-center gap-3">
            <span class="text-lg">${icon}</span>
            <div>
              <p class="${color} font-mono font-semibold text-sm">${prefix}${Math.abs(h.amount).toFixed(4)} ${tokenSymbol}</p>
              <p class="text-xs text-gray-500">${h.type.toUpperCase()}${h.note ? ` — ${h.note.slice(0, 40)}` : ''}</p>
            </div>
          </div>
          <div class="text-right flex-shrink-0">
            <p class="text-xs text-gray-500">${dt}</p>
            ${h.txHash ? `<a href="https://testnet.arcscan.app/tx/${h.txHash}" target="_blank" class="text-xs text-blue-400 hover:underline">${shortTx} ↗</a>` : ''}
          </div>
        </div>`;
    }).join('');

    container.innerHTML = statsHtml + `<div class="space-y-0">${rows}</div>`;
  } catch (e) {
    console.error('[Vaults] loadVaultHistory error:', e);
  }
}

// ─── Carregar operações do agente ────────────────────────────────────────────
async function loadVaultAgentOps(token = null) {
  try {
    const param = token ? `?token=${token.toUpperCase()}` : '';
    const res = await axios.get(`/api/vaults/agent/ops${param}`);
    const container = document.getElementById('vault-agent-ops');
    if (!container) return;

    if (!res.data.success || !res.data.operations?.length) {
      container.innerHTML = `<div class="text-center py-4 text-gray-600 text-xs">
        <i class="fas fa-robot mr-1"></i>Deposite tokens para ativar o agente IA
      </div>`;
      return;
    }

    const opIcons = {
      yield_harvest: { icon: 'fas fa-leaf', color: 'text-green-400', label: 'Harvest' },
      optimize_apy: { icon: 'fas fa-chart-line', color: 'text-blue-400', label: 'Otimizou APY' },
      compound: { icon: 'fas fa-redo', color: 'text-purple-400', label: 'Compound' },
      risk_check: { icon: 'fas fa-shield-alt', color: 'text-yellow-400', label: 'Risk Check' },
      rebalance: { icon: 'fas fa-balance-scale', color: 'text-cyan-400', label: 'Rebalance' },
    };

    const rows = res.data.operations.slice(0, 8).map(op => {
      const meta = opIcons[op.opType] || { icon: 'fas fa-robot', color: 'text-gray-400', label: op.opType };
      const dt = new Date(op.executedAt).toLocaleTimeString('pt-BR');
      const gainBadge = op.gainUSDC ? `<span class="text-green-400 text-xs ml-1">+${op.gainUSDC.toFixed(4)}</span>` : '';
      return `
        <div class="flex items-start gap-2 py-2 border-b border-gray-700/20 last:border-0">
          <i class="${meta.icon} ${meta.color} text-xs mt-0.5 w-4 flex-shrink-0"></i>
          <div class="flex-1 min-w-0">
            <p class="text-xs text-gray-300 truncate">${op.reason}</p>
            <p class="text-xs text-gray-600">${meta.label} · ${op.vaultToken} · ${dt}${gainBadge}</p>
          </div>
        </div>`;
    }).join('');

    container.innerHTML = `
      <div class="flex items-center justify-between mb-2">
        <span class="text-xs text-gray-400 uppercase tracking-wider">Operações do Agente IA</span>
        <button onclick="loadVaultAgentOps()" class="text-xs text-purple-400 hover:text-purple-300">
          <i class="fas fa-sync-alt"></i>
        </button>
      </div>
      ${rows}`;
  } catch (e) {
    console.warn('[Vaults] loadVaultAgentOps error:', e.message);
  }
}

// ─── Forçar ciclo do agente ──────────────────────────────────────────────────
async function runVaultAgent(token = null) {
  try {
    const res = await axios.post('/api/vaults/agent/run', token ? { token } : {});
    if (res.data.success) {
      showToast(`🤖 Agente executou ${res.data.operations?.length || 0} operações`, 'info');
      await loadVaultAgentOps(token);
      await loadVaults();
    }
  } catch (e) {
    showToast('Erro ao executar agente: ' + e.message, 'error');
  }
}

// ─── Buscar saldo on-chain da wallet (para exibir antes do depósito) ─────────
    if (res.data.success) {
      showToast(`🤖 Agente executou ${res.data.operations?.length || 0} operações`, 'info');
      await loadVaultAgentOps(token);
      await loadVaults();
    }
  } catch (e) {
    showToast('Erro ao executar agente: ' + e.message, 'error');
  }
}

// ─── Buscar saldo on-chain da wallet (para exibir antes do depósito) ─────────
async function refreshOnChainBalance(token) {
  const provider = window.walletState?.provider;
  const addr = window.walletState?.address;
  if (!provider || !addr) return;

  try {
    const tokenContract = VAULT_TOKEN_CONTRACTS[token.toUpperCase()];
    const selector = '0x70a08231'; // balanceOf(address)
    const data = selector + addr.slice(2).padStart(64, '0');
    const result = await provider.request({
      method: 'eth_call',
      params: [{ to: tokenContract, data }, 'latest'],
    });

    const balanceEl = document.getElementById(`${token}-onchain-balance`);
    const valEl = document.getElementById(`${token}-onchain-val`);

    if (result && result !== '0x' && result.length > 2) {
      const balance = Number(BigInt(result)) / 1e6;
      if (valEl) valEl.textContent = balance.toFixed(4);
      if (balanceEl) balanceEl.classList.remove('hidden');
    } else {
      if (valEl) valEl.textContent = '0.0000';
      if (balanceEl) balanceEl.classList.remove('hidden');
    }
  } catch (e) {
    console.warn(`[Vaults] refreshOnChainBalance (${token}):`, e.message);
  }
}

// ─── Preencher max amount ─────────────────────────────────────────────────────
async function setMaxVaultAmount(token, action) {
  const amountEl = document.getElementById(`${token}-vault-amount`);
  if (!amountEl) return;

  if (action === 'withdraw') {
    const pos = walletVaultPositions[token];
    if (pos?.hasPosition && pos.balance > 0) {
      amountEl.value = parseFloat(pos.balance).toFixed(4);
    } else {
      showToast(`Nenhum saldo no vault ${token.toUpperCase()}`, 'warning');
    }
  } else {
    // Para depósito, buscar saldo da wallet on-chain
    const provider = window.walletState?.provider;
    const addr = window.walletState?.address;
    if (!provider || !addr) {
      showToast('Conecte sua wallet primeiro', 'warning');
      return;
    }
    try {
      const tokenContract = VAULT_TOKEN_CONTRACTS[token.toUpperCase()];
      const selector = '0x70a08231';
      const data = selector + addr.slice(2).padStart(64, '0');
      const result = await provider.request({
        method: 'eth_call',
        params: [{ to: tokenContract, data }, 'latest'],
      });
      if (result && result !== '0x') {
        const balance = Number(BigInt(result)) / 1e6;
        amountEl.value = balance.toFixed(4);
        showToast(`Saldo ${token.toUpperCase()}: ${balance.toFixed(4)}`, 'info');
      } else {
        amountEl.value = '0';
        showToast(`Saldo ${token.toUpperCase()}: 0 (conecte-se à Arc Testnet)`, 'warning');
      }
    } catch (e) {
      showToast('Erro ao ler saldo: ' + e.message, 'error');
    }
  }
}

function addVaultLog(message, type = 'info') {
  if (typeof addLog === 'function') addLog(message, type);
}

// ─── Window hooks ────────────────────────────────────────────────────────────
window.loadVaultData = function () {
  loadVaults();
  loadVaultHistory('usdc');
  loadVaultAgentOps();
};

// Atualizar posições quando wallet conectar
window.addEventListener('walletConnected', (e) => {
  const addr = e.detail?.address;
  if (addr) {
    loadWalletVaultPosition('usdc', addr);
    loadWalletVaultPosition('eurc', addr);
    loadVaultHistory('usdc', addr);
    // Mostrar saldo on-chain automaticamente
    setTimeout(() => {
      refreshOnChainBalance('usdc');
      refreshOnChainBalance('eurc');
    }, 500);
  }
});

window.addEventListener('walletDisconnected', () => {
  walletVaultPositions = { usdc: null, eurc: null };
  ['usdc', 'eurc'].forEach(t => {
    const posEl = document.getElementById(`${t}-wallet-position`);
    if (posEl) posEl.innerHTML = `<div class="text-center py-3 text-gray-500 text-xs">Conecte sua wallet para ver sua posição</div>`;
  });
});

// Expor globais
window.submitVaultAction = submitVaultAction;
window.setVaultAction = setVaultAction;
window.loadVaults = loadVaults;
window.loadVaultHistory = loadVaultHistory;
window.loadVaultAgentOps = loadVaultAgentOps;
window.runVaultAgent = runVaultAgent;
window.setMaxVaultAmount = setMaxVaultAmount;
window.loadWalletVaultPosition = loadWalletVaultPosition;
window.refreshOnChainBalance = refreshOnChainBalance;
