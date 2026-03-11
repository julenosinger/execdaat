// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

/**
 * @title PaymentManager
 * @notice Gerencia pagamentos em USDC na rede Arc
 * @dev Permite pagamentos simples, agendados e em lote via Agentes de IA
 */
contract PaymentManager {
    // USDC nativo da Arc Testnet
    address public constant USDC_ADDRESS = 0x3600000000000000000000000000000000000000;
    IERC20 public immutable usdc;

    address public owner;
    address public aiAgent; // Endereço do Agente de IA autorizado

    uint256 public paymentCounter;

    enum PaymentStatus { Pending, Completed, Failed, Cancelled }

    struct Payment {
        uint256 id;
        address from;
        address to;
        uint256 amount;
        string description;
        PaymentStatus status;
        uint256 createdAt;
        uint256 executedAt;
        string agentDecision; // Decisão do agente de IA
    }

    mapping(uint256 => Payment) public payments;
    mapping(address => uint256[]) public userPayments;

    event PaymentCreated(uint256 indexed id, address indexed from, address indexed to, uint256 amount, string description);
    event PaymentExecuted(uint256 indexed id, string agentDecision);
    event PaymentCancelled(uint256 indexed id, string reason);
    event AgentUpdated(address indexed oldAgent, address indexed newAgent);
    event FundsDeposited(address indexed from, uint256 amount);
    event FundsWithdrawn(address indexed to, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    modifier onlyAgent() {
        require(msg.sender == aiAgent || msg.sender == owner, "Only AI agent or owner");
        _;
    }

    constructor(address _aiAgent) {
        owner = msg.sender;
        aiAgent = _aiAgent;
        usdc = IERC20(USDC_ADDRESS);
    }

    /**
     * @notice Cria um novo pagamento (pendente de aprovação do agente)
     */
    function createPayment(
        address to,
        uint256 amount,
        string memory description
    ) external returns (uint256) {
        require(to != address(0), "Invalid recipient");
        require(amount > 0, "Amount must be positive");

        paymentCounter++;
        uint256 paymentId = paymentCounter;

        payments[paymentId] = Payment({
            id: paymentId,
            from: msg.sender,
            to: to,
            amount: amount,
            description: description,
            status: PaymentStatus.Pending,
            createdAt: block.timestamp,
            executedAt: 0,
            agentDecision: ""
        });

        userPayments[msg.sender].push(paymentId);

        emit PaymentCreated(paymentId, msg.sender, to, amount, description);
        return paymentId;
    }

    /**
     * @notice Agente de IA executa um pagamento aprovado
     */
    function executePayment(uint256 paymentId, string memory agentDecision) external onlyAgent {
        Payment storage payment = payments[paymentId];
        require(payment.status == PaymentStatus.Pending, "Payment not pending");

        payment.agentDecision = agentDecision;

        // Transferir USDC do remetente para o destinatário
        bool success = usdc.transferFrom(payment.from, payment.to, payment.amount);
        require(success, "USDC transfer failed");

        payment.status = PaymentStatus.Completed;
        payment.executedAt = block.timestamp;

        emit PaymentExecuted(paymentId, agentDecision);
    }

    /**
     * @notice Agente de IA cancela um pagamento
     */
    function cancelPayment(uint256 paymentId, string memory reason) external onlyAgent {
        Payment storage payment = payments[paymentId];
        require(payment.status == PaymentStatus.Pending, "Payment not pending");

        payment.status = PaymentStatus.Cancelled;
        payment.agentDecision = reason;

        emit PaymentCancelled(paymentId, reason);
    }

    /**
     * @notice Pagamento direto executado pelo agente (sem pré-aprovação)
     */
    function agentDirectPayment(
        address from,
        address to,
        uint256 amount,
        string memory description,
        string memory agentDecision
    ) external onlyAgent returns (uint256) {
        require(to != address(0), "Invalid recipient");
        require(amount > 0, "Amount must be positive");

        paymentCounter++;
        uint256 paymentId = paymentCounter;

        bool success = usdc.transferFrom(from, to, amount);
        require(success, "USDC transfer failed");

        payments[paymentId] = Payment({
            id: paymentId,
            from: from,
            to: to,
            amount: amount,
            description: description,
            status: PaymentStatus.Completed,
            createdAt: block.timestamp,
            executedAt: block.timestamp,
            agentDecision: agentDecision
        });

        userPayments[from].push(paymentId);

        emit PaymentCreated(paymentId, from, to, amount, description);
        emit PaymentExecuted(paymentId, agentDecision);

        return paymentId;
    }

    /**
     * @notice Retorna todos os pagamentos de um usuário
     */
    function getUserPayments(address user) external view returns (uint256[] memory) {
        return userPayments[user];
    }

    /**
     * @notice Retorna detalhes de um pagamento
     */
    function getPayment(uint256 paymentId) external view returns (Payment memory) {
        return payments[paymentId];
    }

    /**
     * @notice Atualiza o endereço do agente de IA
     */
    function updateAgent(address newAgent) external onlyOwner {
        address oldAgent = aiAgent;
        aiAgent = newAgent;
        emit AgentUpdated(oldAgent, newAgent);
    }

    /**
     * @notice Retorna o saldo USDC do contrato
     */
    function getContractBalance() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }
}
