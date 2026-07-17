// ============================================================
// EXECDAAT NATIVE TREASURY CORE (self-contained — no Elligent)
// ------------------------------------------------------------
// Serves the /api/core/v1/* contract ENTIRELY inside ExecDaat.
// Zero runtime dependency on the Elligent Treasury Core: no
// TREASURY_CORE_URL, no outbound proxy, no HMAC/cross-app auth.
//
// Data source: in-memory intent ledger (Cloudflare KV optional — used only
// if an AGENT_INTENTS binding happens to exist) + Arc RPC (read-only) for
// on-chain vault/liquidity.
// Actual on-chain settlement signing stays where it already is
// (/api/treasury/auto-settle, operator key) — this module is the
// record / ledger / metrics / health authority.
//
// Internal engines (all local):
//   Intent · Ledger · Settlement (record) · Reimbursement (record) ·
//   Vault · Liquidity · Metrics · Health · Registry · Audit
//
// Endpoints:
//   GET  /health           POST /intents         GET  /intents/:id
//   POST /intents/:id/status                      POST /quote
//   POST /execute          GET  /history          GET  /metrics
//   GET  /reimbursements   GET  /applications     GET  /liquidity
//   GET  /vault
//
// Response envelope matches the previous contract:
//   { success:true, requestId, correlationId, timestamp, version, data, errors:[] }
//
// Security: never returns secrets/keys. Read-only chain access.
// build: 20260709c1
// ============================================================

import { Hono } from 'hono'

type CoreBindings = {
  AGENT_INTENTS?: KVNamespace
  APPLICATION_ID?: string
  CLIENT_ID?: string
  API_VERSION?: string
  APPLICATION_MODE?: string
  TREASURY_MODE?: string
  EXECDAAT_VAULT_ADDRESS?: string
}

const router = new Hono<{ Bindings: CoreBindings }>()

// ─── Constants (Arc testnet + ExecDaat vault) ────────────────────────────────
const RPC_URL = 'https://rpc.testnet.arc.network'
const NETWORK = 'Arc Testnet'
const CHAIN_ID = 5042002
const DEFAULT_VAULT = '0x1e039fF538Ed84Ad54610D644ca36D4b03167B87'
const CIRCLE_TRANSMITTER = '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275'
const ASSETS: Record<string, { address: string; decimals: number }> = {
  USDC: { address: '0x3600000000000000000000000000000000000000', decimals: 6 },
  EURC: { address: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a', decimals: 6 },
}
const DEFAULT_FEE_BPS = 100 // 1% turbo fee (used only for local quotes)
const INDEX_KEY = 'tc:index'
const INDEX_CAP = 500

// ─── Helpers ──────────────────────────────────────────────────────────────────
function genId(prefix: string): string {
  const rnd = (globalThis.crypto && globalThis.crypto.randomUUID)
    ? globalThis.crypto.randomUUID().replace(/-/g, '')
    : Math.random().toString(16).slice(2) + Date.now().toString(16)
  return prefix + rnd.slice(0, 20)
}
function bytes32(): string {
  const b = new Uint8Array(32)
  try { globalThis.crypto.getRandomValues(b) } catch { for (let i = 0; i < 32; i++) b[i] = Math.floor(Math.random() * 256) }
  let h = '0x'; for (let i = 0; i < b.length; i++) h += b[i].toString(16).padStart(2, '0'); return h
}
function corr(raw: string | null | undefined): string {
  const v = (raw || '').trim()
  if (v && /^[A-Za-z0-9_-]{8,128}$/.test(v)) return v
  return genId('exd-')
}
function ok(c: any, data: any, correlationId: string) {
  return c.json({
    success: true,
    requestId: genId('req_'),
    correlationId,
    timestamp: new Date().toISOString(),
    version: 'v1',
    data,
    errors: [],
  }, 200, { 'X-Correlation-Id': correlationId, 'Cache-Control': 'no-store' })
}
function fail(c: any, status: number, message: string, correlationId: string) {
  return c.json({
    success: false,
    requestId: genId('req_'),
    correlationId,
    timestamp: new Date().toISOString(),
    version: 'v1',
    data: null,
    errors: [{ code: status, message }],
  }, status, { 'X-Correlation-Id': correlationId, 'Cache-Control': 'no-store' })
}
const now = () => Date.now()
function toNum(v: any): number { const n = Number(v); return isFinite(n) ? n : 0 }
function isHex(v: any, len: number): boolean { return typeof v === 'string' && new RegExp('^0x[0-9a-fA-F]{' + len + '}$').test(v) }
function isAddr(v: any): boolean { return isHex(v, 40) }

// ─── Ledger store (in-memory, no KV dependency) ──────────────────────────────
const memStore = new Map<string, string>()
async function kvGet(env: CoreBindings, key: string): Promise<any> {
  try {
    if (env.AGENT_INTENTS) { const raw = await env.AGENT_INTENTS.get(key); if (raw) return JSON.parse(raw) }
  } catch { /* KV unavailable — fall back to memory */ }
  try { const raw = memStore.get(key); return raw ? JSON.parse(raw) : null } catch { return null }
}
async function kvPut(env: CoreBindings, key: string, val: any): Promise<void> {
  const raw = JSON.stringify(val)
  memStore.set(key, raw)
  try { if (env.AGENT_INTENTS) await env.AGENT_INTENTS.put(key, raw) } catch { /* never throw */ }
}
async function readIndex(env: CoreBindings): Promise<any[]> { const a = await kvGet(env, INDEX_KEY); return Array.isArray(a) ? a : [] }
async function writeIndex(env: CoreBindings, arr: any[]): Promise<void> { await kvPut(env, INDEX_KEY, arr.slice(0, INDEX_CAP)) }

// Stage/status derivation from the recorded fields (single source of truth).
function deriveStage(it: any): string {
  const raw = String(it.status || '').toLowerCase()
  if (/fail|error/.test(raw)) return 'FAILED'
  if (/cancel/.test(raw)) return 'CANCELLED'
  const rs = String((it.reimbursement && it.reimbursement.status) || '').toLowerCase()
  if (it.vaultCreditTxHash || /complete|done|reimbursed|success/.test(rs)) return /completed/.test(raw) ? 'COMPLETED' : 'REIMBURSED'
  if (rs && /pending|processing|await|running/.test(rs)) return 'SETTLED'
  const ss = String((it.settlement && it.settlement.status) || '').toLowerCase()
  if (/running|processing/.test(ss)) return 'SETTLING'
  if (it.settlementTxHash || /settled/.test(raw)) return 'SETTLED'
  if (it.circleMintTxHash || /minted/.test(raw)) return 'MINTED'
  if (it.attestation || /attested/.test(raw)) return 'ATTESTED'
  if (it.fulfillTxHash || /paid|treasury_paid|fulfil/.test(raw)) return 'TREASURY_PAID'
  if ((it.vaultDebit && /debited/.test(String(it.vaultDebit.status || '').toLowerCase())) || /debited/.test(raw)) return 'VAULT_DEBITED'
  if (/reserved/.test(raw)) return 'RESERVED'
  if (it.sourceTxHash || /burn|bridging|executing/.test(raw)) return 'WAITING_ATTESTATION'
  return 'CREATED'
}
const TERMINAL = { COMPLETED: 1, REIMBURSED: 1, FAILED: 1, CANCELLED: 1 } as Record<string, number>

function appendTimeline(it: any, stage: string, tx?: string) {
  if (!Array.isArray(it.timeline)) it.timeline = []
  const last = it.timeline[it.timeline.length - 1]
  if (last && last.stage === stage) return
  it.timeline.push({ stage, ts: now(), tx: tx || null })
}

function normalizeBody(body: any, existing?: any): any {
  const it = existing || {}
  const set = (k: string, v: any) => { if (v !== undefined && v !== null && v !== '') it[k] = v }
  set('application', body.application || body.applicationId || it.application || 'EXECDAAT')
  set('client', body.client || body.clientId || it.client || 'EXECDAAT-PROD')
  set('environment', body.environment || it.environment || 'LOCAL')
  set('wallet', body.wallet || body.userAddress || it.wallet)
  set('recipient', body.recipient || body.receiver || it.recipient)
  set('asset', String(body.asset || body.token || it.asset || 'USDC').toUpperCase())
  if (body.amount != null) set('amount', String(body.amount))
  set('sourceChain', body.sourceChain || body.srcChain || it.sourceChain)
  set('destinationChain', body.destinationChain || body.dstChain || it.destinationChain || 'arc')
  set('bridge', body.bridge || it.bridge || 'Turbo')
  set('vault', body.vault || it.vault || DEFAULT_VAULT)
  set('memo', body.memo || it.memo)
  set('nonce', body.nonce != null ? body.nonce : it.nonce)
  set('intentBytes32', body.intentBytes32 || it.intentBytes32)
  // tx hashes (lifecycle)
  set('sourceTxHash', body.sourceTxHash || body.burnTxHash || body.txHash || it.sourceTxHash)
  set('attestation', body.attestation || body.attestationHash || it.attestation)
  set('circleMintTxHash', body.circleMintTxHash || body.mintTxHash || it.circleMintTxHash)
  set('fulfillTxHash', body.fulfillTxHash || body.treasuryTxHash || it.fulfillTxHash)
  set('settlementTxHash', body.settlementTxHash || it.settlementTxHash)
  set('vaultCreditTxHash', body.vaultCreditTxHash || (body.reimbursement && body.reimbursement.txHash) || it.vaultCreditTxHash)
  if (body.vaultDebit) it.vaultDebit = Object.assign({}, it.vaultDebit, body.vaultDebit)
  if (body.treasuryPayment) it.treasuryPayment = Object.assign({}, it.treasuryPayment, body.treasuryPayment)
  if (body.settlement) it.settlement = Object.assign({}, it.settlement, body.settlement)
  if (body.reimbursement) it.reimbursement = Object.assign({}, it.reimbursement, body.reimbursement)
  if (body.status) it.status = body.status
  return it
}

async function upsertIntent(env: CoreBindings, it: any): Promise<any> {
  it.updatedAt = now()
  it.status = deriveStage(it)
  if ((it.status === 'SETTLED' || it.status === 'REIMBURSED' || it.status === 'COMPLETED') && !it.settledAt) it.settledAt = now()
  if ((it.status === 'REIMBURSED' || it.status === 'COMPLETED') && !it.reimbursedAt) it.reimbursedAt = now()
  appendTimeline(it, it.status)
  await kvPut(env, 'tc:i:' + it.intentId, it)
  // update compact index (newest first, dedup)
  const idx = await readIndex(env)
  const pos = idx.findIndex((x) => x.intentId === it.intentId)
  const compact = compactOf(it)
  if (pos >= 0) idx[pos] = compact
  else idx.unshift(compact)
  await writeIndex(env, idx)
  return it
}
function compactOf(it: any) {
  return {
    intentId: it.intentId, application: it.application, client: it.client, environment: it.environment,
    wallet: it.wallet, recipient: it.recipient, asset: it.asset, amount: it.amount,
    sourceChain: it.sourceChain, destinationChain: it.destinationChain, bridge: it.bridge, vault: it.vault,
    memo: it.memo, nonce: it.nonce, correlationId: it.correlationId, ledgerEntry: it.ledgerEntry,
    status: it.status,
    sourceTxHash: it.sourceTxHash, attestation: it.attestation, circleMintTxHash: it.circleMintTxHash,
    fulfillTxHash: it.fulfillTxHash, settlementTxHash: it.settlementTxHash, vaultCreditTxHash: it.vaultCreditTxHash,
    vaultDebit: it.vaultDebit, treasuryPayment: it.treasuryPayment, settlement: it.settlement, reimbursement: it.reimbursement,
    createdAt: it.createdAt, updatedAt: it.updatedAt, settledAt: it.settledAt, reimbursedAt: it.reimbursedAt,
  }
}

// ─── On-chain reads (ethers, read-only) ──────────────────────────────────────
let _ethers: any = null
async function ethersMod() { if (!_ethers) { try { _ethers = await import('ethers') } catch { _ethers = null } } return _ethers }
const VAULT_ABI = ['function getAvailableLiquidity(address asset) view returns (uint256)', 'function turboFeeBps() view returns (uint256)', 'function paused() view returns (bool)']
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)']

async function readVault(env: CoreBindings) {
  const vaultAddr = (env.EXECDAAT_VAULT_ADDRESS && isAddr(env.EXECDAAT_VAULT_ADDRESS)) ? env.EXECDAAT_VAULT_ADDRESS : DEFAULT_VAULT
  const out: any = { address: vaultAddr, network: NETWORK, chainId: CHAIN_ID, paused: null, assets: {} as Record<string, any> }
  const E = await ethersMod(); if (!E) return out
  try {
    const provider = new E.JsonRpcProvider(RPC_URL)
    const vc = new E.Contract(vaultAddr, VAULT_ABI, provider)
    try { out.paused = await vc.paused() } catch { /* optional */ }
    for (const sym of Object.keys(ASSETS)) {
      const a = ASSETS[sym]; const row: any = { available: null, balance: null }
      try { row.available = parseFloat(E.formatUnits(await vc.getAvailableLiquidity(a.address), a.decimals)) } catch {}
      try { const tok = new E.Contract(a.address, ERC20_ABI, provider); row.balance = parseFloat(E.formatUnits(await tok.balanceOf(vaultAddr), a.decimals)) } catch {}
      out.assets[sym] = row
    }
  } catch { /* RPC unavailable — return partial */ }
  return out
}
async function rpcBlock(): Promise<{ ok: boolean; block: number | null; latencyMs: number }> {
  const t0 = Date.now()
  try {
    const r = await fetch(RPC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }) })
    const j: any = await r.json()
    return { ok: !!(j && j.result), block: j && j.result ? parseInt(j.result, 16) : null, latencyMs: Date.now() - t0 }
  } catch { return { ok: false, block: null, latencyMs: Date.now() - t0 } }
}

// ─── Metrics engine (from local ledger) ──────────────────────────────────────
function computeMetrics(items: any[], vault: any) {
  const m: any = {
    scope: 'EXECDAAT', totalVolume: 0, tvl: 0, vaultBalance: 0, outstandingLiquidity: 0,
    pendingSettlement: 0, pendingReimbursement: 0, averageSettlementTime: 0, averageReimbursementTime: 0,
    bridgeSuccessRate: 0, todayVolume: 0, monthlyVolume: 0, intentCount: items.length, settledCount: 0,
    failedCount: 0, activeIntents: 0, assets: {}, chains: {}, bridges: {}, generatedAt: new Date().toISOString(),
  }
  const today0 = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() })()
  const month0 = (() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime() })()
  let settleTimes: number[] = [], reimbTimes: number[] = [], terminal = 0, success = 0
  for (const it of items) {
    const amt = toNum(it.amount), st = String(it.status || '')
    m.totalVolume += amt
    if (['TREASURY_PAID', 'WAITING_ATTESTATION', 'ATTESTED', 'MINTED', 'SETTLING', 'SETTLED'].indexOf(st) !== -1) m.outstandingLiquidity += amt
    if (st === 'SETTLED' || st === 'SETTLING') m.pendingReimbursement += amt
    if (st === 'MINTED' || st === 'ATTESTED') m.pendingSettlement += amt
    if (!TERMINAL[st]) m.activeIntents++
    if (st === 'REIMBURSED' || st === 'COMPLETED') success++
    if (TERMINAL[st]) terminal++
    if (st === 'FAILED') m.failedCount++
    if (st === 'REIMBURSED' || st === 'COMPLETED' || st === 'SETTLED') m.settledCount++
    if (it.settledAt && it.createdAt) settleTimes.push(it.settledAt - it.createdAt)
    if (it.reimbursedAt && it.settledAt) reimbTimes.push(it.reimbursedAt - it.settledAt)
    if (it.createdAt >= today0) m.todayVolume += amt
    if (it.createdAt >= month0) m.monthlyVolume += amt
    m.assets[it.asset] = (m.assets[it.asset] || 0) + amt
    const ch = it.sourceChain || 'unknown'; m.chains[ch] = (m.chains[ch] || 0) + 1
    const br = it.bridge || 'Turbo'; m.bridges[br] = (m.bridges[br] || 0) + 1
  }
  m.averageSettlementTime = settleTimes.length ? Math.round(settleTimes.reduce((a, b) => a + b, 0) / settleTimes.length) : 0
  m.averageReimbursementTime = reimbTimes.length ? Math.round(reimbTimes.reduce((a, b) => a + b, 0) / reimbTimes.length) : 0
  m.bridgeSuccessRate = terminal ? Math.round((success / terminal) * 10000) / 100 : 0
  if (vault && vault.assets) { let bal = 0, avail = 0; for (const s of Object.keys(vault.assets)) { bal += toNum(vault.assets[s].balance); avail += toNum(vault.assets[s].available) } m.vaultBalance = bal; m.tvl = bal; if (!m.outstandingLiquidity) m.outstandingLiquidity = Math.max(0, bal - avail) }
  return m
}

// ─── Local Application Registry (EXECDAAT only, no HMAC) ──────────────────────
function registry(env: CoreBindings) {
  return [{
    applicationId: (env.APPLICATION_ID || 'EXECDAAT'),
    displayName: 'ExecDaat',
    status: 'active',
    environment: 'self-contained',
    permissions: ['intents:create', 'intents:read', 'quote:read', 'execute:write', 'history:read', 'metrics:read', 'health:read', 'reimbursements:read'],
    authMode: 'local',
    core: true,
    version: 'v1',
    allowedOrigins: ['https://execdaat.xyz', 'https://www.execdaat.xyz'],
  }]
}

// ═════════════════════════════ ROUTES ════════════════════════════════════════

// GET /health — native, no external deps
router.get('/health', async (c) => {
  const cid = corr(c.req.header('X-Correlation-Id'))
  const [blk, vault] = await Promise.all([rpcBlock(), readVault(c.env).catch(() => null)])
  const okc = (s: boolean) => ({ status: s ? 'ok' : 'degraded' })
  const data = {
    status: blk.ok ? 'ok' : 'degraded', engine: 'ExecDaat Native Treasury Core', network: NETWORK, chainId: CHAIN_ID,
    components: {
      rpc: { status: blk.ok ? 'ok' : 'degraded', url: RPC_URL, blockNumber: blk.block, latencyMs: blk.latencyMs },
      circle: { status: 'ok', messageTransmitter: CIRCLE_TRANSMITTER, provider: 'Circle CCTP v2' },
      vault: { status: vault && vault.address ? 'ok' : 'degraded', address: vault ? vault.address : null, paused: vault ? vault.paused : null },
      treasury: okc(true), settlement: okc(true), reimbursement: okc(true), ledger: okc(true),
      bridge: { status: 'ok', provider: 'Circle CCTP v2', chainId: CHAIN_ID },
      workers: { status: 'ok', runtime: 'cloudflare_pages_functions' },
      storage: { status: 'ok', type: c.env.AGENT_INTENTS ? 'cloudflare_kv' : 'memory' },
      kv: { status: 'ok' },
    },
    dependencies: { elligent: 'none' },
    checkedAt: new Date().toISOString(),
  }
  return ok(c, data, cid)
})

// POST /intents — create/upsert a local intent (Intent + Ledger engines)
router.post('/intents', async (c) => {
  const cid = corr(c.req.header('X-Correlation-Id'))
  let body: any = {}
  try { body = await c.req.json() } catch { return fail(c, 400, 'Invalid JSON body', cid) }
  const providedId = String(body.intentId || body.id || '').trim()
  let it: any
  if (providedId) { it = await kvGet(c.env, 'tc:i:' + providedId) }
  if (!it) {
    it = {
      intentId: providedId && /^[A-Za-z0-9_.:-]{4,128}$/.test(providedId) ? providedId : genId('int_'),
      intentBytes32: isHex(body.intentBytes32, 64) ? body.intentBytes32 : bytes32(),
      correlationId: cid, ledgerEntry: genId('led_'), createdAt: now(), status: 'CREATED', timeline: [],
    }
    appendTimeline(it, 'CREATED')
  }
  it = normalizeBody(body, it)
  it.correlationId = it.correlationId || cid
  it = await upsertIntent(c.env, it)
  return ok(c, it, cid)
})

// GET /intents/:id — canonical intent state
router.get('/intents/:id', async (c) => {
  const cid = corr(c.req.header('X-Correlation-Id'))
  const id = c.req.param('id')
  const it = await kvGet(c.env, 'tc:i:' + id)
  if (!it) return fail(c, 404, 'Intent not found', cid)
  return ok(c, it, cid)
})

// POST /intents/:id/status — lifecycle update (Ledger append)
router.post('/intents/:id/status', async (c) => {
  const cid = corr(c.req.header('X-Correlation-Id'))
  const id = c.req.param('id')
  let it = await kvGet(c.env, 'tc:i:' + id)
  if (!it) return fail(c, 404, 'Intent not found', cid)
  let body: any = {}
  try { body = await c.req.json() } catch { return fail(c, 400, 'Invalid JSON body', cid) }
  it = normalizeBody(body, it)
  it = await upsertIntent(c.env, it)
  return ok(c, it, cid)
})

// POST /quote — local best-effort quote (Liquidity engine)
router.post('/quote', async (c) => {
  const cid = corr(c.req.header('X-Correlation-Id'))
  let body: any = {}
  try { body = await c.req.json() } catch { return fail(c, 400, 'Invalid JSON body', cid) }
  const amount = toNum(body.amount)
  if (amount <= 0) return fail(c, 400, 'Invalid amount', cid)
  const feeBps = DEFAULT_FEE_BPS
  const fee = Math.round((amount * feeBps) / 10000 * 1e6) / 1e6
  const receive = Math.round((amount - fee) * 1e6) / 1e6
  const data = {
    quoteId: genId('qt_'), application: 'EXECDAAT',
    sourceChain: body.sourceChain || body.srcChain || null, destinationChain: body.destinationChain || body.dstChain || 'arc',
    asset: String(body.asset || body.token || 'USDC').toUpperCase(), amount, feeBps, fee, receive,
    bridge: 'Turbo', etaSeconds: 20, expiresAt: new Date(now() + 60000).toISOString(),
  }
  return ok(c, data, cid)
})

// POST /execute — mark execution started (bridge stays client-side/on-chain)
router.post('/execute', async (c) => {
  const cid = corr(c.req.header('X-Correlation-Id'))
  let body: any = {}
  try { body = await c.req.json() } catch { return fail(c, 400, 'Invalid JSON body', cid) }
  const id = String(body.intentId || body.id || '').trim()
  if (!id) return fail(c, 400, 'intentId required', cid)
  let it = await kvGet(c.env, 'tc:i:' + id)
  if (!it) { it = { intentId: id, intentBytes32: bytes32(), correlationId: cid, ledgerEntry: genId('led_'), createdAt: now(), status: 'CREATED', timeline: [] } }
  it = normalizeBody(body, it)
  if (!TERMINAL[it.status]) it.status = 'WAITING_ATTESTATION'
  it = await upsertIntent(c.env, it)
  return ok(c, { intentId: it.intentId, status: it.status, ledgerEntry: it.ledgerEntry }, cid)
})

// GET /history — local ledger (filters via query)
router.get('/history', async (c) => {
  const cid = corr(c.req.header('X-Correlation-Id'))
  const url = new URL(c.req.url)
  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '200', 10) || 200))
  const wallet = (url.searchParams.get('wallet') || '').toLowerCase()
  const asset = (url.searchParams.get('asset') || '').toUpperCase()
  const status = (url.searchParams.get('status') || '').toUpperCase()
  let items = await readIndex(c.env)
  if (wallet) items = items.filter((x) => String(x.wallet || '').toLowerCase() === wallet)
  if (asset) items = items.filter((x) => String(x.asset || '').toUpperCase() === asset)
  if (status) items = items.filter((x) => String(x.status || '').toUpperCase() === status)
  items = items.slice(0, limit)
  return ok(c, { items, page: 1, total: items.length }, cid)
})

// GET /metrics — local aggregates (Metrics engine)
router.get('/metrics', async (c) => {
  const cid = corr(c.req.header('X-Correlation-Id'))
  const [items, vault] = await Promise.all([readIndex(c.env), readVault(c.env).catch(() => null)])
  return ok(c, computeMetrics(items, vault), cid)
})

// GET /reimbursements — reimbursement-focused view (Reimbursement engine)
router.get('/reimbursements', async (c) => {
  const cid = corr(c.req.header('X-Correlation-Id'))
  const items = await readIndex(c.env)
  const relevant = items.filter((x) => ['TREASURY_PAID', 'WAITING_ATTESTATION', 'ATTESTED', 'MINTED', 'SETTLING', 'SETTLED', 'REIMBURSED', 'COMPLETED'].indexOf(String(x.status)) !== -1)
  return ok(c, { items: relevant, total: relevant.length }, cid)
})

// GET /applications — local registry only
router.get('/applications', async (c) => {
  const cid = corr(c.req.header('X-Correlation-Id'))
  return ok(c, { applications: registry(c.env) }, cid)
})

// GET /liquidity — vault liquidity snapshot (Liquidity engine)
router.get('/liquidity', async (c) => {
  const cid = corr(c.req.header('X-Correlation-Id'))
  const [vault, items] = await Promise.all([readVault(c.env).catch(() => null), readIndex(c.env)])
  const m = computeMetrics(items, vault)
  const rows = vault && vault.assets ? Object.keys(vault.assets).map((s) => ({ asset: s, available: vault.assets[s].available, balance: vault.assets[s].balance })) : []
  return ok(c, { vault: vault ? vault.address : null, network: NETWORK, chainId: CHAIN_ID, assets: rows, outstandingLiquidity: m.outstandingLiquidity, pendingReimbursement: m.pendingReimbursement, tvl: m.tvl }, cid)
})

// GET /vault — vault engine snapshot
router.get('/vault', async (c) => {
  const cid = corr(c.req.header('X-Correlation-Id'))
  const [vault, items] = await Promise.all([readVault(c.env).catch(() => null), readIndex(c.env)])
  const m = computeMetrics(items, vault)
  return ok(c, {
    address: vault ? vault.address : DEFAULT_VAULT, network: NETWORK, chainId: CHAIN_ID, paused: vault ? vault.paused : null,
    assets: vault ? vault.assets : {}, tvl: m.tvl, outstanding: m.outstandingLiquidity,
    pendingSettlement: m.pendingSettlement, pendingReimbursement: m.pendingReimbursement,
  }, cid)
})

export default router
