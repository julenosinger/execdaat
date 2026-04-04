// ============================================================
// AGENT INTENTS ROUTE v2 — ExecDaat
//
// Full persistence via Cloudflare KV (binding: AGENT_INTENTS)
// Falls back gracefully to in-memory if KV is not bound.
//
// POST   /api/agent/intents          — create intent (+ optional permit sig)
// GET    /api/agent/intents?wallet=  — list intents for wallet
// GET    /api/agent/intents/:id      — get single intent
// PATCH  /api/agent/intents/:id      — update status / txHash / result
// DELETE /api/agent/intents/:id      — cancel intent
// GET    /api/agent/poll?wallet=&since= — short-poll for changed intents
// GET    /api/agent/stats?wallet=    — aggregate stats
//
// KV key schema:
//   intent:{id}          → AgentIntent JSON  (TTL: 7 days)
//   wallet:{addr}:index  → JSON array of intent ids (TTL: 7 days)
// ============================================================

import { Hono } from 'hono'

// ─── Bindings ──────────────────────────────────────────────────────────────
type Bindings = {
  AGENT_INTENTS?: KVNamespace   // optional so build passes without KV
  // other bindings inherited from main app
  [key: string]: unknown
}

// ─── Types ─────────────────────────────────────────────────────────────────
export type IntentStatus =
  | 'pending'
  | 'processing'
  | 'signing'
  | 'broadcast'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type IntentType =
  | 'transfer'
  | 'multisend'
  | 'swap'
  | 'contract_deploy'
  | 'contract_call'
  | 'automation'

export interface AgentIntent {
  id:           string
  type:         IntentType
  status:       IntentStatus
  wallet:       string          // user's wallet (lowercase)
  token:        string          // 'USDC' | 'EURC'
  amount?:      string          // human-readable ("10.5")
  to?:          string          // single recipient (lowercase)
  receivers?:   Array<{ address: string; amount: string }>
  memo?:        string
  // Auth / Permit2
  sessionHash?: string          // links to arcpay session
  signature?:   string          // EIP-191 session sig (used for Permit2)
  permitNonce?: string          // Permit2 nonce (uint256 as string)
  permitDeadline?: string       // Permit2 deadline (unix ts as string)
  // Result
  txHash?:      string
  blockNumber?: number
  error?:       string
  retries:      number
  // Timestamps
  createdAt:    string          // ISO
  updatedAt:    string          // ISO
  completedAt?: string          // ISO
}

// ─── KV TTL (7 days in seconds) ────────────────────────────────────────────
const KV_TTL_SECONDS  = 7 * 24 * 60 * 60
const MAX_PER_WALLET  = 200
const WALLET_INDEX_TTL = KV_TTL_SECONDS

// ─── Fallback in-memory store (used if KV binding absent) ──────────────────
const _mem = new Map<string, AgentIntent>()

// ─── Helpers ───────────────────────────────────────────────────────────────
function _nowISO()  { return new Date().toISOString() }
function _genId()   { return 'intent-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7) }
function _isAddr(a: unknown): a is string {
  return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)
}

// ─── KV helpers ────────────────────────────────────────────────────────────
async function kvGet(kv: KVNamespace | undefined, key: string): Promise<AgentIntent | null> {
  if (!kv) return _mem.get(key.replace('intent:', '')) ?? null
  const v = await kv.get(key)
  if (!v) return null
  try { return JSON.parse(v) as AgentIntent } catch { return null }
}

async function kvPut(kv: KVNamespace | undefined, intent: AgentIntent): Promise<void> {
  if (!kv) { _mem.set(intent.id, intent); return }
  await kv.put(`intent:${intent.id}`, JSON.stringify(intent), {
    expirationTtl: KV_TTL_SECONDS,
  })
}

async function kvDelete(kv: KVNamespace | undefined, id: string): Promise<void> {
  if (!kv) { _mem.delete(id); return }
  await kv.delete(`intent:${id}`)
}

async function kvGetWalletIndex(kv: KVNamespace | undefined, wallet: string): Promise<string[]> {
  if (!kv) {
    return [..._mem.values()].filter(i => i.wallet === wallet.toLowerCase()).map(i => i.id)
  }
  const raw = await kv.get(`wallet:${wallet.toLowerCase()}:index`)
  if (!raw) return []
  try { return JSON.parse(raw) as string[] } catch { return [] }
}

async function kvAddToWalletIndex(kv: KVNamespace | undefined, wallet: string, intentId: string): Promise<void> {
  if (!kv) return  // in-memory already tracked via _mem
  const ids = await kvGetWalletIndex(kv, wallet)
  if (!ids.includes(intentId)) {
    ids.push(intentId)
    // Keep last MAX_PER_WALLET
    const trimmed = ids.slice(-MAX_PER_WALLET)
    await kv.put(`wallet:${wallet.toLowerCase()}:index`, JSON.stringify(trimmed), {
      expirationTtl: WALLET_INDEX_TTL,
    })
  }
}

async function kvGetWalletIntents(kv: KVNamespace | undefined, wallet: string): Promise<AgentIntent[]> {
  const ids = await kvGetWalletIndex(kv, wallet)
  if (ids.length === 0) return []
  const results: AgentIntent[] = []
  // Fetch in parallel (max 20 at a time to avoid rate limits)
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20)
    const fetched = await Promise.all(chunk.map(id => kvGet(kv, `intent:${id}`)))
    for (const intent of fetched) {
      if (intent) results.push(intent)
    }
  }
  return results
}

// ─── Router ────────────────────────────────────────────────────────────────
const agentIntentsRouter = new Hono<{ Bindings: Bindings }>()

// ── POST /api/agent/intents ── Create ─────────────────────────────────────
agentIntentsRouter.post('/intents', async (c) => {
  const kv = c.env?.AGENT_INTENTS as KVNamespace | undefined

  let body: Record<string, unknown>
  try { body = await c.req.json() } catch {
    return c.json({ success: false, error: 'Invalid JSON body' }, 400)
  }

  const { type, wallet, token, amount, to, receivers, memo,
          sessionHash, signature, permitNonce, permitDeadline } = body as Record<string, unknown>

  // Validations
  if (!type || typeof type !== 'string') {
    return c.json({ success: false, error: 'Field "type" is required' }, 400)
  }
  const validTypes: IntentType[] = ['transfer','multisend','swap','contract_deploy','contract_call','automation']
  if (!validTypes.includes(type as IntentType)) {
    return c.json({ success: false, error: `Invalid type. Must be one of: ${validTypes.join(', ')}` }, 400)
  }
  if (!_isAddr(wallet)) {
    return c.json({ success: false, error: 'Field "wallet" must be a valid 0x address' }, 400)
  }
  if (!token || typeof token !== 'string') {
    return c.json({ success: false, error: 'Field "token" is required (USDC|EURC)' }, 400)
  }
  if (type === 'transfer') {
    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      return c.json({ success: false, error: 'Transfer: "amount" must be > 0' }, 400)
    }
    if (!_isAddr(to)) {
      return c.json({ success: false, error: 'Transfer: "to" must be a valid 0x address' }, 400)
    }
  }
  if (type === 'multisend') {
    if (!Array.isArray(receivers) || receivers.length === 0) {
      return c.json({ success: false, error: 'Multisend: "receivers" array is required' }, 400)
    }
    for (const r of receivers as Array<Record<string, unknown>>) {
      if (!_isAddr(r.address) || !r.amount || isNaN(Number(r.amount)) || Number(r.amount) <= 0) {
        return c.json({ success: false, error: 'Multisend: each receiver needs valid address + amount > 0' }, 400)
      }
    }
  }

  const walletLower = (wallet as string).toLowerCase()

  // Check per-wallet cap (best-effort: skip if KV unavailable)
  try {
    const existing = await kvGetWalletIntents(kv, walletLower)
    const pending  = existing.filter(i => !['completed','failed','cancelled'].includes(i.status))
    if (pending.length >= MAX_PER_WALLET) {
      return c.json({ success: false, error: 'Too many active intents. Wait for current ones to complete.' }, 429)
    }
  } catch { /* continue anyway */ }

  const intent: AgentIntent = {
    id:             _genId(),
    type:           type as IntentType,
    status:         'pending',
    wallet:         walletLower,
    token:          (token as string).toUpperCase(),
    amount:         amount ? String(amount) : undefined,
    to:             to ? (to as string).toLowerCase() : undefined,
    receivers:      receivers as AgentIntent['receivers'],
    memo:           memo ? String(memo).slice(0, 200) : undefined,
    sessionHash:    sessionHash ? String(sessionHash).slice(0, 64)  : undefined,
    signature:      signature   ? String(signature)                  : undefined,
    permitNonce:    permitNonce ? String(permitNonce)                : undefined,
    permitDeadline: permitDeadline ? String(permitDeadline)          : undefined,
    retries:        0,
    createdAt:      _nowISO(),
    updatedAt:      _nowISO(),
  }

  await kvPut(kv, intent)
  await kvAddToWalletIndex(kv, walletLower, intent.id)

  console.log(`[AGENT] Created: ${intent.id} type=${intent.type} wallet=${intent.wallet.slice(0,10)}…`)

  return c.json({ success: true, intent }, 201)
})

// ── GET /api/agent/intents ── List ────────────────────────────────────────
agentIntentsRouter.get('/intents', async (c) => {
  const kv = c.env?.AGENT_INTENTS as KVNamespace | undefined

  const rawWallet    = c.req.query('wallet')
  const statusFilter = c.req.query('status')
  const limitRaw     = parseInt(c.req.query('limit') || '50', 10)
  const limit        = Math.min(Math.max(1, limitRaw), 200)

  if (!rawWallet || !_isAddr(rawWallet)) {
    return c.json({ success: false, error: 'Query param "wallet" must be a valid 0x address' }, 400)
  }

  let results = await kvGetWalletIntents(kv, rawWallet)

  if (statusFilter) {
    const statuses = statusFilter.split(',').map(s => s.trim())
    results = results.filter(i => statuses.includes(i.status))
  }

  results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  results = results.slice(0, limit)

  return c.json({ success: true, intents: results, total: results.length })
})

// ── GET /api/agent/intents/:id ── Get single ─────────────────────────────
agentIntentsRouter.get('/intents/:id', async (c) => {
  const kv = c.env?.AGENT_INTENTS as KVNamespace | undefined
  const id = c.req.param('id')
  const intent = await kvGet(kv, `intent:${id}`)
  if (!intent) return c.json({ success: false, error: 'Intent not found' }, 404)
  return c.json({ success: true, intent })
})

// ── PATCH /api/agent/intents/:id ── Update ───────────────────────────────
agentIntentsRouter.patch('/intents/:id', async (c) => {
  const kv = c.env?.AGENT_INTENTS as KVNamespace | undefined
  const id = c.req.param('id')

  const intent = await kvGet(kv, `intent:${id}`)
  if (!intent) return c.json({ success: false, error: 'Intent not found' }, 404)

  let body: Record<string, unknown>
  try { body = await c.req.json() } catch {
    return c.json({ success: false, error: 'Invalid JSON body' }, 400)
  }

  const allowedStatuses: IntentStatus[] = ['pending','processing','signing','broadcast','completed','failed','cancelled']
  if (body.status && !allowedStatuses.includes(body.status as IntentStatus)) {
    return c.json({ success: false, error: `Invalid status` }, 400)
  }

  if (body.status)      intent.status      = body.status as IntentStatus
  if (body.txHash)      intent.txHash      = String(body.txHash).slice(0, 66)
  if (body.blockNumber) intent.blockNumber = Number(body.blockNumber)
  if (body.error)       intent.error       = String(body.error).slice(0, 500)
  if (body.retries !== undefined) intent.retries = Number(body.retries)
  if (body.permitNonce) intent.permitNonce  = String(body.permitNonce)
  if (body.permitDeadline) intent.permitDeadline = String(body.permitDeadline)
  if (body.status === 'completed' || body.status === 'failed') {
    intent.completedAt = _nowISO()
  }
  intent.updatedAt = _nowISO()

  await kvPut(kv, intent)

  console.log(`[AGENT] Updated: ${id} → ${intent.status}${intent.txHash ? ' tx='+intent.txHash.slice(0,14) : ''}`)

  return c.json({ success: true, intent })
})

// ── DELETE /api/agent/intents/:id ── Cancel ──────────────────────────────
agentIntentsRouter.delete('/intents/:id', async (c) => {
  const kv = c.env?.AGENT_INTENTS as KVNamespace | undefined
  const id = c.req.param('id')

  const intent = await kvGet(kv, `intent:${id}`)
  if (!intent) return c.json({ success: false, error: 'Intent not found' }, 404)

  if (intent.status === 'processing' || intent.status === 'broadcast') {
    return c.json({ success: false, error: 'Cannot cancel an intent that is being processed' }, 409)
  }

  // Soft-delete: mark as cancelled (preserves history)
  intent.status      = 'cancelled'
  intent.updatedAt   = _nowISO()
  intent.completedAt = _nowISO()
  await kvPut(kv, intent)

  return c.json({ success: true, message: 'Intent cancelled' })
})

// ── GET /api/agent/poll ── Short-poll for UI ──────────────────────────────
agentIntentsRouter.get('/poll', async (c) => {
  const kv = c.env?.AGENT_INTENTS as KVNamespace | undefined

  const rawWallet = c.req.query('wallet')
  const since     = c.req.query('since')   // ISO timestamp

  if (!rawWallet || !_isAddr(rawWallet)) {
    return c.json({ success: false, error: 'Query param "wallet" must be a valid 0x address' }, 400)
  }

  let results = await kvGetWalletIntents(kv, rawWallet)

  if (since) {
    results = results.filter(i => i.updatedAt > since)
  } else {
    // First poll: active + recently completed (last 60s)
    results = results.filter(i =>
      !['completed','failed','cancelled'].includes(i.status) ||
      (i.completedAt && Date.now() - new Date(i.completedAt).getTime() < 60_000)
    )
  }

  results.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))

  return c.json({
    success:   true,
    intents:   results,
    total:     results.length,
    timestamp: _nowISO(),
  })
})

// ── GET /api/agent/stats ── Aggregate stats ──────────────────────────────
agentIntentsRouter.get('/stats', async (c) => {
  const kv = c.env?.AGENT_INTENTS as KVNamespace | undefined

  const rawWallet = c.req.query('wallet')
  let scope: AgentIntent[]

  if (rawWallet && _isAddr(rawWallet)) {
    scope = await kvGetWalletIntents(kv, rawWallet)
  } else {
    // No wallet filter — return zero stats (avoids scanning all KV keys)
    scope = []
  }

  const stats = {
    total:      scope.length,
    pending:    scope.filter(i => i.status === 'pending').length,
    processing: scope.filter(i => ['processing','signing','broadcast'].includes(i.status)).length,
    completed:  scope.filter(i => i.status === 'completed').length,
    failed:     scope.filter(i => i.status === 'failed').length,
    cancelled:  scope.filter(i => i.status === 'cancelled').length,
  }
  return c.json({ success: true, stats })
})

export default agentIntentsRouter
