// Tipos compartilhados para os Agentes de IA na rede Arc

export interface ArcNetworkConfig {
  rpcUrl: string;
  rpcUrlAlternatives: string[];
  rpcUrlWebSocket: string;
  chainId: number;
  usdcAddress: string;
  eurcAddress: string;
  explorerUrl: string;
  faucetUrl: string;
}

export const ARC_TESTNET: ArcNetworkConfig = {
  // RPC endpoints — primário + alternativas
  rpcUrl: 'https://rpc.testnet.arc.network',
  rpcUrlAlternatives: [
    'https://rpc.blockdaemon.testnet.arc.network',
    'https://rpc.drpc.testnet.arc.network',
    'https://rpc.quicknode.testnet.arc.network',
  ],
  rpcUrlWebSocket: 'wss://rpc.testnet.arc.network',
  chainId: 5042002,
  usdcAddress: '0x3600000000000000000000000000000000000000',
  eurcAddress: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
  explorerUrl: 'https://testnet.arcscan.app',
  faucetUrl: 'https://faucet.circle.com'
};

export interface AgentState {
  id: string;
  name: string;
  type: 'payment' | 'contract';
  status: 'idle' | 'thinking' | 'executing' | 'waiting' | 'error';
  lastAction: string;
  lastActionAt: number;
  pendingTasks: number;
  completedTasks: number;
  walletAddress?: string;
}

export interface PaymentTask {
  id: string;
  type: 'analyze' | 'execute' | 'cancel' | 'batch';
  from: string;
  to: string;
  amount: number; // em USDC (com decimais)
  description: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  riskScore?: number;
  status: 'pending' | 'analyzing' | 'approved' | 'rejected' | 'executed' | 'failed';
  agentDecision?: string;
  createdAt: number;
  executedAt?: number;
  txHash?: string;
}

export interface ContractTask {
  id: string;
  type: 'review' | 'activate' | 'verify_milestone' | 'resolve_dispute';
  contractId: number;
  data?: Record<string, unknown>;
  status: 'pending' | 'analyzing' | 'approved' | 'rejected' | 'executed' | 'failed';
  agentDecision?: string;
  createdAt: number;
  executedAt?: number;
  txHash?: string;
}

export interface AgentDecision {
  action: 'approve' | 'reject' | 'escalate' | 'request_info';
  reason: string;
  confidence: number; // 0-100
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  recommendations: string[];
}

export interface BlockchainTransaction {
  hash: string;
  from: string;
  to: string;
  value: string;
  status: 'pending' | 'confirmed' | 'failed';
  blockNumber?: number;
  gasUsed?: string;
  timestamp?: number;
}
