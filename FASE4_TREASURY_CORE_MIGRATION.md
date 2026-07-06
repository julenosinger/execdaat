# FASE 4 — Migração Definitiva do ExecDaat para a Treasury Core da Elligent

Fase definitiva. O ExecDaat passa a operar como **camada de experiência (Experience
Layer)**, usando a **Treasury Core API da Elligent como única fonte de verdade** para
Quote, Intent, Execute, Status, Timeline, History, Settlement e Reimbursement. Toda a
lógica financeira, liquidez, Turbo Bridge, Vault e Settlement permanecem na Elligent.

Modo definitivo: **`TREASURY_MODE=REMOTE`**. `LOCAL` fica apenas para emergência e todo
uso de fallback é **registrado na observabilidade**.

Nenhuma alteração de UX/UI, fluxo, Smart Contracts, Wallet Connect, assinaturas,
Circle CCTP ou fluxo financeiro. Toda mudança ocorre **apenas na camada de integração**.

---

## 1. Arquivos modificados / criados

**Backend (Worker):**
- `src/routes/treasury.ts` — **atualizado (Fase 4)**: assinatura **HMAC-SHA256 + Timestamp
  + Nonce** por requisição; **cache TTL** apenas para `health`/`metrics`/`applications`;
  novo endpoint `/applications`; observabilidade e sanitização de erros.
- `src/config/treasury.ts` — config centralizada (CF `c.env` + Vercel `process.env`); sem chaves.
- `src/index.tsx`, `api/index.ts` — montagem de `/api/core/v1` e `/api/treasury`.

**Frontend (camada de experiência):**
- `public/static/treasury-config.js` — `window.TreasuryConfig` (modo, Correlation ID, loader).
- `public/static/treasury-core-client.js` — **atualizado**: `applications()`, **de-dup de GET
  em voo**, `debounce`, reuso de conexão HTTP, observabilidade.
- `public/static/treasury-core-integration.js` — **atualizado**: wrappers remote-first de
  `ArcBridge`/`TurboBridge`, **de-dup de quote (evita intent duplicado)**, **log explícito de
  fallback**, indicador de health (Treasury/Vault/Relayer/Circle/RPC/Workers), `TreasuryData`.
- `public/static/treasury-ui-sync.js` — **novo**: sincronização em tempo real (Saldo/History/
  Advanced) após operações + métricas remotas (`treasury:metrics`) e history (`treasury:history`).
- `src/app.html` — tags de script da camada (config → client → integration → ui-sync).
- `.env.example` — variáveis (sem chaves privadas).

---

## 2. Componentes migrados

| Componente | Origem dos dados (Fase 4) |
|---|---|
| Create Intent | `POST /api/core/v1/intents` |
| Quote / Best Route / Bridge / ETA / Fees / Receive / Liquidity / Provider | `POST /api/core/v1/quote` (verbatim, sem recálculo local) |
| Execute (Send Cross-Chain) | `POST /api/core/v1/execute` |
| Status / Timeline / Bridge Progress / Settlement / Reimbursement / Explorer / Hashes | `GET /api/core/v1/intents/{intent}` (fonte única) |
| History (Advanced/Unified/Bridge/Dashboard) | `GET /api/core/v1/history` (mesmo Intent ID) |
| Metrics (Volume/Success/Settlement/Outstanding/Liquidity/Pending) | `GET /api/core/v1/metrics` |
| Health (Treasury/Vault/Relayer/Circle/RPC/Workers) | `GET /api/core/v1/health` |
| Applications breakdown | `GET /api/core/v1/applications` |

Advanced Cross-Chain, Turbo Bridge, Arc Bridge (Arc→Arc, Arc→Outras, Outras→Arc) e Unified
Balance passam a consumir a Treasury Core via wrappers que preservam **exatamente** as
formas de objeto e os callbacks (`onEvent`/`onStep`) — UI/timeline idênticas.

---

## 3. Endpoints utilizados

```
POST   /api/core/v1/intents
GET    /api/core/v1/intents/{id}
POST   /api/core/v1/quote
POST   /api/core/v1/execute
GET    /api/core/v1/history
GET    /api/core/v1/metrics
GET    /api/core/v1/applications
GET    /api/core/v1/health
GET    /api/treasury/config     (meta, não-sensível, para o frontend)
```

Todos consumidos via **proxy same-origin** do Worker do ExecDaat.

---

## 4. Autenticação (Worker ↔ Treasury Core)

Injetada **exclusivamente** no Worker (nunca no navegador):
- `X-Application-Id`, `X-Client-Id`, `X-Api-Version`, `X-Application-Mode`
- `X-Correlation-Id` (propagado ponta-a-ponta)
- `X-Application-Secret` (secret — só no Worker)
- **`X-Timestamp` + `X-Nonce` + `X-Signature` (HMAC-SHA256)** — assinatura calculada no
  Worker via Web Crypto sobre o canônico `MÉTODO\nPATH\nTIMESTAMP\nNONCE\nBODY`.
- `X-Signature-Alg: HMAC-SHA256`

Nenhuma informação sensível trafega no corpo. O secret **nunca** chega ao browser.

---

## 5. Fluxo completo

```
Wallet → ExecDaat (Experience Layer)
   POST /intents  → intentId (salvo: correlationId, application, client, timeline)
   POST /quote    → melhor rota (exibida verbatim)
   POST /execute  → { intent, wallet, signature?, correlationId, application, client }
   loop GET /intents/{id} → status → onEvent/onStep (timeline idêntica)
        ↓ (Elligent)
   Treasury Engine ▸ Vault ▸ Turbo Bridge ▸ Circle ▸ Settlement ▸ Reimbursement
   → History / Metrics / Explorer / Hashes (mesmo Intent ID em todas as views)
```

Após conclusão: `treasury-ui-sync.js` dispara refresh automático de Saldo, History e
Advanced (sem refresh manual), reagindo aos eventos existentes (`ub:bridge:completed`, etc.).

---

## 6. Estratégia de fallback

- `TREASURY_MODE=REMOTE` (definitivo). `LOCAL` = emergência.
- **Efetivo REMOTE** = mode REMOTE + `TREASURY_CORE_URL` configurada + `GET /health` OK.
- Falha remota **antes de assinatura** (transitório/timeout/indisponível) → fallback
  automático para o caminho legado, **com log** (`result: 'fallback'` na observabilidade,
  `FALLBACK USED →` no console).
- Retry **apenas** para transitórios (rede/502/503/504) e **apenas em GET** idempotente.
- De-dup de GET em voo e de quote (evita intents duplicados).

---

## 7. Cache

- Cacheado (TTL curto, no Worker): `health` (10s), `metrics` (15s), `applications` (60s).
- **NUNCA** cacheado: `intents`, `execute`, `settlement`, `history` (fonte de verdade viva).
- Cabeçalho `X-Cache: HIT|MISS|BYPASS`; respostas ao browser sempre `Cache-Control: no-store`.

---

## 8. Observabilidade

Registrado (sem dados sensíveis): `correlationId`, `intentId`, `endpoint` (sem query),
`method`, `status`, `latencyMs`, `result` (`ok|error|transient|fallback`), `attempt`.
- Worker: log JSON estruturado (`tag: TREASURY_CORE`).
- Browser: `window.TreasuryObs.dump()` (ring buffer, sem PII/secrets/tokens).

---

## 9. Configuração / Variáveis de ambiente

```
TREASURY_CORE_URL=<URL da Treasury Core>     # vazio → LOCAL/fallback
APPLICATION_ID=EXECDAAT
CLIENT_ID=EXECDAAT-PROD
API_VERSION=v1
APPLICATION_MODE=REMOTE
TREASURY_MODE=REMOTE
TREASURY_APPLICATION_SECRET=<secret>          # SERVIDOR APENAS (wrangler secret put)
```

**Proibidas no ExecDaat:** `OPERATOR_PRIVATE_KEY`, `TURBO_RELAYER_PRIVATE_KEY`,
`TREASURY_PRIVATE_KEY`, `VAULT_PRIVATE_KEY` (verificado: ausentes).

---

## 10. Segurança / Evidências (nenhum segredo no frontend)

- Busca em `public/static/treasury-*.js` por `APPLICATION_SECRET`, `PRIVATE_KEY`,
  `X-Application-Secret`, `X-Signature`, `hmac`, `secret`: **apenas comentários**
  explicando que o frontend NUNCA recebe secrets. **Zero** valores/lógica de secret.
- HMAC/Nonce/Timestamp e `X-Application-Secret` existem **somente** em `src/routes/treasury.ts` (Worker).
- `/api/treasury/config` expõe apenas dados públicos (modo, IDs, versão, `enabled`, `basePath`).
- CSP inalterada: browser fala apenas same-origin; o Worker fala com a Treasury Core.

---

## 11. Testes executados

- `npm run build` (Cloudflare, entry `src/index.tsx`) → **OK** (`dist/_worker.js`).
- `npm run build:vercel` → **OK** (assets em `dist-vercel`).
- esbuild bundle isolado de `src/routes/treasury.ts` e `src/config/treasury.ts` → **OK**.
- `node --check` em todos os `treasury-*.js` → **OK** (sem erro de sintaxe).
- Verificação de segredos no frontend → **nenhum** (apenas comentários).
- Arquivos novos presentes em `dist/static/` e `dist-vercel/static/`.

> Observação (pré-existente, fora de escopo): `src/html-template.ts` (template legado, usado
> só pelo entry Vercel) tem erro de sintaxe pré-existente (backtick escapado, linha 1832),
> não relacionado a esta fase e não modificado. O entry primário Cloudflare compila limpo.

---

## 12. Checklist de validação

- [x] Quote remoto — `POST /quote` (verbatim).
- [x] Create Intent — `POST /intents`.
- [x] Execute — `POST /execute` + polling.
- [x] Timeline — `GET /intents/{id}` (fonte única).
- [x] Settlement / Reimbursement — refletidos do estado do Intent.
- [x] History — `GET /history` (mesmo Intent ID em todas as views).
- [x] Metrics — `GET /metrics` (broadcast `treasury:metrics` + `[data-treasury-metric]`).
- [x] Health — `GET /health` + indicador discreto (Treasury/Vault/Relayer/Circle/RPC/Workers).
- [x] Unified Balance sincroniza automaticamente (sem refresh).
- [x] Advanced Cross-Chain sincroniza automaticamente.
- [x] Turbo Bridge operacional (Other→Arc prioriza Turbo; fallback Standard).
- [x] Arc→Arc, Arc→Outras, Outras→Arc.
- [x] Autenticação HMAC + Nonce + Timestamp no Worker.
- [x] Cache apenas health/metrics/applications; nunca intent/execute/settlement/history.
- [x] Nenhuma chave privada no ExecDaat; nenhum segredo exposto ao browser.
- [x] Sem erros TypeScript nos arquivos da integração; build limpo.
- [x] De-dup de chamadas + debounce; conexões HTTP reutilizadas.
- [x] Fallback controlado por flag, com logs. Zero regressão (pass-through em LOCAL).

---

## 13. Resultado

O ExecDaat opera integralmente sobre a Treasury Core da Elligent como única fonte de
verdade. O navegador é responsável apenas pela experiência e pela assinatura da carteira;
toda a lógica financeira, liquidez, Turbo Bridge e gestão da Treasury permanecem na
Elligent. Migração transparente, sem regressões, sem mudanças de interface e sem qualquer
exposição de chaves privadas ou segredos.
