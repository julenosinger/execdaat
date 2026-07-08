// ============================================================
// CCTP Bridge — ExecDaat dApp  |  build: 20260626-fix-empty-data
// Circle Cross-Chain Transfer Protocol (CCTP V2)
// Testnet ONLY — Fast Execution optimised
// ============================================================

'use strict';

// ─── CCTP Domain / Chain config (TESTNET ONLY) ────────────────────────────────
const BRIDGE_CHAINS = {
  sepolia: {
    name:       'Ethereum Sepolia',
    shortName:  'Sepolia',
    icon:       '🔷',
    chainId:    11155111,
    chainHex:   '0xaa36a7',
    domain:     0,
    rpcUrl:     'https://ethereum-sepolia-rpc.publicnode.com',
    explorer:   'https://sepolia.etherscan.io',
    usdcAddress:            '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    tokenMessengerV2:       '0x8fe6b999dc680ccfdd5bf7c5f412b27e4e99e6d7',
    messageTransmitterV2:   '0xe737e5cebeeba77efe34d4aa090756590b1ce275',
    tokenMinterV2:          '0xe997d7d2f6e065a9a93fa2175e878fb9081f1f0a',
  },
  arbsepolia: {
    name:       'Arbitrum Sepolia',
    shortName:  'Arb Sepolia',
    icon:       '🔵',
    chainId:    421614,
    chainHex:   '0x66eee',
    domain:     3,
    rpcUrl:     'https://sepolia-rollup.arbitrum.io/rpc',
    explorer:   'https://sepolia.arbiscan.io',
    usdcAddress:            '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    tokenMessengerV2:       '0x8fe6b999dc680ccfdd5bf7c5f412b27e4e99e6d7',
    messageTransmitterV2:   '0xe737e5cebeeba77efe34d4aa090756590b1ce275',
    tokenMinterV2:          '0xe997d7d2f6e065a9a93fa2175e878fb9081f1f0a',
  },
  basesepolia: {
    name:       'Base Sepolia',
    shortName:  'Base Sep',
    icon:       '🔵',
    chainId:    84532,
    chainHex:   '0x14a34',
    domain:     6,
    rpcUrl:     'https://sepolia.base.org',
    explorer:   'https://sepolia.basescan.org',
    usdcAddress:            '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    tokenMessengerV2:       '0x8fe6b999dc680ccfdd5bf7c5f412b27e4e99e6d7',
    messageTransmitterV2:   '0xe737e5cebeeba77efe34d4aa090756590b1ce275',
    tokenMinterV2:          '0xe997d7d2f6e065a9a93fa2175e878fb9081f1f0a',
  },
  optsepolia: {
    name:       'OP Sepolia',
    shortName:  'OP Sep',
    icon:       '🔴',
    chainId:    11155420,
    chainHex:   '0xaa37dc',
    domain:     2,
    rpcUrl:     'https://sepolia.optimism.io',
    explorer:   'https://sepolia-optimism.etherscan.io',
    usdcAddress:            '0x5fd84259d66Cd46123540766Be93DFE6D43130D7',
    tokenMessengerV2:       '0x8fe6b999dc680ccfdd5bf7c5f412b27e4e99e6d7',
    messageTransmitterV2:   '0xe737e5cebeeba77efe34d4aa090756590b1ce275',
    tokenMinterV2:          '0xe997d7d2f6e065a9a93fa2175e878fb9081f1f0a',
  },
  arc: {
    name:       'Arc Testnet',
    shortName:  'Arc',
    icon:       '🟣',
    chainId:    5042002,
    chainHex:   '0x4cef52',
    domain:     26,
    rpcUrl:     'https://rpc.testnet.arc.network',
    explorer:   'https://testnet.arcscan.app',
    usdcAddress:            '0x3600000000000000000000000000000000000000',
    tokenMessengerV2:       '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
    messageTransmitterV2:   '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
    tokenMinterV2:          '0xb43db544E2c27092c107639Ad201b3dEfAbcF192',
  },
};

// ─── ABIs (minimal) ───────────────────────────────────────────────────────────
const BRIDGE_ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];

const BRIDGE_TOKEN_MESSENGER_ABI = [
  // V2 depositForBurn
  'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken) returns (uint64 nonce)',
  'function depositForBurnWithCaller(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller) returns (uint64 nonce)',
  // Events
  'event DepositForBurn(uint64 indexed nonce, address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller)',
  'event MessageSent(bytes message)',
];

const BRIDGE_MESSAGE_TRANSMITTER_ABI = [
  'function receiveMessage(bytes message, bytes attestation) returns (bool success)',
  'function usedNonces(bytes32) view returns (uint256)',
];

// ─── State ────────────────────────────────────────────────────────────────────
const bridgeState = {
  fromChain:    'sepolia',
  toChain:      'basesepolia',
  amount:       '',
  mode:         'fast',
  pending:      false,
  history:      [],
  pollTimer:    null,
  usdcBalance:  null,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function bridgeToBytes32(address) {
  // Pad address to bytes32
  if (window.ethers?.zeroPadValue) return window.ethers.zeroPadValue(address, 32);
  if (window.ethers?.utils?.hexZeroPad) return window.ethers.utils.hexZeroPad(address, 32);
  // Manual fallback
  const addr = address.toLowerCase().replace('0x', '');
  return '0x' + addr.padStart(64, '0');
}

function bridgeFmt(amount, decimals = 6) {
  if (!amount) return '0.00';
  const n = parseFloat(amount);
  if (isNaN(n)) return '0.00';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

function bridgeShortAddr(addr) {
  if (!addr || addr.length < 10) return addr;
  return addr.slice(0, 6) + '…' + addr.slice(-4);
}

function bridgeSaveHistory() {
  try { localStorage.setItem('bridge_history_v1', JSON.stringify(bridgeState.history.slice(0, 50))); } catch (_) {}
}
function bridgeLoadHistory() {
  try { bridgeState.history = JSON.parse(localStorage.getItem('bridge_history_v1') || '[]'); } catch (_) { bridgeState.history = []; }
}

function bridgeLog(msg, level = 'info') {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  const colors = { info: '#60a5fa', warn: '#fbbf24', error: '#f87171', success: '#34d399' };
  console.log(`%c[BRIDGE ${ts}] ${msg}`, `color:${colors[level]||colors.info}`);
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function bridgeEl(id) { return document.getElementById(id); }

function bridgeSetStatus(text, type = 'idle') {
  const el = bridgeEl('bridge-status-bar');
  if (!el) return;
  const colors = {
    idle:    'br-status-idle',
    burn:    'br-status-burn',
    attest:  'br-status-attest',
    mint:    'br-status-mint',
    done:    'br-status-done',
    error:   'br-status-error',
  };
  el.className = `${colors[type] || colors.idle}`;
  el.innerHTML = text;
  el.classList.remove('hidden');
}

function bridgeSetStep(step) {
  const steps = ['burn', 'attest', 'mint', 'done'];
  steps.forEach(s => {
    const el = bridgeEl(`bridge-step-${s}`);
    if (!el) return;
    el.classList.remove('br-step-active', 'br-step-done', 'br-step-pending', 'br-step-error');
    if (!step) { el.classList.add('br-step-pending'); return; }
    const idx = steps.indexOf(s);
    const cur = steps.indexOf(step === 'error' ? 'burn' : step);
    if (step === 'error' && s === 'burn') { el.classList.add('br-step-error'); }
    else if (idx < cur || (step === 'done' && idx <= steps.indexOf('done'))) { el.classList.add('br-step-done'); }
    else if (idx === cur) { el.classList.add('br-step-active'); }
    else { el.classList.add('br-step-pending'); }
  });

  // Update connecting lines
  for (let i = 1; i <= 3; i++) {
    const line = bridgeEl(`bridge-step-line${i}`);
    if (!line) continue;
    line.classList.remove('br-step-line-active', 'br-step-line-done');
    if (!step) continue;
    const stepIdx = steps.indexOf(step === 'error' ? 'burn' : step);
    if (step === 'done') { line.classList.add('br-step-line-done'); }
    else if (i <= stepIdx) { line.classList.add('br-step-line-active'); }
  }

  const stepsWrap = bridgeEl('bridge-steps-wrap');
  if (stepsWrap) stepsWrap.classList.toggle('hidden', !step);
}

function bridgeUpdateBtn() {
  const btn = bridgeEl('bridge-submit-btn');
  if (!btn) return;
  const amt = parseFloat(bridgeState.amount);
  const connected = !!window.walletState?.address;
  const valid = connected && amt > 0 && bridgeState.fromChain !== bridgeState.toChain;
  btn.disabled = bridgeState.pending || !valid;
  if (!connected) { btn.textContent = 'Connect Wallet'; return; }
  if (bridgeState.fromChain === bridgeState.toChain) { btn.textContent = 'Select different chains'; return; }
  if (!amt || isNaN(amt) || amt <= 0) { btn.textContent = 'Enter amount'; return; }
  btn.innerHTML = bridgeState.pending
    ? '<i class="fas fa-spinner fa-spin mr-2"></i>Bridging…'
    : `<i class="fas fa-right-left mr-2"></i>Bridge ${bridgeFmt(bridgeState.amount)} USDC`;
  bridgeUpdateSummary();
}

function bridgeUpdateSummary() {
  const amt = parseFloat(bridgeState.amount) || 0;
  const from = BRIDGE_CHAINS[bridgeState.fromChain];
  const to   = BRIDGE_CHAINS[bridgeState.toChain];

  // Update transaction summary row
  const sumReceive = bridgeEl('bridge-sum-receive');
  const sumTime    = bridgeEl('bridge-sum-time');
  const sumFee     = bridgeEl('bridge-sum-fee');
  if (sumReceive) sumReceive.textContent = amt > 0 ? bridgeFmt(amt) : '—';
  if (sumTime)    sumTime.textContent    = '~15 min';
  if (sumFee)     sumFee.textContent     = '0.00';

  // Update right info card
  const infoFrom = bridgeEl('bridge-info-from');
  const infoTo   = bridgeEl('bridge-info-to');
  const infoTime = bridgeEl('bridge-info-time');
  const infoFee  = bridgeEl('bridge-info-fee');
  if (infoFrom) infoFrom.textContent = from ? from.name : '—';
  if (infoTo)   infoTo.textContent   = to   ? to.name   : '—';
  if (infoTime) infoTime.textContent = '~15 min';
  if (infoFee)  infoFee.textContent  = '0.00 USDC';
}

async function bridgeRefreshBalance() {
  const wallet = window.walletState?.address;
  const chain  = BRIDGE_CHAINS[bridgeState.fromChain];
  const el     = bridgeEl('bridge-balance');
  const eth    = window.ethereum;
  if (!el) return;
  if (!wallet || !eth) { el.textContent = 'Balance: —'; return; }
  try {
    const usdcIface = new window.ethers.Interface(BRIDGE_ERC20_ABI);
    const balanceData = usdcIface.encodeFunctionData('balanceOf', [wallet]);
    const decimalsData = usdcIface.encodeFunctionData('decimals', []);
    const [balanceHex, decimalsHex] = await Promise.all([
      eth.request({ method: 'eth_call', params: [{ to: chain.usdcAddress, data: balanceData }, 'latest'] }),
      eth.request({ method: 'eth_call', params: [{ to: chain.usdcAddress, data: decimalsData }, 'latest'] }),
    ]);
    const dec = parseInt(decimalsHex, 16) || 6;
    const fmt = window.ethers?.formatUnits
      ? window.ethers.formatUnits(BigInt(balanceHex), dec)
      : (Number(BigInt(balanceHex)) / Math.pow(10, dec)).toFixed(6);
    bridgeState.usdcBalance = parseFloat(fmt);
    el.textContent = `Balance: ${bridgeFmt(fmt)} USDC`;
  } catch (e) {
    el.textContent = 'Balance: —';
    bridgeLog('Balance error: ' + e.message, 'warn');
  }
}

function bridgeSetMax() {
  if (bridgeState.usdcBalance && bridgeState.usdcBalance > 0) {
    bridgeState.amount = String(bridgeState.usdcBalance);
    const inp = bridgeEl('bridge-amount-input');
    if (inp) inp.value = bridgeState.usdcBalance;
    bridgeUpdateBtn();
  }
}

// ─── Chain selectors ─────────────────────────────────────────────────────────
function bridgeSelectFrom(key) {
  bridgeState.fromChain = key;
  // Prevent same chain
  if (bridgeState.toChain === key) {
    const others = Object.keys(BRIDGE_CHAINS).filter(k => k !== key);
    bridgeState.toChain = others[0];
  }
  bridgeRenderSelectors();
  bridgeRefreshBalance();
  bridgeUpdateBtn();
}

function bridgeSelectTo(key) {
  bridgeState.toChain = key;
  if (bridgeState.fromChain === key) {
    const others = Object.keys(BRIDGE_CHAINS).filter(k => k !== key);
    bridgeState.fromChain = others[0];
  }
  bridgeRenderSelectors();
  bridgeRefreshBalance();
  bridgeUpdateBtn();
}

function bridgeFlipChains() {
  [bridgeState.fromChain, bridgeState.toChain] = [bridgeState.toChain, bridgeState.fromChain];
  bridgeRenderSelectors();
  bridgeRefreshBalance();
  bridgeUpdateBtn();
}

function bridgeRenderSelectors() {
  const from = BRIDGE_CHAINS[bridgeState.fromChain];
  const to   = BRIDGE_CHAINS[bridgeState.toChain];
  const fromEl = bridgeEl('bridge-from-chain');
  const toEl   = bridgeEl('bridge-to-chain');
  if (fromEl) fromEl.innerHTML = `${from.icon} <span class="font-semibold">${from.shortName}</span> <i class="fas fa-chevron-down text-[10px] opacity-50 ml-1"></i>`;
  if (toEl)   toEl.innerHTML   = `${to.icon} <span class="font-semibold">${to.shortName}</span> <i class="fas fa-chevron-down text-[10px] opacity-50 ml-1"></i>`;

  // Render dropdowns
  bridgeRenderChainDropdown('bridge-from-dropdown', bridgeState.fromChain, (k) => { bridgeSelectFrom(k); bridgeEl('bridge-from-dropdown').classList.add('hidden'); });
  bridgeRenderChainDropdown('bridge-to-dropdown',   bridgeState.toChain,   (k) => { bridgeSelectTo(k);   bridgeEl('bridge-to-dropdown').classList.add('hidden'); });

  // Update info cards
  bridgeUpdateSummary();
}

function bridgeRenderChainDropdown(id, selected, onSelect) {
  const el = bridgeEl(id);
  if (!el) return;
  el.innerHTML = Object.entries(BRIDGE_CHAINS).map(([key, c]) => `
    <button class="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm
      ${selected === key ? 'bg-blue-600/20 text-blue-300 font-semibold' : 'text-gray-300 hover:bg-gray-700/60'}
      transition-all"
      onclick="(${onSelect.toString()})('${key}')">
      <span class="text-base">${c.icon}</span>
      <span>${c.name}</span>
      ${selected === key ? '<i class="fas fa-check ml-auto text-blue-400 text-xs"></i>' : ''}
    </button>
  `).join('');
}

function bridgeToggleDropdown(which) {
  const fromDd = bridgeEl('bridge-from-dropdown');
  const toDd   = bridgeEl('bridge-to-dropdown');
  if (which === 'from') {
    fromDd.classList.toggle('hidden');
    toDd.classList.add('hidden');
  } else {
    toDd.classList.toggle('hidden');
    fromDd.classList.add('hidden');
  }
}

// ─── Mode toggle ──────────────────────────────────────────────────────────────
function bridgeSetMode(mode) {
  bridgeState.mode = mode;
  const fast = bridgeEl('bridge-mode-fast');
  const std  = bridgeEl('bridge-mode-standard');
  const slow = bridgeEl('bridge-mode-slow');
  if (!fast || !std) return;

  // Reset all
  [fast, std, slow].forEach(el => { if (el) { el.classList.remove('active'); } });

  if (mode === 'fast') {
    if (fast) fast.classList.add('active');
  } else if (mode === 'slow') {
    if (slow) slow.classList.add('active');
  } else {
    if (std) std.classList.add('active');
  }

  // Update ETA display
  const etaEl = bridgeEl('bridge-eta');
  if (etaEl) {
    if (mode === 'fast') etaEl.textContent = '~5–15 seconds';
    else if (mode === 'slow') etaEl.textContent = '~3–5 minutes';
    else etaEl.textContent = '~15 minutes';
  }
}

// ─── Core CCTP Flow ───────────────────────────────────────────────────────────
async function bridgeSwitchWalletChain(chainKey) {
  const chain = BRIDGE_CHAINS[chainKey];
  const raw   = window.walletState?.provider;
  if (!raw) throw new Error('No wallet provider');
  try {
    await raw.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chain.chainHex }] });
  } catch (switchErr) {
    const isUnknown = switchErr.code === 4902
      || (switchErr.message && switchErr.message.toLowerCase().includes('unrecognized chain'));
    if (isUnknown) {
      try {
        await raw.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId:          chain.chainHex,
            chainName:        chain.name,
            rpcUrls:          [chain.rpcUrl],
            nativeCurrency:   chainKey === 'arc'
              ? { name: 'USDC', symbol: 'USDC', decimals: 18 }
              : { name: 'ETH', symbol: 'ETH', decimals: 18 },
            blockExplorerUrls:[chain.explorer],
          }],
        });
      } catch (addErr) {
        throw new Error('Failed to add ' + chain.name + ': ' + (addErr.message || addErr));
      }
    } else throw switchErr;
  }
}

async function bridgeBurn(fromChainKey, toChainKey, amount, recipient) {
  const fromChain = BRIDGE_CHAINS[fromChainKey];
  const toChain   = BRIDGE_CHAINS[toChainKey];
  const eth = window.ethereum;
  if (!eth) throw new Error('MetaMask not available');

  bridgeLog(`Switching wallet to ${fromChain.name}…`);
  await bridgeSwitchWalletChain(fromChainKey);

  const senderAddr = window.walletState?.address;
  if (!senderAddr) throw new Error('Wallet not connected');

  // Parse amount using ethers
  const usdcIface = new window.ethers.Interface(BRIDGE_ERC20_ABI);
  const decimals = 6;
  const amountBN = window.ethers.parseUnits(String(amount), decimals);

  // Check balance via eth_call (wallet provider, avoids CSP blocking)
  const balanceData = usdcIface.encodeFunctionData('balanceOf', [senderAddr]);
  const balanceHex = await eth.request({ method: 'eth_call', params: [{ to: fromChain.usdcAddress, data: balanceData }, 'latest'] });
  const balance = BigInt(balanceHex);
  if (balance < amountBN) throw new Error('Insufficient USDC balance');

  // Arc: CCTP manual not supported for native USDC source. Bridge TO Arc works (destination).
  if (fromChainKey === 'arc') {
    throw new Error('Bridging FROM Arc Testnet is not supported via direct CCTP. Bridge TO Arc works — select Arc as the destination chain.');
  }

  // Standard CCTP flow (non-Arc chains) — approve USDC
  bridgeLog('Approving USDC…');
  bridgeSetStatus('<i class="fas fa-lock mr-2"></i>Approving USDC spend…', 'burn');
  const allowanceData = usdcIface.encodeFunctionData('allowance', [senderAddr, fromChain.tokenMessengerV2]);
  const allowanceHex = await eth.request({ method: 'eth_call', params: [{ to: fromChain.usdcAddress, data: allowanceData }, 'latest'] });
  const currentAllowance = BigInt(allowanceHex);

  if (currentAllowance < amountBN) {
    const approveCalldata = usdcIface.encodeFunctionData('approve', [fromChain.tokenMessengerV2, amountBN]);
    const approveHash = await eth.request({
      method: 'eth_sendTransaction',
      params: [{ from: senderAddr, to: fromChain.usdcAddress, data: approveCalldata, gas: '0x' + (100000).toString(16) }],
    });
    bridgeLog('Approve tx: ' + approveHash);
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const receipt = await eth.request({ method: 'eth_getTransactionReceipt', params: [approveHash] });
      if (receipt && receipt.blockNumber) break;
    }
    bridgeLog('Approval confirmed');
  } else {
    bridgeLog('Allowance sufficient, skipping approve');
  }

  // depositForBurn
  bridgeLog(`Burning ${amount} USDC on ${fromChain.name} → domain ${toChain.domain}…`);
  bridgeSetStatus('<i class="fas fa-fire mr-2 animate-pulse"></i>Burning USDC on source chain…', 'burn');
  const mintRecipientBytes32 = bridgeToBytes32(recipient);

  const messengerIface = new window.ethers.Interface(BRIDGE_TOKEN_MESSENGER_ABI);
  const burnCalldata = messengerIface.encodeFunctionData('depositForBurn', [
    amountBN, toChain.domain, mintRecipientBytes32, fromChain.usdcAddress
  ]);

  if (!burnCalldata || burnCalldata === '0x') {
    throw new Error('Bridge calldata missing');
  }

  // Build tx params
  const txParams = {
    from: senderAddr,
    to: fromChain.tokenMessengerV2,
    data: burnCalldata,
    gas: '0x' + (500000).toString(16),
  };

  const burnTxHash = await eth.request({
    method: 'eth_sendTransaction',
    params: [txParams],
  });

  bridgeLog('Burn tx sent: ' + burnTxHash);

  // Wait for receipt via wallet provider (avoids CSP blocking external RPCs)
  let burnReceipt = null;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    burnReceipt = await eth.request({ method: 'eth_getTransactionReceipt', params: [burnTxHash] });
    if (burnReceipt && burnReceipt.blockNumber) break;
  }
  if (!burnReceipt || !burnReceipt.blockNumber) {
    throw new Error('Burn transaction not confirmed within 2 minutes');
  }
  if (parseInt(burnReceipt.status, 16) !== 1) {
    throw new Error('Burn transaction reverted on-chain');
  }
  bridgeLog('Burn confirmed in block ' + parseInt(burnReceipt.blockNumber, 16), 'success');
  return { txHash: burnTxHash, receipt: burnReceipt };
}

async function bridgePollAttestation(txHash, mode, onProgress) {
  // Circle Iris API v2
  const BASE = 'https://iris-api-sandbox.circle.com/v2/messages';
  const FAST_INTERVAL  = 2000;   // 2s polling for fast mode
  const STD_INTERVAL   = 10000;  // 10s for standard
  const MAX_ATTEMPTS   = mode === 'fast' ? 120 : 200; // 4min / 33min max
  const interval       = mode === 'fast' ? FAST_INTERVAL : STD_INTERVAL;

  bridgeLog(`Polling attestation for tx ${txHash} (${mode} mode)…`);
  let attempts = 0;

  return new Promise((resolve, reject) => {
    async function poll() {
      attempts++;
      if (attempts > MAX_ATTEMPTS) {
        reject(new Error('Attestation timeout — please retry later'));
        return;
      }
      try {
        onProgress(attempts, MAX_ATTEMPTS);
        const res = await fetch(`${BASE}?transactionHash=${txHash}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        // Check for complete attestation
        const msg = data?.messages?.[0];
        if (msg && msg.status === 'complete' && msg.attestation && msg.attestation !== 'PENDING') {
          bridgeLog('Attestation received!', 'success');
          resolve({ message: msg.message, attestation: msg.attestation });
          return;
        }
        bridgeLog(`Attestation pending… (attempt ${attempts}/${MAX_ATTEMPTS})`);
      } catch (e) {
        bridgeLog('Poll error: ' + e.message, 'warn');
      }
      bridgeState.pollTimer = setTimeout(poll, interval);
    }
    poll();
  });
}

async function bridgeMint(toChainKey, messageBytes, attestation) {
  const toChain = BRIDGE_CHAINS[toChainKey];
  const eth = window.ethereum;
  if (!eth) throw new Error('MetaMask not available');

  bridgeLog(`Switching wallet to ${toChain.name} for mint…`);
  await bridgeSwitchWalletChain(toChainKey);

  const senderAddr = window.walletState?.address;
  if (!senderAddr) throw new Error('Wallet not connected');

  const transmitterIface = new window.ethers.Interface(BRIDGE_MESSAGE_TRANSMITTER_ABI);
  const mintCalldata = transmitterIface.encodeFunctionData('receiveMessage', [messageBytes, attestation]);

  if (!mintCalldata || mintCalldata === '0x') {
    throw new Error('Mint calldata missing — receiveMessage encoding failed');
  }

  bridgeLog('Calling receiveMessage on ' + toChain.name + '…');
  bridgeSetStatus('<i class="fas fa-coins mr-2 animate-pulse"></i>Minting USDC on destination chain…', 'mint');

  const mintTxHash = await eth.request({
    method: 'eth_sendTransaction',
    params: [{
      from: senderAddr,
      to: toChain.messageTransmitterV2,
      data: mintCalldata,
      gas: '0x' + (500000).toString(16),
    }],
  });

  bridgeLog('Mint tx sent: ' + mintTxHash);

  let mintReceipt = null;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    mintReceipt = await eth.request({ method: 'eth_getTransactionReceipt', params: [mintTxHash] });
    if (mintReceipt && mintReceipt.blockNumber) break;
  }
  if (!mintReceipt || !mintReceipt.blockNumber) {
    throw new Error('Mint transaction not confirmed within 2 minutes');
  }
  if (parseInt(mintReceipt.status, 16) !== 1) {
    throw new Error('Mint transaction reverted on-chain');
  }
  bridgeLog('Mint confirmed!', 'success');
  return { txHash: mintTxHash, receipt: mintReceipt };
}

// ─── Main bridge execute ──────────────────────────────────────────────────────
async function bridgeExecute() {
  if (bridgeState.pending) return;
  if (!window.walletState?.address) {
    bridgeSetStatus('<i class="fas fa-wallet mr-2"></i>Please connect your wallet first.', 'error');
    return;
  }

  const amount    = parseFloat(bridgeState.amount);
  const fromKey   = bridgeState.fromChain;
  const toKey     = bridgeState.toChain;
  const recipient = window.walletState.address;

  if (!amount || isNaN(amount) || amount <= 0) {
    bridgeSetStatus('<i class="fas fa-exclamation-triangle mr-2"></i>Enter a valid amount.', 'error');
    return;
  }
  if (fromKey === toKey) {
    bridgeSetStatus('<i class="fas fa-exclamation-triangle mr-2"></i>Source and destination must differ.', 'error');
    return;
  }
  // Inbound (Other Chains → Arc) is ENABLED — continue to the standard bridge flow.

  // Confirmation modal
  const fromName = BRIDGE_CHAINS[fromKey].name;
  const toName   = BRIDGE_CHAINS[toKey].name;
  const confirmFn = window._showConfirm || window.confirm;
  const confirmed = await confirmFn(
    `Amount: ${bridgeFmt(amount)} USDC\nFrom: ${fromName}\nTo: ${toName}\nRecipient: ${recipient}\n\nThis will burn USDC on ${fromName} and mint on ${toName}.`,
    'Confirm Bridge'
  );
  if (!confirmed) return;

  bridgeState.pending = true;
  bridgeUpdateBtn();
  bridgeSetStep('burn');

  // Create history entry
  const entryId = 'bridge_' + Date.now();
  const entry = {
    id: entryId, from: fromKey, to: toKey,
    amount: String(amount), status: 'burning',
    burnTxHash: null, mintTxHash: null, ts: Date.now(),
    mode: bridgeState.mode,
  };
  bridgeState.history.unshift(entry);
  bridgeSaveHistory();
  bridgeRenderHistory();

  try {
    // Step 1 — Burn
    bridgeSetStatus('<i class="fas fa-fire mr-2 text-orange-400 animate-pulse"></i>Step 1/3 — Burning USDC…', 'burn');
    const { txHash: burnHash } = await bridgeBurn(fromKey, toKey, amount, recipient);
    entry.burnTxHash = burnHash;
    entry.status     = 'attesting';
    bridgeSaveHistory();
    bridgeRenderHistory();

    const fromExplorer = BRIDGE_CHAINS[fromKey].explorer;
    bridgeSetStatus(
      `<i class="fas fa-fire text-orange-400 mr-2"></i>Burned ✅ — <a href="${fromExplorer}/tx/${burnHash}" target="_blank" class="underline text-orange-300 hover:text-orange-200">View burn tx ↗</a>`,
      'attest'
    );
    bridgeSetStep('attest');

    // Step 2 — Attestation
    bridgeSetStatus('<i class="fas fa-hourglass-half mr-2 text-yellow-400 animate-spin"></i>Step 2/3 — Waiting for Circle attestation…', 'attest');

    const { message, attestation } = await bridgePollAttestation(burnHash, bridgeState.mode, (att, max) => {
      const pct = Math.min(100, Math.round((att / max) * 100));
      const bar = bridgeEl('bridge-attest-bar');
      if (bar) bar.style.width = pct + '%';
      bridgeSetStatus(
        `<i class="fas fa-hourglass-half mr-2 text-yellow-400 animate-pulse"></i>Step 2/3 — Awaiting attestation… (${att}/${max})`,
        'attest'
      );
    });

    entry.status      = 'minting';
    entry.messageHex  = message;
    entry.attestation = attestation;
    bridgeSaveHistory();
    bridgeRenderHistory();
    bridgeSetStep('mint');

    // Step 3 — Mint
    const { txHash: mintHash } = await bridgeMint(toKey, message, attestation);
    entry.mintTxHash = mintHash;
    entry.status     = 'done';
    bridgeSaveHistory();
    bridgeRenderHistory();
    bridgeSetStep('done');

    const toExplorer = BRIDGE_CHAINS[toKey].explorer;
    bridgeSetStatus(
      `<i class="fas fa-check-circle text-green-400 mr-2"></i>Bridge Complete! ✅ — <a href="${toExplorer}/tx/${mintHash}" target="_blank" class="underline text-green-300 hover:text-green-200">View mint tx ↗</a>`,
      'done'
    );

    // Reset input
    bridgeState.amount = '';
    const inp = bridgeEl('bridge-amount-input');
    if (inp) inp.value = '';
    bridgeRefreshBalance();

  } catch (err) {
    bridgeLog('Bridge error: ' + err.message, 'error');
    entry.status    = 'error';
    entry.errorMsg  = err.message;
    bridgeSaveHistory();
    bridgeRenderHistory();
    bridgeSetStep('error');
    bridgeSetStatus(`<i class="fas fa-exclamation-circle text-red-400 mr-2"></i>${err.message}`, 'error');
  } finally {
    bridgeState.pending = false;
    if (bridgeState.pollTimer) { clearTimeout(bridgeState.pollTimer); bridgeState.pollTimer = null; }
    bridgeUpdateBtn();
  }
}

// ─── Retry mint ───────────────────────────────────────────────────────────────
async function bridgeRetryMint(entryId) {
  const entry = bridgeState.history.find(e => e.id === entryId);
  if (!entry || entry.status !== 'error' || !entry.messageHex || !entry.attestation) {
    alert('Cannot retry: missing attestation data. Please start a new bridge.');
    return;
  }
  bridgeState.pending = true;
  bridgeUpdateBtn();
  try {
    bridgeSetStep('mint');
    const { txHash } = await bridgeMint(entry.to, entry.messageHex, entry.attestation);
    entry.mintTxHash = txHash;
    entry.status     = 'done';
    bridgeSaveHistory();
    bridgeRenderHistory();
    bridgeSetStep('done');
    bridgeSetStatus(`<i class="fas fa-check-circle text-green-400 mr-2"></i>Mint successful ✅`, 'done');
  } catch (e) {
    bridgeSetStatus(`<i class="fas fa-exclamation-circle text-red-400 mr-2"></i>Retry failed: ${e.message}`, 'error');
  } finally {
    bridgeState.pending = false;
    bridgeUpdateBtn();
  }
}

// ─── History rendering ────────────────────────────────────────────────────────
function bridgeRenderHistory() {
  const el = bridgeEl('bridge-history-list');
  if (!el) return;
  if (!bridgeState.history.length) {
    el.innerHTML = `<div style="text-align:center;padding:40px 16px;">
      <div style="width:44px;height:44px;border-radius:13px;background:rgba(6,182,212,0.06);border:1px solid rgba(6,182,212,0.12);display:flex;align-items:center;justify-content:center;margin:0 auto 12px;">
        <i class="fas fa-inbox" style="color:#4a6490;font-size:18px;"></i>
      </div>
      <div style="color:#6a85aa;font-weight:600;font-size:12px;">No bridge transactions yet</div>
      <div style="color:#4a6490;font-size:10px;margin-top:3px;">Completed bridges will appear here</div>
    </div>`;
    return;
  }
  el.innerHTML = `
    <table class="br-history-table">
      <thead><tr>
        <th>Status</th>
        <th>From → To</th>
        <th>Amount</th>
        <th>Transaction</th>
        <th>Time</th>
        <th>Explorer</th>
      </tr></thead>
      <tbody>
        ${bridgeState.history.slice(0, 20).map(e => {
          const from  = BRIDGE_CHAINS[e.from] || { icon: '?', shortName: e.from, explorer: '' };
          const to    = BRIDGE_CHAINS[e.to]   || { icon: '?', shortName: e.to,   explorer: '' };
          const date  = new Date(e.ts).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
          const statusMap = {
            burning:   { icon:'fa-fire',        cls:'color:#fb923c;', bg:'background:rgba(251,146,60,0.1);border:1px solid rgba(251,146,60,0.25);', label:'Burning' },
            attesting: { icon:'fa-spinner fa-spin', cls:'color:#facc15;', bg:'background:rgba(250,204,21,0.1);border:1px solid rgba(250,204,21,0.25);', label:'Attesting' },
            minting:   { icon:'fa-coins',       cls:'color:#60a5fa;', bg:'background:rgba(96,165,250,0.1);border:1px solid rgba(96,165,250,0.25);', label:'Minting' },
            done:      { icon:'fa-circle-check',cls:'color:#4ade80;', bg:'background:rgba(74,222,128,0.1);border:1px solid rgba(74,222,128,0.25);', label:'Completed' },
            error:     { icon:'fa-circle-xmark',cls:'color:#f87171;', bg:'background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.25);', label:'Failed' },
          };
          const st = statusMap[e.status] || { icon:'fa-minus', cls:'color:#9ca3af;', bg:'background:rgba(156,163,175,0.08);border:1px solid rgba(156,163,175,0.2);', label:e.status };
          const burnLink = e.burnTxHash && from.explorer
            ? `<a href="${from.explorer}/tx/${e.burnTxHash}" target="_blank" style="color:#60b4ff;font-size:10px;text-decoration:none;" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">Burn ↗</a>`
            : '';
          const mintLink = e.mintTxHash && to.explorer
            ? `<a href="${to.explorer}/tx/${e.mintTxHash}" target="_blank" style="color:#34d399;font-size:10px;text-decoration:none;margin-left:6px;" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">Mint ↗</a>`
            : '';
          const retryBtn = (e.status === 'error' && e.messageHex && e.attestation)
            ? `<button onclick="bridgeRetryMint('${e.id}')" style="margin-left:6px;font-size:9px;padding:2px 8px;border-radius:8px;background:rgba(59,130,246,0.12);border:1px solid rgba(59,130,246,0.3);color:#60a5fa;cursor:pointer;transition:all 0.15s;" onmouseover="this.style.background='rgba(59,130,246,0.22)'" onmouseout="this.style.background='rgba(59,130,246,0.12)'">Retry</button>`
            : '';
          return `
          <tr>
            <td><span style="display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:999px;font-size:10px;font-weight:700;${st.bg}${st.cls}"><i class="fas ${st.icon}" style="font-size:9px;"></i>${st.label}</span></td>
            <td><span style="font-size:14px;">${from.icon}</span> <i class="fas fa-arrow-right" style="color:#4a6490;font-size:9px;margin:0 4px;"></i> <span style="font-size:14px;">${to.icon}</span> <span style="font-size:10px;color:#8aaac8;">${from.shortName} → ${to.shortName}</span></td>
            <td><span style="font-weight:700;color:#e8edf8;">${bridgeFmt(e.amount)}</span> <span style="color:#22d3ee;font-size:10px;">USDC</span></td>
            <td>${burnLink}${mintLink}${retryBtn}</td>
            <td style="color:#6a85aa;">${date}</td>
            <td style="text-align:center;">${(e.burnTxHash || e.mintTxHash) ? `<a href="${(from.explorer || to.explorer)}/tx/${e.burnTxHash || e.mintTxHash}" target="_blank" style="color:#4a6490;" onmouseover="this.style.color='#22d3ee'" onmouseout="this.style.color='#4a6490'"><i class="fas fa-external-link-alt" style="font-size:11px;"></i></a>` : '—'}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

// ─── Initialisation ───────────────────────────────────────────────────────────
function bridgeInit() {
  bridgeLoadHistory();
  bridgeRenderSelectors();
  bridgeSetMode('fast');
  bridgeSetStep(null);
  bridgeRenderHistory();
  bridgeRefreshBalance();
  bridgeUpdateBtn();

  // Amount input listener
  const inp = bridgeEl('bridge-amount-input');
  if (inp) {
    inp.addEventListener('input', () => {
      bridgeState.amount = inp.value;
      bridgeUpdateBtn();
    });
  }

  // Close dropdowns on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#bridge-from-wrap')) bridgeEl('bridge-from-dropdown')?.classList.add('hidden');
    if (!e.target.closest('#bridge-to-wrap'))   bridgeEl('bridge-to-dropdown')?.classList.add('hidden');
  });

  bridgeLog('Bridge module ready');
}

// Expose globals
window.bridgeInit       = bridgeInit;
window.bridgeExecute    = bridgeExecute;
window.bridgeFlipChains = bridgeFlipChains;
window.bridgeToggleDropdown = bridgeToggleDropdown;
window.bridgeSetMode    = bridgeSetMode;
window.bridgeSetMax     = bridgeSetMax;
window.bridgeRetryMint  = bridgeRetryMint;
window.bridgeRenderHistory = bridgeRenderHistory;

console.log('[BRIDGE] CCTP module loaded — Testnet only');
