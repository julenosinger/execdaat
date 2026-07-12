# ExecDaat Deployment Security

## Deployment Platforms

| Platform | URL | Purpose |
|----------|-----|---------|
| Cloudflare Pages | `execdaatplataform.pages.dev` | Production |
| Vercel | `execdaatplataform.vercel.app` | Fallback |

## Required Secrets

### Cloudflare Secrets (`wrangler secret put`)

| Secret | Purpose | Rotation |
|--------|---------|----------|
| `OPENAI_API_KEY` | AI chatbot (gpt-5-mini) | Quarterly |
| `CIRCLE_API_KEY` | Circle CCTP bridge API | Quarterly |
| `CIRCLE_WEBHOOK_SECRET` | Circle webhook verification | On compromise |
| `TREASURY_CORE_URL` | Elligent Treasury Core URL | As needed |
| `TREASURY_APPLICATION_SECRET` | HMAC auth for Treasury | Quarterly |
| `TURBO_RELAYER_PRIVATE_KEY` | Turbo Bridge deposit signing | Monthly |
| `OPERATOR_PRIVATE_KEY` | ArcVault settlement signing | Monthly |
| `RELAYER_PRIVATE_KEY` | Gasless execution (AgentExecutor) | Monthly |
| `AGENT_INTENTS` | KV namespace binding | N/A |

### Environment Variables (Vercel)

Same as above, set via Vercel dashboard → Environment Variables.

### Local Development

```bash
# Never commit these files
.env          # local env vars
.dev.vars     # Cloudflare Workers local vars
.my-deployer.json  # deployer private key (TEST ONLY)
```

## Deployment Process

### 1. Pre-deploy Checklist

```bash
npm test                 # All tests pass
npm run security:scan    # No secrets found
npm run build           # Build succeeds
```

### 2. Deploy (Cloudflare Pages)

```bash
npm run deploy
# or manually:
npx wrangler pages deploy dist --project-name execdaatplataform
```

### 3. Deploy (Vercel)

```bash
vercel --prod
```

### 4. Post-deploy Verification

- [ ] Preview URL loads correctly
- [ ] Wallet connection works
- [ ] Network switch works
- [ ] All API endpoints respond
- [ ] Shared modules loaded (check `window.ExecDaat.CHAIN` in console)

## Rollback Procedure

### Cloudflare Pages

```bash
# List deployments
npx wrangler pages deployment list --project-name execdaatplataform

# Rollback to specific deployment
npx wrangler pages deployment rollback <deployment-id> --project-name execdaatplataform
```

### Vercel

Use Vercel dashboard → Deployments → select previous deployment → Promote to Production.

## Emergency Procedure

### If private key is exposed:

1. Immediately rotate via `wrangler secret put <NAME>`
2. Transfer funds from old wallet to new wallet
3. Update on-chain operator references if needed
4. Redeploy backend

### If contract is compromised:

1. Call `emergencyPause()` on ArcVault
2. Call `emergencyPause()` on ArcTreasury
3. Notify users via official channels
4. Begin incident response (see INCIDENT_RESPONSE.md)

## Security Baseline

| Check | Status |
|-------|--------|
| No `.env` in repo | Confirmed (.gitignore) |
| No `.dev.vars` in repo | Confirmed |
| No private keys in source | Confirmed (Phase 1) |
| No private keys in docs | Confirmed (Phase 1) |
| No private keys in build artifacts | Confirmed |
| CSP headers configured | Yes (security middleware) |
| CORS restricted | Yes (allowlist) |
| Rate limiting | Yes (per-endpoint) |
| API authentication | HMAC (Treasury), Bearer (Chat/Circle) |
