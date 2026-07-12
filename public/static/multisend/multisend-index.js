// ExecDaat MultiSend Module — Index / Entry Point

// ─── Global exports ────────────────────────────────────────────────────────────
window.msInit             = msInit;
window.msAddRow           = msAddRow;
window.msSubmit           = msExecute;
window.msHandleCSV        = msHandleCSV;
window.msEditAll          = msEditAll;
window.msDownloadTemplate = msDownloadTemplate;
window.msDownloadReceipt  = msDownloadReceipt;
window.msPdfReceipt       = msPdfReceipt;
window.msUpdateStats      = msUpdateStats;
window.msValidateAddr     = msValidateAddr;
window.msProceedToReview  = msProceedToReview;
window.msProceedToSend    = msProceedToSend;
window.msExecute          = msExecute;
window.msGoBack           = msGoBack;
window.msReceipts         = msReceipts;

// Legacy compat
window.addMultisendRow      = (a, b, c) => msAddRow(a, b, c);
window.updateMultisendTotal = msUpdateStats;
window.submitMultisend      = () => { if (typeof msProceedToReview === 'function') msProceedToReview(); };

// ─── Debug helpers ────────────────────────────────────────────────────────────
window.msDebug = {
  checkMulticall3: async () => {
    const code = await fetch(MS_RPC, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({jsonrpc:'2.0',method:'eth_getCode',params:[MS_MULTICALL3_ADDR,'latest'],id:1})
    }).then(r=>r.json());
    const deployed = code.result && code.result !== '0x';
    msLog('Multicall3 deployed:', deployed, '| address:', MS_MULTICALL3_ADDR);
    return deployed;
  },
  checkAllowance: async (owner, spender = MS_MULTICALL3_ADDR) => {
    if (!window.ethers) { msError('ethers.js not loaded'); return; }
    const provider = new window.ethers.JsonRpcProvider(MS_RPC);
    const usdc = new window.ethers.Contract(MS_USDC_ADDR, MS_ERC20_ABI, provider);
    const allowance = await usdc.allowance(owner, spender);
    const balance   = await usdc.balanceOf(owner);
    msLog(`Allowance: ${window.ethers.formatUnits(allowance, 6)} USDC | Balance: ${window.ethers.formatUnits(balance, 6)} USDC`);
    return { allowance, balance };
  },
  getState: () => ({ msExecuting, msValidatedRows, msReceipts, msCurrentStep }),
};

console.log('%c[MULTISEND v7]', 'color:#22d3ee;font-weight:bold',
  'Loaded | Arc Testnet', MS_CHAIN_ID,
  '| USDC', MS_USDC_ADDR,
  '| Multicall3 (confirmed deployed):', MS_MULTICALL3_ADDR,
  '| Flow: approve MC3 → pay fee → aggregate3(transferFrom) | Single tx batch'
);
