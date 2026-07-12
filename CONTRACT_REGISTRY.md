# ExecDaat Contract Registry

## Network: Arc Testnet (Chain ID 5042002)

| Contract | Address | Compiler | Optimization | Verified | Deploy Block |
|----------|---------|----------|-------------|----------|-------------|
| USDC (Native) | `0x3600000000000000000000000000000000000000` | — | — | Canonical | Genesis |
| EURC (ERC-20) | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` | — | — | Canonical | — |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | — | — | Canonical | — |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | — | — | Canonical | — |

### ExecDaat Contracts

| Contract | Address | Solc | Runs | ABI | Source |
|----------|---------|------|------|-----|--------|
| SimpleAMM | `0x3148E2807F172D1cC354F35fB4fC4104e8b6b561` | 0.8.20 | 200 | `out/SimpleAMM.json` | `src/SimpleAMM.sol` |
| ContractFactory | `0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A` | 0.8.20 | 200 | `out/ContractFactory.json` | `src/ContractFactory.sol` |
| OTCEscrow | (deployed) | 0.8.20 | 200 | `out/OTCEscrow_verified.sol` | `OTCEscrow.sol` |
| ArcVault | `0x1e039fF538Ed84Ad54610D644ca36D4b03167B87` | 0.8.24 | 200 | (on-chain) | `ArcVault.sol` |
| ArcTreasury | `0x1fd3cd592b58e838ab778Baa14f842EBEa52853D` | 0.8.24 | 200 | (on-chain) | `ArcTreasury.sol` |
| EscrowWallet | (factory-deployed) | 0.8.20 | 200 | (on-chain) | `EscrowWallet.sol` |
| EscrowRegistry | (deployed) | 0.8.20 | 200 | (on-chain) | `EscrowWallet.sol` |
| EscrowFactory | (deployed) | 0.8.20 | 200 | (on-chain) | `EscrowWallet.sol` |
| AgentExecutor | (not deployed) | 0.8.34 | 200 | `deploy-with-pk.mjs` | `AgentExecutor.sol` |

### Operator Addresses

| Role | Address | Purpose |
|------|---------|---------|
| Relayer | `0xFAd3edb1aAe40C16cd30987fCEc3C3d68aEb7F45` | Gasless transaction execution |
| Vault Owner | `0xA43ABD9Dc38840376d3C469bFBf5951912936c9f` | ArcVault emergency operator |
| ExecDaat Vault | `0x1e039fF538Ed84Ad54610D644ca36D4b03167B87` | Liquidity vault |
| Treasury Vault | `0xbfC9E8F79bd30b912081ae88F9ad0A515F08c2F1` | Secondary vault |
| Treasury Gov | `0x1fd3cd592b58e838ab778Baa14f842EBEa52853D` | Governance multisig |
| Fee Wallet (MS) | `0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A` | Multisend fee collection |

### CCTP Bridge Contracts

| Contract | Address | Chain |
|----------|---------|-------|
| TokenMessengerV2 | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` | Arc |
| Circle Transmitter | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` | Arc |

### File Locations

| Item | Path |
|------|------|
| Solidity sources | `contracts/*.sol`, `contracts/src/*.sol` |
| Compiled artifacts | `contracts/out/`, `contracts/hardhat/artifacts/` |
| Deployment scripts | `contracts/script/*.cjs`, `contracts/script/*.js` |
| Test ABIs (frontend) | `public/static/otc-escrow-abi.js` |
| Shared registry (frontend) | `public/static/shared/contracts.js` |
