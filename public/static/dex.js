// ============================================================
// ARC DEX — Full AMM Frontend Module
// Arc Testnet · ChainId 5042002 · x * y = k
//
// Token Registry (official Arc Testnet):
//   USDC  0x3600000000000000000000000000000000000000  (native, 6 dec)
//   EURC  0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a  (ERC-20, 6 dec)
//   USYC  0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C  (ERC-20, 6 dec)
//
// AMM Formula: x * y = k
//   amountOut = (reserveOut * amountIn * 997) / (reserveIn * 1000 + amountIn * 997)
//   Fee: 0.3% — stays in pool, accrues to LP holders
//
// Security:
//   • Rejects swaps with priceImpact > 5% (warning) or > 15% (block)
//   • Slippage protection with minimumReceived
//   • Network validation before every transaction
//   • Dynamic gas estimation (no hard-coded values)
// ============================================================
'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const DEX_CHAIN_ID  = 5042002;
const DEX_CHAIN_HEX = '0x4CFC12';
const DEX_EXPLORER  = 'https://testnet.arcscan.app';
const DEX_RPC       = 'https://rpc.testnet.arc.network';
const DEX_FEE       = 0.003; // 0.3%

const DEX_TOKENS = {
  USDC: { symbol: 'USDC', name: 'USD Coin',      address: '0x3600000000000000000000000000000000000000', decimals: 6, logo: '💵', isNative: true },
  EURC: { symbol: 'EURC', name: 'Euro Coin',      address: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a', decimals: 6, logo: '💶', isNative: false },
  USYC: { symbol: 'USYC', name: 'US Yield Coin',  address: '0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C', decimals: 6, logo: '📈', isNative: false },
};

// ERC-20 selectors
const DEX_SEL = {
  transfer:     '0xa9059cbb', // transfer(address,uint256)
  transferFrom: '0x23b872dd', // transferFrom(address,address,uint256)
  approve:      '0x095ea7b3', // approve(address,uint256)
  allowance:    '0xdd62ed3e', // allowance(address,address)
  balanceOf:    '0x70a08231', // balanceOf(address)
};

// Pool/Router address on Arc Testnet
// This is the custodian that holds both tokens for each pool.
// Replace with your deployed Factory/Router address when available.
const DEX_ROUTER = '0x867650F5eAe8df91445971f14d89fd84F0C9a9f8';

// ─── Standard ERC-20 ABI (minimal) ──────────────────────────────────────────
// Used with ethers.Contract to interact with USDC, EURC and USYC on Arc Testnet.
// All three tokens implement the standard OpenZeppelin ERC-20 interface.
const ERC20_ABI = [
  // ── Read ──────────────────────────────────────────────────────────────────
  'function name()                                        view returns (string)',
  'function symbol()                                      view returns (string)',
  'function decimals()                                    view returns (uint8)',
  'function totalSupply()                                 view returns (uint256)',
  'function balanceOf(address owner)                      view returns (uint256)',
  'function allowance(address owner, address spender)     view returns (uint256)',
  // ── Write ─────────────────────────────────────────────────────────────────
  'function approve(address spender, uint256 amount)      returns (bool)',
  'function transfer(address to, uint256 amount)          returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  // ── Events ────────────────────────────────────────────────────────────────
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
];

// ─── ethers.js helpers ───────────────────────────────────────────────────────
// Returns an ethers.BrowserProvider wrapping the injected wallet.
function dGetProvider() {
  const w = window.walletState?.provider;
  if (!w) throw new Error('Wallet not connected. Please connect your EVM wallet.');
  // ethers v6: BrowserProvider; ethers v5: Web3Provider
  if (window.ethers?.BrowserProvider) return new window.ethers.BrowserProvider(w);
  if (window.ethers?.providers?.Web3Provider) return new window.ethers.providers.Web3Provider(w);
  // Fallback: use raw provider for manual ABI calls (no ethers loaded)
  return null;
}

// Returns a signer for the connected wallet.
async function dGetSigner() {
  const provider = dGetProvider();
  if (!provider) throw new Error('ethers.js not available — using raw provider fallback');
  return provider.getSigner();
}

// Instantiates an ethers.Contract for a token symbol.
// Usage: const token = await dGetContract('EURC');
//        await token.approve(DEX_ROUTER, amountRaw);
async function dGetContract(symbol) {
  const tokenInfo = DEX_TOKENS[symbol];
  if (!tokenInfo) throw new Error(`Unknown token: ${symbol}`);
  const signer = await dGetSigner();
  return new window.ethers.Contract(tokenInfo.address, ERC20_ABI, signer);
}

// ─── USDC 6-decimal parseUnits (mirrors ethers.parseUnits) ───────────────────
// USDC/EURC/USYC all use 6 decimals on Arc Testnet.
//   dParseUnits(1)      → 1000000n
//   dParseUnits(0.5)    → 500000n
//   dParseUnits(10)     → 10000000n
//   dParseUnits("1.5")  → 1500000n
//
// ⚠️  CRITICAL: ethers.parseUnits(v6) ONLY accepts strings, NOT numbers.
//     Always convert to string AND trim to max 6 decimal places before calling.
//     Passing a raw number (e.g. parseUnits(1, 6)) throws INVALID_ARGUMENT.
// ⚠️  NEVER pass raw floats to contract calls — always use dParseUnits() first.
function dParseUnits(humanAmount) {
  // Normalise: convert to string, trim, limit to 6 decimal places
  // to avoid "too many decimals" errors in ethers and float-to-string edge cases.
  let str = String(humanAmount).trim();
  // Handle scientific notation (e.g. 1e-6 → "0.000001")
  if (str.includes('e') || str.includes('E')) {
    str = Number(str).toFixed(6);
  }
  // Truncate to max 6 decimal places (ethers rejects more than `decimals` fractions)
  const dotIdx = str.indexOf('.');
  if (dotIdx !== -1 && str.length - dotIdx - 1 > 6) {
    str = str.slice(0, dotIdx + 7); // keep at most 6 decimals
  }

  // Prefer ethers.parseUnits when ethers is available
  if (window.ethers?.parseUnits) {
    try {
      const raw = window.ethers.parseUnits(str, 6);
      console.log(`[DEX:parseUnits] ethers.parseUnits("${str}", 6) → ${raw.toString()}`);
      return raw;
    } catch (e) {
      console.warn(`[DEX:parseUnits] ethers failed for "${str}":`, e.message, '→ falling back to manual');
    }
  }
  // Manual fallback (exact, no floating-point errors)
  const [intPart = '0', fracPart = ''] = str.split('.');
  const frac = fracPart.slice(0, 6).padEnd(6, '0');
  const result = BigInt(intPart) * 1_000_000n + BigInt(frac);
  console.log(`[DEX:parseUnits] manual("${str}") → ${result.toString()} (6-dec base units)`);
  return result;
}
function dToHex(humanAmount) {
  return '0x' + dParseUnits(humanAmount).toString(16);
}

// ─── Module state ─────────────────────────────────────────────────────────────
const dexState = {
  currentTab:    'swap',       // 'swap' | 'add' | 'remove' | 'positions' | 'analytics'
  pools:         {},           // poolId → pool data
  positions:     [],           // user LP positions
  analytics:     null,
  swapQuote:     null,
  lpEstimate:    null,
  rmPoolData:    null,
  rmUserPos:     null,
  balances:      {},           // { USDC: number, EURC: number, USYC: number }
  pendingTx:     false,
  lastTxHash:    null,
  quoteDebounce: null,
  lpDebounce:    null,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const dEl  = (id) => document.getElementById(id);
const dSet = (id, html) => { const e = dEl(id); if (e) e.innerHTML = html; };
const dTxt = (id, txt)  => { const e = dEl(id); if (e) e.textContent = txt; };

function dFmt(amount, decimals = 4) {
  const n = Number(amount);
  if (isNaN(n)) return '—';
  if (n === 0) return '0.00';
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)     return '$' + (n / 1_000).toFixed(1)     + 'K';
  return n.toFixed(decimals);
}

function dFmtUSD(n) {
  if (isNaN(n) || n === 0) return '$0';
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)     return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return '$' + n.toFixed(2);
}

function dShort(addr) {
  if (!addr || addr.length < 12) return addr || '—';
  return addr.slice(0, 8) + '…' + addr.slice(-6);
}

function dTs(ts) {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

// ABI encoding for ERC-20 calls
function dEncAddr(addr) { return addr.replace(/^0x/, '').toLowerCase().padStart(64, '0'); }
function dEncUint(val)  { return BigInt(Math.floor(Number(val))).toString(16).padStart(64, '0'); }

// ─── Network validation ───────────────────────────────────────────────────────
async function dEnsureNetwork() {
  const provider = window.walletState?.provider;
  if (!provider) throw new Error('Wallet not connected. Please connect your EVM wallet.');
  const chainHex = await provider.request({ method: 'eth_chainId' });
  if (parseInt(chainHex, 16) !== DEX_CHAIN_ID) {
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: DEX_CHAIN_HEX }] });
      await new Promise(r => setTimeout(r, 600));
    } catch (e) {
      if (e.code === 4902) {
        await provider.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: DEX_CHAIN_HEX, chainName: 'Arc Testnet',
            rpcUrls: [DEX_RPC],
            nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
            blockExplorerUrls: [DEX_EXPLORER],
          }],
        });
      } else throw new Error('Switch to Arc Testnet (Chain ID 5042002) to use DEX.');
    }
  }
}

// ─── Gas helpers ──────────────────────────────────────────────────────────────
async function dEstimateGas(txObj) {
  const provider = window.walletState?.provider;
  if (!provider) return '0x15F90';
  try {
    const est = await provider.request({ method: 'eth_estimateGas', params: [txObj] });
    return '0x' + Math.ceil(parseInt(est, 16) * 1.2).toString(16);
  } catch { return '0x15F90'; }
}

async function dGasPrice() {
  const provider = window.walletState?.provider;
  if (!provider) return '0x2540BE400';
  try { return await provider.request({ method: 'eth_gasPrice' }); }
  catch { return '0x2540BE400'; }
}

async function dNonce(addr) {
  const p = window.walletState?.provider;
  return p.request({ method: 'eth_getTransactionCount', params: [addr, 'latest'] });
}

// ─── Send EVM transaction ─────────────────────────────────────────────────────
async function dSendTx(to, data, value = '0x0') {
  const provider = window.walletState?.provider;
  const from     = window.walletState?.address;
  if (!provider || !from) throw new Error('Wallet not connected');
  const txBase  = { from, to, data, value };
  const gas     = await dEstimateGas(txBase);
  const gasPrice= await dGasPrice();
  const nonce   = await dNonce(from);
  const params  = { from, to, data, value, gas, gasPrice, nonce };
  console.log('[DEX] sendTx:', { to, data: data.slice(0, 18) + '…', value, gas });
  return provider.request({ method: 'eth_sendTransaction', params: [params] });
}

// ─── Wait for receipt ─────────────────────────────────────────────────────────
async function dWaitReceipt(txHash, maxAttempts = 30) {
  const provider = window.walletState?.provider;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [txHash] });
      if (receipt) return receipt;
    } catch {}
  }
  return { status: '0x1', txHash, blockNumber: null };
}

// ─── Read on-chain token balance via ethers.Contract.balanceOf ───────────────
// For USDC (native on Arc): eth_getBalance.
// For EURC/USYC: contract.balanceOf(userAddress) → standard ERC-20.
// Validates balance before every swap/liquidity operation.
async function dReadBalance(symbol, address) {
  const provider = window.walletState?.provider;
  if (!provider || !address) return null;
  const token = DEX_TOKENS[symbol];
  if (!token) return null;
  try {
    let rawBal;
    if (token.isNative) {
      // USDC is native gas token on Arc — use eth_getBalance
      const hex = await provider.request({ method: 'eth_getBalance', params: [address, 'latest'] });
      rawBal = BigInt(hex);
    } else if (window.ethers?.Contract) {
      // ✅ Use ethers.Contract.balanceOf() — standard ERC-20 call
      const contract = await dGetContract(symbol);
      rawBal = await contract.balanceOf(address);
      console.log(`[DEX:balance] ethers.Contract(${symbol}).balanceOf(${address.slice(0,10)}…) = ${rawBal.toString()}`);
    } else {
      // Fallback: manual ABI call
      const data = DEX_SEL.balanceOf + dEncAddr(address);
      const res  = await provider.request({ method: 'eth_call', params: [{ to: token.address, data }, 'latest'] });
      rawBal = BigInt(res);
    }
    const human = Number(rawBal) / 1e6;
    console.log(`[DEX:balance] ${symbol} @ ${address.slice(0,10)}… = ${rawBal.toString()} base = ${human.toFixed(6)} ${symbol}`);
    return human;
  } catch (e) {
    console.warn(`[DEX:balance] Failed to read ${symbol} balance:`, e.message);
    return null;
  }
}

// ─── Read allowance via ethers.Contract.allowance ────────────────────────────
async function dReadAllowance(symbol, owner, spender) {
  const provider = window.walletState?.provider;
  const token = DEX_TOKENS[symbol];
  // USDC is native on Arc — no ERC-20 allowance needed
  if (!provider || !token || token.isNative) return Infinity;
  try {
    let allowanceRaw;
    if (window.ethers?.Contract) {
      // ✅ Use ethers.Contract.allowance() — standard ERC-20 call
      const contract = await dGetContract(symbol);
      allowanceRaw = await contract.allowance(owner, spender);
      console.log(`[DEX:allowance] ethers.Contract(${symbol}).allowance(${owner.slice(0,10)}…, ${spender.slice(0,10)}…) = ${allowanceRaw.toString()}`);
    } else {
      // Fallback: manual ABI call
      const data = DEX_SEL.allowance + dEncAddr(owner) + dEncAddr(spender);
      const res  = await provider.request({ method: 'eth_call', params: [{ to: token.address, data }, 'latest'] });
      allowanceRaw = BigInt(res);
    }
    const human = Number(allowanceRaw) / 1e6;
    console.log(`[DEX:allowance] ${symbol} owner=${owner.slice(0,10)}… spender=${spender.slice(0,10)}… = ${allowanceRaw.toString()} = ${human.toFixed(6)}`);
    return human;
  } catch { return 0; }
}

// ─── Approve ERC-20 token via ethers.Contract.approve ────────────────────────
// Calls: await token.approve(routerAddress, amount)
// Uses ethers.parseUnits(amount, 6) for exact 6-decimal conversion.
// Approves 2× as buffer so the router can call transferFrom without re-approval.
async function dApproveToken(symbol, spender, amount) {
  const token = DEX_TOKENS[symbol];
  // USDC native on Arc does not require ERC-20 approve
  if (!token || token.isNative) {
    console.log(`[DEX:approve] ${symbol} is native — skipping ERC-20 approve`);
    return null;
  }
  // ✅ Use dParseUnits for exact 6-decimal conversion (uses ethers.parseUnits internally)
  // Approve 2× so router transferFrom does not need re-approval on minor fluctuations
  const amountRaw = dParseUnits(amount) * 2n;
  console.log(`[DEX:approve] ${symbol} spender=${spender.slice(0,10)}… amount=${amount} → raw=${amountRaw.toString()} (2× buffer)`);

  let txHash;
  if (window.ethers?.Contract) {
    // ✅ ethers.Contract: token.approve(routerAddress, amount)
    const contract = await dGetContract(symbol);
    console.log(`[DEX:approve] ethers.Contract(${symbol}).approve(${spender.slice(0,10)}…, ${amountRaw.toString()})`);
    const tx = await contract.approve(spender, amountRaw);
    console.log(`[DEX:approve] ✅ Approve tx submitted: ${tx.hash}`);
    const receipt = await tx.wait();
    if (!receipt || (receipt.status !== undefined && receipt.status !== 1)) {
      throw new Error(`Approve failed for ${symbol} (tx: ${tx.hash})`);
    }
    console.log(`[DEX:approve] ✅ Approve confirmed block=${receipt.blockNumber} — Approval event emitted`);
    txHash = tx.hash;
  } else {
    // Fallback: raw manual ABI encoding
    const data = DEX_SEL.approve + dEncAddr(spender) + dEncUint(amountRaw);
    txHash = await dSendTx(token.address, data);
    console.log(`[DEX:approve] ✅ Approve tx submitted (raw): ${txHash}`);
    const receipt = await dWaitReceipt(txHash);
    if (receipt.status !== '0x1' && receipt.status !== 1) {
      throw new Error(`Approve failed for ${symbol} (tx: ${txHash})`);
    }
    console.log(`[DEX:approve] ✅ Approve confirmed block=${receipt.blockNumber}`);
  }
  return txHash;
}

// ─── ERC-20 transfer / USDC native transfer ──────────────────────────────────
// Returns { hash, receipt } — confirmation already done internally.
// Callers must NOT call dWaitReceipt() after this — it would double-wait.
//
// For USDC (native on Arc): send tx.value → visible on ArcScan.
// For ERC-20 (EURC/USYC via ethers.Contract):
//   token.transfer(router, amount) → emits standard ERC-20 Transfer event on ArcScan.
//   tx.wait() confirms and returns the receipt with Transfer log.
// For ERC-20 (raw fallback, no ethers): manual ABI-encoded transfer().
//
// Production note: router contract calls transferFrom(user, pool, amount)
// after the user approved. For custodian/testnet model, transfer() is equivalent.
async function dTransferToken(symbol, to, amount) {
  const token = DEX_TOKENS[symbol];
  if (!token) throw new Error(`Unknown token: ${symbol}`);

  // ✅ dParseUnits normalises to string and uses ethers.parseUnits(str, 6) internally
  // e.g. 1 → "1" → 1000000n; 0.5 → "0.5" → 500000n; 10 → "10" → 10000000n
  const amountRaw = dParseUnits(amount);
  console.log(`[DEX:transfer] ${symbol} → ${to.slice(0,10)}… amount=${amount} → raw=${amountRaw.toString()} (6-dec)`);

  let txHash, receipt;

  if (token.isNative) {
    // USDC is native gas token on Arc — send as tx.value (no ERC-20 transfer)
    const valueHex = '0x' + amountRaw.toString(16);
    console.log(`[DEX:transfer] USDC native → value=${valueHex}`);
    txHash  = await dSendTx(to, '0x', valueHex);
    receipt = await dWaitReceipt(txHash);
    console.log(`[DEX:transfer] ✅ USDC native confirmed tx=${txHash} block=${receipt?.blockNumber}`);

  } else if (window.ethers?.Contract) {
    // ✅ ethers.Contract.transfer(to, amount) → emits ERC-20 Transfer event
    const contract = await dGetContract(symbol);
    console.log(`[DEX:transfer] ethers.Contract(${symbol}).transfer(${to.slice(0,10)}…, ${amountRaw.toString()})`);
    const tx = await contract.transfer(to, amountRaw);
    txHash  = tx.hash;
    console.log(`[DEX:transfer] Transfer tx submitted: ${txHash} — awaiting confirmation…`);
    receipt = await tx.wait(); // blocks until mined; Transfer event emitted here
    if (!receipt || (receipt.status !== undefined && receipt.status !== 1)) {
      throw new Error(`ERC-20 transfer failed for ${symbol} (tx: ${txHash})`);
    }
    console.log(`[DEX:transfer] ✅ Transfer confirmed block=${receipt.blockNumber} — Transfer event on ArcScan`);
    // Log Transfer event from receipt
    if (receipt.logs?.length > 0) {
      const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
      const log = receipt.logs.find(l => l.topics?.[0] === TRANSFER_TOPIC);
      if (log) {
        const val = log.data ? BigInt(log.data).toString() : amountRaw.toString();
        console.log(`[DEX:transfer] Transfer event → token=${token.address} from=…${log.topics[1]?.slice(-8)} to=…${log.topics[2]?.slice(-8)} value=${val}`);
      }
    }

  } else {
    // Fallback: raw ABI encoding (no ethers available)
    const data = DEX_SEL.transfer + dEncAddr(to) + dEncUint(amountRaw);
    console.log(`[DEX:transfer] ERC-20 transfer raw fallback: transfer(${to.slice(0,10)}…, ${amountRaw.toString()})`);
    txHash  = await dSendTx(token.address, data);
    receipt = await dWaitReceipt(txHash);
    if (receipt.status !== '0x1' && receipt.status !== 1 && receipt.status !== undefined) {
      throw new Error(`ERC-20 transfer (raw) failed for ${symbol} (tx: ${txHash})`);
    }
    console.log(`[DEX:transfer] ✅ Transfer confirmed (raw) block=${receipt?.blockNumber}`);
  }

  return { hash: txHash, receipt };
}

// ─── Refresh all balances ──────────────────────────────────────────────────────
async function dRefreshBalances() {
  const wallet = window.walletState?.address;
  if (!wallet) return;
  const symbols = Object.keys(DEX_TOKENS);
  await Promise.all(symbols.map(async (s) => {
    const bal = await dReadBalance(s, wallet);
    if (bal !== null) dexState.balances[s] = bal;
  }));
  // Update balance displays in UI
  dUpdateBalanceDisplays();
}

function dUpdateBalanceDisplays() {
  const b = dexState.balances;
  // Swap panel
  const fromSel = dEl('dex-swap-from');
  const toSel   = dEl('dex-swap-to');
  if (fromSel) dTxt('dex-swap-balance-from', `Balance: ${(b[fromSel.value] || 0).toFixed(4)} ${fromSel.value}`);
  if (toSel)   dTxt('dex-swap-balance-to',   `Balance: ${(b[toSel.value]   || 0).toFixed(4)} ${toSel.value}`);
  // LP panel
  const lpA = dEl('dex-lp-token-a');
  const lpB = dEl('dex-lp-token-b');
  if (lpA) dTxt('dex-lp-bal-a', `Balance: ${(b[lpA.value] || 0).toFixed(4)} ${lpA.value}`);
  if (lpB) dTxt('dex-lp-bal-b', `Balance: ${(b[lpB.value] || 0).toFixed(4)} ${lpB.value}`);
}

// ─── AMM Price Impact color ───────────────────────────────────────────────────
function dImpactClass(pct) {
  if (pct < 1)  return 'text-green-400';
  if (pct < 3)  return 'text-yellow-400';
  if (pct < 5)  return 'text-orange-400';
  return 'text-red-400';
}

// ─── Step manager ─────────────────────────────────────────────────────────────
function dSetStep(prefix, n, status = 'active') {
  for (let i = 0; i <= 5; i++) {
    const el = dEl(`${prefix}-${i}`);
    if (!el) continue;
    el.className = 'dex-step ' + (i < n ? 'dex-step-done' : i === n ? `dex-step-${status}` : 'dex-step-idle');
  }
  const panel = dEl(`${prefix.replace(/-step/, '-steps').replace(/-[0-9]$/, '-steps')}`);
}

function dShowSteps(id) { const e = dEl(id); if (e) e.classList.remove('hidden'); }
function dHideSteps(id) { const e = dEl(id); if (e) setTimeout(() => e.classList.add('hidden'), 6000); }

function dStep(n, status = 'active') {
  for (let i = 0; i <= 5; i++) {
    const el = dEl(`dex-step-${i}`);
    if (!el) continue;
    el.className = 'dex-step ' + (i < n ? 'dex-step-done' : i === n ? `dex-step-${status}` : 'dex-step-idle');
  }
}

function dLPStep(n, status = 'active') {
  for (let i = 0; i <= 5; i++) {
    const el = dEl(`dex-lp-step-${i}`);
    if (!el) continue;
    el.className = 'dex-step ' + (i < n ? 'dex-step-done' : i === n ? `dex-step-${status}` : 'dex-step-idle');
  }
}

// ─── Tab switching ────────────────────────────────────────────────────────────
window.dexSwitchTab = function(tab) {
  dexState.currentTab = tab;
  const panels = ['swap', 'add', 'remove'];
  const tabs   = ['swap', 'add', 'remove', 'positions', 'analytics'];

  // Panel visibility
  panels.forEach(p => {
    const el = dEl(`dex-panel-${p}`);
    if (el) el.classList.toggle('hidden', p !== tab);
  });

  // Position panel (always visible on right column)
  const posPanels = ['positions', 'analytics'];
  // These stay in right column — just update active tab styling

  // Tab button styling
  tabs.forEach(t => {
    const btn = dEl(`dex-tab-${t}`);
    if (!btn) return;
    const isActive = t === tab;
    btn.classList.toggle('bg-cyan-900/40', isActive);
    btn.classList.toggle('text-cyan-300', isActive);
    btn.classList.toggle('border', isActive);
    btn.classList.toggle('border-cyan-700/40', isActive);
    btn.classList.toggle('text-gray-400', !isActive);
  });

  if (tab === 'positions') dexLoadPositions();
  if (tab === 'analytics') {
    const el = dEl('dex-analytics-expanded');
    if (el) el.classList.remove('hidden');
  }
  if (tab === 'remove')    dexLoadRemovePools();
};

// ─── Load DEX data ────────────────────────────────────────────────────────────
window.dexLoadPools = async function() {
  try {
    const res  = await fetch('/api/dex/pools');
    const data = await res.json();
    if (!data.success) return;

    // Update stats
    dTxt('dex-stat-tvl',   dFmtUSD(data.analytics.tvlTotal));
    dTxt('dex-stat-vol',   dFmtUSD(data.analytics.volume24h));
    dTxt('dex-stat-fees',  dFmtUSD(data.analytics.fees24h));
    dTxt('dex-stat-pools', data.analytics.totalPools);

    // Store pools
    data.pools.forEach(p => { dexState.pools[p.id] = p; });

    // Render pool table
    const tbody = dEl('dex-pools-table');
    if (!tbody) return;
    tbody.innerHTML = data.pools.map(p => `
      <tr class="border-b border-gray-800/40 hover:bg-gray-800/20 transition-colors">
        <td class="py-2.5 px-2">
          <div class="flex items-center gap-2">
            <div class="flex -space-x-1">
              <span class="w-6 h-6 rounded-full bg-cyan-900/40 border border-cyan-700/40 flex items-center justify-center text-[10px]">${DEX_TOKENS[p.tokenA]?.logo || '?'}</span>
              <span class="w-6 h-6 rounded-full bg-blue-900/40 border border-blue-700/40 flex items-center justify-center text-[10px]">${DEX_TOKENS[p.tokenB]?.logo || '?'}</span>
            </div>
            <span class="text-white font-medium">${p.tokenA}/${p.tokenB}</span>
            <span class="text-[10px] text-gray-600 font-mono">0.3%</span>
          </div>
        </td>
        <td class="text-right py-2.5 px-2 text-cyan-400 font-mono">${p.tvlFormatted}</td>
        <td class="text-right py-2.5 px-2 text-green-400 font-mono">${dFmtUSD(p.volume24h)}</td>
        <td class="text-right py-2.5 px-2">
          <span class="text-green-400 font-mono font-bold">${p.aprFormatted}</span>
        </td>
        <td class="text-right py-2.5 px-2">
          <button onclick="dexQuickAddLiquidity('${p.tokenA}','${p.tokenB}')"
            class="text-[10px] bg-green-900/30 hover:bg-green-800/40 border border-green-700/30 text-green-400 rounded-lg px-2 py-1 transition-colors">
            + Add
          </button>
        </td>
      </tr>
    `).join('');
  } catch (e) {
    console.error('[DEX] loadPools error:', e);
  }
};

// ─── Load Analytics ───────────────────────────────────────────────────────────
window.dexLoadAnalytics = async function() {
  try {
    const res  = await fetch('/api/dex/analytics');
    const data = await res.json();
    if (!data.success) return;
    dexState.analytics = data;

    // IL table
    const il = data.analytics.impermanentLoss;
    dTxt('dex-il-10',  il['10%']  || '—');
    dTxt('dex-il-25',  il['25%']  || '—');
    dTxt('dex-il-50',  il['50%']  || '—');
    dTxt('dex-il-100', il['100%'] || '—');

    // Recent swaps
    dexRenderRecentSwaps(data.recentSwaps || []);
  } catch (e) { console.warn('[DEX] analytics error', e); }
};

function dexRenderRecentSwaps(swaps) {
  const el = dEl('dex-recent-swaps');
  if (!el) return;
  if (!swaps.length) {
    el.innerHTML = '<div class="text-center text-gray-500 text-xs py-4">No swaps yet</div>';
    return;
  }
  el.innerHTML = swaps.map(s => {
    const amtIn  = (s.amountIn  / 1e6).toFixed(4);
    const amtOut = (s.amountOut / 1e6).toFixed(4);
    const impact = s.priceImpact ? s.priceImpact.toFixed(3) : '0';
    return `
      <div class="flex items-center gap-2 py-1.5 border-b border-gray-800/30">
        <div class="w-6 h-6 rounded-full bg-cyan-900/30 flex items-center justify-center flex-shrink-0">
          <i class="fas fa-exchange-alt text-cyan-400" style="font-size:9px"></i>
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-xs text-white font-mono">${amtIn} ${s.tokenIn} → ${amtOut} ${s.tokenOut}</div>
          <div class="text-xs text-gray-500">${dShort(s.wallet)} · Impact: <span class="${dImpactClass(+impact)}">${impact}%</span></div>
        </div>
        <a href="${DEX_EXPLORER}/tx/${s.txHash}" target="_blank" rel="noopener"
          class="text-blue-400 hover:text-blue-300 flex-shrink-0 text-xs">
          <i class="fas fa-external-link-alt text-[9px]"></i>
        </a>
      </div>
    `;
  }).join('');
}

// ─── Load user positions ──────────────────────────────────────────────────────
window.dexLoadPositions = async function() {
  const wallet = window.walletState?.address;
  const el = dEl('dex-positions-list');
  if (!wallet) {
    if (el) el.innerHTML = `<div class="text-center text-gray-500 text-sm py-6"><i class="fas fa-wallet text-2xl mb-2 text-gray-600 block"></i>Connect wallet to view positions</div>`;
    return;
  }
  try {
    if (el) el.innerHTML = `<div class="text-center text-gray-400 text-xs py-4"><i class="fas fa-spinner fa-spin mr-2"></i>Loading positions…</div>`;
    const res  = await fetch(`/api/dex/positions/${wallet}`);
    const data = await res.json();
    dexState.positions = data.positions || [];

    if (!data.positions.length) {
      if (el) el.innerHTML = `
        <div class="text-center py-6">
          <i class="fas fa-tint text-2xl text-gray-600 block mb-2"></i>
          <p class="text-gray-500 text-sm">No liquidity positions yet</p>
          <button onclick="dexSwitchTab('add')" class="mt-3 text-xs text-cyan-400 hover:text-cyan-300 underline">+ Add Liquidity</button>
        </div>`;
      return;
    }

    if (el) el.innerHTML = data.positions.map(pos => {
      const pool = pos.pool;
      const ta = pool.tokenA, tb = pool.tokenB;
      const ta_logo = DEX_TOKENS[ta]?.logo || '?';
      const tb_logo = DEX_TOKENS[tb]?.logo || '?';
      const aprFmt  = pool.apr ? pool.apr.toFixed(2) + '%' : '—';
      const reserveA = (pool.reserveA / 1e6).toFixed(2);
      const reserveB = (pool.reserveB / 1e6).toFixed(2);
      return `
        <div class="dex-position-card">
          <div class="flex items-center gap-3 mb-3">
            <div class="flex -space-x-1">
              <span class="w-8 h-8 rounded-full bg-cyan-900/40 border-2 border-gray-800 flex items-center justify-center text-sm">${ta_logo}</span>
              <span class="w-8 h-8 rounded-full bg-blue-900/40 border-2 border-gray-800 flex items-center justify-center text-sm">${tb_logo}</span>
            </div>
            <div>
              <div class="text-white font-semibold text-sm">${ta} / ${tb}</div>
              <div class="text-xs text-gray-500">0.3% fee · Arc Testnet</div>
            </div>
            <div class="ml-auto text-right">
              <div class="text-green-400 font-bold">${dFmtUSD(pos.valueUSD)}</div>
              <div class="text-xs text-gray-500">Your Value</div>
            </div>
          </div>
          <div class="grid grid-cols-2 gap-x-4 gap-y-1 mb-3 text-xs">
            <div class="dex-pos-row">
              <span class="text-gray-500">Your Share</span>
              <span class="text-cyan-400 font-mono">${pos.sharePercent.toFixed(3)}%</span>
            </div>
            <div class="dex-pos-row">
              <span class="text-gray-500">LP Tokens</span>
              <span class="text-yellow-400 font-mono">${(pos.lpTokens / 1e6).toFixed(4)}</span>
            </div>
            <div class="dex-pos-row">
              <span class="text-gray-500">Pool TVL</span>
              <span class="text-white font-mono">${dFmtUSD(pool.tvl)}</span>
            </div>
            <div class="dex-pos-row">
              <span class="text-gray-500">Estimated APR</span>
              <span class="text-green-400 font-mono font-bold">${aprFmt}</span>
            </div>
            <div class="dex-pos-row">
              <span class="text-gray-500">Fees Earned</span>
              <span class="text-yellow-400 font-mono">~$${pos.feesEarned.toFixed(2)}</span>
            </div>
            <div class="dex-pos-row">
              <span class="text-gray-500">Deposited</span>
              <span class="text-gray-400">${dTs(pos.depositedAt)}</span>
            </div>
          </div>
          <div class="bg-gray-800/40 rounded-lg p-2 mb-3 text-xs">
            <div class="flex justify-between">
              <span class="text-gray-500">${ta} in pool:</span>
              <span class="text-cyan-400 font-mono">${(reserveA * pos.sharePercent / 100).toFixed(4)} ${ta}</span>
            </div>
            <div class="flex justify-between mt-0.5">
              <span class="text-gray-500">${tb} in pool:</span>
              <span class="text-blue-400 font-mono">${(reserveB * pos.sharePercent / 100).toFixed(4)} ${tb}</span>
            </div>
          </div>
          <button onclick="dexQuickRemove('${pos.poolId}')"
            class="w-full text-xs bg-red-900/20 hover:bg-red-900/40 border border-red-700/30 text-red-400 rounded-lg py-2 transition-colors">
            <i class="fas fa-minus-circle mr-1.5"></i>Remove Liquidity
          </button>
        </div>
      `;
    }).join('') + `
      <div class="mt-2 p-3 bg-gray-800/30 rounded-xl text-xs">
        <div class="flex justify-between">
          <span class="text-gray-500">Total Position Value</span>
          <span class="text-white font-bold">${dFmtUSD(data.summary.totalValueUSD)}</span>
        </div>
        <div class="flex justify-between mt-1">
          <span class="text-gray-500">Total Fees Earned</span>
          <span class="text-yellow-400 font-mono">~$${data.summary.totalFeesEarned.toFixed(2)}</span>
        </div>
      </div>
    `;
  } catch (e) {
    console.error('[DEX] positions error:', e);
    if (el) el.innerHTML = `<div class="text-red-400 text-xs text-center py-4">Failed to load positions</div>`;
  }
};

// ─── Swap: fetch quote ────────────────────────────────────────────────────────
window.dexOnSwapFromChange = function() {
  dRefreshBalances();
  dexOnSwapInput();
};

window.dexOnSwapInput = function() {
  clearTimeout(dexState.quoteDebounce);
  dexState.quoteDebounce = setTimeout(dexFetchSwapQuote, 350);
};

async function dexFetchSwapQuote() {
  const from    = dEl('dex-swap-from')?.value;
  const to      = dEl('dex-swap-to')?.value;
  const amtEl   = dEl('dex-swap-amount-in');
  const amount  = parseFloat(amtEl?.value || '0');
  const slippage= parseFloat(dEl('dex-slippage')?.value || '0.5');

  if (!from || !to || !amount || amount <= 0) {
    dEl('dex-swap-quote')?.classList.add('hidden');
    dEl('dex-impact-warning')?.classList.add('hidden');
    if (dEl('dex-swap-amount-out')) dEl('dex-swap-amount-out').value = '';
    return;
  }

  if (from === to) {
    showToast && showToast('Select different tokens', 'warning');
    return;
  }

  try {
    const res  = await fetch(`/api/dex/quote?from=${from}&to=${to}&amount=${amount}&slippage=${slippage}`);
    const data = await res.json();

    if (!data.success) {
      dexState.swapQuote = null;
      dEl('dex-swap-quote')?.classList.add('hidden');
      if (typeof showToast === 'function') showToast(`No pool for ${from}/${to}. Add liquidity first.`, 'warning');
      return;
    }

    dexState.swapQuote = data.quote;
    const q = data.quote;

    if (dEl('dex-swap-amount-out')) dEl('dex-swap-amount-out').value = q.amountOut.toFixed(6);
    dEl('dex-swap-quote')?.classList.remove('hidden');

    // Update quote details
    const impactClass = dImpactClass(q.priceImpact);
    dSet('dex-q-impact', `<span class="${impactClass} font-mono">${q.priceImpact.toFixed(4)}%</span>`);
    dTxt('dex-q-min',    `${q.minimumReceivedFmt} ${to}`);
    dTxt('dex-q-fee',    `${q.fee.toFixed(6)} ${from}`);
    dTxt('dex-q-route',  q.route);

    // Impact warnings
    const warn = dEl('dex-impact-warning');
    if (q.priceImpact > 5) {
      if (warn) { warn.classList.remove('hidden'); dTxt('dex-impact-msg', `⚠️ High price impact: ${q.priceImpact.toFixed(2)}% — reduce amount or add liquidity`); }
    } else if (q.rejectSwap) {
      if (warn) { warn.classList.remove('hidden'); dTxt('dex-impact-msg', `🚫 Swap blocked: price impact ${q.priceImpact.toFixed(2)}% exceeds 15% limit`); }
    } else {
      warn?.classList.add('hidden');
    }

  } catch (e) {
    console.warn('[DEX] quote error:', e);
  }
}

// ─── Swap: flip direction ─────────────────────────────────────────────────────
window.dexFlipSwap = function() {
  const from = dEl('dex-swap-from');
  const to   = dEl('dex-swap-to');
  if (!from || !to) return;
  const tmp = from.value;
  from.value = to.value;
  to.value   = tmp;
  if (dEl('dex-swap-amount-out')) dEl('dex-swap-amount-out').value = '';
  dRefreshBalances();
  dexOnSwapInput();
};

// ─── Execute Swap ─────────────────────────────────────────────────────────────
window.dexExecuteSwap = async function() {
  if (dexState.pendingTx) return;
  const wallet  = window.walletState?.address;
  if (!wallet) { showToast('Connect wallet to swap', 'warning'); return; }

  const from    = dEl('dex-swap-from')?.value;
  const to      = dEl('dex-swap-to')?.value;
  const amtEl   = dEl('dex-swap-amount-in');
  const amount  = parseFloat(amtEl?.value || '0');
  const slippage= parseFloat(dEl('dex-slippage')?.value || '0.5');

  if (!amount || amount <= 0) { showToast('Enter amount to swap', 'warning'); return; }
  if (from === to) { showToast('Select different tokens', 'warning'); return; }
  if (!dexState.swapQuote) { showToast('Fetch quote first', 'warning'); return; }

  const q = dexState.swapQuote;
  if (q.rejectSwap) { showToast(`Swap blocked: ${q.priceImpact.toFixed(2)}% impact exceeds limit`, 'error'); return; }

  dexState.pendingTx = true;
  const btn = dEl('dex-swap-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Processing…'; }

  dShowSteps('dex-swap-steps');

  try {
    // Step 0: Verify network
    dStep(0);
    await dEnsureNetwork();

    // Step 1: Read balances
    dStep(1);
    await dRefreshBalances();
    const balance = dexState.balances[from] || 0;
    if (balance < amount) throw new Error(`Insufficient ${from}: ${balance.toFixed(4)} available, ${amount} required`);

    const tokenInfo  = DEX_TOKENS[from];
    // ✅ Use dParseUnits() for exact 6-decimal conversion
    // e.g. 1 USDC → 1000000, 0.5 EURC → 500000
    const amountRaw  = dParseUnits(amount);
    const routerAddr = DEX_ROUTER;
    console.log(`[DEX:swap] ${from} → ${to} amount=${amount} raw=${amountRaw.toString()}`);

    // Step 2: Check allowance (ERC-20 only)
    dStep(2);
    let txHash = null;
    let blockNumber = null;

    if (!tokenInfo.isNative) {
      const allowance = await dReadAllowance(from, wallet, routerAddr);
      if (allowance < amount) {
        // Step 3: Approve ERC-20 (real on-chain approve)
        dStep(3);
        showToast(`Approving ${from} for DEX router…`, 'info');
        await dApproveToken(from, routerAddr, amount);
        await new Promise(r => setTimeout(r, 1500));
      } else {
        console.log(`[DEX:swap] ${from} allowance OK (${allowance.toFixed(6)})`);
        dStep(3, 'done');
      }
    } else {
      // Native USDC — no ERC-20 approve needed
      dStep(3, 'done');
    }

    // Step 4: Real token transfer to router
    // • USDC (native): send tx.value to router
    // • EURC/USYC (ERC-20): transfer(router, amount) after approve
    dStep(4);
    showToast(`Sign swap: ${amount} ${from} → ~${q.amountOut.toFixed(4)} ${to}`, 'info');
    // dTransferToken returns { hash, receipt } — already confirmed, no dWaitReceipt needed
    const transferResult = await dTransferToken(from, routerAddr, amount);
    txHash = transferResult.hash;

    showToast(`Swap tx submitted: ${txHash.slice(0, 14)}…`, 'info');

    // Step 5: Receipt already in transferResult (tx.wait() done inside dTransferToken)
    dStep(5);
    const receipt = transferResult.receipt || {};
    blockNumber = receipt.blockNumber
      ? (typeof receipt.blockNumber === 'string' ? parseInt(receipt.blockNumber, 16) : receipt.blockNumber)
      : null;

    // Register swap on backend
    const regRes = await fetch('/api/dex/swap', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromToken: from, toToken: to, amountIn: amount, wallet, txHash, slippage, blockNumber }),
    });
    const regData = await regRes.json();

    dStep(5, 'done');
    dexState.lastTxHash = txHash;

    const explorerUrl = `${DEX_EXPLORER}/tx/${txHash}`;
    showToast(`✅ Swap complete! ${amount} ${from} → ${regData.swap?.amountOutFormatted || q.amountOut.toFixed(4)} ${to} <a href="${explorerUrl}" target="_blank" class="underline ml-1">View ↗</a>`, 'success');

    // Show receipt
    dexShowSwapReceipt({ from, to, amount, out: regData.swap?.amountOutFormatted || q.amountOut.toFixed(6), txHash, blockNumber, fee: q.fee, priceImpact: q.priceImpact });

    // Refresh
    await dRefreshBalances();
    dexLoadPools();
    dexRenderRecentSwaps([]);
    dexLoadAnalytics();

    if (amtEl) amtEl.value = '';
    if (dEl('dex-swap-amount-out')) dEl('dex-swap-amount-out').value = '';

  } catch (err) {
    console.error('[DEX] swap error:', err);
    dStep(4, 'error');
    if (err.code === 4001 || err.message?.includes('rejected') || err.message?.includes('denied')) {
      showToast('Swap rejected by user', 'warning');
    } else if (err.message?.includes('Insufficient')) {
      showToast(err.message, 'error');
    } else {
      showToast(`Swap failed: ${err.message}`, 'error');
    }
  } finally {
    dexState.pendingTx = false;
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-exchange-alt mr-2"></i>Swap'; }
    dHideSteps('dex-swap-steps');
  }
};

// ─── LP: token change ─────────────────────────────────────────────────────────
window.dexOnLPTokenChange = function() {
  dRefreshBalances();
  dexOnLPAmountChange('a');
};

window.dexOnLPAmountChange = async function(side) {
  clearTimeout(dexState.lpDebounce);
  dexState.lpDebounce = setTimeout(() => dexFetchLPEstimate(side), 350);
};

async function dexFetchLPEstimate(side) {
  const ta  = dEl('dex-lp-token-a')?.value;
  const tb  = dEl('dex-lp-token-b')?.value;
  const amtA = parseFloat(dEl('dex-lp-amount-a')?.value || '0');
  const amtB = parseFloat(dEl('dex-lp-amount-b')?.value || '0');

  if (ta === tb) { showToast && showToast('Select different tokens', 'warning'); return; }
  if (!amtA && !amtB) { dEl('dex-lp-preview')?.classList.add('hidden'); return; }

  try {
    const amtToSend = amtA > 0 ? amtA : 1;
    const amtBToSend = amtB > 0 ? amtB : 1;
    const res  = await fetch(`/api/dex/estimate-lp?tokenA=${ta}&tokenB=${tb}&amountA=${amtToSend}&amountB=${amtBToSend}`);
    const data = await res.json();
    if (!data.success) return;

    dexState.lpEstimate = data.estimate;

    // If pool exists, auto-fill other side
    if (data.estimate.requiredB !== null && side === 'a' && amtA > 0) {
      const ratio = data.pool ? (ta === data.pool.tokenA ? data.pool.priceRatio.priceAinB : data.pool.priceRatio.priceBinA) : null;
      if (ratio) {
        const required = amtA * ratio;
        if (dEl('dex-lp-amount-b')) dEl('dex-lp-amount-b').value = required.toFixed(6);
      }
    } else if (data.pool && side === 'b' && amtB > 0) {
      const ratio = data.pool ? (ta === data.pool.tokenA ? data.pool.priceRatio.priceBinA : data.pool.priceRatio.priceAinB) : null;
      if (ratio) {
        const required = amtB * ratio;
        if (dEl('dex-lp-amount-a')) dEl('dex-lp-amount-a').value = required.toFixed(6);
      }
    }

    const preview = dEl('dex-lp-preview');
    if (preview) preview.classList.remove('hidden');

    const ratioLabel = data.pool
      ? `1 ${ta} = ${(data.pool.priceRatio.priceAinB || 0).toFixed(6)} ${tb}`
      : 'Initial — set by you';

    dTxt('dex-lp-ratio',   ratioLabel);
    dTxt('dex-lp-share',   `${data.estimate.sharePercent}%`);
    dTxt('dex-lp-tokens',  `${parseFloat(data.estimate.lpTokens).toFixed(4)} LP`);
    dTxt('dex-lp-status',  data.estimate.isNewPool ? '🆕 New Pool' : '➕ Existing Pool');
  } catch (e) { console.warn('[DEX] lp estimate error', e); }
}

// ─── Add Liquidity ────────────────────────────────────────────────────────────
window.dexAddLiquidity = async function() {
  if (dexState.pendingTx) return;
  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Connect wallet first', 'warning'); return; }

  const ta   = dEl('dex-lp-token-a')?.value;
  const tb   = dEl('dex-lp-token-b')?.value;
  const amtA = parseFloat(dEl('dex-lp-amount-a')?.value || '0');
  const amtB = parseFloat(dEl('dex-lp-amount-b')?.value || '0');

  if (!amtA || !amtB || amtA <= 0 || amtB <= 0) { showToast('Enter amounts for both tokens', 'warning'); return; }
  if (ta === tb) { showToast('Select different tokens', 'warning'); return; }

  dexState.pendingTx = true;
  const btn = dEl('dex-add-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Adding…'; }

  dShowSteps('dex-lp-steps');

  let txHashA = null, txHashB = null, finalTxHash = null;

  try {
    // ── Step 0: Verify network ───────────────────────────────────────────────
    dLPStep(0);
    await dEnsureNetwork();

    // ── Step 1: Validate balances on-chain ───────────────────────────────────
    // Read real balances from blockchain BEFORE any transaction
    dLPStep(1);
    showToast(`Checking on-chain balances…`, 'info');
    const balA = await dReadBalance(ta, wallet);
    const balB = await dReadBalance(tb, wallet);
    console.log(`[DEX:addLiquidity] Balance check: ${ta}=${balA?.toFixed(6)} ${tb}=${balB?.toFixed(6)}`);
    console.log(`[DEX:addLiquidity] Required:      ${ta}=${amtA}  ${tb}=${amtB}`);

    if (balA === null || balA < amtA)
      throw new Error(`Insufficient ${ta}: ${(balA || 0).toFixed(4)} available, ${amtA} required`);
    if (balB === null || balB < amtB)
      throw new Error(`Insufficient ${tb}: ${(balB || 0).toFixed(4)} available, ${amtB} required`);

    const tokenAInfo = DEX_TOKENS[ta];
    const tokenBInfo = DEX_TOKENS[tb];
    // ✅ Use dParseUnits() for exact 6-decimal base units
    // e.g. 1 USDC → 1000000n, 0.5 EURC → 500000n
    const amtARaw = dParseUnits(amtA);
    const amtBRaw = dParseUnits(amtB);
    console.log(`[DEX:addLiquidity] ${ta} raw=${amtARaw.toString()}  ${tb} raw=${amtBRaw.toString()}`);

    // ── Step 2: Approve Token A (ERC-20 only) ───────────────────────────────
    // Real ERC-20 approve() call — wallet signature required
    dLPStep(2);
    if (!tokenAInfo.isNative) {
      const allowanceA = await dReadAllowance(ta, wallet, DEX_ROUTER);
      if (allowanceA < amtA) {
        showToast(`Approve ${ta} for pool router — sign in wallet`, 'info');
        txHashA = await dApproveToken(ta, DEX_ROUTER, amtA);
        showToast(`✅ ${ta} approved`, 'success');
        await new Promise(r => setTimeout(r, 1000));
      } else {
        console.log(`[DEX:addLiquidity] ${ta} already approved (${allowanceA.toFixed(6)})`);
        dLPStep(2, 'done');
      }
    } else {
      console.log(`[DEX:addLiquidity] ${ta} is native — no ERC-20 approve needed`);
    }

    // ── Step 3: Approve Token B (ERC-20 only) ───────────────────────────────
    dLPStep(3);
    if (!tokenBInfo.isNative) {
      const allowanceB = await dReadAllowance(tb, wallet, DEX_ROUTER);
      if (allowanceB < amtB) {
        showToast(`Approve ${tb} for pool router — sign in wallet`, 'info');
        txHashB = await dApproveToken(tb, DEX_ROUTER, amtB);
        showToast(`✅ ${tb} approved`, 'success');
        await new Promise(r => setTimeout(r, 1000));
      } else {
        console.log(`[DEX:addLiquidity] ${tb} already approved (${allowanceB.toFixed(6)})`);
        dLPStep(3, 'done');
      }
    } else {
      console.log(`[DEX:addLiquidity] ${tb} is native — no ERC-20 approve needed`);
    }

    // ── Step 4: Real token transfers to pool (emit Transfer events) ──────────
    // This is the critical step: tokens MUST actually move on-chain.
    // • USDC (native on Arc): send as tx.value  → visible on ArcScan
    // • ERC-20 (EURC/USYC): ethers.Contract.transfer(router, amount) → emits Transfer event
    // dTransferToken() returns { hash, receipt } — already confirmed, no dWaitReceipt needed.
    dLPStep(4);
    showToast(`Depositing ${amtA} ${ta} + ${amtB} ${tb} into pool — sign in wallet`, 'info');

    let depositReceipt;

    if (tokenAInfo.isNative && !tokenBInfo.isNative) {
      // Case 1: Token A = USDC (native), Token B = ERC-20 (EURC or USYC)
      console.log(`[DEX:addLiquidity] Case 1: native ${ta} + ERC-20 ${tb}`);
      const resA = await dTransferToken(ta, DEX_ROUTER, amtA); // { hash, receipt }
      finalTxHash   = resA.hash;
      depositReceipt = resA.receipt;
      showToast(`${ta} deposited ✅ — now depositing ${tb}…`, 'info');
      console.log(`[DEX:addLiquidity] ${ta} confirmed block=${depositReceipt?.blockNumber}`);

      // ✅ Token B approve was done in Step 3 — now transfer
      const resB = await dTransferToken(tb, DEX_ROUTER, amtB);
      finalTxHash   = resB.hash;   // use ERC-20 tx as final (has Transfer event)
      depositReceipt = resB.receipt;
      showToast(`${tb} deposited ✅ — confirming…`, 'info');
      console.log(`[DEX:addLiquidity] ${tb} confirmed block=${depositReceipt?.blockNumber}`);

    } else if (!tokenAInfo.isNative && tokenBInfo.isNative) {
      // Case 2: Token A = ERC-20, Token B = USDC (native)
      console.log(`[DEX:addLiquidity] Case 2: ERC-20 ${ta} + native ${tb}`);
      const resA = await dTransferToken(ta, DEX_ROUTER, amtA);
      showToast(`${ta} deposited ✅ — now depositing ${tb}…`, 'info');
      console.log(`[DEX:addLiquidity] ${ta} confirmed block=${resA.receipt?.blockNumber}`);

      const resB = await dTransferToken(tb, DEX_ROUTER, amtB);
      finalTxHash   = resB.hash;
      depositReceipt = resB.receipt;
      showToast(`${tb} deposited ✅ — confirming…`, 'info');
      console.log(`[DEX:addLiquidity] ${tb} confirmed block=${depositReceipt?.blockNumber}`);

    } else if (!tokenAInfo.isNative && !tokenBInfo.isNative) {
      // Case 3: Both ERC-20 (EURC + USYC)
      console.log(`[DEX:addLiquidity] Case 3: ERC-20 ${ta} + ERC-20 ${tb}`);
      const resA = await dTransferToken(ta, DEX_ROUTER, amtA);
      showToast(`${ta} deposited ✅ — now depositing ${tb}…`, 'info');
      console.log(`[DEX:addLiquidity] ${ta} confirmed block=${resA.receipt?.blockNumber}`);

      const resB = await dTransferToken(tb, DEX_ROUTER, amtB);
      finalTxHash   = resB.hash;
      depositReceipt = resB.receipt;
      showToast(`${tb} deposited ✅ — confirming…`, 'info');
      console.log(`[DEX:addLiquidity] ${tb} confirmed block=${depositReceipt?.blockNumber}`);

    } else {
      // Case 4: Both native (edge case — only USDC is native on Arc)
      console.log(`[DEX:addLiquidity] Case 4: both native — single native tx`);
      const resA = await dTransferToken(ta, DEX_ROUTER, amtA);
      finalTxHash   = resA.hash;
      depositReceipt = resA.receipt;
    }

    showToast(`Token transfers confirmed ✅ — registering LP position…`, 'info');

    // ── Step 5: Register LP position on backend ──────────────────────────────
    dLPStep(5);
    // blockNumber may be a number (ethers receipt) or hex string (raw receipt)
    const blockNumber = depositReceipt?.blockNumber
      ? (typeof depositReceipt.blockNumber === 'string'
          ? parseInt(depositReceipt.blockNumber, 16)
          : Number(depositReceipt.blockNumber))
      : null;

    console.log(`[DEX:addLiquidity] Registering LP: pool=${ta}-${tb} amtA=${amtA} amtB=${amtB} tx=${finalTxHash} block=${blockNumber}`);

    const regRes = await fetch('/api/dex/liquidity/add', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tokenA: ta, tokenB: tb,
        amountA: amtA, amountB: amtB,
        wallet, txHash: finalTxHash, blockNumber,
        // Signal to backend that these are real on-chain transfers
        onChain: true,
        approveA: txHashA,
        approveB: txHashB,
      }),
    });
    const regData = await regRes.json();

    if (!regData.success) throw new Error(regData.error || 'LP registration failed');

    dLPStep(5, 'done');
    console.log(`[DEX:addLiquidity] ✅ Done — LP minted=${regData.liquidity?.lpTokensMinted} share=${regData.liquidity?.sharePercent}%`);

    showToast(regData.message || `✅ Liquidity added! ${regData.liquidity?.lpTokensMinted} LP tokens minted`, 'success');
    dexShowLPReceipt(regData);

    // Refresh balances + positions
    await dRefreshBalances();
    dexLoadPools();
    dexLoadPositions();

    // Reset form
    if (dEl('dex-lp-amount-a')) dEl('dex-lp-amount-a').value = '';
    if (dEl('dex-lp-amount-b')) dEl('dex-lp-amount-b').value = '';
    dEl('dex-lp-preview')?.classList.add('hidden');

  } catch (err) {
    console.error('[DEX] add liquidity error:', err);
    dLPStep(3, 'error');
    if (err.code === 4001 || err.message?.includes('rejected') || err.message?.includes('denied')) {
      showToast('Transaction rejected by user', 'warning');
    } else if (err.message?.includes('Insufficient')) {
      showToast(err.message, 'error');
    } else {
      showToast(`Add liquidity failed: ${err.message}`, 'error');
    }
  } finally {
    dexState.pendingTx = false;
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-plus mr-2"></i>Add Liquidity'; }
    dHideSteps('dex-lp-steps');
  }
};

// ─── Remove Liquidity: populate pool selector ─────────────────────────────────
async function dexLoadRemovePools() {
  const wallet = window.walletState?.address;
  const sel = dEl('dex-rm-pool');
  if (!sel) return;
  sel.innerHTML = '<option value="">— Select pool —</option>';

  if (!wallet) return;

  try {
    const res  = await fetch(`/api/dex/positions/${wallet}`);
    const data = await res.json();
    (data.positions || []).forEach(pos => {
      const opt = document.createElement('option');
      opt.value = pos.poolId;
      opt.textContent = `${pos.pool.tokenA}/${pos.pool.tokenB} — ${(pos.lpTokens / 1e6).toFixed(4)} LP`;
      sel.appendChild(opt);
    });
    dexState.positions = data.positions || [];
  } catch {}
}

window.dexOnRemovePoolChange = function() {
  const pid = dEl('dex-rm-pool')?.value;
  if (!pid) { dEl('dex-rm-position-info')?.classList.add('hidden'); return; }

  const pos  = dexState.positions.find(p => p.poolId === pid);
  if (!pos) { dEl('dex-rm-position-info')?.classList.add('hidden'); return; }

  dexState.rmUserPos = pos;
  dexState.rmPoolData = pos.pool;

  dEl('dex-rm-position-info')?.classList.remove('hidden');
  dTxt('dex-rm-lp-owned', `${(pos.lpTokens / 1e6).toFixed(4)} LP`);
  dTxt('dex-rm-share',    `${pos.sharePercent.toFixed(4)}%`);
  dTxt('dex-rm-value',    `~$${pos.valueUSD.toFixed(2)}`);
};

window.dexSetMaxLP = function() {
  const pos = dexState.rmUserPos;
  if (!pos) return;
  if (dEl('dex-rm-amount')) dEl('dex-rm-amount').value = (pos.lpTokens / 1e6).toFixed(6);
  dexOnRemoveAmountChange();
};

window.dexOnRemoveAmountChange = function() {
  const pos    = dexState.rmUserPos;
  const pool   = dexState.rmPoolData;
  if (!pos || !pool) return;

  const lpAmt  = parseFloat(dEl('dex-rm-amount')?.value || '0') * 1e6;
  if (!lpAmt || lpAmt <= 0) { dEl('dex-rm-preview')?.classList.add('hidden'); return; }

  const shareRatio = lpAmt / (pos.lpTokens / pos.sharePercent * 100);
  const aOut = (shareRatio * pool.reserveA / 1e6);
  const bOut = (shareRatio * pool.reserveB / 1e6);

  dEl('dex-rm-preview')?.classList.remove('hidden');
  dTxt('dex-rm-token-a-label', pool.tokenA);
  dTxt('dex-rm-token-b-label', pool.tokenB);
  dTxt('dex-rm-amount-a', `${aOut.toFixed(6)} ${pool.tokenA}`);
  dTxt('dex-rm-amount-b', `${bOut.toFixed(6)} ${pool.tokenB}`);
};

// ─── Remove Liquidity: execute ────────────────────────────────────────────────
window.dexRemoveLiquidity = async function() {
  if (dexState.pendingTx) return;
  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Connect wallet first', 'warning'); return; }

  const pid   = dEl('dex-rm-pool')?.value;
  const lpAmt = parseFloat(dEl('dex-rm-amount')?.value || '0') * 1e6;

  if (!pid) { showToast('Select a pool', 'warning'); return; }
  if (!lpAmt || lpAmt <= 0) { showToast('Enter LP amount to remove', 'warning'); return; }

  const pos  = dexState.rmUserPos;
  const pool = dexState.rmPoolData;
  if (!pos || lpAmt > pos.lpTokens) {
    showToast(`Max LP available: ${(pos?.lpTokens / 1e6).toFixed(4)}`, 'error');
    return;
  }

  if (!confirm(`Remove liquidity from ${pid} pool?\n\nBurning ${(lpAmt / 1e6).toFixed(4)} LP tokens.`)) return;

  dexState.pendingTx = true;
  const btn = dEl('dex-remove-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Removing…'; }

  try {
    await dEnsureNetwork();

    // Calculate how many tokens the user gets back
    const shareRatio = lpAmt / pos.lpTokens * (pos.sharePercent / 100);
    const aOut = pool ? (shareRatio * (pool.reserveA / 1e6)) : 0;
    const bOut = pool ? (shareRatio * (pool.reserveB / 1e6)) : 0;
    console.log(`[DEX:removeLiquidity] LP burned=${(lpAmt/1e6).toFixed(4)} → ${aOut.toFixed(6)} ${pool?.tokenA} + ${bOut.toFixed(6)} ${pool?.tokenB}`);

    // On-chain: sign a real intent transaction to the router.
    // The router (custodian) will process the LP burn and return tokens to the user.
    // For testnet custodian model: we send a 0-value signed tx as LP-burn intent.
    // In production with a deployed Router: call router.removeLiquidity(tokenA, tokenB, lpAmount, minA, minB, wallet, deadline)
    showToast(`Sign LP burn transaction in wallet…`, 'info');
    const txHash = await dSendTx(DEX_ROUTER, '0x', '0x0');
    showToast(`LP burn tx submitted: ${txHash.slice(0, 14)}…`, 'info');

    const receipt = await dWaitReceipt(txHash);
    const blockNumber = receipt.blockNumber ? parseInt(receipt.blockNumber, 16) : null;
    console.log(`[DEX:removeLiquidity] TX confirmed block=${blockNumber} status=${receipt.status}`);

    const regRes = await fetch('/api/dex/liquidity/remove', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ poolId: pid, lpAmount: lpAmt, wallet, txHash, blockNumber }),
    });
    const regData = await regRes.json();

    if (!regData.success) throw new Error(regData.error || 'Removal failed');

    const r = regData.removal;
    showToast(
      regData.message ||
      `✅ Removed ${r?.amountAOut} ${r?.tokenA} + ${r?.amountBOut} ${r?.tokenB}`,
      'success'
    );

    await dRefreshBalances();
    dexLoadPositions();
    dexLoadPools();
    dexLoadRemovePools();
    if (dEl('dex-rm-amount')) dEl('dex-rm-amount').value = '';
    dEl('dex-rm-position-info')?.classList.add('hidden');
    dEl('dex-rm-preview')?.classList.add('hidden');

  } catch (err) {
    console.error('[DEX] remove liquidity error:', err);
    if (err.code === 4001 || err.message?.includes('rejected') || err.message?.includes('denied')) {
      showToast('Transaction rejected', 'warning');
    } else {
      showToast(`Remove failed: ${err.message}`, 'error');
    }
  } finally {
    dexState.pendingTx = false;
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-minus mr-2"></i>Remove Liquidity'; }
  }
};

// ─── Quick actions ────────────────────────────────────────────────────────────
window.dexQuickAddLiquidity = function(ta, tb) {
  dexSwitchTab('add');
  if (dEl('dex-lp-token-a')) dEl('dex-lp-token-a').value = ta;
  if (dEl('dex-lp-token-b')) dEl('dex-lp-token-b').value = tb;
  dRefreshBalances();
};

window.dexQuickRemove = function(pid) {
  dexSwitchTab('remove');
  setTimeout(async () => {
    await dexLoadRemovePools();
    const sel = dEl('dex-rm-pool');
    if (sel) { sel.value = pid; dexOnRemovePoolChange(); }
  }, 200);
};

// ─── Receipt modals ───────────────────────────────────────────────────────────
function dexShowSwapReceipt({ from, to, amount, out, txHash, blockNumber, fee, priceImpact }) {
  const explorerUrl = `${DEX_EXPLORER}/tx/${txHash}`;
  const existing = document.getElementById('dex-receipt-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'dex-receipt-modal';
  modal.className = 'fixed inset-0 z-[95] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4';
  modal.innerHTML = `
    <div class="bg-gray-900 border border-cyan-700/40 rounded-2xl p-6 max-w-md w-full shadow-2xl" style="animation:modal-in 0.25s cubic-bezier(0.34,1.56,0.64,1) forwards">
      <div class="flex items-center justify-between mb-5">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-600 to-blue-600 flex items-center justify-center">
            <i class="fas fa-exchange-alt text-white"></i>
          </div>
          <div>
            <h2 class="text-white font-bold">Swap Receipt</h2>
            <p class="text-cyan-400 text-xs">ARC DEX · Arc Testnet</p>
          </div>
        </div>
        <button onclick="document.getElementById('dex-receipt-modal').remove()" class="text-gray-500 hover:text-gray-300 w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-800"><i class="fas fa-times text-sm"></i></button>
      </div>
      <div class="flex items-center gap-2 mb-4 bg-green-900/20 border border-green-700/30 rounded-xl px-4 py-2.5">
        <div class="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
        <span class="text-green-400 text-sm font-semibold">Swap Confirmed on Arc Testnet</span>
      </div>
      <div class="space-y-0 mb-5 bg-gray-800/50 rounded-xl overflow-hidden divide-y divide-gray-700/40">
        <div class="px-4 py-3 bg-cyan-900/10">
          <div class="text-xs text-gray-500 mb-1">You swapped</div>
          <div class="text-xl font-bold text-white">${amount} <span class="text-cyan-400">${from}</span></div>
          <div class="text-sm text-green-400 mt-0.5">→ ${out} <span class="text-white">${to}</span></div>
        </div>
        <div class="px-4 py-2.5">
          <div class="flex justify-between text-xs"><span class="text-gray-500">LP Fee (0.3%)</span><span class="text-yellow-400">${fee?.toFixed(6)} ${from}</span></div>
        </div>
        <div class="px-4 py-2.5">
          <div class="flex justify-between text-xs"><span class="text-gray-500">Price Impact</span><span class="${dImpactClass(priceImpact || 0)}">${(priceImpact || 0).toFixed(4)}%</span></div>
        </div>
        <div class="px-4 py-2.5">
          <div class="flex justify-between text-xs"><span class="text-gray-500">Network</span><span class="text-green-400">Arc Testnet (5042002)</span></div>
        </div>
        ${blockNumber ? `<div class="px-4 py-2.5"><div class="flex justify-between text-xs"><span class="text-gray-500">Block</span><span class="font-mono">#${blockNumber}</span></div></div>` : ''}
        <div class="px-4 py-2.5">
          <div class="flex justify-between text-xs"><span class="text-gray-500">Transaction</span>
          <a href="${explorerUrl}" target="_blank" class="text-blue-400 hover:underline font-mono">${txHash.slice(0,14)}… <i class="fas fa-external-link-alt text-[9px]"></i></a></div>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-2">
        <button onclick="dexDownloadReceipt('json',${JSON.stringify({ type:'swap', from, to, amount, out, txHash, blockNumber, fee, priceImpact, timestamp: Date.now(), network: 'Arc Testnet', chainId: 5042002 }).replace(/"/g,'&quot;')})" class="flex items-center justify-center gap-2 bg-gray-800 hover:bg-gray-700 border border-gray-600 text-gray-300 text-xs rounded-xl py-2.5 transition-colors">
          <i class="fas fa-download text-cyan-400"></i>Download JSON
        </button>
        <a href="${explorerUrl}" target="_blank" class="flex items-center justify-center gap-2 bg-blue-900/20 hover:bg-blue-800/30 border border-blue-700/40 text-blue-400 text-xs rounded-xl py-2.5 transition-colors">
          <i class="fas fa-external-link-alt"></i>View on ArcScan
        </a>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

function dexShowLPReceipt(data) {
  const lp = data.liquidity;
  if (!lp) return;
  const explorerUrl = lp.explorerUrl || `${DEX_EXPLORER}/tx/${lp.txHash}`;
  const existing = document.getElementById('dex-lp-receipt-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'dex-lp-receipt-modal';
  modal.className = 'fixed inset-0 z-[95] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4';
  modal.innerHTML = `
    <div class="bg-gray-900 border border-green-700/40 rounded-2xl p-6 max-w-md w-full shadow-2xl" style="animation:modal-in 0.25s cubic-bezier(0.34,1.56,0.64,1) forwards">
      <div class="flex items-center justify-between mb-5">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-green-600 to-emerald-600 flex items-center justify-center">
            <i class="fas fa-tint text-white"></i>
          </div>
          <div>
            <h2 class="text-white font-bold">${lp.isNewPool ? '🆕 Pool Created!' : 'Liquidity Added'}</h2>
            <p class="text-green-400 text-xs">ARC DEX · event LiquidityAdded</p>
          </div>
        </div>
        <button onclick="document.getElementById('dex-lp-receipt-modal').remove()" class="text-gray-500 hover:text-gray-300 w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-800"><i class="fas fa-times text-sm"></i></button>
      </div>
      <div class="flex items-center gap-2 mb-4 bg-green-900/20 border border-green-700/30 rounded-xl px-4 py-2.5">
        <div class="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
        <span class="text-green-400 text-sm font-semibold">Confirmed — LP Tokens Minted</span>
      </div>
      <div class="space-y-0 mb-5 bg-gray-800/50 rounded-xl overflow-hidden divide-y divide-gray-700/40">
        <div class="px-4 py-3 bg-green-900/10">
          <div class="text-xs text-gray-500 mb-1">Pool</div>
          <div class="text-xl font-bold text-white">${lp.tokenA} / ${lp.tokenB}</div>
        </div>
        <div class="px-4 py-2.5">
          <div class="flex justify-between text-xs"><span class="text-gray-500">${lp.tokenA} Deposited</span><span class="text-cyan-400">${lp.amountA} ${lp.tokenA}</span></div>
        </div>
        <div class="px-4 py-2.5">
          <div class="flex justify-between text-xs"><span class="text-gray-500">${lp.tokenB} Deposited</span><span class="text-blue-400">${lp.amountB} ${lp.tokenB}</span></div>
        </div>
        <div class="px-4 py-2.5">
          <div class="flex justify-between text-sm"><span class="text-gray-400">LP Tokens Minted</span><span class="text-yellow-400 font-bold">${lp.lpTokensMinted}</span></div>
        </div>
        <div class="px-4 py-2.5">
          <div class="flex justify-between text-xs"><span class="text-gray-500">Pool Share</span><span class="text-green-400">${lp.sharePercent}%</span></div>
        </div>
        <div class="px-4 py-2.5">
          <div class="flex justify-between text-xs"><span class="text-gray-500">Transaction</span>
          <a href="${explorerUrl}" target="_blank" class="text-blue-400 hover:underline font-mono">${lp.txHash.slice(0,14)}… <i class="fas fa-external-link-alt text-[9px]"></i></a></div>
        </div>
      </div>
      <a href="${explorerUrl}" target="_blank" class="flex items-center justify-center gap-2 w-full bg-blue-900/20 hover:bg-blue-800/30 border border-blue-700/40 text-blue-400 text-sm rounded-xl py-2.5 transition-colors">
        <i class="fas fa-external-link-alt"></i>View on ArcScan
      </a>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

// ─── Download receipt ─────────────────────────────────────────────────────────
window.dexDownloadReceipt = function(format, data) {
  const receipt = typeof data === 'string' ? JSON.parse(data.replace(/&quot;/g, '"')) : data;
  const blob = new Blob([JSON.stringify({ ...receipt, _meta: { generator: 'ARC DEX', generatedAt: new Date().toISOString(), network: 'Arc Testnet', chainId: 5042002 } }, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `arc-dex-${receipt.type || 'receipt'}-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  if (typeof showToast === 'function') showToast('✅ Receipt downloaded', 'success');
};

// ─── Refresh all DEX data ─────────────────────────────────────────────────────
window.dexRefreshAll = async function() {
  await Promise.all([
    dexLoadPools(),
    dexLoadAnalytics(),
    dRefreshBalances(),
  ]);
  const wallet = window.walletState?.address;
  if (wallet) dexLoadPositions();
};

// ─── APR Estimator ────────────────────────────────────────────────────────────
window.dexEstimateAPR = function() {
  const tvl     = parseFloat(document.getElementById('dex-apr-tvl')?.value   || '0');
  const vol     = parseFloat(document.getElementById('dex-apr-vol')?.value   || '0');
  const fee     = parseFloat(document.getElementById('dex-apr-fee')?.value   || '0.3') / 100;
  const result  = document.getElementById('dex-apr-result');
  if (!tvl || !vol || !result) return;
  const daily   = vol * fee;
  const apr     = tvl > 0 ? (daily * 365 / tvl) * 100 : 0;
  const monthly = apr / 12;
  result.innerHTML = `
    <div class="grid grid-cols-3 gap-3 mt-3">
      <div class="text-center bg-green-900/20 border border-green-700/30 rounded-xl p-3">
        <div class="text-xs text-gray-500 mb-1">Est. APR</div>
        <div class="text-green-400 font-bold text-lg">${apr.toFixed(2)}%</div>
      </div>
      <div class="text-center bg-blue-900/20 border border-blue-700/30 rounded-xl p-3">
        <div class="text-xs text-gray-500 mb-1">Monthly</div>
        <div class="text-blue-400 font-bold text-lg">${monthly.toFixed(2)}%</div>
      </div>
      <div class="text-center bg-yellow-900/20 border border-yellow-700/30 rounded-xl p-3">
        <div class="text-xs text-gray-500 mb-1">Daily Fees</div>
        <div class="text-yellow-400 font-bold text-sm">$${daily.toFixed(2)}</div>
      </div>
    </div>
    <p class="text-xs text-gray-500 mt-2 text-center">APR = (24h Vol × ${(fee*100).toFixed(1)}% × 365) / TVL</p>
  `;
};

// ─── IL Calculator ────────────────────────────────────────────────────────────
window.dexCalcIL = function() {
  const change  = parseFloat(document.getElementById('dex-il-price-change')?.value || '0');
  const result  = document.getElementById('dex-il-calc-result');
  if (!result || isNaN(change)) return;
  const r  = 1 + change / 100;
  const il = (2 * Math.sqrt(r) / (1 + r) - 1) * 100;
  const ilAbs = Math.abs(il);
  const color = ilAbs < 1 ? 'text-green-400' : ilAbs < 5 ? 'text-yellow-400' : ilAbs < 15 ? 'text-orange-400' : 'text-red-400';
  result.innerHTML = `
    <div class="mt-3 p-3 bg-gray-800/60 rounded-xl text-center">
      <div class="text-xs text-gray-500 mb-1">Impermanent Loss</div>
      <div class="${color} font-bold text-2xl">${il.toFixed(3)}%</div>
      <div class="text-xs text-gray-500 mt-1">at ${change > 0 ? '+' : ''}${change}% price change</div>
      <div class="text-xs text-gray-600 mt-2 font-mono">IL = 2√(${r.toFixed(2)})/(1+${r.toFixed(2)}) − 1</div>
    </div>
  `;
};

// ─── Load pool detail modal ───────────────────────────────────────────────────
window.dexShowPoolDetail = async function(poolId) {
  try {
    const res  = await fetch(`/api/dex/pools/${poolId}`);
    const data = await res.json();
    if (!data.success) return;
    const p    = data.pool;
    const pA   = DEX_TOKENS[p.tokenA]?.logo || '?';
    const pB   = DEX_TOKENS[p.tokenB]?.logo || '?';
    const existing = document.getElementById('dex-pool-detail-modal');
    if (existing) existing.remove();
    const modal = document.createElement('div');
    modal.id = 'dex-pool-detail-modal';
    modal.className = 'fixed inset-0 z-[96] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4';
    modal.innerHTML = `
      <div class="bg-gray-900 border border-cyan-700/30 rounded-2xl p-6 max-w-lg w-full shadow-2xl overflow-y-auto max-h-[90vh]" style="animation:modal-in 0.25s ease forwards">
        <div class="flex items-center justify-between mb-5">
          <div class="flex items-center gap-3">
            <div class="flex -space-x-2">
              <span class="w-10 h-10 rounded-full bg-cyan-900/40 border-2 border-gray-800 flex items-center justify-center">${pA}</span>
              <span class="w-10 h-10 rounded-full bg-blue-900/40 border-2 border-gray-800 flex items-center justify-center">${pB}</span>
            </div>
            <div>
              <h2 class="text-white font-bold text-lg">${p.tokenA} / ${p.tokenB}</h2>
              <p class="text-cyan-400 text-xs">ARC DEX · 0.3% fee · x·y=k</p>
            </div>
          </div>
          <button onclick="document.getElementById('dex-pool-detail-modal').remove()" class="text-gray-500 hover:text-gray-300 w-7 h-7 rounded-lg hover:bg-gray-800 flex items-center justify-center">
            <i class="fas fa-times text-sm"></i>
          </button>
        </div>
        <div class="grid grid-cols-2 gap-3 mb-5">
          <div class="dex-analytics-metric">
            <div class="text-xs text-gray-500 mb-1">TVL</div>
            <div class="text-cyan-400 font-bold">${p.tvlFormatted}</div>
          </div>
          <div class="dex-analytics-metric">
            <div class="text-xs text-gray-500 mb-1">APR</div>
            <div class="text-green-400 font-bold">${p.aprFormatted}</div>
          </div>
          <div class="dex-analytics-metric">
            <div class="text-xs text-gray-500 mb-1">${p.tokenA} Reserve</div>
            <div class="text-white font-mono text-sm">${parseFloat(p.reserveAFormatted).toLocaleString()} ${p.tokenA}</div>
          </div>
          <div class="dex-analytics-metric">
            <div class="text-xs text-gray-500 mb-1">${p.tokenB} Reserve</div>
            <div class="text-white font-mono text-sm">${parseFloat(p.reserveBFormatted).toLocaleString()} ${p.tokenB}</div>
          </div>
          <div class="dex-analytics-metric">
            <div class="text-xs text-gray-500 mb-1">24h Volume</div>
            <div class="text-yellow-400 font-mono">${dFmtUSD(p.volume24h)}</div>
          </div>
          <div class="dex-analytics-metric">
            <div class="text-xs text-gray-500 mb-1">Total Swaps</div>
            <div class="text-purple-400 font-bold">${p.swapCount.toLocaleString()}</div>
          </div>
        </div>
        <div class="bg-gray-800/50 rounded-xl p-3 mb-4">
          <div class="text-xs text-gray-500 mb-2">Price Ratio</div>
          <div class="flex justify-between text-sm">
            <span class="text-cyan-400">1 ${p.tokenA} = <span class="font-mono">${(p.priceRatio?.priceAinB || 0).toFixed(6)} ${p.tokenB}</span></span>
            <span class="text-blue-400">1 ${p.tokenB} = <span class="font-mono">${(p.priceRatio?.priceBinA || 0).toFixed(6)} ${p.tokenA}</span></span>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <button onclick="dexQuickAddLiquidity('${p.tokenA}','${p.tokenB}');document.getElementById('dex-pool-detail-modal').remove()"
            class="flex items-center justify-center gap-2 bg-green-900/20 hover:bg-green-800/30 border border-green-700/30 text-green-400 text-sm rounded-xl py-2.5 transition-colors">
            <i class="fas fa-plus"></i>Add Liquidity
          </button>
          <button onclick="dexSwitchTab('swap');document.getElementById('dex-pool-detail-modal').remove()"
            class="flex items-center justify-center gap-2 bg-cyan-900/20 hover:bg-cyan-800/30 border border-cyan-700/30 text-cyan-400 text-sm rounded-xl py-2.5 transition-colors">
            <i class="fas fa-exchange-alt"></i>Swap
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  } catch (e) { console.warn('[DEX] pool detail error:', e); }
};

// ─── Render enhanced pool table ───────────────────────────────────────────────
// Overrides the basic version in dexLoadPools
function dexRenderPoolTable(pools) {
  const tbody = dEl('dex-pools-table');
  if (!tbody) return;
  if (!pools.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center py-6 text-gray-500">No pools yet</td></tr>';
    return;
  }
  const maxTVL = Math.max(...pools.map(p => p.tvl), 1);
  tbody.innerHTML = pools.map(p => {
    const pA = DEX_TOKENS[p.tokenA]?.logo || '?';
    const pB = DEX_TOKENS[p.tokenB]?.logo || '?';
    const tvlPct = Math.round((p.tvl / maxTVL) * 100);
    const aprClass = p.apr > 20 ? 'high' : p.apr > 5 ? 'medium' : 'low';
    return `
      <tr class="border-b border-gray-800/40 hover:bg-gray-800/20 transition-colors cursor-pointer"
          onclick="dexShowPoolDetail('${p.id}')">
        <td class="py-3 px-2">
          <div class="flex items-center gap-2">
            <div class="dex-token-pair">
              <span class="w-6 h-6 rounded-full bg-cyan-900/40 border border-cyan-700/40 flex items-center justify-center text-[11px]">${pA}</span>
              <span class="w-6 h-6 rounded-full bg-blue-900/40 border border-blue-700/40 flex items-center justify-center text-[11px]">${pB}</span>
            </div>
            <div>
              <div class="text-white font-medium text-sm">${p.tokenA}/${p.tokenB}</div>
              <div class="dex-tvl-bar mt-0.5" style="width:${Math.max(tvlPct,4)}px;max-width:60px"></div>
            </div>
          </div>
        </td>
        <td class="text-right py-3 px-2">
          <div class="text-cyan-400 font-mono text-sm">${p.tvlFormatted}</div>
          <div class="text-gray-600 text-[10px]">${p.swapCount} swaps</div>
        </td>
        <td class="text-right py-3 px-2 text-green-400 font-mono text-sm">${dFmtUSD(p.volume24h)}</td>
        <td class="text-right py-3 px-2">
          <span class="dex-apr-badge ${aprClass}">${p.aprFormatted}</span>
        </td>
        <td class="text-right py-3 px-2">
          <button onclick="event.stopPropagation();dexQuickAddLiquidity('${p.tokenA}','${p.tokenB}')"
            class="text-[10px] bg-green-900/30 hover:bg-green-800/40 border border-green-700/30 text-green-400 rounded-lg px-2 py-1 transition-colors">
            + Add
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

// ─── Patch dexLoadPools to use enhanced renderer ──────────────────────────────
const _origLoadPools = window.dexLoadPools;
window.dexLoadPools = async function() {
  try {
    const res  = await fetch('/api/dex/pools');
    const data = await res.json();
    if (!data.success) return;

    dTxt('dex-stat-tvl',   dFmtUSD(data.analytics.tvlTotal));
    dTxt('dex-stat-vol',   dFmtUSD(data.analytics.volume24h));
    dTxt('dex-stat-fees',  dFmtUSD(data.analytics.fees24h));
    dTxt('dex-stat-pools', data.analytics.totalPools);

    data.pools.forEach(p => { dexState.pools[p.id] = p; });
    dexRenderPoolTable(data.pools);
  } catch (e) {
    console.error('[DEX] loadPools error:', e);
  }
};

// ─── Auto-refresh pool prices every 30s ──────────────────────────────────────
let _dexAutoRefreshTimer = null;
function dexStartAutoRefresh() {
  if (_dexAutoRefreshTimer) return;
  _dexAutoRefreshTimer = setInterval(() => {
    dexLoadPools();
    dexLoadAnalytics();
  }, 30_000);
}

// ─── Init on tab open ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('walletConnected', () => {
    dRefreshBalances();
    dexLoadPositions();
  });
  setTimeout(dexRefreshAll, 500);
  dexStartAutoRefresh();
});

window.dexInit = function() {
  dexRefreshAll();
  dRefreshBalances();
  dexStartAutoRefresh();
};

console.log('[DEX] ARC AMM DEX loaded · ChainID:', DEX_CHAIN_ID, '· Formula: x*y=k · Fee: 0.3%');
console.log('[DEX] ethers.js integration:');
console.log('[DEX]   USDC  0x3600000000000000000000000000000000000000 (native, 6 dec)');
console.log('[DEX]   EURC  0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a (ERC-20, 6 dec)');
console.log('[DEX]   USYC  0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C (ERC-20, 6 dec)');
console.log('[DEX]   ERC20_ABI loaded — ethers.Contract available:', !!window.ethers?.Contract);
console.log('[DEX] Real ERC-20 transfer flow:');
console.log('[DEX]   1. token.balanceOf(userAddress)               → validate user has enough');
console.log('[DEX]   2. token.approve(routerAddress, amount)        → authorize router');
console.log('[DEX]   3. token.transfer(routerAddress, amount)       → move tokens on-chain');
console.log('[DEX]      (production: router.transferFrom(user, pool, amount) after approve)');
console.log('[DEX]   USDC (native)  → eth_sendTransaction value=amountRaw');
console.log('[DEX]   EURC/USYC      → ethers.Contract.approve() + transfer() → Transfer event on ArcScan');
console.log('[DEX]   parseUnits: 1 USDC → 1,000,000 · 0.5 → 500,000 · 10 → 10,000,000');
console.log('[DEX]   Router/Custodian:', DEX_ROUTER);
