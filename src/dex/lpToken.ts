// ============================================================
// ARC DEX — LP Token
// Models ERC-20 LP token supply and balances
// (In production this would be deployed as a Solidity contract)
//
// Solidity equivalent:
//   contract LPToken is ERC20 {
//     constructor(string name, string symbol) ERC20(name, symbol) {}
//     function mint(address to, uint256 amount) external onlyPool { ... }
//     function burn(address from, uint256 amount) external onlyPool { ... }
//   }
// ============================================================

export interface LPTokenInfo {
  poolId:         string;
  name:           string;
  symbol:         string;
  totalSupply:    number;
  decimals:       number;
}

export function createLPTokenInfo(poolId: string): LPTokenInfo {
  const [tokenA, tokenB] = poolId.split('-');
  return {
    poolId,
    name:        `ARC LP ${tokenA}/${tokenB}`,
    symbol:      `ARC-LP-${tokenA}-${tokenB}`,
    totalSupply: 0,
    decimals:    6,
  };
}

// ─── LP balance for a wallet ──────────────────────────────────────────────────
export function getLPBalance(
  poolId:    string,
  wallet:    string,
  positions: { wallet: string; lpTokens: number; poolId: string }[]
): number {
  const pos = positions.find(
    p => p.poolId === poolId && p.wallet.toLowerCase() === wallet.toLowerCase()
  );
  return pos?.lpTokens ?? 0;
}
