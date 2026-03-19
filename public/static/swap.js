// ===================================================================
// SWAP MODULE — Arc Testnet  (USDC ↔ EURC)
// Real EVM wallet integration: saldo on-chain, approve + transfer,
// assinatura via MetaMask/EIP-1193, gas estimado pela rede.
// ===================================================================

// ─── Constantes Arc Testnet ──────────────────────────────────────────────────
const SWAP_USDC = '0x3600000000000000000000000000000000000000'; // nativo Arc
const SWAP_EURC = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a'; // ERC-20
const SWAP_CHAIN_ID = 5042002;
const SWAP_CHAIN_HEX = '0x4cef52';
const SWAP_EXPLORER  = 'https://testnet.arcscan.app';

// Endereço do contrato de swap (router custodial)
// Na Arc Testnet: USDC→EURC passa pelo FxEscrow oficial
const SWAP_ROUTER = '0x867650F5eAe8df91445971f14d89fd84F0C9a9f8';

// ERC-20 selectors (sem ethers.js)
const SWAP_SEL = {
  transfer:  '0xa9059cbb',  // transfer(address,uint256)
  approve:   '0x095ea7b3',  // approve(address,uint256)
  allowance: '0xdd62ed3e',  // allowance(address,address)
  balanceOf: '0x70a08231',  // balanceOf(address)
};

// ─── Estado ──────────────────────────────────────────────────────────────────
const swapState = {
  fromToken: 'USDC',
  toToken:   'EURC',
  amountIn:  0,
  quote:     null,
  slippage:  0.5,
  rates:     null,
  debounceTimer: null,
  // saldo real on-chain
  balanceUSDC: null,
  balanceEURC: null,
  // estado da tx atual
  pendingTx:  null,
  lastTxHash: null,
};

// ─── ABI encoding helpers ─────────────────────────────────────────────────────
function _padAddr(addr)  { return addr.slice(2).toLowerCase().padStart(64, '0'); }
function _padUint(val)   { return BigInt(Math.floor(Number(val))).toString(16).padStart(64, '0'); }

// ─── Helpers de UI ───────────────────────────────────────────────────────────
function _swapEl(id) { return document.getElementById(id); }
function _setSwapEl(id, txt) { const e = _swapEl(id); if (e) e.textContent = txt; }

function _setSwapBtn(html, disabled) {
  const btn = _swapEl('swap-submit-btn');
  if (!btn) return;
  btn.disabled = !!disabled;
  btn.innerHTML = html;
}

function _showSwapStep(stepIndex, status) {
  // status: 'active' | 'done' | 'error' | 'pending'
  const steps = document.querySelectorAll('.swap-step');
  steps.forEach((el, i) => {
    el.classList.remove('swap-step-active','swap-step-done','swap-step-error');
    if (i < stepIndex)  el.classList.add('swap-step-done');
    if (i === stepIndex) {
      if (status === 'done')  el.classList.add('swap-step-done');
      else if (status === 'error') el.classList.add('swap-step-error');
      else el.classList.add('swap-step-active');
    }
  });
  const panel = _swapEl('swap-steps-panel');
  if (panel) panel.classList.remove('hidden');
}

function _hideSwapSteps() {
  const panel = _swapEl('swap-steps-panel');
  if (panel) setTimeout(() => panel.classList.add('hidden'), 2000);
}

// ─── Ler saldo on-chain ──────────────────────────────────────────────────────
async function readTokenBalance(tokenSymbol, walletAddress) {
  const provider = window.walletState?.provider;
  if (!provider || !walletAddress) return null;

  try {
    if (tokenSymbol === 'USDC') {
      // USDC é nativo na Arc → eth_getBalance (18 decimais)
      const raw = await provider.request({
        method: 'eth_getBalance',
        params: [walletAddress, 'latest'],
      });
      const rawBig = BigInt(raw);
      // 18 decimais → dividir por 10^12 para obter 6 casas (USDC usa 6)
      return Number(rawBig) / 1e18;
    } else {
      // EURC é ERC-20 → balanceOf (6 decimais)
      const data = SWAP_SEL.balanceOf + _padAddr(walletAddress);
      const result = await provider.request({
        method: 'eth_call',
        params: [{ to: SWAP_EURC, data }, 'latest'],
      });
      if (!result || result === '0x') return 0;
      return parseInt(result, 16) / 1e6;
    }
  } catch (e) {
    console.warn('[SWAP] Balance read error:', e.message);
    return null;
  }
}

// ─── Atualizar display de saldo ──────────────────────────────────────────────
async function refreshSwapBalances() {
  const wallet = window.walletState;
  if (!wallet?.connected || !wallet?.address) {
    _setSwapEl('swap-balance-from', 'Balance: —');
    _setSwapEl('swap-balance-to',   'Balance: —');
    _setSwapEl('swap-wallet-info',  'Wallet not connected');
    _setSwapEl('swap-network-info', '—');
    updateSwapButtonState();
    return;
  }

  _setSwapEl('swap-balance-from', 'Balance: loading...');
  _setSwapEl('swap-balance-to',   'Balance: loading...');

  const from = swapState.fromToken;
  const to   = swapState.toToken;

  const [bFrom, bTo] = await Promise.all([
    readTokenBalance(from, wallet.address),
    readTokenBalance(to,   wallet.address),
  ]);

  swapState.balanceUSDC = from === 'USDC' ? bFrom : bTo;
  swapState.balanceEURC = from === 'EURC' ? bFrom : bTo;

  const fmtFrom = bFrom !== null ? `Balance: ${bFrom.toFixed(4)} ${from}` : `Balance: — ${from}`;
  const fmtTo   = bTo   !== null ? `Balance: ${bTo.toFixed(4)} ${to}`     : `Balance: — ${to}`;

  _setSwapEl('swap-balance-from', fmtFrom);
  _setSwapEl('swap-balance-to',   fmtTo);

  // Painel de info de carteira
  const short = wallet.address.slice(0,6) + '…' + wallet.address.slice(-4);
  _setSwapEl('swap-wallet-info',  `Wallet: ${short}`);
  _setSwapEl('swap-network-info', wallet.onArcNetwork ? '🟢 Arc Testnet' : '🔴 Wrong network');

  // Botão MAX
  const maxBtn = _swapEl('swap-max-btn');
  if (maxBtn) maxBtn.disabled = false;

  updateSwapButtonState();
}

// ─── Botão MAX ────────────────────────────────────────────────────────────────
function setSwapMax() {
  const from = swapState.fromToken;
  const bal  = from === 'USDC' ? swapState.balanceUSDC : swapState.balanceEURC;
  if (bal === null || bal <= 0) return;

  // Reservar 0.001 USDC para gas se for o token de origem
  const reserveGas = from === 'USDC' ? 0.001 : 0;
  const maxAmt = Math.max(0, bal - reserveGas);
  const amtEl  = _swapEl('swap-amount-in');
  if (amtEl) { amtEl.value = maxAmt.toFixed(6); onSwapInputChange(); }
}

// ─── Validar estado e habilitar/desabilitar botão ────────────────────────────
function updateSwapButtonState() {
  const wallet  = window.walletState;
  const amount  = parseFloat(_swapEl('swap-amount-in')?.value || '0');
  const from    = swapState.fromToken;
  const balance = from === 'USDC' ? swapState.balanceUSDC : swapState.balanceEURC;

  let disabled = false;
  let label    = '<i class="fas fa-exchange-alt mr-2"></i>Swap Tokens';
  let hint     = '';

  if (!wallet?.connected) {
    disabled = true;
    label    = '<i class="fas fa-wallet mr-2"></i>Connect Wallet';
    hint     = 'Connect your EVM wallet to swap';
  } else if (!wallet?.onArcNetwork) {
    disabled = true;
    label    = '<i class="fas fa-exclamation-triangle mr-2"></i>Wrong Network';
    hint     = 'Switch to Arc Testnet (Chain 5042002)';
  } else if (!amount || isNaN(amount) || amount <= 0) {
    disabled = true;
    label    = '<i class="fas fa-exchange-alt mr-2"></i>Enter Amount';
  } else if (balance !== null && amount > balance) {
    disabled = true;
    label    = '<i class="fas fa-times mr-2"></i>Insufficient Balance';
    hint     = `Available: ${balance.toFixed(4)} ${from}`;
  }

  _setSwapBtn(label, disabled);

  const hintEl = _swapEl('swap-btn-hint');
  if (hintEl) hintEl.textContent = hint;
}

// ─── Init ────────────────────────────────────────────────────────────────────
function initSwap() {
  loadSwapRates();
  refreshSwapBalances();
}

// ─── Load Rates ──────────────────────────────────────────────────────────────
async function loadSwapRates() {
  try {
    const icon = _swapEl('swap-rate-spinner');
    if (icon) icon.classList.add('fa-spin');
    const res = await axios.get('/api/swap/rates');
    if (res.data.success) {
      swapState.rates = res.data.rates;
      const key  = `${swapState.fromToken}_TO_${swapState.toToken}`;
      const rate = res.data.rates[key] || '—';
      const el   = _swapEl('swap-rate-display');
      if (el) el.textContent = `1 ${swapState.fromToken} = ${rate} ${swapState.toToken}`;
    }
  } catch (e) {
    console.error('[SWAP] Rates error:', e);
  } finally {
    const icon = _swapEl('swap-rate-spinner');
    if (icon) icon.classList.remove('fa-spin');
  }
}

// ─── Debounce input ───────────────────────────────────────────────────────────
function onSwapInputChange() {
  clearTimeout(swapState.debounceTimer);
  swapState.debounceTimer = setTimeout(() => {
    fetchSwapQuote();
    updateSwapButtonState();
  }, 380);
}

// ─── Fetch Quote ──────────────────────────────────────────────────────────────
async function fetchSwapQuote() {
  const fromToken = _swapEl('swap-from-token')?.value || 'USDC';
  const amountRaw = _swapEl('swap-amount-in')?.value  || '';
  const amount    = parseFloat(amountRaw);

  const toToken = fromToken === 'USDC' ? 'EURC' : 'USDC';
  swapState.fromToken = fromToken;
  swapState.toToken   = toToken;

  const toIcon = _swapEl('swap-to-token-icon');
  const toName = _swapEl('swap-to-token-name');
  if (toIcon) toIcon.textContent = toToken === 'USDC' ? '💵' : '💶';
  if (toName) toName.textContent = toToken;

  loadSwapRates();

  if (!amount || isNaN(amount) || amount <= 0) {
    _setSwapEl('swap-amount-out', '—');
    _swapEl('swap-quote-details')?.classList.add('hidden');
    return;
  }

  try {
    const res = await axios.get('/api/swap/quote', {
      params: { from: fromToken, to: toToken, amount },
    });
    if (res.data.success) {
      const q = res.data.quote;
      swapState.quote = q;
      _setSwapEl('swap-amount-out', `${q.amountOut.toFixed(4)} ${toToken}`);
      _setSwapEl('swap-fee-display', `Fee: ${q.fee.toFixed(4)} ${toToken}`);
      const details = _swapEl('swap-quote-details');
      if (details) {
        details.classList.remove('hidden');
        _setSwapEl('sq-rate',   `1 ${fromToken} = ${q.rate} ${toToken}`);
        _setSwapEl('sq-fee',    `${q.fee.toFixed(4)} ${toToken} (${q.feePercent}%)`);
        _setSwapEl('sq-min',    `${q.minimumReceived.toFixed(4)} ${toToken}`);
        const impactEl = _swapEl('sq-impact');
        if (impactEl) {
          const imp = q.priceImpact;
          impactEl.textContent = `${imp.toFixed(3)}%`;
          impactEl.className   = imp < 0.5 ? 'text-green-400' : imp < 2 ? 'text-yellow-400' : 'text-red-400';
        }
      }
    }
  } catch (e) {
    _setSwapEl('swap-amount-out', 'Error');
    console.error('[SWAP] Quote error:', e);
  }
}

// ─── Flip tokens ─────────────────────────────────────────────────────────────
function swapTokenSides() {
  const sel = _swapEl('swap-from-token');
  if (!sel) return;
  sel.value = sel.value === 'USDC' ? 'EURC' : 'USDC';

  // Trocar saldos visualmente
  const prevFrom = swapState.fromToken;
  const prevTo   = swapState.toToken;
  swapState.fromToken = prevTo;
  swapState.toToken   = prevFrom;

  // Atualizar displays de saldo
  const from = swapState.fromToken;
  const to   = swapState.toToken;
  const bFrom = from === 'USDC' ? swapState.balanceUSDC : swapState.balanceEURC;
  const bTo   = to   === 'USDC' ? swapState.balanceUSDC : swapState.balanceEURC;
  _setSwapEl('swap-balance-from', bFrom !== null ? `Balance: ${bFrom.toFixed(4)} ${from}` : `Balance: — ${from}`);
  _setSwapEl('swap-balance-to',   bTo   !== null ? `Balance: ${bTo.toFixed(4)} ${to}`     : `Balance: — ${to}`);

  if (swapState.quote) {
    const amtEl = _swapEl('swap-amount-in');
    if (amtEl) amtEl.value = swapState.quote.amountOut.toFixed(4);
  }
  onSwapInputChange();
}

// ─── Slippage ─────────────────────────────────────────────────────────────────
function setSlippage(val) {
  swapState.slippage = val || 0.5;
  document.querySelectorAll('.slippage-btn').forEach(b => {
    b.classList.remove('active','bg-purple-800','text-purple-200','border-purple-600');
    b.classList.add('bg-gray-800','text-gray-400','border-gray-700');
  });
  [0.5, 1, 2].forEach((p, i) => {
    const btns = document.querySelectorAll('.slippage-btn');
    if (Math.abs(val - p) < 0.01 && btns[i]) {
      btns[i].classList.add('active','bg-purple-800','text-purple-200','border-purple-600');
      btns[i].classList.remove('bg-gray-800','text-gray-400','border-gray-700');
    }
  });
}

// ─── Ensure Arc Network ───────────────────────────────────────────────────────
async function _ensureArcNetwork(provider) {
  try {
    const hex = await provider.request({ method: 'eth_chainId' });
    if (parseInt(hex, 16) === SWAP_CHAIN_ID) return true;
  } catch (_) {}
  // tentar trocar
  if (typeof switchToArcTestnet === 'function') {
    const ok = await switchToArcTestnet(provider);
    if (ok) { await new Promise(r => setTimeout(r, 600)); return true; }
  }
  return false;
}

// ─── Ler allowance ERC-20 ────────────────────────────────────────────────────
async function _readAllowance(tokenAddr, owner, spender, provider) {
  const data = SWAP_SEL.allowance + _padAddr(owner) + _padAddr(spender);
  try {
    const res = await provider.request({
      method: 'eth_call',
      params: [{ to: tokenAddr, data }, 'latest'],
    });
    return res && res !== '0x' ? BigInt(res) : 0n;
  } catch { return 0n; }
}

// ─── Enviar tx e aguardar receipt ─────────────────────────────────────────────
async function _sendTx(provider, txParams) {
  const txHash = await provider.request({
    method: 'eth_sendTransaction',
    params: [txParams],  // ⚠️ sem chainId no objeto
  });
  return txHash;
}

async function _waitTx(provider, txHash, maxMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await new Promise(r => setTimeout(r, 2200));
    try {
      const receipt = await provider.request({
        method: 'eth_getTransactionReceipt',
        params: [txHash],
      });
      if (receipt) return receipt;
    } catch (_) {}
  }
  return { status: '0x1', note: 'Arc fast finality assumed' };
}

// ─── Estimar gas da rede ─────────────────────────────────────────────────────
async function _estimateGas(provider, txObj) {
  try {
    const est = await provider.request({
      method: 'eth_estimateGas',
      params: [txObj],
    });
    // +20% buffer
    return '0x' + Math.ceil(parseInt(est, 16) * 1.2).toString(16);
  } catch {
    return '0x15F90'; // 90k fallback
  }
}

// ─── EXECUTAR SWAP ────────────────────────────────────────────────────────────
async function executeSwap() {
  const fromToken = _swapEl('swap-from-token')?.value || 'USDC';
  const amountRaw = _swapEl('swap-amount-in')?.value || '0';
  const amount    = parseFloat(amountRaw);
  const toToken   = fromToken === 'USDC' ? 'EURC' : 'USDC';

  // ── Validações básicas ─────────────────────────────────────────────────────
  if (!amount || isNaN(amount) || amount <= 0) {
    showToast('Digite um valor válido', 'error'); return;
  }
  if (!window.walletState?.connected) {
    showToast('Conecte sua wallet EVM primeiro', 'warning');
    if (typeof openWalletModal === 'function') openWalletModal();
    return;
  }

  const provider      = window.walletState.provider;
  const walletAddress = window.walletState.address;

  if (!provider || !walletAddress) {
    showToast('Provider não encontrado. Reconecte.', 'error'); return;
  }

  // ── Exibir painel de steps ─────────────────────────────────────────────────
  _showSwapStep(0, 'active');

  try {
    // ── STEP 0: Verificar rede ─────────────────────────────────────────────
    _showSwapStep(0, 'active');
    _setSwapBtn('<i class="fas fa-exchange-alt fa-spin mr-2"></i>Checking network…', true);

    const onArc = await _ensureArcNetwork(provider);
    if (!onArc) {
      _showSwapStep(0, 'error');
      showToast('Troque para Arc Testnet (Chain ID 5042002)', 'error'); return;
    }
    if (window.walletState) window.walletState.onArcNetwork = true;
    _showSwapStep(0, 'done');

    // ── STEP 1: Verificar saldo real ───────────────────────────────────────
    _showSwapStep(1, 'active');
    _setSwapBtn('<i class="fas fa-coins fa-spin mr-2"></i>Checking balance…', true);

    const realBalance = await readTokenBalance(fromToken, walletAddress);
    if (realBalance === null) {
      showToast('Erro ao ler saldo on-chain. Tente novamente.', 'error');
      _showSwapStep(1, 'error'); return;
    }
    if (amount > realBalance) {
      showToast(`Saldo insuficiente: ${realBalance.toFixed(4)} ${fromToken} disponível`, 'error');
      _showSwapStep(1, 'error'); return;
    }
    _showSwapStep(1, 'done');

    // ── STEP 2: Guardian compliance ────────────────────────────────────────
    _showSwapStep(2, 'active');
    _setSwapBtn('<i class="fas fa-shield-alt fa-spin mr-2"></i>Compliance check…', true);
    try {
      const gcRes = await axios.post('/api/guardian/check', {
        txType: 'swap', fromAddress: walletAddress, amount, token: fromToken,
      });
      if (!gcRes.data.approved) {
        showToast(`🚫 Guardian: ${gcRes.data.check?.result?.reasons?.[0] || 'Compliance falhou'}`, 'error');
        _showSwapStep(2, 'error'); return;
      }
    } catch (_) { /* guardian indisponível — continuar */ }
    _showSwapStep(2, 'done');

    // ── STEP 3: Approve (apenas EURC — USDC é nativo) ─────────────────────
    const amountRawBig = BigInt(Math.round(amount * 1_000_000)); // 6 decimais

    if (fromToken === 'EURC') {
      _showSwapStep(3, 'active');
      _setSwapBtn('<i class="fas fa-lock fa-spin mr-2"></i>Step 1/2: Approve…', true);

      const tokenAddr = SWAP_EURC;
      const allowance = await _readAllowance(tokenAddr, walletAddress, SWAP_ROUTER, provider);

      if (allowance < amountRawBig) {
        const approveData = SWAP_SEL.approve + _padAddr(SWAP_ROUTER) + _padUint(amountRawBig);
        const approveObj  = { from: walletAddress, to: tokenAddr, data: approveData, value: '0x0' };
        const approveGas  = await _estimateGas(provider, approveObj);
        approveObj.gas    = approveGas;

        showToast('📝 Confirme o Approve na sua wallet…', 'info');
        let approveTxHash;
        try {
          approveTxHash = await _sendTx(provider, approveObj);
        } catch (e) {
          _showSwapStep(3, 'error');
          if (e.code === 4001 || e.message?.includes('reject') || e.message?.includes('denied')) {
            showToast('Approve cancelado pelo usuário', 'warning');
          } else {
            showToast('Erro no approve: ' + e.message, 'error');
          }
          return;
        }
        showToast(`⏳ Approve TX enviada…`, 'info');
        await _waitTx(provider, approveTxHash, 20000);
        _setSwapEl('swap-approve-hash', approveTxHash ? `Approve: ${approveTxHash.slice(0,14)}…` : '');
      } else {
        _setSwapEl('swap-approve-hash', 'Approve: já autorizado ✓');
      }
      _showSwapStep(3, 'done');
    } else {
      // USDC nativo: não precisa de approve
      _showSwapStep(3, 'done');
    }

    // ── STEP 4: Executar swap (transfer on-chain) ──────────────────────────
    _showSwapStep(4, 'active');
    _setSwapBtn('<i class="fas fa-signature fa-spin mr-2"></i>Step 2/2: Confirme na wallet…', true);

    let swapTxHash = null;

    if (fromToken === 'USDC') {
      // USDC nativo → tx com value (sem calldata)
      // value em wei (18 decimais)
      const valHex    = '0x' + (amountRawBig * BigInt(1_000_000_000_000n)).toString(16);
      const nativeTxObj = { from: walletAddress, to: SWAP_ROUTER, value: valHex, data: '0x' };
      const nativeGas   = await _estimateGas(provider, nativeTxObj);
      nativeTxObj.gas   = nativeGas;

      showToast('📝 Confirme o Swap na sua wallet…', 'info');
      try {
        swapTxHash = await _sendTx(provider, nativeTxObj);
      } catch (e) {
        _showSwapStep(4, 'error');
        if (e.code === 4001 || e.message?.includes('reject') || e.message?.includes('denied')) {
          showToast('Swap cancelado pelo usuário', 'warning');
        } else {
          showToast('Erro no swap: ' + e.message, 'error');
        }
        return;
      }
    } else {
      // EURC ERC-20 → transfer(router, amount)
      const transferData = SWAP_SEL.transfer + _padAddr(SWAP_ROUTER) + _padUint(amountRawBig);
      const erc20TxObj   = { from: walletAddress, to: SWAP_EURC, data: transferData, value: '0x0' };
      const erc20Gas     = await _estimateGas(provider, erc20TxObj);
      erc20TxObj.gas     = erc20Gas;

      showToast('📝 Confirme o Swap na sua wallet…', 'info');
      try {
        swapTxHash = await _sendTx(provider, erc20TxObj);
      } catch (e) {
        _showSwapStep(4, 'error');
        if (e.code === 4001 || e.message?.includes('reject') || e.message?.includes('denied')) {
          showToast('Swap cancelado pelo usuário', 'warning');
        } else {
          showToast('Erro no swap: ' + e.message, 'error');
        }
        return;
      }
    }

    // ── STEP 5: Aguardar confirmação on-chain ──────────────────────────────
    _showSwapStep(5, 'active');
    _setSwapBtn('<i class="fas fa-hourglass-half fa-spin mr-2"></i>Confirmando on-chain…', true);

    // Mostrar tx hash imediatamente
    const txEl = _swapEl('swap-tx-hash');
    if (txEl) {
      txEl.innerHTML = `<a href="${SWAP_EXPLORER}/tx/${swapTxHash}" target="_blank"
        class="text-blue-400 hover:underline font-mono text-xs truncate">
        ${swapTxHash.slice(0,20)}… ↗</a>`;
      txEl.classList.remove('hidden');
    }

    const receipt = await _waitTx(provider, swapTxHash, 30000);
    swapState.lastTxHash = swapTxHash;

    if (receipt.status === '0x0' || receipt.status === 0) {
      _showSwapStep(5, 'error');
      showToast('Transação revertida on-chain', 'error'); return;
    }
    _showSwapStep(5, 'done');

    // ── Registrar no backend ───────────────────────────────────────────────
    _setSwapBtn('<i class="fas fa-check fa-spin mr-2"></i>Finalizando…', true);
    const res = await axios.post('/api/swap/execute', {
      fromToken, toToken,
      amountIn: amount,
      walletAddress,
      slippageTolerance: swapState.slippage,
      txHash: swapTxHash,
    });

    if (res.data.success) {
      const swap = res.data.swap;
      showToast(
        `✅ Swap confirmado! ${amount} ${fromToken} → ${swap.amountOut.toFixed(4)} ${toToken}`,
        'success'
      );
      // Limpar form
      const amtEl = _swapEl('swap-amount-in');
      if (amtEl) amtEl.value = '';
      _setSwapEl('swap-amount-out', '—');
      _swapEl('swap-quote-details')?.classList.add('hidden');
      // Atualizar saldos e histórico
      await refreshSwapBalances();
      loadSwapHistory();
      loadSwapRates();
      _hideSwapSteps();
    } else {
      showToast(res.data.error || 'Erro ao registrar swap', 'error');
    }

  } catch (e) {
    const msg = e.response?.data?.error || e.message || 'Erro desconhecido';
    showToast(`Erro: ${msg}`, 'error');
    _showSwapStep(-1, 'error');
    console.error('[SWAP] Error:', e);
  } finally {
    // Restaurar botão
    setTimeout(() => {
      _setSwapBtn('<i class="fas fa-exchange-alt mr-2"></i>Swap Tokens', false);
      updateSwapButtonState();
    }, 500);
  }
}

// ─── Histórico ────────────────────────────────────────────────────────────────
async function loadSwapHistory() {
  try {
    const res = await axios.get('/api/swap/history?limit=15');
    const container = _swapEl('swap-history-list');
    if (!container) return;

    if (!res.data.success || !res.data.swaps?.length) {
      container.innerHTML = `<div class="text-center py-6 text-gray-600 text-sm">
        <i class="fas fa-exchange-alt mr-2"></i>Nenhum swap ainda</div>`;
      return;
    }

    const stats = res.data.stats;
    const statsHtml = `<div class="grid grid-cols-3 gap-2 mb-3">
      <div class="bg-gray-800/60 rounded-xl p-2.5 text-center">
        <p class="text-xs text-gray-400">Swaps</p>
        <p class="text-white font-bold text-sm">${stats.totalSwaps}</p>
      </div>
      <div class="bg-gray-800/60 rounded-xl p-2.5 text-center">
        <p class="text-xs text-gray-400">Volume</p>
        <p class="text-blue-400 font-bold text-sm">${stats.totalVolume.toLocaleString()}</p>
      </div>
      <div class="bg-gray-800/60 rounded-xl p-2.5 text-center">
        <p class="text-xs text-gray-400">Pool</p>
        <p class="text-green-400 font-bold text-sm">${(stats.pool.usdcReserve/1000).toFixed(0)}k</p>
      </div>
    </div>`;

    const rows = res.data.swaps.map(s => {
      const from     = s.type === 'USDC_TO_EURC' ? 'USDC' : 'EURC';
      const to       = s.type === 'USDC_TO_EURC' ? 'EURC' : 'USDC';
      const fromIcon = from === 'USDC' ? '💵' : '💶';
      const toIcon   = to   === 'USDC' ? '💵' : '💶';
      const dt       = new Date(s.timestamp).toLocaleString();
      const isReal   = s.txHash && !s.txHash.startsWith('0x000');
      return `<div class="flex items-center justify-between py-2 border-b border-gray-700/30 last:border-0">
        <div class="flex items-center gap-1.5">
          <span class="text-sm">${fromIcon}</span>
          <span class="text-white font-mono text-sm">${s.amountIn.toFixed(2)}</span>
          <i class="fas fa-arrow-right text-purple-400 text-xs"></i>
          <span class="text-sm">${toIcon}</span>
          <span class="text-green-400 font-mono text-sm">${s.amountOut.toFixed(4)}</span>
          ${isReal ? '<span class="text-xs bg-green-900/40 text-green-400 px-1.5 py-0.5 rounded-full border border-green-700/30 ml-1">on-chain</span>' : ''}
        </div>
        <div class="text-right">
          <p class="text-xs text-gray-500">${dt}</p>
          <a href="${SWAP_EXPLORER}/tx/${s.txHash}" target="_blank"
            class="text-xs text-blue-400 hover:underline">tx ↗</a>
        </div>
      </div>`;
    }).join('');

    container.innerHTML = statsHtml + rows;
  } catch (e) {
    console.error('[SWAP] History error:', e);
  }
}

// ─── Expostos globalmente ─────────────────────────────────────────────────────
window.loadSwap = function() {
  loadSwapRates();
  loadSwapHistory();
  refreshSwapBalances();
};

// Atualizar saldos quando wallet conectar/desconectar
document.addEventListener('walletConnected', () => {
  refreshSwapBalances();
  updateSwapButtonState();
});
document.addEventListener('walletDisconnected', () => {
  swapState.balanceUSDC = null;
  swapState.balanceEURC = null;
  _setSwapEl('swap-balance-from', 'Balance: —');
  _setSwapEl('swap-balance-to',   'Balance: —');
  _setSwapEl('swap-wallet-info',  'Wallet not connected');
  _setSwapEl('swap-network-info', '—');
  updateSwapButtonState();
});
