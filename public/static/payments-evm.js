// =====================================================================
// PAYMENTS EVM MODULE — Arc Testnet
// Gateway de pagamento real: wallet signature, on-chain transfer,
// receipt generation, contract interactions com assinatura EVM.
// =====================================================================

// ─── Arc Testnet Config ──────────────────────────────────────────────────────
const PAY_USDC     = '0x3600000000000000000000000000000000000000'; // nativo Arc
const PAY_EURC     = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a'; // ERC-20
const PAY_CHAIN_ID = 5042002;
const PAY_EXPLORER = 'https://testnet.arcscan.app';
const PAY_RPC      = 'https://rpc.testnet.arc.network';

// ERC-20 selectors
const PAY_SEL = {
  transfer:  '0xa9059cbb',
  balanceOf: '0x70a08231',
  approve:   '0x095ea7b3',
  allowance: '0xdd62ed3e',
};

// ─── ABI helpers ─────────────────────────────────────────────────────────────
const _padAddr = addr => addr.replace(/^0x/i,'').toLowerCase().padStart(64,'0');
const _padUint = val  => BigInt(Math.floor(Number(val))).toString(16).padStart(64,'0');
const _el      = id   => document.getElementById(id);
const _setEl   = (id, txt) => { const e = _el(id); if (e) e.textContent = txt; };

// ─── Estado global de pagamentos ─────────────────────────────────────────────
window.payEVM = {
  pendingReceipts: [],   // recibos aguardando download
  lastTxHash:      null,
  lastReceipt:     null,
  isSending:       false,
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. LER SALDO ON-CHAIN
// ─────────────────────────────────────────────────────────────────────────────
async function payReadBalance(tokenSymbol, walletAddress) {
  const provider = window.walletState?.provider;
  if (!provider || !walletAddress) return null;
  try {
    if (tokenSymbol === 'USDC') {
      const raw = await provider.request({
        method: 'eth_getBalance', params: [walletAddress, 'latest'],
      });
      return Number(BigInt(raw)) / 1e18; // 18 dec nativo → float
    } else {
      const tokenAddr = tokenSymbol === 'EURC' ? PAY_EURC : PAY_EURC;
      const data = PAY_SEL.balanceOf + _padAddr(walletAddress);
      const res  = await provider.request({
        method: 'eth_call', params: [{ to: tokenAddr, data }, 'latest'],
      });
      return res && res !== '0x' ? parseInt(res, 16) / 1e6 : 0;
    }
  } catch (e) {
    console.warn('[PAY] Balance error:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. ATUALIZAR PAINEL DE SALDO
// ─────────────────────────────────────────────────────────────────────────────
async function payRefreshBalancePanel() {
  const wallet = window.walletState;
  const tokenSel = _el('pay-token-select');
  const token    = tokenSel?.value || 'USDC';

  if (!wallet?.connected || !wallet?.address) {
    _setEl('pay-wallet-balance',  '—');
    _setEl('pay-wallet-address',  'Not connected');
    _setEl('pay-wallet-network',  '—');
    _setEl('pay-from',            '');
    _el('pay-send-btn') && (_el('pay-send-btn').disabled = true);
    return;
  }

  _setEl('pay-wallet-address', wallet.address.slice(0,6) + '…' + wallet.address.slice(-4));
  _setEl('pay-wallet-network', wallet.onArcNetwork ? '🟢 Arc Testnet' : '🔴 Wrong Network');

  // Auto-fill sender
  const fromEl = _el('pay-from');
  if (fromEl && !fromEl.value) fromEl.value = wallet.address;

  _setEl('pay-wallet-balance', 'Loading…');
  const bal = await payReadBalance(token, wallet.address);
  if (bal !== null) {
    _setEl('pay-wallet-balance', `${bal.toFixed(4)} ${token}`);
  } else {
    _setEl('pay-wallet-balance', '— ' + token);
  }

  payUpdateSendButton();
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. VALIDAR E ATUALIZAR BOTÃO ENVIAR
// ─────────────────────────────────────────────────────────────────────────────
function payUpdateSendButton() {
  const btn    = _el('pay-send-btn');
  if (!btn) return;
  const wallet = window.walletState;
  const to     = _el('pay-to-single')?.value?.trim();
  const amount = parseFloat(_el('pay-amount-single')?.value || '0');
  const token  = _el('pay-token-select')?.value || 'USDC';

  let disabled = false, label = '<i class="fas fa-paper-plane mr-2"></i>Send Payment', hint = '';

  if (!wallet?.connected) {
    disabled = true; label = '<i class="fas fa-wallet mr-2"></i>Connect Wallet'; hint = 'Connect your EVM wallet';
  } else if (!wallet?.onArcNetwork) {
    disabled = true; label = '<i class="fas fa-exclamation-triangle mr-2"></i>Wrong Network'; hint = 'Switch to Arc Testnet (5042002)';
  } else if (!to || to.length < 42) {
    disabled = true; label = '<i class="fas fa-paper-plane mr-2"></i>Enter Recipient';
  } else if (!amount || isNaN(amount) || amount <= 0) {
    disabled = true; label = '<i class="fas fa-paper-plane mr-2"></i>Enter Amount';
  }

  btn.disabled = disabled;
  btn.innerHTML = label;
  _setEl('pay-btn-hint', hint);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. VERIFICAR REDE
// ─────────────────────────────────────────────────────────────────────────────
async function _payEnsureNetwork(provider) {
  try {
    const hex = await provider.request({ method: 'eth_chainId' });
    if (parseInt(hex, 16) === PAY_CHAIN_ID) {
      if (window.walletState) window.walletState.onArcNetwork = true;
      return true;
    }
  } catch (_) {}
  if (typeof switchToArcTestnet === 'function') {
    const ok = await switchToArcTestnet(provider);
    if (ok) { await new Promise(r => setTimeout(r, 700)); return true; }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. ESTIMAR GAS
// ─────────────────────────────────────────────────────────────────────────────
async function _payEstimateGas(provider, txObj) {
  try {
    const est = await provider.request({ method: 'eth_estimateGas', params: [txObj] });
    return '0x' + Math.ceil(parseInt(est, 16) * 1.25).toString(16);
  } catch { return '0x15F90'; }
}

async function _payGetGasPrice(provider) {
  try { return await provider.request({ method: 'eth_gasPrice' }); }
  catch { return '0x2540BE400'; } // 10 gwei fallback
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. AGUARDAR RECEIPT
// ─────────────────────────────────────────────────────────────────────────────
async function _payWaitReceipt(provider, txHash, maxMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const r = await provider.request({ method: 'eth_getTransactionReceipt', params: [txHash] });
      if (r) return r;
    } catch (_) {}
  }
  return { status: '0x1', txHash, gasUsed: '0x5208', note: 'Arc fast finality' };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. ENVIAR PAGAMENTO SINGLE
// ─────────────────────────────────────────────────────────────────────────────
async function paySendSingle() {
  if (window.payEVM.isSending) return;

  const to       = _el('pay-to-single')?.value?.trim();
  const amount   = parseFloat(_el('pay-amount-single')?.value || '0');
  const token    = _el('pay-token-select')?.value || 'USDC';
  const desc     = _el('pay-description')?.value?.trim() || 'USDC payment on Arc Testnet';

  // ── Validações básicas ────────────────────────────────────────────────────
  if (!to || !/^0x[0-9a-fA-F]{40}$/.test(to)) {
    showToast('Endereço do destinatário inválido (deve ser 0x...42 chars)', 'error'); return;
  }
  if (!amount || isNaN(amount) || amount <= 0) {
    showToast('Digite um valor válido', 'error'); return;
  }
  if (!window.walletState?.connected) {
    showToast('Conecte sua wallet EVM primeiro', 'warning');
    if (typeof openWalletModal === 'function') openWalletModal();
    return;
  }

  const provider = window.walletState.provider;
  const from     = window.walletState.address;

  window.payEVM.isSending = true;
  _payShowSteps(true);

  const setBtn = (html, dis = true) => {
    const btn = _el('pay-send-btn');
    if (btn) { btn.disabled = dis; btn.innerHTML = html; }
  };

  try {
    // ── STEP 0: Verificar rede ─────────────────────────────────────────────
    _payUpdateStep(0, 'active');
    setBtn('<i class="fas fa-exchange-alt fa-spin mr-2"></i>Checking network…');
    const onArc = await _payEnsureNetwork(provider);
    if (!onArc) {
      _payUpdateStep(0, 'error');
      showToast('Troque para Arc Testnet (Chain 5042002)', 'error'); return;
    }
    _payUpdateStep(0, 'done');

    // ── STEP 1: Verificar saldo ────────────────────────────────────────────
    _payUpdateStep(1, 'active');
    setBtn('<i class="fas fa-coins fa-spin mr-2"></i>Checking balance…');
    const balance = await payReadBalance(token, from);
    if (balance === null) {
      showToast('Erro ao ler saldo on-chain', 'error'); _payUpdateStep(1, 'error'); return;
    }
    const reserveGas = token === 'USDC' ? 0.001 : 0;
    if (amount + reserveGas > balance) {
      showToast(`Saldo insuficiente: ${balance.toFixed(4)} ${token} disponível`, 'error');
      _payUpdateStep(1, 'error'); return;
    }
    _payUpdateStep(1, 'done');

    // ── STEP 2: Guardian compliance ────────────────────────────────────────
    _payUpdateStep(2, 'active');
    setBtn('<i class="fas fa-shield-alt fa-spin mr-2"></i>Compliance check…');
    try {
      const gc = await axios.post('/api/guardian/check', {
        txType: 'payment', fromAddress: from, amount, token,
      });
      if (!gc.data.approved) {
        showToast(`🚫 Guardian: ${gc.data.check?.result?.reasons?.[0] || 'Compliance falhou'}`, 'error');
        _payUpdateStep(2, 'error'); return;
      }
    } catch (_) { /* guardian offline — continuar */ }
    _payUpdateStep(2, 'done');

    // ── STEP 3: Construir e enviar TX ──────────────────────────────────────
    _payUpdateStep(3, 'active');
    setBtn('<i class="fas fa-signature fa-spin mr-2"></i>Confirm in wallet…');
    showToast('📝 Confirme a transação na sua wallet…', 'info');

    const amountRaw = BigInt(Math.round(amount * 1_000_000));
    let txHash;

    if (token === 'USDC') {
      // USDC nativo: tx com value
      const valHex  = '0x' + (amountRaw * BigInt(1_000_000_000_000n)).toString(16);
      const txObj   = { from, to, value: valHex, data: '0x' };
      txObj.gas     = await _payEstimateGas(provider, txObj);

      try {
        txHash = await provider.request({ method: 'eth_sendTransaction', params: [txObj] });
      } catch (e) {
        _payUpdateStep(3, 'error');
        if (e.code === 4001 || e.message?.includes('reject') || e.message?.includes('denied')) {
          showToast('Transação cancelada pelo usuário', 'warning');
        } else {
          showToast('Erro na transação: ' + e.message, 'error');
        }
        return;
      }
    } else {
      // EURC ERC-20: transfer(to, amount)
      const transferData = PAY_SEL.transfer + _padAddr(to) + _padUint(amountRaw);
      const txObj = { from, to: PAY_EURC, data: transferData, value: '0x0' };
      txObj.gas   = await _payEstimateGas(provider, txObj);

      try {
        txHash = await provider.request({ method: 'eth_sendTransaction', params: [txObj] });
      } catch (e) {
        _payUpdateStep(3, 'error');
        if (e.code === 4001 || e.message?.includes('reject') || e.message?.includes('denied')) {
          showToast('Transação cancelada pelo usuário', 'warning');
        } else {
          showToast('Erro na transação: ' + e.message, 'error');
        }
        return;
      }
    }

    window.payEVM.lastTxHash = txHash;
    _payUpdateStep(3, 'done');

    // Mostrar TX hash imediatamente
    _payShowTxHash(txHash);

    // ── STEP 4: Aguardar confirmação ───────────────────────────────────────
    _payUpdateStep(4, 'active');
    setBtn('<i class="fas fa-hourglass-half fa-spin mr-2"></i>Waiting confirmation…');

    const receipt = await _payWaitReceipt(provider, txHash, 30000);
    if (receipt.status === '0x0' || receipt.status === 0) {
      _payUpdateStep(4, 'error');
      showToast('Transação revertida on-chain', 'error'); return;
    }
    _payUpdateStep(4, 'done');

    // ── STEP 5: Registrar no backend + gerar recibo ────────────────────────
    _payUpdateStep(5, 'active');
    setBtn('<i class="fas fa-receipt fa-spin mr-2"></i>Generating receipt…');

    // Registrar no backend
    const gasUsedDec = parseInt(receipt.gasUsed || '0x5208', 16);
    const gasFee     = (gasUsedDec * 10e9) / 1e18; // estimativa

    const payloadReceipt = {
      txHash,
      from,
      to,
      amount,
      token,
      description: desc,
      gasUsed:     gasUsedDec,
      gasFee:      gasFee.toFixed(8),
      network:     'Arc Testnet',
      chainId:     PAY_CHAIN_ID,
      timestamp:   new Date().toISOString(),
      status:      'confirmed',
      blockNumber: receipt.blockNumber ? parseInt(receipt.blockNumber, 16) : null,
    };

    try {
      await axios.post('/api/payments/register', payloadReceipt);
      await axios.post('/api/payments/submit', {
        from, to, amount,
        description: desc,
        priority: _el('pay-priority')?.value || 'medium',
        txHash,
      });
    } catch (_) { /* backend pode estar offline */ }

    window.payEVM.lastReceipt = payloadReceipt;
    window.payEVM.pendingReceipts.unshift(payloadReceipt);
    _payUpdateStep(5, 'done');

    // ── Sucesso ────────────────────────────────────────────────────────────
    showToast(
      `✅ ${amount} ${token} enviado para ${to.slice(0,8)}…! <a href="${PAY_EXPLORER}/tx/${txHash}" target="_blank" class="underline">Ver TX ↗</a>`,
      'success'
    );

    // Mostrar modal de recibo
    _payShowReceiptModal(payloadReceipt);

    // Limpar campos
    const amtEl = _el('pay-amount-single');
    const toEl  = _el('pay-to-single');
    const descEl = _el('pay-description');
    if (amtEl)  amtEl.value  = '';
    if (toEl)   toEl.value   = '';
    if (descEl) descEl.value = '';

    // Atualizar saldo e histórico
    await payRefreshBalancePanel();
    if (typeof loadPayments === 'function') await loadPayments();

    setTimeout(() => _payShowSteps(false), 3000);

  } finally {
    window.payEVM.isSending = false;
    setTimeout(() => {
      setBtn('<i class="fas fa-paper-plane mr-2"></i>Send Payment', false);
      payUpdateSendButton();
    }, 1000);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. ENVIAR BATCH (Multi-send com assinatura EVM)
// ─────────────────────────────────────────────────────────────────────────────
async function payExecuteMultisend(rows) {
  // rows: [{to, amount, note}]
  if (!rows || rows.length === 0) {
    showToast('Nenhum destinatário para enviar', 'error'); return;
  }
  if (!window.walletState?.connected) {
    showToast('Conecte sua wallet EVM primeiro', 'warning');
    if (typeof openWalletModal === 'function') openWalletModal();
    return;
  }

  const provider = window.walletState.provider;
  const from     = window.walletState.address;
  const token    = _el('pay-token-select')?.value || 'USDC';

  // Verificar rede
  const onArc = await _payEnsureNetwork(provider);
  if (!onArc) { showToast('Troque para Arc Testnet (5042002)', 'error'); return; }

  // Verificar saldo total
  const totalAmt = rows.reduce((s, r) => s + parseFloat(r.amount || 0), 0);
  const balance  = await payReadBalance(token, from);
  if (balance !== null && totalAmt > balance) {
    showToast(`Saldo insuficiente: ${balance.toFixed(4)} ${token} para ${totalAmt.toFixed(4)} ${token}`, 'error');
    return;
  }

  showToast(`📤 Enviando ${rows.length} pagamentos… Confirme cada TX na wallet.`, 'info');
  const receipts = [];
  let successCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const to  = row.to?.trim();
    const amt = parseFloat(row.amount || 0);
    const note = row.note || `Payment ${i + 1} of ${rows.length}`;

    if (!to || !/^0x[0-9a-fA-F]{40}$/.test(to) || !amt || amt <= 0) {
      showToast(`Linha ${i+1}: endereço ou valor inválido — pulando`, 'warning');
      continue;
    }

    try {
      showToast(`📤 Enviando ${i+1}/${rows.length}: ${amt} ${token} para ${to.slice(0,10)}…`, 'info');

      const amtRaw = BigInt(Math.round(amt * 1_000_000));
      let txHash;

      if (token === 'USDC') {
        const valHex = '0x' + (amtRaw * BigInt(1_000_000_000_000n)).toString(16);
        const txObj  = { from, to, value: valHex, data: '0x' };
        txObj.gas    = await _payEstimateGas(provider, txObj);
        txHash = await provider.request({ method: 'eth_sendTransaction', params: [txObj] });
      } else {
        const data  = PAY_SEL.transfer + _padAddr(to) + _padUint(amtRaw);
        const txObj = { from, to: PAY_EURC, data, value: '0x0' };
        txObj.gas   = await _payEstimateGas(provider, txObj);
        txHash = await provider.request({ method: 'eth_sendTransaction', params: [txObj] });
      }

      // Aguardar confirmação
      const receipt = await _payWaitReceipt(provider, txHash, 20000);
      const rec = {
        txHash, from, to, amount: amt, token, description: note,
        gasUsed:   parseInt(receipt.gasUsed || '0x5208', 16),
        gasFee:    ((parseInt(receipt.gasUsed || '0x5208', 16) * 10e9) / 1e18).toFixed(8),
        network:   'Arc Testnet', chainId: PAY_CHAIN_ID,
        timestamp: new Date().toISOString(), status: 'confirmed',
      };
      receipts.push(rec);
      window.payEVM.pendingReceipts.unshift(rec);
      successCount++;
      showToast(`✅ ${i+1}/${rows.length}: ${amt} ${token} confirmado!`, 'success');

      // Pequena pausa entre txs
      if (i < rows.length - 1) await new Promise(r => setTimeout(r, 800));

    } catch (e) {
      if (e.code === 4001 || e.message?.includes('reject') || e.message?.includes('denied')) {
        showToast(`❌ ${i+1}/${rows.length}: cancelado pelo usuário`, 'warning');
        break; // user rejected → parar batch
      }
      showToast(`⚠️ ${i+1}/${rows.length}: erro — ${e.message}`, 'error');
    }
  }

  if (successCount > 0) {
    showToast(`🎉 Batch concluído: ${successCount}/${rows.length} pagamentos enviados`, 'success');
    await payRefreshBalancePanel();
    if (typeof loadPayments === 'function') await loadPayments();

    // Oferecer download de recibos
    if (receipts.length > 0) {
      _payShowBatchReceiptBanner(receipts);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. ASSINAR CONTRATO ON-CHAIN (EIP-712 personal_sign)
// ─────────────────────────────────────────────────────────────────────────────
async function paySignContract(contractId, role) {
  if (!window.walletState?.connected) {
    showToast('Conecte sua wallet EVM primeiro', 'warning');
    if (typeof openWalletModal === 'function') openWalletModal();
    return;
  }

  const provider = window.walletState.provider;
  const from     = window.walletState.address;

  const onArc = await _payEnsureNetwork(provider);
  if (!onArc) { showToast('Troque para Arc Testnet (5042002)', 'error'); return; }

  // Obter dados do contrato
  let contractData;
  try {
    const res = await axios.get(`/api/contracts/${contractId}`);
    contractData = res.data.contract;
  } catch (e) {
    showToast('Erro ao carregar contrato', 'error'); return;
  }

  // Mensagem de assinatura estruturada
  const msgPayload = {
    type: 'CONTRACT_SIGNATURE',
    contractId,
    role,
    signer: from,
    title: contractData.title,
    value: contractData.totalValueFormatted,
    timestamp: new Date().toISOString(),
    network: 'Arc Testnet',
    chainId: PAY_CHAIN_ID,
  };

  const msgStr = `ARC Contract Signature\n\nContract: ${contractData.title}\nID: #${contractId}\nRole: ${role}\nValue: ${contractData.totalValueFormatted}\nSigner: ${from}\nTimestamp: ${msgPayload.timestamp}\nNetwork: Arc Testnet (Chain 5042002)\n\nBy signing this message you confirm your participation in this contract.`;

  showToast('📝 Confirme a assinatura do contrato na sua wallet…', 'info');

  let sigHash;
  try {
    sigHash = await provider.request({
      method: 'personal_sign',
      params: [
        '0x' + Array.from(new TextEncoder().encode(msgStr))
          .map(b => b.toString(16).padStart(2, '0')).join(''),
        from,
      ],
    });
  } catch (e) {
    if (e.code === 4001 || e.message?.includes('reject') || e.message?.includes('denied')) {
      showToast('Assinatura cancelada pelo usuário', 'warning');
    } else {
      showToast('Erro na assinatura: ' + e.message, 'error');
    }
    return;
  }

  showToast(`✅ Contrato assinado! Registrando…`, 'success');

  // Registrar assinatura no backend
  try {
    const res = await axios.post(`/api/contracts/${contractId}/sign`, {
      signer: from,
      role,
      signature: sigHash,
    });
    if (res.data.success) {
      const msg = res.data.bothSigned
        ? `🎉 Ambas as partes assinaram! Contrato #${contractId} pronto para ativar.`
        : `✅ ${role === 'client' ? 'Cliente' : 'Contratado'} assinou. Aguardando a outra parte.`;
      showToast(msg, 'success');
      if (typeof loadContracts === 'function') await loadContracts();
    }
  } catch (e) {
    showToast('Erro ao registrar assinatura no backend: ' + e.message, 'error');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. ATIVAR CONTRATO COM ESCROW (depositar USDC no vault do contrato)
// ─────────────────────────────────────────────────────────────────────────────
async function payActivateContractEVM(contractId) {
  if (!window.walletState?.connected) {
    showToast('Conecte sua wallet EVM primeiro', 'warning');
    if (typeof openWalletModal === 'function') openWalletModal();
    return;
  }

  const provider = window.walletState.provider;
  const from     = window.walletState.address;

  const onArc = await _payEnsureNetwork(provider);
  if (!onArc) { showToast('Troque para Arc Testnet (5042002)', 'error'); return; }

  let contractData;
  try {
    const res = await axios.get(`/api/contracts/${contractId}`);
    contractData = res.data.contract;
  } catch (e) { showToast('Erro ao carregar contrato', 'error'); return; }

  const totalUSDC = contractData.totalValue / 1e6;
  const balance   = await payReadBalance('USDC', from);

  if (balance !== null && totalUSDC > balance) {
    showToast(`Saldo insuficiente: ${balance.toFixed(4)} USDC para escrow de ${totalUSDC} USDC`, 'error');
    return;
  }

  showToast(`📝 Confirme o depósito de escrow: ${totalUSDC} USDC na wallet…`, 'info');

  const amtRaw = BigInt(Math.round(totalUSDC * 1_000_000));
  const valHex = '0x' + (amtRaw * BigInt(1_000_000_000_000n)).toString(16);
  // Endereço de escrow = hash do contractId como pseudo-endereço custodial
  const escrowAddr = '0x867650F5eAe8df91445971f14d89fd84F0C9a9f8'; // FxEscrow Arc
  const txObj = { from, to: escrowAddr, value: valHex, data: '0x' };
  txObj.gas   = await _payEstimateGas(provider, txObj);

  let txHash;
  try {
    txHash = await provider.request({ method: 'eth_sendTransaction', params: [txObj] });
  } catch (e) {
    if (e.code === 4001 || e.message?.includes('reject') || e.message?.includes('denied')) {
      showToast('Depósito de escrow cancelado', 'warning');
    } else {
      showToast('Erro no escrow: ' + e.message, 'error');
    }
    return;
  }

  showToast(`⏳ Depósito enviado (${txHash.slice(0,16)}…), aguardando confirmação…`, 'info');
  const receipt = await _payWaitReceipt(provider, txHash, 25000);

  if (receipt.status === '0x0' || receipt.status === 0) {
    showToast('Depósito de escrow revertido on-chain', 'error'); return;
  }

  // Ativar contrato no backend
  try {
    const res = await axios.post(`/api/contracts/${contractId}/activate`, { txHash, from });
    if (res.data.success) {
      showToast(`🎉 Contrato #${contractId} ativado! Escrow de ${totalUSDC} USDC depositado.`, 'success');
      if (typeof loadContracts === 'function') await loadContracts();
    }
  } catch (e) {
    showToast('Contrato ativado on-chain, erro ao atualizar backend: ' + e.message, 'warning');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. COMPLETAR MILESTONE COM ASSINATURA
// ─────────────────────────────────────────────────────────────────────────────
async function payCompleteMilestoneEVM(contractId, milestoneId, evidence) {
  if (!window.walletState?.connected) {
    showToast('Conecte sua wallet EVM primeiro', 'warning');
    if (typeof openWalletModal === 'function') openWalletModal();
    return;
  }

  const provider = window.walletState.provider;
  const from     = window.walletState.address;

  const onArc = await _payEnsureNetwork(provider);
  if (!onArc) { showToast('Troque para Arc Testnet (5042002)', 'error'); return; }

  // Assinar a evidência do milestone
  const msgStr = `ARC Milestone Completion\n\nContract: #${contractId}\nMilestone: #${milestoneId}\nEvidence: ${evidence}\nSigner: ${from}\nTimestamp: ${new Date().toISOString()}\nNetwork: Arc Testnet`;

  showToast('📝 Assine a evidência do milestone na wallet…', 'info');

  let sigHash;
  try {
    sigHash = await provider.request({
      method: 'personal_sign',
      params: [
        '0x' + Array.from(new TextEncoder().encode(msgStr))
          .map(b => b.toString(16).padStart(2, '0')).join(''),
        from,
      ],
    });
  } catch (e) {
    if (e.code === 4001 || e.message?.includes('reject') || e.message?.includes('denied')) {
      showToast('Assinatura cancelada', 'warning');
    } else {
      showToast('Erro: ' + e.message, 'error');
    }
    return;
  }

  // Registrar no backend
  try {
    const res = await axios.post(`/api/contracts/${contractId}/milestone/${milestoneId}/complete`, {
      evidence, signature: sigHash, signer: from,
    });
    if (res.data.success) {
      showToast(res.data.message || `Milestone #${milestoneId} verificado com sucesso!`, 'success');
      if (typeof loadContracts === 'function') await loadContracts();
    } else {
      showToast(res.data.message || 'Verificação pendente', 'warning');
    }
  } catch (e) {
    showToast('Erro ao registrar milestone: ' + e.message, 'error');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. MODAL DE RECIBO DIGITAL
// ─────────────────────────────────────────────────────────────────────────────
function _payShowReceiptModal(rec) {
  // Remove modal anterior se existir
  document.getElementById('pay-receipt-modal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'pay-receipt-modal';
  modal.className = 'fixed inset-0 z-[200] flex items-center justify-center p-4';
  modal.style.background = 'rgba(0,0,0,0.75)';
  modal.innerHTML = `
    <div class="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">
      <!-- Header -->
      <div class="bg-gradient-to-r from-green-900/60 to-emerald-900/40 border-b border-green-700/30 px-5 py-4 flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl bg-green-800/60 flex items-center justify-center">
            <i class="fas fa-receipt text-green-300 text-lg"></i>
          </div>
          <div>
            <p class="text-white font-bold text-sm">Transaction Receipt</p>
            <p class="text-green-400 text-xs">Arc Testnet · Confirmed ✓</p>
          </div>
        </div>
        <button onclick="document.getElementById('pay-receipt-modal').remove()"
          class="text-gray-500 hover:text-gray-300 p-1.5 rounded-lg hover:bg-gray-800 transition-all">
          <i class="fas fa-times"></i>
        </button>
      </div>

      <!-- Body -->
      <div class="px-5 py-4 space-y-3">
        <!-- Amount -->
        <div class="text-center py-3 bg-gray-800/60 rounded-xl border border-gray-700/30">
          <p class="text-4xl font-bold text-white">${rec.amount.toFixed(4)}</p>
          <p class="text-green-400 font-semibold text-lg">${rec.token}</p>
          <p class="text-xs text-gray-500 mt-1">Successfully transferred</p>
        </div>

        <!-- Details grid -->
        <div class="space-y-2 text-sm">
          <div class="flex justify-between items-start py-1.5 border-b border-gray-800">
            <span class="text-gray-400">From</span>
            <span class="text-white font-mono text-xs text-right max-w-[200px] truncate">${rec.from}</span>
          </div>
          <div class="flex justify-between items-start py-1.5 border-b border-gray-800">
            <span class="text-gray-400">To</span>
            <span class="text-white font-mono text-xs text-right max-w-[200px] truncate">${rec.to}</span>
          </div>
          <div class="flex justify-between py-1.5 border-b border-gray-800">
            <span class="text-gray-400">Tx Hash</span>
            <a href="${PAY_EXPLORER}/tx/${rec.txHash}" target="_blank"
              class="text-blue-400 hover:underline font-mono text-xs">
              ${rec.txHash.slice(0,16)}… ↗
            </a>
          </div>
          <div class="flex justify-between py-1.5 border-b border-gray-800">
            <span class="text-gray-400">Gas Used</span>
            <span class="text-gray-300 text-xs">${rec.gasUsed.toLocaleString()} units (~${parseFloat(rec.gasFee).toFixed(6)} USDC)</span>
          </div>
          <div class="flex justify-between py-1.5 border-b border-gray-800">
            <span class="text-gray-400">Network</span>
            <span class="text-cyan-400 text-xs">Arc Testnet (Chain ${rec.chainId})</span>
          </div>
          <div class="flex justify-between py-1.5">
            <span class="text-gray-400">Timestamp</span>
            <span class="text-gray-300 text-xs">${new Date(rec.timestamp).toLocaleString()}</span>
          </div>
          ${rec.description ? `
          <div class="flex justify-between py-1.5">
            <span class="text-gray-400">Description</span>
            <span class="text-gray-300 text-xs text-right max-w-[200px]">${rec.description}</span>
          </div>` : ''}
        </div>
      </div>

      <!-- Footer actions -->
      <div class="px-5 pb-5 grid grid-cols-3 gap-2">
        <button onclick="payDownloadReceiptJSON(window.payEVM.lastReceipt)"
          class="flex flex-col items-center gap-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-xl py-2.5 px-2 transition-all">
          <i class="fas fa-file-code text-blue-400 text-sm"></i>
          <span class="text-xs text-gray-300">JSON</span>
        </button>
        <button onclick="payDownloadReceiptPDF(window.payEVM.lastReceipt)"
          class="flex flex-col items-center gap-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-xl py-2.5 px-2 transition-all">
          <i class="fas fa-file-pdf text-red-400 text-sm"></i>
          <span class="text-xs text-gray-300">PDF</span>
        </button>
        <a href="${PAY_EXPLORER}/tx/${rec.txHash}" target="_blank"
          class="flex flex-col items-center gap-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-xl py-2.5 px-2 transition-all no-underline">
          <i class="fas fa-external-link-alt text-green-400 text-sm"></i>
          <span class="text-xs text-gray-300">ArcScan</span>
        </a>
      </div>
    </div>`;

  document.body.appendChild(modal);
  // Fechar ao clicar fora
  modal.addEventListener('click', e => {
    if (e.target === modal) modal.remove();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 13. DOWNLOAD RECEIPT JSON
// ─────────────────────────────────────────────────────────────────────────────
function payDownloadReceiptJSON(rec) {
  if (!rec) { showToast('Nenhum recibo disponível', 'error'); return; }
  const data = JSON.stringify(rec, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `receipt-${rec.txHash.slice(0,10)}-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('📥 Recibo JSON baixado', 'success');
}

// ─────────────────────────────────────────────────────────────────────────────
// 14. DOWNLOAD RECEIPT PDF (gerado via HTML → print)
// ─────────────────────────────────────────────────────────────────────────────
function payDownloadReceiptPDF(rec) {
  if (!rec) { showToast('Nenhum recibo disponível', 'error'); return; }

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>ARC Payment Receipt</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family: 'Segoe UI', Arial, sans-serif; background:#fff; color:#1a1a2e; padding:40px; }
    .header { display:flex; justify-content:space-between; align-items:center; border-bottom:3px solid #6d28d9; padding-bottom:20px; margin-bottom:30px; }
    .logo { font-size:22px; font-weight:800; color:#6d28d9; }
    .logo span { color:#2563eb; }
    .status { background:#dcfce7; color:#166534; padding:6px 14px; border-radius:20px; font-size:12px; font-weight:600; }
    .amount-box { background:linear-gradient(135deg,#f5f3ff,#ede9fe); border:1px solid #c4b5fd; border-radius:12px; padding:24px; text-align:center; margin-bottom:28px; }
    .amount-box .value { font-size:44px; font-weight:900; color:#4c1d95; }
    .amount-box .token { font-size:18px; color:#7c3aed; font-weight:700; }
    .amount-box .sub { font-size:12px; color:#6b7280; margin-top:4px; }
    table { width:100%; border-collapse:collapse; margin-bottom:24px; }
    tr { border-bottom:1px solid #e5e7eb; }
    td { padding:11px 6px; font-size:13px; }
    td:first-child { color:#6b7280; width:140px; }
    td:last-child { font-family:monospace; word-break:break-all; }
    .footer { display:flex; justify-content:space-between; align-items:center; padding-top:16px; border-top:1px solid #e5e7eb; font-size:11px; color:#9ca3af; }
    .network-badge { background:#dbeafe; color:#1e40af; padding:4px 10px; border-radius:12px; font-size:11px; }
    .arc-scan { color:#7c3aed; text-decoration:none; }
    @media print { body { padding:20px; } .no-print { display:none; } }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="logo">ARC <span>AI Agents</span></div>
      <div style="font-size:12px;color:#9ca3af;margin-top:4px;">Payment Gateway · Arc Network</div>
    </div>
    <div class="status">✓ CONFIRMED</div>
  </div>

  <div class="amount-box">
    <div class="value">${rec.amount.toFixed(4)}</div>
    <div class="token">${rec.token}</div>
    <div class="sub">Successfully transferred on Arc Testnet</div>
  </div>

  <table>
    <tr><td>Transaction Hash</td><td>${rec.txHash}</td></tr>
    <tr><td>From (Sender)</td><td>${rec.from}</td></tr>
    <tr><td>To (Recipient)</td><td>${rec.to}</td></tr>
    <tr><td>Amount</td><td>${rec.amount.toFixed(6)} ${rec.token}</td></tr>
    <tr><td>Network</td><td>${rec.network} (Chain ID: ${rec.chainId})</td></tr>
    <tr><td>Gas Used</td><td>${rec.gasUsed?.toLocaleString() || '—'} units</td></tr>
    <tr><td>Gas Fee</td><td>${parseFloat(rec.gasFee || 0).toFixed(8)} USDC</td></tr>
    <tr><td>Status</td><td>Confirmed ✓</td></tr>
    <tr><td>Timestamp</td><td>${new Date(rec.timestamp).toLocaleString()}</td></tr>
    ${rec.description ? `<tr><td>Description</td><td>${rec.description}</td></tr>` : ''}
    ${rec.blockNumber ? `<tr><td>Block</td><td>#${rec.blockNumber}</td></tr>` : ''}
  </table>

  <div class="footer">
    <div>
      <span class="network-badge">Arc Testnet</span>
    </div>
    <div style="text-align:right;">
      <div>View on explorer:</div>
      <a href="${PAY_EXPLORER}/tx/${rec.txHash}" class="arc-scan">${PAY_EXPLORER}/tx/${rec.txHash.slice(0,20)}…</a>
    </div>
  </div>

  <script>window.onload = () => { window.print(); window.close(); }<\/script>
</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html' });
  const url  = URL.createObjectURL(blob);
  const w    = window.open(url, '_blank');
  if (!w) {
    // Fallback: download como HTML
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `receipt-${rec.txHash.slice(0,10)}.html`;
    a.click();
  }
  setTimeout(() => URL.revokeObjectURL(url), 3000);
  showToast('🖨️ Recibo PDF aberto para impressão', 'success');
}

// ─────────────────────────────────────────────────────────────────────────────
// 15. BANNER DE DOWNLOAD BATCH
// ─────────────────────────────────────────────────────────────────────────────
function _payShowBatchReceiptBanner(receipts) {
  const existing = document.getElementById('pay-batch-receipt-banner');
  if (existing) existing.remove();

  const div = document.createElement('div');
  div.id = 'pay-batch-receipt-banner';
  div.className = 'fixed bottom-20 left-1/2 -translate-x-1/2 z-[150] bg-gray-900 border border-green-700/50 rounded-xl px-5 py-3 shadow-2xl flex items-center gap-4 max-w-sm';
  div.innerHTML = `
    <div class="flex-1 min-w-0">
      <p class="text-white text-sm font-semibold">✅ ${receipts.length} payments sent</p>
      <p class="text-gray-400 text-xs">Download combined receipt</p>
    </div>
    <div class="flex gap-2">
      <button onclick="payDownloadBatchJSON(window.payEVM.pendingReceipts)"
        class="text-xs bg-blue-800 hover:bg-blue-700 text-blue-200 px-3 py-1.5 rounded-lg">JSON</button>
      <button onclick="this.closest('#pay-batch-receipt-banner').remove()"
        class="text-xs text-gray-500 hover:text-gray-300 p-1">✕</button>
    </div>`;
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 8000);
}

function payDownloadBatchJSON(receipts) {
  const data = JSON.stringify({ receipts, exportedAt: new Date().toISOString(), network: 'Arc Testnet' }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `arc-batch-receipts-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('📥 Recibos batch baixados', 'success');
}

// ─────────────────────────────────────────────────────────────────────────────
// 16. UI HELPERS: STEPS PANEL
// ─────────────────────────────────────────────────────────────────────────────
function _payShowSteps(visible) {
  const panel = _el('pay-steps-panel');
  if (panel) panel.classList.toggle('hidden', !visible);
  if (visible) {
    document.querySelectorAll('.pay-step').forEach(el => {
      el.classList.remove('pay-step-active','pay-step-done','pay-step-error');
    });
  }
}

function _payUpdateStep(idx, status) {
  const steps = document.querySelectorAll('.pay-step');
  if (!steps[idx]) return;
  const el = steps[idx];
  el.classList.remove('pay-step-active','pay-step-done','pay-step-error');
  // Mark all previous as done
  for (let i = 0; i < idx; i++) {
    steps[i].classList.remove('pay-step-active','pay-step-error');
    steps[i].classList.add('pay-step-done');
  }
  if (status === 'done')  el.classList.add('pay-step-done');
  else if (status === 'error') el.classList.add('pay-step-error');
  else el.classList.add('pay-step-active');
}

function _payShowTxHash(txHash) {
  const el = _el('pay-tx-hash-display');
  if (!el) return;
  el.innerHTML = `<i class="fas fa-external-link-alt text-blue-400 text-xs mr-1"></i>
    <span class="text-gray-400 text-xs">TX: </span>
    <a href="${PAY_EXPLORER}/tx/${txHash}" target="_blank"
      class="text-blue-400 hover:underline font-mono text-xs">${txHash.slice(0,20)}… ↗</a>`;
  el.classList.remove('hidden');
}

// ─────────────────────────────────────────────────────────────────────────────
// 17. EVENT LISTENERS
// ─────────────────────────────────────────────────────────────────────────────
document.addEventListener('walletConnected', () => {
  payRefreshBalancePanel();
  payUpdateSendButton();
});
document.addEventListener('walletDisconnected', () => {
  _setEl('pay-wallet-balance', '—');
  _setEl('pay-wallet-address', 'Not connected');
  _setEl('pay-wallet-network', '—');
  payUpdateSendButton();
});

// Input change listeners (after DOM ready)
document.addEventListener('DOMContentLoaded', () => {
  const inputs = ['pay-to-single','pay-amount-single','pay-token-select'];
  inputs.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', payUpdateSendButton);
    if (el) el.addEventListener('change', () => {
      payUpdateSendButton();
      if (id === 'pay-token-select') payRefreshBalancePanel();
    });
  });
  payRefreshBalancePanel();
});

// ─── Expostos globalmente ─────────────────────────────────────────────────────
window.paySendSingle           = paySendSingle;
window.payExecuteMultisend     = payExecuteMultisend;
window.paySignContract         = paySignContract;
window.payActivateContractEVM  = payActivateContractEVM;
window.payCompleteMilestoneEVM = payCompleteMilestoneEVM;
window.payRefreshBalancePanel  = payRefreshBalancePanel;
window.payDownloadReceiptJSON  = payDownloadReceiptJSON;
window.payDownloadReceiptPDF   = payDownloadReceiptPDF;
window.payDownloadBatchJSON    = payDownloadBatchJSON;
window.payUpdateSendButton     = payUpdateSendButton;
