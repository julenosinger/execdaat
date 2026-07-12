// ─── Execute Multicall3 batch ─────────────────────────────────────────────────
// CRITICAL: Uses transferFrom(senderAddr, recipient, amount)
// User must have approved Multicall3 for at least totalAmount BEFORE calling this.
// The approval happens in Step 1 of msExecute(), BEFORE the fee payment.
async function msExecuteMulticall3(ethers, signer, provider, senderAddr, recipients, amounts, gasPrice, onStatus) {
  const iface = new ethers.Interface(MS_ERC20_ABI);
  const mc3   = new ethers.Contract(MS_MULTICALL3_ADDR, MS_MULTICALL3_ABI, signer);

  // Build calls array: USDC.transferFrom(sender, recipient, amount)
  const calls = recipients.map((to, i) => ({
    target:       MS_USDC_ADDR,
    allowFailure: false, // if any single transfer fails, revert entire batch = atomic
    callData:     iface.encodeFunctionData('transferFrom', [senderAddr, to, amounts[i]]),
  }));

  // Log all calls for debugging
  msLog(`Building ${calls.length} transferFrom calls:`);
  calls.forEach((call, i) => {
    msLog(`  Call[${i}]: to=${recipients[i]} amount=${ethers.formatUnits(amounts[i], 6)} USDC (${amounts[i].toString()} raw)`);
  });

  // Pre-simulate with from=senderAddr
  onStatus('Simulating batch transaction (pre-flight check)…');
  const sim = await msSimulateAggregate3(provider, senderAddr, calls);

  if (!sim.ok) {
    msWarn('Simulation failed, diagnosing individual calls…');
    // Try to identify which specific call is failing
    for (let i = 0; i < recipients.length; i++) {
      const s = await msSimulateOneTransferFrom(provider, senderAddr, recipients[i], amounts[i]);
      if (!s.ok) {
        const errMsg = `Transfer [${i+1}] to ${msShort(recipients[i])} $${msFmt2(Number(ethers.formatUnits(amounts[i], 6)))} would fail: ${s.error || 'simulation reverted'}`;
        msWarn(errMsg);
        throw new Error(errMsg);
      }
    }
    throw new Error(`Multicall3 simulation failed: ${sim.error || 'execution reverted. Check total allowance vs total amount.'}`);
  }

  msLog('Pre-flight simulation passed ✓');

  // Estimate gas with from override
  onStatus('Estimating gas for batch…');
  let gasLimit;
  try {
    const estimated = await mc3.aggregate3.estimateGas(calls, { from: senderAddr });
    gasLimit = BigInt(Math.ceil(Number(estimated) * MS_GAS_MARGIN));
    msLog(`Gas estimated: ${estimated} → with ${MS_GAS_MARGIN}x margin: ${gasLimit}`);
  } catch (e) {
    msWarn('Gas estimation failed, using fallback:', e.message);
    gasLimit = MS_GAS_PER_XFER * BigInt(recipients.length) + 250_000n;
    msLog(`Gas fallback: ${gasLimit} (${recipients.length} recipients × ${MS_GAS_PER_XFER} + 250k overhead)`);
  }

  onStatus(`Confirm batch in wallet — ${recipients.length} transfers in 1 transaction…`);
  msLog(`Sending mc3.aggregate3 gasLimit=${gasLimit}`, { gasPrice });

  let batchTx;
  try {
    batchTx = await mc3.aggregate3(calls, { gasLimit, ...gasPrice });
  } catch (e) {
    const decoded = msDecodeRevert(e);
    if (decoded.userRejected) throw new Error('Batch transaction rejected by user.');
    // Log full error for debugging
    msError('aggregate3 send error:', e);
    throw new Error(decoded.msg || 'Multicall3 transaction submission failed.');
  }

  msLog('Multicall3 tx submitted:', batchTx.hash);
  onStatus(`Confirming batch… <a href="${MS_EXPLORER}/tx/${batchTx.hash}" target="_blank" class="underline text-blue-400 font-mono text-[10px]">${batchTx.hash.slice(0,14)}…</a>`);

  const receipt = await batchTx.wait(1);
  msLog(`Multicall3 confirmed! Block: ${receipt.blockNumber}, GasUsed: ${receipt.gasUsed}`);

  if (receipt.status !== 1) {
    throw new Error(`Multicall3 transaction reverted on-chain at block #${receipt.blockNumber}. All transfers rolled back.`);
  }

  return { txHash: batchTx.hash, gasUsed: receipt.gasUsed?.toString(), blockNumber: receipt.blockNumber, receipt };
}

// ─── Sequential fallback (direct USDC.transfer, no Multicall3) ───────────────
// Used only if Multicall3 simulation consistently fails or user prefers it
async function msSequentialFallback(ethers, usdc, signer, provider, rows, decs, gasPrice, onStatus) {
  msLog('Using sequential direct USDC.transfer for', rows.length, 'transfers');
  const results = [];

  // Estimate gas from first transfer
  let perGas = BigInt(Math.ceil(Number(MS_GAS_PER_XFER) * MS_GAS_MARGIN));
  try {
    const sampleAmt = ethers.parseUnits(Number(rows[0].amount).toFixed(decs), decs);
    const est = await usdc.transfer.estimateGas(rows[0].address, sampleAmt);
    perGas = BigInt(Math.ceil(Number(est) * MS_GAS_MARGIN));
    msLog(`Sequential gas per transfer estimated: ${perGas}`);
  } catch (_) {
    msLog(`Sequential gas fallback: ${perGas}`);
  }

  const signerAddr = await signer.getAddress();
  let   nonce      = await provider.getTransactionCount(signerAddr, 'pending');

  const pending = [];
  for (let i = 0; i < rows.length; i++) {
    const p = rows[i];
    onStatus(`Sending ${i+1}/${rows.length} → ${msShort(p.address)} $${msFmt2(p.amount)}`);
    try {
      const amtBig = ethers.parseUnits(Number(p.amount).toFixed(decs), decs);
      if (amtBig <= 0n) throw new Error('Zero amount');
      const tx = await usdc.transfer(p.address, amtBig, { gasLimit: perGas, nonce: nonce++, ...gasPrice });
      pending.push({ tx, row: p, index: i });
      msLog(`Tx[${i}] submitted: ${tx.hash} nonce=${nonce-1}`);
    } catch (e) {
      const decoded = msDecodeRevert(e);
      if (decoded.userRejected) {
        results.push({ address: p.address, amount: p.amount, note: p.note || '', txHash: null, status: 'rejected', error: 'User rejected' });
        break; // stop on rejection
      }
      results.push({ address: p.address, amount: p.amount, note: p.note || '', txHash: null, status: 'failed', error: decoded.msg });
    }
  }

  for (const { tx, row } of pending) {
    try {
      const rcpt = await tx.wait(1);
      results.push({ address: row.address, amount: row.amount, note: row.note || '', txHash: tx.hash, status: rcpt.status === 1 ? 'confirmed' : 'failed', gasUsed: rcpt.gasUsed?.toString() });
    } catch (e) {
      results.push({ address: row.address, amount: row.amount, note: row.note || '', txHash: tx.hash, status: 'failed', error: e.message });
    }
  }

  // Fill in skipped rows
  rows.forEach(p => {
    if (!results.find(r => r.address?.toLowerCase() === p.address?.toLowerCase())) {
      results.push({ address: p.address, amount: p.amount, note: p.note || '', txHash: null, status: 'skipped' });
    }
  });

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN EXECUTE — Step 3
//
// FIXED EXECUTION ORDER:
//   1. Validate inputs, check network, get provider/signer
//   2. Check USDC balance >= (total_transfers + fee)
//   3. APPROVE Multicall3 for total_transfers amount (with buffer)
//      → This MUST happen BEFORE fee payment to guarantee allowance is valid
//      → Buffer = 10% extra to handle rounding
//   4. Pay platform fee (USDC.transfer to fee wallet)
//   5. Execute Multicall3.aggregate3 with all transferFrom calls (single tx)
//   6. Build receipt + PDF
//
// SINGLE EXECUTION GUARD: msExecuting flag prevents duplicate sends
// ═══════════════════════════════════════════════════════════════════════════════
async function msExecute() {
  // ── Duplicate prevention ────────────────────────────────────────────────────
  if (msExecuting) {
    showToast('Transaction already in progress. Please wait.', 'warning');
    return;
  }

  const execBtn = msEl('ms-execute-btn');
  const backBtn = msEl('ms-step3-back');
  const finEl   = msEl('ms-final-result');

  if (!msValidatedRows.length)        { showToast('No validated recipients.','warning'); return; }
  if (!window.ethereum)               { showToast('Wallet not detected. Install MetaMask.','error'); return; }
  if (!window.walletState?.connected) {
    showToast('Connect your wallet first.','warning');
    if (typeof openWalletModal === 'function') openWalletModal();
    return;
  }

  // Set executing flag and disable UI
  msExecuting = true;
  if (execBtn) { execBtn.disabled = true; execBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Processing…'; }
  if (backBtn) backBtn.disabled = true;
  if (finEl)   { finEl.classList.add('hidden'); finEl.innerHTML = ''; }
  msTxStepsReset();

  // Calculate totals using integer micro-USDC math to avoid floating point issues
  const totalMicro = msValidatedRows.reduce((s, r) => s + msToMicro(r.amount), 0);
  const total      = msMicroToUsdc(totalMicro);
  const fee        = msCalcFee(total, msValidatedRows.length);
  const grand      = total + fee;
  const batchId    = `BATCH-${Date.now().toString(36).toUpperCase()}`;

  msLog(`=== MULTISEND v7 EXECUTE ===`);
  msLog(`Recipients: ${msValidatedRows.length}`);
  msLog(`Total transfers: $${msFmt6(total)} USDC (${totalMicro} micro-USDC)`);
  msLog(`Platform fee: $${msFmt6(fee)} USDC`);
  msLog(`Grand total needed: $${msFmt6(grand)} USDC`);
  msLog(`Batch ID: ${batchId}`);
  msLog(`Multicall3: ${MS_MULTICALL3_ADDR}`);
  msLog(`USDC: ${MS_USDC_ADDR}`);

  let approvalTxHash = null;
  let feeTxHash      = null;
  let feeGasUsed     = '0';

  try {
    const ethers = window.ethers;
    if (!ethers) throw new Error('ethers.js not loaded. Refresh the page.');

    // ── Step 1: Network validation + provider + balance check ─────────────────
    msTxStep(1, 'active', 'Checking network and USDC balance…');

    // Network check
    const chainHex        = await window.ethereum.request({ method:'eth_chainId' });
    const currentChainId  = parseInt(chainHex, 16);
    msLog(`Current chain: ${currentChainId} | Required: ${MS_CHAIN_ID}`);

    if (currentChainId !== MS_CHAIN_ID) {
      msTxStep(1, 'active', 'Wrong network — switching to Arc Testnet (chainId 5042002)…');
      const ok = await msSwitchToArc();
      if (!ok) {
        msTxStep(1, 'error', `Wrong network (chain ${currentChainId}). Switch to Arc Testnet manually.`);
        showToast(`Switch to Arc Testnet (chain ID 5042002)`, 'error');
        throw new Error(`Network switch failed. Connected to chainId ${currentChainId}, need ${MS_CHAIN_ID}.`);
      }
      msLog('Network switched to Arc Testnet');
      await new Promise(r => setTimeout(r, 1200)); // let provider settle
    }

    // Init provider + signer
    const provider   = new ethers.BrowserProvider(window.ethereum, 'any');
    const signer     = await provider.getSigner();
    const senderAddr = await signer.getAddress();
    const usdc       = new ethers.Contract(MS_USDC_ADDR, MS_ERC20_ABI, signer);

    msLog(`Sender: ${senderAddr}`);

    // Confirm USDC decimals
    let decs = MS_USDC_DECIMALS;
    try { decs = Number(await usdc.decimals()); } catch (_) {}
    msLog(`USDC decimals: ${decs}`);
    if (decs !== MS_USDC_DECIMALS) msWarn(`⚠ USDC decimals = ${decs}, expected 6. Proceeding with ${decs}.`);

    // Parse exact BigInt amounts for all recipients (avoids float drift)
    const recipients  = [];
    const amounts     = [];
    let   totalBig    = 0n;

    for (const p of msValidatedRows) {
      if (!msIsAddr(p.address)) throw new Error(`Invalid address: "${p.address}"`);
      // Parse using exact 6-decimal string to avoid floating point drift
      const amtStr = (msToMicro(p.amount) / 1_000_000).toFixed(decs);
      const amtBig = ethers.parseUnits(amtStr, decs);
      if (amtBig <= 0n) throw new Error(`Zero amount for ${p.address}`);
      recipients.push(p.address);
      amounts.push(amtBig);
      totalBig += amtBig;
    }

    const feeBig    = ethers.parseUnits(fee.toFixed(decs), decs);
    const grandBig  = totalBig + feeBig;

    msLog(`totalBig=${totalBig} (${ethers.formatUnits(totalBig, decs)} USDC)`);
    msLog(`feeBig=${feeBig} (${ethers.formatUnits(feeBig, decs)} USDC)`);
    msLog(`grandBig=${grandBig} (${ethers.formatUnits(grandBig, decs)} USDC)`);

    // Balance check
    const balBig   = await usdc.balanceOf(senderAddr);
    const balHuman = Number(ethers.formatUnits(balBig, decs)).toFixed(2);
    msLog(`Balance: $${balHuman} USDC | Need: $${ethers.formatUnits(grandBig, decs)} USDC`);

    if (balBig < grandBig) {
      const need = Number(ethers.formatUnits(grandBig, decs)).toFixed(2);
      msTxStep(1, 'error', `Insufficient USDC: have $${balHuman}, need $${need}`);
      showToast(`Insufficient USDC balance: you have $${balHuman}, need $${need}`, 'error');
      throw new Error(`Insufficient USDC: have $${balHuman}, need $${need}`);
    }

    msTxStep(1, 'done', `✓ Network: Arc Testnet · Balance: $${balHuman} USDC · ${recipients.length} recipients validated`);

    // Fetch gas price
    const gasPrice = await msFetchGasPrice(provider);
    msLog('Gas price:', gasPrice);

    // ── Step 2: Approve Multicall3 FIRST, then pay fee ────────────────────────
    msTxStep(2, 'active', `Approving Multicall3 for batch ($${msFmt2(total)} USDC)…`);

    // Approval amount = totalBig + 10% buffer (NOT including fee, which goes directly to fee wallet)
    // Buffer formula: totalBig * 110 / 100
    const approveAmtBig = (totalBig * 110n) / 100n;
    msLog(`Approval amount: ${ethers.formatUnits(approveAmtBig, decs)} USDC (total + 10% buffer)`);

    try {
      const approvalResult = await msEnsureAllowance(
        usdc, senderAddr, MS_MULTICALL3_ADDR, approveAmtBig,
        (msg) => msTxStep(2, 'active', msg)
      );
      approvalTxHash = approvalResult.txHash || null;
      msLog('Approval complete:', approvalResult.alreadyApproved ? 'already sufficient' : `new approval tx: ${approvalTxHash}`);
    } catch (e) {
      msTxStep(2, 'error', e.message.slice(0, 150));
      showToast(e.message, 'error');
      throw e;
    }

    // Pay platform fee AFTER approval
    if (fee > 0 && feeBig > 0n) {
      msTxStep(2, 'active', `Paying platform fee $${msFmt2(fee)} USDC to fee wallet…`);
      msLog(`Fee tx: usdc.transfer(${MS_FEE_WALLET}, ${feeBig})`);

      let feeGasLimit = 80_000n;
      try {
        const est = await usdc.transfer.estimateGas(MS_FEE_WALLET, feeBig);
        feeGasLimit = BigInt(Math.ceil(Number(est) * MS_GAS_MARGIN));
      } catch (_) {}

      let feeTx;
      try {
        feeTx = await usdc.transfer(MS_FEE_WALLET, feeBig, { gasLimit: feeGasLimit, ...gasPrice });
      } catch (e) {
        const decoded = msDecodeRevert(e);
        const msg = decoded.userRejected ? 'Fee payment rejected by user.' : `Fee payment failed: ${decoded.msg}`;
        msTxStep(2, 'error', msg);
        showToast(msg, 'error');
        throw new Error(msg);
      }

      msLog('Fee tx submitted:', feeTx.hash);
      msTxStep(2, 'active', `Confirming fee tx… <a href="${MS_EXPLORER}/tx/${feeTx.hash}" target="_blank" class="underline text-yellow-400 font-mono text-[10px]">${feeTx.hash.slice(0,14)}…</a>`);

      const feeRcpt = await feeTx.wait(1);
      if (feeRcpt.status !== 1) throw new Error('Fee transaction was mined but reverted on-chain.');

      feeTxHash  = feeTx.hash;
      feeGasUsed = feeRcpt.gasUsed?.toString() || '0';
      msLog(`Fee confirmed! Block: ${feeRcpt.blockNumber}, hash: ${feeTx.hash}`);
      msTxStep(2, 'done',
        `✓ Fee $${msFmt2(fee)} USDC confirmed · Block #${feeRcpt.blockNumber} · ` +
        `<a href="${MS_EXPLORER}/tx/${feeTx.hash}" target="_blank" class="underline text-yellow-400 font-mono text-[10px]">${feeTx.hash.slice(0,14)}…</a>`
      );
    } else {
      msTxStep(2, 'done', '✓ No platform fee required for this batch.');
    }

    // ── Step 3: Multicall3 aggregate3 batch (single tx) ───────────────────────
    const label = msEl('ms-txstep-3-label');
    if (label) label.textContent = `Multicall3 Batch (${recipients.length} transfers)`;

    let batchTxHash    = null;
    let batchGasUsed   = 'N/A';
    let usedMethod     = 'multicall3';
    let batchResults   = [];
    let blockTimestamp = new Date().toISOString();

    msTxStep(3, 'active', `Executing Multicall3 batch — ${recipients.length} transferFrom calls in 1 tx…`);
    msLog('=== MULTICALL3 AGGREGATE3 ===');

    try {
      const batchResult = await msExecuteMulticall3(
        ethers, signer, provider, senderAddr,
        recipients, amounts, gasPrice,
        (msg) => msTxStep(3, 'active', msg)
      );

      batchTxHash  = batchResult.txHash;
      batchGasUsed = batchResult.gasUsed;
      msLog(`Multicall3 success! tx=${batchTxHash} block=${batchResult.blockNumber} gasUsed=${batchGasUsed}`);

      // Fetch block timestamp
      try {
        const blk = await provider.getBlock(batchResult.blockNumber);
        if (blk?.timestamp) blockTimestamp = new Date(blk.timestamp * 1000).toISOString();
      } catch (_) {}

      batchResults = msValidatedRows.map(p => ({
        address: p.address, amount: p.amount, note: p.note || '',
        txHash: batchTxHash, status: 'confirmed', gasUsed: null,
      }));

      if (label) label.textContent = `Multicall3 confirmed — ${recipients.length} recipients`;
      msTxStep(3, 'done',
        `✅ All ${recipients.length} transfers confirmed · $${msFmt2(total)} USDC · ` +
        `<a href="${MS_EXPLORER}/tx/${batchTxHash}" target="_blank" class="underline text-green-400 font-mono text-[10px]">${batchTxHash.slice(0,14)}…</a>`
      );

    } catch (e) {
      // Multicall3 failed — attempt sequential fallback
      msWarn('Multicall3 failed, attempting sequential fallback:', e.message);
      msTxStep(3, 'active', `Multicall3 failed — falling back to sequential transfers… (${e.message.slice(0,80)})`);
      usedMethod = 'sequential';

      try {
        batchResults = await msSequentialFallback(
          ethers, usdc, signer, provider, msValidatedRows, decs, gasPrice,
          (msg) => {
            if (label) label.textContent = msg;
            msTxStep(3, 'active', msg);
          }
        );

        const confirmed  = batchResults.filter(r => r.status === 'confirmed');
        const allOk      = confirmed.length === msValidatedRows.length;
        const confMicro  = confirmed.reduce((s, r) => s + msToMicro(r.amount), 0);
        const confAmount = msMicroToUsdc(confMicro);
        batchTxHash      = confirmed[0]?.txHash || null;
        batchGasUsed     = batchResults.filter(r => r.gasUsed).reduce((s, r) => s + Number(r.gasUsed || 0), 0).toString();

        if (batchTxHash) {
          try {
            const rcptData = await provider.getTransactionReceipt(batchTxHash);
            if (rcptData?.blockNumber) {
              const blk = await provider.getBlock(rcptData.blockNumber);
              if (blk?.timestamp) blockTimestamp = new Date(blk.timestamp * 1000).toISOString();
            }
          } catch (_) {}
        }

        if (label) label.textContent = `${confirmed.length}/${msValidatedRows.length} confirmed (sequential)`;
        msTxStep(3, allOk ? 'done' : 'error',
          `${confirmed.length}/${msValidatedRows.length} transfers confirmed · $${msFmt2(confAmount)} USDC`);

      } catch (seqErr) {
        msTxStep(3, 'error', `Sequential fallback also failed: ${seqErr.message.slice(0, 100)}`);
        throw seqErr;
      }
    }

    // ── Build receipt & render ─────────────────────────────────────────────────
    const confirmed  = batchResults.filter(r => r.status === 'confirmed');
    const confMicro  = confirmed.reduce((s, r) => s + msToMicro(r.amount), 0);
    const confAmount = msMicroToUsdc(confMicro);
    const allOk      = confirmed.length === msValidatedRows.length;
    msBatchesSent++;

    const receiptObj = msBuildReceipt({
      batchId,
      from:          senderAddr,
      decs,
      fee,
      feeTxHash,
      feeGasUsed,
      results:       batchResults,
      hashes:        confirmed.map(r => r.txHash).filter(Boolean),
      txHash:        batchTxHash,
      totalAmount:   confAmount,
      totalGasUsed:  batchGasUsed,
      blockTimestamp,
      approvalTxHash,
      multicallAddr: usedMethod === 'multicall3' ? MS_MULTICALL3_ADDR : 'N/A (sequential fallback)',
      method:        usedMethod,
      status:        allOk ? 'confirmed' : 'partial',
    });

    msReceipts.unshift(receiptObj);
    msRenderReceipts();
    msShowFinalResult(finEl, receiptObj, allOk);

    // Persist receipt after batch completes — do NOT auto-open
    setTimeout(() => {
      if (typeof arcSaveMultisendReceipt === 'function') arcSaveMultisendReceipt(receiptObj).catch(() => {});
    }, 200);

    showToast(
      allOk
        ? `✅ Batch confirmed · $${msFmt2(confAmount)} USDC · ${confirmed.length} recipients`
        : `⚠️ Partial: ${confirmed.length}/${msValidatedRows.length} confirmed`,
      allOk ? 'success' : 'warning'
    );

    if (allOk) { msInitRows(); msValidatedRows = []; }
    const batchEl = msEl('ms-stat-batches');
    if (batchEl) batchEl.textContent = msBatchesSent;
    if (typeof historyInit    === 'function') setTimeout(() => historyInit(), 3000);
    if (typeof loadDashboard  === 'function') setTimeout(loadDashboard, 2000);

    msLog('=== EXECUTE COMPLETE ===');

  } catch (e) {
    const decoded = msDecodeRevert(e);
    const msg     = decoded.msg || e.message || 'Unknown error';

    msError('Execute error:', e);
    msLog('Error decoded:', decoded);

    if (!decoded.userRejected) {
      showToast('Error: ' + msg, 'error');
    } else {
      showToast('Transaction cancelled.', 'warning');
    }

    if (typeof addLog === 'function') addLog('[MULTISEND v7] Error: ' + msg, 'error');

    // Mark the currently active step as error
    [1, 2, 3].forEach(n => {
      const el = msEl(`ms-txstep-${n}`);
      if (el && (el.className.includes('cyan') || el.className.includes('bg-cyan'))) {
        msTxStep(n, 'error', msg.slice(0, 120));
      }
    });

  } finally {
    // Always re-enable UI
    msExecuting = false;
    if (execBtn) { execBtn.disabled = false; execBtn.innerHTML = '<i class="fas fa-rocket mr-2"></i>Pay Fee &amp; Send All'; }
    if (backBtn) backBtn.disabled = false;
  }
}

// ─── Final result banner ───────────────────────────────────────────────────────
function msShowFinalResult(finEl, r, allOk) {
  if (!finEl) return;
  finEl.classList.remove('hidden');
  finEl.className = `rounded-xl p-4 mb-4 ${allOk ? 'bg-green-900/20 border border-green-700/30' : 'bg-yellow-900/20 border border-yellow-700/30'}`;
  const totalRecipients = msValidatedRows.length || r.recipients?.length || r.count;
  finEl.innerHTML = `
    <div class="flex items-start gap-3">
      <i class="fas ${allOk ? 'fa-check-circle text-green-400' : 'fa-exclamation-triangle text-yellow-400'} text-xl mt-0.5"></i>
      <div class="flex-1">
        <div class="font-semibold ${allOk ? 'text-green-300' : 'text-yellow-300'} mb-2">
          ${allOk ? `✅ Batch complete — ${r.count} recipients confirmed.` : `⚠️ Partial: ${r.count}/${totalRecipients} confirmed.`}
        </div>
        <div class="text-xs text-gray-400 space-y-1">
          <div>Amount sent: <span class="text-white font-medium">$${r.totalAmount} USDC</span></div>
          <div>Platform fee: <span class="text-yellow-300">$${r.fee} USDC</span></div>
          <div>Gas used: <span class="text-gray-400">${r.totalGasUsed || 'N/A'}</span></div>
          <div>Method: <span class="text-cyan-400">${r.executionMethod}</span></div>
          ${r.executionMethod === 'multicall3' ? `<div class="text-[11px] text-green-400/80">✓ Atomic batch — all ${r.count} transfers in a single transaction</div>` : ''}
          ${r.txHash ? `<div>Batch tx: <a href="${r.explorerUrl}" target="_blank" class="text-blue-400 hover:underline font-mono">${r.txHash.slice(0,24)}…</a></div>` : ''}
          ${r.feeTxHash ? `<div>Fee tx: <a href="${MS_EXPLORER}/tx/${r.feeTxHash}" target="_blank" class="text-yellow-400 hover:underline font-mono">${r.feeTxHash.slice(0,24)}…</a></div>` : ''}
          ${r.approvalTxHash ? `<div>Approval tx: <a href="${MS_EXPLORER}/tx/${r.approvalTxHash}" target="_blank" class="text-cyan-400/70 hover:underline font-mono">${r.approvalTxHash.slice(0,24)}…</a></div>` : ''}
        </div>
        <div class="flex gap-2 mt-3 flex-wrap">
          <button onclick="arcViewMultisendReceipt ? arcViewMultisendReceipt('${r.id}') : msPdfReceipt('${r.id}')"
            class="flex items-center gap-1.5 px-3 py-1.5 bg-green-700/40 hover:bg-green-700/60 border border-green-600/40 text-green-300 hover:text-white text-xs rounded-xl transition font-semibold">
            <i class="fas fa-eye text-xs"></i>View Receipt
          </button>
          ${r.txHash ? `<a href="${r.explorerUrl}" target="_blank" rel="noopener" class="flex items-center gap-1.5 px-3 py-1.5 bg-gray-700/40 border border-gray-600/40 text-gray-400 text-xs rounded-xl transition"><i class="fas fa-external-link-alt text-xs"></i>ArcScan</a>` : ''}
        </div>
      </div>
    </div>`;
}
