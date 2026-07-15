// ============================================================
// Arc RPC Client — multi-endpoint failover
// ============================================================
// Phase 1 hardening:
//   • Primary → Secondary → Tertiary → ... → structured error
//   • Per-attempt timeout
//   • Retry with exponential backoff per endpoint
//   • Structured JSON logging for every attempt
//   • Never fabricates data: on total failure throws an Error
//     with code = 'RPC_UNAVAILABLE'
//
// Zero dependencies. Runs in Cloudflare Workers and Node (tests).
// All collaborators (fetch, sleep, clock, logger) are injectable
// for deterministic unit testing.
// ============================================================

export const ARC_RPC_URLS = [
  'https://rpc.testnet.arc.network',
  'https://rpc.blockdaemon.testnet.arc.network',
  'https://rpc.drpc.testnet.arc.network',
  'https://rpc.quicknode.testnet.arc.network',
];

function defaultLog(fields) {
  try {
    console.log(JSON.stringify(
      { ts: new Date().toISOString(), mod: 'arc-rpc', ...fields },
      (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
    ));
  } catch (_) { /* logging must never throw */ }
}

export function createRpcClient(options = {}) {
  const rpcs = (options.rpcs && options.rpcs.length) ? options.rpcs.slice() : ARC_RPC_URLS.slice();
  const fetchFn = options.fetchFn || ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs != null ? options.timeoutMs : 5000;
  const retriesPerEndpoint = Math.max(1, options.retriesPerEndpoint != null ? options.retriesPerEndpoint : 2);
  const backoffBaseMs = options.backoffBaseMs != null ? options.backoffBaseMs : 150;
  const log = options.log || defaultLog;
  const sleepFn = options.sleepFn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now || (() => Date.now());

  let idCounter = 0;

  function makeAbortSignal() {
    try {
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        return AbortSignal.timeout(timeoutMs);
      }
    } catch (_) { /* older runtimes */ }
    return undefined;
  }

  async function fetchWithTimeout(url, body) {
    let timer = null;
    const timeoutPromise = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`RPC timeout after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      return await Promise.race([
        fetchFn(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: makeAbortSignal(),
        }),
        timeoutPromise,
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  async function call(method, params = []) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: ++idCounter, method, params });
    let lastError = null;

    for (let endpointIdx = 0; endpointIdx < rpcs.length; endpointIdx++) {
      const rpc = rpcs[endpointIdx];
      for (let attempt = 1; attempt <= retriesPerEndpoint; attempt++) {
        const started = now();
        try {
          const res = await fetchWithTimeout(rpc, body);
          if (!res || res.ok === false) {
            throw new Error(`HTTP ${res ? res.status : 'no-response'}`);
          }
          const json = await res.json();
          if (json && json.error) {
            throw new Error(`RPC error ${json.error.code}: ${json.error.message}`);
          }
          log({ evt: 'rpc_call', ok: true, rpc, method, attempt, latencyMs: now() - started });
          return json ? json.result : undefined;
        } catch (err) {
          lastError = err;
          log({
            evt: 'rpc_call', ok: false, rpc, method, attempt,
            latencyMs: now() - started,
            error: String((err && err.message) || err),
          });
          if (attempt < retriesPerEndpoint) {
            await sleepFn(backoffBaseMs * (2 ** (attempt - 1)));
          }
        }
      }
    }

    const error = new Error(
      `All ${rpcs.length} RPC endpoints failed for ${method}: ${lastError ? lastError.message : 'unknown error'}`,
    );
    error.code = 'RPC_UNAVAILABLE';
    throw error;
  }

  return {
    call,
    ethCall: (to, data) => call('eth_call', [{ to, data }, 'latest']),
    endpoints: () => rpcs.slice(),
  };
}
