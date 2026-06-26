// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// AgentExecutor.sol — Meta-Transaction Engine
// ExecDaat · Arc Testnet · Chain ID 5042002
//
// Architecture:
//   User → signTypedData(EIP-712 Intent) → Backend Relayer
//   → agentExecutor.execute(request, sig)  ← no wallet popup
//
// EIP-712 Domain:
//   name:              "AgentExecutor"
//   version:           "1"
//   chainId:           <dynamic>
//   verifyingContract: <this contract>
//
// Security:
//   • Per-user nonce prevents replay attacks
//   • Signature verification (ECDSA recover)
//   • Array length checks (recipients == amounts)
//   • Deadline enforcement
//   • Max amount per execution (configurable)
//   • Token whitelist (USDC, EURC)
//   • Pausable (owner can halt in emergency)
//   • Rate limiting (max N executions per block per user)
//
// Execution methods:
//   • execute()       — single transfer (uses transferFrom)
//   • executeBatch()  — multisend (recipients[] + amounts[])
//   • executeCall()   — arbitrary contract call (advanced)
//
// Gas sponsorship:
//   • Relayer pays gas (private key wallet)
//   • User never needs ETH for gas
//   • Optional: accept ETH tips for gas refund
// ============================================================

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

contract AgentExecutor {

    // ── EIP-712 ────────────────────────────────────────────────────────────────
    bytes32 public constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    // Single transfer intent
    bytes32 public constant TRANSFER_TYPEHASH = keccak256(
        "TransferIntent(address from,address token,address to,uint256 amount,uint256 nonce,uint256 deadline)"
    );

    // Batch transfer intent
    bytes32 public constant BATCH_TYPEHASH = keccak256(
        "BatchIntent(address from,address token,address[] recipients,uint256[] amounts,uint256 nonce,uint256 deadline)"
    );

    // Contract call intent
    bytes32 public constant CALL_TYPEHASH = keccak256(
        "CallIntent(address from,address target,bytes4 selector,bytes params,uint256 value,uint256 nonce,uint256 deadline)"
    );

    bytes32 public immutable DOMAIN_SEPARATOR;

    // ── State ──────────────────────────────────────────────────────────────────
    address public owner;
    bool    public paused;

    // per-user nonce (monotonically increasing, replay protection)
    mapping(address => uint256) public nonces;

    // authorized relayers (addresses that can call execute*)
    mapping(address => bool) public relayers;

    // whitelisted tokens
    mapping(address => bool) public allowedTokens;

    // per-user rate limiting: last block executed + count
    mapping(address => uint256) public lastBlock;
    mapping(address => uint256) public blockCount;
    uint256 public constant MAX_PER_BLOCK = 5;

    // max single transfer amount (6 decimals → 10,000 USDC)
    uint256 public maxAmount = 10_000 * 1e6;

    // ── Events ──────────────────────────────────────────────────────────────────
    event Executed(
        address indexed from, address indexed to, address token,
        uint256 amount, uint256 nonce, bytes32 intentId
    );
    event BatchExecuted(
        address indexed from, address token, uint256 recipientCount,
        uint256 totalAmount, uint256 nonce, bytes32 intentId
    );
    event CallExecuted(
        address indexed from, address indexed target, bytes4 selector,
        uint256 nonce, bytes32 intentId
    );
    event RelayerUpdated(address relayer, bool authorized);
    event TokenUpdated(address token, bool allowed);
    event Paused(bool paused);
    event OwnerUpdated(address newOwner);

    // ── Errors ──────────────────────────────────────────────────────────────────
    error Unauthorized();
    error InvalidSignature();
    error ExpiredDeadline();
    error InvalidNonce();
    error ArrayLengthMismatch();
    error TokenNotAllowed();
    error AmountExceedsMax();
    error ContractPaused();
    error RateLimitExceeded();
    error InsufficientAllowance();
    error TransferFailed();
    error ZeroAmount();
    error EmptyRecipients();

    // ── Modifiers ────────────────────────────────────────────────────────────────
    modifier onlyOwner()   { if (msg.sender != owner) revert Unauthorized(); _; }
    modifier onlyRelayer() { if (!relayers[msg.sender]) revert Unauthorized(); _; }
    modifier whenNotPaused() { if (paused) revert ContractPaused(); _; }

    // ── Constructor ──────────────────────────────────────────────────────────────
    constructor(
        address[] memory _relayers,
        address[] memory _tokens
    ) {
        owner = msg.sender;

        DOMAIN_SEPARATOR = keccak256(abi.encode(
            DOMAIN_TYPEHASH,
            keccak256(bytes("AgentExecutor")),
            keccak256(bytes("1")),
            block.chainid,
            address(this)
        ));

        for (uint i = 0; i < _relayers.length; i++) {
            relayers[_relayers[i]] = true;
            emit RelayerUpdated(_relayers[i], true);
        }
        for (uint i = 0; i < _tokens.length; i++) {
            allowedTokens[_tokens[i]] = true;
            emit TokenUpdated(_tokens[i], true);
        }
    }

    // ── View: build intent hash ───────────────────────────────────────────────
    function hashTransferIntent(
        address from, address token, address to,
        uint256 amount, uint256 nonce, uint256 deadline
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            TRANSFER_TYPEHASH, from, token, to, amount, nonce, deadline
        ));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    function hashBatchIntent(
        address from, address token,
        address[] calldata recipients, uint256[] calldata amounts,
        uint256 nonce, uint256 deadline
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            BATCH_TYPEHASH, from, token,
            keccak256(abi.encodePacked(recipients)),
            keccak256(abi.encodePacked(amounts)),
            nonce, deadline
        ));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    // ── Core: Execute single transfer ─────────────────────────────────────────
    function execute(
        address from,
        address token,
        address to,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external onlyRelayer whenNotPaused {
        // 1. Deadline
        if (block.timestamp > deadline) revert ExpiredDeadline();

        // 2. Nonce (must match expected)
        if (nonces[from] != nonce) revert InvalidNonce();

        // 3. Token whitelist
        if (!allowedTokens[token]) revert TokenNotAllowed();

        // 4. Amount checks
        if (amount == 0) revert ZeroAmount();
        if (amount > maxAmount) revert AmountExceedsMax();

        // 5. Rate limiting
        _checkRateLimit(from);

        // 6. Signature verification
        bytes32 hash = hashTransferIntent(from, token, to, amount, nonce, deadline);
        address signer = _recover(hash, signature);
        if (signer != from) revert InvalidSignature();

        // 7. Increment nonce (before external call — reentrancy protection)
        nonces[from]++;

        // 8. Execute transferFrom (user must have approved this contract)
        IERC20 erc20 = IERC20(token);
        uint256 allowed = erc20.allowance(from, address(this));
        if (allowed < amount) revert InsufficientAllowance();

        bool ok = erc20.transferFrom(from, to, amount);
        if (!ok) revert TransferFailed();

        bytes32 intentId = keccak256(abi.encodePacked(from, nonce, block.timestamp));
        emit Executed(from, to, token, amount, nonce, intentId);
    }

    // ── Core: Execute batch transfer ──────────────────────────────────────────
    function executeBatch(
        address from,
        address token,
        address[] calldata recipients,
        uint256[] calldata amounts,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external onlyRelayer whenNotPaused {
        // Basic checks
        if (block.timestamp > deadline) revert ExpiredDeadline();
        if (nonces[from] != nonce) revert InvalidNonce();
        if (!allowedTokens[token]) revert TokenNotAllowed();
        if (recipients.length == 0) revert EmptyRecipients();
        if (recipients.length != amounts.length) revert ArrayLengthMismatch();

        // Total amount + max check
        uint256 total = 0;
        for (uint i = 0; i < amounts.length; i++) {
            if (amounts[i] == 0) revert ZeroAmount();
            total += amounts[i];
        }
        if (total > maxAmount * 10) revert AmountExceedsMax(); // 10x limit for batches

        // Rate limiting
        _checkRateLimit(from);

        // Signature verification
        bytes32 hash = hashBatchIntent(from, token, recipients, amounts, nonce, deadline);
        address signer = _recover(hash, signature);
        if (signer != from) revert InvalidSignature();

        // Increment nonce
        nonces[from]++;

        // Execute transfers
        IERC20 erc20 = IERC20(token);
        uint256 allowed = erc20.allowance(from, address(this));
        if (allowed < total) revert InsufficientAllowance();

        for (uint i = 0; i < recipients.length; i++) {
            bool ok = erc20.transferFrom(from, recipients[i], amounts[i]);
            if (!ok) revert TransferFailed();
        }

        bytes32 intentId = keccak256(abi.encodePacked(from, nonce, block.timestamp));
        emit BatchExecuted(from, token, recipients.length, total, nonce, intentId);
    }

    // ── Internal: rate limiting ───────────────────────────────────────────────
    function _checkRateLimit(address user) internal {
        if (lastBlock[user] == block.number) {
            blockCount[user]++;
            if (blockCount[user] > MAX_PER_BLOCK) revert RateLimitExceeded();
        } else {
            lastBlock[user] = block.number;
            blockCount[user] = 1;
        }
    }

    // ── Internal: ECDSA recover ───────────────────────────────────────────────
    function _recover(bytes32 hash, bytes calldata sig) internal pure returns (address) {
        require(sig.length == 65, "Bad sig length");
        bytes32 r;
        bytes32 s;
        uint8   v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        return ecrecover(hash, v, r, s);
    }

    // ── Admin ────────────────────────────────────────────────────────────────
    function setRelayer(address relayer, bool authorized) external onlyOwner {
        relayers[relayer] = authorized;
        emit RelayerUpdated(relayer, authorized);
    }

    function setToken(address token, bool allowed) external onlyOwner {
        allowedTokens[token] = allowed;
        emit TokenUpdated(token, allowed);
    }

    function setMaxAmount(uint256 newMax) external onlyOwner {
        maxAmount = newMax;
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit Paused(_paused);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
        emit OwnerUpdated(newOwner);
    }

    // Accept ETH for gas refunds (optional tip mechanism)
    receive() external payable {}

    function withdrawETH(address payable to, uint256 amount) external onlyOwner {
        to.transfer(amount);
    }
}
