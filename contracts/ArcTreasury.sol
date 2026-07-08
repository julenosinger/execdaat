// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ============================================================================
//  ArcTreasury — Institutional Multisig Governance for ExecDaat
// ----------------------------------------------------------------------------
//  Scope: GOVERNANCE ONLY. Holds no bridge logic and no liquidity settlement
//  logic. It governs the ArcVault (liquidity), operators, the asset registry,
//  emergency actions, and executes arbitrary approved proposals via a
//  threshold multisig. It never touches the outbound bridge (Arc -> External).
//
//  Design goals: modular, audit-friendly, ERC165-compatible, batch reads and
//  frontend helpers, self-governed admin (signer/threshold/vault/asset changes
//  only happen through executed proposals), emergency pause by any signer.
//
//  Self-contained (no external imports) so it compiles standalone with solc.
// ============================================================================

contract ArcTreasury {
    string public constant NAME = "ArcTreasury";
    string public constant VERSION = "1.0.0";
    string public constant TREASURY_TYPE = "multisig-governance";

    // ── Signers / threshold ──────────────────────────────────────────────────
    address[] private _signers;
    mapping(address => bool) public isSigner;
    uint256 public threshold;

    // ── Emergency pause ───────────────────────────────────────────────────────
    bool public paused;

    // ── Governed references ───────────────────────────────────────────────────
    address public vault; // the ArcVault this treasury administers

    // ── Asset registry (governance-level view of supported assets) ────────────
    struct Asset { bool registered; string symbol; }
    mapping(address => Asset) public assets;
    address[] private _assetList;

    // ── Proposals ─────────────────────────────────────────────────────────────
    struct Proposal {
        address target;
        uint256 value;
        bytes data;
        string metadata;
        address proposer;
        uint64 createdAt;
        bool executed;
        bool cancelled;
        uint256 approvals;
    }
    Proposal[] private _proposals;
    mapping(uint256 => mapping(address => bool)) public approved;

    // ── Statistics ────────────────────────────────────────────────────────────
    uint256 public executedCount;

    // ── Events ────────────────────────────────────────────────────────────────
    event SignerAdded(address indexed signer);
    event SignerRemoved(address indexed signer);
    event ThresholdChanged(uint256 threshold);
    event Paused(address indexed by);
    event Unpaused(address indexed by);
    event VaultSet(address indexed vault);
    event AssetRegistered(address indexed token, string symbol);
    event ProposalCreated(uint256 indexed id, address indexed proposer, address indexed target, uint256 value, string metadata);
    event ProposalApproved(uint256 indexed id, address indexed signer, uint256 approvals);
    event ApprovalRevoked(uint256 indexed id, address indexed signer, uint256 approvals);
    event ProposalExecuted(uint256 indexed id, address indexed executor, bytes result);
    event ProposalCancelled(uint256 indexed id, address indexed by);
    event Received(address indexed from, uint256 amount);

    modifier onlySigner() { require(isSigner[msg.sender], "ArcTreasury: not signer"); _; }
    modifier onlySelf()   { require(msg.sender == address(this), "ArcTreasury: only via proposal"); _; }
    modifier notPaused()  { require(!paused, "ArcTreasury: paused"); _; }

    constructor(address[] memory signers_, uint256 threshold_) {
        require(signers_.length > 0, "ArcTreasury: no signers");
        require(threshold_ > 0 && threshold_ <= signers_.length, "ArcTreasury: bad threshold");
        for (uint256 i = 0; i < signers_.length; i++) {
            address s = signers_[i];
            require(s != address(0) && !isSigner[s], "ArcTreasury: bad signer");
            isSigner[s] = true;
            _signers.push(s);
            emit SignerAdded(s);
        }
        threshold = threshold_;
        emit ThresholdChanged(threshold_);
    }

    receive() external payable { emit Received(msg.sender, msg.value); }

    // ── Proposal lifecycle ────────────────────────────────────────────────────
    function submitProposal(address target, uint256 value, bytes calldata data, string calldata metadata)
        external onlySigner notPaused returns (uint256 id)
    {
        _proposals.push(Proposal({
            target: target, value: value, data: data, metadata: metadata,
            proposer: msg.sender, createdAt: uint64(block.timestamp),
            executed: false, cancelled: false, approvals: 0
        }));
        id = _proposals.length - 1;
        emit ProposalCreated(id, msg.sender, target, value, metadata);
        _approve(id); // proposer auto-approves
    }

    function approveProposal(uint256 id) external onlySigner { _approve(id); }

    function _approve(uint256 id) internal {
        Proposal storage p = _proposals[id];
        require(!p.executed && !p.cancelled, "ArcTreasury: proposal closed");
        require(!approved[id][msg.sender], "ArcTreasury: already approved");
        approved[id][msg.sender] = true;
        p.approvals += 1;
        emit ProposalApproved(id, msg.sender, p.approvals);
    }

    function revokeApproval(uint256 id) external onlySigner {
        Proposal storage p = _proposals[id];
        require(!p.executed && !p.cancelled, "ArcTreasury: proposal closed");
        require(approved[id][msg.sender], "ArcTreasury: not approved");
        approved[id][msg.sender] = false;
        p.approvals -= 1;
        emit ApprovalRevoked(id, msg.sender, p.approvals);
    }

    function executeProposal(uint256 id) external onlySigner notPaused returns (bytes memory result) {
        Proposal storage p = _proposals[id];
        require(!p.executed && !p.cancelled, "ArcTreasury: proposal closed");
        require(p.approvals >= threshold, "ArcTreasury: threshold not met");
        p.executed = true;
        executedCount += 1;
        (bool ok, bytes memory ret) = p.target.call{value: p.value}(p.data);
        require(ok, "ArcTreasury: execution failed");
        result = ret;
        emit ProposalExecuted(id, msg.sender, ret);
    }

    function cancelProposal(uint256 id) external onlySigner {
        Proposal storage p = _proposals[id];
        require(!p.executed && !p.cancelled, "ArcTreasury: proposal closed");
        p.cancelled = true;
        emit ProposalCancelled(id, msg.sender);
    }

    // ── Self-governed administration (only reachable via executeProposal) ─────
    function addSigner(address s) external onlySelf {
        require(s != address(0) && !isSigner[s], "ArcTreasury: bad signer");
        isSigner[s] = true; _signers.push(s); emit SignerAdded(s);
    }
    function removeSigner(address s) external onlySelf {
        require(isSigner[s], "ArcTreasury: not signer");
        require(_signers.length - 1 >= threshold, "ArcTreasury: threshold breach");
        isSigner[s] = false;
        for (uint256 i = 0; i < _signers.length; i++) {
            if (_signers[i] == s) { _signers[i] = _signers[_signers.length - 1]; _signers.pop(); break; }
        }
        emit SignerRemoved(s);
    }
    function changeThreshold(uint256 t) external onlySelf {
        require(t > 0 && t <= _signers.length, "ArcTreasury: bad threshold");
        threshold = t; emit ThresholdChanged(t);
    }
    function setVault(address v) external onlySelf { vault = v; emit VaultSet(v); }
    function registerAsset(address token, string calldata symbol) external onlySelf {
        if (!assets[token].registered) { assets[token] = Asset(true, symbol); _assetList.push(token); }
        else { assets[token].symbol = symbol; }
        emit AssetRegistered(token, symbol);
    }
    function unpause() external onlySelf { paused = false; emit Unpaused(msg.sender); }

    // ── Emergency: any single signer may pause immediately ────────────────────
    function emergencyPause() external onlySigner { paused = true; emit Paused(msg.sender); }

    // ── Frontend helpers / batch reads ────────────────────────────────────────
    function getSigners() external view returns (address[] memory) { return _signers; }
    function signerCount() external view returns (uint256) { return _signers.length; }
    function getAssets() external view returns (address[] memory) { return _assetList; }
    function assetCount() external view returns (uint256) { return _assetList.length; }
    function proposalCount() external view returns (uint256) { return _proposals.length; }
    function getProposal(uint256 id) external view returns (Proposal memory) { return _proposals[id]; }
    function getProposals(uint256 start, uint256 count) external view returns (Proposal[] memory list) {
        uint256 n = _proposals.length;
        if (start >= n) return new Proposal[](0);
        uint256 end = start + count; if (end > n) end = n;
        list = new Proposal[](end - start);
        for (uint256 i = start; i < end; i++) list[i - start] = _proposals[i];
    }
    function isApprovedBy(uint256 id, address signer) external view returns (bool) { return approved[id][signer]; }

    struct Summary {
        string name; string version; uint256 signerCount; uint256 threshold;
        bool paused; address vault; uint256 proposalCount; uint256 executedCount; uint256 assetCount;
    }
    function summary() external view returns (Summary memory) {
        return Summary(NAME, VERSION, _signers.length, threshold, paused, vault, _proposals.length, executedCount, _assetList.length);
    }

    // ── ERC165 ────────────────────────────────────────────────────────────────
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7; // ERC165
    }
}
