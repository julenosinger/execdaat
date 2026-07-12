// ─── Show tx badge ─────────────────────────────────────────────────────────────
function cfShowTxBadge(hash, label = '') {
  try {
    const existing = document.getElementById('cf-tx-badge');
    if (existing) existing.remove();
    const badge = document.createElement('div');
    badge.id = 'cf-tx-badge';
    badge.style.cssText = 'position:fixed;bottom:80px;right:20px;z-index:9999;background:rgba(8,11,24,0.95);border:1px solid rgba(52,211,153,0.3);border-radius:12px;padding:10px 14px;max-width:340px;box-shadow:0 0 20px rgba(52,211,153,0.15);';
    badge.innerHTML = `<div style="font-size:10px;color:#34d399;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">✅ ${label || 'Transaction Confirmed'}</div>
      <a href="${CF_EXPLORER}/tx/${hash}" target="_blank" style="font-size:11px;color:#60b4ff;font-family:monospace;display:flex;align-items:center;gap:4px;">
        <i class="fas fa-external-link-alt" style="font-size:9px;"></i>${hash.slice(0, 20)}…${hash.slice(-8)}
      </a>`;
    document.body.appendChild(badge);
    setTimeout(() => badge.remove(), 8000);
  } catch { /* non-critical */ }
}

// ─── Generic run-transaction wrapper ──────────────────────────────────────────
async function cfRunTx(label, fn, contractId = null) {
  try {
    const init = await cfInitProvider();
    if (!init.ok) { showToast(`❌ ${init.message}`, 'error'); return null; }
    if (!(await cfConfirm(`Confirm transaction:\n${label}\n\nThis requires a wallet signature.`, 'Confirm Transaction'))) return null;
    showToast(`📝 ${label} — confirme na carteira…`, 'info');
    const tx = await fn(init);
    cfLog(`${label} tx submitted:`, tx.hash);
    if (contractId !== null) cfLogTx(label, tx.hash, contractId);
    showToast(t('cf_awaiting_confirmation'), 'info');
    const receipt = await tx.wait(1);
    if (receipt.status !== 1) throw new Error('Transaction reverted on-chain.');
    cfLog(`${label} confirmed! Block: ${receipt.blockNumber}`);
    showToast(`✅ ${label} — confirmado! Bloco #${receipt.blockNumber}.`, 'success');
    cfShowTxBadge(receipt.hash, label);
    return receipt;
  } catch (err) {
    cfErr('cfRunTx error:', err);
    const rej = err.code === 4001 || err.code === 'ACTION_REJECTED';
    showToast(rej ? t('cf_tx_rejected') : `❌ ${err.reason || err.message}`, rej ? 'warning' : 'error');
    return null;
  }
}

// ─── Ensure USDC approval ──────────────────────────────────────────────────────
async function cfEnsureApproval(init, amountRaw, stepFn = null) {
  // Safety: never approve zero amount — would indicate a bug upstream
  if (!amountRaw || BigInt(amountRaw) === 0n) {
    throw new Error('Safety: approval amount must be greater than zero.');
  }
  const allowance = await cfReadAllowance(init.address, CF_FACTORY_ADDR);
  if (allowance >= amountRaw) {
    cfLog('Allowance already sufficient:', cfFmtUsdc(allowance), '>= required:', cfFmtUsdc(amountRaw));
    return { alreadyApproved: true };
  }
  cfLog(`Need approval: current=$${cfFmtUsdc(allowance)} required=$${cfFmtUsdc(amountRaw)}`);
  if (stepFn) stepFn(2, 'active', 'Approving USDC — sign in wallet…');
  else cfSetStep(2, 'active', 'Approve USDC — sign in wallet…');
  showToast('📝 Aprovando USDC para ContractFactory — confirme na carteira…', 'info');
  const tx = await init.usdc.approve(CF_FACTORY_ADDR, amountRaw);
  cfLog('✅ Approve tx submitted:', tx.hash);
  cfLogTx('approve', tx.hash, null, { amount: cfFmtUsdc(amountRaw) });
  if (stepFn) stepFn(2, 'active', `Waiting approval: ${tx.hash.slice(0, 14)}…`);
  else cfSetStep(2, 'active', `Waiting: ${tx.hash.slice(0, 14)}…`);
  const r = await tx.wait(1);
  if (r.status !== 1) throw new Error('Approve revertida on-chain.');
  cfLog('✅ Approval confirmed at block', r.blockNumber);
  if (stepFn) stepFn(2, 'done');
  else cfSetStep(2, 'done');
  return { alreadyApproved: false, txHash: tx.hash, block: r.blockNumber };
}

// ─── Deposit modal ─────────────────────────────────────────────────────────────
async function cfShowDepositModal(contractId) {
  const c = cfState.contracts.find(x => x.id === contractId);
  if (!c) { showToast(t('contracts_contract_not_found'), 'error'); return; }

  // Fetch live on-chain deposited value before showing modal
  let liveDeposited = BigInt(c.depositedValue);
  if (cfState._factory) {
    try {
      const onChain = await cfReadDepositedBalance(contractId);
      if (onChain !== null) {
        liveDeposited = onChain;
        c.depositedValue = liveDeposited.toString();
        cfLog(`Deposit modal: live depositedValue=$${cfFmtUsdc(liveDeposited)}`);
      }
    } catch (e) { cfWarn('Could not fetch live deposit:', e.message); }
  }

  const remaining   = BigInt(c.totalValue) - liveDeposited;
  const humanRemain = (Number(remaining) / 1e6).toFixed(2);
  const humanTotal  = cfFmtUsdc(c.totalValue);
  const humanDep    = cfFmtUsdc(liveDeposited);

  document.getElementById('cf-deposit-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'cf-deposit-modal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm';
  modal.innerHTML = `
  <div style="background:#0a0c18;border:1px solid rgba(55,138,221,0.3);border-radius:20px;width:100%;max-width:440px;padding:24px;box-shadow:0 0 40px rgba(55,138,221,0.15);">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
      <h3 style="color:#dde2f0;font-size:15px;font-weight:800;display:flex;align-items:center;gap:8px;">
        <i class="fas fa-arrow-circle-down" style="color:#a78bfa;"></i>Deposit USDC — #${contractId}
      </h3>
      <button onclick="document.getElementById('cf-deposit-modal').remove()"
        style="width:28px;height:28px;border-radius:8px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);color:#6b7280;cursor:pointer;display:flex;align-items:center;justify-content:center;">
        <i class="fas fa-times text-xs"></i></button>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:16px;text-align:center;">
      <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:10px;">
        <div style="font-size:10px;color:#3a4870;margin-bottom:3px;">Total</div>
        <div style="font-size:13px;font-weight:800;color:#dde2f0;">$${humanTotal}</div>
      </div>
      <div style="background:rgba(34,211,238,0.05);border:1px solid rgba(34,211,238,0.15);border-radius:10px;padding:10px;">
        <div style="font-size:10px;color:#3a4870;margin-bottom:3px;">Deposited</div>
        <div style="font-size:13px;font-weight:800;color:#67e8f9;">$${humanDep}</div>
      </div>
      <div style="background:rgba(167,139,250,0.06);border:1px solid rgba(167,139,250,0.2);border-radius:10px;padding:10px;">
        <div style="font-size:10px;color:#a78bfa;margin-bottom:3px;">Remaining</div>
        <div style="font-size:13px;font-weight:800;color:#c4b5fd;">$${humanRemain}</div>
      </div>
    </div>
    <div style="margin-bottom:14px;">
      <label style="font-size:10px;color:#3a4870;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;display:block;margin-bottom:6px;">Amount (USDC)</label>
      <div style="position:relative;">
        <input id="cf-deposit-amount" type="number" value="${humanRemain}" step="0.01" min="0.01" max="${humanRemain}"
          style="width:100%;background:rgba(255,255,255,0.04);border:1px solid rgba(55,138,221,0.25);border-radius:10px;padding:10px 60px 10px 12px;color:#dde2f0;font-size:14px;font-family:monospace;outline:none;box-sizing:border-box;" />
        <button onclick="document.getElementById('cf-deposit-amount').value='${humanRemain}'"
          style="position:absolute;right:8px;top:50%;transform:translateY(-50%);font-size:10px;color:#a78bfa;background:rgba(167,139,250,0.1);border:1px solid rgba(167,139,250,0.2);padding:2px 8px;border-radius:6px;cursor:pointer;">MAX</button>
      </div>
    </div>
    <div id="cf-deposit-steps" style="display:none;margin-bottom:14px;background:rgba(255,255,255,0.02);border:1px solid rgba(55,138,221,0.1);border-radius:10px;padding:12px;">
      <p style="font-size:10px;color:#3a4870;text-transform:uppercase;font-weight:700;margin-bottom:8px;">Progress</p>
      ${[['fa-network-wired','Verify Arc Testnet'],['fa-coins','Check balance'],['fa-check-double','Approve USDC'],['fa-paper-plane','Send deposit'],['fa-hourglass-half','Awaiting confirmation'],['fa-check-circle','Confirmed']].map((s,i) => `
        <div id="cf-dep-step-${i}" class="ct-step ct-step-idle flex items-center gap-2 mb-1">
          <div class="ct-step-icon w-5 h-5 rounded-full flex items-center justify-center text-[9px] flex-shrink-0"><i class="fas ${s[0]}"></i></div>
          <span style="font-size:11px;">${s[1]}</span>
        </div>`).join('')}
      <div id="cf-dep-tx-link" style="display:none;font-size:11px;margin-top:6px;padding-top:6px;border-top:1px solid rgba(55,138,221,0.1);"></div>
    </div>
    <div style="display:flex;gap:10px;">
      <button onclick="cfExecuteDeposit(${contractId})" id="cf-deposit-btn"
        style="flex:1;background:linear-gradient(135deg,#6d28d9,#5b21b6);color:#fff;border:none;border-radius:12px;padding:12px;font-size:13px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;">
        <i class="fas fa-arrow-circle-down"></i>Deposit USDC
      </button>
      <button onclick="document.getElementById('cf-deposit-modal').remove()"
        style="padding:12px 18px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);color:#6b7280;border-radius:12px;cursor:pointer;font-size:13px;">Cancel</button>
    </div>
    <p style="font-size:10px;color:#252a40;margin-top:10px;display:flex;align-items:center;gap:4px;">
      <i class="fas fa-shield-alt"></i>Funds locked in ContractFactory escrow. No private key stored.
    </p>
  </div>`;
  document.body.appendChild(modal);
  setTimeout(() => document.getElementById('cf-deposit-amount')?.focus(), 100);
}

function cfSetDepStep(n, status = 'active', detail = '') {
  const panel = document.getElementById('cf-deposit-steps');
  if (panel) panel.style.display = 'block';
  for (let i = 0; i <= 5; i++) {
    const el = document.getElementById(`cf-dep-step-${i}`);
    if (!el) continue;
    el.classList.remove('ct-step-active', 'ct-step-done', 'ct-step-error', 'ct-step-idle');
    if (i < n)        el.classList.add('ct-step-done');
    else if (i === n) el.classList.add(status === 'error' ? 'ct-step-error' : 'ct-step-active');
    else              el.classList.add('ct-step-idle');
    if (i === n && detail) {
      const span = el.querySelector('span');
      if (span) { if (!span.dataset.base) span.dataset.base = span.textContent; span.textContent = detail; }
    }
  }
}

function cfDepositToContract(contractId) {
  // In ContractFactory.sol, USDC is pulled in full during createContract().
  // There is no separate depositToContract function on-chain.
  // The funds are already deposited when the contract is created.
  const c = cfState.contracts.find(x => x.id === contractId);
  const deposited = c ? `$${cfFmtUsdc(c.depositedValue)} USDC` : 'valor desconhecido';
  showToast(t('cf_contract_already_deposited', contractId, deposited), 'info');
  cfLog(`[INFO] depositToContract called but funds are already deposited at creation. Contract #${contractId} depositedValue=${c?.depositedValue}`);
}

async function cfExecuteDeposit(contractId) {
  // Not used — depositToContract does not exist in ContractFactory.sol.
  // Funds are deposited automatically during createContract().
  showToast(t('cf_deposit_auto_on_creation'), 'info');
  cfLog('[INFO] cfExecuteDeposit: no depositToContract function on-chain — funds are deposited at createContract time.');
}

// ─── Withdraw (informativo — fundos são enviados direto em completeMilestone) ──
async function cfWithdrawFromContract(contractId) {
  // In ContractFactory.sol there is NO withdrawFromContract function.
  // Payment is sent to the contractor automatically when the client calls completeMilestone().
  // Show the milestones status to the contractor so they can see what was released.
  const c = cfState.contracts.find(x => x.id === contractId);
  const released = (c?.milestones || []).filter(m => m.status === 'Released');
  const pending  = (c?.milestones || []).filter(m => m.status === 'Pending');
  const relTotal = released.reduce((s, m) => s + BigInt(m.amount), 0n);
  cfLog(`[INFO] cfWithdrawFromContract: no separate withdraw fn. Released milestones: ${released.length}, total=$${cfFmtUsdc(relTotal)}`);
  if (released.length > 0) {
    showToast(t('cf_milestones_released', released.length, cfFmtUsdc(relTotal), pending.length), 'info');
  } else {
    showToast(t('cf_no_milestone_released_yet'), 'info');
  }
}

async function cfExecuteWithdraw(contractId, releasedAmt) {
  // Stub — no withdrawFromContract on-chain.
  showToast(t('cf_payments_automatic'), 'info');
  cfLog('[INFO] cfExecuteWithdraw: no withdrawFromContract function in ContractFactory.sol.');
}

// ─── Release milestone ─────────────────────────────────────────────────────────
async function cfReleaseMilestone(contractId, milestoneIdx) {
  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Connect your wallet.', 'warning'); return; }
  if (cfState.pending) { showToast('Please wait.', 'warning'); return; }
  // Block during active dispute
  if (cfGetDisputeStatus(contractId) === 'open') {
    showToast('❌ Funds locked — active dispute. Resolve the dispute first.', 'error'); return;
  }
  const c = cfState.contracts.find(x => x.id === contractId);
  if (c?.client?.toLowerCase() !== wallet.toLowerCase()) { showToast('❌ Only the client can release.', 'error'); return; }
  const ms = c?.milestones?.[milestoneIdx];
  const humanAmt = ms ? cfFmtUsdc(ms.amount) : '?';
  if (!(await cfConfirm(`Release Milestone ${milestoneIdx+1} — $${humanAmt} USDC?\n\nThis action is irreversible.`, 'Release Milestone'))) return;

  cfState.pending = true;
  try {
    const receipt = await cfRunTx(`Release Milestone ${milestoneIdx+1} — $${humanAmt} USDC`, async({factory}) => factory.completeMilestone(contractId, milestoneIdx), contractId);
    if (receipt) setTimeout(() => cfLoadContracts({ force: true }), 1500);
  } finally { cfState.pending = false; }
}

// ─── Sign contract ─────────────────────────────────────────────────────────────
async function cfSignContract(contractId) {
  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Connect your wallet.', 'warning'); return; }
  if (cfState.pending) { showToast('Please wait.', 'warning'); return; }
  const c = cfState.contracts.find(x => x.id === contractId);
  if (c?.contractor?.toLowerCase() !== wallet.toLowerCase()) { showToast('❌ Only the contractor can sign.', 'error'); return; }

  cfState.pending = true;
  try {
    const receipt = await cfRunTx(`Sign Contract #${contractId}`, async({factory}) => factory.signContract(contractId), contractId);
    if (receipt) setTimeout(() => cfLoadContracts({ force: true }), 1500);
  } finally { cfState.pending = false; }
}

// ─── Cancel contract ───────────────────────────────────────────────────────────
async function cfCancelContract(contractId) {
  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Connect your wallet.', 'warning'); return; }
  if (cfState.pending) { showToast('Please wait.', 'warning'); return; }
  const c = cfState.contracts.find(x => x.id === contractId);
  if (c?.client?.toLowerCase() !== wallet.toLowerCase()) { showToast('❌ Only the client can cancel.', 'error'); return; }
  if (!(await cfConfirm(`Cancel Contract #${contractId}?\n\n$${c ? cfFmtUsdc(c.depositedValue) : '?'} USDC will be returned.\nThis action is irreversible.`, 'Cancel Contract', { danger: true, okLabel: 'Cancel Contract', cancelLabel: 'Keep Contract' }))) return;

  cfState.pending = true;
  try {
    const receipt = await cfRunTx(`Cancel Contract #${contractId}`, async({factory}) => factory.cancelContract(contractId), contractId);
    if (receipt) setTimeout(() => cfLoadContracts({ force: true }), 1500);
  } finally { cfState.pending = false; }
}

// ─── Create Contract — Mode Selector ──────────────────────────────────────────
function cfGetSelectedMode() {
  const el = document.getElementById('cf-contract-mode');
  return el ? el.value : 'onchain';
}

// ─── Off-chain / Custodial Contract Creation (no blockchain tx) ───────────────
async function cfCreateOffchainContract(mode) {
  const wallet = window.walletState?.address || 'local-' + Date.now();

  const contractor      = (document.getElementById('cf-contractor')?.value || '').trim();
  const title           = (document.getElementById('cf-title')?.value || '').trim();
  const totalValue      = (document.getElementById('cf-value')?.value || '').trim();
  const clientEmail     = (document.getElementById('cf-client-email')?.value || '').trim();
  const contractorEmail = (document.getElementById('cf-contractor-email')?.value || '').trim();
  const custodianAddr   = (document.getElementById('cf-custodian-addr')?.value || '').trim();
  const notes           = (document.getElementById('cf-notes')?.value || '').trim().slice(0, 500);
  const msRows          = document.querySelectorAll('.cf-milestone-row');

  if (!contractor || !title || !totalValue) { showToast(t('cf_fill_required_fields'), 'warning'); return; }
  if (mode === 'custodial') {
    if (!custodianAddr) { showToast('Custodian address is required for Custodial mode.', 'warning'); return; }
    const isAddr = /^0x[0-9a-fA-F]{40}$/.test(custodianAddr);
    if (!isAddr) { showToast('Invalid custodian address. Must be a valid 0x wallet or contract address.', 'error'); return; }
  }
  const humanAmount = parseFloat(totalValue);
  if (isNaN(humanAmount) || humanAmount <= 0) { showToast('Valor deve ser maior que 0.', 'error'); return; }

  const milestoneDescs   = [];
  const milestoneAmounts = [];
  msRows.forEach(row => {
    const d = row.querySelector('.cf-ms-desc')?.value?.trim();
    const a = parseFloat(row.querySelector('.cf-ms-amt')?.value || '0');
    if (d && a > 0) { milestoneDescs.push(d); milestoneAmounts.push(a); }
  });
  if (!milestoneDescs.length) { showToast('Add at least 1 milestone.', 'warning'); return; }

  // Generate a unique local off-chain ID (negative to distinguish from on-chain)
  const localId   = -(Date.now() % 10000000 + Math.floor(Math.random() * 999));
  const paymentNote = mode === 'offchain' ? `Off-Chain Payment — $${humanAmount} USDC` : `Custodial Escrow — $${humanAmount} USDC`;
  const escrowRef   = mode === 'custodial' ? 'CUST-' + Date.now().toString(36).toUpperCase() : '';

  const meta = {
    mode,
    clientEmail,
    contractorEmail,
    proofs: [],
    createdAt:       Date.now(),
    offchainStatus:  'pending',
    paymentNote,
    escrowRef,
    custodianAddr:   mode === 'custodial' ? custodianAddr : '',
    localId,
    createdByWallet: wallet,
    notes:           notes || '',
    milestoneDescs,
    milestoneAmounts,
  };
  cfSetMeta(localId, meta);

  const totalValueRaw    = Math.round(humanAmount * 1e6);
  const milestoneObjects = milestoneDescs.map((d, i) => ({
    id: i, description: d,
    amount: BigInt(Math.round((milestoneAmounts[i] || 0) * 1e6)),
    status: 'Pending', releasedAt: 0,
  }));

  // In-memory object uses BigInt (required by the rest of the UI)
  const syntheticContract = {
    id:                  localId,
    client:              wallet,
    contractor:          contractor,
    title:               title,
    totalValue:          BigInt(totalValueRaw),
    depositedValue:      0n,
    statusCode:          0,
    status:              'Draft',
    contractorSigned:    false,
    createdAt:           Math.floor(Date.now() / 1000),
    startedAt:           0,
    completedAt:         0,
    milestoneCount:      milestoneDescs.length,
    completedMilestones: 0,
    milestones:          milestoneObjects,
    _isOffchain: true,
    mode:        mode,
    _fetchedAt: Date.now(),
  };

  cfState.contracts = [...cfState.contracts.filter(x => x.id !== localId), syntheticContract];

  // Persist to localStorage — BigInt must be converted to Number/String first
  // because JSON.stringify throws on BigInt values.
  try {
    const offchainKey = 'arc_cf_offchain_v1';
    const all = JSON.parse(localStorage.getItem(offchainKey) || '[]');
    // Build a plain-JSON-safe copy (BigInt → Number)
    const serializable = {
      ...syntheticContract,
      totalValue:    totalValueRaw,
      depositedValue: 0,
      milestones: milestoneObjects.map(m => ({
        ...m,
        amount: Number(m.amount),
      })),
    };
    const idx = all.findIndex(x => x.id === localId);
    if (idx >= 0) all[idx] = serializable; else all.unshift(serializable);
    localStorage.setItem(offchainKey, JSON.stringify(all.slice(0, 100)));
  } catch(e) { cfErr('cfCreateOffchainContract persist:', e); }

  cfLogTx('createOffchain', 'local-' + localId, localId, { mode, title, totalValue: humanAmount });

  const modeInfo = CF_MODES[mode] || CF_MODES.offchain;
  showToast(`✅ ${modeInfo.label} contract created! Local ID: ${localId}.`, 'success');

  // Reset form
  ['cf-title','cf-contractor','cf-value','cf-client-email','cf-contractor-email','cf-custodian-addr','cf-notes'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const ctr = document.getElementById('cf-notes-counter'); if(ctr) ctr.textContent='0/500';
  cfResetMilestones();
  cfUpdateFeePreview();

  cfRenderContracts(cfState.contracts, wallet);
  cfRenderSummary(cfState.contracts, wallet);
}

// ─── Load off-chain contracts from localStorage ────────────────────────────────
function cfLoadOffchainContracts() {
  try {
    const all = JSON.parse(localStorage.getItem('arc_cf_offchain_v1') || '[]');
    return all.map(c => {
      // Ensure mode is present on the object (for contracts created before the fix,
      // fall back to meta so cfContractViewMode can classify them correctly).
      let mode = c.mode;
      if (!mode) {
        try {
          const meta = cfGetMeta(c.id);
          mode = meta.mode || 'offchain';
        } catch { mode = 'offchain'; }
      }
      return {
        ...c,
        mode,
        _isOffchain:    true,
        totalValue:     BigInt(c.totalValue || 0),
        depositedValue: BigInt(c.depositedValue || 0),
        milestones:     (c.milestones || []).map(m => ({ ...m, amount: BigInt(m.amount || 0) })),
      };
    });
  } catch(e) { return []; }
}

// ─── Create contract (v6: on-chain escrow + off-chain/custodial modes) ────────
async function cfCreateContract() {
  if (cfState.pending) { showToast(t('contracts_await_tx'), 'warning'); return; }

  const contractMode = cfGetSelectedMode();

  // Off-chain and custodial modes do NOT require wallet connection
  if (contractMode !== 'onchain') {
    return cfCreateOffchainContract(contractMode);
  }

  // Only onchain requires wallet
  const wallet = window.walletState?.address;
  if (!wallet) { showToast(t('cf_connect_wallet_warning'), 'warning'); return; }

  // Network pre-check
  const netCheck = await cfInitProvider();
  if (!netCheck.ok && netCheck.error === 'wrong_network') {
    showToast('❌ Rede incorreta. Troque para Arc Testnet primeiro.', 'error');
    cfUpdateNetworkBanner(false);
    return;
  }

  const contractor       = cfEl('cf-contractor')?.value?.trim();
  const title            = cfEl('cf-title')?.value?.trim();
  const totalValue       = cfEl('cf-value')?.value?.trim();
  const clientEmail      = cfEl('cf-client-email')?.value?.trim();
  const contractorEmail  = cfEl('cf-contractor-email')?.value?.trim();
  const custodianAddr    = (cfEl('cf-custodian-addr')?.value || '').trim();
  const notes            = (cfEl('cf-notes')?.value || '').trim().slice(0, 500);
  const msRows           = document.querySelectorAll('.cf-milestone-row');

  // Validations
  if (!contractor || !title || !totalValue) { showToast(t('cf_fill_required_fields'), 'warning'); return; }
  if (!/^0x[0-9a-fA-F]{40}$/.test(contractor)) { showToast(t('cf_invalid_contractor_address'), 'error'); return; }
  if (contractor.toLowerCase() === wallet.toLowerCase()) { showToast(t('cf_client_contractor_same'), 'error'); return; }

  const humanAmount = parseFloat(totalValue);
  if (isNaN(humanAmount) || humanAmount <= 0) { showToast('Valor deve ser maior que 0.', 'error'); return; }
  if (humanAmount < 1) { showToast(t('cf_min_value'), 'error'); return; }

  if (clientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) { showToast(t('cf_invalid_client_email'), 'error'); return; }
  if (contractorEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contractorEmail)) { showToast(t('cf_invalid_contractor_email'), 'error'); return; }

  const milestoneDescs   = [];
  const milestoneAmounts = [];
  msRows.forEach(row => {
    const d = row.querySelector('.cf-ms-desc')?.value?.trim();
    const a = parseFloat(row.querySelector('.cf-ms-amt')?.value || '0');
    if (d && a > 0) { milestoneDescs.push(d); milestoneAmounts.push(cfParseUsdc(a)); }
  });

  if (!milestoneDescs.length) { showToast('Add at least 1 milestone.', 'warning'); return; }
  if (milestoneDescs.length > 10) { showToast(t('cf_max_10_milestones'), 'error'); return; }

  const totalRaw = cfParseUsdc(humanAmount);
  const sumMs    = milestoneAmounts.reduce((a, b) => a + b, 0n);
  if (sumMs !== totalRaw) {
    const diff = Math.abs(Number(totalRaw - sumMs)) / 1e6;
    showToast(t('cf_milestone_sum_mismatch', Number(sumMs)/1e6, humanAmount, diff.toFixed(6)), 'error');
    return;
  }

  // Fee preview
  const feeRaw = cfCalcFee(totalRaw);
  const netRaw = cfNetAmount(totalRaw);

  cfState.pending = true;
  const btn = cfEl('cf-submit-btn');
  if (btn) { btn.disabled=true; btn.innerHTML='<i class="fas fa-spinner fa-spin mr-2"></i>Processing…'; }

  const unlock = () => {
    cfState.pending = false;
    if (btn) { btn.disabled=false; btn.innerHTML='<i class="fas fa-file-signature mr-2"></i>Create Contract On-Chain'; }
  };

  try {
    cfSetStep(0);
    const init = await cfInitProvider();
    if (!init.ok) {
      if (init.error === 'wrong_network') { showToast('Rede incorreta. Troque para Arc Testnet.', 'error'); cfShowListState('wrong_network', init.message); }
      else showToast(`❌ ${init.message}`, 'error');
      unlock(); return;
    }
    const { factory, usdc, address: fromAddr } = init;

    cfSetStep(1, 'active', 'Verificar saldo USDC');
    const balance = await cfReadBalance(fromAddr);
    if (balance < totalRaw) throw new Error(`Insufficient balance: $${cfFmtUsdc(balance)} available, $${humanAmount} required.`);
    cfSetStep(1, 'done');

    cfSetStep(2, 'active', 'Verificar allowance USDC');
    await cfEnsureApproval(init, totalRaw);
    cfSetStep(2, 'done');

    cfSetStep(3, 'active', 'Estimando gas…');
    let gasLimit;
    try {
      gasLimit = await factory.createContract.estimateGas(contractor, title, totalRaw, milestoneDescs, milestoneAmounts);
      gasLimit = (gasLimit * 125n) / 100n;
    } catch(e) { cfWarn('estimateGas failed:', e.message); gasLimit = 500000n; }
    let feeData;
    try { feeData = await init.provider.getFeeData(); } catch { feeData = { gasPrice: null }; }
    const gasPrice = feeData?.gasPrice ?? 10000000000n;
    const gasFeeUsdc = (Number(gasLimit * gasPrice) / 1e6).toFixed(6);
    showToast(`⛽ Gas: ${gasFeeUsdc} USDC. Fee: $${cfFmtUsdc(feeRaw)}. Net: $${cfFmtUsdc(netRaw)}. Confirme…`, 'info');
    cfSetStep(3, 'done');

    cfSetStep(4, 'active', 'Awaiting wallet signature…');
    const createTx = await factory.createContract(contractor, title, totalRaw, milestoneDescs, milestoneAmounts, { gasLimit });
    cfState.lastTxHash = createTx.hash;
    showToast(`📤 Tx: <a href="${CF_EXPLORER}/tx/${createTx.hash}" target="_blank" class="underline font-mono">${createTx.hash.slice(0,18)}…</a>`, 'info');
    cfSetStep(4, 'done');

    cfSetStep(5, 'active', 'Awaiting confirmation…');
    const receipt = await createTx.wait(1);
    if (receipt.status !== 1) throw new Error(`Tx revertida no bloco #${receipt.blockNumber}.`);

    // Extract new contract ID from ContractCreated event
    // Event sig (7 params, matches ContractFactory.sol):
    //   ContractCreated(uint256 indexed contractId, address indexed client,
    //                   address indexed contractor, string title,
    //                   uint256 totalValue, uint256 milestoneCount, uint256 timestamp)
    let newId = null;
    try {
      const iface = new window.ethers.Interface([
        'event ContractCreated(uint256 indexed contractId, address indexed client, address indexed contractor, string title, uint256 totalValue, uint256 milestoneCount, uint256 timestamp)',
      ]);
      for (const log of receipt.logs) {
        try {
          const d = iface.parseLog(log);
          if (d?.name === 'ContractCreated') {
            newId = Number(d.args[0]); // args[0] = contractId
            cfLog(`ContractCreated event parsed: id=${newId} title="${d.args[3]}" total=${d.args[4]} milestones=${d.args[5]}`);
            break;
          }
        } catch { /* log from a different contract, skip */ }
      }
      if (newId === null) cfWarn('ContractCreated event not found in receipt logs — IDs fetched on reload');
    } catch (e) { cfWarn('Event parse error:', e.message); }
    cfSetStep(5, 'done');

    // ─── Log TX ─────────────────────────────────────────────────────────────────
    cfLog(`✅ Contract created! ID=${newId} tx=${receipt.hash} block=${receipt.blockNumber}`);
    cfLogTx('createContract', receipt.hash, newId, {
      contractor, title, totalValue: humanAmount,
      milestones: milestoneDescs.length,
      block: receipt.blockNumber,
    });

    // ─── Save metadata off-chain ────────────────────────────────────────────────
    cfSetStep(6, 'active', 'Salvando metadados…');
    if (newId !== null) {
      cfSetMeta(newId, {
        clientEmail: clientEmail || '',
        contractorEmail: contractorEmail || '',
        custodianAddr: (contractMode === 'custodial') ? custodianAddr : '',
        notes: notes || '',
        proofs: [],
        createdAt: Date.now(),
        txHash: receipt.hash,
        block: receipt.blockNumber,
      });
      // Also update the IDs cache to include the new contract immediately
      const cachedIds = cfGetCachedIds(wallet) || [];
      if (!cachedIds.includes(newId)) {
        cfCacheIds(wallet, [...cachedIds, newId]);
        cfLog(`Added contract #${newId} to local IDs cache`);
      }
    }
    cfSetStep(6, 'done');

    const arcScanLink = `${CF_EXPLORER}/tx/${receipt.hash}`;
    showToast(`✅ Contract${newId!==null?` #${newId}`:''} created on-chain! Fee: $${cfFmtUsdc(feeRaw)} · Net: $${cfFmtUsdc(netRaw)} · <a href="${arcScanLink}" target="_blank" class="underline">ArcScan ↗</a>`, 'success');
    cfShowTxBadge(receipt.hash, `Contract #${newId !== null ? newId : 'new'} created!`);

    // ─── Capture data for smart autofill (on-chain path) ───────────────────────
    if (typeof arcCaptureCfData === 'function') arcCaptureCfData();

    // ─── Reset form ─────────────────────────────────────────────────────────────
    cfEl('cf-title').value = '';
    cfEl('cf-contractor').value = '';
    cfEl('cf-value').value = '';
    if (cfEl('cf-client-email'))     cfEl('cf-client-email').value = '';
    if (cfEl('cf-contractor-email')) cfEl('cf-contractor-email').value = '';
    if (cfEl('cf-notes')) { cfEl('cf-notes').value = ''; const ctr = document.getElementById('cf-notes-counter'); if(ctr) ctr.textContent='0/500'; }
    cfResetMilestones();
    cfUpdateFeePreview();

    // ─── Auto-refresh list ───────────────────────────────────────────────────────
    setTimeout(() => cfLoadContracts({ force: true }), 1500);
    // Second refresh after 5s to ensure on-chain indexing
    setTimeout(() => cfLoadContracts({ force: true }), 5000);

  } catch (err) {
    cfErr('cfCreateContract:', err);
    const rej = err.code===4001||err.code==='ACTION_REJECTED'||err.message?.includes('rejected')||err.message?.includes('denied');
    if (rej) { showToast(t('cf_tx_rejected'),'warning'); cfHideSteps(); }
    else { showToast(`❌ ${err.reason||err.message}`,'error'); cfSetStep(0,'error',err.message?.slice(0,50)); }
  } finally {
    unlock();
    setTimeout(cfHideSteps, 20000);
  }
}

// ─── Custodian address field visibility (kept as utility, called from mode selector) ───
function cfToggleCustodianField(show) {
  const wrap  = cfEl('cf-custodian-wrap');
  const input = cfEl('cf-custodian-addr');
  if (wrap)  wrap.style.display = show ? '' : 'none';
  if (!show && input) input.value = '';
}

// ─── Fee preview ────────────────────────────────────────────────────────────────
function cfUpdateFeePreview() {
  const val = parseFloat(cfEl('cf-value')?.value || '0');
  const el  = cfEl('cf-fee-preview');
  if (!el) return;
  if (!val || isNaN(val) || val <= 0) { el.textContent = ''; return; }
  const totalRaw = cfParseUsdc(val);
  const feeRaw   = cfCalcFee(totalRaw);
  const netRaw   = cfNetAmount(totalRaw);
  el.innerHTML = `<span style="color:#fbbf24;"><i class="fas fa-info-circle" style="font-size:9px;"></i> Platform fee: $${cfFmtUsdc(feeRaw)} USDC (0.2%) · Net to contractor: <strong style="color:#34d399;">$${cfFmtUsdc(netRaw)} USDC</strong></span>`;
}

// ─── Milestones ────────────────────────────────────────────────────────────────
let cfMilestoneCount = 1;

function cfAddMilestone() {
  if (cfMilestoneCount >= 10) { showToast(t('cf_max_10_milestones'), 'warning'); return; }
  cfMilestoneCount++;
  const container = cfEl('cf-milestones-container');
  if (!container) return;
  const row = document.createElement('div');
  row.className = 'cf-milestone-row flex items-center gap-2';
  row.innerHTML = `
    <input type="text" placeholder="Milestone description" class="cf-ms-desc flex-1 cf-input px-3 py-2 text-sm" oninput="cfUpdateMilestoneSum()" />
    <input type="number" placeholder="USDC" step="0.01" min="0.01" class="cf-ms-amt w-24 cf-input px-3 py-2 text-sm" oninput="cfUpdateMilestoneSum()" />
    <button onclick="this.closest('.cf-milestone-row').remove();cfUpdateMilestoneSum()" type="button"
      style="width:28px;height:28px;border-radius:8px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);color:#f87171;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:11px;">
      <i class="fas fa-times"></i>
    </button>`;
  container.appendChild(row);
  cfUpdateMilestoneSum();
}

function cfResetMilestones() {
  cfMilestoneCount = 1;
  const container = cfEl('cf-milestones-container');
  if (!container) return;
  container.innerHTML = `
    <div class="cf-milestone-row flex items-center gap-2">
      <input type="text" placeholder="Milestone description" class="cf-ms-desc flex-1 cf-input px-3 py-2 text-sm" oninput="cfUpdateMilestoneSum()" />
      <input type="number" placeholder="USDC" step="0.01" min="0.01" class="cf-ms-amt w-24 cf-input px-3 py-2 text-sm" oninput="cfUpdateMilestoneSum()" />
    </div>`;
  // Reset the sum display immediately after clearing rows
  cfUpdateMilestoneSum();
}

function cfUpdateMilestoneSum() {
  let sum = 0;
  document.querySelectorAll('.cf-milestone-row').forEach(r => {
    const v = parseFloat(r.querySelector('.cf-ms-amt')?.value || '0');
    if (v > 0) sum += v;
  });
  const total = parseFloat(cfEl('cf-value')?.value || '0');
  const el    = cfEl('cf-ms-sum');
  if (el) {
    const diff = Math.abs(sum - total);
    const ok   = diff < 0.000001;
    el.textContent = `Sum: $${sum.toFixed(6)} USDC${ok ? ' ✅' : ` (diff: $${diff.toFixed(6)})`}`;
    el.className   = `text-xs mt-1 ${ok ? 'text-green-400' : 'text-yellow-400'}`;
  }
}

// ─── Wallet gate ────────────────────────────────────────────────────────────────
function cfWalletGateUpdate() {
  const wallet = window.walletState?.address;
  if (!wallet) {
    cfShowListState('no_wallet'); // already has mode-guard — skipped for local tabs
    // Only reset the summary on the on-chain tab to avoid wiping _allContracts
    if ((window._cfViewMode || 'onchain') === 'onchain') {
      cfRenderSummary([], null);
    }
    cfUpdateNetworkBanner(false);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// DISPUTE SYSTEM — Full implementation
// ══════════════════════════════════════════════════════════════════════════════

// ── Open Dispute modal ────────────────────────────────────────────────────────
function cfShowOpenDispute(contractId) {
  const wallet = window.walletState?.address;
  const c = cfState.contracts.find(x => x.id === contractId);
  if (!c) { showToast(t('contracts_contract_not_found'), 'error'); return; }

  const isClient = c.client?.toLowerCase() === wallet?.toLowerCase();
  const isContr  = c.contractor?.toLowerCase() === wallet?.toLowerCase();
  if (!isClient && !isContr) { showToast('Only contract participants can open disputes.', 'error'); return; }

  // Check for existing open dispute
  if (cfGetDisputeStatus(contractId) === 'open') {
    showToast(t('cf_dispute_already_open'), 'warning'); return;
  }
  const meta = cfGetMeta(contractId);
  if (meta.contractClosed) { showToast(t('cf_contract_closed_blocked'), 'error'); return; }

  document.getElementById('cf-dispute-open-modal')?.remove();
  window._cfDisputeFiles = [];
  const modal = document.createElement('div');
  modal.id = 'cf-dispute-open-modal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm';
  modal.innerHTML = `
  <div style="background:#0a0c18;border:1px solid rgba(239,68,68,0.3);border-radius:20px;width:100%;max-width:480px;padding:24px;max-height:90vh;overflow-y:auto;">
    <h3 style="color:#f87171;font-size:15px;font-weight:800;margin-bottom:4px;display:flex;align-items:center;gap:8px;">
      <i class="fas fa-gavel"></i>Open Dispute — #${contractId}
    </h3>
          <p style="font-size:11px;color:#4a6490;margin-bottom:16px;">Contract: <strong style="color:#8899bb;">${cfEsc(c.title || 'Untitled')}</strong> · Valor: <strong style="color:#60b4ff;">$${cfFmtUsdc(BigInt(c.totalValue))} USDC</strong></p>

    <div style="background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.2);border-radius:10px;padding:12px;margin-bottom:14px;font-size:11px;color:#f87171;">
      <i class="fas fa-exclamation-triangle mr-1"></i>
      By opening a dispute, the <strong>escrowed funds will be locked</strong> until resolution.
      Only ${c.mode==='onchain'?'both parties':'you and the counterparty'} can resolve the dispute.
    </div>

    <!-- Reason -->
    <div style="margin-bottom:14px;">
      <label style="font-size:11px;color:#8899bb;display:block;margin-bottom:6px;font-weight:600;">
        <i class="fas fa-comment-alt mr-1" style="color:#f87171;"></i>Motivo da Disputa *
      </label>
      <textarea id="cf-dispute-reason" rows="3"
        placeholder="Descreva detalhadamente o motivo da disputa..."
        style="width:100%;background:rgba(239,68,68,0.04);border:1px solid rgba(239,68,68,0.2);border-radius:10px;padding:10px;color:#dde2f0;font-size:12px;resize:vertical;outline:none;font-family:inherit;">
      </textarea>
    </div>

    <!-- Evidence upload -->
    <div style="margin-bottom:14px;">
      <label style="font-size:11px;color:#8899bb;display:block;margin-bottom:6px;font-weight:600;">
        <i class="fas fa-paperclip mr-1" style="color:#f87171;"></i>${t("cf_evidences_optional")}
      </label>
      <div id="cf-dispute-drop"
        onclick="document.getElementById('cf-dispute-file-input').click()"
        ondragover="event.preventDefault();this.style.borderColor='#f87171'"
        ondragleave="this.style.borderColor='rgba(239,68,68,0.3)'"
        ondrop="cfHandleDisputeFileDrop(event,${contractId})"
        style="border:2px dashed rgba(239,68,68,0.3);border-radius:12px;padding:16px;text-align:center;cursor:pointer;transition:all 0.2s;">
        <i class="fas fa-cloud-upload-alt" style="font-size:22px;color:#f87171;display:block;margin-bottom:6px;"></i>
        <p style="font-size:12px;color:#8899bb;">Drag or click to add evidence</p>
        <p style="font-size:10px;color:#4a3a7a;">${t("cf_file_types_small")}</p>
      </div>
      <input type="file" id="cf-dispute-file-input" multiple accept="image/*,.pdf,.doc,.docx"
        style="display:none;" onchange="cfHandleDisputeFileInput(event,${contractId})">
      <div id="cf-dispute-file-list" style="margin-top:8px;"></div>
    </div>

    <div style="display:flex;gap:10px;">
      <button onclick="cfSubmitDispute(${contractId})" id="cf-dispute-submit-btn"
        style="flex:1;background:linear-gradient(135deg,#991b1b,#7f1d1d);color:#fff;border:none;border-radius:12px;padding:12px;font-size:13px;font-weight:700;cursor:pointer;">
        <i class="fas fa-gavel mr-2"></i>Confirm & Open Dispute
      </button>
      <button onclick="document.getElementById('cf-dispute-open-modal').remove()"
        style="padding:12px 18px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);color:#6b7280;border-radius:12px;cursor:pointer;font-size:13px;">Cancelar</button>
    </div>
  </div>`;
  document.body.appendChild(modal);
}

function cfHandleDisputeFileDrop(event, contractId) {
  event.preventDefault();
  document.getElementById('cf-dispute-drop').style.borderColor = 'rgba(239,68,68,0.3)';
  cfHandleDisputeFilesRaw(Array.from(event.dataTransfer.files));
}
function cfHandleDisputeFileInput(event, contractId) {
  cfHandleDisputeFilesRaw(Array.from(event.target.files));
}
function cfHandleDisputeFilesRaw(files) {
  if (!window._cfDisputeFiles) window._cfDisputeFiles = [];
  const MAX = 10 * 1024 * 1024;
  files.forEach(f => {
    if (f.size > MAX) { showToast(`${f.name} exceeds 10MB.`, 'error'); return; }
    if (window._cfDisputeFiles.length >= 5) { showToast(t('cf_max_5_files'), 'warning'); return; }
    if (window._cfDisputeFiles.find(x => x.name === f.name && x.size === f.size)) { showToast(`${f.name} already added.`, 'warning'); return; }
    window._cfDisputeFiles.push(f);
  });
  cfRenderDisputeFileList();
}
function cfRenderDisputeFileList() {
  const el = document.getElementById('cf-dispute-file-list');
  if (!el) return;
  const files = window._cfDisputeFiles || [];
  if (!files.length) { el.innerHTML = ''; return; }
  el.innerHTML = files.map((f, i) => {
    const icon = f.type.startsWith('image') ? 'fa-image' : f.type === 'application/pdf' ? 'fa-file-pdf' : 'fa-file';
    return `<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:rgba(239,68,68,0.04);border:1px solid rgba(239,68,68,0.12);border-radius:8px;margin-bottom:4px;">
      <i class="fas ${icon}" style="color:#f87171;font-size:12px;flex-shrink:0;"></i>
            <span style="flex:1;font-size:11px;color:#8899bb;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${cfEsc(f.name)}</span>
      <span style="font-size:10px;color:#4a3a7a;">${(f.size/1024).toFixed(0)} KB</span>
      <button onclick="window._cfDisputeFiles.splice(${i},1);cfRenderDisputeFileList()"
        style="width:20px;height:20px;border-radius:4px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);color:#f87171;cursor:pointer;font-size:9px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
        <i class="fas fa-times"></i></button>
    </div>`;
  }).join('');
}

async function cfSubmitDispute(contractId) {
  const wallet = window.walletState?.address;
  const c = cfState.contracts.find(x => x.id === contractId);
  const reason = document.getElementById('cf-dispute-reason')?.value?.trim();
  if (!reason || reason.length < 10) { showToast('Descreva o motivo com pelo menos 10 caracteres.', 'warning'); return; }

  const btn = document.getElementById('cf-dispute-submit-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Enviando…'; }

  try {
    // Process evidence files
    const evidence = [];
    const files = window._cfDisputeFiles || [];
    for (const file of files) {
      const url = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload  = e => res(e.target.result);
        r.onerror = rej;
        r.readAsDataURL(file);
      });
      const hash = await cfHashFile(file);
      const type = file.type.startsWith('image') ? 'image' : file.type === 'application/pdf' ? 'pdf' : 'doc';
      evidence.push({ name: file.name, url, type, hash: hash || 'no-crypto', size: file.size, mimeType: file.type, uploadedAt: Date.now() });
    }

    // Store dispute
    cfSetDispute(contractId, {
      status:    'open',
      reason,
      evidence,
      openedBy:  wallet,
      openedAt:  Date.now(),
      contractId,
      // Track mutual approvals (needed for mutual resolution)
      mutualApproval: null,
    });

    // Also mark in meta so cfUiStatus picks it up
    cfSetMeta(contractId, { disputeOpenedAt: Date.now(), disputeOpenedBy: wallet });

    cfLogTx('openDispute', null, contractId, { reason: reason.slice(0, 80), openedBy: wallet });
    showToast('⚖️ Dispute opened! Escrowed funds are now locked.', 'error');
    document.getElementById('cf-dispute-open-modal')?.remove();
    window._cfDisputeFiles = [];
    cfLoadContracts({ force: true });
  } catch(e) {
    cfErr('cfSubmitDispute:', e);
    showToast('Error opening dispute: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-gavel mr-2"></i>Confirm & Open Dispute'; }
  }
}

// ── Dispute Resolution modal ──────────────────────────────────────────────────
function cfShowDisputeResolution(contractId) {
  const wallet = window.walletState?.address;
  const c = cfState.contracts.find(x => x.id === contractId);
  const dispute = cfGetDispute(contractId);
  if (!c || !dispute) { showToast(t('cf_dispute_data_not_found'), 'error'); return; }
  if (dispute.status !== 'open') { showToast(t('cf_dispute_already_resolved'), 'info'); return; }

  const isClient = c.client?.toLowerCase() === wallet?.toLowerCase();
  const isContr  = c.contractor?.toLowerCase() === wallet?.toLowerCase();
  if (!isClient && !isContr) { showToast('Only participants can resolve disputes.', 'error'); return; }

  // Check mutual approval state
  const approvals = dispute.mutualApproval || {};
  const myApproval = approvals[wallet?.toLowerCase()];

  document.getElementById('cf-dispute-resolve-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'cf-dispute-resolve-modal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm';
  modal.innerHTML = `
  <div style="background:#0a0c18;border:1px solid rgba(239,68,68,0.3);border-radius:20px;width:100%;max-width:480px;padding:24px;max-height:90vh;overflow-y:auto;">
    <h3 style="color:#f87171;font-size:15px;font-weight:800;margin-bottom:4px;display:flex;align-items:center;gap:8px;">
      <i class="fas fa-balance-scale"></i>Resolver Disputa — #${contractId}
    </h3>
    <p style="font-size:11px;color:#4a6490;margin-bottom:14px;">${cfEsc(c.title || 'Untitled')} · <strong style="color:#8899bb;">$${cfFmtUsdc(BigInt(c.totalValue))} USDC</strong></p>

    <!-- Dispute details -->
    <div style="background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.2);border-radius:10px;padding:12px;margin-bottom:16px;">
      <div style="font-size:10px;color:#f87171;font-weight:700;text-transform:uppercase;margin-bottom:6px;"><i class="fas fa-gavel mr-1"></i>Dispute Details</div>
      <div style="font-size:12px;color:#dde2f0;margin-bottom:4px;">"${cfEsc(dispute.reason)}"</div>
      <div style="font-size:10px;color:#4a6490;">Opened by: ${cfShort(dispute.openedBy)} · ${new Date(dispute.openedAt).toLocaleString('en-US')}</div>
      ${dispute.evidence?.length ? `<div style="font-size:10px;color:#4a6490;margin-top:4px;">${dispute.evidence.length} file(s) submitted</div>` : ''}
    </div>

    <!-- Note field -->
    <div style="margin-bottom:14px;">
      <label style="font-size:11px;color:#8899bb;display:block;margin-bottom:6px;font-weight:600;">Resolution note (optional)</label>
      <textarea id="cf-resolve-note" rows="2"
        placeholder="Describe the settlement terms or reason for resolution..."
        style="width:100%;background:rgba(55,138,221,0.04);border:1px solid rgba(55,138,221,0.15);border-radius:10px;padding:10px;color:#dde2f0;font-size:12px;resize:vertical;outline:none;font-family:inherit;"></textarea>
    </div>

    <!-- Resolution options (manual — for client only) -->
    ${isClient ? `
    <div style="margin-bottom:16px;">
      <p style="font-size:11px;color:#8899bb;font-weight:700;margin-bottom:8px;"><i class="fas fa-user-shield mr-1" style="color:#60b4ff;"></i>${t("cf_manual_resolution_label")}</p>
      <div style="display:flex;flex-direction:column;gap:8px;">
        <button onclick="cfExecuteDisputeResolution(${contractId},'contractor')"
          style="padding:12px;background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.3);color:#34d399;border-radius:12px;font-size:12px;font-weight:700;cursor:pointer;text-align:left;">
          <i class="fas fa-arrow-right mr-2"></i><strong>Liberar para o Contratado</strong>
          <div style="font-size:10px;opacity:0.7;margin-top:2px;">Confirma que o trabalho foi entregue — $${cfFmtUsdc(BigInt(c.totalValue))} USDC para ${cfShort(c.contractor)}</div>
        </button>
        <button onclick="cfExecuteDisputeResolution(${contractId},'client')"
          style="padding:12px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);color:#f87171;border-radius:12px;font-size:12px;font-weight:700;cursor:pointer;text-align:left;">
          <i class="fas fa-undo mr-2"></i><strong>Devolver ao Cliente</strong>
          <div style="font-size:10px;opacity:0.7;margin-top:2px;">Work not delivered — $${cfFmtUsdc(BigInt(c.totalValue))} USDC retorna para ${cfShort(c.client)}</div>
        </button>
      </div>
    </div>
    <div style="height:1px;background:rgba(255,255,255,0.05);margin-bottom:16px;"></div>
    ` : ''}

    <!-- Mutual agreement -->
    <div style="margin-bottom:16px;">
      <p style="font-size:11px;color:#fbbf24;font-weight:700;margin-bottom:8px;"><i class="fas fa-handshake mr-1"></i>Mutual Agreement (both parties approve):</p>
      ${myApproval ? `
        <div style="padding:10px;background:rgba(52,211,153,0.08);border:1px solid rgba(52,211,153,0.2);border-radius:10px;font-size:11px;color:#34d399;margin-bottom:8px;">
          <i class="fas fa-check-circle mr-1"></i>You already approved this settlement. Awaiting the counterparty.
        </div>` : `
        <button onclick="cfApproveMutualResolution(${contractId})"
          style="width:100%;padding:12px;background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.3);color:#fbbf24;border-radius:12px;font-size:12px;font-weight:700;cursor:pointer;">
          <i class="fas fa-handshake mr-2"></i>Approve Mutual Agreement
          <div style="font-size:10px;opacity:0.7;margin-top:2px;">Both parties must click to confirm the resolution</div>
        </button>`}
    </div>

    <button onclick="document.getElementById('cf-dispute-resolve-modal').remove()"
      style="width:100%;padding:11px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);color:#6b7280;border-radius:12px;cursor:pointer;font-size:13px;">Fechar</button>
  </div>`;
  document.body.appendChild(modal);
}

async function cfExecuteDisputeResolution(contractId, outcome) {
  const wallet = window.walletState?.address;
  const c = cfState.contracts.find(x => x.id === contractId);
  const dispute = cfGetDispute(contractId);
  if (!c || !dispute) return;

  const isClient = c.client?.toLowerCase() === wallet?.toLowerCase();
  if (!isClient) { showToast(t('cf_only_client_can_resolve'), 'error'); return; }

  const note = document.getElementById('cf-resolve-note')?.value?.trim() || '';
  const outcomeLabel = outcome === 'contractor' ? 'liberar para o Contratado' : 'devolver ao Cliente';
  if (!(await cfConfirm(`Confirm resolution: ${outcomeLabel}?\n\nThis action is irreversible.`, 'Confirm Resolution', { danger: true }))) return;

  cfSetDispute(contractId, {
    status: 'resolved',
    resolution: {
      outcome,
      note,
      resolvedBy:  wallet,
      resolvedAt:  Date.now(),
      method:      'manual_client',
    },
  });

  cfSetMeta(contractId, {
    disputeResolvedAt: Date.now(),
    disputeOutcome: outcome,
    offchainStatus: outcome === 'contractor' ? 'confirmed' : 'refunded',
  });

  cfLogTx('resolveDispute', null, contractId, { outcome, resolvedBy: wallet });
  showToast(`✅ Dispute resolved — ${outcomeLabel}.`, 'success');
  document.getElementById('cf-dispute-resolve-modal')?.remove();
  cfLoadContracts({ force: true });
}

async function cfApproveMutualResolution(contractId) {
  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Connect your wallet.', 'warning'); return; }
  const c = cfState.contracts.find(x => x.id === contractId);
  const dispute = cfGetDispute(contractId);
  if (!c || !dispute || dispute.status !== 'open') return;

  const isClient = c.client?.toLowerCase() === wallet?.toLowerCase();
  const isContr  = c.contractor?.toLowerCase() === wallet?.toLowerCase();
  if (!isClient && !isContr) { showToast('Only participants can approve.', 'error'); return; }

  const approvals = dispute.mutualApproval || {};
  approvals[wallet.toLowerCase()] = true;

  // Check if both parties approved
  const clientApproved = approvals[c.client?.toLowerCase()];
  const contrApproved  = approvals[c.contractor?.toLowerCase()];

  if (clientApproved && contrApproved) {
    // Both approved → resolve as mutual
    const note = document.getElementById('cf-resolve-note')?.value?.trim() || '';
    cfSetDispute(contractId, {
      status: 'resolved',
      mutualApproval: approvals,
      resolution: {
        outcome:     'mutual',
        note,
        resolvedBy:  'both_parties',
        resolvedAt:  Date.now(),
        method:      'mutual_agreement',
      },
    });
    cfSetMeta(contractId, { disputeResolvedAt: Date.now(), disputeOutcome: 'mutual' });
    cfLogTx('resolveDispute', null, contractId, { outcome: 'mutual' });
    showToast(t('cf_mutual_agreement_confirmed'), 'success');
    document.getElementById('cf-dispute-resolve-modal')?.remove();
  } else {
    // First party approved — update and wait
    cfSetDispute(contractId, { mutualApproval: approvals });
    showToast(t('cf_waiting_counterparty'), 'info');
    document.getElementById('cf-dispute-resolve-modal')?.remove();
  }
  cfLoadContracts({ force: true });
}

// ── View dispute evidence ─────────────────────────────────────────────────────
function cfViewDisputeEvidence(contractId, evidenceIndex) {
  const dispute = cfGetDispute(contractId);
  const evidences = dispute?.evidence || [];
  const ev = evidences[evidenceIndex];
  if (!ev || !ev.url) { showToast(t('cf_evidence_not_available'), 'error'); return; }

  document.getElementById('cf-dispute-evidence-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'cf-dispute-evidence-modal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.92);backdrop-filter:blur(4px);display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding:0;overflow:hidden;';

  const isImg = ev.type === 'image' || (ev.mimeType && ev.mimeType.startsWith('image/'));
  const isPdf = ev.type === 'pdf' || ev.mimeType === 'application/pdf';

  let content;
  if (isImg) {
    content = `<div style="flex:1;display:flex;align-items:center;justify-content:center;overflow:auto;padding:16px;">
        <img src="${ev.url}" alt="${cfEsc(ev.name)}" style="max-width:100%;max-height:calc(100vh - 100px);object-fit:contain;border-radius:10px;">
    </div>`;
  } else if (isPdf) {
    content = `<div style="flex:1;width:100%;padding:8px 16px;">
        <iframe src="${ev.url}" style="width:100%;height:calc(100vh - 100px);border:none;border-radius:10px;background:#fff;" title="${cfEsc(ev.name)}"></iframe>
    </div>`;
  } else {
    content = `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px;text-align:center;">
      <i class="fas fa-file-alt" style="font-size:56px;color:#f87171;margin-bottom:16px;"></i>
        <p style="color:#dde2f0;font-size:15px;font-weight:700;margin-bottom:20px;">${cfEsc(ev.name)}</p>
      <button onclick="(()=>{const a=document.createElement('a');a.href='${ev.url}';a.download='${ev.name}';a.click()})()"
        style="padding:11px 24px;background:linear-gradient(135deg,#991b1b,#7f1d1d);color:#fff;border:none;border-radius:12px;font-size:13px;font-weight:700;cursor:pointer;">
        <i class="fas fa-download mr-2"></i>${t("cf_download_file")}
      </button>
    </div>`;
  }

  modal.innerHTML = `
    <div style="width:100%;display:flex;align-items:center;gap:10px;padding:14px 20px;background:rgba(10,12,24,0.95);border-bottom:1px solid rgba(239,68,68,0.15);flex-shrink:0;">
      <button onclick="document.getElementById('cf-dispute-evidence-modal').remove()"
        style="width:32px;height:32px;border-radius:8px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.25);color:#f87171;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;">
        <i class="fas fa-times"></i></button>
      <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:700;color:#dde2f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${cfEsc(ev.name)}</div>
        <div style="font-size:10px;color:#f87171;">Dispute Evidence #${contractId} — ${ev.mimeType || 'Arquivo'}</div>
      </div>
      <button onclick="(()=>{const a=document.createElement('a');a.href='${ev.url}';a.download='${ev.name}';a.click()})()"
        style="width:32px;height:32px;border-radius:8px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);color:#f87171;cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center;" title="Baixar">
        <i class="fas fa-download"></i></button>
    </div>
    <div style="flex:1;width:100%;display:flex;flex-direction:column;overflow:auto;">${content}</div>`;

  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
}

// ══════════════════════════════════════════════════════════════════════════════
// CONTRACT CLOSURE — Permanent lock after completion/resolution
// ══════════════════════════════════════════════════════════════════════════════

function cfCloseContract(contractId) {
  const wallet = window.walletState?.address;
  const c = cfState.contracts.find(x => x.id === contractId);
  if (!c) { showToast(t('contracts_contract_not_found'), 'error'); return; }

  const isClient = c.client?.toLowerCase() === wallet?.toLowerCase();
  const isContr  = c.contractor?.toLowerCase() === wallet?.toLowerCase();
  if (!isClient && !isContr) { showToast('Only participants can close the contract.', 'error'); return; }

  const meta = cfGetMeta(contractId);
  if (meta.contractClosed) { showToast(t('cf_contract_already_closed'), 'info'); return; }

  // Cannot close while dispute is open
  if (cfGetDisputeStatus(contractId) === 'open') {
    showToast(t('cf_cannot_close_dispute_active'), 'error'); return;
  }

  const uiStatus = cfUiStatus(c);
  const disputeResolved = cfGetDisputeStatus(contractId) === 'resolved';
  if (uiStatus !== 'Completed' && !disputeResolved) {
    showToast('The contract must be Completed or Dispute Resolved to be closed.', 'warning'); return;
  }

  document.getElementById('cf-close-contract-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'cf-close-contract-modal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm';
  modal.innerHTML = `
  <div style="background:#0a0c18;border:1px solid rgba(74,85,104,0.3);border-radius:20px;width:100%;max-width:440px;padding:24px;">
    <h3 style="color:#9ca3af;font-size:15px;font-weight:800;margin-bottom:4px;display:flex;align-items:center;gap:8px;">
      <i class="fas fa-lock"></i>Close Contract — #${contractId}
    </h3>
    <p style="font-size:11px;color:#4a6490;margin-bottom:16px;">${cfEsc(c.title || 'Untitled')} · $${cfFmtUsdc(BigInt(c.totalValue))} USDC</p>

    <div style="background:rgba(74,85,104,0.1);border:1px solid rgba(74,85,104,0.25);border-radius:10px;padding:12px;margin-bottom:16px;font-size:11px;color:#9ca3af;">
      <i class="fas fa-exclamation-triangle mr-1" style="color:#fbbf24;"></i>
      <strong>Warning:</strong> Closing this contract will <strong>permanently lock all interactions</strong>:
      <ul style="margin-top:8px;margin-left:16px;list-style:disc;color:#6b7280;">
        <li>No additional proof uploads</li>
        <li>No new disputes can be opened</li>
        <li>No edits or cancellations</li>
        <li>Contrato se torna somente leitura</li>
      </ul>
    </div>

    <div style="display:flex;gap:10px;">
      <button onclick="cfExecuteCloseContract(${contractId})" id="cf-close-contract-btn"
        style="flex:1;background:linear-gradient(135deg,#374151,#1f2937);color:#9ca3af;border:1px solid rgba(74,85,104,0.4);border-radius:12px;padding:12px;font-size:13px;font-weight:700;cursor:pointer;">
        <i class="fas fa-lock mr-2"></i>Encerrar Permanentemente
      </button>
      <button onclick="document.getElementById('cf-close-contract-modal').remove()"
        style="padding:12px 18px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);color:#6b7280;border-radius:12px;cursor:pointer;font-size:13px;">Cancelar</button>
    </div>
  </div>`;
  document.body.appendChild(modal);
}

function cfExecuteCloseContract(contractId) {
  const wallet = window.walletState?.address;
  const btn = document.getElementById('cf-close-contract-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Encerrando…'; }

  try {
    cfSetMeta(contractId, {
      contractClosed: true,
      closedAt:       Date.now(),
      closedBy:       wallet,
    });
    cfLogTx('closeContract', null, contractId, { closedBy: wallet });
    showToast('🔒 Contract permanently closed.', 'success');
    document.getElementById('cf-close-contract-modal')?.remove();
    cfLoadContracts({ force: true });
  } catch(e) {
    cfErr('cfExecuteCloseContract:', e);
    showToast('Error closing contract: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-lock mr-2"></i>Encerrar Permanentemente'; }
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  NATIVE IN-APP MODALS  (additive — replaces all browser alert/confirm/prompt)
//  Reusable ExecDaat components: confirm / success / error / loading /
//  transaction-pending. Wallet signatures still originate ONLY from the wallet
//  provider (ethers → MetaMask/Rabby/Coinbase/WalletConnect). No browser popups.
// ════════════════════════════════════════════════════════════════════════════
const CF_MODAL_THEME = {
  confirm: { icon: 'fa-circle-question',     color: '#60b4ff' },
  success: { icon: 'fa-circle-check',        color: '#34d399' },
  error:   { icon: 'fa-circle-exclamation',  color: '#f87171' },
  loading: { icon: 'fa-spinner fa-spin',     color: '#60b4ff' },
  pending: { icon: 'fa-arrows-rotate fa-spin', color: '#a78bfa' },
  wallet:  { icon: 'fa-wallet',              color: '#fbbf24' },
};

function cfModalClose(id) {
  const el = document.getElementById(id || 'cf-ui-modal');
  if (el) { el.style.opacity = '0'; setTimeout(() => { if (el.parentNode) el.remove(); }, 160); }
}

// Core reusable modal renderer. Returns the overlay element.
function cfModalOpen(opts) {
  const o = opts || {};
  const id = o.id || 'cf-ui-modal';
  const prev = document.getElementById(id); if (prev) prev.remove();
  const theme = CF_MODAL_THEME[o.type] || CF_MODAL_THEME.confirm;
  const dismissable = o.dismissable !== false;   // click-outside / ESC (only when safe)
  const overlay = document.createElement('div');
  overlay.id = id;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', o.title || 'Dialog');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.72);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:20px;opacity:0;transition:opacity 0.18s;';
  const buttons = o.buttons || [];
  const actionsHtml = buttons.map((b, i) =>
    `<button data-cf-btn="${i}" style="padding:9px 18px;border-radius:10px;font-size:12px;font-weight:700;cursor:pointer;transition:all .15s;${b.primary
      ? 'background:linear-gradient(135deg,#378ADD,#1D9E75);border:none;color:#fff;box-shadow:0 2px 12px rgba(55,138,221,0.25);'
      : b.danger
        ? 'background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.3);color:#f87171;'
        : 'background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);color:#8aaac8;'}">${cfEsc(b.label)}</button>`
  ).join('');
  overlay.innerHTML =
    '<div role="document" style="background:linear-gradient(160deg,rgba(10,15,28,0.98) 0%,rgba(6,11,22,1) 100%);border:1px solid rgba(55,138,221,0.2);border-radius:18px;max-width:' + (o.maxWidth || 440) + 'px;width:100%;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.6);transform:scale(.96);transition:transform .18s;max-height:90vh;overflow-y:auto;">'
    + '<div style="padding:20px 22px 0;display:flex;align-items:center;gap:11px;">'
    + '<div style="width:38px;height:38px;border-radius:11px;background:' + theme.color + '1f;border:1px solid ' + theme.color + '44;display:flex;align-items:center;justify-content:center;flex-shrink:0;"><i class="fas ' + theme.icon + '" style="color:' + theme.color + ';font-size:16px;"></i></div>'
    + '<div style="flex:1;min-width:0;"><div style="color:#dde2f0;font-size:14px;font-weight:800;">' + cfEsc(o.title || '') + '</div></div>'
    + (dismissable ? '<button data-cf-x style="width:28px;height:28px;border-radius:8px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#6b7280;cursor:pointer;flex-shrink:0;"><i class="fas fa-times text-xs"></i></button>' : '')
    + '</div>'
    + '<div style="padding:12px 22px ' + (actionsHtml ? '4' : '18') + 'px;color:#8aaac8;font-size:12px;line-height:1.6;white-space:pre-wrap;">' + (o.html || cfEsc(o.message || '')) + '</div>'
    + (actionsHtml ? '<div style="padding:0 22px 18px;display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">' + actionsHtml + '</div>' : '')
    + '</div>';
  document.body.appendChild(overlay);
  requestAnimationFrame(() => { overlay.style.opacity = '1'; const box = overlay.querySelector('[role=document]'); if (box) box.style.transform = 'scale(1)'; });
  const doClose = (fromUser) => { cfModalClose(id); if (fromUser && typeof o.onDismiss === 'function') o.onDismiss(); };
  buttons.forEach((b, i) => {
    const el = overlay.querySelector('[data-cf-btn="' + i + '"]');
    if (el) el.onclick = () => { if (!b.keepOpen) cfModalClose(id); if (typeof b.onClick === 'function') b.onClick(); };
  });
  if (dismissable) {
    const x = overlay.querySelector('[data-cf-x]'); if (x) x.onclick = () => doClose(true);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) doClose(true); });
    const esc = (e) => { if (e.key === 'Escape') { document.removeEventListener('keydown', esc); doClose(true); } };
    document.addEventListener('keydown', esc);
  }
  return overlay;
}

// Promise<boolean> confirmation — native (never window.confirm)
function cfConfirm(message, title, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    let settled = false; const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    cfModalOpen({
      id: 'cf-ui-confirm', type: o.danger ? 'error' : 'confirm', title: title || 'Confirm',
      html: '<div style="white-space:pre-wrap;">' + cfEsc(message) + '</div>',
      dismissable: true, onDismiss: () => done(false),
      buttons: [
        { label: o.cancelLabel || 'Cancel', onClick: () => done(false) },
        { label: o.okLabel || 'Confirm', primary: !o.danger, danger: !!o.danger, onClick: () => done(true) },
      ],
    });
  });
}
function cfAlertSuccess(message, title) { cfModalOpen({ id: 'cf-ui-alert', type: 'success', title: title || 'Success', message, buttons: [{ label: 'OK', primary: true }] }); }
function cfAlertError(message, title)   { cfModalOpen({ id: 'cf-ui-alert', type: 'error', title: title || 'Error', message, buttons: [{ label: 'Close', primary: true }] }); }
function cfShowLoading(message, title)  { return cfModalOpen({ id: 'cf-ui-loading', type: 'loading', title: title || 'Please wait…', message: message || '', dismissable: false }); }
function cfShowTxPending(message, title){ return cfModalOpen({ id: 'cf-ui-loading', type: 'pending', title: title || 'Transaction Pending', message: message || 'Confirm in your wallet, then wait for on-chain confirmation…', dismissable: false }); }
function cfHideLoading() { cfModalClose('cf-ui-loading'); }

// ════════════════════════════════════════════════════════════════════════════
//  INDEPENDENT PER-MILESTONE PROOF & ATTESTATION WORKFLOW  (additive)
//  Each milestone keeps fully independent state under meta.milestoneData[idx].
//  Nothing here changes escrow / payment / deployment / dispute / refund logic:
//  the on-chain release still runs through the existing cfReleaseMilestone().
//  All state is persisted in localStorage, so a page refresh restores it.
// ════════════════════════════════════════════════════════════════════════════
const CF_MS_STATUS = {
  created:         { label: 'Created',            color: '#5f7ba0', icon: 'fa-circle' },
  proof_submitted: { label: 'Proof Submitted',    color: '#a78bfa', icon: 'fa-file-upload' },
  attested:        { label: 'Attestation Created',color: '#67e8f9', icon: 'fa-stamp' },
  approved:        { label: 'Approved',           color: '#fbbf24', icon: 'fa-user-check' },
  rejected:        { label: 'Rejected',           color: '#f87171', icon: 'fa-times-circle' },
  released:        { label: 'Released',           color: '#34d399', icon: 'fa-unlock' },
};

function cfGetMsData(contractId, idx) {
  const all = cfGetMeta(contractId).milestoneData || {};
  return all[String(idx)] || {};
}
function cfSetMsData(contractId, idx, patch) {
  const meta = cfGetMeta(contractId);
  const all = { ...(meta.milestoneData || {}) };
  all[String(idx)] = { ...(all[String(idx)] || {}), ...patch };
  cfSetMeta(contractId, { milestoneData: all });
}
function cfMsEffectiveStatus(c, idx, m) {
  const d = cfGetMsData(c.id, idx);
  if ((m && m.status === 'Released') || d.released) return 'released';
  return d.status || 'created';
}
async function cfSha256Text(text) {
  try {
    const buf = new TextEncoder().encode(String(text));
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch { return 'sha-' + Math.random().toString(16).slice(2); }
}
function cfMsRerender() {
  try { cfRenderContracts(cfState.contracts, window.walletState?.address); } catch (_) {}
}

// Render the independent workflow block for a single milestone.
function cfMilestoneWorkflowHtml(c, i, m, ctx) {
  ctx = ctx || {};
  const d = cfGetMsData(c.id, i);
  const st = cfMsEffectiveStatus(c, i, m);
  const info = CF_MS_STATUS[st] || CF_MS_STATUS.created;
  const isContr = !!ctx.isContr, isClient = !!ctx.isClient;
  const onchain = ctx.mode === 'onchain';
  const locked = !!ctx.isInDispute || !!ctx.isClosed;
  const hasProof = !!d.proofHash;
  const hasAtt = !!d.attestationUID;
  const approved = d.attestationStatus === 'approved';
  const rejected = d.attestationStatus === 'rejected';
  const released = st === 'released';
  const relTs = d.releaseTimestamp || (m && Number(m.releasedAt) > 0 ? Number(m.releasedAt) * 1000 : 0);

  const steps = [
    { label: 'Created',             done: true,        ts: d.createdAt },
    { label: 'Proof Submitted',     done: hasProof,    ts: d.proofTimestamp },
    { label: 'Attestation Created', done: hasAtt,      ts: d.attestationTimestamp },
    { label: 'Approved',            done: approved,    ts: d.approvedAt },
    { label: 'Released',            done: released,    ts: relTs },
  ];
  const tl = steps.map((s, k) => `<div style="display:flex;align-items:center;gap:6px;">
      <span style="width:14px;height:14px;border-radius:50%;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;font-size:7px;${s.done ? 'background:rgba(52,211,153,0.18);border:1px solid rgba(52,211,153,0.4);color:#34d399' : 'background:rgba(74,85,104,0.12);border:1px solid rgba(74,85,104,0.3);color:#5f7ba0'}"><i class="fas ${s.done ? 'fa-check' : 'fa-circle'}"></i></span>
      <span style="font-size:9.5px;color:${s.done ? '#cdd8ea' : '#5f7ba0'};font-weight:${s.done ? '700' : '500'};">${s.label}${s.done && s.ts ? ' · ' + cfTsMs(s.ts) : ''}</span>
    </div>`).join('<div style="width:1px;height:8px;background:rgba(55,138,221,0.2);margin-left:6px;"></div>');

  const btn = (fn, label, icon, style) => `<button onclick="event.stopPropagation();${fn}" class="cf-action-btn" style="padding:3px 9px;font-size:9.5px;${style || ''}"><i class="fas ${icon} mr-1"></i>${label}</button>`;
  const btns = [];
  if (!locked && !released) {
    if (isContr && !hasProof) btns.push(btn(`cfMsSubmitProof(${c.id},${i})`, 'Submit Proof', 'fa-upload', 'background:rgba(167,139,250,0.1);border:1px solid rgba(167,139,250,0.3);color:#a78bfa;'));
    if (isClient && hasProof && !hasAtt) btns.push(btn(`cfMsCreateAttestation(${c.id},${i})`, 'Create Attestation', 'fa-stamp', 'background:rgba(103,232,249,0.1);border:1px solid rgba(103,232,249,0.3);color:#67e8f9;'));
    if (isClient && hasAtt && !approved && !rejected) {
      btns.push(btn(`cfMsApproveProof(${c.id},${i})`, 'Approve', 'fa-check', 'background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.3);color:#34d399;'));
      btns.push(btn(`cfMsRejectProof(${c.id},${i})`, 'Reject', 'fa-times', 'background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);color:#f87171;'));
    }
    if (isClient && approved) btns.push(btn(`cfMsRelease(${c.id},${i})`, 'Release Funds', 'fa-unlock', 'background:rgba(52,211,153,0.12);border:1px solid rgba(52,211,153,0.35);color:#34d399;'));
  }
  if (hasProof) btns.push(btn(`cfMsViewProof(${c.id},${i})`, 'View Proof', 'fa-eye', 'background:rgba(55,138,221,0.09);border:1px solid rgba(55,138,221,0.25);color:#60b4ff;'));
  if (hasAtt && isClient) btns.push(btn(`cfMsViewAttestation(${c.id},${i})`, 'View Attestation', 'fa-certificate', 'background:rgba(55,138,221,0.09);border:1px solid rgba(55,138,221,0.25);color:#60b4ff;'));

  const proofLine = hasProof
    ? `<div style="font-size:9.5px;color:#8aaac8;"><i class="fas fa-fingerprint mr-1" style="color:#a78bfa;"></i>${cfEsc(d.proofCID || 'proof')} · <span class="cf-mono">${(d.proofHash || '').slice(0, 12)}…</span></div>`
    : `<div style="font-size:9.5px;color:#5f7ba0;font-style:italic;">No proof submitted yet.</div>`;
  const attLine = (hasAtt && isClient)
    ? `<div style="font-size:9.5px;color:#8aaac8;"><i class="fas fa-certificate mr-1" style="color:#67e8f9;"></i>UID <span class="cf-mono">${(d.attestationUID || '').slice(0, 12)}…</span> · <span style="color:${approved ? '#34d399' : rejected ? '#f87171' : '#fbbf24'};font-weight:700;">${approved ? 'Approved' : rejected ? 'Rejected' : 'Pending'}</span></div>`
    : '';

  return `<div class="cf-ms-wf" style="margin-top:8px;padding:9px 11px;border-radius:10px;background:rgba(10,14,26,0.5);border:1px solid rgba(55,138,221,0.1);">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:7px;">
        <span style="display:inline-flex;align-items:center;gap:5px;font-size:9.5px;font-weight:800;color:${info.color};"><i class="fas ${info.icon}" style="font-size:9px;"></i>${info.label}</span>
        <div style="display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end;">${btns.join('')}</div>
      </div>
      ${proofLine}
      ${attLine}
      <div style="display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:7px;">${tl}</div>
    </div>`;
}

// ── Submit Proof (independent per milestone) ────────────────────────────────
function cfMsSubmitProof(contractId, idx) {
  const c = cfState.contracts.find(x => x.id === contractId);
  const m = c?.milestones?.[idx];
  document.getElementById('cf-ms-proof-modal')?.remove();
  const modal = cfModalOpen({
    id: 'cf-ms-proof-modal', type: 'wallet', title: `Submit Proof · Milestone ${idx + 1}`, dismissable: true,
    html:
      `<div style="font-size:11px;color:#8aaac8;margin-bottom:10px;">Attach a file <strong>or</strong> provide a reference (URL, GitHub repo, IPFS CID). This proof belongs only to milestone ${idx + 1} and never overwrites other milestones.</div>`
      + `<input type="file" id="cf-ms-proof-file" style="width:100%;font-size:11px;color:#8aaac8;margin-bottom:10px;">`
      + `<input type="text" id="cf-ms-proof-ref" placeholder="Reference (https://…, github.com/…, ipfs://CID)" style="width:100%;background:rgba(255,255,255,0.04);border:1px solid rgba(167,139,250,0.25);color:#dde2f0;border-radius:8px;padding:9px 11px;font-size:12px;outline:none;">`,
    buttons: [
      { label: 'Cancel' },
      { label: 'Submit Proof', primary: true, keepOpen: true, onClick: () => cfMsExecuteProof(contractId, idx) },
    ],
  });
  return modal;
}
async function cfMsExecuteProof(contractId, idx) {
  const c = cfState.contracts.find(x => x.id === contractId);
  const m = c?.milestones?.[idx];
  const fileEl = document.getElementById('cf-ms-proof-file');
  const refEl = document.getElementById('cf-ms-proof-ref');
  const file = fileEl?.files?.[0] || null;
  const ref = (refEl?.value || '').trim();
  if (!file && !ref) { cfAlertError('Please attach a file or enter a reference.', 'Proof required'); return; }

  const existing = cfGetMsData(contractId, idx);
  if (existing.proofHash) {
    const ok = await cfConfirm(`Milestone ${idx + 1} already has a proof. Replace it? The previous proof for this milestone will be overwritten (other milestones are unaffected).`, 'Replace proof?');
    if (!ok) return;
  }

  let proofHash, proofCID, proofUrl = null, proofName = null, proofMime = null;
  try {
    if (file) {
      if (file.size > 10 * 1024 * 1024) { cfAlertError('File exceeds 10MB.', 'Too large'); return; }
      proofHash = await cfHashFile(file);
      proofUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = e => res(e.target.result); r.onerror = rej; r.readAsDataURL(file); });
      proofName = file.name; proofMime = file.type;
      proofCID = ref || file.name;
    } else {
      proofHash = await cfSha256Text(ref + '|' + contractId + '|' + idx);
      proofCID = ref;
    }
  } catch (e) { cfAlertError('Failed to process proof: ' + (e.message || e), 'Error'); return; }

  cfSetMsData(contractId, idx, {
    milestoneId: idx,
    title: (m && m.description) || ('Milestone ' + (idx + 1)),
    amount: m ? String(m.amount) : '0',
    status: 'proof_submitted',
    proofCID, proofHash,
    proofUrl, proofName, proofMime,
    proofTimestamp: Date.now(),
    proofAuthor: window.walletState?.address || 'unknown',
    createdAt: existing.createdAt || Date.now(),
  });
  cfModalClose('cf-ms-proof-modal');
  try { cfLog(`[milestone ${idx}] proof submitted · #${contractId} · ${(proofHash || '').slice(0, 16)}…`); } catch (_) {}
  showToast(`✅ Proof submitted for Milestone ${idx + 1}.`, 'success');
  cfMsRerender();
}

function cfMsViewProof(contractId, idx) {
  const d = cfGetMsData(contractId, idx);
  if (!d.proofHash) { cfAlertError('No proof for this milestone.', 'Not found'); return; }
  let body = '';
  if (d.proofUrl && (d.proofMime || '').startsWith('image/')) {
    body = `<img src="${d.proofUrl}" alt="${cfEsc(d.proofName || 'proof')}" style="max-width:100%;border-radius:10px;">`;
  } else if (d.proofUrl && d.proofMime === 'application/pdf') {
    body = `<iframe src="${d.proofUrl}" style="width:100%;height:60vh;border:none;border-radius:10px;background:#fff;" title="proof"></iframe>`;
  } else if (d.proofUrl) {
    body = `<a href="${d.proofUrl}" download="${cfEsc(d.proofName || 'proof')}" style="color:#a78bfa;">Download ${cfEsc(d.proofName || 'file')}</a>`;
  } else {
    const isLink = /^(https?:|ipfs:)/i.test(d.proofCID || '');
    body = isLink
      ? `<a href="${cfEsc(d.proofCID)}" target="_blank" rel="noopener" style="color:#60b4ff;word-break:break-all;">${cfEsc(d.proofCID)}</a>`
      : `<span style="word-break:break-all;color:#dde2f0;">${cfEsc(d.proofCID || '')}</span>`;
  }
  cfModalOpen({
    id: 'cf-ui-viewer', type: 'confirm', title: `Proof · Milestone ${idx + 1}`, maxWidth: 620, dismissable: true,
    html: body
      + `<div style="margin-top:12px;font-size:10px;color:#5f7ba0;">`
      + `<div>SHA-256: <span class="cf-mono" style="word-break:break-all;color:#8aaac8;">${cfEsc(d.proofHash || '')}</span></div>`
      + `<div style="margin-top:3px;">Submitted by ${cfEsc(cfShort(d.proofAuthor))} · ${d.proofTimestamp ? cfTsMs(d.proofTimestamp) : ''}</div>`
      + `</div>`,
    buttons: [{ label: 'Close', primary: true }],
  });
}

async function cfMsCreateAttestation(contractId, idx) {
  const _c = (cfState.contracts || []).find(x => String(x.id) === String(contractId));
  const _w = (window.walletState && window.walletState.address || '').toLowerCase();
  if (!_c || !_w || (_c.client || '').toLowerCase() !== _w) { cfAlertError('Only the client can create attestations.', 'Client only'); return; }
  const d = cfGetMsData(contractId, idx);
  if (!d.proofHash) { cfAlertError('Attestation requires a submitted proof first.', 'Proof required'); return; }
  if (d.attestationUID) { cfAlertError('This milestone already has an attestation.', 'Already attested'); return; }
  const ok = await cfConfirm(`Create an on-record attestation for the proof of Milestone ${idx + 1}?\n\nThis certifies the delivered work for client review.`, 'Create Attestation');
  if (!ok) return;
  const uid = await cfSha256Text('att|' + contractId + '|' + idx + '|' + d.proofHash + '|' + Date.now());
  cfSetMsData(contractId, idx, {
    status: 'attested',
    attestationUID: uid,
    attestationTimestamp: Date.now(),
    attestationStatus: 'pending',
    attestationAuthor: window.walletState?.address || 'unknown',
  });
  try { cfLog(`[milestone ${idx}] attestation ${uid.slice(0, 16)}… created · #${contractId}`); } catch (_) {}
  showToast(`✅ Attestation created for Milestone ${idx + 1}.`, 'success');
  cfMsRerender();
}

function cfMsViewAttestation(contractId, idx) {
  const _c = (cfState.contracts || []).find(x => String(x.id) === String(contractId));
  const _w = (window.walletState && window.walletState.address || '').toLowerCase();
  if (!_c || !_w || (_c.client || '').toLowerCase() !== _w) { cfAlertError('Only the client can view attestations.', 'Client only'); return; }
  const d = cfGetMsData(contractId, idx);
  if (!d.attestationUID) { cfAlertError('No attestation for this milestone.', 'Not found'); return; }
  const stColor = d.attestationStatus === 'approved' ? '#34d399' : d.attestationStatus === 'rejected' ? '#f87171' : '#fbbf24';
  cfModalOpen({
    id: 'cf-ui-viewer', type: 'confirm', title: `Attestation · Milestone ${idx + 1}`, maxWidth: 520, dismissable: true,
    html:
      `<div style="font-size:11px;line-height:1.8;color:#8aaac8;">`
      + `<div>UID: <span class="cf-mono" style="word-break:break-all;color:#dde2f0;">${cfEsc(d.attestationUID)}</span></div>`
      + `<div>Status: <span style="color:${stColor};font-weight:800;">${cfEsc((d.attestationStatus || 'pending').toUpperCase())}</span></div>`
      + `<div>Linked proof: <span class="cf-mono" style="color:#8aaac8;">${cfEsc((d.proofHash || '').slice(0, 20))}…</span></div>`
      + `<div>Created: ${d.attestationTimestamp ? cfTsMs(d.attestationTimestamp) : '—'}</div>`
      + (d.reviewer ? `<div>Reviewer: ${cfEsc(cfShort(d.reviewer))}</div>` : '')
      + (d.approvedAt ? `<div>Approved: ${cfTsMs(d.approvedAt)}</div>` : '')
      + `</div>`,
    buttons: [{ label: 'Close', primary: true }],
  });
}

async function cfMsApproveProof(contractId, idx) {
  const d = cfGetMsData(contractId, idx);
  if (!d.attestationUID) { cfAlertError('Create the attestation before approving.', 'Attestation required'); return; }
  if (d.attestationStatus === 'approved') { cfAlertError('This milestone is already approved.', 'Already approved'); return; }
  const ok = await cfConfirm(`Approve the attestation for Milestone ${idx + 1}?\n\nAfter approval you can release the funds for this milestone.`, 'Approve Milestone');
  if (!ok) return;
  cfSetMsData(contractId, idx, { status: 'approved', attestationStatus: 'approved', reviewer: window.walletState?.address || 'unknown', approvedAt: Date.now() });
  showToast(`✅ Milestone ${idx + 1} approved.`, 'success');
  cfMsRerender();
}

async function cfMsRejectProof(contractId, idx) {
  const d = cfGetMsData(contractId, idx);
  if (!d.attestationUID) { cfAlertError('Nothing to reject — no attestation yet.', 'Not found'); return; }
  if (d.attestationStatus === 'approved') { cfAlertError('Cannot reject an already-approved milestone.', 'Already approved'); return; }
  const ok = await cfConfirm(`Reject the attestation for Milestone ${idx + 1}?\n\nThe contractor can submit a new proof afterwards.`, 'Reject Milestone', { danger: true, okLabel: 'Reject' });
  if (!ok) return;
  cfSetMsData(contractId, idx, { status: 'rejected', attestationStatus: 'rejected', reviewer: window.walletState?.address || 'unknown', rejectedAt: Date.now() });
  showToast(`Milestone ${idx + 1} attestation rejected.`, 'warning');
  cfMsRerender();
}

// Release funds for a single milestone. On-chain contracts reuse the existing
// cfReleaseMilestone() (real wallet signature + completeMilestone tx). Off-chain
// agreements mark the milestone released locally. Validation prevents releasing
// without proof and prevents double release.
async function cfMsRelease(contractId, idx) {
  const c = cfState.contracts.find(x => x.id === contractId);
  const d = cfGetMsData(contractId, idx);
  const m = c?.milestones?.[idx];
  if ((m && m.status === 'Released') || d.released) { cfAlertError('This milestone was already released.', 'Already released'); return; }
  if (!d.proofHash) { cfAlertError('Cannot release without a submitted proof.', 'Proof required'); return; }
  if (d.attestationStatus !== 'approved') {
    const ok = await cfConfirm(`Milestone ${idx + 1} has not been approved yet. Release anyway?`, 'Release without approval', { danger: true, okLabel: 'Release' });
    if (!ok) return;
  }
  const onchain = (c?.mode || (c?.custodian ? 'custodian' : 'onchain')) === 'onchain';
  if (onchain && typeof cfReleaseMilestone === 'function') {
    // Delegates to the existing, unchanged on-chain release flow.
    await cfReleaseMilestone(contractId, idx);
    // Record per-milestone release metadata (does not affect on-chain logic).
    cfSetMsData(contractId, idx, { status: 'released', released: true, releaseTimestamp: Date.now() });
    cfMsRerender();
  } else {
    cfSetMsData(contractId, idx, { status: 'released', released: true, releaseTimestamp: Date.now() });
    showToast(`✅ Milestone ${idx + 1} marked as released.`, 'success');
    cfMsRerender();
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  OPEN CONTRACT AS AN IN-APP SUBPAGE  (additive)
//  Clicking "Open Page" shows a focused subpage — inside the SAME tab — with
//  only that contract's section, keeping the flow clearer while working on /
//  finishing the contract. Fully interactive (reuses the live card). No new tab,
//  no reload. Additive: only active while window.cfFocusId is set.
// ════════════════════════════════════════════════════════════════════════════
function cfOpenContractPage(contractId) {
  window.cfFocusId = String(contractId);
  try { if (typeof switchTab === 'function') switchTab('contracts'); } catch (_) {}
  // Hide the create-contract form + list chrome — show only this contract section.
  try { var tab = document.getElementById('tab-content-contracts'); if (tab) tab.classList.add('cf-focus-mode'); } catch (_) {}
  try { cfRenderContracts(cfState.contracts, window.walletState && window.walletState.address); } catch (_) {}
  // Bring the focused subpage into view (same tab).
  try {
    var top = document.getElementById('tab-content-contracts') || cfEl('cf-contracts-list');
    if (top && top.scrollIntoView) top.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (_) {}
}

// Render a single contract as a focused, fully-interactive "page" (used by the
// /contracts?focus=<id> deep link and the in-app fallback). Reuses the exact
// same live card, so every action button works. Additive — only active when
// window.cfFocusId is set.
function cfRenderFocused(el, contracts, wallet, focusId) {
  const c = (contracts || []).find(x => String(x.id) === focusId)
         || (cfState.contracts || []).find(x => String(x.id) === focusId);
  const banner = '<div class="cf-focus-banner" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 14px;padding:11px 14px;border-radius:12px;background:linear-gradient(135deg,rgba(55,138,221,0.1),rgba(29,158,117,0.06));border:1px solid rgba(55,138,221,0.25);">'
    + '<span style="width:30px;height:30px;border-radius:9px;background:rgba(55,138,221,0.15);border:1px solid rgba(55,138,221,0.3);display:inline-flex;align-items:center;justify-content:center;color:#60b4ff;flex-shrink:0;"><i class="fas fa-file-contract"></i></span>'
    + '<div style="flex:1;min-width:0;"><div style="font-size:13px;font-weight:800;color:#dde2f0;">Contract #' + cfEsc(focusId) + ' · Focused page</div>'
    + '<div style="font-size:10.5px;color:#8aaac8;">Live view — complete every action for this contract right here.</div></div>'
    + '<button onclick="cfExitFocus()" class="cf-action-btn" style="padding:5px 12px;font-size:11px;background:rgba(55,138,221,0.1);border:1px solid rgba(55,138,221,0.3);color:#60b4ff;"><i class="fas fa-layer-group mr-1"></i>Show all contracts</button>'
    + '</div>';
  if (!c) {
    const arr = cfState.contracts || [];
    const hasWallet = !!(window.walletState && window.walletState.address);
    const loading = !!cfState.pending || (arr.length === 0 && hasWallet);
    const icon = loading ? 'fa-spinner fa-spin' : 'fa-circle-question';
    const msg = loading
      ? 'Loading contract #' + cfEsc(focusId) + '…'
      : 'Contract #' + cfEsc(focusId) + ' is not available for the connected wallet.';
    const hint = loading
      ? 'Fetching from the network…'
      : 'It may belong to another wallet, be on a different mode tab, or still be syncing.';
    el.innerHTML = banner + '<div style="color:#8aaac8;font-size:12px;text-align:center;padding:36px 0;display:flex;flex-direction:column;align-items:center;gap:12px;">'
      + '<div style="width:46px;height:46px;border-radius:13px;background:rgba(55,138,221,0.06);border:1px solid rgba(55,138,221,0.12);display:flex;align-items:center;justify-content:center;"><i class="fas ' + icon + '" style="color:#60b4ff;font-size:18px;"></i></div>'
      + '<span>' + msg + '</span>'
      + '<span style="font-size:11px;color:#3a4870;max-width:340px;">' + hint + '</span>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;">'
      + '<button onclick="cfLoadContracts({force:true})" class="cf-action-btn" style="padding:6px 14px;font-size:11px;background:rgba(55,138,221,0.1);border:1px solid rgba(55,138,221,0.3);color:#60b4ff;"><i class="fas fa-rotate mr-1"></i>Retry</button>'
      + '<button onclick="cfExitFocus()" class="cf-action-btn" style="padding:6px 14px;font-size:11px;background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.3);color:#34d399;"><i class="fas fa-layer-group mr-1"></i>Show all contracts</button>'
      + '</div></div>';
    return;
  }
  el.innerHTML = banner + cfContractCard(c, wallet);
}

// Exit the focused page → restore the full contract list (and clean the URL).
function cfExitFocus() {
  window.cfFocusId = null;
  try { var tab = document.getElementById('tab-content-contracts'); if (tab) tab.classList.remove('cf-focus-mode'); } catch (_) {}
  try { if (history && history.replaceState) history.replaceState({ tab: 'contracts', path: '/contracts' }, '', '/contracts'); } catch (_) {}
  try { cfRenderContracts(cfState.contracts, window.walletState && window.walletState.address); } catch (_) {}
}

// Bootstrap: if the page was opened as /contracts?focus=<id>, enter focus mode.
(function cfFocusBootstrap() {
  try {
    var f = new URLSearchParams(location.search).get('focus');
    if (!f) return;
    window.cfFocusId = String(f);
    var kick = function () {
      try { if (typeof switchTab === 'function') switchTab('contracts'); } catch (_) {}
      try { var tab = document.getElementById('tab-content-contracts'); if (tab) tab.classList.add('cf-focus-mode'); } catch (_) {}
      // switchTab('contracts') triggers cfLoadContracts(); ensure a focused render
      // once data arrives (and a couple of retries while it loads).
      var tries = 0;
      var iv = setInterval(function () {
        tries++;
        try { cfRenderContracts(cfState.contracts, window.walletState && window.walletState.address); } catch (_) {}
        var found = (cfState.contracts || []).some(function (x) { return String(x.id) === String(window.cfFocusId); });
        if (found || tries >= 8 || !window.cfFocusId) clearInterval(iv);
      }, 900);
    };
    if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(kick, 350);
    else document.addEventListener('DOMContentLoaded', function () { setTimeout(kick, 350); });
  } catch (_) {}
})();
