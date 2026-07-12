// ============================================================
// ExecDaat — Safe Environment Variable Access
// ============================================================
// Centralized helper to validate required environment variables.
// Never returns undefined for required vars — throws with a clear
// message so the app fails fast and visibly instead of silently
// continuing with missing secrets.
//
// SECURITY: This module is server-side ONLY. It is never bundled
// into client-side code. Private keys read via this module never
// reach the browser.
// ============================================================

/**
 * Validates that a required environment variable is set and non-empty.
 * Throws a descriptive error if the variable is missing.
 *
 * Usage:
 *   const relayKey = getRequiredEnv(env, 'TURBO_RELAYER_PRIVATE_KEY')
 *   const operatorKey = getRequiredEnv(env, 'OPERATOR_PRIVATE_KEY')
 */
export function getRequiredEnv(
  env: Record<string, string | undefined> | undefined,
  name: string,
): string {
  const val = env?.[name]
  if (!val || String(val).trim() === '') {
    throw new Error(
      `Missing required environment variable: ${name}\n` +
      `Set it before starting the application.\n` +
      `Cloudflare:  wrangler secret put ${name}\n` +
      `Vercel/Node: export ${name}=<value>`,
    )
  }
  return String(val).trim()
}

/**
 * Reads an optional environment variable with a fallback default.
 * Returns the default if the variable is missing or empty.
 *
 * Usage:
 *   const rpc = getOptionalEnv(env, 'ARC_RPC_URL', 'https://rpc.testnet.arc.network')
 */
export function getOptionalEnv(
  env: Record<string, string | undefined> | undefined,
  name: string,
  fallback: string,
): string {
  const val = env?.[name]
  if (!val || String(val).trim() === '') return fallback
  return String(val).trim()
}
