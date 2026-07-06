// ============================================================
// Treasury Core Integration — ExecDaat (Phase 4)
// ------------------------------------------------------------
// Definitive migration: the Advanced Cross-Chain, Turbo Bridge,
// Arc Bridge and Unified Balance flows consume the Elligent
// Treasury Core API as the single source of truth — WITHOUT
// changing UX, flows, smart contracts, wallet integration or
// signatures.
//
// Strategy (feature-flag driven, non-regressive):
//   • Wraps window.ArcBridge and window.TurboBridge, preserving the
//     ORIGINAL implementations as emergency fallback.
//   • When "effective REMOTE" (mode REMOTE + backend enabled + health OK),
//     quotes/execution/status are sourced from the Treasury Core API and
//     adapted back to the EXACT shapes the existing UI expects, driving the
//     SAME onEvent/onStep timeline callbacks.
//   • De-duplicates rapid quote requests (no duplicate intent creation).
//   • On ANY remote failure before signing, it transparently falls back to
//     the legacy local path and LOGS the fallback (observability).
//   • When effective LOCAL (emergency), every wrapped method is a pure
//     pass-through → byte-for-byte legacy UX.
//
// Also provides:
//   • window.TreasuryObs   — structured, non-sensitive observability sink.
//   • window.TreasuryData  — remote history/metrics/applications (local fallback).
//   • A discrete health indicator (Treasury/Vault/Relayer/Circle/RPC/Workers).
//
// ExecDaat holds NO private keys and NO secrets client-side. All signing
// stays in the user's wallet (unchanged); all treasury/vault/settlement
// stays on Elligent. The Application Secret + HMAC live only in the Worker.
// build: 20260705b
// ============================================================
'use strict';

(function () {
  var ARC_KEY = 'arc';

  function _log() {
    try {
      var a = Array.prototype.slice.call(arguments);
      a.unshift('%c[TREASURY-INT]', 'color:#a78bfa');
      console.log.apply(console, a);
    } catch (e) {}
  }
  function _warn() {
    try {
      var a = Array.prototype.slice.call(arguments);
      a.unshift('%c[TREASURY-INT]', 'color:#a78bfa');
      console.warn.apply(console, a);
    } catch (e) {}
  }

  function _num(v, d) {
    var n = parseFloat(v);
    return isFinite(n) ? n : (d === undefined ? 0 : d);
  }
  function _pick() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  }

  // ── Quote↔Intent cache — links a fetched quote to its remote intentId so
  // the subsequent execute reuses it (no duplicate intent creation), and lets
  // the synchronous Turbo getQuote() return an already-fetched remote quote. ──
  var _quoteCache = { key: null, intentId: null, turboQuote: null };
  function _qkey(from, to, amount) { return String(from) + '|' + String(to) + '|' + String(amount); }
  function _cachedIntentFor(from, to, amount) {
    var k = _qkey(from, to || ARC_KEY, amount);
    return (_quoteCache.key === k) ? _quoteCache.intentId : null;
  }

  // In-flight remote-quote de-duplication (avoids duplicate intent creation on
  // rapid repeated quote requests for the same route/amount).
  var _quoteInflight = {};
  function _dedupeQuote(kind, from, to, amount, producer) {
    var key = kind + '|' + _qkey(from, to || ARC_KEY, amount);
    if (_quoteInflight[key]) return _quoteInflight[key];
    var p = producer();
    _quoteInflight[key] = p;
    function clr() { if (_quoteInflight[key] === p) delete _quoteInflight[key]; }
    p.then(clr, clr);
    return p;
  }

  // Explicit fallback observability (records when the legacy LOCAL path is used).
  function _recordFallback(endpoint, reason, corr) {
    try {
      if (window.TreasuryObs && window.TreasuryObs.record) {
        window.TreasuryObs.record({
          correlationId: corr, endpoint: endpoint, method: 'FALLBACK',
          status: 0, latencyMs: 0, result: 'fallback',
        });
      }
    } catch (e) {}
    _warn('FALLBACK USED →', endpoint, '(' + (reason || 'n/a') + ')');
  }

  // ── Observability sink (ring buffer; NO sensitive data) ────────────────────
  var _obsBuf = [];
  window.TreasuryObs = window.TreasuryObs || {
    record: function (entry) {
      try {
        entry = entry || {};
        _obsBuf.push({
          ts: Date.now(),
          correlationId: entry.correlationId,
          intentId: entry.intentId || null,
          application: 'EXECDAAT',
          endpoint: entry.endpoint,
          method: entry.method,
          status: entry.status,
          latencyMs: entry.latencyMs,
          result: entry.result,
          attempt: entry.attempt,
        });
        if (_obsBuf.length > 300) _obsBuf.shift();
        if (entry.result === 'error') {
          _warn('obs', entry.method, entry.endpoint, entry.status, entry.latencyMs + 'ms', 'corr=' + entry.correlationId);
        }
      } catch (e) {}
    },
    dump: function () { return _obsBuf.slice(); },
    clear: function () { _obsBuf = []; },
  };

  // ── Health state ───────────────────────────────────────────────────────────
  var _health = { ok: false, checkedAt: 0, components: {}, checking: null };

  function _remoteConfigured() {
    return !!(window.TreasuryConfig && window.TreasuryConfig.isRemote());
  }
  // Effective remote = configured (mode REMOTE + backend enabled) AND last health OK.
  function _effectiveRemote() {
    return _remoteConfigured() && _health.ok === true;
  }

  function _checkHealth() {
    if (!window.TreasuryCore || !_remoteConfigured()) {
      _health.ok = false;
      return Promise.resolve(_health);
    }
    if (_health.checking) return _health.checking;
    _health.checking = window.TreasuryCore.health()
      .then(function (h) {
        h = h || {};
        var comp = h.components || h.status || h;
        _health.ok = (h.ok === true) || (String(h.status).toUpperCase() === 'OK') || (String(h.status).toUpperCase() === 'ONLINE') || (comp && comp.treasury);
        _health.components = {
          treasury: _healthVal(comp, ['treasury', 'treasuryEngine', 'core']),
          bridge:   _healthVal(comp, ['bridge', 'bridgeEngine', 'turboBridge']),
          vault:    _healthVal(comp, ['vault']),
          relayer:  _healthVal(comp, ['relayer', 'turboRelayer']),
          circle:   _healthVal(comp, ['circle', 'cctp']),
          rpc:      _healthVal(comp, ['rpc', 'node']),
          workers:  _healthVal(comp, ['workers', 'worker', 'edge']),
        };
        _health.checkedAt = Date.now();
        _health.checking = null;
        _renderHealth();
        return _health;
      })
      .catch(function (e) {
        _health.ok = false;
        _health.checkedAt = Date.now();
        _health.checking = null;
        _renderHealth();
        return _health;
      });
    return _health.checking;
  }

  function _healthVal(comp, keys) {
    if (!comp || typeof comp !== 'object') return null;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (comp[k] !== undefined) {
        var v = comp[k];
        if (typeof v === 'boolean') return v ? 'online' : 'offline';
        if (typeof v === 'object' && v) return (v.status || v.state || (v.ok ? 'online' : 'offline'));
        return String(v);
      }
    }
    return null;
  }

  // ── Quote adapters (remote → existing UI shapes) ───────────────────────────
  // Elligent quote `data` shape:
  //   { asset, amount, bestRoute:{from,to,via}, bridge, provider, feeBps, fee,
  //     receive, slippage, eta:{paymentSeconds,settlementSeconds,display},
  //     liquidityAvailable, sourceChain, destChain }
  function _etaStr(r, route, fallback) {
    var e = r.eta;
    if (e && typeof e === 'object') return _pick(e.display, e.text, fallback);
    return _pick(e, r.estTime, route && route.eta, route && route.estTime, fallback);
  }
  function _provName(r, route, fallback) {
    var p = r.provider;
    if (p && typeof p === 'object') return _pick(p.name, p.id, fallback);
    return _pick(p, route && route.via, route && route.provider, r.bridge, fallback);
  }

  // Standard (ArcBridge) shape.
  function _adaptStandardQuote(remote, opts, intentId) {
    var amount = _num(opts.amount);
    var r = remote || {};
    var route = r.bestRoute || r.route || r.quote || {};
    var receive = _num(_pick(r.receive, r.amountOut, r.output, route.receive, route.amountOut), NaN);
    if (!isFinite(receive)) throw new Error('QUOTE_UNUSABLE');
    var fees = r.fees || route.fees || {};
    var bridgeFee = _num(_pick(fees.bridge, fees.total, r.fee, r.bridgeFee, route.bridgeFee), 0);
    var protoFee = _num(_pick(fees.protocol, r.protocolFee, route.protocolFee), 0);
    var gasFee = _num(_pick(fees.gas, r.gasFeeEst, route.gasFee), 0.02);
    var slippage = _num(_pick(r.slippage, route.slippage), 0);
    return {
      provider: { id: _pick(r.provider && r.provider.id, 'treasury-core'), name: _provName(r, route, 'Treasury Core') },
      routeType: _pick(r.routeType, route.routeType, r.bridge, 'Treasury Route'),
      mode: _pick(r.mode, route.mode, 'standard'),
      finality: _pick(r.finality, route.finality),
      input: amount,
      output: receive,
      bridgeFee: bridgeFee,
      protocolFee: protoFee,
      gasFeeEst: gasFee,
      slippage: slippage,
      minReceived: _num(_pick(r.minReceived, route.minReceived, receive - bridgeFee), receive),
      estTime: _etaStr(r, route, '~15+ min'),
      liquidity: _pick(r.liquidity, r.liquidityAvailable, route.liquidity, 'Treasury'),
      reliability: _pick(r.reliability, 'Very High'),
      score: _num(_pick(r.score, route.score), 10.0),
      expiry: _num(_pick(r.expiry, Date.now() + 60000), Date.now() + 60000),
      _remote: true,
      _intentId: intentId,
      _quoteId: _pick(r.quoteId, route.quoteId),
    };
  }

  // Turbo shape.
  function _adaptTurboQuote(remote, opts, intentId) {
    var amount = _num(opts.amount);
    var r = remote || {};
    var route = r.bestRoute || r.route || r.quote || {};
    var receive = _num(_pick(r.receive, r.amountOut, r.output, route.receive), NaN);
    if (!isFinite(receive)) throw new Error('QUOTE_UNUSABLE');
    var fees = r.fees || route.fees || {};
    var bridgeFee = _num(_pick(fees.bridge, fees.total, r.fee, r.bridgeFee, route.bridgeFee), amount - receive);
    var info = {
      provider: _provName(r, route, 'Turbo Bridge (Treasury Core)'),
      treasury: 'Treasury Core',
      vault: 'Treasury Core',
      contract: 'Treasury Core',
      feeBps: _num(r.feeBps, null),
      reserves: _num(_pick(r.liquidityAvailable, r.reserves), null),
    };
    return {
      provider: { id: 'turbo-bridge', name: _provName(r, route, 'Turbo Bridge') },
      input: amount,
      output: receive,
      bridgeFee: bridgeFee,
      gasFee: _num(_pick(fees.gas, r.gasFeeEst), 0.02),
      protFee: _num(_pick(fees.protocol, r.protocolFee), 0),
      totalCost: bridgeFee,
      slippage: _num(_pick(r.slippage, route.slippage), 0),
      time: _etaStr(r, route, '~8–15 sec'),
      score: _num(_pick(r.score, route.score), 9.9),
      minReceived: receive,
      liquidity: _pick(r.liquidity, r.liquidityAvailable, 'Treasury Pool'),
      reliability: _pick(r.reliability, 'Very High'),
      routeType: _pick(r.routeType, r.bridge, 'Turbo (Treasury/Vault)'),
      expiry: _num(_pick(r.expiry, Date.now() + 60000), Date.now() + 60000),
      _mode: 'turbo',
      _remote: true,
      _intentId: intentId,
      _quoteId: _pick(r.quoteId, route.quoteId),
      _turbo: info,
    };
  }

  // ── Intent status → timeline mapping ───────────────────────────────────────
  function _statusOf(intent) {
    return String((intent && (intent.status || intent.state)) || '').toUpperCase();
  }
  function _hashOf(intent, keys) {
    if (!intent) return null;
    for (var i = 0; i < keys.length; i++) {
      if (intent[keys[i]]) return intent[keys[i]];
    }
    var tx = intent.transactions || intent.hashes || {};
    for (var j = 0; j < keys.length; j++) {
      if (tx[keys[j]]) return tx[keys[j]];
    }
    return null;
  }

  // Map a remote intent snapshot to the ArcBridge onEvent stage sequence.
  function _driveStandardEvents(intent, onEvent, seen) {
    var st = _statusOf(intent);
    var burn = _hashOf(intent, ['sourceTxHash', 'burnTxHash', 'depositTxHash']);
    var mint = _hashOf(intent, ['destinationTxHash', 'mintTxHash', 'settlementTxHash']);
    function once(stage, data) { if (!seen[stage]) { seen[stage] = 1; onEvent(stage, data || {}); } }
    if (['CREATED', 'QUOTED', 'ACCEPTED', 'PENDING', 'EXECUTING'].indexOf(st) !== -1) once('validating');
    if (['SIGNING', 'SIGN_REQUIRED', 'AWAITING_SIGNATURE'].indexOf(st) !== -1) { once('validating'); once('switching_source'); }
    if (['SOURCE_PENDING', 'BURNING', 'SUBMITTED'].indexOf(st) !== -1) { once('switching_source'); once('approved'); if (burn) once('burn_sent', { txHash: burn }); }
    if (['SOURCE_CONFIRMED', 'ATTESTING', 'BRIDGING', 'RELAYING'].indexOf(st) !== -1) { if (burn) once('burn_sent', { txHash: burn }); once('burn_confirmed', { txHash: burn }); once('attesting', {}); }
    if (['DEST_PENDING', 'MINTING', 'SETTLING'].indexOf(st) !== -1) { once('attested'); once('minting'); if (mint) once('mint_sent', { txHash: mint }); }
    if (['SETTLED', 'COMPLETED', 'SUCCESS', 'DONE'].indexOf(st) !== -1) { once('mint_confirmed', { txHash: mint }); once('completed', {}); }
    if (['FAILED', 'ERROR', 'CANCELLED', 'REFUNDED', 'EXPIRED'].indexOf(st) !== -1) once('failed');
    return { burn: burn, mint: mint, status: st };
  }

  // Map a remote intent snapshot to the Turbo onStep(n) sequence.
  function _driveTurboSteps(intent, onStep, seen) {
    var st = _statusOf(intent);
    function once(n) { if (!seen['s' + n]) { seen['s' + n] = 1; onStep(n, st); } }
    if (['CREATED', 'QUOTED', 'ACCEPTED', 'EXECUTING', 'SIGNING'].indexOf(st) !== -1) once(0);
    if (['SOURCE_PENDING', 'BURNING', 'SUBMITTED'].indexOf(st) !== -1) { once(0); once(1); }
    if (['SOURCE_CONFIRMED', 'ATTESTING', 'BRIDGING', 'FULFILLING'].indexOf(st) !== -1) { once(1); once(2); once(3); }
    if (['DEST_PENDING', 'SETTLING', 'FULFILLED'].indexOf(st) !== -1) { once(3); }
    if (['SETTLED', 'COMPLETED', 'SUCCESS', 'DONE'].indexOf(st) !== -1) { once(3); once(4); }
    return { status: st, txHash: _hashOf(intent, ['sourceTxHash', 'burnTxHash', 'txHash']) };
  }

  // ── Remote execution (standard) — mirrors ArcBridge.execute contract ───────
  function _remoteExecuteStandard(opts) {
    var onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : function () {};
    var corr = (window.TreasuryConfig && window.TreasuryConfig.newCorrelationId()) || undefined;
    var wallet = opts.recipient || (window.walletState && window.walletState.address);
    var intentId = opts._intentId || (opts.quote && opts.quote._intentId);
    onEvent('validating', {});

    var ensureIntent = intentId
      ? Promise.resolve(intentId)
      : window.TreasuryCore.createIntent({
          sourceChain: opts.from, destinationChain: opts.to, token: 'USDC',
          amount: opts.amount, wallet: wallet, recipient: wallet,
        }, corr).then(function (r) { return r.intentId || (r.intent && r.intent.id); });

    return ensureIntent.then(function (iid) {
      if (!iid) throw new Error('NO_INTENT');
      return window.TreasuryCore.execute({ intentId: iid, wallet: wallet }, corr).then(function () {
        var seen = {};
        return window.TreasuryCore.pollIntent(iid, {
          correlationId: corr,
          onUpdate: function (intent) { _driveStandardEvents(intent, onEvent, seen); },
        }).then(function (finalIntent) {
          var res = _driveStandardEvents(finalIntent, onEvent, seen);
          if (['FAILED', 'ERROR', 'CANCELLED', 'REFUNDED', 'EXPIRED'].indexOf(res.status) !== -1) {
            throw new Error('Treasury settlement did not complete.');
          }
          return { burnTxHash: res.burn, mintTxHash: res.mint, intentId: iid, mode: 'standard', _remote: true };
        });
      });
    });
  }

  // ── Remote execution (turbo) — mirrors TurboBridge.execute contract ────────
  function _remoteExecuteTurbo(opts) {
    var onStep = typeof opts.onStep === 'function' ? opts.onStep : function () {};
    var corr = (window.TreasuryConfig && window.TreasuryConfig.newCorrelationId()) || undefined;
    var wallet = opts.recipient || (window.walletState && window.walletState.address);
    var from = opts.from, to = opts.to || ARC_KEY;
    var intentId = opts._intentId;

    var ensureIntent = intentId
      ? Promise.resolve(intentId)
      : window.TreasuryCore.createIntent({
          sourceChain: from, destinationChain: to, token: 'USDC',
          amount: opts.amount, wallet: wallet, recipient: wallet,
        }, corr).then(function (r) { return r.intentId || (r.intent && r.intent.id); });

    return ensureIntent.then(function (iid) {
      if (!iid) throw new Error('NO_INTENT');
      return window.TreasuryCore.execute({ intentId: iid, wallet: wallet }, corr).then(function () {
        var seen = {};
        return window.TreasuryCore.pollIntent(iid, {
          correlationId: corr,
          onUpdate: function (intent) { _driveTurboSteps(intent, onStep, seen); },
        }).then(function (finalIntent) {
          var res = _driveTurboSteps(finalIntent, onStep, seen);
          if (['FAILED', 'ERROR', 'CANCELLED', 'REFUNDED', 'EXPIRED'].indexOf(res.status) !== -1) {
            throw new Error('Treasury settlement did not complete.');
          }
          return { txHash: res.txHash, intentId: iid, mode: 'turbo', _remote: true };
        });
      });
    });
  }

  // ── Wrap ArcBridge (standard path) ─────────────────────────────────────────
  function _wrapArcBridge() {
    var AB = window.ArcBridge;
    if (!AB || AB.__treasuryWrapped) return;
    var _localGetQuote = AB.getQuote.bind(AB);
    var _localExecute = AB.execute.bind(AB);
    AB.__treasuryLocalGetQuote = _localGetQuote;
    AB.__treasuryLocalExecute = _localExecute;

    AB.getQuote = function (opts) {
      if (!_effectiveRemote()) return _localGetQuote(opts);
      var corr = (window.TreasuryConfig && window.TreasuryConfig.newCorrelationId()) || undefined;
      var wallet = (window.walletState && window.walletState.address);
      // Create intent (source of truth), then fetch remote quote (deduped).
      return _dedupeQuote('std', opts.from, opts.to, opts.amount, function () {
        return window.TreasuryCore.createIntent({
          sourceChain: opts.from, destinationChain: opts.to, token: 'USDC',
          amount: opts.amount, wallet: wallet, recipient: wallet,
        }, corr).then(function (ci) {
          var iid = ci.intentId || (ci.intent && ci.intent.id);
          return window.TreasuryCore.quote({
            intentId: iid, sourceChain: opts.from, destinationChain: opts.to,
            token: 'USDC', amount: opts.amount, wallet: wallet,
          }, corr).then(function (rq) {
            _quoteCache = { key: _qkey(opts.from, opts.to, opts.amount), intentId: iid, turboQuote: null };
            return _adaptStandardQuote(rq, opts, iid);
          });
        });
      }).catch(function (e) {
        _recordFallback('/api/core/v1/quote', e && (e.friendly || e.message), corr);
        return _localGetQuote(opts);
      });
    };

    AB.execute = function (opts) {
      if (!_effectiveRemote()) return _localExecute(opts);
      var q = opts && opts.quote;
      var intentId = (q && q._intentId) || opts._intentId || _cachedIntentFor(opts.from, opts.to, opts.amount);
      return _remoteExecuteStandard(Object.assign({}, opts, { _intentId: intentId }))
        .catch(function (e) {
          // Fall back ONLY if nothing on-chain has started (pre-signature error).
          if (e && (e.code === 'NO_INTENT' || e.transient || e.code === 'UNAVAILABLE' || e.code === 'TIMEOUT' || e.code === 'DISABLED')) {
            _recordFallback('/api/core/v1/execute', e.friendly || e.message);
            return _localExecute(opts);
          }
          throw e;
        });
    };

    AB.__treasuryWrapped = true;
    _log('ArcBridge wrapped (remote-aware, local fallback)');
  }

  // ── Wrap TurboBridge (turbo path) ──────────────────────────────────────────
  function _wrapTurboBridge() {
    var TB = window.TurboBridge;
    if (!TB || TB.__treasuryWrapped) return;
    var _localGetQuote = TB.getQuote.bind(TB);
    var _localExecute = TB.execute.bind(TB);
    var _localIsAvailable = TB.isAvailable.bind(TB);
    TB.__treasuryLocalGetQuote = _localGetQuote;
    TB.__treasuryLocalExecute = _localExecute;
    TB.__treasuryLocalIsAvailable = _localIsAvailable;

    // Availability: in effective remote, fetch the remote intent+quote here
    // (this method IS awaited by the UI) and cache the adapted Turbo quote so
    // the synchronous getQuote() below can return it without breaking the
    // existing call contract. Any failure → local availability check.
    TB.isAvailable = function (fromKey, amount) {
      if (!_effectiveRemote()) return _localIsAvailable(fromKey, amount);
      var corr = (window.TreasuryConfig && window.TreasuryConfig.newCorrelationId()) || undefined;
      var wallet = (window.walletState && window.walletState.address);
      var to = ARC_KEY;
      return _dedupeQuote('turbo', fromKey, to, amount, function () {
        return window.TreasuryCore.createIntent({
          sourceChain: fromKey, destinationChain: to, token: 'USDC',
          amount: amount, wallet: wallet, recipient: wallet,
        }, corr).then(function (ci) {
          var iid = ci.intentId || (ci.intent && ci.intent.id);
          return window.TreasuryCore.quote({
            intentId: iid, sourceChain: fromKey, destinationChain: to,
            token: 'USDC', amount: amount, wallet: wallet,
          }, corr).then(function (rq) {
            var tq = _adaptTurboQuote(rq, { from: fromKey, to: to, amount: amount }, iid);
            _quoteCache = { key: _qkey(fromKey, to, amount), intentId: iid, turboQuote: tq };
            return { available: true, reserves: null, info: tq._turbo };
          });
        });
      }).catch(function (e) {
        _recordFallback('/api/core/v1/quote (turbo)', e && (e.friendly || e.message), corr);
        return _localIsAvailable(fromKey, amount);
      });
    };

    // getQuote MUST stay synchronous (the UI does not await it). Return the
    // quote already fetched by isAvailable(); otherwise fall back to local.
    TB.getQuote = function (opts) {
      if (_effectiveRemote()) {
        var k = _qkey(opts.from, opts.to || ARC_KEY, opts.amount);
        if (_quoteCache.key === k && _quoteCache.turboQuote) return _quoteCache.turboQuote;
      }
      return _localGetQuote(opts);
    };

    TB.execute = function (opts) {
      if (!_effectiveRemote()) return _localExecute(opts);
      var intentId = opts._intentId || (opts.quote && opts.quote._intentId) || _cachedIntentFor(opts.from, opts.to, opts.amount);
      return _remoteExecuteTurbo(Object.assign({}, opts, { _intentId: intentId }))
        .catch(function (e) {
          if (e && (e.code === 'NO_INTENT' || e.transient || e.code === 'UNAVAILABLE' || e.code === 'TIMEOUT' || e.code === 'DISABLED')) {
            _recordFallback('/api/core/v1/execute (turbo)', e.friendly || e.message);
            return _localExecute(opts);
          }
          throw e;
        });
    };

    TB.__treasuryWrapped = true;
    _log('TurboBridge wrapped (remote-aware, local fallback)');
  }

  // ── Remote history / metrics / applications providers (local fallback) ─────
  window.TreasuryData = {
    history: function (filters) {
      if (!_effectiveRemote() || !window.TreasuryCore) return Promise.resolve(null);
      return window.TreasuryCore.history(filters).then(function (r) {
        return (r && (r.items || r.history || r.data)) || r || null;
      }).catch(function () { return null; });
    },
    metrics: function (filters) {
      if (!_effectiveRemote() || !window.TreasuryCore) return Promise.resolve(null);
      return window.TreasuryCore.metrics(filters).then(function (r) {
        return (r && (r.metrics || r.data)) || r || null;
      }).catch(function () { return null; });
    },
    applications: function () {
      if (!_effectiveRemote() || !window.TreasuryCore) return Promise.resolve(null);
      return window.TreasuryCore.applications().then(function (r) {
        return (r && (r.applications || r.items || r.data)) || r || null;
      }).catch(function () { return null; });
    },
    isRemote: _effectiveRemote,
    health: function () { return Object.assign({}, _health); },
  };

  // ── Discrete health indicator (only shown when remote is enabled) ──────────
  var _hEl = null;
  function _ensureHealthEl() {
    if (_hEl || typeof document === 'undefined') return _hEl;
    var el = document.createElement('div');
    el.id = 'treasury-health-indicator';
    el.style.cssText = [
      'position:fixed', 'bottom:14px', 'right:14px', 'z-index:9998',
      'display:none', 'align-items:center', 'gap:8px',
      'background:rgba(15,23,42,.92)', 'border:1px solid #1f2937', 'border-radius:999px',
      'padding:6px 12px', 'font:600 11px/1 system-ui,sans-serif', 'color:#cbd5e1',
      'box-shadow:0 4px 18px rgba(0,0,0,.35)', 'cursor:default', 'user-select:none',
      'backdrop-filter:blur(6px)',
    ].join(';');
    el.innerHTML =
      '<span id="thi-dot" style="width:8px;height:8px;border-radius:50%;background:#6b7280;box-shadow:0 0 6px rgba(107,114,128,.8)"></span>' +
      '<span id="thi-label">Treasury</span>' +
      '<div id="thi-panel" style="display:none;position:absolute;bottom:130%;right:0;min-width:180px;background:#0b1220;border:1px solid #1f2937;border-radius:10px;padding:10px 12px;box-shadow:0 8px 24px rgba(0,0,0,.4)"></div>';
    el.addEventListener('mouseenter', function () { var p = document.getElementById('thi-panel'); if (p) p.style.display = 'block'; });
    el.addEventListener('mouseleave', function () { var p = document.getElementById('thi-panel'); if (p) p.style.display = 'none'; });
    (document.body || document.documentElement).appendChild(el);
    _hEl = el;
    return el;
  }

  function _renderHealth() {
    try {
      // Only surface the indicator when the remote path is configured — keeps
      // the legacy (LOCAL) UX untouched.
      if (!_remoteConfigured()) { if (_hEl) _hEl.style.display = 'none'; return; }
      var el = _ensureHealthEl();
      if (!el) return;
      el.style.display = 'inline-flex';
      var dot = document.getElementById('thi-dot');
      var label = document.getElementById('thi-label');
      var color = _health.ok ? '#22c55e' : (_health.checkedAt ? '#ef4444' : '#6b7280');
      if (dot) { dot.style.background = color; dot.style.boxShadow = '0 0 6px ' + color; }
      if (label) label.textContent = _health.ok ? 'Treasury Online' : (_health.checkedAt ? 'Treasury Offline' : 'Treasury…');
      var panel = document.getElementById('thi-panel');
      if (panel) {
        var rows = [
          ['Treasury', _health.components.treasury],
          ['Bridge Engine', _health.components.bridge],
          ['Vault', _health.components.vault],
          ['Relayer', _health.components.relayer],
          ['Circle', _health.components.circle],
          ['RPC', _health.components.rpc],
          ['Workers', _health.components.workers],
        ];
        panel.innerHTML = rows.map(function (r) {
          var v = r[1];
          var ok = v && /online|ok|up|healthy|true/i.test(String(v));
          var c = v == null ? '#6b7280' : (ok ? '#22c55e' : '#ef4444');
          return '<div style="display:flex;align-items:center;justify-content:space-between;gap:14px;padding:3px 0;font:600 11px/1.4 system-ui">' +
            '<span style="color:#94a3b8">' + r[0] + '</span>' +
            '<span style="display:inline-flex;align-items:center;gap:6px;color:#cbd5e1">' +
            '<span style="width:7px;height:7px;border-radius:50%;background:' + c + '"></span>' +
            (v == null ? '—' : String(v)) + '</span></div>';
        }).join('');
      }
    } catch (e) {}
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────────
  var _healthTimer = null;
  function _boot() {
    // Install wrappers immediately. They are pure pass-through until the config
    // + health confirm effective REMOTE, so this can never regress the UX.
    _wrapArcBridge();
    _wrapTurboBridge();
    var cfgP = (window.TreasuryConfig && window.TreasuryConfig.load()) || Promise.resolve();
    cfgP.then(function () {
      // Bridges may have loaded after the first wrap attempt — re-wrap safely.
      _wrapArcBridge();
      _wrapTurboBridge();
      if (_remoteConfigured()) {
        _checkHealth();
        if (!_healthTimer) _healthTimer = setInterval(_checkHealth, 30000);
      } else {
        _renderHealth(); // stays hidden in LOCAL mode
        _log('LOCAL mode (or remote not configured) — legacy path active, wrappers are pass-through');
      }
    });
  }

  // Wrap as soon as bridges exist; retry briefly if scripts load out of order.
  var _tries = 0;
  function _readyTick() {
    _tries++;
    if (window.ArcBridge || window.TurboBridge) { _boot(); return; }
    if (_tries < 40) setTimeout(_readyTick, 100);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _readyTick);
  } else {
    _readyTick();
  }

  window.TreasuryIntegration = {
    VERSION: '20260705b',
    effectiveRemote: _effectiveRemote,
    checkHealth: _checkHealth,
    health: function () { return Object.assign({}, _health); },
    rewrap: function () { _wrapArcBridge(); _wrapTurboBridge(); },
  };

  _log('integration loaded');
})();
