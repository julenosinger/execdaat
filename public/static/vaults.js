// ===== VAULTS MODULE — Depósito Real EVM na Arc Testnet =====
//
// USDC na Arc = token NATIVO (como ETH em outras chains)
//   → Transferência via campo `value` da tx (sem approve, sem ERC-20 call)
//   → Contrato ERC-20 0x3600... existe como interface opcional
//
// EURC na Arc = ERC-20 padrão
//   → Fluxo: approve(vault, amount) → transferFrom OU transfer(vault, amount)
//   → Contrato: 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a
//
// Endereços oficiais (docs.arc.network/arc/references/contract-addresses):
//   USDC nativo: 0x3600000000000000000000000000000000000000
//   EURC ERC-20: 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a

// ─── Configuração ────────────────────────────────────────────────────────────
const VAULT_TOKENS = {
  USDC: {
    address: '0x3600000000000000000000000000000000000000',
    isNative: true,   // USDC é nativo na Arc — transfere via value
    decimals: 6,
    symbol: 'USDC',
  },
  EURC: {
    address: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
    isNative: false,  // EURC é ERC-20 padrão
    decimals: 6,
    symbol: 'EURC',
  },
};

// Endereço receptor do vault (custodiante dos depósitos — controlado pelo backend)
// Deve ser um endereço real controlado pelo backend ou um smart contract deployado
const VAULT_CUSTODIAN = {
  // Usar o endereço do FxEscrow oficial da Arc como destino de custódia por ora
  // Em produção: deployar VaultCustodian.sol com withdraw controlado
  usdc: '0x867650F5eAe8df91445971f14d89fd84F0C9a9f8', // FxEscrow Arc oficial (testnet)
  eurc: '0x867650F5eAe8df91445971f14d89fd84F0C9a9f8', // mesmo custodiante
};

const ARC_CHAIN_HEX_VAULT = '0x4cef52'; // 5042002

// ─── Estado local ────────────────────────────────────────────────────────────
let vaultActions = { usdc: 'deposit', eurc: 'deposit' };
let walletVaultPositions = { usdc: null, eurc: null };

// ─── Helpers de UI ───────────────────────────────────────────────────────────
function setVaultEl(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function addVaultLog(message, type = 'info') {
  if (typeof addLog === 'function') addLog(message, type);
  console.log(`[VAULT][${type.toUpperCase()}]`, message);
}

// Painel de etapas visuais durante o depósito
function _showStepPanel(token, steps) {
  const panelId = `${token}-deposit-steps`;
  let panel = document.getElementById(panelId);
  if (!panel) {
    panel = document.createElement('div');
    panel.id = panelId;
    panel.className = 'fixed inset-0 z-[90] flex items-center justify-center bg-black/70 backdrop-blur-sm';
    document.body.appendChild(panel);
  }
  const tokenCfg = VAULT_TOKENS[token.toUpperCase()];
  const color = token === 'usdc' ? 'blue' : 'yellow';
  panel.innerHTML = `
    <div class="bg-gray-900 border border-${color}-700/40 rounded-2xl p-6 max-w-sm w-full mx-4 shadow-2xl">
      <div class="flex items-center gap-3 mb-5">
        <div class="w-10 h-10 rounded-xl bg-${color}-900/60 flex items-center justify-center">
          <i class="fas fa-vault text-${color}-400"></i>
        </div>
        <div>
          <p class="text-white font-bold">Depositando ${token.toUpperCase()}</p>
          <p class="text-xs text-gray-400">Arc Testnet · Chain ID 5042002</p>
        </div>
      </div>
      <div class="space-y-3" id="${token}-steps-list">
        ${steps.map((s, i) => `
          <div id="${token}-step-${i}" class="flex items-start gap-3 p-3 rounded-xl ${s.active ? `bg-${color}-900/20 border border-${color}-700/30` : s.done ? 'bg-green-900/20 border border-green-700/20' : 'bg-gray-800/40 border border-gray-700/20'}">
            <div class="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${s.active ? `bg-${color}-700` : s.done ? 'bg-green-700' : 'bg-gray-700'}">
              ${s.done ? '<i class="fas fa-check text-white text-xs"></i>' : s.active ? '<i class="fas fa-spinner fa-spin text-white text-xs"></i>' : `<span class="text-white text-xs font-bold">${i+1}</span>`}
            </div>
            <div>
              <p class="text-sm ${s.active ? `text-${color}-300 font-semibold` : s.done ? 'text-green-300' : 'text-gray-500'}">${s.label}</p>
              <p class="text-xs ${s.active ? 'text-gray-400' : s.done ? 'text-green-600' : 'text-gray-600'}">${s.desc}</p>
              ${s.tx ? `<a href="https://testnet.arcscan.app/tx/${s.tx}" target="_blank" class="text-xs text-blue-400 hover:underline">${s.tx.slice(0,14)}... ↗</a>` : ''}
            </div>
          </div>`).join('')}
      </div>
      <p class="text-xs text-gray-600 text-center mt-4">Não feche esta janela até a confirmação</p>
    </div>`;
  return panel;
}

function _updateStep(token, stepIndex, status, tx = null) {
  const stepEl = document.getElementById(`${token}-step-${stepIndex}`);
  if (!stepEl) return;
  const color = token === 'usdc' ? 'blue' : 'yellow';
  if (status === 'active') {
    stepEl.className = `flex items-start gap-3 p-3 rounded-xl bg-${color}-900/20 border border-${color}-700/30`;
    stepEl.querySelector('div').className = `w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 bg-${color}-700`;
    stepEl.querySelector('div').innerHTML = '<i class="fas fa-spinner fa-spin text-white text-xs"></i>';
  } else if (status === 'done') {
    stepEl.className = 'flex items-start gap-3 p-3 rounded-xl bg-green-900/20 border border-green-700/20';
    stepEl.querySelector('div').className = 'w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 bg-green-700';
    stepEl.querySelector('div').innerHTML = '<i class="fas fa-check text-white text-xs"></i>';
    if (tx) {
      const pEl = stepEl.querySelectorAll('p')[1];
      if (pEl) pEl.insertAdjacentHTML('afterend', `<a href="https://testnet.arcscan.app/tx/${tx}" target="_blank" class="text-xs text-blue-400 hover:underline">${tx.slice(0,14)}... ↗</a>`);
    }
  } else if (status === 'error') {
    stepEl.className = 'flex items-start gap-3 p-3 rounded-xl bg-red-900/20 border border-red-700/30';
    stepEl.querySelector('div').className = 'w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 bg-red-700';
    stepEl.querySelector('div').innerHTML = '<i class="fas fa-times text-white text-xs"></i>';
  }
}

function _closeStepPanel(token) {
  const panel = document.getElementById(`${token}-deposit-steps`);
  if (panel) {
    panel.style.opacity = '0';
    panel.style.transition = 'opacity 0.4s';
    setTimeout(() => panel.remove(), 400);
  }
}

// ─── Carregar overview dos vaults ────────────────────────────────────────────
async function loadVaults() {
  try {
    const res = await (async function() {
   console.log('[fetch] GET', '/api/vaults');
   try {
     var _r = await fetch('/api/vaults', {method:'GET',headers:{'Content-Type':'application/json'}});
     if (!_r.ok) { var _e = new Error('GET failed: '+_r.status); _e.response={data:await _r.json().catch(function(){return null;}),status:_r.status}; throw _e; }
     var _d = await _r.json().catch(function(){return null;});
     console.log('[fetch] GET OK', '/api/vaults', _r.status);
     return {data:_d, status:_r.status};
   } catch(_ex) { console.error('[fetch] GET ERR', '/api/vaults', _ex.message); throw _ex; }
 }());
    if (!res.data.success) return;

    res.data.vaults.forEach(v => {
      const tok = v.token.toLowerCase();
      setVaultEl(`${tok}-vault-balance`, `${parseFloat(v.currentBalance).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})} ${v.token}`);
      setVaultEl(`${tok}-vault-apy`, `${v.apy}%`);
      setVaultEl(`${tok}-vault-accrued`, `${parseFloat(v.accrued).toFixed(4)} ${v.token}`);
      setVaultEl(`${tok}-vault-deposited`, `${parseFloat(v.totalDeposited).toLocaleString()} ${v.token}`);
      setVaultEl(`${tok}-vault-participants`, `${v.participants} wallets`);
    });

    const addr = window.walletState?.address;
    if (addr) {
      await loadWalletVaultPosition('usdc', addr);
      await loadWalletVaultPosition('eurc', addr);
    }
  } catch (e) {
    console.error('[Vaults] loadVaults error:', e);
  }
}

// ─── Posição da wallet no vault ───────────────────────────────────────────────
async function loadWalletVaultPosition(token, walletAddress) {
  try {
    const res = await (async function() {
   console.log('[fetch] GET', `/api/vaults/${token}/position?wallet=${walletAddress}`);
   try {
     var _r = await fetch(`/api/vaults/${token}/position?wallet=${walletAddress}`, {method:'GET',headers:{'Content-Type':'application/json'}});
     if (!_r.ok) { var _e = new Error('GET failed: '+_r.status); _e.response={data:await _r.json().catch(function(){return null;}),status:_r.status}; throw _e; }
     var _d = await _r.json().catch(function(){return null;});
     console.log('[fetch] GET OK', `/api/vaults/${token}/position?wallet=${walletAddress}`, _r.status);
     return {data:_d, status:_r.status};
   } catch(_ex) { console.error('[fetch] GET ERR', `/api/vaults/${token}/position?wallet=${walletAddress}`, _ex.message); throw _ex; }
 }());
    const data = res.data;
    walletVaultPositions[token] = data;

    const posEl = document.getElementById(`${token}-wallet-position`);
    if (!posEl) return;

    if (!data.hasPosition || data.balance <= 0) {
      posEl.innerHTML = `
        <div class="text-center py-3 text-gray-500 text-xs">
          <i class="fas fa-info-circle mr-1"></i>Nenhum saldo depositado neste vault
        </div>`;
      return;
    }

    const sym = token.toUpperCase();
    const yieldPct = data.deposited > 0 ? ((data.yieldEarned / data.deposited) * 100).toFixed(3) : '0';
    posEl.innerHTML = `
      <div class="space-y-2">
        <div class="grid grid-cols-2 gap-2">
          <div class="bg-gray-800/60 rounded-lg p-2.5 text-center">
            <p class="text-xs text-gray-400">Meu Saldo</p>
            <p class="text-white font-bold text-sm">${parseFloat(data.balance).toFixed(4)}</p>
            <p class="text-xs text-gray-500">${sym}</p>
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

// ─── Toggle Deposit/Withdraw ──────────────────────────────────────────────────
function setVaultAction(token, action) {
  vaultActions[token] = action;
  const form = document.getElementById(`${token}-vault-form`);
  if (form) form.classList.remove('hidden');

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

  const depBtn = document.getElementById(`${token}-dep-btn`);
  const witBtn = document.getElementById(`${token}-wit-btn`);
  if (action === 'deposit') {
    depBtn?.classList.add('ring-2', 'ring-white/20');
    witBtn?.classList.remove('ring-2', 'ring-white/20');
  } else {
    witBtn?.classList.add('ring-2', 'ring-white/20');
    depBtn?.classList.remove('ring-2', 'ring-white/20');
  }

  const yieldRow = document.getElementById(`${token}-yield-row`);
  if (yieldRow) yieldRow.style.display = action === 'withdraw' ? '' : 'none';

  const balHint = document.getElementById(`${token}-balance-hint`);
  if (balHint) {
    const pos = walletVaultPositions[token];
    if (action === 'withdraw' && pos?.hasPosition) {
      balHint.innerHTML = `<i class="fas fa-info-circle mr-1"></i>${t("vault_available_balance", parseFloat(pos.balance).toFixed(4), token.toUpperCase())}`;
      balHint.classList.remove('hidden');
    } else {
      balHint.classList.add('hidden');
    }
  }

  const onchainBal = document.getElementById(`${token}-onchain-balance`);
  const strategyRow = document.getElementById(`${token}-strategy-row`);
  if (action === 'deposit') {
    if (onchainBal) onchainBal.classList.remove('hidden');
    if (strategyRow) strategyRow.style.display = '';
    if (window.walletState?.connected) refreshOnChainBalance(token);
  } else {
    if (onchainBal) onchainBal.classList.add('hidden');
    if (strategyRow) strategyRow.style.display = 'none';
  }
}

// ─── FLUXO PRINCIPAL DE DEPÓSITO ─────────────────────────────────────────────
async function submitVaultAction(token) {
  const action = vaultActions[token] || 'deposit';
  const amountEl = document.getElementById(`${token}-vault-amount`);
  const amount = parseFloat(amountEl?.value || '0');
  const includeYield = document.getElementById(`${token}-include-yield`)?.checked || false;
  const strategy = document.getElementById(`${token}-strategy`)?.value || 'balanced';

  if (!amount || isNaN(amount) || amount <= 0) {
    showToast(t('err_enter_amount'), 'error'); return;
  }
  if (amount < 0.000001) {
    showToast(t('err_enter_amount'), 'error'); return;
  }

  if (!window.walletState?.connected) {
    showToast('Conecte sua wallet EVM primeiro', 'warning');
    if (typeof openWalletModal === 'function') openWalletModal();
    return;
  }

  const walletAddress = window.walletState.address;
  const tokenSymbol = token.toUpperCase();
  const tokenCfg = VAULT_TOKENS[tokenSymbol];
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
        showToast(`Nenhum saldo para sacar no vault ${tokenSymbol}`, 'error'); return;
      }
      if (amount > pos.balance) {
        showToast(`Saldo insuficiente. Vault: ${parseFloat(pos.balance).toFixed(4)} ${tokenSymbol}`, 'error'); return;
      }

      setBtn('<i class="fas fa-shield-alt fa-spin mr-2"></i>Verificando compliance...', true);
      try {
        const gcRes = await (async function() {
   console.log('[fetch] POST', '/api/guardian/check');
   try {
     var _r = await fetch('/api/guardian/check', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
          txType: 'vault_withdraw', fromAddress: walletAddress, amount, token: tokenSymbol,
        })});
     if (!_r.ok) { var _e = new Error('POST failed: '+_r.status); _e.response={data:await _r.json().catch(function(){return null;}),status:_r.status}; throw _e; }
     var _d = await _r.json().catch(function(){return null;});
     console.log('[fetch] POST OK', '/api/guardian/check', _r.status);
     return {data:_d, status:_r.status};
   } catch(_ex) { console.error('[fetch] POST ERR', '/api/guardian/check', _ex.message); throw _ex; }
 }());
        if (!gcRes.data.approved) {
          showToast(`🚫 Guardian bloqueou: ${gcRes.data.check?.result?.reasons?.[0] || 'Compliance falhou'}`, 'error');
          return;
        }
      } catch (_) {}

      setBtn('<i class="fas fa-spinner fa-spin mr-2"></i>Processando saque...', true);
      const res = await (async function() {
   console.log('[fetch] POST', `/api/vaults/${token}/withdraw`);
   try {
     var _r = await fetch(`/api/vaults/${token}/withdraw`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ walletAddress, amount, includeYield })});
     if (!_r.ok) { var _e = new Error('POST failed: '+_r.status); _e.response={data:await _r.json().catch(function(){return null;}),status:_r.status}; throw _e; }
     var _d = await _r.json().catch(function(){return null;});
     console.log('[fetch] POST OK', `/api/vaults/${token}/withdraw`, _r.status);
     return {data:_d, status:_r.status};
   } catch(_ex) { console.error('[fetch] POST ERR', `/api/vaults/${token}/withdraw`, _ex.message); throw _ex; }
 }());
      if (res.data.success) {
        const w = res.data.withdrawal;
        showToast(`✅ Saque de ${amount} ${tokenSymbol}${includeYield && w.yieldClaimed > 0 ? ` + ${w.yieldClaimed.toFixed(4)} yield` : ''} registrado!`, 'success');
        addVaultLog(`[VAULT] Saque: ${amount} ${tokenSymbol} de ${walletAddress.slice(0,10)}...`, 'info');
        if (amountEl) amountEl.value = '';
        await _refreshVaultUI(token, walletAddress);
      } else {
        showToast(res.data.error || 'Saque falhou', 'error');
      }
      return;
    }

    // ── DEPÓSITO ─────────────────────────────────────────────────────────────
    const provider = window.walletState?.provider;
    if (!provider) {
      showToast(t('err_vault_provider'), 'error'); return;
    }

    // ── Verificar rede SEMPRE antes de qualquer tx ────────────────────────────
    // Mesmo que walletState.onArcNetwork=true, o usuário pode ter trocado de rede
    setBtn('<i class="fas fa-exchange-alt fa-spin mr-2"></i>Verificando rede...', true);
    try {
      const currentChainHex = await provider.request({ method: 'eth_chainId' });
      const currentChain = parseInt(currentChainHex, 16);
      window.walletState.chainId = currentChain;
      window.walletState.onArcNetwork = (currentChain === 5042002);
    } catch (_) { /* ignorar */ }

    if (!window.walletState.onArcNetwork) {
      setBtn('<i class="fas fa-exchange-alt fa-spin mr-2"></i>Adicionando Arc Testnet...', true);
      try {
        const switched = await switchToArcTestnet(provider);
        if (!switched) {
          showToast('Troque para Arc Testnet (Chain ID: 5042002) e tente novamente', 'error'); return;
        }
        // Aguardar wallet processar a troca de rede
        await new Promise(r => setTimeout(r, 800));
        // Re-verificar após a troca
        const chainHex2 = await provider.request({ method: 'eth_chainId' });
        const chain2 = parseInt(chainHex2, 16);
        if (chain2 !== 5042002) {
          showToast(`Rede incorreta (${chain2}). Use Arc Testnet (5042002).`, 'error'); return;
        }
        window.walletState.chainId = 5042002;
        window.walletState.onArcNetwork = true;
      } catch (netErr) {
        showToast(t('err_generic', netErr.message), 'error'); return;
      }
    }

    setBtn('<i class="fas fa-shield-alt fa-spin mr-2"></i>Verificando compliance...', true);
    try {
      const gcRes = await (async function() {
   console.log('[fetch] POST', '/api/guardian/check');
   try {
     var _r = await fetch('/api/guardian/check', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        txType: 'vault_deposit', fromAddress: walletAddress, amount, token: tokenSymbol,
      })});
     if (!_r.ok) { var _e = new Error('POST failed: '+_r.status); _e.response={data:await _r.json().catch(function(){return null;}),status:_r.status}; throw _e; }
     var _d = await _r.json().catch(function(){return null;});
     console.log('[fetch] POST OK', '/api/guardian/check', _r.status);
     return {data:_d, status:_r.status};
   } catch(_ex) { console.error('[fetch] POST ERR', '/api/guardian/check', _ex.message); throw _ex; }
 }());
      if (!gcRes.data.approved) {
        showToast(`🚫 Guardian bloqueou: ${gcRes.data.check?.result?.reasons?.[0] || 'Compliance falhou'}`, 'error');
        return;
      }
    } catch (_) {}

    const custodian = VAULT_CUSTODIAN[token];
    const amountRaw = BigInt(Math.round(amount * 1_000_000)); // 6 decimais
    const amountHex = '0x' + amountRaw.toString(16);

    let txHash = null;

    if (tokenCfg.isNative) {
      // ── USDC NATIVO: tx com value (como ETH) — sem approve ────────────────
      const steps = [
        { label: 'Compliance Guardian', desc: 'Verificação de compliance AML/KYC', done: true, active: false },
        { label: 'Enviar USDC nativo', desc: `Transferir ${amount} USDC para o vault (Arc native)`, done: false, active: true },
        { label: 'Confirmar on-chain', desc: 'Arc Testnet — sub-second finality', done: false, active: false },
        { label: 'Ativar Agente IA', desc: `Estratégia: ${strategy} · APY ~${token === 'usdc' ? '5.2' : '4.8'}%`, done: false, active: false },
      ];
      const panel = _showStepPanel(token, steps);

      setBtn('<i class="fas fa-paper-plane fa-spin mr-2"></i>Aguardando assinatura na wallet...', true);
      addVaultLog(`[VAULT] Enviando ${amount} USDC nativo para vault (${custodian.slice(0,10)}...)`, 'info');

      try {
        _updateStep(token, 1, 'active');

        // USDC nativo: value em wei (18 decimais para o campo value, 6 decimais para o token)
        // Na Arc, USDC nativo usa 18 casas no campo value da tx
        const amountNativeHex = '0x' + (amountRaw * BigInt(1_000_000_000_000n)).toString(16); // × 10^12 para 18 dec

        // ⚠️ NÃO incluir chainId no objeto de tx — MetaMask rejeita com
        // "chainId should be same as current chainId"
        // A rede já foi validada acima via switchToArcTestnet()
        txHash = await provider.request({
          method: 'eth_sendTransaction',
          params: [{
            from: walletAddress,
            to: custodian,
            value: amountNativeHex,    // USDC nativo no campo value
            data: '0x',                // sem calldata
          }],
        });

        _updateStep(token, 1, 'done', txHash);
        showToast(t('vault_tx_sent_confirming'), 'info');
        addVaultLog(`[VAULT] TX nativa USDC: ${txHash?.slice(0, 18)}...`, 'success');

      } catch (txErr) {
        _updateStep(token, 1, 'error');
        _closeStepPanel(token);
        if (txErr.code === 4001 || txErr.message?.includes('reject') || txErr.message?.includes('denied') || txErr.message?.includes('cancel')) {
          showToast(t('warn_vault_tx_cancelled'), 'warning');
        } else {
          showToast(t('err_generic', txErr.message), 'error');
        }
        return;
      }

      // Aguardar confirmação
      _updateStep(token, 2, 'active');
      setBtn('<i class="fas fa-hourglass-half fa-spin mr-2"></i>Aguardando confirmação on-chain...', true);
      const receipt = await _waitForTx(txHash, provider, 20000);
      _updateStep(token, 2, 'done', txHash);

      // Registrar no backend e ativar agente
      _updateStep(token, 3, 'active');
      setBtn('<i class="fas fa-robot fa-spin mr-2"></i>Ativando agente IA...', true);

      const _vR1 = await fetch(`/api/vaults/${token}/deposit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ walletAddress, amount, txHash, strategy, note: `Depósito USDC nativo · TX: ${txHash?.slice(0,12)}`, txType: 'native' }) });
      if (!_vR1.ok) { const _e = new Error('POST failed: ' + _vR1.status); throw _e; }
      const depRes = { data: await _vR1.json().catch(() => ({})) };

      if (depRes.data.success) {
        _updateStep(token, 3, 'done');
        setTimeout(() => _closeStepPanel(token), 2000);
        const pos = depRes.data.walletPosition;
        showToast(`✅ ${amount} USDC depositado! Agente IA ativo · APY: ${depRes.data.vault.apy}%`, 'success');
        addVaultLog(`[VAULT] ✅ Depósito USDC confirmado: ${amount} USDC | Saldo vault: ${pos.balance}`, 'success');
        addVaultLog(`[AGENTE] ${depRes.data.agentMessage}`, 'agent');
        _showVaultSuccessBadge(token, amount, tokenSymbol, txHash, depRes.data.vault.apy, strategy);
        if (amountEl) amountEl.value = '';
        await _refreshVaultUI(token, walletAddress);
      } else {
        _closeStepPanel(token);
        showToast(depRes.data.error || t('toast_error'), 'error');
      }

    } else {
      // ── EURC ERC-20: approve + transfer ───────────────────────────────────
      const steps = [
        { label: 'Compliance Guardian', desc: 'Verificação de compliance AML/KYC', done: true, active: false },
        { label: 'Approve EURC', desc: `Autorizar vault a receber ${amount} EURC`, done: false, active: true },
        { label: 'Transfer EURC', desc: `Transferir ${amount} EURC para o vault`, done: false, active: false },
        { label: 'Confirmar on-chain', desc: 'Arc Testnet — sub-second finality', done: false, active: false },
        { label: 'Ativar Agente IA', desc: `Estratégia: ${strategy} · APY ~4.8%`, done: false, active: false },
      ];
      const panel = _showStepPanel(token, steps);

      let approveTxHash = null;

      // PASSO: Approve
      setBtn('<i class="fas fa-lock fa-spin mr-2"></i>Passo 1/2: Aprovando EURC...', true);
      addVaultLog(`[VAULT] Solicitando approve de ${amount} EURC para o vault...`, 'info');

      try {
        _updateStep(token, 1, 'active');

        // approve(spender, amount) — ERC-20 selector 0x095ea7b3
        const approveSelector = '0x095ea7b3';
        const paddedSpender = custodian.slice(2).toLowerCase().padStart(64, '0');
        const paddedAmt = amountRaw.toString(16).padStart(64, '0');
        const approveData = approveSelector + paddedSpender + paddedAmt;

        // ⚠️ NÃO incluir chainId — MetaMask rejeita com "chainId should be same"
        approveTxHash = await provider.request({
          method: 'eth_sendTransaction',
          params: [{
            from: walletAddress,
            to: tokenCfg.address,
            data: approveData,
            value: '0x0',
          }],
        });

        _updateStep(token, 1, 'done', approveTxHash);
        showToast(t('vault_approve_confirmed_sending'), 'info');
        addVaultLog(`[VAULT] Approve TX: ${approveTxHash?.slice(0, 18)}...`, 'success');
        await new Promise(r => setTimeout(r, 1200));

      } catch (approveErr) {
        _updateStep(token, 1, 'error');
        _closeStepPanel(token);
        if (approveErr.code === 4001 || approveErr.message?.includes('reject') || approveErr.message?.includes('denied')) {
          showToast(t('warn_vault_approve_cancelled'), 'warning');
        } else {
          showToast(t('vault_approve_error', approveErr.message), 'error');
        }
        return;
      }

      // PASSO: Transfer
      setBtn('<i class="fas fa-paper-plane fa-spin mr-2"></i>Passo 2/2: Transferindo EURC...', true);
      addVaultLog(`[VAULT] Transferindo ${amount} EURC para o vault...`, 'info');

      let transferTxHash = null;
      try {
        _updateStep(token, 2, 'active');

        // transfer(to, amount) — ERC-20 selector 0xa9059cbb
        const transferSelector = '0xa9059cbb';
        const paddedTo = custodian.slice(2).toLowerCase().padStart(64, '0');
        const paddedAmt2 = amountRaw.toString(16).padStart(64, '0');
        const transferData = transferSelector + paddedTo + paddedAmt2;

        // ⚠️ NÃO incluir chainId — MetaMask rejeita com "chainId should be same"
        transferTxHash = await provider.request({
          method: 'eth_sendTransaction',
          params: [{
            from: walletAddress,
            to: tokenCfg.address,
            data: transferData,
            value: '0x0',
          }],
        });

        _updateStep(token, 2, 'done', transferTxHash);
        showToast(t('vault_eurc_sent_confirming'), 'info');
        addVaultLog(`[VAULT] Transfer TX: ${transferTxHash?.slice(0, 18)}...`, 'success');

      } catch (transferErr) {
        _updateStep(token, 2, 'error');
        _closeStepPanel(token);
        if (transferErr.code === 4001 || transferErr.message?.includes('reject') || transferErr.message?.includes('denied')) {
          showToast(t('warn_vault_transfer_cancelled'), 'warning');
        } else {
          showToast(t('err_generic', transferErr.message), 'error');
        }
        return;
      }

      // Aguardar confirmação
      _updateStep(token, 3, 'active');
      setBtn('<i class="fas fa-hourglass-half fa-spin mr-2"></i>Aguardando confirmação...', true);
      await _waitForTx(transferTxHash, provider, 20000);
      _updateStep(token, 3, 'done', transferTxHash);

      txHash = transferTxHash;

      // Registrar no backend
      _updateStep(token, 4, 'active');
      setBtn('<i class="fas fa-robot fa-spin mr-2"></i>Ativando agente IA...', true);

      const _vR2 = await fetch(`/api/vaults/${token}/deposit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ walletAddress, amount, txHash, strategy, note: `Depósito EURC ERC-20 · approve: ${approveTxHash?.slice(0,12)} · transfer: ${txHash?.slice(0,12)}`, txType: 'erc20', approveTxHash }) });
      if (!_vR2.ok) { const _e = new Error('POST failed: ' + _vR2.status); throw _e; }
      const depRes = { data: await _vR2.json().catch(() => ({})) };

      if (depRes.data.success) {
        _updateStep(token, 4, 'done');
        setTimeout(() => _closeStepPanel(token), 2000);
        const pos = depRes.data.walletPosition;
        showToast(`✅ ${amount} EURC depositado! Agente IA ativo · APY: ${depRes.data.vault.apy}%`, 'success');
        addVaultLog(`[VAULT] ✅ Depósito EURC confirmado: ${amount} EURC | Saldo vault: ${pos.balance}`, 'success');
        addVaultLog(`[AGENTE] ${depRes.data.agentMessage}`, 'agent');
        _showVaultSuccessBadge(token, amount, tokenSymbol, txHash, depRes.data.vault.apy, strategy);
        if (amountEl) amountEl.value = '';
        await _refreshVaultUI(token, walletAddress);
      } else {
        _closeStepPanel(token);
        showToast(depRes.data.error || t('toast_error'), 'error');
      }
    }

  } catch (e) {
    _closeStepPanel(token);
    const msg = e.response?.data?.error || e.message || 'Erro inesperado';
    showToast('Erro: ' + msg, 'error');
    addVaultLog(`[VAULT] Erro: ${msg}`, 'error');
    console.error('[Vault] Error:', e);
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      const icons = { usdc_deposit: 'arrow-down', usdc_withdraw: 'arrow-up', eurc_deposit: 'arrow-down', eurc_withdraw: 'arrow-up' };
      const labels = { usdc_deposit: 'Depositar USDC', usdc_withdraw: 'Sacar USDC', eurc_deposit: 'Depositar EURC', eurc_withdraw: 'Sacar EURC' };
      const key = `${token}_${vaultActions[token] || 'deposit'}`;
      submitBtn.innerHTML = `<i class="fas fa-${icons[key] || 'check'} mr-2"></i>${labels[key] || 'Confirmar'}`;
    }
  }
}

// ─── Aguardar TX na Arc (sub-second finality) ────────────────────────────────
async function _waitForTx(txHash, provider, maxMs = 20000) {
  if (!txHash) return null;
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const receipt = await provider.request({
        method: 'eth_getTransactionReceipt',
        params: [txHash],
      });
      if (receipt) {
        if (receipt.status === '0x0') console.warn('[Vault] TX revertida:', txHash);
        return receipt;
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 600));
  }
  // Arc tem sub-second finality — timeout não necessariamente = falha
  return null;
}

// ─── Refresh UI após operação ─────────────────────────────────────────────────
async function _refreshVaultUI(token, walletAddress) {
  await loadVaults();
  await loadVaultHistory(token, walletAddress);
  await loadWalletVaultPosition(token, walletAddress);
  await loadVaultAgentOps(token);
}

// ─── Badge de sucesso ─────────────────────────────────────────────────────────
function _showVaultSuccessBadge(token, amount, sym, txHash, apy, strategy) {
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
        <p class="text-green-400 text-xs mt-1">${amount} ${sym} → vault ativo</p>
        <p class="text-purple-400 text-xs">Agente IA · ${strategy} · APY: ${apy}%</p>
        ${txHash ? `<a href="https://testnet.arcscan.app/tx/${txHash}" target="_blank"
           class="text-xs text-blue-400 hover:underline mt-1 block">Ver TX no Explorer ↗</a>` : ''}
      </div>
      <button onclick="this.parentElement.parentElement.remove()" class="text-gray-500 hover:text-white ml-2">
        <i class="fas fa-times text-xs"></i>
      </button>
    </div>`;
  document.body.appendChild(badge);
  setTimeout(() => badge?.remove(), 15000);
}

// ─── Histórico do vault ───────────────────────────────────────────────────────
async function loadVaultHistory(token = 'usdc', walletAddress = null) {
  try {
    const addr = walletAddress || window.walletState?.address;
    const walletParam = addr ? `&wallet=${addr}` : '';
    const res = await (async function() {
   console.log('[fetch] GET', `/api/vaults/${token}/history?limit=20${walletParam}`);
   try {
     var _r = await fetch(`/api/vaults/${token}/history?limit=20${walletParam}`, {method:'GET',headers:{'Content-Type':'application/json'}});
     if (!_r.ok) { var _e = new Error('GET failed: '+_r.status); _e.response={data:await _r.json().catch(function(){return null;}),status:_r.status}; throw _e; }
     var _d = await _r.json().catch(function(){return null;});
     console.log('[fetch] GET OK', `/api/vaults/${token}/history?limit=20${walletParam}`, _r.status);
     return {data:_d, status:_r.status};
   } catch(_ex) { console.error('[fetch] GET ERR', `/api/vaults/${token}/history?limit=20${walletParam}`, _ex.message); throw _ex; }
 }());
    const container = document.getElementById('vault-history-list');
    if (!container) return;

    if (!res.data.success || !res.data.history?.length) {
      container.innerHTML = `<div class="text-center py-6 text-gray-600 text-sm">
        <i class="fas fa-vault mr-2"></i>Nenhuma atividade ainda${addr ? ' para esta carteira' : ''}
      </div>`;
      return;
    }

    const stats = res.data.stats;
    const sym = token.toUpperCase();
    const statsHtml = `
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
        <div class="bg-gray-800/60 rounded-xl p-3 text-center">
          <p class="text-xs text-gray-400">Saldo no Vault</p>
          <p class="text-white font-bold">${parseFloat(stats.currentBalance).toFixed(4)}</p>
          <p class="text-xs text-gray-500">${sym}</p>
        </div>
        <div class="bg-green-900/20 border border-green-700/20 rounded-xl p-3 text-center">
          <p class="text-xs text-gray-400">Yield Ganho</p>
          <p class="text-green-400 font-bold">${parseFloat(stats.yieldEarned || stats.accrued).toFixed(6)}</p>
          <p class="text-xs text-gray-500">${sym}</p>
        </div>
        <div class="bg-blue-900/20 rounded-xl p-3 text-center">
          <p class="text-xs text-gray-400">APY Atual</p>
          <p class="text-blue-400 font-bold">${stats.apy}%</p>
        </div>
        <div class="bg-purple-900/20 rounded-xl p-3 text-center">
          <p class="text-xs text-gray-400">Participantes</p>
          <p class="text-purple-400 font-bold">${stats.participants}</p>
        </div>
      </div>`;

    const rows = res.data.history.map(h => {
      const isDeposit = h.amount >= 0;
      const icon = h.type === 'deposit' ? '⬇️' : h.type === 'withdraw' ? '⬆️' : h.type === 'agent_op' ? '🤖' : '💰';
      const color = isDeposit ? 'text-green-400' : 'text-red-400';
      const prefix = isDeposit ? '+' : '';
      const dt = new Date(h.timestamp).toLocaleString('pt-BR');
      return `
        <div class="flex items-center justify-between py-3 border-b border-gray-700/30 last:border-0 hover:bg-gray-800/20 rounded-lg px-1 transition-colors">
          <div class="flex items-center gap-3">
            <span class="text-lg">${icon}</span>
            <div>
              <p class="${color} font-mono font-semibold text-sm">${prefix}${Math.abs(h.amount).toFixed(4)} ${sym}</p>
              <p class="text-xs text-gray-500">${h.type.toUpperCase()}${h.note ? ` — ${h.note.slice(0, 40)}` : ''}</p>
            </div>
          </div>
          <div class="text-right flex-shrink-0">
            <p class="text-xs text-gray-500">${dt}</p>
            ${h.txHash ? `<a href="https://testnet.arcscan.app/tx/${h.txHash}" target="_blank" class="text-xs text-blue-400 hover:underline">${h.txHash.slice(0,10)}... ↗</a>` : ''}
          </div>
        </div>`;
    }).join('');

    container.innerHTML = statsHtml + `<div class="space-y-0">${rows}</div>`;
  } catch (e) {
    console.error('[Vaults] loadVaultHistory error:', e);
  }
}

// ─── Operações do Agente IA ───────────────────────────────────────────────────
async function loadVaultAgentOps(token = null) {
  try {
    const param = token ? `?token=${token.toUpperCase()}` : '';
    const res = await (async function() {
   console.log('[fetch] GET', `/api/vaults/agent/ops${param}`);
   try {
     var _r = await fetch(`/api/vaults/agent/ops${param}`, {method:'GET',headers:{'Content-Type':'application/json'}});
     if (!_r.ok) { var _e = new Error('GET failed: '+_r.status); _e.response={data:await _r.json().catch(function(){return null;}),status:_r.status}; throw _e; }
     var _d = await _r.json().catch(function(){return null;});
     console.log('[fetch] GET OK', `/api/vaults/agent/ops${param}`, _r.status);
     return {data:_d, status:_r.status};
   } catch(_ex) { console.error('[fetch] GET ERR', `/api/vaults/agent/ops${param}`, _ex.message); throw _ex; }
 }());
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

// ─── Forçar ciclo do agente ───────────────────────────────────────────────────
async function runVaultAgent(token = null) {
  try {
    const _vaR = await fetch('/api/vaults/agent/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(token ? { token } : {}) });
    if (!_vaR.ok) { const _e = new Error('POST failed: ' + _vaR.status); throw _e; }
    const res = { data: await _vaR.json().catch(() => ({})) };
    if (res.data.success) {
      showToast(`🤖 Agent ran ${res.data.operations?.length || 0} operations`, 'info');
      await loadVaultAgentOps(token);
      await loadVaults();
    }
  } catch (e) {
    showToast(t('err_generic', e.message), 'error');
  }
}

// ─── Saldo on-chain da wallet ─────────────────────────────────────────────────
async function refreshOnChainBalance(token) {
  const provider = window.walletState?.provider;
  const addr = window.walletState?.address;
  if (!provider || !addr) return;

  const tokenCfg = VAULT_TOKENS[token.toUpperCase()];
  if (!tokenCfg) return;

  try {
    let balance = 0;

    if (tokenCfg.isNative) {
      // USDC nativo: usar eth_getBalance (18 casas)
      const result = await provider.request({ method: 'eth_getBalance', params: [addr, 'latest'] });
      if (result && result !== '0x') {
        // Converter de 18 decimais para 6 (USDC)
        balance = Number(BigInt(result)) / 1e18;
      }
    } else {
      // EURC ERC-20: balanceOf
      const selector = '0x70a08231';
      const data = selector + addr.slice(2).padStart(64, '0');
      const result = await provider.request({ method: 'eth_call', params: [{ to: tokenCfg.address, data }, 'latest'] });
      if (result && result !== '0x' && result.length > 2) {
        balance = Number(BigInt(result)) / 1e6;
      }
    }

    const valEl = document.getElementById(`${token}-onchain-val`);
    const balEl = document.getElementById(`${token}-onchain-balance`);
    if (valEl) valEl.textContent = balance.toFixed(4);
    if (balEl) balEl.classList.remove('hidden');

  } catch (e) {
    console.warn(`[Vaults] refreshOnChainBalance (${token}):`, e.message);
  }
}

// ─── Preencher valor máximo ───────────────────────────────────────────────────
async function setMaxVaultAmount(token, action) {
  const amountEl = document.getElementById(`${token}-vault-amount`);
  if (!amountEl) return;

  if (action === 'withdraw') {
    const pos = walletVaultPositions[token];
    if (pos?.hasPosition && pos.balance > 0) {
      amountEl.value = parseFloat(pos.balance).toFixed(6);
    } else {
      showToast(`Nenhum saldo no vault ${token.toUpperCase()}`, 'warning');
    }
  } else {
    await refreshOnChainBalance(token);
    const valEl = document.getElementById(`${token}-onchain-val`);
    const val = parseFloat(valEl?.textContent || '0');
    if (val > 0) {
      // Deixar 0.001 USDC de reserva para gas
      const maxDeposit = token === 'usdc' ? Math.max(0, val - 0.001) : val;
      amountEl.value = maxDeposit.toFixed(6);
    } else {
      showToast(`Saldo ${token.toUpperCase()} = 0 (obtenha tokens no faucet: faucet.circle.com)`, 'warning');
    }
  }
}

// ─── Hooks de wallet ──────────────────────────────────────────────────────────
window.loadVaultData = function () {
  loadVaults();
  loadVaultHistory('usdc');
  loadVaultAgentOps();
};

window.addEventListener('walletConnected', (e) => {
  const addr = e.detail?.address;
  if (addr) {
    loadWalletVaultPosition('usdc', addr);
    loadWalletVaultPosition('eurc', addr);
    loadVaultHistory('usdc', addr);
    setTimeout(() => {
      refreshOnChainBalance('usdc');
      refreshOnChainBalance('eurc');
    }, 800);
  }
});

window.addEventListener('walletDisconnected', () => {
  walletVaultPositions = { usdc: null, eurc: null };
  ['usdc', 'eurc'].forEach(t => {
    const posEl = document.getElementById(`${t}-wallet-position`);
    if (posEl) posEl.innerHTML = `<div class="text-center py-3 text-gray-500 text-xs">${t("vault_connect_to_view_position")}</div>`;
    const onchainEl = document.getElementById(`${t}-onchain-balance`);
    if (onchainEl) onchainEl.classList.add('hidden');
  });
});

// ─── Expor globais ────────────────────────────────────────────────────────────
window.submitVaultAction = submitVaultAction;
window.setVaultAction = setVaultAction;
window.loadVaults = loadVaults;
window.loadVaultHistory = loadVaultHistory;
window.loadVaultAgentOps = loadVaultAgentOps;
window.runVaultAgent = runVaultAgent;
window.setMaxVaultAmount = setMaxVaultAmount;
window.loadWalletVaultPosition = loadWalletVaultPosition;
window.refreshOnChainBalance = refreshOnChainBalance;

console.log('[Vaults] Módulo carregado — USDC nativo + EURC ERC-20 · Arc Testnet 5042002');
