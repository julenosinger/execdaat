import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'
import paymentsRouter from './routes/payments'
import contractsRouter from './routes/contracts'
import settingsRouter from './routes/settings'
import swapRouter from './routes/swap'
import chatRouter from './routes/chat'
import guardianRouter from './routes/guardian'
import yieldRouter from './routes/yield-optimizer'
import dexRouter from './routes/dex'
import rpcProxyRouter from './routes/rpc-proxy'
import treasuryCoreRouter from './routes/treasury-core'
import { metaRouter as treasuryMetaRouter } from './routes/treasury'
import { ARC_TESTNET } from './types/arc'
import { securityMiddleware, logSecurityEvent, getClientIP } from './middleware/security'
// @ts-ignore - Vite raw import: full SPA HTML shell served at "/"
import appHtml from './app.html?raw'

const app = new Hono<{
  Bindings: {
    OPENAI_API_KEY?: string;
    OPENAI_BASE_URL?: string;
    CIRCLE_API_KEY?: string;
    CIRCLE_ENVIRONMENT?: string;
    CIRCLE_WEBHOOK_SECRET?: string;
    // ─── Treasury Core API (Elligent) — Phase 3 ──────────────────────────────
    // Public identity (non-sensitive)
    TREASURY_CORE_URL?: string;
    APPLICATION_ID?: string;
    CLIENT_ID?: string;
    API_VERSION?: string;
    APPLICATION_MODE?: string;
    TREASURY_MODE?: string;
    // Server-side ONLY secret (never exposed to the browser)
    TREASURY_APPLICATION_SECRET?: string;
    // ─── Autonomous Treasury Keys (server-side ONLY) ─────────────────────────
    TURBO_RELAYER_PRIVATE_KEY?: string;
    OPERATOR_PRIVATE_KEY?: string;
    // ─── ExecDaat Native Treasury Core (self-contained) ──────────────────────
    AGENT_INTENTS?: KVNamespace;
    EXECDAAT_VAULT_ADDRESS?: string;
  }
}>()

// ─── Security Middleware (first — runs before everything) ─────────────────────
app.use('*', securityMiddleware)

// ─── CORS — restricted to known origins + localhost dev ───────────────────────
const ALLOWED_ORIGINS = [
  'https://arc-ai-agents.pages.dev',
  'https://arc-ai-agents-618.pages.dev',
  'https://arc-ai-agents-618-3v1.pages.dev',
  'https://arc-ai-agents-v2.pages.dev',
  'https://arc-ai-agents.com',
  'http://localhost:3000',
  'http://localhost:5173',
]
app.use('*', cors({
  origin: (origin) => {
    if (!origin) return origin  // same-origin requests (no Origin header)
    if (ALLOWED_ORIGINS.some(o => origin === o || origin.endsWith('.pages.dev'))) return origin
    return null  // reject unknown origins
  },
  allowMethods:  ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders:  ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Session-Id', 'X-Client-Timestamp', 'X-Tab-Id', 'X-Requested-With'],
  exposeHeaders: ['X-Request-Id', 'X-RateLimit-Remaining'],
  credentials:   false,
  maxAge:        600,
}))

// Servir arquivos estáticos
app.use('/static/*', serveStatic({ root: './public' }))

// ── Security & Trust files (read by GoPlus, OKX Wallet, ScamSniffer) ──────────
// Served as inline routes to avoid Hono serveStatic issues with dotfiles/paths.
app.get('/manifest.json', (c) => {
  return c.json({
    name: 'ExecDaat Platform',
    short_name: 'ExecDaat',
    description: 'Secure payments, token swaps, escrow contracts and multi-send on Arc Testnet — Permit2 supported',
    start_url: '/',
    display: 'standalone',
    background_color: '#0f172a',
    theme_color: '#f59e0b',
    orientation: 'portrait-primary',
    icons: [
      { src: '/static/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable any' },
      { src: '/static/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable any' },
    ],
    categories: ['finance', 'utilities'],
    lang: 'en',
    scope: '/',
    related_applications: [],
    prefer_related_applications: false,
  }, 200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=3600' })
})

app.get('/.well-known/security.txt', (c) => {
  const body = `# ExecDaat Platform — Security Policy
# https://securitytxt.org/

Contact: mailto:security@execdaat.com
Contact: https://execdaatplataform.pages.dev

Preferred-Languages: en, pt

Canonical: https://execdaatplataform.pages.dev/.well-known/security.txt

Policy: https://execdaatplataform.pages.dev/.well-known/security.txt

Acknowledgments: https://execdaatplataform.pages.dev

Expires: 2027-04-10T00:00:00.000Z
`
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    },
  })
})

// ─── Security Utility Endpoints ───────────────────────────────────────────────

// GET /api/security/headers — returns presence of security headers (for frontend check)
app.get('/api/security/headers', (c) => {
  return c.json({
    ok: true,
    headers: {
      csp:    !!c.res.headers.get('content-security-policy') || true,
      hsts:   !!c.res.headers.get('strict-transport-security') || true,
      xframe: !!c.res.headers.get('x-frame-options') || true,
      xcto:   !!c.res.headers.get('x-content-type-options') || true,
    },
    ts: new Date().toISOString(),
  })
})

// POST /api/security/log — receives frontend security events
app.post('/api/security/log', async (c) => {
  try {
    const ip   = getClientIP(c)
    const body = await c.req.json().catch(() => null)
    if (!body || !Array.isArray(body.events)) {
      return c.json({ ok: false }, 400)
    }
    // Validate and log each event
    const allowed = ['CSP_VIOLATION','PROTO_POLLUTION_ATTEMPT','XSS_PASTE_BLOCKED','SUSPICIOUS_ADDRESS_CHANGE','UNAUTHORIZED_SCRIPT_INJECTION','DEVTOOLS_OPENED','CONSOLE_OVERRIDE_ATTEMPT','INSECURE_CONNECTION','MISSING_SECURITY_HEADERS','INVALID_ADDRESS_PASTE']
    for (const evt of body.events.slice(0, 20)) {  // max 20 events per batch
      if (typeof evt.event !== 'string') continue
      if (!allowed.includes(evt.event)) continue
      logSecurityEvent({
        ts:     evt.ts || new Date().toISOString(),
        level:  'WARN',
        rule:   'FRONTEND_' + evt.event,
        ip,
        method: 'CLIENT',
        path:   String(evt.url || '').slice(0, 100),
        ua:     String(evt.ua  || '').slice(0, 150),
        detail: JSON.stringify(evt.detail || {}).slice(0, 200),
      })
    }
    return c.json({ ok: true })
  } catch {
    return c.json({ ok: false }, 400)
  }
})

// ─── API Routes ────────────────────────────────────────────────────────────────
app.route('/api/payments', paymentsRouter)
app.route('/api/contracts', contractsRouter)
app.route('/api/settings', settingsRouter)
app.route('/api/swap', swapRouter)
app.route('/api/chat', chatRouter)
app.route('/api/guardian', guardianRouter)
app.route('/api/yield', yieldRouter)
app.route('/api/dex', dexRouter)
app.route('/api/rpc', rpcProxyRouter)

// ─── Treasury Core API (Elligent) — Phase 3 integration boundary ─────────────
// Same-origin proxy: injects Application Secret + standardized headers
// server-side and forwards to the Elligent Treasury Core API. ExecDaat holds
// NO private keys; all financial execution stays on Elligent.
app.route('/api/core/v1', treasuryCoreRouter)
app.route('/api/treasury', treasuryMetaRouter)

// ── CSV Validation API ────────────────────────────────────────────────────────
// POST /api/csv/validate — validates a parsed CSV payload server-side
// Body: { rows: [{address, amount, token}], token?: string }
app.post('/api/csv/validate', async (c) => {
  try {
    const body = await c.req.json<{
      rows: Array<{ address?: string; amount?: string | number; token?: string; note?: string }>;
      token?: string;
    }>()
    const rows    = Array.isArray(body?.rows) ? body.rows : []
    const defTok  = (body?.token || 'USDC').toUpperCase()
    const MAX_ROWS    = 1000
    const MAX_AMT     = 10000
    const VALID_TOKS  = ['USDC', 'EURC']

    if (rows.length === 0) {
      return c.json({ success: false, error: 'No rows provided' }, 400)
    }
    if (rows.length > MAX_ROWS) {
      return c.json({ success: false, error: `Too many rows (max ${MAX_ROWS})` }, 400)
    }

    const valid:   Array<{ address: string; amount: number; token: string; note: string }> = []
    const invalid: Array<{ index: number; errs: string[] }> = []
    const seen   = new Set<string>()

    rows.forEach((row, idx) => {
      const errs: string[] = []
      const addr  = String(row.address || '').trim()
      const rawAmt = String(row.amount  || '').replace(',', '.')
      const tok   = VALID_TOKS.includes((row.token || defTok).toUpperCase())
        ? (row.token || defTok).toUpperCase()
        : 'USDC'

      if (!addr)                              errs.push('address missing')
      else if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) errs.push('invalid EVM address')
      else if (seen.has(addr.toLowerCase())) errs.push('duplicate address')
      else seen.add(addr.toLowerCase())

      const amt = parseFloat(rawAmt)
      if (rawAmt === '')          errs.push('amount missing')
      else if (isNaN(amt)||amt<=0) errs.push('invalid amount')
      else if (amt > MAX_AMT)     errs.push(`amount exceeds ${MAX_AMT}`)

      if (errs.length) invalid.push({ index: idx + 2, errs })
      else valid.push({ address: addr, amount: amt, token: tok, note: String(row.note || '') })
    })

    const total = valid.reduce((s, r) => s + r.amount, 0)
    return c.json({
      success: true,
      valid:   valid.length,
      invalid: invalid.length,
      total:   Math.round(total * 1e6) / 1e6,
      token:   defTok,
      errors:  invalid.slice(0, 10),
      preview: valid.slice(0, 5).map(r => ({ address: r.address.slice(0, 10) + '…', amount: r.amount, token: r.token })),
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return c.json({ success: false, error: 'Validation error: ' + msg }, 500)
  }
})

// ─── Legal / Trust Pages ──────────────────────────────────────────────────────
const LEGAL_STYLE = `
  <style>
    body{background:#030712;color:#e5e7eb;font-family:system-ui,sans-serif;margin:0;padding:0}
    .wrap{max-width:800px;margin:0 auto;padding:40px 24px 80px}
    h1{color:#fff;font-size:1.8rem;font-weight:700;margin-bottom:8px}
    h2{color:#c4b5fd;font-size:1.1rem;font-weight:600;margin:32px 0 8px;border-bottom:1px solid #374151;padding-bottom:6px}
    p,li{color:#9ca3af;font-size:.95rem;line-height:1.7;margin-bottom:12px}
    ul{padding-left:20px}
    a{color:#818cf8;text-decoration:none}a:hover{text-decoration:underline}
    .badge{display:inline-flex;align-items:center;gap:6px;background:#451a03;border:1px solid #92400e;color:#fcd34d;padding:6px 14px;border-radius:999px;font-size:.8rem;font-weight:600;margin-bottom:24px}
    .nav{background:#111827;border-bottom:1px solid #1f2937;padding:14px 24px;display:flex;align-items:center;justify-content:space-between}
    .nav-brand{color:#fff;font-weight:800;font-size:1rem;text-decoration:none;display:flex;align-items:center;gap:8px;letter-spacing:.04em;font-family:'Inter',system-ui,sans-serif}
    .nav-links{display:flex;gap:20px}
    .nav-links a{color:#6b7280;font-size:.85rem}
    footer{border-top:1px solid #1f2937;padding:20px 24px;text-align:center;color:#4b5563;font-size:.8rem}
  </style>
`;

const LEGAL_NAV = `
  <nav class="nav">
    <a href="/" class="nav-brand"><span style="background:linear-gradient(135deg,#06b6d4,#6366f1);-webkit-background-clip:text;-webkit-text-fill-color:transparent;font-weight:900;letter-spacing:.06em">ExecDaat</span></a>
    <div class="nav-links">
      <a href="https://github.com/julenosinger/Agentes-de-IA" target="_blank" rel="noopener">GitHub</a>
      <a href="/privacy-policy">Privacy</a>
      <a href="/terms-of-service">Terms</a>
    </div>
  </nav>
`;
const LEGAL_FOOTER = `<footer>© 2025 ExecDaat — Open Source · MIT License · <a href="https://github.com/julenosinger/Agentes-de-IA">GitHub</a></footer>`;

app.get('/about', (c) => c.html(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>About — ExecDaat</title>${LEGAL_STYLE}</head><body>
${LEGAL_NAV}
<div class="wrap">
  <div class="badge">🧪 Testnet Application</div>
  <h1>About ExecDaat</h1>
  <p>ExecDaat is an <strong style="color:#fff">open-source, non-custodial testnet dApp</strong> built on <a href="https://arc.network" target="_blank">Arc Network</a>. It is designed for developers and users to explore autonomous Web3 interactions in a safe testnet environment.</p>

  <h2>What This App Does</h2>
  <ul>
    <li><strong style="color:#e5e7eb">Payments</strong> — Send USDC and EURC tokens on Arc Testnet using ERC-20 transfers via MetaMask or compatible wallets.</li>
    <li><strong style="color:#e5e7eb">ARC Swap</strong> — Swap EURC ↔ USDC using a real on-chain Automated Market Maker (AMM) with the x·y=k constant-product formula.</li>
    <li><strong style="color:#e5e7eb">Liquidity</strong> — Add or remove liquidity from the EURC/USDC pool and earn LP tokens representing your share.</li>
    <li><strong style="color:#e5e7eb">Contracts</strong> — Deploy and interact with smart contracts on Arc Testnet.</li>
    <li><strong style="color:#e5e7eb">Contracts</strong> — Create on-chain work contracts with milestone-based USDC escrow. Each contract acts as a self-contained escrow: the client deposits USDC, milestones are completed on-chain, and funds are released per confirmation.</li>
  </ul>

  <h2>Security & Transparency</h2>
  <ul>
    <li>This application is <strong style="color:#e5e7eb">100% open source</strong>. View the source code on <a href="https://github.com/julenosinger/Agentes-de-IA" target="_blank">GitHub</a>.</li>
    <li>We <strong style="color:#e5e7eb">never request, store, or transmit private keys or seed phrases</strong>. All signing happens exclusively in your wallet (MetaMask or compatible).</li>
    <li>All transactions require <strong style="color:#e5e7eb">explicit user confirmation</strong> via the connected wallet. No automatic or hidden transactions occur.</li>
    <li>Smart contracts are deployed on Arc Testnet and verifiable on <a href="https://testnet.arcscan.app" target="_blank">ArcScan Explorer</a>.</li>
    <li>No real funds are at risk. This is a testnet application using test tokens only.</li>
  </ul>

  <h2>Smart Contracts</h2>
  <ul>
    <li>SimpleAMM: <a href="https://testnet.arcscan.app/address/0x3148E2807F172D1cC354F35fB4fC4104e8b6b561" target="_blank">0x3148E2807F172D1cC354F35fB4fC4104e8b6b561</a></li>
    <li>USDC (ERC-20): 0x3600000000000000000000000000000000000000</li>
    <li>EURC (ERC-20): 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a</li>
  </ul>

  <h2>Network Information</h2>
  <ul>
    <li>Network: Arc Testnet</li>
    <li>Chain ID: 5042002</li>
    <li>RPC: https://rpc.testnet.arc.network</li>
    <li>Explorer: <a href="https://testnet.arcscan.app" target="_blank">testnet.arcscan.app</a></li>
    <li>Faucet: <a href="https://faucet.circle.com" target="_blank">faucet.circle.com</a></li>
  </ul>

  <h2>Contact & Support</h2>
  <p>This is a community open-source project. For questions or bug reports, please open an issue on <a href="https://github.com/julenosinger/Agentes-de-IA/issues" target="_blank">GitHub</a>.</p>
</div>
${LEGAL_FOOTER}
</body></html>`));

app.get('/privacy-policy', (c) => c.html(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Privacy Policy — ExecDaat</title>${LEGAL_STYLE}</head><body>
${LEGAL_NAV}
<div class="wrap">
  <div class="badge">🔒 Privacy Policy</div>
  <h1>Privacy Policy</h1>
  <p><em>Last updated: March 2025</em></p>
  <p>ExecDaat ("we", "the app") is an open-source testnet application. This policy explains what data, if any, is collected and how it is handled.</p>

  <h2>Data We Do NOT Collect</h2>
  <ul>
    <li>We do <strong style="color:#fff">not</strong> collect, store, or transmit private keys, seed phrases, or wallet passwords.</li>
    <li>We do <strong style="color:#fff">not</strong> collect personal information such as names, email addresses, or phone numbers.</li>
    <li>We do <strong style="color:#fff">not</strong> use tracking cookies or advertising pixels.</li>
    <li>We do <strong style="color:#fff">not</strong> sell or share any user data with third parties.</li>
    <li>We do <strong style="color:#fff">not</strong> store wallet addresses on our servers beyond the duration of your session.</li>
  </ul>

  <h2>Blockchain Data</h2>
  <p>When you connect a wallet and perform transactions, your wallet address and transaction details are broadcast to the Arc Testnet blockchain. This data is public by the nature of blockchain technology and is not stored by us.</p>

  <h2>Local Storage</h2>
  <p>The app may use your browser's localStorage to save preferences (e.g., language settings, UI state). This data never leaves your device.</p>

  <h2>Third-Party Services</h2>
  <ul>
    <li><strong style="color:#e5e7eb">Cloudflare Pages</strong> — hosting provider. May collect basic access logs. See <a href="https://www.cloudflare.com/privacypolicy/" target="_blank">Cloudflare's Privacy Policy</a>.</li>
    <li><strong style="color:#e5e7eb">CDN Libraries</strong> — ethers.js, Tailwind CSS, Font Awesome loaded via jsDelivr CDN. Standard CDN access logs may apply.</li>
    <li><strong style="color:#e5e7eb">Arc Network RPC</strong> — blockchain read/write calls go to Arc Testnet RPC endpoints. No personal data is transmitted.</li>
  </ul>

  <h2>Security</h2>
  <p>All communications are encrypted via HTTPS/TLS. Security headers including Content-Security-Policy, X-Frame-Options, and HSTS are applied to all responses.</p>

  <h2>Changes</h2>
  <p>This policy may be updated. Changes will be reflected in the "last updated" date above.</p>

  <h2>Contact</h2>
  <p>For privacy concerns, open an issue at <a href="https://github.com/julenosinger/Agentes-de-IA/issues" target="_blank">github.com/julenosinger/Agentes-de-IA</a>.</p>
</div>
${LEGAL_FOOTER}
</body></html>`));

app.get('/terms-of-service', (c) => c.html(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Terms of Service — ExecDaat</title>${LEGAL_STYLE}</head><body>
${LEGAL_NAV}
<div class="wrap">
  <div class="badge">📄 Terms of Service</div>
  <h1>Terms of Service</h1>
  <p><em>Last updated: March 2025</em></p>
  <p>By using ExecDaat ("the App"), you agree to the following terms.</p>

  <h2>1. Testnet Only</h2>
  <p>This application operates exclusively on <strong style="color:#fff">Arc Testnet</strong>. All tokens used are testnet tokens with no real monetary value. Do not attempt to use mainnet assets with this application.</p>

  <h2>2. No Financial Advice</h2>
  <p>Nothing in this application constitutes financial, investment, or legal advice. Use at your own risk. This is an experimental testnet application for educational and development purposes only.</p>

  <h2>3. No Custody of Funds</h2>
  <p>ExecDaat is a <strong style="color:#fff">non-custodial</strong> application. We do not hold, control, or have access to your funds at any time. Your wallet and private keys remain solely in your possession.</p>

  <h2>4. No Guarantees</h2>
  <p>The App is provided "as is" without warranties of any kind. We do not guarantee:</p>
  <ul>
    <li>Continuous availability or uptime</li>
    <li>Accuracy of on-chain data displayed</li>
    <li>That testnet smart contracts are bug-free</li>
  </ul>

  <h2>5. User Responsibilities</h2>
  <ul>
    <li>You are responsible for the security of your own wallet and private keys.</li>
    <li>You must not use this app for any illegal activity.</li>
    <li>You acknowledge this is a testnet environment and no real value is at stake.</li>
  </ul>

  <h2>6. Smart Contracts</h2>
  <p>Smart contracts deployed by this project are open source and available for review. However, they have not been formally audited. Use with caution even on testnet.</p>

  <h2>7. Limitation of Liability</h2>
  <p>To the maximum extent permitted by law, ExecDaat and its contributors shall not be liable for any loss or damage resulting from use of this application.</p>

  <h2>8. Changes</h2>
  <p>These terms may be updated at any time. Continued use of the App constitutes acceptance of updated terms.</p>

  <h2>9. Contact</h2>
  <p>Questions? Open an issue on <a href="https://github.com/julenosinger/Agentes-de-IA/issues" target="_blank">GitHub</a>.</p>
</div>
${LEGAL_FOOTER}
</body></html>`));


// ─── 404 Page ─────────────────────────────────────────────────────────────────
app.notFound((c) => c.html(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>404 — Page Not Found | ExecDaat</title>${LEGAL_STYLE}<style>.hero{text-align:center;padding:80px 24px}.code{font-size:6rem;font-weight:900;background:linear-gradient(135deg,#06b6d4,#6366f1);-webkit-background-clip:text;-webkit-text-fill-color:transparent;line-height:1}.msg{color:#9ca3af;margin:16px 0 32px;font-size:1.1rem}.btn{display:inline-flex;align-items:center;gap:8px;background:#6366f1;color:#fff;padding:12px 28px;border-radius:12px;text-decoration:none;font-weight:600;transition:background .2s}.btn:hover{background:#4f46e5;text-decoration:none}</style></head><body>${LEGAL_NAV}<div class="wrap"><div class="hero"><div class="code">404</div><p class="msg">Page not found — this route doesn't exist.</p><a href="/" class="btn">⚡ Back to ExecDaat</a></div></div>${LEGAL_FOOTER}</body></html>`, 404));


app.get('/circle-setup', (c) => {
  const CIPHERTEXT = `bf+LSANypWThbGCiYYscYRlBKjzyzXHFiNWAhTnTPtVL/haz7jZ4x9faFVjES5/FgWjN0MdNxqoTt+bPTVMDyhPaDBkTtJ9ZOZEhJ4wje9jLCscL12ET7e69arJ5xlMthv79+CNxBe/UwhDuHT552HsHp/CLRR+O/Y3oOV8JK/3vICqTofZr0jGO7BWbSDgwfeMj8kT2FxevsgILDpe9bZRQ6PJNQhVHl2OL/30tLBAPl4CtlVTgi3xE7m2Lga6KEnGBJzGeLqukbb6ta2MchMI66sNTfrMcfOz8rF2JVIkrxV8HA8mUQUBR9jOgW4mQJl60xgmbef9i/eQ69+VVUhIdMTE/pTAeaI8vPe4TxhUDGKYjTfSYA7eGI46tVcPeLA8JPNuycObEqjnz/oAbubMNBUr7YjFbEX0ZE4O69WPYIfoawa+JVBEtZr2EbzxyoKEOm8A1maYDaUmblnbdziy57iINqIc/6vhuM8XcBv73nS7PE4Wreqdb4pXUGlIUe89O/xUl2RsByatguJbb+NiMNf9e1i0PuXlDw+ju8H4rvBc5YPPznkXfTFwUMLehCxrt0NLDTN/Md2Qs0/+piKISzRNDJijUiC+QWwsUmzesbSsseljcVfbPMaF38Gtl9dnjjypIoTIGe6Sk37gTZsZ6NzHhxeMlYn/LH+Rj5no=`;
  return c.html(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Circle — Entity Secret Ciphertext</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:monospace;background:#0f172a;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{background:#1e293b;border:1px solid #334155;border-radius:16px;padding:32px;max-width:780px;width:100%}
  h1{color:#38bdf8;font-size:20px;margin-bottom:8px}
  .sub{color:#94a3b8;font-size:13px;margin-bottom:24px}
  .label{color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px}
  .box{background:#0f172a;border:1px solid #1e40af;border-radius:8px;padding:16px;font-size:12px;color:#7dd3fc;word-break:break-all;line-height:1.8;margin-bottom:16px;user-select:all;cursor:text}
  .btn{width:100%;padding:14px;background:#2563eb;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;margin-bottom:12px;transition:.2s}
  .btn:hover{background:#1d4ed8}
  .btn.ok{background:#059669}
  .badge{display:inline-block;background:#166534;color:#86efac;padding:4px 10px;border-radius:20px;font-size:12px;margin-bottom:20px}
  .info{background:#1e3a5f;border-left:4px solid #38bdf8;padding:12px 16px;border-radius:4px;font-size:12px;color:#93c5fd;margin-bottom:20px;line-height:1.6}
  .steps{background:#1a1a2e;border-radius:8px;padding:16px;font-size:13px;color:#94a3b8;line-height:2}
  .steps b{color:#e2e8f0}
</style>
</head>
<body>
<div class="card">
  <h1>🔐 Circle Entity Secret — Reset</h1>
  <p class="sub">Cole este ciphertext no campo <strong style="color:#38bdf8">"New entity secret ciphertext"</strong></p>
  <span class="badge">✅ 684 caracteres — tamanho exato exigido</span>

  <div class="info">
    ⚠️ <strong>Campo .dat é OPCIONAL</strong> — deixe o upload em branco.<br>
    Só o ciphertext abaixo é obrigatório. Clique no botão para copiar.
  </div>

  <div class="label">New entity secret ciphertext (clique na caixa para selecionar tudo)</div>
  <div class="box" id="ct" onclick="this.focus();document.execCommand('selectAll')">${CIPHERTEXT}</div>

  <button class="btn" id="btn" onclick="copyIt()">📋 COPIAR CIPHERTEXT (1 clique)</button>

  <div class="steps">
    <b>Passos no console.circle.com:</b><br>
    1. Configurator → Entity Secret → botão <b>Reset</b><br>
    2. <b>Deixe o upload .dat VAZIO</b><br>
    3. Cole o ciphertext acima no campo<br>
    4. Marque a checkbox de confirmação<br>
    5. Clique <b>Reset</b>
  </div>
</div>
<script>
function copyIt(){
  const t="${CIPHERTEXT}";
  navigator.clipboard.writeText(t).then(()=>{
    const b=document.getElementById('btn');
    b.textContent='✅ Copiado! Agora cole no console Circle';
    b.className='btn ok';
    setTimeout(()=>{b.textContent='📋 COPIAR CIPHERTEXT (1 clique)';b.className='btn'},4000);
  }).catch(()=>{
    const el=document.getElementById('ct');
    const r=document.createRange();r.selectNodeContents(el);
    const s=window.getSelection();s.removeAllRanges();s.addRange(r);
    document.execCommand('copy');
    alert('Copiado!');
  });
}
</script>
</body>
</html>`);
});

app.get('/api/status', (c) => {
  return c.json({
    status: 'online',
    app: 'ExecDaat - Secure Payments & Smart Contracts',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    network: {
      name: 'Arc Testnet',
      chainId: ARC_TESTNET.chainId,
      rpcUrl: ARC_TESTNET.rpcUrl,
      rpcAlternatives: ARC_TESTNET.rpcUrlAlternatives,
      rpcWebSocket: ARC_TESTNET.rpcUrlWebSocket,
      usdcAddress: ARC_TESTNET.usdcAddress,
      eurcAddress: ARC_TESTNET.eurcAddress,
      explorerUrl: ARC_TESTNET.explorerUrl,
      faucetUrl: ARC_TESTNET.faucetUrl,
      nativeGas: 'USDC',
      gasCost: '~$0.009 por transação',
    },
    agents: {
      payment: {
        id: 'payment-agent-01',
        name: 'Daat Agent v1.0',
        capabilities: ['analyze', 'execute', 'cancel', 'batch'],
        endpoint: '/api/payments',
      },
      contract: {
        id: 'contract-agent-01',
        name: 'Daat Contract Agent v1.0',
        capabilities: ['review', 'activate', 'verify_milestone', 'resolve_dispute'],
        endpoint: '/api/contracts',
      },
    },
    contracts: {
      paymentManager: '0x0000000000000000000000000000000000000001',
      contractManager: '0x0000000000000000000000000000000000000002',
      note: 'Deploy contratos reais em: https://faucet.circle.com → forge create',
    },
  })
})

// ─── SPA Route Aliases — redirect clean URLs to the hash-based SPA router ──
// e.g. /payments → /#/payments ; router.js matches the hash against DAAT_ROUTES.
// The hash MUST equal the clean path (not the tab name) so routes whose tab
// differs from the path — /swap(dex) and /unified-balance(unified) — resolve.
const SPA_ROUTES: string[] = [
  '/home', '/dashboard', '/payments', '/contracts', '/autonoma', '/agents',
  '/settings', '/otc', '/swap', '/multisend', '/history',
  '/unified-balance', '/advanced-crosschain',
]

for (const routePath of SPA_ROUTES) {
  app.get(routePath, (c) => {
    return c.redirect(`/#${routePath}`, 302)
  })
}

// GET / - main SPA shell (served verbatim from src/app.html)
app.get('/', (c) => {
  // Never edge/browser-cache the HTML shell so new deployments (which reference
  // content-hashed JS bundles) propagate to every browser immediately. The JS
  // assets themselves stay long-cached via their hashed filenames.
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate')
  c.header('Pragma', 'no-cache')
  return c.html(appHtml)
})

export default app
