# busca-tudo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** App Electron pessoal (Windows) + serviço em segundo plano que cadastra acompanhamentos por conversa com Claude, verifica com busca inteligente, alerta no WhatsApp e gera relatórios.

**Architecture:** Dois processos sobre o mesmo SQLite. O serviço (Node/TS, sem UI) agenda, verifica, alerta e gera relatórios, e expõe uma API HTTP local com token. O app Electron é só interface e fala com essa API. A lógica de decisão de alerta e estatísticas é código puro e testável; a IA só busca/extrai/conversa.

**Tech Stack:** Node 20+, TypeScript, Electron, better-sqlite3, @anthropic-ai/sdk, whatsapp-web.js, vitest. UI do renderer em HTML/JS simples (sem framework).

**Spec:** `docs/superpowers/specs/2026-11-26-busca-tudo-design.md`

## Global Constraints

- Windows; tudo local; sem login, sem servidor, sem nuvem.
- Chave da Anthropic criptografada com DPAPI do Windows (ligada ao usuário), nunca em texto puro; o serviço precisa conseguir ler.
- Modelos: conversa de cadastro `claude-sonnet-5-5`; verificações e texto de resumo `claude-haiku-5-5`; baixa confiança escala **uma vez** para `claude-sonnet-5-5`. Configuráveis.
- Intervalo mínimo de verificação: 15 minutos.
- Alerta vai para o próprio número do usuário no WhatsApp (whatsapp-web.js, QR uma vez).
- Verificação: planejar consultas, cruzar ≥2 fontes quando possível, resultado estruturado (`found, value, currency, source_url, evidence, confidence`).
- **O código decide o alerta**, não a IA. Primeira verificação de preço só grava linha de base.
- Falhas repetidas aparecem no app, nunca no WhatsApp. Período de resumo sem nada relevante não envia mensagem.
- Retomada após suspensão: **uma** verificação atrasada por acompanhamento, não várias.
- API local em `127.0.0.1`, porta fixa, token aleatório em arquivo do usuário. Dados em `%APPDATA%\busca-tudo`.
- Serviço inicia no logon do Windows via tarefa agendada, sem janela.
- Fora da v1: exportar CSV/PDF, abordagens B/C (URL fixa).

## Review Focus

- Chave da Anthropic ausente/inválida ou sem crédito: verificações pausam com erro visível no app, sem travar o serviço nem enviar WhatsApp.
- Resposta da IA malformada (JSON inválido, `value` como texto "R$ 1.999,90", moeda faltando): tratada como falha da verificação, sem gravar lixo no histórico.
- WhatsApp desconectado/QR expirado quando um alerta dispara: alerta fica pendente e é reenviado ao reconectar, sem perder nem duplicar.
- Serviço reiniciado no meio de um ciclo ou PC acordando após dias: sem rajada de verificações; sem alerta duplicado do mesmo achado.
- Preço oscilando entre lojas (R$ 100 → 90 → 100 → 90): comportamento previsível documentado (alerta quando abaixo do **último valor registrado**), sem alertas a cada verificação por ruído de mesmo valor.

---

## File Structure

```
package.json, tsconfig.json, vitest.config.ts
src/shared/types.ts            tipos compartilhados (Tracker, Finding, ...)
src/service/db.ts              schema + repositórios SQLite
src/service/decide.ts          decideAlert (puro)
src/service/cost.ts            custo estimado + limite
src/service/secrets.ts         chave Anthropic via DPAPI
src/service/llm.ts             interface LlmClient + implementação Anthropic
src/service/checker.ts         verificação inteligente
src/service/pipeline.ts        runCheck: checker -> decide -> grava -> alerta
src/service/notifier.ts        interface Notifier + WhatsApp + fila pendente
src/service/scheduler.ts       agendamento, catch-up, limite de custo
src/service/reports.ts         estatísticas + resumo periódico
src/service/setupChat.ts       conversa de cadastro (tool create_tracker)
src/service/api.ts             API HTTP local
src/service/main.ts            entrada do serviço
src/app/main.ts, preload.ts    Electron main/preload
src/app/startup.ts             registrar/remover tarefa agendada
src/app/renderer/index.html, app.js, styles.css
tests/*.test.ts
```

---

### Task 1: Scaffold e tipos compartilhados

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/shared/types.ts`, `tests/types.test.ts`

**Interfaces:**
- Produces (`src/shared/types.ts`):
  - `type TrackerKind = 'price' | 'news' | 'generic'`
  - `type AlertCondition = { type: 'below_last' } | { type: 'below_value'; value: number } | { type: 'new_items' }`
  - `interface Tracker { id: number; name: string; kind: TrackerKind; goal: string; include: string[]; exclude: string[]; intervalMinutes: number; alertCondition: AlertCondition; digest: 'none' | 'daily' | 'weekly'; status: 'active' | 'paused'; createdAt: string }`
  - `type NewTracker = Omit<Tracker, 'id' | 'status' | 'createdAt'>`
  - `interface Finding { found: boolean; value?: number; currency?: string; title?: string; sourceUrl?: string; evidence: string; confidence: number }` (confidence 0..1)
  - `const MIN_INTERVAL_MINUTES = 15`
  - `function validateNewTracker(t: NewTracker): string[]` (lista de erros; vazia se válido)

- [ ] **Step 1: Write the failing test** em `tests/types.test.ts`: `validateNewTracker` rejeita `intervalMinutes: 5` (erro menciona 15), rejeita `alertCondition below_value` com `value <= 0`, rejeita `name` vazio, aceita um tracker de preço válido (retorna `[]`).
- [ ] **Step 2: Run** `npx vitest run tests/types.test.ts` — Expected: FAIL (módulo não existe).
- [ ] **Step 3:** Criar o scaffold (scripts `test`, `build`, `service`, `app`; deps listadas na Tech Stack; `strict: true`) e implementar `validateNewTracker`.
- [ ] **Step 4: Run** `npx vitest run` — Expected: PASS.
- [ ] **Step 5: Commit** `chore: scaffold and shared types`.

### Task 2: Banco de dados

**Files:**
- Create: `src/service/db.ts`
- Test: `tests/db.test.ts`

**Interfaces:**
- Consumes: tipos da Task 1.
- Produces:
  - `function openDb(path: string): Db` (`':memory:'` aceito; cria schema se faltar)
  - `Db` com: `createTracker(t: NewTracker): Tracker`, `listTrackers(): Tracker[]`, `getTracker(id): Tracker | undefined`, `updateTracker(id, patch: Partial<NewTracker & { status: Tracker['status'] }>): Tracker`, `deleteTracker(id): void`
  - `addCheck(c: { trackerId: number; at: string; ok: boolean; error?: string; findings: Finding[]; model: string; costUsd: number }): number`, `listChecks(trackerId, limit?: number): CheckRow[]`, `lastCheckAt(trackerId): string | undefined`
  - `lastValue(trackerId): number | undefined` (valor do melhor finding da última verificação `ok` que tinha valor)
  - `markSeen(trackerId, key: string): boolean` (true se era novo), `addAlert(a: { trackerId; at; text; sourceUrl?; value?; delivered: boolean }): number`, `pendingAlerts(): AlertRow[]`, `markDelivered(id): void`, `lastAlertAt(trackerId): string | undefined`
  - `getSetting(key): string | undefined`, `setSetting(key, value): void`
  - `addReport(r: { trackerId?: number; period: string; text: string; at: string }): number`, `listReports(filter?: { since?: string }): ReportRow[]`

- [ ] **Step 1: Write the failing tests** (`tests/db.test.ts`): `createTracker` persiste arrays `include/exclude` e `alertCondition` (roundtrip igual); `markSeen` retorna `true` e depois `false` para a mesma chave; `lastValue` ignora verificações com `ok:false`; `pendingAlerts` retorna só `delivered:false` e some após `markDelivered`; `deleteTracker` apaga checks/alertas dele (cascade).
- [ ] **Step 2: Run** `npx vitest run tests/db.test.ts` — FAIL.
- [ ] **Step 3: Implement** com `better-sqlite3`, JSON em colunas de texto para arrays/condição, `PRAGMA foreign_keys = ON`, `ON DELETE CASCADE`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: sqlite persistence layer`.

### Task 3: Decisão de alerta (código puro)

**Files:**
- Create: `src/service/decide.ts`
- Test: `tests/decide.test.ts`

**Interfaces:**
- Consumes: `Tracker`, `Finding`.
- Produces:
  - `const MIN_CONFIDENCE = 0.6`, `const ALERT_COOLDOWN_MINUTES = 60`
  - `interface DecisionContext { lastValue?: number; isNew(key: string): boolean; lastAlertAt?: string; now: string }`
  - `interface Decision { baseline: boolean; alert?: { text: string; sourceUrl?: string; value?: number }; ignored: string[] }`
  - `function decideAlert(t: Tracker, findings: Finding[], ctx: DecisionContext): Decision`
  - `function parsePrice(raw: unknown): number | undefined` (aceita número, `"R$ 1.999,90"`, `"1,999.90"`, `"1999.9"`; rejeita ≤0 e NaN)

- [ ] **Step 1: Write the failing tests:**
  - preço, sem `lastValue`: `baseline: true`, sem alerta.
  - preço `below_last`: último 100, finding 90 conf 0.9 → alerta; finding 100 → sem alerta; finding 110 → sem alerta.
  - `below_value` 50: finding 49 → alerta, 51 → não.
  - finding com confiança 0.4 é ignorada (aparece em `ignored`).
  - várias findings de preço: usa a de menor valor entre as confiáveis.
  - `found: false` → sem alerta, sem baseline.
  - notícia `new_items`: só findings com `isNew(sourceUrl ?? title)`; zero novas → sem alerta; texto lista as novas.
  - cooldown: `lastAlertAt` há 10 min e mesmo `sourceUrl` → sem alerta; há 90 min → alerta.
  - `parsePrice('R$ 1.999,90') === 1999.9`, `parsePrice('1,999.90') === 1999.9`, `parsePrice('grátis') === undefined`, `parsePrice(-3) === undefined`.
- [ ] **Step 2: Run** `npx vitest run tests/decide.test.ts` — FAIL.
- [ ] **Step 3: Implement** as funções; texto do alerta em PT-BR com nome do tracker, valor anterior → novo e link.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: pure alert decision logic`.

### Task 4: Custo e limite

**Files:**
- Create: `src/service/cost.ts`
- Test: `tests/cost.test.ts`

**Interfaces:**
- Produces:
  - `interface Usage { model: string; inputTokens: number; outputTokens: number; searches: number }`
  - `function estimateCostUsd(u: Usage): number` (tabela de preços em constante no arquivo, com `searches * 0.01`)
  - `function spentSince(db: Db, sinceIso: string): number` (soma `costUsd` das checks)
  - `function overLimit(db: Db, now: Date): { over: boolean; period?: 'day' | 'month' }` usando settings `limit_day_usd` / `limit_month_usd` (ausente = sem limite)

- [ ] **Step 1: Write the failing tests:** custo de Usage conhecido (valores fixos da tabela); `overLimit` falso sem settings; verdadeiro com `limit_day_usd=0.5` e checks de hoje somando 0.6; checks de ontem não contam para o dia mas contam para o mês.
- [ ] **Step 2: Run** `npx vitest run tests/cost.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Usar a skill `claude-api` para conferir preços atuais antes de fixar a tabela.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: cost estimation and spend limits`.

### Task 5: Segredos (chave Anthropic via DPAPI)

**Files:**
- Create: `src/service/secrets.ts`
- Test: `tests/secrets.test.ts`

**Interfaces:**
- Produces: `function saveApiKey(dir: string, key: string): Promise<void>`, `function loadApiKey(dir: string): Promise<string | undefined>`, `function clearApiKey(dir: string): void`. Arquivo `anthropic.key` em `dir`.

- [ ] **Step 1: Write the failing tests** (pulados fora do Windows com `describe.skipIf`): roundtrip devolve a mesma chave; o conteúdo do arquivo **não contém** a chave em texto puro; `loadApiKey` sem arquivo → `undefined`; arquivo corrompido → `undefined` (não lança).
- [ ] **Step 2: Run** `npx vitest run tests/secrets.test.ts` — FAIL.
- [ ] **Step 3: Implement** chamando PowerShell (`ConvertTo-SecureString -AsPlainText` + `ConvertFrom-SecureString`, e o inverso) via `child_process.execFile`, passando a chave por **stdin**, nunca por argumento de linha de comando.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: DPAPI-backed api key storage`.

### Task 6: Cliente LLM e verificação inteligente

**Files:**
- Create: `src/service/llm.ts`, `src/service/checker.ts`
- Test: `tests/checker.test.ts`

**Interfaces:**
- Consumes: `Finding`, `Tracker`, `Usage`, `parsePrice`.
- Produces (`llm.ts`):
  - `interface LlmClient { search(req: { model: string; system: string; prompt: string }): Promise<{ text: string; usage: Usage }>; chat(req: { model: string; system: string; messages: ChatMessage[]; tools?: ToolDef[] }): Promise<ChatReply> }`
  - `function createAnthropicClient(apiKey: string): LlmClient` (usa a ferramenta de busca na web da Anthropic no `search`; verificar nome/versão atual da ferramenta com a skill `claude-api`)
- Produces (`checker.ts`):
  - `interface CheckOutcome { findings: Finding[]; usage: Usage; escalated: boolean }`
  - `function runSmartCheck(llm: LlmClient, t: Tracker, models: { routine: string; escalate: string }): Promise<CheckOutcome>`
  - `class CheckError extends Error` (resposta inválida / API falhou)

- [ ] **Step 1: Write the failing tests** com `LlmClient` falso:
  - o prompt enviado contém `goal`, cada item de `include` e `exclude`, e instrui planejar variações de consulta e cruzar ≥2 fontes;
  - resposta JSON válida → `findings` parseados; `value: "R$ 1.999,90"` vira `1999.9`;
  - JSON inválido ou sem `findings` → `CheckError`, nada devolvido;
  - maior confiança < 0.6 com modelo rotina → chama de novo com `escalate` e `escalated: true`; **no máximo uma** escalada (confiança baixa de novo → devolve o resultado da escalada sem terceira chamada);
  - JSON dentro de bloco ```json é aceito;
  - `usage` soma as chamadas feitas.
- [ ] **Step 2: Run** `npx vitest run tests/checker.test.ts` — FAIL.
- [ ] **Step 3: Implement** `runSmartCheck`: prompt de sistema exige saída só JSON `{"findings":[{found,value,currency,title,source_url,evidence,confidence}]}`; extrair JSON da resposta; normalizar com `parsePrice` e clamp de `confidence` em 0..1.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: smart check with escalation`.

### Task 7: Notificador (WhatsApp) com fila pendente

**Files:**
- Create: `src/service/notifier.ts`
- Test: `tests/notifier.test.ts`

**Interfaces:**
- Consumes: `Db` (`addAlert`, `pendingAlerts`, `markDelivered`).
- Produces:
  - `interface Transport { isReady(): boolean; sendToSelf(text: string): Promise<void> }`
  - `class Notifier { constructor(db: Db, transport: Transport); send(trackerId: number, text: string, extra?: { sourceUrl?: string; value?: number }): Promise<void>; flushPending(): Promise<number> }`
  - `function createWhatsAppTransport(authDir: string, onQr: (qr: string) => void, onStatus: (s: 'disconnected' | 'qr' | 'ready') => void): Transport`

- [ ] **Step 1: Write the failing tests** com `Transport` falso: pronto → `send` entrega e grava `delivered: true`; não pronto → grava `delivered: false` e não lança; `flushPending` entrega os pendentes quando fica pronto, retorna a contagem, e uma segunda chamada não reenvia; erro de envio em um pendente deixa-o pendente e segue para os demais.
- [ ] **Step 2: Run** `npx vitest run tests/notifier.test.ts` — FAIL.
- [ ] **Step 3: Implement** `Notifier` e o transporte real (whatsapp-web.js com `LocalAuth` em `authDir`, headless; envia para o número do próprio cliente conectado).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: whatsapp notifier with pending queue`.

### Task 8: Pipeline de verificação

**Files:**
- Create: `src/service/pipeline.ts`
- Test: `tests/pipeline.test.ts`

**Interfaces:**
- Consumes: `Db`, `LlmClient`, `runSmartCheck`, `decideAlert`, `Notifier`, `estimateCostUsd`.
- Produces: `function runCheck(deps: { db: Db; llm: LlmClient; notifier: Notifier; models: { routine: string; escalate: string }; now: () => Date }, trackerId: number): Promise<{ ok: boolean; alerted: boolean; baseline: boolean; error?: string }>`

- [ ] **Step 1: Write the failing tests** (db `:memory:`, LLM e transporte falsos):
  - 1ª verificação de preço: grava check `ok`, `baseline: true`, nenhum alerta;
  - 2ª com valor menor: `alerted: true`, `addAlert` gravado, valor novo vira `lastValue`;
  - mesmo valor de novo: sem alerta (caso do Review Focus de oscilação: 100→90 alerta; 90→100 não alerta; 100→90 alerta de novo, e só se passou o cooldown);
  - `CheckError` → check gravado com `ok:false` e `error`, sem alerta, sem lançar, `lastValue` intacto;
  - notícia: mesmo `sourceUrl` em duas verificações alerta só na primeira (via `markSeen`);
  - tracker pausado/inexistente → `{ ok:false, error }` sem chamar LLM.
- [ ] **Step 2: Run** `npx vitest run tests/pipeline.test.ts` — FAIL.
- [ ] **Step 3: Implement** orquestrando: carregar tracker → `runSmartCheck` → `decideAlert` (ctx montado do db) → `addCheck` (com `costUsd`) → se alerta, `notifier.send`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: check pipeline`.

### Task 9: Agendador

**Files:**
- Create: `src/service/scheduler.ts`
- Test: `tests/scheduler.test.ts`

**Interfaces:**
- Consumes: `Db`, `overLimit`, `runCheck` (injetado como função).
- Produces:
  - `class Scheduler { constructor(deps: { db: Db; run: (id: number) => Promise<unknown>; now: () => Date; tickMs?: number }); start(): void; stop(): void; tick(): Promise<void> }`
  - `tick()` executa, em sequência (nunca em paralelo), os trackers `active` cujo `lastCheckAt + intervalMinutes <= now` (ou sem check). Se `overLimit`, não executa nada.

- [ ] **Step 1: Write the failing tests** (relógio falso, `run` falso): tracker nunca checado roda; tracker checado há menos que o intervalo não roda; pausado não roda; PC "acordando" 3 dias depois com intervalo 15 min → `run` chamado **uma vez** por tracker no tick; `overLimit` verdadeiro → `run` nunca chamado; erro lançado por `run` em um tracker não impede o próximo; `tick` reentrante enquanto outro roda não duplica execuções.
- [ ] **Step 2: Run** `npx vitest run tests/scheduler.test.ts` — FAIL.
- [ ] **Step 3: Implement** `tick` + `setInterval` de 30 s em `start`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: scheduler with catch-up and spend cap`.

### Task 10: Relatórios

**Files:**
- Create: `src/service/reports.ts`
- Test: `tests/reports.test.ts`

**Interfaces:**
- Consumes: `Db`, `LlmClient`, `Notifier`.
- Produces:
  - `interface TrackerStats { trackerId: number; checks: number; failures: number; min?: number; max?: number; avg?: number; alerts: number; relevant: Array<{ at: string; title?: string; value?: number; sourceUrl?: string }> }`
  - `function computeStats(db: Db, trackerId: number, fromIso: string, toIso: string): TrackerStats` (min/max/avg só de verificações `ok`; `relevant` = findings que geraram alerta no período)
  - `function generateDigest(deps: { db: Db; llm: LlmClient; notifier: Notifier; model: string; sendWhatsApp: boolean; now: () => Date }, period: 'daily' | 'weekly'): Promise<{ sent: boolean; text?: string }>`
  - `function dueDigests(db: Db, now: Date): Array<'daily' | 'weekly'>` (qual resumo venceu desde o último gerado, guardado em settings)

- [ ] **Step 1: Write the failing tests:** `computeStats` com checks/alertas conhecidos devolve min/max/avg/alerts exatos e ignora falhas nos números mas conta em `failures`; período sem nenhum achado relevante → `generateDigest` retorna `sent: false` e **não** chama LLM nem notifier; com relevantes → texto vem do LLM, é gravado em `reports`, e o notifier só é chamado se `sendWhatsApp`; o prompt ao LLM contém os números calculados (a IA recebe os números, não os calcula); `dueDigests` não repete o resumo já gerado hoje.
- [ ] **Step 2: Run** `npx vitest run tests/reports.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Agendador do resumo é chamado do `main.ts` do serviço (Task 12).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: reports and periodic digest`.

### Task 11: Conversa de cadastro

**Files:**
- Create: `src/service/setupChat.ts`
- Test: `tests/setupChat.test.ts`

**Interfaces:**
- Consumes: `LlmClient.chat`, `validateNewTracker`.
- Produces:
  - `class SetupSession { constructor(llm: LlmClient, model: string); send(userText: string): Promise<{ reply: string; proposal?: NewTracker; errors?: string[] }> }`
  - A ferramenta `create_tracker` (input = `NewTracker`) é exposta ao modelo; quando ele a chama, `proposal` vem preenchido **sem salvar**. Quem salva é a API após o usuário confirmar (Task 12).

- [ ] **Step 1: Write the failing tests** com `chat` falso: mensagem comum → `reply` sem `proposal`; resposta com `tool_use create_tracker` válido → `proposal` igual ao input; ferramenta com `intervalMinutes: 5` → `errors` com o motivo e o erro devolvido ao modelo para ele corrigir/perguntar; histórico acumulado entre `send`s (a 2ª chamada ao LLM contém as mensagens anteriores); o system prompt manda perguntar só o que falta e exige frequência, condição de alerta e restrições antes de chamar a ferramenta.
- [ ] **Step 2: Run** `npx vitest run tests/setupChat.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: conversational tracker setup`.

### Task 12: API local e entrada do serviço

**Files:**
- Create: `src/service/api.ts`, `src/service/main.ts`
- Test: `tests/api.test.ts`

**Interfaces:**
- Consumes: tudo das Tasks 2–11.
- Produces `function createApi(deps: ApiDeps): http.Server` com rotas JSON, todas exigindo `Authorization: Bearer <token>` (sem token válido → 401):
  - `GET /status` → `{ running: true, whatsapp: 'disconnected'|'qr'|'ready', qr?: string, hasApiKey: boolean, lastCheckAt?: string, overLimit: boolean }`
  - `PUT /settings` (chave Anthropic, modelos, limites, `digest`, `sendReportsToWhatsApp`)
  - `GET/POST /trackers`, `PATCH/DELETE /trackers/:id`, `POST /trackers/:id/check` (verificar agora), `GET /trackers/:id/checks`
  - `POST /setup/:sessionId/message` → resultado de `SetupSession.send`; `POST /setup/:sessionId/confirm` → cria o tracker da última `proposal`
  - `GET /reports?since=`, `GET /trackers/:id/stats?from=&to=`
- `main.ts`: carrega/gera token em `%APPDATA%\busca-tudo\token`, abre db, sobe WhatsApp, `Scheduler`, `flushPending` ao ficar `ready`, verificação periódica de `dueDigests`, API em `127.0.0.1:47831`, falha clara se a porta estiver ocupada.

- [ ] **Step 1: Write the failing tests** (servidor em porta efêmera, dependências falsas): sem token → 401; `POST /trackers` com `intervalMinutes: 5` → 400 com mensagem; `confirm` sem `proposal` pendente → 409; fluxo `message` → `confirm` cria tracker listado em `GET /trackers`; `GET /status` com `hasApiKey: false` quando não há chave; `PUT /settings` com a chave nunca a devolve em nenhuma resposta.
- [ ] **Step 2: Run** `npx vitest run tests/api.test.ts` — FAIL.
- [ ] **Step 3: Implement** com `node:http` puro; ligar `main.ts`. Sem chave Anthropic, o serviço sobe, `Scheduler` não executa e o status informa `hasApiKey:false`.
- [ ] **Step 4: Run** `npx vitest run` (suíte toda) — PASS.
- [ ] **Step 5: Commit** `feat: local api and service entrypoint`.

### Task 13: Inicialização com o Windows

**Files:**
- Create: `src/app/startup.ts`
- Test: `tests/startup.test.ts`

**Interfaces:**
- Produces: `function buildInstallArgs(opts: { nodePath: string; servicePath: string }): string[]` (argumentos do `schtasks /Create`: tarefa `busca-tudo-service`, gatilho `ONLOGON`, usuário atual, `/RL LIMITED`, `/F`), `function buildRemoveArgs(): string[]`, `function installStartup(...)`, `function removeStartup()`, `function isStartupInstalled(): Promise<boolean>`.

- [ ] **Step 1: Write the failing tests** só sobre `buildInstallArgs`/`buildRemoveArgs` (comando exato, caminhos com espaço corretamente tratados como um único argumento).
- [ ] **Step 2: Run** `npx vitest run tests/startup.test.ts` — FAIL.
- [ ] **Step 3: Implement**; a execução real usa `execFile('schtasks', args)`. A tarefa deve iniciar o Node **oculto** (sem janela de console; usar `wscript`/`powershell -WindowStyle Hidden` ou `pythonw`-equivalente em Node, à escolha do implementador, desde que sem janela).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: windows logon startup registration`.

### Task 14: App Electron (interface)

**Files:**
- Create: `src/app/main.ts`, `src/app/preload.ts`, `src/app/renderer/index.html`, `src/app/renderer/app.js`, `src/app/renderer/styles.css`
- Test: `tests/apiClient.test.ts` (cliente HTTP do app, `src/app/apiClient.ts`)

**Interfaces:**
- Consumes: rotas da Task 12; `installStartup/removeStartup/isStartupInstalled`.
- Produces: `src/app/apiClient.ts` — `function createApiClient(baseUrl: string, token: string): { get<T>(path: string): Promise<T>; post<T>(path: string, body?: unknown): Promise<T>; patch<T>(...)...; del(path: string): Promise<void> }` que lança `ApiError { status, message }`; e `isServiceUp(client): Promise<boolean>`.
- Telas (renderer): **Acompanhamentos** (lista com status/último valor/pausar/excluir/verificar agora), **Chat** de cadastro com cartão de resumo e botão confirmar, **Detalhe** (histórico e fontes), **Relatórios** (por período + estatísticas por acompanhamento), **Configurações** (chave Anthropic, modelos, limite de custo, resumo diário/semanal, enviar relatórios no WhatsApp, iniciar com o Windows, QR do WhatsApp). Barra de status do serviço (rodando/parado, WhatsApp, `overLimit`). Serviço parado → aviso com botão "Iniciar serviço". Fechar a janela só fecha o app; o serviço continua.

- [ ] **Step 1: Write the failing tests** do `apiClient` (servidor falso): envia `Authorization: Bearer`; resposta 4xx vira `ApiError` com a mensagem do corpo; `isServiceUp` falso quando a conexão é recusada (não lança).
- [ ] **Step 2: Run** `npx vitest run tests/apiClient.test.ts` — FAIL.
- [ ] **Step 3: Implement** o cliente e depois as telas; `contextIsolation: true`, `nodeIntegration: false`, o token chega ao renderer só via preload; sem `eval`/CDN remoto. Skill `artifact-design` não se aplica; manter visual simples e legível.
- [ ] **Step 4: Run** `npx vitest run` — PASS.
- [ ] **Step 5: Commit** `feat: electron app ui`.

### Task 15: Verificação ponta a ponta (manual)

**Files:** nenhum novo; atualizar `README.md` com como rodar.

- [ ] **Step 1:** `npm run build && npm run service` e `npm run app`; confirmar na barra de status "serviço rodando".
- [ ] **Step 2:** Em Configurações, salvar a chave Anthropic e escanear o QR; status mostra WhatsApp `ready`.
- [ ] **Step 3:** No chat, "quero acompanhar o preço do PS5 e me avisar no zap quando achar mais barato que o último preço"; a IA deve perguntar intervalo/condição/novo-ou-usado; confirmar o resumo; o tracker aparece na lista.
- [ ] **Step 4:** "Verificar agora" duas vezes; 1ª grava linha de base sem alerta; forçar `lastValue` maior no banco e verificar de novo → chega alerta no WhatsApp.
- [ ] **Step 5:** Fechar o app; confirmar que o serviço continua (verificação nova aparece no banco). Reiniciar o Windows (ou sair/entrar) e confirmar que o serviço sobe sozinho.
- [ ] **Step 6:** Gerar um resumo manualmente (ou esperar o diário) e conferir em Relatórios e no WhatsApp.
- [ ] **Step 7: Commit** `docs: how to run`.

---

## Self-Review

- **Cobertura da spec:** chat de cadastro (T11, T14), busca inteligente + escalada (T6), código decide alerta/linha de base (T3, T8), custo/limite/intervalo mínimo (T1, T4, T9), WhatsApp próprio número + pendentes (T7), serviço separado + API local + token (T12), início no logon (T13), retomada com uma verificação (T9), relatórios por acompanhamento e resumo periódico sem mensagem vazia (T10), DPAPI (T5), UI e status do serviço (T14), confirmação antes de salvar (T11/T12), falhas só no app (T8/T14). Sem lacunas.
- **Consistência de tipos:** `Finding`, `Tracker`, `NewTracker`, `Usage`, `Db`, `LlmClient`, `Notifier`, `runCheck`, `Decision` usados com os mesmos nomes entre tarefas.
- **Proporção:** tarefas definem assinaturas, testes e valores da spec; corpos ficam com o implementador.
