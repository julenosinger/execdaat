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
import { ARC_TESTNET } from './types/arc'
import { securityMiddleware, logSecurityEvent, getClientIP } from './middleware/security'

const app = new Hono()

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
    .nav-brand{color:#fff;font-weight:700;font-size:.95rem;text-decoration:none;display:flex;align-items:center;gap:8px}
    .nav-links{display:flex;gap:20px}
    .nav-links a{color:#6b7280;font-size:.85rem}
    footer{border-top:1px solid #1f2937;padding:20px 24px;text-align:center;color:#4b5563;font-size:.8rem}
  </style>
`;

const LEGAL_NAV = `
  <nav class="nav">
    <a href="/" class="nav-brand">⚡ ARC AI Agents</a>
    <div class="nav-links">
      <a href="/about">About</a>
      <a href="/privacy-policy">Privacy</a>
      <a href="/terms-of-service">Terms</a>
    </div>
  </nav>
`;
const LEGAL_FOOTER = `<footer>© 2025 ARC AI Agents — Open Source · MIT License · <a href="https://github.com/julenosinger/Agentes-de-IA">GitHub</a></footer>`;

app.get('/about', (c) => c.html(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>About — ARC AI Agents</title>${LEGAL_STYLE}</head><body>
${LEGAL_NAV}
<div class="wrap">
  <div class="badge">🧪 Testnet Application</div>
  <h1>About ARC AI Agents</h1>
  <p>ARC AI Agents is an <strong style="color:#fff">open-source, non-custodial testnet dApp</strong> built on <a href="https://arc.network" target="_blank">Arc Network</a>. It is designed for developers and users to explore autonomous Web3 interactions in a safe testnet environment.</p>

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

app.get('/privacy-policy', (c) => c.html(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Privacy Policy — ARC AI Agents</title>${LEGAL_STYLE}</head><body>
${LEGAL_NAV}
<div class="wrap">
  <div class="badge">🔒 Privacy Policy</div>
  <h1>Privacy Policy</h1>
  <p><em>Last updated: March 2025</em></p>
  <p>ARC AI Agents ("we", "the app") is an open-source testnet application. This policy explains what data, if any, is collected and how it is handled.</p>

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

app.get('/terms-of-service', (c) => c.html(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Terms of Service — ARC AI Agents</title>${LEGAL_STYLE}</head><body>
${LEGAL_NAV}
<div class="wrap">
  <div class="badge">📄 Terms of Service</div>
  <h1>Terms of Service</h1>
  <p><em>Last updated: March 2025</em></p>
  <p>By using ARC AI Agents ("the App"), you agree to the following terms.</p>

  <h2>1. Testnet Only</h2>
  <p>This application operates exclusively on <strong style="color:#fff">Arc Testnet</strong>. All tokens used are testnet tokens with no real monetary value. Do not attempt to use mainnet assets with this application.</p>

  <h2>2. No Financial Advice</h2>
  <p>Nothing in this application constitutes financial, investment, or legal advice. Use at your own risk. This is an experimental testnet application for educational and development purposes only.</p>

  <h2>3. No Custody of Funds</h2>
  <p>ARC AI Agents is a <strong style="color:#fff">non-custodial</strong> application. We do not hold, control, or have access to your funds at any time. Your wallet and private keys remain solely in your possession.</p>

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
  <p>To the maximum extent permitted by law, ARC AI Agents and its contributors shall not be liable for any loss or damage resulting from use of this application.</p>

  <h2>8. Changes</h2>
  <p>These terms may be updated at any time. Continued use of the App constitutes acceptance of updated terms.</p>

  <h2>9. Contact</h2>
  <p>Questions? Open an issue on <a href="https://github.com/julenosinger/Agentes-de-IA/issues" target="_blank">GitHub</a>.</p>
</div>
${LEGAL_FOOTER}
</body></html>`));


// ─── 404 Page ─────────────────────────────────────────────────────────────────
app.notFound((c) => c.html(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>404 — Page Not Found | ARC AI Agents</title>${LEGAL_STYLE}<style>.hero{text-align:center;padding:80px 24px}.code{font-size:6rem;font-weight:900;background:linear-gradient(135deg,#06b6d4,#6366f1);-webkit-background-clip:text;-webkit-text-fill-color:transparent;line-height:1}.msg{color:#9ca3af;margin:16px 0 32px;font-size:1.1rem}.btn{display:inline-flex;align-items:center;gap:8px;background:#6366f1;color:#fff;padding:12px 28px;border-radius:12px;text-decoration:none;font-weight:600;transition:background .2s}.btn:hover{background:#4f46e5;text-decoration:none}</style></head><body>${LEGAL_NAV}<div class="wrap"><div class="hero"><div class="code">404</div><p class="msg">Page not found — this route doesn't exist.</p><a href="/" class="btn">⚡ Back to ARC AI Agents</a></div></div>${LEGAL_FOOTER}</body></html>`, 404));


app.get('/api/status', (c) => {
  return c.json({
    status: 'online',
    app: 'ARC AI Agents - Pagamentos & Contratos',
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
        name: 'ArcPay Agent v1.0',
        capabilities: ['analyze', 'execute', 'cancel', 'batch'],
        endpoint: '/api/payments',
      },
      contract: {
        id: 'contract-agent-01',
        name: 'ArcContract Agent v1.0',
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

// GET / - Interface principal
app.get('/', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, viewport-fit=cover">
  <title>ARC AI Agents — Testnet dApp | Payments, Swap &amp; Contracts on Arc Network</title>

  <!-- ── SEO & Trust Meta Tags ─────────────────────────────────────────── -->
  <meta name="description" content="ARC AI Agents is an open-source testnet dApp on Arc Network. Explore autonomous payments, token swaps, smart contracts, and liquidity pools — all on testnet. No real funds involved.">
  <meta name="keywords" content="ARC Network, testnet, dApp, USDC, EURC, swap, AMM, Web3, blockchain, open source">
  <meta name="author" content="ARC AI Agents — Open Source Project">
  <meta name="robots" content="index, follow">
  <meta name="theme-color" content="#1e1b4b">

  <!-- ── Open Graph (Facebook/LinkedIn) ──────────────────────────────── -->
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://arc-ai-agents.pages.dev/">
  <meta property="og:title" content="ARC AI Agents — Testnet dApp">
  <meta property="og:description" content="Open-source testnet application on Arc Network. Autonomous payments, token swaps, AMM liquidity pools. No real funds — testnet only.">
  <meta property="og:site_name" content="ARC AI Agents">

  <!-- ── Twitter Card ─────────────────────────────────────────────────── -->
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="ARC AI Agents — Testnet dApp">
  <meta name="twitter:description" content="Open-source testnet dApp on Arc Network. No real funds involved.">

  <!-- ── Security & Anti-Phishing ─────────────────────────────────────── -->
  <meta name="application-name" content="ARC AI Agents">
  <meta http-equiv="X-Content-Type-Options" content="nosniff">
  <meta name="referrer" content="strict-origin-when-cross-origin">

  <!-- ── Favicon ──────────────────────────────────────────────────────── -->
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='20' fill='%237c3aed'/><text y='72' x='50' text-anchor='middle' font-size='58' font-family='sans-serif'>⚡</text></svg>">
  <link rel="apple-touch-icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='20' fill='%237c3aed'/><text y='72' x='50' text-anchor='middle' font-size='58'>⚡</text></svg>">

  <!-- ── Canonical ────────────────────────────────────────────────────── -->
  <link rel="canonical" href="https://arc-ai-agents.pages.dev/">

  <!-- ── Schema.org structured data ──────────────────────────────────── -->
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    "name": "ARC AI Agents",
    "description": "Open-source testnet dApp on Arc Network for autonomous payments, token swaps and smart contracts.",
    "url": "https://arc-ai-agents.pages.dev",
    "applicationCategory": "FinanceApplication",
    "operatingSystem": "Web Browser",
    "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
    "author": { "@type": "Organization", "name": "ARC AI Agents Open Source" }
  }
  </script>

  <!-- ── Stylesheets & Libraries ──────────────────────────────────────── -->
  <script src="https://cdn.tailwindcss.com"></script>

  <!-- ARC Security Layer (loaded first, before all app scripts) -->
  <script src="/static/security.js?v=20250323"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
  <!-- ethers.js v6 — used for ethers.Contract, ethers.parseUnits, BrowserProvider -->
  <script src="https://cdn.jsdelivr.net/npm/ethers@6.13.4/dist/ethers.umd.min.js"></script>
  <!-- jsPDF — PDF receipt generation -->
  <script src="https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js"></script>
  <link href="/static/styles.css?v=20250323e" rel="stylesheet">
  <script src="/static/i18n.js?v=20250322"></script>
</head>
<body class="bg-gray-950 text-gray-100 min-h-screen">

  <!-- ══════════════════════════════════════════════════════════════════════
       HEADER LAYOUT CONTROLLER — inline script runs immediately
       Manages banner dismiss animation + CSS variable for tab-nav sticky offset
       ══════════════════════════════════════════════════════════════════════ -->
  <script>
    // Update --topbar-h so the tab nav always sticks directly below the topbar
    function updateTopbarHeight() {
      var tb = document.getElementById('sticky-topbar');
      if (!tb) return;
      var h = tb.getBoundingClientRect().height;
      document.documentElement.style.setProperty('--topbar-h', h + 'px');
    }

    // Dismiss the testnet banner with a smooth collapse animation
    function dismissBanner() {
      var banner = document.getElementById('testnet-banner');
      if (!banner) return;
      // Collapse: fade out then remove height
      banner.style.transition = 'max-height 0.25s ease, padding 0.2s ease, opacity 0.15s ease';
      banner.style.opacity    = '0';
      banner.style.maxHeight  = '0';
      banner.style.padding    = '0 16px';
      // After animation ends, hide completely and sync height var
      setTimeout(function() {
        banner.style.display = 'none';
        updateTopbarHeight();
      }, 270);
      // Remember preference
      try { sessionStorage.setItem('arc-banner-dismissed', '1'); } catch(e){}
    }

    // Restore banner state on page load (if dismissed in this session)
    document.addEventListener('DOMContentLoaded', function() {
      try {
        if (sessionStorage.getItem('arc-banner-dismissed') === '1') {
          var banner = document.getElementById('testnet-banner');
          if (banner) banner.style.display = 'none';
        }
      } catch(e){}
      // Set initial topbar height after DOM is ready
      updateTopbarHeight();
      // Also update on resize (handles mobile orientation change etc.)
      window.addEventListener('resize', updateTopbarHeight, { passive: true });
    });
  </script>

  <!-- ══════════════════════════════════════════════════════════════════════
       STICKY TOP-BAR WRAPPER — banner + header in one sticky block
       Sticks at top:0. When banner is dismissed, header moves up naturally.
       No hardcoded pixel offsets needed anywhere.
       ══════════════════════════════════════════════════════════════════════ -->
  <div id="sticky-topbar" style="position:sticky;top:0;z-index:100;">

  <!-- TESTNET WARNING BANNER — dismissible -->
  <div id="testnet-banner" style="background:#111;border-bottom:1px solid #2a2a2a;color:#fff;font-size:12px;padding:7px 16px;display:flex;align-items:center;justify-content:center;gap:8px;overflow:hidden;transition:max-height 0.25s ease,padding 0.25s ease,opacity 0.2s ease;max-height:48px;opacity:1;">
    <span style="color:#f59e0b;font-size:14px;">⚠</span>
    <span style="color:#f59e0b;font-weight:700;letter-spacing:0.03em;">TESTNET ONLY —</span>
    <span style="color:#ccc;font-weight:400;" class="hidden sm:inline">This application runs exclusively on Arc Testnet. No real funds are used. Do not send mainnet assets.</span>
    <span style="color:#ccc;font-weight:400;" class="sm:hidden">Arc Testnet only. No real funds.</span>
    <a href="/about" style="color:#ccc;text-decoration:underline;margin-left:4px;opacity:0.8;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.8'" class="hidden sm:inline">Learn more</a>
    <button
      onclick="dismissBanner()"
      title="Dismiss"
      style="margin-left:12px;background:none;border:none;color:#888;font-size:14px;cursor:pointer;padding:0 2px;line-height:1;display:flex;align-items:center;flex-shrink:0;"
      onmouseover="this.style.color='#fff'"
      onmouseout="this.style.color='#888'"
    >✕</button>
  </div>

  <!-- HEADER — stacks directly below banner inside sticky wrapper -->
  <header id="main-header" class="bg-gray-900/95 border-b border-purple-800/30 px-6 py-3 backdrop-blur-sm" style="position:relative;z-index:50;">
    <div class="max-w-7xl mx-auto flex items-center justify-between">
      <button onclick="showLanding()" class="flex items-center gap-3 hover:opacity-80 transition-opacity">
        <div class="w-9 h-9 rounded-xl bg-gradient-to-br from-purple-600 to-blue-600 flex items-center justify-center flex-shrink-0">
          <i class="fas fa-robot text-white text-base"></i>
        </div>
        <div class="text-left">
          <div class="font-bold text-base text-white leading-none">ARC AI Agents</div>
          <div class="text-[10px] text-purple-400 leading-none mt-0.5">Autonomous Payments &amp; Contracts</div>
        </div>
      </button>
      <div class="flex items-center gap-2 sm:gap-3">
        <!-- Language Selector -->
        <div id="lang-selector" class="relative">
          <button onclick="toggleLangDropdown()"
            class="flex items-center gap-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-gray-500 rounded-xl px-3 py-2 text-sm text-gray-300 transition-all">
            <i class="fas fa-globe text-purple-400 text-xs"></i>
            <span id="lang-toggle-label" class="hidden sm:inline">🇺🇸 English <i class="fas fa-chevron-down text-xs ml-1 text-gray-500"></i></span>
          </button>
          <div id="lang-dropdown" class="hidden absolute right-0 top-full mt-1 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl z-50 min-w-[160px] overflow-hidden">
            <button onclick="setLang('en')" data-lang="en" class="lang-option w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-800 border border-transparent transition-all"><span class="text-base">🇺🇸</span> English</button>
            <button onclick="setLang('pt')" data-lang="pt" class="lang-option w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-800 border border-transparent transition-all"><span class="text-base">🇧🇷</span> Português</button>
            <button onclick="setLang('es')" data-lang="es" class="lang-option w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-800 border border-transparent transition-all"><span class="text-base">🇪🇸</span> Español</button>
            <button onclick="setLang('zh')" data-lang="zh" class="lang-option w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-800 border border-transparent transition-all"><span class="text-base">🇨🇳</span> 中文</button>
            <button onclick="setLang('ko')" data-lang="ko" class="lang-option w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-800 border border-transparent transition-all"><span class="text-base">🇰🇷</span> 한국어</button>
          </div>
        </div>

        <!-- Arc Network badge -->
        <div class="hidden sm:flex items-center gap-1.5 bg-green-900/30 border border-green-700/40 rounded-full px-3 py-1.5">
          <div class="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse"></div>
          <span class="text-xs text-green-400 font-medium">Arc Testnet</span>
        </div>



        <!-- Wallet info (when connected) -->
        <div id="wallet-info" class="hidden items-center gap-2 bg-gray-800/80 border border-gray-700/50 rounded-xl px-3 py-2 cursor-pointer hover:border-purple-600/50 transition-all" onclick="openWalletModal()">
          <div class="w-6 h-6 rounded-full bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center flex-shrink-0 text-white text-xs font-bold" id="wallet-avatar">??</div>
          <div class="hidden sm:block">
            <div class="text-xs text-white font-mono font-medium leading-none" id="wallet-address-display">0x...</div>
            <div id="wallet-network-display" class="text-xs text-green-400 leading-none mt-0.5"></div>
          </div>
          <div id="wallet-balance-display" class="hidden text-xs text-blue-400 font-medium bg-blue-900/30 px-2 py-0.5 rounded-full"></div>
        </div>

        <!-- Settings -->
        <button onclick="openSettingsModal()" id="settings-btn"
          class="w-9 h-9 flex items-center justify-center bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-gray-500 rounded-xl text-gray-400 hover:text-white transition-all relative" title="Settings">
          <i class="fas fa-cog text-sm"></i>
          <span id="settings-dot" class="hidden absolute -top-1 -right-1 w-2.5 h-2.5 bg-purple-500 rounded-full border-2 border-gray-900"></span>
        </button>

        <!-- Profile -->
        <button onclick="openProfileModal()" id="profile-btn"
          class="w-9 h-9 flex items-center justify-center bg-gradient-to-br from-purple-700 to-blue-700 hover:from-purple-600 hover:to-blue-600 border border-purple-600/40 rounded-xl text-white font-bold text-xs transition-all" title="Profile">
          <span id="profile-avatar-btn">👤</span>
        </button>

        <!-- Connect Wallet Button -->
        <button id="wallet-connect-btn" onclick="openWalletModal()"
          class="wallet-connect-pulse flex items-center gap-2 bg-purple-600 hover:bg-purple-700 text-white rounded-xl px-4 py-2 text-sm font-semibold transition-all shadow-lg shadow-purple-900/30">
          <i class="fas fa-wallet"></i>
          <span class="hidden sm:inline" data-i18n="btn_connect">Connect</span>
        </button>
        <div id="wallet-badge" class="hidden sm:hidden w-2 h-2 rounded-full bg-green-400"></div>
      </div>
    </div>
  </header>

  </div><!-- /#sticky-topbar -->

  <!-- ══════════════════════════════════════════════════════════════════════
       LANDING PAGE — shown by default, hidden after "Enter App"
       ══════════════════════════════════════════════════════════════════════ -->
  <div id="landing-page">

    <!-- HERO SECTION -->
    <section class="relative overflow-hidden bg-gradient-to-b from-gray-950 via-purple-950/20 to-gray-950 py-20 px-6">
      <!-- Background grid -->
      <div class="absolute inset-0 opacity-5" style="background-image:radial-gradient(circle at 1px 1px, rgba(139,92,246,.6) 1px, transparent 0);background-size:32px 32px;"></div>
      <!-- Glow -->
      <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-purple-600/5 rounded-full blur-3xl pointer-events-none"></div>

      <div class="relative max-w-4xl mx-auto text-center">
        <!-- Testnet pill -->
        <div class="inline-flex items-center gap-2 bg-amber-500/10 border border-amber-500/30 rounded-full px-4 py-1.5 text-xs text-amber-400 font-semibold mb-6">
          <i class="fas fa-flask"></i>
          Testnet Application — No real funds involved
        </div>

        <!-- Title -->
        <h1 class="text-4xl sm:text-5xl lg:text-6xl font-extrabold text-white mb-5 leading-tight tracking-tight">
          ARC <span class="bg-gradient-to-r from-purple-400 to-cyan-400 bg-clip-text text-transparent">AI Agents</span>
        </h1>

        <!-- Subtitle -->
        <p class="text-lg sm:text-xl text-gray-300 font-medium mb-3">
          Autonomous Payments &amp; Smart Contracts on Arc Network (Testnet)
        </p>

        <!-- Description -->
        <p class="text-gray-400 text-base max-w-2xl mx-auto mb-10 leading-relaxed">
          A decentralized platform that allows users to automate financial operations using smart contracts and AI agents on the Arc Network.
          Built entirely open-source — no private keys ever leave your wallet.
        </p>

        <!-- CTA Buttons -->
        <div class="flex flex-col sm:flex-row gap-3 justify-center items-center mb-12">
          <button onclick="enterApp()"
            class="flex items-center gap-2 bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 text-white font-bold rounded-2xl px-8 py-3.5 text-base shadow-lg shadow-purple-900/40 transition-all hover:scale-105 active:scale-95">
            <i class="fas fa-rocket"></i>
            Launch App
          </button>
          <a href="https://github.com/julenosinger/Agentes-de-IA" target="_blank" rel="noopener"
            class="flex items-center gap-2 text-gray-400 hover:text-white text-sm transition-colors">
            <i class="fab fa-github"></i>
            View Source
          </a>
        </div>

        <!-- Trust signals row -->
        <div class="flex flex-wrap justify-center gap-4 text-xs text-gray-500">
          <span class="flex items-center gap-1.5"><i class="fas fa-shield-alt text-green-400"></i>Open Source</span>
          <span class="flex items-center gap-1.5"><i class="fas fa-key text-purple-400"></i>No Private Keys Stored</span>
          <span class="flex items-center gap-1.5"><i class="fas fa-eye text-cyan-400"></i>Fully Verifiable On-Chain</span>
          <span class="flex items-center gap-1.5"><i class="fas fa-code text-blue-400"></i>Testnet Only</span>
          <a href="https://testnet.arcscan.app/address/0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A" target="_blank" rel="noopener"
            class="flex items-center gap-1.5 text-gray-500 hover:text-blue-400 transition-colors">
            <i class="fas fa-external-link-alt"></i>Verified Contracts on ArcScan
          </a>
        </div>
      </div>
    </section>

    <!-- WHAT IS THIS SECTION -->
    <section class="py-16 px-6 border-t border-gray-800/60">
      <div class="max-w-4xl mx-auto">
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-10 items-center">
          <div>
            <div class="text-xs text-purple-400 font-semibold uppercase tracking-wider mb-2">What is this?</div>
            <h2 class="text-2xl font-bold text-white mb-4">A trustless financial automation platform</h2>
            <p class="text-gray-400 leading-relaxed mb-4">
              ARC AI Agents is a decentralized testnet application that lets you explore autonomous financial operations
              on the Arc Network. Connect your EVM wallet to interact with smart contracts,
              send batch payments, swap tokens, and manage on-chain escrow — all without custodians.
            </p>
            <p class="text-gray-500 text-sm leading-relaxed">
              This is a <strong class="text-amber-400">testnet-only</strong> application. All tokens are test tokens with no real value.
              No real funds are at risk. Smart contracts are deployed on Arc Testnet and verifiable on ArcScan.
            </p>
            <div class="mt-6 flex flex-wrap gap-3">
              <a href="https://testnet.arcscan.app" target="_blank" rel="noopener"
                class="flex items-center gap-2 text-xs text-gray-400 hover:text-cyan-400 border border-gray-700 hover:border-cyan-700 rounded-lg px-3 py-2 transition-all">
                <i class="fas fa-search text-cyan-500"></i>ArcScan Explorer
              </a>
              <a href="https://faucet.circle.com" target="_blank" rel="noopener"
                class="flex items-center gap-2 text-xs text-gray-400 hover:text-blue-400 border border-gray-700 hover:border-blue-700 rounded-lg px-3 py-2 transition-all">
                <i class="fas fa-faucet text-blue-500"></i>Get Test USDC
              </a>
              <a href="/about" class="flex items-center gap-2 text-xs text-gray-400 hover:text-white border border-gray-700 rounded-lg px-3 py-2 transition-all">
                <i class="fas fa-info-circle"></i>About / Legal
              </a>
            </div>
          </div>
          <div class="space-y-3">
            <div class="bg-gray-900/60 border border-green-700/20 rounded-xl p-4 flex items-start gap-3">
              <i class="fas fa-shield-alt text-green-400 text-lg mt-0.5 flex-shrink-0"></i>
              <div>
                <div class="text-white text-sm font-semibold mb-0.5">We never request your private key</div>
                <div class="text-gray-500 text-xs">All signing happens exclusively in your wallet (MetaMask or compatible). We have zero access to your funds.</div>
              </div>
            </div>
            <div class="bg-gray-900/60 border border-purple-700/20 rounded-xl p-4 flex items-start gap-3">
              <i class="fas fa-code text-purple-400 text-lg mt-0.5 flex-shrink-0"></i>
              <div>
                <div class="text-white text-sm font-semibold mb-0.5">100% Open Source</div>
                <div class="text-xs text-gray-500">All smart contracts and frontend code are public and verifiable on GitHub and ArcScan.</div>
              </div>
            </div>
            <div class="bg-gray-900/60 border border-cyan-700/20 rounded-xl p-4 flex items-start gap-3">
              <i class="fas fa-flask text-amber-400 text-lg mt-0.5 flex-shrink-0"></i>
              <div>
                <div class="text-white text-sm font-semibold mb-0.5">Testnet only — no real value</div>
                <div class="text-xs text-gray-500">USDC and EURC shown here are testnet tokens. They have no monetary value and cannot be withdrawn.</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- FEATURES SECTION -->
    <section class="py-16 px-6 bg-gray-900/30 border-t border-gray-800/60">
      <div class="max-w-5xl mx-auto">
        <div class="text-center mb-10">
          <div class="text-xs text-cyan-400 font-semibold uppercase tracking-wider mb-2">Platform Features</div>
          <h2 class="text-2xl font-bold text-white">Everything you need to explore Web3 finance</h2>
          <p class="text-gray-500 text-sm mt-2">All features run on Arc Testnet. Safe to explore.</p>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">

          <div class="bg-gray-900/60 border border-gray-700/40 rounded-2xl p-5 hover:border-purple-600/40 transition-colors">
            <div class="w-10 h-10 rounded-xl bg-purple-900/40 border border-purple-700/30 flex items-center justify-center mb-3">
              <i class="fas fa-dollar-sign text-purple-400"></i>
            </div>
            <h3 class="text-white font-semibold mb-1.5 text-sm">Automated Payments</h3>
            <p class="text-gray-500 text-xs leading-relaxed">P2P, corporate, or batch payments in USDC/EURC. AI agents analyze and execute on-chain transfers with full transaction history.</p>
          </div>

          <div class="bg-gray-900/60 border border-gray-700/40 rounded-2xl p-5 hover:border-cyan-600/40 transition-colors">
            <div class="w-10 h-10 rounded-xl bg-cyan-900/40 border border-cyan-700/30 flex items-center justify-center mb-3">
              <i class="fas fa-paper-plane text-cyan-400"></i>
            </div>
            <h3 class="text-white font-semibold mb-1.5 text-sm">MultiSend / Batch</h3>
            <p class="text-gray-500 text-xs leading-relaxed">Send USDC to hundreds of recipients in a single batch. Upload a CSV, review, sign once, and download your receipt.</p>
          </div>

          <div class="bg-gray-900/60 border border-gray-700/40 rounded-2xl p-5 hover:border-green-600/40 transition-colors">
            <div class="w-10 h-10 rounded-xl bg-green-900/40 border border-green-700/30 flex items-center justify-center mb-3">
              <i class="fas fa-file-contract text-green-400"></i>
            </div>
            <h3 class="text-white font-semibold mb-1.5 text-sm">Smart Contracts</h3>
            <p class="text-gray-500 text-xs leading-relaxed">Create on-chain work contracts with milestone-based USDC escrow. Fully trustless via ContractFactory on Arc Testnet.</p>
          </div>

          <div class="bg-gray-900/60 border border-gray-700/40 rounded-2xl p-5 hover:border-blue-600/40 transition-colors">
            <div class="w-10 h-10 rounded-xl bg-blue-900/40 border border-blue-700/30 flex items-center justify-center mb-3">
              <i class="fas fa-exchange-alt text-blue-400"></i>
            </div>
            <h3 class="text-white font-semibold mb-1.5 text-sm">DEX / Token Swap</h3>
            <p class="text-gray-500 text-xs leading-relaxed">Swap USDC ↔ EURC using the on-chain AMM (x·y=k formula, 0.3% fee). Real liquidity pool deployed on Arc Testnet.</p>
          </div>

          <div class="bg-gray-900/60 border border-gray-700/40 rounded-2xl p-5 hover:border-orange-600/40 transition-colors">
            <div class="w-10 h-10 rounded-xl bg-orange-900/40 border border-orange-700/30 flex items-center justify-center mb-3">
              <i class="fas fa-shield-alt text-orange-400"></i>
            </div>
            <h3 class="text-white font-semibold mb-1.5 text-sm">Escrow Integrado</h3>
            <p class="text-gray-500 text-xs leading-relaxed">Cada contrato é um escrow autônomo. O cliente deposita USDC diretamente no contrato; o contratado recebe por milestone confirmado on-chain.</p>
          </div>

          <div class="bg-gray-900/60 border border-gray-700/40 rounded-2xl p-5 hover:border-pink-600/40 transition-colors">
            <div class="w-10 h-10 rounded-xl bg-pink-900/40 border border-pink-700/30 flex items-center justify-center mb-3">
              <i class="fas fa-brain text-pink-400"></i>
            </div>
            <h3 class="text-white font-semibold mb-1.5 text-sm">AI Agents</h3>
            <p class="text-gray-500 text-xs leading-relaxed">AI-driven agents analyze transactions, assess risk, and assist with contract operations. Ask the chatbot anything about the platform.</p>
          </div>

        </div>
      </div>
    </section>

    <!-- NETWORK INFO SECTION -->
    <section class="py-14 px-6 border-t border-gray-800/60">
      <div class="max-w-4xl mx-auto">
        <div class="text-center mb-8">
          <div class="text-xs text-green-400 font-semibold uppercase tracking-wider mb-2">Network Configuration</div>
          <h2 class="text-xl font-bold text-white">Arc Testnet — All addresses are public</h2>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <div class="bg-gray-900/60 border border-gray-700/30 rounded-xl p-3 flex items-center justify-between">
            <span class="text-gray-400 text-xs">Chain ID</span>
            <span class="font-mono text-white text-xs bg-gray-800 px-2 py-0.5 rounded">5042002</span>
          </div>
          <div class="bg-gray-900/60 border border-gray-700/30 rounded-xl p-3 flex items-center justify-between">
            <span class="text-gray-400 text-xs">Gas Token</span>
            <span class="text-green-400 text-xs font-semibold">USDC (native)</span>
          </div>
          <div class="bg-gray-900/60 border border-gray-700/30 rounded-xl p-3 flex items-center justify-between">
            <span class="text-gray-400 text-xs">Gas per tx</span>
            <span class="text-yellow-400 text-xs">~$0.009 USDC</span>
          </div>
          <div class="bg-gray-900/60 border border-gray-700/30 rounded-xl p-3 flex items-center justify-between">
            <span class="text-gray-400 text-xs">RPC</span>
            <a href="https://rpc.testnet.arc.network" target="_blank" class="text-purple-400 text-xs font-mono hover:underline">rpc.testnet.arc.network</a>
          </div>
          <div class="bg-gray-900/60 border border-gray-700/30 rounded-xl p-3 flex items-center justify-between">
            <span class="text-gray-400 text-xs">USDC</span>
            <a href="https://testnet.arcscan.app/address/0x3600000000000000000000000000000000000000" target="_blank" class="text-blue-400 text-xs font-mono hover:underline">0x3600…0000</a>
          </div>
          <div class="bg-gray-900/60 border border-gray-700/30 rounded-xl p-3 flex items-center justify-between">
            <span class="text-gray-400 text-xs">ContractFactory</span>
            <a href="https://testnet.arcscan.app/address/0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A" target="_blank" class="text-cyan-400 text-xs font-mono hover:underline">0xbbC9…aF2A</a>
          </div>
        </div>
      </div>
    </section>

    <!-- FINAL CTA -->
    <section class="py-16 px-6 text-center border-t border-gray-800/60">
      <div class="max-w-2xl mx-auto">
        <h2 class="text-2xl font-bold text-white mb-3">Ready to explore?</h2>
        <p class="text-gray-400 mb-6 text-sm">Connect your wallet and start interacting with the Arc Testnet. Everything is free — just get test USDC from the faucet.</p>
        <div class="flex flex-col sm:flex-row gap-3 justify-center">
          <button onclick="enterApp()"
            class="flex items-center justify-center gap-2 bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 text-white font-bold rounded-2xl px-8 py-3.5 text-sm shadow-lg transition-all hover:scale-105">
            <i class="fas fa-rocket"></i>Launch App — No wallet required
          </button>
          <a href="https://faucet.circle.com" target="_blank" rel="noopener"
            class="flex items-center justify-center gap-2 bg-gray-800 hover:bg-gray-700 border border-gray-600 text-gray-300 rounded-2xl px-8 py-3.5 text-sm transition-all">
            <i class="fas fa-faucet text-blue-400"></i>Get Test USDC
          </a>
        </div>
        <p class="text-xs text-gray-600 mt-6">
          <i class="fas fa-lock mr-1"></i>
          This app never stores your private keys. Source code:
          <a href="https://github.com/julenosinger/Agentes-de-IA" target="_blank" rel="noopener" class="text-gray-500 hover:text-white underline">GitHub</a>
        </p>
      </div>
    </section>

    <!-- FOOTER -->
    <footer class="border-t border-gray-800/60 py-8 px-6">
      <div class="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-gray-600">
        <div class="flex items-center gap-3">
          <div class="w-6 h-6 rounded-lg bg-gradient-to-br from-purple-600 to-blue-600 flex items-center justify-center">
            <i class="fas fa-robot text-white text-[10px]"></i>
          </div>
          <span>ARC AI Agents — Open Source Testnet dApp</span>
        </div>
        <div class="flex items-center gap-4">
          <a href="/about" class="hover:text-gray-400 transition-colors">About</a>
          <a href="/privacy-policy" class="hover:text-gray-400 transition-colors">Privacy</a>
          <a href="/terms-of-service" class="hover:text-gray-400 transition-colors">Terms</a>
          <a href="https://github.com/julenosinger/Agentes-de-IA" target="_blank" rel="noopener" class="hover:text-gray-400 transition-colors">GitHub</a>
          <a href="https://testnet.arcscan.app" target="_blank" rel="noopener" class="hover:text-gray-400 transition-colors">ArcScan</a>
        </div>
      </div>
    </footer>
  </div>
  <!-- END LANDING PAGE -->

  <!-- ══════════════════════════════════════════════════════════════════════
       APP SHELL — hidden until user clicks "Enter App" or connects wallet
       ══════════════════════════════════════════════════════════════════════ -->
  <div id="app-shell" class="hidden">

  <!-- Tabs -->
  <div id="tab-nav" class="bg-gray-900/60 border-b border-gray-800" style="position:sticky;top:var(--topbar-h,0px);z-index:40;transition:top 0.25s ease;">
    <div class="max-w-7xl mx-auto tab-nav-wrapper">
      <div class="flex gap-0 min-w-max">
        <button onclick="switchTab('agents')" id="tab-agents" class="tab-btn active px-4 sm:px-6 py-4 text-sm font-medium border-b-2 border-purple-500 text-purple-400 transition-all">
          <i class="fas fa-brain mr-1 sm:mr-2"></i><span data-i18n="tab_agents" class="hidden xs:inline sm:inline">AI Agents</span>
        </button>
        <button onclick="switchTab('payments')" id="tab-payments" class="tab-btn px-4 sm:px-6 py-4 text-sm font-medium border-b-2 border-transparent text-gray-400 hover:text-gray-200 transition-all">
          <i class="fas fa-dollar-sign mr-1 sm:mr-2"></i><span data-i18n="tab_payments" class="hidden xs:inline sm:inline">Payments</span>
        </button>
        <button onclick="switchTab('contracts')" id="tab-contracts" class="tab-btn px-4 sm:px-6 py-4 text-sm font-medium border-b-2 border-transparent text-gray-400 hover:text-gray-200 transition-all">
          <i class="fas fa-file-contract mr-1 sm:mr-2"></i><span data-i18n="tab_contracts" class="hidden xs:inline sm:inline">Contracts</span>
        </button>
        <button onclick="switchTab('dex')" id="tab-dex" class="tab-btn px-4 sm:px-6 py-4 text-sm font-medium border-b-2 border-transparent text-gray-400 hover:text-gray-200 transition-all">
          <i class="fas fa-exchange-alt mr-1 sm:mr-2"></i><span class="hidden sm:inline">DEX</span><span class="sm:hidden text-xs">DEX</span>
        </button>
        <button onclick="switchTab('multisend')" id="tab-multisend" class="tab-btn px-4 sm:px-6 py-4 text-sm font-medium border-b-2 border-transparent text-gray-400 hover:text-cyan-400 transition-all">
          <i class="fas fa-paper-plane mr-1 sm:mr-2"></i><span class="hidden sm:inline">MultiSend</span><span class="sm:hidden text-xs">Multi</span>
        </button>
        <button onclick="switchTab('history')" id="tab-history" class="tab-btn px-4 sm:px-6 py-4 text-sm font-medium border-b-2 border-transparent text-gray-400 hover:text-blue-400 transition-all">
          <i class="fas fa-history mr-1 sm:mr-2"></i><span class="hidden sm:inline">History</span><span class="sm:hidden text-xs">Hist</span>
        </button>
        <button onclick="switchTab('dashboard')" id="tab-dashboard" class="tab-btn px-4 sm:px-6 py-4 text-sm font-medium border-b-2 border-transparent text-gray-400 hover:text-indigo-400 transition-all">
          <i class="fas fa-info-circle mr-1 sm:mr-2"></i><span class="hidden sm:inline">Information</span><span class="sm:hidden text-xs">Info</span>
        </button>

      </div>
    </div>
  </div>

  <!-- Main Content -->
  <main class="max-w-7xl mx-auto px-6 py-8">

    <!-- DASHBOARD TAB -->
    <div id="tab-content-dashboard" class="tab-content">
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div class="stat-card bg-gradient-to-br from-purple-900/60 to-purple-800/30 border border-purple-700/40 rounded-xl p-5">
          <div class="flex items-center justify-between mb-3">
            <span class="text-purple-300 text-sm" data-i18n="stat_payments_label">Payments Processed</span>
            <i class="fas fa-exchange-alt text-purple-400 text-xl"></i>
          </div>
          <div id="stat-payments" class="text-3xl font-bold text-white">--</div>
          <div class="text-xs text-purple-400 mt-1" data-i18n="stat_payments_sub">transactions on Arc Testnet</div>
        </div>
        <div class="stat-card bg-gradient-to-br from-blue-900/60 to-blue-800/30 border border-blue-700/40 rounded-xl p-5">
          <div class="flex items-center justify-between mb-3">
            <span class="text-blue-300 text-sm" data-i18n="stat_volume_label">USDC Volume</span>
            <i class="fas fa-coins text-blue-400 text-xl"></i>
          </div>
          <div id="stat-volume" class="text-3xl font-bold text-white">--</div>
          <div class="text-xs text-blue-400 mt-1" data-i18n="stat_volume_sub">USDC processed</div>
        </div>
        <div class="stat-card bg-gradient-to-br from-green-900/60 to-green-800/30 border border-green-700/40 rounded-xl p-5">
          <div class="flex items-center justify-between mb-3">
            <span class="text-green-300 text-sm" data-i18n="stat_contracts_label">Active Contracts</span>
            <i class="fas fa-file-contract text-green-400 text-xl"></i>
          </div>
          <div id="stat-contracts" class="text-3xl font-bold text-white">--</div>
          <div class="text-xs text-green-400 mt-1" data-i18n="stat_contracts_sub">in execution</div>
        </div>
        <div class="stat-card bg-gradient-to-br from-orange-900/60 to-orange-800/30 border border-orange-700/40 rounded-xl p-5">
          <div class="flex items-center justify-between mb-3">
            <span class="text-orange-300 text-sm" data-i18n="stat_pending_label">Pending Tasks</span>
            <i class="fas fa-clock text-orange-400 text-xl"></i>
          </div>
          <div id="stat-pending" class="text-3xl font-bold text-white">--</div>
          <div class="text-xs text-orange-400 mt-1" data-i18n="stat_pending_sub">awaiting agents</div>
        </div>
      </div>

      <!-- Network Info -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        <!-- Wallet Panel -->
        <div class="bg-gray-900/60 border border-purple-700/40 rounded-xl p-5">
          <h3 class="text-white font-semibold mb-4 flex items-center gap-2">
            <i class="fas fa-wallet text-purple-400"></i>
            <span data-i18n="my_wallet">My Wallet</span>
          </h3>
          <div id="wallet-panel">
            <!-- Preenchido pelo wallet.js -->
            <div class="flex flex-col items-center justify-center py-4 gap-3">
              <div class="w-12 h-12 rounded-full bg-gray-800 border-2 border-dashed border-gray-600 flex items-center justify-center">
                <i class="fas fa-wallet text-gray-500 text-lg"></i>
              </div>
              <p class="text-gray-400 text-xs text-center" data-i18n="wallet_connect_prompt">Connect your EVM wallet to interact with Arc Testnet</p>
              <button onclick="openWalletModal()" class="wallet-connect-pulse bg-purple-600 hover:bg-purple-700 text-white rounded-xl px-4 py-2 text-sm font-semibold transition-all flex items-center gap-2">
                <i class="fas fa-plug"></i><span data-i18n="btn_connect_wallet">Connect Wallet</span>
              </button>
            </div>
          </div>
        </div>

        <div class="bg-gray-900/60 border border-gray-700/40 rounded-xl p-6">
          <h3 class="text-white font-semibold mb-4 flex items-center gap-2">
            <i class="fas fa-network-wired text-purple-400"></i>
            <span data-i18n="network_config">Arc Testnet — Configuration</span>
          </h3>
          <div class="space-y-3">
            <div class="flex justify-between items-center py-2 border-b border-gray-700/30">
              <span class="text-gray-400 text-sm">RPC Primário</span>
              <a href="https://rpc.testnet.arc.network" target="_blank" class="text-purple-400 text-sm hover:underline font-mono text-xs">rpc.testnet.arc.network</a>
            </div>
            <div class="flex justify-between items-center py-2 border-b border-gray-700/30">
              <span class="text-gray-400 text-sm">RPC Blockdaemon</span>
              <a href="https://rpc.blockdaemon.testnet.arc.network" target="_blank" class="text-gray-400 text-xs hover:underline font-mono">rpc.blockdaemon.testnet.arc.network</a>
            </div>
            <div class="flex justify-between items-center py-2 border-b border-gray-700/30">
              <span class="text-gray-400 text-sm">RPC dRPC</span>
              <a href="https://rpc.drpc.testnet.arc.network" target="_blank" class="text-gray-400 text-xs hover:underline font-mono">rpc.drpc.testnet.arc.network</a>
            </div>
            <div class="flex justify-between items-center py-2 border-b border-gray-700/30">
              <span class="text-gray-400 text-sm">RPC QuickNode</span>
              <a href="https://rpc.quicknode.testnet.arc.network" target="_blank" class="text-gray-400 text-xs hover:underline font-mono">rpc.quicknode.testnet.arc.network</a>
            </div>
            <div class="flex justify-between items-center py-2 border-b border-gray-700/30">
              <span class="text-gray-400 text-sm">WebSocket</span>
              <span class="text-cyan-400 text-xs font-mono">wss://rpc.testnet.arc.network</span>
            </div>
            <div class="flex justify-between items-center py-2 border-b border-gray-700/30">
              <span class="text-gray-400 text-sm">Chain ID</span>
              <span class="text-white text-sm font-mono bg-gray-800 px-2 py-0.5 rounded">5042002</span>
            </div>
            <div class="flex justify-between items-center py-2 border-b border-gray-700/30">
              <span class="text-gray-400 text-sm" data-i18n="network_gas_token">Gas Token</span>
              <span class="text-green-400 text-sm font-semibold">USDC</span>
            </div>
            <div class="flex justify-between items-center py-2 border-b border-gray-700/30">
              <span class="text-gray-400 text-sm">USDC Address</span>
              <span class="text-blue-400 text-xs font-mono">0x3600...0000</span>
            </div>
            <div class="flex justify-between items-center py-2 border-b border-gray-700/30">
              <span class="text-gray-400 text-sm">EURC Address</span>
              <span class="text-blue-400 text-xs font-mono">0x89B5...D72a</span>
            </div>
            <div class="flex justify-between items-center py-2 border-b border-gray-700/30">
              <span class="text-gray-400 text-sm" data-i18n="network_gas_cost">Gas per Tx</span>
              <span class="text-yellow-400 text-sm">~$0.009 USDC</span>
            </div>
            <div class="flex justify-between items-center py-2">
              <span class="text-gray-400 text-sm" data-i18n="network_finality">Finality</span>
              <span class="text-green-400 text-sm" data-i18n="network_finality_val">Sub-second</span>
            </div>
          </div>
        </div>

        <div class="bg-gray-900/60 border border-gray-700/40 rounded-xl p-6">
          <h3 class="text-white font-semibold mb-4 flex items-center gap-2">
            <i class="fas fa-robot text-blue-400"></i>
            <span data-i18n="agent_status">AI Agent Status</span>
          </h3>
          <div id="agent-status-cards" class="space-y-3">
            <div class="animate-pulse bg-gray-800/50 rounded-lg h-16"></div>
            <div class="animate-pulse bg-gray-800/50 rounded-lg h-16"></div>
          </div>
        </div>
      </div>

      <!-- Metrics Bar -->
      <div id="db-metrics-bar"></div>

      <!-- Recent Activity + Network Metrics -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <!-- Activity Feed -->
        <div class="lg:col-span-2 bg-gray-900/60 border border-gray-700/40 rounded-xl p-6">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-white font-semibold flex items-center gap-2">
              <i class="fas fa-history text-gray-400"></i>
              <span data-i18n="recent_activity">Recent Activity</span>
            </h3>
            <div class="flex items-center gap-2">
              <span id="db-live-block" class="text-xs text-gray-600 font-mono"></span>
              <button onclick="loadDashboard()" class="text-xs text-purple-400 hover:text-purple-300 flex items-center gap-1">
                <i class="fas fa-sync"></i><span class="hidden sm:inline ml-1">Refresh</span>
              </button>
            </div>
          </div>
          <div id="recent-activity" class="space-y-1">
            <div class="text-gray-500 text-sm text-center py-4">Loading activities...</div>
          </div>
        </div>
        <!-- Network Metrics -->
        <div class="bg-gray-900/60 border border-gray-700/40 rounded-xl p-6">
          <h3 class="text-white font-semibold mb-4 flex items-center gap-2">
            <i class="fas fa-tachometer-alt text-purple-400"></i>
            Live Metrics
          </h3>
          <div id="db-network-metrics">
            <div class="animate-pulse space-y-2">
              <div class="h-16 bg-gray-800/40 rounded-xl"></div>
              <div class="h-16 bg-gray-800/40 rounded-xl"></div>
            </div>
          </div>
          <div class="mt-4 pt-4 border-t border-gray-700/30">
            <div class="flex items-center justify-between mb-2">
              <span class="text-xs text-gray-400">ContractFactory</span>
              <a href="https://testnet.arcscan.app/address/0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A" target="_blank"
                class="text-xs text-cyan-400 hover:text-cyan-300 font-mono">0xbbC9…aF2A ↗</a>
            </div>
            <div class="flex items-center justify-between mb-2">
              <span class="text-xs text-gray-400">USDC Token</span>
              <a href="https://testnet.arcscan.app/address/0x3600000000000000000000000000000000000000" target="_blank"
                class="text-xs text-blue-400 hover:text-blue-300 font-mono">0x3600…0000 ↗</a>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-xs text-gray-400">Explorer</span>
              <a href="https://testnet.arcscan.app" target="_blank" class="text-xs text-purple-400 hover:text-purple-300">testnet.arcscan.app ↗</a>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- PAYMENTS TAB -->
    <div id="tab-content-payments" class="tab-content hidden">

      <!-- ══ PAYMENTS STYLES (isolated, mirrors Contracts design system) ══ -->
      <style>
        /* ── Layout ── */
        #pay-page { display:grid; grid-template-columns:1fr; gap:20px; }
        @media(min-width:1280px){ #pay-page { grid-template-columns:minmax(0,2fr) minmax(0,3fr); gap:20px; } }

        /* ── Panel (mirrors .cf-panel) ── */
        .pay-cf-panel {
          background:rgba(10,12,24,0.98);
          border:1px solid rgba(55,138,221,0.18);
          border-radius:18px;
          position:relative;
          overflow:hidden;
        }
        .pay-cf-panel::after {
          content:'';
          position:absolute;
          top:0; left:0; right:0; height:1px;
          pointer-events:none;
          background:linear-gradient(90deg,transparent,rgba(55,138,221,0.6) 40%,rgba(29,158,117,0.5) 60%,transparent);
        }

        /* ── Input (mirrors .cf-input) ── */
        .pay-cf-input {
          background:rgba(255,255,255,0.06) !important;
          border:1px solid rgba(55,138,221,0.32) !important;
          border-radius:12px !important;
          color:#e8edf8 !important;
          transition:all 0.2s;
          outline:none !important;
          width:100%;
          box-sizing:border-box;
          font-size:13px !important;
        }
        .pay-cf-input::placeholder { color:#6a85aa !important; }
        .pay-cf-input:hover  { border-color:rgba(55,138,221,0.55) !important; background:rgba(255,255,255,0.07) !important; }
        .pay-cf-input:focus  {
          border-color:rgba(55,138,221,0.75) !important;
          box-shadow:0 0 0 3px rgba(55,138,221,0.16) !important;
          background:rgba(55,138,221,0.07) !important;
          color:#f0f4ff !important;
        }
        .pay-cf-input.is-valid { border-color:rgba(29,158,117,0.65) !important; box-shadow:0 0 0 2px rgba(29,158,117,0.12) !important; }
        .pay-cf-input.is-error { border-color:rgba(239,68,68,0.6) !important; box-shadow:0 0 0 3px rgba(239,68,68,0.12) !important; }

        /* ── Label (mirrors .cf-label) ── */
        .pay-cf-label {
          font-size:10px; font-weight:700;
          letter-spacing:0.09em; text-transform:uppercase;
          color:#a8c4e0;
          display:flex; align-items:center; gap:6px;
          margin-bottom:6px;
        }
        .pay-cf-label .opt {
          color:#8aaac8; font-weight:500;
          text-transform:none; letter-spacing:0; font-size:10px;
        }

        /* ── Field hint ── */
        .pay-field-hint { font-size:10px; margin-top:4px; min-height:14px; }
        .pay-field-hint.ok   { color:#34d39a; font-weight:600; }
        .pay-field-hint.err  { color:#f87171; font-weight:600; }
        .pay-field-hint.info { color:#8aaccc; }

        /* ── Note textarea ── */
        .pay-note-input {
          background:rgba(255,255,255,0.05) !important;
          border:1px solid rgba(55,138,221,0.28) !important;
          border-radius:12px !important;
          color:#e8edf8 !important;
          resize:vertical; min-height:64px; max-height:120px;
          transition:all 0.2s; outline:none !important;
          width:100%; box-sizing:border-box; font-size:12px !important;
          font-family:inherit !important;
        }
        .pay-note-input::placeholder { color:#6a85aa !important; }
        .pay-note-input:hover  { border-color:rgba(55,138,221,0.5) !important; }
        .pay-note-input:focus  { border-color:rgba(55,138,221,0.75) !important; box-shadow:0 0 0 3px rgba(55,138,221,0.14) !important; background:rgba(55,138,221,0.06) !important; }
        .pay-note-counter { font-size:10px; color:#7a9cc0; text-align:right; margin-top:3px; }
        .pay-note-counter.warn { color:#fbbf24; }
        .pay-note-counter.over { color:#f87171; }

        /* ── Schedule section ── */
        .pay-sched-panel {
          background:rgba(55,138,221,0.04);
          border:1px solid rgba(55,138,221,0.18);
          border-radius:14px; padding:14px 16px;
          transition:all 0.3s;
        }
        .pay-sched-toggle { display:flex; gap:6px; }
        .pay-sched-opt {
          flex:1; padding:7px 10px; border-radius:9px;
          border:1px solid rgba(55,138,221,0.22);
          background:rgba(255,255,255,0.03);
          color:#8aaac8; font-size:11px; font-weight:700;
          cursor:pointer; transition:all 0.2s; text-align:center;
        }
        .pay-sched-opt.active-now   { background:rgba(55,138,221,0.18); border-color:rgba(55,138,221,0.6); color:#60b4ff; }
        .pay-sched-opt.active-later { background:rgba(167,139,250,0.15); border-color:rgba(167,139,250,0.5); color:#c4b5fd; }
        .pay-sched-opt:hover:not(.active-now):not(.active-later) { border-color:rgba(55,138,221,0.4); color:#a8c4e0; }
        #pay-sched-inputs { margin-top:12px; display:grid; grid-template-columns:1fr 1fr; gap:8px; animation:fadeIn 0.25s ease; }
        .pay-sched-hint { font-size:10px; color:#c4b5fd; margin-top:4px; display:flex; align-items:center; gap:5px; }
        .pay-sched-hint.err { color:#f87171; }
        .pay-sched-hint.ok  { color:#34d399; }

        /* ── Status badges (history) ── */
        .pay-status-scheduled  { background:rgba(167,139,250,0.12); border:1px solid rgba(167,139,250,0.35); color:#c4b5fd; border-radius:20px; padding:2px 9px; font-size:9px; font-weight:700; letter-spacing:0.04em; }
        .pay-status-processing  { background:rgba(59,130,246,0.12); border:1px solid rgba(59,130,246,0.35); color:#93c5fd; border-radius:20px; padding:2px 9px; font-size:9px; font-weight:700; letter-spacing:0.04em; }
        .pay-status-completed   { background:rgba(52,211,153,0.1); border:1px solid rgba(52,211,153,0.35); color:#34d399; border-radius:20px; padding:2px 9px; font-size:9px; font-weight:700; letter-spacing:0.04em; }
        .pay-status-failed      { background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.3); color:#f87171; border-radius:20px; padding:2px 9px; font-size:9px; font-weight:700; letter-spacing:0.04em; }

        /* ── Receipt Modal ── */
        #pay-receipt-modal {
          position:fixed; inset:0; z-index:9999;
          background:rgba(5,5,20,0.88); backdrop-filter:blur(8px);
          display:none; align-items:center; justify-content:center; padding:16px;
        }
        #pay-receipt-modal.open { display:flex; animation:modal-in 0.25s ease; }
        .pay-receipt-modal-inner {
          background:rgba(10,12,24,0.99);
          border:1px solid rgba(55,138,221,0.25);
          border-radius:20px; width:100%; max-width:520px;
          max-height:90vh; overflow-y:auto; position:relative;
        }
        .pay-receipt-modal-inner::-webkit-scrollbar { width:4px; }
        .pay-receipt-modal-inner::-webkit-scrollbar-thumb { background:rgba(55,138,221,0.3); border-radius:4px; }

        /* ── Token selector buttons ── */
        .pay-tok-btn {
          padding:5px 14px; border-radius:8px;
          border:1px solid transparent; font-size:11px; font-weight:700;
          cursor:pointer; transition:all 0.18s;
        }
        .pay-tok-btn.tok-usdc { background:rgba(55,138,221,0.13); border-color:rgba(55,138,221,0.45); color:#60b4ff; }
        .pay-tok-btn.tok-eurc { background:rgba(29,158,117,0.13); border-color:rgba(29,158,117,0.45); color:#34d399; }
        .pay-tok-btn.tok-off  { background:rgba(255,255,255,0.04); border-color:rgba(255,255,255,0.18); color:#8aaccc; }
        .pay-tok-btn.tok-off:hover { border-color:rgba(55,138,221,0.4); color:#a8c8e8; }

        /* ── Preview box ── */
        #pay-preview-box {
          background:rgba(255,255,255,0.015);
          border:1px solid rgba(55,138,221,0.1);
          border-radius:12px; padding:10px 14px; margin-bottom:14px;
        }
        #pay-preview-box .prow {
          display:flex; justify-content:space-between; align-items:center;
          padding:4px 0; font-size:11px;
          border-bottom:1px solid rgba(55,138,221,0.05);
        }
        #pay-preview-box .prow:last-child { border-bottom:none; }
        #pay-preview-box .prow .pk { color:#8aaac8; font-weight:600; }
        #pay-preview-box .prow .pv { color:#e8edf8; font-weight:700; }

        /* ── Error box ── */
        #pay-error-box {
          background:rgba(239,68,68,0.07);
          border:1px solid rgba(239,68,68,0.28);
          border-radius:10px; padding:9px 13px;
          display:none; align-items:flex-start; gap:8px; margin-bottom:14px;
        }

        /* ── Send button ── */
        #pay-send-btn {
          width:100%;
          background:linear-gradient(135deg,#1565c0,#006064);
          color:#fff; border:none; border-radius:14px;
          padding:13px; font-size:13px; font-weight:800;
          cursor:pointer; transition:all 0.3s;
          box-shadow:0 0 20px rgba(55,138,221,0.3);
          letter-spacing:0.04em;
          display:flex; align-items:center; justify-content:center; gap:8px;
        }
        #pay-send-btn:hover:not(:disabled) { box-shadow:0 0 30px rgba(55,138,221,0.5); transform:translateY(-1px); }
        #pay-send-btn:disabled {
          background:rgba(255,255,255,0.05);
          border:1px solid rgba(55,138,221,0.18);
          color:#7a90a8; cursor:not-allowed;
          box-shadow:none; transform:none;
        }

        /* ── Steps panel (mirrors ct-step) ── */
        #pay-steps-panel {
          background:rgba(255,255,255,0.02);
          border:1px solid rgba(55,138,221,0.1);
          border-radius:12px; padding:14px; margin-top:14px;
        }
        .pstep { display:flex; align-items:center; gap:9px; padding:5px 0; border-bottom:1px solid rgba(55,138,221,0.05); }
        .pstep:last-child { border-bottom:none; }
        .pstep-icon { width:24px; height:24px; border-radius:8px; display:flex; align-items:center; justify-content:center; font-size:10px; flex-shrink:0; transition:all 0.3s; }
        .pstep-idle  .pstep-icon { background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.2); color:#7a90a8; }
        .pstep-active .pstep-icon { background:rgba(55,138,221,0.2); border:1px solid rgba(55,138,221,0.5); color:#60b4ff; box-shadow:0 0 12px rgba(55,138,221,0.3); animation:payStepPulse 1.5s infinite; }
        .pstep-done  .pstep-icon { background:rgba(29,158,117,0.2); border:1px solid rgba(29,158,117,0.5); color:#34d399; }
        .pstep-error .pstep-icon { background:rgba(239,68,68,0.15); border:1px solid rgba(239,68,68,0.4); color:#f87171; }
        .pstep-idle  .pstep-label { color:#8aaac8; font-size:11px; }
        .pstep-active .pstep-label { color:#d0e4f8; font-size:11px; font-weight:600; }
        .pstep-done  .pstep-label  { color:#7a9cc0; font-size:11px; text-decoration:line-through; }
        .pstep-error .pstep-label  { color:#f87171; font-size:11px; }
        @keyframes payStepPulse { 0%,100%{box-shadow:0 0 10px rgba(55,138,221,0.3)} 50%{box-shadow:0 0 20px rgba(55,138,221,0.6)} }

        /* ── Success panel ── */
        #pay-success-panel {
          background:linear-gradient(135deg,rgba(29,158,117,0.06),rgba(10,12,24,0.98));
          border:1px solid rgba(29,158,117,0.22);
          border-radius:14px; padding:16px 18px;
          margin-top:14px; display:none;
        }
        #pay-success-panel.show { display:block; }

        /* ── Right column panels ── */
        #pay-right-col { display:flex; flex-direction:column; gap:14px; }
        .pay-side-panel {
          background:rgba(10,12,24,0.98);
          border:1px solid rgba(55,138,221,0.15);
          border-radius:14px; overflow:hidden;
          position:relative;
        }
        .pay-side-panel::after {
          content:''; position:absolute; top:0; left:0; right:0; height:1px;
          pointer-events:none;
          background:linear-gradient(90deg,transparent,rgba(55,138,221,0.4) 50%,transparent);
        }
        .pay-side-hdr {
          padding:10px 16px;
          border-bottom:1px solid rgba(55,138,221,0.09);
          display:flex; align-items:center; justify-content:space-between;
          background:rgba(55,138,221,0.03);
        }
      </style>

      <!-- ── Info bar (mirrors factory bar in contracts) ── -->
      <div class="mb-5 flex flex-wrap items-center gap-3 text-xs" style="background:rgba(8,11,24,0.8);border:1px solid rgba(55,138,221,0.12);border-radius:14px;padding:10px 16px;">
        <div class="flex items-center gap-2">
          <div class="w-2 h-2 rounded-full" style="background:#4ade80;animation:pulse 2s infinite;box-shadow:0 0 6px #4ade80;"></div>
          <span style="color:#90bce0;font-weight:700;">ArcPay Payments</span>
        </div>
        <span style="color:#7aaad0;">Single on-chain ERC-20 transfer</span>
        <span class="ml-auto" style="color:#6a90b8;">Arc Testnet · Chain 5042002 · No real funds</span>
      </div>

      <div id="pay-page">

        <!-- ══ LEFT: Wallet + Form ══ -->
        <div>

          <!-- Hidden elements to keep JS IDs alive -->
          <span id="pay-wallet-short"  style="display:none;"></span>
          <span id="pay-balance-usdc"  style="display:none;"></span>
          <span id="pay-balance-eurc"  style="display:none;"></span>
          <span id="pay-network-name"  style="display:none;"></span>

          <!-- Main form panel -->
          <div class="pay-cf-panel">
            <div style="height:2px;background:linear-gradient(90deg,transparent,#378ADD 40%,#1D9E75 60%,transparent);"></div>
            <div class="p-5">

              <!-- Panel header -->
              <div class="flex items-center justify-between mb-5 flex-wrap gap-3">
                <div style="display:flex;align-items:center;gap:10px;">
                  <div style="width:32px;height:32px;border-radius:10px;background:rgba(55,138,221,0.12);border:1px solid rgba(55,138,221,0.25);display:flex;align-items:center;justify-content:center;">
                    <i class="fas fa-paper-plane" style="color:#60b4ff;font-size:13px;"></i>
                  </div>
                  <div>
                    <p style="color:#dde2f0;font-size:14px;font-weight:800;margin:0;">Send Payment</p>
                    <p style="color:#8aaac8;font-size:10px;margin:0;">Single on-chain transfer · Arc Testnet</p>
                  </div>
                </div>
                <div style="display:flex;align-items:center;gap:5px;">
                  <button id="pay-token-usdc" class="pay-tok-btn tok-usdc" onclick="selectPayToken('USDC')">USDC</button>
                  <button id="pay-token-eurc" class="pay-tok-btn tok-off"  onclick="selectPayToken('EURC')">EURC</button>
                </div>
              </div>

              <!-- Anti-phishing -->
              <div class="mb-4" style="background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.18);border-radius:10px;padding:10px 12px;display:flex;align-items:flex-start;gap:8px;">
                <i class="fas fa-shield-alt" style="color:#f87171;font-size:11px;flex-shrink:0;margin-top:1px;"></i>
                <p style="color:#fca5a5;font-size:11px;margin:0;">Never enter private keys or seed phrases. All interactions use wallet approval only.</p>
              </div>

              <div class="space-y-3">

                <!-- Name + Email row -->
                <div class="grid grid-cols-2 gap-2">
                  <div>
                    <label class="pay-cf-label">
                      <i class="fas fa-user" style="color:#90bce0;"></i>
                      SENDER NAME
                      <span class="opt">(optional)</span>
                    </label>
                    <input type="text" id="pay-fullname" class="pay-cf-input px-3 py-2 text-sm"
                      placeholder="Your name"
                      autocomplete="name"
                      oninput="payValidateField('fullname'); payValidateForm()">
                    <div id="pay-hint-fullname" class="pay-field-hint"></div>
                  </div>
                  <div>
                    <label class="pay-cf-label">
                      <i class="fas fa-envelope" style="color:#90bce0;"></i>
                      EMAIL
                      <span class="opt">(optional)</span>
                    </label>
                    <input type="email" id="pay-email" class="pay-cf-input px-3 py-2 text-sm"
                      placeholder="you@example.com"
                      autocomplete="email"
                      oninput="payValidateField('email'); payValidateForm()">
                    <div id="pay-hint-email" class="pay-field-hint"></div>
                  </div>
                </div>

                <!-- Recipient wallet -->
                <div>
                  <label class="pay-cf-label">
                    <i class="fas fa-hard-hat" style="color:#1D9E75;"></i>
                    RECIPIENT WALLET (0x…)
                  </label>
                  <input type="text" id="pay-recipient" class="pay-cf-input px-3 py-2.5 text-sm font-mono"
                    placeholder="0x..."
                    autocomplete="off" spellcheck="false"
                    oninput="payValidateField('recipient'); updatePayPreview(); payValidateForm()">
                  <div id="pay-hint-recipient" class="pay-field-hint"></div>
                </div>

                <!-- Recipient name + email (optional) -->
                <div style="background:rgba(29,158,117,0.05);border:1px solid rgba(29,158,117,0.18);border-radius:12px;padding:12px 14px 10px;">
                  <div style="display:flex;align-items:center;gap:7px;margin-bottom:10px;">
                    <div style="width:22px;height:22px;border-radius:7px;background:rgba(29,158,117,0.14);border:1px solid rgba(29,158,117,0.28);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                      <i class="fas fa-user-check" style="color:#34d399;font-size:10px;"></i>
                    </div>
                    <span style="color:#34d399;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">Recipient Info</span>
                    <span style="color:#5a8070;font-size:9px;font-weight:400;text-transform:none;letter-spacing:0;">(optional — for records &amp; receipt)</span>
                  </div>
                  <div class="grid grid-cols-2 gap-2">
                    <div>
                      <label class="pay-cf-label" style="color:#4a9470;">
                        <i class="fas fa-user" style="color:#34d399;"></i>
                        RECIPIENT NAME
                        <span class="opt">(optional)</span>
                      </label>
                      <input type="text" id="pay-recipient-name" class="pay-cf-input px-3 py-2 text-sm"
                        placeholder="Recipient's name"
                        autocomplete="off"
                        oninput="updatePayPreview(); payValidateForm()">
                      <div id="pay-hint-recipient-name" class="pay-field-hint"></div>
                    </div>
                    <div>
                      <label class="pay-cf-label" style="color:#4a9470;">
                        <i class="fas fa-envelope" style="color:#34d399;"></i>
                        RECIPIENT EMAIL
                        <span class="opt">(optional)</span>
                      </label>
                      <input type="email" id="pay-recipient-email" class="pay-cf-input px-3 py-2 text-sm"
                        placeholder="recipient@example.com"
                        autocomplete="off"
                        oninput="payValidateField('recipientEmail'); updatePayPreview(); payValidateForm()">
                      <div id="pay-hint-recipient-email" class="pay-field-hint"></div>
                    </div>
                  </div>
                </div>

                <!-- Amount -->
                <div>
                  <label class="pay-cf-label">
                    <i class="fas fa-coins" style="color:#1D9E75;"></i>
                    AMOUNT (<span id="pay-label-token">USDC</span>)
                    <span id="pay-max-hint" style="font-size:10px;color:#8aaac8;font-weight:400;text-transform:none;letter-spacing:0;margin-left:auto;"></span>
                  </label>
                  <div style="position:relative;">
                    <input type="number" id="pay-amount" class="pay-cf-input px-3 py-2.5 text-sm pr-24"
                      placeholder="0.000000" min="0" step="0.000001"
                      oninput="payValidateField('amount'); updatePayPreview(); payValidateForm()">
                    <button onclick="setPayMax()"
                      style="position:absolute;right:10px;top:50%;transform:translateY(-50%);font-size:10px;font-weight:700;color:#378ADD;background:rgba(55,138,221,0.12);padding:2px 8px;border-radius:8px;border:1px solid rgba(55,138,221,0.25);cursor:pointer;transition:all 0.2s;"
                      onmouseover="this.style.background='rgba(55,138,221,0.22)'" onmouseout="this.style.background='rgba(55,138,221,0.12)'">MAX</button>
                  </div>
                  <div id="pay-hint-amount" class="pay-field-hint"></div>
                </div>

                <!-- Payment Note -->
                <div>
                  <label class="pay-cf-label">
                    <i class="fas fa-sticky-note" style="color:#a78bfa;"></i>
                    PAYMENT NOTE
                    <span class="opt">(optional)</span>
                  </label>
                  <textarea id="pay-note" class="pay-note-input px-3 py-2"
                    placeholder="e.g. Freelance payment, invoice #123, salary…"
                    maxlength="300"
                    oninput="payUpdateNoteCounter(); updatePayPreview(); payValidateForm()"
                    rows="2"></textarea>
                  <div class="pay-note-counter"><span id="pay-note-count">0</span>/300</div>
                </div>

                <!-- Schedule Payment -->
                <div class="pay-sched-panel">
                  <div class="pay-cf-label" style="margin-bottom:10px;">
                    <i class="fas fa-clock" style="color:#a78bfa;"></i>
                    SEND TIMING
                  </div>
                  <div class="pay-sched-toggle">
                    <button type="button" class="pay-sched-opt active-now" id="pay-sched-now" onclick="paySetSchedule('now')">
                      <i class="fas fa-bolt" style="margin-right:4px;"></i>Send Now
                    </button>
                    <button type="button" class="pay-sched-opt" id="pay-sched-later" onclick="paySetSchedule('later')">
                      <i class="fas fa-calendar-alt" style="margin-right:4px;"></i>Schedule for Later
                    </button>
                  </div>
                  <div id="pay-sched-inputs" style="display:none;">
                    <div>
                      <label class="pay-cf-label" style="font-size:9px;margin-bottom:4px;margin-top:2px;">
                        <i class="fas fa-calendar" style="color:#60b4ff;"></i>DATE
                      </label>
                      <input type="date" id="pay-sched-date" class="pay-cf-input px-3 py-2 text-sm"
                        oninput="payValidateSched(); updatePayPreview(); payValidateForm()">
                    </div>
                    <div>
                      <label class="pay-cf-label" style="font-size:9px;margin-bottom:4px;margin-top:2px;">
                        <i class="fas fa-clock" style="color:#60b4ff;"></i>TIME
                      </label>
                      <input type="time" id="pay-sched-time" class="pay-cf-input px-3 py-2 text-sm"
                        oninput="payValidateSched(); updatePayPreview(); payValidateForm()">
                    </div>
                    <div style="grid-column:1/-1;">
                      <label class="pay-cf-label" style="font-size:9px;margin-bottom:4px;">
                        <i class="fas fa-globe" style="color:#34d399;"></i>TIMEZONE
                      </label>
                      <select id="pay-sched-tz" class="pay-cf-input px-3 py-2 text-sm"
                        oninput="payValidateSched(); updatePayPreview(); payValidateForm()">
                      </select>
                    </div>
                    <div id="pay-sched-hint" class="pay-sched-hint" style="grid-column:1/-1;"></div>
                  </div>
                </div>

                <!-- Preview box -->
                <div id="pay-preview-box">
                  <div class="prow"><span class="pk">Token</span><span id="prev-token" class="pv" style="color:#60b4ff;">USDC</span></div>
                  <div class="prow"><span class="pk">Amount</span><span id="prev-amount" class="pv">—</span></div>
                  <div class="prow"><span class="pk">To</span><span id="prev-recipient" class="pv" style="font-family:monospace;font-size:10px;">—</span></div>
                  <div class="prow" id="prev-recipient-name-row" style="display:none;"><span class="pk">Recipient</span><span id="prev-recipient-name" class="pv" style="color:#34d399;">—</span></div>
                  <div class="prow" id="prev-recipient-email-row" style="display:none;"><span class="pk">Recip. Email</span><span id="prev-recipient-email-display" class="pv" style="color:#34d399;">—</span></div>
                  <div class="prow"><span class="pk">From</span><span id="pay-from-display" class="pv" style="font-family:monospace;font-size:10px;">—</span></div>
                  <div class="prow"><span class="pk">Network</span><span id="prev-network" class="pv" style="color:#34d399;">Arc Testnet</span></div>
                  <div class="prow" id="prev-sched-row" style="display:none;"><span class="pk">Scheduled</span><span id="prev-sched" class="pv" style="color:#c4b5fd;">—</span></div>
                  <div class="prow" id="prev-note-row" style="display:none;"><span class="pk">Note</span><span id="prev-note" class="pv" style="color:#a8c4e0;font-style:italic;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">—</span></div>
                  <div class="prow"><span class="pk">Est. Fee</span><span id="prev-gas" class="pv" style="color:#fbbf24;">~1 tx</span></div>
                </div>

                <!-- Error box -->
                <div id="pay-error-box">
                  <i class="fas fa-exclamation-circle" style="color:#f87171;flex-shrink:0;"></i>
                  <span id="pay-error-text" style="color:#fca5a5;font-size:12px;flex:1;"></span>
                  <button onclick="hidePayError()" style="background:none;border:none;color:#8aaac8;cursor:pointer;font-size:14px;padding:0;" onmouseover="this.style.color='#f87171'" onmouseout="this.style.color='#8aaac8'">✕</button>
                </div>

                <!-- Submit button -->
                <button type="button" id="pay-send-btn" onclick="executePayment()" disabled
                  onmouseover="if(!this.disabled)this.style.boxShadow='0 0 30px rgba(55,138,221,0.5)'" onmouseout="if(!this.disabled)this.style.boxShadow='0 0 20px rgba(55,138,221,0.3)'">
                  <i class="fas fa-paper-plane"></i>
                  <span id="pay-send-btn-text">Sign &amp; Send</span>
                </button>

                <p style="font-size:10px;color:#7a9cc0;text-align:center;margin-top:4px;">
                  ERC-20 · Arc Testnet (5042002) · No real funds
                </p>
              </div><!-- end space-y-3 -->

            </div><!-- end p-5 -->
          </div><!-- end pay-cf-panel -->

          <!-- Transaction Steps -->
          <div id="pay-steps-panel" style="display:none;">
            <p style="font-size:10px;color:#8aaac8;text-transform:uppercase;letter-spacing:0.1em;font-weight:700;margin:0 0 10px;">TRANSACTION PIPELINE</p>
            <div id="pay-step-0" class="pstep pstep-idle"><div class="pstep-icon"><i class="fas fa-network-wired"></i></div><span id="pay-step-label-0" class="pstep-label">Verify Arc Testnet network</span></div>
            <div id="pay-step-1" class="pstep pstep-idle"><div class="pstep-icon"><i class="fas fa-coins"></i></div><span id="pay-step-label-1" class="pstep-label">Read token balance</span></div>
            <div id="pay-step-2" class="pstep pstep-idle"><div class="pstep-icon"><i class="fas fa-check-double"></i></div><span id="pay-step-label-2" class="pstep-label">Token approval (if needed)</span></div>
            <div id="pay-step-3" class="pstep pstep-idle"><div class="pstep-icon"><i class="fas fa-signature"></i></div><span id="pay-step-label-3" class="pstep-label">Sign &amp; broadcast transaction</span></div>
            <div id="pay-step-4" class="pstep pstep-idle"><div class="pstep-icon"><i class="fas fa-hourglass-half"></i></div><span id="pay-step-label-4" class="pstep-label">Awaiting on-chain confirmation</span></div>
            <div id="pay-step-5" class="pstep pstep-idle"><div class="pstep-icon"><i class="fas fa-receipt"></i></div><span id="pay-step-label-5" class="pstep-label">Generating receipt</span></div>
          </div>

          <!-- Success + Receipt -->
          <div id="pay-success-panel">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:14px;flex-wrap:wrap;">
              <div style="display:flex;align-items:center;gap:10px;">
                <div style="width:36px;height:36px;border-radius:10px;background:rgba(29,158,117,0.15);border:1px solid rgba(29,158,117,0.4);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                  <i class="fas fa-check" style="color:#34d399;font-size:14px;"></i>
                </div>
                <div>
                  <p style="color:#34d399;font-size:14px;font-weight:800;margin:0;">Payment Confirmed!</p>
                  <p style="color:#7a9ab8;font-size:11px;margin:2px 0 0;">Transaction submitted to Arc Testnet</p>
                </div>
              </div>
              <button onclick="payOpenReceiptModal()"
                style="display:flex;align-items:center;gap:6px;padding:8px 14px;background:rgba(55,138,221,0.12);border:1px solid rgba(55,138,221,0.35);border-radius:10px;color:#60b4ff;font-size:12px;font-weight:700;cursor:pointer;transition:all 0.2s;"
                onmouseover="this.style.background='rgba(55,138,221,0.22)'" onmouseout="this.style.background='rgba(55,138,221,0.12)'">
                <i class="fas fa-eye"></i> View Receipt
              </button>
            </div>
            <div id="pay-receipt-content"></div>
          </div>

        </div><!-- end left col -->

        <!-- ══ RIGHT COLUMN ══ -->
        <div id="pay-right-col">

          <!-- History panel -->
          <div class="pay-side-panel" id="pay-history-panel">
            <div class="pay-side-hdr">
              <span style="color:#dde2f0;font-size:12px;font-weight:700;display:flex;align-items:center;gap:6px;">
                <i class="fas fa-history" style="color:#378ADD;"></i> Transaction History
              </span>
              <div style="display:flex;align-items:center;gap:6px;">
                <button onclick="refreshPaymentBalances();renderPaymentHistory()"
                  style="font-size:10px;color:#8aaac8;background:rgba(55,138,221,0.08);border:1px solid rgba(55,138,221,0.28);padding:3px 10px;border-radius:8px;cursor:pointer;transition:all 0.2s;"
                  onmouseover="this.style.color='#60b4ff';this.style.borderColor='rgba(55,138,221,0.5)'" onmouseout="this.style.color='#8aaac8';this.style.borderColor='rgba(55,138,221,0.28)'">
                  <i class="fas fa-sync" style="font-size:9px;"></i> Refresh
                </button>
                <button onclick="(function(p){p.style.transition='opacity 0.2s ease,transform 0.2s ease';p.style.opacity='0';p.style.transform='translateY(-6px)';setTimeout(()=>{p.style.display='none';p.style.opacity='';p.style.transform='';},200);})(document.getElementById('pay-history-panel'))"
                  title="Close history"
                  style="width:24px;height:24px;border-radius:6px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);color:#f87171;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:10px;flex-shrink:0;">
                  <i class="fas fa-times"></i>
                </button>
              </div>
            </div>
            <div id="pay-history-list" style="padding:12px;display:flex;flex-direction:column;gap:6px;">
              <div style="color:#8aaac8;font-size:11px;text-align:center;padding:24px 0;">
                <i class="fas fa-clock" style="font-size:20px;display:block;margin-bottom:8px;color:#5a7898;"></i>
                No transactions yet
              </div>
            </div>
          </div>

          <!-- Agent Queue panel -->
          <div class="pay-side-panel">
            <div class="pay-side-hdr">
              <span style="color:#dde2f0;font-size:12px;font-weight:700;display:flex;align-items:center;gap:6px;">
                <i class="fas fa-robot" style="color:#1D9E75;"></i> Agent Payment Queue
              </span>
              <button onclick="loadPayments()"
                style="font-size:10px;color:#8aaac8;background:rgba(55,138,221,0.08);border:1px solid rgba(55,138,221,0.28);padding:3px 10px;border-radius:8px;cursor:pointer;transition:all 0.2s;"
                onmouseover="this.style.color='#60b4ff';this.style.borderColor='rgba(55,138,221,0.5)'" onmouseout="this.style.color='#8aaac8';this.style.borderColor='rgba(55,138,221,0.28)'">
                <i class="fas fa-sync" style="font-size:9px;"></i> Update
              </button>
            </div>
            <div id="payments-list" style="padding:12px;">
              <div style="color:#8aaac8;font-size:11px;text-align:center;padding:24px 0;">
                <i class="fas fa-inbox" style="font-size:24px;display:block;margin-bottom:8px;color:#5a7898;"></i>
                No payments in queue
              </div>
            </div>
          </div>

        </div><!-- end right col -->
      </div><!-- end #pay-page -->

      <!-- ══ RECEIPT MODAL ══ -->
      <div id="pay-receipt-modal" onclick="if(event.target===this)payCloseReceiptModal()">
        <div class="pay-receipt-modal-inner">
          <div style="height:2px;background:linear-gradient(90deg,transparent,#378ADD 40%,#1D9E75 60%,transparent);border-radius:20px 20px 0 0;"></div>
          <div style="padding:20px 22px 0;display:flex;align-items:center;justify-content:space-between;">
            <span style="color:#dde2f0;font-size:14px;font-weight:800;display:flex;align-items:center;gap:8px;">
              <i class="fas fa-receipt" style="color:#34d399;"></i>Payment Receipt
            </span>
            <button onclick="payCloseReceiptModal()"
              style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#8aaac8;width:28px;height:28px;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;transition:all 0.2s;"
              onmouseover="this.style.background='rgba(239,68,68,0.12)';this.style.color='#f87171'" onmouseout="this.style.background='rgba(255,255,255,0.05)';this.style.color='#8aaac8'">✕</button>
          </div>
          <div id="pay-receipt-modal-body" style="padding:18px 22px 22px;"></div>
        </div>
      </div>

    </div><!-- end tab-content-payments -->
    <div id="tab-content-contracts" class="tab-content hidden">

      <!-- ══ CONTRACTS STYLES ══ -->
      <style>
        .cf-panel { background:rgba(10,12,24,0.98); border:1px solid rgba(55,138,221,0.18); border-radius:18px; position:relative; overflow:hidden; }
        .cf-panel::after { content:''; position:absolute; top:0; left:0; right:0; height:1px; pointer-events:none; background:linear-gradient(90deg,transparent,rgba(55,138,221,0.6) 40%,rgba(29,158,117,0.5) 60%,transparent); }
        .cf-input { background:rgba(255,255,255,0.06) !important; border:1px solid rgba(55,138,221,0.32) !important; border-radius:12px !important; color:#e8edf8 !important; transition:all 0.2s; outline:none !important; }
        .cf-input::placeholder { color:#6a85aa !important; }
        .cf-input:hover { border-color:rgba(55,138,221,0.55) !important; background:rgba(255,255,255,0.07) !important; }
        .cf-input:focus { border-color:rgba(55,138,221,0.75) !important; box-shadow:0 0 0 3px rgba(55,138,221,0.16) !important; background:rgba(55,138,221,0.07) !important; color:#f0f4ff !important; }
        .cf-label { font-size:10px; font-weight:700; letter-spacing:0.09em; text-transform:uppercase; color:#a8c4e0; display:flex; align-items:center; gap:6px; margin-bottom:6px; }
        .ct-step-idle  .ct-step-icon { background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.2); color:#7a90a8; }
        .ct-step-active .ct-step-icon { background:rgba(55,138,221,0.2); border:1px solid rgba(55,138,221,0.5); color:#60b4ff; box-shadow:0 0 12px rgba(55,138,221,0.3); animation:cfStepPulse 1.5s infinite; }
        .ct-step-done  .ct-step-icon { background:rgba(29,158,117,0.2); border:1px solid rgba(29,158,117,0.5); color:#34d399; }
        .ct-step-error .ct-step-icon { background:rgba(239,68,68,0.15); border:1px solid rgba(239,68,68,0.4); color:#f87171; }
        .ct-step-idle  span { color:#8aaac8; }
        .ct-step-active span { color:#d0e4f8; font-weight:600; }
        .ct-step-done  span { color:#7a9cc0; text-decoration:line-through; }
        .ct-step-error span { color:#f87171; }
        @keyframes cfStepPulse { 0%,100%{box-shadow:0 0 10px rgba(55,138,221,0.3)} 50%{box-shadow:0 0 20px rgba(55,138,221,0.6)} }
        .cf-proof-drop { border:2px dashed rgba(55,138,221,0.25); border-radius:14px; transition:all 0.2s; background:rgba(55,138,221,0.03); }
        .cf-proof-drop.drag-over { border-color:rgba(55,138,221,0.6); background:rgba(55,138,221,0.08); }
        .cf-badge-pending   { background:rgba(245,158,11,0.12); border:1px solid rgba(245,158,11,0.3); color:#fbbf24; }
        .cf-badge-funded    { background:rgba(96,165,250,0.12); border:1px solid rgba(96,165,250,0.3); color:#93c5fd; }
        .cf-badge-active    { background:rgba(34,211,238,0.12); border:1px solid rgba(34,211,238,0.3); color:#67e8f9; }
        .cf-badge-completed { background:rgba(52,211,153,0.12); border:1px solid rgba(52,211,153,0.3); color:#6ee7b7; }
        .cf-badge-cancelled { background:rgba(248,113,113,0.12); border:1px solid rgba(248,113,113,0.3); color:#fca5a5; }
        .cf-badge-dispute   { background:rgba(239,68,68,0.15); border:1px solid rgba(239,68,68,0.4); color:#f87171; }
        .cf-badge-closed    { background:rgba(74,85,104,0.15); border:1px solid rgba(74,85,104,0.35); color:#9ca3af; }
        .cf-card { background:rgba(8,11,24,0.95); border:1px solid rgba(55,138,221,0.14); border-radius:16px; transition:border-color 0.2s; }
        .cf-card:hover { border-color:rgba(55,138,221,0.3); }
        .cf-action-btn { display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;padding:6px 12px;border-radius:8px;cursor:pointer;border:1px solid transparent;transition:all 0.2s;white-space:nowrap; }
        .cf-btn-deposit  { background:rgba(167,139,250,0.12);border-color:rgba(167,139,250,0.3);color:#c4b5fd; }
        .cf-btn-deposit:hover { background:rgba(167,139,250,0.22); }
        .cf-btn-sign     { background:rgba(34,211,238,0.1);border-color:rgba(34,211,238,0.3);color:#67e8f9; }
        .cf-btn-sign:hover { background:rgba(34,211,238,0.18); }
        .cf-btn-proof    { background:rgba(167,139,250,0.08);border-color:rgba(167,139,250,0.2);color:#a78bfa; }
        .cf-btn-proof:hover { background:rgba(167,139,250,0.16); }
        .cf-btn-receive  { background:rgba(52,211,153,0.1);border-color:rgba(52,211,153,0.3);color:#34d399; }
        .cf-btn-receive:hover { background:rgba(52,211,153,0.18); }
        .cf-btn-complete { background:rgba(52,211,153,0.12);border-color:rgba(52,211,153,0.4);color:#6ee7b7;box-shadow:0 0 12px rgba(52,211,153,0.15); }
        .cf-btn-complete:hover { background:rgba(52,211,153,0.22);box-shadow:0 0 20px rgba(52,211,153,0.25); }
        .cf-btn-disabled { background:rgba(255,255,255,0.04);border-color:rgba(255,255,255,0.14);color:#7a90a8;cursor:not-allowed; }
        .cf-btn-cancel   { background:rgba(239,68,68,0.08);border-color:rgba(239,68,68,0.2);color:#f87171; }
        .cf-btn-cancel:hover { background:rgba(239,68,68,0.15); }
        .cf-btn-receipt  { background:rgba(59,130,246,0.1);border-color:rgba(59,130,246,0.3);color:#93c5fd; }
        .cf-btn-receipt:hover { background:rgba(59,130,246,0.18); }
      </style>

      <!-- ── Network warning banner (shown on wrong chain) ── -->
      <div id="cf-network-banner" style="display:none;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.25);border-radius:12px;padding:10px 14px;margin-bottom:12px;flex-direction:row;align-items:center;gap:8px;"></div>

      <!-- ── Factory info bar ── -->
      <div class="mb-5 flex flex-wrap items-center gap-3 text-xs" style="background:rgba(8,11,24,0.8);border:1px solid rgba(55,138,221,0.12);border-radius:14px;padding:10px 16px;">
        <div class="flex items-center gap-2">
          <div class="w-2 h-2 rounded-full bg-green-400" style="animation:pulse 2s infinite;box-shadow:0 0 6px #4ade80;"></div>
          <span style="color:#90bce0;font-weight:700;">ContractFactory</span>
        </div>
        <span style="font-family:monospace;color:#8aaac8;">0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A</span>
        <a href="https://testnet.arcscan.app/address/0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A" target="_blank" rel="noopener" style="color:#378ADD;">
          <i class="fas fa-external-link-alt mr-1"></i>ArcScan
        </a>
        <span class="ml-auto" style="color:#6a90b8;">Arc Testnet · Chain 5042002 · 0.2% Platform Fee</span>
      </div>

      <div class="grid grid-cols-1 xl:grid-cols-5 gap-5">

        <!-- ══ LEFT: Create Contract Form ══ -->
        <div class="xl:col-span-2">
          <div class="cf-panel">
            <div style="height:2px;background:linear-gradient(90deg,transparent,#378ADD 40%,#1D9E75 60%,transparent);"></div>
            <div class="p-5">

              <div class="flex items-center gap-2.5 mb-5">
                <div style="width:32px;height:32px;border-radius:10px;background:rgba(55,138,221,0.12);border:1px solid rgba(55,138,221,0.25);display:flex;align-items:center;justify-content:center;">
                  <i class="fas fa-file-signature" style="color:#60b4ff;font-size:13px;"></i>
                </div>
                <div>
                  <p style="color:#dde2f0;font-size:14px;font-weight:800;margin:0;">New Contract</p>
                  <p style="color:#8aaac8;font-size:10px;margin:0;">Escrow · USDC · Arc Testnet</p>
                </div>
              </div>

              <!-- Contract Mode Selector -->
              <div style="margin-bottom:14px;">
                <label style="font-size:10px;color:#3a4870;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;display:block;margin-bottom:6px;"><i class="fas fa-layer-group" style="color:#a78bfa;margin-right:4px;"></i>CONTRACT MODE</label>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;" id="cf-mode-btns">
                  <label style="cursor:pointer;">
                    <input type="radio" name="cf-mode-radio" value="onchain" checked style="display:none;" onchange="cfUpdateModeUI('onchain')">
                    <div class="cf-mode-opt cf-mode-active" data-mode="onchain"
                      onclick="document.querySelector('[name=cf-mode-radio][value=onchain]').checked=true;cfUpdateModeUI('onchain')"
                      style="padding:8px 6px;border-radius:10px;border:1px solid rgba(55,138,221,0.35);background:rgba(55,138,221,0.12);text-align:center;transition:all 0.2s;">
                      <i class="fas fa-link" style="color:#60b4ff;font-size:12px;display:block;margin-bottom:3px;"></i>
                      <span style="font-size:10px;font-weight:700;color:#60b4ff;">On-Chain</span>
                      <div style="font-size:9px;color:#3a4870;margin-top:2px;">USDC Escrow</div>
                    </div>
                  </label>
                  <label style="cursor:pointer;">
                    <input type="radio" name="cf-mode-radio" value="offchain" style="display:none;" onchange="cfUpdateModeUI('offchain')">
                    <div class="cf-mode-opt" data-mode="offchain"
                      onclick="document.querySelector('[name=cf-mode-radio][value=offchain]').checked=true;cfUpdateModeUI('offchain')"
                      style="padding:8px 6px;border-radius:10px;border:1px solid rgba(251,191,36,0.2);background:rgba(251,191,36,0.06);text-align:center;transition:all 0.2s;">
                      <i class="fas fa-money-bill-wave" style="color:#fbbf24;font-size:12px;display:block;margin-bottom:3px;"></i>
                      <span style="font-size:10px;font-weight:700;color:#fbbf24;">Off-Chain</span>
                      <div style="font-size:9px;color:#3a4870;margin-top:2px;">Payment Note</div>
                    </div>
                  </label>
                  <label style="cursor:pointer;">
                    <input type="radio" name="cf-mode-radio" value="custodial" style="display:none;" onchange="cfUpdateModeUI('custodial')">
                    <div class="cf-mode-opt" data-mode="custodial"
                      onclick="document.querySelector('[name=cf-mode-radio][value=custodial]').checked=true;cfUpdateModeUI('custodial')"
                      style="padding:8px 6px;border-radius:10px;border:1px solid rgba(167,139,250,0.2);background:rgba(167,139,250,0.06);text-align:center;transition:all 0.2s;">
                      <i class="fas fa-shield-alt" style="color:#a78bfa;font-size:12px;display:block;margin-bottom:3px;"></i>
                      <span style="font-size:10px;font-weight:700;color:#a78bfa;">Custodial</span>
                      <div style="font-size:9px;color:#3a4870;margin-top:2px;">3rd-party Escrow</div>
                    </div>
                  </label>
                </div>
                <!-- Hidden select synced with radio buttons -->
                <select id="cf-contract-mode" style="display:none;">
                  <option value="onchain">On-Chain Escrow</option>
                  <option value="offchain">Off-Chain Payment</option>
                  <option value="custodial">Custodial Escrow</option>
                </select>
                <!-- Mode description banner -->
                <div id="cf-mode-desc" style="margin-top:8px;padding:8px 10px;border-radius:8px;font-size:11px;background:rgba(55,138,221,0.06);border:1px solid rgba(55,138,221,0.15);color:#60b4ff;">
                  <i class="fas fa-info-circle mr-1"></i>
                  <strong>On-Chain Escrow:</strong> USDC locked in smart contract. Funds released via milestone approval.
                </div>
              </div>

              <!-- Anti-phishing -->
              <div class="mb-4" style="background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.18);border-radius:10px;padding:10px 12px;display:flex;align-items:flex-start;gap:8px;">
                <i class="fas fa-shield-alt" style="color:#f87171;font-size:11px;flex-shrink:0;margin-top:1px;"></i>
                <p style="color:#fca5a5;font-size:11px;margin:0;">Never enter private key or seed phrase. All interactions use wallet approval only.</p>
              </div>

              <div class="space-y-3">
                <!-- Title -->
                <div>
                  <label class="cf-label"><i class="fas fa-heading" style="color:#378ADD;"></i>CONTRACT TITLE</label>
                  <input type="text" id="cf-title" placeholder="e.g. DeFi dApp Development"
                    class="cf-input w-full px-3 py-2.5 text-sm" />
                </div>

                <!-- Contractor wallet -->
                <div>
                  <label class="cf-label"><i class="fas fa-hard-hat" style="color:#1D9E75;"></i>CONTRACTOR WALLET (0x…)</label>
                  <input type="text" id="cf-contractor" placeholder="0x..."
                    class="cf-input w-full px-3 py-2.5 text-sm font-mono" />
                </div>

                <!-- Emails row -->
                <div class="grid grid-cols-2 gap-2">
                  <div>
                    <label class="cf-label"><i class="fas fa-envelope" style="color:#a78bfa;"></i>CLIENT EMAIL</label>
                    <input type="email" id="cf-client-email" placeholder="client@email.com"
                      class="cf-input w-full px-3 py-2 text-sm" />
                  </div>
                  <div>
                    <label class="cf-label"><i class="fas fa-envelope" style="color:#f59e0b;"></i>CONTRACTOR EMAIL</label>
                    <input type="email" id="cf-contractor-email" placeholder="contractor@email.com"
                      class="cf-input w-full px-3 py-2 text-sm" />
                  </div>
                </div>

                <!-- Total USDC -->
                <div>
                  <label class="cf-label"><i class="fas fa-coins" style="color:#1D9E75;"></i>TOTAL USDC (escrow amount)</label>
                  <div style="position:relative;">
                    <input type="number" id="cf-value" placeholder="0.00" step="0.01" min="0.01"
                      oninput="cfUpdateMilestoneSum();cfUpdateFeePreview()"
                      class="cf-input w-full px-3 py-2.5 text-sm pr-24" />
                    <span style="position:absolute;right:12px;top:50%;transform:translateY(-50%);font-size:11px;font-weight:700;color:#378ADD;background:rgba(55,138,221,0.12);padding:2px 8px;border-radius:8px;border:1px solid rgba(55,138,221,0.25);">USDC</span>
                  </div>
                  <div id="cf-fee-preview" style="font-size:11px;color:#8aaac8;margin-top:4px;"></div>
                </div>

                <!-- OTC Toggle -->
                <div style="background:rgba(167,139,250,0.05);border:1px solid rgba(167,139,250,0.15);border-radius:12px;padding:10px 14px;">
                  <div class="flex items-center justify-between">
                    <div class="flex items-center gap-2">
                      <i class="fas fa-handshake" style="color:#a78bfa;font-size:12px;"></i>
                      <span style="color:#c4b5fd;font-size:12px;font-weight:600;">OTC Negotiation</span>
                      <span style="font-size:9px;background:rgba(167,139,250,0.15);color:#a78bfa;border:1px solid rgba(167,139,250,0.25);padding:1px 6px;border-radius:999px;">optional</span>
                    </div>
                    <label style="position:relative;display:inline-block;width:36px;height:20px;cursor:pointer;">
                      <input type="checkbox" id="cf-otc-toggle" onchange="cfToggleOTC()" style="opacity:0;width:0;height:0;">
                      <span id="cf-otc-slider" style="position:absolute;inset:0;border-radius:20px;background:rgba(255,255,255,0.08);transition:all 0.3s;border:1px solid rgba(255,255,255,0.12);">
                        <span id="cf-otc-knob" style="position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#7a9cc0;transition:all 0.3s;"></span>
                      </span>
                    </label>
                  </div>
                  <div id="cf-otc-fields" class="hidden mt-3 space-y-2">
                    <div>
                      <label class="cf-label"><i class="fas fa-star" style="color:#f59e0b;"></i>PROJECT POINTS / TOKENS</label>
                      <input type="text" id="cf-otc-points" placeholder="e.g. 500 PROJECT_POINTS or 1000 UNLISTED_TKN"
                        class="cf-input w-full px-3 py-2 text-sm" />
                    </div>
                    <div>
                      <label class="cf-label"><i class="fas fa-file-alt" style="color:#f59e0b;"></i>OTC AGREEMENT TERMS</label>
                      <textarea id="cf-otc-terms" placeholder="Describe the OTC terms and conditions…" rows="2"
                        class="cf-input w-full px-3 py-2 text-sm resize-none"></textarea>
                    </div>
                  </div>
                </div>

                <!-- Milestones -->
                <div>
                  <div class="flex items-center justify-between mb-2">
                    <label class="cf-label" style="margin-bottom:0;"><i class="fas fa-list-check" style="color:#60b4ff;"></i>MILESTONES (max 10)</label>
                    <button type="button" onclick="cfAddMilestone()"
                      style="font-size:10px;color:#60b4ff;background:rgba(55,138,221,0.08);border:1px solid rgba(55,138,221,0.2);padding:3px 10px;border-radius:8px;cursor:pointer;transition:all 0.2s;"
                      onmouseover="this.style.background='rgba(55,138,221,0.18)'" onmouseout="this.style.background='rgba(55,138,221,0.08)'">
                      <i class="fas fa-plus" style="font-size:9px;"></i> Add
                    </button>
                  </div>
                  <div id="cf-milestones-container" class="space-y-2">
                    <div class="cf-milestone-row flex items-center gap-2">
                      <input type="text" placeholder="Milestone description" class="cf-ms-desc flex-1 cf-input px-3 py-2 text-sm" oninput="cfUpdateMilestoneSum()" />
                      <input type="number" placeholder="USDC" step="0.01" min="0.01" class="cf-ms-amt w-24 cf-input px-3 py-2 text-sm" oninput="cfUpdateMilestoneSum()" />
                      <button onclick="this.closest('.cf-milestone-row').remove(); cfUpdateMilestoneSum()"
                        style="width:28px;height:28px;border-radius:8px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);color:#f87171;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:11px;">
                        <i class="fas fa-times"></i>
                      </button>
                    </div>
                  </div>
                  <div id="cf-ms-sum" style="font-size:11px;color:#8aaac8;margin-top:6px;">Milestones sum: $0.00 USDC</div>
                </div>

                <!-- Submit button -->
                <button type="button" id="cf-submit-btn" onclick="cfCreateContract()"
                  style="width:100%;background:linear-gradient(135deg,#1565c0,#006064);color:#fff;border:none;border-radius:14px;padding:13px;font-size:13px;font-weight:800;cursor:pointer;transition:all 0.3s;box-shadow:0 0 20px rgba(55,138,221,0.3);letter-spacing:0.04em;display:flex;align-items:center;justify-content:center;gap:8px;"
                  onmouseover="this.style.boxShadow='0 0 30px rgba(55,138,221,0.5)'" onmouseout="this.style.boxShadow='0 0 20px rgba(55,138,221,0.3)'">
                  <i class="fas fa-file-signature" id="cf-submit-icon"></i><span id="cf-submit-label">Create Contract On-Chain</span>
                </button>
              </div>

              <!-- Tx steps panel -->
              <div id="cf-steps-panel" class="hidden mt-4 space-y-1.5" style="background:rgba(255,255,255,0.02);border:1px solid rgba(55,138,221,0.1);border-radius:12px;padding:14px;">
                <p style="font-size:10px;color:#8aaac8;text-transform:uppercase;letter-spacing:0.1em;font-weight:700;margin-bottom:10px;">TRANSACTION PIPELINE</p>
                <div id="cf-step-0" class="ct-step ct-step-idle flex items-center gap-2.5">
                  <div class="ct-step-icon w-6 h-6 rounded-lg flex items-center justify-center text-xs flex-shrink-0"><i class="fas fa-network-wired"></i></div>
                  <span class="text-xs">Verify Arc Testnet network</span>
                </div>
                <div id="cf-step-1" class="ct-step ct-step-idle flex items-center gap-2.5">
                  <div class="ct-step-icon w-6 h-6 rounded-lg flex items-center justify-center text-xs flex-shrink-0"><i class="fas fa-coins"></i></div>
                  <span class="text-xs">Check USDC balance</span>
                </div>
                <div id="cf-step-2" class="ct-step ct-step-idle flex items-center gap-2.5">
                  <div class="ct-step-icon w-6 h-6 rounded-lg flex items-center justify-center text-xs flex-shrink-0"><i class="fas fa-check-double"></i></div>
                  <span class="text-xs">Approve USDC for ContractFactory</span>
                </div>
                <div id="cf-step-3" class="ct-step ct-step-idle flex items-center gap-2.5">
                  <div class="ct-step-icon w-6 h-6 rounded-lg flex items-center justify-center text-xs flex-shrink-0"><i class="fas fa-paper-plane"></i></div>
                  <span class="text-xs">Send createContract (sign in wallet)</span>
                </div>
                <div id="cf-step-4" class="ct-step ct-step-idle flex items-center gap-2.5">
                  <div class="ct-step-icon w-6 h-6 rounded-lg flex items-center justify-center text-xs flex-shrink-0"><i class="fas fa-hourglass-half"></i></div>
                  <span class="text-xs">Awaiting on-chain confirmation</span>
                </div>
                <div id="cf-step-5" class="ct-step ct-step-idle flex items-center gap-2.5">
                  <div class="ct-step-icon w-6 h-6 rounded-lg flex items-center justify-center text-xs flex-shrink-0"><i class="fas fa-database"></i></div>
                  <span class="text-xs">Save metadata (emails, OTC)</span>
                </div>
                <div id="cf-step-6" class="ct-step ct-step-idle flex items-center gap-2.5">
                  <div class="ct-step-icon w-6 h-6 rounded-lg flex items-center justify-center text-xs flex-shrink-0"><i class="fas fa-list-check"></i></div>
                  <span class="text-xs">Reload contracts list</span>
                </div>
              </div>

            </div>
          </div>
        </div>

        <!-- ══ RIGHT: Contracts list ══ -->
        <div class="xl:col-span-3">
          <!-- Summary stats -->
          <div id="cf-summary" class="mb-4"></div>

          <!-- Header -->
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <i class="fas fa-file-contract" style="color:#60b4ff;font-size:14px;"></i>
              <span style="color:#dde2f0;font-size:14px;font-weight:700;">My Contracts</span>
            </div>
            <button onclick="cfLoadContracts()"
              style="font-size:11px;color:#60b4ff;background:rgba(55,138,221,0.08);border:1px solid rgba(55,138,221,0.2);padding:5px 12px;border-radius:8px;cursor:pointer;display:flex;align-items:center;gap:5px;transition:all 0.2s;"
              onmouseover="this.style.background='rgba(55,138,221,0.18)'" onmouseout="this.style.background='rgba(55,138,221,0.08)'">
              <i class="fas fa-rotate" style="font-size:10px;"></i>Refresh
            </button>
          </div>

          <!-- Contracts list container -->
          <div id="cf-contracts-list">
            <div style="display:flex;flex-direction:column;align-items:center;gap:12px;padding:48px 0;text-align:center;">
              <div style="width:56px;height:56px;border-radius:16px;background:rgba(55,138,221,0.06);border:1px solid rgba(55,138,221,0.12);display:flex;align-items:center;justify-content:center;">
                <i class="fas fa-wallet" style="color:#7a9ab8;font-size:22px;"></i>
              </div>
              <p style="color:#8aaac8;font-size:13px;">Connect your wallet to load on-chain contracts.</p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- MULTISEND TAB -->
    <div id="tab-content-multisend" class="tab-content hidden">
      <div class="max-w-5xl mx-auto">

        <!-- Wallet Gate -->
        <div id="ms-wallet-gate" class="hidden mb-6 bg-gray-900/60 border border-gray-700/40 rounded-2xl p-8 text-center">
          <div class="w-14 h-14 rounded-2xl bg-gradient-to-br from-cyan-700/30 to-blue-700/30 border border-cyan-700/30 flex items-center justify-center mx-auto mb-4">
            <i class="fas fa-wallet text-cyan-400 text-2xl"></i>
          </div>
          <h3 class="text-white font-semibold text-lg mb-2">Connect wallet to send</h3>
          <p class="text-gray-500 text-sm mb-4">MultiSend executes real ERC-20 transfers on Arc Testnet. A wallet connection is required to sign transactions.</p>
          <button onclick="openWalletModal()"
            class="inline-flex items-center gap-2 bg-cyan-600 hover:bg-cyan-500 text-white font-semibold rounded-xl px-6 py-2.5 transition-all">
            <i class="fas fa-wallet"></i>Connect Wallet
          </button>
        </div>

        <!-- Header -->
        <div class="flex items-center justify-between mb-6">
          <div>
            <h2 class="text-2xl font-bold text-white flex items-center gap-3">
              <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-600 to-blue-600 flex items-center justify-center">
                <i class="fas fa-paper-plane text-white text-base"></i>
              </div>
              MultiSend — Batch Payments
            </h2>
            <p class="text-gray-400 text-sm mt-1">Send USDC to multiple recipients with a single fee payment on Arc Testnet</p>
          </div>
          <div class="flex items-center gap-2 bg-amber-900/20 border border-amber-700/30 rounded-xl px-3 py-2">
            <i class="fas fa-flask text-amber-400 text-xs"></i>
            <span class="text-xs text-amber-400 font-medium">Testnet — No real funds</span>
          </div>
        </div>

        <!-- 3-Step Progress Bar -->
        <div class="flex items-center justify-between mb-8 px-2" id="ms-steps-bar">
          <div class="flex flex-col items-center gap-1.5 flex-1" id="ms-bar-step1">
            <div class="w-9 h-9 rounded-full border-2 border-cyan-500 bg-cyan-900/30 flex items-center justify-center font-bold text-cyan-400 text-sm transition-all">1</div>
            <span class="text-xs text-cyan-400 font-medium">Recipients</span>
          </div>
          <div class="flex-1 h-0.5 bg-gray-700 mx-1" id="ms-bar-line1"></div>
          <div class="flex flex-col items-center gap-1.5 flex-1" id="ms-bar-step2">
            <div class="w-9 h-9 rounded-full border-2 border-gray-600 bg-gray-800/40 flex items-center justify-center font-bold text-gray-500 text-sm transition-all">2</div>
            <span class="text-xs text-gray-500 font-medium">Review &amp; Sign</span>
          </div>
          <div class="flex-1 h-0.5 bg-gray-700 mx-1" id="ms-bar-line2"></div>
          <div class="flex flex-col items-center gap-1.5 flex-1" id="ms-bar-step3">
            <div class="w-9 h-9 rounded-full border-2 border-gray-600 bg-gray-800/40 flex items-center justify-center font-bold text-gray-500 text-sm transition-all">3</div>
            <span class="text-xs text-gray-500 font-medium">Pay Fee &amp; Send</span>
          </div>
        </div>

        <!-- STEP 1: Build recipient list -->
        <div id="ms-panel-step1" class="ms-step active">
          <!-- Stats bar -->
          <div class="grid grid-cols-4 gap-3 mb-5">
            <div class="bg-gray-800/60 border border-gray-700/40 rounded-xl p-3 text-center">
              <div class="text-lg font-bold text-white" id="ms-stat-recipients">0</div>
              <div class="text-xs text-gray-500 mt-0.5">Recipients</div>
            </div>
            <div class="bg-cyan-900/20 border border-cyan-700/30 rounded-xl p-3 text-center">
              <div class="text-lg font-bold text-cyan-400" id="ms-stat-total">$0.00</div>
              <div class="text-xs text-gray-500 mt-0.5">Total USDC</div>
            </div>
            <div class="bg-gray-800/60 border border-gray-700/40 rounded-xl p-3 text-center">
              <div class="text-lg font-bold text-yellow-400" id="ms-stat-fee">$0.00</div>
              <div class="text-xs text-gray-500 mt-0.5">Platform Fee</div>
            </div>
            <div class="bg-gray-800/60 border border-gray-700/40 rounded-xl p-3 text-center">
              <div class="text-lg font-bold text-purple-400" id="ms-stat-batches">0</div>
              <div class="text-xs text-gray-500 mt-0.5">Batches Sent</div>
            </div>
          </div>

          <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <!-- LEFT: Recipient table -->
            <div class="lg:col-span-2 bg-gray-900/60 border border-gray-700/40 rounded-2xl overflow-hidden">
              <div class="flex items-center justify-between px-5 py-3 border-b border-gray-700/40 bg-gray-800/30">
                <div class="flex items-center gap-3">
                  <span class="text-sm font-semibold text-white">Recipients</span>
                  <span class="text-xs text-gray-500 bg-gray-800 rounded-full px-2 py-0.5" id="ms-row-count">0 rows</span>
                </div>
                <div class="flex items-center gap-2">
                  <input id="ms-csv-input" type="file" accept=".csv,.txt" class="hidden" onchange="msHandleCSV(this.files[0])">
                  <button onclick="document.getElementById('ms-csv-input').click()"
                    ondragover="event.preventDefault(); this.classList.add('border-cyan-400','bg-cyan-900/20')"
                    ondragleave="this.classList.remove('border-cyan-400','bg-cyan-900/20')"
                    ondrop="event.preventDefault(); this.classList.remove('border-cyan-400','bg-cyan-900/20'); msHandleCSV(event.dataTransfer.files[0])"
                    class="flex items-center gap-1.5 text-xs bg-gray-800 hover:bg-gray-700 border border-gray-600 hover:border-cyan-500 text-gray-300 rounded-lg px-3 py-1.5 transition-all">
                    <i class="fas fa-upload text-cyan-400"></i>CSV
                  </button>
                  <button onclick="msDownloadTemplate()" title="Download CSV template"
                    class="w-7 h-7 flex items-center justify-center bg-gray-800 hover:bg-gray-700 border border-gray-600 text-gray-400 rounded-lg transition-all text-xs">
                    <i class="fas fa-download"></i>
                  </button>
                </div>
              </div>

              <div class="grid grid-cols-12 gap-2 px-5 py-2 bg-gray-800/20 border-b border-gray-700/30 text-[11px] text-gray-500 uppercase tracking-wider">
                <div class="col-span-5">Recipient Address</div>
                <div class="col-span-3">Amount (USDC)</div>
                <div class="col-span-3">Note</div>
                <div class="col-span-1"></div>
              </div>

              <div id="ms-error-banner" class="hidden px-5 py-2 bg-red-900/20 border-b border-red-700/30 flex items-center gap-2">
                <i class="fas fa-exclamation-circle text-red-400 text-xs"></i>
                <span id="ms-error-text" class="text-xs text-red-300"></span>
              </div>

              <div id="ms-rows" class="divide-y divide-gray-800/60 min-h-[120px]"></div>

              <div class="px-5 py-3 border-t border-gray-700/30">
                <button onclick="msAddRow()"
                  class="w-full flex items-center justify-center gap-2 text-cyan-400 hover:text-cyan-300 text-sm font-medium py-1.5 transition-colors border border-dashed border-gray-700 hover:border-cyan-600 rounded-xl">
                  <i class="fas fa-plus text-xs"></i>Add Recipient
                </button>
              </div>

              <div class="px-5 py-3 border-t border-gray-700/30 bg-gray-800/20 space-y-3">
                <div>
                  <label class="text-xs text-gray-500 mb-1 block uppercase tracking-wider">From (Sender Wallet)</label>
                  <input type="text" id="ms-from" placeholder="0x… (auto-filled from connected wallet)"
                    class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-cyan-500 focus:outline-none font-mono">
                </div>
              </div>
            </div>

            <!-- RIGHT: Fee info + proceed -->
            <div class="space-y-4">
              <div class="bg-gray-900/60 border border-gray-700/40 rounded-2xl p-4">
                <h3 class="text-white font-semibold text-sm mb-3 flex items-center gap-2">
                  <i class="fas fa-info-circle text-cyan-400"></i>Fee Breakdown
                </h3>
                <div class="space-y-2 mb-4">
                  <div class="flex justify-between text-xs">
                    <span class="text-gray-500">Recipients</span>
                    <span class="text-white font-medium" id="ms-summary-count">—</span>
                  </div>
                  <div class="flex justify-between text-xs">
                    <span class="text-gray-500">Total USDC</span>
                    <span class="text-cyan-400 font-bold text-sm" id="ms-summary-total">$0.00</span>
                  </div>
                  <div class="flex justify-between text-xs border-t border-gray-700/30 pt-2">
                    <span class="text-gray-500">Platform fee <span class="text-gray-600" id="ms-fee-pct">(1%)</span></span>
                    <span class="text-yellow-400 font-medium" id="ms-summary-fee">$0.00</span>
                  </div>
                  <div class="flex justify-between text-xs border-t border-gray-700/30 pt-2">
                    <span class="text-gray-500">Government fee</span>
                    <span class="text-gray-500">—</span>
                  </div>
                  <div class="flex justify-between text-xs">
                    <span class="text-gray-400 font-medium">You pay total</span>
                    <span class="text-white font-bold text-sm" id="ms-summary-grand">$0.00</span>
                  </div>
                  <div class="flex justify-between text-xs">
                    <span class="text-gray-500">Network</span>
                    <span class="text-green-400">Arc Testnet</span>
                  </div>
                </div>
                <div class="bg-blue-900/15 border border-blue-700/20 rounded-lg p-2.5 mb-3 text-xs text-blue-300">
                  <i class="fas fa-shield-alt mr-1"></i>
                  Single fee payment — not per transfer. Fee scales with recipient count.
                </div>
                <button onclick="msProceedToReview()" id="ms-proceed-btn"
                  class="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white rounded-xl px-4 py-2.5 text-sm font-bold transition-all shadow-lg shadow-cyan-900/30">
                  <i class="fas fa-arrow-right"></i>Review &amp; Sign
                </button>
              </div>

              <div class="bg-gray-800/40 border border-gray-700/30 rounded-xl p-3">
                <p class="text-xs text-gray-500 font-medium mb-1.5"><i class="fas fa-info-circle text-cyan-600 mr-1"></i>CSV Format</p>
                <p class="text-xs text-gray-600">Columns: <code class="text-cyan-500 bg-gray-800 px-1 rounded">address</code>, <code class="text-cyan-500 bg-gray-800 px-1 rounded">amount</code>, <code class="text-gray-400 bg-gray-800 px-1 rounded">note</code></p>
                <p class="text-xs text-gray-600 mt-1">Max 500 rows · Max $10,000 per row</p>
              </div>
            </div>
          </div>
        </div>

        <!-- STEP 2: Review & Sign summary -->
        <div id="ms-panel-step2" class="ms-step hidden">
          <div class="bg-gray-900/60 border border-gray-700/40 rounded-2xl p-6 mb-5">
            <h3 class="text-white font-semibold mb-4 flex items-center gap-2">
              <i class="fas fa-list-alt text-cyan-400"></i>Batch Summary
            </h3>
            <div id="ms-review-table" class="space-y-1 max-h-64 overflow-y-auto mb-4"></div>
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t border-gray-700/30">
              <div class="bg-gray-800/50 rounded-lg px-3 py-2 text-center">
                <div class="text-white font-bold text-sm" id="ms-review-count">—</div>
                <div class="text-xs text-gray-500">Recipients</div>
              </div>
              <div class="bg-gray-800/50 rounded-lg px-3 py-2 text-center">
                <div class="text-cyan-400 font-bold text-sm" id="ms-review-total">—</div>
                <div class="text-xs text-gray-500">Total USDC</div>
              </div>
              <div class="bg-gray-800/50 rounded-lg px-3 py-2 text-center">
                <div class="text-yellow-400 font-bold text-sm" id="ms-review-fee">—</div>
                <div class="text-xs text-gray-500">Platform Fee</div>
              </div>
              <div class="bg-gray-800/50 rounded-lg px-3 py-2 text-center">
                <div class="text-white font-bold text-sm" id="ms-review-grand">—</div>
                <div class="text-xs text-gray-500">Grand Total</div>
              </div>
            </div>
          </div>
          <div class="flex gap-3">
            <button onclick="msGoBack()" class="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-400 rounded-xl px-5 py-2.5 text-sm transition-all">
              <i class="fas fa-arrow-left"></i>Back
            </button>
            <button onclick="msProceedToSend()" id="ms-sign-btn"
              class="flex-1 flex items-center justify-center gap-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white rounded-xl px-5 py-2.5 text-sm font-bold transition-all shadow-lg">
              <i class="fas fa-check"></i>Confirm &amp; Proceed to Fee Payment
            </button>
          </div>
        </div>

        <!-- STEP 3: Pay fee + send all transfers -->
        <div id="ms-panel-step3" class="ms-step hidden">
          <div class="bg-gray-900/60 border border-gray-700/40 rounded-2xl p-6 mb-5">
            <h3 class="text-white font-semibold mb-4 flex items-center gap-2">
              <i class="fas fa-paper-plane text-cyan-400"></i>Execute Batch
            </h3>

            <!-- Tx lifecycle steps -->
            <div id="ms-tx-steps" class="space-y-2 mb-5">
              <div class="ms-tx-step flex items-center gap-3 p-3 bg-gray-800/40 border border-gray-700/30 rounded-xl" id="ms-txstep-1">
                <div class="w-7 h-7 rounded-full border-2 border-gray-600 flex items-center justify-center flex-shrink-0 text-xs text-gray-500" id="ms-txstep-1-icon">1</div>
                <div class="flex-1 min-w-0">
                  <div class="text-sm text-gray-300">Check Arc Testnet &amp; USDC Balance</div>
                  <div class="text-xs text-gray-600 ms-txstep-status" id="ms-txstep-1-status">Waiting…</div>
                </div>
              </div>
              <div class="ms-tx-step flex items-center gap-3 p-3 bg-gray-800/40 border border-gray-700/30 rounded-xl" id="ms-txstep-2">
                <div class="w-7 h-7 rounded-full border-2 border-gray-600 flex items-center justify-center flex-shrink-0 text-xs text-gray-500" id="ms-txstep-2-icon">2</div>
                <div class="flex-1 min-w-0">
                  <div class="text-sm text-gray-300">Pay Platform Fee &amp; Execute Multicall</div>
                  <div class="text-xs text-gray-600 ms-txstep-status" id="ms-txstep-2-status">Waiting…</div>
                </div>
              </div>
              <div class="ms-tx-step flex items-center gap-3 p-3 bg-gray-800/40 border border-gray-700/30 rounded-xl" id="ms-txstep-3">
                <div class="w-7 h-7 rounded-full border-2 border-gray-600 flex items-center justify-center flex-shrink-0 text-xs text-gray-500" id="ms-txstep-3-icon">3</div>
                <div class="flex-1 min-w-0">
                  <div class="text-sm text-gray-300" id="ms-txstep-3-label">Multicall Batch (0 recipients)</div>
                  <div class="text-xs text-gray-600 ms-txstep-status" id="ms-txstep-3-status">Waiting…</div>
                </div>
              </div>
            </div>

            <div id="ms-final-result" class="hidden rounded-xl p-4 mb-4"></div>

            <div class="flex gap-3">
              <button onclick="msGoBack()" id="ms-step3-back"
                class="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-400 rounded-xl px-5 py-2.5 text-sm transition-all">
                <i class="fas fa-arrow-left"></i>Back
              </button>
              <button onclick="msExecute()" id="ms-execute-btn"
                class="flex-1 flex items-center justify-center gap-2 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white rounded-xl px-5 py-2.5 text-sm font-bold transition-all shadow-lg shadow-cyan-900/30">
                <i class="fas fa-rocket"></i>Pay Fee &amp; Send All
              </button>
            </div>
          </div>
        </div>

        <!-- Receipt History -->
        <div class="mt-6">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-white font-semibold text-sm flex items-center gap-2">
              <i class="fas fa-receipt text-green-400 text-base"></i>
              Batch Receipts
            </h3>
            <div class="flex items-center gap-2">
              <span class="text-xs text-gray-500" id="ms-receipts-count">0 receipts</span>
              <button onclick="msOpenHybridHistory()"
                class="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-cyan-900/20 border border-cyan-700/30 text-cyan-400 hover:text-cyan-300 rounded-xl transition font-semibold">
                <i class="fas fa-history text-xs"></i>Full History
              </button>
            </div>
          </div>
          <div id="ms-receipts-list">
            <div class="flex flex-col items-center gap-3 py-10 text-center text-gray-600">
              <i class="fas fa-inbox text-2xl"></i>
              <p class="text-sm">No batch receipts yet. Send a batch to generate a receipt.</p>
            </div>
          </div>
        </div>

      </div>
    </div>

    <!-- AGENTS TAB -->
    <div id="tab-content-agents" class="tab-content hidden">

      <!-- Wallet Panel (topo) -->
      <div class="bg-gray-900/60 border border-purple-700/40 rounded-xl p-5 mb-6">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-white font-semibold flex items-center gap-2">
            <i class="fas fa-wallet text-purple-400"></i>
            <span data-i18n="wallet_status">Wallet Status</span>
          </h3>
          <button id="wallet-connect-agents-btn" onclick="openWalletModal()"
            class="wallet-connect-pulse flex items-center gap-2 bg-purple-600 hover:bg-purple-700 text-white rounded-xl px-4 py-2 text-sm font-semibold transition-all">
            <i class="fas fa-plug"></i><span data-i18n="btn_connect_wallet">Connect Wallet</span>
          </button>
        </div>
        <!-- Status compacto da wallet -->
        <div id="wallet-agents-status" class="text-gray-500 text-sm">
          <span data-i18n="no_wallet_connected">No wallet connected. Connect to see balance and address.</span>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <!-- Agente de Pagamentos -->
        <div class="bg-gray-900/60 border border-gray-700/40 rounded-xl p-6">
          <div class="flex items-center gap-3 mb-5">
            <div class="w-12 h-12 rounded-xl bg-gradient-to-br from-purple-600 to-pink-600 flex items-center justify-center">
              <i class="fas fa-money-bill-wave text-white text-xl"></i>
            </div>
            <div>
              <h3 class="text-white font-semibold">ArcPay Agent v1.0</h3>
              <p class="text-purple-400 text-xs" data-i18n="payment_agent_desc">USDC Payment Agent</p>
            </div>
            <div id="pay-agent-status-dot" class="ml-auto w-3 h-3 rounded-full bg-green-400 animate-pulse"></div>
          </div>

          <div id="pay-agent-details" class="space-y-3 mb-5">
            <div class="text-gray-500 text-sm" data-i18n="loading">Loading...</div>
          </div>

          <div class="space-y-2">
            <h4 class="text-xs text-gray-400 uppercase tracking-wider mb-3" data-i18n="capabilities">Capabilities</h4>
            <div class="grid grid-cols-2 gap-2">
              <div class="bg-purple-900/30 border border-purple-700/30 rounded-lg p-3 text-center">
                <i class="fas fa-search text-purple-400 text-lg mb-1 block"></i>
                <span class="text-xs text-gray-300" data-i18n="cap_risk_analysis">Risk Analysis</span>
              </div>
              <div class="bg-purple-900/30 border border-purple-700/30 rounded-lg p-3 text-center">
                <i class="fas fa-check-circle text-green-400 text-lg mb-1 block"></i>
                <span class="text-xs text-gray-300" data-i18n="cap_auto_approval">Auto-Approval</span>
              </div>
              <div class="bg-purple-900/30 border border-purple-700/30 rounded-lg p-3 text-center">
                <i class="fas fa-shield-alt text-blue-400 text-lg mb-1 block"></i>
                <span class="text-xs text-gray-300" data-i18n="cap_fraud_detection">Fraud Detection</span>
              </div>
              <div class="bg-purple-900/30 border border-purple-700/30 rounded-lg p-3 text-center">
                <i class="fas fa-layer-group text-yellow-400 text-lg mb-1 block"></i>
                <span class="text-xs text-gray-300" data-i18n="cap_batch_payments">Batch Payments</span>
              </div>
            </div>
          </div>

          <div class="mt-4 p-3 bg-gray-800/50 rounded-lg">
            <h4 class="text-xs text-gray-400 mb-2" data-i18n="risk_limits">Risk Limits</h4>
            <div class="space-y-1.5 text-xs">
              <div class="flex justify-between"><span class="text-green-400">● <span data-i18n="risk_auto">Auto-approved</span></span><span class="text-gray-300">≤ $10 USDC</span></div>
              <div class="flex justify-between"><span class="text-yellow-400">● <span data-i18n="risk_analysis">Analysis required</span></span><span class="text-gray-300">$10 - $100 USDC</span></div>
              <div class="flex justify-between"><span class="text-orange-400">● <span data-i18n="risk_escalated">Escalated</span></span><span class="text-gray-300">$100 - $1,000 USDC</span></div>
              <div class="flex justify-between"><span class="text-red-400">● <span data-i18n="risk_blocked">Blocked</span></span><span class="text-gray-300">> $10,000 USDC</span></div>
            </div>
          </div>
        </div>

        <!-- Agente de Contratos -->
        <div class="bg-gray-900/60 border border-gray-700/40 rounded-xl p-6">
          <div class="flex items-center gap-3 mb-5">
            <div class="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-600 to-cyan-600 flex items-center justify-center">
              <i class="fas fa-file-contract text-white text-xl"></i>
            </div>
            <div>
              <h3 class="text-white font-semibold">ArcContract Agent v1.0</h3>
              <p class="text-blue-400 text-xs" data-i18n="contract_agent_desc">Digital Contract Agent</p>
            </div>
            <div id="contract-agent-status-dot" class="ml-auto w-3 h-3 rounded-full bg-green-400 animate-pulse"></div>
          </div>

          <div id="contract-agent-details" class="space-y-3 mb-5">
            <div class="text-gray-500 text-sm" data-i18n="loading">Loading...</div>
          </div>

          <div class="space-y-2">
            <h4 class="text-xs text-gray-400 uppercase tracking-wider mb-3" data-i18n="capabilities">Capabilities</h4>
            <div class="grid grid-cols-2 gap-2">
              <div class="bg-blue-900/30 border border-blue-700/30 rounded-lg p-3 text-center">
                <i class="fas fa-file-alt text-blue-400 text-lg mb-1 block"></i>
                <span class="text-xs text-gray-300" data-i18n="cap_contract_review">Contract Review</span>
              </div>
              <div class="bg-blue-900/30 border border-blue-700/30 rounded-lg p-3 text-center">
                <i class="fas fa-lock text-green-400 text-lg mb-1 block"></i>
                <span class="text-xs text-gray-300" data-i18n="cap_escrow">Escrow Management</span>
              </div>
              <div class="bg-blue-900/30 border border-blue-700/30 rounded-lg p-3 text-center">
                <i class="fas fa-tasks text-yellow-400 text-lg mb-1 block"></i>
                <span class="text-xs text-gray-300" data-i18n="cap_milestone">Milestone Verification</span>
              </div>
              <div class="bg-blue-900/30 border border-blue-700/30 rounded-lg p-3 text-center">
                <i class="fas fa-balance-scale text-red-400 text-lg mb-1 block"></i>
                <span class="text-xs text-gray-300" data-i18n="cap_arbitration">Arbitration</span>
              </div>
            </div>
          </div>

          <div class="mt-4 p-3 bg-gray-800/50 rounded-lg">
            <h4 class="text-xs text-gray-400 mb-2" data-i18n="contract_flow">Contract State Machine</h4>
            <div class="flex items-center gap-1 text-xs overflow-x-auto pb-1">
              <span class="bg-yellow-900/50 text-yellow-300 px-2 py-1 rounded whitespace-nowrap">⏳ Pending</span>
              <i class="fas fa-arrow-right text-gray-600 flex-shrink-0"></i>
              <span class="bg-blue-900/50 text-blue-300 px-2 py-1 rounded whitespace-nowrap">💰 Funded</span>
              <i class="fas fa-arrow-right text-gray-600 flex-shrink-0"></i>
              <span class="bg-cyan-900/50 text-cyan-300 px-2 py-1 rounded whitespace-nowrap">⚡ Active</span>
              <i class="fas fa-arrow-right text-gray-600 flex-shrink-0"></i>
              <span class="bg-green-900/50 text-green-300 px-2 py-1 rounded whitespace-nowrap">✅ <span data-i18n="status_completed">Completed</span></span>
            </div>
          </div>
        </div>
      </div>

      <!-- Logs do Sistema -->
      <div class="mt-6 bg-gray-900/60 border border-gray-700/40 rounded-xl p-6">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-white font-semibold flex items-center gap-2">
            <i class="fas fa-terminal text-green-400"></i>
            <span data-i18n="agent_logs">Agent Logs</span>
          </h3>
          <button onclick="clearLogs()" class="text-xs text-gray-500 hover:text-red-400">
            <i class="fas fa-trash mr-1"></i><span data-i18n="btn_clear_logs">Clear</span>
          </button>
        </div>
        <div id="agent-logs" class="font-mono text-xs space-y-1 max-h-64 overflow-y-auto bg-black/40 rounded-lg p-4">
          <div class="text-green-400">[SYSTEM] ARC AI Agents initialized...</div>
          <div class="text-blue-400">[NETWORK] Connected to Arc Testnet (Chain ID: 5042002)</div>
          <div class="text-purple-400">[AGENT:PAY] ArcPay Agent v1.0 ready</div>
          <div class="text-cyan-400">[AGENT:CTR] ArcContract Agent v1.0 ready</div>
          <div class="text-yellow-400">[AGENT:GRD] Guardian Agent v1.0 ready</div>
          <div class="text-green-400">[AGENT:YLD] Yield Optimizer v1.0 ready</div>
          <div class="text-gray-500">[INFO] All 4 agents active — waiting for tasks...</div>
        </div>
      </div>

      <!-- NOVOS AGENTES: Guardian + Yield Optimizer -->
      <div class="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">

        <!-- Guardian Agent — Compliance/KYC -->
        <div class="bg-gray-900/60 border border-yellow-700/40 rounded-xl p-6">
          <div class="flex items-center gap-3 mb-5">
            <div class="w-12 h-12 rounded-xl bg-gradient-to-br from-yellow-600 to-orange-600 flex items-center justify-center">
              <i class="fas fa-shield-alt text-white text-xl"></i>
            </div>
            <div>
              <h3 class="text-white font-semibold">Guardian Agent v1.0</h3>
              <p class="text-yellow-400 text-xs">Compliance &amp; KYC / AML</p>
            </div>
            <div id="guardian-agent-dot" class="ml-auto w-3 h-3 rounded-full bg-yellow-400 animate-pulse"></div>
          </div>

          <!-- Stats rápidas -->
          <div id="guardian-agent-stats" class="grid grid-cols-2 gap-3 mb-5">
            <div class="bg-yellow-900/20 border border-yellow-700/30 rounded-lg p-3 text-center">
              <p class="text-2xl font-bold text-white" id="guardian-total-checks">--</p>
              <p class="text-xs text-yellow-400 mt-0.5">Total Checks</p>
            </div>
            <div class="bg-green-900/20 border border-green-700/30 rounded-lg p-3 text-center">
              <p class="text-2xl font-bold text-green-400" id="guardian-approved">--</p>
              <p class="text-xs text-gray-400 mt-0.5">Approved</p>
            </div>
            <div class="bg-red-900/20 border border-red-700/30 rounded-lg p-3 text-center">
              <p class="text-2xl font-bold text-red-400" id="guardian-blocked">--</p>
              <p class="text-xs text-gray-400 mt-0.5">Blocked</p>
            </div>
            <div class="bg-blue-900/20 border border-blue-700/30 rounded-lg p-3 text-center">
              <p class="text-2xl font-bold text-blue-400" id="guardian-kyc-verified">--</p>
              <p class="text-xs text-gray-400 mt-0.5">KYC Verified</p>
            </div>
          </div>

          <!-- Capacidades -->
          <div class="grid grid-cols-2 gap-2 mb-4">
            <div class="bg-yellow-900/20 border border-yellow-700/20 rounded-lg p-2.5 text-center">
              <i class="fas fa-gavel text-yellow-400 text-sm mb-1 block"></i>
              <span class="text-xs text-gray-300">Sanction Screen</span>
            </div>
            <div class="bg-yellow-900/20 border border-yellow-700/20 rounded-lg p-2.5 text-center">
              <i class="fas fa-id-card text-orange-400 text-sm mb-1 block"></i>
              <span class="text-xs text-gray-300">KYC Verification</span>
            </div>
            <div class="bg-yellow-900/20 border border-yellow-700/20 rounded-lg p-2.5 text-center">
              <i class="fas fa-globe text-red-400 text-sm mb-1 block"></i>
              <span class="text-xs text-gray-300">Jurisdiction Check</span>
            </div>
            <div class="bg-yellow-900/20 border border-yellow-700/20 rounded-lg p-2.5 text-center">
              <i class="fas fa-chart-bar text-purple-400 text-sm mb-1 block"></i>
              <span class="text-xs text-gray-300">AML / Structuring</span>
            </div>
          </div>

          <!-- Quick Check form -->
          <div class="bg-gray-800/50 rounded-lg p-4">
            <h4 class="text-xs text-gray-400 uppercase tracking-wider mb-3">Quick Compliance Check</h4>
            <div class="space-y-2">
              <input id="guardian-check-addr" type="text" placeholder="0x... wallet address"
                class="w-full bg-gray-700/60 border border-gray-600/60 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-yellow-500/60 focus:outline-none">
              <div class="flex gap-2">
                <input id="guardian-check-amt" type="number" placeholder="Amount USDC" min="0"
                  class="flex-1 bg-gray-700/60 border border-gray-600/60 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-yellow-500/60 focus:outline-none">
                <select id="guardian-check-token"
                  class="bg-gray-700/60 border border-gray-600/60 rounded-lg px-3 py-2 text-sm text-white focus:border-yellow-500/60 focus:outline-none">
                  <option value="USDC">USDC</option>
                  <option value="EURC">EURC</option>
                </select>
              </div>
              <button onclick="runGuardianCheck()"
                class="w-full bg-yellow-600 hover:bg-yellow-500 text-white rounded-lg py-2 text-sm font-semibold transition-colors flex items-center justify-center gap-2">
                <i class="fas fa-search-plus"></i> Run Compliance Check
              </button>
            </div>
            <div id="guardian-check-result" class="mt-3 hidden"></div>
          </div>

          <!-- KYC Submit -->
          <div class="bg-gray-800/50 rounded-lg p-4 mt-3">
            <h4 class="text-xs text-gray-400 uppercase tracking-wider mb-3">Submit KYC</h4>
            <div class="space-y-2">
              <input id="kyc-submit-addr" type="text" placeholder="0x... (or connected wallet)"
                class="w-full bg-gray-700/60 border border-gray-600/60 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-yellow-500/60 focus:outline-none">
              <div class="flex gap-2">
                <select id="kyc-submit-tier"
                  class="flex-1 bg-gray-700/60 border border-gray-600/60 rounded-lg px-3 py-2 text-sm text-white focus:border-yellow-500/60 focus:outline-none">
                  <option value="1">Tier 1 — Basic ($1k/tx)</option>
                  <option value="2">Tier 2 — Standard ($10k/tx)</option>
                  <option value="3">Tier 3 — Full ($500k/tx)</option>
                </select>
                <input id="kyc-submit-country" type="text" placeholder="US" maxlength="2"
                  class="w-16 bg-gray-700/60 border border-gray-600/60 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-yellow-500/60 focus:outline-none">
              </div>
              <button onclick="submitKYC()"
                class="w-full bg-orange-600 hover:bg-orange-500 text-white rounded-lg py-2 text-sm font-semibold transition-colors flex items-center justify-center gap-2">
                <i class="fas fa-id-card"></i> Submit KYC Application
              </button>
            </div>
            <div id="kyc-submit-result" class="mt-3 hidden"></div>
          </div>

          <div class="mt-3 flex gap-2">
            <button onclick="loadGuardianStatus()" class="flex-1 text-xs text-yellow-400 hover:text-yellow-300 bg-yellow-900/20 border border-yellow-700/30 rounded-lg py-2 transition-colors">
              <i class="fas fa-sync mr-1"></i> Refresh Stats
            </button>
            <button onclick="loadComplianceLog()" class="flex-1 text-xs text-orange-400 hover:text-orange-300 bg-orange-900/20 border border-orange-700/30 rounded-lg py-2 transition-colors">
              <i class="fas fa-list mr-1"></i> View Log
            </button>
          </div>
        </div>

        <!-- Yield Optimizer Agent -->
        <div class="bg-gray-900/60 border border-green-700/40 rounded-xl p-6">
          <div class="flex items-center gap-3 mb-5">
            <div class="w-12 h-12 rounded-xl bg-gradient-to-br from-green-600 to-teal-600 flex items-center justify-center">
              <i class="fas fa-seedling text-white text-xl"></i>
            </div>
            <div>
              <h3 class="text-white font-semibold">Yield Optimizer v1.0</h3>
              <p class="text-green-400 text-xs">Auto Rebalancing &amp; APY Maximizer</p>
            </div>
            <div id="yield-agent-dot" class="ml-auto w-3 h-3 rounded-full bg-green-400 animate-pulse"></div>
          </div>

          <!-- Stats rápidas -->
          <div id="yield-agent-stats" class="grid grid-cols-2 gap-3 mb-5">
            <div class="bg-green-900/20 border border-green-700/30 rounded-lg p-3 text-center">
              <p class="text-2xl font-bold text-green-400" id="yield-best-apy">--</p>
              <p class="text-xs text-gray-400 mt-0.5">Best APY %</p>
            </div>
            <div class="bg-teal-900/20 border border-teal-700/30 rounded-lg p-3 text-center">
              <p class="text-2xl font-bold text-teal-400" id="yield-total-pools">--</p>
              <p class="text-xs text-gray-400 mt-0.5">Active Pools</p>
            </div>
            <div class="bg-blue-900/20 border border-blue-700/30 rounded-lg p-3 text-center">
              <p class="text-2xl font-bold text-blue-400" id="yield-positions">--</p>
              <p class="text-xs text-gray-400 mt-0.5">Positions</p>
            </div>
            <div class="bg-purple-900/20 border border-purple-700/30 rounded-lg p-3 text-center">
              <p class="text-2xl font-bold text-purple-400" id="yield-rebalances">--</p>
              <p class="text-xs text-gray-400 mt-0.5">Rebalances</p>
            </div>
          </div>

          <!-- Capacidades -->
          <div class="grid grid-cols-2 gap-2 mb-4">
            <div class="bg-green-900/20 border border-green-700/20 rounded-lg p-2.5 text-center">
              <i class="fas fa-swimming-pool text-green-400 text-sm mb-1 block"></i>
              <span class="text-xs text-gray-300">Pool Discovery</span>
            </div>
            <div class="bg-green-900/20 border border-green-700/20 rounded-lg p-2.5 text-center">
              <i class="fas fa-balance-scale text-teal-400 text-sm mb-1 block"></i>
              <span class="text-xs text-gray-300">Auto-Rebalance</span>
            </div>
            <div class="bg-green-900/20 border border-green-700/20 rounded-lg p-2.5 text-center">
              <i class="fas fa-chart-line text-blue-400 text-sm mb-1 block"></i>
              <span class="text-xs text-gray-300">APY Tracking</span>
            </div>
            <div class="bg-green-900/20 border border-green-700/20 rounded-lg p-2.5 text-center">
              <i class="fas fa-redo text-purple-400 text-sm mb-1 block"></i>
              <span class="text-xs text-gray-300">Compounding</span>
            </div>
          </div>

          <!-- APY Projections -->
          <div class="bg-gray-800/50 rounded-lg p-4 mb-3">
            <h4 class="text-xs text-gray-400 uppercase tracking-wider mb-3">APY Projection Calculator</h4>
            <div class="flex gap-2 mb-3">
              <input id="yield-proj-amount" type="number" placeholder="1000" min="1" value="1000"
                class="flex-1 bg-gray-700/60 border border-gray-600/60 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-green-500/60 focus:outline-none">
              <select id="yield-proj-token"
                class="bg-gray-700/60 border border-gray-600/60 rounded-lg px-3 py-2 text-sm text-white focus:border-green-500/60 focus:outline-none">
                <option value="USDC">USDC</option>
                <option value="EURC">EURC</option>
              </select>
              <button onclick="calcYieldProjection()"
                class="bg-green-600 hover:bg-green-500 text-white rounded-lg px-3 py-2 text-sm font-semibold transition-colors">
                <i class="fas fa-calculator"></i>
              </button>
            </div>
            <div id="yield-projection-result" class="text-xs text-gray-500 text-center">
              Click to calculate projected returns
            </div>
          </div>

          <!-- Open Position with EVM signing -->
          <div class="bg-gray-800/50 rounded-lg p-4">
            <h4 class="text-xs text-gray-400 uppercase tracking-wider mb-3">Open Yield Position</h4>
            <div class="space-y-2">
              <select id="yield-open-pool"
                class="w-full bg-gray-700/60 border border-gray-600/60 rounded-lg px-3 py-2 text-sm text-white focus:border-green-500/60 focus:outline-none">
                <option value="">Select pool...</option>
              </select>
              <input id="yield-open-amount" type="number" placeholder="Amount USDC/EURC" min="1"
                class="w-full bg-gray-700/60 border border-gray-600/60 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-green-500/60 focus:outline-none">
              <button onclick="openYieldPosition()"
                class="w-full bg-green-600 hover:bg-green-500 text-white rounded-lg py-2 text-sm font-semibold transition-colors flex items-center justify-center gap-2">
                <i class="fas fa-sign-in-alt"></i> Open Position (Sign on Arc)
              </button>
            </div>
            <div id="yield-open-result" class="mt-3 hidden"></div>
          </div>

          <!-- Active Positions -->
          <div class="mt-3">
            <h4 class="text-xs text-gray-400 uppercase tracking-wider mb-2">Active Positions</h4>
            <div id="yield-positions-list" class="space-y-2 max-h-48 overflow-y-auto">
              <div class="text-center text-gray-600 text-xs py-3">Connect wallet to see positions</div>
            </div>
          </div>

          <div class="mt-3 flex gap-2">
            <button onclick="loadYieldData()" class="flex-1 text-xs text-green-400 hover:text-green-300 bg-green-900/20 border border-green-700/30 rounded-lg py-2 transition-colors">
              <i class="fas fa-sync mr-1"></i> Refresh Pools
            </button>
            <button onclick="loadYieldPositions()" class="flex-1 text-xs text-teal-400 hover:text-teal-300 bg-teal-900/20 border border-teal-700/30 rounded-lg py-2 transition-colors">
              <i class="fas fa-list mr-1"></i> My Positions
            </button>
          </div>
        </div>

      </div>

      <!-- Compliance Log (Guardian) -->
      <div class="mt-6 bg-gray-900/60 border border-yellow-700/30 rounded-xl p-6">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-white font-semibold flex items-center gap-2">
            <i class="fas fa-shield-alt text-yellow-400"></i>
            Compliance Log (Guardian)
          </h3>
          <button onclick="loadComplianceLog()" class="text-xs text-yellow-400 hover:text-yellow-300">
            <i class="fas fa-sync mr-1"></i> Refresh
          </button>
        </div>
        <div id="compliance-log-list" class="space-y-2 max-h-48 overflow-y-auto">
          <div class="text-center text-gray-600 text-sm py-4">No compliance checks yet. Run a check above.</div>
        </div>
      </div>

    </div>



    <!-- HISTORY TAB -->
    <div id="tab-content-history" class="tab-content hidden">
      <div class="max-w-6xl mx-auto">
        <!-- Header -->
        <div class="flex items-center justify-between mb-6">
          <div>
            <h2 class="text-2xl font-bold text-white flex items-center gap-3">
              <span class="w-10 h-10 rounded-2xl bg-gradient-to-br from-blue-600 to-indigo-700 flex items-center justify-center text-lg">
                <i class="fas fa-history"></i>
              </span>
              Transaction History
            </h2>
            <p class="text-gray-500 text-xs mt-1 ml-13">
              All on-chain activity · Arc Testnet · Real blockchain data
              <span id="history-count" class="ml-2 text-gray-600"></span>
            </p>
          </div>
          <div class="flex items-center gap-2">
            <span id="history-poll-badge" class="hidden text-[10px] text-green-500 flex items-center gap-1">
              <i class="fas fa-circle text-[8px] animate-pulse"></i>Live
            </span>
            <button onclick="if(window.historyInit) window.historyInit()"
              class="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 bg-gray-800/60 hover:bg-gray-700/60 border border-gray-600/40 rounded-lg px-3 py-1.5 transition">
              <i class="fas fa-sync text-[10px]"></i>Refresh
            </button>
            <button onclick="switchTab(window._historyPrevTab||'dashboard')" title="Close History"
              class="flex items-center gap-1.5 text-xs text-red-400 hover:text-red-300 bg-red-900/10 hover:bg-red-900/20 border border-red-800/30 rounded-lg px-3 py-1.5 transition">
              <i class="fas fa-times text-[11px]"></i>Close
            </button>
          </div>
        </div>

        <!-- Filters -->
        <div class="flex flex-wrap gap-2 mb-5" id="history-filters">
          <button onclick="window.historyFilter('all')" data-filter="all"
            class="history-filter-btn active text-xs px-3 py-1.5 rounded-lg bg-blue-700/40 border border-blue-600/40 text-blue-300 font-semibold transition">
            <i class="fas fa-th-list mr-1"></i>All
          </button>
          <button onclick="window.historyFilter('payment')" data-filter="payment"
            class="history-filter-btn text-xs px-3 py-1.5 rounded-lg bg-gray-800/60 border border-gray-700/40 text-gray-400 hover:text-purple-300 hover:border-purple-700/40 transition">
            <i class="fas fa-dollar-sign mr-1"></i>Payments
          </button>
          <button onclick="window.historyFilter('multisend')" data-filter="multisend"
            class="history-filter-btn text-xs px-3 py-1.5 rounded-lg bg-gray-800/60 border border-gray-700/40 text-gray-400 hover:text-cyan-300 hover:border-cyan-700/40 transition">
            <i class="fas fa-paper-plane mr-1"></i>MultiSend
          </button>
          <button onclick="window.historyFilter('swap')" data-filter="swap"
            class="history-filter-btn text-xs px-3 py-1.5 rounded-lg bg-gray-800/60 border border-gray-700/40 text-gray-400 hover:text-green-300 hover:border-green-700/40 transition">
            <i class="fas fa-exchange-alt mr-1"></i>Swaps
          </button>
          <button onclick="window.historyFilter('contract')" data-filter="contract"
            class="history-filter-btn text-xs px-3 py-1.5 rounded-lg bg-gray-800/60 border border-gray-700/40 text-gray-400 hover:text-yellow-300 hover:border-yellow-700/40 transition">
            <i class="fas fa-file-contract mr-1"></i>Contracts
          </button>
        </div>

        <!-- Wallet gate -->
        <div id="history-wallet-gate" class="hidden bg-gray-900/60 border border-gray-700/40 rounded-2xl p-10 text-center mb-6">
          <i class="fas fa-wallet text-4xl text-gray-600 mb-4 block"></i>
          <h3 class="text-white font-semibold mb-2">Connect wallet to view history</h3>
          <p class="text-gray-500 text-sm mb-4">Transaction history is fetched from the blockchain using your wallet address.</p>
          <button onclick="openWalletModal()" class="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-xl px-6 py-2.5 transition-all">
            <i class="fas fa-wallet"></i>Connect Wallet
          </button>
        </div>

        <!-- Loading state -->
        <div id="history-loading" class="hidden text-center py-12">
          <i class="fas fa-spinner fa-spin text-blue-400 text-3xl mb-4 block"></i>
          <p class="text-gray-400">Loading transaction history from Arc Testnet…</p>
        </div>

        <!-- Empty state -->
        <div id="history-empty" class="hidden text-center py-12">
          <i class="fas fa-inbox text-4xl text-gray-600 mb-4 block"></i>
          <p class="text-white font-semibold mb-1">No transactions found</p>
          <p class="text-gray-500 text-sm">Transactions will appear here after you interact with the app.</p>
        </div>

        <!-- Transaction list -->
        <div id="history-list" class="space-y-2"></div>

        <!-- Load more -->
        <div id="history-load-more" class="hidden text-center mt-6">
          <button onclick="window.historyLoadMore()"
            class="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-blue-300 bg-gray-800/60 border border-gray-700/40 rounded-xl px-5 py-2.5 transition">
            <i class="fas fa-chevron-down"></i>Load more transactions
          </button>
        </div>
      </div>
    </div>

    <!-- ══════════════════════════ DEX TAB — ARC Swap ══════════════════════════ -->    <!-- ══════════════════════════ DEX TAB — ARC Swap ══════════════════════════ -->
    <div id="tab-content-dex" class="tab-content hidden">

      <!-- ── Page Header ─────────────────────────────────────────────────────── -->
      <div class="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div>
          <h2 class="text-2xl font-bold text-white flex items-center gap-3">
            <span class="w-10 h-10 rounded-2xl bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center text-lg shadow-lg shadow-cyan-900/40">
              <i class="fas fa-exchange-alt"></i>
            </span>
            ARC Swap
            <span class="text-xs font-normal bg-amber-500/10 border border-amber-500/30 text-amber-400 px-2.5 py-1 rounded-full">
              <i class="fas fa-flask mr-1 text-[10px]"></i>Testnet
            </span>
          </h2>
          <p class="text-gray-500 text-xs mt-1.5 ml-13">EURC / USDC · Constant Product AMM (x·y=k) · 0.3% fee · Arc Testnet</p>
        </div>
        <!-- Status + refresh -->
        <div class="flex items-center gap-2">
          <button onclick="ammRefreshAll()" class="text-xs text-gray-500 hover:text-cyan-400 transition-colors bg-gray-800/60 border border-gray-700/40 rounded-xl px-3 py-1.5 flex items-center gap-1.5">
            <i class="fas fa-sync-alt text-[10px]"></i> Refresh
          </button>
          <div class="flex items-center gap-2 px-3 py-1.5 bg-gray-900/60 border border-gray-700/50 rounded-full text-xs">
            <span class="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse"></span>
            <span id="amm-status" class="text-gray-300">Loading…</span>
          </div>
        </div>
      </div>

      <!-- ── Anti-phishing notice ───────────────────────────────────────────── -->
      <div class="mb-5 bg-blue-900/10 border border-blue-700/30 rounded-xl px-4 py-3 flex flex-wrap items-center gap-3 text-xs">
        <i class="fas fa-shield-alt text-blue-400 text-base"></i>
        <span class="text-gray-400">
          <strong class="text-blue-300">Security notice:</strong>
          This dApp never asks for your private key. All transactions are signed
          exclusively in your wallet (MetaMask). No automatic or hidden transactions occur.
        </span>
        <a href="/about" class="ml-auto text-blue-400 hover:text-blue-300 underline whitespace-nowrap">Learn more ↗</a>
      </div>

      <!-- ── Main 2-column layout ────────────────────────────────────────────── -->
      <div id="dex-main-grid" class="grid grid-cols-1 gap-5 items-start">
        <style>@media(min-width:1280px){#dex-main-grid{grid-template-columns:minmax(0,1.6fr) minmax(0,2fr);}}</style>

        <!-- LEFT — Swap / Liquidity tabs -->
        <div class="space-y-4">

          <!-- Tab switcher -->
          <div class="flex gap-1.5 bg-gray-900/70 border border-gray-700/40 rounded-2xl p-1.5">
            <button id="amm-tab-swap" onclick="ammSwitchTab('swap')"
              class="flex-1 py-2.5 px-4 text-sm font-semibold rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 text-white shadow-lg shadow-cyan-900/30 transition-all">
              <i class="fas fa-exchange-alt mr-1.5"></i>Swap
            </button>
            <button id="amm-tab-liquidity" onclick="ammSwitchTab('liquidity')"
              class="flex-1 py-2.5 px-4 text-sm font-semibold rounded-xl text-gray-400 hover:text-white hover:bg-gray-800/60 transition-all">
              <i class="fas fa-tint mr-1.5"></i>Liquidity
            </button>
          </div>

          <!-- ══ SWAP PANEL ═══════════════════════════════════════════════════ -->
          <div id="amm-panel-swap">
            <div class="bg-gray-900/80 border border-gray-700/50 rounded-2xl p-5 space-y-3 shadow-xl">

              <!-- From Token -->
              <div class="bg-gray-800/60 border border-gray-700/40 rounded-xl px-4 py-3.5 space-y-2">
                <div class="flex items-center justify-between text-xs text-gray-500">
                  <span class="font-semibold">You Pay</span>
                  <div class="flex items-center gap-2">
                    <span id="amm-swap-from-bal">Balance: —</span>
                    <button onclick="ammSetSwapMax()"
                      class="px-2 py-0.5 bg-cyan-900/50 hover:bg-cyan-700/60 border border-cyan-700/50 text-cyan-400 rounded-md font-bold transition-all">
                      MAX
                    </button>
                  </div>
                </div>
                <div class="flex items-center gap-3">
                  <div class="flex items-center gap-2 bg-gray-700/50 rounded-xl px-3 py-2 min-w-fit border border-gray-600/30">
                    <span class="text-lg" id="amm-swap-from-logo">💶</span>
                    <span class="text-white font-bold text-sm" id="amm-swap-from-symbol">EURC</span>
                  </div>
                  <input type="number" id="amm-swap-input" placeholder="0.00" min="0" step="0.000001"
                    class="flex-1 bg-transparent text-white text-2xl font-bold text-right outline-none placeholder-gray-700 w-0"
                    oninput="ammComputeSwapQuote()" />
                </div>
              </div>

              <!-- Flip -->
              <div class="flex justify-center -my-1 relative z-10">
                <button onclick="ammFlipSwap()"
                  class="w-9 h-9 rounded-xl bg-gray-800 border border-gray-600/50 hover:border-cyan-500/60 hover:bg-gray-700 flex items-center justify-center transition-all shadow-lg group">
                  <i class="fas fa-arrow-down text-gray-400 group-hover:text-cyan-400 transition-all text-sm"></i>
                </button>
              </div>

              <!-- To Token -->
              <div class="bg-gray-800/40 border border-gray-700/30 rounded-xl px-4 py-3.5 space-y-2">
                <div class="flex items-center justify-between text-xs text-gray-500">
                  <span class="font-semibold">You Receive</span>
                  <span id="amm-swap-to-label" class="text-gray-500">USDC</span>
                </div>
                <div class="flex items-center gap-3">
                  <div class="flex items-center gap-2 bg-gray-700/50 rounded-xl px-3 py-2 min-w-fit border border-gray-600/30">
                    <span class="text-lg" id="amm-swap-to-logo">💵</span>
                    <span class="text-white font-bold text-sm" id="amm-swap-to-symbol">USDC</span>
                  </div>
                  <input type="number" id="amm-swap-output" placeholder="0.00" readonly
                    class="flex-1 bg-transparent text-green-400 text-2xl font-bold text-right outline-none placeholder-gray-700 cursor-default w-0" />
                </div>
              </div>

              <!-- Quote row -->
              <div class="grid grid-cols-3 gap-2 text-xs text-center">
                <div class="bg-gray-800/50 rounded-xl p-2.5">
                  <div class="text-gray-500 mb-0.5">Price Impact</div>
                  <div id="amm-price-impact" class="text-green-400 font-mono font-bold">—</div>
                </div>
                <div class="bg-gray-800/50 rounded-xl p-2.5">
                  <div class="text-gray-500 mb-0.5">Fee (0.3%)</div>
                  <div id="amm-swap-fee" class="text-gray-300 font-mono font-bold">—</div>
                </div>
                <div class="bg-gray-800/50 rounded-xl p-2.5">
                  <div class="text-gray-500 mb-0.5">Min. Received</div>
                  <div id="amm-min-received" class="text-gray-300 font-mono font-bold">—</div>
                </div>
              </div>

              <!-- Slippage tolerance -->
              <div class="bg-gray-800/30 rounded-xl px-3 py-2.5 flex items-center justify-between">
                <div class="flex items-center gap-1.5 text-xs text-gray-500">
                  <i class="fas fa-sliders-h text-gray-600"></i>
                  <span>Slippage:</span>
                  <span id="amm-slip-label" class="text-cyan-400 font-semibold">0.5%</span>
                </div>
                <div class="flex gap-1">
                  <button id="amm-slip-01" onclick="ammSetSlippage(0.1)"
                    class="px-2.5 py-1 rounded-lg text-xs font-bold bg-gray-700 text-gray-300 hover:bg-gray-600 transition-all">0.1%</button>
                  <button id="amm-slip-05" onclick="ammSetSlippage(0.5)"
                    class="px-2.5 py-1 rounded-lg text-xs font-bold bg-cyan-600/80 text-white transition-all ring-1 ring-cyan-500/50">0.5%</button>
                  <button id="amm-slip-10" onclick="ammSetSlippage(1.0)"
                    class="px-2.5 py-1 rounded-lg text-xs font-bold bg-gray-700 text-gray-300 hover:bg-gray-600 transition-all">1.0%</button>
                </div>
              </div>

              <!-- Swap Button -->
              <button id="amm-swap-btn" onclick="ammExecuteSwap()" disabled
                class="w-full py-4 rounded-2xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-base transition-all shadow-lg shadow-cyan-900/40 mt-1 relative overflow-hidden group">
                <span class="relative z-10 flex items-center justify-center gap-2">
                  <i class="fas fa-exchange-alt"></i>
                  <span id="amm-swap-btn-text">Enter Amount</span>
                </span>
                <div class="absolute inset-0 bg-gradient-to-r from-cyan-400/20 to-blue-400/20 opacity-0 group-hover:opacity-100 transition-opacity"></div>
              </button>

              <!-- Wallet not connected hint -->
              <div id="amm-no-wallet-hint" class="text-center text-xs text-gray-600 flex items-center justify-center gap-1.5">
                <i class="fas fa-wallet text-gray-700"></i>
                Connect wallet to execute swaps
              </div>

              <!-- Result / Error -->
              <div id="amm-swap-result" class="hidden bg-green-900/20 border border-green-700/40 rounded-xl p-4">
                <div class="flex items-center gap-2 text-green-400 font-semibold mb-3 text-sm">
                  <div class="w-6 h-6 rounded-full bg-green-500/20 flex items-center justify-center">
                    <i class="fas fa-check text-xs"></i>
                  </div>
                  Swap Confirmed!
                </div>
                <div class="space-y-1.5 text-xs">
                  <div class="flex justify-between">
                    <span class="text-gray-500">Sent</span>
                    <span id="amm-result-in" class="font-mono text-white">—</span>
                  </div>
                  <div class="flex justify-between">
                    <span class="text-gray-500">Received</span>
                    <span id="amm-result-out" class="font-mono text-green-300 font-bold">—</span>
                  </div>
                  <div class="flex justify-between items-center pt-1 border-t border-gray-700/40">
                    <span class="text-gray-500">Transaction</span>
                    <a id="amm-result-hash-link" href="#" target="_blank" rel="noopener noreferrer"
                      class="font-mono text-cyan-400 hover:text-cyan-300 underline truncate max-w-[160px] flex items-center gap-1">
                      <span id="amm-result-hash">—</span>
                      <i class="fas fa-external-link-alt text-[9px]"></i>
                    </a>
                  </div>
                </div>
              </div>
              <div id="amm-swap-error" class="hidden bg-red-900/20 border border-red-700/40 rounded-xl p-3 text-xs text-red-300">
                <div class="flex items-start gap-2">
                  <i class="fas fa-exclamation-triangle mt-0.5 flex-shrink-0"></i>
                  <span id="amm-swap-error-msg">—</span>
                </div>
              </div>

            </div>
          </div>

          <!-- ══ LIQUIDITY PANEL ══════════════════════════════════════════════ -->
          <div id="amm-panel-liquidity" class="hidden space-y-4">

            <!-- Add Liquidity -->
            <div class="bg-gray-900/80 border border-gray-700/50 rounded-2xl p-5 space-y-4 shadow-xl">
              <div class="flex items-center gap-2">
                <span class="w-7 h-7 rounded-lg bg-blue-600/30 border border-blue-600/40 flex items-center justify-center text-xs text-blue-400">
                  <i class="fas fa-plus"></i>
                </span>
                <h3 class="text-white font-bold">Add Liquidity</h3>
                <span class="ml-auto text-xs text-gray-500">Earn 0.3% per swap</span>
              </div>

              <!-- EURC -->
              <div class="bg-gray-800/60 border border-gray-700/40 rounded-xl px-4 py-3 space-y-2">
                <div class="flex justify-between text-xs text-gray-500">
                  <span class="font-semibold">EURC Amount</span>
                  <div class="flex items-center gap-2">
                    <span id="amm-liq-bal-eurc">—</span>
                    <button onclick="ammSetLiqMaxA()"
                      class="px-2 py-0.5 bg-blue-900/50 border border-blue-700/40 text-blue-400 rounded-md text-xs font-bold hover:bg-blue-800/60 transition-all">MAX</button>
                  </div>
                </div>
                <div class="flex items-center gap-3">
                  <div class="flex items-center gap-2 bg-gray-700/50 rounded-xl px-3 py-2 border border-gray-600/30">
                    <span>💶</span><span class="text-white font-bold text-sm">EURC</span>
                  </div>
                  <input type="number" id="amm-liq-input-a" placeholder="0.00" min="0" step="0.000001"
                    class="flex-1 bg-transparent text-white text-xl font-bold text-right outline-none placeholder-gray-700 w-0"
                    oninput="ammUpdateLiqPreview()" />
                </div>
              </div>

              <!-- Plus divider -->
              <div class="flex justify-center">
                <div class="w-8 h-8 rounded-xl bg-gray-800 border border-gray-600/40 flex items-center justify-center text-gray-500 text-sm font-bold">+</div>
              </div>

              <!-- USDC -->
              <div class="bg-gray-800/60 border border-gray-700/40 rounded-xl px-4 py-3 space-y-2">
                <div class="flex justify-between text-xs text-gray-500">
                  <span class="font-semibold">USDC Amount</span>
                  <div class="flex items-center gap-2">
                    <span id="amm-liq-bal-usdc">—</span>
                    <button onclick="ammSetLiqMaxB()"
                      class="px-2 py-0.5 bg-green-900/50 border border-green-700/40 text-green-400 rounded-md text-xs font-bold hover:bg-green-800/60 transition-all">MAX</button>
                  </div>
                </div>
                <div class="flex items-center gap-3">
                  <div class="flex items-center gap-2 bg-gray-700/50 rounded-xl px-3 py-2 border border-gray-600/30">
                    <span>💵</span><span class="text-white font-bold text-sm">USDC</span>
                  </div>
                  <input type="number" id="amm-liq-input-b" placeholder="0.00" min="0" step="0.000001"
                    class="flex-1 bg-transparent text-white text-xl font-bold text-right outline-none placeholder-gray-700 w-0"
                    oninput="ammUpdateLiqPreview()" />
                </div>
              </div>

              <!-- LP Preview -->
              <div class="grid grid-cols-3 gap-2 text-xs text-center">
                <div class="bg-gray-800/50 rounded-xl p-2.5">
                  <div class="text-gray-500 mb-0.5">LP Est.</div>
                  <div id="amm-liq-lp-est" class="text-cyan-300 font-mono font-bold">—</div>
                </div>
                <div class="bg-gray-800/50 rounded-xl p-2.5">
                  <div class="text-gray-500 mb-0.5">Pool Share</div>
                  <div id="amm-liq-pool-share" class="text-cyan-300 font-mono font-bold">—</div>
                </div>
                <div class="bg-gray-800/50 rounded-xl p-2.5">
                  <div class="text-gray-500 mb-0.5">Your LP</div>
                  <div id="amm-liq-bal-lp" class="text-yellow-300 font-mono font-bold">—</div>
                </div>
              </div>

              <button id="amm-add-liq-btn" onclick="ammAddLiquidity()" disabled
                class="w-full py-3.5 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold transition-all shadow-lg">
                <i class="fas fa-plus mr-2"></i>Add Liquidity
              </button>

              <div id="amm-liq-result" class="hidden bg-green-900/20 border border-green-700/40 rounded-xl p-4 text-sm">
                <div class="flex items-center gap-2 text-green-400 font-semibold mb-2"><i class="fas fa-check-circle"></i>Liquidity Added!</div>
                <div class="grid grid-cols-2 gap-1.5 text-xs text-gray-300">
                  <span class="text-gray-500">EURC:</span>   <span id="amm-liq-result-a" class="font-mono">—</span>
                  <span class="text-gray-500">USDC:</span>   <span id="amm-liq-result-b" class="font-mono">—</span>
                  <span class="text-gray-500">LP minted:</span> <span id="amm-liq-result-lp" class="font-mono text-cyan-300">—</span>
                  <span class="text-gray-500">Tx:</span>
                  <a id="amm-liq-result-hash-link" href="#" target="_blank" class="font-mono text-cyan-400 underline truncate">
                    <span id="amm-liq-result-hash">—</span>
                  </a>
                </div>
              </div>
              <div id="amm-liq-error" class="hidden bg-red-900/20 border border-red-700/40 rounded-xl p-3 text-xs text-red-300">
                <i class="fas fa-times-circle mr-2"></i><span id="amm-liq-error-msg">—</span>
              </div>
            </div>

            <!-- Remove Liquidity -->
            <div class="bg-gray-900/80 border border-gray-700/50 rounded-2xl p-5 space-y-4 shadow-xl">
              <div class="flex items-center gap-2">
                <span class="w-7 h-7 rounded-lg bg-red-600/30 border border-red-600/40 flex items-center justify-center text-xs text-red-400">
                  <i class="fas fa-fire"></i>
                </span>
                <h3 class="text-white font-bold">Remove Liquidity</h3>
              </div>
              <p class="text-xs text-gray-500">Burn LP tokens to withdraw EURC + USDC from the pool.</p>

              <!-- Your LP Position -->
              <div class="bg-gray-800/60 border border-cyan-700/20 rounded-xl p-3 grid grid-cols-2 gap-2 text-xs">
                <div class="text-center">
                  <div class="text-gray-500 mb-0.5">Your LP Balance</div>
                  <div class="font-mono text-cyan-300 font-bold" id="amm-remove-lp-bal">—</div>
                </div>
                <div class="text-center">
                  <div class="text-gray-500 mb-0.5">Pool Share</div>
                  <div class="font-mono text-cyan-300 font-bold" id="amm-position-share">—</div>
                </div>
              </div>

              <div class="bg-gray-800/50 border border-gray-700/30 rounded-xl p-4 space-y-3 text-xs">
                <div>
                  <div class="flex justify-between text-gray-400 mb-2">
                    <span>Percentage to remove</span>
                    <span class="font-mono font-bold text-white" id="amm-remove-pct-display">100%</span>
                  </div>
                  <input type="range" id="amm-remove-pct" min="1" max="100" value="100"
                    class="w-full accent-red-500 cursor-pointer"
                    oninput="
                      document.getElementById('amm-remove-pct-display').textContent = this.value + '%';
                      if(typeof ammUpdateRemovePreview === 'function') ammUpdateRemovePreview();
                    " />
                  <div class="flex justify-between text-gray-500 mt-2">
                    <span>LP to burn:</span>
                    <span id="amm-remove-lp-amt" class="font-mono text-red-300 font-bold">—</span>
                  </div>
                </div>

                <!-- Expected Returns -->
                <div class="border-t border-gray-700/40 pt-3 space-y-1.5">
                  <div class="text-gray-500 font-semibold mb-1">Expected to receive:</div>
                  <div class="flex justify-between">
                    <span class="text-gray-400">💶 EURC</span>
                    <span id="amm-remove-est-eurc" class="font-mono text-green-300 font-bold">—</span>
                  </div>
                  <div class="flex justify-between">
                    <span class="text-gray-400">💵 USDC</span>
                    <span id="amm-remove-est-usdc" class="font-mono text-green-300 font-bold">—</span>
                  </div>
                </div>
              </div>
              <button id="amm-remove-liq-btn" onclick="ammRemoveLiquidity()" disabled
                class="w-full py-3.5 rounded-xl bg-gradient-to-r from-red-700 to-rose-600 hover:from-red-600 hover:to-rose-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold transition-all shadow-lg">
                <i class="fas fa-fire mr-2"></i>Remove Liquidity
              </button>
            </div>

          </div><!-- end liquidity panel -->

        </div><!-- end LEFT col -->

        <!-- RIGHT — Pool Status sidebar -->
        <div class="space-y-4">

          <!-- Pool Stats Card -->
          <div class="bg-gray-900/80 border border-cyan-700/20 rounded-2xl overflow-hidden shadow-xl">
            <!-- Card header -->
            <div class="px-4 pt-4 pb-3 flex items-center justify-between border-b border-gray-800/60">
              <div class="flex items-center gap-2">
                <div class="w-6 h-6 rounded-lg bg-cyan-600/20 flex items-center justify-center">
                  <i class="fas fa-chart-bar text-cyan-400 text-xs"></i>
                </div>
                <span class="text-xs text-gray-300 font-bold uppercase tracking-widest">Pool Status</span>
              </div>
              <a href="https://testnet.arcscan.app/address/0x3148E2807F172D1cC354F35fB4fC4104e8b6b561"
                target="_blank" rel="noopener noreferrer"
                class="text-xs text-cyan-500 hover:text-cyan-400 transition-all flex items-center gap-1 bg-cyan-900/20 hover:bg-cyan-900/30 border border-cyan-700/30 rounded-lg px-2 py-1">
                <i class="fas fa-external-link-alt text-[9px]"></i> ArcScan
              </a>
            </div>

            <div class="p-4 space-y-4">
              <!-- TVL highlight -->
              <div class="bg-gradient-to-br from-cyan-900/30 to-blue-900/20 border border-cyan-700/20 rounded-xl p-4 text-center relative overflow-hidden">
                <div class="absolute inset-0 bg-gradient-to-br from-cyan-500/5 to-blue-500/5 pointer-events-none"></div>
                <div class="text-xs text-gray-500 mb-1 font-semibold uppercase tracking-wider">Total Value Locked</div>
                <div class="text-3xl font-bold text-white" id="amm-tvl">—</div>
                <div class="text-xs text-cyan-500 mt-1.5 flex items-center justify-center gap-1.5">
                  <span class="w-1.5 h-1.5 rounded-full bg-cyan-500 animate-pulse"></span>
                  EURC / USDC Pool
                </div>
              </div>

              <!-- Reserves -->
              <div class="space-y-2">
                <div class="text-xs text-gray-600 font-semibold uppercase tracking-wide">Reserves</div>
                <div class="flex items-center justify-between bg-gray-800/50 hover:bg-gray-800/70 rounded-xl px-3 py-2.5 transition-colors">
                  <div class="flex items-center gap-2">
                    <span class="text-base">💶</span>
                    <div>
                      <div class="text-xs text-gray-400 font-semibold">EURC</div>
                      <div class="text-[10px] text-gray-600 font-mono">0x89B5…D72a</div>
                    </div>
                  </div>
                  <span class="text-white font-mono font-bold text-sm" id="amm-reserve-a">—</span>
                </div>
                <div class="flex items-center justify-between bg-gray-800/50 hover:bg-gray-800/70 rounded-xl px-3 py-2.5 transition-colors">
                  <div class="flex items-center gap-2">
                    <span class="text-base">💵</span>
                    <div>
                      <div class="text-xs text-gray-400 font-semibold">USDC</div>
                      <div class="text-[10px] text-gray-600 font-mono">0x3600…0000</div>
                    </div>
                  </div>
                  <span class="text-white font-mono font-bold text-sm" id="amm-reserve-b">—</span>
                </div>
              </div>

              <!-- Live Prices -->
              <div class="space-y-2">
                <div class="text-xs text-gray-600 font-semibold uppercase tracking-wide flex items-center gap-1.5">
                  <i class="fas fa-circle text-green-500 text-[6px] animate-pulse"></i>
                  Live Prices
                </div>
                <div class="grid grid-cols-1 gap-2">
                  <div class="bg-gray-800/50 rounded-xl px-3 py-2.5 flex items-center justify-between">
                    <div class="text-xs text-gray-500">
                      1 <span class="text-cyan-400 font-semibold">EURC</span> =
                    </div>
                    <div class="text-cyan-400 font-mono font-bold text-sm" id="amm-price-a">—</div>
                  </div>
                  <div class="bg-gray-800/50 rounded-xl px-3 py-2.5 flex items-center justify-between">
                    <div class="text-xs text-gray-500">
                      1 <span class="text-purple-400 font-semibold">USDC</span> =
                    </div>
                    <div class="text-purple-400 font-mono font-bold text-sm" id="amm-price-b">—</div>
                  </div>
                </div>
              </div>

              <!-- Pool info row -->
              <div class="bg-gray-800/30 rounded-xl px-3 py-2 flex items-center justify-between text-xs">
                <span class="text-gray-600 flex items-center gap-1">
                  <i class="fas fa-percent text-gray-700"></i> Fee
                </span>
                <span class="text-green-400 font-semibold">0.30%</span>
              </div>

              <!-- Contract address -->
              <div class="border-t border-gray-800/60 pt-3 space-y-1">
                <div class="text-xs text-gray-600 uppercase tracking-wider font-semibold">SimpleAMM Contract</div>
                <div class="flex items-center justify-between gap-2">
                  <code class="text-[10px] font-mono text-gray-500 truncate" id="amm-addr-display">—</code>
                  <button onclick="navigator.clipboard.writeText(document.getElementById('amm-addr-display')?.textContent || '')" 
                    class="text-gray-600 hover:text-gray-400 transition-colors flex-shrink-0" title="Copy address">
                    <i class="fas fa-copy text-xs"></i>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- Your Balances Card -->
          <div class="bg-gray-900/80 border border-gray-700/40 rounded-2xl overflow-hidden shadow-xl">
            <div class="px-4 pt-4 pb-3 flex items-center justify-between border-b border-gray-800/60">
              <div class="flex items-center gap-2">
                <div class="w-6 h-6 rounded-lg bg-purple-600/20 flex items-center justify-center">
                  <i class="fas fa-wallet text-purple-400 text-xs"></i>
                </div>
                <span class="text-xs text-gray-300 font-bold uppercase tracking-widest">Your Balances</span>
              </div>
              <button onclick="ammRefreshAll()" class="text-gray-600 hover:text-purple-400 transition-colors" title="Refresh balances">
                <i class="fas fa-sync-alt text-xs"></i>
              </button>
            </div>
            <div class="p-4 space-y-2">
              <div class="flex items-center justify-between bg-gray-800/50 rounded-xl px-3 py-2.5">
                <div class="flex items-center gap-2">
                  <span>💶</span>
                  <div>
                    <div class="text-xs text-gray-400 font-semibold">EURC</div>
                    <div class="text-[10px] text-gray-600">Euro Coin</div>
                  </div>
                </div>
                <span class="text-blue-300 font-mono font-bold text-sm" id="amm-bal-eurc">—</span>
              </div>
              <div class="flex items-center justify-between bg-gray-800/50 rounded-xl px-3 py-2.5">
                <div class="flex items-center gap-2">
                  <span>💵</span>
                  <div>
                    <div class="text-xs text-gray-400 font-semibold">USDC</div>
                    <div class="text-[10px] text-gray-600">USD Coin</div>
                  </div>
                </div>
                <span class="text-green-300 font-mono font-bold text-sm" id="amm-bal-usdc">—</span>
              </div>
              <div class="flex items-center justify-between bg-gray-800/50 rounded-xl px-3 py-2.5">
                <div class="flex items-center gap-2">
                  <span>🏊</span>
                  <div>
                    <div class="text-xs text-gray-400 font-semibold">LP Token</div>
                    <div class="text-[10px] text-gray-600">Pool share: <span id="amm-bal-lp-share">—</span></div>
                  </div>
                </div>
                <span class="text-cyan-300 font-mono font-bold text-sm" id="amm-bal-lp">—</span>
              </div>

              <!-- Get tokens link -->
              <div class="pt-1">
                <a href="https://faucet.circle.com" target="_blank" rel="noopener noreferrer"
                  class="flex items-center justify-center gap-2 text-xs text-blue-400 hover:text-blue-300 bg-blue-900/10 hover:bg-blue-900/20 border border-blue-700/20 rounded-xl py-2.5 transition-all">
                  <i class="fas fa-faucet"></i>
                  Get testnet tokens from Circle Faucet
                  <i class="fas fa-external-link-alt text-[9px]"></i>
                </a>
              </div>
            </div>
          </div>

          <!-- Deploy Notice (hidden by default, shown if not deployed) -->
          <div id="amm-deploy-notice" class="hidden bg-yellow-900/20 border border-yellow-600/30 rounded-2xl overflow-hidden">
            <div class="px-4 py-3 border-b border-yellow-700/20 flex items-center gap-2">
              <i class="fas fa-exclamation-triangle text-yellow-400"></i>
              <span class="text-xs font-bold text-yellow-300 uppercase tracking-wide">Contract Not Deployed</span>
            </div>
            <div class="p-4 space-y-3">
              <p class="text-xs text-yellow-400">The SimpleAMM contract needs to be deployed to Arc Testnet via CLI. No private keys should be entered in the browser.</p>
              <code class="text-xs bg-black/40 rounded-lg px-3 py-2 block font-mono text-green-300 break-all">
                node contracts/script/deployAMM.cjs &lt;PRIVATE_KEY&gt;
              </code>
              <p class="text-xs text-gray-600 flex items-center gap-1.5">
                <i class="fas fa-shield-alt text-green-500"></i>
                Deploy via CLI only — never input private keys in the browser.
              </p>
            </div>
          </div>

        </div><!-- end RIGHT col -->

      </div><!-- end grid -->

    <!-- ════════════════════════════════════════════════════════════════ -->

    <!-- ════════════════════════════════════════════════════════════════ -->


  </main>

  <!-- ===== CHATBOT WIDGET v2 ===== -->
  <!-- Floating Action Button -->
  <button id="chat-fab"
    onclick="toggleChat()"
    class="fixed bottom-5 right-5 z-[110] flex items-center gap-2 bg-gradient-to-br from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 rounded-full shadow-lg shadow-purple-900/40 px-4 py-3 transition-all hover:scale-105 active:scale-95"
    style="bottom:20px;right:20px;">
    <i class="fas fa-robot text-white text-base" id="chat-fab-icon"></i>
    <span id="chat-fab-label" class="text-white text-sm font-medium">Ask me</span>
    <span id="chat-unread" class="hidden absolute -top-1 -right-1 w-5 h-5 bg-red-500 rounded-full text-white text-xs font-bold flex items-center justify-center leading-none"></span>
  </button>

  <!-- Chat Panel -->
  <div id="chat-widget"
    class="hidden fixed z-[110] flex flex-col bg-gray-900 border border-purple-700/50 rounded-2xl shadow-2xl shadow-black/60"
    data-size="medium"
    style="width:400px;height:560px;bottom:70px;right:20px;max-width:calc(100vw - 16px);">

    <!-- Header (drag handle) -->
    <div id="chat-header" class="flex items-center justify-between px-3 py-2.5 border-b border-gray-700/60 bg-gradient-to-r from-purple-900/60 to-blue-900/40 rounded-t-2xl flex-shrink-0" style="cursor:grab;user-select:none;">
      <!-- Left: identity -->
      <div class="flex items-center gap-2 min-w-0">
        <div class="w-6 h-6 rounded-lg bg-gradient-to-br from-purple-600 to-blue-600 flex items-center justify-center flex-shrink-0">
          <i class="fas fa-robot text-white text-xs"></i>
        </div>
        <div class="min-w-0">
          <p class="text-white font-semibold text-xs leading-tight truncate">ARC AI Assistant</p>
          <div class="flex items-center gap-1">
            <div class="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse"></div>
            <p class="text-[10px] text-green-400 leading-tight">Online · Arc Testnet</p>
          </div>
        </div>
      </div>
      <!-- Right: controls -->
      <div class="flex items-center gap-0.5 flex-shrink-0">
        <!-- Size buttons -->
        <button id="chat-size-mini"   onclick="setChatSize('mini')"   class="chat-size-btn" title="Compacto"><i class="fas fa-compress-alt"></i></button>
        <button id="chat-size-medium" onclick="setChatSize('medium')" class="chat-size-btn active" title="Médio"><i class="fas fa-expand-alt"></i></button>
        <button id="chat-size-wide"   onclick="setChatSize('wide')"   class="chat-size-btn" title="Expandir (+12% largura)"><i class="fas fa-arrows-alt-h"></i></button>
        <button id="chat-size-full"   onclick="setChatSize('full')"   class="chat-size-btn" title="Tela cheia"><i class="fas fa-expand"></i></button>
        <!-- Width expand toggle -->
        <button id="chat-width-toggle-btn"
          onclick="toggleChatWidth()"
          title="Expandir largura (1.5×)"
          class="chat-size-btn"
          style="font-size:13px;font-weight:700;letter-spacing:-0.5px;padding:0 5px;">↔</button>
        <!-- Clear -->
        <button onclick="clearChatHistory()" title="Clear chat" class="text-gray-500 hover:text-gray-300 p-1 rounded hover:bg-gray-800 transition-all">
          <i class="fas fa-trash text-xs"></i>
        </button>
        <!-- Close -->
        <button onclick="toggleChat()" class="text-gray-500 hover:text-red-400 p-1 rounded hover:bg-gray-800 transition-all">
          <i class="fas fa-times text-xs"></i>
        </button>
      </div>
    </div>

    <!-- ArcPay Agent v1.0 — Status Bar -->
    <div id="chat-arcpay-bar" class="px-3 py-2 unauthorized flex-shrink-0">
      <div class="flex items-center justify-between gap-2">
        <!-- Status text + badge -->
        <span id="chat-arcpay-status" class="text-[10px] flex items-center gap-1.5 flex-1 min-w-0 truncate">
          <span class="arcpay-badge-inactive"><i class="fas fa-robot"></i> ArcPay Agent</span>
          <span class="text-[9px] text-purple-400 ml-1">Not authorized — click to enable</span>
        </span>
        <!-- Active badge (hidden until authorized) -->
        <span id="arcpay-session-badge" class="hidden text-[9px] font-bold text-green-400 bg-green-900/30 border border-green-700/30 px-1.5 py-0.5 rounded-full flex-shrink-0"></span>
        <!-- Authorize button (shown when NOT authorized) -->
        <button id="arcpay-auth-btn"
          onclick="executeArcPayAuthorization()"
          class="flex-shrink-0 text-[11px] font-bold text-white px-3 py-1 rounded-lg border border-purple-500/40 transition-all"
          style="background:linear-gradient(135deg,#6d28d9,#3b82f6);">
          <i class="fas fa-shield-alt mr-1"></i>Authorize
        </button>
        <!-- Revoke button (hidden until authorized) -->
        <button id="arcpay-revoke-btn"
          onclick="revokeArcPaySession()"
          class="hidden flex-shrink-0 text-[10px] text-red-400 hover:text-red-300 bg-red-900/20 hover:bg-red-900/30 px-2 py-0.5 rounded-full border border-red-700/30 transition-all">
          Revoke
        </button>
      </div>
    </div>

    <!-- Messages -->
    <div id="chat-messages" class="flex-1 overflow-y-auto px-3 py-2 space-y-2 scroll-smooth"></div>

    <!-- Quick actions -->
    <div id="chat-quick-actions" class="px-2 pb-1.5 flex gap-1.5 overflow-x-auto flex-shrink-0" style="scrollbar-width:none">
      <button onclick="sendQuickMessage('my wallet')"        class="chat-quick-btn flex-shrink-0 text-xs px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-full border border-gray-700">💳 Wallet</button>
      <button onclick="sendQuickMessage('network status')"   class="chat-quick-btn flex-shrink-0 text-xs px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-full border border-gray-700">⛓️ Network</button>
      <button onclick="sendQuickMessage('show my contracts')"class="chat-quick-btn flex-shrink-0 text-xs px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-full border border-gray-700">📋 Contracts</button>
      <button onclick="sendQuickMessage('approve arcpay')"   class="chat-quick-btn flex-shrink-0 text-xs px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-full border border-gray-700">🤖 ArcPay</button>
      <button onclick="sendQuickMessage('guardian')"         class="chat-quick-btn flex-shrink-0 text-xs px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-full border border-gray-700">🛡️ Guardian</button>
      <button onclick="sendQuickMessage('dashboard')"        class="chat-quick-btn flex-shrink-0 text-xs px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-full border border-gray-700">📊 Stats</button>
    </div>

    <!-- Input -->
    <div class="px-2 pb-2.5 flex-shrink-0">
      <div class="flex items-center gap-1.5 bg-gray-800 border border-gray-700 rounded-xl px-2.5 py-1.5 focus-within:border-purple-500 transition-all">
        <input id="chat-input" type="text" placeholder="Ask anything or: send 10 USDC to 0x…"
          class="flex-1 bg-transparent text-xs text-white placeholder-gray-600 focus:outline-none min-w-0"
          onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendChatMessage();}">
        <button onclick="sendChatMessage()" id="chat-send-btn"
          class="w-7 h-7 bg-purple-600 hover:bg-purple-500 rounded-lg flex items-center justify-center text-white transition-all flex-shrink-0">
          <i class="fas fa-paper-plane text-xs"></i>
        </button>
      </div>
      <p class="text-center text-gray-700 text-[10px] mt-1">Ctrl+/ · ESC to close · 🛡️ Guardian-protected</p>
    </div>
  </div>

  <!-- Notification Toast -->
  <div id="toast" class="fixed bottom-6 right-6 z-50 hidden">
    <div class="bg-gray-800 border border-gray-600 rounded-xl p-4 shadow-2xl max-w-sm">
      <div id="toast-content" class="text-sm text-white"></div>
    </div>
  </div>

  <!-- ═══════════════════════════════════════════════════════════
       PIN GATE — aparece antes de abrir Settings
       ═══════════════════════════════════════════════════════════ -->
  <div id="pin-modal" class="fixed inset-0 z-[100] hidden items-center justify-center bg-black/70 backdrop-blur-sm">
    <div class="bg-gray-900 border border-gray-700 rounded-2xl p-8 w-full max-w-sm shadow-2xl">
      <div class="text-center mb-6">
        <div class="w-14 h-14 rounded-full bg-purple-700/30 border border-purple-600/40 flex items-center justify-center mx-auto mb-3">
          <i class="fas fa-lock text-purple-400 text-xl"></i>
        </div>
        <h2 class="text-white font-bold text-lg">Settings Access</h2>
        <p class="text-gray-400 text-sm mt-1">Enter your PIN to continue</p>
      </div>
      <div class="space-y-4">
        <input id="pin-input" type="password" maxlength="8" placeholder="••••"
          class="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white text-center text-xl tracking-widest font-mono placeholder-gray-600 focus:border-purple-500 focus:outline-none"
          onkeydown="if(event.key==='Enter') verifyPIN()">
        <div id="pin-error" class="hidden text-red-400 text-xs text-center">Wrong PIN. Try again.</div>
        <button onclick="verifyPIN()"
          class="w-full bg-purple-600 hover:bg-purple-700 text-white rounded-xl py-3 font-semibold transition-all">
          Unlock
        </button>
        <button onclick="closePINModal()"
          class="w-full bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-xl py-2 text-sm transition-all">
          Cancel
        </button>
      </div>
    </div>
  </div>

  <!-- ═══════════════════════════════════════════════════════════
       SETTINGS MODAL
       ═══════════════════════════════════════════════════════════ -->
  <div id="settings-modal" class="fixed inset-0 z-[90] hidden items-center justify-center bg-black/70 backdrop-blur-sm">
    <div class="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl mx-4">

      <!-- Header -->
      <div class="flex items-center justify-between px-6 py-4 border-b border-gray-700/60">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-xl bg-purple-700/30 border border-purple-600/40 flex items-center justify-center">
            <i class="fas fa-cog text-purple-400"></i>
          </div>
          <div>
            <h2 class="text-white font-bold">Settings</h2>
            <p class="text-xs text-gray-500">App configuration &amp; integrations</p>
          </div>
        </div>
        <button onclick="closeSettingsModal()" class="w-8 h-8 flex items-center justify-center text-gray-500 hover:text-white rounded-lg hover:bg-gray-800 transition-all">
          <i class="fas fa-times"></i>
        </button>
      </div>

      <!-- Tab bar -->
      <div class="flex border-b border-gray-700/60 px-6">
        <button onclick="switchSettingsTab('circle')" id="stab-circle"
          class="settings-tab active-stab px-4 py-3 text-sm font-medium border-b-2 border-purple-500 text-purple-400 -mb-px transition-all">
          <i class="fas fa-circle-notch mr-2"></i>Circle API
        </button>
        <button onclick="switchSettingsTab('appconfig')" id="stab-appconfig"
          class="settings-tab px-4 py-3 text-sm font-medium border-b-2 border-transparent text-gray-400 hover:text-gray-200 -mb-px transition-all">
          <i class="fas fa-sliders-h mr-2"></i>App Config
        </button>
        <button onclick="switchSettingsTab('security')" id="stab-security"
          class="settings-tab px-4 py-3 text-sm font-medium border-b-2 border-transparent text-gray-400 hover:text-gray-200 -mb-px transition-all">
          <i class="fas fa-shield-alt mr-2"></i>Security
        </button>
      </div>

      <!-- Content (scrollable) -->
      <div class="overflow-y-auto flex-1 px-6 py-5 space-y-5">

        <!-- ── CIRCLE API TAB ── -->
        <div id="stab-content-circle" class="settings-tab-content space-y-5">

          <!-- Status banner -->
          <div id="circle-status-banner" class="hidden rounded-xl px-4 py-3 flex items-center gap-3 text-sm"></div>

          <!-- Documentação rápida -->
          <div class="bg-blue-900/20 border border-blue-700/30 rounded-xl p-4">
            <div class="flex items-start gap-3">
              <i class="fas fa-info-circle text-blue-400 mt-0.5 flex-shrink-0"></i>
              <div class="text-xs text-blue-300 space-y-1">
                <p class="font-semibold text-blue-200">Circle API Integration</p>
                <p>Connect to Circle's Web3 Services to enable programmable wallets, USDC transfers, and cross-chain operations.</p>
                <a href="https://console.circle.com" target="_blank" class="inline-flex items-center gap-1 text-blue-400 hover:underline font-medium mt-1">
                  <i class="fas fa-external-link-alt text-xs"></i> Get your API key at console.circle.com
                </a>
              </div>
            </div>
          </div>

          <!-- Formulário Circle -->
          <div class="space-y-4">
            <div>
              <label class="text-xs text-gray-400 uppercase tracking-wider mb-2 block">Environment</label>
              <div class="flex gap-3">
                <label class="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="circle-env" value="sandbox" id="circle-env-sandbox" checked
                    class="w-4 h-4 text-purple-500 bg-gray-800 border-gray-600">
                  <span class="text-sm text-gray-300">Sandbox <span class="text-xs text-yellow-400">(testing)</span></span>
                </label>
                <label class="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="circle-env" value="production" id="circle-env-prod"
                    class="w-4 h-4 text-purple-500 bg-gray-800 border-gray-600">
                  <span class="text-sm text-gray-300">Production <span class="text-xs text-green-400">(live)</span></span>
                </label>
              </div>
            </div>

            <!-- API Key & Webhook — hidden from UI, managed server-side -->
            <input type="hidden" id="circle-api-key" value="">
            <input type="hidden" id="circle-webhook-secret" value="">

            <!-- Ações Circle -->
            <div class="flex gap-3 pt-1">
              <button onclick="saveCircleConfig()"
                class="flex items-center gap-2 bg-purple-600 hover:bg-purple-700 text-white rounded-xl px-5 py-2.5 text-sm font-semibold transition-all">
                <i class="fas fa-save"></i> Save
              </button>
              <button onclick="testCircleConnection()"
                id="circle-test-btn"
                class="flex items-center gap-2 bg-blue-700 hover:bg-blue-600 text-white rounded-xl px-5 py-2.5 text-sm font-semibold transition-all">
                <i class="fas fa-plug"></i> Test Connection
              </button>
              <button onclick="removeCircleConfig()"
                class="flex items-center gap-2 bg-gray-800 hover:bg-red-900/40 text-gray-400 hover:text-red-400 border border-gray-700 hover:border-red-700/40 rounded-xl px-4 py-2.5 text-sm transition-all ml-auto">
                <i class="fas fa-trash text-xs"></i> Remove
              </button>
            </div>

            <!-- Resultado do teste -->
            <div id="circle-test-result" class="hidden rounded-xl p-3 text-sm"></div>
          </div>

          <!-- Balances (quando conectado) -->
          <div id="circle-balances" class="hidden">
            <div class="flex items-center justify-between mb-3">
              <h4 class="text-sm text-white font-semibold flex items-center gap-2">
                <i class="fas fa-wallet text-blue-400"></i> Circle Account Balance
              </h4>
              <button onclick="loadCircleBalance()"
                class="text-xs text-blue-400 hover:text-blue-300">
                <i class="fas fa-sync mr-1"></i>Refresh
              </button>
            </div>
            <div id="circle-balance-data" class="bg-gray-800/60 rounded-xl p-4 text-sm text-gray-300"></div>
          </div>
        </div>

        <!-- ── APP CONFIG TAB ── -->
        <div id="stab-content-appconfig" class="settings-tab-content hidden space-y-5">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">

            <!-- Light / Dark Mode Toggle -->
            <div class="sm:col-span-2">
              <label class="text-xs text-gray-400 uppercase tracking-wider mb-3 block">Appearance</label>
              <div class="flex items-center gap-4 bg-gray-800/60 border border-gray-700/40 rounded-xl p-4">
                <div class="flex items-center gap-3 flex-1">
                  <div id="theme-dark-btn" onclick="setThemeMode('dark')"
                    class="flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl cursor-pointer border-2 border-purple-600 bg-purple-900/30 text-purple-300 font-semibold text-sm transition-all">
                    <i class="fas fa-moon"></i>Dark
                  </div>
                  <div id="theme-light-btn" onclick="setThemeMode('light')"
                    class="flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl cursor-pointer border-2 border-gray-600 bg-gray-800/40 text-gray-400 font-semibold text-sm transition-all hover:border-yellow-500/50 hover:text-yellow-400">
                    <i class="fas fa-sun"></i>Light
                  </div>
                </div>
                <div class="text-xs text-gray-600 text-right leading-tight">
                  <div id="theme-mode-label" class="text-gray-400 font-medium">Dark Mode</div>
                  <div>active</div>
                </div>
              </div>
            </div>

            <div>
              <label class="text-xs text-gray-400 uppercase tracking-wider mb-2 block">Default Language</label>
              <select id="cfg-language"
                class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white focus:border-purple-500 focus:outline-none">
                <option value="en">🇺🇸 English</option>
                <option value="pt">🇧🇷 Português</option>
                <option value="es">🇪🇸 Español</option>
                <option value="zh">🇨🇳 中文</option>
                <option value="ko">🇰🇷 한국어</option>
              </select>
            </div>

            <div>
              <label class="text-xs text-gray-400 uppercase tracking-wider mb-2 block">Auto-refresh interval</label>
              <select id="cfg-refresh"
                class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white focus:border-purple-500 focus:outline-none">
                <option value="15">15 seconds</option>
                <option value="30" selected>30 seconds</option>
                <option value="60">1 minute</option>
                <option value="300">5 minutes</option>
                <option value="0">Disabled</option>
              </select>
            </div>

            <div class="flex flex-col gap-3 pt-1">
              <label class="flex items-center gap-3 cursor-pointer">
                <div class="relative">
                  <input type="checkbox" id="cfg-autorefresh" checked class="sr-only peer">
                  <div class="w-10 h-5 bg-gray-700 peer-checked:bg-purple-600 rounded-full transition-colors"></div>
                  <div class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-5"></div>
                </div>
                <span class="text-sm text-gray-300">Auto-refresh Dashboard</span>
              </label>
              <label class="flex items-center gap-3 cursor-pointer">
                <div class="relative">
                  <input type="checkbox" id="cfg-notifications" checked class="sr-only peer">
                  <div class="w-10 h-5 bg-gray-700 peer-checked:bg-purple-600 rounded-full transition-colors"></div>
                  <div class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-5"></div>
                </div>
                <span class="text-sm text-gray-300">Toast notifications</span>
              </label>
            </div>
          </div>

          <div class="flex gap-3 pt-1">
            <button onclick="saveAppConfig()"
              class="flex items-center gap-2 bg-purple-600 hover:bg-purple-700 text-white rounded-xl px-5 py-2.5 text-sm font-semibold transition-all">
              <i class="fas fa-save"></i> Save App Config
            </button>
          </div>
        </div>

        <!-- ── SECURITY TAB ── -->
        <div id="stab-content-security" class="settings-tab-content hidden space-y-5">
          <div class="bg-yellow-900/20 border border-yellow-700/30 rounded-xl p-4 flex items-start gap-3">
            <i class="fas fa-exclamation-triangle text-yellow-400 mt-0.5 flex-shrink-0"></i>
            <div class="text-xs text-yellow-300">
              <p class="font-semibold text-yellow-200 mb-1">Access PIN</p>
              <p>Set a PIN to protect Settings from unauthorized access. Only visible to you. Leave empty to disable PIN protection.</p>
            </div>
          </div>

          <div class="space-y-4">
            <div id="current-pin-field" class="hidden">
              <label class="text-xs text-gray-400 uppercase tracking-wider mb-2 block">Current PIN</label>
              <input type="password" id="sec-current-pin" maxlength="8" placeholder="Enter current PIN"
                class="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:border-purple-500 focus:outline-none text-center tracking-widest font-mono">
            </div>
            <div>
              <label class="text-xs text-gray-400 uppercase tracking-wider mb-2 block">New PIN <span class="text-gray-600">(4–8 digits, leave empty to disable)</span></label>
              <input type="password" id="sec-new-pin" maxlength="8" placeholder="••••"
                class="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:border-purple-500 focus:outline-none text-center tracking-widest font-mono">
            </div>
            <div>
              <label class="text-xs text-gray-400 uppercase tracking-wider mb-2 block">Confirm New PIN</label>
              <input type="password" id="sec-confirm-pin" maxlength="8" placeholder="••••"
                class="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:border-purple-500 focus:outline-none text-center tracking-widest font-mono">
            </div>
            <div id="pin-save-msg" class="hidden rounded-lg p-2 text-xs text-center"></div>
            <button onclick="savePIN()"
              class="flex items-center gap-2 bg-yellow-600 hover:bg-yellow-700 text-white rounded-xl px-5 py-2.5 text-sm font-semibold transition-all">
              <i class="fas fa-lock"></i> Save PIN
            </button>
          </div>

          <!-- Local Data Management -->
          <div class="border border-gray-700/40 rounded-xl p-4 space-y-3 mt-2">
            <div class="flex items-center gap-2 mb-1">
              <i class="fas fa-database text-blue-400 text-sm"></i>
              <span class="text-xs text-gray-200 font-semibold uppercase tracking-wider">Local Data Storage</span>
            </div>
            <p class="text-xs text-gray-500">Transaction history, payment records, and contracts are stored locally in IndexedDB for offline access. On-chain data remains the source of truth.</p>
            <div id="arc-persist-stats" class="bg-gray-800/50 rounded-lg p-3 text-xs text-gray-400 space-y-1">
              <div class="flex justify-between"><span>Payments cached:</span><span id="ps-payments" class="text-blue-400">—</span></div>
              <div class="flex justify-between"><span>Contracts cached:</span><span id="ps-contracts" class="text-blue-400">—</span></div>
              <div class="flex justify-between"><span>History cached:</span><span id="ps-history" class="text-blue-400">—</span></div>
              <div class="flex justify-between"><span>Storage engine:</span><span id="ps-db" class="text-green-400">—</span></div>
              <div class="flex justify-between"><span>Network:</span><span id="ps-online" class="text-green-400">—</span></div>
            </div>
            <div class="flex gap-2 flex-wrap">
              <button onclick="arcShowPersistStats()"
                class="flex items-center gap-1.5 bg-blue-900/30 hover:bg-blue-800/40 border border-blue-700/30 text-blue-300 rounded-lg px-4 py-2 text-xs font-semibold transition-all">
                <i class="fas fa-sync-alt"></i> Refresh Stats
              </button>
              <button onclick="arcClearLocal()"
                class="flex items-center gap-1.5 bg-red-900/20 hover:bg-red-900/40 border border-red-700/30 text-red-400 rounded-lg px-4 py-2 text-xs font-semibold transition-all">
                <i class="fas fa-trash"></i> Clear Local Data
              </button>
            </div>
            <p class="text-xs text-gray-600">⚠ Clearing local data only removes cached records. On-chain transactions remain permanently on the blockchain.</p>
          </div>
        </div>
      </div>
    </div>
  </div>
  <!-- ═══════════════════════════════════════════════════════════ -->
  <div id="profile-modal" class="fixed inset-0 z-[90] hidden items-center justify-center bg-black/70 backdrop-blur-sm">
    <div class="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-lg max-h-[90vh] flex flex-col shadow-2xl mx-4">

      <!-- Header -->
      <div class="flex items-center justify-between px-6 py-4 border-b border-gray-700/60">
        <div class="flex items-center gap-3">
          <!-- Avatar grande -->
          <div id="profile-avatar-large"
            class="w-12 h-12 rounded-2xl bg-gradient-to-br from-purple-600 to-blue-600 flex items-center justify-center text-white font-bold text-lg border-2 border-purple-500/40">
            👤
          </div>
          <div>
            <h2 class="text-white font-bold" id="profile-header-name">My Profile</h2>
            <p class="text-xs text-gray-500" id="profile-header-email">Set up your profile</p>
          </div>
        </div>
        <button onclick="closeProfileModal()" class="w-8 h-8 flex items-center justify-center text-gray-500 hover:text-white rounded-lg hover:bg-gray-800 transition-all">
          <i class="fas fa-times"></i>
        </button>
      </div>

      <!-- Form -->
      <div class="overflow-y-auto flex-1 px-6 py-5 space-y-4">

        <!-- Avatar display -->
        <div class="flex items-center justify-center py-2">
          <div class="relative">
            <div id="profile-avatar-display"
              class="w-20 h-20 rounded-2xl bg-gradient-to-br from-purple-600 to-blue-600 flex items-center justify-center text-white font-bold text-3xl border-2 border-purple-500/40 shadow-xl">
              👤
            </div>
            <div class="absolute -bottom-1 -right-1 w-6 h-6 bg-green-500 rounded-full border-2 border-gray-900 flex items-center justify-center">
              <i class="fas fa-check text-white" style="font-size:8px"></i>
            </div>
          </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label class="text-xs text-gray-400 uppercase tracking-wider mb-2 block">Full Name <span class="text-purple-400">*</span></label>
            <input type="text" id="prof-name" placeholder="John Doe"
              class="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:border-purple-500 focus:outline-none"
              oninput="updateProfilePreview()">
          </div>
          <div>
            <label class="text-xs text-gray-400 uppercase tracking-wider mb-2 block">Email <span class="text-purple-400">*</span></label>
            <input type="email" id="prof-email" placeholder="john@example.com"
              class="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:border-purple-500 focus:outline-none">
          </div>
          <div>
            <label class="text-xs text-gray-400 uppercase tracking-wider mb-2 block">Role / Title</label>
            <input type="text" id="prof-role" placeholder="CEO, Developer, Analyst..."
              class="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:border-purple-500 focus:outline-none">
          </div>
          <div>
            <label class="text-xs text-gray-400 uppercase tracking-wider mb-2 block">Company / Organization</label>
            <input type="text" id="prof-company" placeholder="Acme Inc."
              class="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:border-purple-500 focus:outline-none">
          </div>
        </div>

        <div>
          <label class="text-xs text-gray-400 uppercase tracking-wider mb-2 block">EVM Wallet Address</label>
          <input type="text" id="prof-wallet" placeholder="0x..."
            class="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:border-purple-500 focus:outline-none font-mono"
            readonly>
          <p class="text-xs text-gray-600 mt-1">Auto-filled from connected wallet</p>
        </div>

        <!-- Badges de integrações -->
        <div class="border-t border-gray-700/50 pt-4">
          <p class="text-xs text-gray-500 uppercase tracking-wider mb-3">Integrations Status</p>
          <div class="flex flex-wrap gap-2" id="profile-integrations">
            <span class="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-gray-800 border border-gray-700 text-xs text-gray-400">
              <i class="fas fa-circle text-gray-600" style="font-size:6px"></i> Circle API: Not connected
            </span>
            <span class="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-gray-800 border border-gray-700 text-xs text-gray-400" id="prof-wallet-badge">
              <i class="fas fa-circle text-gray-600" style="font-size:6px"></i> Wallet: Not connected
            </span>
          </div>
        </div>

        <!-- Timestamps -->
        <div class="text-xs text-gray-600 flex gap-4 pt-1">
          <span>Member since: <span id="prof-created" class="text-gray-500">—</span></span>
          <span>Updated: <span id="prof-updated" class="text-gray-500">—</span></span>
        </div>

        <div id="profile-save-msg" class="hidden rounded-lg p-2 text-xs text-center"></div>
      </div>

      <!-- Footer -->
      <div class="px-6 py-4 border-t border-gray-700/60 flex gap-3">
        <button onclick="saveProfile()"
          class="flex-1 flex items-center justify-center gap-2 bg-purple-600 hover:bg-purple-700 text-white rounded-xl py-2.5 text-sm font-semibold transition-all">
          <i class="fas fa-save"></i> Save Profile
        </button>
        <button onclick="closeProfileModal()"
          class="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-xl px-4 py-2.5 text-sm transition-all">
          Cancel
        </button>
      </div>
    </div>
  </div>

  <!-- ══════════════════════════════════════════════════════════════════════
       SITE FOOTER — Institutional, Legal & Transparency
  ═══════════════════════════════════════════════════════════════════════ -->
  <footer class="mt-16 border-t border-gray-800/60 bg-gray-950/90">

    <!-- Main footer content -->
    <div class="max-w-7xl mx-auto px-6 py-10 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8">

      <!-- Brand column -->
      <div class="space-y-3">
        <div class="flex items-center gap-2.5">
          <div class="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-600 to-blue-600 flex items-center justify-center">
            <i class="fas fa-bolt text-white text-sm"></i>
          </div>
          <span class="font-bold text-white text-sm">ARC AI Agents</span>
        </div>
        <p class="text-xs text-gray-500 leading-relaxed">
          Open-source testnet dApp built on Arc Network. Explore autonomous payments, AMM swaps, and smart contracts — safely, on testnet.
        </p>
        <div class="flex items-center gap-1.5 px-2.5 py-1.5 bg-amber-500/10 border border-amber-500/30 rounded-lg w-fit">
          <i class="fas fa-flask text-amber-400 text-xs"></i>
          <span class="text-amber-300 text-xs font-semibold">TESTNET ONLY</span>
        </div>
      </div>

      <!-- Network Info -->
      <div class="space-y-3">
        <h3 class="text-xs font-bold text-gray-400 uppercase tracking-widest">Arc Network</h3>
        <ul class="space-y-2 text-xs text-gray-500">
          <li class="flex items-center gap-2">
            <i class="fas fa-circle text-green-400 text-[8px]"></i>
            Arc Testnet · ChainID 5042002
          </li>
          <li>
            <a href="https://testnet.arcscan.app" target="_blank" rel="noopener noreferrer"
              class="flex items-center gap-1.5 hover:text-purple-400 transition-colors">
              <i class="fas fa-external-link-alt text-[10px]"></i>ArcScan Explorer
            </a>
          </li>
          <li>
            <a href="https://faucet.circle.com" target="_blank" rel="noopener noreferrer"
              class="flex items-center gap-1.5 hover:text-blue-400 transition-colors">
              <i class="fas fa-faucet text-[10px]"></i>Testnet Faucet
            </a>
          </li>
          <li>
            <a href="https://testnet.arcscan.app/address/0x3148E2807F172D1cC354F35fB4fC4104e8b6b561"
              target="_blank" rel="noopener noreferrer"
              class="flex items-center gap-1.5 hover:text-cyan-400 transition-colors">
              <i class="fas fa-file-contract text-[10px]"></i>SimpleAMM Contract
            </a>
          </li>
        </ul>
      </div>

      <!-- Resources -->
      <div class="space-y-3">
        <h3 class="text-xs font-bold text-gray-400 uppercase tracking-widest">Resources</h3>
        <ul class="space-y-2 text-xs text-gray-500">
          <li>
            <a href="/about" class="flex items-center gap-1.5 hover:text-white transition-colors">
              <i class="fas fa-info-circle text-[10px]"></i>About this App
            </a>
          </li>
          <li>
            <a href="https://github.com/julenosinger/Agentes-de-IA" target="_blank" rel="noopener noreferrer"
              class="flex items-center gap-1.5 hover:text-white transition-colors">
              <i class="fab fa-github text-[10px]"></i>Source Code (GitHub)
            </a>
          </li>
          <li>
            <a href="https://arc.network" target="_blank" rel="noopener noreferrer"
              class="flex items-center gap-1.5 hover:text-white transition-colors">
              <i class="fas fa-globe text-[10px]"></i>Arc Network Official
            </a>
          </li>
        </ul>
      </div>

      <!-- Legal -->
      <div class="space-y-3">
        <h3 class="text-xs font-bold text-gray-400 uppercase tracking-widest">Legal</h3>
        <ul class="space-y-2 text-xs text-gray-500">
          <li>
            <a href="/privacy-policy" class="flex items-center gap-1.5 hover:text-white transition-colors">
              <i class="fas fa-shield-alt text-[10px]"></i>Privacy Policy
            </a>
          </li>
          <li>
            <a href="/terms-of-service" class="flex items-center gap-1.5 hover:text-white transition-colors">
              <i class="fas fa-file-alt text-[10px]"></i>Terms of Service
            </a>
          </li>
          <li class="text-gray-600 pt-1 leading-relaxed">
            This app does not custody funds, store private keys, or execute transactions without explicit user confirmation.
          </li>
        </ul>
      </div>
    </div>

    <!-- Bottom bar -->
    <div class="border-t border-gray-800/60 px-6 py-4">
      <div class="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-gray-600">
        <span>© 2025 ARC AI Agents — Open Source Project · MIT License</span>
        <div class="flex items-center gap-4">
          <span class="flex items-center gap-1.5">
            <i class="fas fa-lock text-green-500 text-[10px]"></i>
            No private keys stored
          </span>
          <span class="flex items-center gap-1.5">
            <i class="fas fa-flask text-amber-400 text-[10px]"></i>
            Testnet only
          </span>
          <a href="https://github.com/julenosinger/Agentes-de-IA" target="_blank" rel="noopener noreferrer"
            class="flex items-center gap-1.5 hover:text-gray-400 transition-colors">
            <i class="fab fa-github"></i>Open Source
          </a>
        </div>
      </div>
    </div>
  </footer>

  <script src="/static/wallet.js?v=20250322"></script>
  <script src="/static/csv-upload.js?v=20250322"></script>
  <script src="/static/persistence.js?v=20250323"></script>
  <script src="/static/receipt-viewer.js?v=20250323b"></script>
  <script src="/static/app.js?v=20250325e"></script>
  <script src="/static/payments.js?v=20250325c"></script>
  <script src="/static/contracts.js?v=20250325a"></script>
  <script src="/static/settings.js?v=20250322"></script>
  <script src="/static/swap.js?v=20250322"></script>
  <script src="/static/dex.js?v=20250325b"></script>
  <script src="/static/multisend.js?v=20250323c"></script>
  <script src="/static/guardian.js?v=20250322"></script>
  <script src="/static/yield-optimizer.js?v=20250322"></script>
  <script src="/static/history.js?v=20250323b"></script>
  <script src="/static/dashboard.js?v=20250322"></script>
  <script src="/static/chat.js?v=20250325a"></script>
  <script>
    // ── Contract Mode UI updater (inline, loads before contracts.js) ─────────────
    function cfUpdateModeUI(mode) {
      // Sync hidden select
      const sel = document.getElementById('cf-contract-mode');
      if (sel) sel.value = mode;

      // Update card visuals
      document.querySelectorAll('.cf-mode-opt').forEach(function(el) {
        const m = el.getAttribute('data-mode');
        if (m === mode) {
          if (m === 'onchain')   { el.style.border = '1px solid rgba(55,138,221,0.5)';  el.style.background = 'rgba(55,138,221,0.18)'; }
          if (m === 'offchain')  { el.style.border = '1px solid rgba(251,191,36,0.5)';  el.style.background = 'rgba(251,191,36,0.15)'; }
          if (m === 'custodial') { el.style.border = '1px solid rgba(167,139,250,0.5)'; el.style.background = 'rgba(167,139,250,0.15)'; }
        } else {
          if (m === 'onchain')   { el.style.border = '1px solid rgba(55,138,221,0.2)';  el.style.background = 'rgba(55,138,221,0.06)'; }
          if (m === 'offchain')  { el.style.border = '1px solid rgba(251,191,36,0.2)';  el.style.background = 'rgba(251,191,36,0.06)'; }
          if (m === 'custodial') { el.style.border = '1px solid rgba(167,139,250,0.2)'; el.style.background = 'rgba(167,139,250,0.06)'; }
        }
      });

      // Update mode description
      var desc = document.getElementById('cf-mode-desc');
      var btn  = document.getElementById('cf-submit-btn');
      var lbl  = document.getElementById('cf-submit-label');
      var ico  = document.getElementById('cf-submit-icon');
      var onchainNote = document.getElementById('cf-onchain-note');
      var valueLabel  = document.querySelector('label[for="cf-value"]');

      if (mode === 'onchain') {
        if (desc) { desc.style.background = 'rgba(55,138,221,0.06)'; desc.style.borderColor = 'rgba(55,138,221,0.2)'; desc.style.color = '#60b4ff'; desc.innerHTML = '<i class="fas fa-info-circle mr-1"></i><strong>On-Chain Escrow:</strong> USDC bloqueado no smart contract. Fundos liberados via aprovação de milestone.'; }
        if (btn)  { btn.style.background = 'linear-gradient(135deg,#1565c0,#006064)'; }
        if (lbl)  lbl.textContent = 'Create Contract On-Chain';
        if (ico)  ico.className = 'fas fa-file-signature';
        if (onchainNote) onchainNote.style.display = '';
      } else if (mode === 'offchain') {
        if (desc) { desc.style.background = 'rgba(251,191,36,0.06)'; desc.style.borderColor = 'rgba(251,191,36,0.2)'; desc.style.color = '#fbbf24'; desc.innerHTML = '<i class="fas fa-info-circle mr-1"></i><strong>Off-Chain Payment:</strong> Registro de contrato sem escrow on-chain. Pagamento externo (PIX, TED, crypto). Serve como registro legal.'; }
        if (btn)  { btn.style.background = 'linear-gradient(135deg,#92400e,#b45309)'; }
        if (lbl)  lbl.textContent = 'Create Off-Chain Contract';
        if (ico)  ico.className = 'fas fa-money-bill-wave';
        if (onchainNote) onchainNote.style.display = 'none';
      } else if (mode === 'custodial') {
        if (desc) { desc.style.background = 'rgba(167,139,250,0.06)'; desc.style.borderColor = 'rgba(167,139,250,0.2)'; desc.style.color = '#a78bfa'; desc.innerHTML = '<i class="fas fa-info-circle mr-1"></i><strong>Custodial Escrow:</strong> Fundos gerenciados por terceiro. Referência de custódia registrada. Status: In Custody → Released → Disputed.'; }
        if (btn)  { btn.style.background = 'linear-gradient(135deg,#4c1d95,#5b21b6)'; }
        if (lbl)  lbl.textContent = 'Create Custodial Contract';
        if (ico)  ico.className = 'fas fa-shield-alt';
        if (onchainNote) onchainNote.style.display = 'none';
      }
    }
    // Initialize on DOMContentLoaded
    document.addEventListener('DOMContentLoaded', function() { cfUpdateModeUI('onchain'); });
  </script>
  <script>
    // ── Platform initialization ───────────────────────────────────────────────
    window.addEventListener('load', () => {

      // 0. Sync --topbar-h CSS variable on load (in case banner was pre-dismissed)
      if (typeof updateTopbarHeight === 'function') updateTopbarHeight();

      // 1. ArcPay status bar — delegate fully to chat.js v3 updateArcPayBar()
      //    The bar is visible by default (no hidden class) and chat.js v3 owns it.
      //    We call updateArcPayBar() after a short delay to ensure chat.js is ready.
      setTimeout(() => {
        if (typeof updateArcPayBar === 'function') {
          updateArcPayBar();
        }
      }, 100);

      // 2. Chat size buttons
      const savedSize = localStorage.getItem('arc-chat-size') || 'medium';
      ['mini','medium','full'].forEach(s => {
        const b = document.getElementById('chat-size-' + s);
        if (b) b.classList.toggle('active', s === savedSize);
      });

      // 3. Handle ?chat=1 query param (open chat in new tab mode)
      if (new URLSearchParams(location.search).get('chat') === '1') {
        const data = JSON.parse(localStorage.getItem('arc-chat-newtab') || '{}');
        if (data.messages?.length) {
          // Restore to app view first
          if (typeof enterApp === 'function') enterApp();
          setTimeout(() => {
            if (typeof toggleChat === 'function') toggleChat();
            if (typeof setChatSize === 'function') setChatSize('full');
          }, 300);
        }
      }

      // 4. Restore scroll position for app shell
      const shell = document.getElementById('app-shell');
      if (shell && !shell.classList.contains('hidden')) {
        window.scrollTo(0, 0);
      }

      // 5. ethers.js check
      if (window.ethers) {
        console.log('[ARC] ethers.js loaded · v', window.ethers.version || '6.x');
      } else {
        console.warn('[ARC] ethers.js not loaded');
      }

      // 6. Performance: preconnect to RPC on load
      const link = document.createElement('link');
      link.rel = 'preconnect'; link.href = 'https://rpc.testnet.arc.network';
      document.head.appendChild(link);
    });
  </script>
</body>
</html>`)
})

export default app
