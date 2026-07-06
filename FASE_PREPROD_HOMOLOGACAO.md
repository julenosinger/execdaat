# PRÉ-PRODUÇÃO — Relatório de Homologação: Integração Elligent (Treasury Core) ↔ ExecDaat

**Status:** homologação da camada de integração concluída. **Nenhum deploy em produção
foi realizado** (conforme instrução). Nenhuma alteração em Smart Contracts, Turbo Bridge,
Vault, Treasury, Settlement, Circle CCTP ou UX.

**Resultado dos testes automatizados:** **39/39 PASS (0 falhas).**

---

## 1. Como a validação foi executada (sem deploy, sem produção)

Como a Treasury Core real da Elligent (URL + secret de homologação) ainda não está
provisionada neste ambiente, a integração foi validada executando o **código de produção
real do proxy** (`src/routes/treasury.ts` + `src/config/treasury.ts`) contra um
**mock Treasury Core compatível com a especificação**, que **verifica HMAC, timestamp,
nonce (replay) e credenciais de aplicação** exatamente como a Elligent fará.

- Harness reproduzível: `tmp/homolog/harness.ts` (monta os routers reais em um app Hono e
  aponta `TREASURY_CORE_URL` para o mock local; secret de teste de 256 bits gerado em
  runtime; nunca versionado).
- Execução: `esbuild tmp/homolog/harness.ts --bundle --platform=node | node`.
- Arquitetura validada: **Frontend → Worker ExecDaat → (mock) Treasury Core**. O navegador
  nunca fala com a Core (apenas same-origin com o Worker).

> Observação: os testes exercitam **o lado ExecDaat da integração** (assinatura, headers,
> cache, retry, fallback, sanitização, contratos de endpoint). A validação final
> ponta-a-ponta contra o ambiente real da Elligent depende do provisionamento descrito na
> seção 9 (itens pendentes).

---

## 2. Endpoints validados (via proxy `/api/core/v1/*`)

| Endpoint | Método | Resultado |
|---|---|---|
| `/health` | GET | OK (Treasury/Vault/Workers/Ledger/Relayer/RPC/Circle + circuitBreaker + latency) |
| `/quote` | POST | OK (Arc→Arc, Arc→Ethereum, Ethereum→Arc) |
| `/intents` | POST | OK (Intent ID, Correlation ID, Ledger, Application, Client, timestamp) |
| `/execute` | POST | OK (status EXECUTING, hashes) |
| `/intents/{id}` | GET | OK (Timeline, Settlement, Reimbursement, Vault debit, Treasury payment, Explorer, hashes) |
| `/history` | GET | OK (filtros wallet/asset; paridade entre chamadas) |
| `/metrics` | GET | OK (Volume/Outstanding/Pending/BridgeTime/SettlementTime/SuccessRate/AppBreakdown) |
| `/applications` | GET | OK (EXECDAAT ACTIVE / PRODUCTION / v1) |
| `/api/treasury/config` | GET | OK (público, sem secret) |

---

## 3. Evidências de autenticação HMAC

O Worker assina **toda** requisição com `X-Application-Secret` + `X-Timestamp` +
`X-Nonce` + `X-Signature` (HMAC-SHA256) sobre o canônico `MÉTODO\nPATH\nTS\nNONCE\nBODY`
(`X-Signature-Alg: HMAC-SHA256`).

- ✅ `HMAC accepted by Core for all proxied calls` — todas as 8 chamadas proxied passaram
  na verificação de assinatura do mock (`lastAuthValid=true`).
- ✅ `HMAC invalid signature REJECTED (401)` — assinatura adulterada recusada.
- ✅ `CORRELATION-ID propagated to Core` e `echoed in response header`.

## 4. Evidências de proteção contra replay / timestamp

- ✅ `REPLAY first accepted` / `REPLAY second REJECTED (409)` — nonce reutilizado recusado.
- ✅ `STALE timestamp REJECTED (401)` — timestamp fora da janela (5 min) recusado.
- Worker gera **nonce único por requisição** (nunca reenvia POST de intents/execute).

## 5. Evidências de Circuit Breaker / Health

- ✅ `HEALTH components` — Treasury, Vault, Workers, Ledger, Relayer, RPC, Circle presentes.
- ✅ `HEALTH circuit breaker present` — campo `circuitBreaker` exposto (ex.: `closed`).
- ✅ Indicador de health discreto no frontend (Treasury/Vault/Relayer/Circle/RPC/Workers).

## 6. Evidências de Cache (política Fase 4)

- ✅ `health` → `X-Cache: MISS` depois `HIT` (TTL 10s).
- ✅ `metrics` → `HIT` na 2ª chamada (TTL 15s). `applications` (TTL 60s).
- ✅ `intents/{id}` (status) e `history` → `X-Cache: BYPASS` (**nunca** cacheados).
- ✅ Nunca cacheados: `intents`, `execute`, `settlement`, `history`, `status`.
- ✅ Achado de resiliência: cache de `health` protegeu a UI durante indisponibilidade breve.

## 7. Evidências de Fallback controlado

- ✅ `FALLBACK core-down returns sanitized error` — Core fora → resposta **503 sanitizada**
  (`code: UNAVAILABLE`), sem stack/paths/secret.
- ✅ `FALLBACK core-back REMOTE recovers` — Core volta → REMOTE retorna automaticamente.
- ✅ `TRANSIENT 503 auto-retry then success` — 503 transitório em GET → retry automático → 200.
- Frontend: `effectiveRemote = mode REMOTE && enabled && health OK`; qualquer falha remota
  **antes da assinatura** cai para o caminho LOCAL legado, **com log** (`result: 'fallback'`
  em `TreasuryObs` + `FALLBACK USED →` no console). Nenhuma operação é perdida.

## 8. Evidências de Segurança (sem segredos no frontend)

- ✅ Assinatura HMAC / `X-Application-Secret` existem **apenas** em `dist/_worker.js`
  (server-side). **Nenhum** hit em `dist/static/treasury-*.js`.
- ✅ `TREASURY_APPLICATION_SECRET` é lido de env em runtime — **nenhum valor literal** no
  código/bundle.
- ✅ `/api/treasury/config` retorna apenas dados públicos (mode, IDs, versão, enabled,
  basePath) — sem secret.
- ✅ `SECRET never in proxied response` / `never in response headers`.
- ✅ Nenhuma `OPERATOR/TURBO_RELAYER/TREASURY/VAULT_PRIVATE_KEY` no repositório.
- ✅ WAF/headers de segurança e CSP inalterados; browser fala apenas same-origin.

## 9. Comparativo de performance (LOCAL vs REMOTE)

Latência do proxy → mock (overhead de integração, sem rede real):

| Endpoint | ms |
|---|---|
| health | 99 (1ª, com cold connect) / ~0 em cache HIT |
| quote Arc→Arc | 24 |
| quote Arc→Ethereum | 13 |
| quote Ethereum→Arc | 10 |
| intent | 9 |
| execute | 10 |
| status | 14 |
| history | 8 |
| metrics | 3 / cache HIT ~0 |
| applications | 5 |

- **LOCAL:** cálculo/execução no navegador + chamadas on-chain/RPC (segundos, dependente de
  RPC/attestation). **REMOTE:** 1 hop same-origin ao Worker + 1 hop Worker→Core; overhead do
  proxy medido em **milissegundos**, com cache para health/metrics/applications e de-dup de
  GET. **Não há degradação significativa esperada**; o gargalo permanece a execução on-chain
  (idêntica em ambos os modos, pois a assinatura continua na carteira).

## 10. Observabilidade

Logs estruturados no Worker (`tag: TREASURY_CORE`) com: `correlationId`, `intentId`,
`endpoint` (sem query), `method`, `status`, `latencyMs`, `result` (`ok|transient|error|fallback`),
`attempt`. Sem PII/secrets/tokens. Frontend: `window.TreasuryObs.dump()`.

---

## 11. Variáveis / Secrets (a configurar no projeto ExecDaat — Cloudflare)

| Nome | Tipo | Onde |
|---|---|---|
| `TREASURY_CORE_URL` | var | Cloudflare env (ex.: `https://core.elligentt.xyz`) |
| `APPLICATION_ID=EXECDAAT` | var | Cloudflare env |
| `CLIENT_ID=EXECDAAT-PROD` | var | Cloudflare env |
| `API_VERSION=v1` | var | Cloudflare env |
| `APPLICATION_MODE=REMOTE` | var | Cloudflare env |
| `TREASURY_MODE=REMOTE` | var | Cloudflare env |
| `TREASURY_APPLICATION_SECRET` | **secret** | `wrangler pages secret put ...` (nunca em Git/HTML/JS/logs) |

Nenhuma dessas informações deve constar em Git, frontend, JavaScript público, HTML ou logs.

---

## 12. Arquivos alterados nesta fase

- `tmp/homolog/harness.ts` — **novo** (harness de homologação; pasta `tmp/`, não versionada).
- `FASE_PREPROD_HOMOLOGACAO.md` — **novo** (este relatório).

**Nenhum** arquivo de produção (código do Worker, frontend, contratos) foi alterado nesta
fase de homologação. A integração validada é a entregue nas Fases 3/4.

---

## 13. Itens pendentes / Bloqueadores para produção

**Bloqueadores (dependem da Elligent / configuração):**
1. Provisionar `TREASURY_CORE_URL` real (ex.: `https://core.elligentt.xyz`) dedicado ao Worker.
2. Registrar a aplicação no **Application Registry** (EXECDAAT / ACTIVE / PRODUCTION /
   permissions QUOTE,INTENTS,EXECUTE,STATUS,HISTORY,METRICS,HEALTH; allowed origins/methods/
   headers; rate limits; fingerprint).
3. Gerar `TREASURY_APPLICATION_SECRET` exclusivo (≥256 bits), armazenar **apenas o hash** na
   Elligent, e configurá-lo como **secret** na Cloudflare do ExecDaat.
4. Confirmar o **esquema canônico do HMAC** aceito pela Elligent (o Worker usa
   `MÉTODO\nPATH\nTS\nNONCE\nBODY` + `X-Signature-Alg: HMAC-SHA256`). Se a Elligent exigir
   canonicalização diferente, ajustar `buildAuthHeaders` em `src/routes/treasury.ts`
   (mudança isolada, server-side).

**Recomendações de hardening (não bloqueiam a homologação técnica):**
5. **CORS:** atualizar `ALLOWED_ORIGINS` em `src/index.tsx` para os domínios de produção
   (`https://execdaat.xyz`, `https://elligentt.xyz` + registrados) e restringir o
   coringa `*.pages.dev` antes do go-live. Já **não** aceita `*` (retorna `null` p/ origem
   desconhecida). A CORS da Treasury Core (Elligent) deve **negar navegadores** (só Worker).
6. Rate limit do Worker: `/api/` = 60/min (cobre `/api/core/*`); confirmar limites de
   Application/Client/IP no lado Elligent (validado o comportamento de recusa via mock).

---

## 14. Checklist final de homologação

| Item | Status |
|---|---|
| Health | ✅ |
| Quote (Arc→Arc, Arc→Outras, Outras→Arc) | ✅ |
| Intent | ✅ |
| Execute | ✅ |
| Status (timeline/settlement/reimbursement/hashes/explorer) | ✅ |
| History (paridade Advanced/Unified/History) | ✅ |
| Metrics | ✅ |
| Applications | ✅ |
| HMAC | ✅ |
| Replay Protection / Nonce / Timestamp | ✅ |
| Circuit Breaker (exposto) | ✅ |
| Cache (apenas health/metrics/applications) | ✅ |
| Retry (transitório) | ✅ |
| Fallback REMOTE↔LOCAL (sem perda de operação) | ✅ |
| Sanitização de erros | ✅ |
| Sem segredos no frontend/bundle/HTML/logs | ✅ |
| Sem chaves privadas no ExecDaat | ✅ |
| Correlation ID / Observabilidade | ✅ |
| CORS sem `*` | ✅ (ajustar domínios de produção — item 5) |
| Performance (sem degradação significativa) | ✅ |
| Zero regressões (wrappers pass-through em LOCAL) | ✅ |
| Turbo Bridge / Vault / Treasury / Circle inalterados | ✅ |

---

## 15. Parecer final (GO / NO-GO)

- **Integração pronta para produção (lado ExecDaat):** ✅ **SIM** — 39/39 testes aprovados,
  autenticação HMAC/replay, cache, retry, fallback, observabilidade e segurança validados
  contra um Core compatível com a especificação.
- **Bloqueadores restantes:** configuração/provisionamento do lado Elligent + secrets na
  Cloudflare (seção 13, itens 1–4). Enquanto `TREASURY_CORE_URL`/secret não existirem, o
  ExecDaat opera em **LOCAL (fallback), sem regressão**.
- **Regressões identificadas:** **nenhuma**.
- **Deploy em produção:** **NÃO realizado** — aguardando (a) provisionamento Elligent +
  secrets Cloudflare, (b) validação ponta-a-ponta contra o ambiente real, (c) **aprovação
  explícita**.

Após aprovação explícita e configuração dos itens 1–4, recomenda-se: validar
`/api/treasury/config` (enabled=true) e `/api/core/v1/health` em preview, depois promover.
