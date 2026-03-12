import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'
import paymentsRouter from './routes/payments'
import contractsRouter from './routes/contracts'
import settingsRouter from './routes/settings'
import swapRouter from './routes/swap'
import vaultsRouter, { vaultStore } from './routes/vaults'
import chatRouter from './routes/chat'
import guardianRouter from './routes/guardian'
import yieldRouter from './routes/yield-optimizer'
import { ARC_TESTNET } from './types/arc'
import { injectVaultStore } from './agents/PaymentAgent'

// Injetar vault store no agente de pagamentos para que ele possa
// consultar e usar saldo depositado pelo usuário sem chamadas HTTP
injectVaultStore(vaultStore)

const app = new Hono()

// CORS para comunicação frontend-backend
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}))

// Servir arquivos estáticos
app.use('/static/*', serveStatic({ root: './public' }))

// Rotas da API
app.route('/api/payments', paymentsRouter)
app.route('/api/contracts', contractsRouter)
app.route('/api/settings', settingsRouter)
app.route('/api/swap', swapRouter)
app.route('/api/vaults', vaultsRouter)
app.route('/api/chat', chatRouter)
app.route('/api/guardian', guardianRouter)
app.route('/api/yield', yieldRouter)

// GET /api/status - Status geral do sistema
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
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ARC AI Agents — Autonomous Payments &amp; Contracts</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🤖</text></svg>">
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
  <!-- csv-upload.js handles all CSV parsing natively -->
  <link href="/static/styles.css" rel="stylesheet">
  <script src="/static/i18n.js"></script>
</head>
<body class="bg-gray-950 text-gray-100 min-h-screen">
  <!-- Header -->
  <header class="bg-gray-900 border-b border-purple-800/40 px-6 py-4 sticky top-0 z-50 backdrop-blur-sm">
    <div class="max-w-7xl mx-auto flex items-center justify-between">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-600 to-blue-600 flex items-center justify-center">
          <i class="fas fa-robot text-white text-lg"></i>
        </div>
        <div>
          <h1 class="font-bold text-lg text-white" data-i18n="app_name">ARC AI Agents</h1>
          <p class="text-xs text-purple-400" data-i18n="app_subtitle">Autonomous Payments &amp; Contracts</p>
        </div>
      </div>
      <div class="flex items-center gap-2 sm:gap-3">
        <!-- Language Selector -->
        <div id="lang-selector" class="relative">
          <button onclick="toggleLangDropdown()"
            class="flex items-center gap-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-gray-500 rounded-xl px-3 py-2 text-sm text-gray-300 transition-all">
            <i class="fas fa-globe text-purple-400 text-xs"></i>
            <span id="lang-toggle-label" class="hidden sm:inline">🇺🇸 English <i class="fas fa-chevron-down text-xs ml-1 text-gray-500"></i></span>
          </button>
          <div id="lang-dropdown" class="hidden absolute right-0 top-full mt-1 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl z-50 min-w-[160px] overflow-hidden">
            <button onclick="setLang('en')" data-lang="en" class="lang-option w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-800 border border-transparent transition-all">
              <span class="text-base">🇺🇸</span> English
            </button>
            <button onclick="setLang('pt')" data-lang="pt" class="lang-option w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-800 border border-transparent transition-all">
              <span class="text-base">🇧🇷</span> Português
            </button>
            <button onclick="setLang('es')" data-lang="es" class="lang-option w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-800 border border-transparent transition-all">
              <span class="text-base">🇪🇸</span> Español
            </button>
            <button onclick="setLang('zh')" data-lang="zh" class="lang-option w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-800 border border-transparent transition-all">
              <span class="text-base">🇨🇳</span> 中文
            </button>
            <button onclick="setLang('ko')" data-lang="ko" class="lang-option w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-800 border border-transparent transition-all">
              <span class="text-base">🇰🇷</span> 한국어
            </button>
          </div>
        </div>

        <!-- Arc Network badge -->
        <div class="hidden sm:flex items-center gap-2 bg-green-900/40 border border-green-700/50 rounded-full px-3 py-1.5">
          <div class="w-2 h-2 rounded-full bg-green-400 animate-pulse"></div>
          <span class="text-xs text-green-400 font-medium">Arc Testnet</span>
        </div>
        <!-- Quick links -->
        <a href="https://testnet.arcscan.app" target="_blank" class="hidden md:block text-xs text-gray-400 hover:text-purple-400 transition-colors">
          <i class="fas fa-external-link-alt mr-1"></i><span data-i18n="explorer">Explorer</span>
        </a>
        <a href="https://faucet.circle.com" target="_blank" class="hidden md:block text-xs text-gray-400 hover:text-blue-400 transition-colors">
          <i class="fas fa-faucet mr-1"></i><span data-i18n="faucet">Faucet</span>
        </a>

        <!-- Wallet info (quando conectada) -->
        <div id="wallet-info" class="hidden items-center gap-2 bg-gray-800/80 border border-gray-700/50 rounded-xl px-3 py-2 cursor-pointer hover:border-purple-600/50 transition-all" onclick="openWalletModal()">
          <div class="w-6 h-6 rounded-full bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center flex-shrink-0 text-white text-xs font-bold" id="wallet-avatar">??</div>
          <div class="hidden sm:block">
            <div class="text-xs text-white font-mono font-medium leading-none" id="wallet-address-display">0x...</div>
            <div id="wallet-network-display" class="text-xs text-green-400 leading-none mt-0.5"></div>
          </div>
          <div id="wallet-balance-display" class="hidden text-xs text-blue-400 font-medium bg-blue-900/30 px-2 py-0.5 rounded-full"></div>
        </div>

        <!-- Settings button -->
        <button onclick="openSettingsModal()"
          id="settings-btn"
          class="w-9 h-9 flex items-center justify-center bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-gray-500 rounded-xl text-gray-400 hover:text-white transition-all relative"
          title="Settings">
          <i class="fas fa-cog text-sm"></i>
          <span id="settings-dot" class="hidden absolute -top-1 -right-1 w-2.5 h-2.5 bg-purple-500 rounded-full border-2 border-gray-900"></span>
        </button>

        <!-- Profile button -->
        <button onclick="openProfileModal()"
          id="profile-btn"
          class="w-9 h-9 flex items-center justify-center bg-gradient-to-br from-purple-700 to-blue-700 hover:from-purple-600 hover:to-blue-600 border border-purple-600/40 rounded-xl text-white font-bold text-xs transition-all"
          title="Profile">
          <span id="profile-avatar-btn">👤</span>
        </button>

        <!-- Botão conectar wallet -->
        <button id="wallet-connect-btn" onclick="openWalletModal()"
          class="wallet-connect-pulse flex items-center gap-2 bg-purple-600 hover:bg-purple-700 text-white rounded-xl px-4 py-2 text-sm font-semibold transition-all shadow-lg shadow-purple-900/30">
          <i class="fas fa-wallet"></i>
          <span class="hidden sm:inline" data-i18n="btn_connect">Connect</span>
        </button>

        <!-- Badge de wallet conectada (mobile) -->
        <div id="wallet-badge" class="hidden sm:hidden w-2 h-2 rounded-full bg-green-400"></div>
      </div>
    </div>
  </header>

  <!-- Tabs -->
  <div class="bg-gray-900/60 border-b border-gray-800">
    <div class="max-w-7xl mx-auto px-6">
      <div class="flex gap-0">
        <button onclick="switchTab('dashboard')" id="tab-dashboard" class="tab-btn active px-6 py-4 text-sm font-medium border-b-2 border-purple-500 text-purple-400 transition-all">
          <i class="fas fa-chart-line mr-2"></i><span data-i18n="tab_dashboard">Dashboard</span>
        </button>
        <button onclick="switchTab('payments')" id="tab-payments" class="tab-btn px-6 py-4 text-sm font-medium border-b-2 border-transparent text-gray-400 hover:text-gray-200 transition-all">
          <i class="fas fa-dollar-sign mr-2"></i><span data-i18n="tab_payments">Payments</span>
        </button>
        <button onclick="switchTab('contracts')" id="tab-contracts" class="tab-btn px-6 py-4 text-sm font-medium border-b-2 border-transparent text-gray-400 hover:text-gray-200 transition-all">
          <i class="fas fa-file-contract mr-2"></i><span data-i18n="tab_contracts">Contracts</span>
        </button>
        <button onclick="switchTab('agents')" id="tab-agents" class="tab-btn px-6 py-4 text-sm font-medium border-b-2 border-transparent text-gray-400 hover:text-gray-200 transition-all">
          <i class="fas fa-brain mr-2"></i><span data-i18n="tab_agents">AI Agents</span>
        </button>
        <button onclick="switchTab('swap')" id="tab-swap" class="tab-btn px-6 py-4 text-sm font-medium border-b-2 border-transparent text-gray-400 hover:text-gray-200 transition-all">
          <i class="fas fa-exchange-alt mr-2"></i><span data-i18n="tab_swap">Swap</span>
        </button>
        <button onclick="switchTab('vaults')" id="tab-vaults" class="tab-btn px-6 py-4 text-sm font-medium border-b-2 border-transparent text-gray-400 hover:text-gray-200 transition-all">
          <i class="fas fa-vault mr-2"></i><span data-i18n="tab_vaults">Vaults</span>
        </button>
        <button onclick="switchTab('deploy')" id="tab-deploy" class="tab-btn px-6 py-4 text-sm font-medium border-b-2 border-transparent text-gray-400 hover:text-gray-200 transition-all">
          <i class="fas fa-rocket mr-2"></i><span data-i18n="tab_deploy">Deploy</span>
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

      <!-- Recent Activity -->
      <div class="bg-gray-900/60 border border-gray-700/40 rounded-xl p-6">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-white font-semibold flex items-center gap-2">
            <i class="fas fa-history text-gray-400"></i>
            <span data-i18n="recent_activity">Recent Activity</span>
          </h3>
          <button onclick="loadDashboard()" class="text-xs text-purple-400 hover:text-purple-300">
            <i class="fas fa-sync mr-1"></i><span data-i18n="btn_refresh">Refresh</span>
          </button>
        </div>
        <div id="recent-activity" class="space-y-2">
          <div class="text-gray-500 text-sm text-center py-4" data-i18n="loading_activity">Loading activities...</div>
        </div>
      </div>
    </div>

    <!-- PAYMENTS TAB -->
    <div id="tab-content-payments" class="tab-content hidden">
      <div class="grid grid-cols-1 xl:grid-cols-5 gap-6">

        <!-- ═══════════════════════════════════════════════════
             COLUNA ESQUERDA — Send Payment (EVM Real)
             ═══════════════════════════════════════════════════ -->
        <div class="xl:col-span-3 space-y-5">

          <!-- ── WALLET BANNER ── -->
          <div class="bg-gray-900/70 border border-purple-700/40 rounded-2xl p-4 flex items-center justify-between gap-4 flex-wrap">
            <div class="flex items-center gap-3">
              <div class="w-9 h-9 rounded-full bg-gradient-to-br from-purple-600 to-blue-600 flex items-center justify-center">
                <i class="fas fa-wallet text-white text-sm"></i>
              </div>
              <div>
                <p class="text-xs text-gray-500 uppercase tracking-wider">Wallet</p>
                <p id="pay-wallet-short" class="text-white text-sm font-mono font-semibold">Not connected</p>
              </div>
            </div>
            <div class="flex items-center gap-4 flex-wrap">
              <div class="text-right">
                <p class="text-xs text-gray-500">USDC</p>
                <p id="pay-balance-usdc" class="text-cyan-400 text-sm font-bold">— USDC</p>
              </div>
              <div class="text-right">
                <p class="text-xs text-gray-500">EURC</p>
                <p id="pay-balance-eurc" class="text-purple-400 text-sm font-bold">— EURC</p>
              </div>
              <div class="text-right">
                <p class="text-xs text-gray-500">Network</p>
                <p id="pay-network-name" class="text-green-400 text-xs font-semibold">—</p>
              </div>
              <button onclick="refreshPaymentBalances()"
                class="w-8 h-8 flex items-center justify-center bg-gray-800 hover:bg-gray-700 border border-gray-600 text-gray-400 hover:text-cyan-400 rounded-lg transition-all text-xs">
                <i class="fas fa-sync"></i>
              </button>
            </div>
          </div>

          <!-- ── SEND PAYMENT PANEL ── -->
          <div class="bg-gray-900/70 border border-gray-700/50 rounded-2xl overflow-hidden">

            <!-- Header -->
            <div class="px-5 py-4 border-b border-gray-700/40 flex items-center justify-between">
              <div class="flex items-center gap-2">
                <i class="fas fa-paper-plane text-cyan-400"></i>
                <h3 class="text-white font-semibold text-sm">Send Payment</h3>
              </div>
              <div class="flex items-center gap-1.5">
                <span class="text-xs text-gray-500">Token:</span>
                <button id="pay-token-usdc" onclick="selectPayToken('USDC')"
                  class="px-4 py-2 rounded-lg border text-sm font-semibold transition-all bg-cyan-700 text-white border-cyan-500">
                  USDC
                </button>
                <button id="pay-token-eurc" onclick="selectPayToken('EURC')"
                  class="px-4 py-2 rounded-lg border text-sm font-semibold transition-all bg-gray-800 text-gray-400 border-gray-700 hover:border-gray-500">
                  EURC
                </button>
              </div>
            </div>

            <!-- Form body -->
            <div class="p-5 space-y-4">

              <!-- Recipient -->
              <div>
                <label class="text-xs text-gray-400 uppercase tracking-wider mb-1.5 block">Recipient Address</label>
                <input type="text" id="pay-recipient" placeholder="0x... recipient wallet address"
                  oninput="updatePayPreview(); validatePayForm()"
                  class="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:border-cyan-500 focus:outline-none font-mono transition-colors">
              </div>

              <!-- Amount + MAX -->
              <div>
                <div class="flex justify-between items-center mb-1.5">
                  <label class="text-xs text-gray-400 uppercase tracking-wider">Amount</label>
                  <span id="pay-max-hint" class="text-xs text-gray-600"></span>
                </div>
                <div class="flex gap-2">
                  <input type="number" id="pay-amount" placeholder="0.000000" min="0" step="0.000001"
                    oninput="updatePayPreview(); validatePayForm()"
                    class="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:border-cyan-500 focus:outline-none transition-colors">
                  <button onclick="setPayMax()"
                    class="px-4 py-2 bg-gray-700 hover:bg-gray-600 border border-gray-600 text-cyan-400 text-xs font-bold rounded-xl transition-colors">
                    MAX
                  </button>
                </div>
              </div>

              <!-- Description / Note -->
              <div>
                <label class="text-xs text-gray-400 uppercase tracking-wider mb-1.5 block">Note (optional)</label>
                <input type="text" id="pay-description" placeholder="Payment for services, invoice #123..."
                  oninput="updatePayPreview()"
                  class="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:border-gray-500 focus:outline-none transition-colors">
              </div>

              <!-- Transaction Preview -->
              <div class="bg-gray-800/60 border border-gray-700/40 rounded-xl p-4 space-y-2">
                <p class="text-xs text-gray-400 uppercase tracking-wider mb-2">Transaction Preview</p>
                <div class="flex justify-between text-xs">
                  <span class="text-gray-500">Token</span>
                  <span id="prev-token" class="text-cyan-400 font-semibold">USDC</span>
                </div>
                <div class="flex justify-between text-xs">
                  <span class="text-gray-500">Amount</span>
                  <span id="prev-amount" class="text-white font-bold">—</span>
                </div>
                <div class="flex justify-between text-xs">
                  <span class="text-gray-500">To</span>
                  <span id="prev-recipient" class="text-gray-300 font-mono">—</span>
                </div>
                <div class="flex justify-between text-xs">
                  <span class="text-gray-500">From</span>
                  <span id="pay-from-display" class="text-gray-300 font-mono">—</span>
                </div>
                <div class="flex justify-between text-xs">
                  <span class="text-gray-500">Network</span>
                  <span id="prev-network" class="text-green-400">Arc Testnet</span>
                </div>
                <div class="flex justify-between text-xs">
                  <span class="text-gray-500">Gas</span>
                  <span id="prev-gas" class="text-yellow-400">~1 tx (native)</span>
                </div>
              </div>

              <!-- Error box -->
              <div id="pay-error-box" class="hidden bg-red-900/20 border border-red-700/40 rounded-xl px-4 py-3 flex items-start gap-2">
                <i class="fas fa-exclamation-circle text-red-400 mt-0.5 flex-shrink-0"></i>
                <div class="flex-1">
                  <span id="pay-error-text" class="text-red-300 text-xs"></span>
                </div>
                <button onclick="hidePayError()" class="text-gray-600 hover:text-gray-400 text-xs ml-1">✕</button>
              </div>

              <!-- Send button -->
              <button id="pay-send-btn" onclick="executePayment()" disabled
                class="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-cyan-700 to-blue-700 hover:from-cyan-600 hover:to-blue-600 disabled:from-gray-700 disabled:to-gray-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold rounded-xl py-3 text-sm transition-all shadow-lg shadow-cyan-900/20">
                <i class="fas fa-paper-plane mr-2"></i>Sign &amp; Send
              </button>

              <!-- ARC note -->
              <p class="text-xs text-gray-600 text-center">
                <i class="fas fa-info-circle mr-1"></i>
                USDC is the native gas token on Arc Testnet. Dynamic gas estimation. No hard-coded values.
              </p>
            </div>
          </div>

          <!-- ── PROGRESS STEPS ── -->
          <div id="pay-steps-panel" class="hidden bg-gray-900/70 border border-gray-700/50 rounded-2xl p-5">
            <p class="text-xs text-gray-400 uppercase tracking-wider mb-4">Transaction Progress</p>
            <div class="space-y-2">
              <div id="pay-step-0" class="pay-step pay-step-idle flex items-center gap-3">
                <div class="pay-step-icon w-6 h-6 rounded-full flex items-center justify-center text-xs flex-shrink-0">
                  <i class="fas fa-network-wired"></i>
                </div>
                <span id="pay-step-label-0" class="text-xs">Verify Arc Testnet network</span>
              </div>
              <div id="pay-step-1" class="pay-step pay-step-idle flex items-center gap-3">
                <div class="pay-step-icon w-6 h-6 rounded-full flex items-center justify-center text-xs flex-shrink-0">
                  <i class="fas fa-coins"></i>
                </div>
                <span id="pay-step-label-1" class="text-xs">Read on-chain balance</span>
              </div>
              <div id="pay-step-2" class="pay-step pay-step-idle flex items-center gap-3">
                <div class="pay-step-icon w-6 h-6 rounded-full flex items-center justify-center text-xs flex-shrink-0">
                  <i class="fas fa-check-double"></i>
                </div>
                <span id="pay-step-label-2" class="text-xs">Approve token spending (EURC only)</span>
              </div>
              <div id="pay-step-3" class="pay-step pay-step-idle flex items-center gap-3">
                <div class="pay-step-icon w-6 h-6 rounded-full flex items-center justify-center text-xs flex-shrink-0">
                  <i class="fas fa-signature"></i>
                </div>
                <span id="pay-step-label-3" class="text-xs">Sign &amp; broadcast transaction</span>
              </div>
              <div id="pay-step-4" class="pay-step pay-step-idle flex items-center gap-3">
                <div class="pay-step-icon w-6 h-6 rounded-full flex items-center justify-center text-xs flex-shrink-0">
                  <i class="fas fa-hourglass-half"></i>
                </div>
                <span id="pay-step-label-4" class="text-xs">Wait for on-chain confirmation</span>
              </div>
              <div id="pay-step-5" class="pay-step pay-step-idle flex items-center gap-3">
                <div class="pay-step-icon w-6 h-6 rounded-full flex items-center justify-center text-xs flex-shrink-0">
                  <i class="fas fa-receipt"></i>
                </div>
                <span id="pay-step-label-5" class="text-xs">Generate receipt</span>
              </div>
            </div>
          </div>

          <!-- ── RECEIPT PANEL ── -->
          <div id="pay-receipt-panel" class="hidden">
            <div id="pay-receipt-content"></div>
          </div>

          <!-- ── BATCH / CSV SECTION (collapsible) ── -->
          <details class="bg-gray-900/50 border border-gray-700/40 rounded-2xl overflow-hidden">
            <summary class="px-5 py-3 cursor-pointer text-sm text-gray-300 hover:text-white flex items-center gap-2 select-none list-none">
              <i class="fas fa-table text-cyan-600"></i>
              <span class="font-medium">Batch / Multi-send (CSV)</span>
              <i class="fas fa-chevron-down text-xs text-gray-600 ml-auto"></i>
            </summary>
            <div class="border-t border-gray-700/40">

              <!-- Cabeçalho do painel multi-send -->
              <div class="flex items-center justify-between px-5 py-4 border-b border-gray-700/40">
                <div class="flex items-center gap-4">
                  <div>
                    <p class="text-xs text-gray-500 uppercase tracking-wider mb-0.5">Token</p>
                    <p class="text-cyan-400 font-bold text-lg leading-none">USDC</p>
                  </div>
                  <div class="w-px h-8 bg-gray-700/60"></div>
                  <div>
                    <p class="text-xs text-gray-500 uppercase tracking-wider mb-0.5">Total to Send</p>
                    <p id="multisend-total" class="text-cyan-400 font-bold text-lg leading-none">0.0000 <span class="text-sm text-gray-400 font-normal">USDC</span></p>
                  </div>
                </div>
                <div class="flex items-center gap-2">
                  <input id="csv-file-input" type="file" accept=".csv,.txt" class="hidden"
                    onchange="handleCSVFile(this.files[0])">
                  <button
                    onclick="document.getElementById('csv-file-input').click()"
                    ondragover="event.preventDefault(); event.currentTarget.classList.add('border-cyan-400','bg-cyan-900/20')"
                    ondragleave="event.currentTarget.classList.remove('border-cyan-400','bg-cyan-900/20')"
                    ondrop="event.preventDefault(); event.currentTarget.classList.remove('border-cyan-400','bg-cyan-900/20'); handleCSVFile(event.dataTransfer.files[0])"
                    class="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 border border-gray-600 hover:border-cyan-500 text-gray-200 font-semibold rounded-xl px-4 py-2.5 text-sm transition-all">
                    <i class="fas fa-upload text-cyan-400"></i>
                    <span>CSV</span>
                  </button>
                  <button onclick="downloadCSVTemplate()" title="Download CSV template"
                    class="w-9 h-9 flex items-center justify-center bg-gray-800 hover:bg-gray-700 border border-gray-600 hover:border-gray-500 text-gray-400 hover:text-cyan-400 rounded-xl transition-all">
                    <i class="fas fa-download text-xs"></i>
                  </button>
                </div>
              </div>

              <div id="csv-error-banner" class="hidden px-5 py-2 bg-red-900/20 border-b border-red-700/30 flex items-center gap-2">
                <i class="fas fa-exclamation-circle text-red-400 text-xs"></i>
                <span id="csv-error-text" class="text-xs text-red-300"></span>
              </div>

              <div class="grid grid-cols-12 gap-3 px-5 py-2 bg-gray-800/30 border-b border-gray-700/30">
                <div class="col-span-5 text-xs text-gray-500 uppercase tracking-wider">ADDRESS</div>
                <div class="col-span-3 text-xs text-gray-500 uppercase tracking-wider">AMOUNT (USDC)</div>
                <div class="col-span-3 text-xs text-gray-500 uppercase tracking-wider">NOTE</div>
                <div class="col-span-1"></div>
              </div>

              <div id="multisend-rows" class="divide-y divide-gray-800/60"></div>

              <div class="px-5 py-3 border-t border-gray-700/30">
                <button onclick="addMultisendRow()"
                  class="w-full flex items-center justify-center gap-2 text-cyan-400 hover:text-cyan-300 text-sm font-medium py-1 transition-colors">
                  <i class="fas fa-plus text-xs"></i> + Add Recipient
                </button>
              </div>

              <div class="px-5 py-3 border-t border-gray-700/30 bg-gray-800/20">
                <label class="text-xs text-gray-500 mb-1.5 block uppercase tracking-wider">From (Sender)</label>
                <input type="text" id="pay-from" placeholder="0x... (auto-filled by wallet)"
                  class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-cyan-500 focus:outline-none font-mono">
              </div>

              <div class="px-5 py-4 border-t border-gray-700/30 bg-gray-800/10">
                <div class="flex items-center gap-3 flex-wrap">
                  <div class="flex items-center gap-2">
                    <label class="text-xs text-gray-500">Priority:</label>
                    <select id="pay-priority"
                      class="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:border-cyan-500 focus:outline-none">
                      <option value="low">Low</option>
                      <option value="medium" selected>Medium</option>
                      <option value="high">High</option>
                      <option value="critical">Critical</option>
                    </select>
                  </div>
                  <div class="flex-1 flex gap-2 justify-end">
                    <button onclick="analyzeMultisend()"
                      class="flex items-center gap-2 bg-gray-700 hover:bg-gray-600 text-white rounded-xl px-4 py-2 text-sm font-medium transition-colors">
                      <i class="fas fa-brain text-purple-400"></i> AI Analysis
                    </button>
                    <button onclick="submitMultisend()"
                      class="flex items-center gap-2 bg-cyan-700 hover:bg-cyan-600 text-white rounded-xl px-5 py-2 text-sm font-bold transition-colors shadow-lg shadow-cyan-900/30">
                      <i class="fas fa-paper-plane"></i> Send All
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </details>

          <!-- CSV format hint -->
          <div class="bg-gray-900/40 border border-gray-700/30 rounded-xl px-4 py-3 flex items-start gap-3">
            <i class="fas fa-info-circle text-cyan-600 mt-0.5 flex-shrink-0"></i>
            <div class="text-xs text-gray-500">
              <strong class="text-gray-400">CSV Format:</strong>
              columns <code class="text-cyan-500 bg-gray-800 px-1 rounded">address</code>,
              <code class="text-cyan-500 bg-gray-800 px-1 rounded">amount</code>,
              <code class="text-gray-400 bg-gray-800 px-1 rounded">note</code> (optional),
              <code class="text-gray-400 bg-gray-800 px-1 rounded">priority</code> (optional) —
              max 500 rows · max $10,000 per row
            </div>
          </div>

          <div id="csv-preview-container" class="hidden"></div>
          <div id="payment-analysis-result" class="hidden"></div>

          <div class="flex gap-2">
            <button onclick="createDemoPayments()"
              class="flex-1 bg-blue-900/30 border border-blue-700/40 hover:bg-blue-800/40 text-blue-400 rounded-xl py-2 text-sm transition-colors">
              <i class="fas fa-flask mr-2"></i>Demo Payments
            </button>
            <button onclick="processPayments()"
              class="flex-1 bg-green-800/40 border border-green-700/40 hover:bg-green-700/50 text-green-400 rounded-xl py-2 text-sm font-medium transition-colors">
              <i class="fas fa-play mr-2"></i>Process Queue
            </button>
          </div>
        </div>

        <!-- ═══════════════════════════════════════════════════
             COLUNA DIREITA — Queue + History
             ═══════════════════════════════════════════════════ -->
        <div class="xl:col-span-2 space-y-4">

          <!-- On-chain payment history -->
          <div>
            <div class="flex items-center justify-between mb-3">
              <h3 class="text-white font-semibold flex items-center gap-2 text-sm">
                <i class="fas fa-history text-cyan-400"></i> On-chain History
              </h3>
              <button onclick="refreshPaymentBalances(); renderPaymentHistory()" class="text-xs text-gray-500 hover:text-gray-300 transition-colors">
                <i class="fas fa-sync mr-1"></i>Refresh
              </button>
            </div>
            <div id="pay-history-list" class="space-y-2">
              <div class="text-gray-600 text-xs text-center py-6 bg-gray-900/40 rounded-xl border border-gray-700/30">
                <i class="fas fa-clock text-2xl mb-2 block"></i>
                No transactions yet
              </div>
            </div>
          </div>

          <!-- Agent Payment Queue -->
          <div>
            <div class="flex items-center justify-between mb-3">
              <h3 class="text-white font-semibold flex items-center gap-2 text-sm">
                <i class="fas fa-robot text-purple-400"></i> Agent Queue
              </h3>
              <button onclick="loadPayments()" class="text-xs text-gray-500 hover:text-gray-300 transition-colors">
                <i class="fas fa-sync mr-1"></i>Update
              </button>
            </div>
            <div id="payments-list" class="space-y-3">
              <div class="text-gray-500 text-sm text-center py-8 bg-gray-900/40 rounded-xl border border-gray-700/30">
                <i class="fas fa-inbox text-4xl mb-3 block text-gray-700"></i>
                No payments in queue
              </div>
            </div>
          </div>

        </div>

      </div>
    </div>

    <!-- CONTRACTS TAB -->
    <div id="tab-content-contracts" class="tab-content hidden">
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <!-- Form de contrato -->
        <div class="lg:col-span-1">
          <div class="bg-gray-900/60 border border-gray-700/40 rounded-xl p-6">
            <h3 class="text-white font-semibold mb-4 flex items-center gap-2">
              <i class="fas fa-plus text-green-400"></i>
              <span data-i18n="new_contract">New Contract</span>
            </h3>
            <form id="contract-form" class="space-y-3">
              <div>
                <label class="text-xs text-gray-400 mb-1 block" data-i18n="ct_title_label">Title</label>
                <input type="text" id="ct-title" data-i18n-placeholder="ct_title_placeholder" placeholder="Contract name" class="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-green-500 focus:outline-none">
              </div>
              <div>
                <label class="text-xs text-gray-400 mb-1 block" data-i18n="ct_client_label">Client (0x...)</label>
                <input type="text" id="ct-client" placeholder="0x..." class="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-green-500 focus:outline-none font-mono">
              </div>
              <div>
                <label class="text-xs text-gray-400 mb-1 block" data-i18n="ct_contractor_label">Contractor (0x...)</label>
                <input type="text" id="ct-contractor" placeholder="0x..." class="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-green-500 focus:outline-none font-mono">
              </div>
              <div>
                <label class="text-xs text-gray-400 mb-1 block" data-i18n="ct_value_label">Total Value (USDC)</label>
                <input type="number" id="ct-value" placeholder="0.00" step="0.01" class="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-green-500 focus:outline-none">
              </div>
              <div>
                <label class="text-xs text-gray-400 mb-1 block" data-i18n="ct_desc_label">Description</label>
                <textarea id="ct-description" data-i18n-placeholder="ct_desc_placeholder" placeholder="Describe the work to be performed..." rows="3" class="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-green-500 focus:outline-none resize-none"></textarea>
              </div>
              <button type="submit" class="w-full bg-green-600 hover:bg-green-700 text-white rounded-lg py-2.5 text-sm font-medium transition-colors">
                <i class="fas fa-file-plus mr-2"></i><span data-i18n="btn_create_contract">Create Contract</span>
              </button>
            </form>
          </div>
        </div>

        <!-- Lista de contratos -->
        <div class="lg:col-span-2">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-white font-semibold" data-i18n="contracts_list">Contracts List</h3>
            <button onclick="loadContracts()" class="text-xs text-green-400 hover:text-green-300">
              <i class="fas fa-sync mr-1"></i><span data-i18n="btn_update">Update</span>
            </button>
          </div>
          <div id="contracts-list" class="space-y-4">
            <div class="text-gray-500 text-sm text-center py-8" data-i18n="loading_contracts">Loading contracts...</div>
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
            <h4 class="text-xs text-gray-400 mb-2" data-i18n="contract_flow">Contract Flow</h4>
            <div class="flex items-center gap-1 text-xs overflow-x-auto pb-1">
              <span class="bg-gray-700 text-gray-300 px-2 py-1 rounded whitespace-nowrap">📝 Draft</span>
              <i class="fas fa-arrow-right text-gray-600 flex-shrink-0"></i>
              <span class="bg-blue-900/50 text-blue-300 px-2 py-1 rounded whitespace-nowrap">✍️ <span data-i18n="status_signed">Signed</span></span>
              <i class="fas fa-arrow-right text-gray-600 flex-shrink-0"></i>
              <span class="bg-green-900/50 text-green-300 px-2 py-1 rounded whitespace-nowrap">🔒 Escrow</span>
              <i class="fas fa-arrow-right text-gray-600 flex-shrink-0"></i>
              <span class="bg-purple-900/50 text-purple-300 px-2 py-1 rounded whitespace-nowrap">✅ <span data-i18n="status_active">Active</span></span>
              <i class="fas fa-arrow-right text-gray-600 flex-shrink-0"></i>
              <span class="bg-yellow-900/50 text-yellow-300 px-2 py-1 rounded whitespace-nowrap">🏆 <span data-i18n="status_completed">Completed</span></span>
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

    <!-- DEPLOY TAB -->
    <div id="tab-content-deploy" class="tab-content hidden">
      <div class="max-w-4xl space-y-6">
        <!-- Guia de Deploy -->
        <div class="bg-gray-900/60 border border-gray-700/40 rounded-xl p-6">
          <h3 class="text-white font-bold text-lg mb-2 flex items-center gap-2">
            <i class="fas fa-rocket text-purple-400"></i>
            <span data-i18n="deploy_title">Deploy Smart Contracts</span>
          </h3>
          <p class="text-gray-400 text-sm mb-6" data-i18n="deploy_guide_desc">Follow the steps below to deploy the PaymentManager and ContractManager contracts on the Arc Testnet using Foundry.</p>

          <div class="space-y-5">
            <div class="step-card border border-gray-700/40 rounded-xl p-5">
              <div class="flex items-center gap-3 mb-3">
                <div class="w-8 h-8 rounded-full bg-purple-600 flex items-center justify-center text-white text-sm font-bold flex-shrink-0">1</div>
                <h4 class="text-white font-semibold" data-i18n="deploy_step1">Install Foundry</h4>
              </div>
              <pre class="bg-black/60 rounded-lg p-3 text-sm text-green-400 overflow-x-auto"><code>curl -L https://foundry.paradigm.xyz | bash
foundryup</code></pre>
            </div>

            <div class="step-card border border-gray-700/40 rounded-xl p-5">
              <div class="flex items-center gap-3 mb-3">
                <div class="w-8 h-8 rounded-full bg-purple-600 flex items-center justify-center text-white text-sm font-bold flex-shrink-0">2</div>
                <h4 class="text-white font-semibold" data-i18n="deploy_step2">Create Wallet &amp; Configure</h4>
              </div>
              <pre class="bg-black/60 rounded-lg p-3 text-sm text-green-400 overflow-x-auto"><code>cast wallet new
# Salvar o endereço e chave privada

# Criar .env na pasta contracts/
cat > contracts/.env << EOF
# RPC primário (alternativas: rpc.blockdaemon / rpc.drpc / rpc.quicknode .testnet.arc.network)
ARC_TESTNET_RPC_URL="https://rpc.testnet.arc.network"
PRIVATE_KEY="0xSUA_CHAVE_PRIVADA"
EOF</code></pre>
            </div>

            <div class="step-card border border-gray-700/40 rounded-xl p-5">
              <div class="flex items-center gap-3 mb-3">
                <div class="w-8 h-8 rounded-full bg-purple-600 flex items-center justify-center text-white text-sm font-bold flex-shrink-0">3</div>
                <h4 class="text-white font-semibold" data-i18n="deploy_step3">Get Testnet USDC</h4>
              </div>
              <p class="text-gray-400 text-sm mb-3" data-i18n="deploy_step3_desc">USDC is the native gas token of Arc. Get it free from the faucet:</p>
              <a href="https://faucet.circle.com" target="_blank" class="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg px-4 py-2 text-sm transition-colors">
                <i class="fas fa-faucet"></i>
                faucet.circle.com → Arc Testnet
              </a>
            </div>

            <div class="step-card border border-gray-700/40 rounded-xl p-5">
              <div class="flex items-center gap-3 mb-3">
                <div class="w-8 h-8 rounded-full bg-purple-600 flex items-center justify-center text-white text-sm font-bold flex-shrink-0">4</div>
                <h4 class="text-white font-semibold" data-i18n="deploy_step4">Initialize Foundry Project &amp; Compile</h4>
              </div>
              <pre class="bg-black/60 rounded-lg p-3 text-sm text-green-400 overflow-x-auto"><code>cd contracts/
forge init --no-git
# Copiar contratos src/PaymentManager.sol e src/ContractManager.sol
source .env
forge build</code></pre>
            </div>

            <div class="step-card border border-gray-700/40 rounded-xl p-5">
              <div class="flex items-center gap-3 mb-3">
                <div class="w-8 h-8 rounded-full bg-purple-600 flex items-center justify-center text-white text-sm font-bold flex-shrink-0">5</div>
                <h4 class="text-white font-semibold" data-i18n="deploy_step5">Deploy on Arc Testnet</h4>
              </div>
              <pre class="bg-black/60 rounded-lg p-3 text-sm text-green-400 overflow-x-auto"><code># Deploy do PaymentManager
forge create src/PaymentManager.sol:PaymentManager \\
  --rpc-url $ARC_TESTNET_RPC_URL \\
  --private-key $PRIVATE_KEY \\
  --constructor-args $SEU_ENDERECO \\
  --broadcast

# Deploy do ContractManager
forge create src/ContractManager.sol:ContractManager \\
  --rpc-url $ARC_TESTNET_RPC_URL \\
  --private-key $PRIVATE_KEY \\
  --constructor-args $SEU_ENDERECO \\
  --broadcast</code></pre>
            </div>

            <div class="step-card border border-gray-700/40 rounded-xl p-5">
              <div class="flex items-center gap-3 mb-3">
                <div class="w-8 h-8 rounded-full bg-green-600 flex items-center justify-center text-white text-sm font-bold flex-shrink-0">6</div>
                <h4 class="text-white font-semibold" data-i18n="deploy_step6">Verify Deploy on Explorer</h4>
              </div>
              <p class="text-gray-400 text-sm mb-3" data-i18n="deploy_step6_desc">Confirm the deployment on the Arc Testnet explorer:</p>
              <a href="https://testnet.arcscan.app" target="_blank" class="inline-flex items-center gap-2 bg-green-700 hover:bg-green-600 text-white rounded-lg px-4 py-2 text-sm transition-colors">
                <i class="fas fa-search"></i>
                testnet.arcscan.app
              </a>
            </div>
          </div>
        </div>

        <!-- ABI dos Contratos -->
        <div class="bg-gray-900/60 border border-gray-700/40 rounded-xl p-6">
          <h3 class="text-white font-semibold mb-4 flex items-center gap-2">
            <i class="fas fa-code text-yellow-400"></i>
            <span data-i18n="contracts_abi_title">Contract Addresses &amp; ABIs</span>
          </h3>
          <div class="space-y-4">
            <div class="bg-gray-800/60 rounded-lg p-4">
              <div class="flex items-center justify-between mb-2">
                <span class="text-white font-medium text-sm">USDC (Nativo Arc)</span>
                <span class="text-xs bg-green-900/50 text-green-400 px-2 py-0.5 rounded" data-i18n="native_token">Native</span>
              </div>
              <code class="text-xs text-purple-300 font-mono break-all">0x3600000000000000000000000000000000000000</code>
            </div>
            <div class="bg-gray-800/60 rounded-lg p-4">
              <div class="flex items-center justify-between mb-2">
                <span class="text-white font-medium text-sm">PaymentManager.sol</span>
                <span class="text-xs bg-purple-900/50 text-purple-400 px-2 py-0.5 rounded" data-i18n="to_deploy">Deploy</span>
              </div>
              <code class="text-xs text-gray-400">Functions: createPayment, executePayment, cancelPayment, agentDirectPayment</code>
            </div>
            <div class="bg-gray-800/60 rounded-lg p-4">
              <div class="flex items-center justify-between mb-2">
                <span class="text-white font-medium text-sm">ContractManager.sol</span>
                <span class="text-xs bg-blue-900/50 text-blue-400 px-2 py-0.5 rounded" data-i18n="to_deploy">Deploy</span>
              </div>
              <code class="text-xs text-gray-400">Functions: createContract, signContract, activateContract, completeMilestone, resolveDispute</code>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- SWAP TAB -->
    <div id="tab-content-swap" class="tab-content hidden">
      <div class="max-w-2xl mx-auto space-y-5">

        <!-- Header -->
        <div class="text-center mb-1">
          <h2 class="text-2xl font-bold text-white mb-1">
            <i class="fas fa-exchange-alt text-purple-400 mr-2"></i>Token Swap
          </h2>
          <p class="text-gray-400 text-sm">USDC ↔ EURC · Arc Testnet · Real EVM wallet</p>
        </div>

        <!-- Wallet Info Banner -->
        <div class="bg-gray-900/70 border border-gray-700/50 rounded-xl px-4 py-3 flex items-center justify-between gap-3">
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-8 h-8 rounded-full bg-purple-800/50 flex-shrink-0 flex items-center justify-center">
              <i class="fas fa-wallet text-purple-300 text-xs"></i>
            </div>
            <div class="min-w-0">
              <p class="text-xs text-gray-500 truncate" id="swap-wallet-info">Wallet not connected</p>
              <p class="text-xs font-medium" id="swap-network-info">—</p>
            </div>
          </div>
          <div class="flex items-center gap-2 flex-shrink-0">
            <button onclick="refreshSwapBalances()" title="Refresh balances"
              class="text-xs text-gray-500 hover:text-purple-400 transition-colors p-1.5 hover:bg-gray-800 rounded-lg">
              <i class="fas fa-sync-alt" id="swap-rate-spinner"></i>
            </button>
            <div class="h-4 w-px bg-gray-700"></div>
            <div class="text-right">
              <p class="text-xs text-gray-500">Rate</p>
              <p class="text-white font-mono text-xs" id="swap-rate-display">1 USDC = … EURC</p>
            </div>
          </div>
        </div>

        <!-- Swap Card -->
        <div class="bg-gray-900/80 border border-gray-700/60 rounded-2xl p-6 shadow-2xl">

          <!-- FROM -->
          <div class="mb-3">
            <div class="flex items-center justify-between mb-2">
              <label class="text-xs text-gray-400 uppercase tracking-wider font-semibold">From</label>
              <span class="text-xs text-emerald-400 font-medium" id="swap-balance-from">Balance: —</span>
            </div>
            <div class="flex gap-2">
              <select id="swap-from-token" onchange="onSwapInputChange(); refreshSwapBalances();"
                class="bg-gray-800 border border-gray-700 rounded-xl px-3 py-3 text-white text-sm font-semibold focus:border-purple-500 focus:outline-none cursor-pointer">
                <option value="USDC">💵 USDC</option>
                <option value="EURC">💶 EURC</option>
              </select>
              <div class="flex-1 relative">
                <input type="number" id="swap-amount-in" placeholder="0.00" min="0" step="0.000001"
                  oninput="onSwapInputChange()"
                  class="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 pr-16 text-white text-sm font-mono focus:border-purple-500 focus:outline-none">
                <button id="swap-max-btn" onclick="setSwapMax()" disabled
                  class="absolute right-2 top-1/2 -translate-y-1/2 text-xs px-2 py-1 bg-purple-800/60 hover:bg-purple-700/70 text-purple-300 rounded-lg border border-purple-700/40 transition-all disabled:opacity-40 disabled:cursor-not-allowed">
                  MAX
                </button>
              </div>
            </div>
          </div>

          <!-- SWAP ARROW -->
          <div class="flex items-center justify-center my-3">
            <button onclick="swapTokenSides()"
              class="w-10 h-10 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-full flex items-center justify-center text-purple-400 hover:text-purple-300 transition-all hover:rotate-180 duration-300 group">
              <i class="fas fa-arrow-down group-hover:hidden"></i>
              <i class="fas fa-exchange-alt hidden group-hover:block text-xs"></i>
            </button>
          </div>

          <!-- TO -->
          <div class="mb-4">
            <div class="flex items-center justify-between mb-2">
              <label class="text-xs text-gray-400 uppercase tracking-wider font-semibold">To (estimated)</label>
              <span class="text-xs text-gray-500 font-medium" id="swap-balance-to">Balance: —</span>
            </div>
            <div class="flex gap-2">
              <div class="bg-gray-800/50 border border-gray-700 rounded-xl px-3 py-3 text-white text-sm font-semibold min-w-[90px] flex items-center gap-2">
                <span id="swap-to-token-icon">💶</span>
                <span id="swap-to-token-name">EURC</span>
              </div>
              <div class="flex-1 bg-gray-800/40 border border-gray-700/40 rounded-xl px-4 py-3 font-mono text-sm flex items-center justify-between">
                <span id="swap-amount-out" class="text-green-400 font-semibold">—</span>
                <span class="text-xs text-yellow-500" id="swap-fee-display"></span>
              </div>
            </div>
          </div>

          <!-- QUOTE DETAILS -->
          <div id="swap-quote-details" class="hidden bg-gray-800/40 border border-gray-700/30 rounded-xl p-3.5 mb-4 space-y-1.5 text-xs">
            <div class="flex justify-between items-center">
              <span class="text-gray-400">Rate</span>
              <span class="text-white font-mono" id="sq-rate">—</span>
            </div>
            <div class="flex justify-between items-center">
              <span class="text-gray-400">Fee (0.3%)</span>
              <span class="text-yellow-400 font-mono" id="sq-fee">—</span>
            </div>
            <div class="flex justify-between items-center">
              <span class="text-gray-400">Price Impact</span>
              <span id="sq-impact" class="font-mono text-green-400">—</span>
            </div>
            <div class="flex justify-between items-center">
              <span class="text-gray-400">Min. Received</span>
              <span class="text-white font-mono" id="sq-min">—</span>
            </div>
            <div class="pt-1 border-t border-gray-700/30 flex justify-between items-center">
              <span class="text-gray-500">Gas</span>
              <span class="text-gray-400">Estimado pela rede Arc ✓</span>
            </div>
          </div>

          <!-- SLIPPAGE -->
          <div class="flex items-center gap-2 mb-4 flex-wrap">
            <span class="text-xs text-gray-500">Slippage:</span>
            <div class="flex gap-1.5">
              <button onclick="setSlippage(0.5)" class="slippage-btn active text-xs px-2.5 py-1 rounded-lg bg-purple-800 text-purple-200 border border-purple-600">0.5%</button>
              <button onclick="setSlippage(1)"   class="slippage-btn text-xs px-2.5 py-1 rounded-lg bg-gray-800 text-gray-400 border border-gray-700">1%</button>
              <button onclick="setSlippage(2)"   class="slippage-btn text-xs px-2.5 py-1 rounded-lg bg-gray-800 text-gray-400 border border-gray-700">2%</button>
            </div>
            <input type="number" id="swap-slippage-custom" placeholder="%" min="0.1" max="50" step="0.1"
              class="w-16 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-xs text-white focus:border-purple-500 focus:outline-none"
              oninput="setSlippage(parseFloat(this.value))">
          </div>

          <!-- TX HASH DISPLAY -->
          <div id="swap-tx-hash" class="hidden mb-3 px-3 py-2 bg-blue-900/20 border border-blue-700/30 rounded-xl flex items-center gap-2">
            <i class="fas fa-external-link-alt text-blue-400 text-xs"></i>
            <span class="text-xs text-gray-400">TX:</span>
            <!-- filled by JS -->
          </div>

          <!-- APPROVE HASH -->
          <div id="swap-approve-hash" class="hidden mb-3 text-xs text-gray-500 text-center"></div>

          <!-- TX STEPS PANEL -->
          <div id="swap-steps-panel" class="hidden mb-4 bg-gray-800/50 border border-gray-700/40 rounded-xl p-3 space-y-1.5">
            <p class="text-xs text-gray-400 font-semibold mb-2 flex items-center gap-1.5">
              <i class="fas fa-list-check text-purple-400"></i>Transaction Progress
            </p>
            <div class="swap-step flex items-center gap-2.5 text-xs text-gray-500 py-1" data-step="0">
              <div class="swap-step-icon w-5 h-5 rounded-full border border-gray-600 flex items-center justify-center flex-shrink-0">
                <i class="fas fa-circle text-[8px]"></i>
              </div>
              <span>Verify Arc Network (Chain 5042002)</span>
            </div>
            <div class="swap-step flex items-center gap-2.5 text-xs text-gray-500 py-1" data-step="1">
              <div class="swap-step-icon w-5 h-5 rounded-full border border-gray-600 flex items-center justify-center flex-shrink-0">
                <i class="fas fa-circle text-[8px]"></i>
              </div>
              <span>Check on-chain balance</span>
            </div>
            <div class="swap-step flex items-center gap-2.5 text-xs text-gray-500 py-1" data-step="2">
              <div class="swap-step-icon w-5 h-5 rounded-full border border-gray-600 flex items-center justify-center flex-shrink-0">
                <i class="fas fa-circle text-[8px]"></i>
              </div>
              <span>Guardian compliance</span>
            </div>
            <div class="swap-step flex items-center gap-2.5 text-xs text-gray-500 py-1" data-step="3">
              <div class="swap-step-icon w-5 h-5 rounded-full border border-gray-600 flex items-center justify-center flex-shrink-0">
                <i class="fas fa-circle text-[8px]"></i>
              </div>
              <span>Token approve (ERC-20)</span>
            </div>
            <div class="swap-step flex items-center gap-2.5 text-xs text-gray-500 py-1" data-step="4">
              <div class="swap-step-icon w-5 h-5 rounded-full border border-gray-600 flex items-center justify-center flex-shrink-0">
                <i class="fas fa-circle text-[8px]"></i>
              </div>
              <span>Sign &amp; send swap transaction</span>
            </div>
            <div class="swap-step flex items-center gap-2.5 text-xs text-gray-500 py-1" data-step="5">
              <div class="swap-step-icon w-5 h-5 rounded-full border border-gray-600 flex items-center justify-center flex-shrink-0">
                <i class="fas fa-circle text-[8px]"></i>
              </div>
              <span>On-chain confirmation</span>
            </div>
          </div>

          <!-- SUBMIT BUTTON -->
          <button onclick="executeSwap()" id="swap-submit-btn" disabled
            class="w-full bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 disabled:from-gray-700 disabled:to-gray-700 text-white disabled:text-gray-500 rounded-xl py-3.5 font-semibold text-sm flex items-center justify-center gap-2 transition-all disabled:cursor-not-allowed">
            <i class="fas fa-wallet mr-1"></i>Connect Wallet
          </button>
          <p class="text-center text-xs text-gray-600 mt-2" id="swap-btn-hint"></p>
          <p class="text-center text-xs text-gray-700 mt-1">
            <i class="fas fa-lock text-gray-700 mr-1"></i>All transactions require wallet signature · Arc Testnet
          </p>
        </div>

        <!-- Recent Swaps -->
        <div class="bg-gray-900/60 border border-gray-700/40 rounded-xl p-5">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-white font-semibold flex items-center gap-2 text-sm">
              <i class="fas fa-history text-blue-400"></i>Recent Swaps
            </h3>
            <button onclick="loadSwapHistory()" class="text-xs text-gray-500 hover:text-gray-300 flex items-center gap-1">
              <i class="fas fa-sync-alt"></i>Refresh
            </button>
          </div>
          <div id="swap-history-list">
            <div class="text-center py-6 text-gray-600 text-sm">
              <i class="fas fa-exchange-alt mr-2"></i>No swaps yet
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- VAULTS TAB -->
    <div id="tab-content-vaults" class="tab-content hidden">
      <div class="space-y-6">

        <!-- Header -->
        <div class="flex items-center justify-between">
          <div>
            <h2 class="text-2xl font-bold text-white flex items-center gap-2">
              <i class="fas fa-vault text-green-400"></i>Yield Vaults
            </h2>
            <p class="text-gray-400 text-sm mt-0.5">Deposite USDC/EURC — Agentes IA otimizam seu rendimento automaticamente</p>
          </div>
          <button onclick="runVaultAgent()" class="flex items-center gap-2 bg-purple-600/20 hover:bg-purple-600/30 border border-purple-600/40 text-purple-400 rounded-xl px-4 py-2 text-sm transition-all">
            <i class="fas fa-robot"></i><span class="hidden sm:inline">Run Agent</span>
          </button>
        </div>

        <!-- Vault Cards -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">

          <!-- USDC Vault -->
          <div class="bg-gradient-to-br from-blue-900/40 to-blue-800/20 border border-blue-700/40 rounded-2xl p-6">
            <!-- Header -->
            <div class="flex items-center justify-between mb-4">
              <div class="flex items-center gap-3">
                <div class="w-12 h-12 rounded-2xl bg-blue-800/60 flex items-center justify-center">
                  <span class="text-2xl">💵</span>
                </div>
                <div>
                  <h3 class="text-white font-bold text-lg">USDC Vault</h3>
                  <div class="flex items-center gap-1.5">
                    <div class="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse"></div>
                    <p class="text-blue-400 text-xs">Arc Testnet · IA Gerenciado</p>
                  </div>
                </div>
              </div>
              <div class="text-right">
                <div class="text-2xl font-bold text-green-400" id="usdc-vault-apy">5.2%</div>
                <div class="text-xs text-gray-400">APY</div>
              </div>
            </div>

            <!-- Stats globais do vault -->
            <div class="grid grid-cols-2 gap-2 mb-4">
              <div class="bg-black/20 rounded-xl p-3">
                <p class="text-xs text-gray-400 mb-1">TVL do Vault</p>
                <p class="text-white font-bold text-sm" id="usdc-vault-balance">—</p>
              </div>
              <div class="bg-black/20 rounded-xl p-3">
                <p class="text-xs text-gray-400 mb-1">Yield Acumulado</p>
                <p class="text-green-400 font-bold text-sm" id="usdc-vault-accrued">—</p>
              </div>
              <div class="bg-black/20 rounded-xl p-3">
                <p class="text-xs text-gray-400 mb-1">Total Depositado</p>
                <p class="text-blue-400 font-mono text-xs" id="usdc-vault-deposited">—</p>
              </div>
              <div class="bg-black/20 rounded-xl p-3">
                <p class="text-xs text-gray-400 mb-1">Participantes</p>
                <p class="text-purple-400 font-bold text-sm" id="usdc-vault-participants">—</p>
              </div>
            </div>

            <!-- Minha posição neste vault -->
            <div class="mb-4 bg-gray-800/40 border border-gray-700/30 rounded-xl p-3">
              <p class="text-xs text-gray-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <i class="fas fa-user text-blue-400"></i>Minha Posição
              </p>
              <div id="usdc-wallet-position">
                <div class="text-center py-2 text-gray-500 text-xs">Conecte sua wallet para ver sua posição</div>
              </div>
            </div>

            <!-- Contrato do vault -->
            <div class="bg-black/20 rounded-lg px-3 py-2 mb-4 flex items-center justify-between">
              <span class="text-xs text-gray-500">Vault Custodian</span>
              <a href="https://testnet.arcscan.app/address/0x867650F5eAe8df91445971f14d89fd84F0C9a9f8" target="_blank"
                 class="text-xs text-blue-400 font-mono hover:underline">0x8676...a9f8 ↗</a>
            </div>
            <!-- Tipo de depósito -->
            <div class="bg-blue-900/10 border border-blue-700/20 rounded-lg px-3 py-2 mb-4">
              <p class="text-xs text-blue-400">
                <i class="fas fa-info-circle mr-1"></i>
                <strong>USDC é nativo na Arc</strong> — transferido via <code class="bg-gray-800 px-1 rounded">value</code> (sem approve necessário)
              </p>
            </div>

            <!-- Formulário Deposit/Withdraw -->
            <div class="space-y-3">
              <div class="flex gap-2">
                <button onclick="setVaultAction('usdc','deposit')" id="usdc-dep-btn"
                  class="vault-action-btn flex-1 bg-blue-700 hover:bg-blue-600 text-white rounded-xl py-2.5 text-sm font-semibold transition-all ring-2 ring-white/20">
                  <i class="fas fa-arrow-down mr-1"></i>Depositar
                </button>
                <button onclick="setVaultAction('usdc','withdraw')" id="usdc-wit-btn"
                  class="vault-action-btn flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-xl py-2.5 text-sm font-semibold transition-all border border-gray-700">
                  <i class="fas fa-arrow-up mr-1"></i>Sacar
                </button>
              </div>

              <div id="usdc-vault-form" class="space-y-3">
                <!-- Hint de saldo disponível (saque) -->
                <div id="usdc-balance-hint" class="hidden text-xs text-blue-400 bg-blue-900/20 border border-blue-700/20 rounded-lg px-3 py-2">
                  <i class="fas fa-info-circle mr-1"></i>
                </div>

                <!-- Saldo on-chain da wallet (para depósito) -->
                <div id="usdc-onchain-balance" class="hidden text-xs text-gray-400 bg-gray-800/40 border border-gray-700/20 rounded-lg px-3 py-2 flex items-center justify-between">
                  <span><i class="fas fa-wallet mr-1 text-blue-400"></i>Saldo na wallet: <span id="usdc-onchain-val" class="text-white font-mono">—</span> USDC</span>
                  <button onclick="refreshOnChainBalance('usdc')" class="text-blue-400 hover:text-blue-300 ml-2"><i class="fas fa-sync-alt text-xs"></i></button>
                </div>

                <!-- Input de valor + MAX -->
                <div class="relative">
                  <input type="number" id="usdc-vault-amount" placeholder="0.00" min="0.01" step="0.01"
                    class="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white font-mono focus:border-blue-500 focus:outline-none pr-20">
                  <button onclick="setMaxVaultAmount('usdc', vaultActions['usdc'])"
                    class="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-blue-400 hover:text-blue-300 bg-blue-900/30 px-2 py-1 rounded-lg transition-colors">
                    MAX
                  </button>
                </div>

                <!-- Estratégia (somente depósito) -->
                <div id="usdc-strategy-row">
                  <label class="text-xs text-gray-400 block mb-1">Estratégia do Agente IA</label>
                  <select id="usdc-strategy"
                    class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none">
                    <option value="conservative">🛡️ Conservadora — APY estável, risco baixo</option>
                    <option value="balanced" selected>⚖️ Balanceada — APY otimizado, risco médio</option>
                    <option value="aggressive">🚀 Agressiva — APY máximo, risco alto</option>
                  </select>
                </div>

                <!-- Incluir yield (somente saque) -->
                <div id="usdc-yield-row" style="display:none" class="flex items-center gap-2">
                  <input type="checkbox" id="usdc-include-yield" class="rounded accent-blue-500">
                  <label for="usdc-include-yield" class="text-xs text-gray-400">Incluir yield acumulado no saque</label>
                </div>

                <!-- Fluxo EVM info -->
                <div class="bg-gray-800/40 rounded-lg p-2.5 text-xs text-gray-500">
                  <i class="fas fa-info-circle text-blue-400 mr-1"></i>
                  <span class="text-blue-300 font-medium">USDC nativo:</span>
                  <span class="text-gray-400"> 1 tx com value (sem approve) — Arc Testnet</span>
                </div>

                <!-- Botão Submit -->
                <button onclick="submitVaultAction('usdc')" id="usdc-vault-submit-btn"
                  class="w-full bg-blue-600 hover:bg-blue-500 text-white rounded-xl py-3 text-sm font-semibold transition-all flex items-center justify-center gap-2">
                  <i class="fas fa-arrow-down mr-2"></i>Depositar USDC no Vault
                </button>
              </div>
            </div>
          </div>

          <!-- EURC Vault -->
          <div class="bg-gradient-to-br from-yellow-900/40 to-orange-800/20 border border-yellow-700/40 rounded-2xl p-6">
            <!-- Header -->
            <div class="flex items-center justify-between mb-4">
              <div class="flex items-center gap-3">
                <div class="w-12 h-12 rounded-2xl bg-yellow-800/60 flex items-center justify-center">
                  <span class="text-2xl">💶</span>
                </div>
                <div>
                  <h3 class="text-white font-bold text-lg">EURC Vault</h3>
                  <div class="flex items-center gap-1.5">
                    <div class="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse"></div>
                    <p class="text-yellow-400 text-xs">Arc Testnet · IA Gerenciado</p>
                  </div>
                </div>
              </div>
              <div class="text-right">
                <div class="text-2xl font-bold text-green-400" id="eurc-vault-apy">4.8%</div>
                <div class="text-xs text-gray-400">APY</div>
              </div>
            </div>

            <!-- Stats globais do vault -->
            <div class="grid grid-cols-2 gap-2 mb-4">
              <div class="bg-black/20 rounded-xl p-3">
                <p class="text-xs text-gray-400 mb-1">TVL do Vault</p>
                <p class="text-white font-bold text-sm" id="eurc-vault-balance">—</p>
              </div>
              <div class="bg-black/20 rounded-xl p-3">
                <p class="text-xs text-gray-400 mb-1">Yield Acumulado</p>
                <p class="text-green-400 font-bold text-sm" id="eurc-vault-accrued">—</p>
              </div>
              <div class="bg-black/20 rounded-xl p-3">
                <p class="text-xs text-gray-400 mb-1">Total Depositado</p>
                <p class="text-yellow-400 font-mono text-xs" id="eurc-vault-deposited">—</p>
              </div>
              <div class="bg-black/20 rounded-xl p-3">
                <p class="text-xs text-gray-400 mb-1">Participantes</p>
                <p class="text-purple-400 font-bold text-sm" id="eurc-vault-participants">—</p>
              </div>
            </div>

            <!-- Minha posição neste vault -->
            <div class="mb-4 bg-gray-800/40 border border-gray-700/30 rounded-xl p-3">
              <p class="text-xs text-gray-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <i class="fas fa-user text-yellow-400"></i>Minha Posição
              </p>
              <div id="eurc-wallet-position">
                <div class="text-center py-2 text-gray-500 text-xs">Conecte sua wallet para ver sua posição</div>
              </div>
            </div>

            <!-- Contrato -->
            <div class="bg-black/20 rounded-lg px-3 py-2 mb-4 flex items-center justify-between">
              <span class="text-xs text-gray-500">Vault Custodian</span>
              <a href="https://testnet.arcscan.app/address/0x867650F5eAe8df91445971f14d89fd84F0C9a9f8" target="_blank"
                 class="text-xs text-yellow-400 font-mono hover:underline">0x8676...a9f8 ↗</a>
            </div>
            <!-- Tipo de depósito ERC-20 -->
            <div class="bg-yellow-900/10 border border-yellow-700/20 rounded-lg px-3 py-2 mb-4">
              <p class="text-xs text-yellow-400">
                <i class="fas fa-info-circle mr-1"></i>
                <strong>EURC ERC-20</strong> — fluxo: <code class="bg-gray-800 px-1 rounded">approve()</code> + <code class="bg-gray-800 px-1 rounded">transfer()</code>
              </p>
            </div>

            <!-- Formulário Deposit/Withdraw -->
            <div class="space-y-3">
              <div class="flex gap-2">
                <button onclick="setVaultAction('eurc','deposit')" id="eurc-dep-btn"
                  class="vault-action-btn flex-1 bg-yellow-700 hover:bg-yellow-600 text-white rounded-xl py-2.5 text-sm font-semibold transition-all ring-2 ring-white/20">
                  <i class="fas fa-arrow-down mr-1"></i>Depositar
                </button>
                <button onclick="setVaultAction('eurc','withdraw')" id="eurc-wit-btn"
                  class="vault-action-btn flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-xl py-2.5 text-sm font-semibold transition-all border border-gray-700">
                  <i class="fas fa-arrow-up mr-1"></i>Sacar
                </button>
              </div>

              <div id="eurc-vault-form" class="space-y-3">
                <div id="eurc-balance-hint" class="hidden text-xs text-yellow-400 bg-yellow-900/20 border border-yellow-700/20 rounded-lg px-3 py-2">
                  <i class="fas fa-info-circle mr-1"></i>
                </div>

                <!-- Saldo on-chain da wallet (para depósito) -->
                <div id="eurc-onchain-balance" class="hidden text-xs text-gray-400 bg-gray-800/40 border border-gray-700/20 rounded-lg px-3 py-2 flex items-center justify-between">
                  <span><i class="fas fa-wallet mr-1 text-yellow-400"></i>Saldo na wallet: <span id="eurc-onchain-val" class="text-white font-mono">—</span> EURC</span>
                  <button onclick="refreshOnChainBalance('eurc')" class="text-yellow-400 hover:text-yellow-300 ml-2"><i class="fas fa-sync-alt text-xs"></i></button>
                </div>

                <div class="relative">
                  <input type="number" id="eurc-vault-amount" placeholder="0.00" min="0.01" step="0.01"
                    class="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white font-mono focus:border-yellow-500 focus:outline-none pr-20">
                  <button onclick="setMaxVaultAmount('eurc', vaultActions['eurc'])"
                    class="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-yellow-400 hover:text-yellow-300 bg-yellow-900/30 px-2 py-1 rounded-lg transition-colors">
                    MAX
                  </button>
                </div>

                <div id="eurc-strategy-row">
                  <label class="text-xs text-gray-400 block mb-1">Estratégia do Agente IA</label>
                  <select id="eurc-strategy"
                    class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white focus:border-yellow-500 focus:outline-none">
                    <option value="conservative">🛡️ Conservadora — APY estável, risco baixo</option>
                    <option value="balanced" selected>⚖️ Balanceada — APY otimizado, risco médio</option>
                    <option value="aggressive">🚀 Agressiva — APY máximo, risco alto</option>
                  </select>
                </div>

                <div id="eurc-yield-row" style="display:none" class="flex items-center gap-2">
                  <input type="checkbox" id="eurc-include-yield" class="rounded accent-yellow-500">
                  <label for="eurc-include-yield" class="text-xs text-gray-400">Incluir yield acumulado no saque</label>
                </div>

                <div class="bg-gray-800/40 rounded-lg p-2.5 text-xs text-gray-500">
                  <i class="fas fa-info-circle text-yellow-400 mr-1"></i>
                  <span class="text-yellow-300 font-medium">EURC ERC-20:</span>
                  <span class="text-gray-400"> approve() + transfer() — 2 txs necessárias</span>
                </div>

                <button onclick="submitVaultAction('eurc')" id="eurc-vault-submit-btn"
                  class="w-full bg-yellow-600 hover:bg-yellow-500 text-white rounded-xl py-3 text-sm font-semibold transition-all flex items-center justify-center gap-2">
                  <i class="fas fa-arrow-down mr-2"></i>Depositar EURC no Vault
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Operações do Agente IA -->
        <div class="bg-gray-900/60 border border-purple-700/30 rounded-xl p-5">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-white font-semibold flex items-center gap-2">
              <i class="fas fa-robot text-purple-400"></i>Agente IA — Operações em Tempo Real
            </h3>
            <div class="flex gap-2">
              <button onclick="runVaultAgent('usdc')" class="text-xs px-3 py-1 rounded-lg bg-blue-900/30 text-blue-400 border border-blue-700/30 hover:bg-blue-900/50 transition-colors">
                <i class="fas fa-play mr-1"></i>Run USDC
              </button>
              <button onclick="runVaultAgent('eurc')" class="text-xs px-3 py-1 rounded-lg bg-yellow-900/30 text-yellow-400 border border-yellow-700/30 hover:bg-yellow-900/50 transition-colors">
                <i class="fas fa-play mr-1"></i>Run EURC
              </button>
            </div>
          </div>
          <div id="vault-agent-ops" class="space-y-1">
            <div class="text-center py-4 text-gray-600 text-xs">
              <i class="fas fa-robot mr-1"></i>Deposite tokens para ativar o agente IA
            </div>
          </div>
        </div>

        <!-- Histórico do vault -->
        <div class="bg-gray-900/60 border border-gray-700/40 rounded-xl p-5">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-white font-semibold flex items-center gap-2">
              <i class="fas fa-history text-green-400"></i>Histórico do Vault
            </h3>
            <div class="flex gap-2">
              <button onclick="loadVaultHistory('usdc', window.walletState?.address)"
                class="text-xs px-3 py-1 rounded-lg bg-blue-900/40 text-blue-400 border border-blue-700/40 hover:bg-blue-900/60 transition-colors">
                💵 USDC
              </button>
              <button onclick="loadVaultHistory('eurc', window.walletState?.address)"
                class="text-xs px-3 py-1 rounded-lg bg-yellow-900/40 text-yellow-400 border border-yellow-700/40 hover:bg-yellow-900/60 transition-colors">
                💶 EURC
              </button>
            </div>
          </div>
          <div id="vault-history-list">
            <div class="text-center py-6 text-gray-600 text-sm">
              <i class="fas fa-vault mr-2"></i>Nenhuma atividade ainda
            </div>
          </div>
        </div>

      </div>
    </div>

  </main>

  <!-- ===== CHATBOT WIDGET (compact 300×400) ===== -->
  <!-- Floating Action Button -->
  <button id="chat-fab"
    onclick="toggleChat()"
    class="fixed bottom-5 right-5 z-[90] w-12 h-12 bg-gradient-to-br from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 rounded-full shadow-lg shadow-purple-900/40 flex items-center justify-center transition-all hover:scale-110 active:scale-95">
    <i class="fas fa-robot text-white text-lg" id="chat-fab-icon"></i>
    <span id="chat-unread" class="hidden absolute -top-1 -right-1 w-5 h-5 bg-red-500 rounded-full text-white text-xs font-bold flex items-center justify-center leading-none"></span>
  </button>

  <!-- Compact Chat Panel: 300px wide × 400px tall -->
  <div id="chat-widget"
    class="hidden fixed z-[85] flex flex-col bg-gray-900 border border-purple-700/50 rounded-2xl shadow-2xl shadow-black/60"
    style="width:300px;height:400px;bottom:70px;right:20px;max-width:calc(100vw - 20px);">

    <!-- Header (compact) -->
    <div class="flex items-center justify-between px-3 py-2.5 border-b border-gray-700/60 bg-gradient-to-r from-purple-900/60 to-blue-900/40 rounded-t-2xl flex-shrink-0">
      <div class="flex items-center gap-2">
        <div class="w-6 h-6 rounded-lg bg-gradient-to-br from-purple-600 to-blue-600 flex items-center justify-center flex-shrink-0">
          <i class="fas fa-robot text-white text-xs"></i>
        </div>
        <div>
          <p class="text-white font-semibold text-xs leading-tight">ARC AI Assistant</p>
          <div class="flex items-center gap-1">
            <div class="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse"></div>
            <p class="text-xs text-green-400 leading-tight">Online · Arc Testnet</p>
          </div>
        </div>
      </div>
      <div class="flex items-center gap-1">
        <button onclick="clearChatHistory()" title="Clear" class="text-gray-500 hover:text-gray-300 p-1 rounded hover:bg-gray-800 transition-all">
          <i class="fas fa-trash text-xs"></i>
        </button>
        <button onclick="toggleChat()" class="text-gray-500 hover:text-gray-300 p-1 rounded hover:bg-gray-800 transition-all">
          <i class="fas fa-times text-xs"></i>
        </button>
      </div>
    </div>

    <!-- Messages (scrollable) -->
    <div id="chat-messages" class="flex-1 overflow-y-auto px-3 py-2 space-y-2 scroll-smooth">
      <!-- Messages inserted by JS -->
    </div>

    <!-- Quick actions (compact, single scroll row) -->
    <div id="chat-quick-actions" class="px-2 pb-1.5 flex gap-1.5 overflow-x-auto flex-shrink-0" style="scrollbar-width:none">
      <button onclick="sendQuickMessage('Vault APY')"       class="chat-quick-btn flex-shrink-0 text-xs px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-full border border-gray-700">🏦 APY</button>
      <button onclick="sendQuickMessage('Swap rates')"      class="chat-quick-btn flex-shrink-0 text-xs px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-full border border-gray-700">🔄 Rates</button>
      <button onclick="sendQuickMessage('Payment queue')"   class="chat-quick-btn flex-shrink-0 text-xs px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-full border border-gray-700">💳 Queue</button>
      <button onclick="sendQuickMessage('Agent status')"    class="chat-quick-btn flex-shrink-0 text-xs px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-full border border-gray-700">🧠 Agent</button>
      <button onclick="sendQuickMessage('Network status')"  class="chat-quick-btn flex-shrink-0 text-xs px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-full border border-gray-700">⛓️ Net</button>
    </div>

    <!-- Input (compact) -->
    <div class="px-2 pb-2.5 flex-shrink-0">
      <div class="flex items-center gap-1.5 bg-gray-800 border border-gray-700 rounded-xl px-2.5 py-1.5 focus-within:border-purple-500 transition-all">
        <input id="chat-input" type="text" placeholder="Ask anything…"
          class="flex-1 bg-transparent text-xs text-white placeholder-gray-500 focus:outline-none min-w-0"
          onkeydown="if(event.key==='Enter' && !event.shiftKey){event.preventDefault();sendChatMessage();}">
        <button onclick="sendChatMessage()" id="chat-send-btn"
          class="w-7 h-7 bg-purple-600 hover:bg-purple-500 rounded-lg flex items-center justify-center text-white transition-all flex-shrink-0">
          <i class="fas fa-paper-plane text-xs"></i>
        </button>
      </div>
      <p class="text-center text-gray-700 text-xs mt-1">Ctrl+/ to open</p>
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

            <div>
              <label class="text-xs text-gray-400 uppercase tracking-wider mb-2 block">API Key</label>
              <div class="relative">
                <input type="password" id="circle-api-key"
                  placeholder="TEST_API_KEY:xxxxxxxxxxxx or LIVE_API_KEY:xxxxxxxxxxxx"
                  autocomplete="off"
                  class="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:border-purple-500 focus:outline-none pr-12 font-mono">
                <button type="button" onclick="toggleFieldVisibility('circle-api-key', this)"
                  class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white transition-colors">
                  <i class="fas fa-eye text-xs"></i>
                </button>
              </div>
              <p class="text-xs text-gray-600 mt-1">Leave blank to keep current key</p>
            </div>

            <div>
              <label class="text-xs text-gray-400 uppercase tracking-wider mb-2 block">Webhook Secret <span class="text-gray-600">(optional)</span></label>
              <div class="relative">
                <input type="password" id="circle-webhook-secret"
                  placeholder="whsec_xxxxxxxxxxxx"
                  autocomplete="off"
                  class="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:border-purple-500 focus:outline-none pr-12 font-mono">
                <button type="button" onclick="toggleFieldVisibility('circle-webhook-secret', this)"
                  class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white transition-colors">
                  <i class="fas fa-eye text-xs"></i>
                </button>
              </div>
            </div>

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

            <div>
              <label class="text-xs text-gray-400 uppercase tracking-wider mb-2 block">Theme</label>
              <select id="cfg-theme"
                class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white focus:border-purple-500 focus:outline-none">
                <option value="dark">🌙 Dark</option>
                <option value="light">☀️ Light (coming soon)</option>
              </select>
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
        </div>

      </div>
    </div>
  </div>

  <!-- ═══════════════════════════════════════════════════════════
       PROFILE MODAL
       ═══════════════════════════════════════════════════════════ -->
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

  <script src="/static/wallet.js"></script>
  <script src="/static/evm-tx.js"></script>
  <script src="/static/csv-upload.js"></script>
  <script src="/static/app.js"></script>
  <script src="/static/payments.js"></script>
  <script src="/static/settings.js"></script>
  <script src="/static/swap.js"></script>
  <script src="/static/vaults.js"></script>
  <script src="/static/guardian.js"></script>
  <script src="/static/yield-optimizer.js"></script>
  <script src="/static/chat.js"></script>
</body>
</html>`)
})

export default app
