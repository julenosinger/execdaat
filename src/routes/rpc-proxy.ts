// ============================================================
// /api/rpc — Same-origin Arc RPC Proxy (reads + raw broadcast)
// ============================================================
// Fixes: browser/wallet traffic hitting rate-limited public Arc
// RPC endpoints directly ("request limit reached").
//   • Multi-endpoint failover (primary → blockdaemon → drpc →
//     quicknode) with timeout + backoff, server-side.
//   • Supports single AND batched JSON-RPC payloads (ethers v6
//     batches by default).
//   • Method whitelist: read-only calls + eth_sendRawTransaction
//     (raw broadcast only — the worker never signs anything).
//   • Upstream JSON-RPC errors are forwarded verbatim, EXCEPT
//     rate-limit errors, which trigger failover to the next RPC.
//   • No keys, no secrets, no state.
// ============================================================

import { Hono } from 'hono';
import { ARC_RPC_URLS } from '../lib/arc-rpc.mjs';
import { validateRpcPayload, isRateLimitError, buildErrorResponse } from '../lib/rpc-proxy-core.mjs';

const rpcProxyRouter = new Hono();

const UPSTREAM_TIMEOUT_MS = 10_000;
const BACKOFF_MS = 150;

// ── Micro-cache (request-optimization) ──────────────────────
// Coalesces identical cheap idempotent reads across concurrent
// clients. ONLY slow-moving, non-account-specific methods are
// cached — never eth_call / balances / receipts / broadcasts.
const MICRO_CACHE_TTL: Record<string, number> = {
  eth_blockNumber: 4_000,
  eth_gasPrice: 10_000,
  eth_chainId: 600_000,
  net_version: 600_000,
};
const _microCache = new Map<string, { result: unknown; at: number }>();

function microKey(method: string, params: unknown): string {
  return method + ':' + JSON.stringify(params ?? []);
}

function slog(fields: Record<string, unknown>): void {
  try {
    console.log(JSON.stringify(
      { ts: new Date().toISOString(), mod: 'rpc-proxy', ...fields },
      (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
    ));
  } catch (_) { /* noop */ }
}

async function fetchWithTimeout(url: string, body: string): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_r, reject) => {
    timer = setTimeout(() => reject(new Error(`upstream timeout after ${UPSTREAM_TIMEOUT_MS}ms`)), UPSTREAM_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }),
      timeout,
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

rpcProxyRouter.post('/', async (c) => {
  const started = Date.now();
  let body: unknown;
  try {
    body = await c.req.json();
  } catch (_) {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }

  const validation = validateRpcPayload(body);
  if (!validation.ok) {
    slog({ evt: 'rpc_proxy_rejected', code: validation.code, reason: validation.message });
    const items = validation.items || [{}];
    const status = validation.code === -32601 ? 403 : 400;
    return c.json(buildErrorResponse(items, validation.isBatch, validation.code!, validation.message!) as object, status);
  }

  const { items, methods, isBatch } = validation as { items: Array<{ id?: unknown }>; methods: string[]; isBatch: boolean };
  const raw = JSON.stringify(body);
  let lastError = 'unknown';

  // Micro-cache hit (single, whitelisted method only)
  if (!isBatch && methods.length === 1 && MICRO_CACHE_TTL[methods[0]]) {
    const req0 = items[0] as { id?: unknown; params?: unknown };
    const key = microKey(methods[0], req0.params);
    const hit = _microCache.get(key);
    if (hit && (Date.now() - hit.at) < MICRO_CACHE_TTL[methods[0]]) {
      slog({ evt: 'rpc_proxy_cache_hit', method: methods[0], ageMs: Date.now() - hit.at });
      return c.json({ jsonrpc: '2.0', id: req0.id ?? null, result: hit.result });
    }
  }

  for (let i = 0; i < ARC_RPC_URLS.length; i++) {
    const rpc = ARC_RPC_URLS[i];
    const attemptStarted = Date.now();
    try {
      const res = await fetchWithTimeout(rpc, raw);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();

      // Rate-limited at the JSON-RPC layer → try the next endpoint
      if (isRateLimitError(json)) throw new Error('upstream rate limit');

      // Populate micro-cache (single whitelisted method, successful result only)
      if (!isBatch && methods.length === 1 && MICRO_CACHE_TTL[methods[0]]) {
        const j0 = json as { result?: unknown; error?: unknown };
        if (j0 && j0.result !== undefined && !j0.error) {
          if (_microCache.size > 100) _microCache.clear();
          _microCache.set(microKey(methods[0], (items[0] as { params?: unknown }).params), { result: j0.result, at: Date.now() });
        }
      }

      slog({
        evt: 'rpc_proxy_forwarded', ok: true, rpc, batch: isBatch,
        count: items.length, methods: methods.slice(0, 5).join(','),
        latencyMs: Date.now() - attemptStarted, totalMs: Date.now() - started,
      });
      return c.json(json as object);
    } catch (err) {
      lastError = String((err as Error)?.message || err);
      slog({
        evt: 'rpc_proxy_forwarded', ok: false, rpc,
        methods: methods.slice(0, 5).join(','),
        latencyMs: Date.now() - attemptStarted, error: lastError,
      });
      if (i < ARC_RPC_URLS.length - 1) {
        await new Promise((r) => setTimeout(r, BACKOFF_MS * (i + 1)));
      }
    }
  }

  slog({ evt: 'rpc_proxy_unavailable', methods: methods.join(','), totalMs: Date.now() - started });
  return c.json(
    buildErrorResponse(items, isBatch, -32000, `All Arc RPC endpoints unavailable: ${lastError}`) as object,
    503,
  );
});

export default rpcProxyRouter;
