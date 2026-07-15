// ============================================================
// RPC Proxy Core — validation helpers for /api/rpc (pure)
// ============================================================

export const ALLOWED_RPC_METHODS = new Set([
  'eth_chainId', 'net_version', 'web3_clientVersion',
  'eth_blockNumber', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory',
  'eth_call', 'eth_estimateGas',
  'eth_getBalance', 'eth_getCode', 'eth_getStorageAt',
  'eth_getBlockByNumber', 'eth_getBlockByHash',
  'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getTransactionCount',
  'eth_getLogs',
  'eth_sendRawTransaction',
]);

export const MAX_RPC_BATCH = 50;

/**
 * Validates a JSON-RPC payload (single object or batch array).
 * Returns { ok:true, items, methods, isBatch } or { ok:false, code, message }.
 */
export function validateRpcPayload(body) {
  const isBatch = Array.isArray(body);
  const items = isBatch ? body : [body];

  if (items.length === 0 || items.length > MAX_RPC_BATCH) {
    return { ok: false, code: -32600, message: `Invalid batch size (max ${MAX_RPC_BATCH})`, isBatch };
  }

  const methods = [];
  for (const item of items) {
    const method = item && typeof item.method === 'string' ? item.method : '';
    if (!ALLOWED_RPC_METHODS.has(method)) {
      return {
        ok: false,
        code: -32601,
        message: `Method not allowed by proxy: ${method || '(missing)'}`,
        isBatch,
        items,
      };
    }
    methods.push(method);
  }

  return { ok: true, items, methods, isBatch };
}

/** Detects upstream rate-limit responses (single or batch). */
export function isRateLimitError(json) {
  const check = (e) => {
    if (!e) return false;
    if (e.code === -32011 || e.code === 429) return true;
    const m = String(e.message || '').toLowerCase();
    return m.includes('request limit') || m.includes('rate limit') || m.includes('too many requests');
  };
  if (Array.isArray(json)) return json.some((entry) => check(entry && entry.error));
  return check(json && json.error);
}

/** Builds an error response matching the request shape (single vs batch). */
export function buildErrorResponse(items, isBatch, code, message) {
  const err = { code, message };
  if (!isBatch) return { jsonrpc: '2.0', id: (items[0] && items[0].id) !== undefined ? items[0].id : null, error: err };
  return items.map((it) => ({ jsonrpc: '2.0', id: (it && it.id) !== undefined ? it.id : null, error: err }));
}
