// ============================================================
// AGENT RELAY — Meta-Transaction Relayer v2
// ExecDaat · Arc Testnet · Chain ID 5042002
// Build: 20260404h
//
// POST /api/agent/relay               — submit signed intent for gasless execution
// GET  /api/agent/relay/:id           — poll relay job status
// GET  /api/agent/relay/nonce/:wallet — get current nonce for wallet
// POST /api/agent/relay/permit        — store signed permit (approve + EIP-712 sig)
// GET  /api/agent/relay/permit/:wallet — check permit status for wallet
//
// GASLESS FLOW (no wallet popup after initial setup):
//   1. User clicks "Setup gasless" → ONE-TIME approve() popup
//   2. User types "send 10 USDC to 0x…" → ONE signTypedData popup (signs the intent)
//   3. Frontend POSTs signed payload to /api/agent/relay
//   4. Backend relayer (with RELAYER_PRIVATE_KEY) calls AgentExecutor.execute()
//   5. No more wallet popups — relayer pays all gas
//
// KEY FIX: buildAndSignTx() now uses @noble/secp256k1 for real secp256k1 signing
// ============================================================

import { Hono } from 'hono'
import * as secp from '@noble/secp256k1'
import { keccak_256 } from '@noble/hashes/sha3.js'

// ─── Types ──────────────────────────────────────────────────────────────────
type Bindings = {
  AGENT_INTENTS?: KVNamespace
  RELAYER_PRIVATE_KEY?: string
  [key: string]: unknown
}

type RelayJobStatus =
  | 'queued'
  | 'validating'
  | 'executing'
  | 'broadcast'
  | 'completed'
  | 'failed'
  | 'rejected'

type RelayJobType = 'transfer' | 'batch' | 'call'

interface RelayJob {
  id:          string
  type:        RelayJobType
  status:      RelayJobStatus
  from:        string
  token:       string
  to?:         string
  amount?:     string
  amountRaw?:  string
  recipients?: Array<{ address: string; amount: string; amountRaw: string }>
  nonce:       string
  deadline:    string
  signature:   string
  txHash?:     string
  blockNumber?: number
  gasUsed?:    string
  error?:      string
  intentId?:   string
  createdAt:   string
  updatedAt:   string
  completedAt?: string
}

interface StoredPermit {
  wallet:      string
  token:       string
  amount:      string
  amountRaw:   string
  nonce:       string
  deadline:    string
  signature:   string  // EIP-712 signature of the permit
  approvedAt:  string
  expiresAt:   string  // ISO string
}

// ─── Constants ──────────────────────────────────────────────────────────────
const RELAY_KV_TTL    = 24 * 60 * 60
const PERMIT_KV_TTL   = 25 * 60 * 60   // 25h (permits last 24h)
const RATE_LIMIT_TTL  = 60
const MAX_RATE        = 20
const MAX_AMOUNT_USDC = 10_000 * 1_000_000
const MAX_BATCH_TOTAL = MAX_AMOUNT_USDC * 10

const CHAIN_ID   = 5042002
const RPC_URL    = 'https://rpc.testnet.arc.network'
const EXPLORER   = 'https://testnet.arcscan.app'

const ALLOWED_TOKENS: Record<string, string> = {
  '0x3600000000000000000000000000000000000000': 'USDC',
  '0x89b50855aa3be2f677cd6303cec089b5f319d72a': 'EURC',
}

// AgentExecutor contract — set after deploying AgentExecutor.sol
// Override via localStorage("ae_contract_addr") on frontend or set here after deploy
const AGENT_EXECUTOR_ADDR = (function () {
  // Will be updated when contract is deployed
  return '0x0000000000000000000000000000000000000000'
})()

const EIP712_DOMAIN = {
  name:              'AgentExecutor',
  version:           '1',
  chainId:           CHAIN_ID,
  verifyingContract: AGENT_EXECUTOR_ADDR,
}

// ─── Noble secp256k1 helpers ─────────────────────────────────────────────────

/** keccak256 using @noble/hashes */
function keccak256(data: Uint8Array): Uint8Array {
  return keccak_256(data)
}

function keccak256Hex(data: Uint8Array): string {
  return bytesToHex(keccak256(data))
}

/** Derive Ethereum address from private key */
function privateKeyToAddress(privateKey: string): string {
  const pkBytes = hexToBytes(privateKey.replace('0x', ''))
  const pubKey  = secp.getPublicKey(pkBytes, false)  // uncompressed 65 bytes
  // Remove prefix byte (0x04), keccak256 of the 64-byte x+y, take last 20 bytes
  const pubKeyBody = pubKey.slice(1)
  const hash = keccak256(pubKeyBody)
  return '0x' + bytesToHex(hash.slice(-20))
}

/** Sign a 32-byte hash with secp256k1 private key, return r,s,v */
async function ecSign(
  hash: Uint8Array,
  privateKey: string,
  chainId: number,
): Promise<{ r: bigint; s: bigint; v: bigint }> {
  const pkBytes = hexToBytes(privateKey.replace('0x', ''))
  const sig = await secp.signAsync(hash, pkBytes)
  const r = sig.r
  const s = sig.s
  const recovery = sig.recovery
  // EIP-155: v = chainId * 2 + 35 + recovery
  const v = BigInt(chainId) * 2n + 35n + BigInt(recovery)
  return { r, s, v }
}

// ─── RPC helpers ─────────────────────────────────────────────────────────────

async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
  const r = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const d = await r.json() as { result?: unknown; error?: { message: string } }
  if (d.error) throw new Error(`RPC ${method}: ${d.error.message}`)
  return d.result
}

async function getOnChainNonce(wallet: string): Promise<bigint> {
  if (AGENT_EXECUTOR_ADDR === '0x0000000000000000000000000000000000000000') return 0n
  try {
    const data = '0x7ecebe00' + wallet.replace('0x', '').padStart(64, '0')
    const result = await rpcCall('eth_call', [{ to: AGENT_EXECUTOR_ADDR, data }, 'latest']) as string
    return result && result !== '0x' ? BigInt(result) : 0n
  } catch {
    return 0n
  }
}

async function sendRelayTx(signedTx: string): Promise<string> {
  const result = await rpcCall('eth_sendRawTransaction', [signedTx]) as string
  return result
}

async function getTxReceipt(txHash: string): Promise<{ status: string; blockNumber: string; gasUsed: string } | null> {
  try {
    const result = await rpcCall('eth_getTransactionReceipt', [txHash]) as
      { status: string; blockNumber: string; gasUsed: string } | null
    return result
  } catch {
    return null
  }
}

// ─── KV helpers ─────────────────────────────────────────────────────────────

const _relayMem  = new Map<string, RelayJob>()
const _permitMem = new Map<string, StoredPermit>()

async function jobGet(kv: KVNamespace | undefined, id: string): Promise<RelayJob | null> {
  if (!kv) return _relayMem.get(id) ?? null
  const v = await kv.get(`relay:${id}`)
  if (!v) return null
  try { return JSON.parse(v) as RelayJob } catch { return null }
}

async function jobPut(kv: KVNamespace | undefined, job: RelayJob): Promise<void> {
  if (!kv) { _relayMem.set(job.id, job); return }
  await kv.put(`relay:${job.id}`, JSON.stringify(job), { expirationTtl: RELAY_KV_TTL })
}

async function permitGet(kv: KVNamespace | undefined, wallet: string, token: string): Promise<StoredPermit | null> {
  const key = `permit:${wallet.toLowerCase()}:${token.toLowerCase()}`
  if (!kv) return _permitMem.get(key) ?? null
  const v = await kv.get(key)
  if (!v) return null
  try { return JSON.parse(v) as StoredPermit } catch { return null }
}

async function permitPut(kv: KVNamespace | undefined, permit: StoredPermit): Promise<void> {
  const key = `permit:${permit.wallet.toLowerCase()}:${permit.token.toLowerCase()}`
  if (!kv) { _permitMem.set(key, permit); return }
  await kv.put(key, JSON.stringify(permit), { expirationTtl: PERMIT_KV_TTL })
}

async function checkRateLimit(kv: KVNamespace | undefined, wallet: string): Promise<boolean> {
  if (!kv) return true
  const key = `relay:ratelimit:${wallet.toLowerCase()}`
  const raw = await kv.get(key)
  const count = raw ? parseInt(raw) : 0
  if (count >= MAX_RATE) return false
  await kv.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_TTL })
  return true
}

async function updateLinkedIntent(
  kv: KVNamespace | undefined,
  intentId: string,
  updates: Record<string, unknown>
): Promise<void> {
  if (!kv || !intentId) return
  try {
    const raw = await kv.get(`intent:${intentId}`)
    if (!raw) return
    const intent = JSON.parse(raw)
    Object.assign(intent, updates, { updatedAt: new Date().toISOString() })
    if (updates.status === 'completed' || updates.status === 'failed') {
      intent.completedAt = new Date().toISOString()
    }
    await kv.put(`intent:${intentId}`, JSON.stringify(intent), { expirationTtl: 7 * 24 * 60 * 60 })
  } catch { /* ignore */ }
}

// ─── Utility helpers ─────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const h = hex.replace('0x', '').padStart(hex.replace('0x','').length % 2 ? hex.replace('0x','').length+1 : hex.replace('0x','').length, '0')
  const arr = new Uint8Array(h.length / 2)
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(h.slice(i*2, i*2+2), 16)
  return arr
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2,'0')).join('')
}

function padLeft32(hex: string): string {
  return hex.replace('0x','').toLowerCase().padStart(64,'0')
}

function toBigHex(val: string): string {
  return BigInt(val).toString(16).padStart(64, '0')
}

function toUint256(n: number | bigint): string {
  return BigInt(n).toString(16).padStart(64, '0')
}

function bigintToMinHex(n: bigint): string {
  if (n === 0n) return ''
  return n.toString(16).replace(/^0+/, '') || '0'
}

function bigintToBytes(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array(0)
  const h = n.toString(16).padStart(n.toString(16).length % 2 ? n.toString(16).length + 1 : n.toString(16).length, '0')
  return hexToBytes(h)
}

function _nowISO()  { return new Date().toISOString() }
function _genId()   { return 'relay-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7) }
function _isAddr(a: unknown): a is string {
  return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)
}
function _isSig(a: unknown): a is string {
  return typeof a === 'string' && /^0x[0-9a-fA-F]{130}$/.test(a)
}

// ─── ABI encoding for AgentExecutor calls ────────────────────────────────────

function encodeExecute(job: RelayJob): string {
  // execute(address from, address token, address to, uint256 amount, uint256 nonce, uint256 deadline, bytes sig)
  // Selector keccak256("execute(address,address,address,uint256,uint256,uint256,bytes)") = first 4 bytes
  // Precomputed: 0x9a8a0592
  const selector = '9a8a0592'

  const from     = padLeft32(job.from)
  const token    = padLeft32(job.token)
  const to       = padLeft32(job.to || '0x0000000000000000000000000000000000000000')
  const amount   = toBigHex(job.amountRaw || '0')
  const nonce    = toBigHex(job.nonce)
  const deadline = toBigHex(job.deadline)

  // bytes offset: 7 static params * 32 = 224
  const sigOffset = toUint256(7 * 32)
  const sigHex    = job.signature.replace('0x', '')
  const sigLen    = toUint256(65)
  // pad to 96 bytes (3 * 32)
  const sigPadded = sigHex + '0'.repeat(192 - sigHex.length)

  return '0x' + selector + from + token + to + amount + nonce + deadline + sigOffset + sigLen + sigPadded
}

function encodeExecuteBatch(job: RelayJob): string {
  // executeBatch(address from, address token, address[] recipients, uint256[] amounts, uint256 nonce, uint256 deadline, bytes sig)
  // Selector keccak256("executeBatch(address,address,address[],uint256[],uint256,uint256,bytes)") 
  // Precomputed: 0xa3951c6b
  const selector = 'a3951c6b'

  if (!job.recipients || job.recipients.length === 0) {
    throw new Error('No recipients for batch')
  }

  const n = job.recipients.length

  const from     = padLeft32(job.from)
  const token    = padLeft32(job.token)
  const nonce    = toBigHex(job.nonce)
  const deadline = toBigHex(job.deadline)

  // Offsets for dynamic params (from, token are static 32-byte each → 2 params)
  // param positions: from(0), token(1), recipients_offset(2), amounts_offset(3), nonce(4), deadline(5), sig_offset(6)
  // Static section: 7 * 32 = 224 bytes
  // recipients array: at offset 224 → length(32) + n*32
  const recipientsOffset = toUint256(7 * 32)                         // 224
  const amountsOffset    = toUint256(7 * 32 + 32 + n * 32)           // 224 + 32 + n*32
  const sigOffset        = toUint256(7 * 32 + 32 + n * 32 + 32 + n * 32) // after amounts array

  const recLen    = toUint256(n)
  const recAddrs  = job.recipients.map(r => padLeft32(r.address)).join('')
  const amtLen    = toUint256(n)
  const recAmts   = job.recipients.map(r => toBigHex(r.amountRaw)).join('')

  const sigHex    = job.signature.replace('0x', '')
  const sigLen    = toUint256(65)
  const sigPadded = sigHex + '0'.repeat(192 - sigHex.length)

  return '0x' + selector +
    from + token +
    recipientsOffset + amountsOffset + nonce + deadline + sigOffset +
    recLen + recAddrs +
    amtLen + recAmts +
    sigLen + sigPadded
}

// ─── RLP encoding ─────────────────────────────────────────────────────────────

function rlpEncodeBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 1 && bytes[0] < 0x80) return bytes
  if (bytes.length === 0) return new Uint8Array([0x80])
  const prefix = rlpStringPrefix(bytes.length)
  const result = new Uint8Array(prefix.length + bytes.length)
  result.set(prefix); result.set(bytes, prefix.length)
  return result
}

function rlpEncodeString(hex: string): Uint8Array {
  const h = hex.replace('0x', '').replace(/^0+/, '') || ''
  if (h === '') return new Uint8Array([0x80])
  const bytes = hexToBytes(h.length % 2 ? '0' + h : h)
  return rlpEncodeBytes(bytes)
}

function rlpStringPrefix(len: number): Uint8Array {
  if (len <= 55) return new Uint8Array([0x80 + len])
  const lenBytes = bigintToBytes(BigInt(len))
  return new Uint8Array([0xb7 + lenBytes.length, ...Array.from(lenBytes)])
}

function rlpListPrefix(len: number): Uint8Array {
  if (len <= 55) return new Uint8Array([0xc0 + len])
  const lenBytes = bigintToBytes(BigInt(len))
  return new Uint8Array([0xf7 + lenBytes.length, ...Array.from(lenBytes)])
}

function rlpList(items: Uint8Array[]): Uint8Array {
  const total = items.reduce((s, i) => s + i.length, 0)
  const prefix = rlpListPrefix(total)
  const result = new Uint8Array(prefix.length + total)
  result.set(prefix)
  let offset = prefix.length
  for (const item of items) { result.set(item, offset); offset += item.length }
  return result
}

// ─── Build & sign EIP-155 legacy transaction ─────────────────────────────────

interface LegacyTxParams {
  nonce: number; gasPrice: bigint; gas: bigint;
  to: string; value: bigint; data: string; chainId: number;
}

async function buildAndSignTx(callData: string, privateKey: string): Promise<string> {
  // Derive relayer address
  const relayerAddr = privateKeyToAddress(privateKey)
  console.log(`[RELAY] Signing tx from relayer: ${relayerAddr}`)

  const [nonceHex, gasPriceHex] = await Promise.all([
    rpcCall('eth_getTransactionCount', [relayerAddr, 'latest']) as Promise<string>,
    rpcCall('eth_gasPrice', []) as Promise<string>,
  ])

  const txNonce  = parseInt(String(nonceHex), 16)
  const gasPrice = BigInt(String(gasPriceHex)) * 110n / 100n  // +10% buffer

  // Estimate gas
  let gasLimit = 250_000n
  try {
    const estHex = await rpcCall('eth_estimateGas', [{
      from: relayerAddr,
      to:   AGENT_EXECUTOR_ADDR,
      data: callData,
    }]) as string
    gasLimit = BigInt(String(estHex)) * 130n / 100n  // +30% buffer
  } catch (e) {
    console.warn('[RELAY] Gas estimation failed, using 250k default:', String(e))
  }

  const chainId = CHAIN_ID

  // Build signing payload: RLP([nonce, gasPrice, gas, to, value, data, chainId, 0, 0])
  const rlpForSigning = rlpList([
    rlpEncodeString(bigintToMinHex(BigInt(txNonce))),
    rlpEncodeString(bigintToMinHex(gasPrice)),
    rlpEncodeString(bigintToMinHex(gasLimit)),
    rlpEncodeBytes(hexToBytes(AGENT_EXECUTOR_ADDR.replace('0x', ''))),
    rlpEncodeString(''),   // value = 0
    // data as bytes
    (function() {
      const dataBytes = hexToBytes(callData.replace('0x', ''))
      return rlpEncodeBytes(dataBytes)
    })(),
    rlpEncodeString(bigintToMinHex(BigInt(chainId))),
    new Uint8Array([0x80]),  // v = 0
    new Uint8Array([0x80]),  // r = 0
  ])

  // Hash for signing
  const txHash = keccak256(rlpForSigning)

  // Sign with secp256k1
  const { r, s, v } = await ecSign(txHash, privateKey, chainId)

  // Build signed transaction: RLP([nonce, gasPrice, gas, to, value, data, v, r, s])
  const signedRlp = rlpList([
    rlpEncodeString(bigintToMinHex(BigInt(txNonce))),
    rlpEncodeString(bigintToMinHex(gasPrice)),
    rlpEncodeString(bigintToMinHex(gasLimit)),
    rlpEncodeBytes(hexToBytes(AGENT_EXECUTOR_ADDR.replace('0x', ''))),
    rlpEncodeString(''),
    (function() {
      const dataBytes = hexToBytes(callData.replace('0x', ''))
      return rlpEncodeBytes(dataBytes)
    })(),
    rlpEncodeString(bigintToMinHex(v)),
    rlpEncodeString(bigintToMinHex(r)),
    rlpEncodeString(bigintToMinHex(s)),
  ])

  return '0x' + bytesToHex(signedRlp)
}

// ─── Execute relay job ────────────────────────────────────────────────────────

async function executeRelayJob(
  kv: KVNamespace | undefined,
  job: RelayJob,
  privateKey: string,
): Promise<void> {
  try {
    // Check if AgentExecutor is deployed
    if (AGENT_EXECUTOR_ADDR === '0x0000000000000000000000000000000000000000') {
      throw new Error(
        'AgentExecutor contract not deployed. ' +
        'Visit /static/deploy-agent to deploy it first. ' +
        'Then update AGENT_EXECUTOR_ADDR in agent-relay.ts.'
      )
    }

    job.status    = 'executing'
    job.updatedAt = _nowISO()
    await jobPut(kv, job)
    if (job.intentId) await updateLinkedIntent(kv, job.intentId, { status: 'processing' })

    let callData: string
    if (job.type === 'transfer') {
      callData = encodeExecute(job)
    } else if (job.type === 'batch') {
      callData = encodeExecuteBatch(job)
    } else {
      throw new Error(`Unsupported job type: ${job.type}`)
    }

    const signedTx = await buildAndSignTx(callData, privateKey)

    job.status    = 'broadcast'
    job.updatedAt = _nowISO()
    await jobPut(kv, job)
    if (job.intentId) await updateLinkedIntent(kv, job.intentId, { status: 'broadcast' })

    const txHash = await sendRelayTx(signedTx)
    job.txHash    = txHash
    job.updatedAt = _nowISO()
    await jobPut(kv, job)
    if (job.intentId) await updateLinkedIntent(kv, job.intentId, { status: 'broadcast', txHash })

    console.log(`[RELAY] Broadcast: ${job.id} → ${txHash}`)

    // Wait for confirmation (up to 60s)
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 3000))
      const receipt = await getTxReceipt(txHash)
      if (receipt) {
        const success = receipt.status === '0x1'
        job.status      = success ? 'completed' : 'failed'
        job.blockNumber = parseInt(receipt.blockNumber, 16)
        job.gasUsed     = receipt.gasUsed
        job.error       = success ? undefined : 'Transaction reverted on-chain'
        job.completedAt = _nowISO()
        job.updatedAt   = _nowISO()
        await jobPut(kv, job)
        if (job.intentId) {
          await updateLinkedIntent(kv, job.intentId, {
            status: job.status, txHash, blockNumber: job.blockNumber,
          })
        }
        console.log(`[RELAY] ${success ? 'Completed ✅' : 'Failed ❌'}: ${job.id} block=${job.blockNumber}`)
        return
      }
    }

    // Still pending — leave as broadcast
    console.log(`[RELAY] Still pending (not confirmed after 60s): ${job.id}`)

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    job.status      = 'failed'
    job.error       = msg.slice(0, 400)
    job.completedAt = _nowISO()
    job.updatedAt   = _nowISO()
    await jobPut(kv, job)
    if (job.intentId) await updateLinkedIntent(kv, job.intentId, { status: 'failed', error: job.error })
    console.error(`[RELAY] Failed: ${job.id} — ${msg}`)
  }
}

// ─── Router ──────────────────────────────────────────────────────────────────
const agentRelayRouter = new Hono<{ Bindings: Bindings }>()

// ── POST /api/agent/relay — Submit signed intent ──────────────────────────
agentRelayRouter.post('/relay', async (c) => {
  const kv = c.env?.AGENT_INTENTS as KVNamespace | undefined

  let body: Record<string, unknown>
  try { body = await c.req.json() } catch {
    return c.json({ success: false, error: 'Invalid JSON body' }, 400)
  }

  const {
    type = 'transfer',
    from, token, to, amount, amountRaw,
    recipients, nonce, deadline, signature, intentId,
  } = body as Record<string, unknown>

  // Validations
  if (!_isAddr(from))    return c.json({ success: false, error: '"from" must be a valid 0x address' }, 400)
  if (!_isAddr(token))   return c.json({ success: false, error: '"token" must be a valid 0x address' }, 400)
  if (!_isSig(signature)) return c.json({ success: false, error: '"signature" must be 65-byte hex (0x + 130 chars)' }, 400)
  if (!nonce || isNaN(Number(nonce)))       return c.json({ success: false, error: '"nonce" must be a number' }, 400)
  if (!deadline || isNaN(Number(deadline))) return c.json({ success: false, error: '"deadline" must be a unix timestamp' }, 400)

  const tokenLower = (token as string).toLowerCase()
  if (!ALLOWED_TOKENS[tokenLower]) {
    return c.json({ success: false, error: 'Token not whitelisted. Only USDC and EURC are supported.' }, 400)
  }

  const deadlineNum = Number(deadline)
  if (Date.now() / 1000 > deadlineNum) {
    return c.json({ success: false, error: 'Deadline has expired.' }, 400)
  }

  if (type === 'transfer') {
    if (!_isAddr(to)) return c.json({ success: false, error: '"to" must be a valid 0x address for transfer type' }, 400)
    const rawAmt = amountRaw ? BigInt(String(amountRaw)) : 0n
    if (rawAmt <= 0n) return c.json({ success: false, error: '"amountRaw" must be > 0' }, 400)
    if (rawAmt > BigInt(MAX_AMOUNT_USDC)) return c.json({ success: false, error: `Amount exceeds max (${MAX_AMOUNT_USDC / 1_000_000} USDC)` }, 400)
  } else if (type === 'batch') {
    if (!Array.isArray(recipients) || recipients.length === 0) {
      return c.json({ success: false, error: '"recipients" array is required for batch type' }, 400)
    }
    let total = 0n
    for (const r of recipients as Array<Record<string, unknown>>) {
      if (!_isAddr(r.address)) return c.json({ success: false, error: `Invalid recipient address: ${r.address}` }, 400)
      const rAmt = r.amountRaw ? BigInt(String(r.amountRaw)) : 0n
      if (rAmt <= 0n) return c.json({ success: false, error: `Amount must be > 0 for ${r.address}` }, 400)
      total += rAmt
    }
    if (total > BigInt(MAX_BATCH_TOTAL)) {
      return c.json({ success: false, error: `Batch total exceeds max (${MAX_BATCH_TOTAL / 1_000_000} USDC)` }, 400)
    }
  } else {
    return c.json({ success: false, error: `Unsupported relay type: "${type}". Use "transfer" or "batch".` }, 400)
  }

  const allowed = await checkRateLimit(kv, from as string)
  if (!allowed) {
    return c.json({ success: false, error: 'Rate limit exceeded. Max 20 relay requests per minute.' }, 429)
  }

  // Validate on-chain nonce
  const onChainNonce   = await getOnChainNonce(from as string)
  const requestedNonce = BigInt(String(nonce))
  if (AGENT_EXECUTOR_ADDR !== '0x0000000000000000000000000000000000000000' &&
      requestedNonce !== onChainNonce) {
    return c.json({
      success: false,
      error: `Nonce mismatch. On-chain: ${onChainNonce}, provided: ${requestedNonce}. Refresh and retry.`,
      onChainNonce: onChainNonce.toString(),
    }, 409)
  }

  const jobId = _genId()
  const job: RelayJob = {
    id:         jobId,
    type:       type as RelayJobType,
    status:     'queued',
    from:       (from as string).toLowerCase(),
    token:      tokenLower,
    to:         to ? (to as string).toLowerCase() : undefined,
    amount:     amount ? String(amount) : undefined,
    amountRaw:  amountRaw ? String(amountRaw) : undefined,
    recipients: recipients as RelayJob['recipients'],
    nonce:      String(nonce),
    deadline:   String(deadline),
    signature:  signature as string,
    intentId:   intentId ? String(intentId) : undefined,
    createdAt:  _nowISO(),
    updatedAt:  _nowISO(),
  }

  await jobPut(kv, job)

  if (job.intentId) {
    await updateLinkedIntent(kv, job.intentId, { status: 'signing', relayJobId: jobId })
  }

  console.log(`[RELAY] Queued: ${jobId} type=${type} from=${job.from.slice(0,10)}…`)

  // Attempt immediate execution if private key is configured
  const pk = c.env?.RELAYER_PRIVATE_KEY
  if (pk) {
    // Execute asynchronously (don't block the HTTP response)
    if (c.executionCtx?.waitUntil) {
      c.executionCtx.waitUntil(executeRelayJob(kv, job, pk))
    } else {
      // Fallback: fire and forget
      executeRelayJob(kv, job, pk).catch(console.error)
    }
  }

  return c.json({
    success:   true,
    jobId,
    status:    'queued',
    relayerConfigured: !!pk,
    agentContractDeployed: AGENT_EXECUTOR_ADDR !== '0x0000000000000000000000000000000000000000',
    message:   pk
      ? `✅ Intent queued for immediate gasless execution. Poll /api/agent/relay/${jobId} for updates.`
      : '⚠️ Intent queued but RELAYER_PRIVATE_KEY not set. Configure via: npx wrangler secret put RELAYER_PRIVATE_KEY',
  }, 201)
})

// ── GET /api/agent/relay/nonce/:wallet — Get on-chain nonce ───────────────
// IMPORTANT: This route must come BEFORE /relay/:id to avoid param collision
agentRelayRouter.get('/relay/nonce/:wallet', async (c) => {
  const wallet = c.req.param('wallet')
  if (!_isAddr(wallet)) return c.json({ success: false, error: 'Invalid wallet address' }, 400)
  const nonce = await getOnChainNonce(wallet)
  return c.json({
    success: true,
    wallet:  wallet.toLowerCase(),
    nonce:   nonce.toString(),
    domain:  EIP712_DOMAIN,
    contractDeployed: AGENT_EXECUTOR_ADDR !== '0x0000000000000000000000000000000000000000',
    contractAddress:  AGENT_EXECUTOR_ADDR,
  })
})

// ── POST /api/agent/relay/permit — Store signed permit ────────────────────
// Called after user does one-time approve() + signTypedData for the permit
// This stores the permit on the backend so future intents can reuse it
agentRelayRouter.post('/relay/permit', async (c) => {
  const kv = c.env?.AGENT_INTENTS as KVNamespace | undefined

  let body: Record<string, unknown>
  try { body = await c.req.json() } catch {
    return c.json({ success: false, error: 'Invalid JSON body' }, 400)
  }

  const { wallet, token, amount, amountRaw, nonce, deadline, signature } = body

  if (!_isAddr(wallet))    return c.json({ success: false, error: 'Invalid wallet address' }, 400)
  if (!_isAddr(token))     return c.json({ success: false, error: 'Invalid token address' }, 400)
  if (!_isSig(signature as string))  return c.json({ success: false, error: 'Invalid signature' }, 400)
  if (!deadline || isNaN(Number(deadline))) return c.json({ success: false, error: 'Invalid deadline' }, 400)

  const deadlineNum = Number(deadline)
  if (Date.now() / 1000 > deadlineNum) {
    return c.json({ success: false, error: 'Permit deadline already expired' }, 400)
  }

  const expiresAt = new Date(deadlineNum * 1000).toISOString()
  const permit: StoredPermit = {
    wallet:     (wallet as string).toLowerCase(),
    token:      (token as string).toLowerCase(),
    amount:     String(amount || '0'),
    amountRaw:  String(amountRaw || '0'),
    nonce:      String(nonce || '0'),
    deadline:   String(deadline),
    signature:  signature as string,
    approvedAt: _nowISO(),
    expiresAt,
  }

  await permitPut(kv, permit)
  console.log(`[RELAY] Permit stored: wallet=${permit.wallet.slice(0,10)}… token=${permit.token.slice(0,10)}… expires=${expiresAt}`)

  return c.json({
    success:  true,
    message:  'Permit stored. Future intents will be executed automatically without wallet popups.',
    expiresAt,
    wallet:   permit.wallet,
  })
})

// ── GET /api/agent/relay/permit/:wallet — Check permit status ────────────
agentRelayRouter.get('/relay/permit/:wallet', async (c) => {
  const kv     = c.env?.AGENT_INTENTS as KVNamespace | undefined
  const wallet = c.req.param('wallet')
  if (!_isAddr(wallet)) return c.json({ success: false, error: 'Invalid wallet address' }, 400)

  // Check both USDC and EURC
  const usdcPermit = await permitGet(kv, wallet, '0x3600000000000000000000000000000000000000')
  const eurcPermit = await permitGet(kv, wallet, '0x89b50855aa3be2f677cd6303cec089b5f319d72a')

  const now = Date.now() / 1000
  const activePermits = [usdcPermit, eurcPermit].filter(p => p && Number(p.deadline) > now) as StoredPermit[]

  return c.json({
    success:      true,
    hasPermit:    activePermits.length > 0,
    permits:      activePermits.map(p => ({
      token:     p.token,
      amount:    p.amount,
      expiresAt: p.expiresAt,
      approvedAt: p.approvedAt,
    })),
    contractDeployed: AGENT_EXECUTOR_ADDR !== '0x0000000000000000000000000000000000000000',
    contractAddress:  AGENT_EXECUTOR_ADDR,
  })
})

// ── GET /api/agent/relay/:id — Poll job status ────────────────────────────
agentRelayRouter.get('/relay/:id', async (c) => {
  const kv  = c.env?.AGENT_INTENTS as KVNamespace | undefined
  const id  = c.req.param('id')
  const job = await jobGet(kv, id)
  if (!job) return c.json({ success: false, error: 'Relay job not found' }, 404)

  // If broadcast, poll receipt
  if (job.status === 'broadcast' && job.txHash) {
    const receipt = await getTxReceipt(job.txHash)
    if (receipt) {
      const success = receipt.status === '0x1'
      job.status      = success ? 'completed' : 'failed'
      job.blockNumber = parseInt(receipt.blockNumber, 16)
      job.gasUsed     = receipt.gasUsed
      job.error       = success ? undefined : 'Transaction reverted on-chain'
      job.completedAt = _nowISO()
      job.updatedAt   = _nowISO()
      await jobPut(kv, job)
      if (job.intentId) {
        await updateLinkedIntent(kv, job.intentId, {
          status: job.status, txHash: job.txHash,
          blockNumber: job.blockNumber, error: job.error,
        })
      }
    }
  }

  return c.json({
    success: true,
    job: {
      id:          job.id,
      status:      job.status,
      txHash:      job.txHash,
      blockNumber: job.blockNumber,
      gasUsed:     job.gasUsed,
      error:       job.error,
      createdAt:   job.createdAt,
      updatedAt:   job.updatedAt,
      completedAt: job.completedAt,
      explorer:    job.txHash ? `${EXPLORER}/tx/${job.txHash}` : undefined,
    },
  })
})

// ── GET /api/agent/relay/status — Relay system status ─────────────────────
agentRelayRouter.get('/relay/status', async (c) => {
  const pk = c.env?.RELAYER_PRIVATE_KEY
  const relayerAddr = pk ? privateKeyToAddress(pk) : null

  return c.json({
    success:              true,
    relayerConfigured:    !!pk,
    relayerAddress:       relayerAddr,
    contractDeployed:     AGENT_EXECUTOR_ADDR !== '0x0000000000000000000000000000000000000000',
    contractAddress:      AGENT_EXECUTOR_ADDR,
    chainId:              CHAIN_ID,
    network:              'Arc Testnet',
    capabilities:         !!pk && AGENT_EXECUTOR_ADDR !== '0x0000000000000000000000000000000000000000'
      ? ['gasless_transfer', 'gasless_batch']
      : ['queued_only'],
    message:
      !pk                     ? '⚠️ RELAYER_PRIVATE_KEY not set — set via wrangler secret put' :
      AGENT_EXECUTOR_ADDR === '0x0000000000000000000000000000000000000000'
                              ? '⚠️ AgentExecutor not deployed — visit /static/deploy-agent' :
                                '✅ Relay system fully operational',
  })
})

// ── POST /api/agent/relay/execute — Trigger executor loop (cron/manual) ──
agentRelayRouter.post('/relay/execute', async (c) => {
  const kv = c.env?.AGENT_INTENTS as KVNamespace | undefined
  const pk = c.env?.RELAYER_PRIVATE_KEY

  if (!pk) {
    return c.json({
      success: false,
      error:   'RELAYER_PRIVATE_KEY not configured.',
      setup: {
        step1: 'Deploy AgentExecutor.sol via /static/deploy-agent',
        step2: 'npx wrangler secret put RELAYER_PRIVATE_KEY',
        step3: 'Update AGENT_EXECUTOR_ADDR in agent-relay.ts',
      },
    }, 503)
  }

  const queued: RelayJob[] = []
  for (const job of _relayMem.values()) {
    if (job.status === 'queued') queued.push(job)
  }

  const results = await Promise.allSettled(
    queued.slice(0, 5).map(job => executeRelayJob(kv, job, pk))
  )

  return c.json({
    success:   true,
    processed: queued.length,
    results:   results.map((r, i) => ({
      jobId:   queued[i].id,
      settled: r.status,
      reason:  r.status === 'rejected' ? String((r as PromiseRejectedResult).reason) : undefined,
    })),
  })
})

export default agentRelayRouter
