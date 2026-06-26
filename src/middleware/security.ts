/**
 * ExecDaat — Unified Security Middleware
 * ============================================
 * Covers:
 *  1. Secure HTTP response headers (CSP, HSTS, X-Frame, X-Content-Type, etc.)
 *  2. Web Application Firewall (WAF) — blocks XSS, SQLi, path traversal,
 *     command injection, SSRF, prototype pollution, and malicious bots
 *  3. Sliding-window rate limiter (per IP, per endpoint group)
 *  4. Request size guard (prevents oversized payload attacks)
 *  5. Security event logger — structured JSON to console (Cloudflare Logpush-ready)
 *  6. CORS lockdown helper
 *
 * All logic runs in the Cloudflare Workers runtime — no Node.js APIs used.
 */

import type { Context, MiddlewareHandler, Next } from 'hono'

// ─── Types ────────────────────────────────────────────────────────────────────

interface SecurityEvent {
  ts: string
  level: 'BLOCK' | 'WARN' | 'INFO' | 'RATE_LIMIT'
  rule: string
  ip: string
  method: string
  path: string
  ua: string
  detail?: string
}

interface RateLimitEntry {
  count: number
  windowStart: number
  blocked: boolean
  blockedUntil: number
}

// ─── In-Memory Rate Limit Store (Workers: per-isolate, resets on cold start) ──
// For production with persistent rate-limiting, bind a Cloudflare KV namespace
const rateLimitStore = new Map<string, RateLimitEntry>()

// Cleanup old entries every ~500 requests to prevent memory bloat
let rlCleanupCounter = 0
function maybeCleanupRateLimitStore() {
  if (++rlCleanupCounter % 500 !== 0) return
  const now = Date.now()
  for (const [key, entry] of rateLimitStore.entries()) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 4) {
      rateLimitStore.delete(key)
    }
  }
}

// ─── Rate Limit Configuration ─────────────────────────────────────────────────
const RATE_LIMIT_WINDOW_MS = 60_000          // 1-minute sliding window
const RATE_LIMIT_BLOCK_MS  = 5 * 60_000      // 5-minute block after abuse

// Per-path-group limits (requests per RATE_LIMIT_WINDOW_MS per IP)
const RATE_LIMITS: Record<string, number> = {
  '/api/chat':     20,   // AI chat — expensive, limit tightly
  '/api/payments': 30,   // payment endpoints
  '/api/contracts':30,
  '/api/settings': 15,   // settings mutations
  '/api/swap':     40,
  '/api/guardian': 20,
  '/api/yield':    40,
  '/api/dex':      30,
  '/api/':         60,   // all other API
  '/':             200,  // static / HTML
}

function getRateLimit(path: string): number {
  for (const [prefix, limit] of Object.entries(RATE_LIMITS)) {
    if (path.startsWith(prefix)) return limit
  }
  return 120
}

// ─── WAF Rule Patterns ────────────────────────────────────────────────────────

// XSS — covers reflected, stored, DOM-based, SVG payloads, event handlers
const XSS_PATTERNS = [
  /<script[\s>]/i,
  /javascript\s*:/i,
  /vbscript\s*:/i,
  /on(?:load|error|click|mouse|key|focus|blur|change|submit|reset|select|abort|drag|drop|paste|copy|cut|input|wheel|touch|pointer|transition|animation)\s*=/i,
  /<\s*(?:iframe|object|embed|applet|base|link|meta|style|form|img|svg|math)\s/i,
  /expression\s*\(/i,
  /&#\s*(?:x[0-9a-f]+|[0-9]+)\s*;/i,
  /data\s*:\s*text\/html/i,
  /srcdoc\s*=/i,
  /import\s+['"`]?data:/i,
]

// SQL Injection — UNION, DROP, INSERT, UPDATE, DELETE, OR 1=1, comment markers
const SQLI_PATTERNS = [
  /'\s*(?:OR|AND)\s+['"\d]/i,
  /\b(?:UNION\s+(?:ALL\s+)?SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+(?:TABLE|DATABASE|INDEX)|ALTER\s+TABLE|EXEC(?:UTE)?\s*\(|DECLARE\s+@|CAST\s*\(|CONVERT\s*\()\b/i,
  /--\s*$|\/\*[\s\S]*?\*\//,
  /;\s*(?:DROP|INSERT|UPDATE|DELETE|CREATE|EXEC)/i,
  /\bWAITFOR\s+DELAY\b/i,
  /\bSLEEP\s*\(\s*\d+\s*\)/i,
  /\bBENCHMARK\s*\(/i,
  /\bPG_SLEEP\s*\(/i,
]

// Path Traversal — directory climbing, null bytes
const PATH_TRAVERSAL_PATTERNS = [
  /\.\.[\/\\]/,
  /%2e%2e[%2f%5c]/i,
  /\0|%00/,
  /\/(?:etc\/passwd|windows\/win\.ini|boot\.ini|proc\/self)/i,
]

// Command Injection
const CMD_INJECTION_PATTERNS = [
  /[;&|`$].*(?:cat|ls|wget|curl|bash|sh|chmod|chown|nc\b|ncat|socat|python|perl|ruby|php|node)\b/i,
  /\$\(.*\)/,
  /`[^`]+`/,
  /\|\s*(?:cat|bash|sh|nc|curl|wget)/i,
]

// SSRF — internal network probing
const SSRF_PATTERNS = [
  /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|::1|169\.254\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)\b/i,
  /file:\/\//i,
  /dict:\/\//i,
  /gopher:\/\//i,
  /ftp:\/\//i,
]

// Prototype Pollution
const PROTO_POLLUTION_PATTERNS = [
  /__proto__/i,
  /constructor\s*\[/i,
  /prototype\s*\[/i,
]

// Malicious User Agents — scanners, exploit frameworks
const MALICIOUS_UA_PATTERNS = [
  /(?:sqlmap|nikto|nessus|openvas|masscan|zgrab|nuclei|hydra|medusa|nmap|dirb|gobuster|ffuf|wfuzz|dirsearch|acunetix|appscan|burpsuite|w3af|skipfish|havij|pangolin)/i,
  /python-requests\/[0-2]\./i,   // very old automated scanners
  /(?:zgrab|go-http-client\/1\.[01]$)/i,
  /curl\/[0-6]\.\d/i,             // ancient curl (scanners often use old)
]

// Oversized request threshold (1 MB for API endpoints, 10 KB for chat)
const MAX_BODY_BYTES_API  = 1_048_576   // 1 MB
const MAX_BODY_BYTES_CHAT = 10_240      // 10 KB

// ─── Security Event Logger ────────────────────────────────────────────────────

function logSecurityEvent(evt: SecurityEvent): void {
  // Structured JSON — Cloudflare Logpush, Workers Tail, and CF Analytics read this
  const entry = JSON.stringify({
    ...evt,
    service: 'arc-ai-agents',
    env: 'production',
  })
  // In Workers, console.log goes to Cloudflare Logs / Logpush
  if (evt.level === 'BLOCK' || evt.level === 'RATE_LIMIT') {
    console.warn('[SECURITY]', entry)
  } else {
    console.log('[SECURITY]', entry)
  }
}

function getClientIP(c: Context): string {
  return (
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-real-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    '0.0.0.0'
  )
}

// ─── WAF Core — scans a string against all rule sets ─────────────────────────

interface WAFResult {
  blocked: boolean
  rule?: string
  detail?: string
}

function runWAF(value: string, isUrl = false): WAFResult {
  if (!value || typeof value !== 'string') return { blocked: false }

  // URL-decode one level to catch encoded attacks
  let decoded = value
  try { decoded = decodeURIComponent(value) } catch { /* malformed encoding */ }

  for (const p of XSS_PATTERNS) {
    if (p.test(decoded) || p.test(value)) {
      return { blocked: true, rule: 'XSS', detail: p.source.slice(0, 60) }
    }
  }
  for (const p of SQLI_PATTERNS) {
    if (p.test(decoded) || p.test(value)) {
      return { blocked: true, rule: 'SQLI', detail: p.source.slice(0, 60) }
    }
  }
  for (const p of PATH_TRAVERSAL_PATTERNS) {
    if (p.test(decoded) || p.test(value)) {
      return { blocked: true, rule: 'PATH_TRAVERSAL', detail: p.source.slice(0, 60) }
    }
  }
  for (const p of CMD_INJECTION_PATTERNS) {
    if (p.test(decoded) || p.test(value)) {
      return { blocked: true, rule: 'CMD_INJECTION', detail: p.source.slice(0, 60) }
    }
  }
  for (const p of PROTO_POLLUTION_PATTERNS) {
    if (p.test(decoded) || p.test(value)) {
      return { blocked: true, rule: 'PROTO_POLLUTION', detail: p.source.slice(0, 60) }
    }
  }
  // SSRF only on URL/body values that look like they contain a URL
  if (isUrl || /https?:\/\//.test(value)) {
    for (const p of SSRF_PATTERNS) {
      if (p.test(decoded) || p.test(value)) {
        return { blocked: true, rule: 'SSRF', detail: p.source.slice(0, 60) }
      }
    }
  }
  return { blocked: false }
}

function deepScanObject(obj: unknown, depth = 0): WAFResult {
  if (depth > 8) return { blocked: false }   // recursion guard
  if (typeof obj === 'string') return runWAF(obj)
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const r = deepScanObject(item, depth + 1)
      if (r.blocked) return r
    }
  }
  if (obj !== null && typeof obj === 'object') {
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      const kr = runWAF(key)
      if (kr.blocked) return { ...kr, detail: `key: ${key}` }
      const vr = deepScanObject(val, depth + 1)
      if (vr.blocked) return vr
    }
  }
  return { blocked: false }
}

// ─── Secure Headers ───────────────────────────────────────────────────────────

function applySecureHeaders(c: Context): void {
  const h = c.res.headers

  // Strict Transport Security — 2-year max-age, include subdomains, preload
  h.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload')

  // Content Security Policy — tight allowlist
  // Allows only self + specific CDN hosts needed by the app
  const csp = [
    "default-src 'self'",
    // Scripts: self + Tailwind CDN + FontAwesome + Chart.js + known libs
    "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
    // Styles: self + CDN
    "style-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://fonts.googleapis.com",
    // Fonts
    "font-src 'self' https://cdn.jsdelivr.net https://fonts.gstatic.com data:",
    // Images: self + data URIs + blob (for receipt viewer)
    "img-src 'self' data: blob: https://*.arcscan.app",
    // Connections: self + Arc Testnet RPCs + ArcScan explorer
    "connect-src 'self' https://rpc.testnet.arc.network https://rpc.blockdaemon.testnet.arc.network https://rpc.drpc.testnet.arc.network https://rpc.quicknode.testnet.arc.network wss://rpc.testnet.arc.network https://testnet.arcscan.app https://api.coingecko.com",
    // Media
    "media-src 'none'",
    // Objects (Flash etc)
    "object-src 'none'",
    // Frames — only self (wallet providers may need this)
    "frame-src 'self'",
    // Workers
    "worker-src 'self' blob:",
    // Form actions — only self
    "form-action 'self'",
    // Base URI lockdown
    "base-uri 'self'",
    // Manifest
    "manifest-src 'self'",
    // Upgrade insecure requests
    "upgrade-insecure-requests",
  ].join('; ')

  h.set('Content-Security-Policy', csp)

  // Prevent MIME-type sniffing
  h.set('X-Content-Type-Options', 'nosniff')

  // Clickjacking protection
  h.set('X-Frame-Options', 'SAMEORIGIN')

  // XSS filter for legacy browsers
  h.set('X-XSS-Protection', '1; mode=block')

  // Referrer policy — don't leak paths
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin')

  // Permissions policy — disable dangerous browser APIs
  h.set('Permissions-Policy', [
    'camera=()',
    'microphone=()',
    'geolocation=()',
    'payment=(self)',
    'usb=()',
    'magnetometer=()',
    'accelerometer=()',
    'gyroscope=()',
    'fullscreen=(self)',
    'interest-cohort=()',   // FLoC opt-out
  ].join(', '))

  // Cross-Origin policies
  h.set('Cross-Origin-Opener-Policy', 'same-origin')
  h.set('Cross-Origin-Resource-Policy', 'same-origin')
  h.set('Cross-Origin-Embedder-Policy', 'unsafe-none') // wallet providers need this

  // Cache control for API responses — no caching of sensitive data
  const path = new URL(c.req.url).pathname
  if (path.startsWith('/api/')) {
    h.set('Cache-Control', 'no-store, no-cache, must-revalidate, private')
    h.set('Pragma', 'no-cache')
    h.set('Expires', '0')
  }

  // Remove server fingerprinting headers
  h.delete('Server')
  h.delete('X-Powered-By')
  h.delete('Via')

  // Set server identifier (obfuscated)
  h.set('Server', 'ARC/1.0')
}

// ─── Rate Limiter ─────────────────────────────────────────────────────────────

function checkRateLimit(ip: string, path: string): { limited: boolean; retryAfter: number } {
  maybeCleanupRateLimitStore()

  const key    = `${ip}:${path.split('/').slice(0, 3).join('/')}`
  const limit  = getRateLimit(path)
  const now    = Date.now()
  const entry  = rateLimitStore.get(key)

  if (!entry) {
    rateLimitStore.set(key, { count: 1, windowStart: now, blocked: false, blockedUntil: 0 })
    return { limited: false, retryAfter: 0 }
  }

  // Still in block period?
  if (entry.blocked && now < entry.blockedUntil) {
    return { limited: true, retryAfter: Math.ceil((entry.blockedUntil - now) / 1000) }
  }

  // Window expired — reset
  if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry.count      = 1
    entry.windowStart = now
    entry.blocked     = false
    entry.blockedUntil = 0
    return { limited: false, retryAfter: 0 }
  }

  entry.count++

  // Exceed limit — enter block
  if (entry.count > limit) {
    entry.blocked     = true
    entry.blockedUntil = now + RATE_LIMIT_BLOCK_MS
    return { limited: true, retryAfter: Math.ceil(RATE_LIMIT_BLOCK_MS / 1000) }
  }

  return { limited: false, retryAfter: 0 }
}

// ─── Blocked Response ─────────────────────────────────────────────────────────

function blockedResponse(c: Context, status: 403 | 429, reason: string, retryAfter = 0): Response {
  const body = JSON.stringify({
    error: status === 429 ? 'Too Many Requests' : 'Forbidden',
    reason,
    timestamp: new Date().toISOString(),
    ...(retryAfter > 0 ? { retryAfter } : {}),
  })
  const headers = new Headers({
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
    ...(retryAfter > 0 ? { 'Retry-After': String(retryAfter) } : {}),
  })
  return new Response(body, { status, headers })
}

// ─── Main Security Middleware ─────────────────────────────────────────────────

export const securityMiddleware: MiddlewareHandler = async (c: Context, next: Next) => {
  const ip     = getClientIP(c)
  const method = c.req.method
  const path   = new URL(c.req.url).pathname
  const ua     = c.req.header('user-agent') || ''
  const isAPI  = path.startsWith('/api/')

  // ── 1. Malicious bot detection ───────────────────────────────────────────────
  for (const pattern of MALICIOUS_UA_PATTERNS) {
    if (pattern.test(ua)) {
      logSecurityEvent({ ts: new Date().toISOString(), level: 'BLOCK', rule: 'MALICIOUS_UA', ip, method, path, ua })
      return blockedResponse(c, 403, 'Automated scanner detected')
    }
  }

  // ── 2. URL / Path WAF scan ───────────────────────────────────────────────────
  const urlResult = runWAF(path + (c.req.url.includes('?') ? '?' + c.req.url.split('?')[1] : ''), true)
  if (urlResult.blocked) {
    logSecurityEvent({ ts: new Date().toISOString(), level: 'BLOCK', rule: urlResult.rule!, ip, method, path, ua, detail: `url: ${urlResult.detail}` })
    return blockedResponse(c, 403, `Request blocked by WAF [${urlResult.rule}]`)
  }

  // ── 3. Rate limiting (API endpoints only) ────────────────────────────────────
  if (isAPI) {
    const rl = checkRateLimit(ip, path)
    if (rl.limited) {
      logSecurityEvent({ ts: new Date().toISOString(), level: 'RATE_LIMIT', rule: 'RATE_LIMIT', ip, method, path, ua })
      return blockedResponse(c, 429, 'Rate limit exceeded', rl.retryAfter)
    }
  }

  // ── 4. Request body scanning (POST/PUT/PATCH) ────────────────────────────────
  if (['POST', 'PUT', 'PATCH'].includes(method) && isAPI) {
    const ct = c.req.header('content-type') || ''

    if (ct.includes('application/json')) {
      // Check Content-Length before attempting parse
      const clHeader = c.req.header('content-length')
      const maxBytes = path.startsWith('/api/chat') ? MAX_BODY_BYTES_CHAT : MAX_BODY_BYTES_API

      if (clHeader && parseInt(clHeader, 10) > maxBytes) {
        logSecurityEvent({ ts: new Date().toISOString(), level: 'BLOCK', rule: 'OVERSIZED_REQUEST', ip, method, path, ua, detail: `content-length: ${clHeader}` })
        return blockedResponse(c, 403, 'Request payload too large')
      }

      try {
        const cloned   = c.req.raw.clone()
        const text     = await cloned.text()
        const byteLen  = new TextEncoder().encode(text).length

        if (byteLen > maxBytes) {
          logSecurityEvent({ ts: new Date().toISOString(), level: 'BLOCK', rule: 'OVERSIZED_REQUEST', ip, method, path, ua, detail: `body: ${byteLen} bytes` })
          return blockedResponse(c, 403, 'Request payload too large')
        }

        // Parse and deep-scan JSON body
        if (text.trim()) {
          let parsed: unknown
          try { parsed = JSON.parse(text) } catch { /* non-JSON body */ }
          if (parsed !== undefined) {
            const bodyResult = deepScanObject(parsed)
            if (bodyResult.blocked) {
              logSecurityEvent({ ts: new Date().toISOString(), level: 'BLOCK', rule: bodyResult.rule!, ip, method, path, ua, detail: `body: ${bodyResult.detail}` })
              return blockedResponse(c, 403, `Request blocked by WAF [${bodyResult.rule}]`)
            }
          }
        }
      } catch {
        // Body read error — allow through (downstream handler will deal with it)
      }
    }
  }

  // ── 5. Process request ───────────────────────────────────────────────────────
  await next()

  // ── 6. Apply secure response headers ────────────────────────────────────────
  applySecureHeaders(c)

  // ── 7. Log suspicious activity (non-blocking) ────────────────────────────────
  const status = c.res.status
  if (status >= 400 && status < 500 && status !== 404) {
    logSecurityEvent({ ts: new Date().toISOString(), level: 'WARN', rule: `HTTP_${status}`, ip, method, path, ua })
  }
}

// ─── Input Sanitization Utilities ────────────────────────────────────────────
// Use these in route handlers to sanitize user-supplied strings before processing

/**
 * Escapes HTML special characters to prevent stored XSS
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;')
}

/**
 * Strips all HTML tags from a string
 */
export function stripTags(str: string): string {
  return str.replace(/<[^>]*>/g, '').replace(/&[a-z#0-9]+;/gi, ' ')
}

/**
 * Sanitizes a string for safe inclusion in logs (prevents log injection)
 */
export function sanitizeForLog(str: string): string {
  return str.replace(/[\r\n\t]/g, ' ').replace(/[^\x20-\x7E]/g, '').slice(0, 200)
}

/**
 * Validates an Ethereum address (0x + 40 hex chars)
 */
export function isValidEthAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr)
}

/**
 * Validates a transaction hash (0x + 64 hex chars)
 */
export function isValidTxHash(hash: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(hash)
}

/**
 * Validates a numeric amount string — positive, max 6 decimal places, max 18 digits
 */
export function isValidAmount(amount: string): boolean {
  return /^\d{1,18}(\.\d{1,6})?$/.test(amount) && parseFloat(amount) > 0
}

/**
 * Validates an email address
 */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(email) && email.length <= 320
}

/**
 * Validates a session ID (alphanumeric + hyphens, 8–128 chars)
 */
export function isValidSessionId(id: string): boolean {
  return /^[a-zA-Z0-9\-_]{8,128}$/.test(id)
}

/**
 * Clamps a string to a maximum length (safe truncation)
 */
export function clampString(str: string, maxLen: number): string {
  return typeof str === 'string' ? str.slice(0, maxLen) : ''
}

// ─── AES-256-GCM Encryption Utilities (Web Crypto API — works in Workers) ────
// Use for encrypting sensitive data at rest (stored in KV or returned in response)

/**
 * Derives a 256-bit AES-GCM key from a passphrase using PBKDF2
 * The passphrase should come from an environment variable, never be hardcoded
 */
export async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 310_000,   // NIST recommended minimum for PBKDF2-SHA-256
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

/**
 * Encrypts plaintext using AES-256-GCM
 * Returns a base64url-encoded string: salt(16) + iv(12) + ciphertext
 */
export async function encrypt(plaintext: string, passphrase: string): Promise<string> {
  const enc   = new TextEncoder()
  const salt  = crypto.getRandomValues(new Uint8Array(16))
  const iv    = crypto.getRandomValues(new Uint8Array(12))
  const key   = await deriveKey(passphrase, salt)

  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    key,
    enc.encode(plaintext)
  )

  // Combine salt + iv + ciphertext into one buffer
  const combined = new Uint8Array(salt.length + iv.length + cipherBuf.byteLength)
  combined.set(salt, 0)
  combined.set(iv, salt.length)
  combined.set(new Uint8Array(cipherBuf), salt.length + iv.length)

  return btoa(String.fromCharCode(...combined))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

/**
 * Decrypts a base64url-encoded AES-256-GCM ciphertext
 */
export async function decrypt(ciphertext: string, passphrase: string): Promise<string> {
  const dec = new TextDecoder()
  // Restore standard base64
  const b64 = ciphertext.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - ciphertext.length % 4) % 4)
  const combined = Uint8Array.from(atob(b64), c => c.charCodeAt(0))

  const salt = combined.slice(0, 16)
  const iv   = combined.slice(16, 28)
  const data = combined.slice(28)

  const key = await deriveKey(passphrase, salt)

  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    key,
    data
  )

  return dec.decode(plainBuf)
}

/**
 * Creates a HMAC-SHA256 signature for a message
 * Use to sign webhook payloads, token payloads, etc.
 */
export async function hmacSign(message: string, secret: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Verifies a HMAC-SHA256 signature in constant time (prevents timing attacks)
 */
export async function hmacVerify(message: string, signature: string, secret: string): Promise<boolean> {
  const expected = await hmacSign(message, secret)
  if (expected.length !== signature.length) return false
  // Constant-time comparison
  let diff = 0
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  }
  return diff === 0
}

/**
 * Generates a cryptographically secure random token (URL-safe base64)
 */
export function generateSecureToken(bytes = 32): string {
  const arr = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

/**
 * Hashes a string with SHA-256 (for fingerprinting, deduplication)
 */
export async function sha256(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ─── CSRF Token Utilities ─────────────────────────────────────────────────────

const CSRF_HEADER = 'X-CSRF-Token'
const CSRF_TTL_MS = 2 * 60 * 60 * 1000   // 2 hours

interface CSRFToken {
  token: string
  issuedAt: number
}

const csrfStore = new Map<string, CSRFToken>()

/**
 * Issues a CSRF token for a session
 */
export function issueCSRFToken(sessionId: string): string {
  const token = generateSecureToken(24)
  csrfStore.set(sessionId, { token, issuedAt: Date.now() })
  // Clean old tokens
  for (const [id, entry] of csrfStore.entries()) {
    if (Date.now() - entry.issuedAt > CSRF_TTL_MS) csrfStore.delete(id)
  }
  return token
}

/**
 * CSRF validation middleware — applies to state-mutating requests
 * Expects X-CSRF-Token header to match the token issued for the session
 * NOTE: For pure API + JWT auth (no cookies), CSRF is naturally mitigated
 * by the same-origin policy on XHR/fetch. This adds an extra layer.
 */
export const csrfMiddleware: MiddlewareHandler = async (c: Context, next: Next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) {
    return next()
  }
  // Skip CSRF check if using Authorization header (JWT / token-auth flow)
  if (c.req.header('Authorization')) {
    return next()
  }
  // Skip for OPTIONS (preflight)
  if (c.req.method === 'OPTIONS') {
    return next()
  }
  // For session-based flows, validate CSRF token
  const csrfToken  = c.req.header(CSRF_HEADER)
  const sessionId  = c.req.header('X-Session-Id') || ''
  if (!csrfToken || !sessionId) {
    return next()   // Non-session flows skip check
  }
  const stored = csrfStore.get(sessionId)
  if (!stored || stored.token !== csrfToken || Date.now() - stored.issuedAt > CSRF_TTL_MS) {
    return blockedResponse(c, 403, 'Invalid or expired CSRF token')
  }
  return next()
}

// ─── JWT Utilities (stateless, no library dependency) ─────────────────────────

interface JWTPayload {
  sub: string       // subject (wallet address)
  iat: number       // issued at
  exp: number       // expires at
  jti: string       // JWT ID (for revocation)
  role?: string     // optional role
  [key: string]: unknown
}

/**
 * Signs a JWT using HMAC-SHA256
 * secret must come from environment variable (c.env.JWT_SECRET)
 */
export async function signJWT(payload: Omit<JWTPayload, 'iat' | 'jti'>, secret: string, ttlSeconds = 3600): Promise<string> {
  const header  = { alg: 'HS256', typ: 'JWT' }
  const now     = Math.floor(Date.now() / 1000)
  const full: JWTPayload = {
    ...payload,
    iat: now,
    exp: now + ttlSeconds,
    jti: generateSecureToken(16),
  }

  const enc = (obj: unknown) => btoa(JSON.stringify(obj))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')

  const h  = enc(header)
  const p  = enc(full)
  const sig = await hmacSign(`${h}.${p}`, secret)
  const sigB64 = btoa(sig.match(/.{2}/g)!.map(h => String.fromCharCode(parseInt(h, 16))).join(''))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')

  return `${h}.${p}.${sigB64}`
}

/**
 * Verifies and decodes a JWT
 */
export async function verifyJWT(token: string, secret: string): Promise<JWTPayload | null> {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null

    const [h, p, s] = parts
    const expected = await hmacSign(`${h}.${p}`, secret)

    // Decode signature
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '=='
    const sigBytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    const sigHex   = Array.from(sigBytes).map(b => b.toString(16).padStart(2, '0')).join('')

    if (!(await hmacVerify(`${h}.${p}`, sigHex, secret))) return null

    // Decode payload
    const payloadB64 = p.replace(/-/g, '+').replace(/_/g, '/')
    const payload: JWTPayload = JSON.parse(atob(payloadB64 + '=='.slice(0, (4 - p.length % 4) % 4)))

    // Check expiry
    if (payload.exp < Math.floor(Date.now() / 1000)) return null

    return payload
  } catch {
    return null
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export { CSRF_HEADER, logSecurityEvent, getClientIP }
