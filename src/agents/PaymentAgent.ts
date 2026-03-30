// Agente de IA para Gerenciamento de Pagamentos na Rede Arc
// Usa regras heurísticas e análise de risco para decisões autônomas

import type { AgentState, PaymentTask, AgentDecision, BlockchainTransaction } from '../types/arc';
import { ARC_TESTNET } from '../types/arc';

// ABIs simplificados
const USDC_ABI = [
  'function transfer(address to, uint256 amount) external returns (bool)',
  'function balanceOf(address owner) external view returns (uint256)',
  'function decimals() external view returns (uint8)',
  'function approve(address spender, uint256 amount) external returns (bool)',
];

const PAYMENT_MANAGER_ABI = [
  'function createPayment(address to, uint256 amount, string description) external returns (uint256)',
  'function executePayment(uint256 paymentId, string agentDecision) external',
  'function cancelPayment(uint256 paymentId, string reason) external',
  'function agentDirectPayment(address from, address to, uint256 amount, string description, string agentDecision) external returns (uint256)',
  'function getPayment(uint256 paymentId) external view returns (tuple(uint256 id, address from, address to, uint256 amount, string description, uint8 status, uint256 createdAt, uint256 executedAt, string agentDecision))',
];

// ─── Vault integration helper ────────────────────────────────────────────────
// Acessa o estado dos vaults em memória (importado em runtime para evitar circular deps)
// Em produção: usar D1 ou KV para persistência compartilhada
let _vaultStore: Record<string, { positions: Map<string, { balance: number; yieldEarned: number; strategy: string }> }> | null = null;

export function injectVaultStore(store: typeof _vaultStore) {
  _vaultStore = store;
}

export class PaymentAgent {
  private state: AgentState;
  private taskQueue: PaymentTask[] = [];
  private processedTasks: PaymentTask[] = [];
  private contractAddress: string;

  // Limites de risco para decisões autônomas
  private readonly RISK_THRESHOLDS = {
    LOW_RISK_LIMIT: 10 * 1e6,       // 10 USDC - auto-aprova
    MEDIUM_RISK_LIMIT: 100 * 1e6,   // 100 USDC - análise aumentada
    HIGH_RISK_LIMIT: 1000 * 1e6,    // 1000 USDC - requer múltiplas verificações
    CRITICAL_LIMIT: 10000 * 1e6,    // 10000 USDC - bloqueia até revisão humana
  };

  constructor(contractAddress: string) {
    this.contractAddress = contractAddress;
    this.state = {
      id: 'payment-agent-01',
      name: 'Daat Agent v1.0',
      type: 'payment',
      status: 'idle',
      lastAction: 'Inicializado',
      lastActionAt: Date.now(),
      pendingTasks: 0,
      completedTasks: 0,
    };
  }

  getState(): AgentState {
    return { ...this.state };
  }

  getTaskQueue(): PaymentTask[] {
    return [...this.taskQueue];
  }

  getProcessedTasks(): PaymentTask[] {
    return [...this.processedTasks].slice(-50); // últimas 50
  }

  /**
   * Submete uma nova tarefa de pagamento para análise
   */
  async submitPaymentTask(task: Omit<PaymentTask, 'id' | 'status' | 'createdAt' | 'riskScore'>): Promise<string> {
    const taskId = `pay-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newTask: PaymentTask = {
      ...task,
      id: taskId,
      status: 'pending',
      createdAt: Date.now(),
      riskScore: this.calculateRiskScore(task),
    };

    this.taskQueue.push(newTask);
    this.state.pendingTasks = this.taskQueue.length;
    this.updateState('idle', `Nova tarefa adicionada: ${taskId}`);

    return taskId;
  }

  /**
   * Consulta saldo disponível no vault para uma carteira
   */
  getVaultBalance(walletAddress: string, token: 'usdc' | 'eurc' = 'usdc'): number {
    if (!_vaultStore) return 0;
    const vault = _vaultStore[token];
    if (!vault) return 0;
    const pos = vault.positions.get(walletAddress.toLowerCase());
    return pos?.balance ?? 0;
  }

  /**
   * Verifica se o agente pode operar com saldo do vault para um pagamento
   */
  canUseVaultFunds(walletAddress: string, amountUSDC: number): { can: boolean; vaultBalance: number; reason: string } {
    const vaultBal = this.getVaultBalance(walletAddress, 'usdc');
    if (vaultBal <= 0) {
      return { can: false, vaultBalance: 0, reason: 'Nenhum saldo depositado no vault USDC' };
    }
    const amountRaw = amountUSDC * 1e6;
    if (amountRaw > this.RISK_THRESHOLDS.MEDIUM_RISK_LIMIT) {
      return { can: false, vaultBalance: vaultBal, reason: `Operação acima do limite via vault ($${amountUSDC} > $100)` };
    }
    if (vaultBal < amountUSDC) {
      return { can: false, vaultBalance: vaultBal, reason: `Saldo no vault insuficiente: ${vaultBal.toFixed(4)} USDC` };
    }
    return { can: true, vaultBalance: vaultBal, reason: `Vault USDC disponível: ${vaultBal.toFixed(4)} USDC` };
  }

  /**
   * Executa um pagamento usando saldo do vault (debita a posição da carteira)
   * Retorna txHash simulado + detalhes para o backend de vault registrar
   */
  async executeWithVaultFunds(
    task: PaymentTask
  ): Promise<{ success: boolean; txHash?: string; vaultDebit?: { wallet: string; token: string; amount: number }; error?: string }> {
    const amountUSDC = task.amount / 1e6;
    const check = this.canUseVaultFunds(task.from, amountUSDC);
    if (!check.can) {
      return { success: false, error: check.reason };
    }

    if (!_vaultStore) return { success: false, error: 'Vault store não disponível' };

    const vault = _vaultStore['usdc'];
    if (!vault) return { success: false, error: 'Vault USDC não encontrado' };

    const pos = vault.positions.get(task.from.toLowerCase());
    if (!pos || pos.balance < amountUSDC) {
      return { success: false, error: 'Saldo insuficiente no vault durante execução' };
    }

    // Debitar saldo da posição
    pos.balance -= amountUSDC;

    // Simular execução on-chain
    const txResult = await this.simulateBlockchainExecution(task);

    this.updateState('executing', `Pagamento via vault: ${amountUSDC} USDC de ${task.from.slice(0,10)}... para ${task.to.slice(0,10)}...`);

    return {
      success: txResult.success,
      txHash: txResult.hash,
      vaultDebit: { wallet: task.from.toLowerCase(), token: 'usdc', amount: amountUSDC },
    };
  }

  /**
   * Analisa e decide sobre um pagamento (lógica do agente de IA)
   */
  async analyzePayment(task: PaymentTask): Promise<AgentDecision> {
    this.updateState('thinking', `Analisando pagamento ${task.id}`);

    const amount = task.amount;
    const riskScore = task.riskScore || this.calculateRiskScore(task);

    // Simulação de análise de IA com regras heurísticas
    const checks = {
      validAddresses: this.validateAddresses(task.from, task.to),
      amountSafe: amount <= this.RISK_THRESHOLDS.CRITICAL_LIMIT,
      hasDescription: task.description.length > 5,
      notSelfPayment: task.from.toLowerCase() !== task.to.toLowerCase(),
      reasonableAmount: amount > 0,
    };

    const failedChecks = Object.entries(checks)
      .filter(([_, passed]) => !passed)
      .map(([check]) => check);

    if (failedChecks.length > 0) {
      return {
        action: 'reject',
        reason: `Verificações falhas: ${failedChecks.join(', ')}`,
        confidence: 95,
        riskLevel: 'critical',
        recommendations: ['Verificar endereços', 'Confirmar descrição', 'Verificar limite de valor'],
      };
    }

    // Decisão baseada no valor
    if (amount <= this.RISK_THRESHOLDS.LOW_RISK_LIMIT) {
      return {
        action: 'approve',
        reason: `Pagamento de baixo risco (${(amount / 1e6).toFixed(2)} USDC). Auto-aprovado pelo agente.`,
        confidence: 98,
        riskLevel: 'low',
        recommendations: ['Monitorar padrões de pagamento'],
      };
    } else if (amount <= this.RISK_THRESHOLDS.MEDIUM_RISK_LIMIT) {
      const shouldApprove = riskScore < 70;
      return {
        action: shouldApprove ? 'approve' : 'escalate',
        reason: shouldApprove
          ? `Pagamento de médio risco aprovado após análise. Score: ${riskScore}/100`
          : `Pagamento requer revisão adicional. Score: ${riskScore}/100`,
        confidence: 85,
        riskLevel: 'medium',
        recommendations: ['Verificar histórico do remetente', 'Confirmar finalidade'],
      };
    } else if (amount <= this.RISK_THRESHOLDS.HIGH_RISK_LIMIT) {
      return {
        action: 'escalate',
        reason: `Pagamento de alto valor (${(amount / 1e6).toFixed(2)} USDC). Requer verificação adicional.`,
        confidence: 80,
        riskLevel: 'high',
        recommendations: ['Verificar identidade', 'Confirmar por múltiplos canais', 'Aguardar confirmação manual'],
      };
    } else {
      return {
        action: 'reject',
        reason: `Pagamento excede limite crítico (${(amount / 1e6).toFixed(2)} USDC). Bloqueado para segurança.`,
        confidence: 99,
        riskLevel: 'critical',
        recommendations: ['Contatar suporte', 'Dividir em transações menores', 'Verificar autorização'],
      };
    }
  }

  /**
   * Processa a fila de tarefas pendentes (simula execução blockchain)
   */
  async processPendingTasks(): Promise<{ processed: number; errors: string[] }> {
    const pendingTasks = this.taskQueue.filter(t => t.status === 'pending');
    const errors: string[] = [];
    let processed = 0;

    for (const task of pendingTasks) {
      try {
        task.status = 'analyzing';
        const decision = await this.analyzePayment(task);

        if (decision.action === 'approve') {
          // Verificar se pode usar saldo do vault antes de executar
          const amountUSDC = task.amount / 1e6;
          const vaultCheck = this.canUseVaultFunds(task.from, amountUSDC);

          let txResult: { success: boolean; hash: string };
          let usedVault = false;

          if (vaultCheck.can) {
            // Usar saldo do vault para executar o pagamento
            const vaultResult = await this.executeWithVaultFunds(task);
            if (vaultResult.success && vaultResult.txHash) {
              txResult = { success: true, hash: vaultResult.txHash };
              usedVault = true;
              task.agentDecision = `${decision.reason} [VAULT: ${vaultCheck.vaultBalance.toFixed(4)} USDC disponível → debitado ${amountUSDC.toFixed(4)} USDC]`;
            } else {
              // Fallback para simulação normal
              txResult = await this.simulateBlockchainExecution(task);
              task.agentDecision = `${decision.reason} [Vault indisponível, execução direta]`;
            }
          } else {
            // Execução normal (sem vault)
            txResult = await this.simulateBlockchainExecution(task);
            task.agentDecision = decision.reason;
          }

          task.status = txResult.success ? 'executed' : 'failed';
          task.txHash = txResult.hash;
          if (!task.agentDecision) task.agentDecision = decision.reason;
          task.executedAt = Date.now();
          processed++;
        } else if (decision.action === 'reject') {
          task.status = 'rejected';
          task.agentDecision = decision.reason;
          processed++;
        } else {
          // escalate - mantém na fila mas marca para revisão
          task.status = 'pending';
          task.agentDecision = `ESCALADO: ${decision.reason}`;
        }

        // Mover para processados
        const index = this.taskQueue.indexOf(task);
        if (task.status !== 'pending') {
          this.taskQueue.splice(index, 1);
          this.processedTasks.push(task);
          this.state.completedTasks++;
        }
      } catch (err) {
        errors.push(`Erro na tarefa ${task.id}: ${err}`);
        task.status = 'failed';
      }
    }

    this.state.pendingTasks = this.taskQueue.length;
    this.updateState('idle', `Processadas ${processed} tarefas`);
    return { processed, errors };
  }

  /**
   * Calcula score de risco (0-100, maior = mais arriscado)
   */
  private calculateRiskScore(task: Partial<PaymentTask>): number {
    let score = 0;
    const amount = task.amount || 0;

    // Fator de valor
    if (amount > this.RISK_THRESHOLDS.HIGH_RISK_LIMIT) score += 50;
    else if (amount > this.RISK_THRESHOLDS.MEDIUM_RISK_LIMIT) score += 30;
    else if (amount > this.RISK_THRESHOLDS.LOW_RISK_LIMIT) score += 10;

    // Fator de prioridade
    if (task.priority === 'critical') score += 20;
    else if (task.priority === 'high') score += 10;

    // Fator de descrição (sem descrição = mais risco)
    if (!task.description || task.description.length < 10) score += 20;

    return Math.min(score, 100);
  }

  private validateAddresses(from: string, to: string): boolean {
    const addressRegex = /^0x[a-fA-F0-9]{40}$/;
    return addressRegex.test(from) && addressRegex.test(to) && from !== to;
  }

  /**
   * Simula execução de transação na blockchain Arc
   * Em produção, conectaria via ethers.js
   */
  private async simulateBlockchainExecution(task: PaymentTask): Promise<{ success: boolean; hash: string }> {
    // Simula latência de ~1 segundo (Arc tem finalidade sub-segundo)
    await new Promise(resolve => setTimeout(resolve, 800));
    
    // Gera hash simulado de transação
    const hash = `0x${Array.from({ length: 64 }, () => 
      Math.floor(Math.random() * 16).toString(16)
    ).join('')}`;
    
    return { success: true, hash };
  }

  private updateState(status: AgentState['status'], action: string) {
    this.state.status = status;
    this.state.lastAction = action;
    this.state.lastActionAt = Date.now();
  }

  /**
   * Retorna estatísticas do agente
   */
  getStats() {
    const allTasks = [...this.processedTasks];
    return {
      totalProcessed: allTasks.length,
      approved: allTasks.filter(t => t.status === 'executed').length,
      rejected: allTasks.filter(t => t.status === 'rejected').length,
      failed: allTasks.filter(t => t.status === 'failed').length,
      pending: this.taskQueue.length,
      totalValueProcessed: allTasks
        .filter(t => t.status === 'executed')
        .reduce((sum, t) => sum + t.amount, 0),
    };
  }

  /**
   * Gera relatório de atividade do agente
   */
  generateReport(): string {
    const stats = this.getStats();
    const approvalRate = stats.totalProcessed > 0
      ? ((stats.approved / stats.totalProcessed) * 100).toFixed(1)
      : '0';

    return `
# Relatório do Agente de Pagamentos - ${this.state.name}

## Status: ${this.state.status.toUpperCase()}
- Última ação: ${this.state.lastAction}
- Em: ${new Date(this.state.lastActionAt).toLocaleString('pt-BR')}

## Estatísticas
- Total processado: ${stats.totalProcessed}
- Aprovados/Executados: ${stats.approved}
- Rejeitados: ${stats.rejected}
- Falhos: ${stats.failed}
- Pendentes: ${stats.pending}
- Taxa de aprovação: ${approvalRate}%
- Valor total processado: $${(stats.totalValueProcessed / 1e6).toFixed(2)} USDC

## Rede Arc Testnet
- RPC: ${ARC_TESTNET.rpcUrl}
- Chain ID: ${ARC_TESTNET.chainId}
- Explorer: ${ARC_TESTNET.explorerUrl}
    `.trim();
  }
}
