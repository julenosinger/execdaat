// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// OTCEscrow — ExecDaat OTC Smart Contract
//
// EVM-compatible escrow for Over-The-Counter token deals.
// Compatible with ARC Testnet (Chain ID: 5042002) and any EVM.
//
// Flow:
//   1. buyer calls createDeal()    → dealId generated
//   2. buyer calls signDeal()      → marks buyerSigned
//   3. seller calls signDeal()     → marks sellerSigned
//   4. buyer approves ERC20, then calls fundDeal() → tokens locked
//   5. After TGE timestamp: anyone calls release() → tokens to seller
//   6. Either party can cancel()   → refund if not funded
//      buyer+seller both cancel()  → refund if funded (dual consent)
//
// Security:
//   - ReentrancyGuard on all state-changing functions
//   - SafeERC20 for all token transfers
//   - Role checks: buyer/seller only
//   - Double-funding / double-release prevention
// ============================================================

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract OTCEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Deal struct ─────────────────────────────────────────────────────────
    struct Deal {
        address buyer;
        address seller;
        address token;
        uint256 amount;
        uint256 tgeTimestamp;   // Unix timestamp (UTC) for TGE/release

        bool buyerSigned;
        bool sellerSigned;

        bool funded;
        bool released;
        bool cancelled;

        // Dual-consent cancel (for funded deals)
        bool buyerCancelRequested;
        bool sellerCancelRequested;

        bytes32 contractHash;   // keccak256 of off-chain contract data
        uint256 createdAt;
    }

    // ─── Storage ─────────────────────────────────────────────────────────────
    mapping(bytes32 => Deal) public deals;

    // Tracks all deal IDs for a given address (buyer or seller)
    mapping(address => bytes32[]) public dealsByParty;

    // ─── Events ──────────────────────────────────────────────────────────────
    event DealCreated(
        bytes32 indexed dealId,
        address indexed buyer,
        address indexed seller,
        address token,
        uint256 amount,
        uint256 tgeTimestamp,
        bytes32 contractHash
    );
    event DealSigned(bytes32 indexed dealId, address indexed signer, string role);
    event DealFunded(bytes32 indexed dealId, uint256 amount);
    event DealReleased(bytes32 indexed dealId, address indexed seller, uint256 amount);
    event DealCancelled(bytes32 indexed dealId, address indexed cancelledBy, bool refunded);
    event CancelRequested(bytes32 indexed dealId, address indexed requester);

    // ─── Errors ──────────────────────────────────────────────────────────────
    error NotParty();
    error AlreadySigned();
    error NotBothSigned();
    error AlreadyFunded();
    error NotFunded();
    error AlreadyReleased();
    error AlreadyCancelled();
    error TGENotReached();
    error DealNotFound();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidTimestamp();
    error SameAddress();
    error AlreadyCancelRequested();

    // ─── Modifiers ───────────────────────────────────────────────────────────
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
        if (deals[dealId].cancelled) revert AlreadyCancelled();
        _;
    }

    modifier notReleased(bytes32 dealId) {
        if (deals[dealId].released) revert AlreadyReleased();
        _;
    }

    // ─── 1. CREATE DEAL ──────────────────────────────────────────────────────
    /// @notice Buyer creates an OTC deal
    /// @param seller         The seller's address
    /// @param token          ERC-20 token contract address
    /// @param amount         Token amount (in token's native decimals)
    /// @param tgeTimestamp   Unix UTC timestamp for TGE (release time)
    /// @param contractHash   keccak256 hash of the off-chain contract document
    /// @return dealId        Unique identifier for this deal
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
            msg.sender,
            seller,
            token,
            amount,
            tgeTimestamp,
            contractHash,
            block.timestamp,
            block.number
        ));

        // Prevent collision (extremely unlikely but safe)
        require(deals[dealId].buyer == address(0), "Deal ID collision");

        deals[dealId] = Deal({
            buyer:                msg.sender,
            seller:               seller,
            token:                token,
            amount:               amount,
            tgeTimestamp:         tgeTimestamp,
            buyerSigned:          false,
            sellerSigned:         false,
            funded:               false,
            released:             false,
            cancelled:            false,
            buyerCancelRequested: false,
            sellerCancelRequested:false,
            contractHash:         contractHash,
            createdAt:            block.timestamp
        });

        dealsByParty[msg.sender].push(dealId);
        dealsByParty[seller].push(dealId);

        emit DealCreated(dealId, msg.sender, seller, token, amount, tgeTimestamp, contractHash);
    }

    // ─── 2. SIGN DEAL ────────────────────────────────────────────────────────
    /// @notice Buyer or seller signs the deal on-chain
    /// @param dealId The deal identifier
    function signDeal(bytes32 dealId)
        external
        nonReentrant
        dealExists(dealId)
        onlyParty(dealId)
        notCancelled(dealId)
        notReleased(dealId)
    {
        Deal storage d = deals[dealId];

        bool isBuyer  = (msg.sender == d.buyer);
        bool isSeller = (msg.sender == d.seller);

        if (isBuyer) {
            if (d.buyerSigned) revert AlreadySigned();
            d.buyerSigned = true;
            emit DealSigned(dealId, msg.sender, "Buyer");
        } else if (isSeller) {
            if (d.sellerSigned) revert AlreadySigned();
            d.sellerSigned = true;
            emit DealSigned(dealId, msg.sender, "Seller");
        }
    }

    // ─── 3. FUND DEAL ────────────────────────────────────────────────────────
    /// @notice Buyer deposits ERC-20 tokens into escrow
    /// @dev Requires prior ERC-20 approval for this contract
    /// @param dealId The deal identifier
    function fundDeal(bytes32 dealId)
        external
        nonReentrant
        dealExists(dealId)
        notCancelled(dealId)
        notReleased(dealId)
    {
        Deal storage d = deals[dealId];

        if (msg.sender != d.buyer) revert NotParty();
        if (!d.buyerSigned || !d.sellerSigned) revert NotBothSigned();
        if (d.funded) revert AlreadyFunded();

        d.funded = true;

        IERC20(d.token).safeTransferFrom(msg.sender, address(this), d.amount);

        emit DealFunded(dealId, d.amount);
    }

    // ─── 4. RELEASE ──────────────────────────────────────────────────────────
    /// @notice Release escrowed tokens to seller after TGE timestamp
    /// @dev Can be called by anyone after TGE — trustless execution
    /// @param dealId The deal identifier
    function release(bytes32 dealId)
        external
        nonReentrant
        dealExists(dealId)
        notCancelled(dealId)
        notReleased(dealId)
    {
        Deal storage d = deals[dealId];

        if (!d.funded) revert NotFunded();
        if (block.timestamp < d.tgeTimestamp) revert TGENotReached();

        d.released = true;

        IERC20(d.token).safeTransfer(d.seller, d.amount);

        emit DealReleased(dealId, d.seller, d.amount);
    }

    // ─── 5. CANCEL ───────────────────────────────────────────────────────────
    /// @notice Cancel a deal
    /// @dev   - If NOT funded: either party can cancel immediately
    ///        - If funded: both parties must call cancel() (dual consent)
    ///          After both request → refund to buyer
    /// @param dealId The deal identifier
    function cancel(bytes32 dealId)
        external
        nonReentrant
        dealExists(dealId)
        onlyParty(dealId)
        notCancelled(dealId)
        notReleased(dealId)
    {
        Deal storage d = deals[dealId];

        if (!d.funded) {
            // Not funded: immediate cancel, no refund needed
            d.cancelled = true;
            emit DealCancelled(dealId, msg.sender, false);
            return;
        }

        // Funded: require dual consent
        bool isBuyer  = (msg.sender == d.buyer);
        bool isSeller = (msg.sender == d.seller);

        if (isBuyer) {
            if (d.buyerCancelRequested) revert AlreadyCancelRequested();
            d.buyerCancelRequested = true;
            emit CancelRequested(dealId, msg.sender);
        } else if (isSeller) {
            if (d.sellerCancelRequested) revert AlreadyCancelRequested();
            d.sellerCancelRequested = true;
            emit CancelRequested(dealId, msg.sender);
        }

        // If both have requested → execute cancel + refund
        if (d.buyerCancelRequested && d.sellerCancelRequested) {
            d.cancelled = true;
            IERC20(d.token).safeTransfer(d.buyer, d.amount);
            emit DealCancelled(dealId, msg.sender, true);
        }
    }

    // ─── 6. VIEW FUNCTIONS ───────────────────────────────────────────────────
    /// @notice Get full deal data
    function getDeal(bytes32 dealId) external view returns (Deal memory) {
        return deals[dealId];
    }

    /// @notice Get all deal IDs for a party
    function getDealsByParty(address party) external view returns (bytes32[] memory) {
        return dealsByParty[party];
    }

    /// @notice Check if a deal can be released right now
    function canRelease(bytes32 dealId) external view returns (bool) {
        Deal storage d = deals[dealId];
        return d.funded && !d.released && !d.cancelled &&
               block.timestamp >= d.tgeTimestamp;
    }

    /// @notice Returns the current status string of a deal
    function dealStatus(bytes32 dealId) external view returns (string memory) {
        Deal storage d = deals[dealId];
        if (d.buyer == address(0))          return "NOT_FOUND";
        if (d.cancelled)                     return "CANCELLED";
        if (d.released)                      return "RELEASED";
        if (d.funded) {
            if (block.timestamp >= d.tgeTimestamp) return "EXECUTABLE";
            return "FUNDED";
        }
        if (d.buyerSigned && d.sellerSigned) return "BOTH_SIGNED";
        if (d.buyerSigned || d.sellerSigned) return "PARTIALLY_SIGNED";
        return "CREATED";
    }
}
