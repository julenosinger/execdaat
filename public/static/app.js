// ARC AI Agents - Frontend Application
// Pagamentos e Contratos Autônomos na Arc Testnet

const API = {
  base: '',
  
  async get(path) {
    const res = await axios.get(this.base + path);
    return res.data;
  },
  
  async post(path, data) {
    const res = await axios.post(this.base + path, data);
    return res.data;
  }
};

// ============================================================
// STATE
// ============================================================
let currentTab = 'dashboard';
let logCount = 0;

// ============================================================
// TABS
// ============================================================
function switchTab(tab) {
  // Hide all contents
  document.querySelectorAll('.tab-content').forEach(el => {
    el.classList.add('hidden');
  });
  
  // Deactivate all tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.remove('active');
    btn.classList.remove('border-purple-500', 'text-purple-400', 'border-green-500', 'text-green-400');
    btn.classList.add('border-transparent', 'text-gray-400');
  });
  
  // Show selected content
  const content = document.getElementById(`tab-content-${tab}`);
  const tabBtn = document.getElementById(`tab-${tab}`);
  
  if (content) content.classList.remove('hidden');
  if (tabBtn) {
    tabBtn.classList.add('active');
    tabBtn.classList.remove('border-transparent', 'text-gray-400');
    tabBtn.classList.add('border-purple-500', 'text-purple-400');
  }
  
  currentTab = tab;
  
  // Load data for the tab
  if (tab === 'dashboard') loadDashboard();
  if (tab === 'payments') loadPayments();
  if (tab === 'contracts') loadContracts();
  if (tab === 'agents') loadAgentsDetails();
}

// ============================================================
// TOAST NOTIFICATIONS
// ============================================================
function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  const content = document.getElementById('toast-content');
  
  const colors = {
    success: 'text-green-400',
    error: 'text-red-400',
    warning: 'text-yellow-400',
    info: 'text-blue-400',
  };
  
  content.innerHTML = `<span class="${colors[type] || colors.info}">${message}</span>`;
  toast.classList.remove('hidden');
  
  setTimeout(() => {
    toast.classList.add('hidden');
  }, 4000);
}

// ============================================================
// LOGGING
// ============================================================
function addLog(message, type = 'info') {
  const logs = document.getElementById('agent-logs');
  if (!logs) return;
  
  const colors = {
    success: 'text-green-400',
    error: 'text-red-400',
    warning: 'text-yellow-400',
    info: 'text-blue-400',
    system: 'text-purple-400',
    agent: 'text-cyan-400',
  };
  
  const time = new Date().toLocaleTimeString('pt-BR');
  const div = document.createElement('div');
  div.className = colors[type] || colors.info;
  div.textContent = `[${time}] ${message}`;
  logs.appendChild(div);
  logs.scrollTop = logs.scrollHeight;
  logCount++;
}

function clearLogs() {
  const logs = document.getElementById('agent-logs');
  if (logs) logs.innerHTML = '';
  logCount = 0;
}

// ============================================================
// DASHBOARD
// ============================================================
async function loadDashboard() {
  try {
    // Load payment stats
    const payData = await API.get('/api/payments/agent');
    const ctData = await API.get('/api/contracts/agent');
    
    // Update stats
    document.getElementById('stat-payments').textContent = payData.stats.totalProcessed;
    document.getElementById('stat-volume').textContent = `$${(payData.stats.totalValueProcessed / 1e6).toFixed(2)}`;
    document.getElementById('stat-contracts').textContent = ctData.stats.activeContracts;
    document.getElementById('stat-pending').textContent = payData.stats.pending + ctData.stats.pendingTasks;
    
    // Agent status cards
    const agentCards = document.getElementById('agent-status-cards');
    agentCards.innerHTML = `
      <div class="flex items-center gap-3 bg-gray-800/50 rounded-lg p-3">
        <div class="w-8 h-8 rounded-lg bg-purple-600/30 flex items-center justify-center">
          <i class="fas fa-money-bill-wave text-purple-400 text-sm"></i>
        </div>
        <div class="flex-1">
          <div class="text-sm text-white font-medium">${payData.agent.name}</div>
          <div class="text-xs text-gray-400">${payData.agent.lastAction}</div>
        </div>
        <span class="text-xs px-2 py-1 rounded-full ${getAgentStatusClass(payData.agent.status)}">
          ${payData.agent.status}
        </span>
      </div>
      <div class="flex items-center gap-3 bg-gray-800/50 rounded-lg p-3">
        <div class="w-8 h-8 rounded-lg bg-blue-600/30 flex items-center justify-center">
          <i class="fas fa-file-contract text-blue-400 text-sm"></i>
        </div>
        <div class="flex-1">
          <div class="text-sm text-white font-medium">${ctData.agent.name}</div>
          <div class="text-xs text-gray-400">${ctData.agent.lastAction}</div>
        </div>
        <span class="text-xs px-2 py-1 rounded-full ${getAgentStatusClass(ctData.agent.status)}">
          ${ctData.agent.status}
        </span>
      </div>
    `;
    
    // Recent activity - load processed payments and contracts
    const queueData = await API.get('/api/payments/queue');
    const contractsList = await API.get('/api/contracts');
    
    const activity = document.getElementById('recent-activity');
    const recentPayments = queueData.processed.slice(-3);
    const recentContracts = contractsList.contracts.slice(0, 2);
    
    let activityHtml = '';
    
    recentPayments.forEach(p => {
      activityHtml += `
        <div class="flex items-center gap-3 py-2 border-b border-gray-700/20 last:border-0">
          <div class="w-8 h-8 rounded-lg bg-purple-900/40 flex items-center justify-center flex-shrink-0">
            <i class="fas fa-exchange-alt text-purple-400 text-xs"></i>
          </div>
          <div class="flex-1 min-w-0">
            <div class="text-sm text-white truncate">${p.description}</div>
            <div class="text-xs text-gray-500">$${(p.amount / 1e6).toFixed(2)} USDC • ${p.from.substring(0, 10)}... → ${p.to.substring(0, 10)}...</div>
          </div>
          <span class="text-xs px-2 py-0.5 rounded-full flex-shrink-0 ${getPaymentStatusClass(p.status)}">${p.status}</span>
        </div>
      `;
    });
    
    recentContracts.forEach(ct => {
      activityHtml += `
        <div class="flex items-center gap-3 py-2 border-b border-gray-700/20 last:border-0">
          <div class="w-8 h-8 rounded-lg bg-blue-900/40 flex items-center justify-center flex-shrink-0">
            <i class="fas fa-file-contract text-blue-400 text-xs"></i>
          </div>
          <div class="flex-1 min-w-0">
            <div class="text-sm text-white truncate">${ct.title}</div>
            <div class="text-xs text-gray-500">${ct.totalValueFormatted} • ${ct.milestonesProgress} marcos</div>
          </div>
          <span class="text-xs px-2 py-0.5 rounded-full flex-shrink-0 status-${ct.status.toLowerCase()}">${ct.status}</span>
        </div>
      `;
    });
    
    activity.innerHTML = activityHtml || '<div class="text-gray-500 text-sm text-center py-4">Nenhuma atividade recente</div>';
    
  } catch (err) {
    console.error('Dashboard load error:', err);
    showToast('Erro ao carregar dashboard', 'error');
  }
}

// ============================================================
// PAYMENTS
// ============================================================
async function loadPayments() {
  try {
    const data = await API.get('/api/payments/queue');
    renderPaymentsList(data);
  } catch (err) {
    showToast('Erro ao carregar pagamentos', 'error');
  }
}

function renderPaymentsList(data) {
  const list = document.getElementById('payments-list');
  const allTasks = [...data.pending, ...data.processed];
  
  if (allTasks.length === 0) {
    list.innerHTML = `
      <div class="text-gray-500 text-sm text-center py-8 bg-gray-900/40 rounded-xl border border-gray-700/30">
        <i class="fas fa-inbox text-4xl mb-3 block text-gray-700"></i>
        Nenhum pagamento na fila
      </div>
    `;
    return;
  }
  
  list.innerHTML = allTasks.reverse().map(task => `
    <div class="bg-gray-900/60 border border-gray-700/40 rounded-xl p-4 contract-card">
      <div class="flex items-start justify-between mb-2">
        <div class="flex items-center gap-2">
          <i class="fas fa-exchange-alt text-purple-400"></i>
          <span class="text-white font-medium text-sm">${task.description}</span>
        </div>
        <span class="text-xs px-2 py-0.5 rounded-full ${getPaymentStatusClass(task.status)}">${task.status}</span>
      </div>
      <div class="grid grid-cols-2 gap-3 mb-3">
        <div>
          <div class="text-xs text-gray-500">De</div>
          <div class="text-xs text-gray-300 font-mono truncate">${task.from}</div>
        </div>
        <div>
          <div class="text-xs text-gray-500">Para</div>
          <div class="text-xs text-gray-300 font-mono truncate">${task.to}</div>
        </div>
      </div>
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <span class="text-lg font-bold text-white">$${(task.amount / 1e6).toFixed(2)}</span>
          <span class="text-xs text-gray-500">USDC</span>
          <span class="text-xs px-1.5 py-0.5 rounded bg-gray-700/50 text-gray-400 capitalize">${task.priority}</span>
        </div>
        ${task.riskScore !== undefined ? `<div class="text-xs text-gray-400">Risco: <span class="${getRiskClass(task.riskScore)}">${task.riskScore}/100</span></div>` : ''}
      </div>
      ${task.agentDecision ? `
        <div class="mt-3 p-2 bg-gray-800/50 rounded-lg">
          <div class="text-xs text-gray-500 mb-1">Decisão do Agente:</div>
          <div class="text-xs text-gray-300">${task.agentDecision}</div>
        </div>
      ` : ''}
      ${task.txHash ? `
        <div class="mt-2 text-xs">
          <span class="text-gray-500">TX: </span>
          <a href="https://testnet.arcscan.app/tx/${task.txHash}" target="_blank" class="text-purple-400 hover:underline font-mono">${task.txHash.substring(0, 20)}...</a>
        </div>
      ` : ''}
    </div>
  `).join('');
}

async function analyzePayment() {
  const from = document.getElementById('pay-from').value;
  const to = document.getElementById('pay-to').value;
  const amount = document.getElementById('pay-amount').value;
  const description = document.getElementById('pay-description').value;
  const priority = document.getElementById('pay-priority').value;
  
  if (!from || !to || !amount) {
    showToast('Preencha os campos: de, para e valor', 'warning');
    return;
  }
  
  try {
    const result = await API.post('/api/payments/analyze', { from, to, amount, description, priority });
    const resultDiv = document.getElementById('payment-analysis-result');
    
    const riskColors = { low: 'green', medium: 'yellow', high: 'orange', critical: 'red' };
    const color = riskColors[result.decision.riskLevel] || 'gray';
    
    resultDiv.className = `bg-${color}-900/20 border border-${color}-700/40 rounded-xl p-4`;
    resultDiv.innerHTML = `
      <div class="flex items-center justify-between mb-3">
        <h4 class="text-white font-semibold">Análise do Agente IA</h4>
        <span class="text-xs px-2 py-1 rounded-full bg-${color}-900/50 text-${color}-400 border border-${color}-700/40">
          ${result.decision.riskLevel.toUpperCase()}
        </span>
      </div>
      <div class="flex items-center gap-2 mb-2">
        <i class="fas fa-${result.decision.action === 'approve' ? 'check-circle text-green-400' : result.decision.action === 'reject' ? 'times-circle text-red-400' : 'exclamation-circle text-yellow-400'}"></i>
        <span class="text-sm font-medium text-white capitalize">${result.decision.action}</span>
        <span class="text-xs text-gray-400">• Confiança: ${result.decision.confidence}%</span>
      </div>
      <p class="text-sm text-gray-300 mb-3">${result.decision.reason}</p>
      ${result.decision.recommendations.length > 0 ? `
        <div>
          <div class="text-xs text-gray-500 mb-1">Recomendações:</div>
          ${result.decision.recommendations.map(r => `<div class="text-xs text-gray-400">• ${r}</div>`).join('')}
        </div>
      ` : ''}
    `;
    resultDiv.classList.remove('hidden');
    
    addLog(`[AGENT:PAY] Análise: ${result.decision.action.toUpperCase()} - ${result.decision.riskLevel} risk (${result.decision.confidence}% conf)`, 'agent');
  } catch (err) {
    showToast('Erro na análise: ' + err.message, 'error');
  }
}

async function createDemoPayments() {
  try {
    const result = await API.post('/api/payments/demo', {});
    showToast(result.message, 'success');
    addLog('[AGENT:PAY] 3 pagamentos demo criados na fila', 'system');
    await loadPayments();
  } catch (err) {
    showToast('Erro ao criar demos: ' + err.message, 'error');
  }
}

async function processPayments() {
  try {
    showToast('Processando fila de pagamentos...', 'info');
    addLog('[AGENT:PAY] Iniciando processamento da fila...', 'agent');
    
    const result = await API.post('/api/payments/process', {});
    showToast(`✅ ${result.result.processed} pagamentos processados`, 'success');
    addLog(`[AGENT:PAY] Processadas ${result.result.processed} tarefas. Erros: ${result.result.errors.length}`, 'success');
    
    await loadPayments();
    if (currentTab === 'dashboard') await loadDashboard();
  } catch (err) {
    showToast('Erro ao processar: ' + err.message, 'error');
  }
}

document.getElementById('payment-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const from = document.getElementById('pay-from').value;
  const to = document.getElementById('pay-to').value;
  const amount = document.getElementById('pay-amount').value;
  const description = document.getElementById('pay-description').value;
  const priority = document.getElementById('pay-priority').value;
  
  if (!from || !to || !amount || !description) {
    showToast('Preencha todos os campos', 'warning');
    return;
  }
  
  try {
    const result = await API.post('/api/payments/submit', { from, to, amount, description, priority });
    showToast(`✅ Pagamento submetido! ID: ${result.taskId.substring(0, 20)}...`, 'success');
    addLog(`[AGENT:PAY] Novo pagamento $${parseFloat(amount).toFixed(2)} USDC → análise pendente`, 'agent');
    e.target.reset();
    await loadPayments();
  } catch (err) {
    showToast('Erro: ' + err.message, 'error');
  }
});

// ============================================================
// CONTRACTS
// ============================================================
async function loadContracts() {
  try {
    const data = await API.get('/api/contracts');
    renderContractsList(data.contracts);
  } catch (err) {
    showToast('Erro ao carregar contratos', 'error');
  }
}

function renderContractsList(contracts) {
  const list = document.getElementById('contracts-list');
  
  if (!contracts || contracts.length === 0) {
    list.innerHTML = '<div class="text-gray-500 text-sm text-center py-8">Nenhum contrato encontrado</div>';
    return;
  }
  
  list.innerHTML = contracts.map(ct => {
    const completedMilestones = ct.milestones.filter(m => m.status === 'Completed').length;
    const progressPct = ct.milestones.length > 0 ? (completedMilestones / ct.milestones.length * 100) : 0;
    
    return `
      <div class="bg-gray-900/60 border border-gray-700/40 rounded-xl p-5 contract-card">
        <div class="flex items-start justify-between mb-3">
          <div>
            <div class="flex items-center gap-2 mb-1">
              <h4 class="text-white font-semibold">${ct.title}</h4>
              <span class="text-xs px-2 py-0.5 rounded-full status-${ct.status.toLowerCase()}">${ct.status}</span>
            </div>
            <div class="text-xs text-gray-400">#${ct.id} • Criado em ${new Date(ct.createdAt).toLocaleDateString('pt-BR')}</div>
          </div>
          <div class="text-right">
            <div class="text-lg font-bold text-white">${ct.totalValueFormatted}</div>
            <div class="text-xs text-gray-400">${ct.milestonesProgress} marcos</div>
          </div>
        </div>
        
        <p class="text-sm text-gray-400 mb-3 line-clamp-2">${ct.description}</p>
        
        <!-- Addresses -->
        <div class="grid grid-cols-2 gap-2 mb-3">
          <div class="bg-gray-800/50 rounded-lg p-2">
            <div class="text-xs text-gray-500 mb-0.5">Cliente</div>
            <div class="text-xs text-gray-300 font-mono truncate">${ct.client}</div>
            ${ct.clientSigned ? '<div class="text-xs text-green-400 mt-0.5"><i class="fas fa-check-circle mr-1"></i>Assinado</div>' : '<div class="text-xs text-gray-500 mt-0.5">Não assinado</div>'}
          </div>
          <div class="bg-gray-800/50 rounded-lg p-2">
            <div class="text-xs text-gray-500 mb-0.5">Contratante</div>
            <div class="text-xs text-gray-300 font-mono truncate">${ct.contractor}</div>
            ${ct.contractorSigned ? '<div class="text-xs text-green-400 mt-0.5"><i class="fas fa-check-circle mr-1"></i>Assinado</div>' : '<div class="text-xs text-gray-500 mt-0.5">Não assinado</div>'}
          </div>
        </div>
        
        <!-- Progress -->
        ${ct.milestones.length > 0 ? `
          <div class="mb-3">
            <div class="flex justify-between text-xs text-gray-400 mb-1">
              <span>Progresso</span>
              <span>${progressPct.toFixed(0)}%</span>
            </div>
            <div class="milestone-bar">
              <div class="milestone-fill" style="width: ${progressPct}%"></div>
            </div>
          </div>
          <!-- Milestones -->
          <div class="space-y-1.5 mb-3">
            ${ct.milestones.map(m => `
              <div class="flex items-center gap-2 text-xs">
                <i class="fas fa-${getMilestoneIcon(m.status)} ${getMilestoneColor(m.status)} flex-shrink-0"></i>
                <span class="text-gray-300 flex-1 truncate">${m.description}</span>
                <span class="text-gray-400 flex-shrink-0">$${(m.amount / 1e6).toFixed(0)}</span>
              </div>
            `).join('')}
          </div>
        ` : ''}
        
        <!-- Actions -->
        <div class="flex gap-2 flex-wrap">
          <button onclick="analyzeContract(${ct.id})" class="text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 rounded-lg px-3 py-1.5 transition-colors">
            <i class="fas fa-brain mr-1"></i>Analisar IA
          </button>
          ${ct.status === 'Draft' && ct.clientSigned && ct.contractorSigned ? `
            <button onclick="activateContract(${ct.id})" class="text-xs bg-green-700 hover:bg-green-600 text-white rounded-lg px-3 py-1.5 transition-colors">
              <i class="fas fa-bolt mr-1"></i>Ativar + Escrow
            </button>
          ` : ''}
          ${ct.status === 'Active' ? `
            <button onclick="completeMilestone(${ct.id})" class="text-xs bg-blue-700 hover:bg-blue-600 text-white rounded-lg px-3 py-1.5 transition-colors">
              <i class="fas fa-check mr-1"></i>Completar Marco
            </button>
            <button onclick="disputeContract(${ct.id})" class="text-xs bg-red-900/50 hover:bg-red-800/50 text-red-400 rounded-lg px-3 py-1.5 transition-colors">
              <i class="fas fa-exclamation-triangle mr-1"></i>Disputar
            </button>
          ` : ''}
          <a href="https://testnet.arcscan.app" target="_blank" class="text-xs bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-lg px-3 py-1.5 transition-colors">
            <i class="fas fa-external-link-alt mr-1"></i>Explorer
          </a>
        </div>
        
        ${ct.agentAnalysis ? `
          <div class="mt-3 p-2 bg-purple-900/20 border border-purple-700/30 rounded-lg">
            <div class="text-xs text-purple-400 mb-1"><i class="fas fa-robot mr-1"></i>Análise do Agente:</div>
            <div class="text-xs text-gray-300">${ct.agentAnalysis}</div>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

async function analyzeContract(contractId) {
  try {
    addLog(`[AGENT:CTR] Analisando contrato #${contractId}...`, 'agent');
    const result = await API.post(`/api/contracts/${contractId}/analyze`, {});
    
    const colors = { low: 'green', medium: 'yellow', high: 'orange', critical: 'red' };
    const color = colors[result.decision.riskLevel] || 'gray';
    
    showToast(`Análise #${contractId}: ${result.decision.action.toUpperCase()} (${result.decision.confidence}% conf)`, 
              result.decision.action === 'approve' ? 'success' : 'warning');
    addLog(`[AGENT:CTR] Contrato #${contractId}: ${result.decision.action} - ${result.decision.reason.substring(0, 80)}...`, 'success');
  } catch (err) {
    showToast('Erro na análise: ' + err.message, 'error');
  }
}

async function activateContract(contractId) {
  if (!confirm(`Ativar contrato #${contractId}? O valor em escrow será debitado do cliente.`)) return;
  
  try {
    addLog(`[AGENT:CTR] Ativando contrato #${contractId}...`, 'agent');
    const result = await API.post(`/api/contracts/${contractId}/activate`, {});
    showToast(result.message, 'success');
    addLog(`[AGENT:CTR] Contrato #${contractId} ativado! Escrow depositado.`, 'success');
    await loadContracts();
  } catch (err) {
    showToast('Erro: ' + err.message, 'error');
  }
}

async function completeMilestone(contractId) {
  const milestoneId = prompt('ID do Marco a completar (1, 2, 3...):', '1');
  if (!milestoneId) return;
  
  const evidence = prompt('Evidência de conclusão (URL, descrição, hash):', 'Entregue em: https://github.com/...');
  if (!evidence) return;
  
  try {
    addLog(`[AGENT:CTR] Verificando milestone #${milestoneId} do contrato #${contractId}...`, 'agent');
    const result = await API.post(`/api/contracts/${contractId}/milestone/${milestoneId}/complete`, { evidence });
    showToast(result.message, result.milestone?.status === 'Completed' ? 'success' : 'warning');
    addLog(`[AGENT:CTR] Milestone #${milestoneId}: ${result.milestone?.status}`, 
           result.milestone?.status === 'Completed' ? 'success' : 'warning');
    await loadContracts();
  } catch (err) {
    showToast('Erro: ' + err.message, 'error');
  }
}

async function disputeContract(contractId) {
  const reason = prompt('Motivo da disputa:');
  if (!reason) return;
  
  try {
    addLog(`[AGENT:CTR] Registrando disputa no contrato #${contractId}...`, 'warning');
    const result = await API.post(`/api/contracts/${contractId}/dispute`, { reason });
    showToast(result.message, 'warning');
    addLog(`[AGENT:CTR] Disputa #${contractId} enviada para arbitragem`, 'warning');
    await loadContracts();
  } catch (err) {
    showToast('Erro: ' + err.message, 'error');
  }
}

document.getElementById('contract-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const client = document.getElementById('ct-client').value;
  const contractor = document.getElementById('ct-contractor').value;
  const title = document.getElementById('ct-title').value;
  const description = document.getElementById('ct-description').value;
  const totalValue = document.getElementById('ct-value').value;
  
  if (!client || !contractor || !title || !description || !totalValue) {
    showToast('Preencha todos os campos', 'warning');
    return;
  }
  
  try {
    const result = await API.post('/api/contracts/create', {
      client, contractor, title, description, totalValue
    });
    showToast(`✅ Contrato #${result.contractId} criado!`, 'success');
    addLog(`[AGENT:CTR] Novo contrato #${result.contractId}: "${title}" - $${parseFloat(totalValue).toFixed(2)} USDC`, 'system');
    e.target.reset();
    await loadContracts();
  } catch (err) {
    showToast('Erro: ' + err.message, 'error');
  }
});

// ============================================================
// AGENTS
// ============================================================
async function loadAgentsDetails() {
  try {
    const payData = await API.get('/api/payments/agent');
    const ctData = await API.get('/api/contracts/agent');
    
    // Payment agent
    const payDetails = document.getElementById('pay-agent-details');
    payDetails.innerHTML = `
      <div class="flex justify-between text-sm py-1 border-b border-gray-700/30">
        <span class="text-gray-400">Status</span>
        <span class="${getAgentStatusTextClass(payData.agent.status)} font-medium capitalize">${payData.agent.status}</span>
      </div>
      <div class="flex justify-between text-sm py-1 border-b border-gray-700/30">
        <span class="text-gray-400">Aprovados</span>
        <span class="text-green-400">${payData.stats.approved}</span>
      </div>
      <div class="flex justify-between text-sm py-1 border-b border-gray-700/30">
        <span class="text-gray-400">Rejeitados</span>
        <span class="text-red-400">${payData.stats.rejected}</span>
      </div>
      <div class="flex justify-between text-sm py-1 border-b border-gray-700/30">
        <span class="text-gray-400">Pendentes</span>
        <span class="text-yellow-400">${payData.stats.pending}</span>
      </div>
      <div class="flex justify-between text-sm py-1">
        <span class="text-gray-400">Volume Total</span>
        <span class="text-white font-medium">$${(payData.stats.totalValueProcessed / 1e6).toFixed(2)} USDC</span>
      </div>
    `;
    
    // Contract agent
    const ctDetails = document.getElementById('contract-agent-details');
    ctDetails.innerHTML = `
      <div class="flex justify-between text-sm py-1 border-b border-gray-700/30">
        <span class="text-gray-400">Status</span>
        <span class="${getAgentStatusTextClass(ctData.agent.status)} font-medium capitalize">${ctData.agent.status}</span>
      </div>
      <div class="flex justify-between text-sm py-1 border-b border-gray-700/30">
        <span class="text-gray-400">Contratos Ativos</span>
        <span class="text-green-400">${ctData.stats.activeContracts}</span>
      </div>
      <div class="flex justify-between text-sm py-1 border-b border-gray-700/30">
        <span class="text-gray-400">Concluídos</span>
        <span class="text-blue-400">${ctData.stats.completedContracts}</span>
      </div>
      <div class="flex justify-between text-sm py-1 border-b border-gray-700/30">
        <span class="text-gray-400">Em Disputa</span>
        <span class="text-red-400">${ctData.stats.disputedContracts}</span>
      </div>
      <div class="flex justify-between text-sm py-1">
        <span class="text-gray-400">Total Registrados</span>
        <span class="text-white font-medium">${ctData.stats.totalContracts}</span>
      </div>
    `;
    
  } catch (err) {
    console.error('Agents load error:', err);
  }
}

// ============================================================
// HELPERS
// ============================================================
function getAgentStatusClass(status) {
  const map = {
    idle: 'bg-green-900/40 text-green-400 border border-green-700/40',
    thinking: 'bg-purple-900/40 text-purple-400 border border-purple-700/40',
    executing: 'bg-blue-900/40 text-blue-400 border border-blue-700/40',
    waiting: 'bg-yellow-900/40 text-yellow-400 border border-yellow-700/40',
    error: 'bg-red-900/40 text-red-400 border border-red-700/40',
  };
  return map[status] || map.idle;
}

function getAgentStatusTextClass(status) {
  const map = {
    idle: 'text-green-400',
    thinking: 'text-purple-400',
    executing: 'text-blue-400',
    error: 'text-red-400',
  };
  return map[status] || 'text-gray-400';
}

function getPaymentStatusClass(status) {
  const map = {
    pending: 'pay-pending',
    analyzing: 'pay-analyzing',
    executed: 'pay-executed',
    rejected: 'pay-rejected',
    failed: 'bg-red-900/30 text-red-400 border border-red-700/40',
    approved: 'pay-executed',
  };
  return map[status] || 'bg-gray-700/40 text-gray-400';
}

function getRiskClass(score) {
  if (score < 30) return 'text-green-400';
  if (score < 60) return 'text-yellow-400';
  if (score < 80) return 'text-orange-400';
  return 'text-red-400';
}

function getMilestoneIcon(status) {
  const icons = {
    Completed: 'check-circle',
    InProgress: 'spinner fa-spin',
    Pending: 'circle',
    Failed: 'times-circle',
  };
  return icons[status] || 'circle';
}

function getMilestoneColor(status) {
  const colors = {
    Completed: 'text-green-400',
    InProgress: 'text-blue-400',
    Pending: 'text-gray-500',
    Failed: 'text-red-400',
  };
  return colors[status] || 'text-gray-500';
}

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  loadDashboard();
  
  // Auto-refresh a cada 30 segundos
  setInterval(() => {
    if (currentTab === 'dashboard') loadDashboard();
    if (currentTab === 'agents') loadAgentsDetails();
  }, 30000);
  
  addLog('[SYSTEM] Interface ARC AI Agents carregada', 'system');
  addLog('[NETWORK] Arc Testnet - Chain ID: 5042002 - USDC Gas', 'info');

  // ============================================================
  // INTEGRAÇÃO COM WALLET
  // ============================================================

  // Ouvir evento de wallet conectada
  window.addEventListener('walletConnected', (e) => {
    const { address, shortAddress, onArcNetwork, usdcBalance } = e.detail;

    // Atualizar avatar no header
    const avatar = document.getElementById('wallet-avatar');
    if (avatar) avatar.textContent = address.slice(2, 4).toUpperCase();

    // Mostrar wallet info, esconder botão conectar
    const connectBtn = document.getElementById('wallet-connect-btn');
    const walletInfo = document.getElementById('wallet-info');
    if (connectBtn) connectBtn.classList.add('hidden');
    if (walletInfo) walletInfo.classList.remove('hidden');

    // Atualizar botão de conectar na aba agentes
    const agentConnectBtn = document.getElementById('wallet-connect-agents-btn');
    if (agentConnectBtn) agentConnectBtn.classList.add('hidden');

    // Atualizar status na aba agentes
    updateWalletAgentsStatus(e.detail);

    // Atualizar dashboard
    if (currentTab === 'dashboard') loadDashboard();

    addLog(`[WALLET] ✅ ${shortAddress} conectada${onArcNetwork ? ' na Arc Testnet' : ' (rede incorreta)'}`, 'success');
  });

  // Ouvir evento de wallet desconectada
  window.addEventListener('walletDisconnected', () => {
    const connectBtn = document.getElementById('wallet-connect-btn');
    const walletInfo = document.getElementById('wallet-info');
    if (connectBtn) connectBtn.classList.remove('hidden');
    if (walletInfo) walletInfo.classList.add('hidden');

    // Mostrar botão de conectar na aba agentes
    const agentConnectBtn = document.getElementById('wallet-connect-agents-btn');
    if (agentConnectBtn) agentConnectBtn.classList.remove('hidden');

    // Resetar status na aba agentes
    const agentsStatus = document.getElementById('wallet-agents-status');
    if (agentsStatus) {
      agentsStatus.textContent = 'Nenhuma wallet conectada. Conecte para ver saldo e endereço.';
      agentsStatus.className = 'text-gray-500 text-sm';
    }

    // Limpar campos autopreenchidos
    const payFrom = document.getElementById('pay-from');
    if (payFrom && payFrom.dataset.autoFilled === 'true') {
      payFrom.value = '';
      payFrom.dataset.autoFilled = 'false';
      payFrom.classList.remove('border-purple-500/60');
    }
    const ctClient = document.getElementById('ct-client');
    if (ctClient && ctClient.dataset.autoFilled === 'true') {
      ctClient.value = '';
      ctClient.dataset.autoFilled = 'false';
      ctClient.classList.remove('border-green-500/60');
    }

    addLog('[WALLET] Wallet desconectada', 'warning');
  });
});

// ============================================================
// ATUALIZAR STATUS DA WALLET NA ABA AGENTES
// ============================================================
function updateWalletAgentsStatus(walletData) {
  const el = document.getElementById('wallet-agents-status');
  if (!el) return;

  const { address, shortAddress, onArcNetwork, usdcBalance, chainId } = walletData;

  if (!address) {
    el.textContent = 'Nenhuma wallet conectada.';
    el.className = 'text-gray-500 text-sm';
    return;
  }

  el.className = '';
  el.innerHTML = `
    <div class="flex flex-wrap gap-3 items-center">
      <!-- Endereço -->
      <div class="flex items-center gap-2 bg-gray-800/60 rounded-lg px-3 py-2">
        <div class="w-6 h-6 rounded-full bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center text-white text-xs font-bold">
          ${address.slice(2, 4).toUpperCase()}
        </div>
        <div>
          <div class="text-xs text-gray-400">Endereço</div>
          <div class="text-sm text-white font-mono font-medium">${shortAddress}</div>
        </div>
        <button onclick="copyAddress()" class="text-gray-500 hover:text-white ml-1 transition-colors">
          <i class="fas fa-copy text-xs"></i>
        </button>
      </div>

      <!-- Saldo USDC -->
      <div class="flex items-center gap-2 bg-blue-900/30 border border-blue-700/30 rounded-lg px-3 py-2">
        <i class="fas fa-coins text-blue-400 text-sm"></i>
        <div>
          <div class="text-xs text-gray-400">Saldo USDC</div>
          <div class="text-sm text-white font-semibold">${usdcBalance !== null ? '$' + usdcBalance : '...'} <span class="text-blue-400 text-xs">USDC</span></div>
        </div>
        <button onclick="refreshBalance()" class="text-blue-500 hover:text-blue-300 ml-1 transition-colors">
          <i class="fas fa-sync-alt text-xs"></i>
        </button>
      </div>

      <!-- Rede -->
      <div class="flex items-center gap-2 bg-gray-800/60 rounded-lg px-3 py-2">
        <div class="w-2 h-2 rounded-full ${onArcNetwork ? 'bg-green-400' : 'bg-yellow-400 animate-pulse'}"></div>
        <div>
          <div class="text-xs text-gray-400">Rede</div>
          <div class="text-sm ${onArcNetwork ? 'text-green-400' : 'text-yellow-400'} font-medium">
            ${onArcNetwork ? 'Arc Testnet ✓' : 'Incorreta - Chain ' + chainId}
          </div>
        </div>
        ${!onArcNetwork ? `
          <button onclick="switchNetworkFromUI()" class="text-xs bg-yellow-600 hover:bg-yellow-700 text-white rounded px-2 py-1 transition-colors ml-1">
            Trocar
          </button>
        ` : ''}
      </div>

      <!-- Explorer link -->
      <a href="https://testnet.arcscan.app/address/${address}" target="_blank"
         class="flex items-center gap-1.5 bg-gray-800/60 hover:bg-gray-700/60 rounded-lg px-3 py-2 text-xs text-gray-400 hover:text-purple-400 transition-colors">
        <i class="fas fa-external-link-alt"></i>Ver no Explorer
      </a>
    </div>
  `;
}

