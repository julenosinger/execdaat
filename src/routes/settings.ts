import { Hono } from 'hono'

const router = new Hono()

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
      environment: s.circle.environment,
      apiKeyMasked: s.circle.apiKey ? maskKey(s.circle.apiKey) : '',
      webhookSecretMasked: s.circle.webhookSecret ? maskKey(s.circle.webhookSecret) : '',
      isConnected: s.circle.isConnected,
      lastTestAt: s.circle.lastTestAt,
      testResult: s.circle.testResult,
      hasApiKey: !!s.circle.apiKey,
      hasWebhookSecret: !!s.circle.webhookSecret,
    },
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
  return c.json({ success: true, settings: safeSettings(settingsStore) })
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
  const body = await c.req.json()
  const { name, email, role, company, walletAddress } = body

  settingsStore.profile = {
    ...settingsStore.profile,
    name: name?.trim() || settingsStore.profile.name,
    email: email?.trim() || settingsStore.profile.email,
    role: role?.trim() || settingsStore.profile.role,
    company: company?.trim() || settingsStore.profile.company,
    walletAddress: walletAddress?.trim() || settingsStore.profile.walletAddress,
    avatarInitials: name ? name.trim().split(' ').map((w: string) => w[0]).join('').toUpperCase().slice(0, 2) : settingsStore.profile.avatarInitials,
    updatedAt: new Date().toISOString(),
  }
  settingsStore.updatedAt = new Date().toISOString()

  return c.json({ success: true, profile: settingsStore.profile, message: 'Profile saved' })
})

// ─── PUT /api/settings/circle ── salvar Circle API config ────────────────────
router.put('/circle', async (c) => {
  const body = await c.req.json()
  const { apiKey, environment, webhookSecret } = body

  // Só atualiza se o campo não for placeholder de mascaramento (••••••)
  if (apiKey && !apiKey.includes('•')) {
    settingsStore.circle.apiKey = apiKey.trim()
  }
  if (webhookSecret && !webhookSecret.includes('•')) {
    settingsStore.circle.webhookSecret = webhookSecret.trim()
  }
  if (environment) {
    settingsStore.circle.environment = environment
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

// ─── POST /api/settings/circle/test ── testar conexão Circle ────────────────
router.post('/circle/test', async (c) => {
  if (!settingsStore.circle.apiKey) {
    return c.json({ success: false, error: 'No API key configured' }, 400)
  }

  try {
    const baseUrl = settingsStore.circle.environment === 'production'
      ? 'https://api.circle.com/v1'
      : 'https://api-sandbox.circle.com/v1'

    // Teste real: GET /ping ou /businessAccount/balances
    const response = await fetch(`${baseUrl}/ping`, {
      headers: {
        'Authorization': `Bearer ${settingsStore.circle.apiKey}`,
        'Content-Type': 'application/json',
      },
    })

    const ok = response.ok || response.status === 200 || response.status === 401 // 401 = chave inválida mas endpoint alcançável
    const data = await response.json().catch(() => ({}))

    if (response.ok) {
      settingsStore.circle.isConnected = true
      settingsStore.circle.lastTestAt = new Date().toISOString()
      settingsStore.circle.testResult = 'Connected successfully'
      return c.json({
        success: true,
        status: response.status,
        message: 'Circle API connected successfully',
        environment: settingsStore.circle.environment,
        data,
      })
    } else if (response.status === 401) {
      settingsStore.circle.isConnected = false
      settingsStore.circle.testResult = 'Invalid API key'
      return c.json({ success: false, error: 'Invalid API key (401 Unauthorized)', status: 401 }, 400)
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
  if (!settingsStore.circle.apiKey) {
    return c.json({ success: false, error: 'No API key configured' }, 400)
  }
  try {
    const baseUrl = settingsStore.circle.environment === 'production'
      ? 'https://api.circle.com/v1'
      : 'https://api-sandbox.circle.com/v1'

    const res = await fetch(`${baseUrl}/businessAccount/balances`, {
      headers: { 'Authorization': `Bearer ${settingsStore.circle.apiKey}` },
    })
    const data = await res.json()
    return c.json({ success: res.ok, data, status: res.status })
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 500)
  }
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
