# ExecDaat Threat Model

## System Assets

| Asset | Value | Custodian | Exposure |
|-------|-------|-----------|----------|
| User funds (USDC/EURC) | User-owned | User wallet | On-chain |
| Treasury vault liquidity | Operator-managed | ArcVault contract | On-chain |
| Relayer private key | Gasless tx signing | Cloudflare Secrets | Server-side |
| Operator private key | Vault settlement | Cloudflare Secrets | Server-side |
| ArcTreasury signers | Governance control | Multisig wallets | On-chain |
| Contract ownership | Admin functions | Deployer wallets | On-chain |
| API secrets (OpenAI, Circle) | Service access | Cloudflare Secrets | Server-side |
| HMAC secret | Treasury auth | Cloudflare Secrets | Server-side |

## Attack Surfaces

### Frontend

| Surface | Risk | Mitigation | Remaining Risk |
|---------|------|------------|----------------|
| Wallet connection (MetaMask/EIP-1193) | Malicious provider injection | EIP-6963 multi-provider detection, origin check | Medium: user must verify provider |
| User inputs (amounts, addresses) | XSS, injection | arcEscapeHtml, arcSanitizeInput, WAF middleware | Low |
| Browser storage (localStorage, sessionStorage) | Data exfiltration | Masked storage for sensitive keys, no private keys stored | Low |
| External scripts (CDN: Tailwind, ethers, FontAwesome, jsPDF) | Supply chain compromise | SRI-ready, MutationObserver monitoring, allowed-origin whitelist | Medium: CDN dependency |
| Dynamic HTML (innerHTML) | Stored XSS | Phase 1: showToast sanitized, arcEscapeHtml available | Low |
| Drag-and-drop (CSV, proofs) | Malicious file upload | Client-side validation, server-side WAF | Low |

### Backend (Cloudflare Workers / Vercel)

| Surface | Risk | Mitigation | Remaining Risk |
|---------|------|------------|----------------|
| API endpoints (/api/*) | Unauthorized access, injection | Rate limiting, WAF (XSS/SQLi/SSRF/path traversal), CORS allowlist | Low |
| /api/chat | Prompt injection, data exfiltration | Server-side input sanitization, clampString | Medium: LLM risks |
| /api/treasury, /api/core/v1/* | Treasury manipulation | HMAC authentication, endpoint whitelist, stripSecretFields | Low |
| /api/settings | API key exposure | Keys never returned to browser (masked), server-side only | Low |
| Authentication | Credential theft | HMAC-SHA256 with timestamp+nonce+replay protection | Low |
| Rate limits | DoS | Per-endpoint sliding window (20-200 req/min), 5-min block | Low |

### Blockchain

| Surface | Risk | Mitigation | Remaining Risk |
|---------|------|------------|----------------|
| Smart contracts | Reentrancy, access control, logic bugs | Phase 7: ReentrancyGuard on all contracts, CEI pattern, custom errors | Low |
| SimpleAMM | Flash loan manipulation, no TWAP | Phase 7: nonReentrant, deadline, slippage. No oracle yet. | Medium: oracle recommended |
| ArcVault | Unauthorized settlement | Operator whitelist, governor-gated admin, emergency pause | Low |
| ArcTreasury | Governance takeover | Threshold multisig, onlySelf admin, emergency pause | Low |
| OTCEscrow | Fund lock, dispute abuse | OZ ReentrancyGuard, 8-state machine, arbiter-gated resolution, dual-consent cancel | Low |
| Token approvals | Infinite approval risk | ContractFactory checks allowance before transferFrom | Low |
| RPC manipulation | Transaction censorship, frontrunning | 4 RPC fallbacks, circuit breaker, health monitoring (Phase 4) | Medium: RPC provider trust |

## Threat Categories

### Reentrancy
- **Risk:** High before Phase 7, Low after
- **Contracts affected:** SimpleAMM, ContractFactory, EscrowWallet
- **Mitigation:** Self-contained nonReentrant guards on all state-mutating functions
- **Remaining:** None (all protected)

### Access Control Abuse
- **Risk:** Medium
- **Contracts:** ArcVault (operators), ArcTreasury (signers), OTCEscrow (arbiter)
- **Mitigation:** Explicit modifiers, role separation, governor-only admin
- **Remaining:** Governance timelock recommended

### Key Compromise
- **Risk:** High
- **Affected:** Relayer key, operator key, deployer keys
- **Mitigation:** Cloudflare Secrets (encrypted at rest), rotation procedures, incident response plan
- **Remaining:** Human error in key management

### RPC Manipulation
- **Risk:** Medium
- **Affected:** All on-chain reads
- **Mitigation:** 4 RPC fallbacks, circuit breaker, health monitoring
- **Remaining:** Trust in RPC providers

### Oracle Manipulation
- **Risk:** Medium
- **Affected:** SimpleAMM (no on-chain price feed)
- **Mitigation:** Slippage guards, deadline protection
- **Remaining:** No TWAP oracle (Phase 8 future)

### Frontend Injection
- **Risk:** Low
- **Affected:** User inputs, toast messages, dynamic HTML
- **Mitigation:** arcEscapeHtml, WAF, CSP, X-Content-Type-Options
- **Remaining:** CDN dependency risk

### Denial of Service
- **Risk:** Low
- **Affected:** API endpoints, RPC access
- **Mitigation:** Rate limiting, RPC fallback, circuit breaker
- **Remaining:** Cloudflare-level DDoS (mitigated by platform)

## Risk Matrix Summary

| Threat | Likelihood | Impact | Risk Level |
|--------|-----------|--------|------------|
| Key compromise | Low | Critical | High |
| Smart contract exploit | Low | Critical | High |
| RPC manipulation | Medium | Medium | Medium |
| Oracle manipulation | Medium | Medium | Medium |
| Frontend XSS | Low | Medium | Low |
| DoS | Low | Low | Low |
| Supply chain (CDN) | Low | Medium | Low |
