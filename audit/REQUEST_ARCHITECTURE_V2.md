# ExecDaat — Request Architecture v2.0

**Fase:** Arquitetura e Planejamento (sem implementação)
**Data:** 2026-07-17
**Escopo:** Redesenho completo do consumo de Requests e Subrequests
**Restrições respeitadas:** nenhuma alteração de código, UI/UX, lógica de negócio, smart contracts ou RPC Proxy. Este documento é 100% projeto/planejamento.

---

## SUMÁRIO

1. [Diagnóstico quantificado do estado atual (baseline)](#1-baseline)
2. [Fase 1 — Request Architecture (fluxo atual vs. proposto)](#2-fase-1)
3. [Fase 2 — Request Policy (política oficial)](#3-fase-2)
4. [Fase 3 — Request Manager Global](#4-fase-3)
5. [Fase 4 — Polling Manager v2](#5-fase-4)
6. [Fase 5 — RPC Architecture](#6-fase-5)
7. [Fase 6 — Cache Architecture](#7-fase-6)
8. [Fase 7 — Lazy Loading Architecture](#8-fase-7)
9. [Fase 8 — Multi-tab Architecture](#9-fase-8)
10. [Fase 9 — Request Coalescing](#10-fase-9)
11. [Fase 10 — Smart Refresh](#11-fase-10)
12. [Fase 11 — Escalabilidade (1 → 10.000 usuários)](#12-fase-11)
13. [Fase 12 — Roadmap de Implementação](#13-fase-12)
14. [Estimativa consolidada de redução](#14-reducao)

---

<a id="1-baseline"></a>
## 1. DIAGNÓSTICO QUANTIFICADO DO ESTADO ATUAL (BASELINE)

### 1.1 Números da auditoria

| Métrica | Valor atual |
|---|---|
| Timers/pollers ativos ou potencialmente ativos no frontend | **52** |
| Monitores *ambient* que auto-iniciam nos primeiros 5s | **7** (PM heartbeat, security scanner, RPC health, app health, contract monitor, treasury event bus, treasury job engine) |
| Scripts carregados no boot (`src/app.html`) | **~88** (0 com `defer`/`async`), ~3,5–4 MB |
| Pollers que usam o PollingManager existente | **12 de 52** (23%) |
| Pollers com `stop()`/destroy real | **~15 de 52** |
| Clientes RPC distintos no backend | **4** (arc-rpc.mjs com failover 4×2; rpc-proxy 4×1; contracts.ts URL única; ethers JsonRpcProvider URL única) |
| Pior endpoint em subrequests | `GET /api/contracts` → **até 101 chamadas RPC** (contracts.ts) |
| Caches backend | 8 caches, todos **per-isolate** (voláteis, não compartilhados) |
| Uso do `PM.dedupe()` (coalescing já existente) | **0 módulos** |
| Cron/background no backend | 0 (backend é 100% request-driven — bom) |

### 1.2 Consumo estimado por usuário (v1 atual)

**Usuário ocioso, 1 aba aberta, wallet conectada, dashboard visível:**

| Fonte | Frequência | Req/min |
|---|---|---|
| Contract Monitor (`contract-monitor.js:171`) — 4 `eth_call` via `/api/rpc` a cada 30s | 30s | 8,0 |
| App Health Monitor (`health.js:174`) — guardian + core/v1/health + 2× `/api/rpc` | 60s | 4,0 |
| Dashboard auto-refresh (`dashboard.js:553`) — batch `/api/rpc` | 60s | 1,0 |
| Wallet balance poll (`wallet.js:1564`) | 60s | 1,0 |
| RPC Health Monitor (`rpc.js:231`) — 4 RPCs + proxy (todos reroteados p/ `/api/rpc` pelo interceptor `security.js:298`) | 300s | 1,0 |
| Treasury Job Engine idle (`treasury-job-engine.js:157`) | 300s | 0,2 |
| **TOTAL (aba visível, ociosa)** | | **~15 req/min ≈ 900/h ≈ 21.600/dia** |

**Com a aba Treasury aberta** (pior caso legítimo): +9 endpoints/60s (`treasury.js:1083`) + 4/30s (`toc.js:128`) + 3/15s (`reimbursements.js:644`) ≈ **+29 req/min → ~44 req/min ≈ 2.600/h**.

**Aba em segundo plano:** a maioria dos pollers tem guarda `document.hidden`, mas ~35 timers continuam rodando (custo de CPU) e vários fluxos sem guarda continuam consumindo (bridge pollers, waiters).

### 1.3 Conclusão do baseline

- O plano Free da Cloudflare (100.000 requests/dia em Functions) é esgotado por **~4,6 abas abertas 24h** ou **~55 usuários com 2h de aba aberta/dia**.
- **>90% das requests são polling ambient de dados que ninguém está olhando** — não são ações do usuário.
- Subrequests: fator médio ~1,3× por request (proxy 1 upstream), mas com **cauda pesada**: failover ×4, `arc-rpc` até ×8, `/api/contracts` até ×101, `core/v1/health` até ×6.
- Não existe: budget global, coalescing em uso, cache compartilhado entre abas, lifecycle de módulo (activate/deactivate), gating por bloco.

---

<a id="2-fase-1"></a>
## 2. FASE 1 — REQUEST ARCHITECTURE

### 2.1 Fluxo ATUAL (v1)

```
┌─────────────────────────────── BROWSER (por aba!) ───────────────────────────────┐
│                                                                                   │
│  52 timers independentes                     Módulos (cada um busca sozinho)      │
│  ┌──────────────┐ ┌──────────────┐  ┌─────────┬─────────┬────────┬──────────┐    │
│  │ContractMon 30s│ │HealthMon 60s │  │Dashboard│Treasury │ Swap   │ Bridge   │    │
│  │RPCHealth 300s│ │JobEngine 1s  │  │History  │TOC      │ Pools  │ Contracts│    │
│  │EventBus 4s   │ │Reimb 15s ... │  │OTC      │Autonoma │ Wallet │ ...      │    │
│  └──────┬───────┘ └──────┬───────┘  └────┬────┴────┬────┴───┬────┴────┬─────┘    │
│         │                │                │         │        │         │          │
│         ▼                ▼                ▼         ▼        ▼         ▼          │
│  ╔═══════════════════════════════════════════════════════════════════════╗       │
│  ║ security.js fetch interceptor: TODO RPC Arc → /api/rpc (sem exceção)   ║       │
│  ╚═══════════════════════════╦═══════════════════════════════════════════╝       │
└──────────────────────────────╫───────────────────────────────────────────────────┘
                               ║  N módulos × N timers × N abas = N³ requests
                               ▼
┌────────────────────── CLOUDFLARE PAGES FUNCTIONS ────────────────────────────────┐
│  /api/rpc (proxy failover 4 endpoints, micro-cache 4-600s)                       │
│  /api/dex/* (cache 60s)   /api/swap/* (cache 30s)   /api/core/v1/* (cache 12-30s)│
│  /api/contracts/* (cache 15s, SEM failover, até 101 RPC)                          │
│  /api/payments|guardian|yield|chat|wallet|treasury|settings (0 RPC ou externos)   │
│  → caches per-isolate, 4 clientes RPC diferentes, sem orçamento de subrequests   │
└──────────────────────────────╫───────────────────────────────────────────────────┘
                               ▼
      Arc RPC ×4 (failover)  ·  Circle API  ·  OpenAI  ·  Treasury Core (Elligent)
```

**Problemas estruturais (confirmados pela auditoria):**
1. Cada módulo é seu próprio "scheduler + fetcher + cache" → duplicação total.
2. O interceptor globalizou o RPC: cada leitura de cada aba de cada usuário = 1 invocação de Function.
3. Monitores ambient (contract-monitor, health, rpc-health) rodam **sempre**, mesmo sem ninguém olhando.
4. Zero compartilhamento entre abas (leader election existe, mas só 12 pollers respeitam).
5. Nenhuma request tem metadados (TTL/prioridade/owner) — impossível governar.

### 2.2 Fluxo PROPOSTO (v2)

```
┌─────────────────────────────── BROWSER ──────────────────────────────────────────┐
│                                                                                   │
│   Módulos (Dashboard, Treasury, Swap, Bridge, Contracts, OTC, Autonoma, ...)      │
│   ─ não fazem fetch direto                                                        │
│   ─ declaram INTERESSE em dados:  RM.subscribe('balances:0xabc', cb, {ttl})       │
│   ─ lifecycle: init() / activate() / deactivate() / destroy()                     │
│              │                                                                    │
│              ▼                                                                    │
│  ┌─────────────────────────── REQUEST MANAGER GLOBAL (RM) ────────────────────┐   │
│  │  Registry de subscriptions   →  1 dado = 1 fetch = N consumidores          │   │
│  │  Dedupe/in-flight (coalescing)                                             │   │
│  │  L1 Memory Cache (TTL por categoria)                                       │   │
│  │  Priority Queue + Token Bucket (budget global de requests)                 │   │
│  │  Micro-batching RPC (janela 100ms → 1 batch JSON-RPC até 50 itens)         │   │
│  └──────┬──────────────────────────────┬───────────────────────────┬──────────┘   │
│         │                              │                           │              │
│  ┌──────▼──────┐              ┌────────▼────────┐        ┌─────────▼─────────┐    │
│  │ POLLING MGR │              │   RPC MANAGER   │        │  SHARED CACHE L2  │    │
│  │ v2 (único   │              │ classifica:     │        │ cross-tab         │    │
│  │ dono de     │              │ · RPC Direto    │        │ BroadcastChannel  │    │
│  │ TODOS os    │              │ · RPC Manager   │        │ + localStorage    │    │
│  │ timers)     │              │ · RPC Proxy     │        │ (só líder busca)  │    │
│  └─────────────┘              └────────┬────────┘        └───────────────────┘    │
│   gates: visibility ·                  │                                          │
│   module-active · idle ·               │                                          │
│   leader · wallet · block              │                                          │
└────────────────────────────────────────╫──────────────────────────────────────────┘
              (1 request coalescida, batcheada, cacheada, só do líder)
                                         ▼
┌────────────────────── CLOUDFLARE PAGES FUNCTIONS ────────────────────────────────┐
│  /api/rpc (INTACTO — proxy failover, micro-cache, batch)                          │
│  /api/snapshot (NOVO, agregador: 1 request → dashboard+health+vault+metrics)      │
│  demais endpoints INTACTOS (mantêm compat) + Cache-Control/ETag padronizados      │
│  Edge SWR: caches per-isolate existentes + coalescing de in-flight (já existe)    │
│  Orçamento de subrequests: hard cap por invocação (ex.: contracts paginado)       │
└────────────────────────────────────────╫──────────────────────────────────────────┘
                                         ▼
      Arc RPC ×4 (failover INTACTO) · Circle · OpenAI · Treasury Core
```

### 2.3 Fluxo de uma request no v2 (pipeline de decisão)

```
Módulo pede dado
   │
   ▼
[1] Está no L1 (memória) dentro do TTL? ──sim──► retorna (0 requests)
   │ não
   ▼
[2] Está no L2 (shared cache de outra aba)? ──sim──► retorna (0 requests)
   │ não
   ▼
[3] Já existe fetch in-flight desse dado? ──sim──► aguarda a mesma Promise (0 requests)
   │ não
   ▼
[4] Gates do Smart Refresh passam?
    visível? módulo ativo? usuário não-idle? sou líder (se ambient)?
    blockNumber mudou (para dados on-chain)? ──não──► serve stale ou adia (0 requests)
   │ sim
   ▼
[5] Budget disponível no token bucket da categoria? ──não──► enfileira por prioridade
   │ sim
   ▼
[6] Classificação de transporte (RPC Manager):
    · Cached API  → GET com ETag (304 barato)
    · Internal API→ fetch normal
    · RPC Manager → entra no micro-batch (100ms) → 1 POST /api/rpc com N itens
    · RPC Proxy   → operações críticas/escritas → POST /api/rpc individual
    · RPC Direto  → leituras públicas triviais direto no RPC Arc (respeitando
                    rate-limit por IP; bypass do interceptor via allowlist)
   │
   ▼
[7] Resposta → grava L1 + broadcast L2 → notifica TODOS os subscribers (todas as abas)
```

### 2.4 Mapa módulo → fonte de dados no v2

| Módulo | Hoje (v1) | v2 |
|---|---|---|
| Dashboard | batch RPC próprio + 4 APIs | `RM.subscribe('snapshot:dashboard')` → `/api/snapshot` |
| Treasury + TOC + Reimbursements | 16 requests/min combinadas nos mesmos endpoints | `RM.subscribe('snapshot:treasury')` → 1 request/60s compartilhada pelos 3 |
| Swap/Pools | `/api/dex/amm` + balances 60s | `RM.subscribe('pool:state')` (TTL 30s) + balances sob demanda |
| Bridge/XBridge | pollers 3s/5s/6s próprios | `RM.poll('bridge:intent:<id>')` — só durante operação ativa (transacional, mantém frequência) |
| Contracts | eth_call por contrato via provider | `RM.subscribe('contracts:list:<wallet>')` (TTL 300s + invalidação por evento) |
| History | receipts 60s | `RM.poll('tx:pending:<hash>')` — só enquanto houver tx pendente |
| OTC | watchers 0,5–10s | subscribe em `wallet:state` (evento, não poll) + alerts locais |
| Health/Status | 3 monitores ambient | `RM.subscribe('health:system')` **apenas com widget/página aberta** |
| Autonoma / Circle Skills | 2 pollers de 30s no mesmo endpoint | 1 subscription `agent:intents:<wallet>` compartilhada |
| Wallet | poll 60s balanceOf | subscribe `balances:<wallet>` + invalidação por evento de tx |

---

<a id="3-fase-2"></a>
## 3. FASE 2 — REQUEST POLICY (POLÍTICA OFICIAL DE REQUESTS DO EXECDAAT)

> Política normativa. Toda request futura DEVE cumprir. PRs que violarem regras exigem justificativa técnica escrita no próprio PR e aprovação explícita.

### REGRA 1 — Zero requests no boot
Nenhum módulo pode iniciar automaticamente ao abrir o site. Abrir a landing page = **0 requests de dados** (apenas assets estáticos). A primeira request de dados ocorre quando o usuário entra no app E um módulo é ativado.
*Estado atual que a viola: 7 monitores ambient auto-start (health.js:189, rpc.js:248, contract-monitor.js:171, treasury-job-engine.js:301, treasury-event-bus.js:279, circle-skills-agent.js:826, dashboard.js:579).*

### REGRA 2 — Requests exigem visibilidade + atividade
Nenhum módulo pode consumir requests se: não estiver visível, OU não estiver ativo (tab selecionada / widget aberto), OU o usuário estiver idle além do limiar da categoria. Exceção única: **operações transacionais em andamento** (bridge em execução, tx pendente), que continuam até resolução ou timeout.

### REGRA 3 — Piso de polling: 30s
Nenhum polling pode ter intervalo < 30.000ms sem justificativa técnica registrada neste documento. Justificativas aprovadas (allowlist transacional):
| Poller | Intervalo | Justificativa |
|---|---|---|
| Bridge intent/settlement (turbo-bridge-core) | 5–6s | UX de operação financeira em andamento; termina sozinho (max polls já existe) |
| Tx receipt pendente (history) | 10s | Só enquanto existir tx pendente do usuário; para ao confirmar |
| Quote countdown (advanced-crosschain) | 1s | Timer de UI local, **0 requests** |
Todos os demais pollers < 30s do inventário atual (event bus 4s, job engine 1s, watchers 0,5–2s) devem migrar para eventos ou ≥30s.

### REGRA 4 — Toda request tem metadados obrigatórios
```
{ key, owner, category, origin, priority, ttl, scope }
```
- `owner`: módulo responsável (ex.: `treasury`)
- `category`: RPC-DIRECT | RPC-MANAGER | RPC-PROXY | INTERNAL-API | EXTERNAL-API | CACHED-API
- `origin`: user-action | module-poll | ambient-poll | boot | background | transactional
- `priority`: P0-critical (tx/segurança) · P1-user (ação direta) · P2-visible (dado na tela) · P3-ambient · P4-background
- `ttl`: obrigatório e > 0 para toda leitura
Requests sem metadados são rejeitadas pelo Request Manager (fail-fast em dev, log em prod).

### REGRA 5 — Proibida duplicação de consulta
Nenhuma informação pode ser solicitada simultaneamente por dois módulos. Todo dado tem **uma chave canônica** (`balances:<wallet>`, `pool:state`, `core:metrics`...) e um único fetcher registrado. Módulos consomem via subscribe.
*Duplicações atuais a eliminar: treasury.js + toc.js + reimbursements.js + job-engine (mesmos endpoints core/v1); autonoma.js + circle-skills-agent.js + chat-bridge.js (agent/intents); contracts-index.js + contracts.js legacy (mesmo Factory); otc.js + otc.c619b754.js (watchers duplicados).*

### REGRA 6 — Classificação obrigatória de transporte
Toda request é classificada como: **RPC Direto** · **RPC Manager** · **RPC Proxy** · **Internal API** · **External API** · **Cached API** (critérios na Fase 5). A classificação determina budget, TTL mínimo e rota.

### REGRA 7 — Nada sobrevive à saída
Ao sair da página (pagehide) ou desativar um módulo: todos os timers do módulo param, subscriptions são canceladas, fetches abortados (`AbortController`). Aba oculta > 60s: pollers P3/P4 suspensos; > 10min: apenas transacionais sobrevivem.

### REGRA 8 — Contrato de timer
Todo timer DEVE ser criado pelo Polling Manager e expor: `start() · stop() · pause() · resume() · destroy()`. `setInterval`/`setTimeout` "crus" para polling ficam proibidos (lint rule futura). Timers de UI pura (animações, countdowns sem rede) são isentos mas devem se registrar para pausa em background.

### REGRA 9 — Budget global (token bucket)
Orçamento padrão por aba-líder: **30 requests/min** para P2+P3 somados; P4 apenas com bucket cheio; P0/P1 nunca bloqueiam (bypass com log). Estouro de budget = requests adiadas por prioridade, nunca dropadas silenciosamente para P0–P2.

### REGRA 10 — Backoff e jitter obrigatórios
Todo poller: backoff exponencial em erro (×2 até 8× o intervalo) e jitter de ±10% para evitar sincronização de rebanho (thundering herd) entre usuários/abas.

### REGRA 11 — Orçamento de subrequests no edge
Nenhuma invocação de Function pode exceder **10 subrequests** no caminho feliz. Endpoints acima disso devem paginar ou agregar via cache (ex.: `GET /api/contracts` com 101 RPC → paginação + cache; já viola). Failover não conta para o cap, mas deve logar.

### REGRA 12 — Toda leitura é cacheável por padrão
Endpoints GET internos devem emitir `Cache-Control` + `ETag`. O frontend deve enviar `If-None-Match` (304 reduz payload; a invocação ainda conta, por isso o corte principal é client-side).

---

<a id="4-fase-3"></a>
## 4. FASE 3 — REQUEST MANAGER GLOBAL (RM)

**Posição:** novo módulo `public/static/shared/request-manager.js` (futuro), carregado logo após `polling-manager.js`. Singleton `window.ExecDaat.RM`. **Não substitui o fetch interceptor de security.js** — opera acima dele; o interceptor vira a rede de segurança para chamadas fora do RM.

### 4.1 Estrutura interna

```
RequestManager
├── SubscriptionRegistry     // chave canônica → {fetcher, ttl, subscribers[], lastValue}
├── InflightTracker          // dedupe: chave → Promise em andamento
├── CacheFacade              // L1 memory + ponte p/ L2 shared (Fase 6/8)
├── PriorityQueue            // P0..P4, FIFO dentro da prioridade
├── TokenBucket              // budget global + budgets por categoria (Regra 9)
├── RpcBatcher               // micro-batch: junta eth_* em janela de 100ms
│                            // → 1 POST /api/rpc (batch já suportado: até 50 itens)
├── TransportRouter          // decide RPC-DIRECT/MANAGER/PROXY/API (Fase 5)
├── RefreshController        // gates do Smart Refresh (Fase 10)
├── TabCoordinator           // integração líder/seguidor (Fase 8)
└── Metrics                  // contadores por owner/categoria → debug panel + telemetry
```

### 4.2 API pública

```js
// Leitura com cache + dedupe + coalescing (uso principal)
RM.get(key, { fetcher, ttl, priority, owner, category, origin }) → Promise<value>

// Assinatura reativa: recebe valor atual (stale imediato) + atualizações
RM.subscribe(key, callback, opts) → Subscription { unsubscribe() }

// Polling declarativo (delega ao Polling Manager; obedece lifecycle do módulo)
RM.poll(key, { interval, scope, ...opts }) → PollHandle {start,stop,pause,resume,destroy}

// RPC de leitura (entra no micro-batch automaticamente)
RM.rpc(method, params, { ttl, priority, owner }) → Promise<result>

// Escritas/críticos: passa direto (P0, sem cache, sem batch com leituras)
RM.rpcCritical(method, params) → Promise<result>

// Invalidação por evento (pós-transação, troca de wallet, etc.)
RM.invalidate(prefixOrKey)

// Registro de fetcher canônico (1 por chave — Regra 5)
RM.define(key, fetcher, defaults)

// Introspecção
RM.stats() → { requestsByOwner, cacheHitRate, budgetRemaining, inflight, queued }
```

### 4.3 Ciclo de vida

1. **Boot:** RM inicializa vazio. Nenhum fetcher roda (Regra 1). Registra listeners: `visibilitychange`, `pagehide`, `online/offline`, `focus`, eventos de wallet, BroadcastChannel.
2. **Ativação de módulo:** `switchTab('x')` → módulo chama `RM.subscribe(...)` → primeiro subscriber de uma chave dispara fetch (se cache frio) e agenda revalidação por TTL.
3. **Desativação:** módulo cancela subscriptions → última subscription cancelada = polling da chave para automaticamente (refcount 0).
4. **Pós-transação:** módulo chama `RM.invalidate('balances:')`, `RM.invalidate('history:')` → próximas leituras buscam fresco (uma vez, compartilhado).
5. **Saída:** `pagehide` → aborta in-flight, destrói timers, libera liderança.

### 4.4 Integração com módulos atuais (estratégia de adoção sem quebra)

- **Camada de compatibilidade:** os fetchers canônicos encapsulam exatamente as chamadas que os módulos já fazem (mesmos endpoints, mesmos parsers). Módulo migrado troca `fetch(...)` por `RM.get(...)` — resposta idêntica.
- **Ordem de adoção** (maior consumidor primeiro): contract-monitor → health → treasury/toc/reimbursements → dashboard → dex → history → agents → resto.
- O `PM.dedupe()` existente (polling-manager.js) é o embrião do InflightTracker — será absorvido pelo RM.

---

<a id="5-fase-4"></a>
## 5. FASE 4 — POLLING MANAGER v2

Evolução do `shared/polling-manager.js` atual (leader election + visibility já existem e serão mantidos). Passa a ser o **único dono de todos os timers** da aplicação (Regra 8).

### 5.1 Arquitetura

```
PollingManager v2
├── TimerRegistry            // id → TimerHandle (TODOS os 52 timers migram para cá)
├── LeaderElection           // existente (localStorage + BroadcastChannel) — mantido
├── VisibilityGate           // existente — centralizado (remove 26 guards duplicados)
├── ActivityTracker          // NOVO: pointer/keydown/scroll → idle 2min / deep-idle 10min
├── ModuleScopes             // NOVO: timers vinculados ao lifecycle do módulo dono
├── BackoffController        // NOVO: erro → intervalo ×2..×8; sucesso → reset; jitter ±10%
└── Scheduler                // NOVO: alinhamento de ticks (60s pollers disparam juntos
                             //        → 1 batch/snapshot em vez de N requests espalhadas)
```

### 5.2 API

```js
PM.create(id, {
  fn,                  // callback (recebe AbortSignal)
  interval,            // ms — mínimo 30_000 salvo allowlist (Regra 3)
  scope,               // 'module:<nome>' | 'tab' | 'ambient' | 'transactional'
  owner, priority,
  autoStart: false,    // default: NUNCA auto-start (Regra 1)
  alignTo,             // 'minute' → participa do tick alinhado
  maxRuns, maxAgeMs    // término automático (pollers transacionais)
}) → TimerHandle { start(), stop(), pause(), resume(), destroy(), state }
```

**Estados:** `created → running ⇄ paused → stopped → destroyed`.

### 5.3 Matriz de gates por escopo

| Escopo | Visível | Módulo ativo | Líder | Idle-stop | Sobrevive pagehide |
|---|---|---|---|---|---|
| `module:*` | ✔ exigido | ✔ exigido | — | 2min pausa | não |
| `tab` | ✔ exigido | — | — | 10min pausa | não |
| `ambient` | ✔ exigido | — | ✔ exigido | 10min pausa | não |
| `transactional` | — (roda oculto) | — | — | — | não (mas retoma via estado persistido) |

### 5.4 Gestão de estado do usuário

- **Ativo:** intervalos nominais.
- **Idle 2min:** timers `module:*` pausam; `tab` continuam.
- **Idle 10min (deep):** tudo pausa exceto `transactional`; ao retomar atividade → `resume()` + um refresh imediato coalescido (não N).
- **Aba oculta:** pausa imediata de `module/tab/ambient`; retorno à visibilidade → refresh único via RM (dados chegam do L2 se outra aba estava visível).

### 5.5 Destino dos 52 timers atuais (mapeamento)

| Grupo | Timers hoje | Destino v2 |
|---|---|---|
| Monitores ambient (health, rpc-health, contract-monitor, job-engine, event-bus, ui-sync, core-health) | 7 | `module:status` — só rodam com widget/página de status aberto; intervalos ≥60s |
| Treasury (treasury, toc, reimbursements, sync) | 4+ | 1 única subscription `snapshot:treasury` 60s |
| Watchers de estado (queue-engine 1,5s/2s, otc 0,5s, csv 5s) | ~8 | eventos (`walletConnected`, CustomEvents) — **0 timers** |
| Waiters de init (100–250ms) | ~7 | Promises/eventos de ready — **0 timers** |
| Transacionais (bridge 3–6s, receipts, schedule 30s) | ~8 | `scope:'transactional'` com maxRuns (mantidos como estão em frequência) |
| Pollers de dados por tab (dashboard, dex, history, autonoma, contracts) | ~10 | `RM.subscribe` + tick alinhado 60s |
| UI pura (countdown, banners, dispute inject) | ~8 | timers de UI registrados (pausam em background), sem rede |

---

<a id="6-fase-5"></a>
## 6. FASE 5 — RPC ARCHITECTURE

**O RPC Proxy (`src/routes/rpc-proxy.ts`) permanece intacto** — failover 4 endpoints, whitelist de 14 métodos, batch até 50, micro-cache. A mudança é **quem chega até ele e como**.

### 6.1 Três vias de RPC

```
                         ┌──────────────────────────────────────────────┐
                         │                RPC MANAGER (client)          │
   módulo pede leitura → │  classifica → cache → coalesce → batch       │
                         └───────┬──────────────┬───────────────┬───────┘
                                 │              │               │
                     [RPC DIRETO]│  [RPC MANAGER│(batch)]       │[RPC PROXY]
                                 ▼              ▼               ▼
                        Arc RPC público   POST /api/rpc    POST /api/rpc
                        (browser→Arc,     (1 batch com     (individual,
                        IP do usuário,    N leituras)      P0/crítico)
                        0 Cloudflare)
```

### 6.2 Critérios técnicos por categoria

| Categoria | Critérios (TODOS devem valer) | Exemplos | Custo CF |
|---|---|---|---|
| **RPC DIRETO** (browser → Arc, allowlist no interceptor) | leitura pública · tolera falha silenciosa · não alimenta decisão financeira · frequência ≤1/30s por usuário · fallback automático para proxy se 429/timeout | `eth_blockNumber` de UI ("network up"), `eth_chainId`, ping de health do RPC do usuário, `wallet_addEthereumChain` | **0 requests** (usa IP do usuário; alivia CF e distribui carga) |
| **RPC MANAGER** (batch via `/api/rpc`) | leitura de dados de tela · cacheável (TTL ≥15s) · agrupável com outras leituras · idempotente | `balanceOf` USDC/EURC, `getReserves`, `totalSupply`, `contractCount`, `getContract/getMilestones`, `eth_gasPrice`, pool state, token metadata | 1 request para N chamadas (batch) |
| **RPC PROXY** (individual, prioridade P0/P1) | escrita ou validação crítica · precisa failover garantido · não pode esperar janela de batch | `eth_sendRawTransaction`, `eth_getTransactionReceipt` de tx do usuário, simulação pré-envio, verificação de swap/settlement, Treasury auto-settle, intent state de bridge em execução | 1 request, até 4 subrequests (failover) |

**Regra de decisão (ordem):** é escrita ou verificação de tx? → PROXY. É dado de tela cacheável? → MANAGER (batch). É sinal público tolerante a falha? → DIRETO (com fallback para PROXY em 429 — o failover per-IP da Arc foi exatamente o motivo do proxy existir; o DIRETO é oportunista, nunca obrigatório).

### 6.3 Consolidação backend (planejada, sem remover nada)

- **Unificar os 4 clientes RPC do backend** no `createRpcClient` (arc-rpc.mjs): `contracts.ts` (hoje URL única s/ failover) e `treasury-core.ts` (ethers URL única) passam a usar o mesmo cliente com failover — coerência e resiliência.
- **`GET /api/contracts` (até 101 RPC):** planejar paginação (`?limit=10&cursor=`) + cache de lista 300s + batch JSON-RPC upstream (50 calls em 1 fetch = 101 RPC → 3 subrequests).
- **Novo endpoint agregador `GET /api/snapshot?scope=dashboard|treasury|status`:** 1 invocação retorna o pacote de dados do escopo usando os caches internos existentes (dex-cache, reserve-cache, vault-cache, ledger). Substitui 4–9 requests por 1. Não remove os endpoints atuais (compat total).

---

<a id="7-fase-6"></a>
## 7. FASE 6 — CACHE ARCHITECTURE

### 7.1 Camadas

```
L1  Memory Cache (por aba)        — Map + TTL; hit < 1ms; morre com a aba
L2  Shared Cache (entre abas)     — BroadcastChannel (push) + localStorage (snapshot
                                     para abas novas); só o líder busca; ~5ms
L3  Cache API / persistente       — caches.open('execdaat-v1') p/ dados lentos
                                     (token metadata, ABIs, listas, analytics);
                                     sobrevive a reload; SWR
L4  Edge per-isolate (existente)  — dex-cache 60s, reserve-cache 30s, vault 30s,
                                     micro-cache RPC 4–600s, contracts 15s (mantidos)
S   sessionStorage                — estado de UI por aba (não é cache de dados)
```

**Semântica padrão: SWR (stale-while-revalidate).** Módulo recebe o valor stale imediatamente (UI nunca fica vazia) e a revalidação acontece dentro dos gates/budget.

### 7.2 Tabela oficial de TTLs

| Dado | TTL fresh | Janela stale aceitável | Camadas | Invalidação por evento |
|---|---|---|---|---|
| balances (wallet) | 30s | 120s | L1+L2 | tx confirmada, troca de wallet |
| prices / rates | 30s | 60s | L1+L2+L4 | — |
| pool state / reserves | 30s | 90s | L1+L2+L4 (30–60s já existe) | swap/liquidity do usuário |
| vault | 60s | 300s | L1+L2+L4 (30s existe) | settlement |
| TVL | 120s | 600s | L1+L2 | — |
| history (listas) | 120s | ∞ (append-only) | L1+L2+L3 | tx nova do usuário |
| tx receipt pendente | 10s (poll transacional) | — | L1 | confirmação |
| contracts (lista/detalhe) | 300s | 900s | L1+L2+L3 | criação/milestone do usuário |
| analytics / depth / risk | 300s | 900s | L1+L3+L4 | — |
| treasury metrics | 120s | 300s | L1+L2+L4 | intent nova |
| treasury intents (lista) | 60s | 180s | L1+L2 | ação do usuário |
| health checks | 300s | 600s | L1+L2 | — (e só com status visível) |
| token metadata / ABIs | 24h | ∞ | L1+L3 | versão de deploy |
| gas price | 30s | 60s | L1+L2+L4 (10s existe) | — |
| blockNumber | 5s | 15s | L1+L2+L4 (4s existe) | — |

### 7.3 Regras de coerência

1. Chave canônica única por dado (Regra 5) — mesma chave em L1/L2/L3.
2. Escrita: L1 → broadcast L2 → (se categoria persistente) L3. L4 é independente (edge).
3. `RM.invalidate(prefix)` propaga para todas as camadas e todas as abas (mensagem `invalidate` no canal).
4. Versionamento: chaves prefixadas `v1:` — bump limpa tudo em deploy incompatível.
5. Dados sensíveis (sessões, PIN, chaves) **nunca** entram em L2/L3 (mantêm o esquema atual do security.js).

---

<a id="8-fase-7"></a>
## 8. FASE 7 — LAZY LOADING ARCHITECTURE

### 8.1 Contrato de lifecycle de módulo

Todo módulo implementa (registrado num `ModuleRegistry`):

```js
{
  id: 'treasury',
  init()        // 1× na primeira ativação: monta estado, define fetchers no RM
  activate()    // a cada entrada na tab: cria subscriptions, PM.start dos timers do módulo
  deactivate()  // a cada saída da tab: cancela subscriptions, PM.pause/stop, aborta fetches
  destroy()     // saída da página / limpeza total
}
```

`switchTab(x)` (app.js:41) passa a orquestrar: `deactivate(anterior)` → `activate(x)`. *(Hoje só o autonoma.js:1033 tem esse par init/destroy — vira o padrão universal.)*

### 8.2 Comportamento-alvo (conforme especificado)

```
Usuário abre o site        → 0 monitores, 0 polling, 0 requests de dados
Entra no app (Launch App)  → módulo default ativa → 1 request de snapshot
Abre Treasury              → deactivate(anterior) → activate(treasury)
                             → 1 subscription snapshot:treasury (60s, alinhado)
Abre Swap                  → treasury.deactivate() PARA tudo de treasury
                             → swap.activate() → subscription pool:state (30s)
Sai do Swap                → swap.deactivate() → 0 requests de swap
Fecha a aba                → pagehide → destroy geral, 0 vazamentos
```

**Exceção transacional:** operação em andamento (bridge, tx pendente) migra a subscription para escopo `transactional` e sobrevive à troca de tab até resolver (preserva funcionalidade atual).

### 8.3 Lazy loading por módulo (estado-alvo)

| Módulo | Ativa quando | Desativa quando | Requests em repouso |
|---|---|---|---|
| Dashboard | tab dashboard | sair da tab | 0 |
| Treasury/TOC/Reimb | tab treasury (sub-tabs compartilham snapshot) | sair | 0 |
| Swap/Pools | tab dex | sair | 0 |
| Bridge/XBridge | tab bridge | sair (menos op. ativa) | 0 |
| Contracts | tab contracts | sair | 0 |
| Payments | tab payments | sair (menos scheduler com jobs devidos) | 0 |
| OTC | tab otc | sair | 0 |
| History | tab history | sair (menos tx pendente) | 0 |
| Autonoma/Chat | painel aberto | painel fechado | 0 |
| Health/Status | widget/página status | fechar | 0 |
| Wallet | conexão (evento) | desconexão | 0 (balance via subscription só com UI que exibe saldo visível) |

### 8.4 Carregamento de código (fase posterior do roadmap, sem mudança agora)

Estado atual: ~88 scripts síncronos (~3,5–4 MB) no parse. Alvo em fase própria do roadmap: `defer` em tudo → núcleo mínimo (security, PM, RM, wallet, shell) + `import()` dinâmico por módulo na primeira ativação. *(Reduz TTI e RAM; não afeta contagem de requests de Functions — assets estáticos não contam — por isso é fase tardia e de baixo risco.)*

---

<a id="9-fase-8"></a>
## 9. FASE 8 — MULTI-TAB ARCHITECTURE

### 9.1 Avaliação das opções

| Tecnologia | Veredito | Papel no v2 |
|---|---|---|
| **BroadcastChannel** | ✔ adotar (já em uso no PM) | Barramento principal: dados, invalidações, eleição, presença |
| **localStorage + storage events** | ✔ adotar (já em uso) | Heartbeat do líder (existe) + snapshot L2 para abas novas + fallback de canal |
| **SharedWorker** | ✖ rejeitar por ora | Ideal em teoria (1 socket/scheduler por browser), mas: sem suporte em Chrome Android, complexidade de debug, exige refatoração profunda — reavaliar no futuro |
| **sessionStorage** | ✔ manter | Estado por aba (tab_id já existe) — não é compartilhamento |
| **Cache API** | ✔ adotar como L3 | Compartilhada entre abas por natureza (mesma origin) |
| **Web Locks API** | ◐ opcional | Endurecer eleição de líder (lock `execdaat-leader`) com fallback ao esquema atual |

### 9.2 Topologia líder/seguidor

```
        ┌─────────── ABA LÍDER (visível, eleita) ───────────┐
        │  PM v2 roda pollers ambient/alinhados             │
        │  RM executa fetches → grava L1 → broadcast:       │
        │     {type:'data', key, value, fetchedAt, ttl}     │
        └───────────────┬───────────────────────────────────┘
                        │ BroadcastChannel 'execdaat-rm'
        ┌───────────────┼───────────────────────────────┐
        ▼               ▼                               ▼
   ABA SEGUIDORA   ABA SEGUIDORA                  ABA OCULTA
   consome L2      pedidos ad-hoc:                tudo pausado;
   (0 fetches      {type:'request', key} →        ao voltar: lê L2
   ambient)        líder responde ou seguidor      (0 fetches)
                   busca se líder não responder em 500ms
```

**Regras:**
1. N abas = consumo de **1** aba (hoje: N× — 12 pollers respeitam líder, 40 não).
2. Failover de líder: heartbeat 5s (existe); líder some → nova eleição < 6s; seguidora visível assume.
3. Dados transacionais (`scope:'transactional'`) rodam na aba dona da operação, independente de liderança.
4. Broadcast de invalidação: tx confirmada na aba A invalida `balances:` em todas.
5. Aba nova: hidrata L1 a partir do snapshot L2 em localStorage → **primeira pintura sem nenhuma request** se TTLs válidos.

---

<a id="10-fase-9"></a>
## 10. FASE 9 — REQUEST COALESCING

### 10.1 Três níveis de coalescing

**Nível 1 — In-flight dedupe (mesma chave):**
```
ANTES: Dashboard pede balances ─► RPC     DEPOIS: Dashboard ─┐
       Treasury  pede balances ─► RPC             Treasury  ─┼─► RM: 1 fetch em voo
       Wallet    pede balances ─► RPC             Wallet    ─┘   (3 awaiters, 1 request)
```
*(Mecanismo já existe em PM.dedupe (0 usuários) e no backend (vault/contracts inflight) — vira obrigatório e universal no client.)*

**Nível 2 — Micro-batch RPC (chaves diferentes, mesma janela):**
```
janela de 100ms coleta: eth_blockNumber + balanceOf×2 + getReserves + contractCount
→ 1 POST /api/rpc [batch de 5]  (suporte a batch de 50 JÁ EXISTE no proxy)
→ 1 invocação de Function, 1 subrequest upstream
ANTES: 5 invocações, 5 subrequests.
```

**Nível 3 — Snapshot por escopo (tick alinhado de 60s):**
```
ANTES (tick de 60s com treasury aberta):           DEPOIS:
intents, metrics, health, system, policies,        GET /api/snapshot?scope=treasury
operator, vault, governance, pools, toc×4,   →     → 1 invocação
reimb×3  ≈ 16 invocações/min                       → responde do cache L4 (vault 30s,
                                                      ledger em memória) ≈ 0–6 subreq.
```

### 10.2 Fan-out da resposta

```
                    1 fetch (líder)
                         │
              ┌──────────┼───────────────┐
              ▼          ▼               ▼
        subscribers   L1 cache      BroadcastChannel
        da aba líder  (TTL)         → L2 → subscribers das outras abas
        (Dashboard, Treasury, Bridge, Pools, History — todos recebem o MESMO objeto)
```

### 10.3 Precedência de coalescing

1. Mesma chave, fetch em voo → aguarda Promise (custo 0).
2. Chave expirada + gates OK → entra na janela de batch da categoria (RPC: 100ms; API: dispara direto).
3. Múltiplos scopes ativos no tick alinhado → snapshot combinado (`?scope=dashboard,status`).
4. P0/P1 nunca esperam janela — bypass imediato.

---

<a id="11-fase-10"></a>
## 11. FASE 10 — SMART REFRESH

### 11.1 Cadeia de gates (toda revalidação passa por ela)

```
TTL expirou?  ──não──► serve L1 (fim, 0 requests)
   │sim
document.hidden == false?  ──não──► marca dirty; refresh ao voltar (1×, coalescido)
   │sim
módulo dono está ativo OU dado é compartilhado por módulo ativo? ──não──► não busca
   │sim
usuário ativo (não-idle)? ──não (idle>2min)──► adia; deep-idle 10min → suspende
   │sim
sou líder (para chaves ambient)? ──não──► espero broadcast do líder
   │sim
dado é on-chain? ──sim──► blockNumber mudou desde o último fetch?
   │                        (1 chamada barata, cacheada 5s, gate para N pesadas)
   │                        ──não──► renova TTL sem buscar (bloco igual = dado igual)
   ▼
busca (com budget/prioridade) → atualiza L1/L2 → notifica subscribers
```

### 11.2 Sinais utilizados

| Sinal | Fonte | Uso |
|---|---|---|
| blockNumber | `eth_blockNumber` batcheado (TTL 5s, micro-cache 4s no edge já existe) | Gate para reserves, balances, vault, contracts |
| timestamps/TTL | RM CacheFacade | Expiração base |
| wallet state | eventos `walletConnected/Disconnected` (existem) | Sem wallet → zero polls de balance/intents; troca → invalidate |
| active module | ModuleRegistry (Fase 7) | Gate de escopo |
| user activity | ActivityTracker (PM v2) | Idle 2min/10min |
| visibility | `visibilitychange` (existe) | Pausa/retoma + refresh-on-return coalescido |
| focus/online | `focus`, `online` | Refresh único ao voltar de sleep/offline |
| eventos de tx | pós-confirmação (módulos já sabem o momento) | Invalidação cirúrgica: `balances`, `history`, `pool` |

### 11.3 Exemplos de comportamento resultante

- Rede Arc parada (sem blocos novos): dashboard visível consome ~1 `blockNumber`/min e **nada mais** (hoje: ~15 req/min).
- Usuário leu um artigo em outra janela por 30min: **0 requests** (hoje: ~450).
- Usuário volta: 1 snapshot coalescido re-hidrata tudo.
- Usuário faz um swap: invalidação de `balances/pool/history` → 1 batch fresco → todas as telas e abas atualizadas.

---

<a id="12-fase-11"></a>
## 12. FASE 11 — ESCALABILIDADE

### 12.1 Premissas de perfil de uso (por usuário/dia)

- 20 min de uso ativo (aba visível, interagindo), 100 min de aba aberta em background, 1,5 sessões, 10 ações transacionais/dia (quotes, swaps, envios), 1,4 abas em média.

**v1 (medido/derivado da auditoria):** visível ~15 req/min; background ainda consome (guards parciais) ~10 req/min; multi-tab multiplica ~1,4×.
**v2 (projetado):** visível ~1,2 req/min (snapshot 60s + blockNumber batcheado + ações); background 0; multi-tab 1×; boot 0; +ações transacionais idênticas ao v1 (~30 req/dia).

### 12.2 Requests em Functions por dia

| Usuários | v1 requests/dia | v2 requests/dia | Situação Cloudflare |
|---|---|---|---|
| 1 | ~3.900 | ~55 | ambos ok |
| 100 | ~390.000 | ~5.500 | **v1 = 3,9× o limite Free (100k/dia)** · v2 = 5,5% do Free |
| 1.000 | ~3.900.000 | ~55.000 | v1 exige plano pago + $$ · **v2 ainda cabe no Free (55%)** |
| 10.000 | ~39.000.000 | ~550.000 | v1 ≈ 1,17 bi/mês ≈ **US$ 350+/mês** · v2 ≈ 16,5M/mês ≈ **US$ 7/mês** (Workers Paid US$ 5 + excedente) |

### 12.3 Subrequests por dia (upstream: Arc RPC, Circle, core)

Fator v1: ~1,3×/request no caminho feliz (até 4× em failover; picos de 8× no arc-rpc e 101 no /api/contracts).
Fator v2: ~1,1×/request com caps (Regra 11) + batch upstream (N leituras = 1 subrequest) + edge caches servindo a maioria dos ticks.

| Usuários | v1 subrequests/dia | v2 subrequests/dia | Observação |
|---|---|---|---|
| 1 | ~5.100 | ~60 | |
| 100 | ~510.000 | ~6.000 | v2: edge cache faz subrequests ≈ invariantes dentro do TTL |
| 1.000 | ~5.100.000 | ~45.000* | *sub-linear: 1 isolate busca pool state 1×/30s independente de quantos usuários pedem |
| 10.000 | ~51.000.000 | ~300.000* | pressão sobre Arc RPC cai ~99% — o problema dos 429 que originou o proxy também é mitigado na fonte |

### 12.4 Uso de cache projetado (v2, 1.000 usuários)

| Camada | Hit rate esperado | Efeito |
|---|---|---|
| L1 memória | 60–70% das leituras de módulo | UI instantânea |
| L2 multi-tab | +10% (usuários com 2+ abas) | N abas = 1 consumo |
| L4 edge (dex/reserve/vault/micro) | 80–95% dos ticks de snapshot | subrequests sub-lineares |
| L3 Cache API | ~100% para metadata/ABIs | 0 refetch entre sessões |

### 12.5 Guard-rails de escala

- Jitter ±10% nos ticks alinhados evita rajadas sincronizadas de milhares de clientes no mesmo segundo.
- Budget por aba (Regra 9) limita o pior cliente a ~43k req/dia mesmo com bug (hoje: ilimitado).
- Telemetria do RM (`RM.stats()`) exposta no debug panel + `exd_telemetry` permite medir o consumo real por owner e comparar com este plano (base para o gate de aceitação do roadmap).

---

<a id="13-fase-12"></a>
## 13. FASE 12 — ROADMAP DE IMPLEMENTAÇÃO

> Nenhuma fase abaixo foi iniciada. Ordem otimizada por (impacto ÷ risco). Cada fase tem critério de aceitação mensurável via telemetria RM + dashboard Cloudflare. Rollback: cada fase atrás de flag em `shared/config.js` (`FEATURES.RM_*`).

| # | Fase | Conteúdo | Depende de | Impacto req. | Risco | Critério de aceitação |
|---|---|---|---|---|---|---|
| **F1** | **Request Manager** | RM core: define/get/subscribe, L1, dedupe, metadados (Regras 4/5), telemetria. Migração dos 5 maiores consumidores (contract-monitor, health, treasury trio, dashboard, dex) | — | −40–50% | médio | consumo/idle-user ≤ 6 req/min |
| **F2** | **Polling Manager v2** | TimerRegistry, contrato start/stop/pause/resume/destroy, ActivityTracker, backoff+jitter, migração dos 52 timers, piso 30s (Regra 3) | F1 | −15% | baixo | 0 setInterval fora do PM (auditoria grep) |
| **F3** | **Lazy Initialization** | ModuleRegistry + activate/deactivate em switchTab; monitores ambient → module:status; boot com 0 requests (Regra 1) | F1,F2 | −20% | médio | abrir site = 0 requests de dados; trocar de tab desliga módulo anterior |
| **F4** | **Smart Refresh** | Cadeia de gates, block-gating, refresh-on-return coalescido, invalidação por evento de tx | F1,F2 | −10–15% | baixo | rede sem blocos novos → ≤1 req/min |
| **F5** | **Request Coalescing** | RpcBatcher (janela 100ms → batch /api/rpc), tick alinhado 60s, endpoint agregador `/api/snapshot` (aditivo, sem tocar endpoints atuais) | F1 | −10% req, −50% invocações de tick | médio | tick treasury = 1 invocação (era ~16) |
| **F6** | **Multi-tab Management** | L2 SharedCache (broadcast+snapshot), request forwarding, invalidação cross-tab, Web Locks opcional | F1 | −20% p/ multi-aba | baixo | 2ª aba = +0 req/min ambient |
| **F7** | **Cache Architecture** | Tabela de TTLs oficial, SWR universal, L3 Cache API, ETag/Cache-Control nos GETs internos | F1,F5,F6 | −5–10% + subreq. | baixo | hit-rate L1+L2 ≥ 70% |
| **F8** | **RPC Architecture** | Classificação DIRETO/MANAGER/PROXY, allowlist no interceptor c/ fallback, unificação dos 4 clientes backend no arc-rpc, cap de subrequests + paginação /api/contracts (Regra 11) | F1,F5 | subreq. −30% | médio | p95 subrequests/invocação ≤ 4; /api/contracts ≤ 10 |
| **F9** | **Testes** | Suite: lifecycle de módulos, eleição de líder, coalescing, budget, TTLs, regressão funcional completa (176 testes atuais verdes + novos), teste de carga sintético (simulador de N clientes) | F1–F8 | — | — | 100% funcionalidades preservadas; simulação 1k users ≤ 60k req/dia |
| **F10** | **Deploy em produção** | Rollout gradual por flag: 10% → 50% → 100%; monitorar dashboard CF por 72h por etapa; rollback = desligar flag | F9 | — | — | Cloudflare: −80%+ requests/dia confirmado em produção |

**Sequência de execução sugerida:** F1 → F2 → F3 → F4 (corta ~80% sozinho) → F5 → F6 → F7 → F8 (consolida e ataca subrequests) → F9 → F10.
**Fase extra (pós-v2, opcional):** bundling/defer/dynamic-import dos ~88 scripts (performance de boot; não afeta contagem de Functions).

---

<a id="14-reducao"></a>
## 14. ESTIMATIVA CONSOLIDADA DE REDUÇÃO

### 14.1 Requests (invocações de Pages Functions)

| Cenário | v1 | v2 | Redução |
|---|---|---|---|
| Usuário ocioso, dashboard visível | ~15 req/min | ~1,2 req/min | **−92%** |
| Usuária com Treasury aberta | ~44 req/min | ~1,2 req/min | **−97%** |
| Aba em background | ~10 req/min | 0 | **−100%** |
| 2ª/3ª aba do mesmo usuário | ~1× cada | ~0 | **−100%** |
| Boot do site | 5–10 req | 0 | **−100%** |
| Ações transacionais (swap, bridge, send) | X | X (inalterado por design) | 0% (preservado) |
| **Agregado diário (perfil médio)** | **~3.900/user** | **~55/user** | **≈ −86% a −98% → meta >80% ✔** |

### 14.2 Subrequests

| Vetor | v1 | v2 | Mecanismo |
|---|---|---|---|
| Fator médio por invocação | ~1,3 | ~1,1 | caps + cache edge |
| N leituras RPC do client | N invocações × 1–4 | 1 batch × 1–4 | micro-batch (suporte já existe no proxy) |
| Pior endpoint (/api/contracts) | até 101 | ≤ 10 | paginação + batch + cache 300s |
| Pressão total upstream (1k users) | ~5,1M/dia | ~45k/dia | **≈ −99% → meta >80% ✔** |

### 14.3 Preservação (checklist de invariantes)

| Invariante | Status no projeto v2 |
|---|---|
| 100% das funcionalidades | ✔ módulos consomem os mesmos dados, via RM |
| RPC Proxy | ✔ intacto; segue sendo a rota de críticos + failover |
| Failover multi-RPC | ✔ intacto no proxy; estendido a contracts/treasury-core (melhoria) |
| Integrações (Circle, OpenAI, Treasury Core) | ✔ intocadas |
| UI/UX | ✔ idêntica; SWR elimina telas vazias; frequências transacionais mantidas |
| Smart Contracts / on-chain | ✔ zero mudanças |
| Cloudflare Free | ✔ v2 com 1.000 usuários ≈ 55% do limite Free |

---

## APÊNDICE A — Inventário de referência (auditoria 2026-07-17)

- 52 pollers mapeados (tabela completa no relatório de auditoria da sessão): destaque para os que violam a futura Regra 3: job-engine 1s, queue-engine 1,5–2s, event-bus 4s, otc 0,5s, chat banner 5s, security scanner 2s, dispute inject 2,5s.
- Auto-start (violam futura Regra 1): dashboard.js:579, contracts-index.js:64, contracts.js:3760, otc.js:3856/3891, treasury-event-bus.js:279, treasury-job-engine.js:301, circle-skills-agent.js:826, health.js:189, rpc.js:248, contract-monitor.js:171, security.js:440, cache.js:121, telemetry.js:142.
- Backend: rpc-proxy.ts (batch 50, micro-cache, whitelist 14 métodos, 4×1 failover), arc-rpc.mjs (4×2), dex-cache 60s, reserve-cache 30s, vault-cache 30s/block 12s, contracts read-cache 15s (URL única), treasury.ts metaRouter proxy-cache 30–300s.
- Duplicatas a consolidar (Regra 5): treasury/toc/reimb/job-engine; autonoma/circle-skills/chat-bridge; contracts-index/contracts legacy; otc.js/otc.c619b754.js.

*Documento de arquitetura — nenhuma linha de código do sistema foi alterada nesta fase.*
