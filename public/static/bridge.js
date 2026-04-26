// ============================================================
// CCTP Bridge — ExecDaat dApp
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
    rpcUrl:     'https://rpc.sepolia.org',
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
  mode:         'fast',       // 'fast' | 'standard'
  pending:      false,
  history:      [],           // [{id, from, to, amount, status, txHash, attestationTxHash, ts}]
  pollTimer:    null,
  usdcBalance:  null,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function bridgeGetProvider(chainKey) {
  // If chainKey matches connected wallet chain → use wallet provider
  const chain = BRIDGE_CHAINS[chainKey];
  const walletChainId = window.walletState?.chainId;
  if (walletChainId && Number(walletChainId) === chain.chainId) {
    const raw = window.walletState?.provider;
    if (!raw) throw new Error('Wallet not connected');
    if (window.ethers?.BrowserProvider) return new window.ethers.BrowserProvider(raw);
    if (window.ethers?.providers?.Web3Provider) return new window.ethers.providers.Web3Provider(raw);
    throw new Error('ethers.js not loaded');
  }
  // Otherwise use public RPC read-only provider
  if (window.ethers?.JsonRpcProvider) return new window.ethers.JsonRpcProvider(chain.rpcUrl);
  if (window.ethers?.providers?.JsonRpcProvider) return new window.ethers.providers.JsonRpcProvider(chain.rpcUrl);
  throw new Error('ethers.js not loaded');
}

async function bridgeGetSignerForChain(chainKey) {
  const chain = BRIDGE_CHAINS[chainKey];
  const raw   = window.walletState?.provider;
  if (!raw) throw new Error('Wallet not connected');

  if (window.ethers?.BrowserProvider) {
    const p = new window.ethers.BrowserProvider(raw);
    return p.getSigner();
  }
  if (window.ethers?.providers?.Web3Provider) {
    const p = new window.ethers.providers.Web3Provider(raw);
    return p.getSigner();
  }
  throw new Error('ethers.js not loaded');
}

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
    idle:    'bg-gray-800/60 border-gray-700/40 text-gray-400',
    burn:    'bg-orange-900/30 border-orange-700/40 text-orange-300',
    attest:  'bg-yellow-900/30 border-yellow-700/40 text-yellow-300',
    mint:    'bg-blue-900/30 border-blue-700/40 text-blue-300',
    done:    'bg-green-900/30 border-green-700/40 text-green-300',
    error:   'bg-red-900/30 border-red-700/40 text-red-300',
  };
  el.className = `rounded-xl px-4 py-3 text-sm flex items-center gap-2 border transition-all ${colors[type] || colors.idle}`;
  el.innerHTML = text;
  el.classList.remove('hidden');
}

function bridgeSetStep(step) {
  // step: null | 'burn' | 'attest' | 'mint' | 'done' | 'error'
  const steps = ['burn', 'attest', 'mint', 'done'];
  steps.forEach(s => {
    const el = bridgeEl(`bridge-step-${s}`);
    if (!el) return;
    el.classList.remove('bridge-step-active', 'bridge-step-done', 'bridge-step-pending', 'bridge-step-error');
    if (!step) { el.classList.add('bridge-step-pending'); return; }
    const idx = steps.indexOf(s);
    const cur = steps.indexOf(step === 'error' ? 'burn' : step);
    if (step === 'error' && s === 'burn') { el.classList.add('bridge-step-error'); }
    else if (idx < cur || (step === 'done' && idx <= steps.indexOf('done'))) { el.classList.add('bridge-step-done'); }
    else if (idx === cur) { el.classList.add('bridge-step-active'); }
    else { el.classList.add('bridge-step-pending'); }
  });
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
    : `<i class="fas fa-bridge mr-2"></i>Bridge ${bridgeFmt(bridgeState.amount)} USDC`;
}

async function bridgeRefreshBalance() {
  const wallet = window.walletState?.address;
  const chain  = BRIDGE_CHAINS[bridgeState.fromChain];
  const el     = bridgeEl('bridge-balance');
  if (!el) return;
  if (!wallet) { el.textContent = 'Balance: —'; return; }
  try {
    const provider = bridgeGetProvider(bridgeState.fromChain);
    const usdc = new window.ethers.Contract(chain.usdcAddress, BRIDGE_ERC20_ABI, provider);
    const [bal, dec] = await Promise.all([usdc.balanceOf(wallet), usdc.decimals()]);
    const fmt = window.ethers?.formatUnits
      ? window.ethers.formatUnits(bal, dec)
      : (Number(bal) / Math.pow(10, dec)).toFixed(6);
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
  if (!fast || !std) return;
  if (mode === 'fast') {
    fast.className = 'flex-1 py-2 px-3 text-xs font-bold rounded-lg bg-gradient-to-r from-yellow-500 to-amber-500 text-gray-900 shadow transition-all flex items-center justify-center gap-1';
    std.className  = 'flex-1 py-2 px-3 text-xs font-semibold rounded-lg text-gray-400 hover:text-white hover:bg-gray-800/60 transition-all flex items-center justify-center gap-1';
  } else {
    std.className  = 'flex-1 py-2 px-3 text-xs font-bold rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow transition-all flex items-center justify-center gap-1';
    fast.className = 'flex-1 py-2 px-3 text-xs font-semibold rounded-lg text-gray-400 hover:text-white hover:bg-gray-800/60 transition-all flex items-center justify-center gap-1';
  }
  // Update ETA display
  const etaEl = bridgeEl('bridge-eta');
  if (etaEl) etaEl.textContent = mode === 'fast' ? '~5–15 seconds' : '~15 minutes';
}

// ─── Core CCTP Flow ───────────────────────────────────────────────────────────
async function bridgeSwitchWalletChain(chainKey) {
  const chain = BRIDGE_CHAINS[chainKey];
  const raw   = window.walletState?.provider;
  if (!raw) throw new Error('No wallet provider');
  try {
    await raw.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chain.chainHex }] });
  } catch (switchErr) {
    if (switchErr.code === 4902) {
      await raw.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId:          chain.chainHex,
          chainName:        chain.name,
          rpcUrls:          [chain.rpcUrl],
          nativeCurrency:   { name: 'ETH', symbol: 'ETH', decimals: 18 },
          blockExplorerUrls:[chain.explorer],
        }],
      });
    } else throw switchErr;
  }
}

async function bridgeBurn(fromChainKey, toChainKey, amount, recipient) {
  const fromChain = BRIDGE_CHAINS[fromChainKey];
  const toChain   = BRIDGE_CHAINS[toChainKey];

  bridgeLog(`Switching wallet to ${fromChain.name}…`);
  await bridgeSwitchWalletChain(fromChainKey);

  const signer    = await bridgeGetSignerForChain(fromChainKey);
  const provider  = bridgeGetProvider(fromChainKey);
  const usdc      = new window.ethers.Contract(fromChain.usdcAddress, BRIDGE_ERC20_ABI, signer);
  const messenger = new window.ethers.Contract(fromChain.tokenMessengerV2, BRIDGE_TOKEN_MESSENGER_ABI, signer);

  // Parse amount
  const decimals = await usdc.decimals();
  const amountBN = window.ethers.parseUnits
    ? window.ethers.parseUnits(String(amount), decimals)
    : window.ethers.utils.parseUnits(String(amount), decimals);

  // Check balance
  const balance = await usdc.balanceOf(await signer.getAddress());
  if (balance < amountBN) throw new Error('Insufficient USDC balance');

  // Approve
  bridgeLog('Approving USDC…');
  bridgeSetStatus('<i class="fas fa-lock mr-2"></i>Approving USDC spend…', 'burn');
  const currentAllowance = await usdc.allowance(await signer.getAddress(), fromChain.tokenMessengerV2);
  if (currentAllowance < amountBN) {
    const approveTx = await usdc.approve(fromChain.tokenMessengerV2, amountBN);
    await approveTx.wait(1);
    bridgeLog('Approval confirmed');
  } else {
    bridgeLog('Allowance sufficient, skipping approve');
  }

  // depositForBurn
  bridgeLog(`Burning ${amount} USDC on ${fromChain.name} → domain ${toChain.domain}…`);
  bridgeSetStatus('<i class="fas fa-fire mr-2 animate-pulse"></i>Burning USDC on source chain…', 'burn');
  const mintRecipientBytes32 = bridgeToBytes32(recipient);
  const burnTx = await messenger.depositForBurn(
    amountBN,
    toChain.domain,
    mintRecipientBytes32,
    fromChain.usdcAddress
  );
  bridgeLog('Burn tx sent: ' + burnTx.hash);
  const receipt = await burnTx.wait(1);
  bridgeLog('Burn confirmed in block ' + receipt.blockNumber, 'success');
  return { txHash: burnTx.hash, receipt };
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
  const toChain   = BRIDGE_CHAINS[toChainKey];
  bridgeLog(`Switching wallet to ${toChain.name} for mint…`);
  await bridgeSwitchWalletChain(toChainKey);

  const signer      = await bridgeGetSignerForChain(toChainKey);
  const transmitter = new window.ethers.Contract(toChain.messageTransmitterV2, BRIDGE_MESSAGE_TRANSMITTER_ABI, signer);

  bridgeLog('Calling receiveMessage on ' + toChain.name + '…');
  bridgeSetStatus('<i class="fas fa-coins mr-2 animate-pulse"></i>Minting USDC on destination chain…', 'mint');
  const mintTx = await transmitter.receiveMessage(messageBytes, attestation);
  bridgeLog('Mint tx sent: ' + mintTx.hash);
  const receipt = await mintTx.wait(1);
  bridgeLog('Mint confirmed!', 'success');
  return { txHash: mintTx.hash, receipt };
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

  // Confirmation modal
  const fromName = BRIDGE_CHAINS[fromKey].name;
  const toName   = BRIDGE_CHAINS[toKey].name;
  const modeLabel = bridgeState.mode === 'fast' ? '⚡ Fast (~5–15s)' : '🛡️ Standard (~15min)';
  const confirmed = window.confirm(
    `Confirm Bridge\n\nAmount: ${bridgeFmt(amount)} USDC\nFrom: ${fromName}\nTo: ${toName}\nMode: ${modeLabel}\nRecipient: ${recipient}\n\nThis will burn USDC on ${fromName} and mint on ${toName}.`
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
    el.innerHTML = `<div class="text-gray-600 text-sm text-center py-6"><i class="fas fa-inbox mr-2 opacity-40"></i>No bridge transactions yet.</div>`;
    return;
  }
  el.innerHTML = bridgeState.history.slice(0, 20).map(e => {
    const from  = BRIDGE_CHAINS[e.from] || { icon: '?', shortName: e.from, explorer: '' };
    const to    = BRIDGE_CHAINS[e.to]   || { icon: '?', shortName: e.to,   explorer: '' };
    const date  = new Date(e.ts).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
    const statusMap = {
      burning:   ['<i class="fas fa-fire text-orange-400 animate-pulse"></i>', 'text-orange-400', 'Burning…'],
      attesting: ['<i class="fas fa-hourglass-half text-yellow-400 animate-spin"></i>', 'text-yellow-400', 'Attesting…'],
      minting:   ['<i class="fas fa-coins text-blue-400 animate-pulse"></i>', 'text-blue-400', 'Minting…'],
      done:      ['<i class="fas fa-check-circle text-green-400"></i>', 'text-green-400', 'Completed'],
      error:     ['<i class="fas fa-exclamation-circle text-red-400"></i>', 'text-red-400', 'Failed'],
    };
    const [icon, cls, label] = statusMap[e.status] || ['', 'text-gray-400', e.status];
    const burnLink = e.burnTxHash && from.explorer
      ? `<a href="${from.explorer}/tx/${e.burnTxHash}" target="_blank" class="text-xs text-gray-500 hover:text-blue-400 transition-colors underline">${bridgeShortAddr(e.burnTxHash)} ↗</a>`
      : '';
    const mintLink = e.mintTxHash && to.explorer
      ? `<a href="${to.explorer}/tx/${e.mintTxHash}" target="_blank" class="text-xs text-gray-500 hover:text-green-400 transition-colors underline">${bridgeShortAddr(e.mintTxHash)} ↗</a>`
      : '';
    const retryBtn = (e.status === 'error' && e.messageHex && e.attestation)
      ? `<button onclick="bridgeRetryMint('${e.id}')" class="ml-2 text-xs px-2 py-0.5 rounded-lg bg-blue-600/20 border border-blue-600/40 text-blue-400 hover:bg-blue-600/40 transition-all">Retry Mint</button>`
      : '';
    return `
      <div class="bg-gray-800/50 border border-gray-700/40 rounded-xl px-4 py-3 flex flex-wrap items-center gap-3">
        <div class="flex items-center gap-2 flex-1 min-w-0">
          <span class="text-base">${from.icon}</span>
          <i class="fas fa-arrow-right text-gray-600 text-xs"></i>
          <span class="text-base">${to.icon}</span>
          <div class="min-w-0">
            <div class="text-white text-sm font-semibold truncate">${bridgeFmt(e.amount)} USDC</div>
            <div class="text-gray-500 text-xs">${from.shortName} → ${to.shortName}</div>
          </div>
        </div>
        <div class="flex flex-col items-end gap-1 text-right">
          <div class="flex items-center gap-1.5 text-xs ${cls}">${icon}<span>${label}</span>${retryBtn}</div>
          <div class="text-gray-600 text-xs">${date}</div>
          <div class="flex gap-2">${burnLink}${mintLink}</div>
        </div>
      </div>`;
  }).join('');
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
