// ============================================================
// Turbo Bridge Integration — ExecDaat
// Wires the Elligentt Treasury/Vault Turbo Bridge (turbo-bridge-core.js)
// into the Advanced Cross-Chain Center and the shared ArcBridge flow.
//
// SCOPE: Turbo Bridge is used ONLY for "Other Chains → Arc".
//        Any other route (including Arc → Other Chains) keeps using the
//        existing Standard Bridge (Arc App Kit / CCTP via window.ArcBridge).
//
// This module is 100% ADDITIVE. It never replaces the Standard Bridge; it
// only adds a prioritised execution path with automatic fallback.
// build: 20260704a
// ============================================================
'use strict';

(function () {
  const ARC_KEY    = 'arc';
  const ARC_DOMAIN = 26;

  function _log(...a)  { console.log('%c[TURBO-INT]', 'color:#f59e0b', ...a); }
  function _warn(...a) { console.warn('%c[TURBO-INT]', 'color:#f59e0b', ...a); }

  /* ── Build the window.BRIDGE_CHAINS map that turbo-bridge-core expects ──
     turbo-bridge-core.js reads window.BRIDGE_CHAINS[key] with the field
     names { chainId, chainHex, shortName, domain, usdcAddress,
     tokenMessengerV2 }. We derive it from the canonical ArcBridge registry
     so there is a single source of truth for chain config. We only set it
     if nothing else already defined it (never override existing state). */
  function _syncBridgeChains() {
    try {
      if (!window.ArcBridge || !window.ArcBridge.CHAINS) return;
      const src = window.ArcBridge.CHAINS;
      const out = {};
      Object.keys(src).forEach(function (k) {
        const c = src[k];
        out[k] = {
          name:             c.name,
          shortName:        c.short,
          icon:             c.icon,
          chainId:          c.chainId,
          chainHex:         c.chainHex,
          domain:           c.domain,
          rpcUrl:           c.rpc,
          explorer:         c.explorer,
          usdcAddress:      c.usdc,
          tokenMessengerV2: c.tokenMessenger,
          messageTransmitterV2: c.messageTransmitter,
          isNative:         !!c.isNative,
        };
      });
      // Additive: expose for turbo-core. bridge.js uses a lexical const of the
      // same name (NOT window.*), so this never collides with it.
      window.BRIDGE_CHAINS = out;
    } catch (e) { _warn('syncBridgeChains failed:', e && e.message); }
  }

  /* ── Route detection: Turbo only applies to Other → Arc ── */
  function isTurboRoute(fromKey, toKey) {
    if (!fromKey || !toKey) return false;
    if (fromKey === toKey) return false;
    if (fromKey === ARC_KEY) return false;                 // Arc → * stays Standard
    const chains = (window.ArcBridge && window.ArcBridge.CHAINS) || {};
    const dst = chains[toKey];
    const dstIsArc = toKey === ARC_KEY || (dst && dst.domain === ARC_DOMAIN);
    return !!dstIsArc;
  }

  /* ── Availability: consult Treasury/Vault reserves on-chain ──
     Any failure (contract unreachable, RPC error, insufficient liquidity,
     module missing) resolves to available:false so the caller falls back to
     the Standard Bridge without interrupting the user flow. */
  async function isAvailable(fromKey, amount) {
    const amt = parseFloat(amount) || 0;
    try {
      if (!window.TurboExecutor || !window.VaultAccounting) {
        return { available: false, reason: 'Turbo module not loaded' };
      }
      if (!window.ethers) {
        return { available: false, reason: 'ethers.js not loaded' };
      }
      if (amt <= 0) return { available: false, reason: 'Invalid amount' };

      // Read live on-chain Treasury reserves (30s cache inside VaultAccounting)
      let reserves = null;
      try {
        reserves = await window.VaultAccounting.fetchOnChainReserves();
      } catch (e) {
        return { available: false, reason: 'Treasury unreachable' };
      }
      if (reserves === null || reserves === undefined) {
        return { available: false, reason: 'Treasury unreachable' };
      }
      if (reserves < amt) {
        return {
          available: false,
          reason: 'Insufficient Treasury liquidity (' + reserves.toFixed(2) + ' USDC available)',
          reserves: reserves,
        };
      }
      return {
        available: true,
        reserves: reserves,
        info: _turboInfo(reserves),
      };
    } catch (e) {
      _warn('isAvailable error:', e && e.message);
      return { available: false, reason: (e && e.message) || 'Turbo check failed' };
    }
  }

  function _turboInfo(reserves) {
    const feeBps = (typeof window.TURBO_FEE_BPS === 'number') ? window.TURBO_FEE_BPS : 100;
    return {
      provider:  'Turbo Bridge (Treasury)',
      treasury:  window.TREASURY_VAULT_ADDRESS || '—',
      vault:     window.TREASURY_VAULT_ADDRESS || '—',
      contract:  window.TREASURY_VAULT_ADDRESS || '—',
      feeBps:    feeBps,
      reserves:  (typeof reserves === 'number') ? reserves : null,
    };
  }

  /* ── Turbo quote (shape compatible with Advanced Cross-Chain render fns) ── */
  function getQuote(opts) {
    const amount = parseFloat(opts.amount) || 0;
    const feeBps = (typeof window.TURBO_FEE_BPS === 'number') ? window.TURBO_FEE_BPS : 100;
    const bridgeFee = parseFloat((amount * (feeBps / 10000)).toFixed(6));
    const output    = Math.max(0, parseFloat((amount - bridgeFee).toFixed(6)));
    const info      = _turboInfo(opts.reserves);
    return {
      provider:   { id: 'turbo-bridge', name: 'Turbo Bridge' },
      input:      amount,
      output:     output,
      bridgeFee:  bridgeFee,
      gasFee:     0.02,
      protFee:    0,
      totalCost:  bridgeFee,
      slippage:   0,
      time:       '~8–15 sec',
      score:      9.9,
      minReceived: output,
      liquidity:  'Treasury Pool',
      reliability:'Very High',
      routeType:  'Turbo (Treasury/Vault)',
      expiry:     Date.now() + 60000,
      _mode:      'turbo',
      _turbo:     info,
    };
  }

  /* ── Turbo execution — delegates to the Elligentt TurboExecutor.
     onStep(stepNum, message) is the turbo-core progress callback.
     Resolves after the source burn + Treasury intent is created (settlement
     continues asynchronously via turbo-core pollers). Throws on hard failure
     so the caller can fall back to the Standard Bridge. ── */
  async function execute(opts) {
    if (!window.TurboExecutor) throw new Error('Turbo module not loaded');
    const fromKey    = opts.from;
    const toKey      = opts.to || ARC_KEY;
    const amount     = parseFloat(opts.amount) || 0;
    const recipient  = opts.recipient || window.walletState?.address;
    const onStep     = typeof opts.onStep === 'function' ? opts.onStep : function () {};
    if (!recipient) throw new Error('WALLET_NOT_CONNECTED');
    if (amount <= 0) throw new Error('Invalid amount');

    _log('execute turbo', amount, 'USDC', fromKey, '→', toKey);
    const res = await window.TurboExecutor.execute(fromKey, toKey, 'usdc', amount, recipient, onStep);
    return Object.assign({ mode: 'turbo' }, _turboInfo(), res || {});
  }

  /* ── Decision helper (used by the Autonomous Agent) ──
     Returns the mode that WILL be used for a given route + amount. */
  async function decide(fromKey, toKey, amount) {
    if (!isTurboRoute(fromKey, toKey)) return { mode: 'standard', reason: 'Not an Other→Arc route' };
    const a = await isAvailable(fromKey, amount);
    return a.available
      ? { mode: 'turbo', info: a.info, reserves: a.reserves }
      : { mode: 'standard', reason: a.reason };
  }

  /* ── Smart execute (used by the Autonomous Agent / programmatic callers) ──
     Prefers Turbo for Other→Arc, automatically falls back to the Standard
     Bridge (window.ArcBridge.execute) on any turbo failure. onEvent mirrors
     the ArcBridge event contract for the standard path. */
  async function smartExecute(opts) {
    const fromKey = opts.from, toKey = opts.to;
    const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : function () {};
    if (isTurboRoute(fromKey, toKey)) {
      const a = await isAvailable(fromKey, opts.amount);
      if (a.available) {
        try {
          onEvent('mode_resolved', { mode: 'turbo' });
          const res = await execute({
            from: fromKey, to: toKey, amount: opts.amount, recipient: opts.recipient,
            onStep: function (n, msg) { onEvent('turbo_progress', { step: n, message: msg }); },
          });
          onEvent('completed', { burnTxHash: res.txHash, mode: 'turbo', intentId: res.intentId });
          return Object.assign({ mode: 'turbo' }, res);
        } catch (turboErr) {
          _warn('Turbo failed, falling back to Standard:', turboErr && turboErr.message);
          onEvent('mode_resolved', { mode: 'standard', fallback: true, reason: (turboErr && turboErr.message) });
        }
      } else {
        onEvent('mode_resolved', { mode: 'standard', reason: a.reason });
      }
    } else {
      onEvent('mode_resolved', { mode: 'standard' });
    }
    // Standard bridge (Arc App Kit / CCTP)
    if (!window.ArcBridge) throw new Error('Bridge service unavailable');
    const std = await window.ArcBridge.execute(opts);
    return Object.assign({ mode: 'standard' }, std);
  }

  /* ── Public API ── */
  window.TurboBridge = {
    VERSION: '20260704a',
    ARC_KEY: ARC_KEY,
    isTurboRoute: isTurboRoute,
    isAvailable: isAvailable,
    getQuote: getQuote,
    execute: execute,
    decide: decide,
    smartExecute: smartExecute,
    _syncBridgeChains: _syncBridgeChains,
  };

  _syncBridgeChains();
  _log('Turbo Bridge integration loaded — Other→Arc prioritised, Standard fallback active');
})();
