# CLAUDE.md — Jarvis Hub

Instruções pra IA (Claude Code, agentes) trabalhando neste repo. Leia antes de qualquer alteração.

## Contexto

Jarvis Hub é um workspace pessoal multi-modo do Diogo (solo dev, pt-BR). Roda local, sem multiusuário, sem deploy. Ver `README.md` pra overview do produto.

## Arquitetura — pontos críticos

**Monolito intencional.** Não fragmente:

- `server.js` é único (~3000 linhas, todas as rotas `/api/*`). Não extraia pra microserviços. Crie módulos só em `lib/` quando ficar > 200 linhas relacionadas.
- `public/index.html` é single-file (~600 KB, todos os modos + Builder + Command Palette + Settings). Não introduza bundler/Vite/React no frontend do **próprio Hub** — vanilla JS é a escolha. Frameworks ficam nos projetos dos usuários (`~/dev/projetos/<nome>`), não aqui.
- `jarvis_core/` é sidecar Python aiohttp em `:3001`. Hub Node faz proxy via `/api/core/*`.

## Regras de edição

1. **Sem deps novas no Hub sem aprovação explícita.** Stack atual: Node http nativo, `better-sqlite3`, `puppeteer-core`. Python: aiohttp, claude-agent-sdk, openai-whisper. Adicionar = perguntar.
2. **Edite, não crie.** Prefira modificar arquivos existentes a criar novos. Não invente abstrações pra "futuro" — três linhas iguais é melhor que abstração prematura.
3. **Sem comentários narrativos.** Não escreva `// adicionado para feature X` ou `// fix do bug Y`. Use commits/PRs pra isso. Comentários só explicam o **porquê** quando não-óbvio (constraint escondida, workaround específico, invariant sutil).
4. **Sem documentação não solicitada.** Não crie `*.md` (READMEs internos, docstrings longos) sem o usuário pedir. Esta linha **é** a exceção.
5. **Path security:** toda operação de arquivo no backend valida `resolved.startsWith("/home/diogo")`. Não relaxe.
6. **Sem hooks bypass:** `--no-verify`, `--no-gpg-sign`, `commit.gpgsign=false` — nunca, sem ordem direta.

## Convenções

- **PT-BR em UI e mensagens.** Inglês só em código (variáveis, identificadores, comentários técnicos curtos).
- **Sem emojis em código.** Em UI, só quando o user usar emojis (ele usa pouco).
- **Toasts e alerts:** use `showToast(msg, "success"|"error"|"warn"|"info")`. Evite `alert()` exceto em caminhos de teste.
- **Modais:** use `jModal({title, body, width, actions, onMount})`. Não monte overlays do zero.
- **Endpoints novos:** padrão é `/api/<area>/<verb>`. SSE pra streams (newproj, BMAD, run-bmad). JSON síncrono pro resto.

## Estrutura por modo (frontend)

Cada modo é um `<div class="mode-container" id="mode-<nome>">` em `public/index.html`. Toggle via `switchMode("nome")`. Adicionar mode novo:
1. Adiciona container no HTML
2. Botão no rail esquerdo (`.rail-btn`)
3. Hook em `switchMode` se precisar de inicialização

## Builder (in-app low-code editor)

Toda lógica do Builder vive em `public/index.html`, marcado por `// ── Builder` blocks. Estado em `const Builder = {...}`. Tipos em `BUILDER_TYPES`. Veja `docs/builder.md` pra detalhes do formato JSON e fluxos. Mudanças no Builder devem **manter compat** com `.page.json` existentes — adicionar campos opcionais, nunca remover.

## BMAD agents

7 agentes em `bmad/agents/<name>.md` (PT-BR). Carregados por `jarvis_core/bmad_loader.py`. Catálogo de tarefas + filenames de output em `BMAD_AGENT_TASKS` no `server.js`. Ao adicionar agente novo:
1. Cria `bmad/agents/<name>.md`
2. Adiciona em `bmad_loader.py` (`AGENTS` dict)
3. Atualiza teste `tests/test_bmad_loader.py`
4. Adiciona em `BMAD_AGENT_TASKS` (server.js) com `file`/`label`/`prompt`
5. Adiciona em `BMAD_NAMES`/`BMAD_CONTEXT_AGENTS`/`agentIcon`/`BMAD_TOOLTIPS`/`outputName`/`BMAD_RUNNERS` (frontend)

## Persistência

- SQLite (`data/jarvis.db`): conversas, workers. Migrations em `lib/db.js` se necessário.
- LocalStorage no browser: settings, panel widths, preview state.
- Filesystem: hub Obsidian (`~/dev/_hub`), projetos (`~/dev/projetos/<nome>`), uploads (`uploads/<scope>/`).

## Test-driven mindset

- `node --check server.js` antes de subir.
- `python -m pytest -q` pros tests Python (sob `.venv`).
- Pra mudanças de API: faça `curl` test antes de declarar pronto.
- Pra mudanças de UI: declare claramente que **não testou no browser** se não foi possível.

## Diretivas do dono (Diogo)

- **Velocidade > rigor formal.** Solo dev, pode tomar risco controlado.
- **Doing > explaining.** Automatize, não só guie. Verifique alegações de "feito".
- **Bubble-style, não Wappler.** Code mode mira no-code visual puro com round-trip pra JSX, não IDE de texto tradicional.
- **Stack alvo dos projetos:** Vite + React + TS + Tailwind + shadcn (matched a Replit Agent).

## Anti-padrões

- ❌ Adicionar React/Vue/etc no frontend do Hub (não é app Web genérica, é tooling pessoal)
- ❌ Quebrar `index.html` em arquivos (proposital ser um arquivão)
- ❌ Criar BFF/microserviço novo (sidecar Python já é um — chega)
- ❌ Adicionar autenticação / multi-user (uso pessoal, sem isso)
- ❌ "Cleanup" preventivo (renomear, mover) sem mudança de comportamento — gera diff ruidoso
