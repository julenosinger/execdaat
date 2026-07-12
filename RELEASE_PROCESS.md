# ExecDaat Release Process

## Pre-Release Checklist

```bash
# 1. Security scan
npm run security:scan

# 2. Run all tests
npm test

# 3. Build
npm run build

# 4. Deployment validation
node scripts/deployment-check.cjs

# 5. Contract verification
# Verify on-chain contracts match CONTRACT_REGISTRY.md
```

## Release Steps

### 1. Create Release Branch

```bash
git checkout -b release/vX.Y.Z
git push origin release/vX.Y.Z
```

### 2. Verify CI Pipeline

Wait for GitHub Actions to complete:
- Security Scan PASS
- Unit Tests PASS
- Integration Tests PASS
- Build PASS

### 3. Deploy to Staging (if available)

```bash
npx wrangler pages deploy dist --project-name execdaatapp-v2 --branch staging
```

### 4. Smoke Test Staging

- [ ] Page loads without errors
- [ ] Wallet connection works
- [ ] Network switch works
- [ ] API health endpoint responds
- [ ] Shared modules loaded (check console: `window.ExecDaat.CHAIN.ID`)
- [ ] No console errors

### 5. Deploy to Production

```bash
npm run deploy
# or:
npx wrangler pages deploy dist --project-name execdaatplataform
```

### 6. Post-Deploy Verification

- [ ] Production URL loads
- [ ] Wallet connect/disconnect works
- [ ] Treasury data loads
- [ ] Bridge works
- [ ] Swap works
- [ ] Chat responds
- [ ] Health check: `curl https://execdaatplataform.pages.dev/api/health`

### 7. Monitor

- Monitor Cloudflare analytics for error spikes
- Check RPC health (browser console: `window.ExecDaat.getRPCMetrics()`)
- Verify contract monitor is running

## Rollback

```bash
# Cloudflare Pages
npx wrangler pages deployment list --project-name execdaatplataform
npx wrangler pages deployment rollback <prev-deploy-id> --project-name execdaatplataform
```

## Release Notes Template

```
## vX.Y.Z — [Date]

### Changes
- [List changes]

### Security
- [Security-related changes]

### Breaking Changes
- None (or list)

### Upgrade Notes
- No action required (or instructions)
```
