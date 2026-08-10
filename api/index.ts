/**
 * ExecDaat Platform — Vercel Serverless Entry Point
 *
 * This file is the single entry point for Vercel deployment.
 * It uses Node.js-compatible APIs (no Cloudflare Workers-specific imports).
 *
 * Key differences from src/index.tsx:
 *   - serveStatic from @hono/node-server/serve-static (not hono/cloudflare-workers)
 *   - No Cloudflare Bindings (KVNamespace, D1Database, etc.)
 *   - Exports app.fetch as default (Vercel's fetch handler interface)
 *   - HTML served from src/html-template.ts (no dynamic CF import)
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from '@hono/node-server/serve-static'

// Route imports (all pure Hono, no CF-specific APIs)
import paymentsRouter  from '../src/routes/payments'
import contractsRouter from '../src/routes/contracts'
import settingsRouter  from '../src/routes/settings'
import swapRouter      from '../src/routes/swap'
import chatRouter      from '../src/routes/chat'
import guardianRouter  from '../src/routes/guardian'
import yieldRouter     from '../src/routes/yield-optimizer'
import dexRouter       from '../src/routes/dex'
import rpcProxyRouter  from '../src/routes/rpc-proxy'
import agentWalletRouter from '../src/routes/agent-wallet'
import treasuryCoreRouter from '../src/routes/treasury-core'
import { metaRouter as treasuryMetaRouter } from '../src/routes/treasury'

// HTML template (no Cloudflare deps)
import { getMainHTML } from '../src/html-template'

// ─── App ──────────────────────────────────────────────────────────────────────
const app = new Hono()

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use('*', cors({
  origin: (origin) => {
    if (!origin) return origin
    const allowed = [
      'https://execdaatplataform.vercel.app',
      'https://execdaatplataform.pages.dev',
      'http://localhost:3000',
      'http://localhost:5173',
    ]
    if (
      allowed.some(o => origin === o) ||
      origin.endsWith('.vercel.app') ||
      origin.endsWith('.pages.dev')
    ) {
      return origin
    }
    return null
  },
  allowMethods:  ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders:  ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Session-Id',
                  'X-Client-Timestamp', 'X-Tab-Id', 'X-Requested-With'],
  exposeHeaders: ['X-Request-Id', 'X-RateLimit-Remaining'],
  credentials:   false,
  maxAge:        600,
}))

// ─── Static files ─────────────────────────────────────────────────────────────
// Served by Vercel CDN from dist-vercel/ (see vercel.json outputDirectory)
// Fallback for local dev
app.use('/static/*', serveStatic({ root: './public' }))

// ─── Security & Trust files ───────────────────────────────────────────────────
app.get('/manifest.json', (c) => c.json({
  name: 'ExecDaat Platform',
  short_name: 'ExecDaat',
  description: 'Compliance and send platform for Arc Testnet — AI-powered agent transfers with Permit2',
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
}, 200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=3600' }))

app.get('/.well-known/security.txt', (c) => new Response(
  `# ExecDaat Platform — Security Policy\n# https://securitytxt.org/\n\nContact: mailto:security@execdaat.com\nPreferred-Languages: en, pt\nExpires: 2027-04-10T00:00:00.000Z\n`,
  { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' } }
))

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (c) => c.json({
  status: 'ok',
  platform: 'vercel',
  timestamp: new Date().toISOString(),
}))

app.get('/api/status', (c) => c.json({
  status: 'online',
  platform: 'vercel',
  version: '1.0.0',
  timestamp: new Date().toISOString(),
}))

// ─── API Routes ───────────────────────────────────────────────────────────────
app.route('/api/payments',  paymentsRouter)
app.route('/api/contracts', contractsRouter)
app.route('/api/settings',  settingsRouter)
app.route('/api/swap',      swapRouter)
app.route('/api/chat',      chatRouter)
app.route('/api/guardian',  guardianRouter)
app.route('/api/yield',     yieldRouter)
app.route('/api/dex',       dexRouter)
app.route('/api/rpc',       rpcProxyRouter)
app.route('/api/agent-wallet', agentWalletRouter)

// ─── Treasury Core API (Elligent) — Phase 3 integration boundary ─────────────
// Same-origin proxy: injects Application Secret + standardized headers
// server-side (read from process.env on Vercel) and forwards to the Elligent
// Treasury Core API. ExecDaat holds NO private keys.
app.route('/api/core/v1', treasuryCoreRouter)
app.route('/api/treasury', treasuryMetaRouter)

// ─── Main dApp HTML ───────────────────────────────────────────────────────────
// Serve the main app HTML for all non-API routes (SPA fallback)
app.get('*', (c) => {
  return c.html(getMainHTML())
})

// ─── Export for Vercel ────────────────────────────────────────────────────────
export default app.fetch
