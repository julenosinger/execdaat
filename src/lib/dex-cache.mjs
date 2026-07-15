// ============================================================
// DEX Cache Engine — verified pool snapshots (Phase 2 Part 2)
// ============================================================
//   • Single verified snapshot per TTL window (15s default):
//       reserveA, reserveB, totalSupply, blockNumber, timestamp,
//       balanceA/balanceB (donation detection), TVL, priceRatio,
//       source, cacheAge.
//   • Cache is ONLY written after: successful RPC fetch AND
//     successful decoding AND a valid block number.
//   • RPC failures NEVER overwrite a valid cache entry:
//     stale snapshots are served as source='cache'.
//   • No cache + RPC down → throws code='RPC_UNAVAILABLE'.
//     Zero/fabricated liquidity is never returned.
// ============================================================

import { calcPriceRatio, calcTvl, calcReserveRatio, detectDonations } from './dex-metrics.mjs';

export const DEX_CACHE_TTL_MS = 15_000;

const SEL_GET_RESERVES = '0x0902f1ac'; // getReserves()
const SEL_TOTAL_SUPPLY = '0x18160ddd'; // totalSupply()
const SEL_BALANCE_OF   = '0x70a08231'; // balanceOf(address)

function padAddress(addr) {
  return String(addr).replace(/^0x/, '').toLowerCase().padStart(64, '0');
}

export function decodeWord(hex, wordIdx = 0) {
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

export function createDexCache(options) {
  const { rpcClient, eurcAddress, usdcAddress } = options;
  if (!rpcClient || !options.ammAddress || !eurcAddress || !usdcAddress) {
    throw new Error('dex-cache: rpcClient, ammAddress, eurcAddress and usdcAddress are required');
  }
  const ammAddressOf = typeof options.ammAddress === 'function'
    ? options.ammAddress
    : () => options.ammAddress;
  const ttlMs = options.ttlMs != null ? options.ttlMs : DEX_CACHE_TTL_MS;
  const now = options.now || (() => Date.now());
  const log = options.log || ((fields) => {
    try {
      console.log(JSON.stringify(
        { ts: new Date().toISOString(), mod: 'dex-cache', ...fields },
        (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
      ));
    } catch (_) { /* noop */ }
  });

  // Last VERIFIED snapshot — only mutated after a fully successful read.
  let snapshot = null;
  // Immutable-after-first-read extras (lazy, best-effort)
  let minimumLiquidity = null;

  function view(source) {
    return {
      ...snapshot,
      source,
      cacheAge: Math.max(0, now() - snapshot.fetchedAt),
    };
  }

  async function fetchFresh() {
    const started = now();
    const amm = ammAddressOf();
    const [reservesHex, supplyHex, balAHex, balBHex, blockHex] = await Promise.all([
      rpcClient.ethCall(amm, SEL_GET_RESERVES),
      rpcClient.ethCall(amm, SEL_TOTAL_SUPPLY),
      rpcClient.ethCall(eurcAddress, SEL_BALANCE_OF + padAddress(amm)),
      rpcClient.ethCall(usdcAddress, SEL_BALANCE_OF + padAddress(amm)),
      rpcClient.call('eth_blockNumber', []),
    ]);

    const reserveA = decodeWord(reservesHex, 0);
    const reserveB = decodeWord(reservesHex, 1);
    const totalSupply = decodeWord(supplyHex, 0);
    const balanceA = decodeWord(balAHex, 0);
    const balanceB = decodeWord(balBHex, 0);
    const blockNumber = Number(BigInt(blockHex));

    if (!Number.isFinite(blockNumber) || blockNumber <= 0) {
      throw new Error(`Invalid block number: ${blockHex}`);
    }

    const t = now();
    const priceRatio = calcPriceRatio(reserveA, reserveB);
    const tvl = calcTvl(reserveA, reserveB);
    const donation = detectDonations({
      reserveA, reserveB, balanceA, balanceB,
      blockNumber, timestamp: new Date(t).toISOString(),
    });

    // Only NOW — everything fetched, decoded and validated — update cache.
    snapshot = {
      ammAddress: amm,
      reserveA, reserveB, totalSupply,
      balanceA, balanceB,
      blockNumber,
      timestamp: t,
      lastSuccessfulFetch: t,
      fetchedAt: t,
      tvl,
      priceRatio,
      reserveRatio: calcReserveRatio(reserveA, reserveB),
      donation,
    };

    log({
      evt: 'dex_reserves_fetched', ok: true, blockNumber,
      reserveA, reserveB, totalSupply, tvl,
      donationStatus: donation.status,
      latencyMs: now() - started,
    });

    return view('on-chain');
  }

  async function getSnapshot() {
    if (snapshot && now() - snapshot.fetchedAt < ttlMs) {
      log({ evt: 'dex_cache_hit', cacheAge: now() - snapshot.fetchedAt, blockNumber: snapshot.blockNumber });
      return view('cache');
    }

    log({ evt: 'dex_cache_miss', hasStale: !!snapshot });

    try {
      return await fetchFresh();
    } catch (err) {
      if (snapshot) {
        log({
          evt: 'dex_rpc_failed_serving_stale_cache',
          cacheAge: now() - snapshot.fetchedAt,
          error: String((err && err.message) || err),
        });
        return view('cache');
      }
      log({ evt: 'dex_rpc_failed_no_cache', error: String((err && err.message) || err) });
      const error = new Error('Unable to fetch on-chain reserves.');
      error.code = 'RPC_UNAVAILABLE';
      throw error;
    }
  }

  /** balanceOf(address(0)) — locked MINIMUM_LIQUIDITY. Constant after genesis; fetched once. */
  async function getMinimumLiquidity() {
    if (minimumLiquidity !== null) return minimumLiquidity;
    const hex = await rpcClient.ethCall(ammAddressOf(), SEL_BALANCE_OF + '0'.repeat(64));
    minimumLiquidity = decodeWord(hex, 0);
    return minimumLiquidity;
  }

  return {
    getSnapshot,
    getMinimumLiquidity,
    invalidate: () => { if (snapshot) snapshot.fetchedAt = 0; },
    peek: () => (snapshot ? view('cache') : null),
  };
}
