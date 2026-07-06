# FIX — Persistência de Intents na Treasury Core — Diagnóstico Final + Correção Prescrita

## Situação

A causa raiz está confirmada: a Treasury Core **cria o Intent mas não o persiste** num
store compartilhado. Por isso `GET /intents/{id}` → **404** e `POST /execute` → **422
EXECUTE_INCOMPLETE**, imediatamente após o `POST /intents` retornar 201.

## BLOQUEADOR para aplicar a correção

O **código-fonte da Treasury Core** (`elligente.pages.dev/api/core/v1/*`, com
`EXECUTE_INCOMPLETE`, `intentBytes32`, `/intents`, `/execute`) **não está presente** neste
workspace nem nas pastas Elligent encontradas na máquina.

O que foi localizado (e descartado) — buscas realizadas:
- `C:\Users\Juleno\Eligentt` → app de **pagamentos** Elligent (Pages `name:"elligente"`),
  functions: `auth`, `health`, `payment`, `relayer`, `treasury/fees.js`. **Não tem `api/core/`**.
  KV declarados: `AUTH_KV`, `PAYMENT_LINKS`, `RATE_LIMIT_KV` — **não existe `CORE_KV`**.
- `C:\Users\Juleno\Eligentt-fresh` → mesma base, ainda menor. Sem `api/core`.
- `C:\Users\Juleno\Test1 elligente\ell2\src` → relayer/cctp. Sem `api/core`.
- `C:\Users\Juleno\elligente-deploy-direct` → deploy estático (só `index.html`).
- Busca por `EXECUTE_INCOMPLETE` / `intentBytes32` / `api/core/v1/intents` nas pastas de
  projeto: **nenhum resultado**.

Conclusão: o serviço Treasury Core que está no ar foi implantado a partir de um
código-fonte **fora do meu alcance atual**. Não é possível editar/corrigir com segurança um
código que não tenho — e editar o projeto errado causaria dano.

---

## Causa raiz (confirmada por evidências)

1. `POST /api/core/v1/intents` retorna o Intent (computado), com `status:"Created"`, mas o
   objeto **não é gravado** num armazenamento persistente compartilhado.
2. `GET /api/core/v1/intents/{id}` e `POST /api/core/v1/execute` leem de um store onde o
   Intent **não existe** → 404 / 422.
3. **Pista forte:** o próprio checklist da tarefa cita `CORE_KV`, mas **nenhum
   `wrangler.jsonc` da Elligent declara `CORE_KV`**. Se o handler de intents grava em
   `env.CORE_KV` (ou em um `Map` em memória) e esse binding **não existe**, a escrita falha
   silenciosamente ou fica só na memória do isolate → o Intent some entre requisições/Workers.
4. Regressão temporal: às **21:29 UTC** (go-live) `create → execute → 200 Fulfilled` e
   `status 200`. Às **23:26 UTC** `create 201`, `status 404`, `execute 422`. Algo mudou
   **no lado da Elligent** (provável remoção/troca do binding ou do store de Intents num redeploy).

---

## Correção PRESCRITA (a aplicar na Treasury Core — sem soluções temporárias, sem memória)

**1. Declarar um KV persistente dedicado a Intents no `wrangler.jsonc` da Treasury Core:**
```jsonc
"kv_namespaces": [
  { "binding": "CORE_KV", "id": "<id-do-namespace-CORE_KV-em-producao>" }
  // ...demais bindings existentes
]
```
> Criar o namespace real: `wrangler kv namespace create CORE_KV` e colar o `id` acima.
> **Não** usar memória / `Map` / variável global como store.

**2. No handler `POST /api/core/v1/intents` — GRAVAR antes de responder 201:**
```js
const intent = buildIntent(payload)               // já existente
const key = `intent:${intent.intentId}`
await env.CORE_KV.put(key, JSON.stringify(intent)) // <-- PERSISTIR (aguardar)
return json({ success: true, data: intent }, 201)  // só responde após gravar
```

**3. No `GET /api/core/v1/intents/{id}` — LER com a MESMA chave, do MESMO store:**
```js
const raw = await env.CORE_KV.get(`intent:${id}`)
if (!raw) return json({ success:false, errors:[{code:'NOT_FOUND'}] }, 404)
return json({ success:true, data: JSON.parse(raw) }, 200)
```

**4. No `POST /api/core/v1/execute` — LER o Intent do MESMO store (mesma chave):**
```js
const raw = await env.CORE_KV.get(`intent:${intentId}`)
if (!raw) return json({ success:false, errors:[{code:'EXECUTE_INCOMPLETE', ...}] }, 422)
const intent = JSON.parse(raw)
// ...fulfilhar; ao mudar de estado, RE-GRAVAR:
intent.status = 'Fulfilled'
await env.CORE_KV.put(`intent:${intentId}`, JSON.stringify(intent))
```

**5. Regras invioláveis:**
- Todos os endpoints (`intents`/`{id}`/`execute`/`history`/`metrics`) usam **o mesmo binding
  `CORE_KV`** e o **mesmo esquema de chave** (`intent:${intentId}`).
- **Nenhum** fallback para memória. Se `env.CORE_KV` for `undefined`, **falhar explicitamente**
  (503) em vez de gravar em memória — assim o problema fica visível e não “fantasma”.
- Não alterar HMAC, contratos, Turbo Bridge, Vault, Settlement, Circle nem a interface pública.

**6. Consistência KV (importante):** o Cloudflare KV tem consistência eventual em leituras
por região, mas leituras logo após escrita no MESMO namespace normalmente refletem o valor.
Como o fluxo é create → (poll) status → execute, isso é suficiente. Se precisar de leitura
imediata forte, considerar **Durable Object** ou **D1** para o store de Intents.

---

## Validação (após a correção)

```
POST /intents → 201  →  GET /intents/{id} → 200  →  POST /execute → 200
→ Settlement → Reimbursement → History mostra o Intent → Metrics conta o Intent → Health ok
```
E confirmar: o Intent sobrevive a novo deploy, em Workers/isolates diferentes e sob
requisições simultâneas (todos leem do mesmo `CORE_KV`).

---

## Ação necessária de você

Para eu **aplicar** essa correção, preciso do **código-fonte da Treasury Core** (a pasta que
faz deploy de `elligente.pages.dev/api/core/v1/*`). Ela deve conter o handler `/api/core/v1/intents`
e um `wrangler.jsonc`/`wrangler.toml`. Assim que você indicar o caminho, eu implemento e valido.
Alternativa imediata (reversível, no lado do ExecDaat, sem tocar na Core): `TREASURY_MODE=LOCAL`.
