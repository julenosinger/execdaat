# INVESTIGAÇÃO — Regressão Crítica pós-ativação da Treasury Core (todas as bridges falham)

**Conclusão:** a causa raiz está na **Treasury Core da Elligent** — ela **parou de
persistir os Intents**. O `POST /intents` responde com sucesso, mas o Intent **não é
salvo**; logo, `GET /intents/{id}` retorna **404** e `POST /execute` retorna **422
EXECUTE_INCOMPLETE**. O ExecDaat está enviando tudo corretamente (URL, HMAC, headers,
schema). **Nenhuma correção foi implementada** (conforme instruído). Nenhum arquivo foi
alterado nesta fase.

---

## 1. Etapa exata onde falha

O fluxo quebra **entre a criação do Intent e a execução**, na **persistência do Intent na
Elligent**:

```
POST /api/core/v1/intents   → 201  (retorna intentId + intentBytes32, status "Created")
GET  /api/core/v1/intents/{id} → 404  NOTFOUND  (o intent recém-criado NÃO existe)
POST /api/core/v1/execute   → 422  EXECUTE_INCOMPLETE
```

- **Camada:** Treasury Core (Elligent) — armazenamento/registro de Intents.
- **No ExecDaat:** a falha aparece ao chamar `execute` em
  `public/static/treasury-core-integration.js` → `_remoteExecuteTurbo` /
  `_remoteExecuteStandard` (que chamam `window.TreasuryCore.execute`), propagada por
  `public/static/treasury-core-client.js` → `_request/_friendly`, e exibida por
  `advanced-crosschain.js` → `accExecuteBridge` como "Bridge failed: …".

---

## 2. Verificação obrigatória (itens 1–15)

| # | Verificação | Resultado |
|---|---|---|
| 1 | Worker acessa `TREASURY_CORE_URL` | ✅ SIM (health/quote/intents respondem) |
| 2 | `/health` responde | ✅ **200** (treasury/vault/rpc/circle/relayer/ledger/kv ok, circuit `closed`) |
| 3 | `/quote` responde | ✅ **200** (rota real, receive/fee/eta) |
| 4 | `/intents` responde | ⚠️ **201** — retorna o objeto, **mas não persiste** |
| 5 | `/execute` responde | ❌ **422 EXECUTE_INCOMPLETE** |
| 6 | Códigos HTTP | create **201**, quote **200**, health **200**, **status 404**, **execute 422** |
| 7 | Corpo completo | capturado (ver seção 3) |
| 8 | Secret confere com a Elligent | ✅ SIM — se não conferisse, TUDO seria 401; health/quote/create passam |
| 9 | `APPLICATION_ID` ACTIVE | ✅ SIM — `/applications` mostra `EXECDAAT` `status:"active"`, `environment:"production"`, `authMode:"hmac"` |
| 10 | Validação HMAC passa | ✅ SIM — todas as chamadas assinadas (menos as que dependem de persistência) retornam 200/201 |
| 11 | Falha de Timestamp/Nonce/Replay | ❌ Não há (nenhum 401/409; nonce único por request) |
| 12 | Erro de CORS / WAF | ❌ Não é a causa (curl e navegador passam; CORS permite `*.pages.dev`; WAF não bloqueia o corpo) |
| 13 | Worker envia headers `X-Application-Id/X-Timestamp/X-Nonce/X-Signature/X-Correlation-Id` | ✅ SIM — comprovado pelo sucesso das chamadas assinadas |
| 14 | Endpoint correto é chamado | ✅ SIM — `…/api/core/v1/*` (URL normalizada, sem duplicação) |
| 15 | Erro interno mascarado antes do frontend | ✅ SIM — o **422 EXECUTE_INCOMPLETE** e o **404 NOTFOUND** são convertidos pelo client em mensagem genérica `UPSTREAM` ("The Treasury service could not process this request.") |

---

## 3. Corpo completo das respostas (evidências)

**CREATE — `POST /api/core/v1/intents` → 201 (sucesso, objeto retornado):**
```json
{"success":true,"data":{"intentId":"INT-MR8F8BT4-72BB60AA",
"intentBytes32":"0xca3b0e53...953c","status":"Created","asset":"usdc","amount":10,
"grossAmount":10,"feeAmount":0.1,"netAmount":9.9,"bridge":"Turbo","quote":{...}},"errors":[]}
```

**STATUS — `GET /api/core/v1/intents/INT-MR8F8BT4-72BB60AA` → 404 (3 tentativas em 6s):**
```json
{"ok":false,"error":"Requested Treasury resource was not found.","code":"NOTFOUND",...}
```

**EXECUTE — `POST /api/core/v1/execute` → 422:**
```json
{"success":false,"data":null,"errors":[{"code":"EXECUTE_INCOMPLETE",
"message":"Cannot execute: missing asset/amount/wallet/intentBytes32 (register the intent first or provide them)"}]}
```
> Mesmo **fornecendo** `asset`, `amount`, `wallet` e `intentBytes32` no corpo do execute, o
> retorno permanece **422 EXECUTE_INCOMPLETE** — ou seja, o "escape hatch" (provide them)
> também não funciona, confirmando que o problema é o **registro/persistência do Intent na
> Elligent**, não o payload do ExecDaat.

---

## 4. Exceção original / causa raiz

- **Exceção original (Elligent):** `EXECUTE_INCOMPLETE — "Cannot execute: missing
  asset/amount/wallet/intentBytes32 (register the intent first or provide them)"` e, no
  status, `NOTFOUND`.
- **Causa raiz:** A Treasury Core **cria o Intent em memória e o retorna, mas NÃO o persiste**
  no store (KV/DB). Consequentemente:
  - `GET /intents/{id}` não encontra o Intent → **404**.
  - `execute` não encontra o Intent registrado → **422 EXECUTE_INCOMPLETE**.
- **Prova de regressão (linha do tempo):**
  - **21:29 UTC (go-live):** `create → execute {intentId,wallet}` → **200 "Fulfilled"** (tx real, bloco 50378481); `status` → **200** com dados completos. **Persistência funcionava.**
  - **23:25–23:27 UTC (agora):** `create` → 201; `status` → **404**; `execute` → **422**. **Persistência quebrada.**
  - O ExecDaat **não mudou** entre esses horários — a mudança ocorreu no lado da Elligent.

---

## 5. Por que a UI mostra a mensagem genérica

1. O proxy do Worker (`src/routes/treasury.ts`) repassa 400/422, mas o **404** vira
   `friendlyError('notfound')` e o **422** é repassado; então o **client**
   (`treasury-core-client.js` → `_friendly`) mapeia qualquer status ≠200/404/transitório
   para o código genérico `UPSTREAM` → "The Treasury service could not process this request.".
2. O **integration** (`treasury-core-integration.js`) só faz fallback para LOCAL em erros
   `NO_INTENT/transient/UNAVAILABLE/TIMEOUT/DISABLED`. Como o erro é `UPSTREAM`/`NOTFOUND`,
   **não** cai para o caminho LOCAL — a bridge falha em vez de degradar.

> Estes dois pontos são **secundários** (mascaram o diagnóstico e impedem o fallback), mas
> **não são a causa raiz** — mesmo com fallback, o modo REMOTE continuaria falhando enquanto
> a Elligent não persistir os Intents.

---

## 6. Correção recomendada (NÃO implementada — aguardando aprovação)

**Primária (Elligent — Treasury Core):** corrigir a **persistência de Intents**.
- Verificar o store de Intents (KV/DB): o `POST /intents` deve **gravar** o Intent
  (chave = `intentId`) e `GET /intents/{id}` + `/execute` devem **ler** do mesmo store.
- Provável origem: binding de KV/namespace ausente após redeploy, store em memória por
  isolate (não compartilhado entre requisições), ou etapa de "registro" do Intent removida.
- Critério de aceite: após `POST /intents`, `GET /intents/{id}` deve retornar **200** com o
  Intent e `execute` deve **fulfilhar**.

**Mitigação imediata (ExecDaat — operacional, reversível):** definir
`TREASURY_MODE=LOCAL` no `execdaatapp-v2` (Cloudflare Secret) e redeploy. Isso volta o
ExecDaat ao caminho legado (bridges on-chain via carteira do usuário), **sem regressão de
UX**, até a Elligent corrigir a persistência. (Não aplicado nesta fase.)

**Resiliência (ExecDaat — secundária, opcional):**
1. Expor o motivo real (repassar `EXECUTE_INCOMPLETE`/`NOTFOUND`) em vez do genérico
   `UPSTREAM`, para diagnóstico.
2. Incluir `NOTFOUND`/intent-missing nos gatilhos de fallback para LOCAL, de modo que
   falhas REMOTE degradem para o caminho legado automaticamente.

---

## 7. Arquivos / funções envolvidos (referência)

- **Elligent (causa raiz):** `POST /api/core/v1/intents` (não persiste) e
  `GET /api/core/v1/intents/{id}` / `POST /api/core/v1/execute` (não encontram o Intent).
- **ExecDaat (apenas mascaramento/fallback, não causa):**
  - `src/routes/treasury.ts` → `forwardToCore` (404→`friendlyError('notfound')`).
  - `public/static/treasury-core-client.js` → `_friendly` (422→`UPSTREAM`).
  - `public/static/treasury-core-integration.js` → `_remoteExecuteTurbo`/`_remoteExecuteStandard` e catches de `TB.execute`/`AB.execute` (sem fallback para `UPSTREAM`/`NOTFOUND`).
  - `public/static/advanced-crosschain.js` → `accExecuteBridge` (exibe "Bridge failed: …").

---

## 8. Resumo executivo

- **O que falha:** execução da bridge (todas as rotas), no passo de `execute`/`status`.
- **HTTP:** create **201**, quote **200**, **status 404**, **execute 422 EXECUTE_INCOMPLETE**.
- **Causa raiz:** **Treasury Core (Elligent) não está persistindo os Intents** (regressão de
  infraestrutura no lado da Elligent, ocorrida após o go-live das 21:29 UTC).
- **ExecDaat:** correto no envio (HMAC ✅, secret ✅, APPLICATION_ID ACTIVE ✅, headers ✅,
  endpoint ✅). Contribui apenas mascarando o erro e não fazendo fallback.
- **Ação imediata sugerida (a aprovar):** rollback operacional `TREASURY_MODE=LOCAL` +
  abrir correção da persistência de Intents na Elligent.
