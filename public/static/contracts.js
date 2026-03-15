// ============================================================
// ARC Contracts Module — Blockchain receipt on contract creation
// and escrow deposit on ARC Testnet (chainId 5042002)
//
// Mirrors Solidity structs:
//   struct Receipt {
//     uint256 id;          // receiptCount
//     address client;
//     address contractor;
//     uint256 amount;      // micro-USDC (6 decimals)
//     string  contractTitle;
//     uint256 timestamp;
//   }
//   mapping(uint256 => Receipt) public receipts;
//   uint256 public receiptCount;
//   event ContractReceiptIssued(uint256 indexed receiptId, address client, address contractor,
//                               uint256 amount, string contractTitle, uint256 timestamp);
//   event EscrowDepositIssued(uint256 indexed receiptId, uint256 contractId, address depositor,
//                             uint256 amount, bytes32 txHash, uint256 timestamp);
// ============================================================
'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const CT_USDC_ADDR   = () => window.USDC_ADDRESS || '0x3600000000000000000000000000000000000000';
const CT_EURC_ADDR   = () => window.EURC_ADDRESS || '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const CT_EXPLORER    = () => window.ARC_EXPLORER  || 'https://testnet.arcscan.app';
const CT_CHAIN_ID    = 5042002;
const CT_CHAIN_HEX   = '0x4CFC12';
const CT_NETWORK     = 'Arc Testnet';

// Escrow / custodian address (ARC Testnet — deploy real contract to replace)
const CT_ESCROW_ADDR = '0x867650F5eAe8df91445971f14d89fd84F0C9a9f8';

// ERC-20 selectors
const CT_SEL_TRANSFER  = '0xa9059cbb';
const CT_SEL_APPROVE   = '0x095ea7b3';
const CT_SEL_BALANCE   = '0x70a08231';
const CT_SEL_ALLOWANCE = '0xdd62ed3e';

// ─── Module state ─────────────────────────────────────────────────────────────
const ctState = {
  pending: false,
  lastReceipt: null,        // most recent receipt object
  receiptsByContract: {},   // { contractId: [receipt, ...] }
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function ctEl(id) { return document.getElementById(id); }
function ctShort(addr) {
  if (!addr || addr.length < 12) return addr || '—';
  return addr.slice(0, 8) + '…' + addr.slice(-6);
}
function ctFmt(microUsdc) {
  return (Number(microUsdc) / 1e6).toFixed(2);
}
function ctTs(ts) {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
function ctEscapeJson(obj) {
  return JSON.stringify(obj).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ABI encoding
function ctEncAddr(addr) { return addr.replace(/^0x/, '').padStart(64, '0'); }
function ctEncUint(val)  { return BigInt(Math.floor(Number(val))).toString(16).padStart(64, '0'); }

// ─── Network validation ───────────────────────────────────────────────────────
async function ctEnsureNetwork() {
  const provider = window.walletState?.provider;
  if (!provider) throw new Error('Wallet not connected. Please connect your EVM wallet first.');
  const chainHex = await provider.request({ method: 'eth_chainId' });
  const chainDec = parseInt(chainHex, 16);
  if (chainDec !== CT_CHAIN_ID) {
    if (typeof switchToArcTestnet === 'function') {
      const ok = await switchToArcTestnet(provider);
      if (!ok) throw new Error('Please switch to Arc Testnet (Chain ID 5042002).');
      await new Promise(r => setTimeout(r, 600));
    } else {
      try {
        await provider.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: CT_CHAIN_HEX }],
        });
        await new Promise(r => setTimeout(r, 600));
      } catch (switchErr) {
        if (switchErr.code === 4902) {
          await provider.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: CT_CHAIN_HEX,
              chainName: CT_NETWORK,
              rpcUrls: ['https://rpc.testnet.arc.network'],
              nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
              blockExplorerUrls: ['https://testnet.arcscan.app'],
            }],
          });
        } else {
          throw new Error('Wrong network. Switch to Arc Testnet (Chain ID 5042002).');
        }
      }
    }
  }
}

// ─── Gas helpers ──────────────────────────────────────────────────────────────
async function ctEstimateGas(txObj) {
  const provider = window.walletState?.provider;
  if (!provider) return '0x15F90';
  try {
    const est = await provider.request({ method: 'eth_estimateGas', params: [txObj] });
    return '0x' + Math.ceil(parseInt(est, 16) * 1.2).toString(16);
  } catch (e) { return '0x15F90'; }
}
async function ctGasPrice() {
  const provider = window.walletState?.provider;
  if (!provider) return '0x2540BE400';
  try { return await provider.request({ method: 'eth_gasPrice' }); }
  catch (e) { return '0x2540BE400'; }
}
async function ctNonce(addr) {
  const provider = window.walletState?.provider;
  return provider.request({ method: 'eth_getTransactionCount', params: [addr, 'latest'] });
}

// ─── Send raw EVM transaction ─────────────────────────────────────────────────
async function ctSendTx(to, data, value = '0x0') {
  const provider = window.walletState?.provider;
  const from = window.walletState?.address;
  if (!provider || !from) throw new Error('Wallet not connected');

  const txBase = { from, to, data, value };
  const gas      = await ctEstimateGas(txBase);
  const gasPrice = await ctGasPrice();
  const nonce    = await ctNonce(from);

  // ⚠️ No chainId — MetaMask/EIP-1193 rejects eth_sendTransaction with chainId
  const txParams = { from, to, data, value, gas, gasPrice, nonce };
  console.log('[CT] Sending tx:', { ...txParams, data: data.slice(0, 18) + '...' });
  return provider.request({ method: 'eth_sendTransaction', params: [txParams] });
}

// ─── Wait for receipt ──────────────────────────────────────────────────────────
async function ctWaitReceipt(txHash, maxAttempts = 30) {
  const provider = window.walletState?.provider;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const receipt = await provider.request({
        method: 'eth_getTransactionReceipt',
        params: [txHash],
      });
      if (receipt) return receipt;
    } catch (e) { /* ignore */ }
  }
  return { status: '0x1', txHash, blockNumber: null, note: 'Fast finality assumed' };
}

// ─── USDC balance ──────────────────────────────────────────────────────────────
async function ctReadUsdcBalance(address) {
  const provider = window.walletState?.provider;
  if (!provider || !address) return null;
  try {
    // USDC is native on Arc — use eth_getBalance
    const hex = await provider.request({ method: 'eth_getBalance', params: [address, 'latest'] });
    return Number(BigInt(hex)) / 1e6;
  } catch (e) { return null; }
}

// ─── Gas fee estimate helper ──────────────────────────────────────────────────
async function ctCalcGasFee(txObj) {
  try {
    const gasHex = await ctEstimateGas(txObj);
    const gpHex  = await ctGasPrice();
    const gasUsed = parseInt(gasHex, 16);
    const gpWei   = parseInt(gpHex, 16);
    return (gasUsed * gpWei / 1e6).toFixed(6);
  } catch (e) { return '0'; }
}

// ─── Step panel helpers ────────────────────────────────────────────────────────
function ctSetStep(n, status = 'active') {
  for (let i = 0; i <= 5; i++) {
    const el = ctEl(`ct-step-${i}`);
    if (!el) continue;
    el.classList.remove('ct-step-active', 'ct-step-done', 'ct-step-error', 'ct-step-idle');
    if (i < n) el.classList.add('ct-step-done');
    else if (i === n) el.classList.add(status === 'error' ? 'ct-step-error' : 'ct-step-active');
    else el.classList.add('ct-step-idle');
  }
  const panel = ctEl('ct-steps-panel');
  if (panel) panel.classList.remove('hidden');
}

function ctHideSteps() {
  const panel = ctEl('ct-steps-panel');
  if (panel) panel.classList.add('hidden');
}

// ─── Main: Create Contract + Escrow Deposit ────────────────────────────────────
async function createContractWithReceipt(formData) {
  if (ctState.pending) return;

  const { client, contractor, title, description, totalValue } = formData;

  if (!client || !contractor || !title || !description || !totalValue) {
    showToast('Please fill all required fields.', 'warning');
    return;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(client)) {
    showToast('Invalid client address (must be 0x…42 chars)', 'error');
    return;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(contractor)) {
    showToast('Invalid contractor address (must be 0x…42 chars)', 'error');
    return;
  }
  const amount = parseFloat(totalValue);
  if (isNaN(amount) || amount <= 0) {
    showToast('Total value must be > 0', 'error');
    return;
  }

  const walletConnected = !!window.walletState?.address;
  ctState.pending = true;

  // Lock submit button
  const submitBtn = ctEl('ct-submit-btn');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Processing…'; }

  const showCtError = (msg) => {
    showToast(`❌ ${msg}`, 'error');
    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fas fa-file-plus mr-2"></i>Create Contract'; }
  };

  let txHash = null;
  let blockNumber = null;
  let gasFee = '0';

  try {
    if (walletConnected) {
      // ── Step 0: Verify network ─────────────────────────────────────────────
      ctSetStep(0);
      await ctEnsureNetwork();

      const from = window.walletState.address;
      const amountRaw = BigInt(Math.round(amount * 1e6));
      const valueHex = '0x' + amountRaw.toString(16);

      // ── Step 1: Read USDC balance ──────────────────────────────────────────
      ctSetStep(1);
      const balance = await ctReadUsdcBalance(from);
      console.log('[CT] USDC balance:', balance);
      if (balance !== null && balance < amount) {
        throw new Error(`Insufficient USDC balance: ${balance?.toFixed(4)} USDC available, ${amount} required for escrow.`);
      }

      // ── Step 2: Create contract record on backend ──────────────────────────
      ctSetStep(2);
      const createRes = await fetch('/api/contracts/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client, contractor, title, description, totalValue }),
      });
      const createData = await createRes.json();
      if (!createData.success) throw new Error(createData.error || 'Contract creation failed');

      const contractId = createData.contractId;
      showToast(`📋 Contract #${contractId} registered. Starting escrow deposit…`, 'info');

      // ── Step 3: Estimate gas + Deposit USDC to escrow ─────────────────────
      ctSetStep(3);
      const txBase = { from, to: CT_ESCROW_ADDR, data: '0x', value: valueHex };
      gasFee = await ctCalcGasFee(txBase);
      showToast('📝 Confirm USDC escrow transfer in your wallet…', 'info');

      txHash = await ctSendTx(CT_ESCROW_ADDR, '0x', valueHex);
      showToast(`⏳ Escrow tx submitted: ${txHash.slice(0, 14)}…`, 'info');

      // ── Step 4: Wait for confirmation ──────────────────────────────────────
      ctSetStep(4);
      const onChainReceipt = await ctWaitReceipt(txHash);
      if (onChainReceipt.status !== '0x1' && onChainReceipt.status !== 1) {
        throw new Error('Escrow transaction reverted on-chain.');
      }
      blockNumber = onChainReceipt.blockNumber ? parseInt(onChainReceipt.blockNumber, 16) : null;

      // ── Step 5: Register escrow deposit + emit receipt ─────────────────────
      ctSetStep(5);
      const escrowRes = await fetch(`/api/contracts/${contractId}/escrow-deposit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txHash, blockNumber, depositor: from, gasFee }),
      });
      const escrowData = await escrowRes.json();
      if (!escrowData.success) throw new Error(escrowData.error || 'Escrow registration failed');

      const receipt = { ...escrowData.receipt, gasFee, sender: from };
      ctState.lastReceipt = receipt;
      if (!ctState.receiptsByContract[contractId]) ctState.receiptsByContract[contractId] = [];
      ctState.receiptsByContract[contractId].unshift(receipt);

      ctSetStep(5, 'done');
      showToast(
        `✅ Contract #${contractId} created! Receipt #${receipt.id} on Arc Testnet. ` +
        `<a href="${receipt.explorerUrl}" target="_blank" class="underline">View ↗</a>`,
        'success'
      );
      if (typeof showTXConfirmationBadge === 'function') {
        showTXConfirmationBadge(txHash, `Escrow $${ctFmt(receipt.amount)} USDC — Contract #${contractId}`);
      }

      // Show receipt modal
      showContractReceiptModal(receipt, createData.contract);

      return { success: true, contractId, receipt, txHash };

    } else {
      // ── Wallet not connected: create contract without EVM tx ───────────────
      ctHideSteps();
      const createRes = await fetch('/api/contracts/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client, contractor, title, description, totalValue }),
      });
      const createData = await createRes.json();
      if (!createData.success) throw new Error(createData.error || 'Contract creation failed');

      const receipt = createData.receipt;
      ctState.lastReceipt = receipt;
      const contractId = createData.contractId;
      if (!ctState.receiptsByContract[contractId]) ctState.receiptsByContract[contractId] = [];
      ctState.receiptsByContract[contractId].unshift(receipt);

      showToast(`✅ Contract #${contractId} created! Receipt #${receipt.id} issued. (Connect wallet to deposit escrow)`, 'success');
      showContractReceiptModal(receipt, createData.contract);

      return { success: true, contractId, receipt };
    }

  } catch (err) {
    console.error('[CT] Contract creation error:', err);
    if (ctState.pending) ctSetStep(3, 'error');

    if (err.code === 4001 || err.message?.includes('rejected') || err.message?.includes('denied')) {
      showCtError('Transaction rejected by user.');
    } else if (err.message?.includes('Insufficient')) {
      showCtError(err.message);
    } else {
      showCtError(err.message || 'Unknown error');
    }
    return { success: false, error: err.message };

  } finally {
    ctState.pending = false;
    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fas fa-file-plus mr-2"></i>Create Contract'; }
    setTimeout(ctHideSteps, 10000);
  }
}

// ─── Activate contract with EVM escrow deposit ────────────────────────────────
async function activateContractEVM(contractId, contractData) {
  const walletConnected = !!window.walletState?.address;

  if (!walletConnected) {
    // Fallback to API-only activation
    const result = await fetch(`/api/contracts/${contractId}/activate`, { method: 'POST' });
    const data = await result.json();
    if (data.success && data.escrowReceipt) {
      ctState.lastReceipt = data.escrowReceipt;
      if (!ctState.receiptsByContract[contractId]) ctState.receiptsByContract[contractId] = [];
      ctState.receiptsByContract[contractId].unshift(data.escrowReceipt);
      showContractReceiptModal(data.escrowReceipt, contractData);
    }
    return data;
  }

  try {
    await ctEnsureNetwork();
    const from = window.walletState.address;
    const amount = contractData?.totalValue || 0;
    const valueHex = '0x' + BigInt(Math.round(amount)).toString(16);

    showToast('📝 Confirm USDC escrow deposit in your wallet…', 'info');
    const txHash = await ctSendTx(CT_ESCROW_ADDR, '0x', valueHex);
    showToast(`⏳ Escrow tx: ${txHash.slice(0, 14)}…`, 'info');

    const onChainReceipt = await ctWaitReceipt(txHash);
    const blockNumber = onChainReceipt.blockNumber ? parseInt(onChainReceipt.blockNumber, 16) : null;

    const txBase = { from, to: CT_ESCROW_ADDR, data: '0x', value: valueHex };
    const gasFee = await ctCalcGasFee(txBase);

    const res = await fetch(`/api/contracts/${contractId}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txHash, blockNumber, gasFee }),
    });
    const data = await res.json();
    if (data.escrowReceipt) {
      const receipt = { ...data.escrowReceipt, gasFee, sender: from };
      ctState.lastReceipt = receipt;
      if (!ctState.receiptsByContract[contractId]) ctState.receiptsByContract[contractId] = [];
      ctState.receiptsByContract[contractId].unshift(receipt);
      showContractReceiptModal(receipt, contractData);
      data.escrowReceipt = receipt;
    }
    return data;
  } catch (err) {
    if (err.code === 4001 || err.message?.includes('rejected')) {
      throw new Error('Transaction rejected by user');
    }
    throw err;
  }
}

// ─── Receipt Modal ─────────────────────────────────────────────────────────────
function showContractReceiptModal(receipt, contract) {
  const existing = document.getElementById('ct-receipt-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'ct-receipt-modal';
  modal.className = 'fixed inset-0 z-[90] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4';

  const isEscrow = receipt.type === 'escrow_deposit';
  const typeLabel = isEscrow ? 'Escrow Deposit Receipt' : 'Contract Creation Receipt';
  const eventName = receipt.eventName || (isEscrow ? 'EscrowDepositIssued' : 'ContractReceiptIssued');

  modal.innerHTML = `
    <div class="bg-gray-900 border border-green-700/50 rounded-2xl p-6 max-w-lg w-full shadow-2xl animate-modal-in">
      <!-- Header -->
      <div class="flex items-center justify-between mb-5">
        <div class="flex items-center gap-3">
          <div class="w-11 h-11 rounded-xl bg-gradient-to-br from-green-600 to-emerald-500 flex items-center justify-center flex-shrink-0">
            <i class="fas fa-receipt text-white text-lg"></i>
          </div>
          <div>
            <h2 class="text-white font-bold text-base">Blockchain Receipt</h2>
            <p class="text-green-400 text-xs">${typeLabel}</p>
          </div>
        </div>
        <button onclick="document.getElementById('ct-receipt-modal').remove()"
          class="text-gray-500 hover:text-gray-300 transition-colors w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-800">
          <i class="fas fa-times"></i>
        </button>
      </div>

      <!-- Status badge -->
      <div class="flex items-center gap-2 mb-4 bg-green-900/20 border border-green-700/30 rounded-xl px-4 py-2.5">
        <div class="w-2 h-2 bg-green-400 rounded-full animate-pulse flex-shrink-0"></div>
        <span class="text-green-400 text-sm font-semibold">Confirmed on Arc Testnet</span>
        <span class="ml-auto text-xs text-gray-500 font-mono">event ${eventName}</span>
      </div>

      <!-- Receipt fields -->
      <div class="space-y-0 mb-5 bg-gray-800/50 rounded-xl overflow-hidden divide-y divide-gray-700/40">
        <!-- IDs Row -->
        <div class="grid grid-cols-2 divide-x divide-gray-700/40">
          <div class="px-4 py-2.5">
            <div class="text-xs text-gray-500 mb-0.5">Receipt ID</div>
            <div class="text-white font-bold font-mono text-sm">#${receipt.id}</div>
          </div>
          <div class="px-4 py-2.5">
            <div class="text-xs text-gray-500 mb-0.5">Contract ID</div>
            <div class="text-white font-mono text-sm">#${receipt.contractId}</div>
          </div>
        </div>

        <!-- Contract Title -->
        <div class="px-4 py-2.5">
          <div class="text-xs text-gray-500 mb-0.5">Contract Title</div>
          <div class="text-white font-semibold text-sm">${receipt.contractTitle}</div>
        </div>

        <!-- Parties -->
        <div class="px-4 py-2.5">
          <div class="text-xs text-gray-500 mb-1.5">Parties</div>
          <div class="space-y-1.5">
            <div class="flex items-center gap-2">
              <span class="text-xs text-gray-500 w-20 flex-shrink-0">Client</span>
              <span class="text-cyan-400 font-mono text-xs break-all">${receipt.client}</span>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-xs text-gray-500 w-20 flex-shrink-0">Contractor</span>
              <span class="text-purple-400 font-mono text-xs break-all">${receipt.contractor}</span>
            </div>
          </div>
        </div>

        <!-- Escrow Amount -->
        <div class="px-4 py-3 bg-green-900/10">
          <div class="flex items-center justify-between">
            <div>
              <div class="text-xs text-gray-500 mb-0.5">Escrow Amount</div>
              <div class="text-2xl font-bold text-white">$${ctFmt(receipt.amount)} <span class="text-lg text-cyan-400">USDC</span></div>
            </div>
            <div class="w-10 h-10 rounded-full bg-green-900/40 border border-green-600/30 flex items-center justify-center">
              <i class="fas fa-lock text-green-400"></i>
            </div>
          </div>
        </div>

        <!-- Blockchain Info -->
        <div class="px-4 py-2.5">
          <div class="text-xs text-gray-500 mb-1.5">Blockchain Details</div>
          <div class="space-y-1.5">
            <div class="flex justify-between text-xs">
              <span class="text-gray-500">Network</span>
              <span class="text-green-400 font-medium">${receipt.network} <span class="text-gray-600">(Chain ${receipt.chainId})</span></span>
            </div>
            <div class="flex justify-between text-xs">
              <span class="text-gray-500">Escrow Address</span>
              <span class="text-gray-300 font-mono">${ctShort(receipt.escrowAddress)}</span>
            </div>
            <div class="flex justify-between text-xs">
              <span class="text-gray-500">Transaction</span>
              <a href="${receipt.explorerUrl}" target="_blank" rel="noopener"
                class="text-blue-400 hover:text-blue-300 hover:underline font-mono flex items-center gap-1">
                ${receipt.txHash.slice(0, 18)}… <i class="fas fa-external-link-alt text-[9px]"></i>
              </a>
            </div>
            ${receipt.blockNumber ? `
            <div class="flex justify-between text-xs">
              <span class="text-gray-500">Block</span>
              <span class="text-gray-300 font-mono">#${receipt.blockNumber}</span>
            </div>` : ''}
            ${receipt.gasFee && receipt.gasFee !== '0' ? `
            <div class="flex justify-between text-xs">
              <span class="text-gray-500">Gas Fee</span>
              <span class="text-gray-300 font-mono">${receipt.gasFee} USDC</span>
            </div>` : ''}
            <div class="flex justify-between text-xs">
              <span class="text-gray-500">Timestamp</span>
              <span class="text-gray-300">${ctTs(receipt.timestamp)}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Action buttons -->
      <div class="grid grid-cols-3 gap-2">
        <button onclick="downloadContractReceipt('json', ${receipt.id})"
          class="flex flex-col items-center gap-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-600/60 text-gray-300 text-xs rounded-xl py-3 transition-colors hover:border-cyan-700/50">
          <i class="fas fa-download text-cyan-400 text-base"></i>
          <span>JSON</span>
        </button>
        <button onclick="downloadContractReceipt('pdf', ${receipt.id})"
          class="flex flex-col items-center gap-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-600/60 text-gray-300 text-xs rounded-xl py-3 transition-colors hover:border-red-700/50">
          <i class="fas fa-file-pdf text-red-400 text-base"></i>
          <span>PDF</span>
        </button>
        <a href="${receipt.explorerUrl}" target="_blank" rel="noopener"
          class="flex flex-col items-center gap-1.5 bg-blue-900/20 hover:bg-blue-800/30 border border-blue-700/40 text-blue-400 text-xs rounded-xl py-3 transition-colors">
          <i class="fas fa-external-link-alt text-base"></i>
          <span>ArcScan</span>
        </a>
      </div>

      <p class="text-xs text-gray-600 text-center mt-3">
        Receipt permanently verifiable on Arc Network · Chain ID ${receipt.chainId}
      </p>
    </div>
  `;

  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

// ─── Render receipt panel inside contract card ─────────────────────────────────
function renderContractReceiptPanel(receipt) {
  if (!receipt) return '';
  const isEscrow = receipt.type === 'escrow_deposit';
  const eventName = receipt.eventName || (isEscrow ? 'EscrowDepositIssued' : 'ContractReceiptIssued');
  const safeReceipt = ctEscapeJson(receipt);

  return `
    <div class="ct-receipt-panel mt-4">
      <!-- Header row: green check + label + event name -->
      <div class="flex items-center gap-2 mb-3">
        <div class="ct-receipt-icon">
          <i class="fas fa-check-circle text-green-400 text-sm"></i>
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-xs font-semibold text-green-400">
            ${isEscrow ? 'Escrow Deposit Receipt' : 'Creation Receipt'}
            <span class="text-white ml-1">#${receipt.id}</span>
          </div>
          <div class="text-xs text-gray-500 font-mono">event ${eventName}</div>
        </div>
        <div class="flex items-center gap-1 flex-shrink-0">
          <div class="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse"></div>
          <span class="text-xs text-green-500 font-medium">Confirmed</span>
        </div>
      </div>

      <!-- Contract Info -->
      <div class="ct-receipt-title mb-2.5">
        <i class="fas fa-file-contract text-gray-500 mr-1.5 text-xs"></i>
        <span class="text-xs text-gray-400 font-medium">${receipt.contractTitle}</span>
      </div>

      <!-- Wallet addresses -->
      <div class="grid grid-cols-1 gap-1 mb-2.5">
        <div class="ct-receipt-row">
          <span class="ct-receipt-label"><i class="fas fa-user mr-1 text-[10px]"></i>Client</span>
          <span class="ct-receipt-addr text-cyan-400">${ctShort(receipt.client)}</span>
        </div>
        <div class="ct-receipt-row">
          <span class="ct-receipt-label"><i class="fas fa-hard-hat mr-1 text-[10px]"></i>Contractor</span>
          <span class="ct-receipt-addr text-purple-400">${ctShort(receipt.contractor)}</span>
        </div>
        <div class="ct-receipt-row">
          <span class="ct-receipt-label"><i class="fas fa-lock mr-1 text-[10px]"></i>Escrow</span>
          <span class="ct-receipt-addr text-gray-400">${ctShort(receipt.escrowAddress)}</span>
        </div>
      </div>

      <!-- Amount + Network row -->
      <div class="flex items-center gap-2 mb-2.5 bg-green-900/10 border border-green-800/20 rounded-lg px-3 py-2">
        <div class="flex-1">
          <div class="text-xs text-gray-500 mb-0.5">Escrow Value</div>
          <div class="text-sm font-bold text-white">$${ctFmt(receipt.amount)} <span class="text-cyan-400 text-xs">USDC</span></div>
        </div>
        <div class="text-right">
          <div class="text-xs text-gray-500 mb-0.5">Network</div>
          <div class="text-xs text-green-400 font-medium">${receipt.network}</div>
        </div>
      </div>

      <!-- TX Hash -->
      <div class="ct-receipt-row mb-2">
        <span class="ct-receipt-label"><i class="fas fa-hashtag mr-1 text-[10px]"></i>TX Hash</span>
        <a href="${receipt.explorerUrl}" target="_blank" rel="noopener"
          class="text-blue-400 hover:text-blue-300 hover:underline font-mono text-xs flex items-center gap-1">
          ${receipt.txHash.slice(0, 14)}… <i class="fas fa-external-link-alt text-[9px]"></i>
        </a>
      </div>

      <!-- Timestamp -->
      <div class="ct-receipt-row mb-3">
        <span class="ct-receipt-label"><i class="fas fa-clock mr-1 text-[10px]"></i>Timestamp</span>
        <span class="text-gray-300 text-xs">${ctTs(receipt.timestamp)}</span>
      </div>

      <!-- Action buttons -->
      <div class="flex gap-1.5 flex-wrap">
        <button onclick='showContractReceiptModal(${safeReceipt}, null)'
          class="ct-receipt-btn ct-receipt-btn-view">
          <i class="fas fa-eye text-green-400 text-xs"></i>
          <span>View Receipt</span>
        </button>
        <button onclick="downloadContractReceipt('json', ${receipt.id})"
          class="ct-receipt-btn ct-receipt-btn-dl">
          <i class="fas fa-download text-cyan-400 text-xs"></i>
          <span>Download</span>
        </button>
        <button onclick="downloadContractReceipt('pdf', ${receipt.id})"
          class="ct-receipt-btn ct-receipt-btn-pdf">
          <i class="fas fa-file-pdf text-red-400 text-xs"></i>
          <span>PDF</span>
        </button>
        <a href="${receipt.explorerUrl}" target="_blank" rel="noopener"
          class="ct-receipt-btn ct-receipt-btn-ext">
          <i class="fas fa-external-link-alt text-blue-400 text-xs"></i>
          <span>ArcScan</span>
        </a>
      </div>
    </div>
  `;
}

// ─── Download receipt ──────────────────────────────────────────────────────────
async function downloadContractReceipt(format, receiptId) {
  // Find receipt: check local cache first, then fetch from API
  let receipt = ctState.lastReceipt?.id === receiptId ? ctState.lastReceipt : null;
  if (!receipt) {
    for (const list of Object.values(ctState.receiptsByContract)) {
      const found = list.find(r => r.id === receiptId);
      if (found) { receipt = found; break; }
    }
  }
  if (!receipt) {
    try {
      const res = await fetch('/api/contracts/receipts/all');
      const data = await res.json();
      receipt = data.receipts?.find(r => r.id === receiptId);
    } catch (e) { /* ignore */ }
  }
  if (!receipt) { showToast('Receipt not found', 'error'); return; }

  if (format === 'json') {
    const exportData = {
      ...receipt,
      _meta: {
        generatedAt: new Date().toISOString(),
        generator: 'ARC AI Agents',
        network: 'Arc Testnet',
        chainId: CT_CHAIN_ID,
      }
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `arc-contract-receipt-${receipt.id}-contract-${receipt.contractId}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('✅ JSON receipt downloaded', 'success');

  } else if (format === 'pdf') {
    const isEscrow = receipt.type === 'escrow_deposit';
    const content = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Contract Receipt #${receipt.id} — ARC Network</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; max-width: 680px; margin: 0 auto;
           padding: 40px 30px; background: #fff; color: #1a1a1a; }
    .header { display: flex; align-items: center; gap: 16px; border-bottom: 3px solid #059669;
              padding-bottom: 20px; margin-bottom: 24px; }
    .logo { width: 52px; height: 52px; background: linear-gradient(135deg,#059669,#10b981);
            border-radius: 12px; display: flex; align-items: center; justify-content: center;
            font-size: 26px; flex-shrink: 0; }
    h1 { font-size: 22px; color: #065f46; margin-bottom: 4px; }
    .subtitle { color: #6b7280; font-size: 13px; }
    .status-badge { display: inline-flex; align-items: center; gap: 8px;
                    background: #d1fae5; color: #065f46; padding: 8px 14px;
                    border-radius: 8px; font-size: 13px; font-weight: 600;
                    margin-bottom: 24px; border: 1px solid #a7f3d0; }
    .event-badge { background: #f3f4f6; color: #374151; padding: 4px 10px;
                   border-radius: 20px; font-size: 11px; font-family: monospace;
                   display: inline-block; margin-bottom: 24px; margin-left: 8px; }
    .section { margin-bottom: 24px; }
    .section-title { font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px;
                     color: #9ca3af; font-weight: 600; margin-bottom: 10px;
                     padding-bottom: 6px; border-bottom: 1px solid #f3f4f6; }
    table { width: 100%; border-collapse: collapse; }
    td { padding: 8px 10px; border-bottom: 1px solid #f9fafb; font-size: 13px; vertical-align: top; }
    td:first-child { color: #6b7280; width: 160px; font-weight: 500; }
    td:last-child { font-weight: 600; word-break: break-all; }
    .amount-box { background: #f0fdf4; border: 2px solid #a7f3d0; border-radius: 10px;
                  padding: 16px 20px; margin-bottom: 24px; display: flex; align-items: center;
                  justify-content: space-between; }
    .amount-value { font-size: 28px; font-weight: 800; color: #059669; }
    .amount-label { font-size: 12px; color: #6b7280; margin-top: 4px; }
    .addr { font-family: 'Courier New', monospace; font-size: 11px; word-break: break-all; }
    .footer { margin-top: 36px; font-size: 11px; color: #9ca3af; text-align: center;
              border-top: 1px solid #f3f4f6; padding-top: 20px; }
    .watermark { position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%) rotate(-35deg);
                  font-size: 60px; color: rgba(5,150,105,0.04); font-weight: 900;
                  pointer-events: none; white-space: nowrap; }
    @media print { .watermark { display: block; } body { padding: 20px; } }
  </style>
</head>
<body>
  <div class="watermark">ARC NETWORK</div>

  <div class="header">
    <div class="logo">🤖</div>
    <div>
      <h1>ARC AI Agents — Blockchain Receipt</h1>
      <div class="subtitle">${isEscrow ? 'Escrow Deposit Receipt' : 'Contract Creation Receipt'}</div>
    </div>
  </div>

  <div>
    <span class="status-badge">✅ Confirmed on Arc Network</span>
    <span class="event-badge">event ${receipt.eventName || (isEscrow ? 'EscrowDepositIssued' : 'ContractReceiptIssued')}</span>
  </div>

  <div class="amount-box">
    <div>
      <div class="amount-value">$${ctFmt(receipt.amount)} USDC</div>
      <div class="amount-label">Escrow Value · USDC (native Arc Testnet)</div>
    </div>
    <div style="text-align:right">
      <div style="font-size:13px;color:#374151;font-weight:600">Receipt #${receipt.id}</div>
      <div style="font-size:12px;color:#9ca3af">Contract #${receipt.contractId}</div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Contract Details</div>
    <table>
      <tr><td>Contract Title</td><td>${receipt.contractTitle}</td></tr>
      <tr><td>Receipt Type</td><td>${isEscrow ? 'Escrow Deposit' : 'Contract Creation'}</td></tr>
      <tr><td>Issued At</td><td>${ctTs(receipt.timestamp)}</td></tr>
    </table>
  </div>

  <div class="section">
    <div class="section-title">Parties</div>
    <table>
      <tr><td>Client</td><td class="addr">${receipt.client}</td></tr>
      <tr><td>Contractor</td><td class="addr">${receipt.contractor}</td></tr>
      <tr><td>Escrow Address</td><td class="addr">${receipt.escrowAddress}</td></tr>
    </table>
  </div>

  <div class="section">
    <div class="section-title">Blockchain Verification</div>
    <table>
      <tr><td>Network</td><td>${receipt.network} (Chain ID: ${receipt.chainId})</td></tr>
      <tr><td>Transaction Hash</td><td class="addr">${receipt.txHash}</td></tr>
      ${receipt.blockNumber ? `<tr><td>Block Number</td><td>#${receipt.blockNumber}</td></tr>` : ''}
      ${receipt.gasFee && receipt.gasFee !== '0' ? `<tr><td>Gas Fee</td><td>${receipt.gasFee} USDC</td></tr>` : ''}
      <tr><td>Explorer URL</td><td class="addr">${receipt.explorerUrl}</td></tr>
    </table>
  </div>

  <div class="footer">
    <strong>ARC AI Agents</strong> · Arc Network Testnet · Generated: ${new Date().toLocaleString()}<br>
    This receipt is permanently verifiable on-chain at Chain ID ${receipt.chainId}
  </div>
</body>
</html>`;
    const blob = new Blob([content], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, '_blank');
    if (win) {
      win.onload = () => {
        setTimeout(() => { win.print(); URL.revokeObjectURL(url); }, 500);
      };
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.download = `arc-contract-receipt-${receipt.id}.html`;
      a.click();
    }
    showToast('✅ PDF receipt opened for printing', 'success');
  }
}

// ─── Load and cache receipts for existing contracts ────────────────────────────
async function loadContractReceipts() {
  try {
    const res = await fetch('/api/contracts/receipts/all?limit=100');
    const data = await res.json();
    if (data.success) {
      data.receipts.forEach(r => {
        if (!ctState.receiptsByContract[r.contractId]) ctState.receiptsByContract[r.contractId] = [];
        const exists = ctState.receiptsByContract[r.contractId].some(e => e.id === r.id);
        if (!exists) ctState.receiptsByContract[r.contractId].push(r);
      });
    }
  } catch (e) { console.warn('[CT] Failed to load receipts:', e.message); }
}

// ─── Expose globally ──────────────────────────────────────────────────────────
window.createContractWithReceipt = createContractWithReceipt;
window.activateContractEVM       = activateContractEVM;
window.showContractReceiptModal  = showContractReceiptModal;
window.renderContractReceiptPanel= renderContractReceiptPanel;
window.downloadContractReceipt   = downloadContractReceipt;
window.loadContractReceipts      = loadContractReceipts;
window.ctState                   = ctState;

console.log('[CT] Contracts module loaded — Arc Testnet ChainID:', CT_CHAIN_ID, '| Escrow:', CT_ESCROW_ADDR);
