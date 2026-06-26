// Agente de IA para Gerenciamento de Contratos na Rede Arc
// Analisa, ativa, verifica milestones e resolve disputas autonomamente

import type { AgentState, ContractTask, AgentDecision } from '../types/arc';
import { ARC_TESTNET } from '../types/arc';

export interface ContractData {
  id: number;
  client: string;
  contractor: string;
  title: string;
  description: string;
  totalValue: number; // USDC (6 decimals)
  status: 'Draft' | 'Active' | 'Completed' | 'Disputed' | 'Cancelled';
  clientSigned: boolean;
  contractorSigned: boolean;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  milestones: MilestoneData[];
  agentAnalysis?: string;
}

export interface MilestoneData {
  id: number;
  description: string;
  amount: number;
  status: 'Pending' | 'InProgress' | 'Completed' | 'Failed';
  completedAt?: number;
  agentVerification?: string;
}

export class ContractAgent {
  private state: AgentState;
  private taskQueue: ContractTask[] = [];
  private processedTasks: ContractTask[] = [];
  private contracts: Map<number, ContractData> = new Map();
  private contractAddress: string;

  // Critérios de análise de contratos
  private readonly ANALYSIS_CRITERIA = {
    MAX_CONTRACT_VALUE: 50000 * 1e6,   // 50,000 USDC
    MAX_MILESTONES: 20,
    MIN_DESCRIPTION_LENGTH: 20,
    DISPUTE_RESOLUTION_TIMEOUT: 7 * 24 * 60 * 60 * 1000, // 7 dias
  };

  constructor(contractAddress: string) {
    this.contractAddress = contractAddress;
    this.state = {
      id: 'contract-agent-01',
      name: 'Daat Contract Agent v1.0',
      type: 'contract',
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

  getTaskQueue(): ContractTask[] {
    return [...this.taskQueue];
  }

  getContracts(): ContractData[] {
    return Array.from(this.contracts.values());
  }

  /**
   * Registra um contrato no agente para monitoramento
   */
  registerContract(contract: ContractData): void {
    this.contracts.set(contract.id, contract);
    this.updateState('idle', `Contrato #${contract.id} registrado: ${contract.title}`);
  }

  /**
   * Submete tarefa de revisão de contrato
   */
  async submitContractTask(task: Omit<ContractTask, 'id' | 'status' | 'createdAt'>): Promise<string> {
    const taskId = `contract-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newTask: ContractTask = {
      ...task,
      id: taskId,
      status: 'pending',
      createdAt: Date.now(),
    };

    this.taskQueue.push(newTask);
    this.state.pendingTasks = this.taskQueue.length;
    return taskId;
  }

  /**
   * Analisa um contrato e toma decisão (lógica de IA)
   */
  async analyzeContract(contract: ContractData): Promise<AgentDecision> {
    this.updateState('thinking', `Analisando contrato #${contract.id}: ${contract.title}`);

    const issues: string[] = [];
    const recommendations: string[] = [];

    // Verificações básicas
    if (contract.totalValue > this.ANALYSIS_CRITERIA.MAX_CONTRACT_VALUE) {
      issues.push(`Valor excede limite máximo de $${(this.ANALYSIS_CRITERIA.MAX_CONTRACT_VALUE / 1e6).toLocaleString()} USDC`);
    }

    if (contract.description.length < this.ANALYSIS_CRITERIA.MIN_DESCRIPTION_LENGTH) {
      issues.push('Descrição muito curta - detalhes insuficientes');
      recommendations.push('Adicionar descrição detalhada do escopo');
    }

    if (!contract.clientSigned || !contract.contractorSigned) {
      issues.push('Contrato não assinado por ambas as partes');
    }

    if (contract.milestones.length === 0) {
      recommendations.push('Adicionar marcos para controlar progresso');
    }

    if (contract.milestones.length > this.ANALYSIS_CRITERIA.MAX_MILESTONES) {
      issues.push(`Muitos marcos (${contract.milestones.length}). Máximo: ${this.ANALYSIS_CRITERIA.MAX_MILESTONES}`);
    }

    // Verificar se soma dos milestones bate com o total
    if (contract.milestones.length > 0) {
      const milestonesTotal = contract.milestones.reduce((sum, m) => sum + m.amount, 0);
      if (Math.abs(milestonesTotal - contract.totalValue) > 1e6) { // tolerância de 1 USDC
        issues.push(`Soma dos marcos ($${(milestonesTotal / 1e6).toFixed(2)}) difere do valor total ($${(contract.totalValue / 1e6).toFixed(2)})`);
        recommendations.push('Ajustar valores dos marcos para totalizar o valor do contrato');
      }
    }

    // Verificar endereços
    const addressRegex = /^0x[a-fA-F0-9]{40}$/;
    if (!addressRegex.test(contract.client) || !addressRegex.test(contract.contractor)) {
      issues.push('Endereços inválidos');
    }

    if (contract.client.toLowerCase() === contract.contractor.toLowerCase()) {
      issues.push('Cliente e contratante são o mesmo endereço');
    }

    const riskLevel = issues.length === 0 ? 'low' : issues.length <= 2 ? 'medium' : 'high';

    return {
      action: issues.length === 0 ? 'approve' : issues.some(i => i.includes('inválido') || i.includes('excede')) ? 'reject' : 'escalate',
      reason: issues.length === 0
        ? `Contrato validado com sucesso. ${contract.milestones.length} marcos identificados. Pronto para ativação com escrow de $${(contract.totalValue / 1e6).toFixed(2)} USDC.`
        : `Problemas encontrados: ${issues.join('; ')}`,
      confidence: issues.length === 0 ? 95 : 70,
      riskLevel,
      recommendations: [
        ...recommendations,
        'Verificar termos no explorador: ' + ARC_TESTNET.explorerUrl,
        'Garantir USDC disponível para escrow',
      ],
    };
  }

  /**
   * Verifica conclusão de milestone
   */
  async verifyMilestoneCompletion(
    contract: ContractData,
    milestoneId: number,
    evidence: string
  ): Promise<AgentDecision> {
    this.updateState('thinking', `Verificando milestone #${milestoneId} do contrato #${contract.id}`);

    const milestone = contract.milestones.find(m => m.id === milestoneId);
    if (!milestone) {
      return {
        action: 'reject',
        reason: `Milestone #${milestoneId} não encontrado no contrato`,
        confidence: 100,
        riskLevel: 'high',
        recommendations: ['Verificar ID do milestone'],
      };
    }

    // Análise da evidência fornecida
    const evidenceQuality = this.evaluateEvidence(evidence);

    if (evidenceQuality.score >= 70) {
      return {
        action: 'approve',
        reason: `Milestone "${milestone.description}" verificado. Evidência analisada: ${evidence.substring(0, 100)}... Liberando pagamento de $${(milestone.amount / 1e6).toFixed(2)} USDC para o contratante.`,
        confidence: evidenceQuality.score,
        riskLevel: 'low',
        recommendations: ['Documentar conclusão para referência futura'],
      };
    } else {
      return {
        action: 'reject',
        reason: `Evidência insuficiente para verificar milestone. Score: ${evidenceQuality.score}/100. ${evidenceQuality.issues.join(', ')}`,
        confidence: 85,
        riskLevel: 'medium',
        recommendations: evidenceQuality.recommendations,
      };
    }
  }

  /**
   * Resolve disputa de contrato
   */
  async resolveDispute(
    contract: ContractData,
    disputeReason: string
  ): Promise<{ clientAmount: number; contractorAmount: number; resolution: string }> {
    this.updateState('thinking', `Resolvendo disputa no contrato #${contract.id}`);

    // Calcular trabalho concluído
    const completedMilestones = contract.milestones.filter(m => m.status === 'Completed');
    const completedValue = completedMilestones.reduce((sum, m) => sum + m.amount, 0);
    const pendingValue = contract.totalValue - completedValue;

    // Decisão de arbitragem baseada em progresso
    let contractorShare = completedValue;
    let clientShare = pendingValue;
    let resolution = '';

    if (completedValue / contract.totalValue >= 0.8) {
      // 80%+ concluído - favorece contratante
      contractorShare = Math.floor(contract.totalValue * 0.85);
      clientShare = contract.totalValue - contractorShare;
      resolution = `Arbitragem: ${(completedValue / contract.totalValue * 100).toFixed(0)}% do trabalho concluído. Contratante recebe 85% do valor total.`;
    } else if (completedValue / contract.totalValue >= 0.5) {
      // 50-80% concluído - divisão proporcional
      contractorShare = completedValue + Math.floor(pendingValue * 0.3);
      clientShare = contract.totalValue - contractorShare;
      resolution = `Arbitragem: ${(completedValue / contract.totalValue * 100).toFixed(0)}% do trabalho concluído. Distribuição proporcional ao progresso.`;
    } else {
      // < 50% concluído - favorece cliente
      contractorShare = completedValue;
      clientShare = pendingValue;
      resolution = `Arbitragem: Apenas ${(completedValue / contract.totalValue * 100).toFixed(0)}% concluído. Cliente reembolsado por trabalho não entregue.`;
    }

    this.updateState('idle', `Disputa #${contract.id} resolvida`);

    return {
      clientAmount: clientShare,
      contractorAmount: contractorShare,
      resolution: `${resolution} Motivo da disputa: ${disputeReason}`,
    };
  }

  /**
   * Processa tarefas pendentes da fila
   */
  async processTaskQueue(): Promise<{ processed: number; errors: string[] }> {
    const pendingTasks = this.taskQueue.filter(t => t.status === 'pending');
    const errors: string[] = [];
    let processed = 0;

    for (const task of pendingTasks) {
      try {
        task.status = 'analyzing';
        const contract = this.contracts.get(task.contractId);

        if (!contract) {
          task.status = 'failed';
          task.agentDecision = `Contrato #${task.contractId} não encontrado`;
          errors.push(task.agentDecision);
          continue;
        }

        let decision: AgentDecision;

        switch (task.type) {
          case 'review':
            decision = await this.analyzeContract(contract);
            break;
          case 'activate':
            decision = await this.analyzeContract(contract);
            if (decision.action === 'approve') {
              contract.status = 'Active';
              contract.startedAt = Date.now();
            }
            break;
          case 'verify_milestone':
            const milestoneId = task.data?.milestoneId as number;
            const evidence = task.data?.evidence as string || '';
            decision = await this.verifyMilestoneCompletion(contract, milestoneId, evidence);
            if (decision.action === 'approve') {
              const milestone = contract.milestones.find(m => m.id === milestoneId);
              if (milestone) {
                milestone.status = 'Completed';
                milestone.completedAt = Date.now();
                milestone.agentVerification = decision.reason;
              }
            }
            break;
          case 'resolve_dispute':
            const disputeReason = task.data?.reason as string || 'Sem motivo especificado';
            const resolution = await this.resolveDispute(contract, disputeReason);
            decision = {
              action: 'approve',
              reason: resolution.resolution,
              confidence: 85,
              riskLevel: 'medium',
              recommendations: [],
            };
            break;
          default:
            decision = {
              action: 'reject',
              reason: 'Tipo de tarefa desconhecido',
              confidence: 100,
              riskLevel: 'low',
              recommendations: [],
            };
        }

        task.status = decision.action === 'approve' ? 'executed' : decision.action === 'reject' ? 'rejected' : 'pending';
        task.agentDecision = decision.reason;
        task.executedAt = Date.now();

        if (task.status !== 'pending') {
          const index = this.taskQueue.indexOf(task);
          this.taskQueue.splice(index, 1);
          this.processedTasks.push(task);
          this.state.completedTasks++;
          processed++;
        }
      } catch (err) {
        errors.push(`Erro na tarefa ${task.id}: ${err}`);
        task.status = 'failed';
      }
    }

    this.state.pendingTasks = this.taskQueue.length;
    this.updateState('idle', `Processadas ${processed} tarefas de contrato`);
    return { processed, errors };
  }

  /**
   * Avalia qualidade das evidências submetidas
   */
  private evaluateEvidence(evidence: string): { score: number; issues: string[]; recommendations: string[] } {
    const issues: string[] = [];
    const recommendations: string[] = [];
    let score = 100;

    if (evidence.length < 20) {
      score -= 40;
      issues.push('Evidência muito curta');
      recommendations.push('Fornecer descrição detalhada do trabalho concluído');
    }

    if (!evidence.includes('http') && evidence.length < 100) {
      score -= 20;
      recommendations.push('Incluir link para código, documento ou prova de entrega');
    }

    if (evidence.toLowerCase().includes('conclu') || evidence.toLowerCase().includes('entregue') || 
        evidence.toLowerCase().includes('pronto') || evidence.toLowerCase().includes('done')) {
      score += 10; // Palavras-chave positivas
    }

    return { score: Math.max(0, Math.min(100, score)), issues, recommendations };
  }

  private updateState(status: AgentState['status'], action: string) {
    this.state.status = status;
    this.state.lastAction = action;
    this.state.lastActionAt = Date.now();
  }

  /**
   * Estatísticas do agente de contratos
   */
  getStats() {
    const allTasks = [...this.processedTasks];
    return {
      totalContracts: this.contracts.size,
      activeContracts: Array.from(this.contracts.values()).filter(c => c.status === 'Active').length,
      completedContracts: Array.from(this.contracts.values()).filter(c => c.status === 'Completed').length,
      disputedContracts: Array.from(this.contracts.values()).filter(c => c.status === 'Disputed').length,
      totalTasksProcessed: allTasks.length,
      approvedTasks: allTasks.filter(t => t.status === 'executed').length,
      rejectedTasks: allTasks.filter(t => t.status === 'rejected').length,
      pendingTasks: this.taskQueue.length,
    };
  }

  /**
   * Gera relatório de atividade
   */
  generateReport(): string {
    const stats = this.getStats();
    return `
# Relatório do Agente de Contratos - ${this.state.name}

## Status: ${this.state.status.toUpperCase()}
- Última ação: ${this.state.lastAction}

## Contratos Gerenciados
- Total registrados: ${stats.totalContracts}
- Ativos: ${stats.activeContracts}
- Concluídos: ${stats.completedContracts}
- Em disputa: ${stats.disputedContracts}

## Tarefas Processadas
- Total: ${stats.totalTasksProcessed}
- Aprovadas: ${stats.approvedTasks}
- Rejeitadas: ${stats.rejectedTasks}
- Pendentes: ${stats.pendingTasks}

## Rede Arc Testnet
- RPC: ${ARC_TESTNET.rpcUrl}
- Chain ID: ${ARC_TESTNET.chainId}
- Explorer: ${ARC_TESTNET.explorerUrl}
    `.trim();
  }
}
