// ============================================================
// Treasury Core — Centralized Configuration (Phase 3)
// ------------------------------------------------------------
// Single source of truth for the ExecDaat → Elligent Treasury
// Core API integration. Reads Cloudflare/Vercel env bindings and
// exposes a normalized, non-sensitive config object.
//
// SECURITY: This module NEVER exposes the Application Secret to
// the client. Only `hasSecret` (boolean) is ever surfaced. The
// ExecDaat platform holds NO private keys (operator / relayer /
// treasury / vault). All signing stays on the Elligent side.
// ============================================================

// ─── Env bindings consumed by the Treasury Core integration ──────────────────
export type TreasuryBindings = {
  // Base URL of the Elligent Treasury Core API (e.g. https://treasury.elligent.io)
  TREASURY_CORE_URL?: string
  // Application identity (public, non-sensitive)
  APPLICATION_ID?: string
  CLIENT_ID?: string
  API_VERSION?: string
  APPLICATION_MODE?: string
  // Feature flag controlling execution source: LOCAL | REMOTE (default REMOTE)
  TREASURY_MODE?: string
  // Server-side ONLY secret used to authenticate against the Treasury Core API.
  // Injected as a header by the ExecDaat proxy; never sent to the browser.
  TREASURY_APPLICATION_SECRET?: string
}

export type TreasuryMode = 'LOCAL' | 'REMOTE'

export interface TreasuryConfig {
  coreUrl: string
  applicationId: string
  clientId: string
  apiVersion: string
  applicationMode: string
  treasuryMode: TreasuryMode
  hasSecret: boolean
  // `enabled` = true only when a core URL is configured. When false, the
  // frontend integration transparently falls back to the legacy LOCAL path,
  // guaranteeing zero regression until Elligent provisions the endpoint.
  enabled: boolean
}

// ─── Defaults (match the Phase 3 specification) ──────────────────────────────
const DEFAULTS = {
  APPLICATION_ID: 'EXECDAAT',
  CLIENT_ID: 'EXECDAAT-PROD',
  API_VERSION: 'v1',
  APPLICATION_MODE: 'REMOTE',
  TREASURY_MODE: 'REMOTE' as TreasuryMode,
}

function normalizeMode(raw?: string): TreasuryMode {
  const v = (raw || '').trim().toUpperCase()
  return v === 'LOCAL' ? 'LOCAL' : 'REMOTE'
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

// Normalize TREASURY_CORE_URL to the ORIGIN (+ optional custom prefix), stripping
// a trailing "/api/core/vN" or "/api/core" so the proxy can append the canonical
// path (`/api/core/<version>/...`) WITHOUT duplicating it. This makes both forms
// valid and prevents a go-live misconfiguration:
//   https://core.elligentt.xyz            → https://core.elligentt.xyz
//   https://core.elligentt.xyz/api/core/v1 → https://core.elligentt.xyz
//   https://elligente.pages.dev/api/core/v1 → https://elligente.pages.dev
function normalizeCoreUrl(raw: string): string {
  let u = trimTrailingSlash((raw || '').trim())
  u = u.replace(/\/api\/core(\/v\d+)?$/i, '')
  return trimTrailingSlash(u)
}

// Resolve a single env var from the provided bindings (Cloudflare `c.env`)
// falling back to `process.env` (Vercel / Node). Keeps a single source of
// truth for both deployment targets.
function fromEnv(env: TreasuryBindings | undefined, key: keyof TreasuryBindings): string | undefined {
  const v = env && env[key]
  if (v != null && String(v) !== '') return String(v)
  try {
    const p = (globalThis as any)?.process?.env
    if (p && p[key] != null && String(p[key]) !== '') return String(p[key])
  } catch {
    /* process not available (edge runtime) */
  }
  return undefined
}

/**
 * Build the normalized Treasury Core configuration from env bindings.
 * Safe to call per-request; performs no I/O.
 */
export function getTreasuryConfig(env: TreasuryBindings | undefined): TreasuryConfig {
  const coreUrl = normalizeCoreUrl(fromEnv(env, 'TREASURY_CORE_URL') || '')
  const secret = fromEnv(env, 'TREASURY_APPLICATION_SECRET')
  const hasSecret = !!(secret && secret.trim())
  return {
    coreUrl,
    applicationId: (fromEnv(env, 'APPLICATION_ID') || DEFAULTS.APPLICATION_ID).trim(),
    clientId: (fromEnv(env, 'CLIENT_ID') || DEFAULTS.CLIENT_ID).trim(),
    apiVersion: (fromEnv(env, 'API_VERSION') || DEFAULTS.API_VERSION).trim(),
    applicationMode: (fromEnv(env, 'APPLICATION_MODE') || DEFAULTS.APPLICATION_MODE).trim(),
    treasuryMode: normalizeMode(fromEnv(env, 'TREASURY_MODE') || DEFAULTS.TREASURY_MODE),
    hasSecret,
    enabled: coreUrl.length > 0,
  }
}

/**
 * Resolve the Application Secret (server-side ONLY). Never returned to client.
 */
export function getApplicationSecret(env: TreasuryBindings | undefined): string {
  return (fromEnv(env, 'TREASURY_APPLICATION_SECRET') || '').trim()
}

/**
 * Public (non-sensitive) view of the config, safe to return to the browser.
 * NEVER includes the Application Secret or the raw core URL host internals.
 */
export function getPublicTreasuryConfig(env: TreasuryBindings | undefined) {
  const c = getTreasuryConfig(env)
  return {
    applicationId: c.applicationId,
    clientId: c.clientId,
    apiVersion: c.apiVersion,
    applicationMode: c.applicationMode,
    treasuryMode: c.treasuryMode,
    // `enabled` tells the frontend whether the remote path can be attempted.
    // Effective REMOTE requires: treasuryMode === REMOTE AND enabled AND health OK.
    enabled: c.enabled && c.treasuryMode === 'REMOTE',
    // Non-sensitive diagnostics (booleans only — never the values):
    hasCoreUrl: c.coreUrl.length > 0,
    hasSecret: c.hasSecret,
    // Proxy base path the frontend should call (same-origin; secret injected server-side)
    basePath: `/api/core/${c.apiVersion}`,
  }
}
