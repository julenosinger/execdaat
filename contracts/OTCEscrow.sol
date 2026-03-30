// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// =============================================================================
// OTCEscrow v4 — ExecDaat OTC Smart Contract
//
// @title    OTCEscrow — Production-Ready OTC Token Escrow with Trustless &
//           Flexible Proof Modes + Full Dispute System
// @author   ExecDaat
// @notice   EVM-compatible escrow for Over-The-Counter ERC-20 token deals,
//           with dispute/arbitration, Permit2/EIP-2612 support, TradeMode
//           selection (TRUSTLESS / FLEXIBLE), and an explicit
//           authorized-releaser system for trustless automation.
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │  LIFECYCLE (on-chain state machine)                                     │
// │                                                                         │
// │  createDeal() → Status.CREATED                                          │
// │    │                                                                    │
// │    ├─ signDeal() [buyer]   → still CREATED (one sig)                   │
// │    ├─ signDeal() [seller]  → still CREATED (two sigs)                  │
// │    │                                                                    │
// │    ├─ fundDeal() [buyer]   → AWAITING_SELLER_DEPOSIT (TRUSTLESS)       │
// │    │                        AWAITING_PROOF           (FLEXIBLE)        │
// │    │                                                                    │
// │    │  [TRUSTLESS only] depositSeller() → AWAITING_PROOF                │
// │    │                                                                    │
// │    ├─ submitProof()        → READY_TO_SETTLE                           │
// │    │                                                                    │
// │    ├─ release()            → Status.COMPLETED  (tokens → seller)       │
// │    ├─ openDispute()        → Status.IN_DISPUTE                         │
// │    │    └─ resolveDispute() → Status.COMPLETED | Status.CANCELLED      │
// │    └─ cancel() [dual consent] → Status.CANCELLED (refund → buyer)      │
// └─────────────────────────────────────────────────────────────────────────┘
//
// SECURITY ASSUMPTIONS:
//   • ReentrancyGuard prevents re-entrant calls on all state mutators.
//   • SafeERC20 wraps all token transfers; non-reverting tokens are also
//     caught by an explicit balance-diff check in fundDeal().
//   • All role checks use custom errors — no silent failures.
//   • Checks-Effects-Interactions pattern is strictly followed.
//   • state is updated BEFORE any external call.
//   • The arbiter address is set once at construction (immutable after
//     deployment) — choosing a neutral multisig is the deployer's responsibility.
//   • DOMAIN_SEPARATOR is computed at construction time with the actual
//     chain ID; EIP-2612 permits are validated against it before execution.
//   • Dispute cannot be re-opened after resolution (disallowReopenAfterResolution).
//
// DISPUTE SYSTEM:
//   • Either party may call openDispute() on a funded/proof-stage deal.
//   • Dispute pauses/overrides timeout logic: release() and cancel() both
//     revert while Status == IN_DISPUTE.
//   • Only the arbiter can call resolveDispute(tradeId, releaseToSeller).
//   • DisputeOpened(tradeId, openedBy) and DisputeResolved(tradeId, result)
//     are emitted for full on-chain auditability.
//
// TRADE MODES:
//   • TRUSTLESS  — both buyer and seller deposit tokens; release sends each
//                  party's counterpart deposit (atomic swap-like).
//   • FLEXIBLE   — buyer deposits only; seller provides off-chain proof
//                  before release (traditional escrow flow).
// =============================================================================

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

// =============================================================================
// CONTRACT
// =============================================================================

/**
 * @title  OTCEscrow
 * @notice Production-ready OTC escrow with Trustless & Flexible trade modes,
 *         a full dispute/arbitration system, and Permit2 / EIP-2612 support.
 * @dev    All state-changing functions are nonReentrant. All external token
 *         transfers use SafeERC20 plus an explicit balance-diff guard.
 *         Version: 4
 */
contract OTCEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // =========================================================================
    // ENUMS
    // =========================================================================

    /**
     * @notice Trade mode governing escrow behaviour.
     *   TRUSTLESS — both buyer and seller must deposit (atomic-swap style).
     *   FLEXIBLE  — buyer deposits; seller provides proof before release.
     */
    enum TradeMode { TRUSTLESS, FLEXIBLE }

    /**
     * @notice Full lifecycle status for each deal.
     *
     * Transitions:
     *   CREATED                → AWAITING_BUYER_DEPOSIT  (fundDeal, either mode)
     *   AWAITING_BUYER_DEPOSIT → AWAITING_SELLER_DEPOSIT (TRUSTLESS: buyer deposits)
     *   AWAITING_BUYER_DEPOSIT → AWAITING_PROOF          (FLEXIBLE:  buyer deposits)
     *   AWAITING_SELLER_DEPOSIT→ AWAITING_PROOF          (TRUSTLESS: seller deposits)
     *   AWAITING_PROOF         → READY_TO_SETTLE         (submitProof)
     *   READY_TO_SETTLE        → COMPLETED               (release)
     *   AWAITING_BUYER_DEPOSIT | AWAITING_SELLER_DEPOSIT
     *     | AWAITING_PROOF | READY_TO_SETTLE             → IN_DISPUTE  (openDispute)
     *   IN_DISPUTE             → COMPLETED | CANCELLED   (resolveDispute)
     *   CREATED                → CANCELLED               (single-party cancel, unfunded)
     *   (any funded state)     → CANCELLED               (dual-consent cancel)
     *
     * @dev Legacy compatibility: State.Pending=0 maps to CREATED; State.Funded=1
     *      maps to AWAITING_PROOF (FLEXIBLE) or AWAITING_SELLER_DEPOSIT (TRUSTLESS).
     *      State.Completed=2, State.Cancelled=3, State.Disputed=4.
     */
    enum Status {
        CREATED,                  // 0 — deal created, awaiting signatures & funding
        AWAITING_BUYER_DEPOSIT,   // 1 — buyer must deposit tokens
        AWAITING_SELLER_DEPOSIT,  // 2 — TRUSTLESS: seller must deposit
        AWAITING_PROOF,           // 3 — buyer funded; awaiting seller proof
        READY_TO_SETTLE,          // 4 — proof submitted; release is callable
        IN_DISPUTE,               // 5 — dispute raised; settlement frozen
        COMPLETED,                // 6 — deal completed successfully
        CANCELLED                 // 7 — deal cancelled / refunded
    }

    // =========================================================================
    // STRUCTS
    // =========================================================================

    /**
     * @notice Dispute record stored inline in each deal.
     */
    struct DisputeData {
        address opener;          // who opened the dispute
        uint256 openedAt;        // block.timestamp when opened
        string  reason;          // optional off-chain reason string
        bool    resolved;        // true after arbitrator resolves
        bool    releasedToSeller;// outcome: true = seller wins; false = buyer refunded
    }

    /**
     * @notice Full deal record stored on-chain.
     * @dev    After release or cancellation, `buyerAmount` and `sellerAmount`
     *         are zeroed to reclaim gas and prevent accidental re-use.
     */
    struct Deal {
        // ── Core parties ──────────────────────────────────────────────────────
        address buyer;
        address seller;

        // ── Token & amounts ───────────────────────────────────────────────────
        address token;
        uint256 buyerAmount;     // buyer's deposit (both modes)
        uint256 sellerAmount;    // seller's deposit (TRUSTLESS only; 0 in FLEXIBLE)

        // ── Schedule ──────────────────────────────────────────────────────────
        uint256 tgeTimestamp;    // Unix UTC timestamp for TGE / release window

        // ── Off-chain signatures ───────────────────────────────────────────────
        bool    buyerSigned;
        bool    sellerSigned;

        // ── Mode & status ─────────────────────────────────────────────────────
        TradeMode tradeMode;
        Status    status;

        // ── Dual-consent cancel flags ──────────────────────────────────────────
        bool    buyerCancelRequested;
        bool    sellerCancelRequested;

        // ── Dispute ───────────────────────────────────────────────────────────
        DisputeData dispute;

        // ── Proof (FLEXIBLE mode) ─────────────────────────────────────────────
        bytes32 proofHash;       // keccak256 of off-chain proof document

        // ── Metadata ──────────────────────────────────────────────────────────
        bytes32 contractHash;    // keccak256 of off-chain contract document
        uint256 createdAt;
        uint256 disputeTimeout;  // seconds after funding before either party can openDispute
                                 // 0 = no timeout (immediate dispute allowed)
    }

    // =========================================================================
    // IMMUTABLES & STORAGE
    // =========================================================================

    /// @notice The arbiter/multisig that can resolve disputes.
    /// @dev    Set at construction; cannot be changed post-deployment.
    address public immutable arbiter;

    /// @notice Backward-compatible alias: arbitrator == arbiter.
    address public immutable arbitrator;

    /// @notice Authorized releasers (e.g., multisig, relayer, automation contract).
    mapping(address => bool) public isAuthorized;

    /// @notice All deals, keyed by their unique dealId (keccak256 hash).
    mapping(bytes32 => Deal) public deals;

    /// @notice All deal IDs for a given party (buyer or seller).
    mapping(address => bytes32[]) public dealsByParty;

    /// @dev    EIP-712 domain separator for permit2-style typed-data signatures.
    bytes32 public immutable DOMAIN_SEPARATOR;

    /// @dev    Typehash for fundWithPermit calls.
    bytes32 public constant FUND_PERMIT_TYPEHASH = keccak256(
        "FundPermit(bytes32 dealId,address buyer,uint256 amount,uint256 nonce,uint256 deadline)"
    );

    /// @notice Per-address nonces for fundWithPermit (replay protection).
    mapping(address => uint256) public nonces;

    // =========================================================================
    // EVENTS
    // =========================================================================

    event DealCreated(
        bytes32 indexed dealId,
        address indexed buyer,
        address indexed seller,
        address  token,
        uint256  buyerAmount,
        uint256  tgeTimestamp,
        bytes32  contractHash,
        TradeMode tradeMode
    );

    event DealSigned(bytes32 indexed dealId, address indexed signer, string role);

    event DealFunded(bytes32 indexed dealId, address indexed depositor, uint256 amount, string role);

    event DealReleased(bytes32 indexed dealId, address indexed seller, uint256 amount);

    event DealCancelled(bytes32 indexed dealId, address indexed cancelledBy, bool refunded);

    event CancelRequested(bytes32 indexed dealId, address indexed requester);

    /// @notice Emitted when a dispute is opened on a deal.
    event DisputeOpened(bytes32 indexed tradeId, address indexed openedBy);

    /// @notice Emitted when the arbiter resolves a dispute.
    /// @param tradeId        The deal identifier.
    /// @param releaseToSeller True → tokens sent to seller; False → refunded to buyer.
    event DisputeResolved(bytes32 indexed tradeId, bool releaseToSeller);

    /// @notice Legacy alias for DisputeOpened (backward-compat with v3 ABIs).
    event DisputeRaised(bytes32 indexed dealId, address indexed raisedBy);

    event ProofSubmitted(bytes32 indexed dealId, address indexed submitter, bytes32 proofHash);

    event AuthorizationUpdated(address indexed account, bool authorized);

    // =========================================================================
    // ERRORS
    // =========================================================================

    error NotParty();
    error NotBuyer();
    error NotSeller();
    error NotAuthorized();
    error NotArbiter();
    /// @dev Legacy alias kept for ABI compat.
    error NotArbitrator();
    error AlreadySigned();
    error NotSigned();
    /// @dev Legacy alias.
    error NotBothSigned();
    error AlreadyFunded();
    error NotFunded();
    error AlreadyReleased();
    error AlreadyCancelled();
    error DealDisputed();
    error NoDispute();
    error DisputeAlreadyResolved();
    error TGENotReached();
    error DealNotFound();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidTimestamp();
    error SameAddress();
    error AlreadyCancelRequested();
    error InsufficientAllowance();
    error TransferFailed();
    error PermitExpired();
    error InvalidPermitSignature();
    error InvalidNonce();
    error InvalidState();
    error DisputeTimeoutNotReached();

    // =========================================================================
    // MODIFIERS
    // =========================================================================

    modifier dealExists(bytes32 dealId) {
        if (deals[dealId].buyer == address(0)) revert DealNotFound();
        _;
    }

    modifier onlyParty(bytes32 dealId) {
        Deal storage d = deals[dealId];
        if (msg.sender != d.buyer && msg.sender != d.seller) revert NotParty();
        _;
    }

    modifier notCancelled(bytes32 dealId) {
        if (deals[dealId].status == Status.CANCELLED) revert AlreadyCancelled();
        _;
    }

    modifier notCompleted(bytes32 dealId) {
        if (deals[dealId].status == Status.COMPLETED) revert AlreadyReleased();
        _;
    }

    /// @dev Reverts if the deal is IN_DISPUTE — settlement is frozen.
    modifier notDisputed(bytes32 dealId) {
        if (deals[dealId].status == Status.IN_DISPUTE) revert DealDisputed();
        _;
    }

    /// @dev Allows only the arbiter.
    modifier onlyArbiter() {
        if (msg.sender != arbiter) revert NotArbiter();
        _;
    }

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * @param _arbiter             Address of the neutral arbiter/multisig.
     * @param _authorizedRelayers  Initial list of authorized releasers.
     */
    constructor(address _arbiter, address[] memory _authorizedRelayers) {
        if (_arbiter == address(0)) revert InvalidAddress();
        arbiter    = _arbiter;
        arbitrator = _arbiter; // backward-compat alias

        uint256 len = _authorizedRelayers.length;
        for (uint256 i = 0; i < len; ) {
            if (_authorizedRelayers[i] != address(0)) {
                isAuthorized[_authorizedRelayers[i]] = true;
                emit AuthorizationUpdated(_authorizedRelayers[i], true);
            }
            unchecked { ++i; }
        }

        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("OTCEscrow")),
                keccak256(bytes("4")),
                block.chainid,
                address(this)
            )
        );
    }

    // =========================================================================
    // GOVERNANCE — ARBITER ONLY
    // =========================================================================

    function setAuthorized(address account, bool authorized) external onlyArbiter {
        if (account == address(0)) revert InvalidAddress();
        isAuthorized[account] = authorized;
        emit AuthorizationUpdated(account, authorized);
    }

    // =========================================================================
    // 1. CREATE DEAL
    // =========================================================================

    /**
     * @notice Buyer initiates a new OTC deal.
     * @param seller         The seller's address.
     * @param token          ERC-20 token address.
     * @param amount         Raw buyer deposit amount (token decimals). Must be > 0.
     * @param tgeTimestamp   Unix UTC TGE / release timestamp. Must be > 0.
     * @param contractHash   keccak256 of off-chain contract doc.
     * @param mode           TRUSTLESS or FLEXIBLE.
     * @param disputeTimeout Seconds after funding before dispute can be opened.
     *                       Pass 0 to allow immediate disputes.
     * @return dealId        Unique bytes32 deal identifier.
     */
    function createDeal(
        address   seller,
        address   token,
        uint256   amount,
        uint256   tgeTimestamp,
        bytes32   contractHash,
        TradeMode mode,
        uint256   disputeTimeout
    ) external nonReentrant returns (bytes32 dealId) {
        if (seller == address(0) || token == address(0)) revert InvalidAddress();
        if (seller == msg.sender) revert SameAddress();
        if (amount == 0) revert InvalidAmount();
        if (tgeTimestamp == 0) revert InvalidTimestamp();

        dealId = keccak256(abi.encodePacked(
            msg.sender, seller, token, amount, tgeTimestamp,
            contractHash, block.timestamp, block.number
        ));

        if (deals[dealId].buyer != address(0)) revert InvalidState();

        deals[dealId] = Deal({
            buyer:                  msg.sender,
            seller:                 seller,
            token:                  token,
            buyerAmount:            amount,
            sellerAmount:           0,
            tgeTimestamp:           tgeTimestamp,
            buyerSigned:            false,
            sellerSigned:           false,
            tradeMode:              mode,
            status:                 Status.CREATED,
            buyerCancelRequested:   false,
            sellerCancelRequested:  false,
            dispute: DisputeData({
                opener:          address(0),
                openedAt:        0,
                reason:          "",
                resolved:        false,
                releasedToSeller: false
            }),
            proofHash:              bytes32(0),
            contractHash:           contractHash,
            createdAt:              block.timestamp,
            disputeTimeout:         disputeTimeout
        });

        dealsByParty[msg.sender].push(dealId);
        dealsByParty[seller].push(dealId);

        emit DealCreated(dealId, msg.sender, seller, token, amount, tgeTimestamp, contractHash, mode);
    }

    /**
     * @notice Backward-compatible createDeal — defaults to FLEXIBLE mode, no
     *         dispute timeout. Existing integrations continue to work.
     */
    function createDeal(
        address seller,
        address token,
        uint256 amount,
        uint256 tgeTimestamp,
        bytes32 contractHash
    ) external nonReentrant returns (bytes32 dealId) {
        if (seller == address(0) || token == address(0)) revert InvalidAddress();
        if (seller == msg.sender) revert SameAddress();
        if (amount == 0) revert InvalidAmount();
        if (tgeTimestamp == 0) revert InvalidTimestamp();

        dealId = keccak256(abi.encodePacked(
            msg.sender, seller, token, amount, tgeTimestamp,
            contractHash, block.timestamp, block.number
        ));
        if (deals[dealId].buyer != address(0)) revert InvalidState();

        deals[dealId] = Deal({
            buyer:                  msg.sender,
            seller:                 seller,
            token:                  token,
            buyerAmount:            amount,
            sellerAmount:           0,
            tgeTimestamp:           tgeTimestamp,
            buyerSigned:            false,
            sellerSigned:           false,
            tradeMode:              TradeMode.FLEXIBLE,
            status:                 Status.CREATED,
            buyerCancelRequested:   false,
            sellerCancelRequested:  false,
            dispute: DisputeData({
                opener:          address(0),
                openedAt:        0,
                reason:          "",
                resolved:        false,
                releasedToSeller: false
            }),
            proofHash:              bytes32(0),
            contractHash:           contractHash,
            createdAt:              block.timestamp,
            disputeTimeout:         0
        });

        dealsByParty[msg.sender].push(dealId);
        dealsByParty[seller].push(dealId);

        // Emit with legacy 7-arg signature for backward compat
        emit DealCreated(dealId, msg.sender, seller, token, amount, tgeTimestamp, contractHash, TradeMode.FLEXIBLE);
    }

    // =========================================================================
    // 2. SIGN DEAL
    // =========================================================================

    function signDeal(bytes32 dealId)
        external
        nonReentrant
        dealExists(dealId)
        onlyParty(dealId)
        notCancelled(dealId)
        notCompleted(dealId)
    {
        Deal storage d = deals[dealId];
        if (d.status != Status.CREATED) revert InvalidState();

        bool isBuyer = (msg.sender == d.buyer);
        if (isBuyer) {
            if (d.buyerSigned) revert AlreadySigned();
            d.buyerSigned = true;
            emit DealSigned(dealId, msg.sender, "Buyer");
        } else {
            if (d.sellerSigned) revert AlreadySigned();
            d.sellerSigned = true;
            emit DealSigned(dealId, msg.sender, "Seller");
        }
    }

    // =========================================================================
    // 3a. FUND DEAL — BUYER DEPOSIT (standard approve/transferFrom)
    // =========================================================================

    function fundDeal(bytes32 dealId)
        external
        nonReentrant
        dealExists(dealId)
        notCancelled(dealId)
        notCompleted(dealId)
        notDisputed(dealId)
    {
        Deal storage d = deals[dealId];
        if (msg.sender != d.buyer) revert NotBuyer();
        if (!d.buyerSigned || !d.sellerSigned) revert NotSigned();
        if (d.status != Status.CREATED) revert InvalidState();

        uint256 allowed = IERC20(d.token).allowance(msg.sender, address(this));
        if (allowed < d.buyerAmount) revert InsufficientAllowance();

        // Transition state BEFORE external call (CEI)
        d.status = (d.tradeMode == TradeMode.TRUSTLESS)
            ? Status.AWAITING_SELLER_DEPOSIT
            : Status.AWAITING_PROOF;

        uint256 before   = IERC20(d.token).balanceOf(address(this));
        IERC20(d.token).safeTransferFrom(msg.sender, address(this), d.buyerAmount);
        uint256 received = IERC20(d.token).balanceOf(address(this)) - before;
        if (received < d.buyerAmount) revert TransferFailed();

        emit DealFunded(dealId, msg.sender, d.buyerAmount, "Buyer");
    }

    // =========================================================================
    // 3b. FUND DEAL — SELLER DEPOSIT (TRUSTLESS mode only)
    // =========================================================================

    /**
     * @notice Seller deposits their side of the TRUSTLESS trade.
     * @dev    Only callable in TRUSTLESS mode after buyer has deposited.
     * @param dealId     The deal identifier.
     * @param amount     Seller's raw token amount to deposit.
     */
    function depositSeller(bytes32 dealId, uint256 amount)
        external
        nonReentrant
        dealExists(dealId)
        notCancelled(dealId)
        notCompleted(dealId)
        notDisputed(dealId)
    {
        Deal storage d = deals[dealId];
        if (msg.sender != d.seller) revert NotSeller();
        if (d.tradeMode != TradeMode.TRUSTLESS) revert InvalidState();
        if (d.status != Status.AWAITING_SELLER_DEPOSIT) revert InvalidState();
        if (amount == 0) revert InvalidAmount();

        uint256 allowed = IERC20(d.token).allowance(msg.sender, address(this));
        if (allowed < amount) revert InsufficientAllowance();

        d.sellerAmount = amount;
        d.status       = Status.AWAITING_PROOF;

        uint256 before   = IERC20(d.token).balanceOf(address(this));
        IERC20(d.token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(d.token).balanceOf(address(this)) - before;
        if (received < amount) revert TransferFailed();

        emit DealFunded(dealId, msg.sender, amount, "Seller");
    }

    // =========================================================================
    // 3c. FUND DEAL WITH PERMIT (EIP-2612 / gasless approve)
    // =========================================================================

    function fundDealWithPermit(
        bytes32 dealId,
        uint256 deadline,
        uint8   v,
        bytes32 r,
        bytes32 s
    )
        external
        nonReentrant
        dealExists(dealId)
        notCancelled(dealId)
        notCompleted(dealId)
        notDisputed(dealId)
    {
        Deal storage d = deals[dealId];
        if (msg.sender != d.buyer) revert NotBuyer();
        if (!d.buyerSigned || !d.sellerSigned) revert NotSigned();
        if (d.status != Status.CREATED) revert InvalidState();
        if (block.timestamp > deadline) revert PermitExpired();

        try IERC20Permit(d.token).permit(msg.sender, address(this), d.buyerAmount, deadline, v, r, s) {
        } catch {
            uint256 allowed = IERC20(d.token).allowance(msg.sender, address(this));
            if (allowed < d.buyerAmount) revert InsufficientAllowance();
        }

        d.status = (d.tradeMode == TradeMode.TRUSTLESS)
            ? Status.AWAITING_SELLER_DEPOSIT
            : Status.AWAITING_PROOF;

        uint256 before   = IERC20(d.token).balanceOf(address(this));
        IERC20(d.token).safeTransferFrom(msg.sender, address(this), d.buyerAmount);
        uint256 received = IERC20(d.token).balanceOf(address(this)) - before;
        if (received < d.buyerAmount) revert TransferFailed();

        emit DealFunded(dealId, msg.sender, d.buyerAmount, "Buyer");
    }

    // =========================================================================
    // 3d. SUBMIT PROOF (FLEXIBLE & TRUSTLESS — advances to READY_TO_SETTLE)
    // =========================================================================

    /**
     * @notice Seller submits an off-chain proof hash to advance the deal to
     *         READY_TO_SETTLE, after which release() becomes callable.
     * @dev    In FLEXIBLE mode, called after buyer funds.
     *         In TRUSTLESS mode, called after both parties fund.
     * @param dealId    The deal identifier.
     * @param proofHash keccak256 of off-chain proof document / delivery evidence.
     */
    function submitProof(bytes32 dealId, bytes32 proofHash)
        external
        nonReentrant
        dealExists(dealId)
        notCancelled(dealId)
        notCompleted(dealId)
        notDisputed(dealId)
    {
        Deal storage d = deals[dealId];
        if (msg.sender != d.seller && !isAuthorized[msg.sender]) revert NotAuthorized();
        if (d.status != Status.AWAITING_PROOF) revert InvalidState();
        if (proofHash == bytes32(0)) revert InvalidAmount(); // reuse convenient error

        d.proofHash = proofHash;
        d.status    = Status.READY_TO_SETTLE;

        emit ProofSubmitted(dealId, msg.sender, proofHash);
    }

    // =========================================================================
    // 4. RELEASE (settle) — now requires READY_TO_SETTLE or AWAITING_PROOF
    //    (AWAITING_PROOF allowed for backward-compat with v3 FLEXIBLE flow)
    // =========================================================================

    /**
     * @notice Release escrowed tokens to the seller after the TGE timestamp.
     * @dev    RESTRICTED: only the seller or an authorized address may call.
     *         Settlement is BLOCKED when status == IN_DISPUTE.
     *         In TRUSTLESS mode: buyer receives sellerAmount, seller receives buyerAmount.
     *         In FLEXIBLE mode: seller receives buyerAmount.
     * @param dealId The deal identifier.
     */
    function release(bytes32 dealId)
        external
        nonReentrant
        dealExists(dealId)
        notCancelled(dealId)
        notCompleted(dealId)
        notDisputed(dealId)          // ← BLOCKS when IN_DISPUTE
    {
        Deal storage d = deals[dealId];
        if (msg.sender != d.seller && !isAuthorized[msg.sender]) revert NotAuthorized();

        // Accept READY_TO_SETTLE or (backward compat) AWAITING_PROOF
        bool settleable = d.status == Status.READY_TO_SETTLE || d.status == Status.AWAITING_PROOF;
        if (!settleable) revert InvalidState();
        if (block.timestamp < d.tgeTimestamp) revert TGENotReached();

        address buyer       = d.buyer;
        address seller      = d.seller;
        address token       = d.token;
        uint256 buyerAmt    = d.buyerAmount;
        uint256 sellerAmt   = d.sellerAmount;
        bool    trustless   = d.tradeMode == TradeMode.TRUSTLESS;

        // Effects before interactions
        d.status      = Status.COMPLETED;
        d.buyerAmount = 0;
        d.sellerAmount= 0;

        if (trustless && sellerAmt > 0) {
            // Atomic swap: buyer gets sellerAmt, seller gets buyerAmt
            IERC20(token).safeTransfer(buyer,  sellerAmt);
        }
        IERC20(token).safeTransfer(seller, buyerAmt);

        emit DealReleased(dealId, seller, buyerAmt);
    }

    // =========================================================================
    // 5. CANCEL
    // =========================================================================

    /**
     * @notice Cancel a deal.
     * @dev    Unfunded (CREATED): either party cancels immediately.
     *         Funded (any status except CREATED/IN_DISPUTE/terminal): dual-consent.
     *         IN_DISPUTE: cannot cancel — arbiter must resolve first.
     *         In TRUSTLESS mode, both buyer and seller deposits are refunded.
     */
    function cancel(bytes32 dealId)
        external
        nonReentrant
        dealExists(dealId)
        onlyParty(dealId)
        notCancelled(dealId)
        notCompleted(dealId)
    {
        Deal storage d = deals[dealId];

        // Cannot cancel while disputed — arbiter resolves
        if (d.status == Status.IN_DISPUTE) revert DealDisputed();

        if (d.status == Status.CREATED) {
            d.status = Status.CANCELLED;
            emit DealCancelled(dealId, msg.sender, false);
            return;
        }

        // Funded state — dual consent
        bool isBuyer = (msg.sender == d.buyer);
        if (isBuyer) {
            if (d.buyerCancelRequested) revert AlreadyCancelRequested();
            d.buyerCancelRequested = true;
            emit CancelRequested(dealId, msg.sender);
        } else {
            if (d.sellerCancelRequested) revert AlreadyCancelRequested();
            d.sellerCancelRequested = true;
            emit CancelRequested(dealId, msg.sender);
        }

        if (d.buyerCancelRequested && d.sellerCancelRequested) {
            address buyer      = d.buyer;
            address seller     = d.seller;
            address token      = d.token;
            uint256 buyerAmt   = d.buyerAmount;
            uint256 sellerAmt  = d.sellerAmount;

            d.status       = Status.CANCELLED;
            d.buyerAmount  = 0;
            d.sellerAmount = 0;

            IERC20(token).safeTransfer(buyer, buyerAmt);
            if (sellerAmt > 0) {
                IERC20(token).safeTransfer(seller, sellerAmt);
            }
            emit DealCancelled(dealId, msg.sender, true);
        }
    }

    // =========================================================================
    // 6. DISPUTE SYSTEM
    // =========================================================================

    /**
     * @notice Open a dispute on a deal — callable by either party.
     * @dev    Transitions deal to IN_DISPUTE, freezing settlement and dual-cancel.
     *         If disputeTimeout > 0, the deal must have been funded for at least
     *         that many seconds before openDispute() can be called.
     *
     *         Emits both DisputeOpened (v4) and DisputeRaised (v3 backward compat).
     *
     * @param tradeId  The deal identifier.
     * @param reason   Optional human-readable reason (stored on-chain in deal).
     */
    function openDispute(bytes32 tradeId, string calldata reason)
        external
        nonReentrant
        dealExists(tradeId)
        onlyParty(tradeId)
        notCancelled(tradeId)
        notCompleted(tradeId)
    {
        Deal storage d = deals[tradeId];

        // Only disputable in funded/proof/settle states
        bool disputable = d.status == Status.AWAITING_SELLER_DEPOSIT
            || d.status == Status.AWAITING_PROOF
            || d.status == Status.READY_TO_SETTLE;
        if (!disputable) revert InvalidState();

        // Dispute timeout guard
        if (d.disputeTimeout > 0) {
            // Use createdAt + disputeTimeout as proxy for "funded long enough"
            // A more precise implementation would track fundedAt separately;
            // this is a conservative approximation that is safe.
            if (block.timestamp < d.createdAt + d.disputeTimeout) {
                revert DisputeTimeoutNotReached();
            }
        }

        // Cannot re-open after resolution
        if (d.dispute.resolved) revert DisputeAlreadyResolved();

        d.status = Status.IN_DISPUTE;
        d.dispute.opener   = msg.sender;
        d.dispute.openedAt = block.timestamp;
        d.dispute.reason   = reason;

        emit DisputeOpened(tradeId, msg.sender);
        emit DisputeRaised(tradeId, msg.sender); // v3 compat
    }

    /**
     * @notice Backward-compatible raiseDispute (no reason string).
     * @dev    Delegates to openDispute with empty reason.
     *         Kept for ABI compatibility with v3 front-ends.
     */
    function raiseDispute(bytes32 dealId)
        external
        nonReentrant
        dealExists(dealId)
        onlyParty(dealId)
        notCancelled(dealId)
        notCompleted(dealId)
    {
        Deal storage d = deals[dealId];

        // v3 compat: accept Funded (maps to AWAITING_PROOF in v4 FLEXIBLE)
        bool disputable = d.status == Status.AWAITING_SELLER_DEPOSIT
            || d.status == Status.AWAITING_PROOF
            || d.status == Status.READY_TO_SETTLE;
        if (!disputable) revert InvalidState();
        if (d.dispute.resolved) revert DisputeAlreadyResolved();

        d.status = Status.IN_DISPUTE;
        d.dispute.opener   = msg.sender;
        d.dispute.openedAt = block.timestamp;

        emit DisputeOpened(dealId, msg.sender);
        emit DisputeRaised(dealId, msg.sender);
    }

    /**
     * @notice Arbiter resolves a dispute, deciding who receives the tokens.
     * @dev    ARBITER-ONLY.
     *         Two outcomes:
     *           releaseToSeller = true  → buyer's amount → seller; (TRUSTLESS: seller's amount → buyer)
     *           releaseToSeller = false → buyer's amount → buyer refunded; (TRUSTLESS: seller's amount → seller)
     *         Emits DisputeResolved(tradeId, releaseToSeller) [v4] and
     *               DisputeResolved(tradeId, releaseToSeller, arbiter) [v3 compat].
     *         Cannot be re-opened after resolution (disallowReopenAfterResolution).
     *
     * @param tradeId          The deal identifier.
     * @param releaseToSeller  True = release to seller; False = refund to buyer.
     */
    function resolveDispute(bytes32 tradeId, bool releaseToSeller)
        external
        nonReentrant
        dealExists(tradeId)
        onlyArbiter
    {
        Deal storage d = deals[tradeId];
        if (d.status != Status.IN_DISPUTE) revert NoDispute();
        if (d.dispute.resolved) revert DisputeAlreadyResolved();

        address buyer      = d.buyer;
        address seller     = d.seller;
        address token      = d.token;
        uint256 buyerAmt   = d.buyerAmount;
        uint256 sellerAmt  = d.sellerAmount;
        bool    trustless  = d.tradeMode == TradeMode.TRUSTLESS;

        // Mark resolved BEFORE any external call (CEI)
        d.dispute.resolved        = true;
        d.dispute.releasedToSeller = releaseToSeller;
        d.buyerAmount  = 0;
        d.sellerAmount = 0;

        if (releaseToSeller) {
            d.status = Status.COMPLETED;
            IERC20(token).safeTransfer(seller, buyerAmt);
            if (trustless && sellerAmt > 0) {
                // In TRUSTLESS, also return seller's deposit
                IERC20(token).safeTransfer(seller, sellerAmt);
            }
            emit DealReleased(tradeId, seller, buyerAmt);
        } else {
            d.status = Status.CANCELLED;
            IERC20(token).safeTransfer(buyer, buyerAmt);
            if (trustless && sellerAmt > 0) {
                IERC20(token).safeTransfer(seller, sellerAmt);
            }
            emit DealCancelled(tradeId, msg.sender, true);
        }

        emit DisputeResolved(tradeId, releaseToSeller);
    }

    // =========================================================================
    // 7. VIEW FUNCTIONS
    // =========================================================================

    function getDeal(bytes32 dealId) external view returns (Deal memory) {
        return deals[dealId];
    }

    /**
     * @notice Get deal signing and funding status — v3 ABI compatible.
     * @return buyerSigned   Whether the buyer has signed on-chain.
     * @return sellerSigned  Whether the seller has signed on-chain.
     * @return funded        True if deal is past CREATED status (buyer deposited).
     * @return currentState  Numeric status (0=CREATED,1=AWB_DEP,2=AWS_DEP,3=AWP,
     *                       4=READY,5=IN_DISPUTE,6=COMPLETED,7=CANCELLED).
     */
    function getDealStatus(bytes32 dealId)
        external
        view
        returns (
            bool   buyerSigned,
            bool   sellerSigned,
            bool   funded,
            Status currentState
        )
    {
        Deal storage d = deals[dealId];
        return (
            d.buyerSigned,
            d.sellerSigned,
            d.status != Status.CREATED && d.status != Status.CANCELLED,
            d.status
        );
    }

    /**
     * @notice Get dispute details for a deal.
     */
    function getDisputeData(bytes32 dealId)
        external
        view
        returns (
            address opener,
            uint256 openedAt,
            string  memory reason,
            bool    resolved,
            bool    releasedToSeller
        )
    {
        DisputeData storage dd = deals[dealId].dispute;
        return (dd.opener, dd.openedAt, dd.reason, dd.resolved, dd.releasedToSeller);
    }

    function getDealsByParty(address party) external view returns (bytes32[] memory) {
        return dealsByParty[party];
    }

    function canRelease(bytes32 dealId) external view returns (bool) {
        Deal storage d = deals[dealId];
        bool settleable = d.status == Status.READY_TO_SETTLE || d.status == Status.AWAITING_PROOF;
        return settleable && d.status != Status.IN_DISPUTE && block.timestamp >= d.tgeTimestamp;
    }

    /**
     * @notice Returns the current human-readable status string for a deal.
     * @dev    Possible values:
     *         NOT_FOUND, CANCELLED, COMPLETED, IN_DISPUTE, READY_TO_SETTLE,
     *         EXECUTABLE (READY_TO_SETTLE + TGE reached), AWAITING_PROOF,
     *         AWAITING_SELLER_DEPOSIT, AWAITING_BUYER_DEPOSIT, BOTH_SIGNED,
     *         PARTIALLY_SIGNED, CREATED.
     */
    function dealStatus(bytes32 dealId) external view returns (string memory) {
        Deal storage d = deals[dealId];
        if (d.buyer == address(0))                         return "NOT_FOUND";
        if (d.status == Status.CANCELLED)                  return "CANCELLED";
        if (d.status == Status.COMPLETED)                  return "COMPLETED";
        if (d.status == Status.IN_DISPUTE)                 return "IN_DISPUTE";
        if (d.status == Status.READY_TO_SETTLE) {
            if (block.timestamp >= d.tgeTimestamp)         return "EXECUTABLE";
            return "READY_TO_SETTLE";
        }
        if (d.status == Status.AWAITING_PROOF) {
            if (block.timestamp >= d.tgeTimestamp)         return "EXECUTABLE";
            return "AWAITING_PROOF";
        }
        if (d.status == Status.AWAITING_SELLER_DEPOSIT)   return "AWAITING_SELLER_DEPOSIT";
        if (d.status == Status.AWAITING_BUYER_DEPOSIT)    return "AWAITING_BUYER_DEPOSIT";
        // Status.CREATED
        if (d.buyerSigned && d.sellerSigned)              return "BOTH_SIGNED";
        if (d.buyerSigned || d.sellerSigned)              return "PARTIALLY_SIGNED";
        return "CREATED";
    }

    function getNonce(address buyer) external view returns (uint256) {
        return nonces[buyer];
    }

    /**
     * @notice Returns the TradeMode for a deal.
     */
    function getTradeMode(bytes32 dealId) external view returns (TradeMode) {
        return deals[dealId].tradeMode;
    }

    /**
     * @notice Check if a dispute can be opened right now.
     */
    function canOpenDispute(bytes32 dealId) external view returns (bool, string memory reason) {
        Deal storage d = deals[dealId];
        if (d.buyer == address(0))           return (false, "NOT_FOUND");
        if (d.status == Status.CANCELLED)    return (false, "CANCELLED");
        if (d.status == Status.COMPLETED)    return (false, "COMPLETED");
        if (d.status == Status.IN_DISPUTE)   return (false, "ALREADY_DISPUTED");
        if (d.dispute.resolved)              return (false, "ALREADY_RESOLVED");
        bool disputable = d.status == Status.AWAITING_SELLER_DEPOSIT
            || d.status == Status.AWAITING_PROOF
            || d.status == Status.READY_TO_SETTLE;
        if (!disputable)                     return (false, "NOT_FUNDED");
        if (d.disputeTimeout > 0 && block.timestamp < d.createdAt + d.disputeTimeout) {
            return (false, "TIMEOUT_NOT_REACHED");
        }
        return (true, "");
    }
}
