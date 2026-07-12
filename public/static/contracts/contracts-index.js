// This file is the entry point that ties all sub-modules together.
// It contains wallet event listeners, global window exports, and the debug object.

// ─── Background sync handler ──────────────────────────────────────────────────
window.addEventListener('arcSyncRequest', () => {
  if (!window.walletState?.address) return;
  const tabEl = document.getElementById('tab-content-contracts');
  if (tabEl && !tabEl.classList.contains('hidden')) {
    const age = Date.now() - cfState.lastRefresh;
    if (age > 30000) {
      cfLog('arcSyncRequest: refreshing contracts');
      cfLoadContracts();
    }
  }
});
// ─── Wallet event listeners ────────────────────────────────────────────────────
window.addEventListener('walletConnected', () => {
  cfLog('walletConnected event → loading contracts');
  // Only do a chain fetch when the On-Chain tab is active; local tabs are unaffected.
  if ((window._cfViewMode || 'onchain') === 'onchain') {
    cfLoadContracts({ force: true });
  } else {
    // Still save the wallet / network state without touching the local view.
    cfUpdateNetworkBanner(true);
    if (typeof cfRenderContractsByViewMode === 'function') cfRenderContractsByViewMode();
  }
  // Init smart autofill for Contracts tab
  setTimeout(() => { if (typeof arcInitCfAutofill === 'function') arcInitCfAutofill(); }, 800);
});
window.addEventListener('walletDisconnected', () => {
  cfLog('walletDisconnected event');
  // Leave the focused single-contract subpage — its contract belonged to the
  // previous wallet; show the normal list for the new wallet state.
  if (window.cfFocusId != null) { try { cfExitFocus(); } catch (_) {} }
  cfShowListState('no_wallet'); // mode-guard inside — skipped for local tabs
  // Don't wipe _allContracts for local tabs — off-chain data stays visible
  if ((window._cfViewMode || 'onchain') === 'onchain') {
    cfRenderSummary([], null);
  }
  cfState.contracts = [];
  cfState.networkOk = false;
  cfState.lastWallet = null;
  cfUpdateNetworkBanner(false);
  // Re-render local tab so off-chain/custodial contracts remain visible
  if ((window._cfViewMode || 'onchain') !== 'onchain' && typeof cfRenderContractsByViewMode === 'function') {
    cfRenderContractsByViewMode();
  }
});
window.addEventListener('walletChanged', () => {
  cfLog('walletChanged event → reloading contracts');
  // Switching wallet: exit the focused subpage so we don't get stuck loading a
  // contract that belongs to the previous account. Show the new wallet's list.
  if (window.cfFocusId != null) { try { cfExitFocus(); } catch (_) {} }
  cfState.contracts = [];
  // Only chain-reload when on the On-Chain tab.
  if ((window._cfViewMode || 'onchain') === 'onchain') {
    cfLoadContracts({ force: true });
  } else if (typeof cfRenderContractsByViewMode === 'function') {
    cfRenderContractsByViewMode();
  }
});

// ─── Auto-refresh every 60s when contracts tab is active (on-chain only) ─────
setInterval(() => {
  if (document.getElementById('tab-content-contracts')?.classList.contains('hidden')) return;
  // Never auto-refresh local tabs — data is already in localStorage.
  if ((window._cfViewMode || 'onchain') !== 'onchain') return;
  if (!window.walletState?.address) return;
  const age = Date.now() - cfState.lastRefresh;
  if (age > 60000) {
    cfLog('Auto-refresh contracts (60s interval)');
    cfLoadContracts();
  }
}, 15000);

// ─── Global exports ────────────────────────────────────────────────────────────

// ─── Global exports ────────────────────────────────────────────────────────────
window.cfOpenContractPage     = cfOpenContractPage;
window.cfExitFocus            = cfExitFocus;
window.cfModalOpen            = cfModalOpen;
window.cfModalClose           = cfModalClose;
window.cfConfirm              = cfConfirm;
window.cfAlertSuccess         = cfAlertSuccess;
window.cfAlertError           = cfAlertError;
window.cfShowLoading          = cfShowLoading;
window.cfShowTxPending        = cfShowTxPending;
window.cfHideLoading          = cfHideLoading;
window.cfMsSubmitProof        = cfMsSubmitProof;
window.cfMsExecuteProof       = cfMsExecuteProof;
window.cfMsViewProof          = cfMsViewProof;
window.cfMsCreateAttestation  = cfMsCreateAttestation;
window.cfMsViewAttestation    = cfMsViewAttestation;
window.cfMsApproveProof       = cfMsApproveProof;
window.cfMsRejectProof        = cfMsRejectProof;
window.cfMsRelease            = cfMsRelease;
window.cfCreateContract       = cfCreateContract;
window.cfLoadContracts        = cfLoadContracts;
window.cfSignContract         = cfSignContract;
window.cfDepositToContract    = cfDepositToContract;
window.cfExecuteDeposit       = cfExecuteDeposit;
window.cfWithdrawFromContract = cfWithdrawFromContract;
window.cfExecuteWithdraw      = cfExecuteWithdraw;
window.cfReleaseMilestone     = cfReleaseMilestone;
window.cfCancelContract       = cfCancelContract;
window.cfMarkComplete         = cfMarkComplete;
window.cfShowProofUpload      = cfShowProofUpload;
window.cfHandleProofDrop      = cfHandleProofDrop;
window.cfHandleProofFiles     = cfHandleProofFiles;
window.cfExecuteProofUpload   = cfExecuteProofUpload;
window.cfCommitProof          = cfCommitProof;
window.cfExecuteCommitProof   = cfExecuteCommitProof;
window.cfShowWalletLink       = cfShowWalletLink;
window.cfShowOffchainActions  = cfShowOffchainActions;
window.cfSaveOffchainStatus   = cfSaveOffchainStatus;
window.cfDownloadReceipt      = cfDownloadReceipt;   // legacy — kept for compat
window.cfOpenReceipt          = cfOpenReceipt;
window.cfAddMilestone         = cfAddMilestone;
window.cfUpdateMilestoneSum   = cfUpdateMilestoneSum;
window.cfUpdateFeePreview     = cfUpdateFeePreview;
window.cfToggleCustodianField  = cfToggleCustodianField;
window.cfWalletGateUpdate     = cfWalletGateUpdate;
window.cfSwitchNetwork        = cfSwitchNetwork;
window.cfState                = cfState;
window.cfUiStatus             = cfUiStatus;
window.loadContracts          = cfLoadContracts;
window.cfRenderProofPreview   = cfRenderProofPreview;
window.cfViewProof            = cfViewProof;
// Presentation helpers (v6 UI refresh)
window.cfCopy                 = cfCopy;
window.cfToggleSection        = cfToggleSection;
window.cfUpdateNetworkBanner  = cfUpdateNetworkBanner;
window.cfLogTx                = cfLogTx;
window.cfGetSelectedMode      = cfGetSelectedMode;
window.cfCreateOffchainContract = cfCreateOffchainContract;
window.cfLoadOffchainContracts  = cfLoadOffchainContracts;
window.cfGenerateQrCanvas     = cfGenerateQrCanvas;
// Dispute system
window.cfShowOpenDispute          = cfShowOpenDispute;
window.cfHandleDisputeFileDrop    = cfHandleDisputeFileDrop;
window.cfHandleDisputeFileInput   = cfHandleDisputeFileInput;
window.cfRenderDisputeFileList    = cfRenderDisputeFileList;
window.cfSubmitDispute            = cfSubmitDispute;
window.cfShowDisputeResolution    = cfShowDisputeResolution;
window.cfExecuteDisputeResolution = cfExecuteDisputeResolution;
window.cfApproveMutualResolution  = cfApproveMutualResolution;
window.cfViewDisputeEvidence      = cfViewDisputeEvidence;
// Contract closure
window.cfCloseContract            = cfCloseContract;
window.cfExecuteCloseContract     = cfExecuteCloseContract;
// Debug helpers — exposed on window for console/devtools use
window.cfDebug = {
  getState:     () => cfState,
  getTxLog:     () => JSON.parse(localStorage.getItem(CF_TX_LOG_KEY) || '[]'),
  getMeta:      (id) => cfGetMeta(id),
  getCachedIds: (addr) => cfGetCachedIds(addr || window.walletState?.address),
  clearCache:   () => { localStorage.removeItem(CF_IDS_KEY); cfLog('ID cache cleared'); },
  setDebug:     (v) => { cfState.debugMode = v; cfLog('Debug mode:', v); },
  getOffchain:  () => cfLoadOffchainContracts(),
  clearOffchain: () => { localStorage.removeItem('arc_cf_offchain_v1'); cfLog('Off-chain contracts cleared'); },
  // Test reading a known contract directly (no wallet needed)
  testContract: async (id) => {
    id = id || 1;
    const ethers = window.ethers;
    if (!ethers) { console.error('[cfDebug] ethers.js not loaded'); return; }
    const provider = new ethers.JsonRpcProvider(CF_RPC);
    const factory  = new ethers.Contract(CF_FACTORY_ADDR, CF_ABI, provider);
    try {
      const count = Number(await factory.contractCount());
      console.log('[cfDebug] contractCount:', count);
      const c = await factory.getContract(id);
      console.log(`[cfDebug] Contract #${id}:`, {
        id: Number(c.id), title: c.title,
        client: c.client, contractor: c.contractor,
        total:    '$' + (Number(c.totalValue) / 1e6).toFixed(2),
        deposited:'$' + (Number(c.depositedValue) / 1e6).toFixed(2),
        status: Number(c.status), signed: c.contractorSigned,
      });
      const ms = await factory.getMilestones(id);
      console.log(`[cfDebug] Milestones #${id}:`, ms.map(m => ({
        id: Number(m.id), desc: m.description,
        amount: '$' + (Number(m.amount)/1e6).toFixed(2),
        status: Number(m.status),
      })));
      const wallet = window.walletState?.address;
      if (wallet) {
        const clientIds = await factory.getByClient(wallet);
        const contrIds  = await factory.getByContractor(wallet);
        console.log(`[cfDebug] getByClient(${wallet}):`,     clientIds.map(x => Number(x)));
        console.log(`[cfDebug] getByContractor(${wallet}):`, contrIds.map(x => Number(x)));
      }
    } catch (e) {
      console.error('[cfDebug] testContract failed:', e.message);
    }
  },
};

console.log('%c[CF v6] Contracts Module loaded', 'color:#60b4ff;font-weight:bold',
  '| Factory:', CF_FACTORY_ADDR,
  '| Chain:', CF_CHAIN_ID,
  '| Modes: onchain / offchain / custodial',
  '| QR: canvas fallback built-in',
  '| Proof: SHA-256 + commit lock',
  '| Debug: cfDebug.testContract(1)'
);
