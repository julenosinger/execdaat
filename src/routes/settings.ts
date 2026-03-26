import { Hono } from 'hono'
import {
  clampString,
  isValidEmail,
  isValidEthAddress,
  sanitizeForLog,
  stripTags,
} from '../middleware/security'

// ─── Cloudflare env bindings type ────────────────────────────────────────────
type Bindings = {
  CIRCLE_API_KEY?: string
  CIRCLE_WEBHOOK_SECRET?: string
  CIRCLE_ENVIRONMENT?: string
}

const router = new Hono<{ Bindings: Bindings }>()

// ─── In-memory settings store (persiste enquanto o processo rodar) ────────────
// Em produção com Cloudflare, usar KV ou D1 para persistência real
interface UserProfile {
  name: string
  email: string
  role: string
  company: string
  walletAddress: string
  avatarInitials: string
  createdAt: string
  updatedAt: string
}

interface CircleConfig {
  apiKey: string           // armazenado ofuscado
  environment: 'sandbox' | 'production'
  apiKeyMasked: string
  webhookSecret: string
  webhookSecretMasked: string
  isConnected: boolean
  lastTestAt: string | null
  testResult: string | null
}

interface AppSettings {
  accessPin: string        // PIN de acesso às configurações (hash simples)
  theme: string
  language: string
  autoRefresh: boolean
  refreshInterval: number  // segundos
  notifications: boolean
  analyticsEnabled: boolean
}

interface SettingsStore {
  profile: UserProfile
  circle: CircleConfig
  app: AppSettings
  updatedAt: string
}

const DEFAULT_SETTINGS: SettingsStore = {
  profile: {
    name: '',
    email: '',
    role: '',
    company: '',
    walletAddress: '',
    avatarInitials: '??',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  circle: {
    apiKey: '',
    environment: 'sandbox',
    apiKeyMasked: '',
    webhookSecret: '',
    webhookSecretMasked: '',
    isConnected: false,
    lastTestAt: null,
    testResult: null,
  },
  app: {
    accessPin: '',   // vazio = sem PIN
    theme: 'dark',
    language: 'en',
    autoRefresh: true,
    refreshInterval: 30,
    notifications: true,
    analyticsEnabled: false,
  },
  updatedAt: new Date().toISOString(),
}

let settingsStore: SettingsStore = JSON.parse(JSON.stringify(DEFAULT_SETTINGS))

// Helper: mascarar chave (mostrar apenas últimos 6 chars)
function maskKey(key: string): string {
  if (!key || key.length < 8) return key ? '••••••' : ''
  return '•'.repeat(key.length - 6) + key.slice(-6)
}

// Helper: safe response (nunca expõe chaves reais)
function safeSettings(s: SettingsStore) {
  return {
    profile: { ...s.profile },
    circle: {
      environment: s.circle.environment as 'sandbox' | 'production',
      apiKeyMasked: s.circle.apiKey ? maskKey(s.circle.apiKey) : '',
      webhookSecretMasked: s.circle.webhookSecret ? maskKey(s.circle.webhookSecret) : '',
      isConnected: s.circle.isConnected,
      lastTestAt: s.circle.lastTestAt,
      testResult: s.circle.testResult,
      hasApiKey: !!s.circle.apiKey,
      hasWebhookSecret: !!s.circle.webhookSecret,
    } as Record<string, any>,
    app: {
      theme: s.app.theme,
      language: s.app.language,
      autoRefresh: s.app.autoRefresh,
      refreshInterval: s.app.refreshInterval,
      notifications: s.app.notifications,
      analyticsEnabled: s.app.analyticsEnabled,
      hasPIN: !!s.app.accessPin,
    },
    updatedAt: s.updatedAt,
  }
}

// ─── GET /api/settings ── retorna configurações seguras ──────────────────────
router.get('/', (c) => {
  const { apiKey, environment, fromEnv } = resolveCircleCredentials(c)
  const settings = safeSettings(settingsStore)
  // Enriquecer com info do env Cloudflare (sem expor a chave)
  if (fromEnv) {
    settings.circle.hasApiKey = true
    settings.circle.apiKeyMasked = '••••• (Cloudflare Secret)'
    settings.circle.environment = environment as 'sandbox' | 'production'
  }
  return c.json({ success: true, settings })
})

// ─── POST /api/settings/verify-pin ── verificar PIN ─────────────────────────
router.post('/verify-pin', async (c) => {
  const { pin } = await c.req.json()
  if (!settingsStore.app.accessPin) {
    // Sem PIN configurado — acesso livre
    return c.json({ success: true, message: 'No PIN configured' })
  }
  if (pin === settingsStore.app.accessPin) {
    return c.json({ success: true, message: 'PIN valid' })
  }
  return c.json({ success: false, error: 'Invalid PIN' }, 401)
})

// ─── PUT /api/settings/profile ── salvar perfil ──────────────────────────────
router.put('/profile', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return c.json({ success: false, error: 'Invalid request body' }, 400)
  }
  const { name, email, role, company, walletAddress } = body

  // Validate & sanitize each field
  const cleanName    = clampString(stripTags(String(name    || '').trim()), 100)
  const cleanRole    = clampString(stripTags(String(role    || '').trim()), 50)
  const cleanCompany = clampString(stripTags(String(company || '').trim()), 100)

  // Email validation
  const cleanEmail = email ? String(email).trim().toLowerCase() : ''
  if (cleanEmail && !isValidEmail(cleanEmail)) {
    return c.json({ success: false, error: 'Invalid email address format' }, 400)
  }

  // Wallet address validation
  const cleanWallet = walletAddress ? String(walletAddress).trim() : ''
  if (cleanWallet && !isValidEthAddress(cleanWallet)) {
    return c.json({ success: false, error: 'Invalid wallet address format' }, 400)
  }

  settingsStore.profile = {
    ...settingsStore.profile,
    name:            cleanName    || settingsStore.profile.name,
    email:           cleanEmail   || settingsStore.profile.email,
    role:            cleanRole    || settingsStore.profile.role,
    company:         cleanCompany || settingsStore.profile.company,
    walletAddress:   cleanWallet  || settingsStore.profile.walletAddress,
    avatarInitials:  cleanName ? cleanName.split(' ').map((w: string) => w[0]).join('').toUpperCase().slice(0, 2) : settingsStore.profile.avatarInitials,
    updatedAt:       new Date().toISOString(),
  }
  settingsStore.updatedAt = new Date().toISOString()

  return c.json({ success: true, profile: settingsStore.profile, message: 'Profile saved' })
})

// ─── PUT /api/settings/circle ── salvar Circle API config ────────────────────
router.put('/circle', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return c.json({ success: false, error: 'Invalid request body' }, 400)
  }
  const { apiKey, environment, webhookSecret } = body

  // Validate environment value against allowlist
  const allowedEnvs = ['sandbox', 'production']
  if (environment && !allowedEnvs.includes(String(environment))) {
    return c.json({ success: false, error: 'Invalid environment value' }, 400)
  }

  // Só atualiza se o campo não for placeholder de mascaramento (••••••)
  if (apiKey && typeof apiKey === 'string' && !apiKey.includes('•')) {
    settingsStore.circle.apiKey = clampString(apiKey.trim(), 256)
  }
  if (webhookSecret && typeof webhookSecret === 'string' && !webhookSecret.includes('•')) {
    settingsStore.circle.webhookSecret = clampString(webhookSecret.trim(), 256)
  }
  if (environment) {
    settingsStore.circle.environment = String(environment)
  }

  // Reset conexão ao mudar config
  settingsStore.circle.isConnected = false
  settingsStore.circle.lastTestAt = null
  settingsStore.circle.testResult = null
  settingsStore.updatedAt = new Date().toISOString()

  return c.json({
    success: true,
    circle: {
      environment: settingsStore.circle.environment,
      apiKeyMasked: maskKey(settingsStore.circle.apiKey),
      webhookSecretMasked: maskKey(settingsStore.circle.webhookSecret),
      hasApiKey: !!settingsStore.circle.apiKey,
      isConnected: false,
    },
    message: 'Circle configuration saved',
  })
})

// ─── Helper: resolve Circle credentials (env > in-memory) ───────────────────
function resolveCircleCredentials(c: any) {
  // Priority: Cloudflare env secrets > in-memory store
  const apiKey = c.env?.CIRCLE_API_KEY || settingsStore.circle.apiKey
  const environment = c.env?.CIRCLE_ENVIRONMENT || settingsStore.circle.environment || 'sandbox'
  const webhookSecret = c.env?.CIRCLE_WEBHOOK_SECRET || settingsStore.circle.webhookSecret
  const fromEnv = !!(c.env?.CIRCLE_API_KEY)
  return { apiKey, environment, webhookSecret, fromEnv }
}

// ─── POST /api/settings/circle/test ── testar conexão Circle ────────────────
router.post('/circle/test', async (c) => {
  const { apiKey, environment, fromEnv } = resolveCircleCredentials(c)

  if (!apiKey) {
    return c.json({ success: false, error: 'No API key configured. Add CIRCLE_API_KEY as a Cloudflare secret or configure it in settings.' }, 400)
  }

  try {
    const baseUrl = environment === 'production'
      ? 'https://api.circle.com/v1'
      : 'https://api-sandbox.circle.com/v1'

    // Teste real: GET /ping
    const response = await fetch(`${baseUrl}/ping`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    })

    const data = await response.json().catch(() => ({}))

    if (response.ok) {
      settingsStore.circle.isConnected = true
      settingsStore.circle.lastTestAt = new Date().toISOString()
      settingsStore.circle.testResult = 'Connected successfully'
      return c.json({
        success: true,
        status: response.status,
        message: 'Circle API connected successfully',
        environment,
        keySource: fromEnv ? 'cloudflare_secret' : 'in_memory',
        data,
      })
    } else if (response.status === 401) {
      settingsStore.circle.isConnected = false
      settingsStore.circle.testResult = 'Invalid API key'
      return c.json({ success: false, error: 'Invalid API key (401 Unauthorized)', status: 401, keySource: fromEnv ? 'cloudflare_secret' : 'in_memory' }, 400)
    } else {
      settingsStore.circle.isConnected = false
      settingsStore.circle.testResult = `Error ${response.status}`
      return c.json({ success: false, error: `Circle API returned ${response.status}`, status: response.status }, 400)
    }
  } catch (err: any) {
    settingsStore.circle.isConnected = false
    settingsStore.circle.testResult = 'Connection failed'
    return c.json({ success: false, error: `Connection failed: ${err.message}` }, 500)
  }
})

// ─── GET /api/settings/circle/balance ── saldo Circle ───────────────────────
router.get('/circle/balance', async (c) => {
  const { apiKey, environment, fromEnv } = resolveCircleCredentials(c)

  if (!apiKey) {
    return c.json({ success: false, error: 'No API key configured' }, 400)
  }
  try {
    const baseUrl = environment === 'production'
      ? 'https://api.circle.com/v1'
      : 'https://api-sandbox.circle.com/v1'

    const res = await fetch(`${baseUrl}/businessAccount/balances`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    })
    const data = await res.json()
    return c.json({ success: res.ok, data, status: res.status, keySource: fromEnv ? 'cloudflare_secret' : 'in_memory' })
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 500)
  }
})

// ─── GET /api/settings/circle/status ── status rápido da Circle ─────────────
router.get('/circle/status', async (c) => {
  const { apiKey, environment, fromEnv } = resolveCircleCredentials(c)
  if (!apiKey) {
    return c.json({
      success: true,
      hasKey: false,
      isConnected: false,
      keySource: 'none',
      environment: 'sandbox',
      message: 'No API key configured',
    })
  }
  return c.json({
    success: true,
    hasKey: true,
    isConnected: settingsStore.circle.isConnected,
    lastTestAt: settingsStore.circle.lastTestAt,
    testResult: settingsStore.circle.testResult,
    keySource: fromEnv ? 'cloudflare_secret' : 'in_memory',
    environment,
    apiKeyMasked: fromEnv ? '••••• (Cloudflare Secret)' : maskKey(apiKey),
  })
})

// ─── PUT /api/settings/app ── configurações do app ───────────────────────────
router.put('/app', async (c) => {
  const body = await c.req.json()
  const { theme, language, autoRefresh, refreshInterval, notifications, analyticsEnabled, accessPin, currentPin } = body

  // Verificar PIN atual se já existe
  if (settingsStore.app.accessPin && accessPin !== undefined) {
    if (currentPin !== settingsStore.app.accessPin) {
      return c.json({ success: false, error: 'Current PIN is incorrect' }, 401)
    }
  }

  settingsStore.app = {
    ...settingsStore.app,
    ...(theme !== undefined && { theme }),
    ...(language !== undefined && { language }),
    ...(autoRefresh !== undefined && { autoRefresh }),
    ...(refreshInterval !== undefined && { refreshInterval: Number(refreshInterval) }),
    ...(notifications !== undefined && { notifications }),
    ...(analyticsEnabled !== undefined && { analyticsEnabled }),
    ...(accessPin !== undefined && { accessPin: accessPin.trim() }),
  }
  settingsStore.updatedAt = new Date().toISOString()

  return c.json({
    success: true,
    app: {
      theme: settingsStore.app.theme,
      language: settingsStore.app.language,
      autoRefresh: settingsStore.app.autoRefresh,
      refreshInterval: settingsStore.app.refreshInterval,
      notifications: settingsStore.app.notifications,
      analyticsEnabled: settingsStore.app.analyticsEnabled,
      hasPIN: !!settingsStore.app.accessPin,
    },
    message: 'App settings saved',
  })
})

// ─── DELETE /api/settings/circle ── remover Circle config ───────────────────
router.delete('/circle', (c) => {
  settingsStore.circle = { ...DEFAULT_SETTINGS.circle }
  settingsStore.updatedAt = new Date().toISOString()
  return c.json({ success: true, message: 'Circle configuration removed' })
})

// ─── DELETE /api/settings/profile ── resetar perfil ──────────────────────────
router.delete('/profile', (c) => {
  settingsStore.profile = {
    ...DEFAULT_SETTINGS.profile,
    createdAt: settingsStore.profile.createdAt,
    updatedAt: new Date().toISOString(),
  }
  settingsStore.updatedAt = new Date().toISOString()
  return c.json({ success: true, message: 'Profile reset' })
})

export default router
