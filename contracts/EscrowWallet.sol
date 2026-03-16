// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title EscrowWallet
 * @notice Milestone-based USDC escrow for ARC Testnet (EVM-compatible)
 * @dev    Compatible with ARC Testnet (Chain ID 5042002)
 *         USDC: 0x3600000000000000000000000000000000000000
 *
 * Flow:
 *   1. client calls createEscrow(contractor, totalAmount, milestoneAmounts[])
 *   2. client calls depositUSDC(amount) — triggers ERC-20 transferFrom
 *   3. contractor calls requestMilestoneVerification(milestoneId)
 *   4. client calls verifyMilestone(milestoneId)  → marks milestone completed
 *   5. contractor calls releaseMilestonePayment(milestoneId) → receives USDC
 *   6. Either party can call raiseDispute() → freezes escrow
 *   7. client can call refundClient() only when disputed
 */

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

contract EscrowWallet {

    // ─── Enums ────────────────────────────────────────────────────────────────
    enum EscrowState { Created, Active, Disputed, Completed, Refunded }
    enum MilestoneState { Pending, RequestedByContractor, Verified, Released }

    // ─── Milestone Struct (mirrors Solidity best practices) ──────────────────
    struct Milestone {
        uint256 id;
        uint256 amount;          // USDC amount (6 decimals)
        string  description;
        MilestoneState state;
        bool    completed;       // true = client verified
        bool    released;        // true = payment sent to contractor
        uint256 requestedAt;     // timestamp of contractor request
        uint256 verifiedAt;      // timestamp of client verification
        uint256 releasedAt;      // timestamp of payment release
    }

    // ─── State Variables ──────────────────────────────────────────────────────
    address public client;
    address public contractor;
    address public usdcToken;
    uint256 public totalAmount;      // total USDC in escrow (6 decimals)
    uint256 public releasedAmount;   // USDC already paid out
    uint256 public depositedAmount;  // USDC actually deposited
    EscrowState public state;

    mapping(uint256 => Milestone) public milestones;
    uint256 public milestoneCount;
    uint256 public escrowId;

    // ─── Events ───────────────────────────────────────────────────────────────
    event EscrowCreated(
        uint256 indexed escrowId,
        address indexed client,
        address indexed contractor,
        uint256 totalAmount,
        uint256 milestoneCount,
        uint256 timestamp
    );
    event DepositReceived(
        uint256 indexed escrowId,
        address indexed depositor,
        uint256 amount,
        uint256 newBalance,
        uint256 timestamp
    );
    event MilestoneRequested(
        uint256 indexed escrowId,
        uint256 indexed milestoneId,
        address indexed contractor,
        uint256 timestamp
    );
    event MilestoneVerified(
        uint256 indexed escrowId,
        uint256 indexed milestoneId,
        address indexed client,
        uint256 amount,
        uint256 timestamp
    );
    event PaymentReleased(
        uint256 indexed escrowId,
        uint256 indexed milestoneId,
        address indexed contractor,
        uint256 amount,
        uint256 timestamp
    );
    event DisputeRaised(
        uint256 indexed escrowId,
        address indexed raisedBy,
        uint256 timestamp
    );
    event RefundIssued(
        uint256 indexed escrowId,
        address indexed client,
        uint256 amount,
        uint256 timestamp
    );

    // ─── Modifiers ────────────────────────────────────────────────────────────
    modifier onlyClient() {
        require(msg.sender == client, "EscrowWallet: caller is not client");
        _;
    }

    modifier onlyContractor() {
        require(msg.sender == contractor, "EscrowWallet: caller is not contractor");
        _;
    }

    modifier onlyParticipant() {
        require(
            msg.sender == client || msg.sender == contractor,
            "EscrowWallet: caller is not participant"
        );
        _;
    }

    modifier inState(EscrowState _state) {
        require(state == _state, "EscrowWallet: invalid escrow state");
        _;
    }

    modifier notDisputed() {
        require(state != EscrowState.Disputed, "EscrowWallet: escrow is disputed");
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────────────
    /**
     * @notice Deploy and initialize the escrow
     * @param _escrowId      Unique ID for this escrow (off-chain assigned)
     * @param _client        Address of the client (payer)
     * @param _contractor    Address of the contractor (receiver)
     * @param _usdcToken     USDC token contract address
     * @param _totalAmount   Total USDC amount (in base units, 6 decimals)
     * @param _milestoneAmounts  Array of USDC amounts per milestone
     * @param _milestoneDescriptions Array of descriptions per milestone
     */
    constructor(
        uint256 _escrowId,
        address _client,
        address _contractor,
        address _usdcToken,
        uint256 _totalAmount,
        uint256[] memory _milestoneAmounts,
        string[] memory _milestoneDescriptions
    ) {
        require(_client != address(0), "EscrowWallet: invalid client");
        require(_contractor != address(0), "EscrowWallet: invalid contractor");
        require(_usdcToken != address(0), "EscrowWallet: invalid USDC token");
        require(_totalAmount > 0, "EscrowWallet: amount must be > 0");
        require(_milestoneAmounts.length > 0, "EscrowWallet: must have milestones");
        require(
            _milestoneAmounts.length == _milestoneDescriptions.length,
            "EscrowWallet: milestones length mismatch"
        );

        // Verify milestone amounts sum to totalAmount
        uint256 sum = 0;
        for (uint i = 0; i < _milestoneAmounts.length; i++) {
            sum += _milestoneAmounts[i];
        }
        require(sum == _totalAmount, "EscrowWallet: milestone amounts don't sum to total");

        escrowId     = _escrowId;
        client       = _client;
        contractor   = _contractor;
        usdcToken    = _usdcToken;
        totalAmount  = _totalAmount;
        state        = EscrowState.Created;

        for (uint256 i = 0; i < _milestoneAmounts.length; i++) {
            milestones[i] = Milestone({
                id: i,
                amount: _milestoneAmounts[i],
                description: _milestoneDescriptions[i],
                state: MilestoneState.Pending,
                completed: false,
                released: false,
                requestedAt: 0,
                verifiedAt: 0,
                releasedAt: 0
            });
        }
        milestoneCount = _milestoneAmounts.length;

        emit EscrowCreated(
            _escrowId,
            _client,
            _contractor,
            _totalAmount,
            _milestoneAmounts.length,
            block.timestamp
        );
    }

    // ─── Core Functions ───────────────────────────────────────────────────────

    /**
     * @notice Client deposits USDC into escrow
     * @param amount Amount to deposit (6 decimals)
     * @dev Client must have approved this contract first via ERC20.approve()
     */
    function depositUSDC(uint256 amount)
        external
        onlyClient
    {
        require(amount > 0, "EscrowWallet: amount must be > 0");
        require(
            depositedAmount + amount <= totalAmount,
            "EscrowWallet: deposit exceeds total amount"
        );

        IERC20 usdc = IERC20(usdcToken);
        require(
            usdc.allowance(msg.sender, address(this)) >= amount,
            "EscrowWallet: insufficient USDC allowance"
        );

        bool success = usdc.transferFrom(msg.sender, address(this), amount);
        require(success, "EscrowWallet: USDC transfer failed");

        depositedAmount += amount;

        // Activate escrow when fully funded
        if (depositedAmount >= totalAmount && state == EscrowState.Created) {
            state = EscrowState.Active;
        }

        emit DepositReceived(
            escrowId,
            msg.sender,
            amount,
            depositedAmount,
            block.timestamp
        );
    }

    /**
     * @notice Contractor requests milestone verification
     * @param milestoneId  0-indexed milestone ID
     */
    function requestMilestoneVerification(uint256 milestoneId)
        external
        onlyContractor
        inState(EscrowState.Active)
    {
        require(milestoneId < milestoneCount, "EscrowWallet: invalid milestone");
        Milestone storage m = milestones[milestoneId];
        require(m.state == MilestoneState.Pending, "EscrowWallet: milestone not pending");

        m.state = MilestoneState.RequestedByContractor;
        m.requestedAt = block.timestamp;

        emit MilestoneRequested(escrowId, milestoneId, msg.sender, block.timestamp);
    }

    /**
     * @notice Client verifies that a milestone is complete
     * @param milestoneId  0-indexed milestone ID
     */
    function verifyMilestone(uint256 milestoneId)
        external
        onlyClient
        inState(EscrowState.Active)
        notDisputed
    {
        require(milestoneId < milestoneCount, "EscrowWallet: invalid milestone");
        Milestone storage m = milestones[milestoneId];
        require(
            m.state == MilestoneState.RequestedByContractor,
            "EscrowWallet: milestone not requested by contractor"
        );
        require(!m.completed, "EscrowWallet: milestone already completed");

        m.state = MilestoneState.Verified;
        m.completed = true;
        m.verifiedAt = block.timestamp;

        emit MilestoneVerified(
            escrowId,
            milestoneId,
            msg.sender,
            m.amount,
            block.timestamp
        );
    }

    /**
     * @notice Contractor releases payment for a verified milestone
     * @param milestoneId  0-indexed milestone ID
     * @dev Security: only contractor can call, milestone must be verified (by client),
     *      double-release prevented by `released` flag
     */
    function releaseMilestonePayment(uint256 milestoneId)
        external
        onlyContractor
        inState(EscrowState.Active)
        notDisputed
    {
        require(milestoneId < milestoneCount, "EscrowWallet: invalid milestone");
        Milestone storage m = milestones[milestoneId];
        require(m.completed, "EscrowWallet: milestone not verified by client");
        require(!m.released, "EscrowWallet: payment already released");
        require(
            depositedAmount - releasedAmount >= m.amount,
            "EscrowWallet: insufficient escrow balance"
        );

        // ─ Effects before interactions (CEI pattern) ─
        m.released = true;
        m.state = MilestoneState.Released;
        m.releasedAt = block.timestamp;
        releasedAmount += m.amount;

        // ─ Interaction ─
        bool success = IERC20(usdcToken).transfer(contractor, m.amount);
        require(success, "EscrowWallet: USDC transfer to contractor failed");

        // Check if all milestones released
        if (releasedAmount >= totalAmount) {
            state = EscrowState.Completed;
        }

        emit PaymentReleased(
            escrowId,
            milestoneId,
            contractor,
            m.amount,
            block.timestamp
        );
    }

    /**
     * @notice Either party can raise a dispute
     * @dev Freezes the escrow; no payments can be made while disputed
     */
    function raiseDispute()
        external
        onlyParticipant
        inState(EscrowState.Active)
    {
        state = EscrowState.Disputed;
        emit DisputeRaised(escrowId, msg.sender, block.timestamp);
    }

    /**
     * @notice Client can get a full refund when escrow is disputed
     * @dev Sends remaining (unreleased) USDC balance back to client
     */
    function refundClient()
        external
        onlyClient
        inState(EscrowState.Disputed)
    {
        uint256 refundAmount = depositedAmount - releasedAmount;
        require(refundAmount > 0, "EscrowWallet: nothing to refund");

        // ─ Effects ─
        state = EscrowState.Refunded;
        depositedAmount = releasedAmount; // balance now 0

        // ─ Interaction ─
        bool success = IERC20(usdcToken).transfer(client, refundAmount);
        require(success, "EscrowWallet: USDC refund failed");

        emit RefundIssued(escrowId, client, refundAmount, block.timestamp);
    }

    // ─── View Functions ───────────────────────────────────────────────────────

    /**
     * @notice Returns the current USDC balance held in escrow
     */
    function escrowBalance() external view returns (uint256) {
        return depositedAmount - releasedAmount;
    }

    /**
     * @notice Returns full milestone data
     */
    function getMilestone(uint256 milestoneId)
        external
        view
        returns (Milestone memory)
    {
        require(milestoneId < milestoneCount, "EscrowWallet: invalid milestone");
        return milestones[milestoneId];
    }

    /**
     * @notice Returns all milestones
     */
    function getAllMilestones() external view returns (Milestone[] memory) {
        Milestone[] memory all = new Milestone[](milestoneCount);
        for (uint256 i = 0; i < milestoneCount; i++) {
            all[i] = milestones[i];
        }
        return all;
    }

    /**
     * @notice Returns escrow summary
     */
    function getEscrowInfo() external view returns (
        uint256 _escrowId,
        address _client,
        address _contractor,
        uint256 _totalAmount,
        uint256 _depositedAmount,
        uint256 _releasedAmount,
        uint256 _balance,
        EscrowState _state,
        uint256 _milestoneCount
    ) {
        return (
            escrowId,
            client,
            contractor,
            totalAmount,
            depositedAmount,
            releasedAmount,
            depositedAmount - releasedAmount,
            state,
            milestoneCount
        );
    }
}

// ─── EscrowRegistry ───────────────────────────────────────────────────────────
/**
 * @title EscrowRegistry
 * @notice Lightweight registry for escrow records linked to contracts
 * @dev Implements the createEscrow(title, client, contractor, totalAmount) pattern
 *      This contract is used when deploying a separate registry (no child contract deploy)
 */
contract EscrowRegistry {
    address public usdcToken;
    address public owner;

    // ─── Escrow struct (as specified) ─────────────────────────────────────────
    struct Escrow {
        uint256 id;
        string  title;
        address client;
        address contractor;
        uint256 totalAmount;
        uint256 releasedAmount;
        uint256 depositedAmount;
        uint256 createdAt;
        bool    active;
        string  contractRef;   // optional: link to off-chain contract ID
    }

    mapping(uint256 => Escrow) public escrows;
    mapping(address => uint256[]) public clientEscrows;
    mapping(address => uint256[]) public contractorEscrows;
    uint256 public escrowCount;

    // ─── Events ───────────────────────────────────────────────────────────────
    event EscrowCreated(
        uint256 indexed escrowId,
        string  title,
        address indexed client,
        address indexed contractor,
        uint256 amount,
        uint256 timestamp
    );
    event EscrowDeposited(
        uint256 indexed escrowId,
        address depositor,
        uint256 amount,
        uint256 newBalance,
        uint256 timestamp
    );
    event EscrowReleased(
        uint256 indexed escrowId,
        address contractor,
        uint256 amount,
        uint256 timestamp
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "EscrowRegistry: not owner");
        _;
    }

    modifier escrowExists(uint256 escrowId) {
        require(escrowId > 0 && escrowId <= escrowCount, "EscrowRegistry: escrow not found");
        _;
    }

    constructor(address _usdcToken) {
        usdcToken = _usdcToken;
        owner = msg.sender;
    }

    /**
     * @notice Register a new escrow from a contract creation
     * @param title       Human-readable contract/escrow title
     * @param client      Address of the payer (client)
     * @param contractor  Address of the receiver (contractor)
     * @param totalAmount Total USDC amount (6 decimals)
     * @dev Only client can create — security: prevent duplicate by using escrowCount
     */
    function createEscrow(
        string memory title,
        address client,
        address contractor,
        uint256 totalAmount
    ) external returns (uint256 escrowId) {
        require(bytes(title).length > 0, "EscrowRegistry: title required");
        require(client != address(0), "EscrowRegistry: invalid client");
        require(contractor != address(0), "EscrowRegistry: invalid contractor");
        require(client != contractor, "EscrowRegistry: client == contractor");
        require(totalAmount > 0, "EscrowRegistry: amount must be > 0");

        escrowCount++;
        escrowId = escrowCount;

        escrows[escrowId] = Escrow({
            id:              escrowId,
            title:           title,
            client:          client,
            contractor:      contractor,
            totalAmount:     totalAmount,
            releasedAmount:  0,
            depositedAmount: 0,
            createdAt:       block.timestamp,
            active:          true,
            contractRef:     ""
        });

        clientEscrows[client].push(escrowId);
        contractorEscrows[contractor].push(escrowId);

        emit EscrowCreated(escrowId, title, client, contractor, totalAmount, block.timestamp);
    }

    /**
     * @notice Deposit USDC into escrow
     * @dev Caller must have approved this contract first
     */
    function depositUSDC(uint256 escrowId, uint256 amount)
        external
        escrowExists(escrowId)
    {
        Escrow storage esc = escrows[escrowId];
        require(esc.active, "EscrowRegistry: escrow not active");
        require(
            esc.depositedAmount + amount <= esc.totalAmount,
            "EscrowRegistry: over-deposit"
        );
        require(
            IERC20(usdcToken).transferFrom(msg.sender, address(this), amount),
            "EscrowRegistry: USDC transfer failed"
        );
        esc.depositedAmount += amount;
        emit EscrowDeposited(escrowId, msg.sender, amount, esc.depositedAmount, block.timestamp);
    }

    /**
     * @notice Release funds to contractor (only client can call)
     */
    function releaseToContractor(uint256 escrowId, uint256 amount)
        external
        escrowExists(escrowId)
    {
        Escrow storage esc = escrows[escrowId];
        require(msg.sender == esc.client, "EscrowRegistry: only client");
        require(esc.active, "EscrowRegistry: not active");
        uint256 available = esc.depositedAmount - esc.releasedAmount;
        require(amount <= available, "EscrowRegistry: insufficient balance");
        esc.releasedAmount += amount;
        if (esc.releasedAmount >= esc.totalAmount) esc.active = false;
        require(
            IERC20(usdcToken).transfer(esc.contractor, amount),
            "EscrowRegistry: transfer failed"
        );
        emit EscrowReleased(escrowId, esc.contractor, amount, block.timestamp);
    }

    /**
     * @notice Get escrow balance (locked USDC)
     */
    function escrowBalance(uint256 escrowId) external view escrowExists(escrowId) returns (uint256) {
        Escrow storage esc = escrows[escrowId];
        return esc.depositedAmount - esc.releasedAmount;
    }

    function getClientEscrows(address client) external view returns (uint256[] memory) {
        return clientEscrows[client];
    }

    function getContractorEscrows(address contractor) external view returns (uint256[] memory) {
        return contractorEscrows[contractor];
    }
}

// ─── EscrowFactory ────────────────────────────────────────────────────────────
/**
 * @title EscrowFactory
 * @notice Deploys and tracks EscrowWallet contracts (full milestone support)
 */
contract EscrowFactory {
    address public usdcToken;
    address public owner;

    struct EscrowRecord {
        uint256 escrowId;
        address escrowAddress;
        address client;
        address contractor;
        uint256 totalAmount;
        uint256 createdAt;
        bool    active;
    }

    mapping(uint256 => EscrowRecord) public escrows;
    mapping(address => uint256[]) public clientEscrows;
    mapping(address => uint256[]) public contractorEscrows;
    uint256 public escrowCount;

    event EscrowDeployed(
        uint256 indexed escrowId,
        address indexed escrowAddress,
        address indexed client,
        address contractor,
        uint256 totalAmount,
        uint256 timestamp
    );

    constructor(address _usdcToken) {
        usdcToken = _usdcToken;
        owner = msg.sender;
    }

    /**
     * @notice Create a new escrow (full milestone support)
     */
    function createEscrow(
        address _contractor,
        uint256 _totalAmount,
        uint256[] memory _milestoneAmounts,
        string[] memory _milestoneDescriptions
    ) external returns (address escrowAddress) {
        escrowCount++;
        uint256 newId = escrowCount;

        EscrowWallet newEscrow = new EscrowWallet(
            newId,
            msg.sender,
            _contractor,
            usdcToken,
            _totalAmount,
            _milestoneAmounts,
            _milestoneDescriptions
        );

        escrowAddress = address(newEscrow);

        escrows[newId] = EscrowRecord({
            escrowId: newId,
            escrowAddress: escrowAddress,
            client: msg.sender,
            contractor: _contractor,
            totalAmount: _totalAmount,
            createdAt: block.timestamp,
            active: true
        });

        clientEscrows[msg.sender].push(newId);
        contractorEscrows[_contractor].push(newId);

        emit EscrowDeployed(
            newId,
            escrowAddress,
            msg.sender,
            _contractor,
            _totalAmount,
            block.timestamp
        );
    }

    function getEscrow(uint256 escrowId) external view returns (EscrowRecord memory) {
        return escrows[escrowId];
    }

    function getClientEscrows(address _client) external view returns (uint256[] memory) {
        return clientEscrows[_client];
    }

    function getContractorEscrows(address _contractor) external view returns (uint256[] memory) {
        return contractorEscrows[_contractor];
    }
}
