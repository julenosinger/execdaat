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
    FINALITY_FAST:         1000,
    FINALITY_STANDARD:     2000,
    MAX_FEE_TO_ARC_USDC:   '0.5',   // Standard transfer to Arc allows a small maxFee
    ATTEST_POLL_INTERVAL:  5000,
    ATTEST_POLL_MAX:       120,     // ~10 min (other routes)
    ATTEST_POLL_MAX_ARC:   180,     // ~15 min (inbound to Arc on sandbox)
    ATTEST_V1_FALLBACK_MAX: 60,
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
      usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      tokenMessenger: TOKEN_MESSENGER_V2, messageTransmitter: MSG_TRANSMITTER_V2,
      nativeSymbol: 'ETH', nativeDecimals: 18,
    },
    basesepolia: {
      key: 'basesepolia', name: 'Base Sepolia', short: 'Base Sep', icon: '🔵',
      chainId: 84532, chainHex: '0x14a34', domain: 6,
      rpc: 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org',
      usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      tokenMessenger: TOKEN_MESSENGER_V2, messageTransmitter: MSG_TRANSMITTER_V2,
      nativeSymbol: 'ETH', nativeDecimals: 18,
    },
    arbsepolia: {
      key: 'arbsepolia', name: 'Arbitrum Sepolia', short: 'Arb Sep', icon: '🔵',
      chainId: 421614, chainHex: '0x66eee', domain: 3,
      rpc: 'https://sepolia-rollup.arbitrum.io/rpc', explorer: 'https://sepolia.arbiscan.io',
      usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
      tokenMessenger: TOKEN_MESSENGER_V2, messageTransmitter: MSG_TRANSMITTER_V2,
      nativeSymbol: 'ETH', nativeDecimals: 18,
    },
    optsepolia: {
      key: 'optsepolia', name: 'OP Sepolia', short: 'OP Sep', icon: '🔴',
      chainId: 11155420, chainHex: '0xaa37dc', domain: 2,
      rpc: 'https://sepolia.optimism.io', explorer: 'https://sepolia-optimism.etherscan.io',
      usdc: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7',
      tokenMessenger: TOKEN_MESSENGER_V2, messageTransmitter: MSG_TRANSMITTER_V2,
      nativeSymbol: 'ETH', nativeDecimals: 18,
    },
    polygonAmoy: {
      key: 'polygonAmoy', name: 'Polygon Amoy', short: 'Amoy', icon: '🟪',
      chainId: 80002, chainHex: '0x13882', domain: 7,
      rpc: 'https://rpc-amoy.polygon.technology', explorer: 'https://amoy.polygonscan.com',
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
    return new (_E().JsonRpcProvider)(chain.rpc);
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
    const maxFee  = isToArc ? parseFloat(CFG.MAX_FEE_TO_ARC_USDC) : 0;
    const mode    = isToArc ? 'standard' : 'fast';
    const quote = {
      provider: { id: 'circle-cctp', name: 'Circle CCTP V2' },
      routeType: 'Native Burn & Mint',
      mode,
      finality: isToArc ? CFG.FINALITY_STANDARD : CFG.FINALITY_FAST,
      input: amount,
      output: amount,                                   // 1:1 mint (relayer may take up to maxFee)
      bridgeFee: maxFee,                                // max relayer fee (0 for Fast)
      protocolFee: 0,
      gasFeeEst: 0.02,                                  // informational; gas paid on-chain
      slippage: 0,
      minReceived: Math.max(0, amount - maxFee),
      estTime: isToArc ? '~15+ min (Standard)' : '~1–2 min (Fast)',
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

  /* ── Read-only balance (public RPC) ── */
  async function getBalance(chainKey, address) {
    const chain = CHAINS[chainKey];
    if (!chain || !address) return null;
    try {
      const c = new (_E().Contract)(chain.usdc, USDC_ABI, _readProvider(chain));
      const bal = await c.balanceOf(address);
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
      const c = new (_E().Contract)(CHAINS[from].usdc, USDC_ABI, _readProvider(CHAINS[from]));
      const bal = await c.balanceOf(address);
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

  /* ── Full execution — real CCTP V2 (architecture from Elligentt) ──────────
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
    VERSION: '20260703c-elligentt',
    CFG, CHAINS,
    listChains: function () { return Object.values(CHAINS); },
    getChain: function (k) { return CHAINS[k] || null; },
    isRouteSupported,
    getQuote,
    getBalance,
    validate,
    pollAttestation,
    execute,
  };

  log('init', 'ArcBridge service loaded — CCTP V2 (Elligentt architecture)');
})();
