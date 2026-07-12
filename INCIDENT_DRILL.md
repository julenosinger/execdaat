# ExecDaat Incident Drills

## Scenario 1: Relayer Key Compromise

### Trigger
Alert: Unauthorized transaction detected from relayer wallet.

### Detection
- Transaction monitoring shows unexpected outbound transfers
- Gas usage spike on relayer wallet
- `window.ExecDaat.health.components.rpc` shows degraded

### Response (P0 — Immediate)

```bash
# 1. Rotate key immediately
wrangler secret put RELAYER_PRIVATE_KEY
# Paste new key

# 2. Redeploy
npm run deploy

# 3. Transfer remaining funds from old relayer to secure wallet
# Old relayer: 0xFAd3edb1aAe40C16cd30987fCEc3C3d68aEb7F45

# 4. Verify new key works
# Check browser console: no RELAYER_PRIVATE_KEY not set errors
```

### Recovery
- Document incident in post-mortem
- Review key management procedures
- Consider hardware wallet for relayer

---

## Scenario 2: RPC Outage

### Trigger
Users report transactions stuck. Health check shows RPC degraded.

### Detection
- `window.ExecDaat.health.components.rpc.status = "down"`
- Circuit breaker open on all RPCs
- App shows "RPC unavailable" toasts

### Response (P1)

```bash
# Automatic mitigation (already implemented):
# Phase 4 RPC fallback — app tries 4 RPC endpoints
# Circuit breaker resets after 60s

# If all RPCs down:
# 1. Verify RPC status
curl -X POST https://rpc.testnet.arc.network \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'

# 2. If Arc network is down, wait for recovery
# 3. Communicate status
```

### Recovery
- RPCs recover automatically
- Circuit breaker resets when healthy
- Dashboard reverts to operational status

---

## Scenario 3: Contract Emergency (Pause)

### Trigger
Smart contract vulnerability detected. Requires immediate pause.

### Detection
- Security researcher report
- On-chain anomaly detection
- Community report

### Response (P0 — Immediate)

```javascript
// ArcVault emergency pause (any operator)
// Browser console with connected operator wallet:
// await vaultContract.emergencyPause()

// ArcTreasury emergency pause (any signer)
// await treasuryContract.emergencyPause()
```

### Recovery
1. Investigate root cause
2. Patch contract if needed
3. Redeploy fixed contract
4. Update `shared/contracts.js` with new address
5. Deploy frontend
6. Call `unpause()` (governor-only for ArcVault, proposal-only for ArcTreasury)
7. Communicate resolution

---

## Scenario 4: Frontend Vulnerability

### Trigger
XSS or injection vulnerability reported in frontend.

### Detection
- Security scanner report
- Bug bounty submission
- `window.arcSecurityLog` alert

### Response (P0-P2 depending on severity)

```bash
# 1. Assess severity
# 2. If critical: rollback to previous deployment
npx wrangler pages deployment rollback <prev-id> --project-name execdaatplataform

# 3. Fix in code
# 4. Test
npm test

# 5. Deploy fixed version
npm run deploy

# 6. Verify fix
```

### Recovery
- Post-mortem
- Add regression test for vulnerability class
- Update security documentation

---

## Drill Schedule

| Drill | Frequency | Owner |
|-------|-----------|-------|
| Key rotation | Quarterly | Security |
| RPC outage recovery | Monthly | DevOps |
| Contract pause/unpause | Biannually | Smart Contract |
| Incident response | Quarterly | All |

## After-Action Template

```
DRILL: [Scenario name]
DATE: [Date]
PARTICIPANTS: [Names]

WHAT WENT WELL:
-

WHAT NEEDS IMPROVEMENT:
-

ACTION ITEMS:
- [ ] Item 1
- [ ] Item 2

TIME TO DETECT: __ minutes
TIME TO RESPOND: __ minutes
TIME TO RECOVER: __ minutes
```
