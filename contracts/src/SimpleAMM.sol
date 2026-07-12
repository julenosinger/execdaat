// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
//  SimpleAMM v2 — Constant-Product AMM (x * y = k)
//  Arc Testnet · EURC / USDC pool
//
//  Phase 7 Hardening: ReentrancyGuard, deadline, input checks
//  Backward-compatible: existing function signatures preserved
//
//  EURC: 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a  (ERC-20, 6 dec)
//  USDC: 0x3600000000000000000000000000000000000000  (ERC-20, 6 dec)
//
//  Fee: 0.3 %  (997 / 1000)
//
//  Functions (v1 preserved):
//    addLiquidity(amountA, amountB)    → mint LP tokens
//    removeLiquidity(lpAmount)         → burn LP, return tokens
//    swapAforB(amountA, minOut)        → EURC → USDC
//    swapBforA(amountB, minOut)        → USDC → EURC
//    getAmountOut(amountIn, rIn, rOut) → pure AMM quote
//
//  Functions (v2 — deadline-protected overloads):
//    swapAforB(amountA, minOut, deadline)
//    swapBforA(amountB, minOut, deadline)
// ============================================================

interface IERC20 {
    function totalSupply()                                          external view returns (uint256);
    function balanceOf(address account)                             external view returns (uint256);
    function transfer(address to, uint256 amount)                   external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount)               external returns (bool);
    function allowance(address owner, address spender)              external view returns (uint256);
}

contract SimpleAMM {
    // ── Tokens ─────────────────────────────────────────────────────────────
    IERC20 public immutable tokenA; // EURC
    IERC20 public immutable tokenB; // USDC

    // ── AMM State ──────────────────────────────────────────────────────────
    uint256 public reserveA;         // EURC reserve (6 dec)
    uint256 public reserveB;         // USDC reserve (6 dec)

    // ── LP Token (internal ERC-20-lite) ────────────────────────────────────
    string  public constant name     = "ARC-LP-EURC-USDC";
    string  public constant symbol   = "ARC-LP";
    uint8   public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    // ── Fee constant ───────────────────────────────────────────────────────
    uint256 private constant FEE_NUM   = 997;
    uint256 private constant FEE_DENOM = 1000;
    uint256 private constant MINIMUM_LIQUIDITY = 1000; // locked forever

    // ── Reentrancy guard (self-contained, no imports) ──────────────────────
    uint256 private _guard = 1;
    modifier nonReentrant() { require(_guard == 1, "AMM: reentrant"); _guard = 2; _; _guard = 1; }

    // ── Events ─────────────────────────────────────────────────────────────
    event LiquidityAdded(
        address indexed provider,
        uint256 amountA,
        uint256 amountB,
        uint256 lpMinted,
        uint256 reserveA,
        uint256 reserveB
    );
    event LiquidityRemoved(
        address indexed provider,
        uint256 amountA,
        uint256 amountB,
        uint256 lpBurned,
        uint256 reserveA,
        uint256 reserveB
    );
    event Swap(
        address indexed trader,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 reserveA,
        uint256 reserveB
    );
    event Transfer(address indexed from, address indexed to, uint256 value);

    // ── Constructor ────────────────────────────────────────────────────────
    constructor(address _tokenA, address _tokenB) {
        require(_tokenA != address(0) && _tokenB != address(0), "Zero address");
        require(_tokenA != _tokenB, "Same token");
        tokenA = IERC20(_tokenA);
        tokenB = IERC20(_tokenB);
    }

    // ── Internal LP mint/burn ──────────────────────────────────────────────
    function _mint(address to, uint256 amount) internal {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function _burn(address from, uint256 amount) internal {
        require(balanceOf[from] >= amount, "Insufficient LP balance");
        balanceOf[from] -= amount;
        totalSupply      -= amount;
        emit Transfer(from, address(0), amount);
    }

    // ── Integer sqrt (Babylonian) ──────────────────────────────────────────
    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) { z = x; x = (y / x + x) / 2; }
        } else if (y != 0) {
            z = 1;
        }
    }

    // ── getAmountOut (pure, no side effects) ──────────────────────────────
    /// @notice  Constant-product quote with 0.3 % fee
    /// @param   amountIn  raw token units (6 decimals)
    /// @param   rIn       reserve of input token
    /// @param   rOut      reserve of output token
    /// @return  amountOut raw token units
    function getAmountOut(
        uint256 amountIn,
        uint256 rIn,
        uint256 rOut
    ) public pure returns (uint256 amountOut) {
        require(amountIn > 0,  "AmountIn must be > 0");
        require(rIn  > 0 && rOut > 0, "Empty reserves");
        uint256 amountInWithFee = amountIn * FEE_NUM;
        uint256 numerator       = amountInWithFee * rOut;
        uint256 denominator     = rIn * FEE_DENOM + amountInWithFee;
        amountOut = numerator / denominator;
    }

    // ── addLiquidity ────────────────────────────────────────────────────────
    /// @notice  Deposit amountA (EURC) + amountB (USDC) → receive LP tokens.
    ///          Caller must approve this contract on both tokens first.
    function addLiquidity(uint256 amountA, uint256 amountB)
        external
        nonReentrant
        returns (uint256 lpMinted)
    {
        require(amountA > 0 && amountB > 0, "Amounts must be > 0");

        // Pull tokens from caller
        require(tokenA.transferFrom(msg.sender, address(this), amountA), "TransferFrom A failed");
        require(tokenB.transferFrom(msg.sender, address(this), amountB), "TransferFrom B failed");

        // Mint LP tokens
        if (totalSupply == 0) {
            // First liquidity: LP = sqrt(amountA * amountB) - MINIMUM_LIQUIDITY
            lpMinted = _sqrt(amountA * amountB);
            require(lpMinted > MINIMUM_LIQUIDITY, "Insufficient initial liquidity");
            _mint(address(0), MINIMUM_LIQUIDITY); // lock forever
            lpMinted -= MINIMUM_LIQUIDITY;
        } else {
            // Subsequent: proportional to existing reserves
            uint256 lpFromA = (amountA * totalSupply) / reserveA;
            uint256 lpFromB = (amountB * totalSupply) / reserveB;
            lpMinted = lpFromA < lpFromB ? lpFromA : lpFromB;
        }

        require(lpMinted > 0, "Zero LP minted");
        _mint(msg.sender, lpMinted);

        // Update reserves
        reserveA += amountA;
        reserveB += amountB;

        emit LiquidityAdded(msg.sender, amountA, amountB, lpMinted, reserveA, reserveB);
    }

    // ── removeLiquidity ─────────────────────────────────────────────────────
    /// @notice  Burn lpAmount LP tokens → receive proportional tokenA + tokenB.
    function removeLiquidity(uint256 lpAmount)
        external
        nonReentrant
        returns (uint256 amountA, uint256 amountB)
    {
        require(lpAmount > 0,                      "LP amount must be > 0");
        require(balanceOf[msg.sender] >= lpAmount, "Insufficient LP balance");
        require(totalSupply > 0,                   "No liquidity");

        amountA = (lpAmount * reserveA) / totalSupply;
        amountB = (lpAmount * reserveB) / totalSupply;
        require(amountA > 0 && amountB > 0, "Insufficient liquidity burned");

        _burn(msg.sender, lpAmount);
        reserveA -= amountA;
        reserveB -= amountB;

        require(tokenA.transfer(msg.sender, amountA), "Transfer A failed");
        require(tokenB.transfer(msg.sender, amountB), "Transfer B failed");

        emit LiquidityRemoved(msg.sender, amountA, amountB, lpAmount, reserveA, reserveB);
    }

    // ── swapAforB (EURC → USDC) — v1 (no deadline, preserved) ────────────
    /// @param amountA   exact amount of EURC to sell (6 dec)
    /// @param minOut    minimum USDC to receive (slippage guard)
    function swapAforB(uint256 amountA, uint256 minOut)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        require(amountA > 0, "AmountIn must be > 0");
        require(reserveA > 0 && reserveB > 0, "Pool empty");

        amountOut = getAmountOut(amountA, reserveA, reserveB);
        require(amountOut >= minOut, "Slippage exceeded");

        require(tokenA.transferFrom(msg.sender, address(this), amountA), "TransferFrom A failed");
        require(tokenB.transfer(msg.sender, amountOut), "Transfer B failed");

        reserveA += amountA;
        reserveB -= amountOut;

        emit Swap(msg.sender, address(tokenA), address(tokenB), amountA, amountOut, reserveA, reserveB);
    }

    // ── swapAforB with deadline (v2 overload) ─────────────────────────────
    function swapAforB(uint256 amountA, uint256 minOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        require(block.timestamp <= deadline, "AMM: deadline expired");
        require(amountA > 0, "AmountIn must be > 0");
        require(reserveA > 0 && reserveB > 0, "Pool empty");

        amountOut = getAmountOut(amountA, reserveA, reserveB);
        require(amountOut >= minOut, "Slippage exceeded");

        require(tokenA.transferFrom(msg.sender, address(this), amountA), "TransferFrom A failed");
        require(tokenB.transfer(msg.sender, amountOut), "Transfer B failed");

        reserveA += amountA;
        reserveB -= amountOut;

        emit Swap(msg.sender, address(tokenA), address(tokenB), amountA, amountOut, reserveA, reserveB);
    }

    // ── swapBforA (USDC → EURC) — v1 (no deadline, preserved) ────────────
    function swapBforA(uint256 amountB, uint256 minOut)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        require(amountB > 0, "AmountIn must be > 0");
        require(reserveA > 0 && reserveB > 0, "Pool empty");

        amountOut = getAmountOut(amountB, reserveB, reserveA);
        require(amountOut >= minOut, "Slippage exceeded");

        require(tokenB.transferFrom(msg.sender, address(this), amountB), "TransferFrom B failed");
        require(tokenA.transfer(msg.sender, amountOut), "Transfer A failed");

        reserveB += amountB;
        reserveA -= amountOut;

        emit Swap(msg.sender, address(tokenB), address(tokenA), amountB, amountOut, reserveA, reserveB);
    }

    // ── swapBforA with deadline (v2 overload) ─────────────────────────────
    function swapBforA(uint256 amountB, uint256 minOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        require(block.timestamp <= deadline, "AMM: deadline expired");
        require(amountB > 0, "AmountIn must be > 0");
        require(reserveA > 0 && reserveB > 0, "Pool empty");

        amountOut = getAmountOut(amountB, reserveB, reserveA);
        require(amountOut >= minOut, "Slippage exceeded");

        require(tokenB.transferFrom(msg.sender, address(this), amountB), "TransferFrom B failed");
        require(tokenA.transfer(msg.sender, amountOut), "Transfer A failed");

        reserveB += amountB;
        reserveA -= amountOut;

        emit Swap(msg.sender, address(tokenB), address(tokenA), amountB, amountOut, reserveA, reserveB);
    }

    // ── View helpers ────────────────────────────────────────────────────────
    function getReserves() external view returns (uint256 _reserveA, uint256 _reserveB) {
        return (reserveA, reserveB);
    }

    function getLPBalance(address user) external view returns (uint256) {
        return balanceOf[user];
    }

    /// @notice  Quote swapAforB without state change
    function quoteAforB(uint256 amountA) external view returns (uint256) {
        if (reserveA == 0 || reserveB == 0) return 0;
        return getAmountOut(amountA, reserveA, reserveB);
    }

    /// @notice  Quote swapBforA without state change
    function quoteBforA(uint256 amountB) external view returns (uint256) {
        if (reserveA == 0 || reserveB == 0) return 0;
        return getAmountOut(amountB, reserveB, reserveA);
    }

    /// @notice  Price impact in basis points (1 bp = 0.01%)
    function priceImpactBps(uint256 amountIn, bool aToB) external view returns (uint256) {
        if (reserveA == 0 || reserveB == 0) return 0;
        uint256 rIn  = aToB ? reserveA : reserveB;
        uint256 rOut = aToB ? reserveB : reserveA;
        uint256 idealOut = (amountIn * rOut) / rIn;        // without fee / impact
        uint256 realOut  = getAmountOut(amountIn, rIn, rOut);
        if (idealOut == 0) return 0;
        return ((idealOut - realOut) * 10_000) / idealOut; // bps
    }
}
