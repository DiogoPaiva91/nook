# Jarvis Hub

Workspace pessoal multi-modo: **Chat**, **Code** (com IDE visual estilo Bubble), **Cowork** (agentes em paralelo) e **Hub** (vault Obsidian em `~/dev/_hub`). Roda 100% local em `localhost:3000`.

## Setup

```bash
git clone https://github.com/DiogoPaiva91/jarvis.git ~/dev/jarvis
cd ~/dev/jarvis
npm install
python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt
node server.js          # Hub UI em :3000
python -m jarvis_core.server  # sidecar Python em :3001 (Claude Agent SDK + BMAD)
```

Abre `http://localhost:3000`.

## Estrutura

```
jarvis/
├── server.js            # Backend Node monolítico (~3000 linhas) — todas as rotas /api/*
├── public/index.html    # Frontend single-file (~600 KB) — todos os modos + Builder
├── jarvis_core/         # Sidecar Python aiohttp (Claude Agent SDK)
│   ├── server.py        # Endpoint /chat (SSE) + /diagnostics + /hub/*
│   ├── bmad_loader.py   # Carrega prompts BMAD locais
│   ├── browser.py       # MCP browser worker
│   ├── embeddings.py    # Ollama embeddings pra hub
│   ├── voice.py         # Whisper local
│   └── telegram_bot.py
├── lib/
│   ├── chat/            # Persistência + snapshot + distill de conversas
│   └── workers/         # Registry e bus pra Cowork
├── bmad/agents/         # 7 prompts BMAD (analyst/pm/architect/designer/dev/qa/sm)
├── docs/                # brief, prd, architecture, stories, builder, api
└── data/jarvis.db       # SQLite (better-sqlite3) — conversas, workers, etc.
```

## Modos

- **Chat** (Ctrl+1) — assistente principal, com awareness do hub Obsidian (snippets/padrões/decisões).
- **Code** (Ctrl+2) — workspace por projeto em `~/dev/projetos/`. File tree, editor texto, dev server integrado, BMAD on-demand, **Builder visual estilo Bubble** (Ctrl+B). Veja [docs/builder.md](docs/builder.md).
- **Cowork** (Ctrl+3) — múltiplos agentes em paralelo via `lib/workers/`.
- **Hub** (Ctrl+4) — vault Obsidian em `~/dev/_hub` com leitura/edição inline + indexação por embeddings.

## Atalhos globais

| Tecla | Ação |
|---|---|
| `Ctrl+1..4` | Trocar de modo |
| `Ctrl+K` | Command palette (arquivos / páginas / modos / BMAD) |
| `Ctrl+B` | Toggle Builder (em Code) |
| `Ctrl+,` | Settings |
| `?` | Cheatsheet |

## Project creation (Code mode)

`+ Novo projeto` no sidebar de Code → modal com:
- Nome + descrição + tipo (web/cli/lib/api/data/mobile/other)
- **Template** quando `kind=web`: vite-shadcn (default), vite-blank, nextjs
- Toggle: instalar BMAD / criar nota Obsidian em `_hub/projetos/<nome>.md` / rodar Analyst (Mary) agora

Ao criar:
1. `~/dev/bin/newproj` cria esqueleto + git init
2. Scaffold do template (Vite+React+TS+Tailwind+shadcn ou outro)
3. `npm install` streamado via SSE
4. Grava `.jarvis-project.json` com metadata
5. Popula README com Objetivo/Stack/Tipo
6. Cria nota Obsidian + linka no `_hub/projetos/index.md`
7. Escreve `CLAUDE.md` no projeto com instruções pra Claude Code
8. Se Analyst marcado, dispara BMAD Mary → `docs/brief.md`

## BMAD on-demand

No project bar, `🤖 BMAD ▾` abre dropdown com 7 agentes:

| Agente | Output | Ação |
|---|---|---|
| Mary (Analyst) | `docs/brief.md` | Project brief estruturado |
| John (PM) | `docs/prd.md` | PRD com épicos/stories |
| Winston (Architect) | `docs/architecture.md` | Doc de arquitetura |
| Sally (Designer) | `docs/design.md` | Design system + telas |
| James (Dev) | `docs/dev-plan.md` | Plano de implementação |
| Quinn (QA) | `docs/qa-plan.md` | Plano de QA |
| Bob (SM) | `docs/sprint-1.md` | Plano de sprint |

Cada um lê `.jarvis-project.json` + `docs/brief.md` (se existir) como contexto.

## Dev server integrado

`▶ Dev` no project bar sobe `npm run dev` em background. Captura porta automaticamente do output. Preview pane (em Code) tem toggle **Estatico/Dev** — em Dev, carrega `localhost:<porta>` no iframe com HMR ao vivo.

Botão `📜` mostra logs do dev server em modal. Banner vermelho aparece se dev server crasha (exit code != 0).

## Builder (low-code estilo Bubble)

Veja [docs/builder.md](docs/builder.md) pra detalhes. TL;DR:

- Toggle `🧱 Builder` no project bar (ou Ctrl+B)
- 3 colunas: palette + element tree | canvas iframe | properties (Layout/Typography/Color/Workflows)
- 14 tipos: Container, Card, Section, Heading, H2, H3, Text, Link, Button, Input, Image, Divider, Badge, Avatar
- 7 templates de página: Blank, Welcome, Hero, Login, Two-column, Pricing, Dashboard
- Drag-drop: palette → tree ou canvas, reordenar tree
- Edit/Preview mode (Preview executa workflows reais)
- Workflows: events × actions (alert/log/navigate/setState/fetch)
- **Export to JSX**: gera componente React real (framework-aware Vite/Next.js, shadcn-aware imports)
- **Install Runtime**: copia `JBuilderPage.tsx` pro projeto pra renderizar `.page.json` em runtime (live binding)

## Persistência

- **Conversas**: `data/jarvis.db` via `lib/chat/conversations.js`
- **Workers (Cowork)**: `lib/workers/registry.js` + bus
- **Builder pages**: `<projeto>/jarvis-pages/*.page.json` (JSON vivo)
- **Project metadata**: `<projeto>/.jarvis-project.json`
- **Settings/preferences**: `localStorage` (`jarvis-hub:settings`, `jarvis-hub:panelWidths`, etc)
- **Hub**: arquivos `.md` no vault Obsidian em `~/dev/_hub`

## Diagnóstico

`/api/core/diagnostics` agrega 11 checks: Sidecar, BMAD agents, Embeddings (Ollama), Obsidian hub, Browser CDP, Browser MANUAL, Browser SCHEDULED, Voice (Whisper), Telegram, Cache, Disco, Scheduler. Acessível via 🩺 Diag no status bar.

## Testes

```bash
source .venv/bin/activate
python -m pytest -q          # testes Python (bmad_loader etc)
node --check server.js       # syntax check do backend
```

Não tem suite de testes JS pro frontend ainda — validação é via `curl` + smoke test manual no browser.

## Memória de evolução

Veja `docs/stories/` (~42 stories BMAD) e `docs/brief.md` pra contexto histórico do produto.
