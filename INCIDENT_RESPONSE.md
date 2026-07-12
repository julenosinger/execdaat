# ExecDaat Incident Response

## Severity Levels

| Level | Description | Response Time |
|-------|-------------|---------------|
| P0 | Critical — funds at risk, contract compromised, key exposed | Immediate |
| P1 | High — service down, RPC unavailable, bridge stuck | < 1 hour |
| P2 | Medium — feature broken, wrong display, non-critical error | < 24 hours |
| P3 | Low — cosmetic issue, minor bug, slow performance | Next sprint |

---

## P0 Response — Key/Contract Compromise

### 1. Contain (Immediate)

```bash
# Pause contracts
# ArcVault: call emergencyPause() from any operator wallet
# ArcTreasury: call emergencyPause() from any signer wallet

# Rotate exposed keys
wrangler secret put TURBO_RELAYER_PRIVATE_KEY   # new key
wrangler secret put OPERATOR_PRIVATE_KEY         # new key
wrangler secret put RELAYER_PRIVATE_KEY          # new key
```

### 2. Transfer Funds

Move remaining funds from compromised wallet to secure wallet.

### 3. Update On-Chain References

- Update operator list on ArcVault via ArcTreasury governance
- Update relayer list on AgentExecutor (if deployed)

### 4. Redeploy

```bash
npm run deploy
```

### 5. Communicate

- Post incident notice on official channels
- Update status page
- File post-mortem within 48 hours

---

## P1 Response — Service Outage

### 1. Diagnose

```bash
# Check RPC health
curl -X POST https://rpc.testnet.arc.network \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'

# Check Cloudflare status
# https://www.cloudflarestatus.com/

# Check app health
curl https://execdaatplataform.pages.dev/api/health
```

### 2. Recovery Options

| Issue | Action |
|-------|--------|
| RPC down | Automatic fallback to 3 alternatives (Phase 4) |
| Cloudflare down | Switch DNS to Vercel deployment |
| API error | Check Cloudflare logs via `wrangler tail` |
| Build issue | Rollback to previous deployment |

### 3. Rollback

```bash
npx wrangler pages deployment rollback <prev-id> --project-name execdaatplataform
```

---

## Emergency Contacts

| Role | Contact |
|------|---------|
| Security | `security@execdaat.com` |
| Platform | GitHub Issues: `julenosinger/execdaat` |

---

## Key Rotation Procedure

### Rotate Server Keys

```bash
# 1. Generate new wallet
node -e "const ethers=require('ethers'); const w=ethers.Wallet.createRandom(); console.log('Address:', w.address); console.log('Private Key:', w.privateKey);"

# 2. Fund new wallet (minimum gas)

# 3. Update Cloudflare secret
wrangler secret put OPERATOR_PRIVATE_KEY
# Paste new private key

# 4. Update on-chain operator
node scripts/register-operator.cjs
# Uses REGISTER_OPERATOR_KEY env var

# 5. Verify
# Check on-chain isOperator(newAddress)

# 6. Redeploy
npm run deploy
```

---

## Communication Template

```
INCIDENT: [Brief description]
SEVERITY: [P0/P1/P2/P3]
STATUS: [Investigating/Identified/Mitigating/Resolved]
IMPACT: [What users experience]
ACTIONS: [What we're doing]
NEXT UPDATE: [Time]
```

---

## Recovery Checklist

- [ ] Incident documented in post-mortem
- [ ] Root cause identified
- [ ] Fix implemented and tested
- [ ] Keys rotated if exposed
- [ ] Contracts unpaused if paused
- [ ] Users notified of resolution
- [ ] Monitoring enhanced to detect similar issues
