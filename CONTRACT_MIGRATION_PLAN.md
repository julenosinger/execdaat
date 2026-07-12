# ExecDaat Contract Migration Plan

## Overview

Phase 7 introduces security hardening to Solidity contracts. All changes are backward-compatible — existing ABIs preserved.

## Changes Summary

| Contract | Change | Breaking? | Action Required |
|----------|--------|-----------|-----------------|
| SimpleAMM | Added ReentrancyGuard | No | Redeploy |
| SimpleAMM | Added deadline overloads (swapAforB/BforA + deadline) | No | Frontend upgrade optional |
| ContractFactory | Added ReentrancyGuard | No | Redeploy |
| ContractFactory | Added expiresAt field to WorkContract (default 0) | No | No migration needed |
| EscrowWallet | Added ReentrancyGuard | No | Redeploy (new deployments only) |
| EscrowWallet | Added expiresAt + recoverExpired() | No | No migration needed |
| EscrowWallet | Added Expired state to EscrowState enum | No | Existing states unchanged |

## Detailed Changes

### SimpleAMM

**Before:** No reentrancy protection, no swap deadline
**After:** nonReentrant on all state-mutating functions, deadline-protected swap overloads

```solidity
// v1 — still works (no deadline)
swapAforB(uint256 amountA, uint256 minOut)

// v2 — new overload with deadline protection
swapAforB(uint256 amountA, uint256 minOut, uint256 deadline)
```

**Migration:** Frontend can optionally pass deadline for v2 protection. v1 calls continue working unchanged.

### ContractFactory

**Before:** No reentrancy protection
**After:** nonReentrant on createContract, completeMilestone, cancelContract

**New field:** `WorkContract.expiresAt` — defaults to 0 (no expiration). Existing contracts unaffected.

### EscrowWallet

**Before:** No reentrancy protection, no timeout
**After:** nonReentrant on deposit, release, dispute, refund, recovery

**New features:**
- `expiresAt` state variable (default 0 = no expiration)
- `recoverExpired()` — client reclaims funds after expiration
- `EscrowState.Expired` — new state (existing states unchanged)
- `EscrowExpired` and `RecoveryExecuted` events

**Migration:** No migration needed for existing escrows. `expiresAt` is 0 by default (no expiration = same behavior as before).

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| SimpleAMM redeploy changes address | Frontend needs address update | Update shared/contracts.js |
| ContractFactory redeploy changes address | Frontend needs address update | Update shared/contracts.js |
| New enum values break ABI decoders | Frontend switch statements | New values added at end; existing ordinals unchanged |
| Reentrancy guard false positives | Legitimate call blocked | Standard pattern; same as OpenZeppelin |

## Deployment Order

1. Deploy updated SimpleAMM
2. Deploy updated ContractFactory
3. Update `public/static/shared/contracts.js` with new addresses
4. Deploy frontend
5. Verify all existing integrations

## Rollback

If issues detected:
1. Revert to previous contract addresses in shared/contracts.js
2. Previous contracts remain deployed (new contracts are separate deployments)
3. No data migration required
