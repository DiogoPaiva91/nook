# Arquitetura — Jarvis Hub

**Última atualização:** 2026-04-26

> **Sobre essa doc:** descreve o estado **real** atual após implementação iterativa. O plano original (BMAD, abril/26) propunha Builder em `lib/builder/` + Next.js + Supabase + Postgres com RLS. A implementação convergiu pra algo mais leve: vanilla JS in-place, sem dependências novas, sem coupling de stack. O plano original está preservado em `docs/stories/` e `docs/prd.md`.

## 1. Stack

| Camada | Tecnologia | Localização |
|---|---|---|
| HTTP server | Node `http` nativo, roteamento manual por `req.url` | `server.js` (~3500 linhas) |
| DB | `better-sqlite3` WAL | `lib/db.js` → `data/jarvis.db` |
| Sidecar IA | aiohttp + Claude Agent SDK em `:3001` | `jarvis_core/` |
| UI | Vanilla HTML/CSS/JS single-file | `public/index.html` (~610 KB) |
| Workers | Registry + bus SSE | `lib/workers/` |
| Chat persistence | Conversations + snapshot + distill | `lib/chat/` |
| BMAD | Markdown prompts + Python loader | `bmad/agents/`, `jarvis_core/bmad_loader.py` |
| Hub Obsidian | Vault em `~/dev/_hub`, exposto via `/api/hub/*` | fora do repo |
| Voice | Whisper local | `jarvis_core/voice.py` |
| Browser MCP | Puppeteer-core | `jarvis_core/browser.py` |

## 2. Topologia

```
                ┌──────────────────────────────────────┐
                │  Browser (single-file UI)            │
                │  public/index.html                   │
                │  - 4 modos: Chat, Code, Cowork, Hub  │
                │  - Builder (Bubble-style) in-app     │
                │  - Command Palette (Ctrl+K)          │
                └────────┬─────────────────────────────┘
                         │ http :3000
                         ▼
                ┌──────────────────────────────────────┐
                │  Hub Node (server.js)                │
                │  - Rotas /api/*                       │
                │  - SSE pra streams                    │
                │  - Static files                       │
                │  - SQLite (data/jarvis.db)            │
                └────────┬──────────────┬──────────────┘
                         │              │
                  /api/core/*           │ spawn (newproj, npm run dev, BMAD via sidecar)
                         │              │
                         ▼              ▼
                ┌────────────────┐   ┌──────────────────┐
                │ Sidecar Python │   │ Filesystem       │
                │ jarvis_core    │   │ ~/dev/projetos/* │
                │ :3001          │   │ ~/dev/_hub/*     │
                │ Claude SDK     │   │ uploads/*        │
                └────────┬───────┘   └──────────────────┘
                         │
                         ▼
                  Anthropic API
                  + Ollama (local)
```

## 3. Decisões-chave

### 3.1 Monolito intencional

`server.js` e `public/index.html` são **deliberadamente** únicos. Razões:

- **Solo dev**, sem onboarding pra time. Fragmentar perde mais tempo navegando que ganha em isolamento.
- Sem build step no frontend — refresh do browser = mudanças visíveis. Sem Vite, sem webpack, sem bundler. Trade-off: perde-se tree-shaking + hot module replacement, mas ganha-se simplicidade absoluta.
- Não escala pra time, mas escala pra **Diogo + IA** que é o uso real.

### 3.2 Estado client-side

| Onde | O quê |
|---|---|
| `localStorage["jarvis-hub:settings"]` | Tema, accent color, voice model, history limit |
| `localStorage["jarvis-hub:panelWidths"]` | Larguras dos resize handles |
| `localStorage["jarvis-hub:previewConfig"]` | Por-projeto: breakpoint, entry, mode (static/dev) |
| `state.conversations` (memory + SQLite via `/api/conversations`) | Conversas com kind="chat"\|"code:<projeto>"\|... |
| `Builder.*` (memory) | Estado do Builder enquanto aberto |

### 3.3 Builder: vanilla DOM em iframe srcdoc

O Builder não usa React no canvas — é um interpretador JSON → DOM em vanilla JS, embutido num iframe `srcdoc` com **Tailwind CDN**. Razão: zero acoplamento com o stack do projeto do user. O canvas funciona idênticamente seja o projeto Vite ou Next.js, com ou sem shadcn instalado.

Quando o user faz **Export** ou **Install Runtime**, aí sim emite código TypeScript/React específico ao framework detectado.

Trade-off: o canvas mostra "shadcn-like" via classes Tailwind diretas, não os componentes shadcn reais. Cores customizadas (`--primary`, etc.) não aparecem. Mitigação: paleta visual usa cores Tailwind padrão (slate/violet/sky/etc).

### 3.4 BMAD agents — sidecar over inline

BMAD agents rodam no sidecar Python via Claude Agent SDK. Razões:
- Claude Agent SDK é Python-only (no momento)
- SDK gerencia tools (Read/Edit/Write/Bash/Grep/Glob), threading, streaming — não queremos reimplementar em Node
- Cwd correto pro agente: sidecar resolve via `projeto: <nome>` → `~/dev/projetos/<nome>`

### 3.5 Sem autenticação / sem multi-user

Roda em `localhost`, uso pessoal. Adicionar auth = complexidade morta. Path security é a única defesa: tudo precisa começar com `/home/diogo`.

### 3.6 Project metadata via `.jarvis-project.json`

Cada projeto criado pelo modal grava `<projeto>/.jarvis-project.json` com `{name, kind, description, stack, bmad, createdAt, hubNote}`. Lido por:
- Code mode (frontend) — injeta no system prompt do code chat
- BMAD on-demand — usa pra montar prompt do agente
- Builder — não usa diretamente, mas detecta framework via `package.json`

## 4. Fluxos principais

### 4.1 Project creation

```
modal → /api/projects/create (SSE)
  → spawn ~/dev/bin/newproj (skeleton + git init + BMAD opcional)
  → postCreateEnrichProject:
     1. scaffold por (kind, template):
        - web/vite-shadcn → scaffoldViteReact (Vite+React+TS+Tailwind+shadcn pré-instalado)
        - web/vite-blank → scaffoldViteBlank
        - web/nextjs → scaffoldNextjs
        - cli → scaffoldNodeCli (tsx + commander)
        - api → scaffoldNodeApi (Express + TS)
        - lib → scaffoldNodeLib (tsup)
     2. write .jarvis-project.json
     3. populate README (replace placeholders)
     4. write CLAUDE.md (instruções pro Claude Code) ← novo
     5. create _hub/projetos/<nome>.md (Obsidian note)
     6. if runAnalyst: run BMAD Analyst → docs/brief.md
  → SSE done event
```

### 4.2 Builder save → app preview

```
User edita no Builder (Ctrl+B)
  → builderUpdateProp/builderInsertAt/etc mutam Builder.page
  → builderRender re-renderiza iframe canvas
  → Ctrl+S ou autosave (8s) → /api/fs write → <projeto>/jarvis-pages/<name>.page.json

Pra usar no app real do user:
  Opção A — Export to JSX (estático):
    📤 Export → builderEmitJsx → src/jarvis-pages/<name>.tsx
    User edita o JSX se quiser. Re-Export sobrescreve.

  Opção B — Install Runtime (live binding):
    📥 Runtime → escreve src/components/JBuilderPage.tsx + copia .page.json pra src/
    User usa <JBuilderPage page={home} /> no App.tsx
    Editar no Builder = editar a app (sem Export)
```

### 4.3 Dev server

```
▶ Dev → /api/devserver/start { path }
  → spawn npm run dev (cwd=path)
  → captura porta do stdout (regex localhost:<n>)
  → registry Map<path, {proc, pid, port, url, logs[]}>

UI poll /api/devserver/status a cada 2s
Preview pane (modo Dev) → iframe.src = http://localhost:<port>

⏸ Dev → SIGTERM (fallback SIGKILL após 3s)
Cleanup automático em SIGINT/SIGTERM/exit do server.js
```

### 4.4 BMAD on-demand

```
🤖 BMAD ▾ → dropdown com 7 agentes
Click → /api/projects/run-bmad { path, agent } (SSE)
  → load <projeto>/.jarvis-project.json + docs/brief.md
  → POST /chat (sidecar) com:
       - agent: <name>
       - mode: "codigo"
       - projeto: <name> (sidecar resolve cwd)
       - prompt: BMAD_AGENT_TASKS[agent].prompt({name, description, kind, stack, brief})
  → consome SSE tokens → string completa
  → strip wrapper ```markdown se existir
  → fs.writeFileSync(<projeto>/docs/<file>.md)
  → if hubNote: copia pra _hub/projetos/<agent>-<name>.md + linka na nota principal
```

## 5. Arquivos críticos

| Arquivo | LOC aprox | Responsabilidade |
|---|---|---|
| `server.js` | 3500 | Tudo do backend Node |
| `public/index.html` | ~16k | Tudo do frontend |
| `jarvis_core/server.py` | 1300 | Sidecar Python (chat/hub/macros/browser/voice) |
| `lib/db.js` | 200 | Schema + migrations |
| `lib/workers/registry.js` | 150 | Worker registry |
| `lib/chat/conversations.js` | 250 | Persistência de conversas |
| `bmad/agents/*.md` | 7 arquivos | Prompts BMAD |

## 6. Pontos de extensão

- **Novo modo**: `<div class="mode-container" id="mode-<x>">` + botão rail + hook em `switchMode`
- **Novo endpoint**: bloco `if (req.url === "/api/<x>" && req.method === "...")` no createServer
- **Novo BMAD agent**: ver § "BMAD agents" em CLAUDE.md
- **Novo tipo no Builder**: ver § "Estendendo" em docs/builder.md
- **Novo template de projeto**: nova função `scaffold<X>` em server.js + dispatch no `postCreateEnrichProject`
- **Nova action de workflow**: `BUILDER_ACTION_TYPES` + emit em `builderEmitActionJs` + handler em `runActions` (no runtime)

## 7. Limites conhecidos

- Frontend é monolito de ~600 KB sem code-splitting — full reload pesado
- Builder canvas usa Tailwind CDN — first paint emite warning de produção
- Sem hot module replacement no Hub UI (refresh full)
- Sem testes JS — validação via curl + smoke manual
- Sem CSP / sandbox no iframe srcdoc do Builder (uso pessoal só)
- Sem rate limiting — confiança no localhost

## 8. Diferenças vs plano original

A doc anterior (versão 0.2, 26/04) propunha:
- Builder isolado em `lib/builder/` com router próprio (`/api/builder/*`)
- Stack alvo único: Next.js + Supabase + Postgres com RLS
- Codegen via templates Prettier
- Tabelas SQLite novas (`builder_projects`, `builder_preview_processes`)
- Plugin de MCP por projeto

Implementado:
- Builder vive em `public/index.html` (não tem `lib/builder/`)
- Stack alvo é configurable (`template` no modal: vite-shadcn / vite-blank / nextjs)
- Sem coupling com Supabase/Postgres
- Sem tabelas novas no SQLite — pages são `.page.json` no FS
- Dev server é registry em memória do `server.js`
- BMAD on-demand usa endpoint SSE genérico, não router separado

Razão da divergência: cada feature foi entregue com escopo mínimo viável e validada em build real antes de seguir. O plano BMAD original era mais ambicioso (ADRs, RLS, codegen Prettier) — chegou-se ao ponto de "funciona em todos os casos testados" antes.

Stories BMAD em `docs/stories/` permanecem como referência de roadmap futuro caso algum item específico vire prioridade.
