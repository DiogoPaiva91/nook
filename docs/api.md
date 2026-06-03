# API Reference

Endpoints expostos pelo Jarvis Hub. 2 portas:

- **`:3000`** — `server.js` (Node, monolito). Rotas `/api/*` + frontend estático + `/preview/<projeto>/<arquivo>`.
- **`:3001`** — `jarvis_core/server.py` (Python aiohttp, sidecar). Acessível via proxy `/api/core/*` no Hub.

## Autenticação

Nenhuma. Roda local, uso pessoal. Path security em ops de filesystem: tudo precisa começar com `/home/diogo`.

---

## Hub Node (`:3000`)

### Status / sistema

| Método | Path | Descrição |
|---|---|---|
| GET | `/api/status/claude` | Status da CLI do Claude Code (instalado/login) |
| GET | `/api/ollama/models` | Lista modelos Ollama locais (pra embeddings/voice) |
| GET | `/api/core/*` | Proxy pro sidecar Python (transparente) |

### Files / código

| Método | Path | Descrição |
|---|---|---|
| GET | `/api/files?path=...` | Lista entradas (não recursivo) — `[{path, name, isDir}]` |
| GET | `/api/files-flat?path=...` | Walk recursivo com SKIP — máx 5000 arquivos, retorna `{files, truncated}` |
| GET | `/api/file-content?path=...` | Lê arquivo (max 100KB) — `{content}` |
| POST | `/api/fs` | `{action, path, ...}` — actions: `create` (file/dir), `rename`, `delete`, `write` |
| POST | `/api/find` | Body `{path, query}` — busca em arquivos |
| POST | `/api/replace` | Body `{path, query, replace}` — replace |
| GET | `/api/htmls?path=...` | Lista arquivos HTML pra preview |
| GET | `/api/todos?path=...` | Extrai TODOs dos arquivos do projeto |
| POST | `/api/run-tests` | Detecta + roda npm/pytest/cargo/go/make |
| POST | `/api/run-lint` | Detecta + roda eslint/ruff/mypy/clippy |
| POST | `/api/upload` | Multipart, retorna IDs |
| POST | `/api/upload-from-path` | Body `{path, scope}` — copia local pra `uploads/<scope>/` |
| GET | `/api/uploads/<id>` | Serve arquivo de upload |

### Git

| Método | Path | Descrição |
|---|---|---|
| GET | `/api/git-status?path=...` | `{branch, files: [{status, name, path}]}` |
| POST | `/api/git/commit` | Body `{path, message, addAll}` |
| POST | `/api/git/push` | Body `{path}` |
| POST | `/api/git/pull` | Body `{path}` — `--ff-only` |
| POST | `/api/git/stash` | Body `{path}` |
| POST | `/api/git/diff` | Body `{path}` — diff staged + unstaged |
| POST | `/api/git/log` | Body `{path}` — últimos 20 commits |
| POST | `/api/git/branches/list` | Body `{path}` |
| POST | `/api/git/branches/checkout` | Body `{path, name}` |
| POST | `/api/git/branches/create` | Body `{path, name, from}` |
| POST | `/api/git/branches/delete` | Body `{path, name}` |

### Projetos

| Método | Path | Descrição |
|---|---|---|
| GET | `/api/projects` | Lista projetos em `~/dev/projetos/` |
| POST | `/api/projects/create` | **SSE-stream**. Body: `{name, bmad, description, kind, stack, hubNote, runAnalyst, template}`. Eventos: `status`/`stdout`/`stderr`/`error`/`done` |
| DELETE | `/api/projects/<name>` | Apaga projeto + git local |
| POST | `/api/projects/run-bmad` | **SSE-stream**. Body: `{path, agent}`. Roda agente BMAD via sidecar, salva `docs/<file>.md` |

### Dev server (per-project)

| Método | Path | Descrição |
|---|---|---|
| POST | `/api/devserver/start` | Body `{path}` — spawn `npm run dev` |
| POST | `/api/devserver/stop` | Body `{path}` — SIGTERM, fallback SIGKILL |
| GET | `/api/devserver/status?path=...` | `{running, pid, port, url, exitCode, logsCount}` |
| GET | `/api/devserver/logs?path=...&max=N` | `{logs: string[]}` |

Detecta porta automaticamente do output do Vite/Next (regex `localhost:<n>`).

### Hub (Obsidian vault)

| Método | Path | Descrição |
|---|---|---|
| GET | `/api/hub/tree` | Tree do vault em `~/dev/_hub/` |
| GET | `/api/hub/file?path=...&raw=1` | Lê arquivo do hub (markdown) |
| PUT | `/api/hub/file` | Body `{path, content}` — escreve |
| DELETE | `/api/hub/file?path=...` | Apaga |
| POST | `/api/hub/save` | Body `{folder, content, name}` — cria nota |
| GET | `/api/hub/graph` | Grafo de wikilinks |
| GET | `/api/search?q=...&path=...` | Search across hub + projects |

### Cowork (workers em paralelo)

| Método | Path | Descrição |
|---|---|---|
| GET | `/api/events` (SSE) | Stream de eventos. Query `workerId` filtra |
| GET | `/api/workers?kind=worker` | Lista workers ativos |
| POST | `/api/workers` | Body — cria worker |
| DELETE | `/api/workers/<id>` | Encerra worker |
| POST | `/api/workers/<id>/message` | Envia mensagem |
| POST | `/api/workers/<id>/abort` | Aborta task atual |

### Conversations

| Método | Path | Descrição |
|---|---|---|
| GET | `/api/conversations` | Lista conversas |
| POST | `/api/conversations` | Cria conversa |
| GET | `/api/conversations/<id>/messages` | Lista mensagens |
| POST | `/api/conversations/<id>/messages` | Adiciona mensagem |
| PUT | `/api/conversations/<id>/messages` | Substitui mensagens |
| DELETE | `/api/conversations/<id>` | Apaga |
| POST | `/api/conversations/<id>/distill` | Resumo via Claude |
| POST | `/api/migrate-chat` | Migração de schema antigo |

### Chat

| Método | Path | Descrição |
|---|---|---|
| POST | `/api/chat` | **SSE**. Body: `{provider, model, systemPrompt, messages, temperature}` — proxy pra Claude/Anthropic ou Ollama |

### Misc

| Método | Path | Descrição |
|---|---|---|
| POST | `/api/terminal` | Body `{cmd, cwd}` — roda shell, timeout 10s, output limitado |
| GET | `/preview/<projeto>/<arquivo>` | Serve arquivo de projeto pra iframe preview |

---

## Sidecar Python (`:3001`)

Acessível via `/api/core/*` no Hub. Usa Claude Agent SDK.

### Health / agents

| Método | Path | Descrição |
|---|---|---|
| GET | `/health` | Health check |
| GET | `/agents` | Lista agents BMAD disponíveis |
| GET | `/diagnostics` | 11 checks agregados (sidecar/embeddings/browser/voice/etc) |

### Chat (Claude Agent SDK)

| Método | Path | Descrição |
|---|---|---|
| POST | `/chat` | **SSE**. Body: `{prompt?, messages?, agent?, mode, projeto?, cwd?}`. Tools: Read/Edit/Write/Bash/Grep/Glob (mode=codigo); MCP browser pra mode=browser |

Eventos SSE: `thinking` (text), `token` (text), `tool` (id/name/input), `usage` (input_tokens/output_tokens).

### Hub

| Método | Path | Descrição |
|---|---|---|
| GET | `/hub/list?folder=` | Lista vault entries |
| GET | `/hub/search?q=` | Search com embeddings (Ollama) se disponível, fallback grep |
| POST | `/hub/adr` | Cria ADR |
| POST | `/hub/snippet` | Cria snippet |
| POST | `/hub/padrao` | Cria padrão |
| POST | `/hub/bmad-artifact` | Salva artefato BMAD no hub |
| GET | `/hub/git-status` | Git status do vault |

### Macros (browser worker)

| Método | Path | Descrição |
|---|---|---|
| GET | `/macros` | Lista macros |
| GET | `/macros/stats` | Stats de execução |
| GET | `/macros/<slug>` | Detalhe |
| POST | `/macros` | Cria/atualiza |
| DELETE | `/macros/<slug>` | Apaga |
| PATCH | `/macros/<slug>/schedule` | Define cron |
| PATCH | `/macros/<slug>/meta` | Atualiza meta |
| POST | `/macros/<slug>/run` | Roda agora |
| GET | `/macros/<slug>/versions` | Lista versões |
| GET | `/macros/<slug>/versions/<v>` | Lê versão |
| POST | `/macros/<slug>/versions/<v>/restore` | Restaura |

### Browser worker

| Método | Path | Descrição |
|---|---|---|
| GET | `/browser/status` | Status do browser CDP |
| POST | `/browser/answer` | Resposta a prompt do browser |
| POST | `/browser/sync-cookies` | Sync cookies do Chrome |
| POST | `/browser/record/start` | Inicia gravação |
| POST | `/browser/record/stop` | Para gravação |
| GET | `/browser/record/state` | Estado da gravação |
| GET | `/browser/fails` | Lista falhas |
| GET | `/browser/fails/<id>/screen.png` | Screenshot da falha |

### Projetos

| Método | Path | Descrição |
|---|---|---|
| GET | `/projetos` | Lista projetos via sidecar |

---

## Convenções

- **SSE format**: `data: <json>\n\n` por evento. `kind` é o discriminador (`status`, `stdout`, `stderr`, `error`, `done`, `token`, `thinking`, `tool`, `usage`).
- **Erros**: status HTTP apropriado + `{error: "msg"}` em JSON.
- **Path validation**: tudo que recebe `path` valida `path.resolve(p).startsWith("/home/diogo")` antes de operar.
- **Streams**: `Cache-Control: no-cache`, `Connection: keep-alive`, `Content-Type: text/event-stream`. Pra evitar buffering em proxies, sidecar adiciona `X-Accel-Buffering: no`.
