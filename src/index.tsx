import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'
import paymentsRouter from './routes/payments'
import contractsRouter from './routes/contracts'
import { ARC_TESTNET } from './types/arc'

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
      usdcAddress: ARC_TESTNET.usdcAddress,
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
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ARC AI Agents - Pagamentos & Contratos</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🤖</text></svg>">
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
  <!-- csv-upload.js handles all CSV parsing natively -->
  <link href="/static/styles.css" rel="stylesheet">
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
          <h1 class="font-bold text-lg text-white">ARC AI Agents</h1>
          <p class="text-xs text-purple-400">Pagamentos & Contratos Autônomos</p>
        </div>
      </div>
      <div class="flex items-center gap-2 sm:gap-3">
        <!-- Arc Network badge -->
        <div class="hidden sm:flex items-center gap-2 bg-green-900/40 border border-green-700/50 rounded-full px-3 py-1.5">
          <div class="w-2 h-2 rounded-full bg-green-400 animate-pulse"></div>
          <span class="text-xs text-green-400 font-medium">Arc Testnet</span>
        </div>
        <!-- Links rápidos -->
        <a href="https://testnet.arcscan.app" target="_blank" class="hidden md:block text-xs text-gray-400 hover:text-purple-400 transition-colors">
          <i class="fas fa-external-link-alt mr-1"></i>Explorer
        </a>
        <a href="https://faucet.circle.com" target="_blank" class="hidden md:block text-xs text-gray-400 hover:text-blue-400 transition-colors">
          <i class="fas fa-faucet mr-1"></i>Faucet
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

        <!-- Botão conectar wallet -->
        <button id="wallet-connect-btn" onclick="openWalletModal()"
          class="wallet-connect-pulse flex items-center gap-2 bg-purple-600 hover:bg-purple-700 text-white rounded-xl px-4 py-2 text-sm font-semibold transition-all shadow-lg shadow-purple-900/30">
          <i class="fas fa-wallet"></i>
          <span class="hidden sm:inline">Conectar</span>
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
          <i class="fas fa-chart-line mr-2"></i>Dashboard
        </button>
        <button onclick="switchTab('payments')" id="tab-payments" class="tab-btn px-6 py-4 text-sm font-medium border-b-2 border-transparent text-gray-400 hover:text-gray-200 transition-all">
          <i class="fas fa-dollar-sign mr-2"></i>Pagamentos
        </button>
        <button onclick="switchTab('contracts')" id="tab-contracts" class="tab-btn px-6 py-4 text-sm font-medium border-b-2 border-transparent text-gray-400 hover:text-gray-200 transition-all">
          <i class="fas fa-file-contract mr-2"></i>Contratos
        </button>
        <button onclick="switchTab('agents')" id="tab-agents" class="tab-btn px-6 py-4 text-sm font-medium border-b-2 border-transparent text-gray-400 hover:text-gray-200 transition-all">
          <i class="fas fa-brain mr-2"></i>Agentes IA
        </button>
        <button onclick="switchTab('deploy')" id="tab-deploy" class="tab-btn px-6 py-4 text-sm font-medium border-b-2 border-transparent text-gray-400 hover:text-gray-200 transition-all">
          <i class="fas fa-rocket mr-2"></i>Deploy
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
            <span class="text-purple-300 text-sm">Pagamentos Processados</span>
            <i class="fas fa-exchange-alt text-purple-400 text-xl"></i>
          </div>
          <div id="stat-payments" class="text-3xl font-bold text-white">--</div>
          <div class="text-xs text-purple-400 mt-1">transações na Arc Testnet</div>
        </div>
        <div class="stat-card bg-gradient-to-br from-blue-900/60 to-blue-800/30 border border-blue-700/40 rounded-xl p-5">
          <div class="flex items-center justify-between mb-3">
            <span class="text-blue-300 text-sm">Volume USDC</span>
            <i class="fas fa-coins text-blue-400 text-xl"></i>
          </div>
          <div id="stat-volume" class="text-3xl font-bold text-white">--</div>
          <div class="text-xs text-blue-400 mt-1">USDC processados</div>
        </div>
        <div class="stat-card bg-gradient-to-br from-green-900/60 to-green-800/30 border border-green-700/40 rounded-xl p-5">
          <div class="flex items-center justify-between mb-3">
            <span class="text-green-300 text-sm">Contratos Ativos</span>
            <i class="fas fa-file-contract text-green-400 text-xl"></i>
          </div>
          <div id="stat-contracts" class="text-3xl font-bold text-white">--</div>
          <div class="text-xs text-green-400 mt-1">em execução</div>
        </div>
        <div class="stat-card bg-gradient-to-br from-orange-900/60 to-orange-800/30 border border-orange-700/40 rounded-xl p-5">
          <div class="flex items-center justify-between mb-3">
            <span class="text-orange-300 text-sm">Tarefas Pendentes</span>
            <i class="fas fa-clock text-orange-400 text-xl"></i>
          </div>
          <div id="stat-pending" class="text-3xl font-bold text-white">--</div>
          <div class="text-xs text-orange-400 mt-1">aguardando agentes</div>
        </div>
      </div>

      <!-- Network Info -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        <!-- Wallet Panel -->
        <div class="bg-gray-900/60 border border-purple-700/40 rounded-xl p-5">
          <h3 class="text-white font-semibold mb-4 flex items-center gap-2">
            <i class="fas fa-wallet text-purple-400"></i>
            Minha Wallet
          </h3>
          <div id="wallet-panel">
            <!-- Preenchido pelo wallet.js -->
            <div class="flex flex-col items-center justify-center py-4 gap-3">
              <div class="w-12 h-12 rounded-full bg-gray-800 border-2 border-dashed border-gray-600 flex items-center justify-center">
                <i class="fas fa-wallet text-gray-500 text-lg"></i>
              </div>
              <p class="text-gray-400 text-xs text-center">Conecte sua wallet EVM para interagir com a Arc Testnet</p>
              <button onclick="openWalletModal()" class="wallet-connect-pulse bg-purple-600 hover:bg-purple-700 text-white rounded-xl px-4 py-2 text-sm font-semibold transition-all flex items-center gap-2">
                <i class="fas fa-plug"></i>Conectar Wallet
              </button>
            </div>
          </div>
        </div>

        <div class="bg-gray-900/60 border border-gray-700/40 rounded-xl p-6">
          <h3 class="text-white font-semibold mb-4 flex items-center gap-2">
            <i class="fas fa-network-wired text-purple-400"></i>
            Arc Testnet - Configuração
          </h3>
          <div class="space-y-3">
            <div class="flex justify-between items-center py-2 border-b border-gray-700/30">
              <span class="text-gray-400 text-sm">RPC URL</span>
              <a href="https://rpc.testnet.arc.network" target="_blank" class="text-purple-400 text-sm hover:underline font-mono text-xs">rpc.testnet.arc.network</a>
            </div>
            <div class="flex justify-between items-center py-2 border-b border-gray-700/30">
              <span class="text-gray-400 text-sm">Chain ID</span>
              <span class="text-white text-sm font-mono bg-gray-800 px-2 py-0.5 rounded">5042002</span>
            </div>
            <div class="flex justify-between items-center py-2 border-b border-gray-700/30">
              <span class="text-gray-400 text-sm">Token de Gas</span>
              <span class="text-green-400 text-sm font-semibold">USDC</span>
            </div>
            <div class="flex justify-between items-center py-2 border-b border-gray-700/30">
              <span class="text-gray-400 text-sm">USDC Address</span>
              <span class="text-blue-400 text-xs font-mono">0x3600...0000</span>
            </div>
            <div class="flex justify-between items-center py-2 border-b border-gray-700/30">
              <span class="text-gray-400 text-sm">Gas por Tx</span>
              <span class="text-yellow-400 text-sm">~$0.009 USDC</span>
            </div>
            <div class="flex justify-between items-center py-2">
              <span class="text-gray-400 text-sm">Finalidade</span>
              <span class="text-green-400 text-sm">Sub-segundo</span>
            </div>
          </div>
        </div>

        <div class="bg-gray-900/60 border border-gray-700/40 rounded-xl p-6">
          <h3 class="text-white font-semibold mb-4 flex items-center gap-2">
            <i class="fas fa-robot text-blue-400"></i>
            Status dos Agentes de IA
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
            Atividade Recente
          </h3>
          <button onclick="loadDashboard()" class="text-xs text-purple-400 hover:text-purple-300">
            <i class="fas fa-sync mr-1"></i>Atualizar
          </button>
        </div>
        <div id="recent-activity" class="space-y-2">
          <div class="text-gray-500 text-sm text-center py-4">Carregando atividades...</div>
        </div>
      </div>
    </div>

    <!-- PAYMENTS TAB -->
    <div id="tab-content-payments" class="tab-content hidden">
      <div class="grid grid-cols-1 xl:grid-cols-5 gap-6">

        <!-- ═══════════════════════════════════════════════════
             COLUNA ESQUERDA: Envio Manual + Multi-send
             ═══════════════════════════════════════════════════ -->
        <div class="xl:col-span-3 space-y-5">

          <!-- ── PAINEL MULTI-SEND (estilo da imagem) ── -->
          <div class="bg-gray-900/70 border border-gray-700/50 rounded-2xl overflow-hidden">

            <!-- Cabeçalho do painel -->
            <div class="flex items-center justify-between px-5 py-4 border-b border-gray-700/40">
              <div class="flex items-center gap-4">
                <div>
                  <p class="text-xs text-gray-500 uppercase tracking-wider mb-0.5">Token</p>
                  <p class="text-cyan-400 font-bold text-lg leading-none">USDC</p>
                </div>
                <div class="w-px h-8 bg-gray-700/60"></div>
                <div>
                  <p class="text-xs text-gray-500 uppercase tracking-wider mb-0.5">Total a enviar</p>
                  <p id="multisend-total" class="text-cyan-400 font-bold text-lg leading-none">0.0000 <span class="text-sm text-gray-400 font-normal">USDC</span></p>
                </div>
              </div>
              <!-- Botão CSV fixo no cabeçalho -->
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
                <button onclick="downloadCSVTemplate()"
                  title="Baixar template CSV"
                  class="w-9 h-9 flex items-center justify-center bg-gray-800 hover:bg-gray-700 border border-gray-600 hover:border-gray-500 text-gray-400 hover:text-cyan-400 rounded-xl transition-all">
                  <i class="fas fa-download text-xs"></i>
                </button>
              </div>
            </div>

            <!-- Banner de erro CSV (oculto por padrão) -->
            <div id="csv-error-banner" class="hidden px-5 py-2 bg-red-900/20 border-b border-red-700/30 flex items-center gap-2">
              <i class="fas fa-exclamation-circle text-red-400 text-xs"></i>
              <span id="csv-error-text" class="text-xs text-red-300"></span>
            </div>

            <!-- Cabeçalhos das colunas -->
            <div class="grid grid-cols-12 gap-3 px-5 py-2 bg-gray-800/30 border-b border-gray-700/30">
              <div class="col-span-5 text-xs text-gray-500 uppercase tracking-wider">Endereço</div>
              <div class="col-span-3 text-xs text-gray-500 uppercase tracking-wider">Valor (USDC)</div>
              <div class="col-span-3 text-xs text-gray-500 uppercase tracking-wider">Nota</div>
              <div class="col-span-1"></div>
            </div>

            <!-- Linhas de destinatários -->
            <div id="multisend-rows" class="divide-y divide-gray-800/60">
              <!-- Linhas geradas pelo JS -->
            </div>

            <!-- Botão Adicionar destinatário -->
            <div class="px-5 py-3 border-t border-gray-700/30">
              <button onclick="addMultisendRow()"
                class="w-full flex items-center justify-center gap-2 text-cyan-400 hover:text-cyan-300 text-sm font-medium py-1 transition-colors">
                <i class="fas fa-plus text-xs"></i> Adicionar Destinatário
              </button>
            </div>

            <!-- Remetente -->
            <div class="px-5 py-3 border-t border-gray-700/30 bg-gray-800/20">
              <label class="text-xs text-gray-500 mb-1.5 block uppercase tracking-wider">De (Remetente)</label>
              <input type="text" id="pay-from" placeholder="0x... (auto-preenchido pela wallet)"
                class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-cyan-500 focus:outline-none font-mono">
            </div>

            <!-- Prioridade + botões de ação -->
            <div class="px-5 py-4 border-t border-gray-700/30 bg-gray-800/10">
              <div class="flex items-center gap-3 flex-wrap">
                <div class="flex items-center gap-2">
                  <label class="text-xs text-gray-500">Prioridade:</label>
                  <select id="pay-priority"
                    class="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:border-cyan-500 focus:outline-none">
                    <option value="low">Baixa</option>
                    <option value="medium" selected>Média</option>
                    <option value="high">Alta</option>
                    <option value="critical">Crítica</option>
                  </select>
                </div>
                <div class="flex-1 flex gap-2 justify-end">
                  <button onclick="analyzeMultisend()"
                    class="flex items-center gap-2 bg-gray-700 hover:bg-gray-600 text-white rounded-xl px-4 py-2 text-sm font-medium transition-colors">
                    <i class="fas fa-brain text-purple-400"></i>Analisar IA
                  </button>
                  <button onclick="submitMultisend()"
                    class="flex items-center gap-2 bg-cyan-700 hover:bg-cyan-600 text-white rounded-xl px-5 py-2 text-sm font-bold transition-colors shadow-lg shadow-cyan-900/30">
                    <i class="fas fa-paper-plane"></i>Enviar Tudo
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- Info de formato CSV (compacto, sempre visível) -->
          <div class="bg-gray-900/40 border border-gray-700/30 rounded-xl px-4 py-3 flex items-start gap-3">
            <i class="fas fa-info-circle text-cyan-600 mt-0.5 flex-shrink-0"></i>
            <div class="text-xs text-gray-500">
              <strong class="text-gray-400">Formato CSV:</strong>
              colunas <code class="text-cyan-500 bg-gray-800 px-1 rounded">address</code>,
              <code class="text-cyan-500 bg-gray-800 px-1 rounded">amount</code>,
              <code class="text-gray-400 bg-gray-800 px-1 rounded">note</code> (opcional),
              <code class="text-gray-400 bg-gray-800 px-1 rounded">priority</code> (opcional) —
              separador vírgula ou ponto-e-vírgula · máx 500 linhas
            </div>
          </div>

          <!-- Preview CSV após upload -->
          <div id="csv-preview-container" class="hidden"></div>

          <!-- Resultado da análise IA -->
          <div id="payment-analysis-result" class="hidden"></div>

          <!-- Botões secundários -->
          <div class="flex gap-2">
            <button onclick="createDemoPayments()"
              class="flex-1 bg-blue-900/30 border border-blue-700/40 hover:bg-blue-800/40 text-blue-400 rounded-xl py-2 text-sm transition-colors">
              <i class="fas fa-flask mr-2"></i>Demo Payments
            </button>
            <button onclick="processPayments()"
              class="flex-1 bg-green-800/40 border border-green-700/40 hover:bg-green-700/50 text-green-400 rounded-xl py-2 text-sm font-medium transition-colors">
              <i class="fas fa-play mr-2"></i>Processar Fila
            </button>
          </div>
        </div>

        <!-- ═══════════════════════════════════════════════════
             COLUNA DIREITA: Fila de Pagamentos
             ═══════════════════════════════════════════════════ -->
        <div class="xl:col-span-2 space-y-4">
          <div class="flex items-center justify-between">
            <h3 class="text-white font-semibold flex items-center gap-2">
              <i class="fas fa-list text-purple-400"></i>Fila de Pagamentos
            </h3>
            <button onclick="loadPayments()" class="text-xs text-gray-500 hover:text-gray-300 transition-colors">
              <i class="fas fa-sync mr-1"></i>Atualizar
            </button>
          </div>
          <div id="payments-list" class="space-y-3">
            <div class="text-gray-500 text-sm text-center py-8 bg-gray-900/40 rounded-xl border border-gray-700/30">
              <i class="fas fa-inbox text-4xl mb-3 block text-gray-700"></i>
              Nenhum pagamento na fila
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
              Novo Contrato
            </h3>
            <form id="contract-form" class="space-y-3">
              <div>
                <label class="text-xs text-gray-400 mb-1 block">Título</label>
                <input type="text" id="ct-title" placeholder="Nome do contrato" class="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-green-500 focus:outline-none">
              </div>
              <div>
                <label class="text-xs text-gray-400 mb-1 block">Cliente (0x...)</label>
                <input type="text" id="ct-client" placeholder="0x..." class="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-green-500 focus:outline-none font-mono">
              </div>
              <div>
                <label class="text-xs text-gray-400 mb-1 block">Contratante (0x...)</label>
                <input type="text" id="ct-contractor" placeholder="0x..." class="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-green-500 focus:outline-none font-mono">
              </div>
              <div>
                <label class="text-xs text-gray-400 mb-1 block">Valor Total (USDC)</label>
                <input type="number" id="ct-value" placeholder="0.00" step="0.01" class="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-green-500 focus:outline-none">
              </div>
              <div>
                <label class="text-xs text-gray-400 mb-1 block">Descrição do Escopo</label>
                <textarea id="ct-description" placeholder="Descreva o trabalho a ser realizado..." rows="3" class="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-green-500 focus:outline-none resize-none"></textarea>
              </div>
              <button type="submit" class="w-full bg-green-600 hover:bg-green-700 text-white rounded-lg py-2.5 text-sm font-medium transition-colors">
                <i class="fas fa-file-plus mr-2"></i>Criar Contrato
              </button>
            </form>
          </div>
        </div>

        <!-- Lista de contratos -->
        <div class="lg:col-span-2">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-white font-semibold">Contratos Registrados</h3>
            <button onclick="loadContracts()" class="text-xs text-green-400 hover:text-green-300">
              <i class="fas fa-sync mr-1"></i>Atualizar
            </button>
          </div>
          <div id="contracts-list" class="space-y-4">
            <div class="text-gray-500 text-sm text-center py-8">Carregando contratos...</div>
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
            Wallet EVM Conectada
          </h3>
          <button id="wallet-connect-agents-btn" onclick="openWalletModal()"
            class="wallet-connect-pulse flex items-center gap-2 bg-purple-600 hover:bg-purple-700 text-white rounded-xl px-4 py-2 text-sm font-semibold transition-all">
            <i class="fas fa-plug"></i>Conectar Wallet
          </button>
        </div>
        <!-- Status compacto da wallet -->
        <div id="wallet-agents-status" class="text-gray-500 text-sm">
          Nenhuma wallet conectada. Conecte para ver saldo e endereço.
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
              <p class="text-purple-400 text-xs">Agente de Pagamentos USDC</p>
            </div>
            <div id="pay-agent-status-dot" class="ml-auto w-3 h-3 rounded-full bg-green-400 animate-pulse"></div>
          </div>

          <div id="pay-agent-details" class="space-y-3 mb-5">
            <div class="text-gray-500 text-sm">Carregando...</div>
          </div>

          <div class="space-y-2">
            <h4 class="text-xs text-gray-400 uppercase tracking-wider mb-3">Capacidades</h4>
            <div class="grid grid-cols-2 gap-2">
              <div class="bg-purple-900/30 border border-purple-700/30 rounded-lg p-3 text-center">
                <i class="fas fa-search text-purple-400 text-lg mb-1 block"></i>
                <span class="text-xs text-gray-300">Análise de Risco</span>
              </div>
              <div class="bg-purple-900/30 border border-purple-700/30 rounded-lg p-3 text-center">
                <i class="fas fa-check-circle text-green-400 text-lg mb-1 block"></i>
                <span class="text-xs text-gray-300">Auto-Aprovação</span>
              </div>
              <div class="bg-purple-900/30 border border-purple-700/30 rounded-lg p-3 text-center">
                <i class="fas fa-shield-alt text-blue-400 text-lg mb-1 block"></i>
                <span class="text-xs text-gray-300">Detecção de Fraude</span>
              </div>
              <div class="bg-purple-900/30 border border-purple-700/30 rounded-lg p-3 text-center">
                <i class="fas fa-layer-group text-yellow-400 text-lg mb-1 block"></i>
                <span class="text-xs text-gray-300">Pagamentos em Lote</span>
              </div>
            </div>
          </div>

          <div class="mt-4 p-3 bg-gray-800/50 rounded-lg">
            <h4 class="text-xs text-gray-400 mb-2">Limites de Risco</h4>
            <div class="space-y-1.5 text-xs">
              <div class="flex justify-between"><span class="text-green-400">● Auto-aprovado</span><span class="text-gray-300">≤ $10 USDC</span></div>
              <div class="flex justify-between"><span class="text-yellow-400">● Análise aumentada</span><span class="text-gray-300">$10 - $100 USDC</span></div>
              <div class="flex justify-between"><span class="text-orange-400">● Escalado</span><span class="text-gray-300">$100 - $1,000 USDC</span></div>
              <div class="flex justify-between"><span class="text-red-400">● Bloqueado</span><span class="text-gray-300">> $10,000 USDC</span></div>
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
              <p class="text-blue-400 text-xs">Agente de Contratos Digitais</p>
            </div>
            <div id="contract-agent-status-dot" class="ml-auto w-3 h-3 rounded-full bg-green-400 animate-pulse"></div>
          </div>

          <div id="contract-agent-details" class="space-y-3 mb-5">
            <div class="text-gray-500 text-sm">Carregando...</div>
          </div>

          <div class="space-y-2">
            <h4 class="text-xs text-gray-400 uppercase tracking-wider mb-3">Capacidades</h4>
            <div class="grid grid-cols-2 gap-2">
              <div class="bg-blue-900/30 border border-blue-700/30 rounded-lg p-3 text-center">
                <i class="fas fa-file-alt text-blue-400 text-lg mb-1 block"></i>
                <span class="text-xs text-gray-300">Revisão de Contratos</span>
              </div>
              <div class="bg-blue-900/30 border border-blue-700/30 rounded-lg p-3 text-center">
                <i class="fas fa-lock text-green-400 text-lg mb-1 block"></i>
                <span class="text-xs text-gray-300">Gestão de Escrow</span>
              </div>
              <div class="bg-blue-900/30 border border-blue-700/30 rounded-lg p-3 text-center">
                <i class="fas fa-tasks text-yellow-400 text-lg mb-1 block"></i>
                <span class="text-xs text-gray-300">Verificação Milestones</span>
              </div>
              <div class="bg-blue-900/30 border border-blue-700/30 rounded-lg p-3 text-center">
                <i class="fas fa-balance-scale text-red-400 text-lg mb-1 block"></i>
                <span class="text-xs text-gray-300">Arbitragem</span>
              </div>
            </div>
          </div>

          <div class="mt-4 p-3 bg-gray-800/50 rounded-lg">
            <h4 class="text-xs text-gray-400 mb-2">Fluxo de Contratos</h4>
            <div class="flex items-center gap-1 text-xs overflow-x-auto pb-1">
              <span class="bg-gray-700 text-gray-300 px-2 py-1 rounded whitespace-nowrap">📝 Draft</span>
              <i class="fas fa-arrow-right text-gray-600 flex-shrink-0"></i>
              <span class="bg-blue-900/50 text-blue-300 px-2 py-1 rounded whitespace-nowrap">✍️ Assinado</span>
              <i class="fas fa-arrow-right text-gray-600 flex-shrink-0"></i>
              <span class="bg-green-900/50 text-green-300 px-2 py-1 rounded whitespace-nowrap">🔒 Escrow</span>
              <i class="fas fa-arrow-right text-gray-600 flex-shrink-0"></i>
              <span class="bg-purple-900/50 text-purple-300 px-2 py-1 rounded whitespace-nowrap">✅ Ativo</span>
              <i class="fas fa-arrow-right text-gray-600 flex-shrink-0"></i>
              <span class="bg-yellow-900/50 text-yellow-300 px-2 py-1 rounded whitespace-nowrap">🏆 Concluído</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Logs do Sistema -->
      <div class="mt-6 bg-gray-900/60 border border-gray-700/40 rounded-xl p-6">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-white font-semibold flex items-center gap-2">
            <i class="fas fa-terminal text-green-400"></i>
            Log dos Agentes
          </h3>
          <button onclick="clearLogs()" class="text-xs text-gray-500 hover:text-red-400">
            <i class="fas fa-trash mr-1"></i>Limpar
          </button>
        </div>
        <div id="agent-logs" class="font-mono text-xs space-y-1 max-h-64 overflow-y-auto bg-black/40 rounded-lg p-4">
          <div class="text-green-400">[SYSTEM] ARC AI Agents inicializados...</div>
          <div class="text-blue-400">[NETWORK] Conectado à Arc Testnet (Chain ID: 5042002)</div>
          <div class="text-purple-400">[AGENT:PAY] ArcPay Agent v1.0 pronto</div>
          <div class="text-cyan-400">[AGENT:CTR] ArcContract Agent v1.0 pronto</div>
          <div class="text-gray-500">[INFO] Aguardando tarefas...</div>
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
            Deploy de Contratos na Arc Testnet
          </h3>
          <p class="text-gray-400 text-sm mb-6">Siga os passos abaixo para fazer o deploy dos contratos PaymentManager e ContractManager na rede Arc Testnet usando Foundry.</p>

          <div class="space-y-5">
            <div class="step-card border border-gray-700/40 rounded-xl p-5">
              <div class="flex items-center gap-3 mb-3">
                <div class="w-8 h-8 rounded-full bg-purple-600 flex items-center justify-center text-white text-sm font-bold flex-shrink-0">1</div>
                <h4 class="text-white font-semibold">Instalar Foundry</h4>
              </div>
              <pre class="bg-black/60 rounded-lg p-3 text-sm text-green-400 overflow-x-auto"><code>curl -L https://foundry.paradigm.xyz | bash
foundryup</code></pre>
            </div>

            <div class="step-card border border-gray-700/40 rounded-xl p-5">
              <div class="flex items-center gap-3 mb-3">
                <div class="w-8 h-8 rounded-full bg-purple-600 flex items-center justify-center text-white text-sm font-bold flex-shrink-0">2</div>
                <h4 class="text-white font-semibold">Gerar Carteira e Configurar</h4>
              </div>
              <pre class="bg-black/60 rounded-lg p-3 text-sm text-green-400 overflow-x-auto"><code>cast wallet new
# Salvar o endereço e chave privada

# Criar .env na pasta contracts/
cat > contracts/.env << EOF
ARC_TESTNET_RPC_URL="https://rpc.testnet.arc.network"
PRIVATE_KEY="0xSUA_CHAVE_PRIVADA"
EOF</code></pre>
            </div>

            <div class="step-card border border-gray-700/40 rounded-xl p-5">
              <div class="flex items-center gap-3 mb-3">
                <div class="w-8 h-8 rounded-full bg-purple-600 flex items-center justify-center text-white text-sm font-bold flex-shrink-0">3</div>
                <h4 class="text-white font-semibold">Obter USDC Testnet</h4>
              </div>
              <p class="text-gray-400 text-sm mb-3">O USDC é o token de gas nativo da Arc. Obtenha gratuitamente pelo faucet:</p>
              <a href="https://faucet.circle.com" target="_blank" class="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg px-4 py-2 text-sm transition-colors">
                <i class="fas fa-faucet"></i>
                faucet.circle.com → Arc Testnet
              </a>
            </div>

            <div class="step-card border border-gray-700/40 rounded-xl p-5">
              <div class="flex items-center gap-3 mb-3">
                <div class="w-8 h-8 rounded-full bg-purple-600 flex items-center justify-center text-white text-sm font-bold flex-shrink-0">4</div>
                <h4 class="text-white font-semibold">Inicializar Projeto Foundry e Compilar</h4>
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
                <h4 class="text-white font-semibold">Deploy na Arc Testnet</h4>
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
                <h4 class="text-white font-semibold">Verificar Deploy no Explorer</h4>
              </div>
              <p class="text-gray-400 text-sm mb-3">Confirme o deploy no explorador da Arc Testnet:</p>
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
            Endereços & ABIs dos Contratos
          </h3>
          <div class="space-y-4">
            <div class="bg-gray-800/60 rounded-lg p-4">
              <div class="flex items-center justify-between mb-2">
                <span class="text-white font-medium text-sm">USDC (Nativo Arc)</span>
                <span class="text-xs bg-green-900/50 text-green-400 px-2 py-0.5 rounded">Nativo</span>
              </div>
              <code class="text-xs text-purple-300 font-mono break-all">0x3600000000000000000000000000000000000000</code>
            </div>
            <div class="bg-gray-800/60 rounded-lg p-4">
              <div class="flex items-center justify-between mb-2">
                <span class="text-white font-medium text-sm">PaymentManager.sol</span>
                <span class="text-xs bg-purple-900/50 text-purple-400 px-2 py-0.5 rounded">Fazer Deploy</span>
              </div>
              <code class="text-xs text-gray-400">Funções: createPayment, executePayment, cancelPayment, agentDirectPayment</code>
            </div>
            <div class="bg-gray-800/60 rounded-lg p-4">
              <div class="flex items-center justify-between mb-2">
                <span class="text-white font-medium text-sm">ContractManager.sol</span>
                <span class="text-xs bg-blue-900/50 text-blue-400 px-2 py-0.5 rounded">Fazer Deploy</span>
              </div>
              <code class="text-xs text-gray-400">Funções: createContract, signContract, activateContract, completeMilestone, resolveDispute</code>
            </div>
          </div>
        </div>
      </div>
    </div>

  </main>

  <!-- Notification Toast -->
  <div id="toast" class="fixed bottom-6 right-6 z-50 hidden">
    <div class="bg-gray-800 border border-gray-600 rounded-xl p-4 shadow-2xl max-w-sm">
      <div id="toast-content" class="text-sm text-white"></div>
    </div>
  </div>

  <script src="/static/wallet.js"></script>
  <script src="/static/csv-upload.js"></script>
  <script src="/static/app.js"></script>
</body>
</html>`)
})

export default app
