// ============================================================
// ExecDaat — ArcBridge : reusable Cross-Chain service (CCTP V2)
// Architecture reused from the mature Elligentt bridge implementation
// (elligentt.xyz — same Cloudflare account, readable source), adapted to
// ExecDaat's patterns. It exposes a single reusable API (window.ArcBridge)
// consumed by the Advanced Cross-Chain Center and available to the AI Agent.
//
// Official Circle/Arc CCTP V2 (no custom bridge, no custom contracts):
//   • TokenMessengerV2.depositForBurn(amount, destDomain, mintRecipient,
//       burnToken, destinationCaller, maxFee, minFinalityThreshold)
//   • Circle Iris attestation API v2 (per-source-domain) + v1 fallback
//   • MessageTransmitterV2.receiveMessage(message, attestation)
// Docs: https://docs.arc.io/app-kit/bridge · https://developers.circle.com/cctp
// build: 20260703c-elligentt
// ============================================================
'use strict';

(function () {
  /* ── CCTP parameters (single source of truth — from Elligentt cctp.js) ── */
  const CFG = Object.freeze({
    ARC_DOMAIN:            26,
    IRIS_V2_URL:           'https://iris-api-sandbox.circle.com/v2/messages/',
    ATTEST_V1_URL:         'https://iris-api-sandbox.circle.com/attestations/',
    FEES_URL:              'https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/',
    FINALITY_FAST:         1000,
    FINALITY_STANDARD:     2000,
    MAX_FEE_TO_ARC_USDC:   '0.5',   // static FALLBACK only — inbound fees are quoted dynamically
    ATTEST_POLL_INTERVAL:  5000,
    ATTEST_POLL_MAX:       120,     // ~10 min (other routes)
    ATTEST_POLL_MAX_ARC:   180,     // ~15 min (legacy standard fallback)
    ATTEST_V1_FALLBACK_MAX: 60,
    // Inbound → Arc (Fast Transfer + Forwarding Service) — exponential backoff
    IN_POLL_BASE_MS:       2000,    // first poll delay
    IN_POLL_FACTOR:        1.5,     // exponential factor
    IN_POLL_CAP_MS:        15000,   // max delay between polls
    IN_POLL_BUDGET_MS:     12 * 60 * 1000, // total budget (fast attest is usually <1 min)
    IN_FORWARD_GRACE_MS:   120000,  // wait for forwardTxHash after attestation before self-mint fallback
    // Forwarding Service hook data ("cctp-forward" right-padded to 32 bytes)
    FORWARD_HOOK_DATA:     '0x636374702d666f72776172640000000000000000000000000000000000000000',
    PENDING_KEY:           'arcbridge_inbound_pending_v1',
  });

  // Official CCTP V2 contracts (identical across all supported testnets)
  const TOKEN_MESSENGER_V2  = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA';
  const MSG_TRANSMITTER_V2  = '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275';

  // Chain registry (keyed to match Advanced Cross-Chain's chain keys)
  const CHAINS = {
    arc: {
      key: 'arc', name: 'Arc Testnet', short: 'Arc', icon: '🟣',
      chainId: 5042002, chainHex: '0x4cef52', domain: 26,
      rpc: 'https://rpc.testnet.arc.network', explorer: 'https://testnet.arcscan.app',
      rpcAlternatives: [
        'https://rpc.blockdaemon.testnet.arc.network',
        'https://rpc.drpc.testnet.arc.network',
        'https://rpc.quicknode.testnet.arc.network',
      ],
      usdc: '0x3600000000000000000000000000000000000000',
      tokenMessenger: TOKEN_MESSENGER_V2, messageTransmitter: MSG_TRANSMITTER_V2,
      nativeSymbol: 'USDC', nativeDecimals: 18, isNative: true,
    },
    sepolia: {
      key: 'sepolia', name: 'Ethereum Sepolia', short: 'Sepolia', icon: '🔷',
      chainId: 11155111, chainHex: '0xaa36a7', domain: 0,
      rpc: 'https://ethereum-sepolia-rpc.publicnode.com', explorer: 'https://sepolia.etherscan.io',
      rpcAlternatives: ['https://sepolia.drpc.org', 'https://1rpc.io/sepolia'],
      usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      tokenMessenger: TOKEN_MESSENGER_V2, messageTransmitter: MSG_TRANSMITTER_V2,
      nativeSymbol: 'ETH', nativeDecimals: 18,
    },
    basesepolia: {
      key: 'basesepolia', name: 'Base Sepolia', short: 'Base Sep', icon: '🔵',
      chainId: 84532, chainHex: '0x14a34', domain: 6,
      rpc: 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org',
      rpcAlternatives: ['https://base-sepolia-rpc.publicnode.com', 'https://base-sepolia.drpc.org'],
      usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      tokenMessenger: TOKEN_MESSENGER_V2, messageTransmitter: MSG_TRANSMITTER_V2,
      nativeSymbol: 'ETH', nativeDecimals: 18,
    },
    arbsepolia: {
      key: 'arbsepolia', name: 'Arbitrum Sepolia', short: 'Arb Sep', icon: '🔵',
      chainId: 421614, chainHex: '0x66eee', domain: 3,
      rpc: 'https://sepolia-rollup.arbitrum.io/rpc', explorer: 'https://sepolia.arbiscan.io',
      rpcAlternatives: ['https://arbitrum-sepolia-rpc.publicnode.com', 'https://arbitrum-sepolia.drpc.org'],
      usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
      tokenMessenger: TOKEN_MESSENGER_V2, messageTransmitter: MSG_TRANSMITTER_V2,
      nativeSymbol: 'ETH', nativeDecimals: 18,
    },
    optsepolia: {
      key: 'optsepolia', name: 'OP Sepolia', short: 'OP Sep', icon: '🔴',
      chainId: 11155420, chainHex: '0xaa37dc', domain: 2,
      rpc: 'https://sepolia.optimism.io', explorer: 'https://sepolia-optimism.etherscan.io',
      rpcAlternatives: ['https://optimism-sepolia-rpc.publicnode.com', 'https://optimism-sepolia.drpc.org'],
      usdc: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7',
      tokenMessenger: TOKEN_MESSENGER_V2, messageTransmitter: MSG_TRANSMITTER_V2,
      nativeSymbol: 'ETH', nativeDecimals: 18,
    },
    polygonAmoy: {
      key: 'polygonAmoy', name: 'Polygon Amoy', short: 'Amoy', icon: '🟪',
      chainId: 80002, chainHex: '0x13882', domain: 7,
      rpc: 'https://rpc-amoy.polygon.technology', explorer: 'https://amoy.polygonscan.com',
      rpcAlternatives: ['https://polygon-amoy-bor-rpc.publicnode.com', 'https://polygon-amoy.drpc.org'],
      usdc: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
      tokenMessenger: TOKEN_MESSENGER_V2, messageTransmitter: MSG_TRANSMITTER_V2,
      nativeSymbol: 'POL', nativeDecimals: 18,
    },
  };

  const USDC_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
  ];
  const TOKEN_MESSENGER_ABI = [
    'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold) external returns (uint64 nonce)',
    'function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData) external returns (uint64 nonce)',
  ];
  const MSG_TRANSMITTER_ABI = [
    'function receiveMessage(bytes message, bytes attestation) returns (bool success)',
  ];
  const MESSAGE_SENT_ABI = ['event MessageSent(bytes message)'];

  /* ── Structured logging (toggle via window.ARC_BRIDGE_DEBUG=false) ── */
  function log(stage, msg, extra) {
    if (window.ARC_BRIDGE_DEBUG === false) return;
    var ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    if (extra !== undefined) console.log(`%c[ArcBridge ${ts}] ${stage}: ${msg}`, 'color:#a78bfa', extra);
    else console.log(`%c[ArcBridge ${ts}] ${stage}: ${msg}`, 'color:#a78bfa');
  }

  /* ── Helpers ────────────────────────────────────────────── */
  function _rawProvider() { return window.walletState?.provider || window.ethereum || null; }
  function _E() { if (!window.ethers) throw new Error('ethers.js not loaded'); return window.ethers; }

  function _browserProvider() {
    const raw = _rawProvider();
    if (!raw) throw new Error('No wallet provider available');
    return new (_E().BrowserProvider)(raw);
  }

  function _readProvider(chain) {
    // Arc reads go through the same-origin failover proxy (/api/rpc):
    // the public Arc RPC rate-limits per client IP ("request limit reached"),
    // which broke source-balance reads. The proxy fails over across 4 RPCs.
    if (chain.chainId === 5042002 && typeof window !== 'undefined' && window.location && window.location.origin.indexOf('http') === 0) {
      return new (_E().JsonRpcProvider)(window.location.origin + '/api/rpc');
    }
    // Optional dedicated-RPC override (recommended: Alchemy/QuickNode), e.g.
    //   window.ARC_BRIDGE_RPC_OVERRIDES = { sepolia: 'https://eth-sepolia.g.alchemy.com/v2/KEY' }
    const ov = (typeof window !== 'undefined' && window.ARC_BRIDGE_RPC_OVERRIDES) || {};
    if (ov[chain.key]) return new (_E().JsonRpcProvider)(ov[chain.key]);
    return new (_E().JsonRpcProvider)(chain.rpc);
  }

  // Read-only call with automatic failover across the chain's alternative RPCs.
  async function _readCall(chain, fn) {
    const ov = (typeof window !== 'undefined' && window.ARC_BRIDGE_RPC_OVERRIDES) || {};
    const urls = [];
    if (chain.chainId === 5042002) return fn(_readProvider(chain)); // Arc: proxy already fails over
    if (ov[chain.key]) urls.push(ov[chain.key]);
    urls.push(chain.rpc);
    (chain.rpcAlternatives || []).forEach((u) => urls.push(u));
    let lastErr = null;
    for (const url of urls) {
      try { return await fn(new (_E().JsonRpcProvider)(url)); }
      catch (e) { lastErr = e; log('rpc', 'read failover ' + chain.key + ' via ' + url + ' failed: ' + (e && e.message)); }
    }
    throw lastErr || new Error('All RPCs failed for ' + chain.key);
  }

  function _toUsdc(amountStr) { return _E().parseUnits(String(amountStr), 6); }

  function _decodeError(err) {
    const msg = ((err && (err.shortMessage || err.message)) || '').toLowerCase();
    if (err && (err.code === 4001 || err.code === 'ACTION_REJECTED') || msg.includes('rejected') || msg.includes('user denied')) return 'Transaction rejected by user';
    if (msg.includes('insufficient') && msg.includes('balance')) return 'Insufficient USDC balance';
    if (msg.includes('insufficient funds')) return 'Insufficient native gas on source chain';
    if (msg.includes('wrong chain') || msg.includes('did not switch') || msg.includes('mismatch')) return (err && err.message) || 'Wrong network';
    if (msg.includes('gas')) return 'Gas estimation failed — ensure you have native gas on the source chain';
    if (msg.includes('network') || msg.includes('chain')) return 'Network error — ' + ((err && (err.shortMessage || err.message)) || '');
    return (err && (err.shortMessage || err.message)) || 'Unknown error';
  }

  /* ── Switch wallet network (verified, like Elligentt ensureNetwork) ── */
  async function _ensureNetwork(chainKey) {
    const chain = CHAINS[chainKey];
    const raw = _rawProvider();
    if (!raw) throw new Error('No wallet provider available');
    try {
      await raw.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chain.chainHex }] });
    } catch (switchErr) {
      const unknown = switchErr.code === 4902 ||
        (switchErr.message && switchErr.message.toLowerCase().includes('unrecognized chain'));
      if (unknown) {
        await raw.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: chain.chainHex, chainName: chain.name,
            rpcUrls: [chain.rpc].concat(chain.rpcAlternatives || []),
            nativeCurrency: chain.isNative
              ? { name: 'USDC', symbol: 'USDC', decimals: 18 }
              : { name: chain.nativeSymbol || 'ETH', symbol: chain.nativeSymbol || 'ETH', decimals: 18 },
            blockExplorerUrls: [chain.explorer],
          }],
        });
      } else throw switchErr;
    }
    // Verify the wallet actually switched (poll a few times)
    for (let i = 0; i < 10; i++) {
      try {
        const hex = await raw.request({ method: 'eth_chainId', params: [] });
        if (parseInt(hex, 16) === chain.chainId) return;
      } catch (_) {}
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error(`Wallet did not switch to ${chain.name}. Please switch manually and retry.`);
  }

  /* ── Route support ── */
  function isRouteSupported(fromKey, toKey) {
    if (!CHAINS[fromKey] || !CHAINS[toKey]) return { ok: false, reason: 'Unsupported chain selected.' };
    if (fromKey === toKey) return { ok: false, reason: 'Source and destination must be different.' };
    return { ok: true };
  }

  /* ── Real CCTP quote (single native route; fee/finality follow Elligentt) ── */
  async function getQuote(opts) {
    const from = opts.from, to = opts.to;
    const amount = parseFloat(opts.amount) || 0;
    const sup = isRouteSupported(from, to);
    if (!sup.ok) throw new Error(sup.reason);
    if (amount <= 0) throw new Error('Enter an amount greater than 0.');

    const isToArc = CHAINS[to].domain === CFG.ARC_DOMAIN;
    let maxFee = isToArc ? parseFloat(CFG.MAX_FEE_TO_ARC_USDC) : 0;
    // Inbound → Arc is now a FAST transfer (minFinalityThreshold 1000) with the
    // fee quoted dynamically from the Iris fee endpoint (cached; never throws).
    let mode = 'fast', finality = CFG.FINALITY_FAST, estTime = '~1–2 min (Fast)';
    if (isToArc) {
      try {
        const fees = await getInboundFees(CHAINS[from].domain, _toUsdc(amount.toFixed(6)));
        maxFee = Number(_E().formatUnits(fees.maxFee, 6));
        estTime = fees.forwarding ? '~30–90 sec (Fast + Forwarding)' : '~1–2 min (Fast)';
      } catch (_) { /* keep static fallback fee */ }
    } else {
      maxFee = 0;
    }
    const quote = {
      provider: { id: 'circle-cctp', name: 'Circle CCTP V2' },
      routeType: 'Native Burn & Mint',
      mode,
      finality,
      input: amount,
      output: amount,                                   // 1:1 mint (relayer may take up to maxFee)
      bridgeFee: maxFee,                                // max relayer fee (0 for outbound Fast)
      protocolFee: 0,
      gasFeeEst: 0.02,                                  // informational; gas paid on-chain
      slippage: 0,
      minReceived: Math.max(0, amount - maxFee),
      estTime,
      liquidity: 'Native (unlimited)',
      reliability: 'Very High',
      score: 10.0,
      fromDomain: CHAINS[from].domain,
      toDomain: CHAINS[to].domain,
      expiry: Date.now() + 60000,
    };
    log('quote', `${amount} USDC ${from}→${to} (${mode}, maxFee ${maxFee})`, quote);
    return quote;
  }

  /* ── Read-only balance (public RPC with failover) ── */
  async function getBalance(chainKey, address) {
    const chain = CHAINS[chainKey];
    if (!chain || !address) return null;
    try {
      const bal = await _readCall(chain, (p) => new (_E().Contract)(chain.usdc, USDC_ABI, p).balanceOf(address));
      return Number(_E().formatUnits(bal, 6));
    } catch (e) { log('balance', 'error ' + chainKey + ': ' + e.message); return null; }
  }

  /* ── Pre-flight validation ── */
  async function validate(opts) {
    const from = opts.from, to = opts.to, address = opts.address;
    const amount = parseFloat(opts.amount) || 0;
    if (!window.ethers) return { ok: false, error: 'ethers.js not loaded.' };
    if (!address) return { ok: false, error: 'Connect your wallet first.' };
    if (!_rawProvider()) return { ok: false, error: 'No wallet provider available.' };
    const sup = isRouteSupported(from, to);
    if (!sup.ok) return { ok: false, error: sup.reason };
    if (amount <= 0) return { ok: false, error: 'Enter an amount greater than 0.' };
    try {
      const bal = await _readCall(CHAINS[from], (p) => new (_E().Contract)(CHAINS[from].usdc, USDC_ABI, p).balanceOf(address));
      if (bal < _toUsdc(amount.toFixed(6))) {
        return { ok: false, error: `Insufficient USDC on ${CHAINS[from].name} (have ${Number(_E().formatUnits(bal, 6)).toFixed(2)}).` };
      }
    } catch (e) {
      return { ok: false, error: 'Could not read source balance (RPC unavailable). Try again.' };
    }
    return { ok: true };
  }

  /* ── Attestation polling — Iris V2 (per source domain) + V1 fallback ──
     Faithful to Elligentt: v2 URL includes the SOURCE domain in the path. */
  async function pollAttestation(sourceChain, burnHash, burnReceipt, isToArc, onProgress) {
    const maxPolls = isToArc ? CFG.ATTEST_POLL_MAX_ARC : CFG.ATTEST_POLL_MAX;
    const irisUrl  = `${CFG.IRIS_V2_URL}${sourceChain.domain}?transactionHash=${burnHash}`;
    log('attest', 'iris v2 ' + irisUrl);
    let messageBytes = null, attestation = null;

    for (let i = 0; i < maxPolls && !attestation; i++) {
      await new Promise(r => setTimeout(r, CFG.ATTEST_POLL_INTERVAL));
      if (typeof onProgress === 'function') onProgress(i + 1, maxPolls);
      try {
        const res = await fetch(irisUrl);
        if (res.ok) {
          const data = await res.json();
          const msg = data && data.messages && data.messages[0];
          if (msg && msg.status === 'complete' && msg.attestation && msg.attestation !== 'PENDING') {
            messageBytes = msg.message;
            attestation  = msg.attestation;
            break;
          }
        }
      } catch (e) { log('attest', 'poll ' + (i + 1) + ' error: ' + e.message); }
    }

    // Fallback: extract MessageSent from burn logs + poll v1 attestations/{hash}
    if (!attestation) {
      log('attest', 'v2 timed out — parsing MessageSent + v1 fallback');
      const iface = new (_E().Interface)(MESSAGE_SENT_ABI);
      if (burnReceipt && burnReceipt.logs) {
        for (const lg of burnReceipt.logs) {
          try {
            const parsed = iface.parseLog({ topics: lg.topics, data: lg.data });
            if (parsed && parsed.name === 'MessageSent') { messageBytes = parsed.args.message; break; }
          } catch (_) {}
        }
      }
      if (!messageBytes) throw new Error('Cannot extract CCTP message. Burn tx may not be indexed yet — retry in a minute.');
      const msgHash = _E().keccak256(messageBytes);
      for (let v = 0; v < CFG.ATTEST_V1_FALLBACK_MAX && !attestation; v++) {
        await new Promise(r => setTimeout(r, CFG.ATTEST_POLL_INTERVAL));
        try {
          const r = await fetch(`${CFG.ATTEST_V1_URL}${msgHash}`);
          if (r.ok) { const d = await r.json(); if (d.attestation && d.attestation !== 'PENDING') attestation = d.attestation; }
        } catch (_) {}
      }
    }

    if (!attestation) {
      throw new Error(isToArc
        ? 'Attestation for transfer TO Arc timed out. Standard transfers to Arc on testnet can take 15+ min — wait and retry.'
        : 'Attestation timed out. Network may be congested — retry later.');
    }
    return { message: messageBytes, attestation };
  }

  /* ════════════════════════════════════════════════════════════════════════
     INBOUND → ARC ENGINE (Fast Transfer + Forwarding Service + recovery)
     Scope: ONLY transfers whose destination is Arc (domain 26). The outbound
     direction (Arc → other chains) is untouched and keeps its original path.
     Docs: developers.circle.com/cctp/quickstarts/transfer-usdc-ethereum-to-arc
           docs.arc.io/app-kit/references/bridge-error-recovery
     ════════════════════════════════════════════════════════════════════════ */

  function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function _fetchJson(url, timeoutMs) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs || 8000);
    try {
      const res = await fetch(url, { method: 'GET', signal: ctl.signal });
      clearTimeout(t);
      return { status: res.status, ok: res.ok, json: res.ok ? await res.json().catch(() => null) : null };
    } catch (e) { clearTimeout(t); return { status: 0, ok: false, json: null, error: e }; }
  }

  /* ── Dynamic fees via Iris fee endpoint (cached 5 min per source domain) ──
     Returns { maxFee (bigint), forwarding (bool), source ('forward'|'fast'|'fallback') }.
     maxFee covers forwardFee + protocol fee (+20% headroom, since maxFee is a
     cap — only the actual fee is charged). Never throws. */
  const _feeCache = {};
  async function getInboundFees(srcDomain, amountBig) {
    const cacheKey = String(srcDomain);
    const hit = _feeCache[cacheKey];
    const now = Date.now();
    let quotes = (hit && (now - hit.ts) < 300000) ? hit.data : null;
    if (!quotes) {
      const fwd = await _fetchJson(`${CFG.FEES_URL}${srcDomain}/${CFG.ARC_DOMAIN}?forward=true`, 7000);
      const plain = (fwd.ok && Array.isArray(fwd.json)) ? null : await _fetchJson(`${CFG.FEES_URL}${srcDomain}/${CFG.ARC_DOMAIN}`, 7000);
      quotes = {
        forward: (fwd.ok && Array.isArray(fwd.json)) ? fwd.json : null,
        plain:   (plain && plain.ok && Array.isArray(plain.json)) ? plain.json : null,
      };
      if (quotes.forward || quotes.plain) _feeCache[cacheKey] = { ts: now, data: quotes };
    }
    const pick = (list) => (list || []).find(f => Number(f.finalityThreshold) === CFG.FINALITY_FAST) || null;
    const protoFeeOf = (f) => (amountBig * BigInt(Math.round((Number(f.minimumFee) || 0) * 100))) / 1000000n; // minimumFee in bps (quickstart formula)
    try {
      const f = pick(quotes.forward);
      if (f && f.forwardFee && f.forwardFee.med != null) {
        const raw = BigInt(f.forwardFee.med) + protoFeeOf(f);
        return { maxFee: (raw * 120n) / 100n, forwarding: true, source: 'forward' };
      }
    } catch (_) {}
    try {
      const f = pick(quotes.plain);
      if (f) {
        const raw = protoFeeOf(f);
        return { maxFee: ((raw * 150n) / 100n) + 100n, forwarding: false, source: 'fast' };
      }
    } catch (_) {}
    // Static fallback (fee endpoint unreachable) — direct fast mint with generous cap
    return { maxFee: _E().parseUnits(CFG.MAX_FEE_TO_ARC_USDC, 6), forwarding: false, source: 'fallback' };
  }

  /* ── Iris v2 message polling with retry + exponential backoff + jitter ──
     predicate(msg) → truthy result ends the loop. 429-aware. Never throws on
     transient errors; returns null when the time budget is exhausted. */
  async function pollIrisMessage(srcDomain, burnHash, predicate, onAttempt, budgetMs) {
    const url = `${CFG.IRIS_V2_URL}${srcDomain}?transactionHash=${burnHash}`;
    const deadline = Date.now() + (budgetMs || CFG.IN_POLL_BUDGET_MS);
    let delay = CFG.IN_POLL_BASE_MS, attempt = 0;
    const maxAttempts = Math.ceil(Math.log(CFG.IN_POLL_CAP_MS / CFG.IN_POLL_BASE_MS) / Math.log(CFG.IN_POLL_FACTOR)) +
                        Math.ceil((budgetMs || CFG.IN_POLL_BUDGET_MS) / CFG.IN_POLL_CAP_MS);
    while (Date.now() < deadline) {
      attempt++;
      if (typeof onAttempt === 'function') onAttempt(attempt, maxAttempts);
      const res = await _fetchJson(url, 10000);
      if (res.status === 429) {
        log('iris', 'rate limited (429) — backing off 30s');
        await _sleep(30000);
        continue;
      }
      if (res.ok && res.json) {
        const msg = res.json.messages && res.json.messages[0];
        if (msg) { const out = predicate(msg); if (out) return out; }
      }
      // 404 = burn not indexed yet → keep polling with backoff
      await _sleep(delay + Math.floor(Math.random() * 500));
      delay = Math.min(Math.floor(delay * CFG.IN_POLL_FACTOR), CFG.IN_POLL_CAP_MS);
    }
    return null;
  }

  /* ── Persistent recovery store (burn succeeded but transfer incomplete) ── */
  function _listPending() {
    try { return JSON.parse(localStorage.getItem(CFG.PENDING_KEY) || '[]'); } catch (_) { return []; }
  }
  function _savePending(rec) {
    try {
      const all = _listPending().filter(r => r.burnHash !== rec.burnHash);
      all.unshift(rec);
      localStorage.setItem(CFG.PENDING_KEY, JSON.stringify(all.slice(0, 20)));
    } catch (_) {}
  }
  function _removePending(burnHash) {
    try { localStorage.setItem(CFG.PENDING_KEY, JSON.stringify(_listPending().filter(r => r.burnHash !== burnHash))); } catch (_) {}
  }

  /* ── Destination mint with retry + gas fallback (direct-mint path only) ──
     "Nonce already used" ⇒ the message was already minted (e.g. by the
     Forwarding Service or a previous retry) — treated as success. */
  async function _mintOnArcWithRetry(message, attestation, onEvent) {
    const E = _E();
    const arc = CHAINS.arc;
    await _ensureNetwork('arc');
    const destProvider = _browserProvider();
    const destNet = await destProvider.getNetwork();
    if (Number(destNet.chainId) !== arc.chainId) throw new Error(`Wallet still on chain ${destNet.chainId} — expected ${arc.chainId} (${arc.name}).`);
    const destSigner = await destProvider.getSigner();
    const mt = new E.Contract(arc.messageTransmitter, MSG_TRANSMITTER_ABI, destSigner);

    let lastErr = null;
    for (let i = 0; i < 3; i++) {
      try {
        let gasLimit;
        try { gasLimit = (await mt.receiveMessage.estimateGas(message, attestation)) * 140n / 100n; }
        catch (ge) {
          const gm = String((ge && (ge.shortMessage || ge.message)) || '').toLowerCase();
          if (gm.includes('nonce') && gm.includes('used')) return { alreadyMinted: true };
          gasLimit = 800000n; // estimation unavailable — safe fixed cap on Arc
        }
        onEvent('minting');
        const mintTx = await mt.receiveMessage(message, attestation, { gasLimit });
        onEvent('mint_sent', { txHash: mintTx.hash, explorer: arc.explorer });
        const rcpt = await mintTx.wait();
        if (!rcpt || rcpt.status !== 1) throw new Error(`receiveMessage failed on-chain (status=0). Tx: ${mintTx.hash}`);
        return { mintTxHash: mintTx.hash };
      } catch (e) {
        const m = String((e && (e.shortMessage || e.message)) || '').toLowerCase();
        if (e && (e.code === 4001 || e.code === 'ACTION_REJECTED') || m.includes('rejected') || m.includes('denied')) throw e;
        if (m.includes('nonce') && m.includes('used')) return { alreadyMinted: true };
        lastErr = e;
        log('mint', `attempt ${i + 1} failed: ` + (e && e.message));
        await _sleep(3000 * (i + 1));
      }
    }
    throw lastErr || new Error('Mint on Arc failed after retries');
  }

  /* ── Wait for the mint tx to confirm on Arc (read-only, via /api/rpc) ── */
  async function _waitArcReceipt(txHash, budgetMs) {
    const deadline = Date.now() + (budgetMs || 90000);
    while (Date.now() < deadline) {
      try {
        const rcpt = await _readProvider(CHAINS.arc).getTransactionReceipt(txHash);
        if (rcpt) return rcpt;
      } catch (_) {}
      await _sleep(4000);
    }
    return null; // best effort — tx hash already known
  }

  /* ── Full inbound execution: Fast Transfer (minFinality 1000) + Forwarding
     Service (depositForBurnWithHook) with automatic self-mint fallback ── */
  async function executeInboundToArc(opts) {
    const from = opts.from, to = opts.to;
    const amount = parseFloat(opts.amount) || 0;
    const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : function () {};
    const fromChain = CHAINS[from], toChain = CHAINS[to];
    let burnHash = null;

    try {
      onEvent('validating');
      const recipient = opts.recipient || window.walletState?.address;
      const v = await validate({ from, to, amount, address: recipient });
      if (!v.ok) throw new Error(v.error);
      const E = _E();
      const amtBig = _toUsdc(amount.toFixed(6));

      // Dynamic fee quote (forwarding preferred; graceful fallbacks)
      const fees = await getInboundFees(fromChain.domain, amtBig);
      if (fees.maxFee >= amtBig) {
        throw new Error(`Amount too small to cover bridge fees (max fee ≈ ${Number(E.formatUnits(fees.maxFee, 6)).toFixed(4)} USDC). Send a larger amount.`);
      }
      log('exec', `start ${amount} USDC ${from}→arc (Fast/1000, ${fees.forwarding ? 'Forwarding Service' : 'direct mint'}, maxFee ${E.formatUnits(fees.maxFee, 6)}, fees:${fees.source})`);

      // STEP 0: switch to source
      onEvent('switching_source');
      await _ensureNetwork(from);
      const srcProvider = _browserProvider();
      const srcNet = await srcProvider.getNetwork();
      if (Number(srcNet.chainId) !== fromChain.chainId) throw new Error(`Provider chain mismatch: expected ${fromChain.chainId}, got ${srcNet.chainId}`);
      const srcSigner = await srcProvider.getSigner();

      // STEP 1: approve USDC → TokenMessengerV2
      onEvent('approving');
      const usdcRead  = new E.Contract(fromChain.usdc, USDC_ABI, _readProvider(fromChain));
      const usdcWrite = new E.Contract(fromChain.usdc, USDC_ABI, srcSigner);
      const currentAllowance = await usdcRead.allowance(recipient, fromChain.tokenMessenger).catch(() => 0n);
      if (currentAllowance < amtBig) {
        let approveGas;
        try { approveGas = (await usdcWrite.approve.estimateGas(fromChain.tokenMessenger, amtBig)) * 130n / 100n; }
        catch (_) { approveGas = 100000n; }
        const approveTx = await usdcWrite.approve(fromChain.tokenMessenger, amtBig, { gasLimit: approveGas });
        const approveRcpt = await approveTx.wait();
        if (!approveRcpt || approveRcpt.status !== 1) throw new Error('Approve transaction failed (status=0)');
      }
      onEvent('approved');

      // STEP 2: burn — Fast Transfer (minFinalityThreshold 1000)
      onEvent('burning');
      const tm = new E.Contract(fromChain.tokenMessenger, TOKEN_MESSENGER_ABI, srcSigner);
      const mintRecipient32 = E.zeroPadValue(recipient, 32);
      const zeroCaller32 = E.zeroPadValue('0x0000000000000000000000000000000000000000', 32);

      let burnTx;
      if (fees.forwarding) {
        let g;
        try { g = (await tm.depositForBurnWithHook.estimateGas(amtBig, toChain.domain, mintRecipient32, fromChain.usdc, zeroCaller32, fees.maxFee, CFG.FINALITY_FAST, CFG.FORWARD_HOOK_DATA)) * 150n / 100n; }
        catch (_) { g = 450000n; }
        burnTx = await tm.depositForBurnWithHook(amtBig, toChain.domain, mintRecipient32, fromChain.usdc, zeroCaller32, fees.maxFee, CFG.FINALITY_FAST, CFG.FORWARD_HOOK_DATA, { gasLimit: g });
      } else {
        let g;
        try { g = (await tm.depositForBurn.estimateGas(amtBig, toChain.domain, mintRecipient32, fromChain.usdc, zeroCaller32, fees.maxFee, CFG.FINALITY_FAST)) * 150n / 100n; }
        catch (_) { g = 400000n; }
        burnTx = await tm.depositForBurn(amtBig, toChain.domain, mintRecipient32, fromChain.usdc, zeroCaller32, fees.maxFee, CFG.FINALITY_FAST, { gasLimit: g });
      }
      burnHash = burnTx.hash;
      onEvent('burn_sent', { txHash: burnHash, explorer: fromChain.explorer });
      const burnReceipt = await burnTx.wait();
      if (!burnReceipt || burnReceipt.status !== 1) throw new Error('depositForBurn failed (status=0)');
      onEvent('burn_confirmed', { txHash: burnHash, explorer: fromChain.explorer });

      // Persist recovery state (burn is irreversible from here on)
      _savePending({ burnHash, srcKey: from, srcDomain: fromChain.domain, amount, recipient, forwarding: fees.forwarding, ts: Date.now(), stage: 'attesting' });

      // STEP 3: attestation / forwarded mint — Iris v2 with backoff
      onEvent('attesting', { attempt: 0, max: 1 });
      let attested = null;   // { message, attestation }
      let forwardTxHash = null;
      let attestedAt = 0;

      const found = await pollIrisMessage(fromChain.domain, burnHash, (msg) => {
        if (msg.forwardTxHash) { forwardTxHash = msg.forwardTxHash; return { done: 'forwarded', msg }; }
        if (msg.status === 'complete' && msg.attestation && msg.attestation !== 'PENDING') {
          if (!attested) { attested = { message: msg.message, attestation: msg.attestation }; attestedAt = Date.now(); }
          // Forwarding path: give Circle a grace window to publish forwardTxHash,
          // then fall back to self-mint with the attestation we already hold.
          if (!fees.forwarding) return { done: 'attested', msg };
          if (Date.now() - attestedAt > CFG.IN_FORWARD_GRACE_MS) return { done: 'attested', msg };
        }
        return null;
      }, (a, m) => onEvent('attesting', { attempt: a, max: m }));

      if (!found && !attested) {
        throw new Error('Attestation timed out. Your burn succeeded and funds are safe — this transfer will resume automatically (or call ArcBridge.resumeInbound()).');
      }

      let mintTxHash = null;
      if (forwardTxHash) {
        // Circle's Forwarding Service minted on Arc — no wallet switch, no dest gas.
        onEvent('attested');
        onEvent('minting');
        onEvent('mint_sent', { txHash: forwardTxHash, explorer: toChain.explorer });
        await _waitArcReceipt(forwardTxHash, 90000);
        mintTxHash = forwardTxHash;
      } else {
        // Direct mint (fallback or non-forwarding quote)
        onEvent('attested');
        _savePending({ burnHash, srcKey: from, srcDomain: fromChain.domain, amount, recipient, forwarding: fees.forwarding, ts: Date.now(), stage: 'minting', message: attested.message, attestation: attested.attestation });
        onEvent('switching_dest');
        const minted = await _mintOnArcWithRetry(attested.message, attested.attestation, onEvent);
        mintTxHash = minted.mintTxHash || null;
        if (minted.alreadyMinted) log('mint', 'message already received on Arc (minted elsewhere) — success');
      }
      onEvent('mint_confirmed', { txHash: mintTxHash, explorer: toChain.explorer });
      _removePending(burnHash);

      onEvent('completed', { burnTxHash: burnHash, mintTxHash, message: attested ? attested.message : null, attestation: attested ? attested.attestation : null });
      log('exec', 'inbound completed', { burnHash, mintTxHash, forwarded: !!forwardTxHash });
      return { burnTxHash: burnHash, mintTxHash, message: attested ? attested.message : null, attestation: attested ? attested.attestation : null, from, to, amount };

    } catch (err) {
      let friendly = _decodeError(err);
      if (burnHash) friendly += ' — Burn tx succeeded (' + burnHash.slice(0, 12) + '…); funds are SAFE. Use ArcBridge.resumeInbound() to finish the mint on Arc.';
      log('exec', 'inbound failed: ' + friendly, 'error');
      onEvent('failed', { error: friendly, burnTxHash: burnHash });
      const e2 = new Error(friendly); e2.original = err; e2.burnTxHash = burnHash; throw e2;
    }
  }

  /* ── Recovery: finish transfers whose burn succeeded but mint didn't ──
     Read-only for forwarded transfers; direct-mint recovery asks the wallet
     to sign receiveMessage on Arc. Returns a per-transfer summary. */
  async function resumeInbound(burnHashFilter, onEvent) {
    onEvent = typeof onEvent === 'function' ? onEvent : function () {};
    const targets = _listPending().filter(r => !burnHashFilter || r.burnHash === burnHashFilter);
    const results = [];
    for (const rec of targets) {
      try {
        const found = await pollIrisMessage(rec.srcDomain, rec.burnHash, (msg) => {
          if (msg.forwardTxHash) return { forwardTxHash: msg.forwardTxHash };
          if (msg.status === 'complete' && msg.attestation && msg.attestation !== 'PENDING') return { message: msg.message, attestation: msg.attestation };
          return null;
        }, null, 60000);
        if (!found) { results.push({ burnHash: rec.burnHash, status: 'still_pending' }); continue; }
        if (found.forwardTxHash) {
          _removePending(rec.burnHash);
          results.push({ burnHash: rec.burnHash, status: 'completed', mintTxHash: found.forwardTxHash, forwarded: true });
          continue;
        }
        const minted = await _mintOnArcWithRetry(found.message, found.attestation, onEvent);
        _removePending(rec.burnHash);
        results.push({ burnHash: rec.burnHash, status: 'completed', mintTxHash: minted.mintTxHash || null, alreadyMinted: !!minted.alreadyMinted });
      } catch (e) {
        results.push({ burnHash: rec.burnHash, status: 'failed', error: (e && e.message) || String(e) });
      }
    }
    return results;
  }

  // Passive background check (read-only): clears pending records already
  // completed by the Forwarding Service. Never touches the wallet.
  setTimeout(async function () {
    try {
      for (const rec of _listPending()) {
        if (Date.now() - rec.ts < 60000) continue;
        const res = await _fetchJson(`${CFG.IRIS_V2_URL}${rec.srcDomain}?transactionHash=${rec.burnHash}`, 8000);
        const msg = res.ok && res.json && res.json.messages && res.json.messages[0];
        if (msg && msg.forwardTxHash) { _removePending(rec.burnHash); log('recovery', 'forwarded mint confirmed for ' + rec.burnHash.slice(0, 12) + '… — cleared'); }
        else if (msg) log('recovery', 'pending inbound transfer found (' + rec.burnHash.slice(0, 12) + '…) — call ArcBridge.resumeInbound() to finish');
      }
    } catch (_) {}
  }, 10000);


  /* ── Full execution — real CCTP V2 (architecture from Elligentt) ──────────
     Inbound (→ Arc) is routed to the dedicated Fast+Forwarding engine above;
     the outbound path below is UNCHANGED.
     onEvent(stage, data) stages: validating · switching_source · approving ·
       approved · burning · burn_sent{txHash,explorer} · burn_confirmed ·
       attesting{attempt,max} · attested · switching_dest · minting ·
       mint_sent{txHash,explorer} · mint_confirmed · completed · failed{error} */
  async function execute(opts) {
    const from = opts.from, to = opts.to;
    const amount = parseFloat(opts.amount) || 0;
    const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : function () {};
    const fromChain = CHAINS[from], toChain = CHAINS[to];
    const isToArc = toChain.domain === CFG.ARC_DOMAIN;

    // ── Inbound → Arc: Fast Transfer + Forwarding Service + recovery ──
    if (isToArc) return executeInboundToArc(opts);

    try {
      onEvent('validating');
      const recipient = opts.recipient || window.walletState?.address;
      const v = await validate({ from, to, amount, address: recipient });
      if (!v.ok) throw new Error(v.error);
      const E = _E();
      log('exec', `start ${amount} USDC ${from}→${to} (${isToArc ? 'Standard/Arc' : 'Fast'})`);

      // STEP 0: switch to source
      onEvent('switching_source');
      await _ensureNetwork(from);
      const srcProvider = _browserProvider();
      const srcNet = await srcProvider.getNetwork();
      if (Number(srcNet.chainId) !== fromChain.chainId) throw new Error(`Provider chain mismatch: expected ${fromChain.chainId}, got ${srcNet.chainId}`);
      const srcSigner = await srcProvider.getSigner();

      // STEP 1: approve USDC → TokenMessenger
      onEvent('approving');
      const amtBig = _toUsdc(amount.toFixed(6));
      const usdcRead = new E.Contract(fromChain.usdc, USDC_ABI, _readProvider(fromChain));
      const usdcWrite = new E.Contract(fromChain.usdc, USDC_ABI, srcSigner);
      const currentAllowance = await usdcRead.allowance(recipient, fromChain.tokenMessenger).catch(() => 0n);
      if (currentAllowance < amtBig) {
        let approveGas;
        try { approveGas = (await usdcWrite.approve.estimateGas(fromChain.tokenMessenger, amtBig)) * 130n / 100n; }
        catch (_) { approveGas = 100000n; }
        const approveTx = await usdcWrite.approve(fromChain.tokenMessenger, amtBig, { gasLimit: approveGas });
        const approveRcpt = await approveTx.wait();
        if (!approveRcpt || approveRcpt.status !== 1) throw new Error('Approve transaction failed (status=0)');
      }
      onEvent('approved');

      // STEP 2: depositForBurn (CCTP V2 — 7 args)
      onEvent('burning');
      const tm = new E.Contract(fromChain.tokenMessenger, TOKEN_MESSENGER_ABI, srcSigner);
      const mintRecipient32 = E.zeroPadValue(recipient, 32);
      const zeroCaller32 = E.zeroPadValue('0x0000000000000000000000000000000000000000', 32);
      const finalityThreshold = isToArc ? CFG.FINALITY_STANDARD : CFG.FINALITY_FAST;
      const maxFee = isToArc ? E.parseUnits(CFG.MAX_FEE_TO_ARC_USDC, 6) : 0n;

      let burnGas;
      try { burnGas = (await tm.depositForBurn.estimateGas(amtBig, toChain.domain, mintRecipient32, fromChain.usdc, zeroCaller32, maxFee, finalityThreshold)) * 150n / 100n; }
      catch (_) { burnGas = 400000n; }
      const burnTx = await tm.depositForBurn(amtBig, toChain.domain, mintRecipient32, fromChain.usdc, zeroCaller32, maxFee, finalityThreshold, { gasLimit: burnGas });
      onEvent('burn_sent', { txHash: burnTx.hash, explorer: fromChain.explorer });
      const burnReceipt = await burnTx.wait();
      if (!burnReceipt || burnReceipt.status !== 1) throw new Error('depositForBurn failed (status=0)');
      await new Promise(r => setTimeout(r, 3000));
      onEvent('burn_confirmed', { txHash: burnTx.hash, explorer: fromChain.explorer });

      // STEP 3: attestation
      onEvent('attesting', { attempt: 0, max: isToArc ? CFG.ATTEST_POLL_MAX_ARC : CFG.ATTEST_POLL_MAX });
      const { message, attestation } = await pollAttestation(
        fromChain, burnTx.hash, burnReceipt, isToArc,
        (a, m) => onEvent('attesting', { attempt: a, max: m })
      );
      onEvent('attested');

      // STEP 4: switch to destination
      onEvent('switching_dest');
      await _ensureNetwork(to);
      const destProvider = _browserProvider();
      const destNet = await destProvider.getNetwork();
      if (Number(destNet.chainId) !== toChain.chainId) throw new Error(`Wallet still on chain ${destNet.chainId} — expected ${toChain.chainId} (${toChain.name}).`);
      const destSigner = await destProvider.getSigner();

      // STEP 5: receiveMessage (mint)
      onEvent('minting');
      const mt = new E.Contract(toChain.messageTransmitter, MSG_TRANSMITTER_ABI, destSigner);
      const mintTx = await mt.receiveMessage(message, attestation);
      onEvent('mint_sent', { txHash: mintTx.hash, explorer: toChain.explorer });
      const mintReceipt = await mintTx.wait();
      if (!mintReceipt || mintReceipt.status !== 1) throw new Error(`receiveMessage failed on-chain (status=0). Tx: ${mintTx.hash}`);
      await new Promise(r => setTimeout(r, 3000));
      onEvent('mint_confirmed', { txHash: mintTx.hash, explorer: toChain.explorer });

      onEvent('completed', { burnTxHash: burnTx.hash, mintTxHash: mintTx.hash, message, attestation });
      log('exec', 'completed', 'success');
      return { burnTxHash: burnTx.hash, mintTxHash: mintTx.hash, message, attestation, from, to, amount };

    } catch (err) {
      const friendly = _decodeError(err);
      log('exec', 'failed: ' + friendly, 'error');
      onEvent('failed', { error: friendly });
      const e2 = new Error(friendly); e2.original = err; throw e2;
    }
  }

  /* ── Public API ── */
  window.ArcBridge = {
    VERSION: '20260718arcin1',
    CFG, CHAINS,
    listChains: function () { return Object.values(CHAINS); },
    getChain: function (k) { return CHAINS[k] || null; },
    isRouteSupported,
    getQuote,
    getBalance,
    validate,
    pollAttestation,
    execute,
    // Inbound (→ Arc) helpers: dynamic fees, recovery for burn-ok/mint-failed
    getInboundFees,
    resumeInbound,
    listPendingInbound: _listPending,
  };

  log('init', 'ArcBridge service loaded — CCTP V2 (Fast+Forwarding inbound to Arc)');
})();
