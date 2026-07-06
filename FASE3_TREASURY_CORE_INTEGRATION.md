# FASE 3 — Integração ExecDaat ↔ Treasury Core API (Elligent)

Relatório de migração. O ExecDaat passa a atuar **exclusivamente como cliente** da
Treasury Core API da Elligent. Toda execução financeira (Treasury, Vault, Turbo
Bridge, Circle, Settlement, Reimbursement) permanece na Elligent. O ExecDaat apenas
**inicia operações** e **exibe o progresso** — sem chaves privadas e sem duplicar
lógica de infraestrutura.

A migração foi feita **somente na camada de integração**. Nenhuma alteração em: UX da
Advanced Cross-Chain / Turbo Bridge, fluxo das bridges, Smart Contracts, Circle CCTP,
Vault, Treasury Core, Settlement, Reimbursement, ABI, Wallet Integration ou assinaturas.

---

## 1. Componentes migrados

| Componente | Antes (local) | Agora (Fase 3) |
|---|---|---|
| Create Intent | `RepaymentContract.createIntent()` (`turbo-bridge-core.js`, localStorage) | `POST /api/core/v1/intents` (remoto) |
| Quote / Best Route | `TurboBridge.getQuote()` / `ArcBridge.getQuote()` | `POST /api/core/v1/quote` (remoto) |
| Execute | `TurboExecutor.execute()` / `ArcBridge.execute()` | `POST /api/core/v1/execute` + polling de status |
| Status / Timeline | pollers locais (Iris/on-chain) | `GET /api/core/v1/intents/{id}` (fonte única) |
| History | `localStorage` / logs on-chain | `GET /api/core/v1/history` (fallback local) |
| Metrics | — | `GET /api/core/v1/metrics` |
| Health | — | `GET /api/core/v1/health` + indicador discreto |

O código legado (`turbo-bridge-core.js`, `cross-chain-service.js`) **permanece intacto**
e é usado apenas como **fallback** (feature flag `TREASURY_MODE=LOCAL` ou quando o
endpoint remoto não estiver provisionado/saudável).

A migração é feita via **wrappers** sobre `window.ArcBridge` e `window.TurboBridge`.
As implementações originais são preservadas em `AB.__treasuryLocalExecute`,
`TB.__treasuryLocalGetQuote`, etc. Os wrappers retornam **exatamente as mesmas formas de
objeto** e disparam **os mesmos callbacks** (`onEvent` / `onStep`) — logo a UI e a
timeline não sofrem qualquer alteração.

---

## 2. Endpoints utilizados (Treasury Core API)

Todos consumidos via **proxy same-origin** do ExecDaat (o Application Secret é injetado
no servidor, nunca no browser):

```
POST   /api/core/v1/intents          → Create Intent
GET    /api/core/v1/intents/{id}     → Status (drive da timeline/history/explorer)
POST   /api/core/v1/quote            → Best Route / Receive / ETA / Fees / Slippage / Provider / Bridge
POST   /api/core/v1/execute          → Execução (Send Cross-Chain)
GET    /api/core/v1/history          → Histórico (filtros: wallet, application, status, asset, intent, período, paginação, ordenação)
GET    /api/core/v1/metrics          → Total Volume, Pending Settlement, Outstanding Liquidity, Average Settlement, Bridge Time, Success Rate, Application Breakdown
GET    /api/core/v1/health           → Treasury / Bridge Engine / Vault / Relayer / Circle / RPC
```

Endpoints auxiliares do ExecDaat (meta):

```
GET    /api/treasury/config          → config pública não-sensível (modo, IDs, versão, basePath)
GET    /api/treasury/health          → passthrough de conveniência (não usado pelo cliente)
```

### Headers padronizados (injetados server-side)
`X-Application-Id`, `X-Client-Id`, `X-Api-Version`, `X-Application-Mode`,
`X-Correlation-Id`, `X-Application-Secret` *(secret — apenas no servidor)*.

Nenhuma informação sensível trafega no **corpo** da requisição.

---

## 3. Fluxo completo da operação

```
Usuário (Advanced Cross-Chain / Turbo Bridge / Unified Balance)
   │  informa chains + amount → "Get Quote"
   ▼
ArcBridge.getQuote() / TurboBridge.isAvailable()  (wrappers remote-aware)
   │  POST /intents  → intentId
   │  POST /quote    → melhor rota (usada verbatim, nunca recalculada)
   ▼  quote adaptada às formas da UI (Best Route/Receive/ETA/Fees/Slippage/Provider/Bridge)
Usuário → "Send Cross-Chain"
   ▼
ArcBridge.execute() / TurboBridge.execute()  (wrappers)
   │  POST /execute { intentId, wallet, signature? , application, correlationId }
   │  loop: GET /intents/{id}  → mapeia status → onEvent/onStep (timeline idêntica)
   ▼
Treasury Engine ▸ Vault ▸ Turbo Bridge ▸ Circle ▸ Settlement  (100% Elligent)
   ▼
Estado final do Intent → History / Explorer / Settlement / Reimbursement / Hashes
```

O Correlation ID é gerado uma vez por operação e propagado em **todas** as requisições
(logs, intent, timeline, history, suporte, auditoria).

---

## 4. Estratégia de fallback (controlado)

`TREASURY_MODE` (feature flag) — valores `LOCAL` | `REMOTE`, **default `REMOTE`**.

- **Efetivo REMOTE** = `TREASURY_MODE=REMOTE` **E** `TREASURY_CORE_URL` configurada
  **E** `GET /health` OK.
- **LOCAL** (ou remoto não configurado/indisponível) → os wrappers são **pass-through**
  para o código legado → comportamento **idêntico ao atual** (zero regressão).
- Falha remota **antes de qualquer assinatura** (intent/quote/execute transitório,
  timeout, indisponível) → **fallback automático** para o caminho local, sem o usuário
  perder a operação.
- History remoto indisponível → usa histórico local como fallback temporário.
- **Retry apenas para erros transitórios** (rede / 502 / 503 / 504) e **apenas em GET**
  idempotente — nunca reenvia `POST /intents` ou `POST /execute`.

Enquanto `TREASURY_CORE_URL` não for provisionada pela Elligent, o app opera
exatamente como hoje (LOCAL), e ativa o caminho remoto automaticamente quando a URL +
secret forem configurados e o health passar.

---

## 5. Configurações necessárias / Variáveis de ambiente

Definir no ambiente (Cloudflare `vars`/`secret` ou Vercel env). Ver `.env.example`:

```
TREASURY_CORE_URL=<base URL da Treasury Core API>   # vazio = LOCAL/fallback
APPLICATION_ID=EXECDAAT
CLIENT_ID=EXECDAAT-PROD
API_VERSION=v1
APPLICATION_MODE=REMOTE
TREASURY_MODE=REMOTE                                 # LOCAL para rollback
TREASURY_APPLICATION_SECRET=<secret>                 # SERVIDOR APENAS (wrangler secret put)
```

**Proibido no ExecDaat** (todas as assinaturas ficam na Elligent):
`OPERATOR_PRIVATE_KEY`, `TURBO_RELAYER_PRIVATE_KEY`, `TREASURY_PRIVATE_KEY`,
`VAULT_PRIVATE_KEY`. Verificado: nenhuma dessas chaves existe no repositório.

O `TREASURY_APPLICATION_SECRET` é lido apenas no servidor e injetado como header pelo
proxy; **o browser recebe somente `hasSecret`/`enabled`** via `/api/treasury/config`.

---

## 6. Pontos de rollback

1. **Instantâneo (operacional):** `TREASURY_MODE=LOCAL` → volta ao caminho legado sem
   deploy de código.
2. **Desativar remoto:** remover/limpar `TREASURY_CORE_URL` → `enabled=false` → LOCAL.
3. **Reverter integração:** remover as 3 tags `<script>` de treasury em `src/app.html`
   e o mount de `/api/core/v1` + `/api/treasury` em `src/index.tsx` / `api/index.ts`.
   Os módulos legados permanecem 100% funcionais.

---

## 7. Observabilidade

Registrado (sem dados sensíveis): `correlationId`, `intentId`, `application`,
`endpoint` (sem query string), `method`, `status`, `latencyMs`, `result`, `attempt`.

- Servidor: log estruturado JSON (tag `TREASURY_CORE`) no proxy.
- Browser: `window.TreasuryObs` (ring buffer, sem PII/secrets). `TreasuryObs.dump()`.

Query strings (que podem conter wallet) são removidas dos logs.

---

## 8. Segurança

- ExecDaat não conhece nenhuma private key / treasury key / vault key / operator key /
  secret interno. Toda responsabilidade criptográfica permanece na Elligent.
- Assinatura continua exclusivamente na carteira do usuário (inalterado).
- Secret trafega **apenas** servidor→Elligent (header). Nunca no browser, nunca no body.
- Proxy com whitelist de rotas (evita open forwarder). Erros sanitizados (sem stack
  trace / paths / secrets / internos).
- CSP inalterada: o browser fala apenas com same-origin (`connect-src 'self'`); o
  proxy fala com a Treasury Core API.

---

## 9. Arquivos alterados / criados

**Criados (backend):**
- `src/config/treasury.ts` — configuração centralizada (CF `c.env` + Vercel `process.env`).
- `src/routes/treasury.ts` — proxy `/api/core/v1/*` + meta `/api/treasury/*` (correlation, retry, sanitização, observabilidade).

**Criados (frontend):**
- `public/static/treasury-config.js` — `window.TreasuryConfig` (modo, correlation id, loader).
- `public/static/treasury-core-client.js` — `window.TreasuryCore` (intents/quote/execute/status/history/metrics/health).
- `public/static/treasury-core-integration.js` — `window.TreasuryIntegration`/`TreasuryData`/`TreasuryObs`; wrappers remote-aware de `ArcBridge`/`TurboBridge`; indicador de health.

**Modificados:**
- `src/index.tsx` — mount de `/api/core/v1` e `/api/treasury`; Bindings de env.
- `api/index.ts` — mesmo mount para o alvo Vercel.
- `src/app.html` — 3 tags `<script>` da camada de integração (config → client → integration).
- `.env.example` — variáveis da Treasury Core (sem chaves privadas).

---

## 10. Checklist de validação

- [x] Create Intent remoto — `POST /api/core/v1/intents` (proxy).
- [x] Quote remoto — `POST /api/core/v1/quote` (usado verbatim, sem recálculo local).
- [x] Execute remoto — `POST /api/core/v1/execute` + polling de status.
- [x] Status remoto — `GET /api/core/v1/intents/{id}` como fonte única.
- [x] History remoto — `GET /api/core/v1/history` (fallback local).
- [x] Metrics remoto — `GET /api/core/v1/metrics`.
- [x] Health remoto — `GET /api/core/v1/health` + indicador discreto.
- [x] Timeline / Execution Preview — inalteradas (mesmos callbacks `onEvent`/`onStep`).
- [x] Turbo Bridge — operacional (Other→Arc prioriza Turbo; fallback Standard).
- [x] Arc→Arc, Arc→outras, outras→Arc — decisão de rota preservada (badges idênticos).
- [x] Treasury/Vault/Reimbursement — permanecem na Elligent (ExecDaat só exibe).
- [x] Nenhuma chave privada no ExecDaat (verificado).
- [x] Sem erros TypeScript nos arquivos da integração (esbuild-clean).
- [x] Build Cloudflare (`npm run build`) OK — `dist/_worker.js`.
- [x] Build Vercel de assets (`npm run build:vercel`) OK.
- [x] Sem regressão funcional: em LOCAL / remoto não configurado os wrappers são pass-through.

### Observação (pré-existente, fora de escopo)
`src/html-template.ts` (template legado usado só pelo entry Vercel) possui um erro de
sintaxe pré-existente (backtick escapado na linha 1832) **não relacionado** a esta fase e
**não modificado** aqui. O entry primário (Cloudflare, `src/index.tsx`, que serve
`src/app.html`) compila e faz build sem erros. Recomenda-se corrigir esse arquivo legado
em tarefa separada.
