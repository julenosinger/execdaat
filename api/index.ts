/**
 * ExecDaat Platform — Vercel Serverless Entry Point
 *
 * This file adapts the Hono app (originally built for Cloudflare Pages/Workers)
 * to run on Vercel's Node.js serverless runtime using @hono/node-server.
 *
 * Architecture:
 *   - Vercel routes all requests to this function via vercel.json
 *   - Static files in /public are served directly by Vercel's CDN (no cost)
 *   - API routes (/api/*) are handled by the Hono router here
 *   - The Hono app is the same source used in Cloudflare — no duplication
 */

import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import paymentsRouter from '../src/routes/payments'
import contractsRouter from '../src/routes/contracts'
import settingsRouter from '../src/routes/settings'
import swapRouter from '../src/routes/swap'
import chatRouter from '../src/routes/chat'
import guardianRouter from '../src/routes/guardian'
import yieldRouter from '../src/routes/yield-optimizer'
import dexRouter from '../src/routes/dex'
import { securityMiddleware } from '../src/middleware/security'

// ─── App ──────────────────────────────────────────────────────────────────────
const app = new Hono()

// ─── Security Middleware ──────────────────────────────────────────────────────
app.use('*', securityMiddleware)

// ─── CORS — allow Vercel preview URLs + production ───────────────────────────
const ALLOWED_ORIGINS = [
  'https://execdaatplataform.vercel.app',
  'https://execdaatplataform.pages.dev',
  'http://localhost:3000',
  'http://localhost:5173',
]

app.use('*', cors({
  origin: (origin) => {
    if (!origin) return origin
    if (
      ALLOWED_ORIGINS.some(o => origin === o) ||
      origin.endsWith('.vercel.app') ||
      origin.endsWith('.pages.dev')
    ) return origin
    return null
  },
  allowMethods:  ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders:  ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Session-Id',
                  'X-Client-Timestamp', 'X-Tab-Id', 'X-Requested-With'],
  exposeHeaders: ['X-Request-Id', 'X-RateLimit-Remaining'],
  credentials:   false,
  maxAge:        600,
}))

// ─── Static files — served by Vercel CDN directly, but fallback here ─────────
app.use('/static/*', serveStatic({ root: './public' }))

// ─── Security & Trust files ───────────────────────────────────────────────────
app.get('/manifest.json', (c) => {
  return c.json({
    name: 'ExecDaat Platform',
    short_name: 'ExecDaat',
    description: 'Compliance and payment platform for Arc Testnet — AI-powered agent transfers with Permit2',
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
Contact: https://execdaatplataform.vercel.app

Preferred-Languages: en, pt

Canonical: https://execdaatplataform.vercel.app/.well-known/security.txt

Policy: https://execdaatplataform.vercel.app/.well-known/security.txt

Acknowledgments: https://execdaatplataform.vercel.app

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

// ─── API Routes ───────────────────────────────────────────────────────────────
app.route('/api/payments',  paymentsRouter)
app.route('/api/contracts', contractsRouter)
app.route('/api/settings',  settingsRouter)
app.route('/api/swap',      swapRouter)
app.route('/api/chat',      chatRouter)
app.route('/api/guardian',  guardianRouter)
app.route('/api/yield',     yieldRouter)
app.route('/api/dex',       dexRouter)

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (c) => c.json({
  status: 'ok',
  platform: 'vercel',
  timestamp: new Date().toISOString(),
}))

// ─── Export for Vercel serverless ─────────────────────────────────────────────
// Vercel expects a default export that is a Request handler (fetch API compatible)
export default app.fetch
