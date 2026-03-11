// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/**
 * @title ContractManager
 * @notice Gerencia contratos digitais na rede Arc com aprovação por Agentes de IA
 * @dev Permite criar, assinar, executar e cancelar contratos digitais com pagamentos USDC
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract ContractManager {
    address public constant USDC_ADDRESS = 0x3600000000000000000000000000000000000000;
    IERC20 public immutable usdc;

    address public owner;
    address public aiAgent;

    uint256 public contractCounter;

    enum ContractStatus { Draft, Active, Completed, Disputed, Cancelled }
    enum MilestoneStatus { Pending, InProgress, Completed, Failed }

    struct Milestone {
        uint256 id;
        string description;
        uint256 amount;      // USDC amount (6 decimals)
        MilestoneStatus status;
        uint256 completedAt;
        string agentVerification;
    }

    struct DigitalContract {
        uint256 id;
        address client;
        address contractor;
        string title;
        string description;
        uint256 totalValue;   // Total em USDC
        ContractStatus status;
        uint256 createdAt;
        uint256 startedAt;
        uint256 completedAt;
        string ipfsHash;       // Hash IPFS dos termos do contrato
        bool clientSigned;
        bool contractorSigned;
        string agentAnalysis;  // Análise do agente de IA
        uint256 milestoneCount;
        mapping(uint256 => Milestone) milestones;
    }

    mapping(uint256 => DigitalContract) public contracts;
    mapping(address => uint256[]) public userContracts;
    mapping(uint256 => uint256) public contractEscrow; // Valores em escrow

    event ContractCreated(uint256 indexed id, address indexed client, address indexed contractor, string title, uint256 totalValue);
    event ContractSigned(uint256 indexed id, address indexed signer);
    event ContractActivated(uint256 indexed id, string agentAnalysis);
    event MilestoneCompleted(uint256 indexed contractId, uint256 indexed milestoneId, string agentVerification);
    event ContractCompleted(uint256 indexed id);
    event ContractDisputed(uint256 indexed id, string reason);
    event ContractCancelled(uint256 indexed id, string reason);
    event EscrowDeposited(uint256 indexed contractId, uint256 amount);
    event PaymentReleased(uint256 indexed contractId, address indexed to, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    modifier onlyAgent() {
        require(msg.sender == aiAgent || msg.sender == owner, "Only AI agent or owner");
        _;
    }

    modifier onlyParties(uint256 contractId) {
        DigitalContract storage dc = contracts[contractId];
        require(msg.sender == dc.client || msg.sender == dc.contractor, "Only contract parties");
        _;
    }

    constructor(address _aiAgent) {
        owner = msg.sender;
        aiAgent = _aiAgent;
        usdc = IERC20(USDC_ADDRESS);
    }

    /**
     * @notice Cria um novo contrato digital
     */
    function createContract(
        address contractor,
        string memory title,
        string memory description,
        uint256 totalValue,
        string memory ipfsHash
    ) external returns (uint256) {
        require(contractor != address(0) && contractor != msg.sender, "Invalid contractor");
        require(totalValue > 0, "Value must be positive");

        contractCounter++;
        uint256 contractId = contractCounter;

        DigitalContract storage dc = contracts[contractId];
        dc.id = contractId;
        dc.client = msg.sender;
        dc.contractor = contractor;
        dc.title = title;
        dc.description = description;
        dc.totalValue = totalValue;
        dc.status = ContractStatus.Draft;
        dc.createdAt = block.timestamp;
        dc.ipfsHash = ipfsHash;

        userContracts[msg.sender].push(contractId);
        userContracts[contractor].push(contractId);

        emit ContractCreated(contractId, msg.sender, contractor, title, totalValue);
        return contractId;
    }

    /**
     * @notice Adiciona marcos (milestones) ao contrato
     */
    function addMilestone(
        uint256 contractId,
        string memory description,
        uint256 amount
    ) external {
        DigitalContract storage dc = contracts[contractId];
        require(dc.status == ContractStatus.Draft, "Contract not in draft");
        require(msg.sender == dc.client, "Only client can add milestones");

        uint256 milestoneId = dc.milestoneCount + 1;
        dc.milestones[milestoneId] = Milestone({
            id: milestoneId,
            description: description,
            amount: amount,
            status: MilestoneStatus.Pending,
            completedAt: 0,
            agentVerification: ""
        });
        dc.milestoneCount++;
    }

    /**
     * @notice Assina o contrato (ambas as partes devem assinar)
     */
    function signContract(uint256 contractId) external onlyParties(contractId) {
        DigitalContract storage dc = contracts[contractId];
        require(dc.status == ContractStatus.Draft, "Contract not in draft");

        if (msg.sender == dc.client) {
            dc.clientSigned = true;
        } else {
            dc.contractorSigned = true;
        }

        emit ContractSigned(contractId, msg.sender);
    }

    /**
     * @notice Agente de IA ativa o contrato após análise e depósito de escrow
     */
    function activateContract(uint256 contractId, string memory agentAnalysis) external onlyAgent {
        DigitalContract storage dc = contracts[contractId];
        require(dc.status == ContractStatus.Draft, "Contract not in draft");
        require(dc.clientSigned && dc.contractorSigned, "Both parties must sign");

        // Depositar escrow do cliente
        bool success = usdc.transferFrom(dc.client, address(this), dc.totalValue);
        require(success, "Escrow deposit failed");

        contractEscrow[contractId] = dc.totalValue;
        dc.status = ContractStatus.Active;
        dc.startedAt = block.timestamp;
        dc.agentAnalysis = agentAnalysis;

        emit ContractActivated(contractId, agentAnalysis);
        emit EscrowDeposited(contractId, dc.totalValue);
    }

    /**
     * @notice Agente de IA verifica e completa um milestone
     */
    function completeMilestone(
        uint256 contractId,
        uint256 milestoneId,
        string memory agentVerification
    ) external onlyAgent {
        DigitalContract storage dc = contracts[contractId];
        require(dc.status == ContractStatus.Active, "Contract not active");

        Milestone storage milestone = dc.milestones[milestoneId];
        require(milestone.status == MilestoneStatus.Pending || milestone.status == MilestoneStatus.InProgress, "Invalid milestone status");
        require(milestone.amount <= contractEscrow[contractId], "Insufficient escrow");

        milestone.status = MilestoneStatus.Completed;
        milestone.completedAt = block.timestamp;
        milestone.agentVerification = agentVerification;

        // Liberar pagamento do escrow para o contratante
        contractEscrow[contractId] -= milestone.amount;
        bool success = usdc.transfer(dc.contractor, milestone.amount);
        require(success, "Payment failed");

        emit MilestoneCompleted(contractId, milestoneId, agentVerification);
        emit PaymentReleased(contractId, dc.contractor, milestone.amount);

        // Verificar se todos os milestones foram concluídos
        bool allCompleted = true;
        for (uint256 i = 1; i <= dc.milestoneCount; i++) {
            if (dc.milestones[i].status != MilestoneStatus.Completed) {
                allCompleted = false;
                break;
            }
        }

        if (allCompleted && contractEscrow[contractId] == 0) {
            dc.status = ContractStatus.Completed;
            dc.completedAt = block.timestamp;
            emit ContractCompleted(contractId);
        }
    }

    /**
     * @notice Disputa um contrato
     */
    function disputeContract(uint256 contractId, string memory reason) external onlyParties(contractId) {
        DigitalContract storage dc = contracts[contractId];
        require(dc.status == ContractStatus.Active, "Contract not active");
        dc.status = ContractStatus.Disputed;
        emit ContractDisputed(contractId, reason);
    }

    /**
     * @notice Agente de IA resolve disputa e distribui fundos
     */
    function resolveDispute(
        uint256 contractId,
        uint256 clientAmount,
        uint256 contractorAmount,
        string memory resolution
    ) external onlyAgent {
        DigitalContract storage dc = contracts[contractId];
        require(dc.status == ContractStatus.Disputed, "Contract not disputed");
        require(clientAmount + contractorAmount <= contractEscrow[contractId], "Invalid amounts");

        contractEscrow[contractId] = 0;
        dc.status = ContractStatus.Completed;
        dc.completedAt = block.timestamp;
        dc.agentAnalysis = resolution;

        if (clientAmount > 0) {
            usdc.transfer(dc.client, clientAmount);
            emit PaymentReleased(contractId, dc.client, clientAmount);
        }
        if (contractorAmount > 0) {
            usdc.transfer(dc.contractor, contractorAmount);
            emit PaymentReleased(contractId, dc.contractor, contractorAmount);
        }
    }

    /**
     * @notice Cancela um contrato em Draft
     */
    function cancelContract(uint256 contractId, string memory reason) external {
        DigitalContract storage dc = contracts[contractId];
        require(
            msg.sender == dc.client || msg.sender == dc.contractor || msg.sender == aiAgent,
            "Unauthorized"
        );
        require(dc.status == ContractStatus.Draft, "Can only cancel draft contracts");

        dc.status = ContractStatus.Cancelled;
        emit ContractCancelled(contractId, reason);
    }

    /**
     * @notice Retorna os contratos de um usuário
     */
    function getUserContracts(address user) external view returns (uint256[] memory) {
        return userContracts[user];
    }

    /**
     * @notice Retorna os dados básicos de um contrato
     */
    function getContractBasic(uint256 contractId) external view returns (
        uint256 id,
        address client,
        address contractor,
        string memory title,
        uint256 totalValue,
        ContractStatus status,
        uint256 createdAt,
        bool clientSigned,
        bool contractorSigned,
        uint256 milestoneCount
    ) {
        DigitalContract storage dc = contracts[contractId];
        return (
            dc.id,
            dc.client,
            dc.contractor,
            dc.title,
            dc.totalValue,
            dc.status,
            dc.createdAt,
            dc.clientSigned,
            dc.contractorSigned,
            dc.milestoneCount
        );
    }

    /**
     * @notice Retorna milestone de um contrato
     */
    function getMilestone(uint256 contractId, uint256 milestoneId) external view returns (Milestone memory) {
        return contracts[contractId].milestones[milestoneId];
    }

    /**
     * @notice Retorna saldo em escrow de um contrato
     */
    function getEscrowBalance(uint256 contractId) external view returns (uint256) {
        return contractEscrow[contractId];
    }

    /**
     * @notice Atualiza o agente de IA
     */
    function updateAgent(address newAgent) external onlyOwner {
        aiAgent = newAgent;
    }
}
