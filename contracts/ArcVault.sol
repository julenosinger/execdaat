// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ============================================================================
//  ArcVault — Liquidity Engine for the INBOUND Turbo Bridge (External -> Arc)
// ----------------------------------------------------------------------------
//  Independent from ArcTreasury. ArcTreasury is the GOVERNOR (administrative);
//  ArcVault is the OPERATIONAL liquidity manager. Settlement operators reserve,
//  start, complete, or cancel settlements against per-asset liquidity.
//
//  Direction scope: this vault only backs inbound settlements delivered ON Arc.
//  It contains NO outbound (Arc -> External) logic and must never be used for it.
//
//  Read interface is intentionally compatible with the existing app:
//    getAvailableLiquidity(address)  · isOperator(address)  · turboFeeBps()
//  so the Treasury page works unchanged whether pointed at this vault or the
//  legacy one (auto-discovery just swaps the address).
//
//  Automatic asset discovery: any asset funded or used is auto-registered.
//  Native asset supported via address(0). Self-contained (no imports).
// ============================================================================

interface IERC20V {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract ArcVault {
    string public constant NAME = "ArcVault";
    string public constant VERSION = "1.0.0";
    string public constant VAULT_TYPE = "inbound-liquidity";
    address public constant NATIVE = address(0); // sentinel for the native asset

    // ── Governance / permissions ──────────────────────────────────────────────
    address public governor;               // ArcTreasury (administrative)
    mapping(address => bool) public isOperator; // settlement workers (operational)
    address[] private _operators;

    // ── Emergency pause ───────────────────────────────────────────────────────
    bool public paused;

    // ── Informational fee (governed; read-compat with existing UI) ────────────
    uint256 public turboFeeBps;

    // ── Reentrancy guard ──────────────────────────────────────────────────────
    uint256 private _guard = 1;

    // ── Per-asset accounting ──────────────────────────────────────────────────
    struct AssetInfo { bool registered; string symbol; uint256 reserved; uint256 locked; uint256 pending; }
    mapping(address => AssetInfo) public assetInfo;
    address[] private _assets;

    // ── Events (as specified) ─────────────────────────────────────────────────
    event VaultFunded(address indexed asset, address indexed from, uint256 amount);
    event VaultWithdrawn(address indexed asset, address indexed to, uint256 amount);
    event LiquidityReserved(bytes32 indexed intentId, address indexed asset, uint256 amount);
    event LiquidityReleased(bytes32 indexed intentId, address indexed asset, uint256 amount);
    event SettlementStarted(bytes32 indexed intentId, address indexed asset, uint256 amount);
    event SettlementCompleted(bytes32 indexed intentId, address indexed asset, address indexed to, uint256 amount);
    event SettlementCancelled(bytes32 indexed intentId, address indexed asset, uint256 amount);
    event AssetRegistered(address indexed asset, string symbol);
    event OperatorSet(address indexed operator, bool enabled);
    event GovernorChanged(address indexed governor);
    event Paused(address indexed by);
    event Unpaused(address indexed by);
    event HealthUpdated(address indexed asset, uint8 health);
    event FeeUpdated(uint256 bps);

    modifier onlyGovernor() { require(msg.sender == governor, "ArcVault: not governor"); _; }
    modifier onlyOperator() { require(isOperator[msg.sender] || msg.sender == governor, "ArcVault: not operator"); _; }
    modifier notPaused()    { require(!paused, "ArcVault: paused"); _; }
    modifier nonReentrant() { require(_guard == 1, "ArcVault: reentrant"); _guard = 2; _; _guard = 1; }

    constructor(address governor_, address[] memory operators_, address[] memory assets_, string[] memory symbols_) {
        require(governor_ != address(0), "ArcVault: governor 0");
        governor = governor_;
        emit GovernorChanged(governor_);
        for (uint256 i = 0; i < operators_.length; i++) {
            address o = operators_[i];
            if (o != address(0) && !isOperator[o]) { isOperator[o] = true; _operators.push(o); emit OperatorSet(o, true); }
        }
        for (uint256 i = 0; i < assets_.length; i++) {
            _register(assets_[i], i < symbols_.length ? symbols_[i] : "");
        }
    }

    // Accept native funding; auto-register native.
    receive() external payable {
        if (!assetInfo[NATIVE].registered) _register(NATIVE, "NATIVE");
        emit VaultFunded(NATIVE, msg.sender, msg.value);
    }

    // ── Balances & liquidity views (read-compatible) ──────────────────────────
    function rawBalance(address asset) public view returns (uint256) {
        return asset == NATIVE ? address(this).balance : IERC20V(asset).balanceOf(address(this));
    }
    function getAvailableLiquidity(address asset) public view returns (uint256 available) {
        uint256 bal = rawBalance(asset);
        AssetInfo storage a = assetInfo[asset];
        uint256 committed = a.reserved + a.locked + a.pending;
        available = bal > committed ? bal - committed : 0;
    }
    function assetHealth(address asset) public view returns (uint8) {
        // 0 = healthy (green), 1 = tight (yellow), 2 = depleted (red)
        uint256 avail = getAvailableLiquidity(asset);
        AssetInfo storage a = assetInfo[asset];
        if (avail == 0 && (a.reserved + a.pending) > 0) return 2;
        if (avail < a.pending) return 1;
        return 0;
    }

    // ── Funding ───────────────────────────────────────────────────────────────
    function deposit(address asset, uint256 amount) external payable notPaused nonReentrant {
        require(amount > 0, "ArcVault: zero amount");
        if (asset == NATIVE) {
            require(msg.value == amount, "ArcVault: bad native value");
        } else {
            require(msg.value == 0, "ArcVault: no native");
            require(IERC20V(asset).transferFrom(msg.sender, address(this), amount), "ArcVault: transferFrom failed");
        }
        if (!assetInfo[asset].registered) _register(asset, "");
        emit VaultFunded(asset, msg.sender, amount);
        emit HealthUpdated(asset, assetHealth(asset));
    }

    // ── Withdraw (governor only; cannot touch committed liquidity) ────────────
    function withdraw(address asset, uint256 amount, address to) external onlyGovernor nonReentrant {
        require(to != address(0), "ArcVault: to 0");
        require(amount > 0 && amount <= getAvailableLiquidity(asset), "ArcVault: exceeds available");
        _send(asset, to, amount);
        emit VaultWithdrawn(asset, to, amount);
        emit HealthUpdated(asset, assetHealth(asset));
    }

    // ── Inbound settlement lifecycle (operators) ──────────────────────────────
    function reserve(bytes32 intentId, address asset, uint256 amount) external onlyOperator notPaused {
        require(amount <= getAvailableLiquidity(asset), "ArcVault: insufficient liquidity");
        if (!assetInfo[asset].registered) _register(asset, "");
        assetInfo[asset].reserved += amount;
        emit LiquidityReserved(intentId, asset, amount);
        emit HealthUpdated(asset, assetHealth(asset));
    }
    function release(bytes32 intentId, address asset, uint256 amount) external onlyOperator {
        AssetInfo storage a = assetInfo[asset];
        a.reserved = amount <= a.reserved ? a.reserved - amount : 0;
        emit LiquidityReleased(intentId, asset, amount);
        emit HealthUpdated(asset, assetHealth(asset));
    }
    function startSettlement(bytes32 intentId, address asset, uint256 amount) external onlyOperator notPaused {
        AssetInfo storage a = assetInfo[asset];
        a.reserved = amount <= a.reserved ? a.reserved - amount : 0;
        a.pending += amount;
        emit SettlementStarted(intentId, asset, amount);
    }
    function completeSettlement(bytes32 intentId, address asset, address to, uint256 amount)
        external onlyOperator nonReentrant
    {
        require(to != address(0), "ArcVault: to 0");
        AssetInfo storage a = assetInfo[asset];
        a.pending = amount <= a.pending ? a.pending - amount : 0;
        _send(asset, to, amount);
        emit SettlementCompleted(intentId, asset, to, amount);
        emit HealthUpdated(asset, assetHealth(asset));
    }
    function cancelSettlement(bytes32 intentId, address asset, uint256 amount) external onlyOperator {
        AssetInfo storage a = assetInfo[asset];
        a.pending = amount <= a.pending ? a.pending - amount : 0;
        emit SettlementCancelled(intentId, asset, amount);
        emit HealthUpdated(asset, assetHealth(asset));
    }

    // ── Governance-controlled administration ──────────────────────────────────
    function registerAsset(address asset, string calldata symbol) external onlyGovernor { _register(asset, symbol); }
    function setOperator(address op, bool enabled) external onlyGovernor {
        require(op != address(0), "ArcVault: op 0");
        if (enabled && !isOperator[op]) { isOperator[op] = true; _operators.push(op); }
        else if (!enabled && isOperator[op]) {
            isOperator[op] = false;
            for (uint256 i = 0; i < _operators.length; i++) {
                if (_operators[i] == op) { _operators[i] = _operators[_operators.length - 1]; _operators.pop(); break; }
            }
        }
        emit OperatorSet(op, enabled);
    }
    function setGovernor(address g) external onlyGovernor { require(g != address(0), "ArcVault: gov 0"); governor = g; emit GovernorChanged(g); }
    function setTurboFeeBps(uint256 bps) external onlyGovernor { require(bps <= 1000, "ArcVault: fee too high"); turboFeeBps = bps; emit FeeUpdated(bps); }
    function emergencyPause() external onlyOperator { paused = true; emit Paused(msg.sender); }
    function unpause() external onlyGovernor { paused = false; emit Unpaused(msg.sender); }

    // ── Internal ──────────────────────────────────────────────────────────────
    function _register(address asset, string memory symbol) internal {
        if (!assetInfo[asset].registered) {
            assetInfo[asset] = AssetInfo(true, symbol, 0, 0, 0);
            _assets.push(asset);
            emit AssetRegistered(asset, symbol);
        } else if (bytes(symbol).length > 0) {
            assetInfo[asset].symbol = symbol;
        }
    }
    function _send(address asset, address to, uint256 amount) internal {
        if (asset == NATIVE) { (bool ok, ) = to.call{value: amount}(""); require(ok, "ArcVault: native send failed"); }
        else { require(IERC20V(asset).transfer(to, amount), "ArcVault: transfer failed"); }
    }

    // ── Views / frontend helpers / batch reads ────────────────────────────────
    function getAssets() external view returns (address[] memory) { return _assets; }
    function getOperators() external view returns (address[] memory) { return _operators; }
    function operatorCount() external view returns (uint256) { return _operators.length; }

    struct AssetStat {
        address asset; string symbol; uint256 total; uint256 available;
        uint256 reserved; uint256 locked; uint256 pending; uint8 health;
    }
    function assetStat(address asset) public view returns (AssetStat memory s) {
        AssetInfo storage a = assetInfo[asset];
        s = AssetStat(asset, a.symbol, rawBalance(asset), getAvailableLiquidity(asset), a.reserved, a.locked, a.pending, assetHealth(asset));
    }
    function allAssetStats() external view returns (AssetStat[] memory list) {
        list = new AssetStat[](_assets.length);
        for (uint256 i = 0; i < _assets.length; i++) list[i] = assetStat(_assets[i]);
    }

    struct VaultSummary {
        string name; string version; address governor; bool paused;
        uint256 assetCount; uint256 operatorCount; uint256 turboFeeBps;
    }
    function summary() external view returns (VaultSummary memory) {
        return VaultSummary(NAME, VERSION, governor, paused, _assets.length, _operators.length, turboFeeBps);
    }

    // ── ERC165 ────────────────────────────────────────────────────────────────
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7; // ERC165
    }
}
