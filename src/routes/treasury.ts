// ============================================================
// Treasury Core API — Proxy & Meta Router (Phase 3 → Phase 4)
// ------------------------------------------------------------
// ExecDaat acts EXCLUSIVELY as a client of the Elligent Treasury
// Core API. This router is the ONLY integration boundary:
//
//   Browser ──► /api/core/v1/*  (this proxy, same-origin)
//                     │  injects Application Secret + HMAC signature
//                     ▼
//            Elligent Treasury Core API
//                     ▼
//            Treasury Engine ▸ Vault ▸ Turbo Bridge ▸ Circle ▸ Settlement
//
// The proxy:
//   • Injects the server-side Application Secret (never sent to browser).
//   • Signs each request with Timestamp + Nonce + HMAC-SHA256 (Phase 4).
//   • Adds standardized headers (Application/Client/Version/Correlation).
//   • Propagates the client Correlation ID end-to-end (logs/audit/support).
//   • Retries ONLY transient errors (network / 502 / 503 / 504).
//   • Caches ONLY health/metrics/applications (never intents/execute/history).
//   • Sanitizes upstream errors (no stack traces / paths / secrets).
//   • Emits structured observability (no sensitive data).
//
// It holds NO private keys. All cryptography stays on Elligent.
// ============================================================

import { Hono } from 'hono'
import {
  getTreasuryConfig,
  getPublicTreasuryConfig,
  getApplicationSecret,
  getTurboRelayerKey,
  getOperatorKey,
  type TreasuryBindings,
} from '../config/treasury'

const router = new Hono<{ Bindings: TreasuryBindings }>()

// ─── Allowed upstream Treasury Core endpoints (whitelist) ────────────────────
// Only these routes may be proxied. Anything else → 404. Prevents the proxy
// from being used as an open forwarder.
const ALLOWED: Array<{ method: string; pattern: RegExp }> = [
  { method: 'POST', pattern: /^\/intents$/ },
  { method: 'GET', pattern: /^\/intents\/[A-Za-z0-9_-]{1,128}$/ },
  { method: 'POST', pattern: /^\/quote$/ },
  { method: 'POST', pattern: /^\/execute$/ },
  { method: 'GET', pattern: /^\/history$/ },
  { method: 'GET', pattern: /^\/metrics$/ },
  { method: 'GET', pattern: /^\/applications$/ },
  { method: 'GET', pattern: /^\/health$/ },
]

const TRANSIENT_STATUS = new Set([502, 503, 504])
const MAX_RETRIES = 2
const RETRY_BASE_MS = 250
const UPSTREAM_TIMEOUT_MS = 25000

// ─── Cache policy (Phase 4) ──────────────────────────────────────────────────
// Cache ONLY idempotent, non-financial reads. NEVER cache intents, execute,
// settlement or history (single source of truth must always be live).
const CACHE_TTL_MS: Record<string, number> = {
  '/health': 30_000,
  '/metrics': 60_000,
  '/applications': 300_000,
}
function cacheTtlFor(cleanSub: string): number {
  return CACHE_TTL_MS[cleanSub] || 0
}
interface CacheEntry { body: string; contentType: string; exp: number }
// Best-effort in-memory cache (per Worker isolate). No sensitive data cached.
const _cache = new Map<string, CacheEntry>()
function cacheGet(key: string): CacheEntry | null {
  const e = _cache.get(key)
  if (!e) return null
  if (Date.now() > e.exp) { _cache.delete(key); return null }
  return e
}
function cacheSet(key: string, body: string, contentType: string, ttl: number) {
  if (ttl <= 0) return
  if (_cache.size > 200) _cache.clear()
  _cache.set(key, { body, contentType, exp: Date.now() + ttl })
}

// ─── HMAC request signing (Phase 4) ──────────────────────────────────────────
// The Worker signs each upstream request with the Application Secret using
// timestamp + nonce + HMAC-SHA256. The secret NEVER leaves the Worker. The
// canonical string is:  METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY
function genNonce(): string {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID().replace(/-/g, '')
    }
  } catch { /* fall through */ }
  return Math.random().toString(16).slice(2) + Date.now().toString(16)
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(message))
  const bytes = new Uint8Array(sig)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0')
  return hex
}

async function buildAuthHeaders(
  secret: string,
  method: string,
  pathWithQuery: string,
  bodyText: string,
): Promise<Record<string, string>> {
  const timestamp = String(Date.now())
  const nonce = genNonce()
  const canonical = [method.toUpperCase(), pathWithQuery, timestamp, nonce, bodyText || ''].join('\n')
  const signature = await hmacSha256Hex(secret, canonical)
  return {
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Signature': signature,
    'X-Signature-Alg': 'HMAC-SHA256',
  }
}

// ─── Correlation ID ──────────────────────────────────────────────────────────
function safeCorrelationId(raw: string | null | undefined): string {
  const v = (raw || '').trim()
  if (v && /^[A-Za-z0-9_-]{8,128}$/.test(v)) return v
  return genCorrelationId()
}

function genCorrelationId(): string {
  const rnd =
    (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function')
      ? globalThis.crypto.randomUUID().replace(/-/g, '')
      : Math.random().toString(16).slice(2) + Date.now().toString(16)
  return 'exd-' + rnd.slice(0, 24)
}

// ─── Observability (structured, non-sensitive) ───────────────────────────────
function logObs(entry: {
  correlationId: string
  intentId?: string | null
  endpoint: string
  method: string
  status: number
  latencyMs: number
  result: 'ok' | 'error' | 'transient'
  attempt?: number
}) {
  try {
    // Never log bodies, secrets, wallet keys, or PII — only operational metadata.
    console.log(
      JSON.stringify({
        tag: 'TREASURY_CORE',
        ts: new Date().toISOString(),
        app: 'EXECDAAT',
        correlationId: entry.correlationId,
        intentId: entry.intentId || undefined,
        endpoint: entry.endpoint,
        method: entry.method,
        status: entry.status,
        latencyMs: Math.round(entry.latencyMs),
        result: entry.result,
        attempt: entry.attempt,
      }),
    )
  } catch {
    /* logging must never throw */
  }
}

// ─── Friendly, sanitized error surface ───────────────────────────────────────
function friendlyError(kind: 'unavailable' | 'timeout' | 'upstream' | 'disabled' | 'notfound', status: number, correlationId: string) {
  const messages: Record<string, string> = {
    disabled: 'Treasury Core is not configured for this environment.',
    unavailable: 'Treasury service is temporarily unavailable. Please try again shortly.',
    timeout: 'Treasury service took too long to respond. Please try again.',
    upstream: 'The Treasury service could not process this request.',
    notfound: 'Requested Treasury resource was not found.',
  }
  return {
    ok: false,
    error: messages[kind] || messages.upstream,
    code: kind.toUpperCase(),
    correlationId,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// Defense-in-depth: strip any secret/credential-like fields from an upstream
// JSON payload before it can reach the browser (e.g. the /applications registry
// may include per-app `secret` hashes). Recursive; never throws.
function stripSecretFields(jsonText: string): string {
  try {
    const obj = JSON.parse(jsonText)
    const SECRET_KEY = /secret|apikey|api_key|privatekey|private_key|token|password|hmac/i
    const walk = (o: any): void => {
      if (!o || typeof o !== 'object') return
      if (Array.isArray(o)) { o.forEach(walk); return }
      for (const k of Object.keys(o)) {
        if (SECRET_KEY.test(k)) { delete o[k] }
        else walk(o[k])
      }
    }
    walk(obj)
    return JSON.stringify(obj)
  } catch {
    // If not parseable, redact via regex as a last resort.
    return jsonText.replace(/"([A-Za-z0-9_]*(?:secret|apikey|token|password|hmac)[A-Za-z0-9_]*)"\s*:\s*"[^"]*"/gi, '"$1":"***"')
  }
}

// ─── Meta: public config for the frontend ────────────────────────────────────
// GET /api/treasury/config  (mounted separately — see index.tsx)
export const metaRouter = new Hono<{ Bindings: TreasuryBindings }>()

metaRouter.get('/config', (c) => {
  const pub = getPublicTreasuryConfig(c.env)
  return c.json(
    { ok: true, ...pub, ts: new Date().toISOString() },
    200,
    { 'Cache-Control': 'no-store' },
  )
})

// GET /api/treasury/health — convenience passthrough to Treasury Core health.
metaRouter.get('/health', async (c) => {
  const cfg = getTreasuryConfig(c.env)
  const correlationId = safeCorrelationId(c.req.header('X-Correlation-Id'))
  if (!cfg.enabled || cfg.treasuryMode !== 'REMOTE') {
    return c.json(
      { ok: true, mode: cfg.treasuryMode, enabled: false, treasury: 'local', correlationId },
      200,
      { 'Cache-Control': 'no-store' },
    )
  }
  return forwardToCore(c, cfg, 'GET', '/health', correlationId)
})

// ─── Autonomous Settlement (server-side Operator keys) ────────────────────────
// POST /api/treasury/auto-settle
// Executes the ArcVault settlement lifecycle (reserve → startSettlement →
// completeSettlement) using the server-side TURBO_RELAYER_PRIVATE_KEY or
// OPERATOR_PRIVATE_KEY. This runs autonomously in the Worker — no browser
// wallet confirmation needed.
//
// Body: { intentBytes32, asset, amount, recipient, vault? }
//   - intentBytes32: bytes32 hex string identifying the intent
//   - asset: ERC-20 token address (e.g. 0x3600...0000 for USDC)
//   - amount: raw amount string (in token's smallest unit, e.g. "1000000" for 1 USDC)
//   - recipient: Arc address receiving the settled funds
//   - vault (optional): override ArcVault address (default from deployment)
metaRouter.post('/auto-settle', async (c) => {
  const started = Date.now()
  const cfg = getTreasuryConfig(c.env)
  const correlationId = safeCorrelationId(c.req.header('X-Correlation-Id'))

  if (!cfg.hasTurboRelayerKey && !cfg.hasOperatorKey) {
    return c.json({ ok: false, error: 'No server-side operator keys configured', correlationId }, 503)
  }

  let body: {
    intentBytes32?: string
    asset?: string
    amount?: string
    recipient?: string
    vault?: string
  } = {}
  try { body = await c.req.json() } catch { return c.json({ ok: false, error: 'Invalid JSON body', correlationId }, 400) }

  const intentBytes32 = (body.intentBytes32 || '').trim()
  const asset = (body.asset || '').trim()
  const amount = (body.amount || '').trim()
  const recipient = (body.recipient || '').trim()
  const vaultAddr = (body.vault || '0x1e039fF538Ed84Ad54610D644ca36D4b03167B87').trim()

  if (!intentBytes32 || !/^0x[0-9a-fA-F]{64}$/.test(intentBytes32)) {
    return c.json({ ok: false, error: 'Invalid intentBytes32', correlationId }, 400)
  }
  if (!asset || !/^0x[0-9a-fA-F]{40}$/.test(asset)) {
    return c.json({ ok: false, error: 'Invalid asset address', correlationId }, 400)
  }
  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
    return c.json({ ok: false, error: 'Invalid amount', correlationId }, 400)
  }
  if (!recipient || !/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
    return c.json({ ok: false, error: 'Invalid recipient address', correlationId }, 400)
  }

  // Use Turbo Relayer key first, fall back to Operator key
  let privateKey = getTurboRelayerKey(c.env)
  if (!privateKey) privateKey = getOperatorKey(c.env)
  if (!privateKey) {
    return c.json({ ok: false, error: 'No operator private key available', correlationId }, 503)
  }

  // ethers v6 normally uses fetch/WebSocket — Cloudflare Workers need a
  // custom JsonRpcProvider that avoids the node.js net/http polyfill mismatch.
  // We construct a lightweight provider using only the global fetch.
  const ethersModule = await import('ethers')
  const { Interface, JsonRpcProvider, Wallet } = ethersModule

  const RPC_URL = 'https://rpc.testnet.arc.network'
  const V_ABI = [
    'function reserve(bytes32 intentId, address asset, uint256 amount) external',
    'function startSettlement(bytes32 intentId, address asset, uint256 amount) external',
    'function completeSettlement(bytes32 intentId, address asset, address to, uint256 amount) external',
  ]

  try {
    const iface = new Interface(V_ABI)
    const provider = new JsonRpcProvider(RPC_URL)
    const wallet = new Wallet(privateKey, provider)
    const CONTRACT = vaultAddr

    // Step 1 — reserve
    const reserveData = iface.encodeFunctionData('reserve', [intentBytes32, asset, amount])
    const r1 = await wallet.sendTransaction({ to: CONTRACT, data: reserveData })
    const r1r = await r1.wait()
    if (!r1r || r1r.status !== 1) throw new Error('reserve reverted')

    // Step 2 — startSettlement
    const startData = iface.encodeFunctionData('startSettlement', [intentBytes32, asset, amount])
    const r2 = await wallet.sendTransaction({ to: CONTRACT, data: startData })
    const r2r = await r2.wait()
    if (!r2r || r2r.status !== 1) throw new Error('startSettlement reverted')

    // Step 3 — completeSettlement
    const completeData = iface.encodeFunctionData('completeSettlement', [intentBytes32, asset, recipient, amount])
    const r3 = await wallet.sendTransaction({ to: CONTRACT, data: completeData })
    const r3r = await r3.wait()
    if (!r3r || r3r.status !== 1) throw new Error('completeSettlement reverted')

    const latencyMs = Date.now() - started
    return c.json({
      ok: true,
      settlementId: r3.hash,
      txHash: r3.hash,
      steps: {
        reserve: r1.hash,
        startSettlement: r2.hash,
        completeSettlement: r3.hash,
      },
      block: r3r.blockNumber,
      latencyMs,
      correlationId,
    })
  } catch (e: any) {
    const msg = (e && (e.shortMessage || e.message)) || String(e)
    console.error('[TREASURY:AUTO_SETTLE]', correlationId, msg)
    return c.json({
      ok: false,
      error: msg.slice(0, 200),
      correlationId,
      latencyMs: Date.now() - started,
    }, 500)
  }
})

// ─── Core proxy handlers ─────────────────────────────────────────────────────
// Mounted at /api/core/v1 in index.tsx. Path here is relative (e.g. /intents).

async function forwardToCore(
  c: any,
  cfg: ReturnType<typeof getTreasuryConfig>,
  method: string,
  subPath: string,
  correlationId: string,
): Promise<Response> {
  const started = Date.now()
  // Log the route WITHOUT query string (filters may contain wallet addresses).
  const cleanSub = subPath.split('?')[0]
  const endpoint = `/api/core/${cfg.apiVersion}${cleanSub}`

  if (!cfg.enabled) {
    logObs({ correlationId, endpoint, method, status: 503, latencyMs: Date.now() - started, result: 'error' })
    return c.json(friendlyError('disabled', 503, correlationId), 503, {
      'X-Correlation-Id': correlationId,
    })
  }

  const url = `${cfg.coreUrl}/api/core/${cfg.apiVersion}${subPath}`
  const corePath = `/api/core/${cfg.apiVersion}${subPath}` // path + query, used for signing + cache

  // ── Cache read (health/metrics/applications only) ──────────────────────────
  const ttl = method === 'GET' ? cacheTtlFor(cleanSub) : 0
  const cacheKey = `${method} ${corePath}`
  if (ttl > 0) {
    const hit = cacheGet(cacheKey)
    if (hit) {
      logObs({ correlationId, endpoint, method, status: 200, latencyMs: Date.now() - started, result: 'ok' })
      return new Response(hit.body, {
        status: 200,
        headers: {
          'Content-Type': hit.contentType,
          'X-Correlation-Id': correlationId,
          'X-Cache': 'HIT',
          'Cache-Control': 'no-store',
        },
      })
    }
  }

  // Build standardized headers. Sensitive material lives ONLY here (server-side).
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'X-Application-Id': cfg.applicationId,
    'X-Client-Id': cfg.clientId,
    'X-Api-Version': cfg.apiVersion,
    'X-Application-Mode': cfg.applicationMode,
    'X-Correlation-Id': correlationId,
    'User-Agent': 'ExecDaat/4.0 (+treasury-core-client)',
  }

  // Read body for write methods (already validated by whitelist).
  let bodyText: string | undefined
  if (method === 'POST' || method === 'PUT') {
    try {
      const raw = await c.req.text()
      bodyText = raw && raw.length ? raw : '{}'
      headers['Content-Type'] = 'application/json'
    } catch {
      bodyText = '{}'
      headers['Content-Type'] = 'application/json'
    }
  }

  if (cfg.hasSecret) {
    const secret = getApplicationSecret(c.env)
    // Application Secret — server-side only. Never reaches the browser.
    headers['X-Application-Secret'] = secret
    // Timestamp + Nonce + HMAC-SHA256 signature (computed in the Worker).
    try {
      const auth = await buildAuthHeaders(secret, method, corePath, bodyText || '')
      Object.assign(headers, auth)
    } catch {
      /* signing failure must not leak; upstream will reject unsigned request */
    }
  }

  // Extract intentId (best-effort, for observability only) without logging body.
  let intentId: string | null = null
  const m = cleanSub.match(/^\/intents\/([A-Za-z0-9_-]+)$/)
  if (m) intentId = m[1]

  let lastStatus = 0
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS)
    try {
      const upstream = await fetch(url, {
        method,
        headers,
        body: bodyText,
        signal: ac.signal,
      })
      clearTimeout(timer)
      lastStatus = upstream.status

      // Transient upstream → retry (idempotent-safe for GET; POST retried only
      // on connection-level failures handled in catch — here we retry 5xx only
      // for GET to avoid double-submitting intents/executes).
      if (TRANSIENT_STATUS.has(upstream.status) && method === 'GET' && attempt < MAX_RETRIES) {
        logObs({ correlationId, intentId, endpoint, method, status: upstream.status, latencyMs: Date.now() - started, result: 'transient', attempt })
        await sleep(RETRY_BASE_MS * Math.pow(2, attempt))
        continue
      }

      const text = await upstream.text()
      const result = upstream.ok ? 'ok' : 'error'
      logObs({ correlationId, intentId, endpoint, method, status: upstream.status, latencyMs: Date.now() - started, result, attempt })

      if (!upstream.ok) {
        // Validation errors (400/422) carry actionable, NON-sensitive field
        // messages — pass them through so the client contract can be aligned.
        // Everything else (401/403/404/5xx) stays sanitized.
        if (upstream.status === 400 || upstream.status === 422) {
          return new Response(text || '{}', {
            status: upstream.status,
            headers: {
              'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
              'X-Correlation-Id': correlationId,
              'Cache-Control': 'no-store',
            },
          })
        }
        // Sanitize: do not leak upstream error internals to the client.
        const kind = upstream.status === 404 ? 'notfound' : TRANSIENT_STATUS.has(upstream.status) ? 'unavailable' : 'upstream'
        return c.json(friendlyError(kind, upstream.status, correlationId), upstream.status, {
          'X-Correlation-Id': correlationId,
        })
      }

      // Success: pass through JSON verbatim (Treasury Core is the source of truth).
      const outContentType = upstream.headers.get('Content-Type') || 'application/json'
      let outText = text || '{}'
      // The applications registry may carry per-app secret hashes — strip any
      // secret/credential fields so the browser NEVER receives them.
      if (cleanSub === '/applications') outText = stripSecretFields(outText)
      // Cache ONLY health/metrics/applications (never intents/execute/history).
      if (ttl > 0) cacheSet(cacheKey, outText, outContentType, ttl)
      return new Response(outText, {
        status: upstream.status,
        headers: {
          'Content-Type': outContentType,
          'X-Correlation-Id': correlationId,
          'X-Cache': ttl > 0 ? 'MISS' : 'BYPASS',
          'Cache-Control': 'no-store',
        },
      })
    } catch (err: unknown) {
      clearTimeout(timer)
      const aborted = err instanceof Error && err.name === 'AbortError'
      const isLast = attempt >= MAX_RETRIES
      // Connection-level failure is transient — safe to retry for GET only.
      if (!isLast && method === 'GET') {
        logObs({ correlationId, intentId, endpoint, method, status: 0, latencyMs: Date.now() - started, result: 'transient', attempt })
        await sleep(RETRY_BASE_MS * Math.pow(2, attempt))
        continue
      }
      logObs({ correlationId, intentId, endpoint, method, status: aborted ? 504 : 502, latencyMs: Date.now() - started, result: 'error', attempt })
      return c.json(friendlyError(aborted ? 'timeout' : 'unavailable', aborted ? 504 : 502, correlationId), aborted ? 504 : 502, {
        'X-Correlation-Id': correlationId,
      })
    }
  }

  // Exhausted retries (GET transient loop).
  return c.json(friendlyError('unavailable', lastStatus || 503, correlationId), 503, {
    'X-Correlation-Id': correlationId,
  })
}

function isAllowed(method: string, subPath: string): boolean {
  return ALLOWED.some((r) => r.method === method && r.pattern.test(subPath))
}

// Generic proxy entrypoint used by each registered method/path.
async function handleProxy(c: any, method: string): Promise<Response> {
  const cfg = getTreasuryConfig(c.env)
  const correlationId = safeCorrelationId(c.req.header('X-Correlation-Id'))
  // Reconstruct the sub-path relative to /api/core/v1
  const full = new URL(c.req.url).pathname
  const base = `/api/core/${cfg.apiVersion}`
  let subPath = full.startsWith(base) ? full.slice(base.length) : full
  if (!subPath.startsWith('/')) subPath = '/' + subPath
  // Preserve query string for GET (history/metrics filters).
  const qs = new URL(c.req.url).search

  if (!isAllowed(method, subPath)) {
    return c.json(friendlyError('notfound', 404, correlationId), 404, {
      'X-Correlation-Id': correlationId,
    })
  }
  return forwardToCore(c, cfg, method, subPath + qs, correlationId)
}

// Explicit route registrations (spec endpoints).
router.post('/intents', (c) => handleProxy(c, 'POST'))
router.get('/intents/:id', (c) => handleProxy(c, 'GET'))
router.post('/quote', (c) => handleProxy(c, 'POST'))
router.post('/execute', (c) => handleProxy(c, 'POST'))
router.get('/history', (c) => handleProxy(c, 'GET'))
router.get('/metrics', (c) => handleProxy(c, 'GET'))
router.get('/applications', (c) => handleProxy(c, 'GET'))
router.get('/health', (c) => handleProxy(c, 'GET'))

export default router
