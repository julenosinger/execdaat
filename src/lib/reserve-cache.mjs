// ============================================================
// Verified Reserve Cache — SimpleAMM (EURC/USDC)
// ============================================================
// Phase 1 hardening:
//   • Cache is ONLY written after a successful on-chain read
//     (getReserves + totalSupply + blockNumber).
//   • A failed RPC read NEVER overwrites a valid cache.
//   • TTL 15s: fresh cache → source 'cache' is still honest
//     (last verified data + cacheAge exposed to callers).
//   • No cache + RPC down → throws RPC_UNAVAILABLE.
//     Reserves are NEVER fabricated.
// ============================================================

export const RESERVE_CACHE_TTL_MS = 15_000;

const GET_RESERVES_SELECTOR = '0x0902f1ac'; // getReserves()
const TOTAL_SUPPLY_SELECTOR = '0x18160ddd'; // totalSupply()

export function decodeUint256Word(hex, wordIdx = 0) {
  if (typeof hex !== 'string' || hex === '0x' || hex.length < 3) {
    throw new Error(`Malformed eth_call result: ${String(hex)}`);
  }
  const s = hex.replace(/^0x/, '');
  const word = s.slice(wordIdx * 64, wordIdx * 64 + 64);
  if (word.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(word)) {
    throw new Error(`Malformed uint256 word ${wordIdx} in: ${hex.slice(0, 20)}…`);
  }
  return BigInt('0x' + word);
}

export function createReserveCache(options) {
  const { rpcClient, ammAddress } = options;
  if (!rpcClient || !ammAddress) throw new Error('reserve-cache: rpcClient and ammAddress are required');
  const ttlMs = options.ttlMs != null ? options.ttlMs : RESERVE_CACHE_TTL_MS;
  const now = options.now || (() => Date.now());
  const log = options.log || ((fields) => {
    try {
      console.log(JSON.stringify(
        { ts: new Date().toISOString(), mod: 'reserve-cache', ...fields },
        (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
      ));
    } catch (_) { /* noop */ }
  });

  // Last VERIFIED on-chain snapshot. Only mutated on successful reads.
  let snapshot = null;

  function cacheView(source) {
    return {
      reserveA: snapshot.reserveA,
      reserveB: snapshot.reserveB,
      totalSupply: snapshot.totalSupply,
      blockNumber: snapshot.blockNumber,
      timestamp: snapshot.timestamp,
      lastSuccessfulFetch: snapshot.lastSuccessfulFetch,
      source,
      cacheAge: Math.max(0, now() - snapshot.lastSuccessfulFetch),
    };
  }

  async function fetchFresh() {
    const started = now();
    const [reservesHex, supplyHex, blockHex] = await Promise.all([
      rpcClient.ethCall(ammAddress, GET_RESERVES_SELECTOR),
      rpcClient.ethCall(ammAddress, TOTAL_SUPPLY_SELECTOR),
      rpcClient.call('eth_blockNumber', []),
    ]);

    const reserveA = decodeUint256Word(reservesHex, 0);
    const reserveB = decodeUint256Word(reservesHex, 1);
    const totalSupply = decodeUint256Word(supplyHex, 0);
    const blockNumber = Number(BigInt(blockHex));

    if (reserveA < 0n || reserveB < 0n) throw new Error('Invalid negative reserves');

    // Only NOW (after a fully successful, decoded read) update the cache.
    snapshot = {
      reserveA,
      reserveB,
      totalSupply,
      blockNumber,
      timestamp: now(),
      lastSuccessfulFetch: now(),
      source: 'on-chain',
    };

    log({
      evt: 'reserves_fetched', ok: true, blockNumber,
      reserveA: reserveA.toString(), reserveB: reserveB.toString(),
      totalSupply: totalSupply.toString(), latencyMs: now() - started,
    });

    return cacheView('on-chain');
  }

  async function getReserves() {
    // Fresh cache → serve as 'cache' hit (honest: verified data + age).
    if (snapshot && now() - snapshot.lastSuccessfulFetch < ttlMs) {
      log({ evt: 'cache_hit', cacheAge: now() - snapshot.lastSuccessfulFetch, blockNumber: snapshot.blockNumber });
      return cacheView('cache');
    }

    log({ evt: 'cache_miss', hasStale: !!snapshot });

    try {
      return await fetchFresh();
    } catch (err) {
      // RPC failed. NEVER fabricate. Serve last verified cache if it exists.
      if (snapshot) {
        log({
          evt: 'rpc_failed_serving_stale_cache',
          cacheAge: now() - snapshot.lastSuccessfulFetch,
          error: String((err && err.message) || err),
        });
        return cacheView('cache');
      }
      log({ evt: 'rpc_failed_no_cache', error: String((err && err.message) || err) });
      const error = new Error('Unable to fetch on-chain reserves.');
      error.code = 'RPC_UNAVAILABLE';
      throw error;
    }
  }

  return {
    getReserves,
    invalidate: () => { if (snapshot) snapshot.lastSuccessfulFetch = 0; },
    peek: () => (snapshot ? cacheView('cache') : null),
  };
}
