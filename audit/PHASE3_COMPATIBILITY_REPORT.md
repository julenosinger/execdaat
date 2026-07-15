# PHASE 3 — SimpleAMM Compatibility Report (Internal)

**Date:** 2026-07-15
**Contract:** `0x3148E2807F172D1cC354F35fB4fC4104e8b6b561` (Arc Testnet, chainId 5042002)
**Method:** `eth_getCode` bytecode selector scan (5,739 bytes deployed) + repo source diff (`contracts/src/SimpleAMM.sol`)

## 1. Deployed contract profile

| Capability | Selector | Deployed? |
|---|---|---|
| `swapAforB(uint256,uint256)` (v1, no deadline) | `0x140e6247` | ✅ |
| `swapBforA(uint256,uint256)` (v1, no deadline) | `0xc915cc24` | ✅ |
| `swapAforB(uint256,uint256,uint256)` (v2 deadline) | `0xbd5fd41c` | ❌ |
| `swapBforA(uint256,uint256,uint256)` (v2 deadline) | `0xd8f4d44b` | ❌ |
| `addLiquidity(uint256,uint256)` | `0x9cd441da` | ✅ |
| `removeLiquidity(uint256)` | `0x9c8f9f23` | ✅ |
| `getAmountOut(uint256,uint256,uint256)` | `0x054d50d4` | ✅ |
| `getReserves()` | `0x0902f1ac` | ✅ |
| `getLPBalance(address)` | `0xd2258beb` | ✅ |
| `quoteAforB(uint256)` / `quoteBforA(uint256)` | `0x0b4a945e` / `0xd9497f00` | ✅ |
| `priceImpactBps(uint256,bool)` | `0x5d1257e8` | ✅ |
| ERC-20-lite LP (`name/symbol/decimals/totalSupply/balanceOf`) | — | ✅ |
| `price0CumulativeLast` / `price1CumulativeLast` (TWAP accumulators) | `0x5909c0d5` / `0x5a3d5493` | ❌ |
| `sync()` / `skim(address)` | `0xfff6cae9` / `0xbc25cf77` | ❌ |
| `kLast()` | `0x7464fc3d` | ❌ |

**Conclusion:** the deployed bytecode is the **v1 (pre-Phase-7)** contract. The repo source (`SimpleAMM.sol`) already contains the v2 deadline overloads, but they were never deployed.

## 2. Upgradeability

- **NOT upgradeable.** Direct deployment (no proxy pattern, no `delegatecall` dispatch, no admin/owner functions, immutable token addresses in constructor).
- No pause, no governance, no rescue functions.
- **Therefore: liquidity migration is FORBIDDEN in this phase (per mandate) and impossible without a new deployment. All Phase 3 improvements are implemented off-chain in helper modules.**

## 3. What can/cannot be safely extended

| Area | Verdict |
|---|---|
| Read-only analytics (reserves, LP, health, risk, depth) | ✅ Safe — pure `eth_call`, zero liquidity impact |
| Deadline enforcement on-chain | ❌ Impossible (v2 overloads not deployed) → implemented at **quote layer** (deadline/expiry metadata) and **execution layer** (receipt verification, Phase 1). Frontend unchanged (mandate). |
| Add-liquidity ratio protection on-chain | ❌ Impossible (no refund logic deployed) → **Liquidity Ratio Analyzer** (informational API, pre-submission) |
| `sync`/`skim` of the 5.798953 USDC surplus | ❌ Impossible — surplus is permanently locked; monitored read-only by the Donation Engine (Phase 2) |
| Helper contracts | Possible but NOT required for Phase 3 (all metrics achievable off-chain); deferred |

## 4. TWAP feasibility analysis (Part 7)

- **On-chain cumulative price data: DOES NOT EXIST** (no `price*CumulativeLast`, no `kLast`, no per-block accumulator writes).
- **On-chain TWAP with the deployed AMM: NOT FEASIBLE.** Any retrofit requires a new contract → forbidden (migration).
- **Helper observer contract:** possible (periodic spot sampling), but samples are single-block spot prices → flash-loan manipulable; low value; NOT recommended.
- **Off-chain TWAP oracle: FEASIBLE.** `Swap`, `LiquidityAdded`, `LiquidityRemoved` events all emit post-event reserves; an indexer over `eth_getLogs` (10,000-block windows on Arc RPC) can reconstruct the full reserve time series and compute TWAP with block timestamps. Recommended path for a future phase; requires persistent storage (KV/D1) — out of Phase 3 scope.

**Feasibility verdict:** `ON_CHAIN: NOT_FEASIBLE` · `OFF_CHAIN_INDEXER: FEASIBLE (future phase)` · **No migration triggered.**

## 5. Phase 3 implementation decisions

1. `pool-analytics.mjs` — canonical `PoolAnalyticsSnapshot` built on the Phase 2 verified DEX cache (single RPC snapshot shared by all endpoints; memoized per block).
2. LP Analytics Engine — read-only (supply, share %, value, withdrawal estimate, growth index, min-liquidity lock, LP health).
3. Liquidity Ratio Analyzer — informational verdict `OPTIMAL` / `WARNING: EXCESS TOKENS WILL BE DONATED`; no tx modification, no refunds.
4. Risk Engine — LOW/MODERATE/HIGH/CRITICAL, informational only. LP holder concentration reported as `unavailable` (LP token has no holder enumeration/Transfer indexing on-chain).
5. Runtime capability probe (`eth_getCode` selector scan, memoized) feeds `deadlineSupportedOnChain` flags so the stack self-adapts if the AMM address is ever re-pointed to a v2 deployment.
6. Deadline protection: quote responses carry `deadlineSuggestion` + `quoteExpiresAt`; on-chain enforcement documented as unavailable for the v1 contract.
